import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, PanelRightOpen, SquareArrowOutUpRight, type LucideIcon } from 'lucide-react'
import { useIntent, useShell, type ScreenProps } from '../kit/shell'
import { Bar, Press, Segmented, cx, toast } from '../kit/ui'
import { Icon, hostIcon, isIconName, type IconName, type IconTone } from '../kit/icons'
import { canDetach, openDetached } from '../kit/windows'
import {
  ago, onAccount, useHosts, useLaunchTargets, useLive, useSessionIndex, useSessions, useSwitchStatus, useTick, useUsage,
  type Live, type ProjectVM, type SessionIndex, type SessionVM, type TargetVM,
} from '../kit/data'
import { animateSpring, useReducedMotion } from '../kit/motion'
import {
  api, apiErrorText, fetchSessionHosts, fetchSessionList, fetchTermSessions, killTermSession, launchSessionOnHost,
  localHostname, openNewSessionHere, openSessionHere, openTermSession, setSessionsDone, startSessionOnHost,
  stopSessionOnHost, termLabel, type LaunchTarget, type SessionHost, type TermSession,
} from '../../lib/api'
import {
  BASE_AREAS, LIMITS, PROJ_KEYS, addProjReminder, addProjTab, cancelProjReminder, fetchProjDoc, fetchProjList,
  projAreasQuery, projTabItem, unlinkProjSession, updateProj, type ChecklistItem, type Exposure, type ProjectSummary,
} from '../../lib/projectsApi'
import { v2TermPath } from '../../lib/term'
import { shortName } from '../../lib/quickSessions'
import { seedTerminal } from '../../lib/sessionLaunch'
import { UploadButton } from '../kit/upload'
import {
  DueChip, LinkSessionPicker, NewProjectFlow, PIcon, ProjectNotes, ProjectSettings, SessionActions, type NoteTab, type ProjMeta,
} from './ProjectPage'
import { Accounts } from './Accounts'
import { CallView } from './Call'
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
// The picker offers these places on every device, the desktop app included:
// inside Valkyrie (the default, a tmux pane on odin running Claude on thor
// over SSH), thor's own screen (Windows Terminal on thor's desk, so the
// session lives on thor and survives a dropped connection), this screen (the
// desktop app off thor: a terminal here over SSH), and odin (Claude on odin
// itself, the backup when thor is down). A row's Open follows the same rule:
// inside Valkyrie first, the screens as second ways in.
//
// Sessions also carries the classic board's tools: every open tmux pane (Open
// terminals: reattach by its own name, close with two taps), Stop all (two
// taps, panes first, then sessions, one at a time), a long press to pick many
// rows for Mark done or Undo, Recent grouped by area in the classic board's
// order (each group folds, the folds are remembered), the done list folded
// under it with Undo per row, search over title, project and folder, and a
// link to the classic page for host health, snapshots, restore and closed
// history. A terminal is only ever opened by an explicit pane name; nothing
// here picks "the latest one". Where windows exist (the desktop app, a mouse),
// a session or a pane also opens in its own window (kit/windows.ts), and a
// project opens in its own window by default, "Open here" beside it.
// Projects: New project (a desk session sets it up, "Set up by hand" is the
// fallback form; ProjectPage.tsx), Show archived, and a project's detail that
// starts and opens its sessions, acts on them (move here, stop, done, unlink)
// and links existing ones, ticks and adds checklist items, sets and cancels
// reminders, reads the notes and links tabs, and edits every setting (name,
// next action, summary, status and restore, area, folder, exposure, session
// switches, archive). The classic project page keeps files, activity, agents
// and note editing (Open full project). /m/ai/projects?p=<id> opens a
// project's detail, /m/ai/projects?new=1 the New project sheet.

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

// The classic board's area order for sessions (components/SessionBoard.tsx
// groupByArea): work first, the host-defined areas right after it (by name),
// then server and personal, and a session with no area last. With no work
// area, the host-defined ones lead.
const CLASSIC_AREAS = ['work', 'server', 'personal']
const isNoArea = (a: string) => a === '' || a === 'other'

function sessionAreaOrder(present: Iterable<string>): string[] {
  const set = new Set(present)
  const known = CLASSIC_AREAS.filter((a) => set.has(a))
  const extra = [...set].filter((a) => !CLASSIC_AREAS.includes(a) && !isNoArea(a)).sort()
  const at = known[0] === 'work' ? 1 : 0
  return [...known.slice(0, at), ...extra, ...known.slice(at), ...[...set].filter(isNoArea)]
}

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

// Line icons kit/icons.tsx does not carry, drawn in its look (tone classes, stroke by size).
const XICONS = { popout: SquareArrowOutUpRight, fold: ChevronDown, here: PanelRightOpen } satisfies Record<string, LucideIcon>
type XIconName = keyof typeof XICONS
type AnyIconName = IconName | XIconName

function AnyIcon({ name, size = 16, tone = 'fg', glow = false, className }: {
  name: AnyIconName
  size?: number
  tone?: IconTone
  glow?: boolean
  className?: string
}) {
  if (isIconName(name)) return <Icon name={name} size={size} tone={tone} glow={glow} className={className} />
  const C = XICONS[name as XIconName]
  return <C size={size} strokeWidth={size <= 12 ? 1.8 : size <= 14 ? 1.6 : 1.4} className={cx('vl-icon', `vl-icon-${tone}`, glow && 'vl-icon-glow', className)} aria-hidden />
}

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

/** A board row: the view model and whether it is marked done. A running session marked done stays under Live until it closes (the classic board's rule). */
type Row = SessionVM & { done: boolean }

/** The conversation a pane runs: a new pane knows it from the start, a resume keeps it as its target. */
const paneSid = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

/** The v2 terminal for one pane, always by its own name. */
const termTo = (name: string, back?: string) => v2TermPath(name, back)

/** Two-tap actions (Stop all, Close, Cancel) disarm after this long. */
const ARM_MS = 4000
/** A press held this long picks the row (select mode). */
const LONG_MS = 450

/**
 * Render an input now and focus it inside the tap, or iOS keeps the keyboard
 * down. The tap's own click lands afterwards on whatever now sits under the
 * finger and would blur it, so focus once more on that click (Media's way).
 */
function openAndFocus(open: () => void, ref: RefObject<HTMLInputElement | null>) {
  flushSync(open)
  const focus = () => ref.current?.focus({ preventScroll: true })
  focus()
  const done = () => {
    window.removeEventListener('click', onClick, true)
    window.clearTimeout(t)
  }
  const onClick = () => {
    focus()
    done()
  }
  window.addEventListener('click', onClick, true)
  const t = window.setTimeout(done, 600)
}

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

/**
 * Where "open" and "new" can put a session from this device. Inside Valkyrie
 * (the in-page terminal) is the default everywhere, the desktop app included;
 * thor's screen is the second way in. `remote`: the desktop app on another
 * machine, which can also open a terminal on its own screen over SSH.
 * `windows`: the target can open in its own window (the desktop app, or a
 * browser driven by a mouse), so the pop-out actions show.
 */
type Where = { remote: boolean; here: string | null; windows: boolean }

