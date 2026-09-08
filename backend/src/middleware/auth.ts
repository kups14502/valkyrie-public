import type { Request, Response, NextFunction } from 'express'
import type { IncomingMessage } from 'node:http'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { verifyAppToken, verifyImgToken } from '../auth/token.js'

// Auth for Valkyrie. Accepted credentials, checked in order:
//   1. Self-hosted app token (Authorization: Bearer <jwt>, or ?token= for WS) —
//      the dedicated desktop/mobile apps use this.
//   2. Cloudflare Access JWT (cf-access-jwt-assertion header) — transitional,
//      still active until the Access policy is retired in the cutover.
//   3. Loopback requests in dev (not forwarded by Cloudflare).
//   4. LEGACY (only when AUTH_STRICT is off): the old "trusted frontend/api
//      pairing" bypass that lets requests through with NO token. This is a
//      known hole — the API host isn't actually behind Access, so today's live
//      app depends on it. It stays as the default ONLY so deploying this auth
//      work doesn't break the running dashboard before the apps send tokens.
//      Set AUTH_STRICT=1 in the cutover to remove it.

const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN
const AUD = process.env.CF_ACCESS_AUD
const ALLOW_LOCAL = process.env.NODE_ENV !== 'production'
// When true, only real credentials (app token / cf-access / loopback) are
// accepted — the legacy no-token bypass is disabled. Flip on at cutover.
const AUTH_STRICT = /^(1|true|yes)$/i.test(process.env.AUTH_STRICT || '')
export function isAuthStrict(): boolean { return AUTH_STRICT }

// The legacy trusted frontend↔api origin pairing (no token). Kept only as the
// non-strict fallback during migration.
function isTrustedLegacyPair(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = String(req.headers['origin'] || '')
  const host = String(req.headers['host'] || '')
  const trustedPagesPreview = /^https:\/\/[a-z0-9-]+\.master-control-72u\.pages\.dev$/i.test(origin)
  // Old hostnames stay accepted until every device/bookmark has moved over.
  const trustedFrontend = origin === 'https://valkyrie.brendonkupsch.com'
    || origin === 'https://master-control.brendonkupsch.com'
    || trustedPagesPreview
  const trustedApiHost = host === 'valkyrie-api.brendonkupsch.com'
    || host === 'master-control-api.brendonkupsch.com'
    || host === 'api.brendonkupsch.com'
  return trustedFrontend && trustedApiHost
}

let cachedClient: ReturnType<typeof jwksClient> | null = null
const getClient = () => {
  if (!cachedClient && TEAM_DOMAIN) {
    cachedClient = jwksClient({
      jwksUri: `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`,
      cache: true,
      cacheMaxAge: 600_000,
    })
  }
  return cachedClient
}

const getKey = (header: jwt.JwtHeader): Promise<string> =>
  new Promise((resolve, reject) => {
    const client = getClient()
    if (!client) return reject(new Error('JWKS not configured'))
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err)
      resolve(key!.getPublicKey())
    })
  })

// A request that originated on this host (dev, or a local reverse proxy like
// `tailscale serve`), not one Cloudflare forwarded. Decided on the actual
// socket peer address only: X-Forwarded-For and req.ip are client-controlled
// under `trust proxy` and must never grant access.
export function isLoopbackReq(req: Pick<IncomingMessage, 'socket' | 'headers'>): boolean {
  const socketIP = req.socket.remoteAddress || ''
  const fromCloudflare = req.headers['cf-ray'] || req.headers['cf-connecting-ip']
  const loopbacks = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  return loopbacks.includes(socketIP) && !fromCloudflare
}

