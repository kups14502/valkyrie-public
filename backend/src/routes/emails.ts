import { Router } from 'express'
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { homedir } from 'node:os'

const exec = promisify(execFile)
const router = Router()
const DB_PATH = path.join(homedir(), 'email-assistant', 'data', 'mail.sqlite')

type Message = {
  account: string
  uid: string
  message_id: string
  sender: string
  subject: string
  date: string
  classification: string
  reason: string
  snippet: string
  seen_at: string
}

function getDb() {
  return new Database(DB_PATH, { readonly: true })
}

router.get('/emails', (_req, res) => {
  try {
    const db = getDb()
    const { account, classification, limit = '100', offset = '0' } = _req.query as Record<string, string>

    let where = '1=1'
    const params: (string | number)[] = []
    if (account && account !== 'all') { where += ' AND account = ?'; params.push(account) }
    if (classification && classification !== 'all') { where += ' AND classification = ?'; params.push(classification) }

    const total = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE ${where}`).get(...params) as { n: number }).n
    const rows = db.prepare(
      `SELECT account, uid, message_id, sender, subject, date, classification, reason, snippet, seen_at
       FROM messages WHERE ${where}
       ORDER BY seen_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, Number(limit), Number(offset)) as Message[]

    const accounts = (db.prepare('SELECT account, COUNT(*) as count FROM messages GROUP BY account ORDER BY count DESC').all() as { account: string; count: number }[])
    const byClass = (db.prepare('SELECT classification, COUNT(*) as count FROM messages GROUP BY classification').all() as { classification: string; count: number }[])

    db.close()
    res.json({ messages: rows, total, accounts, byClassification: byClass })
  } catch (err) {
    res.status(500).json({ error: 'failed to read email database', detail: (err as Error).message })
  }
})

router.get('/emails/status', async (_req, res) => {
  try {
    const [timerOut, serviceOut] = await Promise.allSettled([
      exec('systemctl', ['--user', 'show', 'email-assistant.timer', '--property=ActiveState,NextElapseUSecRealtime,LastTriggerUSec']),
      exec('systemctl', ['--user', 'show', 'email-assistant.service', '--property=ActiveState,ExecMainStatus,ExecMainStartTimestamp']),
    ])

    const parseProps = (stdout: string) => Object.fromEntries(
      stdout.trim().split('\n').map((l) => l.split('=').map((s) => s.trim()) as [string, string])
    )

    const timer = timerOut.status === 'fulfilled' ? parseProps(timerOut.value.stdout) : {}
    const service = serviceOut.status === 'fulfilled' ? parseProps(serviceOut.value.stdout) : {}

    let db
    let dbStats: { total: number; lastSeen: string | null } = { total: 0, lastSeen: null }
    try {
      db = getDb()
      const row = db.prepare('SELECT COUNT(*) as total, MAX(seen_at) as lastSeen FROM messages').get() as { total: number; lastSeen: string | null }
      dbStats = row
      db.close()
    } catch { /* db may not exist yet */ }

    res.json({ timer, service, dbStats })
  } catch (err) {
    res.status(500).json({ error: 'failed to read service status', detail: (err as Error).message })
  }
})

export default router
