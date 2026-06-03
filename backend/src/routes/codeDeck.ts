import { Router } from 'express'
import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const router = Router()
const DATA_DIR = path.join(homedir(), 'master-control', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'code-deck.sqlite')

const BASE_PROJECT_ROOTS = [
  { id: 'work', label: 'Work / OneDrive', path: path.join(homedir(), 'work'), folder: 'Work' },
  { id: 'master-control', label: 'Master Control', path: path.join(homedir(), 'master-control'), folder: 'Personal' },
  { id: 'openclaw-home', label: 'OpenClaw Home', path: homedir(), folder: 'OpenClaw' },
  { id: 'dnd-bot', label: 'Bot Workspace', path: path.join(homedir(), 'dm-bot-runtime', 'workspace'), folder: 'OpenClaw' },
  { id: 'msp-platform', label: 'MSP Platform', path: path.join(homedir(), 'msp-platform'), folder: 'Work' },
  { id: 'trading', label: 'Trading', path: path.join(homedir(), 'trading'), folder: 'Personal' },
]

type ProjectRoot = { id: string; label: string; path: string; folder: string }

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'folder'
}

function discoverProjectRoots(): ProjectRoot[] {
  const roots: ProjectRoot[] = [...BASE_PROJECT_ROOTS]
  const addDir = (base: string, folder: string, prefix: string, maxDepth: number) => {
    if (!fs.existsSync(base)) return
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth) return
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ['node_modules', '__pycache__', '.venv'].includes(ent.name)) continue
        const full = path.join(dir, ent.name)
        const rel = path.relative(base, full)
        roots.push({ id: `${prefix}-${slug(rel)}`, label: rel.replaceAll(path.sep, ' / '), path: full, folder })
        walk(full, depth + 1)
      }
    }
    walk(base, 1)
  }
  addDir(path.join(homedir(), 'work'), 'Work', 'work', 2)
  addDir(path.join(homedir(), 'Projects'), 'Projects', 'projects', 2)
  const seen = new Set<string>()
  return roots.filter((r) => {
    if (seen.has(r.path)) return false
    seen.add(r.path)
    return true
  }).sort((a, b) => a.folder.localeCompare(b.folder) || a.label.localeCompare(b.label))
}

const PROFILES = [
  {
    id: 'main-claude',
    label: 'user@example.com Claude',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
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
    command: '/home/brendon/.local/bin/claude',
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

function allowedModels(profileId: string) {
  const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0]
  return profile.provider === 'codex'
    ? ['gpt-5.5']
    : ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']
}

function normalizeModel(profileId: string, requested: string) {
  const allowed = allowedModels(profileId)
  return allowed.includes(requested) ? requested : allowed[0]
}

function commandWithModel(row: SessionRow) {
  const profile = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
  if (profile.provider === 'claude') return `${profile.command} --model ${row.model}`
  return `${profile.command} --model ${row.model}`
}

function launchCommand(row: SessionRow) {
  const cd = `cd ${JSON.stringify(row.cwd)}`
  return `${cd} && ${commandWithModel(row)}`
}

function terminalCommand(row: SessionRow) {
  return commandWithModel(row)
}

function getSession(id: string): SessionRow | undefined {
  const d = db()
  const row = d.prepare('SELECT * FROM code_deck_sessions WHERE id=?').get(id) as SessionRow | undefined
  d.close()
  return row
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
      folders: Array.from(new Set([...discoverProjectRoots().map((p) => p.folder), ...rows.map((r) => r.folder)])).sort(),
      projectRoots: discoverProjectRoots().map((p) => ({ ...p, exists: fs.existsSync(p.path) })),
      profiles: PROFILES,
    })
  } catch (err) {
    res.status(500).json({ error: 'failed to read code deck', detail: (err as Error).message })
  }
})

router.post('/code-deck/sessions', (req, res) => {
  try {
    const body = req.body ?? {}
    const projectRoots = discoverProjectRoots()
    const root = projectRoots.find((p) => p.id === body.projectRootId) ?? projectRoots[0]
    const profile = PROFILES.find((p) => p.id === body.profileId) ?? PROFILES[0]
    const cwd = safePath(String(body.cwd || root.path))
    if (!cwd) return res.status(400).json({ error: 'invalid cwd' })
    const t = now()
    const row: SessionRow = {
      id: randomUUID(),
      title: String(body.title || 'New Code Session').slice(0, 120),
      folder: String(root.folder || 'Inbox').slice(0, 80),
      projectRootId: root.id,
      cwd,
      profileId: profile.id,
      model: normalizeModel(profile.id, String(body.model || profile.defaultModel)).slice(0, 80),
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
      model: normalizeModel(body.profileId != null ? String(body.profileId) : row.profileId, body.model != null ? String(body.model) : row.model).slice(0, 80),
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

export function attachCodeDeckWs(server: Server) {
  const wss = new WebSocketServer({ server, path: '/api/code-deck/ws' })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const row = getSession(sessionId)
    if (!row) {
      ws.send(JSON.stringify({ type: 'error', data: 'Code Deck session not found' }))
      ws.close()
      return
    }
    const profile = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
    const env = { ...process.env, ...profile.env, TERM: 'xterm-256color' }
    const command = terminalCommand(row)
    const shell = pty.spawn('/bin/bash', ['-lc', command], {
      name: 'xterm-256color',
      cols: Number(url.searchParams.get('cols') ?? 120),
      rows: Number(url.searchParams.get('rows') ?? 36),
      cwd: row.cwd,
      env,
    })
    const d = db()
    d.prepare('UPDATE code_deck_sessions SET status=?, updatedAt=? WHERE id=?').run('running', now(), row.id)
    d.close()
    ws.send(JSON.stringify({ type: 'meta', data: `connected: ${command} (${row.cwd})` }))
    shell.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }))
    })
    shell.onExit(({ exitCode, signal }) => {
      const d2 = db()
      d2.prepare('UPDATE code_deck_sessions SET status=?, updatedAt=? WHERE id=?').run(exitCode === 0 ? 'exited' : 'failed', now(), row.id)
      d2.close()
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', data: `process exited code=${exitCode} signal=${signal ?? ''}` }))
      if (ws.readyState === ws.OPEN) ws.close()
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; data?: string; cols?: number; rows?: number }
        if (msg.type === 'input') shell.write(String(msg.data ?? ''))
        if (msg.type === 'resize') shell.resize(Number(msg.cols ?? 120), Number(msg.rows ?? 36))
      } catch {
        shell.write(String(raw))
      }
    })
    ws.on('close', () => {
      try { shell.kill() } catch { /* noop */ }
    })
  })
}

export default router
