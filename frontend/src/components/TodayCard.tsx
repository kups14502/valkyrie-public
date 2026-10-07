import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Card } from './Card'
import { fetchCalendarEvents, type CalendarEvent } from '../lib/calendarApi'
import { addDays, dateKey, startOfDay, timeLabel } from '../lib/calendarDates'

// What is on today, from the calendar (Personal and the connected work feed),
// for the desktop dashboard and the phone home. Calendars switched off on the
// calendar page stay off here.

const HIDDEN_KEY = 'valkyrie-cal-hidden'
const MAX_ROWS = 8

const hiddenSources = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[]) } catch { return new Set() }
}

const until = (ms: number) => {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `in ${h}h ${m}m` : `in ${h}h`
}

/** Ticks once a minute, so past / now / next stay right on a screen left open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

export function TodayCard() {
  const navigate = useNavigate()
  const now = useNow()
  const today = startOfDay(new Date(now))
  const key = dateKey(today)
  const from = today.getTime()
  const to = addDays(today, 1).getTime()

  const query = useQuery({
    queryKey: ['calendar', 'today', from],
    queryFn: () => fetchCalendarEvents(from, to),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  })

  const events = useMemo(() => {
    const hidden = hiddenSources()
    return (query.data?.events ?? [])
      .filter((e) => !hidden.has(e.sourceId))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
  }, [query.data])

  const timed = events.filter((e) => !e.allDay)
  const next = timed.find((e) => Date.parse(e.start) > now)
  const open = () => navigate(`/calendar?view=day&date=${key}`)

  const title = `today · ${today.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`
  const action = (
    <button
      type="button"
      onClick={() => open()}
      className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
    >
      calendar →
    </button>
  )

  const row = (ev: CalendarEvent, i: number) => {
    const start = Date.parse(ev.start)
    const end = Date.parse(ev.end)
    const past = !ev.allDay && end <= now
    const live = !ev.allDay && start <= now && end > now
    const isNext = ev === next
    return (
      <li key={`${ev.uid}-${ev.start}-${i}`}>
        <button
          type="button"
          onClick={() => open()}
          className={`flex w-full min-w-0 items-baseline gap-3 border-l-2 py-1.5 pl-3 pr-1 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)] ${past ? 'opacity-45' : ''}`}
          style={{ borderLeftColor: ev.color }}
        >
          <span className="w-16 shrink-0 font-mono text-[11px] text-[var(--color-text-faint)]">
            {ev.allDay ? 'all day' : timeLabel(ev.start)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{ev.summary}</span>
          {live && <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)]">now · until {timeLabel(ev.end)}</span>}
          {isNext && <span className="shrink-0 text-[11px] text-[var(--color-warning)]">{until(start - now)}</span>}
        </button>
      </li>
    )
  }

  // vk-compact: lets the small text sizes on this card's buttons apply (index.css).
  return (
    <div className="vk-compact">
      <Card title={title} action={action}>
        {query.isLoading && !query.data ? (
          <div className="text-xs text-[var(--color-text-faint)]">loading…</div>
        ) : query.isError ? (
          <div className="text-xs text-[var(--color-danger)]">calendar unreachable</div>
        ) : events.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">Nothing on the calendar today.</div>
        ) : (
          <>
            <ul className="space-y-0.5">{events.slice(0, MAX_ROWS).map(row)}</ul>
            {events.length > MAX_ROWS && (
              <button type="button" onClick={() => open()} className="mt-1.5 pl-3 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-accent)]">
                +{events.length - MAX_ROWS} more
              </button>
            )}
            {timed.length > 0 && timed.every((e) => Date.parse(e.end) <= now) && (
              <div className="mt-2 pl-3 text-[11px] text-[var(--color-text-faint)]">Done for today.</div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
