import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const exec = promisify(execFile)
const router = Router()

const DB_PATH = '/home/brendon/vaultwarden/vw-data/db.sqlite3'
const BACKUP_DIR = '/home/brendon/vaultwarden-backups'
const BACKUP_STALE_HOURS = 36
const CACHE_TTL_MS = 30_000

type ContainerInfo = {
  running: boolean
  healthy: boolean | null
  status: string | null
  startedAt: string | null
}

type ItemBreakdown = {
  total: number
  logins: number
  notes: number
  cards: number
  identities: number
  sshKeys: number
  trash: number
  folders: number
  attachments: number
  sends: number
  users: number
}

type BackupInfo = {
  lastAt: string | null
  lastSize: number | null
  count: number
  totalSize: number
  stale: boolean
}

let cache: { at: number; data: any } | null = null

async function readContainer(): Promise<ContainerInfo> {
  try {
    const { stdout } = await exec('docker', [
      'inspect', 'vaultwarden',
      '--format', '{{.State.Status}}|{{.State.Health.Status}}|{{.State.StartedAt}}',
    ], { timeout: 5_000 })
    const [status, health, startedAt] = stdout.trim().split('|')
    return {
      running: status === 'running',
      healthy: health === '<no value>' || !health ? null : health === 'healthy',
      status: status || null,
      startedAt: startedAt || null,
    }
  } catch {
    return { running: false, healthy: null, status: null, startedAt: null }
  }
}

async function sqliteScalar(query: string): Promise<number | null> {
  try {
    const { stdout } = await exec('sqlite3', ['-readonly', DB_PATH, query], { timeout: 5_000 })
    const n = Number(stdout.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function readItems(): Promise<ItemBreakdown | null> {
  try {
    const { stdout } = await exec('sqlite3', ['-readonly', DB_PATH,
      `SELECT atype, COUNT(*) FROM ciphers WHERE deleted_at IS NULL GROUP BY atype;`,
    ], { timeout: 5_000 })
    const byType: Record<string, number> = {}
    for (const line of stdout.trim().split('\n')) {
      const [t, n] = line.split('|')
      if (t && n) byType[t] = Number(n)
    }
    const [trash, folders, attachments, sends, users] = await Promise.all([
      sqliteScalar('SELECT COUNT(*) FROM ciphers WHERE deleted_at IS NOT NULL;'),
      sqliteScalar('SELECT COUNT(*) FROM folders;'),
      sqliteScalar('SELECT COUNT(*) FROM attachments;'),
      sqliteScalar('SELECT COUNT(*) FROM sends;'),
      sqliteScalar('SELECT COUNT(*) FROM users;'),
    ])
    const logins = byType['1'] ?? 0
    const notes = byType['2'] ?? 0
    const cards = byType['3'] ?? 0
    const identities = byType['4'] ?? 0
    const sshKeys = byType['5'] ?? 0
    return {
      total: logins + notes + cards + identities + sshKeys,
      logins, notes, cards, identities, sshKeys,
      trash: trash ?? 0,
      folders: folders ?? 0,
      attachments: attachments ?? 0,
      sends: sends ?? 0,
      users: users ?? 0,
    }
  } catch {
    return null
  }
}

function readBackups(): BackupInfo {
  let entries: { mtimeMs: number; size: number }[] = []
  try {
    entries = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite3'))
      .map((f) => {
        const s = statSync(path.join(BACKUP_DIR, f))
        return { mtimeMs: s.mtimeMs, size: s.size }
      })
  } catch {
    return { lastAt: null, lastSize: null, count: 0, totalSize: 0, stale: true }
  }
  if (entries.length === 0) return { lastAt: null, lastSize: null, count: 0, totalSize: 0, stale: true }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const last = entries[0]
  const totalSize = entries.reduce((acc, e) => acc + e.size, 0)
  const ageHours = (Date.now() - last.mtimeMs) / 3_600_000
  return {
    lastAt: new Date(last.mtimeMs).toISOString(),
    lastSize: last.size,
    count: entries.length,
    totalSize,
    stale: ageHours > BACKUP_STALE_HOURS,
  }
}

router.get('/vault', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(cache.data)
  }
  const [container, items] = await Promise.all([readContainer(), readItems()])
  const backups = readBackups()
  const data = { container, items, backups, updatedAt: new Date().toISOString() }
  cache = { at: Date.now(), data }
  res.json(data)
})

export default router
