import { Router } from 'express'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import ptyModule from 'node-pty'
import { promises as fs, createReadStream, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'
import { requireStrongAuth, authorizeStrongUpgrade } from '../middleware/auth.js'
import {
  MAX_SESSIONS, MODES, SESSION_NAME_RE, TMUX_BIN,
  attachArgs, claudeBin, createSession, ensureServer, hasSession, isAllowedCwd,
  killSession, listSessions, serverUp, targetFor, targets, tmuxVersion,
  type TermMode,
} from '../terminal/tmux.js'

// The phone terminal. REST here is only bookkeeping — list, open, close; the
// session itself is tmux (see terminal/tmux.ts) and the bytes ride a websocket.
//
// Every route in here is behind requireStrongAuth, NOT the app-wide requireAuth.
// requireAuth still honours the legacy no-token bypass for a request that looks
// like it came from the published frontend, which is fine for reading a chart
// and absolutely not fine for a shell. This asks for a real credential: the
// tailnet, loopback, an app token, or a Cloudflare Access JWT.

const router = Router()

router.use('/terminal', requireStrongAuth)

// ------------------------------------------------------------- transcripts ----
// The resume picker. `claude --resume <id>` needs an id, and an id on its own is
// unpickable on a phone, so each row carries the directory it ran in and the
// opening line of the conversation.

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')
const RECENT_LIMIT = 24
const RECENT_TTL_MS = 30_000
// Enough of the tail to hold a line with a cwd, and of the head to hold the
// first real message. Transcripts run to megabytes; neither end is worth
// reading whole on a route that gets polled.
const TAIL_BYTES = 32_768
const HEAD_BYTES = 65_536
// Below this a transcript is a hook run or an abandoned open, not a session
// worth offering to resume.
const MIN_BYTES = 4_096

export type RecentSession = {
  sessionId: string
  cwd: string
  project: string
  title: string
  lastActivity: number
  bytes: number
}

let recentCache: { at: number; data: RecentSession[] } | null = null

async function readTailCwd(file: string, size: number): Promise<string | null> {
  const start = Math.max(0, size - TAIL_BYTES)
  let cwd: string | null = null
  try {
    const rl = createInterface({
      input: createReadStream(file, { start, encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue
      try {
        const o = JSON.parse(line) as { cwd?: string }
        if (o.cwd) cwd = o.cwd
      } catch { /* a partial first line, or a malformed record */ }
    }
  } catch { /* unreadable */ }
  return cwd
}

async function readFirstPrompt(file: string): Promise<string> {
  try {
    const rl = createInterface({
      input: createReadStream(file, { start: 0, end: HEAD_BYTES, encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line.startsWith('{')) continue
      let o: { type?: string; message?: { role?: string; content?: unknown } }
      try { o = JSON.parse(line) } catch { continue }
      if (o.type !== 'user' || o.message?.role !== 'user') continue
      const c = o.message.content
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? (c.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? ''
          : ''
      const clean = text.replace(/\s+/g, ' ').trim()
      if (!clean) continue
      // A prompt that opens with a brace or runs to thousands of characters is
      // a machine talking to itself (hooks, summarisers). Those flooded the
      // equivalent list on thor — 92% of rows — and none of them is a session
      // anyone wants to reopen.
      if (clean.startsWith('{') || clean.length > 2_000) return ''
      return clean.slice(0, 90)
    }
  } catch { /* unreadable */ }
  return ''
}

async function readRecent(): Promise<RecentSession[]> {
  if (recentCache && Date.now() - recentCache.at < RECENT_TTL_MS) return recentCache.data

  let dirs: string[] = []
  try { dirs = await fs.readdir(PROJECTS_DIR) } catch { return [] }

  const files: { file: string; mtime: number; size: number }[] = []
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d)
    let entries: string[] = []
    try { entries = await fs.readdir(dir) } catch { continue }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue
      try {
        const st = statSync(path.join(dir, e))
        if (st.size < MIN_BYTES) continue
        files.push({ file: path.join(dir, e), mtime: st.mtimeMs, size: st.size })
      } catch { /* vanished between readdir and stat */ }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime)
  const out: RecentSession[] = []
  for (const f of files.slice(0, RECENT_LIMIT)) {
    const cwd = await readTailCwd(f.file, f.size)
    if (!cwd || !isAllowedCwd(cwd)) continue
    const title = await readFirstPrompt(f.file)
    if (!title) continue
    out.push({
      sessionId: path.basename(f.file, '.jsonl'),
      cwd,
      project: cwd === homedir() ? 'home' : path.basename(cwd),
      title,
      lastActivity: f.mtime,
      bytes: f.size,
    })
  }

  recentCache = { at: Date.now(), data: out }
  return out
}

async function cwdForResume(sessionId: string): Promise<string | null> {
  const recent = await readRecent()
  const hit = recent.find((r) => r.sessionId === sessionId)
  if (hit) return hit.cwd
  // Not in the recent window: go find the transcript directly rather than
  // refusing to reopen something a week old.
  let dirs: string[] = []
  try { dirs = await fs.readdir(PROJECTS_DIR) } catch { return null }
  for (const d of dirs) {
    const file = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
    let size: number
    try { size = statSync(file).size } catch { continue }
    const cwd = await readTailCwd(file, size)
    if (cwd && isAllowedCwd(cwd)) return cwd
  }
  return null
}

// ------------------------------------------------------------------ routes ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

router.get('/terminal/status', async (_req, res) => {
  const [version] = await Promise.all([tmuxVersion()])
  const claude = claudeBin()
  res.json({
    ok: Boolean(version) && Boolean(claude),
    tmux: version || null,
    claude,
    serverUp: serverUp(),
    maxSessions: MAX_SESSIONS,
  })
})

router.get('/terminal/targets', (_req, res) => res.json(targets()))

router.get('/terminal/recent', async (_req, res) => {
  try {
    res.json(await readRecent())
  } catch (err) {
    console.error('[terminal] recent failed', err)
    res.status(500).json({ error: 'could not read transcripts' })
  }
})

router.get('/terminal/sessions', async (_req, res) => {
  try {
    res.json(await listSessions())
  } catch (err) {
    console.error('[terminal] list failed', err)
    res.status(500).json({ error: 'could not list sessions' })
  }
})

router.post('/terminal/sessions', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const mode = String(body.mode ?? 'new') as TermMode
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` })

  let cwd: string
  let label: string
  let resumeId: string | undefined

  if (mode === 'resume') {
    resumeId = String(body.sessionId ?? '')
    if (!UUID_RE.test(resumeId)) return res.status(400).json({ error: 'sessionId must be a uuid' })
    const found = await cwdForResume(resumeId)
    if (!found) return res.status(404).json({ error: 'no transcript for that session on this host' })
    cwd = found
    label = cwd === homedir() ? 'home' : path.basename(cwd)
  } else {
    const target = targetFor(String(body.target ?? ''))
    if (!target) return res.status(400).json({ error: 'target must be one of the launch targets' })
    cwd = target.path
    label = target.label
  }

  try {
    const name = await createSession({
      mode, cwd, label, resumeId,
      cols: Number(body.cols), rows: Number(body.rows),
    })
    const session = (await listSessions()).find((s) => s.name === name) ?? null
    res.status(201).json({ name, session })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status >= 500) console.error('[terminal] create failed', err)
    res.status(status).json({ error: (err as Error).message })
  }
})

router.post('/terminal/sessions/:name/kill', async (req, res) => {
  const name = String(req.params.name)
  if (!SESSION_NAME_RE.test(name)) return res.status(400).json({ error: 'not a session name' })
  const killed = await killSession(name)
  res.status(killed ? 200 : 404).json({ killed })
})

export default router

// -------------------------------------------------------------- websocket ----

const WS_PATH = '/ws/terminal'
// Cloudflare drops an idle websocket at 100s, and a session left sitting on a
// prompt sends nothing at all, so the keepalive has to come from us.
const PING_MS = 25_000
const MAX_PAYLOAD = 1 << 20

// Called for every http server the app listens on. Both of them matter: the
// loopback one behind cloudflared, and the tailnet one the phone actually uses
// when it is on the tailnet.
export function attachTerminalWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  server.on('upgrade', (req, socket, head) => {
    void onUpgrade(wss, req, socket as Duplex, head)
  })
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

async function onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  let url: URL
  try {
    url = new URL(req.url ?? '', 'http://localhost')
  } catch {
    return refuse(socket, 400, 'Bad Request')
  }
  // Nothing else on this server upgrades, so an unknown path is a caller
  // mistake worth answering rather than a socket left hanging for a handler
  // that does not exist.
  if (url.pathname !== WS_PATH) return refuse(socket, 404, 'Not Found')

  if (!(await authorizeStrongUpgrade(req))) return refuse(socket, 401, 'Unauthorized')

  const name = url.searchParams.get('s') ?? ''
  if (!SESSION_NAME_RE.test(name)) return refuse(socket, 400, 'Bad Request')

  await ensureServer()
  if (!(await hasSession(name))) return refuse(socket, 404, 'Not Found')

  const cols = clampInt(url.searchParams.get('cols'), 20, 400, 80)
  const rows = clampInt(url.searchParams.get('rows'), 8, 200, 24)

  wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, name, cols, rows))
}

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

type ClientMsg =
  | { t: 'i'; d: string }
  | { t: 'r'; cols: number; rows: number }

function bridge(ws: WebSocket, name: string, cols: number, rows: number): void {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  // The pty's TERM is what tmux negotiates against; what runs INSIDE the pane
  // gets tmux's own default-terminal (see the conf), not this.
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  let pty: ReturnType<typeof ptyModule.spawn>
  try {
    pty = ptyModule.spawn(TMUX_BIN, attachArgs(name), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env,
    })
  } catch (err) {
    console.error('[terminal] attach failed', err)
    try { ws.send(JSON.stringify({ t: 'err', d: 'could not attach' })) } catch { /* already gone */ }
    ws.close(1011, 'attach failed')
    return
  }

  // Output goes out as binary and control messages as text, so the client can
  // tell them apart by frame type instead of sniffing a prefix out of the
  // terminal stream (where any byte is legal payload).
  pty.onData((d) => {
    if (ws.readyState !== ws.OPEN) return
    ws.send(Buffer.from(d, 'utf8'), { binary: true })
  })

  pty.onExit(({ exitCode }) => {
    try { ws.send(JSON.stringify({ t: 'detached', code: exitCode })) } catch { /* already gone */ }
    ws.close(1000, 'detached')
  })

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: ClientMsg
    try { msg = JSON.parse(String(raw)) as ClientMsg } catch { return }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      pty.write(msg.d)
      return
    }
    if (msg.t === 'r') {
      const c = clampInt(String(msg.cols), 20, 400, cols)
      const r = clampInt(String(msg.rows), 8, 200, rows)
      try { pty.resize(c, r) } catch { /* pty already gone */ }
    }
  })

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
  }, PING_MS)

  ws.on('close', () => {
    clearInterval(ping)
    // Kills the attach client only. tmux treats a lost client as a detach, so
    // the session and everything running in it carry on.
    try { pty.kill() } catch { /* already exited */ }
  })

  ws.on('error', (err) => console.warn('[terminal] ws error', (err as Error).message))
}
