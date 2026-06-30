import express, { Router } from 'express'
import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { authorizeUpgrade } from '../middleware/auth.js'

const router = Router()
const DATA_DIR = path.join(homedir(), 'master-control', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'code-deck.sqlite')

const BASE_PROJECT_ROOTS = [
  { id: 'work', label: 'OneDrive', path: path.join(homedir(), 'work'), folder: 'Work' },
  { id: 'master-control', label: 'Valkyrie', path: path.join(homedir(), 'master-control'), folder: 'Personal' },
  { id: 'openclaw-home', label: 'OpenClaw Home', path: homedir(), folder: 'OpenClaw' },
  { id: 'dnd-bot', label: 'Bot Workspace', path: path.join(homedir(), 'dm-bot-runtime', 'workspace'), folder: 'OpenClaw' },
  { id: 'msp-platform', label: 'MSP Platform', path: path.join(homedir(), 'msp-platform'), folder: 'Work' },
  { id: 'trading', label: 'Trading', path: path.join(homedir(), 'trading'), folder: 'Personal' },
]

type ProjectRoot = { id: string; label: string; path: string; folder: string }

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'folder'
}

// Synthetic "run at the group root" entries. Folder groups are just labels with
// no single folder on disk, so each is given an explicit root path. These are
// keyed by id (not path) so Personal/OpenClaw can both point at the home dir
// without the path-dedup below dropping one.
const GROUP_ROOTS: ProjectRoot[] = [
  { id: 'group:Personal', label: 'Personal (group root)', path: homedir(), folder: 'Personal' },
  { id: 'group:Work', label: 'Work (group root)', path: path.join(homedir(), 'work'), folder: 'Work' },
  { id: 'group:OpenClaw', label: 'OpenClaw (group root)', path: homedir(), folder: 'OpenClaw' },
]

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
  const deduped = roots.filter((r) => {
    if (seen.has(r.path)) return false
    seen.add(r.path)
    return true
  })
  return [...GROUP_ROOTS, ...deduped].sort((a, b) => a.folder.localeCompare(b.folder) || a.label.localeCompare(b.label))
}

// `usageClientId` correlates each profile with its aiUsage client (see
// aiUsage.ts CLAUDE_ACCOUNTS ids) so Code Deck can show the right quota bars.
// Existing profile ids are kept stable so stored sessions keep resolving.
export const PROFILES = [
  {
    id: 'main-claude',
    label: 'Account A',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: {},
    usageClientId: 'claude-acct-a',
  },
  {
    id: 'acct-b-claude',
    label: 'Account B',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-accounts/acct-b' },
    usageClientId: 'claude-acct-b',
  },
  {
    id: 'acct-c-claude',
    label: 'Account C',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-accounts/acct-c' },
    usageClientId: 'claude-acct-c',
  },
  {
    id: 'acct-d-claude',
    label: 'Account D',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-accounts/acct-d' },
    usageClientId: 'claude-acct-d',
  },
  {
    id: 'acct-e-claude',
    label: 'Account E',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-accounts/acct-e' },
    usageClientId: 'claude-acct-e',
  },
  {
    id: 'botacct-claude',
    label: 'Bot account',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    command: '/home/brendon/.local/bin/claude',
    env: { CLAUDE_CONFIG_DIR: '/home/brendon/.claude-botacct' },
    usageClientId: 'claude-botacct',
  },
  {
    id: 'main-codex',
    label: 'Codex',
    provider: 'codex',
    defaultModel: 'gpt-5.5',
    command: '/home/brendon/.npm/_npx/c8ab89660c602c20/node_modules/.bin/codex',
    env: {},
    usageClientId: 'codex-work',
  },
]

export type SessionRow = {
  id: string
  title: string
  folder: string
  projectRootId: string
  cwd: string
  profileId: string
  model: string
  effort: string
  pinned: number
  status: string
  notes: string
  createdAt: string
  updatedAt: string
  agentSessionId: string
}

