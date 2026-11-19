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

/** The tabs in view right now (the active tab of each column while the Desk is on screen and the app shows); they count as seen. */
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

// ---------- where the tabs sit ----------
//
// order: every pane on the Desk, in tab order (a column shows its own in this
// order). col: a column he put a tab in (by drag, the tab menu, or "+" in that
// column); clamped to the column count. work: whether a pane belongs to a work
// area, frozen once known so a board that stops answering never reshuffles the
// tabs. off: panes he took off the Desk (they come back from "+"). active: the
// active tab of each column. cols: the column count he picked, 0 = this
// device's default.

export type DeskLayout = {
  order: string[]
  col: Record<string, number>
  work: Record<string, boolean>
  off: string[]
  active: (string | null)[]
  cols: 0 | 1 | 2 | 3
}

const LAYOUT_KEY = 'v2.desk.layout'

function loadLayout(): DeskLayout {
  // the headset's first Desk kept a plain list of screens and a column count; neither carries over
  try {
    localStorage.removeItem('v2.desk.panes')
    localStorage.removeItem('v2.desk.cols')
  } catch { /* storage unavailable */ }
  const raw = read<Partial<DeskLayout>>(LAYOUT_KEY) ?? {}
  const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((n): n is string => typeof n === 'string' && TERM_NAME_RE.test(n)))] : [])
  const rec = <T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> => {
    const out: Record<string, T> = {}
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (TERM_NAME_RE.test(k) && ok(x)) out[k] = x
    return out
  }
  const cols = Number(raw.cols)
  return {
    order: names(raw.order),
    col: rec(raw.col, (x): x is number => x === 0 || x === 1 || x === 2),
    work: rec(raw.work, (x): x is boolean => typeof x === 'boolean'),
    off: names(raw.off),
    active: Array.isArray(raw.active) ? raw.active.slice(0, 3).map((n) => (typeof n === 'string' && TERM_NAME_RE.test(n) ? n : null)) : [],
    cols: cols === 1 || cols === 2 || cols === 3 ? cols : 0,
  }
}

let layout: DeskLayout = loadLayout()

export const deskLayout = (): DeskLayout => layout

/** Changes the layout (a new object, so memos see it), saves it and re-renders the Desk and the badge. */
export function editLayout(fn: (l: DeskLayout) => DeskLayout | void): void {
  const draft: DeskLayout = { ...layout, order: [...layout.order], col: { ...layout.col }, work: { ...layout.work }, off: [...layout.off], active: [...layout.active] }
  const next = fn(draft) ?? draft
  if (JSON.stringify(next) === JSON.stringify(layout)) return
  layout = next
  write(LAYOUT_KEY, layout)
  emit()
}

const placed = new Map<string, number>()
const PLACE_GRACE_MS = 10_000

/** A pane he just put in a column (a new session, or one handed over by a tab): kept through the next reads. */
export function notePlaced(name: string): void {
  placed.set(name, Date.now())
}

/**
 * Follows a fresh pane list: a pane never seen joins the end of the order (its
 * column's end), and every name that is no longer open leaves the layout. An
 * empty list changes nothing (onDesk shows no tab for a name that is not open).
 */
export function syncLayout(list: TermSession[]): void {
  // the API answers an empty list when tmux is slow to reply too: never wipe his placement on one
  if (!list.length) return
  const open = new Set(list.map((s) => s.name))
  // a pane placed a moment ago counts as open: a read that left before it started must not drop its column
  const t = Date.now()
  for (const [n, at] of placed) {
    if (t - at < PLACE_GRACE_MS) open.add(n)
    else placed.delete(n)
  }
  const known = new Set([...layout.order, ...layout.off])
  // oldest first, the way the tabs of a terminal window grow
  const fresh = list.filter((s) => !known.has(s.name)).sort((a, b) => a.createdAt - b.createdAt).map((s) => s.name)
  const gone = [...known].some((n) => !open.has(n)) || Object.keys(layout.col).some((n) => !open.has(n)) || Object.keys(layout.work).some((n) => !open.has(n))
  if (!fresh.length && !gone) return
  editLayout((l) => {
    l.order = [...l.order.filter((n) => open.has(n)), ...fresh]
    l.off = l.off.filter((n) => open.has(n))
    for (const k of Object.keys(l.col)) if (!open.has(k)) delete l.col[k]
    for (const k of Object.keys(l.work)) if (!open.has(k)) delete l.work[k]
    l.active = l.active.map((n) => (n && open.has(n) ? n : null))
  })
}

/** The panes on the Desk (open, and not taken off it), in tab order. */
export function onDesk(list: TermSession[]): TermSession[] {
  const off = new Set(layout.off)
  const byName = new Map(list.filter((s) => !off.has(s.name)).map((s) => [s.name, s]))
  const out: TermSession[] = []
  for (const n of layout.order) {
    const s = byName.get(n)
    if (s) {
      out.push(s)
      byName.delete(n)
    }
  }
  // a pane the layout has not taken in yet (the list just changed) goes last
  return [...out, ...[...byName.values()].sort((a, b) => a.createdAt - b.createdAt)]
}
