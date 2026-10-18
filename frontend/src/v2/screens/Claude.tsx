import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { useIntent, useShell, type ScreenProps } from '../kit/shell'
import { Bar, Press, Segmented, cx, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import {
  ago, useHosts, useLaunchTargets, useLive, useSessionIndex, useSessions, useTick, useUsage,
  type Live, type ProjectVM, type SessionIndex, type SessionVM, type TargetVM,
} from '../kit/data'
import { animateSpring, useReducedMotion } from '../kit/motion'
import {
  api, apiErrorText, fetchSessionHosts, fetchSessionList, fetchTermSessions, launchSessionOnHost, localHostname,
  openNewSessionHere, openSessionHere, openTermSession, setSessionsDone, startSessionOnHost, stopSessionOnHost,
  termPath, type LaunchTarget, type SessionHost, type TermSession,
} from '../../lib/api'
import { BASE_AREAS, fetchProjDoc, fetchProjList, projAreasQuery } from '../../lib/projectsApi'
import { shortName } from '../../lib/quickSessions'
import { readOpenMode, seedTerminal } from '../../lib/sessionLaunch'
import './claude.css'

// AI (Claude.tsx, the /m/ai tab): the session board, Valkyrie Projects and Usage
// (every account's 5h and week windows, /m/ai/usage) in the red HUD language:
// thin outlined panels with a dark fill, line icons leading every header, row
// and action, lit plates for the selected and primary things, and glow only on
// what is lit (working, asking, selected). Every write is the session board's
// own (components/SessionBoard.tsx): open, new, stop, done and recover desk go
// to the same routes by the same rules. Done and Stop show at once and roll
// back with an error toast when the host refuses.
//
// New session from outside the screen: dispatch `window` event
// 'v2-new-session' (opens AI > Sessions and the target picker), send the
// shell intent 'claude:new-session', or open /m/ai/sessions?new=1 (the param
// is removed once the picker opens).
//
// The picker offers three places: thor in the page (the default, a tmux pane
// on odin running Claude on thor over SSH), thor's own screen (Windows Terminal
// on thor's desk, so the session lives on thor and survives a dropped
// connection), and odin (Claude on odin itself, the backup when thor is down).

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

const HOME_HOST = 'thor'
/** The backup host: its panes run Claude on odin itself (backend terminal/tmux.ts, host 'odin'). */
const BACKUP_HOST = 'odin'
// The picker's busy keys for thor's screen and for odin, beside `${host}:${target}`
// for the rest. '@' never starts a host name, so no key can collide.
const SCREEN_SLOT = '@screen'
const ODIN_SLOT = '@odin'

// ---------- areas ----------

// Area ids and their order come from the data (GET /proj-areas, display order;
// the client areas are odin's private config), names are the id capitalized.
const areaName = (a: string) => (a ? a[0].toUpperCase() + a.slice(1) : 'Other')
const areaRank = (a: string, order: readonly string[]) => {
  const i = order.indexOf(a)
  return i < 0 ? 99 : i
}
/** personal work is home, server work is odin's box, client work is a project folder */
const areaIcon = (a: string): IconName => (a === 'personal' ? 'home' : a === 'server' ? 'odin' : 'projects')

type AreaItem = { id: string; label: string; count: number }

function areaItems(values: string[], order: readonly string[]): AreaItem[] {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  const list = [...counts.entries()]
    .sort((a, b) => areaRank(a[0], order) - areaRank(b[0], order) || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: areaName(id), count }))
  return [{ id: 'all', label: 'All', count: values.length }, ...list]
}

// ---------- small helpers ----------

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const f = () => setM(mq.matches)
    f()
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [query])
  return m
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
/** "2:00 AM" today, "Sun 9:00 AM" within a week, else "Oct 24 9:00 AM" */
const dayClock = (ms: number, now = Date.now()) => {
  const d = new Date(ms)
  if (d.toDateString() === new Date(now).toDateString()) return clock(ms)
  if (Math.abs(ms - now) < 6.5 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(ms)}`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(ms)}`
}
const shortDate = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'date unknown')
/** "in 3h", "in 20m", "due now" */
const until = (ms: number, now: number) => {
  const d = ms - now
  if (d < 60_000) return 'due now'
  if (d < 3_600_000) return `in ${Math.round(d / 60_000)}m`
  if (d < 86_400_000) return `in ${Math.round(d / 3_600_000)}h`
  return `in ${Math.round(d / 86_400_000)}d`
}

const ACTIVITY_RANK: Record<SessionVM['activity'], number> = { asking: 0, working: 1, idle: 2, closed: 3 }
const STATE_WORD: Record<SessionVM['activity'], string> = { working: 'working', asking: 'asking', idle: 'idle', closed: 'open' }
// working and asking are lit (glow); idle is dim and closed faint, no glow
const STATE_ICON: Record<SessionVM['activity'], { name: IconName; tone: IconTone; glow: boolean }> = {
  working: { name: 'working', tone: 'fg', glow: true },
  asking: { name: 'asking', tone: 'acc2', glow: true },
  idle: { name: 'idle', tone: 'dim', glow: false },
  closed: { name: 'claude', tone: 'faint', glow: false },
}
const isLive = (s: Pick<SessionVM, 'live' | 'activity'>) => s.live || s.activity !== 'closed'

/** Clipboard write with the execCommand fallback (plain http on the phone has no navigator.clipboard). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

// ---------- writes: the session board's actions, by its rules ----------

const errText = (e: unknown) => apiErrorText(e, (e as Error | null)?.message || 'no reply')
const httpStatus = (e: unknown): number | null => (e as { response?: { status?: number } } | null)?.response?.status ?? null
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** What a row is waiting on while its write is in flight. */
type Busy = 'open' | 'stop' | 'done'

/** Where "open" and "new" put a session. */
type Where = { inPage: boolean; remote: boolean }

/**
 * The session board's rules: a browser (the phone) opens the in-page terminal;
 * the desktop app follows the board's in page / on screen toggle, and off thor
 * it opens the terminal itself over SSH.
 */
function useWhere(): Where {
  const [here, setHere] = useState<string | null>(null)
  useEffect(() => { void localHostname().then(setHere) }, [])
  return { inPage: readOpenMode() === 'page', remote: here !== null && here !== HOME_HOST }
}

// In-page terminals (tmux panes on odin running Claude on thor). Same key and
// shape as the board and the terminal page, so the cache entry is shared.
const TERMS_KEY = ['term', 'sessions']
const paneFor = (terms: TermSession[] | undefined, id: string): string | null =>
  terms?.find((t) => !t.dead && (t.sessionId === id || (t.mode === 'resume' && t.target === id)))?.name ?? null

/** The pane list right before an open: a second resume of a conversation already in a pane is a second Claude on one transcript. */
async function freshPanes(qc: QueryClient): Promise<TermSession[]> {
  try {
    return await qc.fetchQuery({ queryKey: TERMS_KEY, queryFn: fetchTermSessions, staleTime: 5_000 })
  } catch {
    return qc.getQueryData<TermSession[]>(TERMS_KEY) ?? []
  }
}

/** launchSessionOnHost folds a missing or failing launcher into ok:false; here that is a failure like any other. */
async function launchOn(id: string, host: string): Promise<void> {
  const r = await launchSessionOnHost(id, '', host)
  if (!r.ok) throw new Error(r.detail ?? `${host} launcher unavailable (${r.status})`)
}

/**
 * Each session's Windows Terminal window, for the desktop app off thor (it opens
 * the window itself). The v2 view model does not carry it, so this reads the
 * board's own query, cached under the board's key.
 */
async function launchGroups(qc: QueryClient): Promise<Map<string, string | null>> {
  try {
    const r = await qc.fetchQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, staleTime: 60_000 })
    return new Map(r.installed ? r.sessions.map((s) => [s.sessionId, s.launchGroup] as const) : [])
  } catch {
    return new Map()
  }
}

// One disposition write at a time, and one call per host for the whole
// selection: the host rewrites its disposition file whole, so two writes in
// flight at once lose one of them.
let dispoChain: Promise<unknown> = Promise.resolve()

/** Marks rows done (or open again). Returns the ids that did not take and the first error. */
function sendDone(rows: SessionVM[], done: boolean): Promise<{ failed: string[]; error: unknown }> {
  const run = async () => {
    const byHost = new Map<string, string[]>()
    for (const s of rows) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s.id])
    const failed: string[] = []
    let error: unknown = null
    for (const [host, ids] of byHost) {
      try {
        const r = await setSessionsDone(ids, done, host)
        if (r && r.ok === false) throw new Error(r.detail ?? `${host} refused`)
      } catch (e) {
        failed.push(...ids)
        error ??= e
      }
    }
    return { failed, error }
  }
  const p = dispoChain.then(run, run)
  dispoChain = p
  return p
}

/** The phone terminal's first-frame grid (useProjectTerm); the page fits the real one once it connects. */
const phoneGrid = () => ({
  cols: Math.max(24, Math.floor(window.innerWidth / (12 * 0.6))),
  rows: Math.max(10, Math.floor((window.innerHeight - 120) / (12 * 1.32))),
})

// ---------- projects with their links (ProjectVM has no session ids or reminder) ----------

type ProjRow = ProjectVM & { sessionIds: string[]; nextReminderAt: number | null }
const PROJ_KEY = 'claude.projects'

function useProjectRows(): Live<ProjRow[]> {
  return useLive<ProjRow[]>(PROJ_KEY, async () => (await fetchProjList()).map((p): ProjRow => {
    const rem = p.nextReminderAt ? Date.parse(p.nextReminderAt) : NaN
    return {
      id: p.id,
      name: p.name,
      area: String(p.area),
      status: String(p.status),
      summary: p.summary,
      nextAction: p.nextAction,
      sessions: p.sessionIds.length,
      updated: Date.parse(p.updatedAt),
      sessionIds: p.sessionIds,
      nextReminderAt: Number.isFinite(rem) ? rem : null,
    }
  }).sort((a, b) => b.updated - a.updated), 60_000)
}

type Lookup = (id: string) => SessionVM | undefined
type Counted = ProjRow & { live: number; asking: number }

function countProject(p: ProjRow, lookup: Lookup): Counted {
  let live = 0
  let asking = 0
  for (const id of p.sessionIds) {
    const s = lookup(id)
    if (!s) continue
    if (isLive(s)) live += 1
    if (s.activity === 'asking') asking += 1
  }
  return { ...p, live, asking }
}

// a session waiting on Brendon outranks one that is merely running
const urgency = (p: Counted) => (p.asking > 0 ? 2 : p.live > 0 ? 1 : 0)
const byUrgency = (a: Counted, b: Counted) => urgency(b) - urgency(a) || b.updated - a.updated

// ---------- the screen ----------

type UndoItem = { key: number; rows: SessionVM[]; title: string; pending: boolean }
type Tab = 'sessions' | 'projects' | 'usage'
type Recover = { done: number; total: number }
const RECENT_SHOWN = 8