export function db() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const d = new Database(DB_PATH)
  // WAL + a busy timeout so concurrent writers (heavy agent runs writing many
  // tool_use/tool_result rows) wait briefly instead of throwing SQLITE_BUSY,
  // which used to surface as a run dying mid-edit.
  d.pragma('journal_mode = WAL')
  d.pragma('busy_timeout = 5000')
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
    CREATE TABLE IF NOT EXISTS code_deck_prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_deck_messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(sessionId) REFERENCES code_deck_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_code_deck_messages_session_created ON code_deck_messages(sessionId, createdAt);
  `)
  // Migrations: additive columns guarded against re-runs (SQLite throws if the column exists).
  for (const stmt of [
    `ALTER TABLE code_deck_sessions ADD COLUMN agentSessionId TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE code_deck_messages ADD COLUMN meta TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE code_deck_sessions ADD COLUMN effort TEXT NOT NULL DEFAULT ''`,
  ]) {
    try { d.exec(stmt) } catch { /* column already exists */ }
  }
  return d
}

export function now() { return new Date().toISOString() }

// User-defined display ordering, persisted server-side so it survives reloads and
// syncs across devices. groupOrder = ordered folder-group names; projectOrder =
// { [groupName]: rootId[] }; pinnedOrder = ordered session ids. Unknown items
// fall back to alphabetical on the client.
type Prefs = { groupOrder: string[]; projectOrder: Record<string, string[]>; pinnedOrder: string[] }
const PREF_KEYS = ['groupOrder', 'projectOrder', 'pinnedOrder'] as const

function readPrefs(): Prefs {
  const out: Prefs = { groupOrder: [], projectOrder: {}, pinnedOrder: [] }
  const d = db()
  const rows = d.prepare('SELECT key,value FROM code_deck_prefs').all() as { key: string; value: string }[]
  d.close()
  for (const r of rows) {
    if (!(PREF_KEYS as readonly string[]).includes(r.key)) continue
    try { (out as Record<string, unknown>)[r.key] = JSON.parse(r.value) } catch { /* keep default */ }
  }
  return out
}

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
    : ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5']
}

function normalizeModel(profileId: string, requested: string) {
  const allowed = allowedModels(profileId)
  return allowed.includes(requested) ? requested : allowed[0]
}

// Reasoning effort levels supported by the Claude SDK / CLI. '' means "default"
// (let the model decide). Codex has no effort concept, so it's always cleared.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function normalizeEffort(profileId: string, requested: string) {
  const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0]
  if (profile.provider !== 'claude') return ''
  return EFFORT_LEVELS.includes(requested) ? requested : ''
}

function commandWithModel(row: SessionRow) {
  const profile = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
  if (profile.provider === 'claude') {
    const eff = EFFORT_LEVELS.includes(row.effort) ? ` --effort ${row.effort}` : ''
    return `${profile.command} --model ${row.model}${eff}`
  }
  return `${profile.command} --model ${row.model}`
}

function launchCommand(row: SessionRow) {
  const cd = `cd ${JSON.stringify(row.cwd)}`
  return `${cd} && ${commandWithModel(row)}`
}

function terminalCommand(row: SessionRow) {
  return commandWithModel(row)
}

export type MessageRow = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  meta: string
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\r/g, '')
}

export function saveMessage(sessionId: string, role: MessageRow['role'], content: string, meta: Record<string, unknown> | string = ''): MessageRow {
  const metaStr = typeof meta === 'string' ? meta : JSON.stringify(meta)
  const msg: MessageRow = { id: randomUUID(), sessionId, role, content, createdAt: now(), meta: metaStr }
  const d = db()
  d.prepare('INSERT INTO code_deck_messages (id,sessionId,role,content,createdAt,meta) VALUES (@id,@sessionId,@role,@content,@createdAt,@meta)').run(msg)
  const status = role === 'assistant' ? 'chat' : role === 'user' ? 'thinking' : 'note'
  d.prepare('UPDATE code_deck_sessions SET updatedAt=?, status=? WHERE id=?').run(now(), status, sessionId)
  d.close()
  return msg
}

export function setAgentSessionId(sessionId: string, agentSessionId: string) {
  const d = db()
  d.prepare('UPDATE code_deck_sessions SET agentSessionId=?, updatedAt=? WHERE id=?').run(agentSessionId, now(), sessionId)
  d.close()
}

export function setSessionStatus(sessionId: string, status: string) {
  const d = db()
  d.prepare('UPDATE code_deck_sessions SET status=?, updatedAt=? WHERE id=?').run(status, now(), sessionId)
  d.close()
}

export function profileFor(profileId: string) {
  return PROFILES.find((p) => p.id === profileId) ?? PROFILES[0]
}

function safeFilename(input: string) {
  const base = path.basename(input || 'attachment')
  return base.replace(/[^a-zA-Z0-9._ -]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'attachment'
}

function chatPrompt(row: SessionRow, messages: MessageRow[], userText: string) {
  const history = messages.slice(-12).map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n')
  return `You are Code Deck, a direct Claude/Codex coding assistant running inside Valkyrie.\n\nProject folder: ${row.cwd}\nSession: ${row.title}\n\nWork in this folder. Be concise. If you edit files, say exactly what changed. If you need a command run, run it yourself when your tool/CLI supports it. Do not mention OpenClaw.\n\nRecent session history:\n${history || '(none)'}\n\nUSER:\n${userText}`
}

function runAgent(row: SessionRow, prompt: string): Promise<string> {
  const profile = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
  const env = { ...process.env, ...profile.env, TERM: 'xterm-256color' }
  const isClaude = profile.provider === 'claude'
  const cmd = profile.command
  const args = isClaude
    ? ['-p', prompt, '--model', row.model, ...(EFFORT_LEVELS.includes(row.effort) ? ['--effort', row.effort] : []), '--output-format', 'text', '--permission-mode', 'bypassPermissions']
    : ['exec', '-m', row.model, '-C', row.cwd, '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: row.cwd, env })
    child.stdin?.end()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('agent timed out after 10 minutes'))
    }, 10 * 60 * 1000)
    child.stdout.on('data', (b) => { stdout += String(b) })
    child.stderr.on('data', (b) => { stderr += String(b) })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim() || '(no output)')
      else reject(new Error((stderr || stdout || `agent exited ${code}`).trim()))
    })
  })
}

export function getSession(id: string): SessionRow | undefined {
  const d = db()
  const row = d.prepare('SELECT * FROM code_deck_sessions WHERE id=?').get(id) as SessionRow | undefined
  d.close()
  return row
}

function serialize(row: SessionRow, lastAssistantAt: string | null = null) {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    launchCommand: launchCommand(row),
    // Timestamp of the most recent assistant message — drives the client-side
    // "unread AI response" indicator. null when the session has no reply yet.
    lastAssistantAt,
  }
}

router.get('/code-deck', (_req, res) => {
  try {
    const d = db()
    const rows = d.prepare('SELECT * FROM code_deck_sessions ORDER BY pinned DESC, updatedAt DESC').all() as SessionRow[]
    const lastAssistant = d.prepare(
      `SELECT sessionId, MAX(createdAt) AS at FROM code_deck_messages WHERE role='assistant' GROUP BY sessionId`,
    ).all() as { sessionId: string; at: string }[]
    d.close()
    const lastAssistantBy = new Map(lastAssistant.map((r) => [r.sessionId, r.at]))
    res.json({
      sessions: rows.map((r) => serialize(r, lastAssistantBy.get(r.id) ?? null)),
      folders: Array.from(new Set([...discoverProjectRoots().map((p) => p.folder), ...rows.map((r) => r.folder)])).sort(),
      projectRoots: discoverProjectRoots().map((p) => ({ ...p, exists: fs.existsSync(p.path) })),
      profiles: PROFILES,
      prefs: readPrefs(),
    })
  } catch (err) {
    console.error('[500] failed to read code deck:', err)
    res.status(500).json({ error: 'failed to read code deck', detail: (err as Error).message })
  }
})

router.put('/code-deck/prefs', (req, res) => {
  try {
    const body = req.body ?? {}
    const d = db()
    const upsert = d.prepare('INSERT INTO code_deck_prefs (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    for (const key of PREF_KEYS) {
      if (body[key] == null) continue
      const value = JSON.stringify(body[key]).slice(0, 100000)
      upsert.run(key, value)
    }
    d.close()
    res.json({ prefs: readPrefs() })
  } catch (err) {
    console.error('[500] failed to save prefs:', err)
    res.status(500).json({ error: 'failed to save prefs', detail: (err as Error).message })
  }
})

router.post('/code-deck/sessions', (req, res) => {
  try {
    const body = req.body ?? {}
    const projectRoots = discoverProjectRoots()
    const matched = projectRoots.find((p) => p.id === body.projectRootId)
    // A free-form path with no matching predefined root → a "Custom" session.
    const isCustom = !matched && Boolean(String(body.cwd || '').trim())
    const root = matched ?? projectRoots[0]
    const profile = PROFILES.find((p) => p.id === body.profileId) ?? PROFILES[0]
    const cwd = safePath(String(body.cwd || root.path))
    if (!cwd) return res.status(400).json({ error: 'invalid cwd' })
    const t = now()
    const row: SessionRow = {
      id: randomUUID(),
      title: String(body.title || 'New Code Session').slice(0, 120),
      folder: String((isCustom ? (body.folder || 'Custom') : root.folder) || 'Inbox').slice(0, 80),
      projectRootId: isCustom ? 'custom' : root.id,
      cwd,
      profileId: profile.id,
      model: normalizeModel(profile.id, String(body.model || profile.defaultModel)).slice(0, 80),
      effort: normalizeEffort(profile.id, String(body.effort || '')),
      pinned: body.pinned ? 1 : 0,
      status: 'planned',
      notes: String(body.notes || '').slice(0, 4000),
      createdAt: t,
      updatedAt: t,
      agentSessionId: '',
    }
    const d = db()
    d.prepare(`INSERT INTO code_deck_sessions (id,title,folder,projectRootId,cwd,profileId,model,effort,pinned,status,notes,createdAt,updatedAt,agentSessionId)
      VALUES (@id,@title,@folder,@projectRootId,@cwd,@profileId,@model,@effort,@pinned,@status,@notes,@createdAt,@updatedAt,@agentSessionId)`).run(row)
    d.close()
    res.json({ session: serialize(row) })
  } catch (err) {
    console.error('[500] failed to create session:', err)
    res.status(500).json({ error: 'failed to create session', detail: (err as Error).message })
  }
})

router.patch('/code-deck/sessions/:id', (req, res) => {
  try {
    const d = db()
    const row = d.prepare('SELECT * FROM code_deck_sessions WHERE id=?').get(req.params.id) as SessionRow | undefined
    if (!row) { d.close(); return res.status(404).json({ error: 'not found' }) }
    const body = req.body ?? {}
    // Provider is immutable for a session: Claude and codex are different engines
    // with incompatible session formats and cannot share a live conversation, so
    // crossing the provider boundary mid-session is rejected. Account/model
    // switches within the same provider are allowed. (The UI hides cross-provider
    // options; this is the server-side backstop.)
    if (body.profileId != null) {
      const requested = PROFILES.find((p) => p.id === String(body.profileId))
      const current = PROFILES.find((p) => p.id === row.profileId) ?? PROFILES[0]
      if (requested && requested.provider !== current.provider) {
        d.close()
        return res.status(400).json({
          error: 'cannot switch provider mid-session',
          detail: `This is a ${current.provider} session. Create a new session to use ${requested.provider}.`,
        })
      }
    }
    // Only accept a profileId that maps to a known profile; otherwise keep the current one.
    const nextProfileId = body.profileId != null && PROFILES.some((p) => p.id === String(body.profileId))
      ? String(body.profileId)
      : row.profileId
    // The Claude CLI stores conversation/session files per-account, under each
    // account's CLAUDE_CONFIG_DIR. A resume id created under one account does not
    // exist under another, so resuming across an account switch dies with
    // "No conversation found with session ID …" (surfaced as a result
    // subtype=error_during_execution). Invalidate the stored resume id whenever the
    // account changes so the next run starts a fresh CLI session on the new account.
    // The visible chat history lives in code_deck_messages and is unaffected — only
    // the live agent's in-CLI context is reset, which is unavoidable across accounts.
    // A pure model switch keeps the same account, so the resume id is preserved.
    const accountChanged = nextProfileId !== row.profileId
    const next: SessionRow = {
      ...row,
      title: body.title != null ? String(body.title).slice(0, 120) : row.title,
      folder: body.folder != null ? String(body.folder).slice(0, 80) : row.folder,
      projectRootId: body.projectRootId != null ? String(body.projectRootId) : row.projectRootId,
      cwd: body.cwd != null ? (safePath(String(body.cwd)) ?? row.cwd) : row.cwd,
      profileId: nextProfileId,
      model: normalizeModel(nextProfileId, body.model != null ? String(body.model) : row.model).slice(0, 80),
      effort: normalizeEffort(nextProfileId, body.effort != null ? String(body.effort) : row.effort),
      pinned: body.pinned != null ? (body.pinned ? 1 : 0) : row.pinned,
      status: body.status != null ? String(body.status).slice(0, 40) : row.status,
      notes: body.notes != null ? String(body.notes).slice(0, 4000) : row.notes,
      agentSessionId: accountChanged ? '' : row.agentSessionId,
      updatedAt: now(),
    }
    d.prepare(`UPDATE code_deck_sessions SET title=@title, folder=@folder, projectRootId=@projectRootId, cwd=@cwd, profileId=@profileId, model=@model, effort=@effort, pinned=@pinned, status=@status, notes=@notes, agentSessionId=@agentSessionId, updatedAt=@updatedAt WHERE id=@id`).run(next)
    d.close()
    res.json({ session: serialize(next) })
  } catch (err) {
    console.error('[500] failed to update session:', err)
    res.status(500).json({ error: 'failed to update session', detail: (err as Error).message })
  }
})

router.get('/code-deck/sessions/:id/messages', (req, res) => {
  try {
    const row = getSession(req.params.id)
    if (!row) return res.status(404).json({ error: 'not found' })
    const d = db()
    const messages = d.prepare('SELECT * FROM code_deck_messages WHERE sessionId=? ORDER BY createdAt ASC').all(req.params.id) as MessageRow[]
    d.close()
    res.json({ messages })
  } catch (err) {
    console.error('[500] failed to read messages:', err)
    res.status(500).json({ error: 'failed to read messages', detail: (err as Error).message })
  }
})

router.post('/code-deck/sessions/:id/attachments', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  try {
    const row = getSession(req.params.id)
    if (!row) return res.status(404).json({ error: 'not found' })
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([])
    if (body.length === 0) return res.status(400).json({ error: 'missing file body' })
    const encodedName = String(req.header('x-filename') || 'attachment')
    const originalName = safeFilename(decodeURIComponent(encodedName))
    const contentType = String(req.header('x-file-type') || req.header('content-type') || 'application/octet-stream').slice(0, 120)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(row.cwd, '.code-deck', 'attachments', row.id)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${stamp}-${originalName}`)
    fs.writeFileSync(filePath, body)
    const msg = saveMessage(row.id, 'system', `Attachment uploaded: ${originalName}\nPath: ${filePath}\nType: ${contentType}\nSize: ${body.length} bytes\n\nReference this path in your next message when you want Code Deck to inspect it.`)
    res.json({ attachment: { name: originalName, path: filePath, contentType, size: body.length }, message: msg })
  } catch (err) {
    console.error('[500] attachment upload failed:', err)
    res.status(500).json({ error: 'attachment upload failed', detail: (err as Error).message })
  }
})

