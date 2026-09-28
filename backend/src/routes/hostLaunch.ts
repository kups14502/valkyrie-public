import express, { Router } from 'express'
import { Agent, fetch as undiciFetch } from 'undici'

// Proxy to thor's session launcher agent.
//
// This is the only route in Valkyrie that causes something to be executed on
// another machine, so it is deliberately thin and deliberately dumb: it forwards
// a session id and nothing else. The cwd is resolved on thor from its own local
// state, never from anything a client sends here. That means a caller who fully
// controls this endpoint can only reopen a Claude session in a directory that
// already had one, which is a much smaller surface than "run a command on thor".
//
// requireAuth still applies (index.ts mounts this behind it), but note that
// middleware trusts any tailnet peer without a credential. That is acceptable for
// the read-only routes; for this one the launcher enforces its own bearer token
// on the thor side, which is a credential the tailnet alone does not grant.
const router = Router()

const LAUNCHER_HOST = process.env.THOR_LAUNCHER_HOST || '100.118.7.57'
const LAUNCHER_PORT = Number(process.env.THOR_LAUNCHER_PORT || 8766)
const LAUNCHER_TOKEN = process.env.THOR_LAUNCHER_TOKEN || ''
const BASE = `http://${LAUNCHER_HOST}:${LAUNCHER_PORT}`

// Which machines Valkyrie will address. EVERYTHING RUNS ON THOR: it is always
// on, it holds the work, and its sessions are reachable from anywhere through
// the in-page terminal. mimir was wired up as a second host on 2026-09-10 and
// taken back out the same day, because a laptop on another network is off
// exactly when you would want to reach it and a transcript never leaves the
// machine that wrote it, so a session there is work that can hide.
//
// The plumbing stays host-addressed rather than re-hardcoded, since that is
// what lets a row's resume, stop and done follow the machine it belongs to. A
// second host is opt-in: name it in LAUNCHER_HOSTS and give it
// <HOST>_LAUNCHER_HOST and <HOST>_LAUNCHER_TOKEN. With none named, this is a
// one-entry table and /session-board is thor's list.
type Launcher = { host: string; port: number; token: string; env: string }

const LAUNCHERS: Record<string, Launcher> = {
  thor: { host: LAUNCHER_HOST, port: LAUNCHER_PORT, token: LAUNCHER_TOKEN, env: 'THOR_LAUNCHER_TOKEN' },
}

for (const name of (process.env.LAUNCHER_HOSTS || '').split(',').map((h) => h.trim().toLowerCase())) {
  if (!name || name === 'thor') continue
  const prefix = name.toUpperCase()
  const host = process.env[`${prefix}_LAUNCHER_HOST`]
  if (!host) {
    console.error(`[hosts] ${name} is in LAUNCHER_HOSTS but ${prefix}_LAUNCHER_HOST is not set, skipping it`)
    continue
  }
  LAUNCHERS[name] = {
    host,
    port: Number(process.env[`${prefix}_LAUNCHER_PORT`] || 8766),
    token: process.env[`${prefix}_LAUNCHER_TOKEN`] || '',
    env: `${prefix}_LAUNCHER_TOKEN`,
  }
}
// The in-page terminal is a tmux pane SSHing into thor (terminal/tmux.ts), so
// only thor can host one today. Every other host opens on its own screen.
const PAGE_HOSTS = new Set((process.env.TERMINAL_HOSTS || 'thor').split(',').map((h) => h.trim()).filter(Boolean))

// thor is on the tailnet, not the internet: a slow reply means it is asleep or
// gone, not that it needs longer.
const TIMEOUT_MS = 8_000
// Restoring a whole desk opens tabs serially with a deliberate pause between
// them, so that call legitimately takes longer.
const RESTORE_TIMEOUT_MS = 60_000

const agent = new Agent({ connect: { timeout: 3_000 } })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type LauncherResult = { status: number; body: unknown }

