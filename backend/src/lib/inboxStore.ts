import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openDb } from './db.js'
import { pushToAll } from '../routes/push.js'

// The inbox: one list of everything the machines want to tell Brendon.
//
// WHY THIS EXISTS. Alerts, reports and reminders used to arrive as Discord DMs
// and channel posts (Lil' kups on odin), plus a few Web Push alerts straight
// from alerts.ts. Nothing kept a record he could scan in one place, and a chat
// app was the delivery channel for things like a failed RAID disk. Now every
// sender posts here (POST /api/inbox, or postInbox() in this process), the item
// is kept, and the ones worth interrupting him for go to the phone as Web Push.
//
// The rules, because none of this is obvious later:
//   * An item belongs to a SOURCE (backups, raid, trade, reminder...). Sources
//     appear the first time something posts under them; nothing is registered.
//   * LEVEL is info, warn or alert. Whether an item pushes: the source's own
//     setting wins when it is on or off (his choice, set in the UI); on auto,
//     the sender's explicit push flag wins; otherwise warn and alert push and
//     info does not.
//   * A TAG folds repeats: an open item with the same source and tag is
//     updated in place (count + 1, unread again, moved to the top) instead of
//     adding a row. A recovery posted with its problem's tag replaces it.
//   * An alert-level item whose push reached no device also goes to Discord
//     through Lil' kups (--discord, so it cannot loop back here). That is the
//     only Discord path left, and only for things that must not be missed.
//   * Items archive themselves 7 days after they were read; archived ones are
//     deleted 180 days after archiving. The list never grows without bound.
//   * A PRIVATE source (work mail, lib/mailStore.ts) is tailnet only: through
//     Cloudflare its items are left out of the list, the counts and the sources.

const exec = promisify(execFile)

export type InboxLevel = 'info' | 'warn' | 'alert'
export type PushSetting = 'auto' | 'on' | 'off'

export const LEVELS: InboxLevel[] = ['info', 'warn', 'alert']
export const PUSH_SETTINGS: PushSetting[] = ['auto', 'on', 'off']
export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const TITLE_MAX = 120
const BODY_MAX = 4000
const TAG_MAX = 80
const URL_MAX = 500
const READ_ARCHIVE_MS = 7 * 86_400_000
const ARCHIVE_DELETE_MS = 180 * 86_400_000
const ROW_CAP = 5000
const LILKUPS_BIN = process.env.LILKUPS_BIN || '/home/brendon/lilkups/lilkups'

const db = openDb('inbox', `
  CREATE TABLE IF NOT EXISTS inbox_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT,
    tag TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    firstAt TEXT NOT NULL,
    lastAt TEXT NOT NULL,
    readAt TEXT,
    archivedAt TEXT,
    pushedAt TEXT,
    pushDetail TEXT
  );
  CREATE INDEX IF NOT EXISTS inbox_open ON inbox_items (archivedAt, lastAt);
  CREATE INDEX IF NOT EXISTS inbox_tag ON inbox_items (source, tag);
  CREATE TABLE IF NOT EXISTS inbox_sources (
    source TEXT PRIMARY KEY,
    push TEXT NOT NULL DEFAULT 'auto'
  );
`)
// added with work mail: a source whose items stay on the tailnet
if (!(db.prepare('PRAGMA table_info(inbox_sources)').all() as { name: string }[]).some((c) => c.name === 'private')) {
  db.exec('ALTER TABLE inbox_sources ADD COLUMN private INTEGER NOT NULL DEFAULT 0')
}

type Row = {
  id: number; source: string; level: InboxLevel; title: string; body: string
  url: string | null; tag: string | null; count: number; firstAt: string; lastAt: string
  readAt: string | null; archivedAt: string | null; pushedAt: string | null; pushDetail: string | null
}

export type InboxItem = Row

export type InboxInput = {
  source: string
  title?: string
  body?: string
  level?: InboxLevel
  /** where "Open" goes: an app path (/m/...) or an http(s) link */
  url?: string
  /** folds repeats: an open item with the same source and tag is updated in place */
  tag?: string
  /** the sender's push intent; the source's on/off setting still wins */
  push?: boolean
  /** this process only: the lock-screen collapse key, kept when the service worker maps it to a screen */
  pushTag?: string
  /** this process only: where a tap on the notification lands, when it is not the item */
  pushUrl?: string
}

