import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { openDb } from '../lib/db.js'

const router = Router()

// Supplement tracker. Like the meal log, the client owns the calendar date: it
// sends 'YYYY-MM-DD' from the device's own clock so a server in UTC can't push
// an 11pm dose into tomorrow.
//
// Two tables on purpose. `supplements` is the stack (what you take, when, on
// which days) and `supplement_log` is one row per dose actually taken, so
// editing the stack never rewrites what you did last week. The log's primary
// key is (date, supplementId): a dose is taken or it isn't, and a double tap
// can't create two rows.

const db = openDb('supplements', `
  CREATE TABLE IF NOT EXISTS supplements (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dose TEXT NOT NULL DEFAULT '',
    slot TEXT NOT NULL DEFAULT 'morning',
    days TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supplement_log (
    date TEXT NOT NULL,
    supplementId TEXT NOT NULL,
    takenAt TEXT NOT NULL,
    PRIMARY KEY (date, supplementId)
  );
  CREATE INDEX IF NOT EXISTS supplement_log_date ON supplement_log (date);
`)

export type Supplement = {
  id: string; name: string; dose: string; slot: string; days: string; note: string
  sort: number; active: number; createdAt: string; updatedAt: string
}

export const SLOTS = ['morning', 'midday', 'evening', 'night'] as const
const SLOT_SET = new Set<string>(SLOTS)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** '' means every day; otherwise a sorted CSV of weekday numbers, Sunday = 0. */
function cleanDays(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const raw = Array.isArray(v) ? v : String(v).split(',')
  const set = new Set<number>()
  for (const part of raw) {
    const n = Number(String(part).trim())
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n)
  }
  // Every day selected is the same as no restriction, and stores smaller.
  if (set.size === 0 || set.size === 7) return ''
  return [...set].sort((a, b) => a - b).join(',')
}

/** The weekday of a 'YYYY-MM-DD' key, read as a local date (never UTC). */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

const isDue = (s: Supplement, date: string): boolean =>
  s.active === 1 && (s.days === '' || s.days.split(',').includes(String(weekdayOf(date))))

function listSupplements(): Supplement[] {
  return db.prepare('SELECT * FROM supplements ORDER BY sort, createdAt').all() as Supplement[]
}

const slotRank = (slot: string) => {
  const i = (SLOTS as readonly string[]).indexOf(slot)
  return i < 0 ? SLOTS.length : i
}

function dayView(date: string) {
  const all = listSupplements()
  const taken = db.prepare('SELECT * FROM supplement_log WHERE date = ?').all(date) as { supplementId: string; takenAt: string }[]
  const takenAt = new Map(taken.map((t) => [t.supplementId, t.takenAt]))
  const items = all
    .filter((s) => isDue(s, date))
    .map((s) => ({ ...s, active: s.active === 1, taken: takenAt.has(s.id), takenAt: takenAt.get(s.id) ?? null }))
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.sort - b.sort || a.name.localeCompare(b.name))
  return {
    date,
    items,
    due: items.length,
    taken: items.filter((i) => i.taken).length,
  }
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y, m - 1, d + days)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

/**
 * Consecutive complete days ending at `date`.
 *
 * Today only counts once it is finished, so an unfinished morning never reads
 * as a broken streak. A day with nothing due (everything is day-of-week
 * scheduled off) is skipped rather than counted or broken on.
 */
function streakEndingAt(date: string, limit = 400): number {
  const all = listSupplements()
  const first = db.prepare('SELECT MIN(date) AS d FROM supplement_log').get() as { d: string | null }
  const floor = first.d
  let streak = 0
  let cursor = date
  for (let i = 0; i < limit; i++) {
    if (floor && cursor < floor) break
    const due = all.filter((s) => isDue(s, cursor))
    if (due.length > 0) {
      const rows = db.prepare('SELECT supplementId FROM supplement_log WHERE date = ?').all(cursor) as { supplementId: string }[]
      const done = new Set(rows.map((r) => r.supplementId))
      const complete = due.every((s) => done.has(s.id))
      if (!complete) {
        // An unfinished today doesn't break a streak; it just hasn't extended
        // it yet. Any earlier gap does.
        if (i === 0) { cursor = shiftDate(cursor, -1); continue }
        break
      }
      streak++
    }
    cursor = shiftDate(cursor, -1)
  }
  return streak
}

router.get('/supplements/day', (req, res) => {
  const date = String(req.query.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const days = Math.max(1, Math.min(60, Number(req.query.history) || 14))
  const view = dayView(date)
  // A short strip of recent days for the card: one square per day, so a missed
  // day is visible without opening anything.
  const all = listSupplements()
  const from = shiftDate(date, -(days - 1))
  const rows = db.prepare('SELECT date, supplementId FROM supplement_log WHERE date BETWEEN ? AND ?').all(from, date) as { date: string; supplementId: string }[]
  const byDate = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byDate.get(r.date) ?? new Set<string>()
    set.add(r.supplementId)
    byDate.set(r.date, set)
  }
  const history = []
  for (let i = days - 1; i >= 0; i--) {
    const d = shiftDate(date, -i)
    const due = all.filter((s) => isDue(s, d))
    const done = byDate.get(d) ?? new Set<string>()
    history.push({
      date: d,
      due: due.length,
      taken: due.filter((s) => done.has(s.id)).length,
    })
  }
  res.json({ ...view, streak: streakEndingAt(date), history })
})

