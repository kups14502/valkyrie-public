import { api } from './api'

export type SupplementDayEntry = { date: string; taken: boolean; takenAt: string | null }

export type SupplementWindow = {
  /** The middle day of the three. */
  date: string
  today: string
  /** The day before, the day itself, the day after. */
  days: SupplementDayEntry[]
  streak: number
}

export const fetchSupplementWindow = async (date: string, today: string) =>
  (await api.get<SupplementWindow>('/supplements/day', { params: { date, today } })).data

export const logSupplementDay = async (target: string, taken: boolean, date: string, today: string) =>
  (await api.post<SupplementWindow>('/supplements/log', { target, taken, date, today })).data

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
