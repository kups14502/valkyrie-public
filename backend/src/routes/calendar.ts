import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { openDb } from '../lib/db.js'
import { parseIcs, type IcsEvent } from '../lib/ics.js'

const router = Router()

// The calendar is Valkyrie's own. A `local` source holds events created here
// (stored in calendar_events, editable); an `ics` source is a connection that
// fills the calendar from a published feed and stays read-only, because a work
// calendar's authority is Exchange.
//
// A feed URL is a bearer secret (anyone holding it reads the calendar), so it
// is never returned to the client in full — only its host and a short tail.

const db = openDb('calendar', `
  CREATE TABLE IF NOT EXISTS calendar_sources (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    color TEXT NOT NULL,
    tz TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    sourceId TEXT PRIMARY KEY,
    ics TEXT NOT NULL,
    etag TEXT NOT NULL DEFAULT '',
    fetchedAt TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    sourceId TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    allDay INTEGER NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    rrule TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS calendar_events_source ON calendar_events (sourceId);
`)

// Databases made before local calendars existed have no kind column.
const sourceColumns = db.prepare('PRAGMA table_info(calendar_sources)').all() as { name: string }[]
if (!sourceColumns.some((c) => c.name === 'kind')) {
  db.exec(`ALTER TABLE calendar_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'ics'`)
}

const DEFAULT_TZ = process.env.CALENDAR_TZ || 'America/New_York'
const REFRESH_MS = Number(process.env.CALENDAR_REFRESH_MS) || 10 * 60_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_ICS_BYTES = 12 * 1024 * 1024

type SourceKind = 'ics' | 'local'
type SourceRow = {
  id: string; kind: SourceKind; label: string; url: string; color: string; tz: string
  enabled: number; sortOrder: number; createdAt: string
}
type CacheRow = { sourceId: string; ics: string; etag: string; fetchedAt: string; error: string }
type EventRow = {
  id: string; sourceId: string; title: string; notes: string; location: string
  allDay: number; start: string; end: string; rrule: string; createdAt: string; updatedAt: string
}

const listSources = (): SourceRow[] =>
  db.prepare('SELECT * FROM calendar_sources ORDER BY sortOrder, createdAt').all() as SourceRow[]

const getSource = (id: string): SourceRow | undefined =>
  db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as SourceRow | undefined

const getCache = (id: string): CacheRow | undefined =>
  db.prepare('SELECT * FROM calendar_cache WHERE sourceId = ?').get(id) as CacheRow | undefined

// One-time seed so a deployment that already knows the URL comes up working.
function seedFromEnv(): void {
  const url = process.env.CALENDAR_SEED_ICS_URL
  if (!url) return
  const already = db.prepare('SELECT COUNT(*) AS n FROM calendar_sources WHERE url = ?').get(url) as { n: number }
  if (already.n > 0) return
  db.prepare(`INSERT INTO calendar_sources (id, label, url, color, tz, enabled, sortOrder, createdAt)
    VALUES (?, ?, ?, ?, '', 1, 0, ?)`)
    .run(randomUUID(), process.env.CALENDAR_SEED_LABEL || 'Work', url, '#00ff41', new Date().toISOString())
}
seedFromEnv()

// The calendar works with no connection at all: there is always one calendar
// that lives here.
function seedLocal(): void {
  const has = db.prepare(`SELECT COUNT(*) AS n FROM calendar_sources WHERE kind = 'local'`).get() as { n: number }
  if (has.n > 0) return
  db.prepare(`INSERT INTO calendar_sources (id, kind, label, url, color, tz, enabled, sortOrder, createdAt)
    VALUES (?, 'local', 'Personal', '', '#00ff41', '', 1, -1, ?)`)
    .run(randomUUID(), new Date().toISOString())
}
seedLocal()

