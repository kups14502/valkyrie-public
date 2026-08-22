import { Router } from 'express'
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

router.post('/hosts/thor/launch', async (req, res) => {
  if (!LAUNCHER_TOKEN) return notConfigured(res)
  const sessionId = String((req.body ?? {}).sessionId ?? '')
  if (!UUID_RE.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId must be a uuid' })
  }
  // Note what is NOT forwarded: any cwd the caller sent. thor resolves it.
  try {
    const r = await callLauncher('/launch', { method: 'POST', body: { sessionId } })
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

export default router
