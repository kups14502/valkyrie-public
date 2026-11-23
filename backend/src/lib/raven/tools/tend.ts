import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { bump, getKv, setKv } from '../../agentsStore.js'
import { continueCheck } from '../../accountSwitch.js'
import { wakeRavenWith } from '../hooks.js'
import type { RavenToolCtx } from '../types.js'
import { sessionCheck } from './sessions.js'
import { clip, et, RavenToolError, toolRun } from './util.js'

// Tending: a session Raven keeps going on its own. Brendon, 2026-11-23 (Raven
// thread #950): his 24/7 Crewtastrophe session runs overnight, and it pauses on
// a permission or removal popup that does not matter, or when a subscription
// runs out of usage (Valkyrie's account switcher rotates it, and the session
// must pick up after the switch). Every `every` minutes (default 15) Raven is
// woken with where a tended session stands: working or idle, its last answer,
// an open prompt, a usage limit and what the switcher says about it. Raven
// decides what to do; a check that needs nothing stays out of his thread
// (the run's answer is "(no reply)").
//
// Tends live in agents.sqlite's kv (raven:tends), so a restart keeps them. A
// session whose Claude ended is reported once and its tend is dropped.

const KEY = 'raven:tends'
const TICK_MS = 60_000
export const TEND_DEFAULT_MIN = 15

export type Tend = { session: string; label: string; every: number; note: string; since: string; nextAt: number }

export function listTends(): Tend[] {
  try {
    const v = JSON.parse(getKv(KEY) ?? '[]') as Tend[]
    return Array.isArray(v) ? v.filter((t) => t && typeof t.session === 'string') : []
  } catch {
    return []
  }
}

function saveTends(list: Tend[]): void {
  setKv(KEY, JSON.stringify(list))
  bump()
}

/** Starts (or changes) a tend. The first check comes within a minute. */
export async function setTend(session: string, opts: { every?: number; note?: string } = {}): Promise<Tend> {
  const c = await sessionCheck(session)
  if (!c.alive) throw new RavenToolError(`${c.label}: its Claude is not running, so there is nothing to tend`)
  const key = c.sessionId || session
  const list = listTends().filter((t) => t.session !== key)
  const t: Tend = {
    session: key, label: c.label, every: Math.min(120, Math.max(5, Math.round(opts.every ?? TEND_DEFAULT_MIN))),
    note: clip(opts.note ?? '', 500), since: new Date().toISOString(), nextAt: Date.now() + 30_000,
  }
  list.push(t)
  saveTends(list)
  return t
}

export function dropTend(session: string): boolean {
  const s = session.trim().toLowerCase()
  const list = listTends()
  const keep = list.filter((t) => t.session.toLowerCase() !== s && !t.label.toLowerCase().includes(s))
  if (keep.length === list.length) return false
  saveTends(keep)
  return true
}

let ticking = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    const list = listTends()
    const due = list.filter((t) => t.nextAt <= now)
    if (!due.length) return
    const drop = new Set<string>()
    for (const t of due) {
      t.nextAt = now + t.every * 60_000
      const c = await sessionCheck(t.session).catch((e: Error) => ({ error: e.message }))
      if ('error' in c) {
        // thor asleep or its launcher down: one line for Raven, the tend stays
        wakeRavenWith('session_tend', { label: t.label, session: t.session, every: t.every, note: t.note, error: clip(c.error, 300) })
        continue
      }
      let switcher: string | undefined
      if (c.state === 'limit' || c.state === 'ended' || /usage limit|limit reached|hit your limit/i.test(c.lastAnswer ?? '')) {
        try {
          const g = continueCheck(c.host)
          switcher = g.ok ? `the switcher holds ${c.host} on an account with room (${g.active}): a continue is safe now` : `no continue yet: ${g.why}`
        } catch (e) {
          switcher = `could not ask the switcher (${(e as Error).message.slice(0, 120)})`
        }
      }
      if (!c.alive) drop.add(t.session)
      wakeRavenWith('session_tend', { ...c, session: t.session, every: t.every, note: t.note, ...(switcher ? { switcher } : {}), checkedAt: et(now) })
    }
    const fresh = listTends()
    for (const f of fresh) {
      const d = due.find((x) => x.session === f.session)
      if (d) f.nextAt = d.nextAt
    }
    saveTends(fresh.filter((f) => !drop.has(f.session)))
  } catch (e) {
    console.error('[raven-tend]', (e as Error).message)
  } finally {
    ticking = false
  }
}

let timer: NodeJS.Timeout | null = null

/** Starts the tend clock. Called once by startRavenTools. */
export function startTender(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
}

/** Plain lines for Raven's prompt; '' when nothing is tended. */
export function tendsSnapshot(): string {
  const list = listTends()
  if (!list.length) return ''
  return ['Sessions you tend (a check wakes you on each):', ...list.map((t) => `- ${t.label} (${t.session}): every ${t.every} min since ${et(t.since)}, next ${et(t.nextAt)}${t.note ? `, note: ${clip(t.note, 160)}` : ''}`)].join('\n')
}

export function registerTendTools(server: McpServer, _ctx: RavenToolCtx): void {
  server.registerTool('session_tend', {
    description: 'Keep a Claude session going on your own: every `minutes` (default 15) you are woken with where it stands (working or idle, its last '
      + 'answer, an open prompt, a usage limit and what the account switcher says). On each check you decide: nothing while it works; answer a '
      + 'prompt that blocks it (session_keys); "continue" it (session_send) once a usage limit has passed or the switcher moved to an account with '
      + 'room; clear a popup on thor that holds it (thor_windows, thor_button). note is what Brendon wants from it. on false stops tending.',
    inputSchema: { session: z.string().max(120), on: z.boolean(), minutes: z.number().int().min(5).max(120).optional(), note: z.string().max(500).optional() },
  }, (a) => toolRun(async () => {
    if (!a.on) return dropTend(a.session) ? { tending: false, session: a.session } : `${a.session} was not tended.`
    const t = await setTend(a.session, { every: a.minutes, note: a.note })
    return { tending: true, session: t.label, sessionId: t.session, every: t.every }
  }))
}
