import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { MapPin, Maximize2, Pencil, Repeat, Trash2, User, type LucideIcon } from 'lucide-react'
import { StatusStrip, desktopWindow } from '../kit/shell'
import { Button, DotFloor, Glyph, IconButton, Press, Segmented, ToastHost, cx } from '../kit/ui'
import { Icon, SlotIcon, type IconSlot } from '../kit/icons'
import { useTick, type EventVM } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import {
  addCalendarSource, createLocalEvent, deleteCalendarSource, deleteLocalEvent, fetchCalendarEvents, fetchCalendarSources,
  refreshCalendars, rruleText, updateCalendarSource, updateLocalEvent,
  type CalendarEvent, type CalendarSource, type LocalEvent, type LocalEventInput,
} from '../../lib/calendarApi'
import { addDays, dateKey, keyDate, startOfDay, startOfWeek } from '../../lib/calendarDates'
import './calendar.css'

// Valkyrie's calendar in v2, in two frames around one body:
//
//   - the sheet over the Dashboard (phone and iPad portrait): a bottom sheet
//     the Dashboard opens on a day, with its event focused;
//   - the full page at /m/calendar (desktop, iPad landscape, or the sheet's
//     full-screen button): the views across the top, the grid filling the
//     window, an event's details or the editor in a column on the right.
//
// Both have the five views of the classic page (day, work week, week, month,
// agenda) with back and forward, add / edit / delete for the events that live
// in Valkyrie (repeat, location, notes), and the calendars: connect an ICS
// feed, switch one on or off, recolor, remove, sync, and hide one on this
// device only (the legend). A wide screen asked for the sheet gets the page.
//
// Data: lib/calendarApi through react-query. A read covers a whole week (or
// the month grid), so stepping days inside it is instant, and the ranges
// either side are read ahead. Every write invalidates every calendar read,
// the Dashboard's persisted copy included. Until the first read lands, the
// sheet shows the Dashboard's own events (today and the next six days).

/** What the Dashboard opens the sheet on: a day (any ms in it) and, optionally, the event tapped. */
export type CalendarOpen = { day: number; focus?: string | null }

type View = 'day' | 'workweek' | 'week' | 'month' | 'agenda'
const VIEWS: { value: View; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'workweek', label: 'Work week' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'agenda', label: 'Agenda' },
]
const isView = (v: unknown): v is View => VIEWS.some((x) => x.value === v)
const isGrid = (v: View) => v === 'day' || v === 'workweek' || v === 'week'

/** The page takes over from the sheet at this width (the unzoomed window: media queries never see the UI zoom). */
const PAGE_QUERY = '(min-width: 1000px)'
const VIEW_KEY = 'v2.cal.view'

/** One event as v2 shows it. `id` matches the Dashboard's EventVM id (uid + start). */
type Ev = {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location: string
  color: string
  source: string
  sourceId: string
  notes: string
  organizer: string
  repeat: string
  status: string
  url: string
  /** present on events that live here (editable) */
  local?: LocalEvent
}

const fromApi = (e: CalendarEvent): Ev => ({
  id: e.uid + e.start,
  title: e.summary,
  start: Date.parse(e.start),
  end: Date.parse(e.end),
  allDay: e.allDay,
  location: e.location,
  color: e.color,
  source: e.sourceLabel,
  sourceId: e.sourceId,
  notes: e.description ?? '',
  organizer: e.organizer ?? '',
  repeat: e.local?.rrule ? rruleText(e.local.rrule) : e.recurring ? 'Repeats' : '',
  status: e.status ?? '',
  url: e.url ?? '',
  local: e.local,
})

const fromVM = (e: EventVM): Ev => ({
  id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, color: e.color, source: e.source,
  sourceId: '', notes: '', organizer: '', repeat: '', status: '', url: '',
})

// ---------- calendars hidden on this device (the classic page writes the same key) ----------

const HIDDEN_KEY = 'valkyrie-cal-hidden'
const readHidden = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
let hiddenNow = readHidden()
const hiddenListeners = new Set<() => void>()
const subscribeHidden = (l: () => void) => {
  hiddenListeners.add(l)
  return () => { hiddenListeners.delete(l) }
}

/** Every calendar read: this file's, the classic page's, and the Dashboard's persisted copy (kit/data useCalendar). */
function invalidateCalendar(qc: QueryClient) {
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'calendar' || (q.queryKey[0] === 'v2' && String(q.queryKey[1]).startsWith('calendar')),
  })
}

function useHidden(): [Set<string>, (id: string) => void] {
  const list = useSyncExternalStore(subscribeHidden, () => hiddenNow, () => hiddenNow)
  const set = useMemo(() => new Set(list), [list])
  const qc = useQueryClient()
  const toggle = useCallback((id: string) => {
    hiddenNow = hiddenNow.includes(id) ? hiddenNow.filter((x) => x !== id) : [...hiddenNow, id]
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenNow)) } catch { /* storage unavailable */ }
    hiddenListeners.forEach((l) => l())
    // the Dashboard filters at read time: read it again
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'v2' && String(q.queryKey[1]).startsWith('calendar') })
  }, [qc])
  return [set, toggle]
}

// ---------- small hooks ----------

