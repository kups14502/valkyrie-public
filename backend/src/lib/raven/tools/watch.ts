import { bump, getKv, setKv, type Ref } from '../../agentsStore.js'
import { paneLimitState } from '../../accountSwitchCore.js'
import { ravenPost, wakeRavenWith } from '../hooks.js'
import type { RavenSaid } from '../types.js'
import type { TranscriptEntry, TranscriptPage } from '../../../terminal/transcript.js'
import { screenBusy, screenWaiting } from '../../../terminal/paneState.js'
import { io } from './io.js'
import { clip } from './util.js'

// The watcher: everything a watched Claude session writes goes to Raven, and
// Raven tells Brendon what matters. Every 8 s each watched session's
// transcript is read forward from a cursor. Every line Claude writes, its
// progress lines too, is kept in full (with the prompts typed into it, for
// context) until it is handed to Raven as one event:
//   - at the end of a turn: nothing new for 12 s and a pane's screen no longer
//     shows the working spinner (session_reply). It says whether a question or
//     permission prompt is open there and whether background work is still out.
//   - mid-turn, once a minute: the oldest unread line is 60 s old and Claude has
//     moved on to a tool step since (session_progress). A line that is still the
//     newest can be the turn's answer, so it waits for the 12 s check.
//   - when a pane dies (session_reply, ended).
// Brendon asked for it 2026-11-21: "make it so you read every shortened working
// message, and read the important ones and communicate them to me." Nothing a
// session writes is posted in the thread: Raven's own short take replaces it
// (lib/raven/run.ts keeps a copy under that take, collapsed). Only while Raven
// is not running does a turn's answer still post raw, as before.
//
// Watches live in agents.sqlite's kv (raven:watches), cursor and unread lines
// included, so a restart picks up where it left off without handing anything
// over twice. A watch with no activity for 24 h drops on its own.
//
// The Watching card's title is the job's name as Raven gave it, the label of
// session_start or session_send, and nothing else: no prompt, no answer and no
// Claude title ever names it. His screenshot showed a cut-off sentence of a
// prompt and a release headline as titles. Without a label the card shows the
// pane's own label. Under it the card shows the session's latest status line,
// the first sentence of its newest answer, only when that is short enough to fit.
// A watch whose pane ends leaves the Watching card at once: the card shows
// only sessions that are working or idle.
//
// A job is a session Raven opened with session_start for one piece of work
// (never a main terminal). Each turn's end of a job tells Raven it is one, so
// the run that reads "I shipped v0.3.211" is the run that closes it. On
// 2026-11-21 that report was relayed at 1:39 AM ET with no follow-up, so no
// run ever read it, and its card said Working until he asked at 2:01 AM ET.
// A job that stays quiet AUTO_CLOSE_MS after a turn's end was handed over is
// closed and marked done on its own (autoclose.ts), unless Raven holds it open
// with session_keep while it waits on something long, a release or a build.

const KEY = 'raven:watches'
export const TICK_MS = 8_000
export const QUIET_MS = 12_000
/** how long a mid-turn line waits for others before Raven reads them together */
export const BATCH_MS = 60_000
export const STALE_MS = 24 * 3_600_000
/** A job quiet this long after its last relayed answer closes on its own; a background wait counts as Working this long after its last activity. */
export const AUTO_CLOSE_MS = 15 * 60_000
/** the raw answer when Raven is not running to read it */
const RELAY_MAX = 3_000
/** a prompt is context for Raven, not news: its head is enough */
const PROMPT_MAX = 1_000
const PENDING_MAX = 200
// odin's clock against the one that stamped the transcript (thor's)
const SKEW_MS = 2_000

type EntryKind = TranscriptEntry['kind']

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
  /** what it wrote since Raven last read it: every line Claude wrote, in full, and the prompts typed into it */
  pending: RavenSaid[]
  /** ms: when the oldest of Claude's lines in `pending` arrived here; 0 when there is none */
  pendingSince: number
  /** the newest meaningful entry's kind: 'tool' is a step still open (a permission prompt can wait on it) */
  lastKind: EntryKind | ''
  /** the lastNewAt of the last quiet spell read as a turn's end, so each spell is read once */
  settledAt: number
  /** what Raven does with the next answer (once) */
  followUp: string
  /** the job's name from Raven's label (session_start, session_send); '' or absent when Raven gave none */
  title?: string
  /** the first sentence of its newest answer, '' when that is too long for one line */
  status?: string
  /** a session Raven opened with session_start (never a main): Raven closes it once it reports done, or it closes on its own once quiet */
  job?: boolean
  /** ms: when its newest turn's end (with Claude's lines) was handed to Raven */
  relayedAt?: number
  /** ms: session_keep holds the auto-close (and a background wait's Working) until then */
  keepUntil?: number
}

/**
 * When a job closes on its own: AUTO_CLOSE_MS after a turn's end was handed to Raven with nothing new since, or when
 * session_keep's hold ends if that is later. null when it is not due to: not a job, a window on thor, no turn's end
 * handed over yet, or anything after it (a prompt, a tool step, more text, or Raven typing into it).
 */
