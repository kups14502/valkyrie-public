import { Router, type Request, type Response } from 'express'

// AI > Call: thor listens to a Teams or Zoom call through Windows Live
// Captions and has Claude suggest answers while it runs (thor's call-assist
// service, C:\Thor\tools\call-assist, port 8768). This route only passes
// requests through: the call, its transcript and its cards live in thor's
// memory, and nothing about a call is stored on odin.
//
// GET /call/state is a long poll (?rev=<last>&wait=<s>): thor answers at once
// when its rev moved, else when something changes or the wait runs out.

const router = Router()

const CALL_URL = process.env.CALL_ASSIST_URL || 'http://100.118.7.57:8768'
const CALL_TOKEN = process.env.CALL_ASSIST_TOKEN || ''
const MAX_WAIT_S = 25

class CallError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function thor(req: Request, pathAndQuery: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  if (!CALL_TOKEN) throw new CallError(503, 'CALL_ASSIST_TOKEN is not set on the api host')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 15_000)
  // A page that went away stops waiting on thor too.
  const gone = () => ac.abort()
  req.on('close', gone)
  try {
    const r = await fetch(CALL_URL + pathAndQuery, {
      method: init.method ?? 'GET',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${CALL_TOKEN}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string }
    if (!r.ok) throw new CallError(r.status >= 500 ? 502 : r.status, data.error || `thor answered ${r.status}`)
    return data
  } catch (e) {
    if (e instanceof CallError) throw e
    const why = (e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message
    throw new CallError(502, `thor's call service is not answering (${why})`)
  } finally {
    clearTimeout(timer)
    req.off('close', gone)
  }
}

const h = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
  try {
    await fn(req, res)
  } catch (e) {
    if (res.headersSent || res.destroyed) return
    const status = e instanceof CallError ? e.status : 500
    res.status(status).json({ error: e instanceof CallError ? e.message : 'internal error' })
  }
}

const count = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,12}$/.test(v) ? v : null)

router.get('/call/state', h(async (req, res) => {
  const q = new URLSearchParams()
  const rev = count(req.query.rev)
  const after = count(req.query.after)
  const wait = Math.min(Number(count(req.query.wait) ?? 0), MAX_WAIT_S)
  if (rev) q.set('rev', rev)
  if (after) q.set('after', after)
  if (wait) q.set('wait', String(wait))
  const data = await thor(req, `/state?${q}`, { timeoutMs: (wait + 10) * 1000 })
  if (res.destroyed) return
  res.set('Cache-Control', 'no-store').json(data)
}))

router.post('/call/start', h(async (req, res) => {
  const area = String(req.body?.area ?? '')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(area)) throw new CallError(400, 'area must be an area id')
  res.json(await thor(req, '/start', { method: 'POST', body: { area } }))
}))

router.post('/call/stop', h(async (req, res) => {
  res.json(await thor(req, '/stop', { method: 'POST', body: { save: req.body?.save === true }, timeoutMs: 30_000 }))
}))

router.post('/call/ask', h(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  if (!text) throw new CallError(400, 'text is required')
  if (text.length > 2000) throw new CallError(400, 'text is over 2000 characters')
  res.json(await thor(req, '/ask', { method: 'POST', body: { text } }))
}))

router.post('/call/dismiss', h(async (req, res) => {
  const id = String(req.body?.id ?? '')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new CallError(400, 'id must be a card id')
  res.json(await thor(req, '/dismiss', { method: 'POST', body: { id } }))
}))

export default router