async function callLauncher(path: string, init: { method: string; body?: unknown }, timeoutMs = TIMEOUT_MS): Promise<LauncherResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await undiciFetch(`${BASE}${path}`, {
      method: init.method,
      signal: controller.signal,
      dispatcher: agent,
      headers: {
        Authorization: `Bearer ${LAUNCHER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let body: unknown = null
    try { body = await r.json() } catch { body = null }
    return { status: r.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// Resolve a :host param to its launcher, or answer for itself. 404 for a name
// with no launcher, 501 when the token is missing, so the frontend can tell
// "no such machine" from "that machine needs setting up".
function resolveLauncher(req: import('express').Request, res: import('express').Response): Launcher | null {
  const name = String(req.params.host ?? '')
  const launcher = LAUNCHERS[name]
  if (!launcher) {
    res.status(404).json({ error: `no launcher for ${name}` })
    return null
  }
  if (!launcher.token) {
    res.status(501).json({ error: 'launcher not configured', detail: `${launcher.env} is not set on the api host` })
    return null
  }
  return launcher
}

// Same call, aimed at a named host rather than the thor constants.
async function callHostLauncher(
  launcher: Launcher,
  path: string,
  init: { method: string; body?: unknown },
  timeoutMs = TIMEOUT_MS,
): Promise<LauncherResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await undiciFetch(`http://${launcher.host}:${launcher.port}${path}`, {
      method: init.method,
      signal: controller.signal,
      dispatcher: agent,
      headers: {
        Authorization: `Bearer ${launcher.token}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let body: unknown = null
    try { body = await r.json() } catch { body = null }
    return { status: r.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// 501 rather than 500 when the token is absent, because the frontend treats
// 404/501 as "launcher not installed" and shows a calm banner instead of an error.
function notConfigured(res: import('express').Response) {
  return res.status(501).json({
    error: 'launcher not configured',
    detail: 'THOR_LAUNCHER_TOKEN is not set on the api host',
  })
}

router.get('/hosts/thor/launcher', async (_req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  try {
    const r = await callLauncher('/health', { method: 'GET' })
    return res.status(r.status === 200 ? 200 : 502).json({ reachable: r.status === 200, detail: r.body })
  } catch (err) {
    return res.status(502).json({ reachable: false, error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.get('/hosts/thor/desk', async (_req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  try {
    const r = await callLauncher('/desk', { method: 'GET' })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.post('/hosts/thor/capture', async (_req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  try {
    const r = await callLauncher('/capture', { method: 'POST', body: {} }, 30_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.post('/hosts/thor/restore-desk', async (req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  const raw = (req.body ?? {}).sessionIds
  let sessionIds: string[] | undefined
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'sessionIds must be an array' })
    if (raw.length > 40) return res.status(400).json({ error: 'too many sessions' })
    sessionIds = raw.map((x) => String(x))
    const bad = sessionIds.find((s) => !UUID_RE.test(s))
    if (bad) return res.status(400).json({ error: 'every sessionId must be a uuid' })
  }
  try {
    const r = await callLauncher('/restore', { method: 'POST', body: sessionIds ? { sessionIds } : {} }, RESTORE_TIMEOUT_MS)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

// ----------------------------------------------------------- new session ----
// Start a session on thor without remoting in first. The client sends a KEY
// from thor's own list, never a path, so this route cannot widen where the
// launcher may open a terminal: thor resolves the directory locally, exactly as
// it does for resume.

const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

// A row on the board resumes, stops, lists and dispositions on ITS OWN machine.
// These four used to be thor-only, which is why merging mimir into the list had
// to wait: a mimir session id sent to thor resolves to nothing.
router.post('/hosts/:host/launch', async (req, res) => {
  const launcher = resolveLauncher(req, res)
  if (!launcher) return
  const sessionId = String((req.body ?? {}).sessionId ?? '')
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ error: 'sessionId must be a uuid' })
  // Note what is NOT forwarded: any cwd the caller sent. The host resolves it.
  try {
    const r = await callHostLauncher(launcher, '/launch', { method: 'POST', body: { sessionId } })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${req.params.host} is not answering`, detail: (err as Error).message })
  }
})

router.post('/hosts/:host/stop', async (req, res) => {
  const launcher = resolveLauncher(req, res)
  if (!launcher) return
  const sessionId = String((req.body ?? {}).sessionId ?? '')
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ error: 'sessionId must be a uuid' })
  try {
    const r = await callHostLauncher(launcher, '/stop', { method: 'POST', body: { sessionId } })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${req.params.host} is not answering`, detail: (err as Error).message })
  }
})

router.get('/hosts/:host/sessions', async (req, res) => {
  const launcher = resolveLauncher(req, res)
  if (!launcher) return
  try {
    // Reading transcripts is cached on the host but a cold call still walks the
    // tree, so this gets a longer leash than the other proxies.
    const r = await callHostLauncher(launcher, '/sessions', { method: 'GET' }, 60_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${req.params.host} is not answering`, detail: (err as Error).message })
  }
})

