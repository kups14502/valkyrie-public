// Local-time date helpers shared by the calendar page and its time grid. Every
// value is a Date at local midnight unless named otherwise; keys are
// `YYYY-MM-DD` in local time.

export const DAY_MS = 86_400_000

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)
/** Sunday of the week holding `d`, matching the month grid. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay())

export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Noon, so a DST change never moves the key to the neighboring day. */
export const keyDate = (key: string) => new Date(`${key}T12:00:00`)

export const timeLabel = (iso: string | number) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '')

export const hm = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
