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
import { ago, useLaunchTargets, useSessionIndex, useTick, type TargetVM } from '../kit/data'
import {
  MAX_VIEW, deskLayout, doneAt, editLayout, notePlaced, onDesk, paneState, setDeskInView, syncLayout, unseenDone, useDeskPanes, useDeskStore,
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
// and then by project. A tab shows the session's state with the AI > Sessions
// icons (kit/icons StateIcon: working the bolt, asking the bubble in the second
// accent, idle the pause circle) and its title, which also lights when the
// session finished while it was out of view (kit/desk.ts), so a glance tells
// still working, finished, and finished with a question for him. "Sessions"
// at the strip's start lists them all by area and project; "+" starts one.
//
// Under it, the grid: one session fills the Desk at first. On a desktop he
// drags a tab (or a pane's title) onto a pane: its middle puts it in that
// pane's place, an edge puts it beside it, so the grid grows from one to a
// split, 2x2 and 3x3 (kit/desk.ts view). Each pane is the bare terminal under
// a title row: the session's title and the folder it runs in. A touch screen
// shows one session at a time, with the terminal page's composer and keys.
//
// A pane's session is the pop-out terminal page (/m/w/term/<name>) in an
// iframe. The panes in view and the most recent others stay mounted, so a
// switch back is instant and keeps the scrollback; every iframe is one layer
// placed by style, so a layout change never reloads one. The terminals ask
// the Desk for what a pop-out does for itself, and hand it the Desk's keys,
// through window.valkyrieDesk (lib/embed.ts DeskHost).

const EMPTY: TermSession[] = []
/** iframes kept mounted (each is a whole page): the grid's panes, then the most recent others */
const MAX_MOUNTED = 12
const MAX_MOUNTED_TOUCH = 4
/** the terminal page's default font, for sizing a session before its pane attaches */
const FONT_PX = 14
const PANE_MIME = 'application/x-valkyrie-pane'
/** px: a pane's title row on a desktop (desk.css .dk-head) */
const HEAD_H = 26
/** px between panes (desk.css --dk-gap) */
const GAP = 6

type Vars = CSSProperties & Record<`--${string}`, string | number>

const WORD: Record<PaneState, string> = { working: 'working', asking: 'asking', idle: 'idle', shell: 'shell', dead: 'ended' }

/** The mark's icon for a pane state; a shell has none, an ended pane the faint closed mark. */
const markOf = (st: PaneState): SessionState | null => (st === 'shell' ? null : st === 'dead' ? 'closed' : st)

const areaName = (a: string) => (a ? a[0].toUpperCase() + a.slice(1) : 'Other')
/** The conversation a pane runs: a new pane knows it from the start, a resume keeps it as its target. */
const paneSid = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

/** The folder a pane runs in, short: the whole path when it is short, else its last folder. */
function shortFolder(cwd: string): string {
  const p = cwd.replace(/[\\/]+$/, '')
  return p.length <= 24 ? p : p.split(/[\\/]/).pop() || p
}

// ---------- the grid ----------

/** Columns for n panes: one, a split side by side, 2x2, 3x3. */
const gridCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : 3)

type Box = { x: number; y: number; w: number; h: number }
/** Pane i of n, as fractions of the stage: a short last row's panes share its width. */
function cellBox(i: number, n: number): Box {
  const c = gridCols(n)
  const rows = Math.ceil(n / c)
  const r = Math.floor(i / c)
  const inRow = r === rows - 1 ? n - r * c : c
  return { x: (i - r * c) / inRow, y: r / rows, w: 1 / inRow, h: 1 / rows }
}
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 }
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