export default function Claude({ active, sub, setSub }: ScreenProps) {
  const sessions = useSessions()
  const index = useSessionIndex()
  const projects = useProjectRows()
  const hosts = useHosts()
  const now = useTick(active ? 1000 : 60_000)
  const wide = useMedia('(min-width: 640px)')
  const short = useMedia('(min-width: 640px) and (max-height: 480px)')
  const desk = useMedia('(min-width: 1200px)')
  const tab: Tab = sub === 'projects' || sub === 'usage' ? sub : 'sessions'

  const [area, setArea] = useState('all')
  const [picker, setPicker] = useState(false)
  const [projId, setProjId] = useState<string | null>(null)
  // optimistic writes over the board until a fetch agrees: done (true) or open
  // again (false) by id, and stopped sessions with the time the stop landed
  const [dispo, setDispo] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [stopped, setStopped] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [busy, setBusy] = useState<ReadonlyMap<string, Busy>>(() => new Map())
  const busyRef = useRef(new Map<string, Busy>())
  const [recover, setRecover] = useState<Recover | null>(null)
  const recovering = useRef(false)
  const [starting, setStarting] = useState<string | null>(null)
  const startingRef = useRef(false)
  // a refused start, shown in the picker too: the sheet's backdrop covers the toasts
  const [startErr, setStartErr] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [expRow, setExpRow] = useState<string | null>(null)
  const [recentAll, setRecentAll] = useState(false)
  const [undo, setUndo] = useState<UndoItem | null>(null)

  // sheets and open rows belong to the active tab only
  useEffect(() => {
    if (active) return
    setPicker(false)
    setOpenRow(null)
  }, [active])
  useEffect(() => {
    setOpenRow(null)
    setExpRow(null)
  }, [tab, area])

  // New session from anywhere: the 'v2-new-session' window event (a Dashboard
  // quick action) flies to AI > Sessions and opens the picker; so does ?new=1.
  const { go } = useShell()
  const goRef = useRef(go)
  goRef.current = go
  useEffect(() => {
    const open = () => {
      goRef.current('ai', 'sessions')
      setPicker(true)
    }
    window.addEventListener('v2-new-session', open)
    return () => window.removeEventListener('v2-new-session', open)
  }, [])
  useIntent('claude:new-session', () => setPicker(true))
  const loc = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (!active) return
    const q = new URLSearchParams(loc.search)
    if (q.get('new') !== '1') return
    setPicker(true)
    q.delete('new')
    const rest = q.toString()
    navigate({ pathname: loc.pathname, search: rest ? `?${rest}` : '' }, { replace: true })
  }, [active, loc.search, loc.pathname, navigate])

  const hostLabel = useMemo(() => {
    const m = new Map((hosts.data ?? []).map((h) => [h.id, h.label]))
    return (id: string) => m.get(id) ?? id
  }, [hosts.data])

  const qc = useQueryClient()
  const where = useWhere()
  const panes = useQuery({ queryKey: TERMS_KEY, queryFn: fetchTermSessions, refetchInterval: active ? 15_000 : false })
  const paneOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of panes.data ?? []) {
      const id = t.sessionId || (t.mode === 'resume' ? t.target : '')
      if (id && !t.dead) m.set(id, t.name)
    }
    return (id: string) => m.get(id) ?? null
  }, [panes.data])

  // Every open session: the in-memory index of the whole board once this page
  // load has fetched it (no 40-row cap), the persisted 40 newest until then.
  // A done or undo still in flight (or not yet on the board) overrides it.
  const source = useMemo<SessionVM[] | undefined>(() => {
    if (index.ready) return [...index.byId.values()].filter((s) => !(dispo.get(s.id) ?? s.done)).sort((a, b) => b.last - a.last)
    return sessions.data?.filter((s) => !dispo.get(s.id))
  }, [index.ready, index.byId, sessions.data, dispo])
  const hasBoard = source !== undefined

  // the board with stops that have not reached it yet
  const board = useMemo(() => (source ?? [])
    .map((s): SessionVM => (stopped.has(s.id) ? { ...s, activity: 'closed', live: false } : s)), [source, stopped])

  // drop an override once a fetch agrees with it (never while its write is in flight)
  useEffect(() => {
    if (!index.ready) return
    setDispo((m) => {
      let n: Map<string, boolean> | null = null
      for (const [id, done] of m) {
        if (busyRef.current.has(id)) continue
        if (index.byId.get(id)?.done === done) (n ??= new Map(m)).delete(id)
      }
      return n ?? m
    })
  }, [index.ready, index.byId])
  // a stop shows until the board says closed, for a minute at most
  useEffect(() => {
    setStopped((m) => {
      if (!m.size) return m
      let n: Map<string, number> | null = null
      for (const [id, at] of m) {
        if (busyRef.current.get(id) === 'stop') continue
        const s = source?.find((x) => x.id === id)
        if (!s || !isLive(s) || now - at > 60_000) (n ??= new Map(m)).delete(id)
      }
      return n ?? m
    })
  }, [source, now])
  const live = board.filter(isLive).length
  const asking = board.filter((s) => s.activity === 'asking').length

  // any session by id: the index first (done ones too), then the open board
  const lookup = useMemo<Lookup>(() => {
    const open = new Map(board.map((s) => [s.id, s]))
    return (id) => open.get(id) ?? (index.ready ? index.byId.get(id) : undefined)
  }, [board, index.ready, index.byId])

  const projList = useMemo(() => (projects.data ?? []).map((p) => countProject(p, lookup)), [projects.data, lookup])
  const projAsking = useMemo(() => {
    const ids = new Set<string>()
    for (const p of projects.data ?? []) for (const id of p.sessionIds) if (lookup(id)?.activity === 'asking') ids.add(id)
    return ids.size
  }, [projects.data, lookup])
  const nextReminder = useMemo(() => {
    let best: Counted | null = null
    for (const p of projList) if (p.nextReminderAt != null && (!best || p.nextReminderAt < (best.nextReminderAt ?? Infinity))) best = p
    return best
  }, [projList])

  const areaOrder = useQuery(projAreasQuery).data ?? BASE_AREAS
  const areas = useMemo(
    () => areaItems(tab === 'sessions' ? board.map((s) => s.area) : projList.map((p) => p.area), areaOrder),
    [tab, board, projList, areaOrder],
  )
  // a filter that empties out (the last session of an area marked done) falls back to All
  const shownArea = areas.some((a) => a.id === area) ? area : 'all'
  const pickArea = (id: string) => setArea((cur) => (cur === id && id !== 'all' ? 'all' : id))
  // never show "All 0" before the first data
  const showFilter = tab === 'sessions' ? hasBoard : !!projects.data

  // ---- FLIP: rows glide instead of jumping (done, stop, expand, show more) ----
  const rowEls = useRef(new Map<string, HTMLElement>())
  const flipFrom = useRef<Map<string, number> | null>(null)
  const reduced = useReducedMotion()
  const captureFlip = useCallback(() => {
    const m = new Map<string, number>()
    rowEls.current.forEach((el, id) => m.set(id, el.getBoundingClientRect().top))
    flipFrom.current = m
  }, [])
  useLayoutEffect(() => {
    const from = flipFrom.current
    if (!from) return
    flipFrom.current = null
    if (reduced) return
    rowEls.current.forEach((el, id) => {
      const a = from.get(id)
      if (a === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' })
        return
      }
      const d = a - el.getBoundingClientRect().top
      if (Math.abs(d) < 1) return
      el.animate([{ transform: `translate3d(0, ${d}px, 0)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.22,.8,.24,1)' })
    })
  })

  // ---- writes ----
  const setRowBusy = (ids: string[], b: Busy | null) => {
    for (const id of ids) {
      if (b) busyRef.current.set(id, b)
      else busyRef.current.delete(id)
    }
    setBusy(new Map(busyRef.current))
  }
  const setDispoFor = (ids: string[], done: boolean) => setDispo((m) => {
    const n = new Map(m)
    for (const id of ids) n.set(id, done)
    return n
  })
  const refreshBoard = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }
  const nameOf = (s: SessionVM) => `"${s.title || s.project || 'untitled'}"`

  // Done hides the rows at once and offers Undo; a refusal brings them back.
  const markDone = (rows: SessionVM[]) => {
    const list = rows.filter((s) => !busyRef.current.has(s.id))
    if (!list.length) return
    const ids = list.map((s) => s.id)
    const title = list.length === 1 ? nameOf(list[0]) : `${list.length} sessions`
    captureFlip()
    setOpenRow(null)
    setExpRow(null)
    setDispoFor(ids, true)
    setRowBusy(ids, 'done')
    const key = Date.now()
    setUndo({ key, rows: list, title, pending: true })
    void sendDone(list, true).then(({ failed, error }) => {
      setRowBusy(ids, null)
      if (failed.length) {
        captureFlip()
        setDispoFor(failed, false)
        toast(`Could not mark ${title} done: ${errText(error)}`, { ms: 5000 })
      }
      const kept = list.filter((s) => !failed.includes(s.id))
      setUndo((u) => (u?.key !== key ? u : kept.length ? { ...u, rows: kept, pending: false } : null))
      refreshBoard()
    })
  }
  const undoDone = () => {
    if (!undo || undo.pending) return
    const { rows, title } = undo
    const ids = rows.map((s) => s.id)
    if (ids.some((id) => busyRef.current.has(id))) return
    captureFlip()
    setDispoFor(ids, false)
    setRowBusy(ids, 'done')
    setUndo(null)
    void sendDone(rows, false).then(({ failed, error }) => {
      setRowBusy(ids, null)
      if (failed.length) {
        captureFlip()
        setDispoFor(failed, true)
        toast(`Could not put ${title} back: ${errText(error)}`, { ms: 5000 })
      }
      refreshBoard()
    })
  }

  // Stop closes the row at once; a refusal brings it back. 404 means nothing
  // runs under that id any more: it exited before the board noticed.
  const stop = (s: SessionVM) => {
    if (busyRef.current.has(s.id)) return
    const title = nameOf(s)
    captureFlip()
    setOpenRow(null)
    setExpRow(null)
    setRowBusy([s.id], 'stop')
    setStopped((m) => new Map(m).set(s.id, Date.now()))
    void stopSessionOnHost(s.id, s.host)
      .then((r) => {
        if (r && r.ok === false) throw new Error(r.detail ?? `${s.host} refused`)
        setStopped((m) => new Map(m).set(s.id, Date.now()))
        toast(`Stopped ${title}`)
      })
      .catch((e: unknown) => {
        if (httpStatus(e) === 404) {
          toast(`${title} was not running`)
          return
        }
        captureFlip()
        setStopped((m) => {
          const n = new Map(m)
          n.delete(s.id)
          return n
        })
        toast(`Could not stop ${title}: ${errText(e)}`, { ms: 5000 })
      })
      .finally(() => {
        setRowBusy([s.id], null)
        refreshBoard()
        void qc.invalidateQueries({ queryKey: TERMS_KEY })
      })
  }

  // Open, the board's way: back into its pane if one runs it, never a second
  // Claude on a running session, otherwise resume on the machine that holds
  // the transcript (in the page, here over SSH, or on the host's screen).
  const openSession = async (s: SessionVM) => {
    if (busyRef.current.has(s.id)) return
    const title = nameOf(s)
    setRowBusy([s.id], 'open')
    try {
      const pane = paneFor(await freshPanes(qc), s.id)
      if (pane) {
        navigate(termPath(pane))
        return
      }
      if (s.live) {
        toast(`${title} is running on ${hostLabel(s.host)}. Stop it to open it here.`, { ms: 4000 })
        return
      }
      if (s.host !== HOME_HOST) {
        await launchOn(s.id, s.host)
        toast(`Opened ${title} on ${hostLabel(s.host)}`)
      } else if (where.inPage) {
        const r = await openTermSession({ mode: 'resume', sessionId: s.id, label: s.title })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
      } else if (where.remote) {
        await openSessionHere(s.id, undefined, (await launchGroups(qc)).get(s.id) ?? null)
        toast(`Opened ${title} here`)
      } else {
        await launchOn(s.id, HOME_HOST)
        toast(`Opened ${title} on ${hostLabel(HOME_HOST)}`)
      }
    } catch (e) {
      toast(`Could not open ${title}: ${errText(e)}`, { ms: 5000 })
    } finally {
      setRowBusy([s.id], null)
      refreshBoard()
    }
  }

  // Recover desk: reopen the open, not running sessions on thor's screen (or
  // here over SSH), one at a time with the launcher's pause, because Windows
  // Terminal drops tabs that arrive together. One failure does not stop the rest.
  const recoverDesk = async (rows: SessionVM[]) => {
    if (recovering.current || !rows.length) return
    recovering.current = true
    setRecover({ done: 0, total: rows.length })
    const groups = where.remote ? await launchGroups(qc) : null
    // one window group at a time, so each window is made once and later tabs join it
    const ordered = groups ? [...rows].sort((a, b) => (groups.get(a.id) ?? '').localeCompare(groups.get(b.id) ?? '')) : rows
    let failed = 0
    let error: unknown = null
    let lastGroup: string | null | undefined
    for (const [n, s] of ordered.entries()) {
      const group = groups?.get(s.id) ?? null
      setRowBusy([s.id], 'open')
      try {
        if (where.remote) await openSessionHere(s.id, undefined, group)
        else await launchOn(s.id, HOME_HOST)
      } catch (e) {
        failed += 1
        error ??= e
      }
      setRowBusy([s.id], null)
      setRecover((r) => r && { ...r, done: r.done + 1 })
      if (n === ordered.length - 1) break
      // a tab that opens a cold window waits longer than one joining a window that is up
      const opensWindow = where.remote && group !== lastGroup
      lastGroup = group
      await sleep(opensWindow ? 3000 : 700)
    }
    recovering.current = false
    setRecover(null)
    refreshBoard()
    const dest = where.remote ? 'here' : `on ${hostLabel(HOME_HOST)}`
    if (failed) toast(`${failed} of ${rows.length} did not reopen ${dest}: ${errText(error)}`, { ms: 5000 })
    else toast(`Reopened ${rows.length} ${dest}`)
  }

  // One start at a time, from any of the picker's places. `slot` is the
  // plate's busy key; a refusal shows in the picker as well as a toast.
  const launch = async (slot: string, fail: string, fn: () => Promise<void>) => {
    if (startingRef.current) return
    startingRef.current = true
    setStarting(slot)
    setStartErr(null)
    try {
      await fn()
    } catch (e) {
      const msg = `${fail}: ${errText(e)}`
      setStartErr(msg)
      toast(msg, { ms: 5000 })
    } finally {
      startingRef.current = false
      setStarting(null)
    }
  }

  // New session, NewSession's rules: in the page where the host can page and
  // the board opens in the page; here over SSH for thor from the desktop app
  // elsewhere; otherwise the host's own agent opens it on its screen.
  const startNew = (t: TargetVM, h: SessionHost) => launch(`${h.host}:${t.key}`, `Could not start ${t.label} on ${hostLabel(h.host)}`, async () => {
    if (where.inPage && h.canPage) {
      const r = await openTermSession({ mode: 'new', target: t.key, label: t.label })
      seedTerminal(qc, r)
      setPicker(false)
      navigate(termPath(r.name))
      return
    }
    if (where.remote && h.host === HOME_HOST) {
      await openNewSessionHere(t.key, undefined, t.group)
      toast(`${t.label} opened here`)
    } else {
      const r = await startSessionOnHost(h.host, t.key)
      if (!r.ok) throw new Error(r.detail ?? 'could not start it')
      toast(`${t.label} started on ${hostLabel(h.host)}`)
    }
    setPicker(false)
    // Claude takes a moment to register, so give the board something to find
    setTimeout(refreshBoard, 2_500)
  })

  // Thor's own screen: Windows Terminal on thor's desk through its launcher
  // agent, so the session lives on thor and a dropped connection cannot end it.
  const startOnScreen = (t: TargetVM) => launch(`${SCREEN_SLOT}:${t.key}`, `Could not open ${t.label} on ${hostLabel(HOME_HOST)}'s screen`, async () => {
    const r = await startSessionOnHost(HOME_HOST, t.key)
    if (!r.ok) throw new Error(r.detail ?? 'could not start it')
    toast(`${t.label} opened on ${hostLabel(HOME_HOST)}'s screen`)
    setPicker(false)
    setTimeout(refreshBoard, 2_500)
  })

  // Odin, the backup: Claude runs on odin itself, in a pane the terminal page
  // attaches to like any other.
  const startOnOdin = (t: TargetVM) => launch(`${ODIN_SLOT}:${t.key}`, `Could not start ${t.label} on ${hostLabel(BACKUP_HOST)}`, async () => {
    const r = await openTermSession({ mode: 'new', host: 'odin', target: t.key, label: t.label, ...phoneGrid() })
    seedTerminal(qc, r)
    setPicker(false)
    navigate(termPath(r.name))
  })
  const toggleRow = useCallback((id: string) => {
    captureFlip()
    setOpenRow(null)
    setExpRow((cur) => (cur === id ? null : id))
  }, [captureFlip])
  const toggleRecent = () => {
    captureFlip()
    setRecentAll((v) => !v)
  }

  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(t)
  }, [undo])

  // desktop shows a third column: a projects glance beside Sessions, the open
  // project beside Projects (the most urgent one until he picks another)
  const areaProjects = useMemo(
    () => (shownArea === 'all' ? projList : projList.filter((p) => p.area === shownArea)).slice().sort(byUrgency),
    [projList, shownArea],
  )
  const picked = projId ? projList.find((p) => p.id === projId) ?? null : null
  const inlineDetail = desk && tab === 'projects'
  const detail = inlineDetail ? (picked && areaProjects.some((p) => p.id === picked.id) ? picked : areaProjects[0] ?? null) : null
  const openProject = (p: ProjectVM) => {
    setProjId(p.id)
    setSub('projects')
  }

  const filter = showFilter && (
    <AreaFilter items={areas} value={shownArea} onChange={pickArea} vertical={wide && !short} />
  )

  return (
    <div className="vc-root">
      {tab === 'usage' ? <UsageView now={now} /> : (
        <div className="vc" data-detail={desk || undefined} data-fab={!wide || undefined}>
          <aside className="vc-side">
            <Summary
              tab={tab}
              hasBoard={hasBoard}
              live={live}
              asking={asking}
              board={sessions}
              projects={projects}
              projCount={projList.length}
              projAsking={projAsking}
              nextReminder={nextReminder}
              now={now}
              onNew={wide ? () => setPicker(true) : undefined}
              onUsage={() => setSub('usage')}
            />
            {!short && filter}
          </aside>

          <main className="vc-main">
            {short && filter && <div className="vc-filter-top">{filter}</div>}
            {tab === 'sessions' ? (
              hasBoard ? (
                <SessionBoard
                  board={board}
                  area={shownArea}
                  now={now}
                  hostLabel={hostLabel}
                  openRow={openRow}
                  setOpenRow={setOpenRow}
                  expRow={expRow}
                  onToggle={toggleRow}
                  recentAll={recentAll}
                  onToggleRecent={toggleRecent}
                  rowEls={rowEls.current}
                  busy={busy}
                  paneOf={paneOf}
                  where={where}
                  recover={recover}
                  onRecover={(rows) => void recoverDesk(rows)}
                  onOpen={(s) => void openSession(s)}
                  onDone={(s) => markDone([s])}
                  onStop={stop}
                />
              ) : (
                <>
                  <div className="vc-empty vl-build" style={iv(4)} data-failed={sessions.failed || undefined}>
                    {sessions.failed ? (
                      <>
                        <b><Icon name="alert" size={15} tone="acc2" glow />Session board did not answer</b>
                        <span>{sessions.error?.message ?? 'no reply'}. Trying again every 15 s.</span>
                      </>
                    ) : (
                      <span><Icon name="thor" size={15} tone="dim" className="vl-pulse" />Reading the board from {hostLabel(HOME_HOST)}</span>
                    )}
                  </div>
                  {!desk && <ProjectGlance list={areaProjects} now={now} onOpen={openProject} />}
                </>
              )
            ) : (
              <ProjectBoard
                list={projList}
                area={shownArea}
                loading={!projects.data}
                failed={projects.failed}
                error={projects.error}
                now={now}
                selected={detail?.id ?? null}
                onOpen={(p) => setProjId(p.id)}
              />
            )}
          </main>

          {desk && (
            <aside className="vc-detail">
              {tab === 'sessions' ? (
                <ProjectGlance list={areaProjects} now={now} onOpen={openProject} />
              ) : detail ? (
                <div className="vc-detail-card vl-panel vl-build-on" key={detail.id}>
                  <div className="vc-detail-head vl-build" style={iv(0)}>
                    <Icon name="projects" size={18} tone="fg" glow />
                    <span className="vc-detail-name">{detail.name}</span>
                  </div>
                  <ProjectDetail p={detail} index={index} lookup={lookup} now={now} hostLabel={hostLabel} showArea />
                </div>
              ) : null}
            </aside>
          )}
        </div>
      )}

      {/* bottom of the page: the undo bar, or (phone) New session in thumb reach */}
      <div className="vc-undo-anchor" aria-live="polite">
        {undo && active ? (
          <div className="vc-undo" key={undo.key}>
            <Icon name="done" size={14} tone="dim" />
            <span className="vc-undo-text">Done: <b>{undo.title}</b></span>
            <Press className="vc-undo-btn" disabled={undo.pending} onPress={undoDone}><Icon name="undo" size={15} tone="hot" />Undo</Press>
          </div>
        ) : !wide && tab !== 'usage' ? (
          <NewButton className="vc-fab" onPress={() => setPicker(true)} />
        ) : null}
      </div>

      <Sheet open={picker && active} onClose={() => { setPicker(false); setStartErr(null) }} label="New session" icon="start">
        <TargetPicker
          area={shownArea}
          hostLabel={hostLabel}
          where={where}
          starting={starting}
          error={startErr}
          onPick={(t, h) => void startNew(t, h)}
          onScreen={(t) => void startOnScreen(t)}
          onOdin={(t) => void startOnOdin(t)}
        />
      </Sheet>

      <Sheet
        open={!inlineDetail && !!picked && active}
        onClose={() => setProjId(null)}
        label={picked?.name ?? ''}
        icon="projects"
        value={picked ? areaName(picked.area) : ''}
      >
        {picked && <ProjectDetail p={picked} index={index} lookup={lookup} now={now} hostLabel={hostLabel} />}
      </Sheet>
    </div>
  )
}

// ---------- header ----------

/** Quiet freshness: "board 12s", or "board unreachable · 4m old" over the last good data. */
function Fresh({ q, label, now }: { q: Live<unknown>; label: string; now: number }) {
  if (q.failed) {
    return (
      <span className="vc-fresh" data-failed title={q.error?.message}>
        <Icon name="offline" size={12} tone="acc2" />
        {q.data !== undefined && q.updatedAt ? `${label} unreachable · ${ago(q.updatedAt, now)} old` : `${label} unreachable`}
      </span>
    )
  }
  if (q.data === undefined) {
    return (
      <span className="vc-fresh" data-busy={q.isFetching || undefined}>
        <Icon name="refresh" size={11} tone="dim" />{q.isFetching ? `reading ${label}` : '--'}
      </span>
    )
  }
  return (
    <span className="vc-fresh" data-busy={q.isFetching || undefined} title={`${label} updated ${ago(q.updatedAt, now)} ago`}>
      <Icon name={q.isFetching ? 'refresh' : 'clock'} size={11} tone={q.isFetching ? 'dim' : 'faint'} />{label} {ago(q.updatedAt, now)}
    </span>
  )
}

/** The primary action: a solid lit plate with the start icon. */
function NewButton({ onPress, className }: { onPress: () => void; className?: string }) {
  return (
    <Press className={cx('vl-btn vc-new', className)} onPress={onPress}>
      <Icon name="start" size={16} tone="ink" />
      New session
    </Press>
  )
}

/**
 * A count in a small outlined plate, led by its icon: lit (glow) while there is
 * something live, alert (acc2 plate) while a session asks, dim at zero.
 */
function StatPlate({ icon, value, label, state, tone = 'fg' }: {
  icon: IconName
  value: number | null
  label: string
  state: 'lit' | 'alert' | 'plain' | 'zero'
  tone?: IconTone
}) {
  const on = state === 'lit' || state === 'alert'
  return (
    <div className="vc-stat vl-panel" data-s={state}>
      <Icon name={icon} size={18} tone={on ? tone : 'dim'} glow={on} />
      <b>{value ?? '--'}</b>
      <span>{label}</span>
    </div>
  )
}

function Summary({ tab, hasBoard, live, asking, board, projects, projCount, projAsking, nextReminder, now, onNew, onUsage }: {
  tab: 'sessions' | 'projects'
  hasBoard: boolean
  live: number
  asking: number
  board: Live<unknown>
  projects: Live<unknown>
  projCount: number
  projAsking: number
  nextReminder: Counted | null
  now: number
  /** wide layouts: New session sits in the header; the phone pins it at the bottom right */
  onNew?: () => void
  /** opens AI > Usage */
  onUsage: () => void
}) {
  const sess = tab === 'sessions'
  const hasProj = projects.data !== undefined
  const navigate = useNavigate()
  return (
    <div className="vc-sum">
      <div className="vc-counts vl-build" style={iv(0)}>
        {sess ? (
          <>
            <StatPlate icon="working" value={hasBoard ? live : null} label="live" state={hasBoard && live > 0 ? 'lit' : 'zero'} />
            <StatPlate icon="asking" tone="acc2" value={hasBoard ? asking : null} label="asking" state={hasBoard && asking > 0 ? 'alert' : 'zero'} />
            <Fresh q={board} label="board" now={now} />
          </>
        ) : (
          <>
            <StatPlate icon="projects" value={hasProj ? projCount : null} label={projCount === 1 ? 'project' : 'projects'} state={hasProj ? 'plain' : 'zero'} />
            <StatPlate icon="asking" tone="acc2" value={hasProj ? projAsking : null} label="asking" state={hasProj && projAsking > 0 ? 'alert' : 'zero'} />
            {projects.failed ? (
              <Fresh q={projects} label="projects" now={now} />
            ) : nextReminder?.nextReminderAt != null ? (
              <span className="vc-fresh vc-rem" title={`${nextReminder.name}: ${dayClock(nextReminder.nextReminderAt, now)}`}>
                <Icon name="timer" size={12} tone="hot" />reminder {until(nextReminder.nextReminderAt, now)}
              </span>
            ) : null}
          </>
        )}
      </div>
      {onNew && <div className="vc-new-row vl-build" style={iv(1)}><NewButton onPress={onNew} /></div>}
      {sess && <UsageLine now={now} onOpen={onUsage} />}
      {/* the terminal skin preview (Skin.tsx, /m/ai/skin): a recorded sample, nothing is sent */}
      {sess && (
        <Press className="vl-link" style={{ alignSelf: 'flex-start' }} onPress={() => navigate('/m/ai/skin')}>
          <Icon name="ai" size={13} tone="dim" />Try the new terminal (preview)
        </Press>
      )}
    </div>
  )
}

/** "6:10 AM" today, "Mon 8:00 PM" this week; null when unknown or past */
const resetAt = (iso: string | null, now: number): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) && t > now ? dayClock(t, now) : null
}
/** at 85% a window is close to its limit: the alert color */
const usageHigh = (v: number | null | undefined) => v != null && v >= 85