function useWhere(): Where {
  const [here, setHere] = useState<string | null>(null)
  useEffect(() => { void localHostname().then(setHere) }, [])
  return { remote: here !== null && here !== HOME_HOST, here, windows: canDetach() }
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

function toProjRow(p: ProjectSummary): ProjRow {
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
}

function useProjectRows(): Live<ProjRow[]> {
  return useLive<ProjRow[]>(PROJ_KEY, async () => (await fetchProjList()).map(toProjRow).sort((a, b) => b.updated - a.updated), 60_000)
}

/**
 * Show archived: the list with archived projects included (the classic list's
 * own cache entry, under the list key so every list invalidation reaches it),
 * read only while the fold is open. Only the archived ones are kept.
 */
function useArchivedRows(on: boolean) {
  const q = useQuery({
    queryKey: [...PROJ_KEYS.list, 'archived'],
    queryFn: () => fetchProjList(true),
    enabled: on,
    refetchInterval: on ? 60_000 : false,
  })
  const rows = useMemo(
    () => (q.data ?? []).filter((p) => p.status === 'archived').map(toProjRow).sort((a, b) => b.updated - a.updated),
    [q.data],
  )
  return { rows, loading: on && q.data === undefined && !q.isError, error: q.isError ? errText(q.error) : null }
}

/** any session by id, with whether it is marked done (the board's rows and the index both carry it) */
type Lookup = (id: string) => Row | undefined
type Counted = ProjRow & { live: number; asking: number }

/** The board's writes, handed to a project's detail so its session rows act the board's way (optimistic, with the same rollback). */
type SessActs = {
  busy: ReadonlyMap<string, Busy>
  stop: (s: Row) => void
  done: (s: Row) => void
  undo: (s: Row) => void
}

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

/**
 * A callback ref that caps an element's height to its scrolling page, less the
 * sticky top of its parent column and a bottom gap, and keeps it there as the
 * page resizes. Measured, not 100vh: the app's zoom and the shell's header
 * both sit between the viewport and the page.
 */
function useFitToScroller(gap = 18): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null)
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.()
    cleanup.current = null
    if (!el) return
    let sc = el.parentElement
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
    if (!sc) return
    const page = sc
    const fit = () => {
      const top = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).top) || 0 : 0
      el.style.maxHeight = `${Math.max(320, page.clientHeight - top - gap)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(page)
    cleanup.current = () => {
      ro.disconnect()
      el.style.maxHeight = ''
    }
  }, [gap])
}

// ---------- the screen ----------

type UndoItem = { key: number; rows: Row[]; title: string; pending: boolean }
type Tab = 'sessions' | 'projects' | 'usage' | 'call'
type Recover = { done: number; total: number }
/** an area group of Recent shows this many rows before "Show N more": the list is the page, not a teaser */
const AREA_SHOWN = 60
/** the done fold and search results grow by this many rows a press */
const DONE_STEP = 30
const RESULTS_STEP = 40

/** One area of Recent: every row, the rows drawn (none while folded), and whether it is open. */
type AreaGroup = { area: string; rows: Row[]; shown: Row[]; open: boolean }
/** What the session list shows, by group, for the picked area. */
type Layout = { asking: Row[]; live: Row[]; recent: Row[]; areas: AreaGroup[]; done: Row[]; doneShown: Row[] }

// Folded groups (an area of Recent, Live, Open terminals), remembered on this
// device: a group he folds stays folded on the next visit.
const FOLD_KEY = 'v2.claude.folded'
const readFolded = (): ReadonlySet<string> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
const areaFold = (a: string) => `area:${a || 'other'}`

export default function Claude({ active, sub, setSub }: ScreenProps) {
  const sessions = useSessions()
  const index = useSessionIndex()
  const projects = useProjectRows()
  const hosts = useHosts()
  const now = useTick(active ? 1000 : 60_000)
  const wide = useMedia('(min-width: 640px)')
  const short = useMedia('(min-width: 640px) and (max-height: 480px)')
  const desk = useMedia('(min-width: 1200px)')
  const tab: Tab = sub === 'projects' || sub === 'usage' || sub === 'call' ? sub : 'sessions'
  // the area filter is a column beside the list (wide, not a landscape phone)
  const sideFilter = wide && !short

  const [area, setArea] = useState('all')
  const [picker, setPicker] = useState(false)
  const [projId, setProjId] = useState<string | null>(null)
  // the New project sheet, and the archived projects fold under the list
  const [newProj, setNewProj] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
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
  // the areas of Recent showing past AREA_SHOWN, and the folded groups (remembered)
  const [moreAreas, setMoreAreas] = useState<ReadonlySet<string>>(() => new Set())
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolded)
  const [undo, setUndo] = useState<UndoItem | null>(null)
  // the done fold under Recent, and how many of its rows show
  const [doneOpen, setDoneOpen] = useState(false)
  const [doneMax, setDoneMax] = useState(DONE_STEP)
  // select mode (a long press): the picked ids, null when not picking
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null)
  // Stop all: armed by the first tap for a few seconds, then the sweep's progress
  const [stopArmed, setStopArmed] = useState(false)
  const [sweep, setSweep] = useState<Recover | null>(null)
  const sweeping = useRef(false)
  // search: null = closed (the phone shows the area plates), '' = open and empty
  const [query, setQuery] = useState<string | null>(null)
  const [resultsMax, setResultsMax] = useState(RESULTS_STEP)
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = !!query && query.trim() !== ''

  // sheets, open rows and picks belong to the active tab only
  useEffect(() => {
    if (active) return
    setPicker(false)
    setNewProj(false)
    setOpenRow(null)
    setPicked(null)
    setStopArmed(false)
  }, [active])
  useEffect(() => {
    setOpenRow(null)
    setExpRow(null)
    setPicked(null)
  }, [tab, area])
  useEffect(() => {
    if (!stopArmed) return
    const t = setTimeout(() => setStopArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [stopArmed])
  // Escape leaves select mode
  useEffect(() => {
    if (!picked) return
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicked(null) }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [picked])

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
    // on Projects, ?new=1 is a new project
    if (tab === 'projects') setNewProj(true)
    else setPicker(true)
    q.delete('new')
    const rest = q.toString()
    navigate({ pathname: loc.pathname, search: rest ? `?${rest}` : '' }, { replace: true })
  }, [active, tab, loc.search, loc.pathname, navigate])
  // /m/ai/projects?p=<id>: that project's detail (the param is removed once it opens)
  useEffect(() => {
    if (!active || tab !== 'projects') return
    const q = new URLSearchParams(loc.search)
    const id = q.get('p')
    if (!id) return
    setProjId(id)
    q.delete('p')
    const rest = q.toString()
    navigate({ pathname: loc.pathname, search: rest ? `?${rest}` : '' }, { replace: true })
  }, [active, tab, loc.search, loc.pathname, navigate])

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
      const id = paneSid(t)
      if (id && !t.dead) m.set(id, t.name)
    }
    return (id: string) => m.get(id) ?? null
  }, [panes.data])

  // Every session: the in-memory index of the whole board once this page load
  // has fetched it (done ones too, no 40-row cap), the persisted 40 newest open
  // ones until then. A done or undo still in flight overrides the board.
  const source = useMemo<Row[] | undefined>(() => {
    if (index.ready) {
      const out: Row[] = []
      for (const s of index.byId.values()) {
        const d = dispo.get(s.id)
        out.push(d === undefined || d === s.done ? s : { ...s, done: d })
      }
      return out.sort((a, b) => b.last - a.last)
    }
    return sessions.data?.map((s): Row => ({ ...s, done: dispo.get(s.id) ?? false }))
  }, [index.ready, index.byId, sessions.data, dispo])
  const hasBoard = source !== undefined

  // the board with stops that have not reached it yet
  const board = useMemo(() => (source ?? [])
    .map((s): Row => (stopped.has(s.id) ? { ...s, activity: 'closed', live: false } : s)), [source, stopped])
  // on the list: everything not done, and anything still running
  const openRows = useMemo(() => board.filter((s) => !s.done || isLive(s)), [board])
  const doneRows = useMemo(() => board.filter((s) => s.done && !isLive(s)), [board])

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
  const live = openRows.filter(isLive).length
  const asking = openRows.filter((s) => s.activity === 'asking').length

  // any session by id: the board (done ones too once the index is in), then the index
  const lookup = useMemo<Lookup>(() => {
    const all = new Map(board.map((s) => [s.id, s]))
    return (id) => all.get(id) ?? (index.ready ? index.byId.get(id) : undefined)
  }, [board, index.ready, index.byId])
  // what the board calls each conversation, so a pane reads as its session rather than its launch target
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of board) if (s.title) m.set(s.id, s.title)
    return m
  }, [board])

  const projList = useMemo(() => (projects.data ?? []).map((p) => countProject(p, lookup)), [projects.data, lookup])
  const archived = useArchivedRows(showArchived && tab === 'projects')
  const archList = useMemo(() => (showArchived ? archived.rows.map((p) => countProject(p, lookup)) : []), [showArchived, archived.rows, lookup])
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
  // Sessions keep the classic board's area order, so the filter and the groups read the same way down
  const sessOrder = useMemo(() => sessionAreaOrder(openRows.map((s) => s.area)), [openRows])
  const areas = useMemo(
    () => (tab === 'sessions' ? areaItems(openRows.map((s) => s.area), sessOrder) : areaItems(projList.map((p) => p.area), areaOrder)),
    [tab, openRows, projList, areaOrder, sessOrder],
  )
  // a filter that empties out (the last session of an area marked done) falls back to All
  const shownArea = areas.some((a) => a.id === area) ? area : 'all'
  const pickArea = (id: string) => setArea((cur) => (cur === id && id !== 'all' ? 'all' : id))
  // never show "All 0" before the first data
  const showFilter = tab === 'sessions' ? hasBoard : !!projects.data

  const layout = useMemo<Layout>(() => {
    const inArea = (s: Row) => shownArea === 'all' || s.area === shownArea
    const liveRows = openRows.filter((s) => isLive(s) && inArea(s))
      .sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity] || b.last - a.last)
    const recent = openRows.filter((s) => !isLive(s) && inArea(s)).sort((a, b) => b.last - a.last)
    const done = doneRows.filter(inArea)
    // Recent by area, the classic board's grouping and order; newest first inside each
    const byArea = new Map<string, Row[]>()
    for (const s of recent) {
      const held = byArea.get(s.area)
      if (held) held.push(s)
      else byArea.set(s.area, [s])
    }
    const areaGroups = sessionAreaOrder(byArea.keys()).map((a): AreaGroup => {
      const rows = byArea.get(a) ?? []
      const open = !folded.has(areaFold(a))
      return { area: a, rows, open, shown: !open ? [] : moreAreas.has(a) ? rows : rows.slice(0, AREA_SHOWN) }
    })
    return {
      asking: liveRows.filter((s) => s.activity === 'asking'),
      live: liveRows.filter((s) => s.activity !== 'asking'),
      recent,
      areas: areaGroups,
      done,
      doneShown: doneOpen ? done.slice(0, doneMax) : [],
    }
  }, [openRows, doneRows, shownArea, folded, moreAreas, doneOpen, doneMax])

  // Search: title, project and folder, across every session the board knows
  // (done ones too) and every area. The folder (cwd) is only in the board's
  // full list, read once a search starts and shared with the classic board's cache.
  const folders = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, enabled: searching, staleTime: 60_000, refetchInterval: false })
  const cwdOf = useMemo(() => {
    const m = new Map<string, string>()
    const d = folders.data
    if (d?.installed) for (const s of d.sessions) if (s.cwd) m.set(s.sessionId, s.cwd)
    return m
  }, [folders.data])
  const results = useMemo(() => {
    if (!searching || !query) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return board.filter((s) => {
      const hay = `${s.title}\n${s.project}\n${cwdOf.get(s.id) ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [searching, query, board, cwdOf])
  const resultsShown = useMemo(() => results.slice(0, resultsMax), [results, resultsMax])

  // Every row drawn right now: what "All N" picks, and what a pick can act on.
  const liveOpen = !folded.has('live')
  const onScreen = useMemo(
    () => (searching
      ? resultsShown
      : [...layout.asking, ...(liveOpen ? layout.live : []), ...layout.areas.flatMap((g) => g.shown), ...layout.doneShown]),
    [searching, resultsShown, layout, liveOpen],
  )
  const pickedRows = picked ? onScreen.filter((s) => picked.has(s.id)) : []
  const pickedOpen = pickedRows.filter((s) => !s.done)
  const pickedDone = pickedRows.filter((s) => s.done)

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
  const titleFor = (rows: Row[]) => (rows.length === 1 ? nameOf(rows[0]) : `${rows.length} sessions`)

  // Done moves the rows to the done list at once and offers Undo; a refusal brings them back.
  const markDone = (rows: Row[]) => {
    const list = rows.filter((s) => !busyRef.current.has(s.id) && !s.done)
    if (!list.length) return
    const ids = list.map((s) => s.id)
    const title = titleFor(list)
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
  // Undo, from the bar, a done row or a pick: back on the list at once; a refusal sends them back to done.
  const putBack = (rows: Row[]) => {
    const list = rows.filter((s) => !busyRef.current.has(s.id))
    if (!list.length) return
    const ids = list.map((s) => s.id)
    const title = titleFor(list)
    captureFlip()
    setOpenRow(null)
    setExpRow(null)
    setDispoFor(ids, false)
    setRowBusy(ids, 'done')
    setUndo((u) => (u && u.rows.some((r) => ids.includes(r.id)) ? null : u))
    void sendDone(list, false).then(({ failed, error }) => {
      setRowBusy(ids, null)
      if (failed.length) {
        captureFlip()
        setDispoFor(failed, true)
        toast(`Could not put ${title} back: ${errText(error)}`, { ms: 5000 })
      }
      refreshBoard()
    })
  }
  const undoDone = () => {
    if (!undo || undo.pending) return
    putBack(undo.rows)
  }

  // Stop closes the row at once; a refusal brings it back. 404 means nothing
  // runs under that id any more: it exited before the board noticed.
  const stop = (s: Row) => {
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

  // Stop all, the classic board's sweep: the in-page panes first (closing one
  // ends its Claude, so the session sweep behind it meets a harmless 404),
  // then the sessions, ONE AT A TIME: an elevated stop goes through thor's
  // single kill-request file, so two in flight would drop one. A 404 is not a
  // failure: the lists are polls, so something that already exited still shows.
  const stopAll = async (rows: Row[], terms: TermSession[]) => {
    const total = rows.length + terms.length
    if (sweeping.current || !total) return
    sweeping.current = true
    setStopArmed(false)
    setOpenRow(null)
    setExpRow(null)
    setSweep({ done: 0, total })
    const step = () => setSweep((v) => v && { ...v, done: v.done + 1 })
    let failed = 0
    let error: unknown = null
    const markStopped = (id: string) => {
      captureFlip()
      setStopped((m) => new Map(m).set(id, Date.now()))
    }
    for (const t of terms) {
      try {
        await killTermSession(t.name)
      } catch (e) {
        if (httpStatus(e) !== 404) {
          failed += 1
          error ??= e
        }
      }
      step()
    }
    for (const s of rows) {
      if (busyRef.current.has(s.id)) {
        step()
        continue
      }
      setRowBusy([s.id], 'stop')
      try {
        const r = await stopSessionOnHost(s.id, s.host)
        if (r && r.ok === false) throw new Error(r.detail ?? `${s.host} refused`)
        markStopped(s.id)
      } catch (e) {
        if (httpStatus(e) === 404) markStopped(s.id)
        else {
          failed += 1
          error ??= e
        }
      }
      setRowBusy([s.id], null)
      step()
    }
    sweeping.current = false
    setSweep(null)
    refreshBoard()
    void qc.invalidateQueries({ queryKey: TERMS_KEY })
    if (failed) toast(`${failed} of ${total} did not stop: ${errText(error)}`, { ms: 5000 })
    else toast(`Stopped ${total}`)
  }

  // Open, the board's way: back into its pane if one runs it, never a second
  // Claude on a running session, otherwise resume on the machine that holds
  // the transcript: thor's sessions inside Valkyrie (on every device, the
  // desktop app included), any other host's on that host's screen. `how`:
  // this page, or the pane in its own window (kit/windows.ts).
  const openSession = async (s: Row, how: 'page' | 'window' = 'page') => {
    if (busyRef.current.has(s.id)) return
    const title = nameOf(s)
    const land = (name: string) => {
      if (how === 'window') openDetached({ kind: 'session', name, title: s.title || undefined })
      else navigate(termTo(name))
    }
    setRowBusy([s.id], 'open')
    try {
      const pane = paneFor(await freshPanes(qc), s.id)
      if (pane) {
        land(pane)
        return
      }
      if (s.live) {
        toast(`${title} is running on ${hostLabel(s.host)}. Stop it to open it here.`, { ms: 4000 })
        return
      }
      if (s.host !== HOME_HOST) {
        await launchOn(s.id, s.host)
        toast(`Opened ${title} on ${hostLabel(s.host)}`)
        return
      }
      const r = await openTermSession({ mode: 'resume', sessionId: s.id, label: s.title })
      seedTerminal(qc, r)
      land(r.name)
    } catch (e) {
      toast(`Could not open ${title}: ${errText(e)}`, { ms: 5000 })
    } finally {
      setRowBusy([s.id], null)
      refreshBoard()
    }
  }

  // The desktop app off thor: a terminal on this machine's own screen,
  // resuming over SSH to thor, in the session's own Windows Terminal window.
  const openLocal = async (s: Row) => {
    if (busyRef.current.has(s.id)) return
    const title = nameOf(s)
    setRowBusy([s.id], 'open')
    try {
      if (paneFor(await freshPanes(qc), s.id)) {
        toast(`${title} is open in a terminal in Valkyrie. Close it first.`, { ms: 4000 })
        return
      }
      await openSessionHere(s.id, undefined, (await launchGroups(qc)).get(s.id) ?? null)
      toast(`Opened ${title} on this screen`)
    } catch (e) {
      toast(`Could not open ${title} on this screen: ${errText(e)}`, { ms: 5000 })
    } finally {
      setRowBusy([s.id], null)
      refreshBoard()
    }
  }

  // Resume on thor's own screen (Windows Terminal on its desk) from the page or
  // another machine: the session then lives on thor and outlasts this connection.
  const openOnScreen = async (s: Row) => {
    if (busyRef.current.has(s.id)) return
    const title = nameOf(s)
    const home = hostLabel(HOME_HOST)
    setRowBusy([s.id], 'open')
    try {
      if (paneFor(await freshPanes(qc), s.id)) {
        toast(`${title} is open in a terminal in Valkyrie. Close it first.`, { ms: 4000 })
        return
      }
      await launchOn(s.id, HOME_HOST)
      toast(`Opened ${title} on ${home}'s screen`)
    } catch (e) {
      toast(`Could not open ${title} on ${home}'s screen: ${errText(e)}`, { ms: 5000 })
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

  // New session in the way picked (TargetPicker): inside Valkyrie, a pane the
  // page attaches to (the default on every device, the desktop app included);
  // this screen over SSH (the desktop app off thor); otherwise the host's own
  // launcher agent opens it on its screen (thor's screen, or another host's).
  const startNew = (t: TargetVM, h: SessionHost, way: Way, slot: string) => {
    const name = hostLabel(h.host)
    const thorScreen = way === 'screen' && h.host === HOME_HOST
    const fail = thorScreen ? `Could not open ${t.label} on ${name}'s screen` : `Could not start ${t.label} on ${name}`
    return launch(`${slot}:${t.key}`, fail, async () => {
      if (way === 'page') {
        const r = await openTermSession({ mode: 'new', target: t.key, label: t.label })
        seedTerminal(qc, r)
        setPicker(false)
        navigate(termTo(r.name))
        return
      }
      if (way === 'here') {
        await openNewSessionHere(t.key, undefined, t.group)
        toast(`${t.label} opened on this screen`)
      } else {
        const r = await startSessionOnHost(h.host, t.key)
        if (!r.ok) throw new Error(r.detail ?? 'could not start it')
        toast(thorScreen ? `${t.label} opened on ${name}'s screen` : `${t.label} started on ${name}`)
      }
      setPicker(false)
      // Claude takes a moment to register, so give the board something to find
      setTimeout(refreshBoard, 2_500)
    })
  }

  // Odin, the backup: Claude runs on odin itself, in a pane the terminal page
  // attaches to like any other.
  const startOnOdin = (t: TargetVM) => launch(`${ODIN_SLOT}:${t.key}`, `Could not start ${t.label} on ${hostLabel(BACKUP_HOST)}`, async () => {
    const r = await openTermSession({ mode: 'new', host: 'odin', target: t.key, label: t.label, ...phoneGrid() })
    seedTerminal(qc, r)
    setPicker(false)
    navigate(termTo(r.name))
  })
  const toggleRow = useCallback((id: string) => {
    captureFlip()
    setOpenRow(null)
    setExpRow((cur) => (cur === id ? null : id))
  }, [captureFlip])
  // fold or unfold a group; the folds persist on this device
  const toggleFold = (key: string) => {
    captureFlip()
    setOpenRow(null)
    setExpRow(null)
    setFolded((cur) => {
      const n = new Set(cur)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...n])) } catch { /* storage full or off */ }
      return n
    })
  }
  const toggleMore = (area: string) => {
    captureFlip()
    setMoreAreas((cur) => {
      const n = new Set(cur)
      if (n.has(area)) n.delete(area)
      else n.add(area)
      return n
    })
  }
  const toggleDone = () => {
    captureFlip()
    setDoneOpen((v) => !v)
    setDoneMax(DONE_STEP)
  }

  // select mode: a long press starts it on that row, a tap toggles, the last unpick ends it
  const pickStart = (id: string) => {
    setOpenRow(null)
    setExpRow(null)
    setPicked(new Set([id]))
  }
  const pickToggle = (id: string) => setPicked((cur) => {
    const n = new Set(cur ?? [])
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n.size ? n : null
  })

  // search opens in the tap (the phone's keyboard comes up), and closes back to the plates
  const openSearch = () => openAndFocus(() => {
    setQuery((q) => q ?? '')
    setPicked(null)
  }, searchRef)
  const setSearch = (v: string) => {
    setQuery(v)
    setResultsMax(RESULTS_STEP)
  }
  const closeSearch = () => {
    setQuery(null)
    setResultsMax(RESULTS_STEP)
  }

  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(t)
  }, [undo])

  // Stop all covers what the list shows for this area: its running rows, and
  // the live panes (every one under All; under an area, the panes running one
  // of that area's sessions). Closing a pane and its own row counts twice on
  // purpose: they are two things on the screen, and the second is a no-op 404.
  const livePanes = useMemo(() => (panes.data ?? []).filter((t) => !t.dead), [panes.data])
  const stopRows = useMemo(() => [...layout.asking, ...layout.live], [layout])
  const stopPanes = useMemo(
    () => (shownArea === 'all' ? livePanes : livePanes.filter((t) => {
      const id = paneSid(t)
      return !!id && lookup(id)?.area === shownArea
    })),
    [livePanes, shownArea, lookup],
  )
  const stopAllVM: StopAllVM = {
    n: stopRows.length + stopPanes.length,
    armed: stopArmed,
    sweep,
    disabled: recover !== null,
    onPress: () => (stopArmed ? void stopAll(stopRows, stopPanes) : setStopArmed(true)),
  }

  const rowCtx: RowCtx = {
    now,
    showArea: shownArea === 'all',
    hostLabel,
    openRow,
    setOpenRow,
    expRow,
    onToggle: toggleRow,
    rowEls: rowEls.current,
    busy,
    paneOf,
    where,
    picked,
    onPick: pickToggle,
    onPickStart: pickStart,
    onOpen: (s) => void openSession(s),
    onWindow: (s) => void openSession(s, 'window'),
    onScreen: (s) => void openOnScreen(s),
    onLocal: (s) => void openLocal(s),
    onDone: (s) => markDone([s]),
    onUndo: (s) => putBack([s]),
    onStop: stop,
  }

  // desktop shows a third column beside Projects: the project opened here (the
  // most urgent one until he picks another). Sessions has no projects at all.
  const areaProjects = useMemo(
    () => (shownArea === 'all' ? projList : projList.filter((p) => p.area === shownArea)).slice().sort(byUrgency),
    [projList, shownArea],
  )
  const pickedProj = projId ? projList.find((p) => p.id === projId) ?? archList.find((p) => p.id === projId) ?? null : null
  const inlineDetail = desk && tab === 'projects'
  const inArea = (p: ProjectVM) => shownArea === 'all' || p.area === shownArea
  const detail = inlineDetail ? (pickedProj && inArea(pickedProj) ? pickedProj : areaProjects[0] ?? null) : null
  // Where windows exist a project opens in its own window, "Open here" beside
  // it shows it in this page (the column on desktop, a sheet elsewhere); a
  // touch screen opens it here.
  // An archived project opens here (it is opened to restore it).
  const openProjHere = (p: ProjectVM) => setProjId(p.id)
  const openProj = (p: ProjectVM) => (where.windows ? openDetached({ kind: 'project', id: p.id }) : openProjHere(p))
  const projHere = where.windows ? openProjHere : undefined
  // a project made by hand opens at once (the list refetch brings its row)
  const projCreated = (id: string) => {
    setNewProj(false)
    void qc.invalidateQueries({ queryKey: ['v2', PROJ_KEY] })
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
    setProjId(id)
  }
  const sessActs: SessActs = { busy, stop, done: (s) => markDone([s]), undo: (s) => putBack([s]) }
  const startNewProject = () => setNewProj(true)
  // desktop: the open project's panel fits the page and scrolls inside, so the list stays put beside it
  const fitDetail = useFitToScroller()

  const areaFilter = <AreaFilter items={areas} value={shownArea} onChange={pickArea} vertical={sideFilter} />
  const searchLine = (
    <SearchLine
      value={query ?? ''}
      onChange={setSearch}
      onClose={closeSearch}
      closable={!sideFilter}
      inputRef={searchRef}
      note={searching && !index.ready ? 'newest 40 until the board loads' : null}
    />
  )
  // Sessions on the phone: a search plate leads the area plates and opens the
  // search line in their place. Wide: the search line sits over the list.
  const filter = showFilter && (
    tab === 'sessions' && !sideFilter ? (
      query !== null ? searchLine : (
        <div className="vc-findrow">
          <Press className="vc-fplate vc-find vl-build" style={iv(3)} aria-label="Search sessions" title="Search sessions" onPress={openSearch}>
            <Icon name="search" size={15} tone="dim" />
          </Press>
          {areaFilter}
        </div>
      )
    ) : areaFilter
  )

  return (
    <div className="vc-root">
      {tab === 'call' ? <CallView active={active} /> : tab === 'usage' ? <UsageView now={now} /> : (
        <div className="vc" data-detail={inlineDetail || undefined} data-fab={!wide || undefined} data-proj={tab === 'projects' || undefined}>
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
              onNew={wide ? (tab === 'projects' ? startNewProject : () => setPicker(true)) : undefined}
              onUsage={() => setSub('usage')}
            />
            {!short && filter}
          </aside>

          <main className="vc-main">
            {short && filter && <div className="vc-filter-top">{filter}</div>}
            {tab === 'sessions' && sideFilter && hasBoard && searchLine}
            {tab === 'sessions' ? (
              hasBoard ? (
                <SessionBoard
                  layout={layout}
                  results={searching ? { all: results.length, shown: resultsShown, folders: folders.isFetching && !folders.data } : null}
                  onMoreResults={() => setResultsMax((m) => m + RESULTS_STEP)}
                  area={shownArea}
                  ctx={rowCtx}
                  terms={panes.data ?? []}
                  titles={titles}
                  stopAll={stopAllVM}
                  folded={folded}
                  onFold={toggleFold}
                  moreAreas={moreAreas}
                  onToggleMore={toggleMore}
                  doneOpen={doneOpen}
                  onToggleDone={toggleDone}
                  onMoreDone={() => setDoneMax((m) => m + DONE_STEP)}
                  recover={recover}
                  sweeping={sweep !== null}
                  onRecover={(rows) => void recoverDesk(rows)}
                  onReattach={(name) => navigate(termTo(name))}
                  onTermWindow={where.windows ? (t, label) => openDetached({ kind: 'session', name: t.name, title: label }) : undefined}
                  onTermClosed={() => {
                    void qc.invalidateQueries({ queryKey: TERMS_KEY })
                    refreshBoard()
                  }}
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
                </>
              )
            ) : (
              <>
                <ProjectBoard
                  list={projList}
                  area={shownArea}
                  loading={!projects.data}
                  failed={projects.failed}
                  error={projects.error}
                  now={now}
                  selected={desk ? detail?.id ?? null : null}
                  onOpen={openProj}
                  onHere={projHere}
                />
                {projects.data && (
                  <ArchivedFold
                    on={showArchived}
                    onToggle={() => setShowArchived((v) => !v)}
                    list={archList}
                    loading={archived.loading}
                    error={archived.error}
                    area={shownArea}
                    now={now}
                    selected={desk ? detail?.id ?? null : pickedProj?.id ?? null}
                    onOpen={openProjHere}
                  />
                )}
              </>
            )}
          </main>

          {inlineDetail && detail && (
            <aside className="vc-detail">
              <div className="vc-detail-card vl-panel vl-build-on" key={detail.id} ref={fitDetail}>
                <div className="vc-detail-head vl-build" style={iv(0)}>
                  <Icon name="projects" size={18} tone="fg" glow />
                  <span className="vc-detail-name">{detail.name}</span>
                </div>
                <ProjectDetail
                  p={detail}
                  index={index}
                  lookup={lookup}
                  now={now}
                  hostLabel={hostLabel}
                  acts={sessActs}
                  onArchived={() => { if (!showArchived) setProjId(null) }}
                  onWindow={where.windows ? () => openDetached({ kind: 'project', id: detail.id }) : undefined}
                  showArea
                />
              </div>
            </aside>
          )}
        </div>
      )}

      {/* bottom of the page: the pick bar, the undo bar, or (phone) New session in thumb reach */}
      <div className="vc-undo-anchor" aria-live="polite">
        {picked && active && tab === 'sessions' ? (
          <SelectBar
            n={pickedRows.length}
            open={pickedOpen.length}
            done={pickedDone.length}
            all={onScreen.length}
            onAll={() => setPicked(new Set(onScreen.map((s) => s.id)))}
            onMark={() => {
              markDone(pickedOpen)
              setPicked(null)
            }}
            onUndo={() => {
              putBack(pickedDone)
              setPicked(null)
            }}
            onCancel={() => setPicked(null)}
          />
        ) : undo && active ? (
          <div className="vc-undo" key={undo.key}>
            <Icon name="done" size={14} tone="dim" />
            <span className="vc-undo-text">Done: <b>{undo.title}</b></span>
            <Press className="vc-undo-btn" disabled={undo.pending} onPress={undoDone}><Icon name="undo" size={15} tone="hot" />Undo</Press>
          </div>
        ) : !wide && tab === 'projects' ? (
          <NewButton className="vc-fab" label="New project" onPress={startNewProject} />
        ) : !wide && tab === 'sessions' ? (
          <NewButton className="vc-fab" onPress={() => setPicker(true)} />
        ) : null}
      </div>

      <Sheet open={picker && active} onClose={() => { setPicker(false); setStartErr(null) }} label="New session" icon="start">
        <TargetPicker
          area={shownArea}
          hostLabel={hostLabel}
          where={where}
          roomy={wide}
          starting={starting}
          error={startErr}
          onPick={(t, h, way, slot) => void startNew(t, h, way, slot)}
          onOdin={(t) => void startOnOdin(t)}
        />
      </Sheet>

      <Sheet
        open={!inlineDetail && !!pickedProj && active}
        onClose={() => setProjId(null)}
        label={pickedProj?.name ?? ''}
        icon="projects"
        value={pickedProj ? areaName(pickedProj.area) : ''}
      >
        {pickedProj && (
          <ProjectDetail
            p={pickedProj}
            index={index}
            lookup={lookup}
            now={now}
            hostLabel={hostLabel}
            acts={sessActs}
            onArchived={() => { if (!showArchived) setProjId(null) }}
            onWindow={where.windows ? () => {
              openDetached({ kind: 'project', id: pickedProj.id })
              setProjId(null)
            } : undefined}
          />
        )}
      </Sheet>

      <Sheet open={newProj && active} onClose={() => setNewProj(false)} label="New project" icon="projects">
        <NewProjectFlow area={shownArea} onCreated={projCreated} onLeave={() => setNewProj(false)} />
      </Sheet>
    </div>
  )
}

