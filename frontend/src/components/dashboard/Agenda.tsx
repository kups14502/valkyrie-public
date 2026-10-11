import { useNavigate } from 'react-router-dom'
import type { CalendarEvent } from '../../lib/calendarApi'
import { timeLabel } from '../../lib/calendarDates'
import { until, useAgenda, type AgendaDay } from '../../lib/todayEvents'
import { Note, Section } from './Section'

// Rows, not days: today always shows, then each later day that has anything,
// until this many events are on the screen.
const MAX_ROWS = 9

const dayLabel = (i: number, d: Date) =>
  i === 0 ? 'today' : i === 1 ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

// The week ahead: today first, so the next meeting is never more than a glance
// away even on a day with nothing in it.
export function Agenda() {
  const navigate = useNavigate()
  const { query, agenda, now, open } = useAgenda(7)
  const total = new Set(agenda.flatMap((d) => d.events.map((e) => `${e.uid}-${e.start}`))).size

  // Deal the row budget out day by day.
  let left = MAX_ROWS
  const shown: { day: AgendaDay; index: number; events: CalendarEvent[] }[] = []
  agenda.forEach((day, index) => {
    if (index > 0 && (day.events.length === 0 || left <= 0)) return
    const events = day.events.slice(0, Math.max(0, left))
    left -= events.length
    shown.push({ day, index, events })
  })
  const hidden = agenda.reduce((n, d) => n + d.events.length, 0) - shown.reduce((n, s) => n + s.events.length, 0)

  const today = agenda[0]
  const next = today?.events.find((e) => !e.allDay && Date.parse(e.start) > now)

  const row = (ev: CalendarEvent, isToday: boolean, key: string) => {
    const start = Date.parse(ev.start)
    const end = Date.parse(ev.end)
    const past = isToday && !ev.allDay && end <= now
    const live = isToday && !ev.allDay && start <= now && end > now
    return (
      <li key={`${ev.uid}-${ev.start}`}>
        <button
          type="button"
          onClick={() => open(key)}
          title={ev.allDay ? ev.summary : `${ev.summary} · ${timeLabel(ev.start)} to ${timeLabel(ev.end)}`}
          className={`flex w-full min-w-0 items-baseline gap-2.5 border-l-2 py-[3px] pl-2.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.03)] ${past ? 'opacity-45' : ''}`}
          style={{ borderLeftColor: ev.color }}
        >
          <span className="w-14 shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">{ev.allDay ? 'all day' : timeLabel(ev.start)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]">{ev.summary}</span>
          {live && <span className="shrink-0 text-[11px] text-[var(--color-accent)]">now</span>}
          {ev === next && <span className="shrink-0 text-[11px] text-[var(--color-warning)]">{until(start - now)}</span>}
        </button>
      </li>
    )
  }

  return (
    <Section title="calendar" to="/calendar" meta={query.data && `${total} this week`}>
      {query.isLoading && !query.data ? (
        <Note>loading…</Note>
      ) : query.isError ? (
        <Note tone="danger">calendar unreachable</Note>
      ) : (
        <div className="space-y-1.5">
          {shown.map(({ day, index, events }) => (
            <div key={day.key}>
              <button
                type="button"
                onClick={() => open(day.key)}
                className={`text-[11px] transition-colors hover:text-[var(--color-accent)] ${index === 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}
              >
                {dayLabel(index, day.date)}
              </button>
              {events.length === 0 ? (
                <div className="pl-3 text-[12px] text-[var(--color-text-faint)]">nothing on the calendar</div>
              ) : (
                <ul className="space-y-px">{events.map((ev) => row(ev, index === 0, day.key))}</ul>
              )}
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => navigate(`/calendar?view=agenda&date=${agenda[0].key}`)} className="pl-3 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-accent)]">
              +{hidden} more this week
            </button>
          )}
        </div>
      )}
    </Section>
  )
}
