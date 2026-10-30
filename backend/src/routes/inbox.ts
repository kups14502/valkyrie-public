import { Router, type Request, type Response } from 'express'
import { requireStrongAuth, viaCloudflare } from '../middleware/auth.js'
import {
  InboxError, LEVELS, PUSH_SETTINGS, SOURCE_RE, inboxCount, listInbox, markRead, postInbox, setArchived,
  setPushSetting, sourceStats, type InboxLevel, type PushSetting, type Selector,
} from '../lib/inboxStore.js'

// The inbox's HTTP side. The store and the rules are in lib/inboxStore.ts.
//
// Senders: processes on odin call POST http://127.0.0.1:3001/api/inbox (Lil'
// kups does it for every old Discord sender), thor calls the tailnet listener.
// Posting takes strong auth like /push/notify: loopback, a trusted tailnet
// device or a signed-in app, never the media-scoped query token.

const router = Router()

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof InboxError
      if (!known) console.error('[inbox]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? 400 : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

function selector(b: Record<string, unknown>): Selector {
  return {
    ids: Array.isArray(b.ids) ? b.ids.map(Number) : undefined,
    source: typeof b.source === 'string' && b.source ? b.source : undefined,
    all: b.all === true,
  }
}

router.post('/inbox', requireStrongAuth, h(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const level = b.level == null || b.level === '' ? undefined : String(b.level)
  if (level && !LEVELS.includes(level as InboxLevel)) throw new InboxError('level must be info, warn or alert')
  const r = await postInbox({
    source: String(b.source ?? ''),
    title: b.title == null ? undefined : String(b.title),
    // `message` is what Lil' kups calls it
    body: b.body != null ? String(b.body) : b.message != null ? String(b.message) : undefined,
    level: level as InboxLevel | undefined,
    url: b.url == null ? undefined : String(b.url),
    tag: b.tag == null || b.tag === '' ? undefined : String(b.tag),
    push: typeof b.push === 'boolean' ? b.push : undefined,
  })
  res.json({ ok: true, id: r.item.id, folded: r.folded, pushed: r.pushed, pushDetail: r.pushDetail })
}))

router.get('/inbox', h((req, res) => {
  const view = req.query.view === 'archive' ? 'archive' : 'open'
  const source = typeof req.query.source === 'string' && SOURCE_RE.test(req.query.source) ? req.query.source : undefined
  const limit = Number(req.query.limit) || undefined
  const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined
  // through Cloudflare, private sources (work mail) are left out entirely
  const hide = viaCloudflare(req)
  res.json({ view, items: listInbox({ view, source, limit, before, hidePrivate: hide }), sources: sourceStats(hide), count: inboxCount(hide) })
}))

// What the strip's inbox button polls: cheap, no item bodies.
router.get('/inbox/count', h((req, res) => {
  res.json(inboxCount(viaCloudflare(req)))
}))

router.post('/inbox/read', h((req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const changed = markRead(selector(b), b.read !== false)
  res.json({ ok: true, changed, count: inboxCount(viaCloudflare(req)) })
}))

router.post('/inbox/archive', h((req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const changed = setArchived({ ...selector(b), readOnly: b.readOnly === true }, b.archived !== false)
  res.json({ ok: true, changed, count: inboxCount(viaCloudflare(req)) })
}))

router.put('/inbox/sources/:source', h((req, res) => {
  const push = String((req.body ?? {}).push ?? '') as PushSetting
  if (!PUSH_SETTINGS.includes(push)) throw new InboxError('push must be auto, on or off')
  setPushSetting(String(req.params.source), push)
  res.json({ ok: true, sources: sourceStats(viaCloudflare(req)) })
}))

export default router
