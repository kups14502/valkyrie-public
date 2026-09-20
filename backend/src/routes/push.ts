import { Router } from 'express'
import { createHash } from 'node:crypto'
import webpush from 'web-push'
import { openDb } from '../lib/db.js'
import { requireStrongAuth } from '../middleware/auth.js'

// Web Push out of Valkyrie itself.
//
// WHY THIS EXISTS. "A session is waiting on you" used to arrive as a Discord
// DM: thor's Notification hook ssh'd to odin and had openclaw send it. That
// worked, but the alert came from Discord, so it could not carry Valkyrie's
// own identity and tapping it landed in Discord rather than on the board.
// Now the hook POSTs /push/session-waiting here and the iPhone's home-screen
// PWA raises the notification.
//
// The pieces, because none of this is obvious a year from now:
//   * VAPID is the whole authentication story. The keypair in the environment
//     identifies this server to Apple/Google's push service; the public half
//     also goes to the browser at subscribe time, which is why /push/status
//     publishes it. Change the keypair and every stored subscription dies.
//   * A subscription IS a capability URL. Anyone holding the endpoint can push
//     to that device, so endpoints are never returned to a client: the UI sees
//     a sha256 prefix (`id`) and matches on that.
//   * 404 and 410 from the push service mean the subscription is permanently
//     gone (app deleted, permission revoked). That row is dropped on the spot,
//     or a dead iPhone would keep collecting failures forever.
//   * iOS only delivers to a PWA the user added to the Home Screen, and only
//     over https. The frontend does that gatekeeping; by the time a request
//     reaches /push/subscribe the browser has already agreed.

const router = Router()

const db = openDb('push', `
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    ua TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    lastOkAt TEXT,
    lastError TEXT,
    failCount INTEGER NOT NULL DEFAULT 0
  );
`)

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''
// Apple rejects a VAPID JWT whose `sub` is not a mailto: or https: URL.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:brendon@brendonkupsch.com'

const configured = Boolean(VAPID_PUBLIC && VAPID_PRIVATE)
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)
} else {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push is off')
}

type SubRow = {
  endpoint: string; p256dh: string; auth: string; label: string; ua: string
  createdAt: string; lastOkAt: string | null; lastError: string | null; failCount: number
}

/** Short stable handle for an endpoint. The endpoint itself never leaves here. */
const subId = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 12)

const listSubs = (): SubRow[] => db.prepare('SELECT * FROM push_subs ORDER BY createdAt').all() as SubRow[]

const publicSub = (r: SubRow) => ({
  id: subId(r.endpoint),
  label: r.label,
  ua: r.ua,
  createdAt: r.createdAt,
  lastOkAt: r.lastOkAt,
  lastError: r.lastError,
  failCount: r.failCount,
  // Which push service it belongs to, purely so the UI can say "iPhone" honestly.
  service: /apple\.com/i.test(r.endpoint) ? 'apple'
    : /googleapis\.com|google\.com/i.test(r.endpoint) ? 'google'
      : /mozilla|mozaws/i.test(r.endpoint) ? 'mozilla' : 'other',
})

export type PushPayload = {
  title: string
  body: string
  /** Collapse key. Repeat alerts for one session replace each other. */
  tag?: string
  /** Where a tap lands, as an app-relative path. */
  url?: string
}

export type PushResult = { ok: boolean; sent: number; failed: number; removed: number; detail: string }

/**
 * Deliver to every stored subscription. Never throws: a notification failing
 * must not fail the thing that asked for it.
 */
export async function pushToAll(payload: PushPayload): Promise<PushResult> {
  if (!configured) return { ok: false, sent: 0, failed: 0, removed: 0, detail: 'VAPID keys not configured' }
  const subs = listSubs()
  if (subs.length === 0) return { ok: false, sent: 0, failed: 0, removed: 0, detail: 'no subscriptions' }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    tag: payload.tag || 'valkyrie',
    url: payload.url || '/sessions',
  })

  let sent = 0, failed = 0, removed = 0
  const errors: string[] = []

  await Promise.all(subs.map(async (row) => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
    try {
      await webpush.sendNotification(sub, body, {
        TTL: 600,
        // Apple drops a "background" push to a PWA that is not running; every
        // one of ours is meant to be seen, so they all go out at high urgency.
        urgency: 'high',
      })
      sent += 1
      db.prepare('UPDATE push_subs SET lastOkAt = ?, lastError = NULL, failCount = 0 WHERE endpoint = ?')
        .run(new Date().toISOString(), row.endpoint)
    } catch (err) {
      const e = err as { statusCode?: number; body?: string; message?: string }
      const status = e.statusCode ?? 0
      const detail = `${status || 'error'}: ${String(e.body || e.message || '').slice(0, 160)}`
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(row.endpoint)
        removed += 1
      } else {
        failed += 1
        db.prepare('UPDATE push_subs SET lastError = ?, failCount = failCount + 1 WHERE endpoint = ?')
          .run(detail, row.endpoint)
      }
      errors.push(detail)
    }
  }))

  const detail = sent > 0
    ? `sent to ${sent}${removed ? `, dropped ${removed} dead` : ''}${failed ? `, ${failed} failed` : ''}`
    : (errors[0] || 'nothing delivered')
  if (sent === 0) console.warn('[push] delivered nothing', { subs: subs.length, removed, failed, first: errors[0] })
  return { ok: sent > 0, sent, failed, removed, detail }
}

