import { Router } from 'express'
import { openDb } from '../lib/db.js'

const router = Router()

// Supplement tracker: one checkbox a day. The question is "did I take them",
// not which ones, so a day is a single row and there is no stack to maintain.
//
// The client owns the calendar date (it sends 'YYYY-MM-DD' from the device's
// own clock) so a server in UTC can't push an 11pm dose into tomorrow, and so
// ticking off at 1am can be aimed at the day that just ended.

const db = openDb('supplements', `
  CREATE TABLE IF NOT EXISTS supplement_days (
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

const takenAtFor = (date: string): string | null => {
  const row = db.prepare('SELECT takenAt FROM supplement_days WHERE date = ?').get(date) as { takenAt: string } | undefined
  return row?.takenAt ?? null
}

/**
 * Consecutive ticked days ending at `date`.
 *
 * An untaken today doesn't break the streak, it just hasn't extended it yet:
 * at 9am you have not missed anything.
 */
function streakEndingAt(date: string, limit = 3650): number {
  let streak = 0
  let cursor = date
  for (let i = 0; i < limit; i++) {
    const taken = Boolean(takenAtFor(cursor))
    if (!taken) {
      if (i === 0) { cursor = shiftDate(cursor, -1); continue }
      break
    }
    streak++
    cursor = shiftDate(cursor, -1)
  }
  return streak
}

function view(date: string, days: number) {
  const from = shiftDate(date, -(days - 1))
  const rows = db.prepare('SELECT date, takenAt FROM supplement_days WHERE date BETWEEN ? AND ?')
    .all(from, date) as { date: string; takenAt: string }[]
  const byDate = new Map(rows.map((r) => [r.date, r.takenAt]))
  const history = []
  for (let i = days - 1; i >= 0; i--) {
    const d = shiftDate(date, -i)
    history.push({ date: d, taken: byDate.has(d), takenAt: byDate.get(d) ?? null })
  }
  const taken = byDate.get(date) ?? null
  return {
    date,
    taken: Boolean(taken),
    takenAt: taken,
    streak: streakEndingAt(date),
    // How many of the last 30 days were ticked: the number that says whether
    // this is actually a habit yet.
    last30: (db.prepare('SELECT COUNT(*) AS n FROM supplement_days WHERE date BETWEEN ? AND ?')
      .get(shiftDate(date, -29), date) as { n: number }).n,
    history,
  }
}

router.get('/supplements/day', (req, res) => {
  const date = String(req.query.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const days = Math.max(1, Math.min(90, Number(req.query.history) || 14))
  res.json(view(date, days))
})

router.post('/supplements/log', (req, res) => {
  const date = String(req.body?.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const days = Math.max(1, Math.min(90, Number(req.body?.history) || 14))
  // Default true: a bare POST of a date means "took them".
  const taken = req.body?.taken !== false
  if (taken) {
    db.prepare('INSERT INTO supplement_days (date, takenAt) VALUES (?, ?) ON CONFLICT(date) DO NOTHING')
      .run(date, new Date().toISOString())
  } else {
    db.prepare('DELETE FROM supplement_days WHERE date = ?').run(date)
  }
  res.json(view(date, days))
})

export default router
