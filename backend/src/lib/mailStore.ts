import { createHash } from 'node:crypto'
import { openDb } from './db.js'
import { InboxError, markRead, postInbox, setArchived, setSourcePrivate, SOURCE_RE } from './inboxStore.js'

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
//   * only mail a person wrote does (2026-11-01). Focused let through
//     statements, newsletters, delivery notices, meeting replies and ticket
//     notifications, so automated() drops them; they stay in Mail and Today.
//     A message sitting in two mailboxes (CC'd to both) is one inbox item;
//   * job application receipts never do either (jobMail(), 2026-11-05);
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

// A sender that only ever sends automatically: the mailbox name, or the
// sending subdomain bulk mailers use (m., email., post., account. ...).
const AUTO_LOCAL_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletters?|news|notifications?|notify|alerts?|mailer(-daemon)?|bounces?|marketing|promo(tions)?|offers|deals|digest|updates?|replies|order-update|shipment-tracking|auto-confirm|billing|statements?)([-_.+].*)?$/i
const AUTO_HOST_RE = /^(m|e|em|email|emails|mail|mailer|mailing|post|news|newsletter|marketing|promo|info|account|accounts|notify|notifications|alerts|consult|talent|engage|txn)\./i
// Meeting replies and ticket notifications: generated, even when a person's name is on them.
const AUTO_SUBJECT_RE = /^(accepted|declined|tentative|tentatively accepted)\s*:|^(ticket|task) (note|created|assigned|updated|completed|escalated)\b|\bnote created:/i

/** True for mail no person wrote: it stays in Mail but never becomes an inbox item. */
export function automated(m: { fromAddress: string; subject: string }): boolean {
  const [local = '', host = ''] = m.fromAddress.toLowerCase().split('@')
  if (AUTO_LOCAL_RE.test(local)) return true
  if (host.split('.').length >= 3 && AUTO_HOST_RE.test(host)) return true
  return AUTO_SUBJECT_RE.test(m.subject)
}

// Mail the job runner sets off: "thank you for applying"
// receipts, candidate-account and security-code mail. Careers inboxes are not
// no-reply, so automated() lets them through (2026-11-05). A rejection or an
// invitation stays an inbox item: the preview is checked for those first.
const JOB_RE = /appl(y|ying|ied|ication)|candida|career|recruit|talent|hiring|workday|greenhouse|ashby|lever\.co|icims|smartrecruiters/i
const JOB_HOUSEKEEPING_RE = /security code for your application|(verify|reset your password for) your candidate account|candidate (home )?account/i
const JOB_RECEIPT_RE = /thank(s| you)( so much)? for (applying|your application|submitting)|received your (job )?application|application (received|confirmation)|(has|have) been (successfully )?(received|submitted)|confirms? (the )?receipt|we got it|reviewing your application|will review|tell us about your experience|love your feedback/i
const JOB_SIGNAL_RE = /(you('re| are)|we'?d like to|would like to|pleased to|happy to) (be )?invit|invit(ed|ation|e you) (you )?to (participate|interview|complete|schedule|a|an|our)|move forward with (you|your)|like to (schedule|set up|arrange)|book (a|an|your) (time|call|interview)|complete (the|this|our|a) (assessment|questionnaire|coding)|unfortunat|not (be )?(moving|move|proceed)|decided (to|not to) (move|pursue|proceed)|other candidates|no longer (being )?considered|regret to inform|not (been )?selected|not (see )?a (match|fit)|offer (letter|of employment)|congratulations/i

/** True for application receipts and candidate-account mail: kept in Mail, never an inbox item. */
export function jobMail(m: { fromAddress: string; subject: string; preview: string }): boolean {
  if (JOB_HOUSEKEEPING_RE.test(m.subject)) return true
  const text = `${m.subject} ${m.fromAddress} ${m.preview}`
  return JOB_RE.test(text) && !JOB_SIGNAL_RE.test(text) && JOB_RECEIPT_RE.test(text)
}

// job mail that became an inbox item before jobMail() existed goes to Archive
{
  const ids = (db.prepare('SELECT inboxId, fromAddress, subject, preview FROM mail_messages WHERE inboxId IS NOT NULL').all() as Pick<MsgRow, 'inboxId' | 'fromAddress' | 'subject' | 'preview'>[])
    .filter(jobMail).map((m) => m.inboxId as number)
  if (ids.length) console.log(`[mail] archived ${setArchived({ ids }, true)} job mail inbox items`)
}

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
    // the same message delivered to another mailbox already has an item: share it
    const twin = db.prepare(`SELECT inboxId FROM mail_messages WHERE mailbox != ? AND fromAddress = ? AND subject = ?
      AND ABS(julianday(receivedAt) - julianday(?)) * 1440 < 2 AND inboxId IS NOT NULL`)
      .get(key, row.fromAddress, row.subject, row.receivedAt) as { inboxId: number } | undefined
    if (twin) {
      row.inboxId = twin.inboxId
    } else if (!isRead && row.focused && !automated(row) && !jobMail(row) && Date.now() - Date.parse(row.receivedAt) < INBOX_WINDOW_MS) {
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