/** What the client is allowed to see of a feed URL. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return `${u.host}/…${tail.slice(-8)}`
  } catch {
    return 'invalid url'
  }
}

function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    // Outlook hands out webcal:// links; the UI rewrites those before posting.
    return Boolean(u.host)
  } catch {
    return false
  }
}

async function fetchSource(source: SourceRow): Promise<CacheRow> {
  const now = new Date().toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(source.url, {
      signal: controller.signal,
      headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'Valkyrie/1.0 calendar' },
      redirect: 'follow',
    })
    if (!resp.ok) throw new Error(`feed returned ${resp.status}`)
    const text = await resp.text()
    if (text.length > MAX_ICS_BYTES) throw new Error('feed too large')
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an ICS feed')
    const row: CacheRow = { sourceId: source.id, ics: text, etag: resp.headers.get('etag') || '', fetchedAt: now, error: '' }
    db.prepare(`INSERT INTO calendar_cache (sourceId, ics, etag, fetchedAt, error) VALUES (@sourceId, @ics, @etag, @fetchedAt, '')
      ON CONFLICT(sourceId) DO UPDATE SET ics=@ics, etag=@etag, fetchedAt=@fetchedAt, error=''`).run(row)
    return row
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? 'feed timed out' : (err as Error).message
    // Keep the last good copy: a feed that is down for an hour must not empty
    // the calendar, it must show a stale badge.
    const prev = getCache(source.id)
    const row: CacheRow = { sourceId: source.id, ics: prev?.ics ?? '', etag: prev?.etag ?? '', fetchedAt: prev?.fetchedAt ?? '', error: message }
    db.prepare(`INSERT INTO calendar_cache (sourceId, ics, etag, fetchedAt, error) VALUES (@sourceId, @ics, @etag, @fetchedAt, @error)
      ON CONFLICT(sourceId) DO UPDATE SET error=@error`).run(row)
    console.error('[calendar] fetch failed', { label: source.label, message })
    return row
  }
}

const inFlight = new Map<string, Promise<CacheRow>>()

async function loadSource(source: SourceRow, force: boolean): Promise<CacheRow> {
  const cached = getCache(source.id)
  const age = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity
  if (!force && cached?.ics && age < REFRESH_MS) return cached
  const running = inFlight.get(source.id)
  if (running) return running
  const attempt = fetchSource(source).finally(() => inFlight.delete(source.id))
  inFlight.set(source.id, attempt)
  return attempt
}

type SourceStatus = {
  id: string; kind: SourceKind; label: string; color: string; urlHint: string; tz: string
  enabled: boolean; fetchedAt: string | null; error: string | null
}

const statusOf = (s: SourceRow, cache?: CacheRow): SourceStatus => ({
  id: s.id,
  kind: s.kind,
  label: s.label,
  color: s.color,
  urlHint: s.kind === 'local' ? '' : describeUrl(s.url),
  tz: s.tz || DEFAULT_TZ,
  enabled: s.enabled === 1,
  fetchedAt: cache?.fetchedAt || null,
  error: cache?.error || null,
})

router.get('/calendar/sources', (_req, res) => {
  res.json({ sources: listSources().map((s) => statusOf(s, getCache(s.id))), tz: DEFAULT_TZ })
})

router.post('/calendar/sources', (req, res) => {
  const kind: SourceKind = req.body?.kind === 'local' ? 'local' : 'ics'
  const label = String(req.body?.label || '').trim().slice(0, 80)
  // webcal:// is what Outlook and Apple hand out; it is plain https underneath.
  const url = kind === 'local' ? '' : String(req.body?.url || '').trim().replace(/^webcal:\/\//i, 'https://')
  const color = String(req.body?.color || '#00ff41').trim().slice(0, 32)
  const tz = String(req.body?.tz || '').trim().slice(0, 64)
  if (!label) return res.status(400).json({ error: 'label is required' })
  if (kind === 'ics' && !isFetchableUrl(url)) return res.status(400).json({ error: 'url must be an http(s) or webcal ICS link' })
  const id = randomUUID()
  const max = db.prepare('SELECT COALESCE(MAX(sortOrder), -1) AS n FROM calendar_sources').get() as { n: number }
  db.prepare(`INSERT INTO calendar_sources (id, kind, label, url, color, tz, enabled, sortOrder, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, kind, label, url, color, tz, max.n + 1, new Date().toISOString())
  const source = getSource(id)!
  // Fetch immediately so the UI can report a bad URL while the user is still
  // looking at the form.
  if (kind === 'ics') {
    void loadSource(source, true).then((cache) => {
      if (cache.error) console.warn('[calendar] new source failed first fetch', { label, error: cache.error })
    })
  }
  res.json({ ok: true, source: statusOf(source) })
})

router.patch('/calendar/sources/:id', (req, res) => {
  const source = getSource(req.params.id)
  if (!source) return res.status(404).json({ error: 'no such source' })
  const next = {
    label: req.body?.label != null ? String(req.body.label).trim().slice(0, 80) || source.label : source.label,
    url: source.url,
    color: req.body?.color != null ? String(req.body.color).trim().slice(0, 32) : source.color,
    tz: req.body?.tz != null ? String(req.body.tz).trim().slice(0, 64) : source.tz,
    enabled: req.body?.enabled != null ? (req.body.enabled ? 1 : 0) : source.enabled,
  }
  if (req.body?.url != null && source.kind === 'ics') {
    const url = String(req.body.url).trim().replace(/^webcal:\/\//i, 'https://')
    if (!isFetchableUrl(url)) return res.status(400).json({ error: 'url must be an http(s) or webcal ICS link' })
    next.url = url
  }
  db.prepare('UPDATE calendar_sources SET label=@label, url=@url, color=@color, tz=@tz, enabled=@enabled WHERE id=@id')
    .run({ ...next, id: source.id })
  if (next.url !== source.url) db.prepare('DELETE FROM calendar_cache WHERE sourceId = ?').run(source.id)
  res.json({ ok: true, source: statusOf(getSource(source.id)!, getCache(source.id)) })
})

router.delete('/calendar/sources/:id', (req, res) => {
  const source = getSource(req.params.id)
  if (source?.kind === 'local') {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE sourceId = ?').get(source.id) as { n: number }).n
    if (n > 0) return res.status(409).json({ error: `this calendar still has ${n} event${n === 1 ? '' : 's'}` })
  }
  db.prepare('DELETE FROM calendar_cache WHERE sourceId = ?').run(req.params.id)
  const info = db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(req.params.id)
  seedLocal()
  res.json({ ok: true, deleted: info.changes })
})

// ---- Events that live here ------------------------------------------------
//
// Stored as wall-clock values in the calendar's zone: `2026-10-07` for an
// all-day event (end = the last day, inclusive) or `2026-10-07T09:30` for a
// timed one. They are rendered by writing them out as ICS and reading them back
// through parseIcs, so recurrence follows the same rules as a connected feed.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const

type LocalEvent = {
  id: string; sourceId: string; title: string; notes: string; location: string
  allDay: boolean; start: string; end: string; rrule: string
}

const toLocal = (r: EventRow): LocalEvent => ({
  id: r.id, sourceId: r.sourceId, title: r.title, notes: r.notes, location: r.location,
  allDay: r.allDay === 1, start: r.start, end: r.end, rrule: r.rrule,
})

const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
const validDateTime = (s: string) => DATETIME_RE.test(s) && !Number.isNaN(Date.parse(`${s}:00Z`))

/** Only FREQ and INTERVAL are accepted; anything else is rewritten or refused. */
function normalizeRrule(raw: unknown): string | null {
  const text = String(raw ?? '').trim().toUpperCase().replace(/^RRULE:/, '')
  if (!text) return ''
  const parts: Record<string, string> = {}
  for (const seg of text.split(';')) {
    const eq = seg.indexOf('=')
    if (eq > 0) parts[seg.slice(0, eq)] = seg.slice(eq + 1)
  }
  if (!FREQS.includes(parts.FREQ as typeof FREQS[number])) return null
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return null
  return interval === 1 ? `FREQ=${parts.FREQ}` : `FREQ=${parts.FREQ};INTERVAL=${interval}`
}

