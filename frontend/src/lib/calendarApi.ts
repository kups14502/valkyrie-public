import { api } from './api'

export type CalendarSource = {
  id: string
  /** `local` lives in Valkyrie and is editable; `ics` is a read-only feed. */
  kind: 'local' | 'ics'
  label: string
  color: string
  urlHint: string
  tz: string
  enabled: boolean
  fetchedAt: string | null
  error: string | null
}

/** An event that lives here, as stored: wall-clock values in the calendar's zone. */
export type LocalEvent = {
  id: string
  sourceId: string
  title: string
  notes: string
  location: string
  allDay: boolean
  /** `YYYY-MM-DD` when allDay (end is the last day, inclusive), else `YYYY-MM-DDTHH:mm`. */
  start: string
  end: string
  /** `''` or `FREQ=YEARLY;INTERVAL=2` style. */
  rrule: string
}

export type CalendarEvent = {
  uid: string
  summary: string
  location: string
  description: string
  organizer: string
  status: string
  start: string
  end: string
  allDay: boolean
  recurring: boolean
  url: string
  sourceId: string
  sourceLabel: string
  color: string
  /** Present only on events that live here. */
  local?: LocalEvent
}

export type CalendarEvents = { events: CalendarEvent[]; tz: string; sources: CalendarSource[] }

export type LocalEventInput = Omit<LocalEvent, 'id'>

export const fetchCalendarSources = async () =>
  (await api.get<{ sources: CalendarSource[]; tz: string }>('/calendar/sources')).data

export const fetchCalendarEvents = async (fromMs: number, toMs: number, refresh = false) =>
  (await api.get<CalendarEvents>('/calendar/events', {
    params: { from: Math.round(fromMs), to: Math.round(toMs), refresh: refresh ? 1 : undefined },
  })).data

export const addCalendarSource = async (body: { label: string; url: string; color?: string; tz?: string }) =>
  (await api.post<{ ok: boolean; source: CalendarSource }>('/calendar/sources', body)).data

export const updateCalendarSource = async (id: string, body: Partial<{ label: string; url: string; color: string; tz: string; enabled: boolean }>) =>
  (await api.patch<{ ok: boolean; source: CalendarSource }>(`/calendar/sources/${id}`, body)).data

export const deleteCalendarSource = async (id: string) =>
  (await api.delete<{ ok: boolean }>(`/calendar/sources/${id}`)).data

export const refreshCalendars = async () =>
  (await api.post<{ ok: boolean; results: { label: string; error: string | null }[] }>('/calendar/refresh')).data

export const createLocalEvent = async (body: LocalEventInput) =>
  (await api.post<{ ok: boolean; event: LocalEvent }>('/calendar/local-events', body)).data

export const updateLocalEvent = async (id: string, body: Partial<LocalEventInput>) =>
  (await api.patch<{ ok: boolean; event: LocalEvent }>(`/calendar/local-events/${id}`, body)).data

export const deleteLocalEvent = async (id: string) =>
  (await api.delete<{ ok: boolean }>(`/calendar/local-events/${id}`)).data

const UNITS: Record<string, [string, string]> = {
  DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'],
}

/** `FREQ=MONTHLY;INTERVAL=6` -> `every 6 months`. */
export function rruleText(rrule: string): string {
  const freq = /FREQ=(\w+)/.exec(rrule)?.[1] ?? ''
  const n = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1)
  const unit = UNITS[freq]
  if (!unit) return ''
  return n === 1 ? `every ${unit[0]}` : `every ${n} ${unit[1]}`
}
