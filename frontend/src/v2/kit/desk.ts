import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchTermSessions, type PaneState, type TermSession } from '../../lib/api'
import { TERM_NAME_RE } from '../../lib/term'

// The Desk's state that outlives the Desk screen (screens/Desk.tsx): the one
// shared read of the pane list, which panes finished while he was not looking
// at them, and where each tab sits. The Desk tab's badge in the nav reads the
// same store from any screen, so the count is right before the Desk was ever
// opened. Both are kept per device in localStorage.

/** The pane list's query key, shared with the terminal page and AI > Sessions (lib/sessionLaunch seedTerminal). */
const PANES_KEY = ['term', 'sessions'] as const

/** What a tab's mark shows. A pane from an API older than the Desk has no state: idle. */
export function paneState(s: TermSession): PaneState {
  if (s.dead) return 'dead'
  if (s.state) return s.state
  return s.mode === 'shell' ? 'shell' : 'idle'
}

/**
 * The pane list, polled every `poll` ms: 2 s while the Desk is on screen and
 * 15 s otherwise. One query for every caller: each answer restarts every
 * caller's timer, so the fastest one sets the pace. `list` is the list to
 * draw: one empty answer after a list that named panes is held over (see
 * steady). Each new list goes through the done tracker below.
 */
export function useDeskPanes(poll: number) {
  const query = useQuery({ queryKey: PANES_KEY, queryFn: fetchTermSessions, refetchInterval: poll })
  const at = query.dataUpdatedAt
  // a failed read keeps the last list (react-query keeps its data through an error)
  const data = query.data
  const list = useMemo(() => (data ? steady(data, at) : undefined), [data, at])
  useEffect(() => {
    if (list) syncDone(list)
  }, [list])
  return { query, list }
}

// The API answers an empty list when a tmux call fails or times out, as well
// as when nothing is open. One such answer after a list that named panes is
// held over, so a slow tmux never unmounts every terminal (a reload and lost
// scrollback each) or flashes the empty Desk; a second empty answer in a row
// is taken as it is. Keyed by the answer's time, so both callers of one
// answer see the same list.
let lastFull: TermSession[] = []
let lastAt = -1
let lastOut: TermSession[] = []
let heldOne = false

function steady(data: TermSession[], at: number): TermSession[] {
  if (at === lastAt) return lastOut
  lastAt = at
  if (data.length) {
    lastFull = data
    heldOne = false
    lastOut = data
  } else if (lastFull.length && !heldOne) {
    heldOne = true
    lastOut = lastFull
  } else {
    lastFull = []
    lastOut = data
  }
  return lastOut
}

// ---------- the store: one version number for everything below ----------

let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const emit = () => {
  version += 1
  listeners.forEach((l) => l())
}

/** Re-renders the caller whenever the done marks or the layout change. */
export function useDeskStore(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage full or off */ }
}

// ---------- done, and not seen yet ----------
//
// A tab lights its title when its session finished (idle or asking, reached
// from working) while the tab was out of view: not the active tab of its
// column, the Desk not on screen, or the app hidden. Opening it clears that.
// Per pane: the last state read, when the last finish was seen (done) and when
// the tab was last in view (seen), both on this device's clock. The last state
// is kept across a reload, so a session that finished while the app was closed
// still lights.

// A whole run between two reads (a short reply while the list is read every
// 15 s, or while the app was closed) shows as done then done again: the API's
// stateSince moved and the pane printed since (since, out: the last read's
// stateSince and outputAt, both on the API's clock). activityAt does not tell
// that: it is tmux's session activity, which moves on a key or an attach and
// never on output. An API restart moves every stateSince with no work done
// (and the terminals mounted here attach again): the printing rules most of
// that out, and a list whose panes all share one stateSince (the first read
// after a restart dates every pane alike) never counts as a run.

type DoneRec = { last: PaneState; seen: number; done: number; since?: number; out?: number }
const DONE_KEY = 'v2.desk.done'

