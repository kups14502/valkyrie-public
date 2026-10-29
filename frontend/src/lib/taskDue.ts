// A task's due date, as the backend stores it: New York wall clock, 'YYYY-MM-DD'
// or 'YYYY-MM-DDTHH:mm' (backend/src/lib/tasksStore.ts). Every comparison here is
// against New York's date and time, whatever zone the device is in, so "today"
// and "overdue" mean the same on the phone, the desktop and the server.

export type DueState = 'overdue' | 'today' | 'soon' | 'later'

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function nyParts(ms: number): Record<string, string> {
  return Object.fromEntries(NY_PARTS.formatToParts(ms).map((p) => [p.type, p.value]))
}

/** New York's date for an instant, 'YYYY-MM-DD'. */
export function nyDayKey(ms: number): string {
  const p = nyParts(ms)
  return `${p.year}-${p.month}-${p.day}`
}

/** New York's date and minute for an instant, 'YYYY-MM-DDTHH:mm'. */
export function nyMinuteKey(ms: number): string {
  const p = nyParts(ms)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** A date key moved by whole days. */
export function addDayKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

export function dueState(due: string, now: number): DueState {
  const today = nyDayKey(now)
  const day = due.slice(0, 10)
  if (due.length > 10 ? due < nyMinuteKey(now) : day < today) return 'overdue'
  if (day === today) return 'today'
  if (day <= addDayKey(today, 7)) return 'soon'
  return 'later'
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })

/** 'HH:mm' as '2:30 PM'. */
export function clockOf(hm: string): string {
  const [h, m] = hm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "Today", "Tomorrow", "Fri", "Nov 3", "Nov 3, 2027", with ", 2:30 PM" when it has a time. */
export function dueLabel(due: string, now: number): string {
  const today = nyDayKey(now)
  const day = due.slice(0, 10)
  const [y, m, d] = day.split('-').map(Number)
  const noon = Date.UTC(y, m - 1, d, 12)
  let label: string
  if (day === today) label = 'Today'
  else if (day === addDayKey(today, 1)) label = 'Tomorrow'
  else if (day === addDayKey(today, -1)) label = 'Yesterday'
  else if (day > today && day <= addDayKey(today, 6)) label = WEEKDAY.format(noon)
  else label = (day.slice(0, 4) === today.slice(0, 4) ? MONTH_DAY : MONTH_DAY_YEAR).format(noon)
  return due.length > 10 ? `${label}, ${clockOf(due.slice(11, 16))}` : label
}