type Menu = { name: string; x: number; arm: boolean }

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
  const stripRef = useRef<HTMLDivElement>(null)
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
    return rankOf(ma?.area ?? '') - rankOf(mb?.area ?? '')
      || Number(!!ma?.project) - Number(!!mb?.project)
      || (ma?.project ?? '').localeCompare(mb?.project ?? '')
      || a.createdAt - b.createdAt
  }), [meta, rankOf])

  const tabs = useMemo(() => sortPanes(onDesk(list)), [sortPanes, list, L.off]) // eslint-disable-line react-hooks/exhaustive-deps
  const tabNames = new Set(tabs.map((s) => s.name))

  // the grid: the panes he placed that are still on the Desk; before he placed any, the first tab fills it
  const placedView = L.view.filter((n) => tabNames.has(n))
  const focusName = L.focus && tabNames.has(L.focus) ? L.focus : null
  const view: string[] = !grid
    ? [focusName ?? placedView[0] ?? tabs[0]?.name].filter((x): x is string => !!x)
    : placedView.length ? placedView : tabs[0] ? [tabs[0].name] : []
  const n = view.length
  const focus = focusName && view.includes(focusName) ? focusName : view[0] ?? null
  const viewKey = view.join(',')

  // the panes in view count as seen while the Desk shows
  useEffect(() => {
    setDeskInView(onScreen ? view : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, viewKey])
  useEffect(() => () => setDeskInView([]), [])

  // ---------- mounted terminals: the grid's, then the most recently opened ----------

  const [woke, setWoke] = useState(active)
  if (active && !woke) setWoke(true)
  const [recent, setRecent] = useState<string[]>([])
  const max = coarse ? MAX_MOUNTED_TOUCH : MAX_MOUNTED
  const mounted = woke ? [...new Set([...view, ...recent])].filter((x) => tabNames.has(x)).slice(0, Math.max(max, n)) : []
  // a stable DOM order: moving an iframe in the DOM reloads it
  const mountedSorted = [...mounted].sort()
  // a pane out of view keeps the box it last had, so hiding it never resizes its session
  const [boxes, setBoxes] = useState<{ key: string; at: Record<string, Box> }>({ key: '', at: {} })
  if (boxes.key !== viewKey) {
    const at = { ...boxes.at }
    view.forEach((name, i) => { at[name] = cellBox(i, n) })
    setBoxes({ key: viewKey, at })
  }
  const lastBox = boxes.at
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
  const cur = useRef({ view, focus, tabs, grid })
  useLayoutEffect(() => { cur.current = { view, focus, tabs, grid } })

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

  /** Opens a session: in view already, it takes the keyboard; else it takes the focused pane's place (that one stays a tab). */
  const openTab = useCallback((name: string) => {
    const { view: v, focus: f, grid: g } = cur.current
    const was = f && f !== name ? f : null
    editLayout((l) => {
      l.off = l.off.filter((x) => x !== name)
      if (!g) l.view = [name]
      else if (!v.includes(name)) {
        const next = [...v]
        const i = f ? next.indexOf(f) : -1
        if (i >= 0) next[i] = name
        else if (next.length) next[0] = name
        else next.push(name)
        l.view = next
      } else l.view = v
      l.focus = name
    })
    setRecent((r) => [...new Set([name, ...(was ? [was] : []), ...r])].slice(0, 16))
    keyboardTo(name)
  }, [keyboardTo])

  /** A drop on pane `target`: its middle swaps the two (or puts the dragged one in its place), an edge puts it beside. */
  const dropOn = useCallback((name: string, target: string, zone: Zone) => {
    const v = cur.current.view
    if (name === target || !v.includes(target)) return
    editLayout((l) => {
      l.off = l.off.filter((x) => x !== name)
      let next = [...v]
      const from = next.indexOf(name)
      const ti = next.indexOf(target)
      if (zone === 'center' || (from < 0 && next.length >= MAX_VIEW)) {
        if (from >= 0) next[from] = target
        next[ti] = name
      } else {
        next = next.filter((x) => x !== name)
        next.splice(next.indexOf(target) + (zone === 'right' || zone === 'bottom' ? 1 : 0), 0, name)
      }
      l.view = next
      l.focus = name
    })
    setRecent((r) => [...new Set([name, target, ...r])].slice(0, 16))
    keyboardTo(name)
  }, [keyboardTo])

  /** Takes a pane out of the grid (it stays a tab); its neighbor takes the keyboard. */
  const unview = useCallback((name: string) => {
    const v = cur.current.view
    if (v.length < 2 || !v.includes(name)) return
    const i = v.indexOf(name)
    const next = v.filter((x) => x !== name)
    const to = next[Math.min(i, next.length - 1)]
    editLayout((l) => {
      l.view = next
      if (cur.current.focus === name || !l.focus) l.focus = to
    })
    if (cur.current.focus === name) keyboardTo(to)
  }, [keyboardTo])

  /** Takes a tab off the Desk ("+" and the session list put it back); its neighbor fills its pane. */
  const closeTab = useCallback((name: string) => {
    const { view: v, tabs: ts } = cur.current
    const i = ts.findIndex((s) => s.name === name)
    const rest = ts.filter((s) => s.name !== name && !v.includes(s.name))
    const fill = rest.find((_, k) => k >= i)?.name ?? rest[rest.length - 1]?.name ?? null
    editLayout((l) => {
      if (!l.off.includes(name)) l.off.push(name)
      const at = v.indexOf(name)
      const next = [...v]
      if (at >= 0) {
        // the only pane: the next tab takes its place; one of several: the grid closes up
        if (next.length === 1 && fill) next[0] = fill
        else next.splice(at, 1)
      }
      l.view = next
      if (l.focus === name) l.focus = next[Math.min(Math.max(at, 0), next.length - 1)] ?? null
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
    const root = rootRef.current
    const x = el && root ? Math.max(0, el.getBoundingClientRect().left - root.getBoundingClientRect().left) : 0
    setPicker(false)
    setListOpen(false)
    setMenu({ name, x, arm: false })
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
    const b = focus ? cellBox(Math.max(0, view.indexOf(focus)), n) : FULL
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

  // ---------- keys: here, and handed up by a terminal (DeskHost.key) ----------

  const onChord = useCallback((chord: DeskChord, from?: string) => {
    const { view: v, focus: f, tabs: ts } = cur.current
    const here = from ?? f
    if (chord === 'next' || chord === 'prev') {
      if (!ts.length) return
      const i = Math.max(0, ts.findIndex((s) => s.name === here))
      openTab(ts[(i + (chord === 'next' ? 1 : -1) + ts.length) % ts.length].name)
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
      if (ts[k]) openTab(ts[k].name)
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

  // the strip keeps the focused tab in view when it scrolls sideways (the phone, many tabs)
  const titleKey = tabs.map((s) => metaOf(s).title).join('\n')
  useLayoutEffect(() => {
    const keep = () => {
      const row = stripRef.current
      const el = focus && row ? row.querySelector<HTMLElement>(`[data-name="${focus}"]`) : null
      if (!row || !el) return
      const l = el.offsetLeft
      const r = l + el.offsetWidth
      if (l < row.scrollLeft) row.scrollLeft = Math.max(0, l - 8)
      else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 8
    }
    keep()
    let live = true
    void document.fonts?.ready.then(() => { if (live) keep() })
    return () => { live = false }
  }, [focus, titleKey])

  // ---------- drag a tab or a pane's title (a mouse) ----------

  const [drag, setDrag] = useState<{ name: string; from: 'tab' | 'pane' } | null>(null)
  const [dropAt, setDropAt] = useState<{ target: string; zone: Zone } | null>(null)
  const [stripDrop, setStripDrop] = useState(false)
  const beginDrag = (name: string, from: 'tab' | 'pane') => (e: ReactDragEvent) => {
    e.dataTransfer.setData(PANE_MIME, name)
    e.dataTransfer.effectAllowed = 'move'
    setMenu(null)
    // the drop targets go up over the terminals a moment later: changing the page inside dragstart can cancel the drag
    window.setTimeout(() => setDrag({ name, from }), 0)
  }
  const endDrag = () => {
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
  const menuTab = menu ? tabs.find((x) => x.name === menu.name) ?? null : null
  const offDesk = sortPanes(list.filter((s) => L.off.includes(s.name)))
  const headH = grid ? HEAD_H : 0
  const vars: Vars = { '--dk-gap': `${GAP}px`, '--dk-head-h': `${HEAD_H}px` }

  const tooltip = (s: TermSession) => {
    const m = metaOf(s)
    const st = paneState(s)
    const word = st === 'idle' && unseenDone(s.name) ? 'done' : WORD[st]
    const since = s.stateSince && st !== 'dead' ? ` for ${ago(s.stateSince, now)}` : ''
    const lines = [m.title, [m.area && areaName(m.area), m.project, `${word}${since}`].filter(Boolean).join(' · ')]
    if (m.where) lines.push(m.where)
    if (st === 'asking' && s.ask) lines.push(s.ask)
    return lines.join('\n')
  }

  // the session list: every running pane by area, then project
  const groups = useMemo(() => {
    const out: { area: string; projects: { project: string; rows: TermSession[] }[] }[] = []
    for (const s of sortPanes(list)) {
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

  return (
    <div ref={rootRef} className="dk" style={vars} data-grid={grid || undefined} data-coarse={coarse || undefined} data-n={n}>
      {/* an empty Desk on the phone has no strip: nothing to switch */}
      {!(empty && phone) && (
        <div className="dk-bar" data-drop={stripDrop || undefined} onDragOver={overStrip} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setStripDrop(false) }} onDrop={dropStrip}>
          <Press
            className="dk-list-btn"
            aria-expanded={listOpen}
            aria-label="All sessions"
            title="All sessions, by area and project"
            onPress={() => { setMenu(null); setPicker(false); setListOpen((v) => !v) }}
          >
            <Icon name={ListTree} size={coarse ? 17 : 14} tone={listOpen ? 'fg' : 'dim'} glow={listOpen} />
            {!phone && <span>Sessions</span>}
            <Icon name={ChevronDown} size={coarse ? 14 : 11} tone="dim" />
          </Press>
          <div ref={stripRef} className="dk-tabs" role="tablist" aria-label="Sessions">
            {tabs.map((s, i) => {
              const m = metaOf(s)
              // a quiet line where the area changes
              const prev = tabs[i - 1]
              const split = !!prev && (meta.get(prev.name)?.area ?? '') !== m.area
              return (
                <Tab
                  key={s.name}
                  s={s}
                  title={m.title}
                  tip={tooltip(s)}
                  split={split}
                  on={view.includes(s.name)}
                  focused={focus === s.name}
                  coarse={coarse}
                  draggable={grid}
                  onOpen={(el) => {
                    if (focus === s.name && coarse) openMenu(s.name, el)
                    else openTab(s.name)
                  }}
                  onMenu={(el) => openMenu(s.name, el)}
                  onClose={() => closeTab(s.name)}
                  onDragStart={beginDrag(s.name, 'tab')}
                  onDragEnd={endDrag}
                />
              )
            })}
          </div>
          {!empty && (
            <Press
              className="dk-add"
              aria-label="New session"
              title="New session, or put one back"
              aria-expanded={picker}
              onPress={() => { setMenu(null); setListOpen(false); setPicker((p) => !p) }}
            >
              <Icon name="add" size={coarse ? 18 : 15} tone={picker ? 'fg' : 'dim'} glow={picker} />
            </Press>
          )}
        </div>
      )}

      <div ref={stageRef} className="dk-stage">
        {/* the terminals, one layer, so a layout change never reloads one */}
        {mountedSorted.map((name) => {
          const s = tabs.find((x) => x.name === name)
          if (!s) return null
          const i = view.indexOf(name)
          const on = i >= 0
          const b = on ? cellBox(i, n) : lastBox[name] ?? FULL
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
            <div key={name} className="dk-pane" data-name={name} style={boxStyle(cellBox(i, n))} data-focus={(n > 1 && focus === name) || undefined}>
              <div
                className="dk-head"
                data-state={st}
                draggable={n > 1}
                title={tooltip(s)}
                onDragStart={beginDrag(name, 'pane')}
                onDragEnd={endDrag}
                onPointerDown={() => openTab(name)}
              >
                {mark && <StateIcon a={mark} size={13} className="dk-head-mark" />}
                <span className="dk-head-t">{m.title}</span>
                {m.folder && <span className="dk-head-f">{m.folder}</span>}
                {n > 1 && (
                  <Press className="dk-head-x" aria-label={`Take ${m.title} out of the grid`} title="Take it out of the grid (it stays a tab)" onPointerDown={(e) => e.stopPropagation()} onPress={() => unview(name)}>
                    <Icon name="stop" size={11} tone="dim" />
                  </Press>
                )}
              </div>
            </div>
          )
        })}

        {/* while a drag is on: one target over each pane (a terminal's iframe would swallow the drag), lit where it would land */}
        {drag && grid && view.map((name, i) => {
          const z = dropAt?.target === name ? dropAt.zone : null
          return (
            <div
              key={name}
              className="dk-drop"
              style={boxStyle(cellBox(i, n))}
              data-self={drag.name === name || undefined}
              onDragOver={overPane(name)}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.target === name ? null : d)) }}
              onDrop={dropPane(name)}
            >
              {z && drag.name !== name && <div className="dk-drop-hint" data-zone={z} />}
            </div>
          )
        })}

        {!loaded && <p className="dk-quiet">{panes.isError ? `Could not read the sessions: ${errText(panes.error)}` : 'Reading sessions'}</p>}
        {empty && (
          <div className="dk-empty">
            {/* every pane can be off the Desk while it runs: then "+" puts them back */}
            <p>{list.length ? `${list.length} running, none on the Desk.` : 'No session is open.'}</p>
            <Press className="dk-start" aria-expanded={picker} onPress={() => { setMenu(null); setListOpen(false); setPicker((p) => !p) }}>
              <Icon name="add" size={14} tone="fg" glow />
              <span>{list.length ? 'Put one back' : 'New session'}</span>
            </Press>
          </div>
        )}

        {listOpen && (
          <SessionList
            groups={groups}
            meta={metaOf}
            view={view}
            off={L.off}
            focus={focus}
            onPick={(name) => { setListOpen(false); place(name) }}
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
          beside={grid && !view.includes(menuTab.name) && n < MAX_VIEW}
          x={Math.min(menu.x, Math.max(0, stage.w - 210))}
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

// ---------- a tab ----------

function Tab({ s, title, tip, split, on, focused, coarse, draggable, onOpen, onMenu, onClose, onDragStart, onDragEnd }: {
  s: TermSession
  title: string
  tip: string
  /** the first tab of another area: a quiet line before it */
  split: boolean
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
  const long = useRef<{ t: number; fired: boolean } | null>(null)
  const down = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    const rec = { t: 0, fired: false }
    rec.t = window.setTimeout(() => {
      rec.fired = true
      onMenu(ref.current)
    }, 520)
    long.current = rec
  }
  const up = () => { if (long.current) window.clearTimeout(long.current.t) }
  useEffect(() => () => { if (long.current) window.clearTimeout(long.current.t) }, [])
  return (
    <div
      ref={ref}
      className="dk-tab"
      data-name={s.name}
      data-on={on || undefined}
      data-focus={focused || undefined}
      data-split={split || undefined}
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
          if (long.current?.fired) { long.current = null; return }
          onOpen(ref.current)
        }}
      >
        {mark && <StateIcon a={mark} size={coarse ? 15 : 14} className="dk-mark" />}
        <span className="dk-tab-t">{title}</span>
      </Press>
      <Press className="dk-tab-x" aria-label={`Close the ${title} tab`} title="Close tab (the session keeps running)" tabIndex={focused ? 0 : -1} onPress={onClose}>
        <Icon name="stop" size={coarse ? 14 : 12} tone="dim" />
      </Press>
    </div>
  )
}

// ---------- a tab's menu: open it beside, close it, stop its session ----------

function TabMenu({ title, live, beside, x, arm, onBeside, onCloseTab, onStop, onDismiss }: {
  title: string
  live: boolean
  /** it is not in the grid and the grid has room: it can open beside the focused pane */
  beside: boolean
  x: number
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
      <div className="dk-menu" role="menu" aria-label={`${title}: tab`} style={{ left: x }}>
        {beside && <Press role="menuitem" className="dk-mi" onPress={onBeside}>Open beside</Press>}
        <Press role="menuitem" className="dk-mi" onPress={onCloseTab}>Close tab</Press>
        {live && (
          <Press role="menuitem" className="dk-mi" data-tone="hot" data-arm={arm || undefined} onPress={onStop}>
            {arm ? 'Press again to stop it' : 'Stop session'}
          </Press>
        )}
      </div>
    </>
  )
}

// ---------- "Sessions": every running pane by area, then project ----------

function SessionList({ groups, meta, view, off, focus, onPick, onClose }: {
  groups: { area: string; projects: { project: string; rows: TermSession[] }[] }[]
  meta: (s: TermSession) => PaneMeta
  view: string[]
  off: string[]
  focus: string | null
  onPick: (name: string) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="dk-scrim" onPointerDown={onClose} />
      <div className="dk-list" role="dialog" aria-label="All sessions">
        {!groups.length && <p className="dk-quiet-row">No session is open.</p>}
        {groups.map((g) => (
          <section key={g.area || '-'} className="dk-lg">
            <h3 className="dk-k">{areaName(g.area)}</h3>
            {g.projects.map((p) => (
              <div key={p.project || '-'} className="dk-lp">
                {p.project && <div className="dk-tsec-k">{p.project}</div>}
                <div className="dk-rows">
                  {p.rows.map((s) => {
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
                  })}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
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