router.post('/code-deck/sessions/:id/chat', (req, res) => {
  try {
    const row = getSession(req.params.id)
    if (!row) return res.status(404).json({ error: 'not found' })
    const content = String(req.body?.content ?? '').trim()
    if (!content) return res.status(400).json({ error: 'missing content' })
    const d = db()
    const previous = d.prepare('SELECT * FROM code_deck_messages WHERE sessionId=? ORDER BY createdAt ASC').all(req.params.id) as MessageRow[]
    d.close()
    const user = saveMessage(row.id, 'user', content)
    res.json({ user, pending: true })
    void runAgent(row, chatPrompt(row, previous, content))
      .then((output) => { saveMessage(row.id, 'assistant', output) })
      .catch((err) => {
        const detail = (err as Error).message
        try { saveMessage(row.id, 'system', `Agent error: ${detail}`) } catch { /* noop */ }
      })
  } catch (err) {
    const detail = (err as Error).message
    console.error('[500] chat failed:', err)
    try { saveMessage(req.params.id, 'system', `Agent error: ${detail}`) } catch { /* noop */ }
    res.status(500).json({ error: 'chat failed', detail })
  }
})

router.delete('/code-deck/sessions/:id', (req, res) => {
  try {
    const d = db()
    d.prepare('DELETE FROM code_deck_sessions WHERE id=?').run(req.params.id)
    d.close()
    res.json({ ok: true })
  } catch (err) {
    console.error('[500] failed to delete session:', err)
    res.status(500).json({ error: 'failed to delete session', detail: (err as Error).message })
  }
})