type EventInput = { sourceId: string; title: string; notes: string; location: string; allDay: boolean; start: string; end: string; rrule: string }

/** Validate a create or a patch merged over the current row. */
function readEventInput(body: Record<string, unknown>, current?: EventRow): EventInput | string {
  const pick = (key: string, fallback: unknown): unknown => (body[key] !== undefined ? body[key] : fallback)
  const title = String(pick('title', current?.title ?? '')).trim().slice(0, 200)
  if (!title) return 'title is required'
  const allDay = Boolean(pick('allDay', current ? current.allDay === 1 : false))
  const start = String(pick('start', current?.start ?? '')).trim()
  let end = String(pick('end', current?.end ?? '') ?? '').trim()
  if (allDay) {
    if (!validDate(start)) return 'start must be YYYY-MM-DD for an all-day event'
    if (!end || !validDate(end)) end = start
    if (end < start) return 'end is before start'
  } else {
    if (!validDateTime(start)) return 'start must be YYYY-MM-DDTHH:mm'
    if (!end || !validDateTime(end)) {
      const ms = Date.parse(`${start}:00Z`) + 60 * 60_000
      end = new Date(ms).toISOString().slice(0, 16)
    }
    if (end < start) return 'end is before start'
  }
  const rrule = normalizeRrule(pick('rrule', current?.rrule ?? ''))
  if (rrule === null) return 'repeat must be FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with an optional INTERVAL of 1 to 99'
  const sourceId = String(pick('sourceId', current?.sourceId ?? '') || '')
  const source = sourceId ? getSource(sourceId) : listSources().find((s) => s.kind === 'local')
  if (!source || source.kind !== 'local') return 'sourceId must be a calendar that lives here'
  return {
    sourceId: source.id,
    title,
    notes: String(pick('notes', current?.notes ?? '') ?? '').slice(0, 8000),
    location: String(pick('location', current?.location ?? '') ?? '').trim().slice(0, 300),
    allDay, start, end, rrule,
  }
}

const getEvent = (id: string): EventRow | undefined =>
  db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as EventRow | undefined

const escapeIcs = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

