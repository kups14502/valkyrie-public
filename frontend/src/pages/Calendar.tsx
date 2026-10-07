import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, MapPin, Plus, RefreshCw, Repeat, Settings2, Trash2 } from 'lucide-react'
import { apiErrorText } from '../lib/api'
import { BTN_ACCENT, BTN_GHOST, BTN_TEXT, FIELD, LABEL, Sheet } from '../components/projects/Sheet'
import {
  addCalendarSource, createLocalEvent, deleteCalendarSource, deleteLocalEvent, fetchCalendarEvents,
  refreshCalendars, rruleText, updateCalendarSource, updateLocalEvent,
  type CalendarEvent, type CalendarSource, type LocalEvent, type LocalEventInput,
} from '../lib/calendarApi'
import { DAY_MS, addDays, addMonths, dateKey, keyDate, startOfDay, startOfWeek, timeLabel } from '../lib/calendarDates'
import { TimeGrid, type SlotSeed } from '../components/calendar/TimeGrid'

// The calendar is Valkyrie's own: it renders with nothing connected, events
// can be added here, and connected feeds (the work calendar) fill it in.

type View = 'day' | 'workweek' | 'week' | 'month' | 'agenda'

// Outlook's set, plus the agenda list the phone reads best.
const VIEWS: { id: View; label: string }[] = [
  { id: 'day', label: 'day' },
  { id: 'workweek', label: 'work week' },
  { id: 'week', label: 'week' },
  { id: 'month', label: 'month' },
  { id: 'agenda', label: 'agenda' },
]
const isGrid = (v: View) => v === 'day' || v === 'workweek' || v === 'week'

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const dayHeading = (d: Date) => {
  const today = dateKey(new Date())
  const key = dateKey(d)
  const label = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  if (key === today) return `today · ${label}`
  if (key === dateKey(addDays(new Date(), 1))) return `tomorrow · ${label}`
  return label
}

const relative = (iso: string | null) => {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** The window the API is asked for, wide enough that the visible range and a
 *  bit of scroll either side come from one fetch. */
function windowFor(view: View, anchor: Date): { from: number; to: number } {
  if (isGrid(view)) {
    const days = gridDays(view, anchor)
    return { from: addDays(days[0], -1).getTime(), to: addDays(days[days.length - 1], 2).getTime() }
  }
  if (view === 'agenda') {
    const from = startOfDay(anchor).getTime()
    return { from, to: from + 45 * DAY_MS }
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  return { from: addDays(first, -7).getTime(), to: addMonths(first, 1).getTime() + 7 * DAY_MS }
}

/** The columns of a time-grid view: one day, Monday to Friday, or Sunday to Saturday. */
function gridDays(view: View, anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)]
  const sunday = startOfWeek(anchor)
  return view === 'workweek'
    ? Array.from({ length: 5 }, (_, i) => addDays(sunday, i + 1))
    : Array.from({ length: 7 }, (_, i) => addDays(sunday, i))
}

/** `October 5–9, 2026`, `Sep 27 – Oct 3, 2026`, or `Dec 28, 2026 – Jan 3, 2027`. */
function rangeTitle(first: Date, last: Date): string {
  if (first.getTime() === last.getTime()) {
    return first.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }
  if (first.getFullYear() !== last.getFullYear()) {
    const f = { month: 'short', day: 'numeric', year: 'numeric' } as const
    return `${first.toLocaleDateString([], f)} – ${last.toLocaleDateString([], f)}`
  }
  if (first.getMonth() !== last.getMonth()) {
    const f = { month: 'short', day: 'numeric' } as const
    return `${first.toLocaleDateString([], f)} – ${last.toLocaleDateString([], f)}, ${last.getFullYear()}`
  }
  return `${first.toLocaleDateString([], { month: 'long' })} ${first.getDate()}–${last.getDate()}, ${last.getFullYear()}`
}

/** Every day key an event covers, so a multi-day event shows on each. */
function eventDays(ev: CalendarEvent): string[] {
  const start = startOfDay(new Date(ev.start))
  const endMs = Date.parse(ev.end)
  const out = [dateKey(start)]
  for (let d = addDays(start, 1); d.getTime() < endMs && out.length < 62; d = addDays(d, 1)) out.push(dateKey(d))
  return out
}