function useMediaQ(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(query)
    mq.addEventListener('change', cb)
    return () => mq.removeEventListener('change', cb)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

/** An element's width in its own CSS px (a ResizeObserver: the UI zoom hides from media queries). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

// ---------- time helpers (local time, like the classic calendar) ----------

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
/** "9 AM", "12 PM" */
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? 'AM' : 'PM'}`
const longDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
const shortDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
const fullDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const monthName = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
const touches = (e: Ev, from: number, to: number) => e.start < to && e.end > from
const dayOf = (ms: number) => startOfDay(new Date(ms)).getTime()
const shift = (day: number, n: number) => addDays(new Date(day), n).getTime()
const keyOf = (ms: number) => dateKey(new Date(ms))
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
/** All-day in a day's column: flagged so, or timed and covering the whole day. */
const allDayIn = (e: Ev, day: number) => e.allDay || (e.start <= day && e.end >= shift(day, 1))

/** "Today", "Tomorrow", "Yesterday", else null */
function relDay(day: number, today: number): string | null {
  if (day === today) return 'Today'
  if (day === shift(today, 1)) return 'Tomorrow'
  if (day === shift(today, -1)) return 'Yesterday'
  return null
}

function until(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h >= 24) return `in ${Math.round(m / 1440)}d`
  const r = m % 60
  return r && h < 6 ? `in ${h}h ${r}m` : `in ${h}h`
}

const agoText = (iso: string | null) => {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** "October 12 to 18, 2026", "Sep 27 to Oct 3, 2026", "Dec 28, 2026 to Jan 3, 2027"; one day reads in full. */
function rangeTitle(first: number, last: number): string {
  if (first === last) return fullDay(first)
  const a = new Date(first)
  const b = new Date(last)
  if (a.getFullYear() !== b.getFullYear()) {
    const f = { month: 'short', day: 'numeric', year: 'numeric' } as const
    return `${a.toLocaleDateString('en-US', f)} to ${b.toLocaleDateString('en-US', f)}`
  }
  if (a.getMonth() !== b.getMonth()) {
    const f = { month: 'short', day: 'numeric' } as const
    return `${a.toLocaleDateString('en-US', f)} to ${b.toLocaleDateString('en-US', f)}, ${b.getFullYear()}`
  }
  return `${a.toLocaleDateString('en-US', { month: 'long' })} ${a.getDate()} to ${b.getDate()}, ${b.getFullYear()}`
}

// ---------- ranges ----------

/** The month grid around `anchor`: its first cell (a Sunday) and the rows it needs. */
function monthGrid(anchor: number) {
  const a = new Date(anchor)
  const first = new Date(a.getFullYear(), a.getMonth(), 1)
  const start = addDays(first, -first.getDay()).getTime()
  const days = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate()
  return { first: first.getTime(), start, rows: Math.ceil((first.getDay() + days) / 7), month: a.getMonth() }
}

/** The columns of a time-grid view: the day, Monday to Friday, or Sunday to Saturday. */
function gridDays(view: View, day: number): number[] {
  if (view === 'day') return [day]
  const sunday = startOfWeek(new Date(day)).getTime()
  return view === 'workweek' ? [1, 2, 3, 4, 5].map((i) => shift(sunday, i)) : [0, 1, 2, 3, 4, 5, 6].map((i) => shift(sunday, i))
}

/** What the API is asked for: a whole week for the grid views, the month grid, or the agenda's days. */
function readWindow(view: View, day: number, agendaDays: number): [number, number] {
  if (isGrid(view)) {
    const w = startOfWeek(new Date(day)).getTime()
    return [w, shift(w, 7)]
  }
  if (view === 'month') {
    const g = monthGrid(day)
    return [g.start, shift(g.start, g.rows * 7)]
  }
  return [day, shift(day, agendaDays)]
}

/** The visible span (first day, day after the last). */
function visibleSpan(view: View, day: number, agendaDays: number): [number, number] {
  if (isGrid(view)) {
    const d = gridDays(view, day)
    return [d[0], shift(d[d.length - 1], 1)]
  }
  if (view === 'month') {
    const g = monthGrid(day)
    return [g.first, new Date(new Date(g.first).getFullYear(), g.month + 1, 1).getTime()]
  }
  return [day, shift(day, agendaDays)]
}

/** One step back or forward: a day, a week, a month (today when it lands on this month, else the 1st), or a week of agenda. */
function stepFrom(view: View, day: number, n: number, today: number): number {
  if (view === 'day') return shift(day, n)
  if (view === 'month') {
    const d = new Date(day)
    const first = new Date(d.getFullYear(), d.getMonth() + n, 1)
    const t = new Date(today)
    return first.getFullYear() === t.getFullYear() && first.getMonth() === t.getMonth() ? today : first.getTime()
  }
  return shift(day, 7 * n)
}

const LIVE = { refetchInterval: 5 * 60_000, refetchOnWindowFocus: true, staleTime: 60_000 } as const
const readKey = (from: number, to: number) => ['calendar', 'v2', from, to] as const

// ---------- the shared body ----------

type EditSeed = { event?: LocalEvent; date?: string; startTime?: string; endTime?: string; allDay?: boolean }
type Side = { kind: 'edit'; seed: EditSeed } | { kind: 'feeds' } | null
type Notice = { text: string; undo?: () => Promise<unknown>; id: number }

function CalendarUI({ layout, init, enabled, seed, onClose, gripProps, onExpand, onPlace }: {
  layout: 'sheet' | 'page'
  init: { day: number; view: View; focus: string | null }
  /** reads run only while shown */
  enabled: boolean
  /** the Dashboard's events (today and the next six days), shown until the first read lands */
  seed?: EventVM[]
  onClose: () => void
  /** sheet: the drag-to-dismiss handlers for the grip around the head */
  gripProps?: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void
  }
  /** sheet: open the full page where the sheet is */
  onExpand?: (view: View, day: number, sel: string | null) => void
  /** page: the view and day changed (the URL follows) */
  onPlace?: (view: View, day: number) => void
}) {
  const sheet = layout === 'sheet'
  const qc = useQueryClient()
  const now = useTick(30_000)
  const today = dayOf(now)
  const [view, setView] = useState<View>(init.view)
  const [day, setDay] = useState(() => dayOf(init.day))
  const [sel, setSel] = useState<string | null>(init.focus)
  const [side, setSide] = useState<Side>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [hidden, toggleHidden] = useHidden()
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  // the page's side column needs room for a usable grid beside it
  const wide = !sheet && width >= 980
  const agendaDays = sheet ? 14 : 28

  const placeCb = useRef(onPlace)
  useLayoutEffect(() => { placeCb.current = onPlace })
  useEffect(() => {
    placeCb.current?.(view, day)
  }, [view, day])

  // ---- reads ----
  const [from, to] = readWindow(view, day, agendaDays)
  const q = useQuery({ queryKey: readKey(from, to), queryFn: () => fetchCalendarEvents(from, to), enabled, ...LIVE })
  const srcQ = useQuery({ queryKey: ['calendar', 'sources'], queryFn: fetchCalendarSources, enabled, staleTime: 60_000 })
  const sources = useMemo(() => srcQ.data?.sources ?? q.data?.sources ?? [], [srcQ.data, q.data])
  // the ranges either side, ahead of time
  useEffect(() => {
    if (!enabled) return
    for (const n of [-1, 1]) {
      const [f, t] = readWindow(view, stepFrom(view, day, n, today), agendaDays)
      void qc.prefetchQuery({ queryKey: readKey(f, t), queryFn: () => fetchCalendarEvents(f, t), staleTime: LIVE.staleTime })
    }
  }, [enabled, view, day, today, agendaDays, qc])

  const [spanA, spanB] = visibleSpan(view, day, agendaDays)
  const seedEvs = useMemo(() => (seed ?? []).map(fromVM), [seed])
  const apiEvs = useMemo(() => {
    if (!q.data) return undefined
    return q.data.events
      .filter((e) => !hidden.has(e.sourceId))
      .map(fromApi)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
  }, [q.data, hidden])
  const seedCovers = !!seed && spanA >= today && spanB <= shift(today, 7)
  const events = apiEvs ?? (seedCovers ? seedEvs : undefined)
  const fromSeed = !apiEvs && !!events
  const list = events ?? []
  const selected = sel ? list.find((e) => e.id === sel) ?? null : null
  const localCals = sources.filter((s) => s.kind === 'local')
  const failing = sources.filter((s) => s.enabled && s.error)

  // ---- actions ----
  const step = useCallback((n: number) => {
    setDay((d) => stepFrom(view, d, n, today))
    setSel(null)
  }, [view, today])
  const goToday = () => { setDay(today); setSel(null) }
  const changeView = (v: View) => {
    setView(v)
    if (!sheet) try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage unavailable */ }
  }
  const openDay = (d: number) => { setDay(d); changeView('day') }
  const pick = (id: string | null) => setSel((cur) => (id === null || cur === id ? null : id))
  const newEvent = (s?: EditSeed) => {
    const vis = isGrid(view) ? gridDays(view, day) : [day]
    const date = s?.date ?? keyOf(vis.includes(today) ? today : vis[0])
    setSide({ kind: 'edit', seed: { date, ...s } })
  }
  const say = useCallback((text: string, undo?: () => Promise<unknown>) => setNotice({ text, undo, id: Date.now() }), [])
  const sync = useSyncAll(say)
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), notice.undo ? 6000 : 2600)
    return () => window.clearTimeout(t)
  }, [notice])

  // ---- keys: arrows step, T is today, Escape closes the innermost thing ----
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    if (e.key === 'Escape') {
      if (typing && side?.kind !== 'edit') return
      e.preventDefault()
      if (side) setSide(null)
      else if (sel) setSel(null)
      else onClose()
      return
    }
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // the shell pages its tabs on the arrows: here they step the calendar
      e.preventDefault()
      e.stopImmediatePropagation()
      step(e.key === 'ArrowLeft' ? -1 : 1)
    } else if (e.key === 't' || e.key === 'T') {
      goToday()
    }
  }
  useLayoutEffect(() => { keys.current = onKey })
  useEffect(() => {
    if (!enabled) return
    const f = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', f, { capture: true })
    return () => window.removeEventListener('keydown', f, { capture: true })
  }, [enabled])

  // ---- sheet: a sideways swipe over the body steps (touch only: a mouse drags out new events) ----
  const swipe = useRef<{ id: number; x0: number; y0: number } | null>(null)
  const onBodyDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sheet || e.pointerType === 'mouse' || side) return
    swipe.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY }
  }
  const onBodyUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current
    swipe.current = null
    if (!s || s.id !== e.pointerId || e.type === 'pointercancel') return
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.6) return
    // a swipe is not a tap on the event under the finger
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    step(dx < 0 ? 1 : -1)
  }

  // an event's details open at the top of the sheet's body; a panel starts at its top
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (sheet && (sel || side || view === 'agenda')) bodyRef.current?.scrollTo({ top: 0 })
  }, [sheet, view, sel, side])

  // ---- the pieces ----
  const total = new Set(list.filter((e) => touches(e, spanA, spanB)).map((e) => e.id)).size
  const status = !events
    ? (q.isError ? 'The calendar is not answering' : 'Reading the calendar')
    : fromSeed ? 'Showing the Dashboard\'s copy while the calendar answers' : null

  const viewBody = (
    <ViewBody
      view={view}
      day={day}
      today={today}
      now={now}
      events={list}
      loading={!events}
      sel={sel}
      wide={!sheet}
      fit={!sheet}
      agendaDays={agendaDays}
      onPick={pick}
      onDay={openDay}
      onSelectDay={(d) => { setDay(d); setSel(null) }}
      onCreate={(s) => newEvent(s)}
    />
  )

  const panel = side?.kind === 'edit' ? (
    <Editor
      key={side.seed.event?.id ?? `${side.seed.date}${side.seed.startTime ?? ''}`}
      seed={side.seed}
      calendars={localCals}
      onClose={() => setSide(null)}
      onSaved={(what) => { setSide(null); say(what) }}
    />
  ) : side?.kind === 'feeds' ? (
    <Feeds sources={sources} onClose={() => setSide(null)} say={say} />
  ) : selected ? (
    <Detail
      e={selected}
      now={now}
      onClose={() => setSel(null)}
      onEdit={(ev) => setSide({ kind: 'edit', seed: { event: ev } })}
      onDeleted={(text, undo) => { setSel(null); say(text, undo) }}
    />
  ) : null

  const legend = <Legend sources={sources} hidden={hidden} onToggle={toggleHidden} failing={failing} />
  const noticeBar = notice && (
    <div className="cal-notice" key={notice.id} role="status">
      <span>{notice.text}</span>
      {notice.undo && (
        <Press
          className="cal-notice-btn"
          onPress={() => {
            const u = notice.undo
            setNotice(null)
            u?.().then(() => say('Put back'), (e: unknown) => say(`Undo failed: ${apiErrorText(e, 'no answer')}`))
          }}
        >
          <Icon name="undo" size={13} tone="hot" />Undo
        </Press>
      )}
    </div>
  )

  if (sheet) {
    const containsToday = today >= spanA && today < spanB
    return (
      <div className="cal-ui" data-layout="sheet" ref={rootRef}>
        <div className="cal-grip" {...gripProps}>
          <i />
          <div className="cal-head">
            <span className="cal-label"><Icon name="calendar" size={16} tone="fg" glow />Calendar</span>
            <IconButton className="cal-hbtn" icon="add" size={17} label="New event" lit={side?.kind === 'edit'} onPress={() => newEvent()} />
            <IconButton className="cal-hbtn" icon="settings" size={16} label="Calendars and feeds" lit={side?.kind === 'feeds'} onPress={() => setSide(side?.kind === 'feeds' ? null : { kind: 'feeds' })} />
            {onExpand && (
              <IconButton className="cal-hbtn" icon={<Lead C={Maximize2} size={15} />} label="Full screen" onPress={() => onExpand(view, day, sel)} />
            )}
            <Press className="cal-close vl-hit" aria-label="Close the calendar" onPress={onClose}>
              <Glyph name="close" size={11} />
            </Press>
          </div>
        </div>
        <ViewTabs view={view} onChange={(v) => { changeView(v); setSide(null) }} />
        <SheetBar
          view={view}
          day={day}
          today={today}
          containsToday={containsToday}
          count={events ? plural(total, 'event') : ''}
          onStep={step}
          onToday={goToday}
        />
        <div className="cal-body" data-cal-scroll ref={bodyRef} onPointerDown={onBodyDown} onPointerUp={onBodyUp} onPointerCancel={onBodyUp}>
          {side ? panel : (
            <>
              {panel}
              {status && <p className="cal-quiet">{status}</p>}
              {viewBody}
              <div className="cal-foot">{legend}</div>
            </>
          )}
        </div>
        {noticeBar}
      </div>
    )
  }

  // ---- the page ----
  const title = view === 'month'
    ? monthName(day)
    : view === 'agenda'
      ? rangeTitle(day, shift(day, agendaDays - 1))
      : (() => { const d = gridDays(view, day); return rangeTitle(d[0], d[d.length - 1]) })()
  const containsToday = today >= spanA && today < spanB
  return (
    <div className="cal-ui" data-layout="page" data-wide={wide || undefined} ref={rootRef}>
      <div className="cal-top">
        <div className="cal-nav">
          <Press className="cal-step vl-hit" aria-label={stepLabel(view, -1)} onPress={() => step(-1)}><Chev dir="left" /></Press>
          <Press className="cal-step vl-hit" aria-label={stepLabel(view, 1)} onPress={() => step(1)}><Chev dir="right" /></Press>
          <h2 className="cal-title" aria-live="polite">{title}</h2>
          {!containsToday && <Press className="vl-link vl-hit cal-today" onPress={goToday}>Today</Press>}
          {status && <span className="cal-status">{status}</span>}
        </div>
        <ViewTabs view={view} onChange={changeView} />
        <div className="cal-acts">
          {legend}
          <IconButton
            icon="refresh"
            size={16}
            label="Sync feeds"
            className={cx('cal-sync', sync.isPending && 'cal-spin')}
            disabled={sync.isPending}
            onPress={() => sync.mutate()}
          />
          <IconButton icon="settings" size={16} label="Calendars and feeds" lit={side?.kind === 'feeds'} onPress={() => setSide(side?.kind === 'feeds' ? null : { kind: 'feeds' })} />
          <Button icon="add" className="cal-new" onPress={() => newEvent()}>New event</Button>
        </div>
      </div>
      <div className="cal-main" data-side={(wide && panel) ? '' : undefined}>
        <div className="cal-view" data-cal-scroll data-view={view}>
          {!wide && panel && <div className="cal-inline">{panel}</div>}
          {viewBody}
        </div>
        {wide && panel && <aside className="cal-side" aria-label="Details">{panel}</aside>}
      </div>
      {noticeBar}
    </div>
  )
}

const stepLabel = (view: View, n: number) => {
  const unit = view === 'day' ? 'day' : view === 'month' ? 'month' : 'week'
  return n < 0 ? `Previous ${unit}` : `Next ${unit}`
}

/** Sync every feed now. */
function useSyncAll(say: (text: string) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: refreshCalendars,
    onSuccess: (r) => {
      invalidateCalendar(qc)
      const bad = r.results.filter((x) => x.error)
      say(bad.length ? `${bad[0].label}: ${bad[0].error}` : `Synced ${plural(r.results.length, 'feed')}`)
    },
    onError: (e: unknown) => say(`Sync failed: ${apiErrorText(e, 'no answer')}`),
  })
}

/** A lead icon where the kit set has none (lucide, in the kit's line style). */
const Lead = ({ C, size = 13, lit }: { C: LucideIcon; size?: number; lit?: boolean }) => (
  <C size={size} strokeWidth={size <= 13 ? 1.6 : 1.4} className={cx('vl-icon', lit ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />
)

function Chev({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden>
      <path d={dir === 'left' ? 'M6 1 1.5 6 6 11' : 'M2 1l4.5 5L2 11'} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

// ---------- view tabs and the sheet's range bar ----------

function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="cal-tabs" role="tablist" aria-label="Calendar view" data-no-swipe>
      {VIEWS.map((v) => (
        <Press
          key={v.value}
          role="tab"
          aria-selected={v.value === view}
          data-on={v.value === view || undefined}
          className="cal-tab"
          onPress={() => onChange(v.value)}
        >
          {v.label}
        </Press>
      ))}
    </div>
  )
}

function SheetBar({ view, day, today, containsToday, count, onStep, onToday }: {
  view: View; day: number; today: number; containsToday: boolean; count: string
  onStep: (n: number) => void
  onToday: () => void
}) {
  const rel = relDay(day, today)
  let top: string
  let bottom: string
  if (view === 'day') {
    top = rel ?? new Date(day).toLocaleDateString('en-US', { weekday: 'long' })
    bottom = rel ? longDay(day) : new Date(day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  } else if (view === 'month') {
    top = containsToday ? 'This month' : String(new Date(day).getFullYear())
    bottom = new Date(day).toLocaleDateString('en-US', { month: 'long' })
  } else if (view === 'agenda') {
    top = rel ? `From ${rel.toLowerCase()}` : 'From'
    bottom = shortDay(day)
  } else {
    const d = gridDays(view, day)
    const thisWeek = startOfWeek(new Date(today)).getTime()
    const w = startOfWeek(new Date(day)).getTime()
    top = w === thisWeek ? 'This week' : w === shift(thisWeek, 7) ? 'Next week' : w === shift(thisWeek, -7) ? 'Last week' : 'Week'
    const f = { month: 'short', day: 'numeric' } as const
    bottom = `${new Date(d[0]).toLocaleDateString('en-US', f)} to ${new Date(d[d.length - 1]).toLocaleDateString('en-US', f)}`
  }
  const lit = view === 'day' ? day === today : containsToday
  return (
    <div className="cal-bar">
      <Press className="cal-step vl-hit" aria-label={stepLabel(view, -1)} onPress={() => onStep(-1)}><Chev dir="left" /></Press>
      <div className="cal-bar-day" aria-live="polite">
        <span className="cal-bar-rel" data-today={lit || undefined}>{top}</span>
        <span className="cal-bar-date">{bottom}</span>
      </div>
      <Press className="cal-step vl-hit" aria-label={stepLabel(view, 1)} onPress={() => onStep(1)}><Chev dir="right" /></Press>
      <span className="cal-bar-end">
        {!lit
          ? <Press className="vl-link vl-hit cal-today" onPress={onToday}>Today</Press>
          : <span className="cal-count">{count}</span>}
      </span>
    </div>
  )
}

// ---------- the view ----------

function ViewBody({ view, day, today, now, events, loading, sel, wide, fit, agendaDays, onPick, onDay, onSelectDay, onCreate }: {
  view: View; day: number; today: number; now: number; events: Ev[]; loading: boolean; sel: string | null
  /** the page (wide cells, more per row) */
  wide: boolean
  /** the grid fits the hours into the scroller's height */
  fit: boolean
  agendaDays: number
  onPick: (id: string | null) => void
  onDay: (day: number) => void
  onSelectDay: (day: number) => void
  onCreate: (seed: EditSeed) => void
}) {
  if (view === 'month') {
    return <MonthView anchor={day} events={events} today={today} now={now} sel={sel} wide={wide} onPick={onPick} onDay={onDay} onSelectDay={onSelectDay} onCreate={onCreate} />
  }
  if (view === 'agenda') {
    return <Agenda from={day} days={agendaDays} events={events} today={today} now={now} sel={sel} wide={wide} loading={loading} onPick={onPick} onDay={onDay} />
  }
  return (
    <GridView
      days={gridDays(view, day)}
      events={events}
      now={now}
      sel={sel}
      loading={loading}
      fit={fit}
      heads={view !== 'day'}
      onPick={onPick}
      onDay={view === 'day' ? undefined : onDay}
      onCreate={onCreate}
    />
  )
}

// ---------- time grid: day, work week, week ----------

/** px per hour unless the grid fits itself to the window */
const HOUR_PX = 46
const SLOT_MIN = 30

type Placed = { e: Ev; top: number; height: number; col: number; cols: number }

/** Timed events laid out in columns where they overlap (a cluster shares its width). */
function place(events: Ev[], day: number, h0: number, hp: number): Placed[] {
  const dayEnd = shift(day, 1)
  const items = events
    .map((e) => ({ e, s: Math.max(e.start, day), t: Math.min(e.end, dayEnd) }))
    .sort((a, b) => a.s - b.s || b.t - a.t)
  const out: Placed[] = []
  let cluster: { item: (typeof items)[number]; col: number }[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) {
      const top = ((c.item.s - day) / HOUR_MS - h0) * hp
      const height = Math.max(22, ((c.item.t - c.item.s) / HOUR_MS) * hp - 2)
      out.push({ e: c.item.e, top, height, col: c.col, cols })
    }
    cluster = []
  }
  const colEnds: number[] = []
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) { flush(); colEnds.length = 0 }
    let col = colEnds.findIndex((end) => end <= it.s)
    if (col < 0) { col = colEnds.length; colEnds.push(it.t) } else colEnds[col] = it.t
    cluster.push({ item: it, col })
    clusterEnd = Math.max(clusterEnd === -Infinity ? it.t : clusterEnd, it.t)
  }
  if (cluster.length) flush()
  return out
}

/** The element's scale on screen (a UI zoom makes client px differ from its own CSS px). */
const scaleOf = (el: HTMLElement) => (el.offsetHeight ? el.getBoundingClientRect().height / el.offsetHeight : 1) || 1

function GridView({ days, events, now, sel, loading, fit, heads, onPick, onDay, onCreate }: {
  days: number[]
  events: Ev[]
  now: number
  sel: string | null
  loading: boolean
  fit: boolean
  /** the day headers over the columns */
  heads: boolean
  onPick: (id: string | null) => void
  onDay?: (day: number) => void
  onCreate: (seed: EditSeed) => void
}) {
  const n = days.length
  const today = dayOf(now)
  const rootRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  const gut = 46
  const colW = width ? (width - gut) / n : 200

  const cols = useMemo(() => days.map((d) => {
    const inDay = events.filter((e) => touches(e, d, shift(d, 1)))
    return { d, allDay: inDay.filter((e) => allDayIn(e, d)), timed: inDay.filter((e) => !allDayIn(e, d)) }
  }), [days, events])
  const anyAllDay = cols.some((c) => c.allDay.length)
  const anyTimed = cols.some((c) => c.timed.length)

  // the hours shown: 7 AM to 11 PM, stretched to hold every event (and now, on today)
  let lo = 7
  let hi = 23
  for (const c of cols) {
    for (const e of c.timed) {
      lo = Math.min(lo, Math.max(0, (Math.max(e.start, c.d) - c.d) / HOUR_MS))
      hi = Math.max(hi, Math.min(24, (Math.min(e.end, shift(c.d, 1)) - c.d) / HOUR_MS))
    }
  }
  const nowH = (now - today) / HOUR_MS
  if (days.includes(today)) { lo = Math.min(lo, nowH - 1); hi = Math.max(hi, Math.min(24, nowH + 0.5)) }
  const h0 = Math.max(0, Math.floor(lo))
  const h1 = Math.min(24, Math.ceil(hi))

  // the page: the hours fill the scroller's height (never under 30 px an hour; then it scrolls)
  const [fitPx, setFitPx] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!fit) return
    const root = rootRef.current
    const sc = root?.closest('[data-cal-scroll]') as HTMLElement | null
    if (!root || !sc) return
    const measure = () => {
      let top = 0
      for (let el: HTMLElement | null = root; el && el !== sc; el = el.offsetParent as HTMLElement | null) top += el.offsetTop
      const avail = sc.clientHeight - top - (stickyRef.current?.offsetHeight ?? 0) - 14
      setFitPx(Math.max(30, Math.min(72, Math.floor(avail / Math.max(1, h1 - h0)))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    if (stickyRef.current) ro.observe(stickyRef.current)
    return () => ro.disconnect()
  }, [fit, h0, h1])
  const hp = fit && fitPx ? fitPx : HOUR_PX

  const placed = useMemo(() => cols.map((c) => place(c.timed, c.d, h0, hp)), [cols, h0, hp])
  const nowTop = days.includes(today) ? (nowH - h0) * hp : null
  const next = useMemo(() => events.filter((e) => !e.allDay && e.start > now).sort((a, b) => a.start - b.start)[0] ?? null, [events, now])

  // the first event (or now) in view when the range opens
  const rangeKey = `${days[0]}:${n}`
  useLayoutEffect(() => {
    const root = rootRef.current
    const sc = root?.closest('[data-cal-scroll]') as HTMLElement | null
    if (!root || !sc) return
    // the sheet with an event's details on top: start there
    if (sel && !fit) { sc.scrollTo({ top: 0 }); return }
    const tops = placed.flat().map((p) => p.top)
    if (nowTop != null) tops.push(nowTop)
    const first = Math.min(...tops)
    if (!Number.isFinite(first)) { sc.scrollTo({ top: 0 }); return }
    let top = 0
    for (let el: HTMLElement | null = root; el && el !== sc; el = el.offsetParent as HTMLElement | null) top += el.offsetTop
    const stick = stickyRef.current?.offsetHeight ?? 0
    // nothing timed: the "Nothing this day" note stays in view while the now line still fits below it
    if (!placed.flat().length && top + stick + first + hp <= sc.clientHeight) { sc.scrollTo({ top: 0 }); return }
    sc.scrollTo({ top: Math.max(0, top + first - hp * 0.6) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, fitPx != null])

  // ---- new events: a mouse drags out a span; a tap picks the half hour ----
  const [drag, setDrag] = useState<{ d: number; a: number; b: number } | null>(null)
  const tap = useRef<{ d: number; slot: number; x: number; y: number } | null>(null)
  const slotPx = (hp * SLOT_MIN) / 60
  const slots = ((h1 - h0) * 60) / SLOT_MIN
  const slotAt = (e: ReactPointerEvent<HTMLElement>) => {
    const el = e.currentTarget
    const y = (e.clientY - el.getBoundingClientRect().top) / scaleOf(el)
    return Math.min(slots - 1, Math.max(0, Math.floor(y / slotPx)))
  }
  const minuteOf = (slot: number) => h0 * 60 + slot * SLOT_MIN
  const seedFor = (d: number, a: number, b: number): EditSeed => ({
    date: keyOf(d),
    startTime: hhmm(minuteOf(a)),
    endTime: hhmm(Math.min(24 * 60, minuteOf(b + 1))),
  })

  const narrow = colW < 74
  const rich = colW >= 150
  const vars = { '--n': n, '--hp': `${hp}px`, '--gut': `${gut}px` } as CSSProperties

  return (
    <div className="cal-g" ref={rootRef} style={vars} data-cols={n}>
      {(heads || anyAllDay) && (
        <div className="cal-g-sticky" ref={stickyRef}>
          {heads && (
            <div className="cal-g-row cal-g-heads">
              <span />
              {days.map((d) => {
                const date = new Date(d)
                const inner = (
                  <>
                    <b>{date.getDate()}</b>
                    <span>{date.toLocaleDateString('en-US', { weekday: narrow ? 'narrow' : n === 1 ? 'long' : 'short' })}</span>
                  </>
                )
                return onDay ? (
                  <Press key={d} className="cal-g-head" data-today={d === today || undefined} data-weekend={[0, 6].includes(date.getDay()) || undefined} aria-label={`${fullDay(d)}, open the day`} onPress={() => onDay(d)}>
                    {inner}
                  </Press>
                ) : (
                  <span key={d} className="cal-g-head" data-today={d === today || undefined}>{inner}</span>
                )
              })}
            </div>
          )}
          {anyAllDay && (
            <div className="cal-g-row cal-g-allday">
              <span className="cal-g-k">All day</span>
              {cols.map((c) => {
                const cap = n === 1 ? 99 : 3
                return (
                  <div key={c.d} className="cal-g-adcol">
                    {c.allDay.slice(0, cap).map((e) => (
                      <Press key={e.id} className="cal-tag" data-on={sel === e.id || undefined} style={{ '--c': e.color || undefined } as CSSProperties} title={e.title} onPress={() => onPick(e.id)}>
                        <span className="vl-ellipsis">{e.title || 'Busy'}</span>
                      </Press>
                    ))}
                    {c.allDay.length > cap && (
                      <Press className="cal-more" onPress={() => onDay?.(c.d)}>+{c.allDay.length - cap} more</Press>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {!anyTimed && !loading && n === 1 && <p className="cal-free">{anyAllDay ? 'Nothing timed this day' : 'Nothing this day'}</p>}
      <div className="cal-g-body" style={{ height: (h1 - h0) * hp }}>
        <div className="cal-g-hours" aria-hidden>
          {Array.from({ length: h1 - h0 }, (_, k) => (
            nowTop != null && Math.abs(nowTop - k * hp) < 14 ? null : <span key={k} data-first={k === 0 || undefined} style={{ top: k * hp }}>{hourLabel(h0 + k)}</span>
          ))}
          {nowTop != null && nowTop >= 0 && nowTop <= (h1 - h0) * hp && <span className="cal-g-nowk" style={{ top: nowTop }}>{clock(now)}</span>}
        </div>
        {cols.map((c, i) => {
          const isToday = c.d === today
          const sel2 = drag && drag.d === c.d ? { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) } : null
          return (
            <div
              key={c.d}
              className="cal-g-col"
              data-today={isToday || undefined}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return
                const slot = slotAt(e)
                if (e.pointerType === 'mouse') {
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ d: c.d, a: slot, b: slot })
                } else {
                  tap.current = { d: c.d, slot, x: e.clientX, y: e.clientY }
                }
              }}
              onPointerMove={(e) => {
                if (!drag || drag.d !== c.d) return
                const slot = slotAt(e)
                if (slot !== drag.b) setDrag({ ...drag, b: slot })
              }}
              onPointerUp={(e) => {
                if (drag && drag.d === c.d) {
                  const a = Math.min(drag.a, drag.b)
                  const b = Math.max(drag.a, drag.b)
                  setDrag(null)
                  if (sel && a === b) { onPick(null); return }
                  onCreate(seedFor(c.d, a, a === b ? a + 1 : b))
                  return
                }
                const t = tap.current
                tap.current = null
                if (!t || t.d !== c.d || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) return
                if (sel) onPick(null)
                else onCreate(seedFor(c.d, t.slot, t.slot + 1))
              }}
              onPointerCancel={() => { setDrag(null); tap.current = null }}
            >
              {sel2 && (
                <div className="cal-g-drag" style={{ top: sel2.lo * slotPx, height: (sel2.hi - sel2.lo + 1) * slotPx }}>
                  {clock(c.d + minuteOf(sel2.lo) * 60_000)} to {clock(c.d + minuteOf(sel2.hi + 1) * 60_000)}
                </div>
              )}
              {placed[i].map((p) => {
                const past = p.e.end <= now
                const live = p.e.start <= now && p.e.end > now
                const short = p.height < 40
                const w = colW / p.cols
                return (
                  <Press
                    key={p.e.id}
                    className="cal-ev"
                    data-on={sel === p.e.id || undefined}
                    data-past={past || undefined}
                    data-live={live || undefined}
                    data-short={short || undefined}
                    data-tight={w < 74 || undefined}
                    data-lines={!short && p.height >= 62 ? 2 : undefined}
                    style={{
                      top: p.top,
                      height: p.height,
                      left: `calc(${(p.col / p.cols) * 100}% + ${p.col ? 2 : 1}px)`,
                      width: `calc(${100 / p.cols}% - ${p.col ? 3 : 2}px)`,
                      '--c': p.e.color || undefined,
                    } as CSSProperties}
                    title={`${p.e.title || 'Busy'}\n${clock(p.e.start)} to ${clock(p.e.end)}${p.e.location ? `\n${p.e.location}` : ''}`}
                    aria-label={`${p.e.title || 'Busy'}, ${clock(p.e.start)} to ${clock(p.e.end)}${p.e.location ? `, ${p.e.location}` : ''}`}
                    onPress={() => onPick(p.e.id)}
                  >
                    <span className="cal-ev-title">{p.e.title || 'Busy'}</span>
                    {w >= 74 && (!short || rich) && (
                      <span className="cal-ev-meta">
                        {clock(p.e.start)}{rich ? ` to ${clock(p.e.end)}` : ''}{rich && p.e.location ? ` · ${p.e.location}` : ''}
                      </span>
                    )}
                    {rich && w >= 150 && next === p.e && isToday && <span className="cal-ev-when">{until(p.e.start - now)}</span>}
                    {rich && w >= 150 && live && <span className="cal-ev-when" data-live="">Now</span>}
                  </Press>
                )
              })}
              {isToday && nowTop != null && nowTop >= 0 && nowTop <= (h1 - h0) * hp && (
                <div className="cal-now" style={{ top: nowTop }} aria-label={`Now, ${clock(now)}`}><i /></div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- month ----------

function MonthView({ anchor, events, today, now, sel, wide, onPick, onDay, onSelectDay, onCreate }: {
  anchor: number; events: Ev[]; today: number; now: number; sel: string | null
  wide: boolean
  onPick: (id: string | null) => void
  onDay: (day: number) => void
  onSelectDay: (day: number) => void
  onCreate: (seed: EditSeed) => void
}) {
  const g = monthGrid(anchor)
  const cells = useMemo(() => Array.from({ length: g.rows * 7 }, (_, i) => shift(g.start, i)), [g.start, g.rows])
  const byDay = useMemo(() => {
    const map = new Map<number, Ev[]>()
    for (const d of cells) map.set(d, events.filter((e) => touches(e, d, shift(d, 1))))
    return map
  }, [cells, events])
  const selDay = dayOf(anchor)

  // wide: as many event lines as a cell holds
  const gridRef = useRef<HTMLDivElement>(null)
  const [rowH, setRowH] = useState(0)
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el || !wide) return
    const ro = new ResizeObserver(() => setRowH(el.clientHeight / g.rows))
    ro.observe(el)
    setRowH(el.clientHeight / g.rows)
    return () => ro.disconnect()
  }, [wide, g.rows])
  const cap = wide ? Math.max(1, Math.floor((rowH - 30) / 20)) : 0
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayList = byDay.get(selDay) ?? events.filter((e) => touches(e, selDay, shift(selDay, 1)))

  return (
    <div className="cal-m" data-wide={wide || undefined} style={{ '--rows': g.rows } as CSSProperties}>
      <div className="cal-m-names" aria-hidden>{names.map((x) => <span key={x}>{wide ? x : x[0]}</span>)}</div>
      <div className="cal-m-grid" ref={gridRef} role="grid" aria-label={monthName(anchor)}>
        {cells.map((d) => {
          const list = byDay.get(d) ?? []
          const other = new Date(d).getMonth() !== g.month
          const picked = !wide && d === selDay
          return (
            <div
              key={d}
              role="gridcell"
              className="cal-m-cell"
              data-other={other || undefined}
              data-today={d === today || undefined}
              data-on={picked || undefined}
              onClick={(e) => {
                if ((e.target as Element).closest('button')) return
                if (wide) onCreate({ date: keyOf(d), allDay: true })
                else onSelectDay(d)
              }}
            >
              <Press className="cal-m-num" aria-label={`${fullDay(d)}, open the day`} onPress={() => onDay(d)}>{new Date(d).getDate()}</Press>
              {wide ? (
                <div className="cal-m-evs">
                  {list.slice(0, list.length > cap ? cap - 1 : cap).map((e) => (
                    <Press
                      key={e.id}
                      className="cal-m-ev"
                      data-on={sel === e.id || undefined}
                      data-past={e.end <= now || undefined}
                      style={{ '--c': e.color || undefined } as CSSProperties}
                      title={e.title}
                      onPress={() => onPick(e.id)}
                    >
                      {!e.allDay && e.start >= d && <span className="cal-m-t">{clock(e.start).replace(':00', '').replace(' ', '').toLowerCase()}</span>}
                      <span className="vl-ellipsis">{e.title || 'Busy'}</span>
                    </Press>
                  ))}
                  {list.length > cap && <Press className="cal-more" onPress={() => onDay(d)}>+{list.length - cap + 1} more</Press>}
                </div>
              ) : (
                <span className="cal-m-dots" aria-label={plural(list.length, 'event')}>
                  {list.slice(0, 4).map((e) => <i key={e.id} style={{ background: e.color || undefined }} />)}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {!wide && (
        <div className="cal-m-day">
          <div className="cal-ahead cal-m-dayhead">
            <span className="cal-aday" data-today={selDay === today || undefined}>{relDay(selDay, today) ?? shortDay(selDay)}</span>
            {relDay(selDay, today) && <span className="cal-adate">{shortDay(selDay)}</span>}
            <Press className="vl-link vl-hit cal-m-add" onPress={() => onCreate({ date: keyOf(selDay) })}><Icon name="add" size={13} tone="dim" />Add</Press>
          </div>
          {dayList.length === 0 ? <p className="cal-free">Nothing this day</p> : dayList.map((e) => (
            <Press key={e.id} className="cal-arow" data-on={sel === e.id || undefined} data-past={e.end <= now || undefined} onPress={() => onPick(e.id)}>
              <span className="cal-atime" style={e.color ? { borderLeftColor: e.color } : undefined}>
                {e.allDay ? 'All day' : e.start < selDay ? 'Cont.' : clock(e.start)}
              </span>
              <span className="cal-atitle">{e.title || 'Busy'}</span>
            </Press>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- agenda: a day per group, free runs folded ----------

function Agenda({ from, days, events, today, now, sel, wide, loading, onPick, onDay }: {
  from: number; days: number; events: Ev[]; today: number; now: number; sel: string | null; wide: boolean; loading: boolean
  onPick: (id: string | null) => void
  onDay: (day: number) => void
}) {
  const groups = useMemo(() => {
    const out: ({ kind: 'day'; d: number; list: Ev[] } | { kind: 'free'; a: number; b: number })[] = []
    for (let k = 0; k < days; k++) {
      const d = shift(from, k)
      const list = events.filter((e) => touches(e, d, shift(d, 1)))
      const last = out[out.length - 1]
      if (list.length) out.push({ kind: 'day', d, list })
      else if (last?.kind === 'free') last.b = d
      else out.push({ kind: 'free', a: d, b: d })
    }
    return out
  }, [from, days, events])
  if (loading) return null
  const next = events.find((e) => !e.allDay && e.start > now) ?? null
  return (
    <div className="cal-agenda" data-wide={wide || undefined}>
      {groups.map((g) => g.kind === 'free' ? (
        <Press key={`f${g.a}`} className="cal-arow cal-afree" onPress={() => onDay(g.a)}>
          <span className="cal-aday">{relDay(g.a, today) ?? shortDay(g.a)}</span>
          <span className="cal-atitle">{g.a === g.b ? 'Free' : `Free through ${shortDay(g.b)}`}</span>
        </Press>
      ) : (
        <div key={g.d} className="cal-agroup">
          <Press className="cal-ahead" onPress={() => onDay(g.d)} aria-label={`${fullDay(g.d)}, open the day`}>
            <span className="cal-aday" data-today={g.d === today || undefined}>{relDay(g.d, today) ?? shortDay(g.d)}</span>
            {relDay(g.d, today) && <span className="cal-adate">{shortDay(g.d)}</span>}
            <span className="cal-acount">{plural(g.list.length, 'event')}</span>
            <Chev dir="right" />
          </Press>
          {g.list.map((e) => (
            <Press key={e.id} className="cal-arow" data-on={sel === e.id || undefined} data-past={e.end <= now || undefined} onPress={() => onPick(e.id)}>
              <span className="cal-atime" style={e.color ? { borderLeftColor: e.color } : undefined}>
                {e.allDay ? 'All day' : e.start < g.d ? 'Cont.' : clock(e.start)}
              </span>
              <span className="cal-atitle">{e.title || 'Busy'}</span>
              {wide && <span className="cal-aloc">{e.location}</span>}
              {wide && <span className="cal-asrc"><i className="cal-dot" style={{ '--c': e.color || undefined } as CSSProperties} />{e.source}</span>}
              {(wide || e === next) && <span className="cal-awhen">{e === next ? until(e.start - now) : ''}</span>}
            </Press>
          ))}
        </div>
      ))}
    </div>
  )
}

// ---------- one event's details ----------

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

/** The notes as plain text with their links live; long notes fold to a few lines. */
function Notes({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/_{8,}/g, '').trim()
  if (!clean) return null
  const long = clean.length > 280
  const shown = all || !long ? clean : `${clean.slice(0, 260).trimEnd()}…`
  const parts: ReactNode[] = shown.split(URL_RE).map((p, k) =>
    k % 2 ? <a key={k} href={p} target="_blank" rel="noopener noreferrer" className="cal-link">{p.length > 48 ? `${p.slice(0, 46)}…` : p}</a> : p)
  return (
    <div className="cal-notes">
      <p>{parts}</p>
      {long && <Press className="vl-link vl-hit" onPress={() => setAll((v) => !v)}>{all ? 'Show less' : 'Show all'}</Press>}
    </div>
  )
}

const localInput = (l: LocalEvent): LocalEventInput => ({
  sourceId: l.sourceId, title: l.title, notes: l.notes, location: l.location, allDay: l.allDay, start: l.start, end: l.end, rrule: l.rrule,
})

function Detail({ e, now, onClose, onEdit, onDeleted }: {
  e: Ev
  now: number
  onClose: () => void
  onEdit: (ev: LocalEvent) => void
  /** deleted: a line to show, and the Undo that puts it back */
  onDeleted: (text: string, undo: () => Promise<unknown>) => void
}) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const remove = useMutation({
    mutationFn: (id: string) => deleteLocalEvent(id),
    onSuccess: () => {
      invalidateCalendar(qc)
      const back = e.local ? localInput(e.local) : null
      // the Undo outlives this panel: a plain call, not a mutation hook
      onDeleted(`Deleted ${e.title || 'the event'}${e.local?.rrule ? ' and every repeat' : ''}`, async () => {
        if (!back) return
        await createLocalEvent(back)
        invalidateCalendar(qc)
      })
    },
    onError: (err: unknown) => setError(apiErrorText(err, 'Delete failed')),
  })
  const lastDay = new Date(e.end - 1)
  const when = e.allDay
    ? (dateKey(lastDay) === dateKey(new Date(e.start)) ? fullDay(e.start) : `${fullDay(e.start)} to ${fullDay(lastDay.getTime())}`)
    : `${fullDay(e.start)}, ${clock(e.start)} to ${clock(e.end)}`
  const live = !e.allDay && e.start <= now && e.end > now
  const soon = !e.allDay && e.start > now && e.start - now < DAY_MS
  const status = /cancel/i.test(e.status) ? 'Canceled' : /tentative/i.test(e.status) ? 'Tentative' : ''
  const local = e.local
  return (
    <section className="cal-detail" style={{ '--c': e.color || undefined } as CSSProperties} aria-label={`${e.title || 'Busy'}, details`}>
      <div className="cal-detail-head">
        <span className="cal-detail-title">{e.title || 'Busy'}</span>
        <Press className="cal-close vl-hit" aria-label="Close the details" onPress={onClose}>
          <Glyph name="close" size={11} />
        </Press>
      </div>
      {(live || soon || status) && (
        <div className="cal-detail-flag" data-live={live || undefined}>
          {status || (live ? `Now, until ${clock(e.end)}` : until(e.start - now))}
        </div>
      )}
      <dl className="cal-dl">
        <dt><Icon name="clock" size={13} tone="dim" /></dt>
        <dd className="cal-wrap">{when}</dd>
        {e.repeat && (<><dt><Lead C={Repeat} /></dt><dd>{e.repeat}</dd></>)}
        {e.location && (<><dt><Lead C={MapPin} /></dt><dd className="cal-wrap">{e.location}</dd></>)}
        {e.source && (<><dt><i className="cal-dot" /></dt><dd>{e.source}{local ? '' : ', read-only feed'}</dd></>)}
        {e.organizer && (<><dt><Lead C={User} /></dt><dd className="cal-wrap">{e.organizer.replace(/^mailto:/i, '')}</dd></>)}
      </dl>
      <Notes text={e.notes} />
      {e.url && (
        <a className="vl-link cal-url" href={e.url} target="_blank" rel="noopener noreferrer">
          <Icon name="enter" size={13} tone="dim" />Open the event link
        </a>
      )}
      {local && (
        <div className="cal-detail-acts">
          <Button kind="line" icon={<Lead C={Pencil} />} onPress={() => onEdit(local)}>Edit</Button>
          <Press className="vl-link vl-hit cal-del" disabled={remove.isPending} onPress={() => { setError(''); remove.mutate(local.id) }}>
            <Lead C={Trash2} />{remove.isPending ? 'Deleting' : local.rrule ? 'Delete every repeat' : 'Delete'}
          </Press>
          {error && <span className="cal-err">{error}</span>}
        </div>
      )}
    </section>
  )
}

// ---------- add and edit an event that lives here ----------

type Freq = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
type Draft = {
  sourceId: string; title: string; notes: string; location: string; allDay: boolean
  date: string; endDate: string; startTime: string; endTime: string; freq: Freq; interval: number
}

function draftFrom(seed: EditSeed, fallbackSource: string): Draft {
  const ev = seed.event
  if (ev) {
    return {
      sourceId: ev.sourceId,
      title: ev.title,
      notes: ev.notes,
      location: ev.location,
      allDay: ev.allDay,
      date: ev.start.slice(0, 10),
      endDate: ev.end.slice(0, 10),
      startTime: ev.allDay ? '09:00' : ev.start.slice(11, 16),
      endTime: ev.allDay ? '10:00' : ev.end.slice(11, 16),
      freq: (/FREQ=(\w+)/.exec(ev.rrule)?.[1] ?? '') as Freq,
      interval: Number(/INTERVAL=(\d+)/.exec(ev.rrule)?.[1] ?? 1),
    }
  }
  const date = seed.date ?? dateKey(new Date())
  return {
    sourceId: fallbackSource, title: '', notes: '', location: '', allDay: !!seed.allDay,
    date, endDate: date, startTime: seed.startTime ?? '09:00', endTime: seed.endTime ?? '10:00', freq: '', interval: 1,
  }
}

const ruleOf = (d: Pick<Draft, 'freq' | 'interval'>) => (d.freq ? (d.interval > 1 ? `FREQ=${d.freq};INTERVAL=${d.interval}` : `FREQ=${d.freq}`) : '')

function inputFrom(d: Draft): LocalEventInput {
  const rrule = ruleOf(d)
  const base = { sourceId: d.sourceId, title: d.title.trim(), notes: d.notes, location: d.location.trim(), rrule }
  if (d.allDay) return { ...base, allDay: true, start: d.date, end: d.endDate >= d.date ? d.endDate : d.date }
  // an end at or before the start runs past midnight
  const endDay = d.endTime > d.startTime ? d.date : dateKey(addDays(keyDate(d.date), 1))
  return { ...base, allDay: false, start: `${d.date}T${d.startTime}`, end: `${endDay}T${d.endTime}` }
}

const FREQS: { value: Freq; label: string }[] = [
  { value: '', label: 'Does not repeat' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
]

function Editor({ seed, calendars, onClose, onSaved }: {
  seed: EditSeed
  calendars: CalendarSource[]
  onClose: () => void
  onSaved: (what: string) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(seed, calendars[0]?.id ?? ''))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  // the local calendar can arrive after the editor opened
  const sourceId = draft.sourceId || calendars[0]?.id || ''
  const save = useMutation({
    mutationFn: () => {
      const input = inputFrom({ ...draft, sourceId })
      return seed.event ? updateLocalEvent(seed.event.id, input) : createLocalEvent(input)
    },
    onSuccess: () => {
      invalidateCalendar(qc)
      onSaved(seed.event ? `Saved ${draft.title.trim()}` : `Added ${draft.title.trim()}`)
    },
  })
  const canSave = !!draft.title.trim() && !!draft.date && !!sourceId && !save.isPending
  const submit = () => { if (canSave) save.mutate() }
  return (
    <section className="cal-edit" aria-label={seed.event ? 'Edit event' : 'New event'}>
      <div className="cal-panel-head">
        <span className="cal-panel-title"><Icon name="calendar" size={14} tone="fg" glow />{seed.event ? 'Edit event' : 'New event'}</span>
        <Press className="cal-close vl-hit" aria-label="Cancel" onPress={onClose}><Glyph name="close" size={11} /></Press>
      </div>
      <form className="cal-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <input className="cal-field cal-field-title" autoFocus value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Title" aria-label="Title" />
        <Segmented
          className="cal-seg"
          options={[{ value: 'timed', label: 'Timed' }, { value: 'allday', label: 'All day' }]}
          value={draft.allDay ? 'allday' : 'timed'}
          onChange={(v) => set('allDay', v === 'allday')}
        />
        <div className="cal-frow">
          <label className="cal-flabel cal-fhalf">
            <span>{draft.allDay ? 'From' : 'Date'}</span>
            <input
              type="date"
              className="cal-field"
              value={draft.date}
              onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, date: v, endDate: d.endDate < v ? v : d.endDate })) }}
            />
          </label>
          {draft.allDay && (
            <label className="cal-flabel cal-fhalf">
              <span>Through</span>
              <input type="date" className="cal-field" value={draft.endDate} min={draft.date} onChange={(e) => set('endDate', e.target.value)} />
            </label>
          )}
        </div>
        {!draft.allDay && (
          <div className="cal-frow">
            <label className="cal-flabel cal-fhalf">
              <span>Start</span>
              <input type="time" className="cal-field" value={draft.startTime} onChange={(e) => set('startTime', e.target.value)} />
            </label>
            <label className="cal-flabel cal-fhalf">
              <span>End{draft.endTime <= draft.startTime ? ', next day' : ''}</span>
              <input type="time" className="cal-field" value={draft.endTime} onChange={(e) => set('endTime', e.target.value)} />
            </label>
          </div>
        )}
        <div className="cal-frow">
          <label className="cal-flabel cal-fgrow">
            <span>Repeat</span>
            <select className="cal-field" value={draft.freq} onChange={(e) => set('freq', e.target.value as Freq)}>
              {FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          {draft.freq && (
            <label className="cal-flabel cal-ftime">
              <span>Every</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                className="cal-field"
                value={draft.interval}
                onChange={(e) => set('interval', Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
              />
            </label>
          )}
        </div>
        {draft.freq && <p className="cal-hint">Repeats {rruleText(ruleOf(draft))}</p>}
        {calendars.length > 1 && (
          <label className="cal-flabel">
            <span>Calendar</span>
            <select className="cal-field" value={sourceId} onChange={(e) => set('sourceId', e.target.value)}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <input className="cal-field" value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="Location" aria-label="Location" />
        <textarea className="cal-field" value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes" aria-label="Notes" rows={3} />
        <div className="cal-form-acts">
          <Button className="cal-save" disabled={!canSave} onPress={submit}>{save.isPending ? 'Saving' : 'Save'}</Button>
          <Press className="vl-link vl-hit" onPress={onClose}>Cancel</Press>
          {!sourceId && <span className="cal-err">No calendar here to add to</span>}
          {save.isError && <span className="cal-err">{apiErrorText(save.error, 'Save failed')}</span>}
        </div>
        <button type="submit" hidden />
      </form>
    </section>
  )
}

// ---------- calendars: the legend (this device) and the feeds (every device) ----------

function Legend({ sources, hidden, onToggle, failing }: {
  sources: CalendarSource[]
  hidden: Set<string>
  onToggle: (id: string) => void
  failing: CalendarSource[]
}) {
  const shown = sources.filter((s) => s.enabled)
  if (shown.length < 2 && !failing.length) return null
  return (
    <div className="cal-legend" role="group" aria-label="Calendars shown on this device">
      {shown.length > 1 && shown.map((s) => {
        const off = hidden.has(s.id)
        return (
          <Press
            key={s.id}
            className="cal-chip"
            data-off={off || undefined}
            aria-pressed={!off}
            title={off ? `Show ${s.label} here` : `Hide ${s.label} here`}
            style={{ '--c': s.color } as CSSProperties}
            onPress={() => onToggle(s.id)}
          >
            <i aria-hidden />{s.label}
          </Press>
        )
      })}
      {failing.map((s) => <span key={s.id} className="cal-err" title={s.error ?? ''}>{s.label}: {s.error}</span>)}
    </div>
  )
}

const COLORS = ['#00ff41', '#00b4ff', '#00ffe5', '#ff9f1c', '#ff4d6d', '#b388ff', '#ffe066', '#f4f4f4']

function Feeds({ sources, onClose, say }: { sources: CalendarSource[]; onClose: () => void; say: (text: string) => void }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(COLORS[1])
  const [error, setError] = useState('')
  const [painting, setPainting] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const done = () => invalidateCalendar(qc)
  const fail = (what: string) => (e: unknown) => setError(apiErrorText(e, what))
  const add = useMutation({
    mutationFn: () => addCalendarSource({ label: label.trim() || 'Feed', url: url.trim(), color }),
    onSuccess: (r) => { setUrl(''); setLabel(''); setError(''); done(); say(`Connected ${r.source.label}`) },
    onError: fail('Could not add that feed'),
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ color: string; enabled: boolean }> }) => updateCalendarSource(id, body),
    onSuccess: () => { setError(''); done() },
    onError: fail('Could not change that calendar'),
  })
  const remove = useMutation({
    mutationFn: (s: CalendarSource) => deleteCalendarSource(s.id),
    onSuccess: (_r, s) => { setArmed(null); done(); say(`Removed ${s.label}`) },
    onError: fail('Could not remove that calendar'),
  })
  const sync = useSyncAll(say)
  return (
    <section className="cal-feeds" aria-label="Calendars and feeds">
      <div className="cal-panel-head">
        <span className="cal-panel-title"><Icon name="settings" size={14} tone="fg" glow />Calendars</span>
        <Press className="vl-link vl-hit" disabled={sync.isPending} onPress={() => sync.mutate()}>
          <Icon name="refresh" size={13} tone="dim" className={sync.isPending ? 'cal-spin-ic' : undefined} />{sync.isPending ? 'Syncing' : 'Sync now'}
        </Press>
        <Press className="cal-close vl-hit" aria-label="Close" onPress={onClose}><Glyph name="close" size={11} /></Press>
      </div>
      <ul className="cal-srcs">
        {sources.map((s) => (
          <li key={s.id} className="cal-src" data-off={!s.enabled || undefined}>
            <div className="cal-src-row">
              <Press
                className="cal-swatch"
                style={{ '--c': s.color } as CSSProperties}
                data-on={painting === s.id || undefined}
                aria-label={`Change the color of ${s.label}`}
                aria-expanded={painting === s.id}
                onPress={() => setPainting(painting === s.id ? null : s.id)}
              />
              <div className="cal-src-main">
                <b>{s.label}</b>
                <span className={s.error ? 'cal-err' : undefined}>
                  {s.kind === 'local' ? 'Lives in Valkyrie, editable' : s.error ? s.error : `Synced ${agoText(s.fetchedAt)} · ${s.urlHint}`}
                </span>
              </div>
              <Press
                className="cal-src-on"
                data-on={s.enabled || undefined}
                aria-pressed={s.enabled}
                title={s.enabled ? 'On for every device: press to turn it off' : 'Off for every device: press to turn it on'}
                onPress={() => patch.mutate({ id: s.id, body: { enabled: !s.enabled } })}
              >
                {s.enabled ? 'On' : 'Off'}
              </Press>
              {s.kind === 'ics' && (
                <Press
                  className="cal-src-del vl-hit"
                  data-armed={armed === s.id || undefined}
                  aria-label={armed === s.id ? `Confirm: remove ${s.label}` : `Remove ${s.label}`}
                  disabled={remove.isPending}
                  onPress={() => (armed === s.id ? remove.mutate(s) : setArmed(s.id))}
                >
                  <Lead C={Trash2} />{armed === s.id && <span>Remove</span>}
                </Press>
              )}
            </div>
            {painting === s.id && (
              <div className="cal-swatches" role="radiogroup" aria-label={`${s.label} color`}>
                {COLORS.map((c) => (
                  <Press
                    key={c}
                    role="radio"
                    aria-checked={c.toLowerCase() === s.color.toLowerCase()}
                    data-on={c.toLowerCase() === s.color.toLowerCase() || undefined}
                    className="cal-swatch"
                    style={{ '--c': c } as CSSProperties}
                    aria-label={c}
                    onPress={() => { setPainting(null); patch.mutate({ id: s.id, body: { color: c } }) }}
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="cal-form cal-addfeed" onSubmit={(e) => { e.preventDefault(); if (url.trim() && !add.isPending) add.mutate() }}>
        <span className="cal-flabel-k">Connect a feed</span>
        <div className="cal-frow">
          <input className="cal-field cal-fname" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name" aria-label="Feed name" />
          <input className="cal-field cal-fgrow cal-furl" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ICS link (webcal:// or https://)" aria-label="ICS link" inputMode="url" />
        </div>
        <div className="cal-frow cal-frow-mid">
          <span className="cal-swatches" role="radiogroup" aria-label="New feed color">
            {COLORS.map((c) => (
              <Press key={c} role="radio" aria-checked={c === color} data-on={c === color || undefined} className="cal-swatch" style={{ '--c': c } as CSSProperties} aria-label={c} onPress={() => setColor(c)} />
            ))}
          </span>
          <Button kind="line" icon="add" className="cal-connect" disabled={!url.trim() || add.isPending} onPress={() => { if (url.trim()) add.mutate() }}>
            {add.isPending ? 'Connecting' : 'Connect'}
          </Button>
        </div>
        {error && <p className="cal-err">{error}</p>}
        <p className="cal-hint">Read-only: a feed's events show here and are edited where they came from.</p>
        <button type="submit" hidden />
      </form>
    </section>
  )
}

// ---------- the sheet ----------

export function CalendarSheet({ open, onClose, seed }: {
  /** null while closed; a new object opens it on that day */
  open: CalendarOpen | null
  onClose: () => void
  /** the Dashboard's events (today and the next six days), shown until the sheet's own read lands */
  seed?: EventVM[]
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose })
  const backDown = useRef(false)
  const navigate = useNavigate()
  const pageWide = useMediaQ(PAGE_QUERY)
  const want = !!open && !pageWide
  // mounted for the slide in, held for the slide out; shown drives the slide
  const [mounted, setMounted] = useState(want)
  const [shown, setShown] = useState(false)
  if (want && !mounted) setMounted(true)
  if (!want && shown) setShown(false)
  // each open is a fresh body on the day (and event) the Dashboard asked for
  const [cur, setCur] = useState<{ o: CalendarOpen | null; gen: number }>({ o: open, gen: 0 })
  if (open && open !== cur.o) setCur({ o: open, gen: cur.gen + 1 })
  const [opened] = useState(() => Date.now())

  // a wide screen gets the full page instead
  useEffect(() => {
    if (!open || !pageWide) return
    navigate(calendarUrl(storedView(), open.day, open.focus ?? null), { state: { v2Back: true } })
    close.current()
  }, [open, pageWide, navigate])

  useEffect(() => {
    if (want) {
      let r2 = 0
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
    }
    const t = setTimeout(() => setMounted(false), 360)
    return () => clearTimeout(t)
  }, [want])

  // drag the grip down to dismiss
  const drag = useRef<{ id: number; y0: number; dy: number; t: number; vy: number } | null>(null)
  const gripProps = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if ((e.target as Element).closest('button')) return
      drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, vy: 0 }
      e.currentTarget.setPointerCapture(e.pointerId)
      panel.current?.setAttribute('data-drag', '')
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      const dy = Math.max(0, e.clientY - d.y0)
      d.vy = (dy - d.dy) / Math.max(1, e.timeStamp - d.t)
      d.dy = dy
      d.t = e.timeStamp
      panel.current?.style.setProperty('--drag', `${dy}px`)
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      drag.current = null
      panel.current?.removeAttribute('data-drag')
      panel.current?.style.removeProperty('--drag')
      if (d.dy > 90 || (d.dy > 20 && d.vy > 0.5)) close.current()
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== e.pointerId) return
      drag.current = null
      panel.current?.removeAttribute('data-drag')
      panel.current?.style.removeProperty('--drag')
    },
  }

  if (!mounted || pageWide) return null
  return createPortal(
    <div className="cal-root" data-shown={shown || undefined} data-no-swipe>
      {/* closes on a press that began on it: the sheet mounts inside the opening tap, so the
          click a touch screen sends after it lands here and would shut the sheet at once */}
      <div className="cal-back" onPointerDown={() => { backDown.current = true }} onClick={() => { if (backDown.current) close.current(); backDown.current = false }} />
      <div className="cal-sheet" ref={panel} role="dialog" aria-modal="true" aria-label="Calendar">
        <CalendarUI
          key={cur.gen}
          layout="sheet"
          init={{ day: cur.o?.day ?? opened, view: 'day', focus: cur.o?.focus ?? null }}
          enabled={!!open}
          seed={seed}
          onClose={() => close.current()}
          gripProps={gripProps}
          onExpand={(view, day, sel) => {
            close.current()
            navigate(calendarUrl(view, day, sel), { state: { v2Back: true } })
          }}
        />
      </div>
    </div>,
    document.body,
  )
}

/** The view the page opens on: the last one used there, else Week on a wide screen and Day on a narrow one. */
function storedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    if (isView(v)) return v
  } catch { /* storage unavailable */ }
  return window.matchMedia(PAGE_QUERY).matches ? 'week' : 'day'
}

function calendarUrl(view: View, day: number, focus: string | null): string {
  const p = new URLSearchParams({ view, date: keyOf(day) })
  if (focus) p.set('focus', focus)
  return `/m/calendar?${p.toString()}`
}

// ---------- a full page outside the tabs (Calendar, Meals) ----------

/** The caret notch under the page title (the shell's own, drawn the same way). */
function Notch() {
  return (
    <svg width="14" height="7" viewBox="0 0 14 7">
      <rect x="1.2" y="5.4" width="11.6" height="2" fill="#000" />
      <path d="M0.6 6.5 7 1.2 13.4 6.5" fill="#000" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="miter" />
    </svg>
  )
}

/**
 * A full v2 page reached from the Dashboard: the status strip, then a header
 * row like Settings' (back to the Dashboard on the left, the page's title lit
 * with the caret under it), then the page. `scroll` makes the page one
 * scroller; without it the child fills the window and scrolls itself.
 */
export function PageFrame({ id, title, icon, scroll = false, children }: {
  id: string
  title: string
  icon: IconSlot
  scroll?: boolean
  children: ReactNode
}) {
  const navigate = useNavigate()
  const back = () => {
    const st = window.history.state as { usr?: { v2Back?: boolean } } | null
    if (st?.usr?.v2Back) navigate(-1)
    else navigate('/m/dashboard', { replace: true })
  }
  useEffect(() => {
    document.title = `${title} · Valkyrie`
  }, [title])
  return (
    <div className="vl-shell vpg" data-screen={id}>
      <div className="vl-shell-backdrop"><DotFloor className="vl-floor-faint vpg-floor" /></div>
      <header className="vl-head">
        <StatusStrip onSettings={() => navigate('/m/settings', { state: { v2Back: true } })} />
        <div className="vl-setbar" data-no-swipe data-tauri-drag-region={desktopWindow() ? 'deep' : undefined}>
          <Press className="vl-setbar-back" aria-label="Back to the Dashboard" onPress={back}>
            <Glyph name="left" size={11} />
            <span>Dashboard</span>
          </Press>
          <h1 className="vl-setbar-title">
            <SlotIcon icon={icon} size={14} lit />
            <span>{title}</span>
          </h1>
          <div className="vl-nav-line" />
          <div className="vl-notch vl-setbar-notch" aria-hidden><Notch /></div>
        </div>
      </header>
      <div className="vpg-mid">
        <main className="vpg-main" data-scroll={scroll || undefined}>{children}</main>
        <ToastHost className="vpg-toasts" />
      </div>
    </div>
  )
}

// ---------- the page: /m/calendar ----------

/** /m/calendar?view=week&date=2026-10-18&focus=<event id>: the calendar filling the window. */
export function CalendarPage() {
  const [params, setParams] = useSearchParams()
  const [init] = useState(() => {
    const d = params.get('date')
    const v = params.get('view')
    return {
      day: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? keyDate(d).getTime() : Date.now(),
      view: isView(v) ? v : storedView(),
      focus: params.get('focus'),
    }
  })
  const navigate = useNavigate()
  const onPlace = useCallback((view: View, day: number) => {
    setParams({ view, date: keyOf(day) }, { replace: true, state: window.history.state?.usr })
  }, [setParams])
  return (
    <PageFrame id="calendar" title="Calendar" icon="calendar">
      <CalendarUI
        layout="page"
        init={init}
        enabled
        onClose={() => {
          const st = window.history.state as { usr?: { v2Back?: boolean } } | null
          if (st?.usr?.v2Back) navigate(-1)
          else navigate('/m/dashboard', { replace: true })
        }}
        onPlace={onPlace}
      />
    </PageFrame>
  )
}
