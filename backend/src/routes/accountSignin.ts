import { Router, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_ACCOUNTS } from '../lib/claudeAccounts.js'
import {
  SigninError, VAULT_DIR, cancelSignin, getSignin, listSignins, startSignin, submitCode, syncThorVault,
  type SigninMode,
} from '../lib/accountSignin.js'

// Sign-in automation for the account switcher (lib/accountSignin.ts).
//
//   GET  /api/account-switch/signin               { requests, vault }
//   POST /api/account-switch/signin               { accountId, mode?: 'token'|'login', auto?: boolean (default false) } -> 202 { request }
//   POST /api/account-switch/signin/:id/code      { code: '<code#state>' } -> { request }
//   POST /api/account-switch/signin/:id/cancel    -> { request }
//   POST /api/account-switch/signin/sync-thor     { accountId } -> { ok }
//
// mode 'token' (the default) makes a 1-year token for the switcher's vaults; 'login' replaces the
// usage card's sign-in in the account's own config dir.
//
// The default is the one-tap path: Lil kups DMs Brendon the authorize URL and the request waits
// (needsCode true) for code#state from the page. auto:true first tries thor's headless browser;
// on 2026-10-18 claude.ai answered the verification code with a visible hCaptcha every time, so
// auto costs one extra sign-in email and ends in the same DM. No route returns a token, a URL or
// a code.
const router = Router()

type VaultEntry = { accountId: string; present: boolean; kind: string | null; createdAt: string | null; expiresAt: number | null }

// What the page needs to know about each stored token, read without returning it.
function vaultStatus(): VaultEntry[] {
  return CLAUDE_ACCOUNTS.map((a) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, `${a.id}.json`), 'utf8')) as Record<string, unknown>
      return {
        accountId: a.id,
        present: typeof r.accessToken === 'string' && r.accessToken.length > 0,
        kind: typeof r.kind === 'string' ? r.kind : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
        expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
      }
    } catch {
      return { accountId: a.id, present: false, kind: null, createdAt: null, expiresAt: null }
    }
  })
}

function fail(res: Response, err: unknown): void {
  if (err instanceof SigninError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[account-signin] route failed:', (err as Error).message)
  res.status(500).json({ error: 'sign-in failed to start' })
}

router.get('/account-switch/signin', (_req, res) => {
  res.json({ requests: listSignins(), vault: vaultStatus() })
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
