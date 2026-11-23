import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { killTermSession, openTermSession, termLabel, type PaneState, type TermSession } from '../../lib/api'
import { DESK_FOCUS_EVENT, DESK_SHOWN_EVENT, deskChord, type DeskChord, type DeskHost } from '../../lib/embed'
import { BASE_AREAS, PROJ_KEYS, fetchProjList, isClientArea, projAreasQuery } from '../../lib/projectsApi'
import { useProfile } from '../../lib/deviceMode'
import { seedTerminal } from '../../lib/sessionLaunch'
import { errText } from '../../lib/term'
import { ago, useAreaLabel, useLaunchTargets, useSessionIndex, useTick, type SessionBrief, type TargetVM } from '../kit/data'
import {
  MAX_SIDES, MAX_VIEW, deskLayout, doneAt, editLayout, notePlaced, onDesk, paneState, setDeskInView,
  syncLayout, unseenDone, useDeskPanes, useDeskStore, type DeskLayout, type DeskSide,
} from '../kit/desk'
import { ChevronDown, ListTree } from 'lucide-react'
import { Icon, StateIcon } from '../kit/icons'
import type { SessionState } from '../kit/sessionState'
import type { ScreenProps } from '../kit/shell'
import { Press, cx, toast } from '../kit/ui'
import './desk.css'

// The Desk (/m/desk), on every device right after Raven: where he works in
// Claude sessions inside Valkyrie, with tabs like Windows Terminal.
//
// One strip of tabs on top: every open Valkyrie pane on odin (the tmux list),
// sorted by area (the client areas in odin's order, then personal and server)
// and then by project. Each area is a section under a head with its name and
// count (the tabs Raven started that he opened are one more, last): a press on
// the head collapses its tabs (the ones in view stay) or expands them. His
// choice is kept per device; a section he never touched starts collapsed when
// it is big (BIG_SECTION tabs or more) and none of them waits on him, so a
// Recover all does not bury the ones asking. The strip spans the Desk from its
// left edge ("Sessions" is its first item) and is one row on every device that
// never wraps: it scrolls sideways under a swipe, a trackpad, the mouse wheel or
// a mouse drag, with "Sessions" and "+" held at its ends and the focused tab
// kept in view. A tab never squeezes below its title: up to 20 characters show, the tooltip (and a long
// press's menu on a touch screen) has all of it. A tab shows the session's state with the AI > Sessions
// icons (kit/icons StateIcon: working the bolt, asking the bubble in the second
// accent, idle the pause circle) and its title, which also lights when the
// session finished while it was out of view (kit/desk.ts), so a glance tells
// still working, finished, and finished with a question for him. "Sessions"
// at the strip's start lists them all by area and project, each area folded
// until he opens it; "+" starts one. Under the running ones it lists the sessions closed and not marked done
// (AI > Sessions' Recent, thor's only): a pick resumes one in the focused pane,
// "Recover all" resumes every one of them as a tab, and "Recover Thor" (one
// button per context that has any) resumes only that context's. With no tab
// open, the empty Desk lists the same closed sessions in a Raven-style card,
// each with its context and when it closed; a tap resumes that one.
//
// Under it, the grid: one session fills the Desk at first. On a desktop he
// drags a tab (or a pane's title) onto a pane: its middle puts it in that
// pane's place, an edge puts it beside it, so the grid grows from one to a
// split, 2x2 and 3x3 (kit/desk.ts view). Each pane is the bare terminal under
// a title row: the session's title and the folder it runs in. A touch screen
// shows one session at a time, with the terminal page's composer and keys.
//
// A section's head dragged onto the Desk (a mouse or a finger) splits it by
// sections (kit/desk.ts split): that section takes the half it was dropped on
// and the rest of the tabs the other. Each side then has its own strip, one
// row of only its sections' tabs that scrolls on its own, over ONE terminal: a
// tab pressed in a side's strip switches that side's terminal. Dropped on a
// side's edge, a head opens a new side there (three at most); on a side's
// middle it takes that side, and what was there goes to the side it came from.
// A side's x closes it, its tabs joining the side beside it; one side left is
// the grid again, as he left it. The split is kept per device.
//
// A pane's session is the pop-out terminal page (/m/w/term/<name>) in an
// iframe. The panes in view and the most recent others stay mounted, so a
// switch back is instant and keeps the scrollback; every iframe is one layer
// placed by style, so a layout change never reloads one. The terminals ask
// the Desk for what a pop-out does for itself, and hand it the Desk's keys,
// through window.valkyrieDesk (lib/embed.ts DeskHost).
//
// Raven's sessions stay minimized in Raven until he opens one. A pane whose
// conversation Raven started (session_start, or session_send opening a main
// terminal: recorded when it starts, backend lib/sessionOrigin.ts, never
// guessed) is not a tab and never fills the grid on its own: the Raven chip
// at the strip's right end counts them, and opens the Raven card (the Raven
// tab's rounded chat-box look) that lists them all. A pick there, or in
// Sessions, puts that one on the Desk as a tab with the bird (kit/desk.ts
// layout.raven); closing its tab minimizes it into Raven again. The card's
// open or folded state is kept per device, folded at first. Open, it sits right
// of "Sessions" on the same row, over the tabs, so "Sessions" never moves. A
// session he resumes from Raven's closed ones is still Raven's.
//
// Contexts are areas (lib/projectsApi areaLabel): personal reads Thor and
// server Odin, a client area its main terminal's name.

const EMPTY: TermSession[] = []
/** iframes kept mounted (each is a whole page): the grid's panes, then the most recent others */
const MAX_MOUNTED = 12
const MAX_MOUNTED_TOUCH = 4
/** the terminal page's default font, for sizing a session before its pane attaches */
const FONT_PX = 14
const PANE_MIME = 'application/x-valkyrie-pane'
/** px: a pane's title row on a desktop (desk.css .dk-head) */
const HEAD_H = 30
/** px between panes (desk.css --dk-gap) */
const GAP = 6
/** the machine a closed session can resume on inside Valkyrie */
const HOME_HOST = 'thor'
/** ms between two resumes of Recover all: each is an SSH login to thor, and sshd drops logins that pile up */
const RECOVER_GAP = 700
/** ms a resumed session stays out of the closed list while the board catches up */
const REOPEN_GRACE = 15_000
/** tabs in a section that make it big: it starts collapsed unless one of them waits on him */
const BIG_SECTION = 5

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const statusOf = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status

type Vars = CSSProperties & Record<`--${string}`, string | number>

const WORD: Record<PaneState, string> = { working: 'working', asking: 'asking', idle: 'idle', shell: 'shell', dead: 'ended' }

/** The mark's icon for a pane state; a shell has none, an ended pane the faint closed mark. */
const markOf = (st: PaneState): SessionState | null => (st === 'shell' ? null : st === 'dead' ? 'closed' : st)

/** A closed session's context: its area, '' when the board has none. */
const areaOf = (s: SessionBrief) => (s.area && s.area !== 'other' ? s.area : '')
/** The conversation a pane runs: a new pane knows it from the start, a resume keeps it as its target. */
const paneSid = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

/** The folder a pane runs in, short: the whole path when it is short, else its last folder. */
function shortFolder(cwd: string): string {
  const p = cwd.replace(/[\\/]+$/, '')
  return p.length <= 24 ? p : p.split(/[\\/]/).pop() || p
}

// ---------- the grid ----------

/** A layout edit starts from the grid as drawn. */
function fromDrawn(l: DeskLayout, d: { view: readonly string[] }): void {
  l.view = [...d.view]
}

/** Columns for n panes: one, a split side by side, 2x2, 3x3. */
const gridCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : 3)

type Box = { x: number; y: number; w: number; h: number }
/** Pane i of n in c columns, as fractions of the stage: a short last row's panes share its width. */
function cellBox(i: number, n: number, c = gridCols(n)): Box {
  const rows = Math.ceil(n / c)
  const r = Math.floor(i / c)
  const inRow = r === rows - 1 ? n - r * c : c
  return { x: (i - r * c) / inRow, y: r / rows, w: 1 / inRow, h: 1 / rows }
}
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }
/** Side s of k, as a fraction of the stage: the sides share its width. */
const sideBox = (s: number, k: number): Box => ({ x: s / k, y: 0, w: 1 / k, h: 1 })
/** The strips' columns over a split's k sides: each side's width as boxStyle gives it, GAP apart. */
function sideColumns(k: number): string {
  return Array.from({ length: k }, (_, s) => `calc(${100 / k}% - ${(s > 0 ? GAP / 2 : 0) + (s < k - 1 ? GAP / 2 : 0)}px)`).join(' ')
}
/** A box as CSS: GAP apart inside the stage, flush with its edges, `top` px kept clear at the top (the title row). */
function boxStyle(b: Box, top = 0): CSSProperties {
  const l = b.x > 0.001 ? GAP / 2 : 0
  const r = b.x + b.w < 0.999 ? GAP / 2 : 0
  const t = b.y > 0.001 ? GAP / 2 : 0
  const btm = b.y + b.h < 0.999 ? GAP / 2 : 0
  return {
    left: `calc(${b.x * 100}% + ${l}px)`,
    top: `calc(${b.y * 100}% + ${t + top}px)`,
    width: `calc(${b.w * 100}% - ${l + r}px)`,
    height: `calc(${b.h * 100}% - ${t + btm + top}px)`,
  }
}

type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** A press on the strip being followed: waiting to see where it goes, panning the strip, or dragging by pointer. */
type Gesture = {
  id: number
  /** the strip it started on (a split Desk has one per side) */
  row: HTMLDivElement
  mouse: boolean
  x0: number
  y0: number
  x: number
  y: number
  /** the strip's scrollLeft at the press */
  left: number
  /** the section whose head it started on */
  section: string | null
  /** the tab it started on */
  tab: string | null
  mode: 'wait' | 'pan' | 'drag'
  off: () => void
}
/** Keeps a pointer's events on the strip while it pans or drags (over a terminal's iframe too). */
function hold(el: HTMLElement, id: number): void {
  try { el.setPointerCapture(id) } catch { /* the pointer is gone */ }
}
/** Where in a pane a drop lands: within a quarter of an edge puts the pane beside it, the middle in its place. */
function zoneAt(e: { clientX: number; clientY: number }, el: HTMLElement): Zone {
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / Math.max(1, r.width)
  const y = (e.clientY - r.top) / Math.max(1, r.height)
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y }
  const [edge, dist] = (Object.entries(d) as [Zone, number][]).sort((a, b) => a[1] - b[1])[0]
  return dist < 0.25 ? edge : 'center'
}

function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const f = () => setV(!document.hidden)
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])
  return v
}

/** What the Desk knows about a pane besides the tmux row: its area, project and folder. */
type PaneMeta = { title: string; area: string; project: string; folder: string; where: string }

/** x and y: where the menu opens, in the Desk's own px (under the tab or row it came from) */
type Menu = { name: string; x: number; y: number; arm: boolean }

/** Raven started the conversation in this pane (recorded at creation, backend lib/sessionOrigin.ts). */
const byRaven = (s: TermSession) => s.startedBy === 'raven'

/** Whether the Raven card is open or folded into its chip: kept per device, folded until he opens it. */
const RAVEN_OPEN_KEY = 'v2.desk.ravenList'
function useRavenOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      localStorage.removeItem('v2.desk.ravenOpen')
      return localStorage.getItem(RAVEN_OPEN_KEY) === '1'
    } catch { return false }
  })
  const set = useCallback((v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(RAVEN_OPEN_KEY, v ? '1' : '0') } catch { /* storage off */ }
  }, [])
  return [open, set]
}

/** A section of the strip: one area's tabs, or the ones Raven started that he opened. */
type Section = { key: string; label: string; raven: boolean; rows: TermSession[] }

/** Finished while out of view, or asking: the tab waits on him. */
const waits = (s: TermSession) => unseenDone(s.name) || paneState(s) === 'asking'

/** The tab a side shows when nothing says which: one asking, else one done and not seen, else the first. */
const pickOf = (rows: TermSession[]): string =>
  (rows.find((s) => paneState(s) === 'asking') ?? rows.find((s) => unseenDone(s.name)) ?? rows[0]).name

