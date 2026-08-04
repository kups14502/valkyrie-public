import { Router } from 'express'
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { autotaskConfigured, findContactByEmail, createTicket } from '../lib/autotask.js'

// Only these mailboxes hold real client work email, so only they may spawn
// Autotask tickets — never the personal/internal accounts.
const TICKET_ACCOUNTS = new Set(['work', 'work-support'])

// Email intake queue. The email-assistant script on the server classifies each
// new email and writes an intake suggestion row (work → Autotask ticket
// candidates) into mail.sqlite. This route serves that queue and applies the
// user's decision: connect the email to a ticket, or dismiss it.

const router = Router()
const DB_PATH = path.join(homedir(), 'email-assistant', 'data', 'mail.sqlite')

type IntakeRow = {
  account: string
  uid: string
  is_work: number
  summary: string
  ticket_matches: string | null
  status: string
  linked_kind: string | null
  linked_ref: string | null
  linked_by: string | null
  processed_at: string
  // joined from messages
  sender: string | null
  subject: string | null
  date: string | null
  snippet: string | null
  classification: string | null
}

type TicketMatch = { id: number; ticketNumber: string; title: string; score: number }

function getDb(readonly: boolean) {
  return new Database(DB_PATH, readonly ? { readonly: true } : {})
}

function parseTicketMatches(raw: string | null): TicketMatch[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function serialize(r: IntakeRow) {
  return {
    account: r.account,
    uid: r.uid,
    isWork: Boolean(r.is_work),
    summary: r.summary,
    ticketMatches: parseTicketMatches(r.ticket_matches),
    status: r.status,
    linkedKind: r.linked_kind,
    linkedRef: r.linked_ref,
    linkedBy: r.linked_by ?? null,
    processedAt: r.processed_at,
    sender: r.sender ?? '',
    subject: r.subject ?? '(no subject)',
    date: r.date ?? '',
    snippet: (r.snippet ?? '').slice(0, 300),
    classification: r.classification ?? 'normal',
  }
}

const SELECT_INTAKE = `
  SELECT i.*, m.sender, m.subject, m.date, m.snippet, m.classification
  FROM intake i
  LEFT JOIN messages m ON m.account = i.account AND m.uid = i.uid`

router.get('/emails/intake', (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) return res.json({ items: [], counts: { pending: 0, linked: 0, dismissed: 0 } })
    const db = getDb(true)
    try {
      const hasIntake = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intake'").get()
      if (!hasIntake) return res.json({ items: [], counts: { pending: 0, linked: 0, dismissed: 0 } })
      const status = String(req.query.status ?? 'pending')
      const rows = (status === 'all'
        ? db.prepare(`${SELECT_INTAKE} ORDER BY i.processed_at DESC LIMIT 200`).all()
        : db.prepare(`${SELECT_INTAKE} WHERE i.status = ? ORDER BY i.processed_at DESC LIMIT 200`).all(status)) as IntakeRow[]
      const countRows = db.prepare('SELECT status, COUNT(*) as n FROM intake GROUP BY status').all() as { status: string; n: number }[]
      const counts = { pending: 0, linked: 0, dismissed: 0 }
      for (const c of countRows) {
        if (c.status in counts) counts[c.status as keyof typeof counts] = c.n
      }
      res.json({ items: rows.map(serialize), counts })
    } finally {
      db.close()
    }
  } catch (err) {
    console.error('[500] failed to read intake queue:', err)
    res.status(500).json({ error: 'failed to read intake queue', detail: (err as Error).message })
  }
})

function markIntake(account: string, uid: string, status: 'linked' | 'dismissed' | 'pending', linkedKind: string | null, linkedRef: string | null, linkedBy: string | null = null) {
  const db = getDb(false)
  try {
    const result = db.prepare('UPDATE intake SET status = ?, linked_kind = ?, linked_ref = ?, linked_by = ? WHERE account = ? AND uid = ?')
      .run(status, linkedKind, linkedRef, linkedBy, account, uid)
    if (result.changes === 0) throw new Error('intake item not found')
  } finally {
    db.close()
  }
}

