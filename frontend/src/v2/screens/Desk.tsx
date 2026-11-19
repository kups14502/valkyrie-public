import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { killTermSession, openTermSession, termLabel, type PaneState, type TermSession } from '../../lib/api'
import { DESK_FOCUS_EVENT, DESK_SHOWN_EVENT, deskChord, type DeskChord, type DeskHost } from '../../lib/embed'
import { BASE_AREAS, projAreasQuery } from '../../lib/projectsApi'
import { useProfile } from '../../lib/deviceMode'
import { seedTerminal } from '../../lib/sessionLaunch'
import { errText } from '../../lib/term'
import { ago, useLaunchTargets, useSessionIndex, useTick, type TargetVM } from '../kit/data'
import {
  deskLayout, doneAt, editLayout, notePlaced, onDesk, paneState, setDeskInView, syncLayout, unseenDone, useDeskPanes, useDeskStore,
} from '../kit/desk'
import { Icon, StateIcon } from '../kit/icons'
import type { SessionState } from '../kit/sessionState'
import type { ScreenProps } from '../kit/shell'
import { Press, cx, toast } from '../kit/ui'
import './desk.css'

// The Desk (/m/desk), on every device right after Messages: where he works in
// Claude sessions inside Valkyrie, with tabs like Windows Terminal. One to
// three columns side by side, each a tab group: a strip of tabs on top, the
// active tab's session below, filling the screen's height.
//
// Every open Valkyrie pane on odin is a tab (the tmux list), new ones joining
// the end of their column. A tab shows the session's state with the AI >
// Sessions icons (kit/icons StateIcon: working the bolt, asking the bubble in
// the second accent, idle the pause circle) and its title, which also lights
// when the session finished while the tab was out of view (kit/desk.ts), so a
// glance tells still working, finished, and finished with a question for him.
// Closing a tab only takes it off the Desk ("+" puts it back); the tab menu
// stops the session itself.
//
// A tab's session is the pop-out terminal page (/m/w/term/<name>) in an
// iframe, so it is exactly what a pop-out window shows. The most recent tabs
// stay mounted and hidden, so a switch back is instant and keeps the
// scrollback. Nothing is mounted until the Desk is first opened: every tab is
// in the pager at once, and an iframe attaches to its pane and sizes it. The
// terminals ask the Desk for what a pop-out does for itself, and hand it the
// Desk's keys, through window.valkyrieDesk (lib/embed.ts DeskHost).
//
// Placement, order, the active tabs and the column count are kept per device.

const EMPTY: TermSession[] = []
/** iframes kept mounted across all columns (each is a whole page); fewer on the phone */
const MAX_MOUNTED = 8
const MAX_MOUNTED_PHONE = 4
/** px between columns (desk.css --dk-gap) */
const GAP = 10
/** the terminal page's default font, for sizing a session before its tab attaches */
const FONT_PX = 14
const PANE_MIME = 'application/x-valkyrie-pane'

type Vars = CSSProperties & Record<`--${string}`, string | number>
type Device = ReturnType<typeof useProfile>['resolved']

/** This device's column count when he has not picked one: phone 1, iPad 1 upright and 2 on its side, a monitor 2 (1 when narrow), the headset 3. */
function autoCols(device: Device, w: number, h: number): 1 | 2 | 3 {
  if (device === 'vr') return 3
  if (device === 'iphone') return 1
  if (device === 'ipad') return w > h ? 2 : 1
  return w > 0 && w < 1200 ? 1 : 2
}

const WORD: Record<PaneState, string> = { working: 'working', asking: 'asking', idle: 'idle', shell: 'shell', dead: 'ended' }

/** The mark's icon for a pane state; a shell has none, an ended pane the faint closed mark. */
const markOf = (st: PaneState): SessionState | null => (st === 'shell' ? null : st === 'dead' ? 'closed' : st)