export function closesAt(w: Watch): number | null {
  if (!w.job || !w.pane || !w.relayedAt) return null
  if (w.pending.some((s) => s.from === 'claude') || Date.parse(w.lastActivityAt) > w.relayedAt) return null
  return Math.max(w.relayedAt + AUTO_CLOSE_MS, w.keepUntil ?? 0)
}

/**
 * Watching's bound on a background wait: it counts as Working while the session had activity in the last
 * AUTO_CLOSE_MS (a transcript line, or Raven typing into it), or while session_keep holds it. A wait left over
 * after the last answer (a poll that outlived the job) reads Idle after that, never Working for good.
 */
export const waitCounts = (w: Pick<Watch, 'lastActivityAt' | 'keepUntil'>, now: number): boolean =>
  now - (Date.parse(w.lastActivityAt) || 0) < AUTO_CLOSE_MS || (w.keepUntil ?? 0) > now

/** A watch as stored before every line went to Raven: the final answer's parts and the last one relayed. */
type OldWatch = Watch & { tail?: { id: string; text: string }[]; lastRelayedId?: string }

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

/** A stored watch in today's shape: an old one's unrelayed answer becomes unread lines, its quiet spell counts as read. */
function norm(w: OldWatch): Watch {
  if (Array.isArray(w.pending)) return w
  const tail = Array.isArray(w.tail) ? w.tail : []
  const left = tail.slice(tail.findIndex((t) => t.id === w.lastRelayedId) + 1)
  const out: OldWatch = {
    ...w,
    pending: left.map((t) => ({ id: t.id, at: w.lastNewAt || 0, from: 'claude' as const, text: t.text })),
    pendingSince: left.length ? w.lastNewAt || 1 : 0,
    lastKind: left.length ? 'assistant' : '',
    settledAt: left.length ? 0 : w.lastNewAt,
  }
  delete out.tail
  delete out.lastRelayedId
  return out
}