/**
 * The account being burned: both windows as two small meters, their resets,
 * and any account that is signed out. A press opens AI > Usage.
 */
function UsageLine({ now, onOpen }: { now: number; onOpen: () => void }) {
  const usage = useUsage()
  const u = usage.data
  const dead = (u?.accounts ?? []).filter((a) => a.dead)
  const high = usageHigh(u?.five) || usageHigh(u?.week)
  const fiveAt = resetAt(u?.fiveResetsAt ?? null, now)
  const weekAt = resetAt(u?.weekResetsAt ?? null, now)
  return (
    <Press
      className="vc-week vl-panel vl-build"
      style={iv(2)}
      onPress={onOpen}
      aria-label={`AI usage${u ? `, ${u.label ?? 'no account'}: 5 hours ${u.five ?? 'unknown'}%, week ${u.week ?? 'unknown'}%` : ''}. Open Usage`}
    >
      <span className="vc-week-head">
        <Icon name="gauge" size={14} tone={high ? 'acc2' : 'dim'} glow={high} />
        <span className="vc-week-label">Usage</span>
        <span className="vc-acct">{u?.label ?? '--'}</span>
        <Icon name="go" size={12} tone="dim" className="vc-week-go" />
      </span>
      <span className="vc-mini">
        <MiniMeter label="5h" value={u?.five ?? null} ticks={5} />
        <MiniMeter label="Week" value={u?.week ?? null} ticks={7} />
      </span>
      <span className="vc-meter-sub">
        {fiveAt && <span>5h resets {fiveAt}</span>}
        {weekAt && <span>week resets {weekAt}</span>}
        {usage.failed && <span data-warn><Icon name="offline" size={11} tone="acc2" />usage unreachable</span>}
      </span>
      {dead.length > 0 && (
        <span className="vc-meter-sub vc-dead" title={dead.map((a) => a.label).join(', ')}>
          <span><Icon name="alert" size={11} tone="faint" />{dead.length === 1 ? `${dead[0].label} signed out` : `${dead.length} accounts signed out`}</span>
        </span>
      )}
    </Press>
  )
}

