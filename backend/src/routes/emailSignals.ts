import { Router } from 'express'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const exec = promisify(execFile)
const router = Router()

const EMAIL_ROOT = path.join(homedir(), 'email-assistant')
const DB_PATH = path.join(EMAIL_ROOT, 'data', 'mail.sqlite')
const DRAFTS_DIR = path.join(EMAIL_ROOT, 'drafts')
const LOG_PATH = path.join(EMAIL_ROOT, 'data', 'email-assistant.log')
const ACCOUNTS_PATH = path.join(EMAIL_ROOT, 'config', 'accounts.json')

type MsgRow = {
  account: string; uid: string; sender: string; subject: string
  date: string; classification: string; reason: string; snippet: string; seen_at: string
}

// The action inbox hides emails the user has "skipped" (acknowledged). The
// flag lives on the messages table in mail.sqlite; add it once, idempotently.
let ackColumnReady = false
function ensureAckColumn(): void {
  if (ackColumnReady) return
  try {
    const db = new Database(DB_PATH)
    try { db.exec('ALTER TABLE messages ADD COLUMN acked INTEGER NOT NULL DEFAULT 0') } catch { /* exists */ }
    finally { db.close() }
    ackColumnReady = true
  } catch { /* mail.sqlite not ready yet; try again next request */ }
}

function cleanSnippet(s: string): string {
  return s.slice(0, 300).replace(/\s+/g, ' ').trim()
}

function senderDisplay(raw: string): string {
  const m = raw.match(/^"?([^"<]+)"?\s*</)
  return m ? m[1].trim() : raw.replace(/<.*>/, '').trim() || raw
}

router.get('/email/signals', async (_req, res) => {
  try {
    ensureAckColumn()
    // --- service health ---
    const [timerOut, svcOut] = await Promise.allSettled([
      exec('systemctl', ['--user', 'show', 'email-assistant.timer',
        '--property=ActiveState,NextElapseUSecRealtime,LastTriggerUSec']),
      exec('systemctl', ['--user', 'show', 'email-assistant.service',
        '--property=ActiveState,SubState,ExecMainStatus,ExecMainStartTimestamp,Result']),
    ])
    const parseProps = (stdout: string) => Object.fromEntries(
      stdout.trim().split('\n').map((l) => l.split('=') as [string, string])
    )
    const timer = timerOut.status === 'fulfilled' ? parseProps(timerOut.value.stdout) : {}
    const svc = svcOut.status === 'fulfilled' ? parseProps(svcOut.value.stdout) : {}

    // --- accounts (safe — no passwords) ---
    let accounts: { id: string; address: string; provider: string; enabled: boolean }[] = []
    try {
      const cfg = JSON.parse(await fs.readFile(ACCOUNTS_PATH, 'utf8'))
      accounts = (cfg.accounts ?? []).map((a: Record<string, unknown>) => ({
        id: a.id, address: a.address, provider: a.provider, enabled: Boolean(a.enabled),
      }))
    } catch { /* accounts.json missing */ }

    // --- counts ---
    const db = new Database(DB_PATH, { readonly: true })
    const countRow = (sql: string, ...params: (string | number)[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n

    const now24h = "datetime('now', '-24 hours')"
    const now7d  = "datetime('now', '-7 days')"

    const counts = {
      important24h: countRow(`SELECT COUNT(*) as n FROM messages WHERE classification='important' AND seen_at > ${now24h}`),
      important7d:  countRow(`SELECT COUNT(*) as n FROM messages WHERE classification='important' AND seen_at > ${now7d}`),
      routine24h:   countRow(`SELECT COUNT(*) as n FROM messages WHERE classification='routine'   AND seen_at > ${now24h}`),
      routine7d:    countRow(`SELECT COUNT(*) as n FROM messages WHERE classification='routine'   AND seen_at > ${now7d}`),
      ignoredTotal: countRow(`SELECT COUNT(*) as n FROM messages WHERE classification NOT IN ('important','routine')`),
      total:        countRow(`SELECT COUNT(*) as n FROM messages`),
    }

    // --- actionable items (skipped/acked ones are hidden) ---
    const rows = db.prepare(
      `SELECT account, uid, sender, subject, date, classification, reason, snippet, seen_at
       FROM messages
       WHERE classification IN ('important','routine') AND COALESCE(acked, 0) = 0
       ORDER BY seen_at DESC LIMIT 20`
    ).all() as MsgRow[]

    const items = rows.map((r) => ({
      account:        r.account,
      uid:            r.uid,
      sender:         senderDisplay(r.sender),
      subject:        r.subject,
      date:           r.date,
      classification: r.classification,
      reason:         r.reason,
      snippet:        cleanSnippet(r.snippet),
      seen_at:        r.seen_at,
    }))

    db.close()

    // --- drafts ---
    let drafts: { filename: string; mtime: string; preview: string }[] = []
    try {
      const files = await fs.readdir(DRAFTS_DIR)
      const txtFiles = files.filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
      drafts = await Promise.all(
        txtFiles.slice(0, 10).map(async (f) => {
          const full = path.join(DRAFTS_DIR, f)
          const stat = await fs.stat(full)
          const content = await fs.readFile(full, 'utf8')
          return {
            filename: f,
            mtime: stat.mtime.toISOString(),
            preview: content.slice(0, 200).replace(/\s+/g, ' ').trim(),
          }
        })
      )
    } catch { /* drafts dir empty/missing */ }

    // --- recent errors from log ---
    const errors: string[] = []
    try {
      const logText = await fs.readFile(LOG_PATH, 'utf8')
      const lines = logText.split('\n').filter(Boolean)
      for (const line of lines.slice(-200)) {
        try {
          const obj = JSON.parse(line)
          if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.error) {
            errors.push(String(obj.error).slice(0, 200))
          }
        } catch { /* non-JSON lines */ }
      }
    } catch { /* log missing */ }

    res.json({
      timer: {
        active: timer.ActiveState ?? null,
        nextRun: timer.NextElapseUSecRealtime ?? null,
        lastTrigger: timer.LastTriggerUSec ?? null,
      },
      service: {
        active: svc.ActiveState ?? null,
        sub: svc.SubState ?? null,
        result: svc.Result ?? null,
        lastStart: svc.ExecMainStartTimestamp ?? null,
      },
      accounts,
      counts,
      items,
      drafts,
      recentErrors: errors.slice(-5),
    })
  } catch (err) {
    console.error('[500] signals unavailable:', err)
    res.status(500).json({ error: 'signals unavailable', detail: (err as Error).message })
  }
})

// Skip: acknowledge an email so it drops off the action inbox without any
// training signal (unlike spam / not-important, which reclassify the sender).
router.post('/email/signals/:account/:uid/ack', (req, res) => {
  try {
    ensureAckColumn()
    const db = new Database(DB_PATH)
    try {
      const r = db.prepare('UPDATE messages SET acked = 1 WHERE account = ? AND uid = ?')
        .run(req.params.account, req.params.uid)
      if (r.changes === 0) return res.status(404).json({ error: 'message not found' })
      res.json({ ok: true })
    } finally {
      db.close()
    }
  } catch (err) {
    console.error('[500] failed to skip email:', err)
    res.status(500).json({ error: 'failed to skip email', detail: (err as Error).message })
  }
})

export default router