/** One side of a split as drawn: its place in kit/desk.ts split, its sections (with their tabs on this side), its tabs, the one it shows. */
type SideVM = { at: number; sections: Section[]; rows: TermSession[]; name: string }

/**
 * The sides of a split that have a tab, left to right. A tab sits on the side that shows it, else on
 * the side its section is pinned to, else on the rest's side. A side with no name of its own shows
 * the first of `prefer` it holds (the focus, the grid's panes, the ones opened last), else pickOf.
 */
function drawSides(split: readonly DeskSide[], sections: Section[], prefer: readonly (string | null)[], labelOf: (key: string) => string): SideVM[] {
  const home = new Map<string, number>()
  split.forEach((sd, i) => sd.keys.forEach((k) => home.set(k, i)))
  const rest = split.findIndex((sd) => !!sd.rest)
  const names = new Set(sections.flatMap((g) => g.rows.map((r) => r.name)))
  // the tab a side shows stays on it: after a reload its area is not read yet
  const claim = new Map<string, number>()
  split.forEach((sd, i) => { if (sd.name && names.has(sd.name) && !claim.has(sd.name)) claim.set(sd.name, i) })
  const per = split.map(() => new Map<string, Section>())
  const add = (i: number, g: Section, r: TermSession) => {
    let x = per[i].get(g.key)
    if (!x) per[i].set(g.key, (x = { ...g, rows: [] }))
    x.rows.push(r)
  }
  for (const g of sections) {
    const h = home.get(g.key) ?? rest
    for (const r of g.rows) {
      const i = claim.get(r.name) ?? h
      if (i < 0) continue
      const k = split[i].keys[0]
      // a tab whose area is not known yet, kept on a pinned side: under that side's section
      if (i !== h && g.key === 'other' && k) add(i, { key: k, label: labelOf(k), raven: k === 'raven', rows: [] }, r)
      else add(i, g, r)
    }
  }
  const out: SideVM[] = []
  split.forEach((sd, at) => {
    const secs = [...per[at].values()]
    const rows = secs.flatMap((g) => g.rows)
    if (!rows.length) return
    const has = (x: string | null | undefined): x is string => !!x && rows.some((r) => r.name === x)
    out.push({ at, sections: secs, rows, name: [sd.name, ...prefer].find(has) ?? pickOf(rows) })
  })
  return out
}

/**
 * A split after an edit: a pinned side with no tab goes; a rest side with no tab hands the rest to the
 * side left of it (or right). Fewer than two sides left: no split.
 */
function tidySplit(next: DeskSide[], sections: Section[], labelOf: (key: string) => string): DeskSide[] | undefined {
  const xs = next.filter((sd) => sd.keys.length || sd.rest)
  const drawn = new Set(drawSides(xs, sections, [], labelOf).map((sd) => sd.at))
  const keep: DeskSide[] = []
  let restAt = -1
  xs.forEach((sd, i) => {
    if (drawn.has(i)) keep.push(sd)
    else if (sd.rest) restAt = keep.length
  })
  if (restAt >= 0 && keep.length) {
    const i = restAt > 0 ? restAt - 1 : 0
    keep[i] = { ...keep[i], rest: true }
  }
  return keep.length >= 2 ? keep : undefined
}

/** The sections he collapsed (true) or expanded (false) himself, kept per device; the rest follow the default. */
const FOLD_KEY = 'v2.desk.sections'
function useSectionFolds(): [Readonly<Record<string, boolean>>, (key: string, folded: boolean) => void] {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
    } catch { return {} }
  })
  const set = useCallback((key: string, folded: boolean) => {
    setFolds((f) => {
      const next = { ...f, [key]: folded }
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)) } catch { /* storage off */ }
      return next
    })
  }, [])
  return [folds, set]
}

/** A long press on a touch screen opens the menu; the tap that ends it then does nothing. */
function useLongPress(onLong: () => void) {
  const long = useRef<{ t: number; fired: boolean } | null>(null)
  const down = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    const rec = { t: 0, fired: false }
    rec.t = window.setTimeout(() => {
      rec.fired = true
      onLong()
    }, 520)
    long.current = rec
  }
  const up = () => { if (long.current) window.clearTimeout(long.current.t) }
  useEffect(() => () => { if (long.current) window.clearTimeout(long.current.t) }, [])
  /** true once, right after a long press fired */
  const swallow = () => {
    if (!long.current?.fired) return false
    long.current = null
    return true
  }
  return { down, up, swallow }
}

/** The closed, not done sessions of one area, newest first. */
type ClosedGroup = { area: string; rows: SessionBrief[]; raven?: boolean }
/** A recover running: scope 'all' (Recover all) or the area key of one context's button. */
type Recover = { done: number; total: number; scope: string }
/** One context's Recover button: its area, the name he sees, how many it brings back. */
type RecoverArea = { area: string; label: string; n: number }