function useWide() {
  const query = '(min-width: 640px)'
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

const TAB_CLS = '-mb-px shrink-0 whitespace-nowrap border-b-2 py-2.5 text-[11px] uppercase tracking-[0.14em] transition-colors sm:py-2'
const TAB_ON = 'border-[var(--color-accent)] text-[var(--color-accent)]'
const TAB_OFF = 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
const ICON_BTN = 'inline-flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-40 sm:h-8 sm:w-8'
const DATE_FIELD = `${FIELD} [color-scheme:dark]`

function EventRow({ event, onOpen }: { event: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className="flex w-full items-start gap-3 border-l-2 py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)]"
      style={{ borderLeftColor: event.color }}
    >
      <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-[var(--color-text-faint)]">
        {event.allDay ? 'all day' : timeLabel(event.start)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--color-text)]">{event.summary}</span>
        {(event.location || event.recurring) && (
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-text-dim)]">
            {event.recurring && (
              <span className="flex shrink-0 items-center gap-1">
                <Repeat size={10} />
                {event.local?.rrule ? rruleText(event.local.rrule) : ''}
              </span>
            )}
            {event.location && (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin size={10} className="shrink-0" />
                <span className="truncate">{event.location}</span>
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-xs text-[var(--color-text-dim)]">{children}</dd>
    </div>
  )
}

function EventDetail({ event, onClose, onEdit }: { event: CalendarEvent; onClose: () => void; onEdit: (e: LocalEvent) => void }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteLocalEvent(event.local!.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['calendar'] }); onClose() },
  })
  const start = new Date(event.start)
  const end = new Date(event.end)
  const day = (d: Date) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const lastDay = new Date(end.getTime() - 1)
  const when = event.allDay
    ? (dateKey(lastDay) === dateKey(start) ? day(start) : `${day(start)} – ${day(lastDay)}`)
    : `${day(start)}, ${timeLabel(event.start)} – ${timeLabel(event.end)}`
  const repeat = event.local?.rrule ? rruleText(event.local.rrule) : event.recurring ? 'repeats' : ''
  const local = event.local

  return (
    <Sheet
      title={event.summary}
      onClose={onClose}
      footer={local && (
        <>
          <button type="button" onClick={() => onEdit(local)} className={BTN_ACCENT}>edit</button>
          <button
            type="button"
            onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
            disabled={remove.isPending}
            className={`${BTN_TEXT} ${confirming ? 'text-[var(--color-danger)]' : ''}`}
          >
            <Trash2 size={12} /> {confirming ? (local.rrule ? 'delete every repeat' : 'confirm delete') : 'delete'}
          </button>
          {remove.isError && <span className="text-xs text-[var(--color-danger)]">{apiErrorText(remove.error, 'delete failed')}</span>}
        </>
      )}
    >
      <dl className="space-y-2">
        <DetailRow label="when">{when}</DetailRow>
        {repeat && <DetailRow label="repeat">{repeat}</DetailRow>}
        <DetailRow label="cal">
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5" style={{ backgroundColor: event.color }} />
            {event.sourceLabel}
          </span>
        </DetailRow>
        {event.location && <DetailRow label="where">{event.location}</DetailRow>}
        {event.organizer && <DetailRow label="host">{event.organizer}</DetailRow>}
        {event.description && <DetailRow label="notes">{event.description.slice(0, 4000)}</DetailRow>}
      </dl>
    </Sheet>
  )
}

type Freq = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

type Draft = {
  sourceId: string
  title: string
  notes: string
  location: string
  allDay: boolean
  date: string
  endDate: string
  startTime: string
  endTime: string
  freq: Freq
  interval: number
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
    sourceId: fallbackSource, title: '', notes: '', location: '', allDay: Boolean(seed.allDay),
    date, endDate: date, startTime: seed.startTime ?? '09:00', endTime: seed.endTime ?? '10:00', freq: '', interval: 1,
  }
}

function inputFrom(d: Draft): LocalEventInput {
  const rrule = d.freq ? (d.interval > 1 ? `FREQ=${d.freq};INTERVAL=${d.interval}` : `FREQ=${d.freq}`) : ''
  if (d.allDay) {
    return {
      sourceId: d.sourceId, title: d.title.trim(), notes: d.notes, location: d.location.trim(),
      allDay: true, start: d.date, end: d.endDate >= d.date ? d.endDate : d.date, rrule,
    }
  }
  // An end time at or before the start means the event runs past midnight.
  const endDay = d.endTime > d.startTime ? d.date : dateKey(addDays(keyDate(d.date), 1))
  return {
    sourceId: d.sourceId, title: d.title.trim(), notes: d.notes, location: d.location.trim(),
    allDay: false, start: `${d.date}T${d.startTime}`, end: `${endDay}T${d.endTime}`, rrule,
  }
}