const done: Record<string, DoneRec> = (() => {
  const raw = read<Record<string, DoneRec>>(DONE_KEY) ?? {}
  const out: Record<string, DoneRec> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (TERM_NAME_RE.test(k) && v && typeof v.seen === 'number' && typeof v.done === 'number' && typeof v.last === 'string') out[k] = v
  }
  return out
})()
let inView = new Set<string>()

const isDone = (st: PaneState) => st === 'idle' || st === 'asking'

/** Lit: finished since the tab was last in view, and still finished. */
export function unseenDone(name: string): boolean {
  const r = done[name]
  return !!r && isDone(r.last) && r.done > r.seen
}

/** When the unseen finish happened (ms, this device's clock), 0 when there is none. */
export function doneAt(name: string): number {
  return unseenDone(name) ? done[name].done : 0
}

/**
 * Takes a fresh pane list: a finish is a working pane now idle or asking, an
 * idle one now asking, or a whole run between two reads (see DoneRec).
 */
export function syncDone(list: TermSession[]): void {
  const now = Date.now()
  let changed = false
  let dirty = false
  const names = new Set<string>()
  // the first read after an API restart: every pane dated alike
  const since0 = list[0]?.stateSince
  const restarted = list.length > 1 && since0 !== undefined && list.every((s) => s.stateSince === since0)
  for (const s of list) {
    names.add(s.name)
    const st = paneState(s)
    const r = done[s.name]
    if (!r) {
      done[s.name] = { last: st, seen: now, done: 0, since: s.stateSince, out: s.outputAt }
      changed = true
      continue
    }
    const was = unseenDone(s.name)
    const prev = r.last
    const ranUnread = !restarted && isDone(prev)
      && r.since !== undefined && s.stateSince !== undefined && s.stateSince > r.since
      && r.out !== undefined && s.outputAt !== undefined && s.outputAt > r.out
    if (isDone(st) && (prev === 'working' || (st === 'asking' && prev === 'idle') || ranUnread)) {
      r.done = now
      changed = true
    }
    if (prev !== st) {
      r.last = st
      changed = true
    }
    if (r.since !== s.stateSince || r.out !== s.outputAt) {
      r.since = s.stateSince
      r.out = s.outputAt
      dirty = true
    }
    if (inView.has(s.name)) r.seen = now
    if (was !== unseenDone(s.name)) changed = true
  }
  // an empty list is also what the API answers when tmux is slow to reply: keep the records until a list names panes again
  if (list.length) {
    for (const k of Object.keys(done)) {
      if (!names.has(k)) {
        delete done[k]
        changed = true
      }
    }
  }
  if (changed || dirty) write(DONE_KEY, done)
  if (changed) emit()
}

// Another window of the app on this device (a second browser tab) keeps its
// own copy and writes it back: take its newer "seen" times, so a tab opened
// there does not light here again, or come back lit from the store on a reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== DONE_KEY || !e.newValue) return
    let other: Record<string, Partial<DoneRec>>
    try {
      other = JSON.parse(e.newValue) as Record<string, Partial<DoneRec>>
    } catch {
      return
    }
    let changed = false
    for (const [k, r] of Object.entries(done)) {
      const seen = other?.[k]?.seen
      if (typeof seen !== 'number' || seen <= r.seen) continue
      const was = unseenDone(k)
      r.seen = seen
      if (was !== unseenDone(k)) changed = true
    }
    if (changed) emit()
  })
}

/** The panes in view right now (the grid's panes while the Desk is on screen and the app shows); they count as seen. */
export function setDeskInView(names: string[]): void {
  inView = new Set(names)
  const now = Date.now()
  let changed = false
  for (const n of inView) {
    const r = done[n]
    if (!r) continue
    if (r.done > r.seen) changed = true
    r.seen = now
  }
  if (changed) {
    write(DONE_KEY, done)
    emit()
  }
}

