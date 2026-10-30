import { createHash } from 'node:crypto'
import { openDb } from './db.js'
import { InboxError, markRead, postInbox, setSourcePrivate, SOURCE_RE } from './inboxStore.js'

// Mail, as a list: what a person sees in an inbox row, never the body.
//
// A job on thor (C:\Thor\tools\mail-sync\Sync-Mail.ps1) reads each work
// mailbox with the existing app-only access there and posts its last 48 hours
// here every few minutes: sender, subject, a short preview, received time,
// read state, Focused or Other, the Outlook web link. The certificate never
// leaves thor; Valkyrie only ever holds these rows.
//
// What it does with them:
//   * keeps 14 days of rows and each mailbox's unread count (Today, the brief);
//   * a NEW unread Focused message from the last 24 hours becomes an inbox
//     item under the mailbox's source, info level, no push (Outlook already
//     buzzes the phone); reading it in Outlook marks that item read here;
//   * a mailbox marked private (work mail) is tailnet only: through Cloudflare
//     its rows and its inbox items answer like they do not exist.

const KEEP_DAYS = 14
const INBOX_WINDOW_MS = 24 * 3_600_000
const STALE_MS = 15 * 60_000

const db = openDb('mail', `
  CREATE TABLE IF NOT EXISTS mailboxes (
    key      TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    source   TEXT NOT NULL,
    private  INTEGER NOT NULL DEFAULT 1,
    unread   INTEGER,
    total    INTEGER,
    syncedAt TEXT,
    error    TEXT,
    errorAt  TEXT
  );
  CREATE TABLE IF NOT EXISTS mail_messages (
    mailbox     TEXT NOT NULL,
    id          TEXT NOT NULL,
    fromName    TEXT NOT NULL DEFAULT '',
    fromAddress TEXT NOT NULL DEFAULT '',
    subject     TEXT NOT NULL DEFAULT '',
    preview     TEXT NOT NULL DEFAULT '',
    receivedAt  TEXT NOT NULL,
    isRead      INTEGER NOT NULL,
    webLink     TEXT,
    importance  TEXT NOT NULL DEFAULT 'normal',
    flagged     INTEGER NOT NULL DEFAULT 0,
    focused     INTEGER NOT NULL DEFAULT 1,
    inboxId     INTEGER,
    firstSeenAt TEXT NOT NULL,
    PRIMARY KEY (mailbox, id)
  );
  CREATE INDEX IF NOT EXISTS ix_mail_recent ON mail_messages (receivedAt);
`)

type BoxRow = {
  key: string; label: string; source: string; private: 0 | 1; unread: number | null; total: number | null
  syncedAt: string | null; error: string | null; errorAt: string | null
}
type MsgRow = {
  mailbox: string; id: string; fromName: string; fromAddress: string; subject: string; preview: string
  receivedAt: string; isRead: 0 | 1; webLink: string | null; importance: string; flagged: 0 | 1; focused: 0 | 1
  inboxId: number | null; firstSeenAt: string
}

export type Mailbox = { key: string; label: string; source: string; unread: number | null; syncedAt: string | null; stale: boolean; error: string | null }
export type MailMessage = {
  mailbox: string; label: string; fromName: string; fromAddress: string; subject: string; preview: string
  receivedAt: string; isRead: boolean; webLink: string | null; flagged: boolean; important: boolean
}

const nowIso = () => new Date().toISOString()
const clip = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

type SyncInput = {
  mailbox?: { key?: unknown; label?: unknown; source?: unknown; private?: unknown }
  unread?: unknown; total?: unknown; error?: unknown
  messages?: unknown
}