router.get('/supplements', (_req, res) => {
  res.json({ supplements: listSupplements().map((s) => ({ ...s, active: s.active === 1 })) })
})

function fromBody(body: any, existing?: Supplement) {
  const name = String(body?.name ?? existing?.name ?? '').trim().slice(0, 120)
  if (!name) return { error: 'name is required' }
  const slot = String(body?.slot ?? existing?.slot ?? 'morning').toLowerCase()
  if (!SLOT_SET.has(slot)) return { error: `slot must be one of ${SLOTS.join(', ')}` }
  const activeRaw = body?.active ?? (existing ? existing.active === 1 : true)
  return {
    name,
    dose: String(body?.dose ?? existing?.dose ?? '').trim().slice(0, 60),
    slot,
    days: body?.days === undefined ? (existing?.days ?? '') : cleanDays(body.days),
    note: String(body?.note ?? existing?.note ?? '').slice(0, 500),
    sort: Number.isFinite(Number(body?.sort)) ? Number(body.sort) : (existing?.sort ?? 0),
    active: activeRaw === false || activeRaw === 0 || activeRaw === '0' ? 0 : 1,
    updatedAt: new Date().toISOString(),
  }
}

router.post('/supplements', (req, res) => {
  const parsed = fromBody(req.body)
  if ('error' in parsed) return res.status(400).json(parsed)
  // New entries land at the bottom of their slot unless a sort was given.
  const next = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM supplements').get() as { n: number }
  const row = {
    ...parsed,
    sort: req.body?.sort === undefined ? next.n : parsed.sort,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  db.prepare(`INSERT INTO supplements (id,name,dose,slot,days,note,sort,active,createdAt,updatedAt)
    VALUES (@id,@name,@dose,@slot,@days,@note,@sort,@active,@createdAt,@updatedAt)`).run(row)
  res.json({ ok: true, supplement: { ...row, active: row.active === 1 } })
})

router.patch('/supplements/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM supplements WHERE id = ?').get(req.params.id) as Supplement | undefined
  if (!existing) return res.status(404).json({ error: 'no such supplement' })
  const parsed = fromBody(req.body, existing)
  if ('error' in parsed) return res.status(400).json(parsed)
  db.prepare(`UPDATE supplements SET name=@name,dose=@dose,slot=@slot,days=@days,note=@note,
    sort=@sort,active=@active,updatedAt=@updatedAt WHERE id=@id`).run({ ...parsed, id: existing.id })
  res.json({ ok: true, supplement: { ...existing, ...parsed, active: parsed.active === 1 } })
})

router.delete('/supplements/:id', (req, res) => {
  // Its log rows go with it: they would otherwise count toward nothing and
  // still sit in the history strip.
  const tx = db.transaction((id: string) => {
    db.prepare('DELETE FROM supplement_log WHERE supplementId = ?').run(id)
    return db.prepare('DELETE FROM supplements WHERE id = ?').run(id).changes
  })
  res.json({ ok: true, deleted: tx(req.params.id) })
})

router.post('/supplements/log', (req, res) => {
  const date = String(req.body?.date || '')
  const id = String(req.body?.id || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const exists = db.prepare('SELECT id FROM supplements WHERE id = ?').get(id) as { id: string } | undefined
  if (!exists) return res.status(404).json({ error: 'no such supplement' })
  const taken = req.body?.taken !== false
  if (taken) {
    db.prepare('INSERT INTO supplement_log (date, supplementId, takenAt) VALUES (?, ?, ?) ON CONFLICT(date, supplementId) DO NOTHING')
      .run(date, id, new Date().toISOString())
  } else {
    db.prepare('DELETE FROM supplement_log WHERE date = ? AND supplementId = ?').run(date, id)
  }
  res.json({ ok: true, ...dayView(date), streak: streakEndingAt(date) })
})

/** Tick everything still due today in one tap. */
router.post('/supplements/log/all', (req, res) => {
  const date = String(req.body?.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const slot = req.body?.slot === undefined ? null : String(req.body.slot).toLowerCase()
  if (slot !== null && !SLOT_SET.has(slot)) return res.status(400).json({ error: `slot must be one of ${SLOTS.join(', ')}` })
  const now = new Date().toISOString()
  const due = listSupplements().filter((s) => isDue(s, date) && (slot === null || s.slot === slot))
  const insert = db.prepare('INSERT INTO supplement_log (date, supplementId, takenAt) VALUES (?, ?, ?) ON CONFLICT(date, supplementId) DO NOTHING')
  db.transaction(() => { for (const s of due) insert.run(date, s.id, now) })()
  res.json({ ok: true, ...dayView(date), streak: streakEndingAt(date) })
})

export default router
