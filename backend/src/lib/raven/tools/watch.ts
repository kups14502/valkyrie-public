import { bump, getKv, setKv, type Ref } from '../../agentsStore.js'
import { ravenPost, wakeRavenWith } from '../hooks.js'
import type { TranscriptEntry, TranscriptPage } from '../../../terminal/transcript.js'
import { screenBusy } from '../../../terminal/paneState.js'
import { io } from './io.js'
import { clip } from './util.js'

// The relay watcher: what a watched Claude session says comes back into the
// DM. Every 8 s each watched session's transcript is read forward from a
// cursor. When its newest entry is Claude's answer (assistant text) and
// nothing new has arrived for 12 s (and a pane's screen no longer shows the
// working spinner), that answer is posted in #raven once, as a relay, and
// pushed to the phone. A watch asked to follow up also wakes Raven with the
// answer, once. A pane that dies gets one "<label> ended" line and is
// dropped; a watch with no activity for 24 h drops on its own.
//
// Watches live in agents.sqlite's kv (raven:watches), cursor included, so a
// restart picks up where it left off without relaying anything twice.
//
// The Watching card's title is the job's name as Raven gave it, the label of
// session_start or session_send, and nothing else: no prompt, no answer and no
// Claude title ever names it. His screenshot showed a cut-off sentence of a
// prompt and a release headline as titles. Without a label the card shows the
// pane's own label. Under it the card shows the session's latest status line,
// the first sentence of its newest answer, only when that is short enough to fit.
// A watch whose pane ends leaves the Watching card at once: the card shows
// only sessions that are working or idle.

const KEY = 'raven:watches'
export const TICK_MS = 8_000
export const QUIET_MS = 12_000
export const STALE_MS = 24 * 3_600_000
const RELAY_MAX = 3_000
// odin's clock against the one that stamped the transcript (thor's)
const SKEW_MS = 2_000

export type Watch = {
  /** the pane name, or 'sid:<conversation id>' for a thor session with no pane here */
  key: string
  /** the tmux pane, '' for a thor session in a Windows Terminal window */
  pane: string
  label: string
  sessionId: string
  /** ISO */
  since: string
  /** ISO: the last new transcript entry (or the watch's start) */
  lastActivityAt: string
  cursor: string
  /** the transcript was found and read up to `cursor` at least once */
  baselined: boolean
  /** ms: when the last new entry arrived here */
  lastNewAt: number
  /** ms: the newest entry's own time, the line a rewind is read against */
  lastSeenAt: number
  /** Claude's answer so far: the assistant text entries after the last prompt or tool step */
  tail: { id: string; text: string }[]
  lastRelayedId: string
  /** what Raven does with the next answer (once) */
  followUp: string
  /** the job's name from Raven's label (session_start, session_send); '' or absent when Raven gave none */
  title?: string
  /** the first sentence of its newest answer, '' when that is too long for one line */
  status?: string
}

