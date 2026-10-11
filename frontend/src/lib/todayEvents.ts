import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchCalendarEvents, type CalendarEvent } from './calendarApi'
import { addDays, dateKey, startOfDay } from './calendarDates'

// Calendar events for the phone's TodayCard (today) and the desktop
// dashboard (the week ahead). Calendars switched off on the calendar page stay off here.

const HIDDEN_KEY = 'valkyrie-cal-hidden'
const hiddenSources = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[]) } catch { return new Set() }
}

export const until = (ms: number) => {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `in ${h}h ${m}m` : `in ${h}h`
}

/** Ticks once a minute, so past / now / next stay right on a screen left open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** Today's events, all-day first, then by start; and which timed one is next. */
export function useTodayEvents() {
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
  return {
    query, events, timed, next, now, today,
    open: () => navigate(`/calendar?view=day&date=${key}`),
  }
}

export type AgendaDay = { date: Date; key: string; events: CalendarEvent[] }

/**
 * Today and the days after it, each with the events that touch it, for the
 * desktop dashboard. An event that spans days (a trip, an all-day block)
 * shows on every day it covers.
 */
export function useAgenda(days = 7) {
  const navigate = useNavigate()
  const now = useNow()
  const today = startOfDay(new Date(now))
  const from = today.getTime()
  const to = addDays(today, days).getTime()

  const query = useQuery({
    queryKey: ['calendar', 'agenda', from, days],
    queryFn: () => fetchCalendarEvents(from, to),
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  })

  const agenda = useMemo((): AgendaDay[] => {
    const hidden = hiddenSources()
    const events = (query.data?.events ?? [])
      .filter((e) => !hidden.has(e.sourceId))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(new Date(from), i)
      const start = date.getTime()
      const end = addDays(date, 1).getTime()
      return {
        date,
        key: dateKey(date),
        events: events.filter((e) => Date.parse(e.start) < end && Date.parse(e.end) > start),
      }
    })
  }, [query.data, from, days])

  return {
    query, agenda, now,
    open: (key: string) => navigate(`/calendar?view=day&date=${key}`),
  }
}
