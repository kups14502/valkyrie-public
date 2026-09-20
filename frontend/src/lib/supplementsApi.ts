import { api } from './api'

export type SupplementDayEntry = { date: string; taken: boolean; takenAt: string | null }

export type SupplementDay = {
  date: string
  taken: boolean
  takenAt: string | null
  streak: number
  /** Days ticked in the last 30. */
  last30: number
  history: SupplementDayEntry[]
}

export const fetchSupplementDay = async (date: string, history = 14) =>
  (await api.get<SupplementDay>('/supplements/day', { params: { date, history } })).data

export const logSupplementDay = async (date: string, taken: boolean, history = 14) =>
  (await api.post<SupplementDay>('/supplements/log', { date, taken, history })).data

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

/** "today", "yesterday", else "Fri, Sep 19". */
export function dateLabel(key: string, today = supplementDateKey()): string {
  if (key === today) return 'today'
  if (key === shiftDateKey(today, -1)) return 'yesterday'
  return parseDateKey(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
