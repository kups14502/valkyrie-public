import { Router, type Request } from 'express'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import ptyModule from 'node-pty'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { requireStrongAuth, authorizeStrongUpgrade, viaCloudflare } from '../middleware/auth.js'
import { isAllowedHost, isAllowedOrigin } from '../middleware/origin.js'
import {
  MAX_SESSIONS, MODES, SESSION_NAME_RE, TARGET_RE, TMUX_BIN, UUID_RE,
  attachArgs, createSession, endScroll, ensureServer, hasSession, killSession, listSessions,
  remoteLabel, scrollPane, serverUp, sshPresent, tmuxVersion,
  type TermMode, type TermSession,
} from '../terminal/tmux.js'
import { attachRun, createRun, failRun, failRunsForTmux, getProject, linkSession, projectsForSession } from '../lib/projectsStore.js'
import { KEY_RE, ProjError, type Ctx, type Project, type Run } from '../lib/projectTypes.js'
import { DESK_PROMPT_MAX, createDeskBrief, noteDeskPane } from '../lib/projectDesk.js'

// The phone terminal. REST here is only bookkeeping — list, open, close; the
// session itself is tmux (see terminal/tmux.ts) holding an SSH client into
// thor, and the bytes ride a websocket.
//
// What to open comes from elsewhere: the launch targets from thor's launcher
// agent (GET /hosts/thor/launch-targets, filtered to the ones flagged for the
// phone) and the conversations to resume from the session board
// (GET /hosts/thor/sessions). This file never reads a transcript.
//
// Every route in here is behind requireStrongAuth, NOT the app-wide requireAuth,
// so the media-scoped query token that opens a poster can never open a shell.
// It asks for a real credential: the tailnet, loopback, an app token, or a
// Cloudflare Access JWT.

const router = Router()

router.use('/terminal', requireStrongAuth)

// The label is cosmetic (the chip in the session strip) but it is also the one
// free-text field a client can hand this box, so it is cut to something a
// terminal can print and a tmux option can hold.
function cleanLabel(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v : ''
  // eslint-disable-next-line no-control-regex
  const printable = s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  return (printable || fallback).slice(0, 60)
}

router.get('/terminal/status', async (_req, res) => {
  const version = await tmuxVersion()
  const ssh = sshPresent()
  res.json({
    ok: Boolean(version) && ssh,
    tmux: version || null,
    ssh,
    remote: remoteLabel(),
    serverUp: serverUp(),
    maxSessions: MAX_SESSIONS,
  })
})

// A tailnet-only project answers a Cloudflare request as if it did not exist,
// and a pane opened for one carries the project's name as its label. Through
// Cloudflare that pane keeps its row, since it is still a terminal Brendon can
// attach to, but loses the name and the project id.
const hiddenFrom = (req: Request) => {
  const cf = viaCloudflare(req)
  const seen = new Map<string, boolean>()
  return (projectId: string): boolean => {
    if (!cf || !projectId) return false
    if (!seen.has(projectId)) {
      const p = getProject(projectId)
      seen.set(projectId, !p || p.exposure === 'tailnet')
    }
    return seen.get(projectId) as boolean
  }
}

const maskRow = (hidden: (projectId: string) => boolean) => (s: TermSession): TermSession =>
  (hidden(s.projectId) ? { ...s, projectId: '', label: s.target || s.name } : s)

router.get('/terminal/sessions', async (req, res) => {
  const project = req.query.project
  if (project !== undefined && (typeof project !== 'string' || !TARGET_RE.test(project))) {
    return res.status(400).json({ error: 'project must be a project id' })
  }
  const hidden = hiddenFrom(req)
  if (project !== undefined && hidden(project)) return res.json([])
  try {
    const rows = (await listSessions()).map(maskRow(hidden))
    res.json(project === undefined ? rows : rows.filter((s) => s.projectId === project))
  } catch (err) {
    console.error('[terminal] list failed', err)
    res.status(500).json({ error: 'could not list sessions' })
  }
})

// Where a new-project session starts, before it knows its project's folder.
// It can read any folder from there; the project's own sessions run in its folder.
const DESK_TARGET = process.env.PROJECT_DESK_TARGET || 'personal'