// ------------------------------------------------------------------ routes ---

// What the client needs to decide whether it can subscribe, plus the key it
// subscribes with. Readable with ordinary auth: the public key is public.
router.get('/push/status', (_req, res) => {
  res.json({
    configured,
    publicKey: configured ? VAPID_PUBLIC : '',
    subscriptions: listSubs().map(publicSub),
  })
})

router.post('/push/subscribe', (req, res) => {
  if (!configured) return res.status(503).json({ error: 'push not configured' })
  const b = (req.body ?? {}) as { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; label?: string }
  const endpoint = String(b.subscription?.endpoint ?? '')
  const p256dh = String(b.subscription?.keys?.p256dh ?? '')
  const auth = String(b.subscription?.keys?.auth ?? '')
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return res.status(400).json({ error: 'invalid subscription' })
  }
  const label = String(b.label ?? '').slice(0, 60)
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 200)
  // Re-subscribing with the same endpoint is the normal case (the browser
  // hands back the existing one), so this is an upsert that keeps createdAt.
  db.prepare(`
    INSERT INTO push_subs (endpoint, p256dh, auth, label, ua, createdAt, lastOkAt, lastError, failCount)
    VALUES (@endpoint, @p256dh, @auth, @label, @ua, @now, NULL, NULL, 0)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
      ua = excluded.ua, lastError = NULL, failCount = 0
  `).run({ endpoint, p256dh, auth, label, ua, now: new Date().toISOString() })
  res.json({ ok: true, id: subId(endpoint), subscriptions: listSubs().map(publicSub) })
})

// Accepts the endpoint (what the browser has) or the short id (what the UI
// has after a reload, since the endpoint is never sent back down).
router.post('/push/unsubscribe', (req, res) => {
  const b = (req.body ?? {}) as { endpoint?: string; id?: string }
  const endpoint = String(b.endpoint ?? '')
  const id = String(b.id ?? '')
  let removed = 0
  if (endpoint) {
    removed = db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint).changes
  } else if (id) {
    const hit = listSubs().find((r) => subId(r.endpoint) === id)
    if (hit) removed = db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(hit.endpoint).changes
  }
  res.json({ ok: removed > 0, removed, subscriptions: listSubs().map(publicSub) })
})

router.post('/push/test', async (_req, res) => {
  const r = await pushToAll({
    title: 'Valkyrie',
    body: 'Test notification. Push is working.',
    tag: 'valkyrie-test',
    url: '/settings',
  })
  res.status(r.ok ? 200 : 502).json(r)
})

// The hook's endpoint. Strong auth (no legacy origin bypass): thor reaches it
// over the tailnet, which isStrongAuth already trusts by socket address.
router.post('/push/session-waiting', requireStrongAuth, async (req, res) => {
  const b = (req.body ?? {}) as { label?: string; message?: string; host?: string }
  const label = String(b.label ?? '').trim().slice(0, 80) || 'a session'
  const note = String(b.message ?? '').trim().replace(/\s+/g, ' ').slice(0, 140)
  const host = String(b.host ?? '').trim().slice(0, 20)

  const r = await pushToAll({
    title: 'Claude is waiting on you',
    body: note ? `${label}\n${note}` : label,
    // One tag per session label, so a second alert for the same session
    // replaces the first on the lock screen instead of stacking.
    tag: `session-${createHash('sha256').update(`${host}:${label}`).digest('hex').slice(0, 10)}`,
    url: '/sessions',
  })
  res.status(r.ok ? 200 : 502).json(r)
})

// Generic sender for anything else that wants to reach the phone as Valkyrie.
router.post('/push/notify', requireStrongAuth, async (req, res) => {
  const b = (req.body ?? {}) as { title?: string; body?: string; tag?: string; url?: string }
  const title = String(b.title ?? '').trim().slice(0, 80) || 'Valkyrie'
  const body = String(b.body ?? '').trim().slice(0, 300)
  if (!body) return res.status(400).json({ error: 'body required' })
  const url = String(b.url ?? '/dashboard')
  const r = await pushToAll({
    title,
    body,
    tag: String(b.tag ?? 'valkyrie').slice(0, 60),
    url: url.startsWith('/') ? url : '/dashboard',
  })
  res.status(r.ok ? 200 : 502).json(r)
})

export default router