const meaningful = (e: TranscriptEntry) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool' || e.kind === 'result'

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const STATUS_MAX = 140
// markdown that does not show on the card: emphasis, code ticks, links, a list or heading lead
const MD_LEAD = /^(?:[>#*+-]+|\d+[.)])\s+/

/** The status line of an answer: its first sentence as plain text; '' when it runs past STATUS_MAX. */
export function statusOf(text: string): string {
  const first = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const line = flat(first.replace(MD_LEAD, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
  const m = /^.+?[.!?](?=\s|$)/u.exec(line)
  const s = (m ? m[0] : line).replace(/:$/, '').trim()
  return s.length <= STATUS_MAX ? s : ''
}

export function listWatches(): Watch[] {
  try {
    const v = JSON.parse(getKv(KEY) ?? '[]') as Watch[]
    return Array.isArray(v) ? v.filter((w) => w && typeof w.key === 'string') : []
  } catch {
    return []
  }
}

function saveWatches(list: Watch[], changed = true): void {
  setKv(KEY, JSON.stringify(list))
  if (changed) bump()
}

export const watchKey = (pane: string, sessionId: string): string => pane || `sid:${sessionId}`

export function getWatch(key: string): Watch | null {
  return listWatches().find((w) => w.key === key) ?? null
}

async function readPage(w: Pick<Watch, 'pane' | 'sessionId'>, cursor: string): Promise<TranscriptPage | null> {
  return w.pane ? io.paneTranscript(w.pane, cursor) : io.boardTranscript(w.sessionId, cursor)
}

/**
 * Starts (or refreshes) a watch. A session Raven just opened (`fresh`) has no
 * transcript yet, so all of it is news. Any other session is read once now,
 * before anything is typed into it, so what it said before is never relayed
 * and an answer that comes back within seconds still is.
 */
export async function startWatch(w: { pane: string; label: string; sessionId: string; followUp?: string; fresh?: boolean; title?: string }): Promise<Watch> {
  const key = watchKey(w.pane, w.sessionId)
  const nowMs = io.now()
  const now = new Date(nowMs).toISOString()
  const cur = getWatch(key)
  if (cur) {
    const list = listWatches()
    const x = list.find((y) => y.key === key)!
    x.label = w.label || x.label
    if (w.sessionId) x.sessionId = w.sessionId
    if (w.followUp !== undefined) x.followUp = w.followUp
    if (w.title) x.title = w.title
    x.lastActivityAt = now
    saveWatches(list)
    return x
  }
  const next: Watch = {
    key, pane: w.pane, label: w.label, sessionId: w.sessionId, since: now, lastActivityAt: now,
    cursor: '', baselined: Boolean(w.fresh), lastNewAt: nowMs, lastSeenAt: 0, tail: [], lastRelayedId: '', followUp: w.followUp ?? '',
    title: w.title ?? '', status: '',
  }
  if (!w.fresh) {
    try {
      const page = await readPage(next, '')
      if (page?.sessionId) {
        next.baselined = true
        next.cursor = page.cursor
        next.sessionId = page.sessionId
        next.lastSeenAt = Math.max(0, ...page.entries.map((e) => e.at || 0))
      }
    } catch (e) {
      // the first tick reads it instead, keeping only entries newer than the watch
      console.error(`[raven-watch] ${w.label} first read:`, (e as Error).message)
    }
  }
  const list = listWatches().filter((y) => y.key !== key)
  list.push(next)
  saveWatches(list)
  return next
}

export function removeWatch(key: string): boolean {
  const list = listWatches()
  const left = list.filter((w) => w.key !== key)
  if (left.length === list.length) return false
  saveWatches(left)
  return true
}

/** Folds new entries into the watch: the answer tail resets on every prompt or tool step. */
function take(w: Watch, entries: TranscriptEntry[]): boolean {
  let any = false
  for (const e of entries) {
    if (e.at) w.lastSeenAt = Math.max(w.lastSeenAt, e.at)
    if (!meaningful(e)) continue
    any = true
    // a new prompt: the last turn's status says nothing about it
    if (e.kind === 'user' && e.text?.trim()) w.status = ''
    if (e.kind === 'assistant' && e.text?.trim()) {
      w.status = statusOf(e.text)
      if (!w.tail.some((t) => t.id === e.id)) w.tail.push({ id: e.id, text: e.text.trim() })
    } else {
      w.tail = []
    }
  }
  if (w.tail.length > 12) w.tail = w.tail.slice(-12)
  return any
}

function relay(w: Watch, text: string): void {
  const refs: Ref[] = w.pane ? [{ type: 'link', url: `/m/ai/term/${w.pane}`, label: 'Open' }] : []
  ravenPost(clip(text, RELAY_MAX), {
    refs,
    meta: { relay: { kind: 'session', from: w.pane || w.sessionId, label: w.label, sessionId: w.sessionId || undefined } },
    push: true,
  })
  if (w.followUp) {
    wakeRavenWith('session_reply', { pane: w.pane, label: w.label, sessionId: w.sessionId, text: clip(text, 6000), followUp: w.followUp })
    w.followUp = ''
  }
}

/** The parts of the answer not relayed yet: Claude can add text after a relay with no prompt or tool between. */
const answerOf = (w: Watch): string => w.tail.slice(w.tail.findIndex((t) => t.id === w.lastRelayedId) + 1).map((t) => t.text).join('\n\n')

/** Still watched, and the same watch: a tool can turn it off (or stop the pane) while a pass is reading. */
const stillWatched = (w: Watch): boolean => getWatch(w.key)?.since === w.since

async function tickOne(w: Watch, now: number): Promise<boolean> {
  let page: TranscriptPage | null = null
  try {
    page = await readPage(w, w.cursor)
  } catch (e) {
    // thor asleep or its file service down: a pane that died meanwhile must still end below
    console.error(`[raven-watch] ${w.label}:`, (e as Error).message)
  }
  if (page?.sessionId) {
    let entries = page.entries
    if (!w.baselined) {
      // the first read failed when the watch began: only what came after it is news
      const since = Date.parse(w.since) - SKEW_MS
      entries = entries.filter((e) => e.at >= since)
      w.baselined = true
    } else if (page.reset) {
      // a /clear or a rewind: the page is the live branch's newest entries, some already seen
      entries = entries.filter((e) => e.at > w.lastSeenAt)
    }
    w.cursor = page.cursor
    w.sessionId = page.sessionId
    if (take(w, entries)) {
      w.lastNewAt = now
      w.lastActivityAt = new Date(now).toISOString()
    }
    // a burst bigger than one read (page.more) comes in over the next ticks
  }
  const newest = w.tail[w.tail.length - 1]
  const unrelayed = Boolean(newest && newest.id !== w.lastRelayedId)
  if (w.pane) {
    const state = await io.paneState(w.pane)
    if (state === 'dead' || state === 'gone') {
      if (!stillWatched(w)) return false
      if (unrelayed) relay(w, answerOf(w))
      ravenPost(`${w.label} ended`, { meta: { relay: { kind: 'session', from: w.pane, label: w.label, sessionId: w.sessionId || undefined } } })
      return false
    }
  }
  if (unrelayed && now - w.lastNewAt >= QUIET_MS) {
    // a pane still showing Claude's spinner is mid-turn: that text was narration, not the answer
    const busy = w.pane ? screenBusy(await io.capture(w.pane)) : false
    if (!busy && stillWatched(w)) {
      relay(w, answerOf(w))
      w.lastRelayedId = newest.id
    }
  }
  return now - Date.parse(w.lastActivityAt) <= STALE_MS
}

/** One pass over every watch. Exported for the smoke test, which calls it instead of waiting on the timer. */
export async function tickWatches(): Promise<void> {
  const list = listWatches()
  if (!list.length) return
  const original = new Map(list.map((w) => [w.key, JSON.stringify(w)]))
  const now = io.now()
  const done = new Map<string, Watch>()
  const dropped = new Set<string>()
  for (const w of list) {
    let keep = true
    try {
      keep = await tickOne(w, now)
    } catch (e) {
      console.error(`[raven-watch] ${w.label}:`, (e as Error).message)
      keep = now - Date.parse(w.lastActivityAt) <= STALE_MS
    }
    if (keep) done.set(w.key, w)
    else dropped.add(w.key)
  }
  if (!dropped.size && list.every((w) => JSON.stringify(w) === original.get(w.key))) return
  // A tool can change a watch during the pass (session_send refreshes it, a
  // new follow-up). What the tool changed wins; everything else is the pass's,
  // above all how far it read and what it relayed, or the next pass relays the
  // same answer (and wakes Raven with it) a second time. A watch that was
  // turned off, or off and on again, during the pass is left as the tool left it.
  const merged = listWatches().filter((w) => !dropped.has(w.key)).map((stored) => {
    const mine = done.get(stored.key)
    const raw = original.get(stored.key)
    if (!mine || !raw) return stored
    const before = JSON.parse(raw) as Watch
    if (before.since !== stored.since) return stored
    const out = { ...mine } as Record<string, unknown>
    for (const k of Object.keys(stored) as (keyof Watch)[]) {
      if (JSON.stringify(stored[k]) !== JSON.stringify(before[k])) out[k] = stored[k]
    }
    out.lastActivityAt = stored.lastActivityAt > mine.lastActivityAt ? stored.lastActivityAt : mine.lastActivityAt
    return out as Watch
  })
  saveWatches(merged, dropped.size > 0)
}

let timer: NodeJS.Timeout | null = null
let running = false

/** Starts the 8 s pass. Called once by startRavenTools. */
export function startWatcher(): void {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tickWatches().catch((e) => console.error('[raven-watch]', (e as Error).message)).finally(() => { running = false })
  }, TICK_MS)
  timer.unref?.()
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}
