import { api } from './api'

export type CalendarSource = {
  id: string
  label: string
  color: string
  urlHint: string
  tz: string
  enabled: boolean
  fetchedAt: string | null
  error: string | null
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
}

export type CalendarEvents = { events: CalendarEvent[]; tz: string; sources: CalendarSource[] }

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
