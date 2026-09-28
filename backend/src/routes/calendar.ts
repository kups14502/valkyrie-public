import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { openDb } from '../lib/db.js'
import { parseIcs, type IcsEvent } from '../lib/ics.js'

const router = Router()

// Calendars are read from published ICS feeds, one row per feed. Read-only by
// design: a work calendar's authority is Exchange, and a published feed is
// the one way to read it that needs no app registration in the tenant.
//
// The feed URL is a bearer secret (anyone holding it reads the calendar), so it
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
`)

const DEFAULT_TZ = process.env.CALENDAR_TZ || 'America/New_York'
const REFRESH_MS = Number(process.env.CALENDAR_REFRESH_MS) || 10 * 60_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_ICS_BYTES = 12 * 1024 * 1024

type SourceRow = {
  id: string; label: string; url: string; color: string; tz: string
  enabled: number; sortOrder: number; createdAt: string
}
type CacheRow = { sourceId: string; ics: string; etag: string; fetchedAt: string; error: string }

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
  id: string; label: string; color: string; urlHint: string; tz: string
  enabled: boolean; fetchedAt: string | null; error: string | null
}

const statusOf = (s: SourceRow, cache?: CacheRow): SourceStatus => ({
  id: s.id,
  label: s.label,
  color: s.color,
  urlHint: describeUrl(s.url),
  tz: s.tz || DEFAULT_TZ,
  enabled: s.enabled === 1,
  fetchedAt: cache?.fetchedAt || null,
  error: cache?.error || null,
})

router.get('/calendar/sources', (_req, res) => {
  res.json({ sources: listSources().map((s) => statusOf(s, getCache(s.id))), tz: DEFAULT_TZ })
})

router.post('/calendar/sources', (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 80)
  // webcal:// is what Outlook and Apple hand out; it is plain https underneath.
  const url = String(req.body?.url || '').trim().replace(/^webcal:\/\//i, 'https://')
  const color = String(req.body?.color || '#00ff41').trim().slice(0, 32)
  const tz = String(req.body?.tz || '').trim().slice(0, 64)
  if (!label) return res.status(400).json({ error: 'label is required' })
  if (!isFetchableUrl(url)) return res.status(400).json({ error: 'url must be an http(s) or webcal ICS link' })
  const id = randomUUID()
  const max = db.prepare('SELECT COALESCE(MAX(sortOrder), -1) AS n FROM calendar_sources').get() as { n: number }
  db.prepare(`INSERT INTO calendar_sources (id, label, url, color, tz, enabled, sortOrder, createdAt)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, label, url, color, tz, max.n + 1, new Date().toISOString())
  const source = getSource(id)!
  // Fetch immediately so the UI can report a bad URL while the user is still
  // looking at the form.
  void loadSource(source, true).then((cache) => {
    if (cache.error) console.warn('[calendar] new source failed first fetch', { label, error: cache.error })
  })
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
  if (req.body?.url != null) {
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
  db.prepare('DELETE FROM calendar_cache WHERE sourceId = ?').run(req.params.id)
  const info = db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(req.params.id)
  res.json({ ok: true, deleted: info.changes })
})

const MAX_WINDOW_MS = 400 * 86_400_000

router.get('/calendar/events', async (req, res) => {
  const now = Date.now()
  const from = Number(req.query.from) || now - 7 * 86_400_000
  const to = Number(req.query.to) || now + 60 * 86_400_000
  if (to <= from || to - from > MAX_WINDOW_MS) {
    return res.status(400).json({ error: 'window must be positive and under about a year' })
  }
  const force = req.query.refresh === '1'
  const sources = listSources().filter((s) => s.enabled === 1)
  const loaded = await Promise.all(sources.map(async (s) => ({ source: s, cache: await loadSource(s, force) })))

  const events: (IcsEvent & { sourceId: string; sourceLabel: string; color: string })[] = []
  for (const { source, cache } of loaded) {
    if (!cache.ics) continue
    try {
      for (const ev of parseIcs(cache.ics, from, to, source.tz || DEFAULT_TZ)) {
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
    sources: loaded.map(({ source, cache }) => statusOf(source, cache)),
  })
})

router.post('/calendar/refresh', async (_req, res) => {
  const sources = listSources().filter((s) => s.enabled === 1)
  const results = await Promise.all(sources.map(async (s) => ({ label: s.label, error: (await loadSource(s, true)).error || null })))
  res.json({ ok: true, results })
})

export default router
