import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, RefreshCw, Repeat, Trash2 } from 'lucide-react'
import { apiErrorText } from '../lib/api'
import { Card } from '../components/Card'
import {
  addCalendarSource, deleteCalendarSource, fetchCalendarEvents, refreshCalendars, updateCalendarSource,
  type CalendarEvent, type CalendarSource,
} from '../lib/calendarApi'

type View = 'agenda' | 'month'

const DAY_MS = 86_400_000
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '')

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
  if (view === 'agenda') {
    const from = startOfDay(anchor).getTime()
    return { from, to: from + 45 * DAY_MS }
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  return { from: addDays(first, -7).getTime(), to: addMonths(first, 1).getTime() + 7 * DAY_MS }
}

function EventRow({ event, onOpen }: { event: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      className="flex w-full items-start gap-3 border-l-2 py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)]"
      style={{ borderLeftColor: event.color }}
    >
      <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-[var(--color-text-faint)]">
        {event.allDay ? 'all day' : timeLabel(event.start)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--color-text)]">{event.summary}</span>
        {(event.location || event.recurring) && (
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-text-dim)]">
            {event.recurring && <Repeat size={10} className="shrink-0" />}
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

function EventDetail({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const start = new Date(event.start)
  const end = new Date(event.end)
  const span = event.allDay
    ? start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : `${start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}, ${timeLabel(event.start)} – ${timeLabel(event.end)}`
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="panel max-h-[80vh] w-full max-w-xl overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-3 w-3 shrink-0" style={{ backgroundColor: event.color }} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-[var(--color-text)]">{event.summary}</h3>
            <div className="mt-1 text-xs text-[var(--color-text-dim)]">{span}</div>
            {!event.allDay && (
              <div className="text-[11px] text-[var(--color-text-faint)]">
                {minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">
            close
          </button>
        </div>
        <dl className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-3 text-xs">
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 uppercase tracking-[0.2em] text-[var(--color-text-faint)]">cal</dt>
            <dd className="text-[var(--color-text-dim)]">{event.sourceLabel}</dd>
          </div>
          {event.location && (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 uppercase tracking-[0.2em] text-[var(--color-text-faint)]">where</dt>
              <dd className="min-w-0 break-words text-[var(--color-text-dim)]">{event.location}</dd>
            </div>
          )}
          {event.organizer && (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 uppercase tracking-[0.2em] text-[var(--color-text-faint)]">host</dt>
              <dd className="text-[var(--color-text-dim)]">{event.organizer}</dd>
            </div>
          )}
          {event.description && (
            <div className="flex gap-3">
              <dt className="w-20 shrink-0 uppercase tracking-[0.2em] text-[var(--color-text-faint)]">notes</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--color-text-dim)]">
                {event.description.slice(0, 4000)}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

function MonthGrid({ anchor, events, onOpen }: { anchor: Date; events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = addDays(first, -first.getDay())
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const ev of events) {
      // A multi-day event belongs on every day it covers.
      const start = startOfDay(new Date(ev.start))
      const endMs = Date.parse(ev.end)
      for (let d = start; d.getTime() < endMs || dateKey(d) === dateKey(start); d = addDays(d, 1)) {
        const key = dateKey(d)
        const list = map.get(key) ?? []
        list.push(ev)
        map.set(key, list)
        if (d.getTime() > endMs) break
      }
    }
    return map
  }, [events])
  const todayKey = dateKey(new Date())

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-7 border-b border-[var(--color-border)]">
          {DAY_NAMES.map((d) => (
            <div key={d} className="px-2 py-1.5 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">{d}</div>
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
                className={`min-h-[92px] border-b border-r border-[var(--color-border)] p-1.5 ${otherMonth ? 'opacity-40' : ''}`}
              >
                <div
                  className={`mb-1 inline-flex h-5 min-w-5 items-center justify-center px-1 font-mono text-[11px] ${
                    key === todayKey
                      ? 'bg-[var(--color-accent)] font-bold text-black'
                      : 'text-[var(--color-text-dim)]'
                  }`}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayEvents.slice(0, 3).map((ev, i) => (
                    <button
                      key={`${ev.uid}-${ev.start}-${i}`}
                      type="button"
                      onClick={() => onOpen(ev)}
                      title={ev.summary}
                      className="block w-full truncate border-l-2 pl-1 text-left text-[10px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
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
    </div>
  )
}

const COLORS = ['#00ff41', '#00b4ff', '#ff9f1c', '#ff4d6d', '#b388ff', '#ffe066']

function SourcesCard({ sources }: { sources: CalendarSource[] }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('Work')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [error, setError] = useState('')

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['calendar'] }) }
  const add = useMutation({
    mutationFn: () => addCalendarSource({ label, url, color }),
    onSuccess: () => { setUrl(''); setError(''); invalidate() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not add that feed')),
  })
  const toggle = useMutation({
    mutationFn: (s: CalendarSource) => updateCalendarSource(s.id, { enabled: !s.enabled }),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: (id: string) => deleteCalendarSource(id), onSuccess: invalidate })

  return (
    <Card title="calendars" collapsible defaultCollapsed={sources.length > 0} storageKey="calendar-sources">
      <div className="space-y-4">
        {sources.length > 0 && (
          <ul className="space-y-2">
            {sources.map((s) => (
              <li key={s.id} className="flex items-center gap-3 border border-[var(--color-border)] px-3 py-2">
                <span className="h-3 w-3 shrink-0" style={{ backgroundColor: s.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--color-text)]">{s.label}</span>
                  <span className="block truncate text-[11px] text-[var(--color-text-faint)]">{s.urlHint}</span>
                </span>
                <span className="shrink-0 text-right text-[11px]">
                  {s.error
                    ? <span className="text-[var(--color-danger)]">{s.error}</span>
                    : <span className="text-[var(--color-text-faint)]">synced {relative(s.fetchedAt)}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => toggle.mutate(s)}
                  className={`shrink-0 border px-2 py-1 text-[10px] uppercase tracking-[0.18em] ${
                    s.enabled
                      ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
                  }`}
                >
                  {s.enabled ? 'on' : 'off'}
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate(s.id)}
                  title="Remove this feed"
                  className="shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (url.trim()) add.mutate() }}
        >
          <div className="flex flex-wrap gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="name"
              className="w-28 border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ICS link (webcal:// or https://…)"
              className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex items-center gap-1">
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
            </div>
            <button
              type="submit"
              disabled={add.isPending || !url.trim()}
              className="inline-flex items-center gap-2 border border-[var(--color-accent)]/60 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] disabled:opacity-40"
            >
              <Plus size={12} /> {add.isPending ? 'adding' : 'add'}
            </button>
          </div>
          {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
          <p className="text-[11px] leading-relaxed text-[var(--color-text-dim)]">
            Outlook Web → Calendar → Share → the Work calendar → Publish a calendar → permission
            "Can view all details" → copy the <span className="font-mono">.ics</span> link. Read-only:
            events are shown here, edits still happen in Outlook.
          </p>
        </form>
      </div>
    </Card>
  )
}

export default function Calendar() {
  const [view, setView] = useState<View>(() => (localStorage.getItem('valkyrie-cal-view') as View) || 'agenda')
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [open, setOpen] = useState<CalendarEvent | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const qc = useQueryClient()

  const setViewPersisted = (v: View) => { setView(v); localStorage.setItem('valkyrie-cal-view', v) }

  const { from, to } = windowFor(view, anchor)
  const query = useQuery({
    queryKey: ['calendar', 'events', view, from, to],
    queryFn: () => fetchCalendarEvents(from, to),
    refetchInterval: 5 * 60_000,
  })

  const refresh = useMutation({
    mutationFn: refreshCalendars,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['calendar'] }) },
  })

  const sources = query.data?.sources ?? []
  const events = useMemo(
    () => (query.data?.events ?? []).filter((e) => !hidden.has(e.sourceId)),
    [query.data, hidden],
  )

  const agendaDays = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const ev of events) {
      const key = dateKey(new Date(ev.start))
      const list = map.get(key) ?? []
      list.push(ev)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [events])

  const title = view === 'month'
    ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : `${startOfDay(anchor).toLocaleDateString([], { month: 'short', day: 'numeric' })} onward`

  const step = (dir: -1 | 1) =>
    setAnchor((a) => (view === 'month' ? addMonths(a, dir) : addDays(a, dir * 7)))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// time</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            calendar<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['agenda', 'month'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setViewPersisted(v)}
              className={`border px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] ${
                view === v
                  ? 'border-[var(--color-accent)]/70 bg-[rgba(0,255,65,0.12)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
              }`}
            >
              {v}
            </button>
          ))}
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            title="Re-fetch every feed now"
            className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : ''} /> sync
          </button>
        </div>
      </div>

      <SourcesCard sources={sources} />

      {sources.length === 0 ? (
        <Card>
          <div className="flex items-start gap-3 text-sm">
            <CalendarDays size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
            <div className="space-y-1">
              <div className="text-[var(--color-text)]">No calendar connected yet.</div>
              <div className="text-[var(--color-text-dim)]">
                Open the calendars card above and paste the published ICS link for the Work calendar.
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <Card
          title={title}
          action={(
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => step(-1)} className="p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label="Back">
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => setAnchor(startOfDay(new Date()))}
                className="border border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
              >
                today
              </button>
              <button type="button" onClick={() => step(1)} className="p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label="Forward">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        >
          {sources.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-3">
              {sources.map((s) => {
                const off = hidden.has(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setHidden((prev) => {
                      const next = new Set(prev)
                      if (next.has(s.id)) next.delete(s.id)
                      else next.add(s.id)
                      return next
                    })}
                    className={`inline-flex items-center gap-2 border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${
                      off ? 'border-[var(--color-border)] text-[var(--color-text-faint)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                    }`}
                  >
                    <span className="h-2.5 w-2.5" style={{ backgroundColor: off ? 'transparent' : s.color, border: `1px solid ${s.color}` }} />
                    {s.label}
                  </button>
                )
              })}
            </div>
          )}

          {query.isLoading && !query.data ? (
            <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
          ) : query.error ? (
            <div className="text-sm text-[var(--color-danger)]">Calendar API unreachable</div>
          ) : view === 'month' ? (
            <MonthGrid anchor={anchor} events={events} onOpen={setOpen} />
          ) : agendaDays.length === 0 ? (
            <div className="text-sm text-[var(--color-text-dim)]">Nothing scheduled in the next six weeks.</div>
          ) : (
            <div className="space-y-5">
              {agendaDays.map(([key, dayEvents]) => (
                <div key={key}>
                  <div className="mb-1.5 text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">
                    {dayHeading(new Date(`${key}T12:00:00`))}
                  </div>
                  <div className="space-y-0.5">
                    {dayEvents.map((ev, i) => (
                      <EventRow key={`${ev.uid}-${ev.start}-${i}`} event={ev} onOpen={setOpen} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {open && <EventDetail event={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
