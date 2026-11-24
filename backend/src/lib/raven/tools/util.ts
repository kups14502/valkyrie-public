import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AgentError } from '../../agentsStore.js'
import { PsaError } from '../../psa.js'
import { ProjError } from '../../projectTypes.js'
import type { RavenToolCtx } from '../types.js'

// What every Raven tool group shares: the result wrapper, the "only when
// Brendon asked" gate, and New York time labels.

/** A refusal or a plain failure the model should read, never a crash. */
export class RavenToolError extends Error {}

/** Runs a tool body: a string goes back as text, anything else as compact JSON; known errors as isError text. */
export async function toolRun(fn: () => unknown): Promise<CallToolResult> {
  try {
    const result = await fn()
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] }
  } catch (e) {
    if (e instanceof RavenToolError || e instanceof AgentError || e instanceof PsaError || e instanceof ProjError) {
      return { isError: true, content: [{ type: 'text', text: e.message }] }
    }
    console.error('[raven-tools]', (e as Error).message)
    return { isError: true, content: [{ type: 'text', text: `internal error: ${(e as Error).message.slice(0, 200)}` }] }
  }
}

/** Session start/stop, media requests, task changes, calendar events and vault notes run only when Brendon's own message asked (session_send never asks). */
export function needBrendon(ctx: RavenToolCtx, what: string): void {
  if (!ctx.fromBrendon) {
    throw new RavenToolError(`${what} only runs when Brendon's own message asks for it. This run was not woken by him: tell him what you would do and let him ask.`)
  }
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const ET_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

/** "Thu, Nov 19, 1:42 PM ET" for an instant (ISO string or ms); '' for nothing. */
export function et(at: string | number | null | undefined): string {
  if (at === null || at === undefined || at === '') return ''
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) && ms > 0 ? `${ET_TIME.format(ms)} ET` : ''
}

export const etDay = (ms: number): string => ET_DAY.format(ms)
export const etClock = (ms: number): string => `${ET_CLOCK.format(ms)} ET`

/** A New York wall-clock due ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') as words, no conversion needed. */
export function dueLabel(due: string | null | undefined): string {
  if (!due) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(due)
  if (!m) return due
  // noon UTC of that date is the same calendar day in New York
  const day = ET_DAY.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12))
  if (!m[4]) return day
  const h = Number(m[4])
  const time = `${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`
  return `${day}, ${time} ET`
}

/** "45s", "12m", "3h 5m", "2d" */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** The API itself on loopback, for the routes Raven reads the way the app does (calendar, media requests). */
export const apiBase = (): string => process.env.RAVEN_API_BASE || `http://127.0.0.1:${process.env.PORT || 3001}/api`

/** A JSON call to the loopback API. Throws RavenToolError with the route's own error text. */
export async function apiJson<T>(p: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 30_000)
  try {
    const r = await fetch(`${apiBase()}${p}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ac.signal,
    })
    const body = await r.json().catch(() => null) as T
    return { status: r.status, body }
  } catch (e) {
    throw new RavenToolError(`Valkyrie's own ${p.split('?')[0]} did not answer (${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message})`)
  } finally {
    clearTimeout(timer)
  }
}

/** The error text a route answered with. */
export const routeError = (body: unknown, status: number): string => {
  const b = (body ?? {}) as { error?: unknown; detail?: unknown }
  const parts = [b.error, b.detail].filter((x): x is string => typeof x === 'string' && x.length > 0)
  return parts.length ? parts.join(': ') : `answered ${status}`
}