const compact = (s: string) => s.replace(/[-:]/g, '')

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function localIcs(rows: EventRow[], tz: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0']
  for (const r of rows) {
    lines.push('BEGIN:VEVENT', `UID:${r.id}`, `SUMMARY:${escapeIcs(r.title)}`)
    if (r.allDay === 1) {
      lines.push(`DTSTART;VALUE=DATE:${compact(r.start)}`, `DTEND;VALUE=DATE:${compact(nextDay(r.end))}`)
    } else {
      lines.push(`DTSTART;TZID=${tz}:${compact(r.start)}00`, `DTEND;TZID=${tz}:${compact(r.end)}00`)
    }
    if (r.rrule) lines.push(`RRULE:${r.rrule}`)
    if (r.location) lines.push(`LOCATION:${escapeIcs(r.location)}`)
    if (r.notes) lines.push(`DESCRIPTION:${escapeIcs(r.notes)}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

router.get('/calendar/local-events', (req, res) => {
  const sourceId = req.query.sourceId ? String(req.query.sourceId) : null
  const rows = (sourceId
    ? db.prepare('SELECT * FROM calendar_events WHERE sourceId = ? ORDER BY start').all(sourceId)
    : db.prepare('SELECT * FROM calendar_events ORDER BY start').all()) as EventRow[]
  res.json({ events: rows.map(toLocal), tz: DEFAULT_TZ })
})

router.post('/calendar/local-events', (req, res) => {
  const input = readEventInput(req.body ?? {})
  if (typeof input === 'string') return res.status(400).json({ error: input })
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(`INSERT INTO calendar_events (id, sourceId, title, notes, location, allDay, start, end, rrule, createdAt, updatedAt)
    VALUES (@id, @sourceId, @title, @notes, @location, @allDay, @start, @end, @rrule, @now, @now)`)
    .run({ ...input, id, allDay: input.allDay ? 1 : 0, now })
  res.json({ ok: true, event: toLocal(getEvent(id)!) })
})

router.patch('/calendar/local-events/:id', (req, res) => {
  const current = getEvent(req.params.id)
  if (!current) return res.status(404).json({ error: 'no such event' })
  const input = readEventInput(req.body ?? {}, current)
  if (typeof input === 'string') return res.status(400).json({ error: input })
  db.prepare(`UPDATE calendar_events SET sourceId=@sourceId, title=@title, notes=@notes, location=@location,
    allDay=@allDay, start=@start, end=@end, rrule=@rrule, updatedAt=@now WHERE id=@id`)
    .run({ ...input, id: current.id, allDay: input.allDay ? 1 : 0, now: new Date().toISOString() })
  res.json({ ok: true, event: toLocal(getEvent(current.id)!) })
})

router.delete('/calendar/local-events/:id', (req, res) => {
  const info = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id)
  res.json({ ok: true, deleted: info.changes })
})

const MAX_WINDOW_MS = 400 * 86_400_000

type OutEvent = IcsEvent & { sourceId: string; sourceLabel: string; color: string; local?: LocalEvent }

router.get('/calendar/events', async (req, res) => {
  const now = Date.now()
  const from = Number(req.query.from) || now - 7 * 86_400_000
  const to = Number(req.query.to) || now + 60 * 86_400_000
  if (to <= from || to - from > MAX_WINDOW_MS) {
    return res.status(400).json({ error: 'window must be positive and under about a year' })
  }
  const force = req.query.refresh === '1'
  const sources = listSources().filter((s) => s.enabled === 1)
  const loaded = await Promise.all(sources.map(async (s) => ({
    source: s,
    cache: s.kind === 'ics' ? await loadSource(s, force) : undefined,
  })))

  const events: OutEvent[] = []
  for (const { source, cache } of loaded) {
    const tz = source.tz || DEFAULT_TZ
    try {
      if (source.kind === 'local') {
        const rows = db.prepare('SELECT * FROM calendar_events WHERE sourceId = ?').all(source.id) as EventRow[]
        const byId = new Map(rows.map((r) => [r.id, toLocal(r)]))
        for (const ev of parseIcs(localIcs(rows, tz), from, to, tz)) {
          events.push({ ...ev, sourceId: source.id, sourceLabel: source.label, color: source.color, local: byId.get(ev.uid) })
        }
        continue
      }
      if (!cache?.ics) continue
      for (const ev of parseIcs(cache.ics, from, to, tz)) {
        events.push({ ...ev, sourceId: source.id, sourceLabel: source.label, color: source.color })
      }
    } catch (err) {
      console.error('[calendar] parse failed', { label: source.label, message: (err as Error).message })
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary))
  res.json({
    events,
    tz: DEFAULT_TZ,
    sources: listSources().map((s) => statusOf(s, loaded.find((l) => l.source.id === s.id)?.cache ?? getCache(s.id))),
  })
})

router.post('/calendar/refresh', async (_req, res) => {
  const sources = listSources().filter((s) => s.enabled === 1 && s.kind === 'ics')
  const results = await Promise.all(sources.map(async (s) => ({ label: s.label, error: (await loadSource(s, true)).error || null })))
  res.json({ ok: true, results })
})

export default router
