import type { TermSession } from './tmux.js'
import type { TranscriptEntry, TranscriptPage } from './transcript.js'

// What a pane's Claude is doing, for the Desk's tabs: working, done, or done
// with a follow-up for Brendon. His words: "i want to know when the session is
// done working, or if it has a follow up for me. i want those to be
// differentiated."
//
//   dead     tmux kept the pane after its program failed.
//   shell    a shell pane: no Claude in it.
//   working  the pane printed something in the last 30 s and its screen shows
//            Claude's busy line ("esc to interrupt"). Raven's tools use the
//            same check (lib/raven/tools/sessions.ts and watch.ts).
//   asking   Claude is done and wants something from him: thor's session board
//            says the session waits on him (a permission prompt or a dialog),
//            or Claude's last reply ends with a question, or has a `Next:` line.
//   idle     done, and asked nothing (or not started yet).
//
// Cost, with a dozen panes open and the Desk polling every 2 s: a pane's screen
// is captured only while it printed in the last 30 s, at most once per 1.5 s;
// its transcript is read once per turn end, never per poll; thor's board comes
// from the one copy this box already keeps (routes/hostLaunch.ts boardNow). A
// list never waits long on any of them: past a short wait it answers with what
// it knew, and the late answer lands for the next poll.

export type PaneStateWord = 'working' | 'asking' | 'idle' | 'shell' | 'dead'
export type PaneStateFields = {
  state: PaneStateWord
  /** the question or `Next:` line when asking, one line of at most 160 characters; '' otherwise */
  ask: string
  /** ms epoch when `state` last changed, in memory: the first read is "now" */
  stateSince: number
}

// ---------------------------------------------------------- the busy rule ----

export const BUSY_RE = /esc to interrupt/i
// the spinner repaints every second; a pane quiet for half a minute is not working
export const BUSY_WINDOW_MS = 30_000

type Printed = Pick<TermSession, 'name' | 'dead' | 'activityAt'> & { outputAt?: number }

/** Claude's busy line on a captured screen. */
export const screenBusy = (screen: string | null | undefined): boolean => BUSY_RE.test(screen ?? '')

/** When the pane last printed: tmux's window activity, or the session's own (a key, an attach) when that is newer. */
export const lastPrinted = (p: Printed): number => Math.max(p.outputAt ?? 0, p.activityAt || 0)

/** A pane worth capturing at all: alive, and it printed in the last 30 s. */
export const mayBeBusy = (p: Printed, now: number): boolean => !p.dead && now - lastPrinted(p) <= BUSY_WINDOW_MS

/** The busy rule: printed in the last 30 s AND the screen shows Claude's busy line. */
export async function paneBusy(p: Printed, capture: (name: string) => Promise<string | null>, now: number): Promise<boolean> {
  if (!mayBeBusy(p, now)) return false
  return screenBusy(await capture(p.name))
}

// -------------------------------------------------------------- the title ----

const TITLE_MAX = 120
// Claude's own title before it names the session
const CLAUDE_DEFAULT = /^claude(?: code)?$/i
const SHELLS = ['bash', 'sh', 'zsh', 'fish', 'ssh', 'tmux', 'login', 'powershell', 'pwsh', 'cmd', 'conhost',
  'windows powershell', 'command prompt']
// an executable path or bare exe name (ConPTY's first title on thor is the shell's path), or a
// shell prompt's user@host: dir. A name with spaces that only ends in ".exe" is a real title.
const PATHLIKE = /^(?:[a-z]:[\\/]|\\\\|\/)|^\S+\.exe$/i
const USER_AT = /^[\w.-]+@[\w.-]+:/

/**
 * The pane's title as Claude sets it (the session's name after /rename, or
 * the topic Claude picked), without Claude's status glyph in front (spinner
 * frames, the ✳ mark, any symbol). '' when it is tmux's default (the host
 * name), a shell's or the pane command's name, a path, or Claude's own
 * placeholder.
 */
