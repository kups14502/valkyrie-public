import { api } from './api'

/** A one-checkbox-a-day tracker; each is its own path on the API. */
export type TrackerName = 'supplements' | 'exercise' | 'sf'

export type TrackerDayEntry = { date: string; taken: boolean; takenAt: string | null }

export type TrackerWindow = {
  /** The middle day of the three. */
  date: string
  today: string
  /** The day before, the day itself, the day after. */
  days: TrackerDayEntry[]
  streak: number
}

export const fetchTrackerWindow = async (tracker: TrackerName, date: string, today: string) =>
  (await api.get<TrackerWindow>(`/${tracker}/day`, { params: { date, today } })).data

/** The one streak the daily tracker shows: a day counts when all three are done. */
export const fetchDailyStreak = async (today: string) =>
  (await api.get<{ today: string; streak: number }>('/daily/streak', { params: { today } })).data

export const logTrackerDay = async (tracker: TrackerName, target: string, taken: boolean, date: string, today: string) =>
  (await api.post<TrackerWindow>(`/${tracker}/log`, { target, taken, date, today })).data

/** Today's key in the device's own timezone, which is the day the log uses. */
export const supplementDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The key `days` away from `key`, computed in local time. */
export const shiftDateKey = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  return supplementDateKey(new Date(y, m - 1, d + days))
}

export const parseDateKey = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "today", "yesterday", "tomorrow", else "Fri 19". */
export function dateLabel(key: string, today = supplementDateKey()): string {
  if (key === today) return 'today'
  if (key === shiftDateKey(today, -1)) return 'yesterday'
  if (key === shiftDateKey(today, 1)) return 'tomorrow'
  const d = parseDateKey(key)
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`
}