export default function Desk({ active }: ScreenProps) {
  const qc = useQueryClient()
  const device = useProfile().resolved
  const phone = device === 'iphone'
  const coarse = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches, [])
  // the grid needs a mouse to drag with, and room: a touch screen shows one session with its own keys
  const grid = !coarse && !phone
  const visible = usePageVisible()
  const onScreen = active && visible

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  // the stage's size in layout px (the UI zoom hides from media queries)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const st = stageRef.current
    if (!st) return
    const read = () => setStage((b) => (b.w === st.clientWidth && b.h === st.clientHeight ? b : { w: st.clientWidth, h: st.clientHeight }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(st)
    return () => ro.disconnect()
  }, [])

  useDeskStore()
  const L = deskLayout()
  const { query: panes, list: steadyList } = useDeskPanes(onScreen ? 2_000 : 15_000)
  const list = steadyList ?? EMPTY
  useEffect(() => {
    if (steadyList) syncLayout(steadyList)
  }, [steadyList])

  const index = useSessionIndex()
  const targets = useLaunchTargets()
  const areas = useQuery(projAreasQuery).data ?? BASE_AREAS
  const projects = useQuery({ queryKey: PROJ_KEYS.list, queryFn: () => fetchProjList(), staleTime: 60_000 })
  const now = useTick(active ? 30_000 : 300_000)
  const areaName = useAreaLabel()
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, b] of index.byId) if (b.title) m.set(id, b.title)
    return m
  }, [index.byId])

  // ---------- each pane's area, project and folder; the tabs in order ----------

  const meta = useMemo(() => {
    const projById = new Map((projects.data ?? []).map((p) => [p.id, p]))
    const targetByKey = new Map((targets.data ?? []).map((t) => [t.key, t]))
    const out = new Map<string, PaneMeta>()
    for (const s of list) {
      const sid = paneSid(s)
      const b = sid ? index.byId.get(sid) : undefined
      const proj = s.projectId ? projById.get(s.projectId) : undefined
      const t = s.mode !== 'resume' && s.target ? targetByKey.get(s.target) : undefined
      const fromTarget = t?.group && areas.includes(t.group) ? t.group : s.mode !== 'resume' && areas.includes(s.target) ? s.target : ''
      const boardArea = b?.area && b.area !== 'other' ? b.area : ''
      const cwd = b?.cwd ?? ''
      out.set(s.name, {
        title: s.title || termLabel(s, titles),
        area: boardArea || proj?.area || fromTarget,
        project: proj?.name ?? '',
        folder: cwd ? shortFolder(cwd) : t?.label ?? '',
        where: cwd || t?.label || '',
      })
    }
    return out
  }, [list, index.byId, projects.data, targets.data, areas, titles])
  const metaOf = (s: TermSession): PaneMeta => meta.get(s.name) ?? { title: s.title || termLabel(s, titles), area: '', project: '', folder: '', where: '' }

  // the client areas first, in odin's order, then personal and server; a pane whose area is not known yet last
  const areaOrder = useMemo(() => [...areas.filter(isClientArea), ...BASE_AREAS], [areas])
  const rankOf = useCallback((a: string) => {
    const i = areaOrder.indexOf(a)
    return i < 0 ? areaOrder.length : i
  }, [areaOrder])
  const sortPanes = useCallback((xs: TermSession[]): TermSession[] => [...xs].sort((a, b) => {
    const ma = meta.get(a.name)
    const mb = meta.get(b.name)
    return Number(byRaven(a)) - Number(byRaven(b))
      || rankOf(ma?.area ?? '') - rankOf(mb?.area ?? '')
      || Number(!!ma?.project) - Number(!!mb?.project)
      || (ma?.project ?? '').localeCompare(mb?.project ?? '')
      || a.createdAt - b.createdAt
  }), [meta, rankOf])

  // his own panes, and the ones Raven started that he opened (the rest stay minimized in Raven)
  const tabs = useMemo(() => sortPanes(onDesk(list)), [sortPanes, list, L.off, L.raven]) // eslint-disable-line react-hooks/exhaustive-deps
  const tabNames = new Set(tabs.map((s) => s.name))
  // every pane Raven started, on the Desk or not: the Raven card's, newest first
  const ravens = useMemo(() => list.filter(byRaven).sort((a, b) => b.createdAt - a.createdAt), [list])
  const ravenNames = useMemo(() => new Set(ravens.map((s) => s.name)), [ravens])
  const [ravenOpen, setRavenOpen] = useRavenOpen()

  // ---------- closed, not marked done: on thor, nothing runs it, no pane holds it ----------

  // ids being resumed right now, and ids resumed a moment ago (the board still reads them closed)
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set())
  const [reopened, setReopened] = useState<ReadonlyMap<string, number>>(new Map())
  const [recover, setRecover] = useState<Recover | null>(null)
  const recovering = useRef(false)
  const held = useMemo(() => new Set(list.filter((t) => !t.dead).map(paneSid).filter(Boolean)), [list])
  const closed = useMemo(() => {
    // a resume counts until a board read from REOPEN_GRACE after it says otherwise
    const fresh = (id: string) => (reopened.get(id) ?? -Infinity) + REOPEN_GRACE > index.at
    const out: SessionBrief[] = []
    for (const s of index.byId.values()) {
      if (!s.done && !s.live && s.activity === 'closed' && s.host === HOME_HOST && !held.has(s.id) && !fresh(s.id)) out.push(s)
    }
    return out.sort((a, b) => b.last - a.last)
  }, [index.byId, index.at, held, reopened])
  const closedGroups = useMemo(() => {
    const by = new Map<string, SessionBrief[]>()
    const raven: SessionBrief[] = []
    for (const s of closed) {
      if (s.raven) {
        raven.push(s)
        continue
      }
      const a = areaOf(s)
      const rows = by.get(a)
      if (rows) rows.push(s)
      else by.set(a, [s])
    }
    const out = [...by].map(([area, rows]): ClosedGroup => ({ area, rows })).sort((a, b) => rankOf(a.area) - rankOf(b.area))
    if (raven.length) out.push({ area: '', rows: raven, raven: true })
    return out
  }, [closed, rankOf])
  // one Recover button per context that has closed sessions (Raven's included, as Recover all), in area order
  const recoverAreas = useMemo(() => {
    const n = new Map<string, number>()
    for (const s of closed) {
      const a = areaOf(s)
      if (a) n.set(a, (n.get(a) ?? 0) + 1)
    }
    return [...n].sort((a, b) => rankOf(a[0]) - rankOf(b[0])).map(([area, k]): RecoverArea => ({ area, label: areaName(area), n: k }))
  }, [closed, rankOf, areaName])

  // ---------- the strip's sections: one per area, then the Raven ones he opened; each collapses ----------

  const [folds, setFold] = useSectionFolds()
  const sections = useMemo(() => {
    const by = new Map<string, Section>()
    for (const s of tabs) {
      const raven = byRaven(s)
      const area = raven ? '' : meta.get(s.name)?.area ?? ''
      const key = raven ? 'raven' : area || 'other'
      let g = by.get(key)
      if (!g) by.set(key, (g = { key, label: raven ? 'Raven' : areaName(area), raven, rows: [] }))
      g.rows.push(s)
    }
    return [...by.values()]
  }, [tabs, meta, areaName])
  const labelOf = useCallback((key: string) => (key === 'raven' ? 'Raven' : areaName(key === 'other' ? '' : key)), [areaName])

  // ---------- the grid, or the Desk split by sections (one terminal per side) ----------

  // the terminals opened last, newest first: they stay mounted, and a side with no name of its own shows one of them
  const [recent, setRecent] = useState<string[]>([])
  // the grid: the panes he placed that are still on the Desk; before he placed any, the first tab fills it
  const placedView = L.view.filter((n) => tabNames.has(n))
  const focusName = L.focus && tabNames.has(L.focus) ? L.focus : null
  const drawn = grid && L.split ? drawSides(L.split, sections, [focusName, ...placedView, ...recent], labelOf) : []
  // two sides with tabs make a split; else the grid shows, as he left it
  const split = drawn.length >= 2 ? drawn : null
  const view: string[] = split
    ? split.map((sd) => sd.name)
    : !grid
      ? [focusName ?? placedView[0] ?? tabs[0]?.name].filter((x): x is string => !!x)
      : placedView.length ? placedView : tabs[0] ? [tabs[0].name] : []
  const n = view.length
  const focus = focusName && view.includes(focusName) ? focusName : view[0] ?? null
  const boxes: Box[] = split ? split.map((_, s) => sideBox(s, split.length)) : Array.from({ length: n }, (_, i) => cellBox(i, n))
  const viewKey = view.join(',')
  const shapeKey = `${viewKey}|${split?.length ?? ''}`

  // a section alone on its side shows all its tabs: that strip is the section
  const sole = new Set(split ? split.filter((sd) => sd.sections.length === 1).map((sd) => sd.sections[0].key) : [])
  const foldedOf = (g: Section) => !sole.has(g.key) && (folds[g.key] ?? (g.rows.length >= BIG_SECTION && !g.rows.some(waits)))
  /** A section's tabs in the strip: all of them, or (collapsed) the ones in view. */
  const rowsOf = (g: Section) => (foldedOf(g) ? g.rows.filter((s) => view.includes(s.name)) : g.rows)
  // the tabs he sees, per strip (each side of a split has its own): Ctrl+Tab and Alt+N go by the focused one's
  const strips = split ? split.map((sd) => sd.sections.flatMap(rowsOf)) : [sections.flatMap(rowsOf)]
  const foldKey = (split ? split.flatMap((sd) => sd.sections) : sections).map((g) => `${g.key}:${foldedOf(g) ? 1 : 0}`).join(',')

  // the panes in view count as seen while the Desk shows
  useEffect(() => {
    setDeskInView(onScreen ? view : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, viewKey])
  useEffect(() => () => setDeskInView([]), [])

  // ---------- mounted terminals: the grid's, then the most recently opened ----------

  const [woke, setWoke] = useState(active)
  if (active && !woke) setWoke(true)
  const max = coarse ? MAX_MOUNTED_TOUCH : MAX_MOUNTED
  const mounted = woke ? [...new Set([...view, ...recent])].filter((x) => tabNames.has(x)).slice(0, Math.max(max, n)) : []
  // a stable DOM order: moving an iframe in the DOM reloads it
  const mountedSorted = [...mounted].sort()
  // a pane out of view keeps the box it last had, so hiding it never resizes its session
  const [kept, setKept] = useState<{ key: string; at: Record<string, Box> }>({ key: '', at: {} })
  if (kept.key !== shapeKey) {
    const at = { ...kept.at }
    view.forEach((name, i) => { at[name] = boxes[i] })
    setKept({ key: shapeKey, at })
  }
  const lastBox = kept.at
  // the panes in view: a mounted one out of view keeps its terminal attached but stops its quick polls
  // (lib/embed.ts deskTabShown, read by the terminal page)
  const shownRef = useRef(new Set<string>())
  const shownKey = active ? viewKey : ''
  useEffect(() => {
    shownRef.current = new Set(shownKey ? shownKey.split(',') : [])
    for (const f of frames.current.values()) {
      try {
        f.contentWindow?.dispatchEvent(new Event(DESK_SHOWN_EVENT))
      } catch { /* not loaded yet: it asks when it starts */ }
    }
  }, [shownKey])

  const [menu, setMenu] = useState<Menu | null>(null)
  const [picker, setPicker] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const focusRef = useRef<string | null>(null)
  // what the callbacks below (keys, the terminals' requests) read: the Desk as last drawn
  const cur = useRef({ view, split, focus, tabs, strips, sections, grid, ravenNames, recent, labelOf })
  useLayoutEffect(() => { cur.current = { view, split, focus, tabs, strips, sections, grid, ravenNames, recent, labelOf } })

  const focusFrame = useCallback((name: string) => {
    if (coarse) return
    const w = frames.current.get(name)?.contentWindow
    if (!w) return
    try {
      w.focus()
      w.dispatchEvent(new Event(DESK_FOCUS_EVENT))
    } catch { /* not loaded yet: onLoad tries again */ }
  }, [coarse])

  const keyboardTo = useCallback((name: string) => {
    focusRef.current = name
    requestAnimationFrame(() => requestAnimationFrame(() => focusFrame(name)))
  }, [focusFrame])

  /**
   * Opens a session: in view already, it takes the keyboard; else it takes the focused pane's place (that one stays a tab).
   * On a split Desk the side that holds it shows it. One Raven started comes onto the Desk as a tab.
   */
  const openTab = useCallback((name: string) => {
    const { view: v, focus: f, grid: g, ravenNames: rn, split: sp } = cur.current
    const was = f && f !== name ? f : null
    // a tab on no side yet (a new session): the side its section lands on picks it up as the focus
    const side = sp?.find((sd) => sd.rows.some((r) => r.name === name))
    editLayout((l) => {
      l.off = l.off.filter((x) => x !== name)
      if (rn.has(name) && !l.raven.includes(name)) l.raven.push(name)
      if (!g) {
        l.view = [name]
      } else if (sp) {
        const at = side ? l.split?.[side.at] : undefined
        if (at) at.name = name
      } else {
        fromDrawn(l, cur.current)
        if (!v.includes(name)) {
          const i = f ? l.view.indexOf(f) : -1
          if (i >= 0) l.view[i] = name
          else if (l.view.length) l.view[0] = name
          else l.view.push(name)
        }
      }
      l.focus = name
    })
    const left = side && side.name !== name ? [side.name] : []
    setRecent((r) => [...new Set([name, ...left, ...(was ? [was] : []), ...r])].slice(0, 16))
    keyboardTo(name)
  }, [keyboardTo])

  /** A drop on pane `target`: its middle swaps the two (or puts the dragged one in its place), an edge puts it beside. */
  const dropOn = useCallback((name: string, target: string, zone: Zone) => {
    const v = cur.current.view
    if (cur.current.split || name === target || !v.includes(target)) return
    editLayout((l) => {
      l.off = l.off.filter((x) => x !== name)
      fromDrawn(l, cur.current)
      const from = l.view.indexOf(name)
      const ti = l.view.indexOf(target)
      if (zone === 'center' || (from < 0 && l.view.length >= MAX_VIEW)) {
        if (from >= 0) l.view[from] = target
        l.view[ti] = name
      } else {
        l.view = l.view.filter((x) => x !== name)
        l.view.splice(l.view.indexOf(target) + (zone === 'right' || zone === 'bottom' ? 1 : 0), 0, name)
      }
      l.focus = name
    })
    setRecent((r) => [...new Set([name, target, ...r])].slice(0, 16))
    keyboardTo(name)
  }, [keyboardTo])

  /**
   * A section's head dropped on the Desk. Not split yet (`at` -1): the section takes the half it was
   * dropped on and every other tab the other half. Split (`at` a side's place in kit/desk.ts split): on
   * that side's edge it opens as a new side there (three at most); on its middle it takes that side, and
   * what was there goes to the side the section came from. Its side shows one of its tabs: the one he had
   * open, else one in view or opened last, else one waiting on him, else the first.
   */
  const dropSection = useCallback((key: string, at: number, zone: Zone) => {
    const { sections: gs, split: sp, focus: f, tabs: ts, view: v, recent: rc, labelOf: lo } = cur.current
    const g = gs.find((x) => x.key === key)
    if (!g) return
    const mine = new Set(g.rows.map((r) => r.name))
    const shown = sp?.map((sd) => sd.name) ?? []
    const pick = [f, ...shown, ...v, ...rc].find((x): x is string => !!x && mine.has(x)) ?? pickOf(g.rows)
    let next: DeskSide[] | undefined
    if (!sp) {
      const others = ts.filter((r) => !mine.has(r.name))
      if (!others.length) {
        toast(`Only ${g.label} is open: there is nothing to split it from`)
        return
      }
      const restName = [f, ...v, ...rc].find((x): x is string => !!x && others.some((r) => r.name === x)) ?? null
      const own: DeskSide = { keys: [key], name: pick }
      const rest: DeskSide = { keys: [], rest: true, name: restName }
      next = zone === 'right' ? [rest, own] : [own, rest]
    } else {
      const data = deskLayout().split
      if (!data?.[at]) return
      const xs = data.map((sd) => ({ ...sd, keys: [...sd.keys] }))
      // the side it comes from: the one it is pinned to, else the rest's
      const pinned = xs.findIndex((sd) => sd.keys.includes(key))
      const o = pinned >= 0 ? pinned : xs.findIndex((sd) => sd.rest)
      if (o < 0) return
      if ((zone === 'left' || zone === 'right') && sp.length < MAX_SIDES) {
        xs[o].keys = xs[o].keys.filter((k) => k !== key)
        if (xs[o].name && mine.has(xs[o].name)) xs[o].name = null
        xs.splice(zone === 'left' ? at : at + 1, 0, { keys: [key], name: pick })
      } else {
        if (o === at) return
        const from = xs[o]
        const to = xs[at]
        // what was on the target side goes to the side the section came from, its terminal with it
        from.keys = [...from.keys.filter((k) => k !== key), ...to.keys]
        if (to.rest) {
          from.rest = true
          delete to.rest
        }
        if (from.name && mine.has(from.name)) from.name = to.name
        to.keys = [key]
        to.name = pick
      }
      next = tidySplit(xs, gs, lo)
    }
    editLayout((l) => {
      l.split = next
      l.focus = pick
    })
    setRecent((r) => [...new Set([pick, ...r])].slice(0, 16))
    keyboardTo(pick)
  }, [keyboardTo])

  /**
   * Closes side `at` of a split: its sections join the side left of it (the first side's, the one right
   * of it). One side left is no split: the grid comes back, the terminal he had in it.
   */
  const closeSide = useCallback((at: number) => {
    const { sections: gs, split: sp, focus: f, labelOf: lo } = cur.current
    const data = deskLayout().split
    if (!data?.[at] || !sp) return
    const xs = data.map((sd) => ({ ...sd, keys: [...sd.keys] }))
    const [gone] = xs.splice(at, 1)
    const nb = xs[Math.max(0, at - 1)]
    nb.keys.push(...gone.keys)
    if (gone.rest) nb.rest = true
    const next = tidySplit(xs, gs, lo)
    // the keyboard on the side that closes: it goes to the terminal beside it, which stays
    const here = sp.find((sd) => sd.at === at)?.name === f
    const to = next && here ? sp.find((sd) => sd.at === (at > 0 ? at - 1 : at + 1))?.name ?? null : f
    editLayout((l) => {
      l.split = next
      // the grid again, with the terminal he had the keyboard in
      if (!next && f && !l.view.includes(f)) {
        if (l.view.length) l.view[0] = f
        else l.view = [f]
      }
      l.focus = to
    })
    if (to) keyboardTo(to)
  }, [keyboardTo])

  /** Takes a pane out of the grid (it stays a tab); its neighbor takes the keyboard. */
  const unview = useCallback((name: string) => {
    const v = cur.current.view
    if (cur.current.split || v.length < 2 || !v.includes(name)) return
    const i = v.indexOf(name)
    const next = v.filter((x) => x !== name)
    const to = next[Math.min(i, next.length - 1)]
    editLayout((l) => {
      fromDrawn(l, cur.current)
      l.view = l.view.filter((x) => x !== name)
      if (cur.current.focus === name || !l.focus) l.focus = to
    })
    if (cur.current.focus === name) keyboardTo(to)
  }, [keyboardTo])

  /**
   * Takes a tab off the Desk ("+" and the session list put it back); its neighbor fills its pane (on a
   * split Desk, the next tab of its side). One Raven started goes back to Raven's list, minimized.
   */
  const closeTab = useCallback((name: string) => {
    const { view: v, tabs: ts, ravenNames: rn, split: sp } = cur.current
    const i = ts.findIndex((s) => s.name === name)
    const rest = ts.filter((s) => s.name !== name && !v.includes(s.name))
    const fill = rest.find((_, k) => k >= i)?.name ?? rest[rest.length - 1]?.name ?? null
    editLayout((l) => {
      if (rn.has(name)) l.raven = l.raven.filter((x) => x !== name)
      else if (!l.off.includes(name)) l.off.push(name)
      if (sp) {
        // the grid under the split forgets it; the side that showed it shows its next tab
        l.view = l.view.filter((x) => x !== name)
        const side = sp.find((sd) => sd.name === name)
        if (side) {
          const k = side.rows.findIndex((r) => r.name === name)
          const others = side.rows.filter((r) => r.name !== name)
          const to = others[Math.min(k, others.length - 1)]?.name ?? null
          const at = l.split?.[side.at]
          if (at) at.name = to
          if (l.focus === name) l.focus = to ?? sp.find((sd) => sd !== side)?.name ?? null
        }
        return
      }
      const at = v.indexOf(name)
      fromDrawn(l, cur.current)
      if (at >= 0) {
        // the only pane: the next tab takes its place; one of several: the grid closes up
        if (l.view.length === 1 && fill) l.view[0] = fill
        else l.view = l.view.filter((x) => x !== name)
      }
      if (l.focus === name) l.focus = l.view[Math.min(Math.max(at, 0), l.view.length - 1)] ?? null
    })
    setMenu(null)
  }, [])

  /** Puts a pane on the Desk (a new session, one put back) and opens it. */
  const place = useCallback((name: string) => {
    notePlaced(name)
    openTab(name)
  }, [openTab])

  // ---------- menus ----------

  useEffect(() => {
    if (!menu?.arm) return
    const t = setTimeout(() => setMenu((m) => (m ? { ...m, arm: false } : m)), 3500)
    return () => clearTimeout(t)
  }, [menu?.arm])
  useEffect(() => {
    if (!menu && !picker && !listOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      setPicker(false)
      setListOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, picker, listOpen])

  const openMenu = (name: string, el: HTMLElement | null) => {
    const rr = rootRef.current?.getBoundingClientRect()
    const er = el?.getBoundingClientRect()
    const x = er && rr ? Math.max(0, er.left - rr.left) : 0
    const y = er && rr ? Math.max(0, er.bottom - rr.top + 4) : 44
    setPicker(false)
    setListOpen(false)
    setMenu({ name, x, y, arm: false })
  }

  const stop = async (name: string) => {
    setMenu(null)
    try {
      await killTermSession(name)
      // gone now: the read below then confirms an empty list at once (one empty answer alone is held over)
      qc.setQueryData<TermSession[]>(['term', 'sessions'], (old) => old?.filter((s) => s.name !== name))
    } catch (e) {
      toast(`Could not stop it: ${errText(e)}`, { ms: 5000 })
    }
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    // stopping a Claude pane ends it on thor too, so the board's live set just changed
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  /** A new session's first grid: about the size of the pane it is about to fill. */
  const gridFor = () => {
    const b = focus ? boxes[Math.max(0, view.indexOf(focus))] ?? FULL : FULL
    const w = (stage.w || 1200) * b.w
    const h = (stage.h || 800) * b.h - (grid ? HEAD_H : 0)
    return { cols: Math.max(40, Math.floor((w - 24) / (FONT_PX * 0.6))), rows: Math.max(12, Math.floor((h - (grid ? 16 : 150)) / (FONT_PX * 1.32))) }
  }

  const start = async (t: TargetVM) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await openTermSession({ mode: 'new', target: t.key, label: t.label, ...gridFor() })
      seedTerminal(qc, r)
      setPicker(false)
      if (r.name) place(r.name)
    } catch (e) {
      toast(`Could not start ${t.label}: ${errText(e)}`, { ms: 5000 })
    } finally {
      setBusy(false)
    }
  }

  /** Resumes a closed session in a new pane on odin; the pane's name, '' when the API named none. */
  const reopen = async (s: SessionBrief): Promise<string> => {
    setOpening((o) => new Set(o).add(s.id))
    try {
      const r = await openTermSession({ mode: 'resume', sessionId: s.id, label: s.title || undefined, ...gridFor() })
      seedTerminal(qc, r)
      setReopened((m) => new Map(m).set(s.id, Date.now()))
      if (r.name) notePlaced(r.name)
      return r.name
    } finally {
      setOpening((o) => {
        const next = new Set(o)
        next.delete(s.id)
        return next
      })
    }
  }

  /** One closed session, picked from the list: it resumes in the focused pane. */
  const recoverOne = async (s: SessionBrief) => {
    if (opening.has(s.id) || recovering.current) return
    try {
      const name = await reopen(s)
      setListOpen(false)
      if (name) openTab(name)
    } catch (e) {
      toast(`Could not reopen ${s.title || 'the session'}: ${errText(e)}`, { ms: 5000 })
    }
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  /**
   * Recover all ('all'), or one context's Recover (its area key): those
   * closed, not done sessions come back as tabs, newest first, one at a time.
   * The grid stays as it is. One failure does not stop the rest; a full pane
   * list (409) does.
   */
  const recoverMany = async (scope: string) => {
    const rows = closed.filter((s) => !opening.has(s.id) && (scope === 'all' || areaOf(s) === scope))
    if (recovering.current || !rows.length) return
    const what = scope === 'all' ? '' : `${areaName(scope)} `
    recovering.current = true
    setRecover({ done: 0, total: rows.length, scope })
    let opened = 0
    let failed = 0
    let error: unknown = null
    let full = false
    for (const [i, s] of rows.entries()) {
      try {
        if (await reopen(s)) opened += 1
      } catch (e) {
        if (statusOf(e) === 409) {
          full = true
          break
        }
        failed += 1
        error ??= e
      }
      setRecover((r) => r && { ...r, done: r.done + 1 })
      if (i < rows.length - 1) await sleep(RECOVER_GAP)
    }
    recovering.current = false
    setRecover(null)
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    const total = rows.length
    const again = scope === 'all' ? 'Recover all' : `Recover ${areaName(scope)}`
    if (full) toast(`Reopened ${opened} of ${total}: Valkyrie has no room for more terminals. Close some, then ${again} again.`, { ms: 7000 })
    else if (failed) toast(`${failed} of ${total} did not reopen: ${errText(error)}`, { ms: 6000 })
    else toast(`Reopened ${opened} ${what}${opened === 1 ? 'session' : 'sessions'} as tabs`)
  }

  // ---------- keys: here, and handed up by a terminal (DeskHost.key) ----------

  const onChord = useCallback((chord: DeskChord, from?: string) => {
    const { view: v, focus: f, tabs: ts, strips } = cur.current
    const here = from ?? f
    // the strip the keyboard is in: a split Desk's side has its own
    const sh = strips.find((xs) => xs.some((s) => s.name === here)) ?? strips[0] ?? []
    if (chord === 'next' || chord === 'prev') {
      if (!sh.length) return
      const i = Math.max(0, sh.findIndex((s) => s.name === here))
      openTab(sh[(i + (chord === 'next' ? 1 : -1) + sh.length) % sh.length].name)
    } else if (chord === 'left' || chord === 'right') {
      if (v.length < 2) return
      const i = Math.max(0, v.indexOf(here ?? ''))
      openTab(v[(i + (chord === 'right' ? 1 : -1) + v.length) % v.length])
    } else if (chord === 'done') {
      // finished and not seen yet, or asking: the one that has waited longest first
      const waiting = ts
        .filter((s) => unseenDone(s.name) || paneState(s) === 'asking')
        .sort((a, b) => (doneAt(a.name) || a.stateSince || 0) - (doneAt(b.name) || b.stateSince || 0))
      const next = waiting.find((s) => s.name !== here) ?? null
      if (next) openTab(next.name)
      else toast('No session is waiting for you')
    } else {
      const k = Number(chord.slice(3)) - 1
      if (sh[k]) openTab(sh[k].name)
    }
  }, [openTab])

  // the Desk's own keys while it shows and the focus is out of a terminal
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const chord = deskChord(e)
      if (!chord) return
      e.preventDefault()
      onChord(chord)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onChord])

  // What the terminal in a pane asks for (lib/embed.ts DeskHost).
  const nameOf = (from: Window): string | null => {
    for (const [name, el] of frames.current) if (el.contentWindow === from) return name
    return null
  }
  useEffect(() => {
    const host: DeskHost = {
      open: (name) => {
        if (cur.current.tabs.some((s) => s.name === name)) openTab(name)
        else place(name)
      },
      close: (from) => {
        const name = nameOf(from)
        if (name) closeTab(name)
      },
      key: (chord, from) => onChord(chord, nameOf(from) ?? undefined),
      shown: (from) => {
        const name = nameOf(from)
        return !!name && shownRef.current.has(name)
      },
    }
    const w = window as Window & { valkyrieDesk?: DeskHost }
    w.valkyrieDesk = host
    return () => { if (w.valkyrieDesk === host) delete w.valkyrieDesk }
  }, [openTab, place, closeTab, onChord])

  // each strip is one row: it keeps its tab with the keyboard (or the one its side shows) in view when
  // that changes or the strips' shape does, clear of "Sessions" and "+", which stay at its ends. A strip
  // he scrolled himself holds while another side's tab changes.
  const titleKey = tabs.map((s) => metaOf(s).title).join('\n')
  const shapeSeen = useRef('')
  useLayoutEffect(() => {
    const shape = `${titleKey}|${foldKey}|${phone}|${stage.w}|${split?.length ?? 0}`
    const all = shapeSeen.current !== shape
    shapeSeen.current = shape
    const keep = (force: boolean) => {
      for (const row of rootRef.current?.querySelectorAll<HTMLElement>('.dk-tabs') ?? []) {
        const el = row.querySelector<HTMLElement>('.dk-tab[data-focus]') ?? row.querySelector<HTMLElement>('.dk-tab[data-on]')
        const name = el?.dataset.name ?? ''
        if (!el || (!force && row.dataset.kept === name)) continue
        row.dataset.kept = name
        const padL = row.querySelector<HTMLElement>(':scope > .dk-list-btn')?.offsetWidth ?? 0
        const padR = row.querySelector<HTMLElement>(':scope > .dk-add')?.offsetWidth ?? 0
        const l = el.offsetLeft - padL
        const r = el.offsetLeft + el.offsetWidth + padR
        if (l < row.scrollLeft) row.scrollLeft = Math.max(0, l - 8)
        else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 8
      }
    }
    keep(all)
    let live = true
    void document.fonts?.ready.then(() => { if (live) keep(all) })
    return () => { live = false }
  }, [focus, viewKey, titleKey, foldKey, phone, stage.w, split?.length])

  // a mouse wheel over a strip scrolls it sideways (a trackpad's sideways swipe and Shift+wheel already do)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      const row = (e.target as Element | null)?.closest?.<HTMLElement>('.dk-tabs')
      if (!row || e.ctrlKey || row.scrollWidth <= row.clientWidth + 1) return
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      row.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- drag a tab, a section's head or a pane's title ----------
  //
  // A tab and a pane's title are the browser's drag (a mouse). A section's head is the Desk's own,
  // by pointer, so a finger drags it too. On a strip wider than its room, a mouse that sets off
  // sideways on a tab or a head pans that strip instead; pulled down out of the strip, that pan
  // becomes the drag of what it started on. On a split Desk only a head drags: each side shows one
  // terminal, its tabs switch it.

  const [drag, setDrag] = useState<{ name: string; from: 'tab' | 'pane' | 'section' } | null>(null)
  const [dropAt, setDropAt] = useState<{ target: string; zone: Zone } | null>(null)
  const [stripDrop, setStripDrop] = useState(false)
  /** The drag by pointer that is on, for the handlers below (the state above re-renders the Desk). */
  const pdrag = useRef<{ name: string; from: 'tab' | 'section' } | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  /** The press on the strip being followed: waiting to see where it goes, panning, or dragging by pointer. */
  const gest = useRef<Gesture | null>(null)
  /** A press that panned or dragged: the tab or head under it does nothing on release. */
  const moved = () => !!gest.current && gest.current.mode !== 'wait'

  const placeGhost = (x: number, y: number) => {
    const el = ghostRef.current
    const root = rootRef.current
    if (!el || !root) return
    const rr = root.getBoundingClientRect()
    const k = rr.width / Math.max(1, root.offsetWidth) || 1
    el.style.transform = `translate(${(x - rr.left) / k + 12}px, ${(y - rr.top) / k + 14}px)`
  }
  const ghostTo = (el: HTMLDivElement | null) => {
    ghostRef.current = el
    const g = gest.current
    if (el && g) placeGhost(g.x, g.y)
  }

  /**
   * Where a drop by pointer lands. A tab: the pane under it, and where in that pane. A section: the
   * stage's left or right half (not split yet; target '-1'), or a side and its edge or middle (target
   * its place in kit/desk.ts split). A split of three sides has no room for a new one.
   */
  const aimAt = (x: number, y: number, d: { name: string; from: 'tab' | 'section' }): { target: string; zone: Zone } | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.dk-drop')
    const target = d.from === 'section' ? el?.dataset.side : el?.dataset.name
    if (!el || !target || (d.from === 'tab' && target === d.name)) return null
    if (d.from === 'section') {
      const r = el.getBoundingClientRect()
      const fx = (x - r.left) / Math.max(1, r.width)
      const sp = cur.current.split
      if (!sp) return { target, zone: fx < 0.5 ? 'left' : 'right' }
      const room = sp.length < MAX_SIDES
      return { target, zone: room && fx < 0.25 ? 'left' : room && fx > 0.75 ? 'right' : 'center' }
    }
    let zone = zoneAt({ clientX: x, clientY: y }, el)
    // a full 3x3 grid takes no pane beside another: the drop puts it in that pane's place
    if (zone !== 'center' && cur.current.view.length >= MAX_VIEW && !cur.current.view.includes(d.name)) zone = 'center'
    return { target, zone }
  }

  const startDrag = (g: Gesture, from: 'tab' | 'section', name: string) => {
    g.mode = 'drag'
    pdrag.current = { name, from }
    setMenu(null)
    setDrag({ name, from })
  }

  const stripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gest.current) return
    const row = e.currentTarget
    const t = e.target as HTMLElement
    if (t.closest('.dk-tab-x, .dk-add, .dk-list-btn')) return
    const section = t.closest<HTMLElement>('.dk-gh')?.closest<HTMLElement>('.dk-tg')?.dataset.key ?? null
    const tab = t.closest<HTMLElement>('.dk-tab')?.dataset.name ?? null
    const mouse = e.pointerType === 'mouse'
    // a finger pans the strip by itself: only a section head's drag onto the grid is the Desk's
    if (!mouse && !(section && grid)) return
    const id = e.pointerId
    const move = (ev: PointerEvent) => {
      const g = gest.current
      if (!g || ev.pointerId !== id) return
      g.x = ev.clientX
      g.y = ev.clientY
      const dx = g.x - g.x0
      const dy = g.y - g.y0
      if (g.mode === 'wait') {
        if (Math.hypot(dx, dy) < 6) return
        const sideways = Math.abs(dx) > Math.abs(dy)
        if (g.mouse && sideways && row.scrollWidth > row.clientWidth + 1) {
          g.mode = 'pan'
          hold(row, id)
        } else if (g.section && grid && (g.mouse || !sideways)) {
          hold(row, id)
          startDrag(g, 'section', g.section)
        } else {
          // a tab's drag is the browser's, a finger's sideways swipe the browser's scroll
          g.off()
          return
        }
      }
      if (g.mode === 'pan') {
        row.scrollLeft = g.left - dx
        if (grid && g.y > row.getBoundingClientRect().bottom + 24) {
          if (g.section) startDrag(g, 'section', g.section)
          else if (g.tab && !cur.current.split) startDrag(g, 'tab', g.tab)
        }
      }
      if (g.mode === 'drag' && pdrag.current) {
        placeGhost(g.x, g.y)
        const at = aimAt(g.x, g.y, pdrag.current)
        setDropAt((d) => (d?.target === at?.target && d?.zone === at?.zone ? d : at))
      }
    }
    const up = (ev: PointerEvent) => {
      const g = gest.current
      if (!g || ev.pointerId !== id) return
      const d = pdrag.current
      g.off()
      if (g.mode === 'drag') {
        const at = d && ev.type === 'pointerup' ? aimAt(ev.clientX, ev.clientY, d) : null
        endDrag()
        if (d && at) {
          if (d.from === 'section') dropSection(d.name, Number(at.target), at.zone)
          else dropOn(d.name, at.target, at.zone)
        }
      }
      // the press under it reads moved() on this same release: clear it after
      window.setTimeout(() => { if (gest.current === g) gest.current = null }, 0)
    }
    // a finger dragging a head: the strip must not scroll under it (touch-action lets it pan sideways)
    const still = (ev: TouchEvent) => { if (gest.current?.mode === 'drag' && ev.cancelable) ev.preventDefault() }
    const off = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('touchmove', still)
      if (gest.current?.mode === 'wait') gest.current = null
    }
    gest.current = { id, row, mouse, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, left: row.scrollLeft, section, tab, mode: 'wait', off }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    if (!mouse) window.addEventListener('touchmove', still, { passive: false })
  }

  const beginDrag = (name: string, from: 'tab' | 'pane') => (e: ReactDragEvent) => {
    const g = gest.current
    if (from === 'tab' && g) {
      // a mouse setting off sideways on a strip wider than its room pans it (stripDown) instead
      const row = g.row
      if (g.mode === 'pan' || (g.mouse && g.mode === 'wait' && row.scrollWidth > row.clientWidth + 1 && Math.abs(g.x - g.x0) > Math.abs(g.y - g.y0))) {
        e.preventDefault()
        g.mode = 'pan'
        hold(row, g.id)
        return
      }
      g.off()
    }
    e.dataTransfer.setData(PANE_MIME, name)
    e.dataTransfer.effectAllowed = 'move'
    setMenu(null)
    // the drop targets go up over the terminals a moment later: changing the page inside dragstart can cancel the drag
    window.setTimeout(() => setDrag({ name, from }), 0)
  }
  const endDrag = () => {
    pdrag.current = null
    setDrag(null)
    setDropAt(null)
    setStripDrop(false)
  }
  const overPane = (target: string) => (e: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes(PANE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    let zone = zoneAt(e, e.currentTarget)
    // a full 3x3 grid takes no pane beside another: the drop puts it in that pane's place
    if (zone !== 'center' && n >= MAX_VIEW && !(drag && view.includes(drag.name))) zone = 'center'
    if (dropAt?.target !== target || dropAt.zone !== zone) setDropAt({ target, zone })
  }
  const dropPane = (target: string) => (e: ReactDragEvent<HTMLDivElement>) => {
    const name = e.dataTransfer.getData(PANE_MIME)
    const zone = dropAt?.target === target ? dropAt.zone : zoneAt(e, e.currentTarget)
    endDrag()
    if (!name || !tabNames.has(name)) return
    e.preventDefault()
    dropOn(name, target, zone)
  }
  // a pane's title dropped on the tab strip takes it out of the grid
  const overStrip = (e: ReactDragEvent<HTMLDivElement>) => {
    if (drag?.from !== 'pane' || n < 2 || !Array.from(e.dataTransfer.types).includes(PANE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!stripDrop) setStripDrop(true)
  }
  const dropStrip = (e: ReactDragEvent<HTMLDivElement>) => {
    const name = e.dataTransfer.getData(PANE_MIME)
    const from = drag?.from
    endDrag()
    if (from !== 'pane' || !name) return
    e.preventDefault()
    unview(name)
  }

  // ---------- render ----------

  const loaded = !!steadyList || list.length > 0
  const empty = loaded && !tabs.length
  const menuTab = menu ? list.find((x) => x.name === menu.name) ?? null : null
  // his own he took off the Desk; Raven's minimized ones are the Raven card's
  const offDesk = sortPanes(list.filter((s) => L.off.includes(s.name) && !byRaven(s)))
  const own = list.length - ravens.length
  const headH = grid ? HEAD_H : 0
  const vars: Vars = { '--dk-gap': `${GAP}px`, '--dk-head-h': `${HEAD_H}px` }

  const tooltip = (s: TermSession) => {
    const m = metaOf(s)
    const st = paneState(s)
    const word = st === 'idle' && unseenDone(s.name) ? 'done' : WORD[st]
    const since = s.stateSince && st !== 'dead' ? ` for ${ago(s.stateSince, now)}` : ''
    const lines = [m.title, [m.area && areaName(m.area), m.project, `${word}${since}`].filter(Boolean).join(' · ')]
    if (m.where) lines.push(m.where)
    if (byRaven(s)) lines.push('Started by Raven')
    if (st === 'asking' && s.ask) lines.push(s.ask)
    return lines.join('\n')
  }

  // the session list: every running pane by area, then project
  const groups = useMemo(() => {
    const out: { area: string; projects: { project: string; rows: TermSession[] }[] }[] = []
    for (const s of sortPanes(list.filter((x) => !byRaven(x)))) {
      const m = meta.get(s.name)
      const area = m?.area ?? ''
      const project = m?.project ?? ''
      let g = out[out.length - 1]
      if (!g || g.area !== area) out.push((g = { area, projects: [] }))
      let p = g.projects[g.projects.length - 1]
      if (!p || p.project !== project) g.projects.push((p = { project, rows: [] }))
      p.rows.push(s)
    }
    return out
  }, [list, sortPanes, meta])

  // Raven's sessions waiting on him (finished and not seen, or asking): the folded chip lights for them
  const ravenAsking = ravens.filter((s) => paneState(s) === 'asking').length
  const ravenLit = ravens.filter((s) => unseenDone(s.name) || paneState(s) === 'asking').length
  const openRaven = (name: string) => {
    if (tabNames.has(name)) openTab(name)
    else place(name)
  }
  const ravenOff = ravens.filter((s) => !tabNames.has(s.name)).map((s) => s.name)
  // an empty Desk on the phone has no strip (nothing to switch) unless the folded Raven chip needs it
  const strip = !(empty && phone) || (!ravenOpen && ravens.length > 0)
  const card = ravenOpen && ravens.length > 0
  // the tabs' row; an empty Desk with the card open would leave it blank
  const bar = strip && !(empty && card)

  /** One tab in the strip. */
  const tabFor = (s: TermSession) => (
    <Tab
      key={s.name}
      s={s}
      title={metaOf(s).title}
      tip={tooltip(s)}
      raven={byRaven(s)}
      on={view.includes(s.name)}
      focused={focus === s.name}
      coarse={coarse}
      draggable={grid && !split}
      onOpen={(el) => {
        if (moved()) return
        if (focus === s.name && coarse) openMenu(s.name, el)
        else openTab(s.name)
      }}
      onMenu={(el) => openMenu(s.name, el)}
      onClose={() => closeTab(s.name)}
      onDragStart={beginDrag(s.name, 'tab')}
      onDragEnd={endDrag}
    />
  )

  const sessionsBtn = (
    <Press
      className="dk-list-btn"
      aria-expanded={listOpen}
      aria-label="All sessions"
      title="All sessions, by area and project"
      onPress={() => { setMenu(null); setPicker(false); setListOpen((v) => !v) }}
    >
      <Icon name={ListTree} size={coarse ? 17 : 14} tone="dim" />
      {!phone && <span>Sessions</span>}
      <Icon name={ChevronDown} size={coarse ? 14 : 11} tone="dim" />
    </Press>
  )

  /** A section in a strip: its head, then its tabs. `sep`: a quiet line after it, before the next section. */
  const sectionFor = (g: Section, sep: boolean) => {
    const folded = foldedOf(g)
    const hidden = folded ? g.rows.filter((s) => !view.includes(s.name)) : []
    const rows = rowsOf(g)
    const fixed = sole.has(g.key)
    return (
      <div key={g.key} className="dk-tg" role="group" aria-label={g.label} data-key={g.key} data-folded={folded || undefined} data-sep={sep || undefined}>
        {/* the head keeps its first tab beside it */}
        <span className="dk-tg-lead">
          <SectionHead
            label={g.label}
            n={g.rows.length}
            folded={folded}
            fixed={fixed}
            raven={g.raven}
            waiting={hidden.filter(waits).length}
            asking={hidden.some((s) => paneState(s) === 'asking')}
            working={hidden.some((s) => paneState(s) === 'working')}
            coarse={coarse}
            grab={grid ? (split ? 'side' : 'split') : null}
            onToggle={() => { if (!moved() && !fixed) setFold(g.key, !folded) }}
          />
          {rows[0] && tabFor(rows[0])}
        </span>
        {rows.slice(1).map(tabFor)}
      </div>
    )
  }

  const addBtn = (
    <Press
      className="dk-add"
      aria-label="New session"
      title="New session, or put one back"
      aria-expanded={picker}
      onPress={() => { setMenu(null); setListOpen(false); setPicker((p) => !p) }}
    >
      <Icon name="add" size={coarse ? 18 : 15} tone={picker ? 'fg' : 'dim'} glow={picker} />
    </Press>
  )

  const ravenChip = !ravenOpen && ravens.length > 0 && (
    <Press
      className="dk-rchip"
      data-lit={ravenLit > 0 || undefined}
      data-tone={ravenAsking ? 'ask' : undefined}
      data-on={(!!focus && ravens.some((s) => s.name === focus)) || undefined}
      aria-expanded={false}
      aria-label={`Raven started ${ravens.length} ${ravens.length === 1 ? 'session' : 'sessions'}${ravenLit ? `, ${ravenLit} waiting on you` : ''}. Show them.`}
      title="Show the sessions Raven started"
      onPress={() => { setMenu(null); setRavenOpen(true) }}
    >
      <Icon name="raven" size={coarse ? 15 : 13} tone={ravenAsking ? 'acc2' : 'fg'} glow />
      <span>Raven</span>
      <span className="dk-rchip-n">{ravens.length}</span>
    </Press>
  )

  return (
    <div ref={rootRef} className="dk" style={vars} data-grid={grid || undefined} data-coarse={coarse || undefined} data-phone={phone || undefined} data-n={n} data-split={split?.length}>
      {/* "Sessions" at the top left: beside the Raven card while it is open, else the (first) strip's first item, so it never moves.
          The strip spans the Desk from its left edge, under the card; split by sections, one strip over each side. */}
      {(strip || card) && (
        <div className="dk-top">
          {card && (
            <div className="dk-top-row">
              {strip && sessionsBtn}
              <RavenCard
                rows={ravens}
                meta={metaOf}
                tip={tooltip}
                view={view}
                focus={focus}
                off={ravenOff}
                coarse={coarse}
                now={now}
                onOpen={openRaven}
                onMenu={(name, el) => openMenu(name, el)}
                onFold={() => setRavenOpen(false)}
              />
            </div>
          )}
          {bar && !split && (
            <div className="dk-bar" data-drop={stripDrop || undefined} onDragOver={overStrip} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setStripDrop(false) }} onDrop={dropStrip}>
              <div className="dk-tabs" role="tablist" aria-label="Your sessions" onPointerDown={stripDown}>
                {!card && sessionsBtn}
                {sections.map((g, i) => sectionFor(g, i < sections.length - 1))}
                {!empty && addBtn}
              </div>
              {ravenChip}
            </div>
          )}
          {/* split by sections: one strip over each side, as wide as its terminal, that scrolls on its own */}
          {bar && split && (
            <div className="dk-bar" data-split={split.length} style={{ gridTemplateColumns: sideColumns(split.length) }}>
              {split.map((sd, i) => {
                const what = sd.sections.map((g) => g.label).join(', ')
                const last = i === split.length - 1
                return (
                  <div key={sd.at} className="dk-side" data-side={sd.at} data-focus={sd.name === focus || undefined}>
                    <div className="dk-tabs" role="tablist" aria-label={`${what} sessions`} onPointerDown={stripDown}>
                      {i === 0 && !card && sessionsBtn}
                      {sd.sections.map((g, k) => sectionFor(g, k < sd.sections.length - 1))}
                      {last && !empty && addBtn}
                    </div>
                    <Press
                      className="dk-side-x"
                      aria-label={`Close the ${what} side`}
                      title={`Close this side: its tabs join the side ${i > 0 ? 'left' : 'right'} of it`}
                      onPress={() => closeSide(sd.at)}
                    >
                      <Icon name="stop" size={11} tone="dim" />
                    </Press>
                    {last && ravenChip}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {drag?.from === 'section' && (() => {
        const g = sections.find((x) => x.key === drag.name)
        return g && (
          <div ref={ghostTo} className="dk-ghost" aria-hidden>
            {g.raven && <Icon name="raven" size={11} tone="fg" />}
            <span>{g.label}</span>
            <span className="dk-gh-n">{g.rows.length}</span>
          </div>
        )
      })()}

      <div ref={stageRef} className="dk-stage">
        {/* the terminals, one layer, so a layout change never reloads one */}
        {mountedSorted.map((name) => {
          const s = tabs.find((x) => x.name === name)
          if (!s) return null
          const i = view.indexOf(name)
          const on = i >= 0
          const b = on ? boxes[i] : lastBox[name] ?? FULL
          return (
            <iframe
              key={name}
              ref={(el) => { if (el) frames.current.set(name, el); else frames.current.delete(name) }}
              className="dk-frame"
              data-name={name}
              data-on={on || undefined}
              style={boxStyle(b, headH)}
              title={metaOf(s).title}
              src={`/m/w/term/${encodeURIComponent(name)}`}
              inert={!on || undefined}
              onLoad={() => { if (focusRef.current === name && on) focusFrame(name) }}
              onFocus={() => { if (on && cur.current.focus !== name) editLayout((l) => { l.focus = name }) }}
            />
          )
        })}

        {/* each pane's frame and title row, over its terminal */}
        {grid && view.map((name, i) => {
          const s = tabs.find((x) => x.name === name)
          if (!s) return null
          const m = metaOf(s)
          const st = paneState(s)
          const mark = markOf(st)
          return (
            <div key={name} className="dk-pane" data-name={name} style={boxStyle(boxes[i])} data-focus={(n > 1 && focus === name) || undefined}>
              <div
                className="dk-head"
                data-state={st}
                draggable={n > 1 && !split}
                title={tooltip(s)}
                onDragStart={beginDrag(name, 'pane')}
                onDragEnd={endDrag}
                onPointerDown={() => openTab(name)}
              >
                {mark && <StateIcon a={mark} size={13} className="dk-head-mark" />}
                <span className="dk-head-t">{m.title}</span>
                {byRaven(s) && <RavenTag />}
                {m.folder && <span className="dk-head-f">{m.folder}</span>}
                {n > 1 && !split && (
                  <Press className="dk-head-x" aria-label={`Take ${m.title} out of the grid`} title="Take it out of the grid (it stays a tab)" onPointerDown={(e) => e.stopPropagation()} onPress={() => unview(name)}>
                    <Icon name="stop" size={11} tone="dim" />
                  </Press>
                )}
              </div>
            </div>
          )
        })}

        {/* while a tab or a pane's title drags: one target over each pane (a terminal's iframe would swallow the drag), lit where it would land */}
        {drag && grid && drag.from !== 'section' && !split && view.map((name, i) => {
          const z = dropAt?.target === name ? dropAt.zone : null
          return (
            <div
              key={name}
              className="dk-drop"
              data-name={name}
              style={boxStyle(boxes[i])}
              data-self={drag.name === name || undefined}
              onDragOver={overPane(name)}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.target === name ? null : d)) }}
              onDrop={dropPane(name)}
            >
              {z && drag.name !== name && <div className="dk-drop-hint" data-zone={z} />}
            </div>
          )
        })}
        {/* a section's head dragging: one target over the whole stage, or one over each side of a split */}
        {drag?.from === 'section' && grid && (split
          ? split.map((sd, i) => <div key={sd.at} className="dk-drop" data-side={sd.at} style={boxStyle(boxes[i])} />)
          : <div className="dk-drop" data-side="-1" style={boxStyle(FULL)} />)}
        {/* where it would land, lit: a half of the Desk, a side's edge (a new side) or a side (it takes that side) */}
        {drag?.from === 'section' && grid && dropAt && (() => {
          const g = sections.find((x) => x.key === drag.name)
          const at = Number(dropAt.target)
          const i = split ? split.findIndex((sd) => sd.at === at) : -1
          if (!g || (split && i < 0)) return null
          const home = split?.findIndex((sd) => sd.sections.some((x) => x.key === g.key)) ?? -1
          // onto its own side's middle: nothing changes
          if (split && dropAt.zone === 'center' && home === i) return null
          const text = !split ? `${g.label} on the ${dropAt.zone}` : dropAt.zone === 'center' ? `${g.label} here` : `${g.label} as a new side`
          return (
            <div className="dk-side-drop" style={boxStyle(split ? boxes[i] : FULL)}>
              <div className="dk-drop-hint" data-zone={dropAt.zone} />
              <span className="dk-side-t" data-zone={dropAt.zone}>{text}</span>
            </div>
          )
        })()}

        {!loaded && <p className="dk-quiet">{panes.isError ? `Could not read the sessions: ${errText(panes.error)}` : 'Reading sessions'}</p>}
        {empty && (
          <div className="dk-empty">
            {/* every pane can be off the Desk while it runs: then "+" puts them back */}
            <p>{own ? `${own} running, none on the Desk.` : ravens.length ? 'None of yours is open.' : 'No session is open.'}</p>
            <Press className="dk-start" aria-expanded={picker} onPress={() => { setMenu(null); setListOpen(false); setPicker((p) => !p) }}>
              <Icon name="add" size={14} tone="dim" />
              <span>{own ? 'Put one back' : 'New session'}</span>
            </Press>
            <RecoverCard
              rows={closed}
              areas={recoverAreas}
              opening={opening}
              recover={recover}
              coarse={coarse}
              now={now}
              areaName={areaName}
              onReopen={(s) => void recoverOne(s)}
              onRecover={(scope) => void recoverMany(scope)}
            />
          </div>
        )}

        {listOpen && (
          <SessionList
            groups={groups}
            ravens={ravens}
            meta={metaOf}
            view={view}
            off={L.off}
            focus={focus}
            closed={closedGroups}
            closedN={closed.length}
            closedReady={index.ready}
            recoverAreas={recoverAreas}
            areaName={areaName}
            opening={opening}
            recover={recover}
            now={now}
            onPick={(name) => { setListOpen(false); place(name) }}
            onReopen={(s) => void recoverOne(s)}
            onRecover={(scope) => void recoverMany(scope)}
            onClose={() => setListOpen(false)}
          />
        )}

        {picker && (
          <NewTab
            wide={!phone}
            busy={busy}
            targets={targets}
            off={offDesk}
            meta={metaOf}
            onStart={(t) => void start(t)}
            onPutBack={(name) => { setPicker(false); place(name) }}
            onClose={() => setPicker(false)}
          />
        )}
      </div>

      {menu && menuTab && (
        <TabMenu
          title={metaOf(menuTab).title}
          live={!menuTab.dead}
          beside={grid && !split && !view.includes(menuTab.name) && n < MAX_VIEW}
          closable={tabNames.has(menuTab.name)}
          closeLabel={byRaven(menuTab) ? 'Minimize into Raven' : 'Close tab'}
          x={Math.min(menu.x, Math.max(0, stage.w - 270))}
          y={menu.y}
          arm={menu.arm}
          onBeside={() => {
            setMenu(null)
            const target = focus ?? view[view.length - 1]
            if (target) dropOn(menuTab.name, target, 'right')
            else openTab(menuTab.name)
          }}
          onCloseTab={() => closeTab(menuTab.name)}
          onStop={() => { if (!menu.arm) setMenu({ ...menu, arm: true }); else void stop(menuTab.name) }}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}

// ---------- Raven's sessions: a card at the top, in the Raven tab's chat-box look ----------

/** "Raven" with the bird, where a session Raven started shows outside its card (a pane's title row, a list). */
function RavenTag() {
  return (
    <span className="dk-rtag" title="Started by Raven">
      <Icon name="raven" size={11} tone="fg" />
      <span>Raven</span>
    </span>
  )
}

/**
 * The sessions Raven started, newest first: a press opens one in the focused
 * pane (or puts it back on the Desk), a right click or a long press opens its
 * menu. The card is the Raven composer's rounded box (kit/raven.css
 * .rv-compose) and each row is a row of the Raven tab's Connected column
 * (screens/messages.css .rv-crow), so the two read as one place. The chevron
 * folds it into the Raven chip at the strip's right end.
 */
function RavenCard({ rows, meta, tip, view, focus, off, coarse, now, onOpen, onMenu, onFold }: {
  rows: TermSession[]
  meta: (s: TermSession) => PaneMeta
  tip: (s: TermSession) => string
  view: string[]
  focus: string | null
  off: string[]
  coarse: boolean
  now: number
  onOpen: (name: string) => void
  onMenu: (name: string, el: HTMLElement | null) => void
  onFold: () => void
}) {
  const n = rows.length
  return (
    <section className="dk-raven rv-compose" aria-label="Sessions Raven started">
      <div className="dk-raven-head">
        <Icon name="raven" size={coarse ? 16 : 14} tone="fg" glow />
        <span className="dk-raven-k">Raven</span>
        <span className="dk-raven-n">{`started ${n} ${n === 1 ? 'session' : 'sessions'}`}</span>
        <Press className="dk-raven-fold" aria-expanded aria-label="Fold Raven's sessions into a chip" title="Fold into a chip" onPress={onFold}>
          <Icon name={ChevronDown} size={coarse ? 17 : 14} tone="dim" />
        </Press>
      </div>
      <div className="dk-raven-rows">
        {rows.map((s) => (
          <RavenRow
            key={s.name}
            s={s}
            m={meta(s)}
            tip={tip(s)}
            here={focus === s.name}
            on={view.includes(s.name)}
            off={off.includes(s.name)}
            now={now}
            onOpen={() => onOpen(s.name)}
            onMenu={(el) => onMenu(s.name, el)}
          />
        ))}
      </div>
    </section>
  )
}

function RavenRow({ s, m, tip, here, on, off, now, onOpen, onMenu }: {
  s: TermSession
  m: PaneMeta
  tip: string
  here: boolean
  on: boolean
  off: boolean
  now: number
  onOpen: () => void
  onMenu: (el: HTMLElement | null) => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const st = paneState(s)
  const mark = markOf(st)
  const lit = unseenDone(s.name)
  const word = st === 'idle' && lit ? 'done' : WORD[st]
  const since = s.stateSince && st !== 'dead' ? ` ${ago(s.stateSince, now)}` : ''
  const note = here ? 'here' : on ? 'in view' : `${word}${since}`
  const { down, up, swallow } = useLongPress(() => onMenu(ref.current))
  return (
    <Press
      ref={ref}
      className="dk-rrow rv-crow"
      data-state={st}
      data-on={on || undefined}
      data-here={here || undefined}
      data-lit={lit || undefined}
      data-off={off || undefined}
      title={tip}
      aria-label={`${m.title}, ${note}${s.ask && st === 'asking' ? `: ${s.ask}` : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(ref.current)
      }}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      onPress={() => {
        if (swallow()) return
        onOpen()
      }}
    >
      {mark ? <StateIcon a={mark} size={14} className="dk-rrow-mark" /> : <span className="dk-row-nomark" aria-hidden />}
      <span className="rv-crow-name">{m.title}</span>
      <span className="rv-crow-note">{note}</span>
      {(m.folder || (st === 'asking' && s.ask)) && <span className="rv-crow-line">{st === 'asking' && s.ask ? s.ask : m.folder}</span>}
    </Press>
  )
}

// ---------- a section's head in the strip ----------

/**
 * A section's name and how many tabs it holds; a press collapses it (its tabs
 * in view stay) or expands it. Collapsed, it lights while a tab it hides waits
 * on him (the second accent for a question), and shows the bolt while one works.
 * Alone on a side of a split Desk it is that side's name: it never collapses.
 */
function SectionHead({ label, n, folded, fixed, raven, waiting, asking, working, coarse, grab, onToggle }: {
  label: string
  n: number
  folded: boolean
  /** alone on its side: no collapse */
  fixed: boolean
  /** the tabs Raven started: the bird before the name */
  raven: boolean
  /** hidden tabs that finished unseen or ask */
  waiting: number
  asking: boolean
  working: boolean
  coarse: boolean
  /** on the grid it drags onto the Desk (Desk.tsx stripDown): 'split' splits the Desk by it, 'side' moves it to a side */
  grab: 'split' | 'side' | null
  onToggle: () => void
}) {
  const what = `${n} ${label} ${n === 1 ? 'tab' : 'tabs'}`
  const drag = grab === 'split' ? `. Drag it onto the Desk to give ${label} a side of its own`
    : grab === 'side' ? '. Drag it onto a side to put it there, or onto a side\'s edge for a new side' : ''
  const press = fixed ? what : folded ? `Expand the ${what}${waiting ? ` (${waiting} waiting on you)` : ''}` : `Collapse the ${what}`
  return (
    <Press
      className="dk-gh"
      aria-expanded={fixed ? undefined : !folded}
      data-fixed={fixed || undefined}
      data-lit={waiting > 0 || undefined}
      data-tone={asking ? 'ask' : undefined}
      aria-label={`${label}: ${n} ${n === 1 ? 'tab' : 'tabs'}${folded ? ', collapsed' : ''}${waiting ? `, ${waiting} waiting on you` : ''}`}
      data-grab={grab || undefined}
      title={`${press}${drag}`}
      onPress={onToggle}
    >
      {!fixed && <Icon name={ChevronDown} size={coarse ? 13 : 11} tone="dim" className="dk-gh-i" />}
      {raven && <Icon name="raven" size={coarse ? 13 : 11} tone="fg" />}
      <span className="dk-gh-t">{label}</span>
      {folded && working && !waiting && <StateIcon a="working" size={coarse ? 13 : 12} className="dk-gh-mark" />}
      <span className="dk-gh-n">{n}</span>
    </Press>
  )
}

// ---------- a tab ----------

function Tab({ s, title, tip, raven, on, focused, coarse, draggable, onOpen, onMenu, onClose, onDragStart, onDragEnd }: {
  s: TermSession
  title: string
  tip: string
  /** Raven started it: the bird before its title, and its close minimizes it into Raven */
  raven: boolean
  /** in the grid */
  on: boolean
  /** the pane with the keyboard */
  focused: boolean
  coarse: boolean
  draggable: boolean
  onOpen: (el: HTMLElement | null) => void
  onMenu: (el: HTMLElement | null) => void
  onClose: () => void
  onDragStart: (e: ReactDragEvent) => void
  onDragEnd: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const st = paneState(s)
  const mark = markOf(st)
  const lit = unseenDone(s.name)
  // a long press on a touch screen opens the tab's menu (and the tap that ends it does nothing)
  const { down, up, swallow } = useLongPress(() => onMenu(ref.current))
  return (
    <div
      ref={ref}
      className="dk-tab"
      data-name={s.name}
      data-on={on || undefined}
      data-focus={focused || undefined}
      data-state={st}
      data-lit={lit || undefined}
      title={tip}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(ref.current)
      }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        onClose()
      }}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
    >
      <Press
        className="dk-tab-main"
        role="tab"
        aria-selected={on}
        aria-label={`${title}, ${lit && st === 'idle' ? 'done' : WORD[st]}${s.ask && st === 'asking' ? `: ${s.ask}` : ''}`}
        onPress={() => {
          if (swallow()) return
          onOpen(ref.current)
        }}
      >
        {mark && <StateIcon a={mark} size={coarse ? 15 : 14} className="dk-mark" />}
        {raven && <Icon name="raven" size={coarse ? 13 : 11} tone="dim" />}
        <span className="dk-tab-t">{title}</span>
      </Press>
      <Press
        className="dk-tab-x"
        aria-label={raven ? `Minimize ${title} into Raven` : `Close the ${title} tab`}
        title={raven ? 'Minimize into Raven (the session keeps running)' : 'Close tab (the session keeps running)'}
        tabIndex={focused ? 0 : -1}
        onPress={onClose}
      >
        <Icon name="stop" size={coarse ? 14 : 12} tone="dim" />
      </Press>
    </div>
  )
}

// ---------- a tab's menu: open it beside, close it, stop its session ----------

function TabMenu({ title, live, beside, closable, closeLabel, x, y, arm, onBeside, onCloseTab, onStop, onDismiss }: {
  title: string
  live: boolean
  /** it is not in the grid and the grid has room: it can open beside the focused pane */
  beside: boolean
  /** a tab in the strip: Close tab takes it off the Desk (a minimized Raven row has no tab to close) */
  closable: boolean
  /** a Raven tab's close minimizes it into Raven */
  closeLabel: string
  x: number
  y: number
  /** Stop was pressed once: the next press stops the session */
  arm: boolean
  onBeside: () => void
  onCloseTab: () => void
  onStop: () => void
  onDismiss: () => void
}) {
  return (
    <>
      <div className="dk-scrim" onPointerDown={onDismiss} />
      <div className="dk-menu" role="menu" aria-label={`${title}: tab`} style={{ left: x, top: y }}>
        {/* the whole title: a touch screen has no tooltip */}
        <div className="dk-menu-t">{title}</div>
        {beside &&<Press role="menuitem" className="dk-mi" onPress={onBeside}>Open beside</Press>}
        {closable && <Press role="menuitem" className="dk-mi" onPress={onCloseTab}>{closeLabel}</Press>}
        {live && (
          <Press role="menuitem" className="dk-mi" data-tone="hot" data-arm={arm || undefined} onPress={onStop}>
            {arm ? 'Press again to stop it' : 'Stop session'}
          </Press>
        )}
      </div>
    </>
  )
}

// ---------- "Sessions": every running pane by area, then project; then the closed, not done ones ----------

function SessionList({
  groups, ravens, meta, view, off, focus, closed, closedN, closedReady, recoverAreas, areaName, opening, recover, now, onPick, onReopen, onRecover, onClose,
}: {
  groups: { area: string; projects: { project: string; rows: TermSession[] }[] }[]
  /** the panes Raven started, newest first: a section of their own under his */
  ravens: TermSession[]
  meta: (s: TermSession) => PaneMeta
  view: string[]
  off: string[]
  focus: string | null
  closed: ClosedGroup[]
  closedN: number
  /** the board has been read this page load */
  closedReady: boolean
  /** one Recover per context that has closed sessions */
  recoverAreas: RecoverArea[]
  areaName: (area: string) => string
  /** ids being resumed */
  opening: ReadonlySet<string>
  recover: Recover | null
  now: number
  onPick: (name: string) => void
  onReopen: (s: SessionBrief) => void
  /** 'all', or one context's area key */
  onRecover: (scope: string) => void
  onClose: () => void
}) {
  // every area starts folded each time the list opens; a press on its name opens it
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  const fold = (key: string, label: string, count: number) => {
    const open = unfolded.has(key)
    return {
      open,
      head: (
        <Press
          className="dk-fold"
          aria-expanded={open}
          onPress={() => setUnfolded((u) => {
            const next = new Set(u)
            if (open) next.delete(key)
            else next.add(key)
            return next
          })}
        >
          <Icon name={ChevronDown} size={11} tone="dim" className="dk-fold-i" />
          <span className="dk-fold-t">{label}</span>
          <span className="dk-n">{count}</span>
        </Press>
      ),
    }
  }
  const runRow = (s: TermSession) => {
    const m = meta(s)
    const st = paneState(s)
    const mark = markOf(st)
    const where = s.name === focus ? 'here' : view.includes(s.name) ? 'in view' : off.includes(s.name) ? 'off the desk' : ''
    return (
      <Press key={s.name} className="dk-row" data-on={view.includes(s.name) || undefined} title={m.where} onPress={() => onPick(s.name)}>
        {mark ? <StateIcon a={mark} size={14} /> : <span className="dk-row-nomark" aria-hidden />}
        <span className={cx('dk-row-t', st === 'dead' && 'dk-row-dead')}>{m.title}</span>
        {m.folder && <span className="dk-row-f">{m.folder}</span>}
        <span className="dk-row-s">{where || WORD[st]}</span>
      </Press>
    )
  }
  const closedPart = (
    <section className="dk-closed" aria-label="Closed, not done">
      <div className="dk-closed-head">
        <h3 className="dk-k">Closed, not done <span className="dk-n">{closedN}</span></h3>
        {(closedN > 0 || recover?.scope === 'all') && (
          <Press
            className="dk-recover"
            disabled={!!recover}
            title={`Reopen all ${closedN} as tabs on the Desk`}
            onPress={() => onRecover('all')}
          >
            <Icon name="refresh" size={12} tone="dim" className={recover?.scope === 'all' ? 'vl-pulse' : undefined} />
            {recover?.scope === 'all' ? `Recovering ${recover.done}/${recover.total}` : 'Recover all'}
          </Press>
        )}
      </div>
      <RecoverButtons areas={recoverAreas} recover={recover} areaName={areaName} onRecover={onRecover} />
      {!closedReady && <p className="dk-quiet-row">Reading the closed sessions</p>}
      {closedReady && !closedN && <p className="dk-quiet-row">Every closed session is marked done.</p>}
      {closed.map((g) => {
        const f = fold(g.raven ? 'closed:raven' : `closed:${g.area}`, g.raven ? 'Started by Raven' : areaName(g.area), g.rows.length)
        return (
          <div key={g.raven ? 'raven' : g.area || '-'} className="dk-cg" data-raven={g.raven || undefined}>
            <div className="dk-tsec-k">{f.head}</div>
            {f.open && (
              <div className="dk-rows">
                {g.rows.map((s) => {
                  const busy = opening.has(s.id)
                  return (
                    <Press key={s.id} className="dk-row dk-crow" disabled={busy || !!recover} title={s.cwd ?? undefined} onPress={() => onReopen(s)}>
                      <StateIcon a="closed" size={14} />
                      <span className="dk-row-t">{s.title || 'Untitled session'}</span>
                      {s.cwd && <span className="dk-row-f">{shortFolder(s.cwd)}</span>}
                      <span className="dk-row-s">{busy ? 'opening' : s.last ? ago(s.last, now) : ''}</span>
                    </Press>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
  return (
    <>
      <div className="dk-scrim" onPointerDown={onClose} />
      <div className="dk-list" role="dialog" aria-label="All sessions">
        {!groups.length && <p className="dk-quiet-row">{ravens.length ? 'None of yours is open.' : 'No session is open.'}</p>}
        {groups.map((g) => {
          const f = fold(`run:${g.area}`, areaName(g.area), g.projects.reduce((k, p) => k + p.rows.length, 0))
          return (
            <section key={g.area || '-'} className="dk-lg">
              <h3 className="dk-k">{f.head}</h3>
              {f.open && g.projects.map((p) => (
                <div key={p.project || '-'} className="dk-lp">
                  {p.project && <div className="dk-tsec-k">{p.project}</div>}
                  <div className="dk-rows">{p.rows.map(runRow)}</div>
                </div>
              ))}
            </section>
          )
        })}
        {ravens.length > 0 && (() => {
          const f = fold('run:raven', 'Started by Raven', ravens.length)
          return (
            <section className="dk-lg" data-raven>
              <h3 className="dk-k">{f.head}</h3>
              {f.open && <div className="dk-rows">{ravens.map(runRow)}</div>}
            </section>
          )
        })()}
        {closedPart}
      </div>
    </>
  )
}

// ---------- recover: one Recover per context, and the empty Desk's card ----------

/**
 * One Recover per context that has closed, not done sessions ("Recover Thor",
 * "Recover Odin"), in area order, each with its count; a context with none has
 * no button. The one running keeps its button and shows its progress; the rest
 * wait. With `all`, Recover all leads the row (the empty Desk's card).
 */
function RecoverButtons({ all, areas, recover, areaName, onRecover }: {
  /** the closed count: Recover all first, in the empty Desk's look */
  all?: number
  areas: RecoverArea[]
  recover: Recover | null
  areaName: (area: string) => string
  onRecover: (scope: string) => void
}) {
  const scope = recover?.scope
  const list = scope && scope !== 'all' && !areas.some((a) => a.area === scope) ? [...areas, { area: scope, label: areaName(scope), n: 0 }] : areas
  const big = all !== undefined
  const btn = (key: string, text: string, n: number, title: string) => {
    const running = scope === key
    return (
      <Press
        key={key}
        className={big ? cx('dk-recover-btn', key === 'all' && 'dk-recover-all') : 'dk-recover dk-recover-ctx'}
        data-scope={key}
        disabled={!!recover}
        title={title}
        onPress={() => onRecover(key)}
      >
        <Icon name="refresh" size={big ? 13 : 12} tone="dim" className={running ? 'vl-pulse' : undefined} />
        {running && recover
          ? <span>{`Recovering ${recover.done}/${recover.total}`}</span>
          : <><span>{text}</span>{' '}<span className="dk-recover-n">{n}</span></>}
      </Press>
    )
  }
  if (!list.length && !big) return null
  return (
    <div className={big ? 'dk-recov-acts' : 'dk-recover-row'}>
      {big && (all > 0 || scope === 'all') && btn('all', 'Recover all', all, `Reopen all ${all} as tabs on the Desk`)}
      {list.map((a) => btn(a.area, `Recover ${a.label}`, a.n, `Reopen the ${a.n} closed ${a.label} ${a.n === 1 ? 'session' : 'sessions'} as tabs`))}
    </div>
  )
}

/**
 * The empty Desk's list: every closed, not done session on thor (the set
 * Recover all brings back), newest first, each with its context and when it
 * closed; a tap resumes that one as a tab. Over the rows, Recover all and one
 * Recover per context. A plain grey box of its own: the accent-tinted box and
 * glowing label are the Raven card's alone.
 */
function RecoverCard({ rows, areas, opening, recover, coarse, now, areaName, onReopen, onRecover }: {
  rows: SessionBrief[]
  areas: RecoverArea[]
  /** ids being resumed */
  opening: ReadonlySet<string>
  recover: Recover | null
  coarse: boolean
  now: number
  areaName: (area: string) => string
  onReopen: (s: SessionBrief) => void
  onRecover: (scope: string) => void
}) {
  if (!rows.length && !recover) return null
  const n = rows.length
  return (
    <section className="dk-recov" aria-label="Closed sessions to recover">
      <div className="dk-recov-head">
        <Icon name="refresh" size={coarse ? 16 : 14} tone="dim" />
        <span className="dk-recov-k">Recover</span>
        <span className="dk-recov-n">{`${n} closed, not done`}</span>
      </div>
      <RecoverButtons all={n} areas={areas} recover={recover} areaName={areaName} onRecover={onRecover} />
      <div className="dk-recov-rows">
        {rows.map((s) => {
          const busy = opening.has(s.id)
          const title = s.title || 'Untitled session'
          const ctx = areaName(areaOf(s))
          const when = s.last ? `${ago(s.last, now)} ago` : ''
          const line = [s.raven ? 'Started by Raven' : '', s.cwd ? shortFolder(s.cwd) : ''].filter(Boolean).join(' · ')
          return (
            <Press
              key={s.id}
              className="rv-crow dk-recrow"
              disabled={busy || !!recover}
              title={s.cwd ?? undefined}
              aria-label={`${title}, ${ctx}${when ? `, closed ${when}` : ''}. Recover it.`}
              onPress={() => onReopen(s)}
            >
              <StateIcon a="closed" size={14} className="dk-recrow-mark" />
              <span className="rv-crow-name">{title}</span>
              <span className="dk-ctx">{ctx}</span>
              <span className="rv-crow-note">{busy ? 'opening' : when}</span>
              {line && <span className="rv-crow-line">{line}</span>}
            </Press>
          )
        })}
      </div>
    </section>
  )
}

// ---------- "+": a new session, or a running one put back ----------

function NewTab({ wide, busy, targets, off, meta, onStart, onPutBack, onClose }: {
  wide: boolean
  busy: boolean
  targets: ReturnType<typeof useLaunchTargets>
  off: TermSession[]
  meta: (s: TermSession) => PaneMeta
  onStart: (t: TargetVM) => void
  onPutBack: (name: string) => void
  onClose: () => void
}) {
  // the same places AI > Sessions offers for a new session inside Valkyrie: the everyday folders and
  // the projects, and on a wide screen every other target too
  const all = targets.data ?? []
  const sections = [
    { label: 'Folders', items: all.filter((t) => t.phone && !t.project) },
    { label: 'Projects', items: all.filter((t) => t.phone && t.project) },
    { label: 'More', items: wide ? all.filter((t) => !t.phone) : [] },
  ].filter((x) => x.items.length)
  return (
    <div className="dk-pick" role="dialog" aria-label="New session">
      <div className="dk-pick-head">
        <h2>New session</h2>
        <Press className="dk-pick-x" onPress={onClose}>Close</Press>
      </div>
      <section>
        <h3 className="dk-k">Start Claude on thor</h3>
        {!all.length && (
          <p className="dk-quiet-row">{targets.failed ? `thor did not answer: ${targets.error?.message ?? 'no reply'}` : targets.isFetching || !targets.data ? 'Reading the launch targets' : 'thor offers no launch targets'}</p>
        )}
        {sections.map((sec) => (
          <div key={sec.label} className="dk-tsec">
            {sections.length > 1 && <div className="dk-tsec-k">{sec.label}</div>}
            <div className="dk-chips">
              {sec.items.map((t) => (
                <Press key={t.key} className="dk-chip" disabled={busy} onPress={() => onStart(t)}>
                  <Icon name={t.project ? 'projects' : 'claude'} size={13} tone="dim" />
                  <span>{t.label}</span>
                </Press>
              ))}
            </div>
          </div>
        ))}
      </section>
      <section>
        <h3 className="dk-k">Off the Desk <span className="dk-n">{off.length}</span></h3>
        {!off.length && <p className="dk-quiet-row">Every running session is on the Desk.</p>}
        <div className="dk-rows">
          {off.map((s) => {
            const st = paneState(s)
            const mark = markOf(st)
            const m = meta(s)
            return (
              <Press key={s.name} className="dk-row" title={m.where} onPress={() => onPutBack(s.name)}>
                {mark ? <StateIcon a={mark} size={14} /> : <span className="dk-row-nomark" aria-hidden />}
                <span className={cx('dk-row-t', st === 'dead' && 'dk-row-dead')}>{m.title}</span>
                {byRaven(s) && <RavenTag />}
                {m.folder && <span className="dk-row-f">{m.folder}</span>}
                <span className="dk-row-s">{WORD[st]}</span>
              </Press>
            )
          })}
        </div>
      </section>
    </div>
  )
}

// ---------- the badge on the Desk tab ----------

/**
 * How many tabs finished and are not opened yet, on the Desk tab from any
 * screen (the Raven badge's look); in the asking tone while one of them asks
 * him something.
 */
export function DeskBadge() {
  const { list } = useDeskPanes(15_000)
  useDeskStore()
  const lit = onDesk(list ?? EMPTY).filter((s) => unseenDone(s.name))
  if (!lit.length) return null
  const asking = lit.filter((s) => paneState(s) === 'asking').length
  const n = lit.length
  const label = `${n} ${n === 1 ? 'session' : 'sessions'} done${asking ? `, ${asking} asking` : ''}`
  return <span className="dk-badge" data-n={n > 99 ? '99+' : String(n)} data-tone={asking ? 'ask' : undefined} title={label} aria-hidden />
}