export type InboxResult = { item: InboxItem; folded: boolean; pushed: boolean; pushDetail: string | null }

export class InboxError extends Error {}

const nowIso = () => new Date().toISOString()

/** Discord markdown the old senders still write: bold, underline, strike, code ticks. */
function plain(s: string): string {
  return s.replace(/\*\*|__|~~|`/g, '').replace(/\r\n?/g, '\n')
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Title and body from the input; a missing title is the body's first line. */
function split(input: InboxInput): { title: string; body: string } {
  const body = plain(String(input.body ?? '')).trim()
  let title = plain(String(input.title ?? '')).replace(/\s+/g, ' ').trim()
  let rest = body
  if (!title) {
    const nl = body.indexOf('\n')
    title = (nl === -1 ? body : body.slice(0, nl)).replace(/\s+/g, ' ').trim()
    rest = nl === -1 ? '' : body.slice(nl + 1).trim()
  }
  if (!title) throw new InboxError('title or body required')
  return { title: clip(title, TITLE_MAX), body: clip(rest, BODY_MAX) }
}

function cleanUrl(url: unknown): string | null {
  const u = String(url ?? '').trim()
  if (!u) return null
  if (u.length > URL_MAX) throw new InboxError('url too long')
  if (u.startsWith('/') && !u.startsWith('//')) return u
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u
  throw new InboxError('url must be an app path or an http(s) link')
}

export function pushSetting(source: string): PushSetting {
  const r = db.prepare('SELECT push FROM inbox_sources WHERE source = ?').get(source) as { push: PushSetting } | undefined
  return r?.push ?? 'auto'
}

export function setPushSetting(source: string, push: PushSetting): void {
  if (!SOURCE_RE.test(source)) throw new InboxError('bad source')
  if (!PUSH_SETTINGS.includes(push)) throw new InboxError('push must be auto, on or off')
  db.prepare(`INSERT INTO inbox_sources (source, push) VALUES (?, ?)
    ON CONFLICT(source) DO UPDATE SET push = excluded.push`).run(source, push)
}

/** Mark a source tailnet only (or not). Its push setting is kept. */
export function setSourcePrivate(source: string, priv: boolean): void {
  if (!SOURCE_RE.test(source)) throw new InboxError('bad source')
  db.prepare(`INSERT INTO inbox_sources (source, push, private) VALUES (?, 'auto', ?)
    ON CONFLICT(source) DO UPDATE SET private = excluded.private`).run(source, priv ? 1 : 0)
}

/** The sources that stay on the tailnet. */
export function privateSources(): Set<string> {
  return new Set((db.prepare('SELECT source FROM inbox_sources WHERE private = 1').all() as { source: string }[]).map((r) => r.source))
}

/** SQL that leaves private sources out, with its arguments. */
function notPrivate(hide: boolean | undefined): { sql: string; args: string[] } {
  if (!hide) return { sql: '', args: [] }
  const list = [...privateSources()]
  return list.length ? { sql: ` AND source NOT IN (${list.map(() => '?').join(',')})`, args: list } : { sql: '', args: [] }
}

function wantsPush(source: string, level: InboxLevel, push: boolean | undefined): boolean {
  const setting = pushSetting(source)
  if (setting === 'on') return true
  if (setting === 'off') return false
  if (typeof push === 'boolean') return push
  return level !== 'info'
}

function sweep(): void {
  const now = Date.now()
  db.prepare('UPDATE inbox_items SET archivedAt = ? WHERE archivedAt IS NULL AND readAt IS NOT NULL AND readAt < ?')
    .run(nowIso(), new Date(now - READ_ARCHIVE_MS).toISOString())
  db.prepare('DELETE FROM inbox_items WHERE archivedAt IS NOT NULL AND archivedAt < ?')
    .run(new Date(now - ARCHIVE_DELETE_MS).toISOString())
  db.prepare(`DELETE FROM inbox_items WHERE id NOT IN (SELECT id FROM inbox_items ORDER BY lastAt DESC LIMIT ${ROW_CAP})`).run()
}

const getRow = (id: number): Row | undefined => db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as Row | undefined

/** The lock-screen text: never an empty body, because iOS fills one with "from Valkyrie". */
function pushBody(row: Row): string {
  const first = row.body.split('\n').map((l) => l.trim()).find(Boolean)
  return clip(first || row.source, 300)
}

async function discordFallback(row: Row): Promise<void> {
  const text = [`${row.title}`, row.body].filter(Boolean).join('\n').slice(0, 1900)
  try {
    await exec(LILKUPS_BIN, ['send', '--discord', '--message=' + text], { timeout: 20_000 })
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: unknown }
    const why = String(e.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? `exit ${String(e.code ?? '?')}`
    console.error('[inbox] Discord fallback failed:', why.slice(0, 200))
  }
}

/**
 * Store one item (or fold it into its open twin) and push it when it should.
 * Throws InboxError on bad input; never throws for a delivery failure.
 */
export async function postInbox(input: InboxInput): Promise<InboxResult> {
  const source = String(input.source ?? '').trim().toLowerCase()
  if (!SOURCE_RE.test(source)) throw new InboxError('source must be 1-32 of a-z, 0-9 and -')
  const level: InboxLevel = input.level ?? 'info'
  if (!LEVELS.includes(level)) throw new InboxError('level must be info, warn or alert')
  const { title, body } = split(input)
  const url = cleanUrl(input.url)
  const tag = input.tag ? clip(String(input.tag).trim(), TAG_MAX) : null
  const at = nowIso()

  let id: number
  let folded = false
  const twin = tag
    ? db.prepare('SELECT id FROM inbox_items WHERE source = ? AND tag = ? AND archivedAt IS NULL ORDER BY lastAt DESC LIMIT 1')
      .get(source, tag) as { id: number } | undefined
    : undefined
  if (twin) {
    db.prepare(`UPDATE inbox_items SET level = ?, title = ?, body = ?, url = ?, count = count + 1,
      lastAt = ?, readAt = NULL WHERE id = ?`).run(level, title, body, url, at, twin.id)
    id = twin.id
    folded = true
  } else {
    id = Number(db.prepare(`INSERT INTO inbox_items (source, level, title, body, url, tag, firstAt, lastAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(source, level, title, body, url, tag, at, at).lastInsertRowid)
  }
  sweep()

  let row = getRow(id)!
  let pushed = false
  let pushDetail: string | null = null
  if (wantsPush(source, level, input.push)) {
    const r = await pushToAll({
      title: clip(row.title, 80),
      body: pushBody(row),
      tag: input.pushTag || `inbox-${source}-${tag ?? id}`.slice(0, 60),
      url: input.pushUrl || `/m/inbox?item=${id}`,
    })
    pushed = r.ok
    pushDetail = r.detail
    db.prepare('UPDATE inbox_items SET pushedAt = ?, pushDetail = ? WHERE id = ?').run(r.ok ? nowIso() : null, r.detail, id)
    // not awaited: the sender's request must not wait on Discord, or a slow send times the
    // sender out and it posts the same text to Discord a second time
    if (!r.ok && level === 'alert') void discordFallback(row)
    row = getRow(id)!
  }
  return { item: row, folded, pushed, pushDetail }
}

