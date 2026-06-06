import { Router } from 'express'
import { isConfigured, setupCredentials, verifyCredentials } from '../auth/store.js'
import { signAppToken } from '../auth/token.js'
import { isLoopbackReq } from '../middleware/auth.js'

// Public auth endpoints (mounted BEFORE requireAuth). Login/setup must be
// reachable without a token. Everything else stays behind requireAuth.

const router = Router()

// Simple in-memory lockout: after too many failed logins from one IP, cool off.
// Single-user app, so this is just brute-force friction, not a full rate limiter.
const MAX_FAILS = 8
const LOCKOUT_MS = 15 * 60 * 1000
const attempts = new Map<string, { fails: number; until: number }>()

function clientKey(ip: string | undefined): string { return ip || 'unknown' }
function isLockedOut(ip: string | undefined): boolean {
  const a = attempts.get(clientKey(ip))
  return Boolean(a && a.until > Date.now())
}
function recordFail(ip: string | undefined) {
  const key = clientKey(ip)
  const a = attempts.get(key) ?? { fails: 0, until: 0 }
  a.fails += 1
  if (a.fails >= MAX_FAILS) { a.until = Date.now() + LOCKOUT_MS; a.fails = 0 }
  attempts.set(key, a)
}
function recordSuccess(ip: string | undefined) { attempts.delete(clientKey(ip)) }

// Whether owner credentials have been set up yet — drives the login vs. setup UI.
router.get('/auth/status', (_req, res) => {
  res.json({ configured: isConfigured() })
})

// Bootstrap (or recover) the owner credential. Allowed when not yet configured,
// or from a loopback (on-server) request as a recovery hatch. Returns the
// otpauth:// URI + secret so the authenticator app can enroll.
router.post('/auth/setup', (req, res) => {
  const local = isLoopbackReq(req)
  if (isConfigured() && !local) {
    return res.status(403).json({ error: 'already configured', detail: 'run setup from the server to reset credentials' })
  }
  const password = String((req.body ?? {}).password ?? '')
  try {
    const { otpauthUri, secret } = setupCredentials(password)
    res.json({ ok: true, otpauthUri, secret })
  } catch (err) {
    res.status(400).json({ error: 'setup failed', detail: (err as Error).message })
  }
})

// Exchange password + TOTP for an app token.
router.post('/auth/login', (req, res) => {
  if (!isConfigured()) return res.status(409).json({ error: 'not configured' })
  if (isLockedOut(req.ip)) return res.status(429).json({ error: 'too many attempts', detail: 'try again later' })
  const { password, totp } = (req.body ?? {}) as { password?: string; totp?: string }
  if (!verifyCredentials(String(password ?? ''), String(totp ?? ''))) {
    recordFail(req.ip)
    return res.status(401).json({ error: 'invalid credentials' })
  }
  recordSuccess(req.ip)
  res.json(signAppToken())
})

export default router