/** One mailbox's latest read from thor. Returns how many inbox items it added. */
export async function syncMailbox(input: SyncInput): Promise<{ added: number; known: number; markedRead: number }> {
  const mb = input.mailbox ?? {}
  const key = String(mb.key ?? '')
  const source = String(mb.source ?? '')
  if (!KEY_RE.test(key)) throw new InboxError('mailbox.key must be 1-32 of a-z, 0-9 and -')
  if (!SOURCE_RE.test(source)) throw new InboxError('mailbox.source must be 1-32 of a-z, 0-9 and -')
  const label = clip(mb.label, 40) || key
  const priv = mb.private !== false
  const at = nowIso()

  setSourcePrivate(source, priv)
  if (typeof input.error === 'string' && input.error) {
    db.prepare(`INSERT INTO mailboxes (key, label, source, private, error, errorAt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET label = excluded.label, source = excluded.source, private = excluded.private, error = excluded.error, errorAt = excluded.errorAt`)
      .run(key, label, source, priv ? 1 : 0, clip(input.error, 300), at)
    return { added: 0, known: 0, markedRead: 0 }
  }
  db.prepare(`INSERT INTO mailboxes (key, label, source, private, unread, total, syncedAt, error, errorAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, source = excluded.source, private = excluded.private,
      unread = excluded.unread, total = excluded.total, syncedAt = excluded.syncedAt, error = NULL, errorAt = NULL`)
    .run(key, label, source, priv ? 1 : 0, Number(input.unread) || 0, Number(input.total) || 0, at)

  const list = Array.isArray(input.messages) ? input.messages.slice(0, 200) as Record<string, unknown>[] : []
  let added = 0, known = 0, markedRead = 0
  for (const m of list) {
    const id = String(m.id ?? '')
    const received = String(m.receivedAt ?? '')
    if (!id || id.length > 400 || Number.isNaN(Date.parse(received))) continue
    const isRead = m.isRead === true
    const link = typeof m.webLink === 'string' && /^https:\/\//.test(m.webLink) ? m.webLink.slice(0, 1000) : null
    const before = db.prepare('SELECT * FROM mail_messages WHERE mailbox = ? AND id = ?').get(key, id) as MsgRow | undefined
    if (before) {
      known++
      db.prepare('UPDATE mail_messages SET isRead = ?, flagged = ?, focused = ? WHERE mailbox = ? AND id = ?')
        .run(isRead ? 1 : 0, m.flagged === true ? 1 : 0, m.focused === false ? 0 : 1, key, id)
      // read in Outlook: read here too
      if (isRead && !before.isRead && before.inboxId) markedRead += markRead({ ids: [before.inboxId] }, true)
      continue
    }
    const row: MsgRow = {
      mailbox: key, id, fromName: clip(m.fromName, 120), fromAddress: clip(m.fromAddress, 200), subject: clip(m.subject, 300),
      preview: clip(m.preview, 300), receivedAt: new Date(received).toISOString(), isRead: isRead ? 1 : 0, webLink: link,
      importance: clip(m.importance, 10) || 'normal', flagged: m.flagged === true ? 1 : 0, focused: m.focused === false ? 0 : 1,
      inboxId: null, firstSeenAt: at,
    }
    if (!isRead && row.focused && Date.now() - Date.parse(row.receivedAt) < INBOX_WINDOW_MS) {
      try {
        const r = await postInbox({
          source, level: row.importance === 'high' ? 'warn' : 'info', push: false,
          title: `${row.fromName || row.fromAddress || 'Unknown sender'}: ${row.subject || '(no subject)'}`,
          body: row.preview, url: link ?? undefined,
          tag: `m-${createHash('sha256').update(`${key}:${id}`).digest('hex').slice(0, 16)}`,
        })
        row.inboxId = r.item.id
        added++
      } catch (err) {
        console.error('[mail] inbox post failed:', (err as Error).message)
      }
    }
    db.prepare(`INSERT INTO mail_messages (mailbox, id, fromName, fromAddress, subject, preview, receivedAt, isRead, webLink, importance, flagged, focused, inboxId, firstSeenAt)
      VALUES (@mailbox, @id, @fromName, @fromAddress, @subject, @preview, @receivedAt, @isRead, @webLink, @importance, @flagged, @focused, @inboxId, @firstSeenAt)`).run(row)
  }
  db.prepare('DELETE FROM mail_messages WHERE receivedAt < ?').run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString())
  return { added, known, markedRead }
}

export function mailboxes(hidePrivate: boolean): Mailbox[] {
  return (db.prepare('SELECT * FROM mailboxes ORDER BY key').all() as BoxRow[])
    .filter((b) => !(hidePrivate && b.private))
    .map((b) => ({
      key: b.key, label: b.label, source: b.source, unread: b.unread, syncedAt: b.syncedAt,
      stale: !b.syncedAt || Date.now() - Date.parse(b.syncedAt) > STALE_MS, error: b.error,
    }))
}

/** Unread Focused mail of the last few days, newest first. */
export function unreadMail(hidePrivate: boolean, days = 3, limit = 30): MailMessage[] {
  const labels = new Map((db.prepare('SELECT key, label, private FROM mailboxes').all() as Pick<BoxRow, 'key' | 'label' | 'private'>[])
    .map((b) => [b.key, b]))
  return (db.prepare(`SELECT * FROM mail_messages WHERE isRead = 0 AND focused = 1 AND receivedAt >= ? ORDER BY receivedAt DESC LIMIT ?`)
    .all(new Date(Date.now() - days * 86_400_000).toISOString(), Math.min(100, limit * 2)) as MsgRow[])
    .filter((m) => !(hidePrivate && (labels.get(m.mailbox)?.private ?? 1)))
    .slice(0, limit)
    .map((m) => ({
      mailbox: m.mailbox, label: labels.get(m.mailbox)?.label ?? m.mailbox, fromName: m.fromName, fromAddress: m.fromAddress,
      subject: m.subject, preview: m.preview, receivedAt: m.receivedAt, isRead: false, webLink: m.webLink,
      flagged: m.flagged === 1, important: m.importance === 'high',
    }))
}