// ---------- where the panes sit ----------
//
// view: the panes in the grid, in reading order. One fills the Desk, two split
// it side by side, three and four make 2x2, five to nine 3x3 (a short last
// row's panes share its width). He changes it by dragging tabs and pane titles
// (screens/Desk.tsx). off: panes he took off the Desk (the session list and "+"
// put them back). focus: the pane with the keyboard; a tab picked from the
// strip opens there. raven: the panes Raven started that he opened; every
// other pane Raven started stays off the Desk, minimized in Raven's list. The tab order is not kept here: the Desk sorts the tabs
// by area, then project, every time.

export type DeskLayout = {
  view: string[]
  off: string[]
  focus: string | null
  raven: string[]
}

/** The most panes the grid shows (3x3). */
export const MAX_VIEW = 9

const LAYOUT_KEY = 'v2.desk.grid'

function loadLayout(): DeskLayout {
  // the column Desk (11-18 to 11-19) and the headset's first Desk kept other shapes; none carries over
  try {
    for (const k of ['v2.desk.layout', 'v2.desk.panes', 'v2.desk.cols']) localStorage.removeItem(k)
  } catch { /* storage unavailable */ }
  const raw = read<Partial<DeskLayout>>(LAYOUT_KEY) ?? {}
  const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((n): n is string => typeof n === 'string' && TERM_NAME_RE.test(n)))] : [])
  return {
    view: names(raw.view).slice(0, MAX_VIEW),
    off: names(raw.off),
    raven: names(raw.raven),
    focus: typeof raw.focus === 'string' && TERM_NAME_RE.test(raw.focus) ? raw.focus : null,
  }
}

let layout: DeskLayout = loadLayout()

export const deskLayout = (): DeskLayout => layout

/** Changes the layout (a new object, so memos see it), saves it and re-renders the Desk and the badge. */
export function editLayout(fn: (l: DeskLayout) => DeskLayout | void): void {
  const draft: DeskLayout = { ...layout, view: [...layout.view], off: [...layout.off], raven: [...layout.raven] }
  const next = fn(draft) ?? draft
  next.view = [...new Set(next.view)].slice(0, MAX_VIEW)
  if (JSON.stringify(next) === JSON.stringify(layout)) return
  layout = next
  write(LAYOUT_KEY, layout)
  emit()
}

const placed = new Map<string, number>()
const PLACE_GRACE_MS = 10_000

/** A pane he just put on the Desk (a new session, or one handed over by a tab): kept through the next reads. */
export function notePlaced(name: string): void {
  placed.set(name, Date.now())
}

/**
 * Follows a fresh pane list: every name that is no longer open leaves the
 * layout. An empty list changes nothing (the API answers one when tmux is slow too).
 */
export function syncLayout(list: TermSession[]): void {
  if (!list.length) return
  const open = new Set(list.map((s) => s.name))
  // a pane placed a moment ago counts as open: a read that left before it started must not drop it
  const t = Date.now()
  for (const [n, at] of placed) {
    if (t - at < PLACE_GRACE_MS) open.add(n)
    else placed.delete(n)
  }
  const gone = layout.view.some((n) => !open.has(n)) || layout.off.some((n) => !open.has(n)) || layout.raven.some((n) => !open.has(n))
    || (!!layout.focus && !open.has(layout.focus))
  if (!gone) return
  editLayout((l) => {
    l.view = l.view.filter((n) => open.has(n))
    l.off = l.off.filter((n) => open.has(n))
    l.raven = l.raven.filter((n) => open.has(n))
    if (l.focus && !open.has(l.focus)) l.focus = null
  })
}

/**
 * The panes on the Desk: open, not taken off it, and, for one Raven started,
 * opened by him (in the list's order; the Desk sorts them).
 */
export function onDesk(list: TermSession[]): TermSession[] {
  const off = new Set(layout.off)
  const raven = new Set(layout.raven)
  return list.filter((s) => !off.has(s.name) && (s.startedBy !== 'raven' || raven.has(s.name)))
}
