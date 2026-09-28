import { Router } from 'express'
import { openDb } from '../lib/db.js'

const router = Router()

// Daily trackers: one checkbox a day. The question is "did I do it", not what
// or how much, so a day is a single row and there is no stack to maintain.
// Supplements was the first; SF is the same shape in its own table, under its
// own path.
//
// The client owns the calendar date (it sends 'YYYY-MM-DD' from the device's
// own clock) so a server in UTC can't push an 11pm dose into tomorrow, and so
// ticking off at 1am can be aimed at the day that just ended.

const db = openDb('supplements', `
  CREATE TABLE IF NOT EXISTS supplement_days (
    date TEXT PRIMARY KEY,
    takenAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sf_days (
    date TEXT PRIMARY KEY,
    takenAt TEXT NOT NULL
  );
`)

// The first cut of this route kept a per-supplement stack and a dose log.
// Neither held anything worth migrating and neither is read any more.
db.exec('DROP TABLE IF EXISTS supplement_log; DROP TABLE IF EXISTS supplements;')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + days))
}

/** The window's center and the device's today, or an error string. */
function readDates(src: Record<string, unknown>): { center: string; today: string } | { error: string } {
  const center = String(src.date || '')
  if (!DATE_RE.test(center)) return { error: 'date must be YYYY-MM-DD' }
  const today = String(src.today || center)
  if (!DATE_RE.test(today)) return { error: 'today must be YYYY-MM-DD' }
  return { center, today }
}

/** GET `${path}/day` and POST `${path}/log`, backed by `table`. */
function tracker(path: string, table: string) {
  const takenAtFor = (date: string): string | null => {
    const row = db.prepare(`SELECT takenAt FROM ${table} WHERE date = ?`).get(date) as { takenAt: string } | undefined
    return row?.takenAt ?? null
  }

  /**
   * Consecutive ticked days ending at `today`.
   *
   * An untaken today doesn't break the streak, it just hasn't extended it yet:
   * at 9am you have not missed anything.
   */
  function streakEndingAt(today: string, limit = 3650): number {
    let streak = 0
    let cursor = today
    for (let i = 0; i < limit; i++) {
      if (!takenAtFor(cursor)) {
        if (i === 0) { cursor = shiftDate(cursor, -1); continue }
        break
      }
      streak++
      cursor = shiftDate(cursor, -1)
    }
    return streak
  }

  const entry = (date: string) => {
    const takenAt = takenAtFor(date)
    return { date, taken: Boolean(takenAt), takenAt }
  }

  /**
   * The card shows three days: the one before, the one being looked at, and the
   * one after. `today` is carried separately so the streak stays anchored to the
   * real today while the window is stepped around.
   */
  function view(center: string, today: string) {
    return {
      date: center,
      today,
      days: [shiftDate(center, -1), center, shiftDate(center, 1)].map(entry),
      streak: streakEndingAt(today),
    }
  }

  router.get(`${path}/day`, (req, res) => {
    const dates = readDates(req.query as Record<string, unknown>)
    if ('error' in dates) return res.status(400).json(dates)
    res.json(view(dates.center, dates.today))
  })

  router.post(`${path}/log`, (req, res) => {
    const dates = readDates(req.body ?? {})
    if ('error' in dates) return res.status(400).json(dates)
    // The day being ticked is not always the center of the window: the card can
    // tick the day either side of it.
    const target = String(req.body?.target || dates.center)
    if (!DATE_RE.test(target)) return res.status(400).json({ error: 'target must be YYYY-MM-DD' })
    // Default true: a bare POST of a date means "done".
    if (req.body?.taken !== false) {
      db.prepare(`INSERT INTO ${table} (date, takenAt) VALUES (?, ?) ON CONFLICT(date) DO NOTHING`)
        .run(target, new Date().toISOString())
    } else {
      db.prepare(`DELETE FROM ${table} WHERE date = ?`).run(target)
    }
    res.json(view(dates.center, dates.today))
  })
}

tracker('/supplements', 'supplement_days')
tracker('/sf', 'sf_days')

export default router