// Check the row exists before doing any outside work (e.g. opening an Autotask
// ticket), so the only way markIntake can fail afterwards is a transient lock —
// which a retry converges on instead of duplicating the outside effect.
function intakeExists(account: string, uid: string): boolean {
  const db = getDb(true)
  try {
    return Boolean(db.prepare('SELECT 1 FROM intake WHERE account = ? AND uid = ?').get(account, uid))
  } finally {
    db.close()
  }
}

function emailFull(account: string, uid: string): { sender: string; subject: string; snippet: string } | null {
  const db = getDb(true)
  try {
    return db.prepare('SELECT sender, subject, snippet FROM messages WHERE account = ? AND uid = ?').get(account, uid) as
      | { sender: string; subject: string; snippet: string } | undefined ?? null
  } finally {
    db.close()
  }
}

// Create a new Autotask ticket from a work email, attribute it to the sender's
// client (via their Autotask contact), and link the intake item to it. Work
// mailboxes only; refuses when the sender can't be resolved to a client
// (e.g. internal senders) so it never misfiles a ticket.
router.post('/emails/intake/:account/:uid/create-ticket', async (req, res) => {
  const { account, uid } = req.params
  try {
    if (!TICKET_ACCOUNTS.has(account)) return res.status(400).json({ error: 'failed to create ticket', detail: 'this mailbox cannot spawn tickets' })
    if (!autotaskConfigured()) return res.status(400).json({ error: 'failed to create ticket', detail: 'Autotask not configured' })
    if (!intakeExists(account, uid)) return res.status(400).json({ error: 'failed to create ticket', detail: 'intake item not found' })
    const m = emailFull(account, uid)
    if (!m) return res.status(400).json({ error: 'failed to create ticket', detail: 'email not found' })

    const contact = await findContactByEmail(m.sender)
    if (!contact) return res.status(422).json({ error: 'failed to create ticket', detail: 'could not match the sender to an Autotask client — link manually' })

    const ticket = await createTicket({
      companyID: contact.companyID,
      contactID: contact.contactID,
      title: (m.subject || '(no subject)').slice(0, 200),
      description: `Created from email (${m.sender}).\n\n${m.snippet || ''}`,
    })

    // Link the intake item to the freshly created ticket.
    markIntake(account, uid, 'linked', 'ticket', ticket.ticketNumber, 'user')
    res.json({ ok: true, ticket: { id: ticket.id, ref: ticket.ticketNumber } })
  } catch (err) {
    const message = (err as Error).message || 'unknown error'
    console.error('[500] failed to create ticket:', err)
    res.status(500).json({ error: 'failed to create ticket', detail: message })
  }
})

// Apply a decision for one intake item.
// body: { kind: 'ticket', ref }
//  - ticket: ref = Autotask ticket number (records the connection)
router.post('/emails/intake/:account/:uid/link', (req, res) => {
  try {
    const { account, uid } = req.params
    const { kind, ref } = (req.body ?? {}) as { kind?: string; ref?: string }
    if (!intakeExists(account, uid)) return res.status(400).json({ error: 'failed to link intake item', detail: 'intake item not found' })
    if (kind === 'ticket') {
      const ticketRef = String(ref ?? '').trim()
      if (!ticketRef) return res.status(400).json({ error: 'ref required for ticket link' })
      markIntake(account, uid, 'linked', 'ticket', ticketRef, 'user')
      return res.json({ ok: true, linked: { kind: 'ticket', ref: ticketRef } })
    }
    res.status(400).json({ error: 'invalid link kind' })
  } catch (err) {
    const message = (err as Error).message || 'unknown error'
    if (/not found/.test(message)) return res.status(400).json({ error: 'failed to link intake item', detail: message })
    console.error('[500] failed to link intake item:', err)
    res.status(500).json({ error: 'failed to link intake item', detail: message })
  }
})