export function cleanTitle(raw: string, defaults: readonly string[] = []): string {
  // eslint-disable-next-line no-control-regex
  const flat = (raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const bare = flat.replace(/^administrator:\s*/i, '')
  if (PATHLIKE.test(bare) || USER_AT.test(bare)) return ''
  // letters, digits, an opening bracket or quote start the name; anything before them is a glyph
  const title = flat.replace(/^[^\p{L}\p{N}([{"'“‘]+/u, '').trim()
  if (!title || CLAUDE_DEFAULT.test(title)) return ''
  const low = title.replace(/^administrator:\s*/i, '').toLowerCase()
  if (SHELLS.includes(low)) return ''
  for (const d of defaults) {
    const v = (d ?? '').trim().toLowerCase()
    if (v && (low === v || low === v.split('.')[0])) return ''
  }
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title
}

// --------------------------------------------------------- the asking rule ----

export const ASK_MAX = 160
// any indent: Claude puts code blocks under nested list items, four and more spaces in
const FENCE = /^\s*(`{3,}|~{3,})/
// trailing markdown, quotes, brackets and spaces, before the last character is read
const TRAIL = /[\s*_~`"'”’»)\]]+$/u
const LEAD = /^[\s>*_#+-]+/

const oneLine = (s: string): string => s.replace(/\*\*|__/g, '').replace(LEAD, '').replace(/\s+/g, ' ').trim()
const clipAsk = (s: string): string => (s.length > ASK_MAX ? `${s.slice(0, ASK_MAX - 1).trimEnd()}…` : s)

/**
 * The follow-up in a reply: its last non-empty line when that ends with a
 * question mark (code blocks do not count, and a reply that ends in one asks
 * nothing), else its last line that starts with `Next:`. '' when neither.
 */
export function askLine(reply: string): string {
  let fence = ''
  let last = ''
  let next = ''
  for (const line of (reply ?? '').replace(/\r/g, '').split('\n')) {
    const f = FENCE.exec(line)
    if (f) {
      if (!fence) fence = f[1][0]
      else if (f[1][0] === fence) fence = ''
      last = ''
      continue
    }
    if (!line.trim()) continue
    if (fence) {
      last = ''
      continue
    }
    last = line
    const bare = oneLine(line)
    if (bare.startsWith('Next:')) next = bare
  }
  const q = last.replace(TRAIL, '')
  if (q.endsWith('?') || q.endsWith('？')) return clipAsk(oneLine(last))
  return next ? clipAsk(next) : ''
}

/**
 * Claude's last reply: the assistant text after the last prompt, tool step or
 * interrupt, joined. '' when the newest thing is not Claude's text (a prompt
 * he typed, a tool still waiting on its result).
 */
export function lastReply(entries: readonly TranscriptEntry[]): string {
  const parts: string[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'assistant') {
      if (e.text?.trim()) parts.unshift(e.text)
      continue
    }
    if (e.kind === 'thinking' || e.kind === 'todo' || (e.kind === 'system' && e.text !== 'Interrupted')) continue
    break
  }
  return parts.join('\n\n')
}

// ------------------------------------------------------------ the tracker ----

type BoardRowLike = Record<string, unknown>

export type PaneStateIo = {
  /** the pane's visible screen; null when it cannot be read */
  capture: (name: string) => Promise<string | null>
  /** the pane's newest transcript page (terminal/transcriptFeed.ts paneTranscript) */
  transcript: (name: string) => Promise<TranscriptPage | null>
  /**
   * thor's board rows as last known, with when that read started (ms epoch), never waiting on
   * thor; null when unknown. `after`: the pane's last turn ended then (0 = none seen), so a copy
   * read before it is stale and the board should be read again soon.
   */
  board: (after: number) => { at: number; rows: readonly BoardRowLike[] } | null
  now: () => number
}

export const CAPTURE_EVERY_MS = 1_500
// the longest one list waits on a capture, then on a transcript read
export const CAPTURE_WAIT_MS = 1_000
export const ASK_WAIT_MS = 800
// a pane that printed while nobody saw it busy (a short turn between two
// polls) has its transcript read again, at most this often
export const RECHECK_MS = 10_000
const FORGET_MS = 10 * 60_000
/** `ask` for a session the board says waits on him, when its last reply asked nothing */
export const BOARD_ASK = 'Waiting for you in the session'

type Track = {
  state: PaneStateWord | null
  since: number
  seen: number
  busy: boolean
  capAt: number
  capBusy: boolean
  capping: Promise<boolean> | null
  /** when the current turn ended (0 = not yet seen idle, or working again) */
  turnAt: number
  /** when this tracker last saw the pane go from working to done (0 = never) */
  endedAt: number
  /** the turnAt the transcript was last read for */
  askFor: number
  ask: string
  /** when the last transcript read started */
  readAt: number
  reading: Promise<void> | null
  /** the conversation the transcript last named: /clear moves a pane to a new id */
  sid: string
}

const fresh = (): Track => ({
  state: null, since: 0, seen: 0, busy: false, capAt: 0, capBusy: false, capping: null,
  turnAt: 0, endedAt: 0, askFor: -1, ask: '', readAt: 0, reading: null, sid: '',
})

function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const wait = new Promise<T>((r) => { timer = setTimeout(() => r(late), ms) })
  return Promise.race([p, wait]).finally(() => clearTimeout(timer))
}

export type PaneStates = {
  /** the rows with state, ask and stateSince; the order and every other field are kept */
  annotate: <T extends TermSession>(rows: readonly T[]) => Promise<(T & PaneStateFields)[]>
}

export function paneStateTracker(io: PaneStateIo): PaneStates {
  const tracks = new Map<string, Track>()

  function captureBusy(name: string, t: Track, now: number): Promise<boolean> {
    if (t.capping) return t.capping
    if (t.capAt && now - t.capAt < CAPTURE_EVERY_MS) return Promise.resolve(t.capBusy)
    t.capAt = now
    // a screen that cannot be read keeps the last answer
    const p: Promise<boolean> = io.capture(name)
      .then((s) => (s == null ? t.capBusy : screenBusy(s)), () => t.capBusy)
      .then((b) => { t.capBusy = b; return b })
      .finally(() => { if (t.capping === p) t.capping = null })
    t.capping = p
    return p
  }

  function readAsk(name: string, t: Track, now: number): Promise<void> {
    const turn = t.turnAt
    t.readAt = now
    const p: Promise<void> = io.transcript(name)
      .then((page) => {
        if (t.turnAt !== turn) return
        if (page?.sessionId) t.sid = page.sessionId
        t.ask = page ? askLine(lastReply(page.entries)) : ''
        t.askFor = turn
      }, () => {
        // thor's file service is not answering: asked again after RECHECK_MS, the ask stays as known
      })
      .finally(() => { if (t.reading === p) t.reading = null })
    t.reading = p
    return p
  }

  function boardAsking(sessionId: string, t: Track): boolean {
    const b = io.board(t.endedAt)
    // a copy read before the turn ended can still hold a prompt he has since answered
    if (!b || b.at < t.endedAt) return false
    return b.rows.some((r) => r.activity === 'asking' && typeof r.sessionId === 'string' && r.sessionId !== ''
      && (r.sessionId === sessionId || r.sessionId === t.sid))
  }

  async function one<T extends TermSession>(row: T, now: number): Promise<T & PaneStateFields> {
    let t = tracks.get(row.name)
    if (!t) {
      t = fresh()
      tracks.set(row.name, t)
    }
    t.seen = now
    let state: PaneStateWord
    let ask = ''
    if (row.dead) state = 'dead'
    else if (row.mode === 'shell') state = 'shell'
    else {
      const printing = mayBeBusy(row, now)
      // quiet for 30 s: an older capture's "busy" is no answer to fall back on later
      if (!printing && !t.capping) t.capBusy = false
      const busy = printing ? await within(captureBusy(row.name, t, now), CAPTURE_WAIT_MS, t.capBusy) : false
      if (busy) {
        t.busy = true
        // whatever the last turn asked, he has answered it: Claude is working again. A read
        // from the last turn end still out lands on a stale turn and is dropped.
        t.ask = ''
        t.turnAt = 0
        state = 'working'
      } else {
        const ended = t.busy || t.turnAt === 0
        if (t.busy) t.endedAt = now
        const missed = !ended && !t.reading && lastPrinted(row) + 1_000 > t.readAt && now - t.readAt >= RECHECK_MS
        if (ended || missed) t.turnAt = now
        t.busy = false
        if (t.askFor !== t.turnAt && !t.reading && (t.readAt < t.turnAt || now - t.readAt >= RECHECK_MS)) readAsk(row.name, t, now)
        if (t.reading) await within(t.reading, ASK_WAIT_MS, undefined)
        // the board is asked first either way: a turn end it has not seen yet starts a fresh read
        const onBoard = boardAsking(row.sessionId, t)
        ask = t.ask || (onBoard ? BOARD_ASK : '')
        state = ask ? 'asking' : 'idle'
      }
    }
    if (t.state !== state) {
      t.state = state
      t.since = now
    }
    return { ...row, state, ask: state === 'asking' ? ask : '', stateSince: t.since }
  }

  return {
    async annotate(rows) {
      const now = io.now()
      const out = await Promise.all(rows.map((r) => one(r, now)))
      for (const [name, t] of tracks) if (now - t.seen > FORGET_MS && !t.capping && !t.reading) tracks.delete(name)
      return out
    },
  }
}