// ------------------------------------------------------------- reading ----

export type InboxView = 'open' | 'archive'

export type SourceStat = { source: string; open: number; unread: number; push: PushSetting; lastAt: string | null }

export function listInbox(opts: { view?: InboxView; source?: string; limit?: number; before?: string; hidePrivate?: boolean }): InboxItem[] {
  const view = opts.view === 'archive' ? 'archive' : 'open'
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)))
  const where = [view === 'archive' ? 'archivedAt IS NOT NULL' : 'archivedAt IS NULL']
  const args: (string | number)[] = []
  if (opts.source) { where.push('source = ?'); args.push(opts.source) }
  if (opts.before) { where.push('lastAt < ?'); args.push(opts.before) }
  const priv = notPrivate(opts.hidePrivate)
  return db.prepare(`SELECT * FROM inbox_items WHERE ${where.join(' AND ')}${priv.sql} ORDER BY lastAt DESC, id DESC LIMIT ${limit}`)
    .all(...args, ...priv.args) as InboxItem[]
}

export function sourceStats(hidePrivate = false): SourceStat[] {
  const rows = db.prepare(`SELECT source,
      SUM(CASE WHEN archivedAt IS NULL THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN archivedAt IS NULL AND readAt IS NULL THEN 1 ELSE 0 END) AS unread,
      MAX(lastAt) AS lastAt
    FROM inbox_items GROUP BY source`).all() as { source: string; open: number; unread: number; lastAt: string | null }[]
  const settings = new Map((db.prepare('SELECT source, push FROM inbox_sources').all() as { source: string; push: PushSetting }[])
    .map((r) => [r.source, r.push]))
  const out: SourceStat[] = rows.map((r) => ({ ...r, push: settings.get(r.source) ?? 'auto' }))
  // a source he set on or off keeps its row after its items are gone
  for (const [source, push] of settings) {
    if (!out.some((r) => r.source === source)) out.push({ source, open: 0, unread: 0, push, lastAt: null })
  }
  const hidden = hidePrivate ? privateSources() : new Set<string>()
  return out.filter((r) => !hidden.has(r.source))
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.source.localeCompare(b.source))
}