const areaName = (a: string) => (a ? a[0].toUpperCase() + a.slice(1) : '')
const isWorkArea = (a: string) => a !== '' && a !== 'personal' && a !== 'server' && a !== 'other'
/** The conversation a pane runs: a new pane knows it from the start, a resume keeps it as its target. */
const paneSid = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    const f = () => setV(!document.hidden)
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])
  return v
}

type Menu = { name: string; col: number; x: number; arm: boolean }

export default function Desk({ active }: ScreenProps) {
  const qc = useQueryClient()
  const device = useProfile().resolved
  const phone = device === 'iphone'
  const coarse = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches, [])
  const visible = usePageVisible()
  const onScreen = active && visible

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const stripEls = useRef(new Map<number, HTMLDivElement>())
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  // the Desk's own size (the UI zoom hides from media queries) and its stage's, in layout px
  const [box, setBox] = useState({ w: 0, h: 0, sw: 0, sh: 0 })
  useLayoutEffect(() => {
    const el = rootRef.current
    const st = stageRef.current
    if (!el || !st) return
    const read = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight && b.sw === st.clientWidth && b.sh === st.clientHeight
      ? b
      : { w: el.clientWidth, h: el.clientHeight, sw: st.clientWidth, sh: st.clientHeight }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
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
  const now = useTick(active ? 30_000 : 300_000)
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, b] of index.byId) if (b.title) m.set(id, b.title)
    return m
  }, [index.byId])

  // ---------- area: which column a tab starts in ----------

  /** The pane's area: its conversation's on the board, else what its launch target says. '' = not known yet. */
  const areaOf = useCallback((s: TermSession): string => {
    const sid = paneSid(s)
    const a = sid ? index.byId.get(sid)?.area : undefined
    if (a) return a
    if (s.mode === 'resume' || !s.target) return ''
    if (s.target === 'personal' || s.target === 'server' || areas.includes(s.target)) return s.target
    return ''
  }, [index.byId, areas])

  /** true for a work area: any area that is not personal or server; the everyday launch targets besides those are work. null = not known yet. */
  const workOf = useCallback((s: TermSession): boolean | null => {
    const a = areaOf(s)
    if (a) return isWorkArea(a)
    const t = s.mode !== 'resume' ? (targets.data ?? []).find((x) => x.key === s.target) : undefined
    return t && t.phone && !t.project ? true : null
  }, [areaOf, targets.data])

  const tabs = onDesk(list)
  const n: 1 | 2 | 3 = phone ? 1 : L.cols || autoCols(device, box.w, box.h)
  const colOf = (s: TermSession): number => {
    if (n === 1) return 0
    const c = L.col[s.name]
    if (c !== undefined) return Math.min(c, n - 1)
    return (L.work[s.name] ?? workOf(s)) === true ? 0 : n - 1
  }
  const columns: TermSession[][] = Array.from({ length: n }, () => [])
  for (const s of tabs) columns[colOf(s)].push(s)
  const actives = columns.map((col, c) => col.find((s) => s.name === L.active[c]) ?? col[0] ?? null)
  const activeKey = actives.map((s) => s?.name ?? '').join(',')

  // an area once known stays: a board that stops answering never moves a tab
  const learn = tabs.filter((s) => L.work[s.name] === undefined).map((s) => [s.name, workOf(s)] as const).filter((x) => x[1] !== null)
  const learnKey = learn.map(([k, v]) => `${k}:${v}`).join(',')
  useEffect(() => {
    if (!learn.length) return
    editLayout((l) => { for (const [k, v] of learn) l.work[k] = v === true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learnKey])

  // the tabs in view count as seen: the active tab of each column while the Desk shows
  useEffect(() => {
    setDeskInView(onScreen ? actives.filter((s): s is TermSession => !!s).map((s) => s.name) : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, activeKey])
  useEffect(() => () => setDeskInView([]), [])

  // ---------- mounted terminals: the active tabs, then the most recently opened ----------

  const [woke, setWoke] = useState(active)
  if (active && !woke) setWoke(true)
  // the tabs he opened, most recent first (a tab active only while the list was loading is not one)
  const [recent, setRecent] = useState<string[]>([])
  const max = phone ? MAX_MOUNTED_PHONE : MAX_MOUNTED
  const tabNames = new Set(tabs.map((s) => s.name))
  const activeNames = actives.filter((s): s is TermSession => !!s).map((s) => s.name)
  const mounted = woke ? [...new Set([...activeNames, ...recent])].filter((x) => tabNames.has(x)).slice(0, Math.max(max, activeNames.length)) : []
  // a stable DOM order: moving an iframe in the DOM reloads it
  const mountedSorted = [...mounted].sort()
  // the tabs in view: a mounted one behind another keeps its terminal attached but stops its quick polls
  // (lib/embed.ts deskTabShown, read by the terminal page)
  const shownRef = useRef(new Set<string>())
  const shownKey = active ? activeNames.join(',') : ''
  useEffect(() => {
    shownRef.current = new Set(shownKey ? shownKey.split(',') : [])
    for (const f of frames.current.values()) {
      try {
        f.contentWindow?.dispatchEvent(new Event(DESK_SHOWN_EVENT))
      } catch { /* not loaded yet: it asks when it starts */ }
    }
  }, [shownKey])

  // the tab menu (long press, right-click, a tap on the active tab on a touch screen) and "+"
  const [menu, setMenu] = useState<Menu | null>(null)
  const [picker, setPicker] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const [focusCol, setFocusCol] = useState(0)
  const fc = Math.min(focusCol, n - 1)
  const focusRef = useRef<string | null>(null)
  // what the callbacks below (keys, the terminals' requests) read: the tabs as last drawn
  const tabsRef = useRef({ columns, actives, n, fc })
  useLayoutEffect(() => { tabsRef.current = { columns, actives, n, fc } })

  const focusFrame = useCallback((name: string) => {
    if (coarse) return
    const w = frames.current.get(name)?.contentWindow
    if (!w) return
    try {
      w.focus()
      w.dispatchEvent(new Event(DESK_FOCUS_EVENT))
    } catch { /* not loaded yet: onLoad tries again */ }
  }, [coarse])

  /** Opens a tab: active in its column, that column focused, the keyboard in its terminal. */
  const openTab = useCallback((c: number, name: string) => {
    editLayout((l) => {
      l.active[c] = name
      for (let i = 0; i < 3; i++) if (i !== c && l.active[i] === name) l.active[i] = null
    })
    setFocusCol(c)
    // the tab it replaces stays mounted too: switching back is instant
    const was = tabsRef.current.actives[c]?.name
    setRecent((r) => [...new Set([name, ...(was ? [was] : []), ...r])].slice(0, 16))
    focusRef.current = name
    requestAnimationFrame(() => requestAnimationFrame(() => focusFrame(name)))
  }, [focusFrame])

  /** Takes a tab off the Desk; the column's neighbor tab becomes active. */
  const closeTab = useCallback((name: string) => {
    const cols = tabsRef.current.columns
    const c = cols.findIndex((col) => col.some((s) => s.name === name))
    const col = c >= 0 ? cols[c] : []
    const i = col.findIndex((s) => s.name === name)
    const next = col[i + 1]?.name ?? col[i - 1]?.name ?? null
    editLayout((l) => {
      if (!l.off.includes(name)) l.off.push(name)
      l.active = l.active.map((x) => (x === name ? null : x))
      if (c >= 0 && tabsRef.current.actives[c]?.name === name) l.active[c] = next
    })
    setMenu(null)
  }, [])

  /** Puts a pane in column c, at the end or before `before`, and opens it there. */
  const place = useCallback((name: string, c: number, before?: string | null) => {
    notePlaced(name)
    editLayout((l) => {
      l.off = l.off.filter((x) => x !== name)
      l.col[name] = c
      l.order = l.order.filter((x) => x !== name)
      const i = before ? l.order.indexOf(before) : -1
      if (i >= 0) l.order.splice(i, 0, name)
      else l.order.push(name)
    })
    openTab(c, name)
  }, [openTab])

  // ---------- menus ----------

  useEffect(() => {
    if (!menu?.arm) return
    const t = setTimeout(() => setMenu((m) => (m ? { ...m, arm: false } : m)), 3500)
    return () => clearTimeout(t)
  }, [menu?.arm])
  useEffect(() => {
    if (!menu && picker === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      setPicker(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, picker])

  const openMenu = (name: string, c: number, el: HTMLElement | null) => {
    const strip = el?.closest('.dk-strip')
    const x = el && strip ? Math.max(0, el.getBoundingClientRect().left - strip.getBoundingClientRect().left) : 0
    setPicker(null)
    setMenu({ name, col: c, x, arm: false })
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

  /** A new session's first grid: about the size of the column it is about to fill. */
  const gridFor = () => {
    const w = ((box.sw || box.w) - (n - 1) * GAP) / n
    const h = box.sh || box.h
    return { cols: Math.max(40, Math.floor((w - 24) / (FONT_PX * 0.6))), rows: Math.max(12, Math.floor((h - 150) / (FONT_PX * 1.32))) }
  }

  const start = async (c: number, t: TargetVM) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await openTermSession({ mode: 'new', target: t.key, label: t.label, ...gridFor() })
      seedTerminal(qc, r)
      setPicker(null)
      if (r.name) place(r.name, c)
    } catch (e) {
      toast(`Could not start ${t.label}: ${errText(e)}`, { ms: 5000 })
    } finally {
      setBusy(false)
    }
  }

  // ---------- keys: here, and handed up by a terminal (DeskHost.key) ----------

  const onChord = useCallback((chord: DeskChord, from?: number) => {
    const { columns: cols, actives: acts, n: count, fc: f } = tabsRef.current
    const c = Math.min(from ?? f, count - 1)
    const col = cols[c] ?? []
    const cur = acts[c]
    if (chord === 'next' || chord === 'prev') {
      if (!col.length) return
      const i = Math.max(0, col.findIndex((s) => s.name === cur?.name))
      openTab(c, col[(i + (chord === 'next' ? 1 : -1) + col.length) % col.length].name)
    } else if (chord === 'left' || chord === 'right') {
      const to = Math.max(0, Math.min(count - 1, c + (chord === 'right' ? 1 : -1)))
      const a = acts[to]
      setFocusCol(to)
      if (a) openTab(to, a.name)
    } else if (chord === 'done') {
      // finished and not seen yet, or asking: the one that has waited longest first
      const all = cols.flatMap((cc, i) => cc.map((s) => ({ s, c: i })))
      const waiting = all
        .filter(({ s }) => unseenDone(s.name) || paneState(s) === 'asking')
        .sort((a, b) => (doneAt(a.s.name) || a.s.stateSince || 0) - (doneAt(b.s.name) || b.s.stateSince || 0))
      const next = waiting.find(({ s, c: i }) => !(i === c && s.name === cur?.name)) ?? null
      if (next) openTab(next.c, next.s.name)
      else toast('No session is waiting for you')
    } else {
      const k = Number(chord.slice(3)) - 1
      if (col[k]) openTab(c, col[k].name)
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

  // What the terminal in a tab asks for (lib/embed.ts DeskHost).
  const colOfFrame = (from: Window): { name: string; c: number } | null => {
    for (const [name, el] of frames.current) {
      if (el.contentWindow !== from) continue
      const { columns: cols } = tabsRef.current
      const c = cols.findIndex((col) => col.some((s) => s.name === name))
      return { name, c: Math.max(0, c) }
    }
    return null
  }
  const colOfFrameRef = useRef(colOfFrame)
  useLayoutEffect(() => { colOfFrameRef.current = colOfFrame })
  useEffect(() => {
    const host: DeskHost = {
      open: (name, from) => {
        const at = colOfFrameRef.current(from)
        const { columns: cols } = tabsRef.current
        const here = cols.findIndex((col) => col.some((s) => s.name === name))
        if (here >= 0) openTab(here, name)
        else place(name, at?.c ?? 0)
      },
      close: (from) => {
        const at = colOfFrameRef.current(from)
        if (at) closeTab(at.name)
      },
      key: (chord, from) => onChord(chord, colOfFrameRef.current(from)?.c),
      shown: (from) => {
        const at = colOfFrameRef.current(from)
        return !!at && shownRef.current.has(at.name)
      },
    }
    const w = window as Window & { valkyrieDesk?: DeskHost }
    w.valkyrieDesk = host
    return () => { if (w.valkyrieDesk === host) delete w.valkyrieDesk }
  }, [openTab, place, closeTab, onChord])

  // a strip that scrolls sideways (the phone, a crowded column) keeps its active tab in view: when it
  // changes, and when the tabs before it change width (titles from the board, a late webfont)
  const titleKey = columns.map((col) => col.map((s) => s.title || termLabel(s, titles)).join('\n')).join('\t')
  useLayoutEffect(() => {
    const keep = () => stripEls.current.forEach((row, c) => {
      const a = tabsRef.current.actives[c]
      const el = a ? row.querySelector<HTMLElement>(`[data-name="${a.name}"]`) : null
      if (!el) return
      const l = el.offsetLeft
      const r = l + el.offsetWidth
      if (l < row.scrollLeft) row.scrollLeft = Math.max(0, l - 8)
      else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 8
    })
    keep()
    let live = true
    void document.fonts?.ready.then(() => { if (live) keep() })
    return () => { live = false }
  }, [activeKey, n, titleKey])

  // ---------- drag a tab to another strip (a mouse) ----------

  const [dropCol, setDropCol] = useState<number | null>(null)
  const dragOver = (c: number) => (e: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes(PANE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropCol !== c) setDropCol(c)
  }
  const drop = (c: number) => (e: ReactDragEvent<HTMLDivElement>) => {
    const name = e.dataTransfer.getData(PANE_MIME)
    setDropCol(null)
    if (!name || !tabNames.has(name)) return
    e.preventDefault()
    const over = (e.target as HTMLElement).closest<HTMLElement>('.dk-tab')?.dataset.name ?? null
    place(name, c, over && over !== name ? over : null)
  }

  // ---------- render ----------

  const loaded = !!steadyList || list.length > 0
  const empty = loaded && !tabs.length
  const menuTab = menu ? tabs.find((x) => x.name === menu.name) ?? null : null
  const offDesk = list.filter((s) => L.off.includes(s.name))
  const vars: Vars = { '--n': n, '--dk-gap': `${GAP}px` }

  const tooltip = (s: TermSession, title: string) => {
    const st = paneState(s)
    const area = areaName(areaOf(s))
    const word = st === 'idle' && unseenDone(s.name) ? 'done' : WORD[st]
    const since = s.stateSince && st !== 'dead' ? ` for ${ago(s.stateSince, now)}` : ''
    const lines = [title, [area, `${word}${since}`].filter(Boolean).join(' · ')]
    if (st === 'asking' && s.ask) lines.push(s.ask)
    return lines.join('\n')
  }

  return (
    <div ref={rootRef} className="dk" style={vars} data-cols={n} data-coarse={coarse || undefined}>
      {/* an empty Desk on the phone has no strip: nothing to switch, and no column control there */}
      {!(empty && phone) && <div className="dk-strips">
        {columns.map((col, c) => (
          <div
            key={c}
            className="dk-strip"
            data-col={c}
            data-focus={(n > 1 && fc === c) || undefined}
            data-drop={dropCol === c || undefined}
            onPointerDown={() => setFocusCol(c)}
            onDragOver={dragOver(c)}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropCol(null) }}
            onDrop={drop(c)}
          >
            {/* the tabs scroll sideways when they do not fit; "+" and the column control stay in view after them */}
            <div
              ref={(el) => { if (el) stripEls.current.set(c, el); else stripEls.current.delete(c) }}
              className="dk-tabs"
              role="tablist"
              aria-label={n > 1 ? `Column ${c + 1}` : 'Sessions'}
            >
              {col.map((s) => (
                <Tab
                  key={s.name}
                  s={s}
                  title={s.title || termLabel(s, titles)}
                  tip={tooltip}
                  on={actives[c]?.name === s.name}
                  coarse={coarse}
                  draggable={!coarse && (n > 1 || col.length > 1)}
                  onOpen={(el) => {
                    if (actives[c]?.name === s.name && coarse) openMenu(s.name, c, el)
                    else openTab(c, s.name)
                  }}
                  onMenu={(el) => openMenu(s.name, c, el)}
                  onClose={() => closeTab(s.name)}
                />
              ))}
            </div>
            {/* an empty Desk has one way to start: the line under the strip */}
            {!empty && <Press
              className="dk-add"
              aria-label="New tab"
              title="New tab: start a session or put one back"
              aria-expanded={picker === c}
              onPress={() => { setMenu(null); setPicker((p) => (p === c ? null : c)) }}
            >
              <Icon name="add" size={coarse ? 18 : 15} tone={picker === c ? 'fg' : 'dim'} glow={picker === c} />
            </Press>}
            {!phone && c === n - 1 && (
              <div className="dk-ncols" role="group" aria-label="Columns">
                {([1, 2, 3] as const).map((v) => (
                  <Press
                    key={v}
                    className="dk-ncol"
                    data-on={n === v || undefined}
                    aria-pressed={n === v}
                    aria-label={`${v} ${v === 1 ? 'column' : 'columns'}`}
                    title={`${v} ${v === 1 ? 'column' : 'columns'}`}
                    onPress={() => editLayout((l) => { l.cols = v })}
                  >
                    {v}
                  </Press>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>}

      <div ref={stageRef} className="dk-stage">
        {/* the terminals, one layer for every column, so moving a tab or changing the column count never reloads one */}
        {mountedSorted.map((name) => {
          const s = tabs.find((x) => x.name === name)
          if (!s) return null
          const c = colOf(s)
          const on = actives[c]?.name === name
          return (
            <iframe
              key={name}
              ref={(el) => { if (el) frames.current.set(name, el); else frames.current.delete(name) }}
              className="dk-frame"
              data-name={name}
              data-on={on || undefined}
              style={{ '--c': c } as Vars}
              title={s.title || termLabel(s, titles)}
              src={`/m/w/term/${encodeURIComponent(name)}`}
              inert={!on || undefined}
              onLoad={() => { if (focusRef.current === name && on) focusFrame(name) }}
              onFocus={() => setFocusCol(c)}
            />
          )
        })}

        {columns.map((col, c) => (
          <div key={c} className="dk-cell" style={{ '--c': c } as Vars} data-col={c}>
            {!loaded && c === 0 && (
              <p className="dk-quiet">{panes.isError ? `Could not read the sessions: ${errText(panes.error)}` : 'Reading sessions'}</p>
            )}
            {empty && c === 0 && (
              <div className="dk-empty">
                {/* every pane can be off the Desk while it runs: then "+" puts them back */}
                <p>{list.length ? `${list.length} running, none on the Desk.` : 'No session is open.'}</p>
                <Press className="dk-start" aria-expanded={picker === 0} onPress={() => { setMenu(null); setPicker((p) => (p === 0 ? null : 0)) }}>
                  <Icon name="add" size={14} tone="fg" glow />
                  <span>{list.length ? 'New tab' : 'New session'}</span>
                </Press>
              </div>
            )}
            {loaded && tabs.length > 0 && !col.length && (
              <p className="dk-quiet">{coarse ? 'No tabs here. Move one with its menu, or start one with +.' : 'No tabs here. Drag one over, or start one with +.'}</p>
            )}

            {menu && menu.col === c && menuTab && (
              <TabMenu
                title={menuTab.title || termLabel(menuTab, titles)}
                live={!menuTab.dead}
                left={c > 0}
                right={c < n - 1}
                x={Math.min(menu.x, Math.max(0, (box.w - (n - 1) * GAP) / n - 210))}
                arm={menu.arm}
                onMove={(d) => { setMenu(null); place(menuTab.name, c + d) }}
                onCloseTab={() => closeTab(menuTab.name)}
                onStop={() => { if (!menu.arm) setMenu({ ...menu, arm: true }); else void stop(menuTab.name) }}
                onDismiss={() => setMenu(null)}
              />
            )}

            {picker === c && (
              <NewTab
                wide={!phone}
                busy={busy}
                targets={targets}
                off={offDesk}
                titles={titles}
                onStart={(t) => void start(c, t)}
                onPutBack={(name) => { setPicker(null); place(name, c) }}
                onClose={() => setPicker(null)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- a tab ----------

function Tab({ s, title, tip, on, coarse, draggable, onOpen, onMenu, onClose }: {
  s: TermSession
  title: string
  tip: (s: TermSession, title: string) => string
  on: boolean
  coarse: boolean
  draggable: boolean
  onOpen: (el: HTMLElement | null) => void
  onMenu: (el: HTMLElement | null) => void
  onClose: () => void
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
      data-state={st}
      data-lit={lit || undefined}
      title={tip(s, title)}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_MIME, s.name)
        e.dataTransfer.effectAllowed = 'move'
      }}
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
      <Press className="dk-tab-x" aria-label={`Close the ${title} tab`} title="Close tab (the session keeps running)" tabIndex={on ? 0 : -1} onPress={onClose}>
        <Icon name="stop" size={coarse ? 14 : 12} tone="dim" />
      </Press>
    </div>
  )
}

// ---------- a tab's menu: move it, close it, stop its session ----------

function TabMenu({ title, live, left, right, x, arm, onMove, onCloseTab, onStop, onDismiss }: {
  title: string
  live: boolean
  left: boolean
  right: boolean
  x: number
  /** Stop was pressed once: the next press stops the session */
  arm: boolean
  onMove: (d: -1 | 1) => void
  onCloseTab: () => void
  onStop: () => void
  onDismiss: () => void
}) {
  return (
    <>
      <div className="dk-scrim" onPointerDown={onDismiss} />
      <div className="dk-menu" role="menu" aria-label={`${title}: tab`} style={{ left: x }}>
        {left && <Press role="menuitem" className="dk-mi" onPress={() => onMove(-1)}>Move left</Press>}
        {right && <Press role="menuitem" className="dk-mi" onPress={() => onMove(1)}>Move right</Press>}
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

// ---------- "+": a new session in this column, or a running one put back ----------

function NewTab({ wide, busy, targets, off, titles, onStart, onPutBack, onClose }: {
  wide: boolean
  busy: boolean
  targets: ReturnType<typeof useLaunchTargets>
  off: TermSession[]
  titles: Map<string, string>
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
    <div className="dk-pick" role="dialog" aria-label="New tab">
      <div className="dk-pick-head">
        <h2>New tab</h2>
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
        <h3 className="dk-k">Running sessions <span className="dk-n">{off.length}</span></h3>
        {!off.length && <p className="dk-quiet-row">Every running session is on the Desk.</p>}
        <div className="dk-rows">
          {off.map((s) => {
            const st = paneState(s)
            const mark = markOf(st)
            return (
              <Press key={s.name} className="dk-row" onPress={() => onPutBack(s.name)}>
                {mark ? <StateIcon a={mark} size={14} /> : <span className="dk-row-nomark" aria-hidden />}
                <span className={cx('dk-row-t', st === 'dead' && 'dk-row-dead')}>{s.title || termLabel(s, titles)}</span>
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
 * screen (the Messages badge's look); in the asking tone while one of them
 * asks him something.
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
