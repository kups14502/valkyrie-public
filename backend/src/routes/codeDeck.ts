import { Router } from 'express'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const router = Router()
const DATA_DIR = path.join(homedir(), 'master-control', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'code-deck.sqlite')

const PROJECT_ROOTS = [
  { id: 'work', label: 'Work / OneDrive', path: path.join(homedir(), 'work'), folder: 'work' },
  { id: 'master-control', label: 'Master Control', path: path.join(homedir(), 'master-control'), folder: 'personal' },
  { id: 'openclaw-home', label: 'OpenClaw Home', path: homedir(), folder: 'openclaw' },
  { id: 'dnd-bot', label: 'Bot Workspace', path: path.join(homedir(), 'dm-bot-runtime', 'workspace'), folder: 'openclaw' },
  { id: 'msp-platform', label: 'MSP Platform', path: path.join(homedir(), 'msp-platform'), folder: 'work' },
  { id: 'trading', label: 'Trading', path: path.join(homedir(), 'trading'), folder: 'personal' },
]

const PROFILES = [
  {
    id: 'main-claude',
    label: 'user@example.com Claude',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: 'claude',
    env: {},
  },
  {
    id: 'main-codex',
    label: 'user@example.com Codex',
    provider: 'codex',
    defaultModel: 'gpt-5.5',
    command: 'codex',
    env: {},
  },
  {
    id: 'botacct-claude',
    label: 'bot@example.com Claude',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: 'CLAUDE_CONFIG_DIR=/home/brendon/.claude-botacct claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-botacct' },
  },
]

type SessionRow = {
  id: string
  title: string
  folder: string
  projectRootId: string
  cwd: string
  profileId: string
  model: string
  pinned: number
  status: string
  notes: string
  createdAt: string
  updatedAt: string
}

function db() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const d = new Database(DB_PATH)
  d.exec(`
    CREATE TABLE IF NOT EXISTS code_deck_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      folder TEXT NOT NULL,
      projectRootId TEXT NOT NULL,
      cwd TEXT NOT NULL,
      profileId TEXT NOT NULL,
      model TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'planned',
      notes TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `)
  return d
}

function now() { return new Date().toISOString() }

function safePath(input: string): string | null {
  const resolved = path.resolve(input.replace(/^~(?=$|\/)/, homedir()))
  const allowed = [homedir(), '/home/brendon/work']
  if (!allowed.some((base) => resolved === base || resolved.startsWith(base + path.sep))) return null
  return resolved
}

function launchCommand(row: SessionRow) {
  const profile = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
  const cd = `cd ${JSON.stringify(row.cwd)}`
  if (profile.provider === 'claude') return `${cd} && ${profile.command} --model ${row.model}`
  return `${cd} && ${profile.command}`
}

function serialize(row: SessionRow) {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    launchCommand: launchCommand(row),
  }
}

router.get('/code-deck', (_req, res) => {
  try {
    const d = db()
    const rows = d.prepare('SELECT * FROM code_deck_sessions ORDER BY pinned DESC, updatedAt DESC').all() as SessionRow[]
    d.close()
    res.json({
      sessions: rows.map(serialize),
      folders: Array.from(new Set([...PROJECT_ROOTS.map((p) => p.folder), ...rows.map((r) => r.folder)])).sort(),
      projectRoots: PROJECT_ROOTS.map((p) => ({ ...p, exists: fs.existsSync(p.path) })),
      profiles: PROFILES,
    })
  } catch (err) {
    res.status(500).json({ error: 'failed to read code deck', detail: (err as Error).message })
  }
})

router.post('/code-deck/sessions', (req, res) => {
  try {
    const body = req.body ?? {}
    const root = PROJECT_ROOTS.find((p) => p.id === body.projectRootId) ?? PROJECT_ROOTS[0]
    const profile = PROFILES.find((p) => p.id === body.profileId) ?? PROFILES[0]
    const cwd = safePath(String(body.cwd || root.path))
    if (!cwd) return res.status(400).json({ error: 'invalid cwd' })
    const t = now()
    const row: SessionRow = {
      id: randomUUID(),
      title: String(body.title || 'New Code Session').slice(0, 120),
      folder: String(body.folder || root.folder || 'inbox').slice(0, 80),
      projectRootId: root.id,
      cwd,
      profileId: profile.id,
      model: String(body.model || profile.defaultModel).slice(0, 80),
      pinned: body.pinned ? 1 : 0,
      status: 'planned',
      notes: String(body.notes || '').slice(0, 4000),
      createdAt: t,
      updatedAt: t,
    }
    const d = db()
    d.prepare(`INSERT INTO code_deck_sessions VALUES (@id,@title,@folder,@projectRootId,@cwd,@profileId,@model,@pinned,@status,@notes,@createdAt,@updatedAt)`).run(row)
    d.close()
    res.json({ session: serialize(row) })
  } catch (err) {
    res.status(500).json({ error: 'failed to create session', detail: (err as Error).message })
  }
})

router.patch('/code-deck/sessions/:id', (req, res) => {
  try {
    const d = db()
    const row = d.prepare('SELECT * FROM code_deck_sessions WHERE id=?').get(req.params.id) as SessionRow | undefined
    if (!row) { d.close(); return res.status(404).json({ error: 'not found' }) }
    const body = req.body ?? {}
    const next: SessionRow = {
      ...row,
      title: body.title != null ? String(body.title).slice(0, 120) : row.title,
      folder: body.folder != null ? String(body.folder).slice(0, 80) : row.folder,
      projectRootId: body.projectRootId != null ? String(body.projectRootId) : row.projectRootId,
      cwd: body.cwd != null ? (safePath(String(body.cwd)) ?? row.cwd) : row.cwd,
      profileId: body.profileId != null ? String(body.profileId) : row.profileId,
      model: body.model != null ? String(body.model).slice(0, 80) : row.model,
      pinned: body.pinned != null ? (body.pinned ? 1 : 0) : row.pinned,
      status: body.status != null ? String(body.status).slice(0, 40) : row.status,
      notes: body.notes != null ? String(body.notes).slice(0, 4000) : row.notes,
      updatedAt: now(),
    }
    d.prepare(`UPDATE code_deck_sessions SET title=@title, folder=@folder, projectRootId=@projectRootId, cwd=@cwd, profileId=@profileId, model=@model, pinned=@pinned, status=@status, notes=@notes, updatedAt=@updatedAt WHERE id=@id`).run(next)
    d.close()
    res.json({ session: serialize(next) })
  } catch (err) {
    res.status(500).json({ error: 'failed to update session', detail: (err as Error).message })
  }
})

router.delete('/code-deck/sessions/:id', (req, res) => {
  try {
    const d = db()
    d.prepare('DELETE FROM code_deck_sessions WHERE id=?').run(req.params.id)
    d.close()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'failed to delete session', detail: (err as Error).message })
  }
})

export default router
