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
//   3. Loopback and tailnet peers, decided on the socket address.
// Nothing else gets in. The migration-era origin/host pairing that let a
// request through with no credential was removed on 2026-09-28: Origin and
// Host are set by the caller, so they prove nothing.

const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN
const AUD = process.env.CF_ACCESS_AUD
const ALLOW_LOCAL = process.env.NODE_ENV !== 'production'
// Always true now. /api/auth/status still reports it, because clients built
// before the cutover read it to decide whether to offer a no-token skip.
export function isAuthStrict(): boolean { return true }

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

// Routes a media-scoped token (see auth/token.ts signImgToken) may open. Both
// stream bytes to a browser element that cannot send headers.
const MEDIA_TOKEN_PATHS = new Set(['/plex/img', '/plex/music/stream'])

function bearer(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const h = String(req.headers['authorization'] || '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isLoopbackReq(req) || isTailnetReq(req)) return next()

  // 1a. Media-scoped query token, honored ONLY for the poster proxy and the
  //     music stream. <img> and <audio> tags can't set headers, so the token
  //     rides the URL — which lands in proxy logs and browser caches. That's
  //     why it's a separate short-lived token that grants nothing but these
  //     routes (and why the full app token is never accepted from a query
  //     string).
  if (req.method === 'GET' && MEDIA_TOKEN_PATHS.has(req.path)
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

  if (ALLOW_LOCAL) console.warn('[auth] unauthorized', { path: req.path, method: req.method, origin: req.headers.origin, host: req.headers.host })
  return res.status(401).json({ error: 'unauthorized' })
}

// ------------------------------------------------------- strong auth ----
// The terminal's check. It takes requireAuth's credentials except the
// media-scoped query token, which must never open a shell, and it also reads
// the app token from ?token=, because a browser websocket cannot send headers.
// The terminal routes and the terminal websocket use these two.

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