type EditSeed = { event?: LocalEvent } & Partial<SlotSeed>

function EventEditor({ seed, calendars, onClose }: { seed: EditSeed; calendars: CalendarSource[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(seed, calendars[0]?.id ?? ''))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const save = useMutation({
    mutationFn: () => (seed.event ? updateLocalEvent(seed.event.id, inputFrom(draft)) : createLocalEvent(inputFrom(draft))),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['calendar'] }); onClose() },
  })
  const canSave = draft.title.trim() && draft.date && !save.isPending

  return (
    <Sheet
      title={seed.event ? 'edit event' : 'new event'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={() => save.mutate()} disabled={!canSave} className={BTN_ACCENT}>
            {save.isPending ? 'saving' : 'save'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
          {save.isError && <span className="text-xs text-[var(--color-danger)]">{apiErrorText(save.error, 'save failed')}</span>}
        </>
      )}
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate() }}>
        <input
          autoFocus
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="title"
          className={FIELD}
        />
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[9.5rem] flex-1">
            <span className={LABEL}>{draft.allDay ? 'from' : 'date'}</span>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value, endDate: d.endDate < e.target.value ? e.target.value : d.endDate }))}
              className={DATE_FIELD}
            />
          </label>
          {draft.allDay ? (
            <label className="min-w-[9.5rem] flex-1">
              <span className={LABEL}>through</span>
              <input type="date" value={draft.endDate} min={draft.date} onChange={(e) => set('endDate', e.target.value)} className={DATE_FIELD} />
            </label>
          ) : (
            <>
              <label className="w-[7.5rem]">
                <span className={LABEL}>start</span>
                <input type="time" value={draft.startTime} onChange={(e) => set('startTime', e.target.value)} className={DATE_FIELD} />
              </label>
              <label className="w-[7.5rem]">
                <span className={LABEL}>end</span>
                <input type="time" value={draft.endTime} onChange={(e) => set('endTime', e.target.value)} className={DATE_FIELD} />
              </label>
            </>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-dim)]">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => set('allDay', e.target.checked)} className="accent-[var(--color-accent)]" />
          all day
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[9.5rem] flex-1">
            <span className={LABEL}>repeat</span>
            <select value={draft.freq} onChange={(e) => set('freq', e.target.value as Freq)} className={`${FIELD} [color-scheme:dark]`}>
              <option value="">does not repeat</option>
              <option value="DAILY">daily</option>
              <option value="WEEKLY">weekly</option>
              <option value="MONTHLY">monthly</option>
              <option value="YEARLY">yearly</option>
            </select>
          </label>
          {draft.freq && (
            <label className="w-[7.5rem]">
              <span className={LABEL}>every</span>
              <input
                type="number"
                min={1}
                max={99}
                value={draft.interval}
                onChange={(e) => set('interval', Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
                className={FIELD}
              />
            </label>
          )}
          {draft.freq && (
            <span className="pb-2.5 text-[11px] text-[var(--color-text-faint)]">
              {rruleText(draft.interval > 1 ? `FREQ=${draft.freq};INTERVAL=${draft.interval}` : `FREQ=${draft.freq}`)}
            </span>
          )}
        </div>
        {calendars.length > 1 && (
          <label className="block">
            <span className={LABEL}>calendar</span>
            <select value={draft.sourceId} onChange={(e) => set('sourceId', e.target.value)} className={`${FIELD} [color-scheme:dark]`}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="location" className={FIELD} />
        <textarea value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder="notes" rows={3} className={FIELD} />
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}

const COLORS = ['#00ff41', '#00b4ff', '#ff9f1c', '#ff4d6d', '#b388ff', '#ffe066']

function ManageSheet({ sources, onClose }: { sources: CalendarSource[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(COLORS[1])
  const [error, setError] = useState('')

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['calendar'] }) }
  const add = useMutation({
    mutationFn: () => addCalendarSource({ label: label.trim() || 'Feed', url, color }),
    onSuccess: () => { setUrl(''); setLabel(''); setError(''); invalidate() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not add that feed')),
  })
  const toggle = useMutation({
    mutationFn: (s: CalendarSource) => updateCalendarSource(s.id, { enabled: !s.enabled }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteCalendarSource(id),
    onSuccess: invalidate,
    onError: (e: unknown) => setError(apiErrorText(e, 'could not remove that calendar')),
  })

  return (
    <Sheet title="calendars" onClose={onClose}>
      <ul className="divide-y divide-[var(--color-border)]">
        {sources.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2">
            <span className="h-3 w-3 shrink-0" style={{ backgroundColor: s.color }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[var(--color-text)]">{s.label}</span>
              <span className="block truncate text-[11px] text-[var(--color-text-faint)]">
                {s.kind === 'local'
                  ? 'lives in valkyrie'
                  : s.error
                    ? <span className="text-[var(--color-danger)]">{s.error}</span>
                    : `${s.urlHint} · synced ${relative(s.fetchedAt)}`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => toggle.mutate(s)}
              className={`${BTN_TEXT} ${s.enabled ? 'text-[var(--color-accent)]' : ''}`}
            >
              {s.enabled ? 'shown' : 'off'}
            </button>
            {s.kind === 'ics' && (
              <button
                type="button"
                onClick={() => remove.mutate(s.id)}
                aria-label={`Remove ${s.label}`}
                className={ICON_BTN}
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      <form
        className="mt-5 space-y-2 border-t border-[var(--color-border)] pt-4"
        onSubmit={(e) => { e.preventDefault(); if (url.trim()) add.mutate() }}
      >
        <div className={LABEL}>connect a feed</div>
        <div className="flex flex-wrap gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name" className={`${FIELD} sm:w-32 sm:flex-none`} />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ICS link (webcal:// or https://…)"
            className={`${FIELD} flex-1 font-mono`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`color ${c}`}
              className={`h-5 w-5 border ${color === c ? 'border-[var(--color-text)]' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
          <button type="submit" disabled={add.isPending || !url.trim()} className={`${BTN_GHOST} ml-auto`}>
            <Plus size={12} /> {add.isPending ? 'adding' : 'connect'}
          </button>
        </div>
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        <p className="text-[11px] leading-relaxed text-[var(--color-text-faint)]">
          Read-only: a feed's events show here and are edited where they came from.
        </p>
      </form>
    </Sheet>
  )
}

function MonthGrid({ anchor, events, selected, onDay, onDayView, onOpen }: {
  anchor: Date
  events: CalendarEvent[]
  selected: string | null
  onDay: (key: string) => void
  /** The date number was clicked: open the day view. */
  onDayView: (key: string) => void
  onOpen: (e: CalendarEvent) => void
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = addDays(first, -first.getDay())
  // Only as many rows as the month needs, so a short month does not waste one.
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
  const rows = Math.ceil((first.getDay() + daysInMonth) / 7)
  const cells = Array.from({ length: rows * 7 }, (_, i) => addDays(gridStart, i))
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const ev of events) {
      for (const key of eventDays(ev)) {
        const list = map.get(key) ?? []
        list.push(ev)
        map.set(key, list)
      }
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
    return map
  }, [events])
  const todayKey = dateKey(new Date())

  return (
    <div className="border-l border-t border-[var(--color-border)]">
      <div className="grid grid-cols-7">
        {DAY_NAMES.map((d) => (
          <div key={d} className="border-b border-r border-[var(--color-border)] px-1.5 py-1 text-[9px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day) => {
          const key = dateKey(day)
          const dayEvents = byDay.get(key) ?? []
          const otherMonth = day.getMonth() !== anchor.getMonth()
          return (
            <div
              key={key}
              role="button"
              tabIndex={-1}
              onClick={() => onDay(key)}
              className={`group min-h-[52px] cursor-pointer border-b border-r border-[var(--color-border)] p-1 transition-colors hover:bg-[rgba(255,255,255,0.03)] sm:min-h-[96px] sm:p-1.5 ${
                otherMonth ? 'opacity-40' : ''
              } ${selected === key ? 'bg-[rgba(var(--color-accent-rgb),0.08)]' : ''}`}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDayView(key) }}
                  title="Show this day"
                  className={`inline-flex h-5 min-w-5 items-center justify-center px-1 font-mono text-[11px] ${
                    key === todayKey ? 'bg-[var(--color-accent)] font-bold text-black' : 'text-[var(--color-text-dim)] hover:text-[var(--color-accent)]'
                  }`}
                >
                  {day.getDate()}
                </button>
                <Plus size={11} className="hidden text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 sm:block" />
              </div>
              {/* Phone: a dot per event; the selected day lists them below the grid. */}
              <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                {dayEvents.slice(0, 4).map((ev, i) => (
                  <span key={`${ev.uid}-${ev.start}-${i}`} className="h-1.5 w-1.5" style={{ backgroundColor: ev.color }} />
                ))}
              </div>
              <div className="mt-0.5 hidden space-y-0.5 sm:block">
                {dayEvents.slice(0, 3).map((ev, i) => (
                  <button
                    key={`${ev.uid}-${ev.start}-${i}`}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpen(ev) }}
                    title={ev.summary}
                    className="block w-full truncate border-l-2 pl-1 text-left text-[11px] leading-snug text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                    style={{ borderLeftColor: ev.color }}
                  >
                    {!ev.allDay && <span className="text-[var(--color-text-faint)]">{timeLabel(ev.start)} </span>}
                    {ev.summary}
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <div className="pl-1 text-[10px] text-[var(--color-text-faint)]">+{dayEvents.length - 3} more</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DayList({ days, onOpen }: { days: [string, CalendarEvent[]][]; onOpen: (e: CalendarEvent) => void }) {
  return (
    <div className="space-y-5">
      {days.map(([key, dayEvents]) => (
        <div key={key}>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">
            {dayHeading(keyDate(key))}
          </div>
          <div className="space-y-0.5">
            {dayEvents.map((ev, i) => (
              <EventRow key={`${ev.uid}-${ev.start}-${i}`} event={ev} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const HIDDEN_KEY = 'valkyrie-cal-hidden'

export default function Calendar() {
  // ?view=day&date=2026-10-07 opens a given day (the dashboard's today card
  // links here); without them the page opens where it was left.
  const [params] = useSearchParams()
  const linkedDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : null
  const [view, setView] = useState<View>(() => {
    const linked = params.get('view')
    if (VIEWS.some((v) => v.id === linked)) return linked as View
    const saved = localStorage.getItem('valkyrie-cal-view')
    if (VIEWS.some((v) => v.id === saved)) return saved as View
    return window.matchMedia('(min-width: 640px)').matches ? 'week' : 'day'
  })
  const [anchor, setAnchor] = useState(() => startOfDay(linkedDate ? keyDate(linkedDate) : new Date()))
  const [open, setOpen] = useState<CalendarEvent | null>(null)
  const [editing, setEditing] = useState<EditSeed | null>(null)
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => linkedDate ?? dateKey(new Date()))
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[]) } catch { return new Set() }
  })
  const wide = useWide()
  const qc = useQueryClient()

  const setViewPersisted = (v: View) => { setView(v); localStorage.setItem('valkyrie-cal-view', v) }
  const toggleHidden = (id: string) => setHidden((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
    return next
  })

  const days = useMemo(() => (isGrid(view) ? gridDays(view, anchor) : []), [view, anchor])
  const { from, to } = windowFor(view, anchor)
  const query = useQuery({
    queryKey: ['calendar', 'events', view, from, to],
    queryFn: () => fetchCalendarEvents(from, to),
    refetchInterval: 5 * 60_000,
    placeholderData: (prev) => prev,
  })

  const refresh = useMutation({
    mutationFn: refreshCalendars,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['calendar'] }) },
  })

  const sources = query.data?.sources ?? []
  const shown = sources.filter((s) => s.enabled)
  const localCalendars = sources.filter((s) => s.kind === 'local')
  const failing = shown.filter((s) => s.error)
  const events = useMemo(
    () => (query.data?.events ?? []).filter((e) => !hidden.has(e.sourceId)),
    [query.data, hidden],
  )

  const agendaDays = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    const firstKey = dateKey(anchor)
    for (const ev of events) {
      // A multi-day event that began before the window still belongs on its
      // first visible day.
      const key = eventDays(ev).find((k) => k >= firstKey)
      if (!key) continue
      const list = map.get(key) ?? []
      list.push(ev)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [events, anchor])

  const selectedEvents = useMemo(
    () => (selected ? events.filter((ev) => eventDays(ev).includes(selected)) : []),
    [events, selected],
  )

  const title = isGrid(view)
    ? rangeTitle(days[0], days[days.length - 1])
    : view === 'month'
      ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
      : `${anchor.toLocaleDateString([], { month: 'short', day: 'numeric' })} onward`

  const step = (dir: -1 | 1) => {
    if (view === 'day') return setAnchor((a) => addDays(a, dir))
    if (view !== 'month') return setAnchor((a) => addDays(a, dir * 7))
    // The phone's day list follows the month: today in this month, else the 1st.
    const next = addMonths(anchor, dir)
    const today = new Date()
    setAnchor(next)
    setSelected(next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth() ? dateKey(today) : dateKey(next))
  }

  const onDay = (key: string) => {
    if (wide) setEditing({ date: key })
    else setSelected(key)
  }

  const showDay = (key: string) => {
    setAnchor(startOfDay(keyDate(key)))
    setSelected(key)
    setViewPersisted('day')
  }

  // "+ event" lands on the day being looked at: today when it is on screen.
  const newEventDate = () => {
    const today = dateKey(new Date())
    if (isGrid(view)) return days.some((d) => dateKey(d) === today) ? today : dateKey(days[0])
    if (view === 'month' && selected) return selected
    return today
  }

  return (
    <div className="vk-compact mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// time</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            calendar<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            title="Re-fetch every connected feed"
            aria-label="Sync feeds"
            className={ICON_BTN}
          >
            <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={() => setManaging(true)} title="Calendars and feeds" aria-label="Calendars" className={ICON_BTN}>
            <Settings2 size={14} />
          </button>
          <button
            type="button"
            onClick={() => setEditing({ date: newEventDate() })}
            className={`${BTN_ACCENT} ml-2`}
          >
            <Plus size={12} /> event
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => step(-1)} className={ICON_BTN} aria-label="Back">
            <ChevronLeft size={15} />
          </button>
          <button type="button" onClick={() => step(1)} className={ICON_BTN} aria-label="Forward">
            <ChevronRight size={15} />
          </button>
          <span className="min-w-0 text-sm text-[var(--color-text)]">{title}</span>
          <button
            type="button"
            onClick={() => { setAnchor(startOfDay(new Date())); setSelected(dateKey(new Date())) }}
            className={BTN_TEXT}
          >
            today
          </button>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => setViewPersisted(v.id)} className={`${TAB_CLS} ${view === v.id ? TAB_ON : TAB_OFF}`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {(shown.length > 1 || failing.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {shown.length > 1 && shown.map((s) => {
            const off = hidden.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleHidden(s.id)}
                aria-pressed={!off}
                className={`inline-flex items-center gap-1.5 ${off ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'}`}
              >
                <span className="h-2.5 w-2.5" style={{ backgroundColor: off ? 'transparent' : s.color, border: `1px solid ${s.color}` }} />
                {s.label}
              </button>
            )
          })}
          {failing.map((s) => (
            <span key={s.id} className="text-[var(--color-danger)]">{s.label}: {s.error}</span>
          ))}
        </div>
      )}

      {query.isLoading && !query.data ? (
        <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
      ) : query.isError ? (
        <div className="text-sm text-[var(--color-danger)]">{apiErrorText(query.error, 'calendar API unreachable')}</div>
      ) : isGrid(view) ? (
        <TimeGrid days={days} events={events} onOpen={setOpen} onCreate={setEditing} onDay={showDay} />
      ) : view === 'month' ? (
        <>
          <MonthGrid anchor={anchor} events={events} selected={wide ? null : selected} onDay={onDay} onDayView={showDay} onOpen={setOpen} />
          {!wide && selected && (
            <div className="pt-1">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">{dayHeading(keyDate(selected))}</span>
                <button type="button" onClick={() => setEditing({ date: selected })} className={BTN_TEXT}>
                  <Plus size={11} /> add
                </button>
              </div>
              {selectedEvents.length === 0 ? (
                <div className="py-2 text-xs text-[var(--color-text-faint)]">Nothing this day.</div>
              ) : (
                <div className="space-y-0.5">
                  {selectedEvents.map((ev, i) => <EventRow key={`${ev.uid}-${ev.start}-${i}`} event={ev} onOpen={setOpen} />)}
                </div>
              )}
            </div>
          )}
        </>
      ) : agendaDays.length === 0 ? (
        <div className="py-6 text-sm text-[var(--color-text-dim)]">Nothing in the next six weeks.</div>
      ) : (
        <DayList days={agendaDays} onOpen={setOpen} />
      )}

      {open && (
        <EventDetail
          event={open}
          onClose={() => setOpen(null)}
          onEdit={(ev) => { setOpen(null); setEditing({ event: ev }) }}
        />
      )}
      {editing && <EventEditor seed={editing} calendars={localCalendars} onClose={() => setEditing(null)} />}
      {managing && <ManageSheet sources={sources} onClose={() => setManaging(false)} />}
    </div>
  )
}