/** The pick bar (select mode): how many, Mark done for the open ones, Undo for the done ones, pick all, stop picking. */
function SelectBar({ n, open, done, all, onAll, onMark, onUndo, onCancel }: {
  n: number
  open: number
  done: number
  all: number
  onAll: () => void
  onMark: () => void
  onUndo: () => void
  onCancel: () => void
}) {
  return (
    <div className="vc-selbar" role="toolbar" aria-label="Picked sessions" data-no-swipe>
      <Press className="vc-selbar-x" aria-label="Stop picking" title="Stop picking" onPress={onCancel}>
        <Icon name="stop" size={16} tone="dim" />
      </Press>
      {/* the word goes when both Undo and Mark need the room */}
      <span className="vc-selbar-n"><b>{n}</b>{done > 0 && open > 0 ? '' : ' picked'}</span>
      {all > n && <Press className="vc-selbar-btn" onPress={onAll}>All {all}</Press>}
      {done > 0 && (
        <Press className="vc-selbar-btn" onPress={onUndo}><Icon name="undo" size={14} tone="fg" />Undo {done}</Press>
      )}
      {open > 0 && (
        <Press className="vc-selbar-btn" data-main onPress={onMark}><Icon name="done" size={14} tone="ink" />Mark {open} done</Press>
      )}
    </div>
  )
}

