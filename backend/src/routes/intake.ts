import { Router } from 'express'
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { createQuest, addLink, getQuest } from '../quests/store.js'

// Email intake queue. The email-assistant script on the server classifies each
// new email and writes an intake suggestion row (work → Autotask ticket
// candidates, personal → quest match / new-quest suggestion) into mail.sqlite.
// This route serves that queue and applies the user's decision: connect the
// email to a ticket, connect it to a quest (existing or new), or dismiss it.

const router = Router()
const DB_PATH = path.join(homedir(), 'email-assistant', 'data', 'mail.sqlite')

type IntakeRow = {
  account: string
  uid: string
  is_work: number
  summary: string
  ticket_matches: string | null
  quest_match_id: string | null
  quest_match_title: string | null
  suggested_quest_title: string | null
  status: string
  linked_kind: string | null
  linked_ref: string | null
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
    questMatch: r.quest_match_id ? { id: r.quest_match_id, title: r.quest_match_title ?? '' } : null,
    suggestedQuestTitle: r.suggested_quest_title,
    status: r.status,
    linkedKind: r.linked_kind,
    linkedRef: r.linked_ref,
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

function markIntake(account: string, uid: string, status: 'linked' | 'dismissed' | 'pending', linkedKind: string | null, linkedRef: string | null) {
  const db = getDb(false)
  try {
    const result = db.prepare('UPDATE intake SET status = ?, linked_kind = ?, linked_ref = ? WHERE account = ? AND uid = ?')
      .run(status, linkedKind, linkedRef, account, uid)
    if (result.changes === 0) throw new Error('intake item not found')
  } finally {
    db.close()
  }
}

// The intake row lives in mail.sqlite and the quest lives in quests.sqlite, so
// the two writes cannot share a transaction. Checking existence up front means
// the only way markIntake can fail after a quest write is a transient lock,
// and addLink is idempotent, so a retry converges instead of duplicating.
function intakeExists(account: string, uid: string): boolean {
  const db = getDb(true)
  try {
    return Boolean(db.prepare('SELECT 1 FROM intake WHERE account = ? AND uid = ?').get(account, uid))
  } finally {
    db.close()
  }
}

function emailLabel(account: string, uid: string): string {
  try {
    const db = getDb(true)
    try {
      const m = db.prepare('SELECT sender, subject FROM messages WHERE account = ? AND uid = ?').get(account, uid) as
        | { sender: string; subject: string }
        | undefined
      if (m) return `${m.subject}`.slice(0, 200)
    } finally {
      db.close()
    }
  } catch { /* label is best-effort */ }
  return `${account}:${uid}`
}

// Apply a decision for one intake item.
// body: { kind: 'ticket' | 'quest' | 'new-quest', ref?, title? }
//  - ticket:    ref = Autotask ticket number (records the connection)
//  - quest:     ref = quest id (adds an email link on that quest)
//  - new-quest: title = quest title (creates the quest, then links the email)
router.post('/emails/intake/:account/:uid/link', (req, res) => {
  try {
    const { account, uid } = req.params
    const { kind, ref, title } = (req.body ?? {}) as { kind?: string; ref?: string; title?: string }
    if (!intakeExists(account, uid)) return res.status(400).json({ error: 'failed to link intake item', detail: 'intake item not found' })
    if (kind === 'ticket') {
      const ticketRef = String(ref ?? '').trim()
      if (!ticketRef) return res.status(400).json({ error: 'ref required for ticket link' })
      markIntake(account, uid, 'linked', 'ticket', ticketRef)
      return res.json({ ok: true, linked: { kind: 'ticket', ref: ticketRef } })
    }
    if (kind === 'quest') {
      const questId = String(ref ?? '').trim()
      if (!questId || !getQuest(questId)) return res.status(400).json({ error: 'quest not found' })
      addLink(questId, { kind: 'email', ref: `${account}:${uid}`, label: emailLabel(account, uid) })
      markIntake(account, uid, 'linked', 'quest', questId)
      return res.json({ ok: true, linked: { kind: 'quest', ref: questId } })
    }
    if (kind === 'new-quest') {
      const questTitle = String(title ?? '').trim()
      if (!questTitle) return res.status(400).json({ error: 'title required for new-quest link' })
      const quest = createQuest({ title: questTitle, category: 'side' })
      addLink(quest.id, { kind: 'email', ref: `${account}:${uid}`, label: emailLabel(account, uid) })
      markIntake(account, uid, 'linked', 'quest', quest.id)
      return res.json({ ok: true, linked: { kind: 'quest', ref: quest.id }, quest })
    }
    res.status(400).json({ error: 'invalid link kind' })
  } catch (err) {
    const message = (err as Error).message || 'unknown error'
    if (/not found/.test(message)) return res.status(400).json({ error: 'failed to link intake item', detail: message })
    console.error('[500] failed to link intake item:', err)
    res.status(500).json({ error: 'failed to link intake item', detail: message })
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

const CORRECTIONS = ['spam', 'not_important', 'important', 'flip_side'] as const
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
      if (correction === 'spam') {
        db.prepare('UPDATE messages SET classification = ?, reason = ? WHERE account = ? AND uid = ?')
          .run('spam', 'Marked spam by user', account, uid)
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
        // A row flipped to personal needs a quest-title suggestion for the UI's
        // "new quest" button; fall back to the email subject.
        db.prepare(`UPDATE intake SET suggested_quest_title = COALESCE(
            suggested_quest_title,
            (SELECT substr(subject, 1, 60) FROM messages WHERE messages.account = intake.account AND messages.uid = intake.uid)
          ) WHERE account = ? AND uid = ? AND is_work = 0`)
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