export type InboxCount = { unread: number; alerts: number; lastAt: string | null }

export function inboxCount(hidePrivate = false): InboxCount {
  const priv = notPrivate(hidePrivate)
  const r = db.prepare(`SELECT
      SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN readAt IS NULL AND level = 'alert' THEN 1 ELSE 0 END) AS alerts,
      MAX(lastAt) AS lastAt
    FROM inbox_items WHERE archivedAt IS NULL${priv.sql}`).get(...priv.args) as { unread: number | null; alerts: number | null; lastAt: string | null }
  return { unread: r.unread ?? 0, alerts: r.alerts ?? 0, lastAt: r.lastAt }
}

// ------------------------------------------------------------- changing ----

export type Selector = { ids?: number[]; source?: string; all?: boolean }

/** WHERE clause for a selection inside one view; refuses an empty selection. */
function selection(sel: Selector, view: InboxView): { where: string; args: (string | number)[] } {
  const parts = [view === 'archive' ? 'archivedAt IS NOT NULL' : 'archivedAt IS NULL']
  const args: (string | number)[] = []
  if (Array.isArray(sel.ids) && sel.ids.length) {
    const ids = sel.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 1000)
    if (!ids.length) throw new InboxError('no valid ids')
    // ids address items in either view
    parts.length = 0
    parts.push(`id IN (${ids.map(() => '?').join(',')})`)
    args.push(...ids)
  } else if (sel.source) {
    if (!SOURCE_RE.test(sel.source)) throw new InboxError('bad source')
    parts.push('source = ?')
    args.push(sel.source)
  } else if (!sel.all) {
    throw new InboxError('ids, source or all required')
  }
  return { where: parts.join(' AND '), args }
}

export function markRead(sel: Selector, read: boolean): number {
  const { where, args } = selection(sel, 'open')
  return read
    ? db.prepare(`UPDATE inbox_items SET readAt = ? WHERE ${where} AND readAt IS NULL`).run(nowIso(), ...args).changes
    : db.prepare(`UPDATE inbox_items SET readAt = NULL WHERE ${where} AND readAt IS NOT NULL`).run(...args).changes
}

/** Archive (or bring back) items. `readOnly` limits a source/all archive to items already read. */
export function setArchived(sel: Selector & { readOnly?: boolean }, archived: boolean): number {
  const { where, args } = selection(sel, archived ? 'open' : 'archive')
  if (archived) {
    const extra = sel.readOnly ? ' AND readAt IS NOT NULL' : ''
    const at = nowIso()
    return db.prepare(`UPDATE inbox_items SET archivedAt = ?, readAt = COALESCE(readAt, ?) WHERE ${where} AND archivedAt IS NULL${extra}`)
      .run(at, at, ...args).changes
  }
  // back in the inbox: counted as read now, so the 7-day clock restarts and it is not archived again at once
  return db.prepare(`UPDATE inbox_items SET archivedAt = NULL, readAt = ? WHERE ${where} AND archivedAt IS NOT NULL`)
    .run(nowIso(), ...args).changes
}
