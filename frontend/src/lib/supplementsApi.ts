import { api } from './api'

export const SUPPLEMENT_SLOTS = ['morning', 'midday', 'evening', 'night'] as const
export type SupplementSlot = typeof SUPPLEMENT_SLOTS[number]

export type Supplement = {
  id: string
  name: string
  dose: string
  slot: SupplementSlot
  /** '' is every day; otherwise a CSV of weekday numbers, Sunday = 0. */
  days: string
  note: string
  sort: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export type SupplementDose = Supplement & { taken: boolean; takenAt: string | null }

export type SupplementDay = {
  date: string
  items: SupplementDose[]
  due: number
  taken: number
  streak: number
  history: { date: string; due: number; taken: number }[]
}

export type NewSupplement = {
  name: string
  dose?: string
  slot?: SupplementSlot
  days?: string
  note?: string
  sort?: number
  active?: boolean
}

export const fetchSupplementDay = async (date: string) =>
  (await api.get<SupplementDay>('/supplements/day', { params: { date } })).data

export const fetchSupplements = async () =>
  (await api.get<{ supplements: Supplement[] }>('/supplements')).data.supplements

export const createSupplement = async (body: NewSupplement) =>
  (await api.post<{ ok: boolean; supplement: Supplement }>('/supplements', body)).data.supplement

export const updateSupplement = async (id: string, body: Partial<NewSupplement>) =>
  (await api.patch<{ ok: boolean; supplement: Supplement }>(`/supplements/${id}`, body)).data.supplement

export const deleteSupplement = async (id: string) =>
  (await api.delete<{ ok: boolean }>(`/supplements/${id}`)).data

export const logSupplement = async (date: string, id: string, taken: boolean) =>
  (await api.post<SupplementDay>('/supplements/log', { date, id, taken })).data

export const logSupplementSlot = async (date: string, slot?: SupplementSlot) =>
  (await api.post<SupplementDay>('/supplements/log/all', { date, slot })).data

/** Today's key in the device's own timezone, which is the day the log uses. */
export const supplementDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

/** "every day", "weekdays", "Mon, Wed, Fri". */
export function daysLabel(days: string): string {
  if (!days) return 'every day'
  const set = days.split(',').filter(Boolean)
  if (set.length === 5 && ['1', '2', '3', '4', '5'].every((d) => set.includes(d))) return 'weekdays'
  if (set.length === 2 && set.includes('0') && set.includes('6')) return 'weekends'
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return set.map((d) => names[Number(d)]).join(', ')
}

/** The key `days` away from `key`, computed in local time. */
export const shiftDateKey = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  return supplementDateKey(new Date(y, m - 1, d + days))
}

/** "today", "yesterday", else "Fri, Sep 19". */
export function dateLabel(key: string, today = supplementDateKey()): string {
  if (key === today) return 'today'
  if (key === shiftDateKey(today, -1)) return 'yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
