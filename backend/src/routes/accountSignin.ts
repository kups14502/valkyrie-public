import { Router, type Response } from 'express'
import {
  SigninError, cancelQueue, cancelSignin, getQueue, getSignin, listSignins, resendDm, setupPlan, startQueue, startSignin,
  submitCode, syncThorVault, vaultStatus,
  type SigninMode,
} from '../lib/accountSignin.js'

// Sign-ins for the account switcher (lib/accountSignin.ts).
//
//   GET  /api/account-switch/signin               { requests, vault, queue, plan }
//   POST /api/account-switch/signin               { accountId, mode?: 'token'|'login', auto?: boolean (default false) } -> 202 { request }
//   POST /api/account-switch/signin/queue         { accountIds?: string[] } -> 202 { queue }   "Set up all accounts"
//   POST /api/account-switch/signin/queue/cancel  -> { queue }
//   POST /api/account-switch/signin/sync-thor     { accountId } -> { ok }
//   GET  /api/account-switch/signin/:id           { request }
//   POST /api/account-switch/signin/:id/code      { code: '<code#state>' or the callback URL } -> { request }
//   POST /api/account-switch/signin/:id/dm        sends the link DM again (once a minute) -> { request }
//   POST /api/account-switch/signin/:id/cancel    -> { request }
//
// mode 'token' (the default) makes a 1-year token for the switcher's vaults; 'login' replaces the
// usage card's sign-in in the account's own config dir.
//
// The default is the one-tap path: Lil kups DMs Brendon the authorize URL and the request waits an
// hour (needsCode true, waitUntil) for code#state from the page. auto:true first tries thor's
// headless browser; on 2026-10-18 claude.ai answered the verification code with a visible hCaptcha
// every time, so auto costs one extra sign-in email and ends in the same DM.
//
//   request: { id, accountId, label, email, mode, stage, detail, fallbackReason, needsCode, dmSent,
//              dmAt, waitUntil, retries, queue: { n, of } | null, startedAt, updatedAt, finishedAt,
//              ok, vault: { odin, thor, probeStatus } | null, identity }
//   queue:   { id, state: 'running'|'stopped'|'finished'|'canceled', reason, already,
//              items: [{ accountId, label, kind: 'signin'|'copy', status: 'waiting'|'running'|'done'|'failed', detail, requestId }],
//              startedAt, updatedAt, finishedAt } | null
//   plan:    { signin: [accountId], copy: [accountId], already: n }   what "Set up all accounts" would do now
//
// No route returns a token, a URL or a code.
const router = Router()

function fail(res: Response, err: unknown): void {
  if (err instanceof SigninError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[account-signin] route failed:', (err as Error).message)
  res.status(500).json({ error: 'sign-in failed to start' })
}

router.get('/account-switch/signin', (_req, res) => {
  const p = setupPlan()
  res.json({
    requests: listSignins(),
    vault: vaultStatus(),
    queue: getQueue(),
    plan: {
      signin: p.items.filter((i) => i.kind === 'signin').map((i) => i.accountId),
      copy: p.items.filter((i) => i.kind === 'copy').map((i) => i.accountId),
      already: p.already,
    },
  })
})

router.post('/account-switch/signin', async (req, res) => {
  const body = (req.body ?? {}) as { accountId?: unknown; mode?: unknown; auto?: unknown }
  const mode = (body.mode ?? 'token') as SigninMode
  try {
    // No config dir from a client: login mode always targets the account's own dir.
    const request = await startSignin({ accountId: String(body.accountId ?? ''), mode, auto: body.auto === true })
    res.status(202).json({ request })
  } catch (err) {
    fail(res, err)
  }
})

// Registered before the /:id routes, so "queue" is never read as an id.
router.post('/account-switch/signin/queue', async (req, res) => {
  const raw = (req.body ?? {}).accountIds
  const only = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : undefined
  try {
    res.status(202).json({ queue: await startQueue(only && only.length ? only : undefined) })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/signin/queue/cancel', (_req, res) => {
  try {
    res.json({ queue: cancelQueue() })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/signin/sync-thor', async (req, res) => {
  try {
    const ok = await syncThorVault(String((req.body ?? {}).accountId ?? ''))
    res.json({ ok })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/signin/:id/code', async (req, res) => {
  try {
    const request = await submitCode(req.params.id, String((req.body ?? {}).code ?? ''))
    res.json({ request })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/signin/:id/dm', async (req, res) => {
  try {
    res.json({ request: await resendDm(req.params.id) })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/signin/:id/cancel', async (req, res) => {
  try {
    const request = await cancelSignin(req.params.id)
    res.json({ request })
  } catch (err) {
    fail(res, err)
  }
})

router.get('/account-switch/signin/:id', (req, res) => {
  const request = getSignin(req.params.id)
  if (!request) return res.status(404).json({ error: 'no such sign-in' })
  res.json({ request })
})

export default router