function MiniMeter({ label, value, ticks }: { label: string; value: number | null; ticks: number }) {
  const high = usageHigh(value)
  return (
    <span className="vc-mini-m">
      <span className="vc-mini-head">
        <span>{label}</span>
        <b data-high={high || undefined}>{value ?? '--'}<small>%</small></b>
      </span>
      <Bar value={value} ticks={ticks} tone={high ? 'acc2' : 'fg'} />
    </span>
  )
}

// ---------- usage: every account's 5h and week windows ----------

/**
 * AI > Usage: the hottest account's 5-hour and week windows as two big
 * meters with their resets, then every account, hottest first, signed-out
 * ones flagged, each with its own windows and resets. Reads only.
 */
function UsageView({ now }: { now: number }) {
  const usage = useUsage()
  const u = usage.data
  const live = u?.accounts.filter((a) => !a.dead).length ?? 0
  const dead = (u?.accounts.length ?? 0) - live
  return (
    <div className="vc-usage">
      <section className="vc-u-top vl-panel vl-build" style={iv(0)} aria-label="Hottest account">
        <header className="vc-u-head">
          <Icon name="gauge" size={15} tone={usageHigh(u?.five) || usageHigh(u?.week) ? 'acc2' : 'fg'} glow={!!u} />
          <span className="vc-u-label">Usage</span>
          <span className="vc-acct">{u ? u.label ?? 'no live account' : ''}</span>
          <Fresh q={usage} label="usage" now={now} />
        </header>
        {u ? (
          <div className="vc-u-big">
            <BigMeter label="5 hours" value={u.five} ticks={5} reset={resetAt(u.fiveResetsAt, now)} />
            <BigMeter label="Week" value={u.week} ticks={7} reset={resetAt(u.weekResetsAt, now)} />
          </div>
        ) : (
          <div className="vc-u-empty" data-failed={usage.failed || undefined}>
            {usage.failed ? (
              <><Icon name="alert" size={14} tone="acc2" glow />Usage did not answer: {usage.error?.message ?? 'no reply'}. Trying again every 30 s.</>
            ) : (
              <><Icon name="refresh" size={14} tone="dim" className="vl-pulse" />Reading usage</>
            )}
          </div>
        )}
      </section>

      {u && u.accounts.length > 0 && (
        <section className="vc-u-accts vl-panel vl-build" style={iv(1)} aria-label="Accounts">
          <header className="vc-u-head">
            <Icon name="claude" size={14} tone="dim" />
            <span className="vc-u-label">Accounts</span>
            <span className="vc-u-count">{live} live{dead ? <em> · {dead} signed out</em> : null}</span>
          </header>
          <div className="vc-u-row vc-u-cols" aria-hidden><span /><span>5h</span><span>Week</span></div>
          {u.accounts.map((a, k) => {
            const f = resetAt(a.fiveResetsAt, now)
            const w = resetAt(a.weekResetsAt, now)
            return (
              <div key={a.id} className="vc-u-row vl-build" style={iv(2 + k)} data-dead={a.dead || undefined} data-top={(!a.dead && k === 0) || undefined}>
                <span className="vc-u-name">
                  <span className="vl-ellipsis">{a.label}</span>
                  {a.dead ? <em>Sign-in expired</em> : (f || w) ? <em className="vl-ellipsis">{[f && `5h ${f}`, w && `week ${w}`].filter(Boolean).join(' · ')}</em> : null}
                </span>
                {a.dead ? (
                  <span className="vc-u-dead"><Icon name="alert" size={14} tone="acc2" glow />Signed out</span>
                ) : (
                  <>
                    <UsageCell value={a.five} ticks={5} />
                    <UsageCell value={a.week} ticks={7} />
                  </>
                )}
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function BigMeter({ label, value, ticks, reset }: { label: string; value: number | null; ticks: number; reset: string | null }) {
  const high = usageHigh(value)
  return (
    <div className="vc-u-meter">
      <span className="vc-u-mlabel"><Icon name="gauge" size={13} tone={high ? 'acc2' : 'dim'} glow={high} />{label}</span>
      <b data-high={high || undefined}>{value ?? '--'}<small>%</small></b>
      <Bar value={value} ticks={ticks} tone={high ? 'acc2' : 'fg'} />
      <em>{reset ? `resets ${reset}` : NBSP}</em>
    </div>
  )
}

function UsageCell({ value, ticks }: { value: number | null; ticks: number }) {
  const high = usageHigh(value)
  return (
    <span className="vc-u-cell">
      <b data-high={high || undefined}>{value ?? '--'}%</b>
      <Bar value={value} ticks={ticks} tone={high ? 'acc2' : 'fg'} />
    </span>
  )
}

const NBSP = String.fromCharCode(160)

// ---------- area filter: a row of plates, the picked one lit ----------

function AreaFilter({ items, value, onChange, vertical }: {
  items: AreaItem[]
  value: string
  onChange: (id: string) => void
  vertical: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const els = useRef<Record<string, HTMLButtonElement | null>>({})
  const [scroll, setScroll] = useState(false)
  const key = items.map((i) => i.id + i.count).join(',')

  // a row wider than the phone scrolls sideways and keeps its own drags
  // (data-no-swipe) only while it actually overflows
  const measure = useCallback(() => {
    const b = box.current
    if (!b) return
    setScroll(!vertical && b.scrollWidth > b.clientWidth + 1)
  }, [vertical])
  useLayoutEffect(() => {
    measure()
  }, [measure, key])
  useEffect(() => {
    const b = box.current
    if (!b) return
    const ro = new ResizeObserver(measure)
    ro.observe(b)
    document.fonts?.ready.then(measure)
    return () => ro.disconnect()
  }, [measure])
  // keep the lit plate in view when it changes
  useEffect(() => {
    const b = box.current
    const el = els.current[value]
    if (!b || !el || vertical) return
    if (el.offsetLeft < b.scrollLeft || el.offsetLeft + el.offsetWidth > b.scrollLeft + b.clientWidth) {
      b.scrollTo({ left: Math.max(0, el.offsetLeft - 12), behavior: 'smooth' })
    }
  }, [value, vertical])

  return (
    <div
      className="vc-filter vl-build"
      style={iv(3)}
      ref={box}
      role="radiogroup"
      aria-label="Area"
      data-vertical={vertical || undefined}
      data-no-swipe={scroll || undefined}
    >
      {items.map((a) => (
        <Press
          key={a.id}
          ref={(el) => { els.current[a.id] = el }}
          role="radio"
          aria-checked={a.id === value}
          data-on={a.id === value || undefined}
          className="vc-fplate"
          onPress={() => onChange(a.id)}
        >
          <span>{a.label}</span>
          <small>{a.count}</small>
        </Press>
      ))}
    </div>
  )
}

// ---------- sessions ----------

/** The session's state as its icon: working pulses gently, asking breathes in acc2. */
function StateIcon({ a, size = 17 }: { a: SessionVM['activity']; size?: number }) {
  const s = STATE_ICON[a]
  return (
    <span className="vc-sicon" data-a={a} aria-hidden>
      <Icon name={s.name} size={size} tone={s.tone} glow={s.glow} />
    </span>
  )
}

/** A section header: icon, label and count on a hairline; an optional action on the right. */
function GroupHead({ icon, tone = 'dim', glow = false, label, n, i, children }: {
  icon: IconName
  tone?: IconTone
  glow?: boolean
  label: ReactNode
  n: ReactNode
  i?: number
  children?: ReactNode
}) {
  return (
    <header className={cx('vc-ghead', i !== undefined && 'vl-build')} style={i !== undefined ? iv(i) : undefined}>
      <span className="vc-ghead-l">
        <Icon name={icon} size={14} tone={tone} glow={glow} />
        <span className="vc-ghead-t">{label}</span>
        <span className="vc-ghead-n">{n}</span>
      </span>
      {children}
    </header>
  )
}

const GROUP_ICON: Record<string, { icon: IconName; tone: IconTone; glow: boolean }> = {
  asking: { icon: 'asking', tone: 'acc2', glow: true },
  live: { icon: 'working', tone: 'fg', glow: true },
  recent: { icon: 'clock', tone: 'dim', glow: false },
}

function SessionBoard({
  board, area, now, hostLabel, openRow, setOpenRow, expRow, onToggle, recentAll, onToggleRecent, rowEls,
  busy, paneOf, where, recover, onRecover, onOpen, onDone, onStop,
}: {
  board: SessionVM[]
  area: string
  now: number
  hostLabel: (id: string) => string
  openRow: string | null
  setOpenRow: (id: string | null) => void
  expRow: string | null
  onToggle: (id: string) => void
  recentAll: boolean
  onToggleRecent: () => void
  rowEls: Map<string, HTMLElement>
  busy: ReadonlyMap<string, Busy>
  paneOf: (id: string) => string | null
  where: Where
  recover: Recover | null
  onRecover: (rows: SessionVM[]) => void
  onOpen: (s: SessionVM) => void
  onDone: (s: SessionVM) => void
  onStop: (s: SessionVM) => void
}) {
  const list = area === 'all' ? board : board.filter((s) => s.area === area)
  const live = list.filter(isLive).sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] || b.last - a.last)
  const recent = list.filter((s) => !isLive(s)).sort((a, b) => b.last - a.last)
  // recover my desk: open, not running, on thor, and no write of its own in flight
  const desk = recent.filter((s) => !s.live && s.host === HOME_HOST && !busy.has(s.id))
  const groups = [
    { key: 'asking', label: 'Asking', rows: live.filter((s) => s.activity === 'asking'), total: 0 },
    { key: 'live', label: 'Live', rows: live.filter((s) => s.activity !== 'asking'), total: 0 },
    { key: 'recent', label: 'Recent', rows: recentAll ? recent : recent.slice(0, RECENT_SHOWN), total: recent.length },
  ].filter((g) => g.rows.length)

  // close a swiped-open row when a finger lands anywhere else
  useEffect(() => {
    if (!openRow) return
    const f = (e: PointerEvent) => {
      const row = rowEls.get(openRow)
      if (row && row.contains(e.target as Node)) return
      setOpenRow(null)
    }
    window.addEventListener('pointerdown', f, true)
    return () => window.removeEventListener('pointerdown', f, true)
  }, [openRow, rowEls, setOpenRow])

  if (!groups.length) {
    return <div className="vc-empty vl-build" style={iv(4)}><span>Nothing open{area === 'all' ? '' : ` in ${areaName(area)}`}</span></div>
  }

  let k = 4
  return (
    <>
      {groups.map((g) => {
        // the Live header is lit only while something in it is working
        const gi = g.key === 'live' && !g.rows.some((s) => s.activity === 'working')
          ? { icon: 'idle' as IconName, tone: 'dim' as IconTone, glow: false }
          : GROUP_ICON[g.key]
        return (
        <section key={g.key} className="vc-group vl-panel" data-g={g.key}>
          <GroupHead icon={gi.icon} tone={gi.tone} glow={gi.glow} label={g.label} n={g.key === 'recent' ? g.total : g.rows.length} i={k++}>
            {g.key === 'recent' && (desk.length > 0 || recover) && (
              <Press
                className="vc-ghead-act"
                data-busy={recover ? '' : undefined}
                disabled={recover !== null}
                title={`Reopen the ${desk.length} ${area === 'all' ? '' : `${areaName(area)} `}session${desk.length === 1 ? '' : 's'} still open and not running, ${where.remote ? 'here' : `on ${hostLabel(HOME_HOST)}`}`}
                onPress={() => onRecover(desk)}
              >
                <Icon name={recover ? 'refresh' : hostIcon(HOME_HOST)} size={13} tone={recover ? 'fg' : 'dim'} className={recover ? 'vl-pulse' : undefined} />
                {recover ? `Recovering ${recover.done}/${recover.total}` : `Recover desk (${desk.length})`}
              </Press>
            )}
          </GroupHead>
          <div className="vc-rows">
            {g.rows.map((s) => (
              <SessionItem
                key={s.id}
                s={s}
                i={Math.min(k++, 16)}
                now={now}
                showArea={area === 'all'}
                hostLabel={hostLabel}
                open={openRow === s.id}
                setOpen={(o) => setOpenRow(o ? s.id : null)}
                expanded={expRow === s.id}
                onToggle={() => onToggle(s.id)}
                register={(el) => { if (el) rowEls.set(s.id, el); else rowEls.delete(s.id) }}
                busy={busy.get(s.id)}
                way={openState(s, paneOf(s.id), where, busy.get(s.id), hostLabel)}
                onOpen={onOpen}
                onDone={onDone}
                onStop={onStop}
              />
            ))}
          </div>
          {g.key === 'recent' && recent.length > RECENT_SHOWN && (
            <Press className="vc-showmore" onPress={onToggleRecent}>
              {!recentAll && <Icon name="add" size={14} tone="dim" />}
              {recentAll ? 'Show fewer' : `Show ${recent.length - RECENT_SHOWN} more`}
            </Press>
          )}
        </section>
        )
      })}
    </>
  )
}

/** The row's way back in, as its button says it: what Open will do for this session from this device. */
type OpenState = { label: string; hint: string; can: boolean; busy: boolean }

function openState(s: SessionVM, pane: string | null, where: Where, busy: Busy | undefined, hostLabel: (id: string) => string): OpenState {
  const home = hostLabel(HOME_HOST)
  if (busy === 'open') return { label: 'Opening', hint: 'Opening', can: false, busy: true }
  if (busy) return { label: 'Open', hint: busy === 'stop' ? 'Stopping' : 'Saving', can: false, busy: false }
  if (pane) return { label: 'Reattach', hint: 'Go to the terminal already running this session', can: true, busy: false }
  if (s.live) return { label: `Running on ${hostLabel(s.host)}`, hint: `Running on ${hostLabel(s.host)}'s screen. Stop it to open it here.`, can: false, busy: false }
  if (s.host !== HOME_HOST) return { label: `Open on ${hostLabel(s.host)}`, hint: `Open a terminal on ${hostLabel(s.host)}, where this session lives`, can: true, busy: false }
  if (where.inPage) return { label: 'Open', hint: `Open it here, running on ${home}`, can: true, busy: false }
  if (where.remote) return { label: 'Open here', hint: `Open a terminal here, resuming over SSH to ${home}`, can: true, busy: false }
  return { label: `Open on ${home}`, hint: `Open a terminal on ${home}`, can: true, busy: false }
}

function SessionItem({ s, i, now, showArea, hostLabel, open, setOpen, expanded, onToggle, register, busy, way, onOpen, onDone, onStop }: {
  s: SessionVM
  i: number
  now: number
  showArea: boolean
  hostLabel: (id: string) => string
  /** the swipe actions are showing */
  open: boolean
  setOpen: (open: boolean) => void
  expanded: boolean
  onToggle: () => void
  register: (el: HTMLElement | null) => void
  busy: Busy | undefined
  way: OpenState
  onOpen: (s: SessionVM) => void
  onDone: (s: SessionVM) => void
  onStop: (s: SessionVM) => void
}) {
  const liveRow = isLive(s)
  const locked = busy !== undefined
  const actions: RowAction[] = liveRow
    ? [{ id: 'stop', label: 'Stop', icon: 'stop', tone: 'acc2', run: () => onStop(s), disabled: locked }, { id: 'done', label: 'Done', icon: 'done', tone: 'fg', run: () => onDone(s), disabled: locked }]
    : [{ id: 'done', label: 'Done', icon: 'done', tone: 'fg', run: () => onDone(s), disabled: locked }]
  return (
    <div className="vc-item" ref={register} data-row={s.id} data-exp={expanded || undefined}>
      <SwipeRow
        i={i}
        open={open}
        setOpen={setOpen}
        actions={actions}
        onFull={() => onDone(s)}
        onTap={onToggle}
        expanded={expanded}
      >
        <StateIcon a={s.activity} />
        <span className="vc-row-main">
          <span className="vc-row-title" data-closed={!liveRow || undefined} data-a={s.activity}>{s.title || '(untitled)'}</span>
          <span className="vc-row-sub">
            <Icon name={hostIcon(s.host)} size={12} tone={liveRow ? 'dim' : 'faint'} title={hostLabel(s.host)} />
            <span>{s.project || 'no folder'}{s.host !== HOME_HOST ? ` · ${hostLabel(s.host)}` : ''}</span>
          </span>
        </span>
        <span className="vc-row-meta">
          <span className="vc-ago" data-a={s.activity}>{s.last ? ago(s.last, now) : '--'}</span>
          {busy === 'stop' || busy === 'open' ? (
            <span className="vc-state" data-a="closed">{busy === 'stop' ? 'stopping' : 'opening'}</span>
          ) : liveRow ? (
            <span className="vc-state" data-a={s.activity}>{STATE_WORD[s.activity]}</span>
          ) : showArea && s.area ? (
            <span className="vc-area">{areaName(s.area)}</span>
          ) : null}
        </span>
      </SwipeRow>
      {expanded && <RowStrip s={s} live={liveRow} locked={locked} way={way} onOpen={() => onOpen(s)} onDone={() => onDone(s)} onStop={() => onStop(s)} />}
    </div>
  )
}

/** Under a tapped row: getting back into the session is the point of the page, so Open leads. */
function RowStrip({ s, live, locked, way, onOpen, onDone, onStop }: {
  s: SessionVM
  live: boolean
  /** a write for this row is in flight */
  locked: boolean
  way: OpenState
  onOpen: () => void
  onDone: () => void
  onStop: () => void
}) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(t)
  }, [copied])
  // the copy runs in the click handler: iOS only lets the clipboard be written
  // from a click or touchend, not from pointerup
  const copy = () => {
    if (!s.resume) return
    void copyText(s.resume).then((ok) => {
      setCopied(ok ? 'ok' : 'fail')
      if (!ok) toast('The browser blocked the clipboard')
    })
  }
  return (
    <div className="vc-strip">
      <div className="vc-strip-acts">
        <Press className="vc-sact" data-main data-busy={way.busy || undefined} disabled={!way.can} title={way.hint} onPress={onOpen}>
          <Icon name={way.busy ? 'refresh' : 'claude'} size={15} tone="fg" glow={way.can} className={way.busy ? 'vl-pulse' : undefined} />
          <span>{way.label}</span>
        </Press>
        <Press
          className="vc-sact vc-iact"
          data-copied={copied === 'ok' || undefined}
          disabled={!s.resume}
          aria-label="Copy resume"
          title={s.resume ?? 'no resume command'}
          onPress={() => {}}
          onClick={copy}
        >
          <Icon name={copied === 'ok' ? 'done' : 'copy'} size={16} tone={copied === 'ok' ? 'hot' : 'dim'} glow={copied === 'ok'} />
          <span className="vc-iact-l">{copied === 'ok' ? 'Copied' : 'Copy resume'}</span>
        </Press>
        <Press className="vc-sact vc-iact" aria-label="Done" title="Done" disabled={locked} onPress={onDone}>
          <Icon name="done" size={16} tone="dim" /><span className="vc-iact-l">Done</span>
        </Press>
        {live && (
          <Press className="vc-sact vc-iact" data-tone="acc2" aria-label="Stop" title="Stop" disabled={locked} onPress={onStop}>
            <Icon name="stop" size={16} tone="acc2" /><span className="vc-iact-l">Stop</span>
          </Press>
        )}
      </div>
      {s.resume && <code className="vc-strip-cmd">{s.resume}</code>}
    </div>
  )
}

// A row that slides left to reveal its actions. It only starts a slide from
// the right edge (the age column) or while already open, so a left swipe on
// the title still pages to the next tab. Native listeners on the row see the
// gesture before the pager does, keep their own drags, and let vertical
// scrolls and rightward swipes (to the previous tab) through.

type RowAction = { id: string; label: string; icon: IconName; tone: 'fg' | 'acc2'; run: () => void; disabled?: boolean }
const ACT_W = 78
const SWIPE_ZONE = 72

function SwipeRow({ i, open, setOpen, actions, onFull, onTap, expanded, children }: {
  i: number
  open: boolean
  setOpen: (open: boolean) => void
  actions: RowAction[]
  onFull: () => void
  onTap: () => void
  expanded: boolean
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLButtonElement>(null)
  const x = useRef(0)
  const anim = useRef<null | (() => void)>(null)
  const swiped = useRef(false)
  // a full swipe commits Done, so it only arms while Done can run
  const canFull = actions.some((a) => a.id === 'done' && !a.disabled)
  const latest = useRef({ open, setOpen, onFull, canFull, width: actions.length * ACT_W })
  latest.current = { open, setOpen, onFull, canFull, width: actions.length * ACT_W }

  const set = (v: number) => {
    x.current = v
    const f = front.current
    if (f) f.style.transform = v ? `translate3d(${v.toFixed(1)}px, 0, 0)` : ''
    const b = box.current
    if (b) {
      b.style.setProperty('--reveal', String(Math.max(0, Math.min(1, -v / Math.max(1, latest.current.width)))))
      b.style.setProperty('--fill', String(Math.max(0, Math.min(1, -v / Math.max(1, b.clientWidth)))))
      b.toggleAttribute('data-moved', Math.abs(v) > 0.5)
    }
  }
  const springTo = (to: number, velocity = 0, done?: () => void) => {
    anim.current?.()
    anim.current = animateSpring(x.current, to, (v) => set(v), { stiffness: 420, velocity, precision: 0.3, onDone: () => { anim.current = null; done?.() } })
  }

  // follow the controlled state (another row opened, a tap closed this one)
  useEffect(() => {
    if (box.current?.dataset.dragging !== undefined) return
    springTo(open ? -latest.current.width : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const el = box.current
    if (!el) return
    type G = { id: number; x0: number; y0: number; axis: null | 'x' | 'pass'; base: number; lastX: number; lastT: number; vx: number; w: number }
    let g: G | null = null

    const down = (e: PointerEvent) => {
      swiped.current = false
      g = null
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if ((e.target as Element).closest('.vc-act')) return
      // closed rows slide only from the age column; the title area belongs to the pager
      const r = el.getBoundingClientRect()
      if (x.current > -0.5 && e.clientX < r.right - SWIPE_ZONE) return
      anim.current?.()
      anim.current = null
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, base: x.current, lastX: e.clientX, lastT: e.timeStamp, vx: 0, w: el.clientWidth }
    }
    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id || g.axis === 'pass') return
      const dx = e.clientX - g.x0
      const dy = e.clientY - g.y0
      if (!g.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
        if (Math.abs(dx) > Math.abs(dy) && (dx < 0 || g.base < 0)) {
          g.axis = 'x'
          swiped.current = true
          try { el.setPointerCapture(e.pointerId) } catch { /* pointer gone */ }
          el.dataset.dragging = ''
          if (!latest.current.open) latest.current.setOpen(true)
        } else {
          g.axis = 'pass'
          return
        }
      }
      e.stopPropagation()
      if (e.cancelable) e.preventDefault()
      const dt = Math.max(1, e.timeStamp - g.lastT)
      g.vx = g.vx * 0.3 + ((e.clientX - g.lastX) / dt) * 0.7
      g.lastX = e.clientX
      g.lastT = e.timeStamp
      const W = latest.current.width
      let v = g.base + dx
      if (v > 0) v *= 0.22
      else if (v < -W) v = -W - (-W - v) * 0.85
      set(v)
      el.toggleAttribute('data-full', latest.current.canFull && v < -Math.max(W + 70, g.w * 0.55))
    }
    const up = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return
      const was = g
      g = null
      if (was.axis !== 'x') return
      delete el.dataset.dragging
      try { el.releasePointerCapture(e.pointerId) } catch { /* released */ }
      const W = latest.current.width
      const v = x.current
      const vx = e.timeStamp - was.lastT > 80 ? 0 : was.vx
      const full = el.hasAttribute('data-full') && e.type !== 'pointercancel'
      if (!full) el.removeAttribute('data-full')
      if (full) {
        springTo(-was.w - 20, vx * 1000, () => latest.current.onFull())
        return
      }
      let o = v < -W * 0.45
      if (vx < -0.35) o = true
      if (vx > 0.35) o = false
      latest.current.setOpen(o)
      springTo(o ? -W : 0, vx * 1000)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      anim.current?.()
    }
  }, [])

  return (
    <div className="vc-swipe vl-build" style={iv(i)} data-open={open || undefined} ref={box}>
      <i className="vc-fill" aria-hidden />
      <div className="vc-acts" style={{ width: actions.length * ACT_W }} aria-hidden={!open}>
        {actions.map((a) => (
          <Press key={a.id} className="vc-act" data-tone={a.tone} tabIndex={open ? 0 : -1} disabled={a.disabled} onPress={a.run}>
            <Icon name={a.icon} size={18} tone={a.tone === 'acc2' ? 'acc2' : 'ink'} />
            <span>{a.label}</span>
          </Press>
        ))}
      </div>
      <Press
        ref={front}
        className="vc-front"
        aria-expanded={expanded}
        onPress={() => {
          if (swiped.current) return
          if (latest.current.open) latest.current.setOpen(false)
          else onTap()
        }}
      >
        {children}
      </Press>
      {/* mouse: the same actions on hover, so desktop does not need a drag */}
      <div className="vc-hover-acts">
        {actions.map((a) => (
          <Press key={a.id} className="vc-hact" data-tone={a.tone} tabIndex={-1} disabled={a.disabled} onPress={a.run}>
            <Icon name={a.icon} size={14} tone={a.tone === 'acc2' ? 'acc2' : 'dim'} />
            {a.label}
          </Press>
        ))}
      </div>
    </div>
  )
}

// ---------- projects ----------

/** Right column of a project row: asking, live, the next reminder, else the age. */
function ProjMeta({ p, now }: { p: Counted; now: number }) {
  const lead = p.asking > 0
    ? <span className="vc-ago" data-a="asking"><Icon name="asking" size={13} tone="acc2" glow />{p.asking} asking</span>
    : p.live > 0
      ? <span className="vc-ago" data-a="working"><Icon name="working" size={13} tone="fg" glow />{p.live} live</span>
      : <span className="vc-ago" data-a="closed">{ago(p.updated, now)}</span>
  return (
    <span className="vc-row-meta">
      {lead}
      {p.nextReminderAt != null ? (
        <span className="vc-area" data-rem title="next reminder"><Icon name="timer" size={11} tone="hot" />{until(p.nextReminderAt, now)}</span>
      ) : p.asking > 0 || p.live > 0 ? (
        <span className="vc-area">{ago(p.updated, now)}</span>
      ) : null}
      {p.status !== 'active' && <span className="vc-area" data-warn>{p.status}</span>}
    </span>
  )
}

/** A project's leading icon: lit while it has a live or asking session, or while it is the one shown. */
function ProjIcon({ p, on, size = 16 }: { p: Counted; on?: boolean; size?: number }) {
  const lit = p.asking > 0 || p.live > 0 || !!on
  return <Icon name="projects" size={size} tone={p.asking > 0 ? 'acc2' : lit ? 'fg' : 'dim'} glow={lit} className="vc-picon" />
}

function ProjectBoard({ list, area, loading, failed, error, now, selected, onOpen }: {
  list: Counted[]
  area: string
  loading: boolean
  failed: boolean
  error: Error | null
  now: number
  selected: string | null
  onOpen: (p: ProjectVM) => void
}) {
  if (loading) {
    return (
      <div className="vc-empty vl-build" style={iv(4)} data-failed={failed || undefined}>
        {failed ? (
          <><b><Icon name="alert" size={15} tone="acc2" glow />Projects did not answer</b><span>{error?.message ?? 'no reply'}</span></>
        ) : (
          <span><Icon name="projects" size={15} tone="dim" className="vl-pulse" />Reading Valkyrie Projects</span>
        )}
      </div>
    )
  }
  const shown = area === 'all' ? list : list.filter((p) => p.area === area)
  if (!shown.length) return <div className="vc-empty vl-build" style={iv(4)}><span>No projects{area === 'all' ? '' : ` in ${areaName(area)}`}</span></div>

  // by area (his clients stay together); inside an area, asking > live > updated;
  // areas ordered by their most urgent project
  const byArea = new Map<string, Counted[]>()
  for (const p of shown) byArea.set(p.area, [...(byArea.get(p.area) ?? []), p])
  const groups = [...byArea.entries()]
    .map(([a, rows]) => [a, rows.sort(byUrgency)] as const)
    .sort((a, b) => byUrgency(a[1][0], b[1][0]))

  let k = 4
  return (
    <>
      {groups.map(([a, rows]) => (
        <section key={a} className="vc-group vl-panel">
          <GroupHead icon={areaIcon(a)} label={areaName(a)} n={rows.length} i={k++} />
          <div className="vc-rows">
            {rows.map((p) => (
              <Press
                key={p.id}
                className="vc-prow vl-build"
                style={iv(Math.min(k++, 16))}
                data-on={selected === p.id || undefined}
                onPress={() => onOpen(p)}
              >
                <ProjIcon p={p} on={selected === p.id} />
                <span className="vc-row-main">
                  <span className="vc-row-title">{p.name}</span>
                  <span className="vc-prow-next">{p.nextAction || 'No next action set'}</span>
                </span>
                <ProjMeta p={p} now={now} />
              </Press>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

type ProjDocVM = {
  targetKey: string
  tasks: string[]
  openTasks: number
  doneTasks: number
  links: { id: string; host: string; note: string; at: number }[]
  reminder: { at: number; message: string } | null
}

function useProjDoc(id: string): Live<ProjDocVM> {
  return useLive<ProjDocVM>(`projdoc.${id}`, async () => {
    const d = await fetchProjDoc(id)
    const items = d.tabs.filter((t) => t.kind === 'checklist').flatMap((t) => t.items as { text: string; done: boolean }[])
    const seen = new Set<string>()
    const links = d.sessions
      .filter((l) => !seen.has(l.sessionId) && !!seen.add(l.sessionId))
      .map((l) => ({ id: l.sessionId, host: l.host, note: l.statusNote, at: Date.parse(l.statusAt ?? l.linkedAt) }))
    const rem = d.reminders.filter((r) => r.state === 'pending').sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
    return {
      targetKey: d.project.targetKey,
      tasks: items.filter((t) => !t.done).map((t) => t.text).slice(0, 8),
      openTasks: items.filter((t) => !t.done).length,
      doneTasks: items.filter((t) => t.done).length,
      links: links.slice(0, 12),
      reminder: rem ? { at: Date.parse(rem.at), message: rem.message } : null,
    }
  }, 60_000)
}

const TASKS_SHOWN = 5

// A project's linked sessions are often done or old, so the open board does not
// name them. The kit's session index (the same board fetch, every session by
// id) names them; the names persist here so a reopened project paints them at
// once on a cold open, before the board has loaded.
type Brief = { title: string; project: string; host: string; last: number }
const BRIEFS_KEY = 'v2.claude.briefs'

function readBriefs(): Record<string, Brief> {
  try { return JSON.parse(localStorage.getItem(BRIEFS_KEY) || '{}') as Record<string, Brief> } catch { return {} }
}

function useSessionBriefs(ids: string[], index: SessionIndex): Record<string, Brief> {
  const [stored, setStored] = useState(readBriefs)
  const idsKey = ids.join(',')
  useEffect(() => {
    if (!index.ready || !ids.length) return
    const next = { ...readBriefs() }
    let changed = false
    for (const id of ids) {
      const s = index.byId.get(id)
      if (!s) continue
      const b: Brief = { title: s.title, project: s.project, host: s.host, last: s.last }
      if (JSON.stringify(next[id]) !== JSON.stringify(b)) { next[id] = b; changed = true }
    }
    if (!changed) return
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete next[k]
    try { localStorage.setItem(BRIEFS_KEY, JSON.stringify(next)) } catch { /* quota */ }
    setStored(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index.ready, index.byId, idsKey])
  return stored
}

function ProjectDetail({ p, index, lookup, now, hostLabel, showArea }: {
  p: ProjectVM
  index: SessionIndex
  lookup: Lookup
  now: number
  hostLabel: (id: string) => string
  /** the sheet already names the area in its header */
  showArea?: boolean
}) {
  const doc = useProjDoc(p.id)
  const targets = useLaunchTargets()
  const [more, setMore] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  // 'start' or the linked session being opened; one at a time, so two taps never make two sessions
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)
  // the last refusal, inline as well: on the phone this sits in a sheet whose backdrop covers the toasts
  const [note, setNote] = useState<string | null>(null)
  const say = (msg: string, ms = 5000) => {
    setNote(msg)
    toast(msg, { ms })
  }
  // A project always opens in the page (useProjectTerm): only that path hands
  // the session the project's MCP server. The terminal's back leads to the project.
  const back = `/projects/${p.id}`
  const run = async (what: string, fail: string, fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(what)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      // verbatim: the backend's 409 at the session cap says what to close
      say(`${fail}: ${errText(e)}`)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  const landed = (r: { name: string; session: TermSession | null }) => {
    seedTerminal(qc, r)
    void qc.invalidateQueries({ queryKey: ['v2', `projdoc.${p.id}`] })
    navigate(termPath(r.name, back))
  }
  // no label: the backend names a project session after the project
  const start = () => run('start', `Could not start a session in ${p.name}`, async () => {
    landed(await openTermSession({ mode: 'new', project: p.id, ...phoneGrid() }))
  })
  const resume = (id: string, title: string | undefined, host: string) => run(id, `Could not open "${title || 'the session'}"`, async () => {
    const pane = paneFor(await freshPanes(qc), id)
    if (pane) {
      navigate(termPath(pane, back))
      return
    }
    if (lookup(id)?.live) {
      say(`"${title || 'The session'}" is running on ${hostLabel(host)}. Stop it to open it here.`, 4000)
      return
    }
    // the in-page terminal reaches thor only; a transcript elsewhere opens on its own machine
    if (host !== HOME_HOST) {
      await launchOn(id, host)
      toast(`Opened "${title || 'the session'}" on ${hostLabel(host)}`)
      return
    }
    landed(await openTermSession({ mode: 'resume', sessionId: id, project: p.id, label: title, ...phoneGrid() }))
  })
  const d = doc.data
  const target = d ? targets.data?.find((t) => t.key === d.targetKey) : undefined
  const links = d?.links ?? []
  const briefs = useSessionBriefs(links.map((l) => l.id), index)
  // the board and index give the real state; a stored brief only names it (its state is old)
  const info = (id: string): { title: string; project: string; host: string; last: number; activity: SessionVM['activity'] } | undefined => {
    const s = lookup(id)
    if (s) return s
    const b = briefs[id]
    return b ? { ...b, activity: 'closed' } : undefined
  }
  const rank = (id: string) => ACTIVITY_RANK[info(id)?.activity ?? 'closed']
  const sortedLinks = [...links].sort((x, y) => rank(x.id) - rank(y.id) || (info(y.id)?.last || y.at) - (info(x.id)?.last || x.at))
  const longSummary = p.summary.length > 220
  const caps: string[] = []
  if (showArea) caps.push(areaName(p.area))
  if (p.status !== 'active') caps.push(p.status)
  caps.push(`updated ${ago(p.updated, now)} ago`)
  if (d && d.openTasks > 0) caps.push(`${d.openTasks} open`)
  let k = 1
  return (
    <div className="vc-pd vl-build-on">
      <div className="vc-pd-caps vl-build" style={iv(k++)}>
        {caps.map((c, n) => <span key={c}>{n > 0 && <b>·</b>}{c}</span>)}
      </div>

      <div className="vc-pd-next vl-build" style={iv(k++)}>
        <span className="vc-pd-label">Next</span>
        <p>{p.nextAction || 'No next action set'}</p>
      </div>

      <div className="vc-pd-actions vl-build" style={iv(k++)}>
        <Press
          className="vc-glass vc-pd-start"
          data-busy={busy === 'start' || undefined}
          disabled={busy !== null}
          title={`Start an AI session in ${target?.label ?? p.name}, here in the page`}
          onPress={() => void start()}
        >
          <Icon name={busy === 'start' ? 'refresh' : 'start'} size={16} tone="fg" className={busy === 'start' ? 'vl-pulse' : undefined} />
          <span>{busy === 'start' ? 'Starting' : `Start session${target ? ` in ${target.label}` : ''}`}</span>
        </Press>
        {note && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{note}</p>}
      </div>

      {d?.reminder && (
        <div className="vc-pd-rem vl-build" style={iv(k++)}>
          <span className="vc-pd-label"><Icon name="timer" size={12} tone="hot" />Reminder</span>
          <span className="vc-pd-rem-at">{dayClock(d.reminder.at, now)}</span>
          <span className="vc-pd-rem-msg">{d.reminder.message}</span>
        </div>
      )}

      {p.summary && (
        <div className="vc-pd-sumwrap vl-build" style={iv(k++)}>
          <p className="vc-pd-summary" data-clamp={(longSummary && !more) || undefined}>{p.summary}</p>
          {longSummary && <Press className="vc-more" onPress={() => setMore((m) => !m)}>{more ? 'Less' : 'More'}</Press>}
        </div>
      )}

      <section className="vc-pd-sec vl-build" style={iv(k++)}>
        <GroupHead icon="claude" label="Sessions" n={p.sessions} />
        {links.length ? (
          <div className="vc-rows">
            {sortedLinks.map((l) => {
              const s = info(l.id)
              const a = s?.activity ?? 'closed'
              const liveRow = a !== 'closed'
              const host = s?.host ?? l.host
              const pane = paneFor(qc.getQueryData<TermSession[]>(TERMS_KEY), l.id)
              return (
                <Press
                  key={l.id}
                  className="vc-pd-srow"
                  data-busy={busy === l.id || undefined}
                  disabled={busy !== null}
                  title={pane ? 'Go to the terminal already running this session' : host !== HOME_HOST ? `Open a terminal on ${hostLabel(host)}, where this session lives` : `Open it here, running on ${hostLabel(host)}`}
                  onPress={() => void resume(l.id, s?.title || undefined, host)}
                >
                  <StateIcon a={a} size={16} />
                  <span className="vc-row-main">
                    <span className="vc-row-title" data-closed={!liveRow || undefined}>{s?.title || l.note || `Linked session · ${shortDate(l.at)}`}</span>
                    <span className="vc-row-sub">
                      <Icon name={hostIcon(s?.host ?? l.host)} size={12} tone={liveRow ? 'dim' : 'faint'} title={hostLabel(s?.host ?? l.host)} />
                      <span>{[s?.project, (s?.host ?? l.host) !== HOME_HOST ? hostLabel(s?.host ?? l.host) : ''].filter(Boolean).join(' · ') || 'not on the open board'}</span>
                    </span>
                  </span>
                  <span className="vc-row-meta">
                    <span className="vc-ago" data-a={a}>{ago(s?.last || l.at, now)}</span>
                    {busy === l.id ? <span className="vc-state" data-a="closed">opening</span> : liveRow && <span className="vc-state" data-a={a}>{STATE_WORD[a]}</span>}
                  </span>
                </Press>
              )
            })}
          </div>
        ) : (
          <p className="vc-pd-none">{doc.failed && !d ? 'Project did not answer' : doc.isFetching && !d ? 'Loading' : 'No linked sessions'}</p>
        )}
      </section>

      {d && d.openTasks > 0 && (
        <section className="vc-pd-sec vl-build" style={iv(k++)}>
          <GroupHead icon="done" label="Open tasks" n={`${d.openTasks}${d.doneTasks ? ` of ${d.openTasks + d.doneTasks}` : ''}`} />
          <ul className="vc-pd-tasks">
            {d.tasks.slice(0, TASKS_SHOWN).map((t, n) => <li key={n}><i />{t}</li>)}
          </ul>
          {d.openTasks > TASKS_SHOWN && <p className="vc-pd-none">{d.openTasks - TASKS_SHOWN} more in Valkyrie Projects</p>}
        </section>
      )}
    </div>
  )
}

/** Beside Sessions on desktop (and under the loading line on the phone): the projects at a glance. */
function ProjectGlance({ list, now, onOpen }: { list: Counted[]; now: number; onOpen: (p: ProjectVM) => void }) {
  if (!list.length) return null
  return (
    <section className="vc-glance vl-panel">
      <GroupHead icon="projects" label="Projects" n={list.length} i={5} />
      <div className="vc-rows">
        {list.slice(0, 9).map((p, n) => (
          <Press key={p.id} className="vc-grow vl-build" style={iv(Math.min(6 + n, 16))} onPress={() => onOpen(p)}>
            <ProjIcon p={p} size={15} />
            <span className="vc-row-main">
              <span className="vc-grow-name">{p.name}</span>
              <span className="vc-grow-next">{p.nextAction || 'No next action set'}</span>
            </span>
            <ProjMeta p={p} now={now} />
          </Press>
        ))}
      </div>
    </section>
  )
}

// ---------- new session: machines, then their launch targets as glass plates ----------

const THOR_ONLY: SessionHost[] = [{ host: HOME_HOST, configured: true, reachable: true, canLaunch: true, canPage: true, detail: null }]

function useRemoteTargets(host: string): Live<TargetVM[]> {
  return useLive<TargetVM[]>(`claude.targets.${host}`, async () => {
    const d = (await api.get<{ targets?: unknown }>(`/hosts/${encodeURIComponent(host)}/launch-targets`)).data
    if (!Array.isArray(d.targets)) throw new Error('launch targets: bad response')
    return (d.targets as Record<string, unknown>[])
      .filter((t) => typeof t.key === 'string' && t.exists !== false)
      .map((t): TargetVM => {
        const key = String(t.key)
        const label = typeof t.label === 'string' ? t.label : key
        return { key, label: shortName({ key, label } as LaunchTarget), phone: t.phone === true, project: t.project === true, group: typeof t.group === 'string' ? t.group : null }
      })
  }, 5 * 60_000)
}

// The odin targets (GET /terminal/odin-targets): keys and labels from a private
// file on odin, never paths. `ready` is false when odin has no claude CLI.
type OdinTargets = { ready: boolean; detail: string | null; targets: TargetVM[] }

function useOdinTargets(): Live<OdinTargets> {
  return useLive<OdinTargets>('claude.odinTargets', async () => {
    const d = (await api.get<{ ready?: unknown; detail?: unknown; targets?: unknown }>('/terminal/odin-targets')).data
    if (!Array.isArray(d.targets)) throw new Error('odin targets: bad response')
    return {
      ready: d.ready !== false,
      detail: typeof d.detail === 'string' ? d.detail : null,
      targets: (d.targets as Record<string, unknown>[])
        .filter((t) => typeof t.key === 'string')
        .map((t): TargetVM => {
          const key = String(t.key)
          return { key, label: typeof t.label === 'string' && t.label ? t.label : key, phone: true, project: false, group: null }
        }),
    }
  }, 5 * 60_000)
}

type ThorWay = 'page' | 'screen'

function TargetPicker({ area, hostLabel, where, starting, error, onPick, onScreen, onOdin }: {
  area: string
  hostLabel: (id: string) => string
  where: Where
  /** the in-flight start's busy key: `${host}:${target}`, or a slot's */
  starting: string | null
  /** the last start the host refused */
  error: string | null
  onPick: (t: TargetVM, h: SessionHost) => void
  /** thor's own screen: Windows Terminal on its desk, so the session lives on thor */
  onScreen: (t: TargetVM) => void
  /** the backup host: Claude on odin itself, in a pane the page attaches to */
  onOdin: (t: TargetVM) => void
}) {
  // /api/session-hosts: which machines can start a session (falls back to thor on an older backend)
  const hosts = useLive<SessionHost[]>('claude.sessionHosts', fetchSessionHosts, 5 * 60_000)
  const [way, setWay] = useState<ThorWay>('page')
  const list = (hosts.data?.length ? hosts.data : THOR_ONLY)
    .slice()
    .sort((a, b) => Number(b.host === HOME_HOST) - Number(a.host === HOME_HOST) || Number(b.canLaunch) - Number(a.canLaunch) || a.host.localeCompare(b.host))
  // Odin sits right under thor, and leads while thor is not answering: that is when the backup is the point.
  const thorAt = list.findIndex((h) => h.host === HOME_HOST)
  const odinAt = thorAt >= 0 && !list[thorAt].canLaunch ? 0 : thorAt + 1
  const rows: (SessionHost | null)[] = [...list.slice(0, odinAt), null, ...list.slice(odinAt)]
  return (
    <div className="vc-targets vl-build-on">
      {error && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{error}</p>}
      {rows.map((h, n) => {
        if (!h) return <OdinSection key={ODIN_SLOT} k0={n * 6} starting={starting} hostLabel={hostLabel} onPick={onOdin} />
        // the in-page terminal is a pane on odin that reaches thor only, and offers the phone targets
        const inPage = where.inPage && h.canPage
        const here = !inPage && where.remote && h.host === HOME_HOST
        // From the page, thor can also open on its own screen through its launcher agent.
        const canScreen = inPage && h.host === HOME_HOST && h.canLaunch
        const screen = canScreen && way === 'screen'
        const props: TargetListProps = screen
          ? { host: h.host, slot: SCREEN_SLOT, area, k0: n * 6 + 2, phoneOnly: false, starting, onPick: onScreen }
          : { host: h.host, area, k0: n * 6 + (canScreen ? 2 : 1), phoneOnly: inPage, starting, onPick: (t: TargetVM) => onPick(t, h) }
        return (
          <section key={h.host} className="vc-host" data-off={!h.canLaunch || undefined}>
            <header className="vc-host-head vl-build" style={iv(n * 6)}>
              <Icon name={hostIcon(h.host)} size={17} tone={h.canLaunch ? 'fg' : 'faint'} glow={h.canLaunch} />
              <span className="vc-host-name">{hostLabel(h.host)}</span>
              <span className="vc-host-how">
                {!h.canLaunch && <Icon name={!h.reachable ? 'offline' : 'alert'} size={12} tone="acc2" />}
                {h.canLaunch
                  ? screen ? `opens on ${hostLabel(h.host)}'s screen` : inPage ? 'opens in the page' : here ? 'opens on this screen' : 'opens on its screen'
                  : !h.reachable ? 'not answering' : 'cannot start sessions'}
              </span>
            </header>
            {canScreen && (
              <div className="vc-way vl-build" style={iv(n * 6 + 1)}>
                <Segmented<ThorWay>
                  options={[{ value: 'page', label: 'In page', icon: 'phone' }, { value: 'screen', label: 'On screen', icon: 'thor' }]}
                  value={way}
                  onChange={setWay}
                />
              </div>
            )}
            {!h.canLaunch ? (
              <p className="vc-pd-none vl-build" style={iv(n * 6 + 1)}>
                {!h.reachable ? `${hostLabel(h.host)} did not answer${h.detail ? ` (${h.detail})` : ''}. Try again in a minute.` : h.detail ?? 'no launcher agent'}
              </p>
            ) : h.host === HOME_HOST ? (
              <ThorTargets {...props} />
            ) : (
              <RemoteTargets {...props} />
            )}
          </section>
        )
      })}
    </div>
  )
}

// Odin, the backup: Claude Code on odin itself in one of odin's own targets,
// opened in the page like a thor pane. It needs neither thor nor its agent.
function OdinSection({ k0, starting, hostLabel, onPick }: {
  k0: number
  starting: string | null
  hostLabel: (id: string) => string
  onPick: (t: TargetVM) => void
}) {
  const q = useOdinTargets()
  const name = hostLabel(BACKUP_HOST)
  const notReady = q.data?.ready === false
  const lit = !!q.data?.targets.length && !notReady && !(q.failed && !q.data)
  const targets: Live<TargetVM[]> = { ...q, data: q.data?.targets }
  return (
    <section className="vc-host" data-off={notReady || (q.failed && !q.data) || undefined}>
      <header className="vc-host-head vl-build" style={iv(k0)}>
        <Icon name={hostIcon(BACKUP_HOST)} size={17} tone={lit ? 'fg' : 'faint'} glow={lit} />
        <span className="vc-host-name">{name}</span>
        <span className="vc-host-how">
          {notReady && <Icon name="alert" size={12} tone="acc2" />}
          {notReady ? 'no claude here' : `backup, runs on ${name}`}
        </span>
      </header>
      {notReady ? (
        <p className="vc-pd-none vl-build" style={iv(k0 + 1)}>{q.data?.detail ?? `${name} cannot start Claude`}</p>
      ) : (
        <TargetList q={targets} host={name} slot={ODIN_SLOT} area="" k0={k0 + 1} phoneOnly={false} starting={starting} onPick={onPick} />
      )}
    </section>
  )
}

type TargetListProps = {
  host: string
  /** the busy key's prefix, when it is not the host (thor's screen, odin) */
  slot?: string
  area: string
  k0: number
  phoneOnly: boolean
  starting: string | null
  onPick: (t: TargetVM) => void
}

function ThorTargets(props: TargetListProps) {
  return <TargetList q={useLaunchTargets()} {...props} />
}

function RemoteTargets(props: TargetListProps) {
  return <TargetList q={useRemoteTargets(props.host)} {...props} />
}

function TargetList({ q, host, slot, area, k0, phoneOnly, starting, onPick }: TargetListProps & { q: Live<TargetVM[]> }) {
  const list = (q.data ?? []).filter((t) => !phoneOnly || t.phone)
  if (!list.length) {
    const why = q.failed ? `${host} did not answer: ${q.error?.message ?? 'no reply'}` : q.isFetching || !q.data ? 'Reading targets' : `No launch targets on ${host}`
    return <p className="vc-pd-none">{why}</p>
  }
  const sections = [
    { label: 'Folders', items: list.filter((t) => t.phone && !t.project) },
    { label: 'Projects', items: list.filter((t) => t.phone && t.project) },
    { label: 'More', items: list.filter((t) => !t.phone) },
  ].filter((s) => s.items.length)
  let k = k0
  return (
    <>
      {q.failed && <p className="vc-tnote">{host} did not answer, list from {ago(q.updatedAt)} ago</p>}
      {sections.map((s) => (
        <div key={s.label} className="vc-tsec">
          <div className="vc-tsec-label vl-build" style={iv(k++)}>{s.label}</div>
          <div className="vc-plates">
            {s.items.map((t) => {
              const mine = starting === `${slot ?? host}:${t.key}`
              return (
                <Press
                  key={t.key}
                  className="vc-plate vl-build"
                  style={iv(Math.min(k++, 14))}
                  data-hint={(area !== 'all' && t.key === area) || undefined}
                  data-busy={mine || undefined}
                  disabled={starting !== null}
                  onPress={() => onPick(t)}
                >
                  <Icon name={mine ? 'refresh' : t.project ? 'projects' : 'claude'} size={14} tone={mine ? 'fg' : 'dim'} className={mine ? 'vl-pulse' : undefined} />
                  <span>{mine ? `Starting ${t.label}` : t.label}</span>
                </Press>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

// ---------- bottom sheet ----------

function Sheet({ open, onClose, label, icon, value, children }: {
  open: boolean
  onClose: () => void
  label: ReactNode
  icon?: IconName
  value?: ReactNode
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (open) {
      setMounted(true)
      let r2 = 0
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 360)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // drag the grip down to dismiss
  const drag = useRef<{ id: number; y0: number; dy: number; t: number; vy: number } | null>(null)
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, vy: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
    panel.current?.setAttribute('data-drag', '')
  }
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dy = Math.max(0, e.clientY - d.y0)
    d.vy = (dy - d.dy) / Math.max(1, e.timeStamp - d.t)
    d.dy = dy
    d.t = e.timeStamp
    panel.current?.style.setProperty('--drag', `${dy}px`)
  }
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    panel.current?.removeAttribute('data-drag')
    panel.current?.style.removeProperty('--drag')
    if (d.dy > 90 || (d.dy > 20 && d.vy > 0.5)) close.current()
  }

  if (!mounted) return null
  return createPortal(
    <div className="vc-sheet-root" data-shown={shown || undefined}>
      <div className="vc-sheet-back" onClick={() => close.current()} />
      <div className="vc-sheet" ref={panel} role="dialog" aria-modal="true" aria-label={typeof label === 'string' ? label : undefined}>
        <div className="vc-sheet-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
          <i />
          <div className="vc-sheet-head">
            {icon && <Icon name={icon} size={18} tone="fg" glow />}
            <span className="vc-sheet-label">{label}</span>
            {value && <span className="vc-sheet-value">{value}</span>}
          </div>
        </div>
        <div className="vc-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