// One id or a whole checkbox selection. The host rewrites its disposition file
// whole, so the page has to send the batch in one request: twenty parallel
// calls each read the same copy of that file and the last write wins.
router.post('/hosts/:host/sessions/disposition', async (req, res) => {
  const launcher = resolveLauncher(req, res)
  if (!launcher) return
  const body = (req.body ?? {}) as { sessionId?: unknown; sessionIds?: unknown; disposition?: unknown }
  const ids = Array.isArray(body.sessionIds) ? body.sessionIds.map((v) => String(v)) : [String(body.sessionId ?? '')]
  const disposition = String(body.disposition ?? '')
  if (ids.length === 0 || ids.length > 200) return res.status(400).json({ error: 'send 1 to 200 session ids' })
  if (!ids.every((id) => UUID_RE.test(id))) return res.status(400).json({ error: 'sessionId must be a uuid' })
  if (!SESSION_DISPOSITIONS.has(disposition)) return res.status(400).json({ error: 'disposition must be open or done' })
  try {
    // sessionId as well, so a host still running the older agent marks the
    // first row instead of answering 400.
    const r = await callHostLauncher(launcher, '/sessions/disposition', { method: 'POST', body: { sessionId: ids[0], sessionIds: ids, disposition } }, 60_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${req.params.host} is not answering`, detail: (err as Error).message })
  }
})

// The board's list: thor in full, every other machine only where it is still
// current. Brendon's rule for the second host, in his words: they should show
// up in the list, but not old ones. thor is the desk and keeps its own
// disposition-driven list, where "done" is the only thing that takes a row off.
const MERGE_DAYS = Number(process.env.SESSION_MERGE_DAYS || 7)

type BoardRow = Record<string, unknown> & { host?: string; live?: boolean; lastActivityUtc?: string | null }

router.get('/session-board', async (_req, res) => {
  const names = Object.keys(LAUNCHERS)
  const cutoff = Date.now() - MERGE_DAYS * 86_400_000
  const results = await Promise.all(names.map(async (name) => {
    const launcher = LAUNCHERS[name]
    if (!launcher.token) return { host: name, ok: false, status: 501, rows: [] as BoardRow[], detail: `${launcher.env} is not set on the api host` }
    try {
      const r = await callHostLauncher(launcher, '/sessions', { method: 'GET' }, 60_000)
      const body = (r.body ?? {}) as { sessions?: unknown }
      if (r.status !== 200 || !Array.isArray(body.sessions)) {
        return { host: name, ok: false, status: r.status, rows: [] as BoardRow[], detail: 'no session list' }
      }
      const rows = (body.sessions as BoardRow[])
        .map((row) => ({ ...row, host: name }))
        // thor is the desk: everything open stays. Elsewhere, recent or running.
        .filter((row) => {
          if (name === 'thor') return true
          if (row.live === true) return true
          const at = row.lastActivityUtc ? Date.parse(String(row.lastActivityUtc)) : NaN
          return Number.isFinite(at) && at >= cutoff
        })
      return { host: name, ok: true, status: 200, rows, detail: null as string | null }
    } catch (err) {
      return { host: name, ok: false, status: 502, rows: [] as BoardRow[], detail: (err as Error).message }
    }
  }))

  const thor = results.find((r) => r.host === 'thor')
  // thor failing is the list failing: it holds the desk. Another host failing is
  // a note on an otherwise complete list, never an error page.
  if (!thor?.ok) {
    return res.status(thor?.status === 501 ? 501 : 502).json({
      error: 'session list unavailable',
      detail: thor?.detail ?? 'thor is not answering',
    })
  }

  const sessions = results
    .flatMap((r) => r.rows)
    .sort((a, b) => Date.parse(String(b.lastActivityUtc ?? 0)) - Date.parse(String(a.lastActivityUtc ?? 0)))

  res.json({
    version: 1,
    generatedAt: new Date().toISOString(),
    mergeDays: MERGE_DAYS,
    hosts: results.map((r) => ({ host: r.host, ok: r.ok, detail: r.detail })),
    sessions,
  })
})

// Which machines can start a session, and what each one can do. The menu draws
// itself from this rather than assuming thor.
type HostProbe = { at: number; reachable: boolean; detail: string | null }
const PROBE_TTL_MS = 30_000
const probes = new Map<string, HostProbe>()

async function probeHost(name: string, launcher: Launcher): Promise<HostProbe> {
  const held = probes.get(name)
  if (held && Date.now() - held.at < PROBE_TTL_MS) return held
  let probe: HostProbe
  try {
    const r = await callHostLauncher(launcher, '/health', { method: 'GET' }, 3_000)
    probe = r.status === 200
      ? { at: Date.now(), reachable: true, detail: null }
      : { at: Date.now(), reachable: false, detail: `agent answered ${r.status}` }
  } catch (err) {
    probe = { at: Date.now(), reachable: false, detail: (err as Error).message }
  }
  probes.set(name, probe)
  return probe
}

router.get('/session-hosts', async (_req, res) => {
  const hosts = await Promise.all(Object.keys(LAUNCHERS).map(async (name) => {
    const launcher = LAUNCHERS[name]
    if (!launcher.token) {
      return {
        host: name,
        configured: false,
        reachable: false,
        canLaunch: false,
        canPage: PAGE_HOSTS.has(name),
        detail: `${launcher.env} is not set on the api host`,
      }
    }
    const probe = await probeHost(name, launcher)
    return {
      host: name,
      configured: true,
      reachable: probe.reachable,
      canLaunch: probe.reachable,
      canPage: PAGE_HOSTS.has(name),
      detail: probe.detail,
    }
  }))
  res.json({ hosts })
})

router.get('/hosts/:host/launch-targets', async (req, res) => {
  const name = String(req.params.host ?? '')
  const launcher = LAUNCHERS[name]
  if (!launcher) return res.status(404).json({ error: `no launcher for ${name}` })
  if (!launcher.token) {
    return res.status(501).json({ error: 'launcher not configured', detail: `${launcher.env} is not set on the api host` })
  }
  try {
    const r = await callHostLauncher(launcher, '/launch-targets', { method: 'GET' })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${name} is not answering`, detail: (err as Error).message })
  }
})