// Undo: put an item (e.g. a wrong auto-link) back in the pending queue.
router.post('/emails/intake/:account/:uid/unlink', (req, res) => {
  try {
    markIntake(req.params.account, req.params.uid, 'pending', null, null, null)
    res.json({ ok: true })
  } catch (err) {
    const message = (err as Error).message || 'unknown error'
    if (/not found/.test(message)) return res.status(400).json({ error: 'failed to unlink intake item', detail: message })
    console.error('[500] failed to unlink intake item:', err)
    res.status(500).json({ error: 'failed to unlink intake item', detail: message })
  }
})

router.post('/emails/intake/:account/:uid/dismiss', (req, res) => {
  try {
    markIntake(req.params.account, req.params.uid, 'dismissed', null, null)
    // Dismissals are training signal too: "this needed no intake".
    try { recordFeedback(req.params.account, req.params.uid, 'dismissed') } catch { /* best effort */ }
    res.json({ ok: true })
  } catch (err) {
    const message = (err as Error).message || 'unknown error'
    if (/not found/.test(message)) return res.status(400).json({ error: 'failed to dismiss intake item', detail: message })
    console.error('[500] failed to dismiss intake item:', err)
    res.status(500).json({ error: 'failed to dismiss intake item', detail: message })
  }
})

// ---------------------------------------------------------------------------
// Training feedback. Corrections are stored in mail.sqlite (the email
// assistant reads them back into its classifier prompt on every scan) and
// applied to the current row so the UI reflects the correction immediately.
// ---------------------------------------------------------------------------

const CORRECTIONS = ['spam', 'spam_once', 'not_important', 'important', 'flip_side'] as const
type Correction = (typeof CORRECTIONS)[number]

function recordFeedback(account: string, uid: string, correction: string) {
  const db = getDb(false)
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS feedback(
      account text, uid text, correction text, created_at text,
      primary key(account, uid, correction)
    )`).run()
    db.prepare('INSERT OR REPLACE INTO feedback (account, uid, correction, created_at) VALUES (?,?,?,?)')
      .run(account, uid, correction, new Date().toISOString())
  } finally {
    db.close()
  }
}

router.post('/emails/feedback', (req, res) => {
  try {
    const { account, uid, correction } = (req.body ?? {}) as { account?: string; uid?: string; correction?: string }
    if (!account || !uid) return res.status(400).json({ error: 'account and uid required' })
    if (!CORRECTIONS.includes(correction as Correction)) return res.status(400).json({ error: 'invalid correction' })

    recordFeedback(account, uid, correction!)
    const db = getDb(false)
    try {
      if (correction === 'spam' || correction === 'spam_once') {
        // 'spam' teaches the assistant to filter this sender forever (the
        // Python side builds its blocklist from correction='spam' rows);
        // 'spam_once' only buries this one email.
        db.prepare('UPDATE messages SET classification = ?, reason = ? WHERE account = ? AND uid = ?')
          .run('spam', correction === 'spam' ? 'Marked spam by user (sender blocked)' : 'Marked spam by user (one-off)', account, uid)
        db.prepare("UPDATE intake SET status = 'dismissed' WHERE account = ? AND uid = ? AND status = 'pending'")
          .run(account, uid)
      } else if (correction === 'not_important') {
        db.prepare('UPDATE messages SET classification = ?, reason = ? WHERE account = ? AND uid = ?')
          .run('normal', 'Downgraded by user', account, uid)
      } else if (correction === 'important') {
        db.prepare('UPDATE messages SET classification = ?, reason = ? WHERE account = ? AND uid = ?')
          .run('important', 'Upgraded by user', account, uid)
      } else if (correction === 'flip_side') {
        db.prepare('UPDATE intake SET is_work = CASE is_work WHEN 1 THEN 0 ELSE 1 END WHERE account = ? AND uid = ?')
          .run(account, uid)
      }
    } finally {
      db.close()
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[500] failed to record feedback:', err)
    res.status(500).json({ error: 'failed to record feedback', detail: (err as Error).message })
  }
})

export default router