export function listWatches(): Watch[] {
  try {
    const v = JSON.parse(getKv(KEY) ?? '[]') as OldWatch[]
    return Array.isArray(v) ? v.filter((w) => w && typeof w.key === 'string').map(norm) : []
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
 * before anything is typed into it, so what it said before never reaches Raven
 * and an answer that comes back within seconds still does.
 */
export async function startWatch(w: { pane: string; label: string; sessionId: string; followUp?: string; fresh?: boolean; title?: string; job?: boolean }): Promise<Watch> {
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
    if (w.job) x.job = true
    x.lastActivityAt = now
    saveWatches(list)
    return x
  }
  const next: Watch = {
    key, pane: w.pane, label: w.label, sessionId: w.sessionId, since: now, lastActivityAt: now,
    cursor: '', baselined: Boolean(w.fresh), lastNewAt: nowMs, lastSeenAt: 0, pending: [], pendingSince: 0, lastKind: '', settledAt: 0,
    followUp: w.followUp ?? '', title: w.title ?? '', status: '', ...(w.job ? { job: true } : {}),
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

/** session_keep: holds a job's auto-close, and its background wait's Working, until `until` (ms). */
export function keepWatch(key: string, until: number): boolean {
  const list = listWatches()
  const w = list.find((y) => y.key === key)
  if (!w) return false
  w.keepUntil = until
  saveWatches(list)
  return true
}

export function removeWatch(key: string): boolean {
  const list = listWatches()
  const left = list.filter((w) => w.key !== key)
  if (left.length === list.length) return false
  saveWatches(left)
  return true
}

/** Adds a line once (a page read twice never doubles it). True when it was new. */
function add(w: Watch, s: RavenSaid): boolean {
  if (w.pending.some((p) => p.id === s.id)) return false
  w.pending.push(s)
  // a bound for a watch Raven never reads (it is not running): the newest lines stay
  if (w.pending.length > PENDING_MAX) w.pending = w.pending.slice(-PENDING_MAX)
  return true
}

/** Folds new entries into the watch: every line Claude writes and every prompt typed, oldest first. */
function take(w: Watch, entries: TranscriptEntry[], now: number): boolean {
  let any = false
  for (const e of entries) {
    if (e.at) w.lastSeenAt = Math.max(w.lastSeenAt, e.at)
    if (!meaningful(e)) continue
    any = true
    w.lastKind = e.kind
    const text = e.text?.trim() ?? ''
    if (e.kind === 'user' && text) {
      // a new prompt: the last turn's status says nothing about it
      w.status = ''
      add(w, { id: e.id, at: e.at || now, from: 'prompt', text: clip(text, PROMPT_MAX) })
    } else if (e.kind === 'assistant' && text) {
      w.status = statusOf(text)
      if (add(w, { id: e.id, at: e.at || now, from: 'claude', text }) && !w.pendingSince) w.pendingSince = now
    }
  }
  return any
}

/** Claude's lines since its last prompt in `said`: the turn's answer, for the raw post when Raven is not running. */
function answerIn(said: RavenSaid[]): string {
  const from = said.map((s) => s.from).lastIndexOf('prompt') + 1
  return said.slice(from).filter((s) => s.from === 'claude').map((s) => s.text).join('\n\n')
}

/** Raven is not running: a turn's answer posts raw in the thread, as it did before Raven read every line. */
function postRaw(w: Watch, said: RavenSaid[], ended: boolean): void {
  const relay = { kind: 'session' as const, from: w.pane || w.sessionId, label: w.label, sessionId: w.sessionId || undefined }
  const answer = answerIn(said)
  if (answer) {
    const refs: Ref[] = w.pane ? [{ type: 'link', url: `/m/ai/term/${w.pane}`, label: 'Open' }] : []
    ravenPost(clip(answer, RELAY_MAX), { refs, meta: { relay }, push: true })
  }
  if (ended) ravenPost(`${w.label} ended`, { meta: { relay } })
}

type HandOff = {
  /** the turn is over (quiet, no spinner), or the pane ended */
  turnEnded: boolean
  ended?: boolean
  /** its screen shows no prompt box: a question, a permission prompt or a menu is open */
  asking?: boolean
  /** the turn ended with a background shell, monitor or agent still running */
  background?: boolean
}

/**
 * Hands the unread lines to Raven as one event and clears them. A mid-turn batch Raven does not take (it is not
 * running) stays for the turn's end, which then posts raw.
 */
function handOff(w: Watch, f: HandOff, now: number): void {
  const said = w.pending
  const followUp = f.turnEnded ? w.followUp : ''
  const answered = f.turnEnded && said.some((s) => s.from === 'claude')
  // a job's turn ends with its answer: this run decides whether the job is done (a pane that ended needs no stop)
  const job = Boolean(answered && w.job && w.pane && !f.ended)
  const took = wakeRavenWith(f.turnEnded ? 'session_reply' : 'session_progress', {
    pane: w.pane, label: w.label, title: w.title || undefined, sessionId: w.sessionId || undefined,
    said: said.map(({ at, from, text }) => ({ at, from, text })),
    turnEnded: f.turnEnded, ended: f.ended || undefined, asking: f.asking || undefined, background: f.background || undefined,
    followUp: followUp || undefined, job: job || undefined,
  })
  if (!took) {
    if (!f.turnEnded) return
    postRaw(w, said, Boolean(f.ended))
  }
  w.pending = []
  w.pendingSince = 0
  if (f.turnEnded) w.followUp = ''
  if (answered) w.relayedAt = now
}

/** No prompt box on the pane's screen: a question, a permission prompt or a menu waits on him. False when it cannot tell. */
async function promptClosed(pane: string): Promise<boolean> {
  try {
    // scrolled back (he is reading it on the phone): the screen says nothing about the prompt
    if (await io.paneInMode(pane)) return false
    const screen = await io.capturePrompt(pane)
    return Boolean(screen?.trim()) && !paneLimitState(screen!).promptFound
  } catch {
    return false
  }
}

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
    if (take(w, entries, now)) {
      w.lastNewAt = now
      w.lastActivityAt = new Date(now).toISOString()
    }
    // a burst bigger than one read (page.more) comes in over the next ticks
  }
  const keep = now - Date.parse(w.lastActivityAt) <= STALE_MS
  if (w.pane) {
    const state = await io.paneState(w.pane)
    if (state === 'dead' || state === 'gone') {
      // the end is news by itself, with whatever it wrote last
      if (stillWatched(w)) handOff(w, { turnEnded: true, ended: true }, now)
      return false
    }
  }
  const claude = w.pending.some((s) => s.from === 'claude')
  // a quiet spell, read once: the turn is over unless the pane still shows Claude's spinner (a long tool step, thinking).
  // A step still open with nothing written can be a permission prompt waiting on him.
  if ((claude || w.lastKind === 'tool') && now - w.lastNewAt >= QUIET_MS && w.settledAt !== w.lastNewAt) {
    const screen = w.pane ? await io.capture(w.pane) : null
    if (!screenBusy(screen)) {
      w.settledAt = w.lastNewAt
      const asking = w.pane ? await promptClosed(w.pane) : false
      if ((claude || asking) && stillWatched(w)) handOff(w, { turnEnded: true, asking, background: screenWaiting(screen) }, now)
      return keep
    }
  }
  // mid-turn, once a minute. Claude's newest line can be the turn's answer: it waits for the quiet check instead
  if (claude && w.lastKind !== 'assistant' && now - w.pendingSince >= BATCH_MS && stillWatched(w)) handOff(w, { turnEnded: false }, now)
  return keep
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

/** Starts the 8 s pass; `after` runs once each pass is done (the jobs' auto-close). Called once by startRavenTools. */
export function startWatcher(after?: () => Promise<void>): void {
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void tickWatches()
      .then(() => after?.())
      .catch((e) => console.error('[raven-watch]', (e as Error).message))
      .finally(() => { running = false })
  }, TICK_MS)
  timer.unref?.()
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer)
  timer = null
}