export function attachCodeDeckWs(server: Server) {
  // noServer + a path-scoped upgrade listener so this WSS composes with the
  // agent WSS on the same HTTP server. (A `{ server, path }` WSS aborts the
  // handshake with 400 on any non-matching path, which would kill the other.)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost')
    if (pathname !== '/api/code-deck/ws') return
    void authorizeUpgrade(req).then((ok) => {
      if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    }).catch(() => { socket.destroy() })
  })
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
    let transcript = `TERMINAL START: ${command}\nCWD: ${row.cwd}\n\n`
    let savedTranscript = false
    const persistTranscript = (footer: string) => {
      if (savedTranscript) return
      savedTranscript = true
      const clean = stripAnsi(`${transcript}\n${footer}`).trim()
      if (clean.length > 0) saveMessage(row.id, 'system', clean.slice(-50000))
    }
    shell.onData((data) => {
      transcript = (transcript + data).slice(-50000)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }))
    })
    shell.onExit(({ exitCode, signal }) => {
      const d2 = db()
      d2.prepare('UPDATE code_deck_sessions SET status=?, updatedAt=? WHERE id=?').run(exitCode === 0 ? 'exited' : 'failed', now(), row.id)
      d2.close()
      persistTranscript(`TERMINAL END: code=${exitCode} signal=${signal ?? ''}`)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', data: `process exited code=${exitCode} signal=${signal ?? ''}` }))
      if (ws.readyState === ws.OPEN) ws.close()
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; data?: string; cols?: number; rows?: number }
        if (msg.type === 'input') {
          transcript = (transcript + String(msg.data ?? '')).slice(-50000)
          shell.write(String(msg.data ?? ''))
        }
        if (msg.type === 'resize') shell.resize(Number(msg.cols ?? 120), Number(msg.rows ?? 36))
      } catch {
        shell.write(String(raw))
      }
    })
    ws.on('close', () => {
      persistTranscript('TERMINAL CLOSED')
      try { shell.kill() } catch { /* noop */ }
    })
  })
}

export default router