router.post('/hosts/:host/launch-new', async (req, res) => {
  const name = String(req.params.host ?? '')
  const launcher = LAUNCHERS[name]
  if (!launcher) return res.status(404).json({ error: `no launcher for ${name}` })
  if (!launcher.token) {
    return res.status(501).json({ error: 'launcher not configured', detail: `${launcher.env} is not set on the api host` })
  }
  const target = String((req.body ?? {}).target ?? '')
  if (!TARGET_RE.test(target)) return res.status(400).json({ error: 'target must be a launch-target key' })
  try {
    const r = await callHostLauncher(launcher, '/launch-new', { method: 'POST', body: { target } }, 20_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: `${name} is not answering`, detail: (err as Error).message })
  }
})

// -------------------------------------------------------------- desk RGB ----
// thor's desk lighting: the same two actions as its "Relight Thor" and "Dark
// Thor" desktop buttons. Same rule as the launch routes above: the client sends
// a MODE from a fixed list, never a task name, and thor maps it to a scheduled
// task out of its own local table.

const RGB_MODES = new Set(['relight', 'dark'])

router.get('/hosts/thor/rgb', async (_req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  try {
    const r = await callLauncher('/rgb', { method: 'GET' })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.post('/hosts/thor/rgb', async (req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  const mode = String((req.body ?? {}).mode ?? '')
  if (!RGB_MODES.has(mode)) return res.status(400).json({ error: 'mode must be relight or dark' })
  // The reply comes back as soon as the task is STARTED. A relight runs two
  // full OpenRGB cycles and takes about 45 seconds, so the page polls the
  // status route instead of holding a request open for it.
  try {
    const r = await callLauncher('/rgb', { method: 'POST', body: { mode } })
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

// ---------------------------------------------------------------- uploads ----
// Photos and videos from the phone into C:\Thor\uploads, so a Claude session on
// thor can read them by path. The page sends a file in 8 MB chunks
// (frontend/src/lib/upload.ts) and thor appends them (Receive-UploadChunk in
// Start-LauncherAgent.ps1). Same rule as the launch routes: the client names a
// FILE, never a folder. thor picks the folder and cuts the name down again.
//
// Each chunk is buffered here before it goes on, on purpose. The agent serves
// one request at a time, and the slow leg is the phone's uplink: streaming it
// through would hold the session list and every launch for as long as a
// cellular upload takes. Buffered, thor spends well under a second per chunk.

const UPLOAD_ID_RE = /^[0-9a-f]{32}$/
const UPLOAD_CHUNK_MAX = 8 * 1024 * 1024
const UPLOAD_MAX = 8 * 1024 ** 3

router.post(
  '/hosts/thor/upload',
  express.raw({ type: () => true, limit: UPLOAD_CHUNK_MAX + 64 * 1024 }),
  async (req, res) => {
    if (!LAUNCHER_TOKEN) return notConfigured(res)
    const id = String(req.query.id ?? '')
    const name = String(req.query.name ?? '')
    const offset = Number(req.query.offset)
    const total = Number(req.query.total)
    const chunk = Buffer.isBuffer(req.body) ? req.body : null
    if (!UPLOAD_ID_RE.test(id)) return res.status(400).json({ error: 'id must be 32 hex characters' })
    if (!name || name.length > 255) return res.status(400).json({ error: 'name is required' })
    if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'bad offset' })
    if (!Number.isSafeInteger(total) || total <= 0 || total > UPLOAD_MAX) return res.status(400).json({ error: 'bad total' })
    if (!chunk || chunk.length === 0) return res.status(400).json({ error: 'empty chunk' })
    const qs = new URLSearchParams({ id, name, offset: String(offset), total: String(total) })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const r = await undiciFetch(`${BASE}/upload?${qs}`, {
        method: 'POST',
        signal: controller.signal,
        dispatcher: agent,
        headers: { Authorization: `Bearer ${LAUNCHER_TOKEN}`, 'Content-Type': 'application/octet-stream' },
        body: chunk,
      })
      let body: unknown = null
      try { body = await r.json() } catch { body = null }
      return res.status(r.status).json(body)
    } catch (err) {
      return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
    } finally {
      clearTimeout(timer)
    }
  },
)

// --------------------------------------------------------------- sessions ----
// The list the page draws: real sessions, newest first, one row per session.
//
// This replaces the thread grouping. Threads existed to tame 455 rows, but 92%
// of those were the Obsidian hook's summariser runs; filtered out, only 265 are
// real. Grouping also had to guess which session a folder meant, and guessed
// wrong: it resumed a hook run and showed its own JSON prompt as the
// conversation. One row per session leaves nothing to guess.

const SESSION_DISPOSITIONS = new Set(['open', 'done'])

// ---------------------------------------------------------------- threads ----
// A thread is the unit above a session: the folder, with every session that ran
// in it. 455 sessions in a week is unreadable; 29 threads is a list. Disposition
// (active / parked / done) is the part no process state can tell you, because
// "closed" is a fact and "done" is a decision.
//
// Labels for client threads default to the business root. If one carries a real
// name it is because Brendon typed it, having decided it was safe to publish.

const THREAD_ID_RE = /^[0-9a-f]{6,32}$/
const DISPOSITIONS = new Set(['active', 'parked', 'done'])

router.get('/hosts/thor/threads', async (_req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  try {
    const r = await callLauncher('/threads', { method: 'GET' }, 30_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.post('/hosts/thor/threads/disposition', async (req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  const threadId = String((req.body ?? {}).threadId ?? '')
  const disposition = String((req.body ?? {}).disposition ?? '')
  if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: 'threadId must be hex' })
  if (!DISPOSITIONS.has(disposition)) return res.status(400).json({ error: 'disposition must be active, parked or done' })
  try {
    const r = await callLauncher('/threads/disposition', { method: 'POST', body: { threadId, disposition } }, 30_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

router.post('/hosts/thor/threads/label', async (req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  const threadId = String((req.body ?? {}).threadId ?? '')
  const label = String((req.body ?? {}).label ?? '')
  if (!THREAD_ID_RE.test(threadId)) return res.status(400).json({ error: 'threadId must be hex' })
  if (label.length > 60) return res.status(400).json({ error: 'label too long' })
  // eslint-disable-next-line no-control-regex
  if (/[\x00-]/.test(label)) return res.status(400).json({ error: 'label has control characters' })
  try {
    const r = await callLauncher('/threads/label', { method: 'POST', body: { threadId, label } }, 30_000)
    return res.status(r.status).json(r.body)
  } catch (err) {
    return res.status(502).json({ error: 'thor is not answering', detail: (err as Error).message })
  }
})

export default router