/** The search line: title, project and folder. On the phone it closes back to the area plates. */
function SearchLine({ value, onChange, onClose, closable, inputRef, note }: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
  /** the phone: an X that closes the line even when empty */
  closable: boolean
  inputRef: RefObject<HTMLInputElement | null>
  note: string | null
}) {
  return (
    <div className="vc-search vl-build" style={iv(3)} data-no-swipe>
      <Icon name="search" size={16} tone={value ? 'fg' : 'dim'} glow={!!value} className="vc-search-icon" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        placeholder="Search title, project, folder"
        aria-label="Search sessions"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {note && <span className="vc-search-note">{note}</span>}
      {(value || closable) && (
        <Press className="vc-search-x" aria-label={closable ? 'Close search' : 'Clear search'} onPress={() => (closable ? onClose() : onChange(''))}>
          <Icon name="stop" size={15} tone="dim" />
        </Press>
      )}
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

/** The primary action: a solid lit plate with the start icon (New session, or New project on Projects). */
function NewButton({ onPress, className, label = 'New session' }: { onPress: () => void; className?: string; label?: string }) {
  return (
    <Press className={cx('vl-btn vc-new', className)} onPress={onPress}>
      <Icon name={label === 'New session' ? 'start' : 'add'} size={16} tone="ink" />
      {label}
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
      {/* one dash, a digit's width: the plate does not grow or wrap while the count loads */}
      <b>{value ?? '-'}</b>
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
            {/* pictures to thor for a session: the Dashboard's upload queue (kit/upload.tsx), toasts here */}
            <UploadButton />
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
      {onNew && <div className="vc-new-row vl-build" style={iv(1)}><NewButton onPress={onNew} label={sess ? undefined : 'New project'} /></div>}
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
  const sw = useSwitchStatus()
  const u = usage.data
  // the account thor runs on now, not the hottest; hottest is the fallback
  const on = onAccount(u, sw.data, 'thor')
  const dead = (u?.accounts ?? []).filter((a) => a.dead)
  const high = usageHigh(on.five) || usageHigh(on.week)
  const fiveAt = resetAt(on.fiveResetsAt, now)
  const weekAt = resetAt(on.weekResetsAt, now)
  return (
    <Press
      className="vc-week vl-panel vl-build"
      style={iv(2)}
      onPress={onOpen}
      aria-label={`AI usage${u ? `, ${on.label ?? 'no account'}: 5 hours ${on.five ?? 'unknown'}%, week ${on.week ?? 'unknown'}%` : ''}. Open Usage`}
    >
      <span className="vc-week-head">
        <Icon name="gauge" size={14} tone={high ? 'acc2' : 'dim'} glow={high} />
        <span className="vc-week-label">Usage</span>
        <span className="vc-acct">{on.label ?? '--'}{on.source === 'hottest' && on.label ? <i className="vc-acct-hot"> busiest</i> : null}</span>
        <Icon name="go" size={12} tone="dim" className="vc-week-go" />
      </span>
      <span className="vc-mini">
        <MiniMeter label="5h" value={on.five} ticks={5} />
        <MiniMeter label="Week" value={on.week} ticks={7} />
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
 * AI > Usage: the account thor is on now (from the switcher), its 5-hour and
 * week windows as two big meters with their resets, then every account, hottest
 * first, signed-out ones flagged, each with its own windows, resets and sign-in
 * address (with a copy button). The headline falls back to the hottest account
 * when the switcher is not installed or has not taken thor over. Reads only.
 */
function UsageView({ now }: { now: number }) {
  const usage = useUsage()
  const sw = useSwitchStatus()
  const u = usage.data
  // the headline is the account thor runs on now; the hottest account is the fallback
  const on = onAccount(u, sw.data, 'thor')
  // the account the headline numbers belong to, so its row reads as the active one
  const onId = on.source === 'host' ? sw.data?.hosts.thor?.active?.id ?? null : u?.accounts.find((a) => !a.dead)?.id ?? null
  const live = u?.accounts.filter((a) => !a.dead).length ?? 0
  const dead = (u?.accounts.length ?? 0) - live
  return (
    <div className="vc-usage">
      <section className="vc-u-top vl-panel vl-build" style={iv(0)} aria-label={on.source === 'host' ? 'Account thor is on' : 'Busiest account'}>
        <header className="vc-u-head">
          <Icon name="gauge" size={15} tone={usageHigh(on.five) || usageHigh(on.week) ? 'acc2' : 'fg'} glow={!!u} />
          <span className="vc-u-label">{on.source === 'host' ? 'thor is on' : 'Usage'}</span>
          <span className="vc-acct">{u ? on.label ?? 'no live account' : ''}{on.source === 'hottest' && on.label ? <i className="vc-acct-hot"> busiest{on.note ? `, ${on.note}` : ''}</i> : null}</span>
          <Fresh q={usage} label="usage" now={now} />
        </header>
        {u ? (
          <div className="vc-u-big">
            <BigMeter label="5 hours" value={on.five} ticks={5} reset={resetAt(on.fiveResetsAt, now)} />
            <BigMeter label="Week" value={on.week} ticks={7} reset={resetAt(on.weekResetsAt, now)} />
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
              <div key={a.id} className="vc-u-row vl-build" style={iv(2 + k)} data-dead={a.dead || undefined} data-top={(!a.dead && a.id === onId) || undefined}>
                <span className="vc-u-name">
                  <span className="vl-ellipsis">{a.label}</span>
                  {a.email ? <AcctEmail email={a.email} /> : null}
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
      <Accounts now={now} />
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

/** An account's sign-in address with a copy button. Copies with the clipboard API and the
 *  execCommand fallback (plain http on the phone and WebView2 have no secure clipboard). */
function AcctEmail({ email }: { email: string }) {
  const copy = () => {
    void copyText(email).then((ok) => toast(ok ? `Copied ${email}` : `Copy failed. ${email}`))
  }
  return (
    <span className="vc-u-email">
      <span className="vl-ellipsis">{email}</span>
      <Press className="vc-u-copy vl-hit" onPress={copy} aria-label={`Copy ${email}`} title="Copy email">
        <Icon name="copy" size={12} tone="dim" />
      </Press>
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

/**
 * A section header: icon, label and count on a hairline; an optional action
 * on the right. With `fold`, the label side is a button that folds the group
 * (a chevron leads it, turned while folded).
 */
function GroupHead({ icon, tone = 'dim', glow = false, label, n, i, fold, children }: {
  icon: IconName
  tone?: IconTone
  glow?: boolean
  label: ReactNode
  n: ReactNode
  i?: number
  fold?: { open: boolean; onToggle: () => void }
  children?: ReactNode
}) {
  const inner = (
    <>
      {fold && <AnyIcon name="fold" size={13} tone="dim" className="vc-ghead-chev" />}
      <Icon name={icon} size={14} tone={tone} glow={glow} />
      <span className="vc-ghead-t">{label}</span>
      <span className="vc-ghead-n">{n}</span>
    </>
  )
  return (
    <header className={cx('vc-ghead', i !== undefined && 'vl-build')} style={i !== undefined ? iv(i) : undefined} data-folded={(fold && !fold.open) || undefined}>
      {fold ? (
        <Press
          className="vc-ghead-l vc-ghead-fold"
          aria-expanded={fold.open}
          title={fold.open ? 'Fold this group' : 'Show this group'}
          onPress={fold.onToggle}
        >
          {inner}
        </Press>
      ) : (
        <span className="vc-ghead-l">{inner}</span>
      )}
      {children}
    </header>
  )
}

const GROUP_ICON: Record<string, { icon: IconName; tone: IconTone; glow: boolean }> = {
  asking: { icon: 'asking', tone: 'acc2', glow: true },
  live: { icon: 'working', tone: 'fg', glow: true },
  recent: { icon: 'clock', tone: 'dim', glow: false },
}

/** What every session row needs from the screen. */
type RowCtx = {
  now: number
  /** the area filter is on All, so each row names its area */
  showArea: boolean
  hostLabel: (id: string) => string
  openRow: string | null
  setOpenRow: (id: string | null) => void
  expRow: string | null
  onToggle: (id: string) => void
  rowEls: Map<string, HTMLElement>
  busy: ReadonlyMap<string, Busy>
  paneOf: (id: string) => string | null
  where: Where
  /** select mode: the picked ids; null when not picking */
  picked: ReadonlySet<string> | null
  onPick: (id: string) => void
  onPickStart: (id: string) => void
  /** inside Valkyrie, this page */
  onOpen: (s: Row) => void
  /** inside Valkyrie, in its own window */
  onWindow: (s: Row) => void
  /** thor's own screen */
  onScreen: (s: Row) => void
  /** this machine's screen over SSH (the desktop app off thor) */
  onLocal: (s: Row) => void
  onDone: (s: Row) => void
  onUndo: (s: Row) => void
  onStop: (s: Row) => void
}

/** Stop all on a group header: armed by the first tap, fired by the second. */
type StopAllVM = { n: number; armed: boolean; sweep: Recover | null; disabled: boolean; onPress: () => void }

function StopAllButton({ vm }: { vm: StopAllVM }) {
  if (vm.n === 0 && !vm.sweep) return null
  return (
    <Press
      className="vc-ghead-act"
      data-tone="acc2"
      data-armed={vm.armed || undefined}
      data-busy={vm.sweep ? '' : undefined}
      disabled={vm.sweep !== null || vm.disabled}
      title={vm.armed
        ? `Tap again to stop all ${vm.n}`
        : 'Close every terminal open in the page, then stop every running session. Transcripts are kept, so each one reopens later.'}
      onPress={vm.onPress}
    >
      <Icon name={vm.sweep ? 'refresh' : 'stop'} size={13} tone="acc2" className={vm.sweep ? 'vl-pulse' : undefined} />
      {vm.sweep ? `Stopping ${vm.sweep.done}/${vm.sweep.total}` : vm.armed ? `Stop all ${vm.n}?` : `Stop all ${vm.n}`}
    </Press>
  )
}

function SessionBoard({
  layout, results, onMoreResults, area, ctx, terms, titles, stopAll, folded, onFold, moreAreas, onToggleMore,
  doneOpen, onToggleDone, onMoreDone, recover, sweeping, onRecover, onReattach, onTermWindow, onTermClosed,
}: {
  layout: Layout
  /** a search is on: its matches replace the groups */
  results: { all: number; shown: Row[]; folders: boolean } | null
  onMoreResults: () => void
  area: string
  ctx: RowCtx
  /** every tmux pane (the ['term','sessions'] list) */
  terms: TermSession[]
  titles: Map<string, string>
  stopAll: StopAllVM
  /** the folded groups: 'terms', 'live', and areaFold(area) for each area of Recent */
  folded: ReadonlySet<string>
  onFold: (key: string) => void
  /** the areas of Recent showing past AREA_SHOWN */
  moreAreas: ReadonlySet<string>
  onToggleMore: (area: string) => void
  doneOpen: boolean
  onToggleDone: () => void
  onMoreDone: () => void
  recover: Recover | null
  sweeping: boolean
  onRecover: (rows: SessionVM[]) => void
  onReattach: (name: string) => void
  /** where windows exist: a pane in its own window */
  onTermWindow?: (t: TermSession, label: string) => void
  onTermClosed: () => void
}) {
  const { openRow, setOpenRow, rowEls, busy, hostLabel, where } = ctx
  const { asking, live, recent, areas, done, doneShown } = layout
  // recover my desk: open, not running, on thor, and no write of its own in flight
  const desk = recent.filter((s) => !s.live && s.host === HOME_HOST && !busy.has(s.id))
  // one area's Recover sits on its header only when the desk spans more than one area (the classic split button's rule)
  const splitDesk = new Set(desk.map((s) => s.area)).size > 1
  // Stop all sits on Live, else Asking, else on the open terminals
  const stopOn = live.length ? 'live' : asking.length ? 'asking' : 'terms'
  const liveOpen = !folded.has('live')
  const navigate = useNavigate()
  const dest = where.remote ? 'here' : `on ${hostLabel(HOME_HOST)}`

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

  let k = 4
  // rows inside an area group do not repeat the area their header names
  const item = (s: Row, noArea = false) => <SessionItem key={s.id} s={s} i={Math.min(k++, 16)} ctx={ctx} noArea={noArea} />
  const foot = (
    <div className="vc-foot vl-build" style={iv(Math.min(k++, 16))}>
      <Press className="vl-link" onPress={() => navigate('/sessions')}>
        <Icon name="claude" size={13} tone="dim" />All sessions (classic)
      </Press>
      <span>host health, snapshots, restore, closed history</span>
    </div>
  )
  const recoverBtn = (rows: Row[], label: string, what: string, quiet = false) => (
    <Press
      className="vc-ghead-act"
      data-quiet={quiet || undefined}
      data-busy={recover ? '' : undefined}
      disabled={recover !== null || sweeping}
      title={`Reopen the ${rows.length} ${what}session${rows.length === 1 ? '' : 's'} still open and not running, ${dest}`}
      onPress={() => onRecover(rows)}
    >
      <Icon name={recover ? 'refresh' : hostIcon(HOME_HOST)} size={13} tone={recover ? 'fg' : 'dim'} className={recover ? 'vl-pulse' : undefined} />
      {label}
    </Press>
  )

  if (results) {
    return (
      <>
        <section className="vc-group vl-panel" data-g="results">
          <GroupHead icon="search" tone="fg" glow={results.all > 0} label="Results" n={results.all} i={k++}>
            {results.folders && <span className="vc-ghead-note"><Icon name="refresh" size={12} tone="dim" className="vl-pulse" />folders</span>}
          </GroupHead>
          {results.shown.length ? (
            <div className="vc-rows">{results.shown.map((s) => item(s))}</div>
          ) : (
            <p className="vc-pd-none">No session matches. Search covers every area and the done list.</p>
          )}
          {results.all > results.shown.length && (
            <Press className="vc-showmore" onPress={onMoreResults}>
              <Icon name="add" size={14} tone="dim" />Show {Math.min(RESULTS_STEP, results.all - results.shown.length)} more
            </Press>
          )}
        </section>
        {foot}
      </>
    )
  }

  // the Live header is lit only while something in it is working
  const liveLit = live.some((s) => s.activity === 'working')
  return (
    <>
      {terms.length > 0 && (
        <OpenTerminals
          list={terms}
          titles={titles}
          now={ctx.now}
          hostLabel={hostLabel}
          k0={k++}
          stopAll={stopOn === 'terms' ? <StopAllButton vm={stopAll} /> : null}
          open={!folded.has('terms')}
          onFold={() => onFold('terms')}
          onReattach={onReattach}
          onWindow={onTermWindow}
          onClosed={onTermClosed}
        />
      )}
      {!asking.length && !live.length && !recent.length && (
        <div className="vc-empty vl-build" style={iv(k++)}><span>Nothing open{area === 'all' ? '' : ` in ${areaName(area)}`}</span></div>
      )}
      {asking.length > 0 && (
        <section className="vc-group vl-panel" data-g="asking">
          <GroupHead icon={GROUP_ICON.asking.icon} tone={GROUP_ICON.asking.tone} glow label="Asking" n={asking.length} i={k++}>
            {stopOn === 'asking' && <StopAllButton vm={stopAll} />}
          </GroupHead>
          <div className="vc-rows">{asking.map((s) => item(s))}</div>
        </section>
      )}
      {live.length > 0 && (
        <section className="vc-group vl-panel" data-g="live" data-folded={!liveOpen || undefined}>
          <GroupHead
            icon={liveLit ? GROUP_ICON.live.icon : 'idle'}
            tone={liveLit ? GROUP_ICON.live.tone : 'dim'}
            glow={liveLit}
            label="Live"
            n={live.length}
            i={k++}
            fold={{ open: liveOpen, onToggle: () => onFold('live') }}
          >
            {stopOn === 'live' && <StopAllButton vm={stopAll} />}
          </GroupHead>
          {liveOpen && <div className="vc-rows">{live.map((s) => item(s))}</div>}
        </section>
      )}
      {recent.length > 0 && (
        <>
          {/* Recent: a caption over one panel per area, the classic board's grouping and order */}
          <header className="vc-sec vl-build" style={iv(k++)}>
            <span className="vc-sec-l">
              <Icon name={GROUP_ICON.recent.icon} size={14} tone="dim" />
              <span className="vc-ghead-t">Recent</span>
              <span className="vc-ghead-n">{recent.length}</span>
            </span>
            {(desk.length > 0 || recover) && recoverBtn(
              desk,
              recover ? `Recovering ${recover.done}/${recover.total}` : `Recover desk (${desk.length})`,
              area === 'all' ? '' : `${areaName(area)} `,
            )}
          </header>
          <div className="vc-areas">
            {areas.map((g) => {
              const areaDesk = splitDesk ? desk.filter((s) => s.area === g.area) : []
              const more = moreAreas.has(g.area)
              return (
                <section key={g.area || 'other'} className="vc-group vl-panel" data-g="recent" data-area={g.area || 'other'} data-folded={!g.open || undefined}>
                  <GroupHead
                    icon={areaIcon(g.area)}
                    label={areaName(g.area)}
                    n={g.rows.length}
                    i={k++}
                    fold={{ open: g.open, onToggle: () => onFold(areaFold(g.area)) }}
                  >
                    {areaDesk.length > 0 && !recover && recoverBtn(areaDesk, `Recover ${areaDesk.length}`, `${areaName(g.area)} `, true)}
                  </GroupHead>
                  {g.open && <div className="vc-rows">{g.shown.map((s) => item(s, true))}</div>}
                  {g.open && g.rows.length > AREA_SHOWN && (
                    <Press className="vc-showmore" onPress={() => onToggleMore(g.area)}>
                      {!more && <Icon name="add" size={14} tone="dim" />}
                      {more ? 'Show fewer' : `Show ${g.rows.length - AREA_SHOWN} more`}
                    </Press>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
      {done.length > 0 && (
        doneOpen ? (
          <section className="vc-group vl-panel" data-g="done">
            <GroupHead icon="done" label="Done" n={done.length} i={k++}>
              <Press className="vc-ghead-act" onPress={onToggleDone}>Hide done</Press>
            </GroupHead>
            <div className="vc-rows">{doneShown.map((s) => item(s))}</div>
            {done.length > doneShown.length && (
              <Press className="vc-showmore" onPress={onMoreDone}>
                <Icon name="add" size={14} tone="dim" />Show {Math.min(DONE_STEP, done.length - doneShown.length)} more
              </Press>
            )}
          </section>
        ) : (
          <Press className="vc-fold vl-build" style={iv(Math.min(k++, 16))} onPress={onToggleDone}>
            <Icon name="done" size={14} tone="dim" />Show {done.length} done
          </Press>
        )
      )}
      {foot}
    </>
  )
}

const TERMS_SHOWN = 10

/**
 * Every tmux pane on odin (Claude on thor, Claude on odin, shells, new
 * sessions the board has not picked up yet), oldest first so a busy one never
 * jumps under a finger. A tap reattaches by that pane's own name; where
 * windows exist a second button opens it in its own window; the X closes it
 * with two taps, which ends its Claude and leaves the conversation resumable.
 * The header folds the group.
 */
function OpenTerminals({ list, titles, now, hostLabel, k0, stopAll, open, onFold, onReattach, onWindow, onClosed }: {
  list: TermSession[]
  titles: Map<string, string>
  now: number
  hostLabel: (id: string) => string
  k0: number
  stopAll: ReactNode
  open: boolean
  onFold: () => void
  onReattach: (name: string) => void
  onWindow?: (t: TermSession, label: string) => void
  onClosed: () => void
}) {
  const [all, setAll] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt)
  const shown = all ? sorted : sorted.slice(0, TERMS_SHOWN)
  const close = async (t: TermSession, label: string) => {
    setArmed(null)
    setClosing(t.name)
    try {
      await killTermSession(t.name)
      toast(`Closed "${label}"`)
    } catch (e) {
      if (httpStatus(e) !== 404) toast(`Could not close "${label}": ${errText(e)}`, { ms: 5000 })
    } finally {
      setClosing(null)
      onClosed()
    }
  }
  let k = k0
  return (
    <section className="vc-group vl-panel" data-g="terms" data-folded={!open || undefined}>
      <GroupHead icon="claude" label="Open terminals" n={list.length} i={k++} fold={{ open, onToggle: onFold }}>{stopAll}</GroupHead>
      {open && <div className="vc-rows">
        {shown.map((t) => {
          const label = termLabel(t, titles)
          const on = armed === t.name
          const claude = t.mode !== 'shell'
          return (
            <div key={t.name} className="vc-term vl-build" style={iv(Math.min(k++, 16))} data-dead={t.dead || undefined}>
              <Press
                className="vc-term-main"
                disabled={closing === t.name}
                title={`Reattach to ${label} on ${hostLabel(t.host)}`}
                onPress={() => onReattach(t.name)}
              >
                <span className="vc-sicon" aria-hidden>
                  <Icon name={t.dead ? 'alert' : 'claude'} size={16} tone={t.dead ? 'acc2' : claude ? 'fg' : 'dim'} />
                </span>
                <span className="vc-row-main">
                  <span className="vc-row-title" data-closed>{label}</span>
                  <span className="vc-row-sub">
                    <Icon name={hostIcon(t.host)} size={12} tone="dim" title={hostLabel(t.host)} />
                    <span>{hostLabel(t.host)}{t.projectId ? ' · project' : ''}</span>
                  </span>
                </span>
                <span className="vc-row-meta">
                  <span className="vc-ago" data-a="closed">{t.activityAt > 0 ? ago(t.activityAt, now) : '--'}</span>
                  <span className="vc-state" data-a={t.dead ? 'asking' : 'closed'}>
                    {closing === t.name ? 'closing' : t.dead ? 'ended' : claude ? 'claude' : 'shell'}
                  </span>
                </span>
              </Press>
              {onWindow && !t.dead && (
                <Press
                  className="vc-term-pop"
                  disabled={closing === t.name}
                  aria-label={`Open ${label} in a new window`}
                  title="Open in a new window"
                  onPress={() => onWindow(t, label)}
                >
                  <AnyIcon name="popout" size={15} tone="dim" />
                </Press>
              )}
              <Press
                className="vc-term-x"
                data-armed={on || undefined}
                disabled={closing !== null}
                aria-label={on ? `Close ${label} now` : `Close ${label}`}
                title={on ? 'Tap again to close it' : 'Close this terminal. Its Claude ends; the conversation stays resumable.'}
                onPress={() => (on ? void close(t, label) : setArmed(t.name))}
              >
                <Icon name="stop" size={15} tone={on ? 'acc2' : 'dim'} />
                {on && <span>Close?</span>}
              </Press>
            </div>
          )
        })}
      </div>}
      {open && sorted.length > TERMS_SHOWN && (
        <Press className="vc-showmore" onPress={() => setAll((v) => !v)}>
          {!all && <Icon name="add" size={14} tone="dim" />}
          {all ? 'Show fewer' : `Show ${sorted.length - TERMS_SHOWN} more`}
        </Press>
      )}
    </section>
  )
}

/** The row's way back in, as its button says it: what Open will do for this session from this device. */
type OpenState = { label: string; hint: string; can: boolean; busy: boolean }

function openState(s: SessionVM, pane: string | null, busy: Busy | undefined, hostLabel: (id: string) => string): OpenState {
  const home = hostLabel(HOME_HOST)
  if (busy === 'open') return { label: 'Opening', hint: 'Opening', can: false, busy: true }
  if (busy) return { label: 'Open', hint: busy === 'stop' ? 'Stopping' : 'Saving', can: false, busy: false }
  if (pane) return { label: 'Reattach', hint: 'Go to the terminal already running this session', can: true, busy: false }
  if (s.live) return { label: `Running on ${hostLabel(s.host)}`, hint: `Running on ${hostLabel(s.host)}'s screen. Stop it to open it here.`, can: false, busy: false }
  if (s.host !== HOME_HOST) return { label: `Open on ${hostLabel(s.host)}`, hint: `Open a terminal on ${hostLabel(s.host)}, where this session lives`, can: true, busy: false }
  return { label: 'Open', hint: `Open it inside Valkyrie, running on ${home}`, can: true, busy: false }
}

/** Select mode's check box, in the state icon's place. */
function PickBox({ on }: { on: boolean }) {
  return (
    <span className="vc-check" data-on={on || undefined} aria-hidden>
      {on && <Icon name="done" size={13} tone="ink" />}
    </span>
  )
}

function SessionItem({ s, i, ctx, noArea = false }: { s: Row; i: number; ctx: RowCtx; noArea?: boolean }) {
  const liveRow = isLive(s)
  const busy = ctx.busy.get(s.id)
  const locked = busy !== undefined
  const selecting = ctx.picked !== null
  const picked = ctx.picked?.has(s.id) ?? false
  const expanded = !selecting && ctx.expRow === s.id
  const pane = ctx.paneOf(s.id)
  const finish: RowAction = s.done
    ? { id: 'undo', label: 'Undo', icon: 'undo', tone: 'fg', run: () => ctx.onUndo(s), disabled: locked }
    : { id: 'done', label: 'Done', icon: 'done', tone: 'fg', run: () => ctx.onDone(s), disabled: locked }
  const actions: RowAction[] = liveRow
    ? [{ id: 'stop', label: 'Stop', icon: 'stop', tone: 'acc2', run: () => ctx.onStop(s), disabled: locked }, finish]
    : [finish]
  // the screens, beside Open (which is inside Valkyrie): only for thor's sessions and only
  // while nothing runs the session (a second Claude on one transcript)
  const free = s.host === HOME_HOST && !s.live && !pane
  // its own window: the pane it runs in, or a new pane for a thor session nothing runs
  const pop = ctx.where.windows && !locked && (!!pane || free)
  const hoverExtra: RowAction[] = []
  // bare: with On screen and Done beside it, a labeled New window pushed the bar over the row's middle, where a click opens the strip
  if (pop) hoverExtra.push({ id: 'window', label: 'New window', icon: 'popout', tone: 'fg', run: () => ctx.onWindow(s), bare: free })
  // a terminal on the screen in front of him, one click from the row like Recover desk, not only in the tapped strip
  if (free && !locked) {
    hoverExtra.push(ctx.where.remote
      ? { id: 'local', label: 'On this screen', icon: 'mimir', tone: 'fg', run: () => ctx.onLocal(s) }
      : { id: 'screen', label: 'On screen', icon: hostIcon(HOME_HOST), tone: 'fg', run: () => ctx.onScreen(s) })
  }
  return (
    <div
      className="vc-item"
      ref={(el) => { if (el) ctx.rowEls.set(s.id, el); else ctx.rowEls.delete(s.id) }}
      data-row={s.id}
      data-exp={expanded || undefined}
      data-done={s.done || undefined}
      data-picked={picked || undefined}
    >
      <SwipeRow
        i={i}
        open={!selecting && ctx.openRow === s.id}
        setOpen={(o) => ctx.setOpenRow(o ? s.id : null)}
        actions={actions}
        onFull={() => ctx.onDone(s)}
        onTap={() => (selecting ? ctx.onPick(s.id) : ctx.onToggle(s.id))}
        onLong={() => (selecting ? ctx.onPick(s.id) : ctx.onPickStart(s.id))}
        hoverExtra={hoverExtra}
        selecting={selecting}
        picked={picked}
        expanded={expanded}
      >
        {selecting ? <PickBox on={picked} /> : <StateIcon a={s.activity} />}
        <span className="vc-row-main">
          <span className="vc-row-title" data-closed={!liveRow || undefined} data-a={s.activity}>{s.title || '(untitled)'}</span>
          <span className="vc-row-sub">
            <Icon name={hostIcon(s.host)} size={12} tone={liveRow ? 'dim' : 'faint'} title={ctx.hostLabel(s.host)} />
            <span>{s.project || 'no folder'}{s.host !== HOME_HOST ? ` · ${ctx.hostLabel(s.host)}` : ''}</span>
          </span>
        </span>
        <span className="vc-row-meta">
          <span className="vc-ago" data-a={s.activity}>{s.last ? ago(s.last, ctx.now) : '--'}</span>
          {busy === 'stop' || busy === 'open' ? (
            <span className="vc-state" data-a="closed">{busy === 'stop' ? 'stopping' : 'opening'}</span>
          ) : liveRow ? (
            <span className="vc-state" data-a={s.activity}>{STATE_WORD[s.activity]}{s.done ? ' · done' : ''}</span>
          ) : s.done ? (
            <span className="vc-area" data-done>done</span>
          ) : ctx.showArea && !noArea && s.area ? (
            <span className="vc-area">{areaName(s.area)}</span>
          ) : null}
        </span>
      </SwipeRow>
      {expanded && (
        <RowStrip
          s={s}
          live={liveRow}
          locked={locked}
          way={openState(s, pane, busy, ctx.hostLabel)}
          home={ctx.hostLabel(HOME_HOST)}
          screen={free}
          local={free && ctx.where.remote}
          pop={pop}
          onOpen={() => ctx.onOpen(s)}
          onWindow={() => ctx.onWindow(s)}
          onScreen={() => ctx.onScreen(s)}
          onLocal={() => ctx.onLocal(s)}
          onDone={() => (s.done ? ctx.onUndo(s) : ctx.onDone(s))}
          onStop={() => ctx.onStop(s)}
        />
      )}
    </div>
  )
}

/**
 * Under a tapped row: getting back into the session is the point of the page,
 * so Open (inside Valkyrie) leads, then its own window, thor's screen and this
 * screen where those are ways in, then copy, done and stop.
 */
function RowStrip({ s, live, locked, way, home, screen, local, pop, onOpen, onWindow, onScreen, onLocal, onDone, onStop }: {
  s: Row
  live: boolean
  /** a write for this row is in flight */
  locked: boolean
  way: OpenState
  /** thor's name, for the screen button */
  home: string
  /** resume on thor's own screen is a second way in */
  screen: boolean
  /** the desktop app off thor: resume on this screen over SSH */
  local: boolean
  /** open it in its own window */
  pop: boolean
  onOpen: () => void
  onWindow: () => void
  onScreen: () => void
  onLocal: () => void
  /** Done, or Undo on a done row */
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
        {pop && (
          <Press className="vc-sact" disabled={locked} title="Open it inside Valkyrie, in a window of its own" onPress={onWindow}>
            <AnyIcon name="popout" size={15} tone="dim" />
            <span>New window</span>
          </Press>
        )}
        {screen && (
          <Press className="vc-sact" disabled={locked} title={`Resume it in a terminal window on ${home}'s screen, so it lives there and outlasts this connection`} onPress={onScreen}>
            <Icon name={hostIcon(HOME_HOST)} size={15} tone="dim" />
            {/* the picker's word on the phone, the whole place where there is room */}
            <span className="vc-iact-s">On screen</span>
            <span className="vc-iact-l">{`On ${home}'s screen`}</span>
          </Press>
        )}
        {local && (
          <Press className="vc-sact" disabled={locked} title={`Resume it in a terminal on this screen, over SSH to ${home}`} onPress={onLocal}>
            <Icon name="mimir" size={15} tone="dim" />
            <span>On this screen</span>
          </Press>
        )}
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
        <Press className="vc-sact vc-iact" aria-label={s.done ? 'Undo done' : 'Done'} title={s.done ? 'Put it back on the list' : 'Done'} disabled={locked} onPress={onDone}>
          <Icon name={s.done ? 'undo' : 'done'} size={16} tone="dim" /><span className="vc-iact-l">{s.done ? 'Undo' : 'Done'}</span>
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
// scrolls and rightward swipes (to the previous tab) through. A press held
// still for LONG_MS (or a right click) picks the row instead; in select mode
// nothing slides and a tap toggles the pick.

type RowAction = { id: string; label: string; icon: AnyIconName; tone: 'fg' | 'acc2'; run: () => void; disabled?: boolean; /** hover bar: the icon alone, the label as its tooltip */ bare?: boolean }
const ACT_W = 78
const SWIPE_ZONE = 72

function SwipeRow({ i, open, setOpen, actions, hoverExtra = [], onFull, onTap, onLong, selecting, picked, expanded, children }: {
  i: number
  open: boolean
  setOpen: (open: boolean) => void
  actions: RowAction[]
  /** mouse only: more actions ahead of `actions` on hover (its own window); never in the swipe */
  hoverExtra?: RowAction[]
  onFull: () => void
  onTap: () => void
  /** a long press (or right click) */
  onLong: () => void
  selecting: boolean
  picked: boolean
  expanded: boolean
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLButtonElement>(null)
  const x = useRef(0)
  const anim = useRef<null | (() => void)>(null)
  const swiped = useRef(false)
  // the press already did its job as a long press, so its release is not a tap
  const longFired = useRef(false)
  // a full swipe commits Done, so it only arms while Done can run
  const canFull = actions.some((a) => a.id === 'done' && !a.disabled)
  const latest = useRef({ open, setOpen, onFull, onLong, selecting, canFull, width: actions.length * ACT_W })
  latest.current = { open, setOpen, onFull, onLong, selecting, canFull, width: actions.length * ACT_W }

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
    let lp: { id: number; x0: number; y0: number; t: number } | null = null
    const clearLp = () => {
      if (!lp) return
      window.clearTimeout(lp.t)
      lp = null
    }
    const fireLong = () => {
      longFired.current = true
      try { navigator.vibrate?.(12) } catch { /* no vibration */ }
      latest.current.onLong()
    }

    const down = (e: PointerEvent) => {
      swiped.current = false
      longFired.current = false
      g = null
      clearLp()
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if ((e.target as Element).closest('.vc-act, .vc-hact')) return
      // a still press anywhere on a closed row picks it after LONG_MS
      if (x.current > -0.5) {
        const id = e.pointerId
        lp = { id, x0: e.clientX, y0: e.clientY, t: window.setTimeout(() => { lp = null; fireLong() }, LONG_MS) }
      }
      if (latest.current.selecting) return
      // closed rows slide only from the age column; the title area belongs to the pager
      const r = el.getBoundingClientRect()
      if (x.current > -0.5 && e.clientX < r.right - SWIPE_ZONE) return
      anim.current?.()
      anim.current = null
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, base: x.current, lastX: e.clientX, lastT: e.timeStamp, vx: 0, w: el.clientWidth }
    }
    const move = (e: PointerEvent) => {
      if (lp && e.pointerId === lp.id && Math.hypot(e.clientX - lp.x0, e.clientY - lp.y0) > 8) clearLp()
      if (!g || e.pointerId !== g.id || g.axis === 'pass') return
      const dx = e.clientX - g.x0
      const dy = e.clientY - g.y0
      if (!g.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
        if (Math.abs(dx) > Math.abs(dy) && (dx < 0 || g.base < 0)) {
          g.axis = 'x'
          clearLp()
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
      if (lp && e.pointerId === lp.id) clearLp()
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
    // A long press on a phone can also raise the context menu, and a right
    // click raises it on purpose: both pick the row, once, never the menu.
    const menu = (e: MouseEvent) => {
      if ((e.target as Element).closest('.vc-act, .vc-hact')) return
      e.preventDefault()
      clearLp()
      if (longFired.current || x.current < -0.5) return
      fireLong()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('contextmenu', menu)
    return () => {
      clearLp()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('contextmenu', menu)
      anim.current?.()
    }
  }, [])

  return (
    <div className="vc-swipe vl-build" style={iv(i)} data-open={open || undefined} data-selecting={selecting || undefined} ref={box}>
      <i className="vc-fill" aria-hidden />
      <div className="vc-acts" style={{ width: actions.length * ACT_W }} aria-hidden={!open}>
        {actions.map((a) => (
          <Press key={a.id} className="vc-act" data-tone={a.tone} tabIndex={open ? 0 : -1} disabled={a.disabled} onPress={a.run}>
            <AnyIcon name={a.icon} size={18} tone={a.tone === 'acc2' ? 'acc2' : 'ink'} />
            <span>{a.label}</span>
          </Press>
        ))}
      </div>
      <Press
        ref={front}
        className="vc-front"
        aria-expanded={selecting ? undefined : expanded}
        role={selecting ? 'checkbox' : undefined}
        aria-checked={selecting ? picked : undefined}
        onPress={() => {
          if (swiped.current || longFired.current) return
          if (latest.current.open) latest.current.setOpen(false)
          else onTap()
        }}
      >
        {children}
      </Press>
      {/* mouse: the same actions on hover, so desktop does not need a drag */}
      <div className="vc-hover-acts">
        {[...hoverExtra, ...actions].map((a) => (
          <Press key={a.id} className="vc-hact" data-tone={a.tone} data-bare={a.bare || undefined} tabIndex={-1} disabled={a.disabled} aria-label={a.bare ? a.label : undefined} title={a.bare ? a.label : undefined} onPress={a.run}>
            <AnyIcon name={a.icon} size={14} tone={a.tone === 'acc2' ? 'acc2' : 'dim'} />
            {!a.bare && a.label}
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

/**
 * One project row: a press opens it (its own window where windows exist,
 * here on a touch screen); `onHere`, where given, is the plain "Open here"
 * beside it (the column on desktop, a sheet elsewhere).
 */
function ProjRowItem({ p, k, selected, archived = false, onOpen, onHere, children }: {
  p: Counted
  k: number
  selected: boolean
  archived?: boolean
  onOpen: (p: ProjectVM) => void
  onHere?: (p: ProjectVM) => void
  children: ReactNode
}) {
  return (
    <div className="vc-pline vl-build" style={iv(k)} data-on={selected || undefined} data-archived={archived || undefined}>
      <Press
        className="vc-prow"
        data-on={selected || undefined}
        data-archived={archived || undefined}
        title={onHere ? `Open ${p.name} in its own window` : undefined}
        onPress={() => onOpen(p)}
      >
        <ProjIcon p={p} on={selected} />
        {children}
      </Press>
      {onHere && (
        <Press className="vc-phere" aria-label={`Open ${p.name} here`} title="Open here, in this page" onPress={() => onHere(p)}>
          <AnyIcon name="here" size={14} tone={selected ? 'fg' : 'dim'} />
          <span>Open here</span>
        </Press>
      )}
    </div>
  )
}

function ProjectBoard({ list, area, loading, failed, error, now, selected, onOpen, onHere }: {
  list: Counted[]
  area: string
  loading: boolean
  failed: boolean
  error: Error | null
  now: number
  selected: string | null
  onOpen: (p: ProjectVM) => void
  onHere?: (p: ProjectVM) => void
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
              <ProjRowItem key={p.id} p={p} k={Math.min(k++, 16)} selected={selected === p.id} onOpen={onOpen} onHere={onHere}>
                <span className="vc-row-main">
                  <span className="vc-row-title">{p.name}</span>
                  <span className="vc-prow-next">{p.nextAction || 'No next action set'}</span>
                </span>
                <ProjMeta p={p} now={now} />
              </ProjRowItem>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

/**
 * Show archived, under the list: a quiet text toggle, and while it is on the
 * archived projects of the picked area as one more group. A tap opens one
 * here, never in its own window (its detail offers Restore).
 */
function ArchivedFold({ on, onToggle, list, loading, error, area, now, selected, onOpen }: {
  on: boolean
  onToggle: () => void
  list: Counted[]
  loading: boolean
  error: string | null
  area: string
  now: number
  selected: string | null
  onOpen: (p: ProjectVM) => void
}) {
  const shown = area === 'all' ? list : list.filter((p) => p.area === area)
  return (
    <>
      {on && (
        loading ? (
          <p className="vc-pd-none vc-arch-note"><Icon name="refresh" size={13} tone="dim" className="vl-pulse" />Reading archived projects</p>
        ) : error ? (
          <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />Archived projects did not answer: {error}</p>
        ) : !shown.length ? (
          <p className="vc-pd-none vc-arch-note">No archived projects{area === 'all' ? '' : ` in ${areaName(area)}`}</p>
        ) : (
          <section className="vc-group vl-panel vl-build-on" data-g="archived">
            <header className="vc-ghead">
              <span className="vc-ghead-l">
                <PIcon name="archive" />
                <span className="vc-ghead-t">Archived</span>
                <span className="vc-ghead-n">{shown.length}</span>
              </span>
            </header>
            <div className="vc-rows">
              {shown.map((p, n) => (
                <ProjRowItem key={p.id} p={p} k={Math.min(n + 1, 12)} selected={selected === p.id} archived onOpen={onOpen}>
                  <span className="vc-row-main">
                    <span className="vc-row-title">{p.name}</span>
                    <span className="vc-prow-next">{p.nextAction || p.summary || 'No next action set'}</span>
                  </span>
                  <span className="vc-row-meta">
                    <span className="vc-ago" data-a="closed">{ago(p.updated, now)}</span>
                    {area === 'all' && <span className="vc-area">{areaName(p.area)}</span>}
                  </span>
                </ProjRowItem>
              ))}
            </div>
          </section>
        )
      )}
      <div className="vc-foot vc-arch-foot">
        <Press className="vl-link" aria-pressed={on} title={on ? 'Hide the archived projects' : 'Archived projects: open one to restore it'} onPress={onToggle}>
          <PIcon name="archive" size={13} />{on ? 'Hide archived' : 'Show archived'}
        </Press>
      </div>
    </>
  )
}

type ProjTask = { id: string; tabId: string; text: string; done: boolean; due?: string | null }
type ProjReminder = { id: string; at: number; message: string }
type ProjLink = { id: string; host: string; note: string; at: number }

type ProjDocVM = {
  targetKey: string
  /** what Edit needs beyond the list row: folder, exposure and the two session switches */
  meta: ProjMeta
  /** every item of every checklist tab, in stored order */
  tasks: ProjTask[]
  /** the first checklist tab, where a new item lands; null when the project has none yet */
  listTab: string | null
  /** every linked session, newest link first */
  links: ProjLink[]
  /** pending reminders, soonest first */
  reminders: ProjReminder[]
  /** the notes and links tabs by name (bodies are read only when one opens) */
  notes: NoteTab[]
}

const projDocKey = (id: string) => `projdoc.${id}`
const asExposure = (e: unknown): Exposure => (e === 'anywhere' ? 'anywhere' : 'tailnet')

function useProjDoc(id: string): Live<ProjDocVM> {
  return useLive<ProjDocVM>(projDocKey(id), async () => {
    const d = await fetchProjDoc(id)
    const lists = d.tabs.filter((t) => t.kind === 'checklist')
    const tasks = lists.flatMap((t) => (t.items as ChecklistItem[]).map((it): ProjTask => ({ id: it.id, tabId: t.id, text: it.text, done: it.done, due: it.due ?? null })))
    const seen = new Set<string>()
    const links = d.sessions
      .filter((l) => !seen.has(l.sessionId) && !!seen.add(l.sessionId))
      .map((l): ProjLink => ({ id: l.sessionId, host: l.host, note: l.statusNote, at: Date.parse(l.statusAt ?? l.linkedAt) }))
    const reminders = d.reminders
      .filter((r) => r.state === 'pending')
      .map((r): ProjReminder => ({ id: r.id, at: Date.parse(r.at), message: r.message }))
      .sort((a, b) => a.at - b.at)
    const notes = d.tabs
      .filter((t) => t.kind === 'markdown' || t.kind === 'links')
      .map((t): NoteTab => ({ id: t.id, kind: t.kind === 'links' ? 'links' : 'markdown', title: t.title, n: t.items.length }))
    const meta: ProjMeta = {
      targetKey: d.project.targetKey,
      exposure: asExposure(d.project.exposure),
      allowSnapshots: d.project.allowSnapshots === true,
      sessionEdits: d.project.sessionEdits !== false,
    }
    return { targetKey: d.project.targetKey, meta, tasks, listTab: lists[0]?.id ?? null, links, reminders, notes }
  }, 60_000, {
    // an older build cached a different shape under this key: paint nothing rather than misread it
    revive: (c) => {
      const v = c as Partial<ProjDocVM> | null
      return v && Array.isArray(v.tasks) && Array.isArray(v.reminders) && Array.isArray(v.links) && Array.isArray(v.notes) && !!v.meta
        ? (v as ProjDocVM)
        : undefined
    },
  })
}

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

/** a project's open sessions shown before "Show N more" */
const PROJ_SESS_SHOWN = 8

function ProjectDetail({ p, index, lookup, now, hostLabel, acts, onArchived, onWindow, showArea }: {
  p: ProjectVM
  index: SessionIndex
  lookup: Lookup
  now: number
  hostLabel: (id: string) => string
  /** the board's stop, done and undo, so a session acts here as it does on Sessions */
  acts: SessActs
  /** the project left the list (archived while the archived fold is closed) */
  onArchived: () => void
  /** where windows exist: this project in its own window */
  onWindow?: () => void
  /** the sheet already names the area in its header */
  showArea?: boolean
}) {
  const doc = useProjDoc(p.id)
  const targets = useLaunchTargets()
  const [more, setMore] = useState(false)
  const [editing, setEditing] = useState(false)
  // the session whose action strip is open, the link picker, and the folds
  const [exp, setExp] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const linkRef = useRef<HTMLInputElement>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  // unlinked here, hidden until the doc stops listing them
  const [unlinked, setUnlinked] = useState<ReadonlySet<string>>(() => new Set())
  const qc = useQueryClient()
  const navigate = useNavigate()
  // 'start', 'restore' or the linked session being opened, moved, stopped or unlinked; one at a time
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)
  // the last refusal, inline as well: on the phone this sits in a sheet whose backdrop covers the toasts
  const [note, setNote] = useState<string | null>(null)
  const say = (msg: string, ms = 5000) => {
    setNote(msg)
    toast(msg, { ms })
  }
  // A project always opens in the page (useProjectTerm): only that path hands
  // the session the project's MCP server. The back param must be a project
  // path (PROJECT_BACK_RE drops anything else); the v2 terminal turns it into
  // AI > Projects, the classic one into the project's own page.
  const back = `/projects/${p.id}`
  // every write here: this project's doc and the list (name, next action, next reminder), v2's and the classic page's
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['v2', projDocKey(p.id)] })
    void qc.invalidateQueries({ queryKey: ['v2', PROJ_KEY] })
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(p.id) })
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
  }
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
    void qc.invalidateQueries({ queryKey: ['v2', projDocKey(p.id)] })
    navigate(termTo(r.name, back))
  }
  const refreshSessions = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    void qc.invalidateQueries({ queryKey: TERMS_KEY })
  }
  // no label: the backend names a project session after the project
  const start = () => run('start', `Could not start a session in ${p.name}`, async () => {
    landed(await openTermSession({ mode: 'new', project: p.id, ...phoneGrid() }))
  })
  const restore = () => run('restore', `Could not restore ${p.name}`, async () => {
    await updateProj(p.id, { status: 'active' })
    changed()
    toast(`Restored ${p.name}`)
  })
  const resume = (id: string, title: string | undefined, host: string) => run(id, `Could not open "${title || 'the session'}"`, async () => {
    const pane = paneFor(await freshPanes(qc), id)
    if (pane) {
      navigate(termTo(pane, back))
      return
    }
    if (lookup(id)?.live) {
      say(`"${title || 'The session'}" is running on ${hostLabel(host)}. Use Move here, or stop it, to open it here.`, 4000)
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
  // Running in a window on thor: stop it there, give the window's Claude a
  // moment to finish writing the transcript, then pick it up here (the classic
  // project page's move). A 404 means it had already exited.
  const move = (id: string, title: string) => run(id, `Could not move "${title}"`, async () => {
    try {
      const r = await stopSessionOnHost(id, HOME_HOST)
      if (r && r.ok === false) throw new Error(r.detail ?? `${HOME_HOST} refused`)
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
    }
    await sleep(1500)
    refreshSessions()
    landed(await openTermSession({ mode: 'resume', sessionId: id, project: p.id, label: title, ...phoneGrid() }))
  })
  // a session in a pane here: closing the pane ends its Claude
  const stopPane = (id: string, pane: string, title: string) => run(id, `Could not stop "${title}"`, async () => {
    try {
      await killTermSession(pane)
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
    }
    setExp(null)
    refreshSessions()
    toast(`Stopped "${title}"`)
  })
  const unlink = (id: string, title: string) => run(id, `Could not unlink "${title}"`, async () => {
    await unlinkProjSession(p.id, id)
    setUnlinked((s) => new Set(s).add(id))
    setExp(null)
    changed()
    toast(`Unlinked "${title}" from ${p.name}`)
  })

  const d = doc.data
  const target = d ? targets.data?.find((t) => t.key === d.targetKey) : undefined
  const links = (d?.links ?? []).filter((l) => !unlinked.has(l.id))
  const linkedIds = useMemo(() => new Set((d?.links ?? []).map((l) => l.id)), [d?.links])
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
  // a running session marked done stays with the open ones until it closes (the board's rule)
  const isDoneRow = (id: string) => {
    const s = lookup(id)
    return !!s && s.done && !isLive(s)
  }
  const openLinks = sortedLinks.filter((l) => !isDoneRow(l.id))
  const doneLinks = sortedLinks.filter((l) => isDoneRow(l.id))
  const openShown = allOpen ? openLinks : openLinks.slice(0, PROJ_SESS_SHOWN)
  const archivedP = p.status === 'archived'
  const longSummary = p.summary.length > 220
  const openTasks = d ? d.tasks.filter((t) => !t.done).length : 0
  const nextRem = d?.reminders[0] ?? null
  const caps: string[] = []
  if (showArea) caps.push(areaName(p.area))
  if (p.status !== 'active') caps.push(p.status)
  caps.push(`updated ${ago(p.updated, now)} ago`)
  if (openTasks > 0) caps.push(`${openTasks} open`)

  const sessionRow = (l: ProjLink) => {
    const s = info(l.id)
    const row = lookup(l.id)
    const a = s?.activity ?? 'closed'
    const liveRow = a !== 'closed'
    const host = s?.host ?? l.host
    const title = s?.title || l.note || `Linked session · ${shortDate(l.at)}`
    const pane = paneFor(qc.getQueryData<TermSession[]>(TERMS_KEY), l.id)
    const actBusy = acts.busy.get(l.id)
    const mine = busy === l.id
    const open = exp === l.id
    const done = !!row?.done
    const word = mine ? 'working on it' : actBusy === 'stop' ? 'stopping' : actBusy === 'done' ? 'saving' : liveRow ? STATE_WORD[a] : done ? 'done' : ''
    return (
      <div key={l.id} className="vp-sitem" data-exp={open || undefined} data-done={(done && !liveRow) || undefined}>
        <div className="vp-sline">
          <Press
            className="vc-pd-srow"
            data-busy={mine || undefined}
            disabled={busy !== null}
            title={pane ? 'Go to the terminal already running this session' : host !== HOME_HOST ? `Open a terminal on ${hostLabel(host)}, where this session lives` : `Open it here, running on ${hostLabel(host)}`}
            onPress={() => void resume(l.id, s?.title || undefined, host)}
          >
            <StateIcon a={a} size={16} />
            <span className="vc-row-main">
              <span className="vc-row-title" data-closed={!liveRow || undefined}>{title}</span>
              <span className="vc-row-sub">
                <Icon name={hostIcon(host)} size={12} tone={liveRow ? 'dim' : 'faint'} title={hostLabel(host)} />
                <span>{[s?.project, host !== HOME_HOST ? hostLabel(host) : '', pane ? 'in a pane here' : row?.live ? 'in a window' : ''].filter(Boolean).join(' · ') || 'not on the open board'}</span>
              </span>
            </span>
            <span className="vc-row-meta">
              <span className="vc-ago" data-a={a}>{ago(s?.last || l.at, now)}</span>
              {word && <span className="vc-state" data-a={liveRow && !mine && !actBusy ? a : 'closed'}>{word}</span>}
            </span>
          </Press>
          <Press
            className="vp-more"
            aria-label={`Actions for ${title}`}
            aria-expanded={open}
            title="Stop, done, unlink"
            onPress={() => setExp((e) => (e === l.id ? null : l.id))}
          >
            <PIcon name="more" size={16} tone={open ? 'fg' : 'dim'} />
          </Press>
        </div>
        {open && (
          <SessionActions
            canMove={!!row?.live && !pane && host === HOME_HOST}
            canStop={!!pane || (!!row && isLive(row))}
            canDone={!!row}
            done={done}
            busy={busy !== null || actBusy !== undefined}
            onMove={() => void move(l.id, title)}
            onStop={() => {
              if (pane) void stopPane(l.id, pane, title)
              else if (row) {
                setExp(null)
                acts.stop(row)
              }
            }}
            onDone={() => {
              if (!row) return
              setExp(null)
              if (row.done) acts.undo(row)
              else acts.done(row)
            }}
            onUnlink={() => void unlink(l.id, title)}
          />
        )}
      </div>
    )
  }

  let k = 1
  return (
    <div className="vc-pd vl-build-on">
      <div className="vc-pd-caps vl-build" style={iv(k++)}>
        {caps.map((c, n) => <span key={c}>{n > 0 && <b>·</b>}{c}</span>)}
      </div>

      {editing && d ? (
        <ProjectSettings
          p={p}
          meta={d.meta}
          onClose={() => setEditing(false)}
          onSaved={changed}
          onArchived={() => {
            setEditing(false)
            onArchived()
          }}
        />
      ) : (
        <div className="vc-pd-next vl-build" style={iv(k++)}>
          <span className="vc-pd-label">Next</span>
          <p>{p.nextAction || 'No next action set'}</p>
        </div>
      )}

      <div className="vc-pd-actions vl-build" style={iv(k++)}>
        {archivedP ? (
          <Press
            className="vc-glass vc-pd-start"
            data-busy={busy === 'restore' || undefined}
            disabled={busy !== null}
            title="Put it back on the project list"
            onPress={() => void restore()}
          >
            {busy === 'restore' ? <Icon name="refresh" size={16} tone="fg" className="vl-pulse" /> : <PIcon name="restore" size={16} tone="fg" />}
            <span>{busy === 'restore' ? 'Restoring' : 'Restore project'}</span>
          </Press>
        ) : (
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
        )}
        {note && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{note}</p>}
        <div className="vc-pd-links">
          {onWindow && (
            <Press className="vl-link" title="This project in a window of its own" onPress={onWindow}>
              <AnyIcon name="popout" size={13} tone="dim" />New window
            </Press>
          )}
          {/* the classic page keeps files, activity and undo, agents and automations, and note editing */}
          <Press
            className="vl-link"
            title="Files, activity, agents and note editing, on the classic project page"
            onPress={() => navigate(`/projects/${encodeURIComponent(p.id)}`)}
          >
            <Icon name="enter" size={13} tone="dim" />Open full project
          </Press>
          {!editing && (
            <Press
              className="vl-link"
              disabled={!d}
              title={d ? 'Name, next action, summary, status, area, folder, exposure, archive' : 'Loading the project'}
              onPress={() => setEditing(true)}
            >
              <Icon name="settings" size={13} tone="dim" />Edit
            </Press>
          )}
        </div>
      </div>

      {nextRem && (
        <div className="vc-pd-rem vl-build" style={iv(k++)}>
          <span className="vc-pd-label"><Icon name="timer" size={12} tone="hot" />Reminder</span>
          <span className="vc-pd-rem-at">{dayClock(nextRem.at, now)}</span>
          <span className="vc-pd-rem-msg">{nextRem.message}</span>
        </div>
      )}

      {p.summary && !editing && (
        <div className="vc-pd-sumwrap vl-build" style={iv(k++)}>
          <p className="vc-pd-summary" data-clamp={(longSummary && !more) || undefined}>{p.summary}</p>
          {longSummary && <Press className="vc-more" onPress={() => setMore((m) => !m)}>{more ? 'Less' : 'More'}</Press>}
        </div>
      )}

      <section className="vc-pd-sec vl-build" style={iv(k++)}>
        <GroupHead icon="claude" label="Sessions" n={d ? links.length : p.sessions}>
          {d && !linking && (
            <Press
              className="vc-ghead-act"
              title="Add a session that started somewhere else"
              onPress={() => openAndFocus(() => setLinking(true), linkRef)}
            >
              <PIcon name="link" size={13} />Link a session
            </Press>
          )}
        </GroupHead>
        {linking && d && (
          <LinkSessionPicker
            projectId={p.id}
            area={p.area}
            linked={linkedIds}
            inputRef={linkRef}
            onClose={() => setLinking(false)}
            onLinked={changed}
          />
        )}
        {links.length ? (
          <div className="vc-rows">
            {openShown.map(sessionRow)}
            {openLinks.length > openShown.length && (
              <Press className="vc-showmore" onPress={() => setAllOpen(true)}>
                <Icon name="go" size={13} tone="dim" />Show {openLinks.length - openShown.length} more
              </Press>
            )}
            {doneLinks.length > 0 && (
              <Press className="vc-showmore" aria-expanded={doneOpen} onPress={() => setDoneOpen((v) => !v)}>
                <Icon name="done" size={13} tone="dim" />{doneOpen ? 'Hide done' : `Show ${doneLinks.length} done`}
              </Press>
            )}
            {doneOpen && doneLinks.map(sessionRow)}
          </div>
        ) : (
          <p className="vc-pd-none">{doc.failed && !d ? 'Project did not answer' : doc.isFetching && !d ? 'Loading' : 'No linked sessions'}</p>
        )}
      </section>

      {d && <ProjTasks key={`t.${p.id}`} projectId={p.id} tasks={d.tasks} listTab={d.listTab} k={k++} onChanged={changed} />}
      {d && <ProjReminders key={`r.${p.id}`} projectId={p.id} list={d.reminders} now={now} k={k++} onChanged={changed} />}
      {d && <ProjectNotes key={`n.${p.id}`} projectId={p.id} tabs={d.notes} />}
    </div>
  )
}

/**
 * The project's checklist: every open item, a tap ticks it (or unticks one
 * ticked here, which stays in place until the detail closes so a mis-tap is
 * one more tap), and a line that adds an item to the first checklist (or makes
 * one, named Tasks, when the project has none). Same writes as the classic
 * checklist tab.
 */
function ProjTasks({ projectId, tasks, listTab, k, onChanged }: {
  projectId: string
  tasks: ProjTask[]
  listTab: string | null
  k: number
  onChanged: () => void
}) {
  // the state a tap set, over the doc's state at the time: once the doc moves (it agrees, or a
  // session changed it) the doc wins again. The ids ticked here stay listed.
  const [over, setOver] = useState<ReadonlyMap<string, { from: boolean; to: boolean }>>(() => new Map())
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set())
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set())
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const doneOf = (t: ProjTask) => {
    const o = over.get(t.id)
    return o && o.from === t.done ? o.to : t.done
  }

  const shown = tasks.filter((t) => !t.done || kept.has(t.id))
  const open = tasks.filter((t) => !doneOf(t)).length
  const full = !!listTab && tasks.filter((t) => t.tabId === listTab).length >= LIMITS.itemsPerTab

  const toggle = (t: ProjTask) => {
    if (inflight.has(t.id)) return
    const next = !doneOf(t)
    setErr(null)
    setOver((m) => new Map(m).set(t.id, { from: t.done, to: next }))
    setKept((s) => new Set(s).add(t.id))
    setInflight((s) => new Set(s).add(t.id))
    projTabItem(projectId, t.tabId, { op: 'set', itemId: t.id, done: next })
      .then(() => onChanged())
      .catch((e: unknown) => {
        setOver((m) => {
          const n = new Map(m)
          n.delete(t.id)
          return n
        })
        setErr(`Could not ${next ? 'tick' : 'reopen'} "${t.text}": ${errText(e)}`)
      })
      .finally(() => setInflight((s) => {
        const n = new Set(s)
        n.delete(t.id)
        return n
      }))
  }
  const add = () => {
    const text = draft.trim()
    if (!text || adding || full) return
    setAdding(true)
    setErr(null)
    const write = listTab
      ? projTabItem(projectId, listTab, { op: 'add', text })
      : addProjTab(projectId, { kind: 'checklist', title: 'Tasks', items: [text] })
    write
      .then(() => {
        setDraft('')
        onChanged()
      })
      .catch((e: unknown) => setErr(`Could not add "${text}": ${errText(e)}`))
      .finally(() => setAdding(false))
  }

  return (
    <section className="vc-pd-sec vl-build" style={iv(k)}>
      <GroupHead icon="done" label="Open tasks" n={tasks.length && open !== tasks.length ? `${open} of ${tasks.length}` : open} />
      {shown.length > 0 && (
        <ul className="vc-pd-tasks">
          {shown.map((t) => {
            const done = doneOf(t)
            return (
              <li key={t.id}>
                <Press
                  className="vc-task"
                  role="checkbox"
                  aria-checked={done}
                  data-done={done || undefined}
                  data-busy={inflight.has(t.id) || undefined}
                  title={done ? 'Tap to reopen it' : 'Tap to tick it'}
                  onPress={() => toggle(t)}
                >
                  <i className="vc-task-box">{done && <Icon name="done" size={11} tone="ink" />}</i>
                  <span>{t.text}</span>
                  {t.due && !done && <DueChip due={t.due} />}
                </Press>
              </li>
            )
          })}
        </ul>
      )}
      <form className="vc-addline" onSubmit={(e) => { e.preventDefault(); add() }} data-no-swipe>
        <Icon name="add" size={14} tone={draft.trim() ? 'fg' : 'dim'} />
        <input
          className="vc-field"
          value={draft}
          maxLength={LIMITS.checklistText}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={full ? `Full at ${LIMITS.itemsPerTab} items` : 'Add item'}
          aria-label="New task"
          enterKeyHint="done"
          autoComplete="off"
          disabled={full}
        />
        {draft.trim() !== '' && (
          <Press className="vc-sact" data-main data-busy={adding || undefined} disabled={adding || full} onPress={add}>
            {adding ? 'Adding' : 'Add'}
          </Press>
        )}
      </form>
      {err && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{err}</p>}
    </section>
  )
}

/**
 * Pending reminders, each with a two-tap Cancel, and a form for a new one:
 * the text and a local date and time, sent as ISO with the Z the backend wants
 * (the classic reminders tab's writes).
 */
function ProjReminders({ projectId, list, now, k, onChanged }: {
  projectId: string
  list: ProjReminder[]
  now: number
  k: number
  onChanged: () => void
}) {
  const [form, setForm] = useState(false)
  const [msg, setMsg] = useState('')
  const [at, setAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [canceling, setCanceling] = useState<string | null>(null)
  // canceled here, hidden until the doc stops listing them
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set())
  const msgRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])

  const shown = list.filter((r) => !gone.has(r.id))
  const full = shown.length >= LIMITS.pendingReminders
  // datetime-local has no zone: Date reads it as this device's local time
  const atMs = at ? new Date(at).getTime() : NaN
  const ready = Number.isFinite(atMs) && msg.trim() !== '' && !full

  const add = () => {
    if (!ready || saving) return
    if (atMs <= Date.now()) {
      setErr('Pick a time in the future')
      return
    }
    setSaving(true)
    setErr(null)
    addProjReminder(projectId, { at: new Date(atMs).toISOString(), message: msg.trim() })
      .then(() => {
        setMsg('')
        setAt('')
        setForm(false)
        onChanged()
        toast(`Reminder set for ${dayClock(atMs)}`)
      })
      .catch((e: unknown) => setErr(`Could not add the reminder: ${errText(e)}`))
      .finally(() => setSaving(false))
  }
  const cancel = (r: ProjReminder) => {
    setArmed(null)
    setCanceling(r.id)
    setErr(null)
    cancelProjReminder(projectId, r.id)
      .then(() => {
        setGone((s) => new Set(s).add(r.id))
        onChanged()
      })
      .catch((e: unknown) => setErr(`Could not cancel it: ${errText(e)}`))
      .finally(() => setCanceling(null))
  }

  return (
    <section className="vc-pd-sec vl-build" style={iv(k)}>
      <GroupHead icon="timer" label="Reminders" n={shown.length}>
        {!form && (
          <Press className="vc-ghead-act" disabled={full} onPress={() => openAndFocus(() => { setForm(true); setErr(null) }, msgRef)}>
            <Icon name="add" size={13} tone="dim" />Add reminder
          </Press>
        )}
      </GroupHead>
      {form && (
        <form className="vc-remform" onSubmit={(e) => { e.preventDefault(); add() }} data-no-swipe>
          <input
            className="vc-field"
            value={msg}
            maxLength={LIMITS.reminderMessage}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="What to remember"
            ref={msgRef}
            aria-label="Reminder text"
            autoComplete="off"
          />
          <div className="vc-remform-row">
            <input
              className="vc-field vc-field-when"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              aria-label="When"
            />
            <Press className="vc-sact" data-main data-busy={saving || undefined} disabled={!ready || saving} onPress={add}>
              <Icon name={saving ? 'refresh' : 'timer'} size={14} tone="fg" className={saving ? 'vl-pulse' : undefined} />{saving ? 'Adding' : 'Add'}
            </Press>
            <Press className="vc-sact vc-iact" aria-label="Close the form" title="Close the form" onPress={() => { setForm(false); setErr(null) }}>
              <Icon name="stop" size={15} tone="dim" />
            </Press>
          </div>
        </form>
      )}
      {shown.length > 0 ? (
        <div className="vc-rows">
          {shown.map((r) => {
            const on = armed === r.id
            return (
              <div key={r.id} className="vc-remrow" data-busy={canceling === r.id || undefined}>
                <span className="vc-row-main">
                  <span className="vc-remrow-when"><b>{dayClock(r.at, now)}</b><em>{until(r.at, now)}</em></span>
                  <span className="vc-remrow-msg">{r.message}</span>
                </span>
                <Press
                  className="vc-term-x"
                  data-armed={on || undefined}
                  disabled={canceling !== null}
                  aria-label={on ? 'Cancel this reminder now' : 'Cancel this reminder'}
                  title={on ? 'Tap again to cancel it' : 'Cancel this reminder'}
                  onPress={() => (on ? cancel(r) : setArmed(r.id))}
                >
                  <Icon name="stop" size={15} tone={on ? 'acc2' : 'dim'} />
                  {on && <span>Cancel?</span>}
                </Press>
              </div>
            )
          })}
        </div>
      ) : !form ? <p className="vc-pd-none">Nothing scheduled</p> : null}
      {err && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{err}</p>}
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

/**
 * Where a new session in a host's target opens: inside Valkyrie (a pane the
 * page attaches to; it reaches thor only), on the host's own screen (its
 * launcher agent), or here (the desktop app off thor: a terminal on this
 * screen over SSH to thor).
 */
type Way = 'page' | 'screen' | 'here'
/** the busy key of a start from this device's screen; '@' never starts a host name */
const HERE_SLOT = '@here'

function TargetPicker({ area, hostLabel, where, roomy, starting, error, onPick, onOdin }: {
  area: string
  hostLabel: (id: string) => string
  where: Where
  /** a wide screen: inside Valkyrie offers every target, not only the phone's short list */
  roomy: boolean
  /** the in-flight start's busy key: `${slot}:${target}` */
  starting: string | null
  /** the last start the host refused */
  error: string | null
  /** a start in `way`; `slot` is the plate's busy key prefix */
  onPick: (t: TargetVM, h: SessionHost, way: Way, slot: string) => void
  /** the backup host: Claude on odin itself, in a pane the page attaches to */
  onOdin: (t: TargetVM) => void
}) {
  // /api/session-hosts: which machines can start a session (falls back to thor on an older backend)
  const hosts = useLive<SessionHost[]>('claude.sessionHosts', fetchSessionHosts, 5 * 60_000)
  // inside Valkyrie by default on every device, the desktop app included
  const [way, setWay] = useState<Way>('page')
  const list = (hosts.data?.length ? hosts.data : THOR_ONLY)
    .slice()
    .sort((a, b) => Number(b.host === HOME_HOST) - Number(a.host === HOME_HOST) || Number(b.canLaunch) - Number(a.canLaunch) || a.host.localeCompare(b.host))
  // Odin sits right under thor, and leads while thor is not answering: that is when the backup is the point.
  const thorAt = list.findIndex((h) => h.host === HOME_HOST)
  const odinAt = thorAt >= 0 && !list[thorAt].canLaunch && !list[thorAt].canPage ? 0 : thorAt + 1
  const rows: (SessionHost | null)[] = [...list.slice(0, odinAt), null, ...list.slice(odinAt)]
  const thor = hostLabel(HOME_HOST)
  return (
    <div className="vc-targets vl-build-on">
      {error && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{error}</p>}
      {rows.map((h, n) => {
        if (!h) return <OdinSection key={ODIN_SLOT} k0={n * 6} starting={starting} hostLabel={hostLabel} onPick={onOdin} />
        const home = h.host === HOME_HOST
        // the ways this host offers from this device, inside Valkyrie first
        const ways: Way[] = home
          ? [...(h.canPage ? ['page' as const] : []), ...(h.canLaunch ? ['screen' as const] : []), ...(where.remote ? ['here' as const] : [])]
          : h.canLaunch ? ['screen'] : []
        const on = ways.includes(way) ? way : ways[0]
        const slot = on === 'page' ? h.host : on === 'here' ? HERE_SLOT : home ? SCREEN_SLOT : h.host
        const how = on === 'page' ? 'opens inside Valkyrie' : on === 'here' ? 'opens on this screen' : home ? `opens on ${thor}'s screen` : 'opens on its screen'
        const props: TargetListProps | null = on
          ? { host: h.host, slot, area, k0: n * 6 + (ways.length > 1 ? 2 : 1), phoneOnly: on === 'page' && !roomy, starting, onPick: (t: TargetVM) => onPick(t, h, on, slot) }
          : null
        return (
          <section key={h.host} className="vc-host" data-off={!on || undefined}>
            <header className="vc-host-head vl-build" style={iv(n * 6)}>
              <Icon name={hostIcon(h.host)} size={17} tone={on ? 'fg' : 'faint'} glow={!!on} />
              <span className="vc-host-name">{hostLabel(h.host)}</span>
              <span className="vc-host-how">
                {!on && <Icon name={!h.reachable ? 'offline' : 'alert'} size={12} tone="acc2" />}
                {on ? how : !h.reachable ? 'not answering' : 'cannot start sessions'}
              </span>
            </header>
            {ways.length > 1 && on && (
              <div className="vc-way vl-build" style={iv(n * 6 + 1)}>
                <Segmented<Way>
                  options={ways.map((w) => (w === 'page'
                    ? { value: w, label: 'In Valkyrie', icon: 'claude' as IconName }
                    : w === 'screen'
                      ? { value: w, label: `On ${thor}'s screen`, icon: hostIcon(HOME_HOST) }
                      : { value: w, label: 'On this screen', icon: 'mimir' as IconName }))}
                  value={on}
                  onChange={setWay}
                />
              </div>
            )}
            {!props ? (
              <p className="vc-pd-none vl-build" style={iv(n * 6 + 1)}>
                {!h.reachable ? `${hostLabel(h.host)} did not answer${h.detail ? ` (${h.detail})` : ''}. Try again in a minute.` : h.detail ?? 'no launcher agent'}
              </p>
            ) : home ? (
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