router.post('/terminal/sessions', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const mode = String(body.mode ?? 'new') as TermMode
  if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` })

  // Both are keys, never paths. The project id rides the ssh line to thor; the
  // agent key does not, only the run id minted from it.
  const projectKey = body.project == null ? undefined : String(body.project)
  if (projectKey !== undefined && !TARGET_RE.test(projectKey)) return res.status(400).json({ error: 'project must be a project id' })
  const automation = body.automation == null ? undefined : String(body.automation)
  if (automation !== undefined && (!KEY_RE.test(automation) || !projectKey || mode !== 'new')) {
    return res.status(400).json({ error: 'an agent or workflow run needs a project and mode new' })
  }
  // The rev of the brief the run sheet showed. The run starts from that
  // version or not at all: a session can rewrite the body between Brendon's
  // read and this request, and the run is elevated with no prompts.
  const automationRev = body.automationRev
  if (automation !== undefined && (typeof automationRev !== 'number' || !Number.isInteger(automationRev) || automationRev < 0)) {
    return res.status(400).json({ error: 'an agent or workflow run needs the rev that was shown' })
  }
  // A desk session sets up a project that does not exist yet (lib/projectDesk.ts).
  const desk = body.desk === true
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (desk && (mode !== 'new' || projectKey !== undefined || automation !== undefined)) {
    return res.status(400).json({ error: 'a new-project session is mode new, with no project or agent' })
  }
  if (prompt.length > DESK_PROMPT_MAX) return res.status(400).json({ error: `the description is longer than ${DESK_PROMPT_MAX} characters` })
  const hidden = hiddenFrom(req)
  let project: Project | null = null
  if (projectKey !== undefined) {
    project = getProject(projectKey)
    if (!project || project.status === 'archived' || hidden(project.id)) return res.status(404).json({ error: 'no such project' })
  }

  let target: string | undefined
  let resumeId: string | undefined
  let newId: string | undefined
  let fallback: string

  if (mode === 'resume') {
    resumeId = String(body.sessionId ?? '')
    if (!UUID_RE.test(resumeId)) return res.status(400).json({ error: 'sessionId must be a uuid' })
    fallback = resumeId.slice(0, 8)
    // A project conversation reopened from anywhere but its project page (the
    // Sessions page, the phone's dead-pane reopen, a resume picker, an older
    // app) would otherwise come back with no MCP channel and nothing on screen
    // to say so. Only an unambiguous link counts: a conversation linked to two
    // projects is left alone.
    if (!project) {
      const ids = projectsForSession(resumeId)
      const p = ids.length === 1 ? getProject(ids[0]) : null
      if (p && p.status !== 'archived' && !hidden(p.id)) project = p
    }
  } else {
    // A project session always runs in the project's own folder, whatever the
    // client sent: the pinned relPaths and the session's work are relative to it.
    target = project ? project.targetKey : desk ? DESK_TARGET : String(body.target ?? '')
    if (!TARGET_RE.test(target)) return res.status(400).json({ error: 'target must be a launch-target key' })
    fallback = target
    // The conversation id is minted HERE and handed to claude, rather than read
    // back afterwards. A chip opened on a target could otherwise never name the
    // conversation running in it: the label froze at 'personal' for the life of
    // the terminal, and only closing and reopening it as a resume picked up the
    // real title. Never taken from the request: a client choosing session ids
    // could collide with a conversation that already exists.
    if (mode === 'new') newId = randomUUID()
  }

  const ctx: Ctx = { actor: 'ui', via: 'terminal' }
  try {
    const run: Run | null = project && automation ? createRun(project.id, automation, automationRev as number, ctx) : null
    const deskRun = desk ? createDeskBrief(prompt) : null
    const label = cleanLabel(body.label, run && project ? `${project.name}: ${run.name}` : project ? project.name : desk ? 'new project' : fallback)
    let name: string
    try {
      name = await createSession({
        mode, target, resumeId, newId, label,
        cols: Number(body.cols), rows: Number(body.rows),
        projectId: project?.id, runId: run?.id ?? deskRun ?? undefined, desk,
      })
    } catch (err) {
      if (run) failRun(run.id, 'could not start: ' + (err as Error).message)
      throw err
    }
    if (project && mode !== 'shell') {
      // Linked here, at creation, rather than left to thor's SessionStart hook:
      // the page shows the session the moment it opens, and a hook that never
      // fires (an old thor, a launch that dies early) cannot orphan it. The
      // pane is already running, so a failure here is logged, not returned.
      const sid = (newId ?? resumeId) as string
      try {
        linkSession(project.id, {
          sessionId: sid, launchSessionId: sid, tmuxName: name, mode,
          runId: run?.id ?? null, via: mode === 'resume' ? 'resume' : 'launch',
        }, ctx)
        if (run) attachRun(run.id, sid, name)
      } catch (err) {
        console.error('[terminal] project link failed', (err as Error).message)
      }
    }
    if (desk && newId) noteDeskPane(newId, name)
    const row = (await listSessions()).find((s) => s.name === name)
    const session = row ? maskRow(hidden)(row) : null
    res.status(201).json({ name, session, conversationId: newId ?? resumeId ?? null, runId: run?.id ?? null })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    if (status >= 500) console.error('[terminal] create failed', err)
    // A run whose brief changed since the sheet opened answers 409 with the
    // current rev, which the sheet uses to show the new text.
    res.status(status).json({ error: (err as Error).message, ...(err instanceof ProjError ? err.body : undefined) })
  }
})

router.post('/terminal/sessions/:name/kill', async (req, res) => {
  const name = String(req.params.name)
  if (!SESSION_NAME_RE.test(name)) return res.status(400).json({ error: 'not a session name' })
  const killed = await killSession(name)
  // A run stopped from here never gets to call run_report, and would sit at
  // 'running' on the page forever.
  if (killed) {
    try {
      failRunsForTmux(name, 'stopped before it reported')
    } catch (err) {
      console.error('[terminal] could not close runs for', name, (err as Error).message)
    }
  }
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

  // The CORS layer never sees an upgrade, and a browser lets any page open a
  // websocket to any host. Native clients send no Origin and are unaffected.
  const origin = req.headers.origin
  if (!isAllowedHost(req) || (origin && !isAllowedOrigin(origin, req))) return refuse(socket, 403, 'Forbidden')

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
  // Swipe-to-scroll. The client sends a line delta, never a key: what moves
  // the view is a tmux copy-mode command, see scrollPane.
  | { t: 's'; lines: number }
  | { t: 'se' }
  // "are you still there". A phone that comes back from the background cannot
  // tell a working socket from one the network dropped while it slept: the
  // readyState is OPEN either way, and a half-open socket looks exactly like a
  // session with nothing to say. This is the client asking for proof, and the
  // 'hb' below is the proof.
  | { t: 'p' }

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

  // A websocket ping is invisible to a browser: the reply is handled by the
  // socket itself and no JavaScript ever sees it, so a page cannot use one to
  // decide whether its connection still works. This says the same thing in a
  // frame the page can read.
  const beat = () => {
    if (ws.readyState !== ws.OPEN) return
    try { ws.send(JSON.stringify({ t: 'hb' })) } catch { /* already gone */ }
  }

  // Copy-mode belongs to the PANE, not to this socket, so it outlives the
  // client that entered it. A phone that swiped, then dropped its connection,
  // came back to a pane still in copy-mode: frozen on old output, with every
  // keystroke read as a copy-mode command. Reloading the page did not help,
  // because the mode was never on this side. Every attach therefore starts live.
  void endScroll(name)

  // Scrolling puts the pane in copy-mode, where keys are copy-mode commands
  // rather than input, so a keystroke has to leave it first. That exit is an
  // async tmux call, so everything the client sends is serialized through one
  // chain: a keystroke must never overtake the cancel that makes it mean what
  // the user typed. One microtask per keystroke, at phone typing speed.
  let inCopy = false
  let chain: Promise<unknown> = Promise.resolve()
  const run = (fn: () => unknown) => { chain = chain.then(fn).catch(() => {}) }
  const leaveCopy = () => {
    if (!inCopy) return
    inCopy = false
    run(() => endScroll(name))
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: ClientMsg
    try { msg = JSON.parse(String(raw)) as ClientMsg } catch { return }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      leaveCopy()
      const d = msg.d
      run(() => { pty.write(d) })
      return
    }
    if (msg.t === 's') {
      const lines = Number(msg.lines)
      if (!Number.isFinite(lines) || lines === 0) return
      inCopy = true
      run(() => scrollPane(name, lines))
      return
    }
    if (msg.t === 'se') {
      leaveCopy()
      return
    }
    if (msg.t === 'p') {
      beat()
      return
    }
    if (msg.t === 'r') {
      const c = clampInt(String(msg.cols), 20, 400, cols)
      const r = clampInt(String(msg.rows), 8, 200, rows)
      try { pty.resize(c, r) } catch { /* pty already gone */ }
    }
  })

  const ping = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return
    ws.ping()
    beat()
  }, PING_MS)

  ws.on('close', () => {
    clearInterval(ping)
    // Kills the attach client only. tmux treats a lost client as a detach, so
    // the session and everything running in it carry on.
    try { pty.kill() } catch { /* already exited */ }
  })

  ws.on('error', (err) => console.warn('[terminal] ws error', (err as Error).message))
}