// A request from a Tailscale peer: the socket peer address is in the tailnet
// CGNAT range 100.64.0.0/10 (Node reports v4 as ::ffff:-mapped) or Tailscale's
// ULA v6 prefix. Devices on the tailnet are already authenticated by WireGuard
// key, so these requests are trusted like loopback. Same socket-only rule as
// isLoopbackReq — never derived from forwarded headers.
const TAILNET_V4 = /^(?:::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const TAILNET_V6 = /^fd7a:115c:a1e0:/i
export function isTailnetReq(req: Pick<IncomingMessage, 'socket' | 'headers'>): boolean {
  const socketIP = req.socket.remoteAddress || ''
  const fromCloudflare = req.headers['cf-ray'] || req.headers['cf-connecting-ip']
  return !fromCloudflare && (TAILNET_V4.test(socketIP) || TAILNET_V6.test(socketIP))
}

// Verify a Cloudflare Access JWT (RS256, JWKS-backed). Returns payload or null.
async function verifyCfAccessToken(token: string | undefined): Promise<jwt.JwtPayload | null> {
  if (!token || !TEAM_DOMAIN || !AUD) return null
  try {
    const decoded = jwt.decode(token, { complete: true })
    if (!decoded || typeof decoded === 'string') return null
    const key = await getKey(decoded.header)
    return jwt.verify(token, key, { audience: AUD, issuer: `https://${TEAM_DOMAIN}`, algorithms: ['RS256'] }) as jwt.JwtPayload
  } catch {
    return null
  }
}

function bearer(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const h = String(req.headers['authorization'] || '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isLoopbackReq(req) || isTailnetReq(req)) return next()

  // 1a. Image-scoped query token, honored ONLY for the poster proxy. <img>
  //     tags can't set headers, so the token rides the URL — which lands in
  //     proxy logs and browser caches. That's why it's a separate short-lived
  //     token that grants nothing but this route (and why the full app token
  //     is never accepted from a query string).
  if (req.method === 'GET' && req.path === '/plex/img'
    && typeof req.query.token === 'string' && verifyImgToken(req.query.token)) {
    return next()
  }

  // 1b. App token (Bearer).
  const appPayload = verifyAppToken(bearer(req))
  if (appPayload) {
    ;(req as Request & { user: jwt.JwtPayload }).user = appPayload
    return next()
  }

  // 2. Cloudflare Access JWT.
  const cfToken = req.headers['cf-access-jwt-assertion'] as string | undefined
  if (cfToken) {
    if (!TEAM_DOMAIN || !AUD) {
      console.error('[auth] Cloudflare Access not configured', { teamDomain: Boolean(TEAM_DOMAIN), aud: Boolean(AUD) })
      return res.status(503).json({ error: 'auth not configured' })
    }
    const verified = await verifyCfAccessToken(cfToken)
    if (verified) {
      ;(req as Request & { user: jwt.JwtPayload }).user = verified
      return next()
    }
    if (ALLOW_LOCAL) console.warn('[auth] invalid cf-access token', { path: req.path })
    return res.status(401).json({ error: 'invalid token' })
  }

  // 4. Legacy no-token bypass (migration only). Removed when AUTH_STRICT is on.
  if (!AUTH_STRICT && isTrustedLegacyPair(req)) {
    console.warn('[auth] LEGACY no-token bypass (set AUTH_STRICT=1 to disable)', { path: req.path, origin: req.headers.origin, host: req.headers.host })
    return next()
  }

  if (ALLOW_LOCAL) console.warn('[auth] unauthorized', { path: req.path, method: req.method, origin: req.headers.origin, host: req.headers.host })
  return res.status(401).json({ error: 'unauthorized' })
}

// Authorize a WebSocket upgrade. Accepts an app token via ?token=, a Cloudflare
// Access JWT header (transitional), or a loopback dev connection.
export async function authorizeUpgrade(req: IncomingMessage): Promise<boolean> {
  if (isLoopbackReq(req) || isTailnetReq(req)) return true
  try {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
    if (verifyAppToken(token)) return true
  } catch { /* malformed url */ }
  if (verifyAppToken(bearer(req))) return true
  const cfToken = req.headers['cf-access-jwt-assertion'] as string | undefined
  if (cfToken && (await verifyCfAccessToken(cfToken))) return true
  // Legacy: WS was previously unauthenticated at the app layer (edge-protected
  // only). Keep that until cutover so live Code Deck connections don't drop.
  if (!AUTH_STRICT) {
    console.warn('[auth] LEGACY ws upgrade without token (set AUTH_STRICT=1 to enforce)')
    return true
  }
  return false
}

// ------------------------------------------------------- strong auth ----
// Same credentials as requireAuth MINUS the legacy no-token bypass.
//
// That bypass lets a request through with no credential at all as long as its
// Origin and Host look like the published frontend talking to the published
// API, both of which a caller sets freely. For a chart that is a cosmetic
// risk. For /api/terminal it would be a shell on this box for anyone who can
// reach the hostname, so these two are what the terminal routes and the
// terminal websocket use, and they stay strict whether or not AUTH_STRICT is
// on.

export async function isStrongAuth(req: Pick<IncomingMessage, 'socket' | 'headers' | 'url'>): Promise<boolean> {
  if (isLoopbackReq(req) || isTailnetReq(req)) return true
  if (verifyAppToken(bearer(req))) return true
  try {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
    if (verifyAppToken(token)) return true
  } catch { /* malformed url */ }
  const cfToken = req.headers['cf-access-jwt-assertion'] as string | undefined
  if (cfToken && (await verifyCfAccessToken(cfToken))) return true
  return false
}

export async function requireStrongAuth(req: Request, res: Response, next: NextFunction) {
  if (await isStrongAuth(req)) return next()
  console.warn('[auth] terminal request refused', { path: req.path, origin: req.headers.origin, host: req.headers.host })
  return res.status(401).json({
    error: 'unauthorized',
    detail: 'the terminal needs the tailnet or a signed-in app token',
  })
}

export function authorizeStrongUpgrade(req: IncomingMessage): Promise<boolean> {
  return isStrongAuth(req)
}
