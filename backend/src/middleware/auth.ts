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
//   3. Processes on this host (loopback with no proxy in between), and the
//      tailnet devices named in TRUSTED_TAILNET_IPS. Any other tailnet node
//      needs a token like anyone else.
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

// Cloudflare always sets these and a client cannot remove them, so their
// absence means the request came over the tailnet or loopback. A client CAN
// add them, which only ever costs it the socket-address trust below.
export function viaCloudflare(req: Pick<IncomingMessage, 'headers'>): boolean {
  return Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip'])
}

type SocketReq = Pick<IncomingMessage, 'socket' | 'headers'>

const LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const TAILNET_V6 = /^fd7a:115c:a1e0:/i

const normIP = (ip: string) => ip.trim().toLowerCase().replace(/^::ffff:/, '')

// The tailnet devices trusted without a token, by Tailscale address (v4 and
// v6). The list lives in odin's .env, not here, because this repo is public.
// Entries outside the tailnet ranges are dropped, and an unset list trusts no
// tailnet device: servers, headsets and shared users all need a token.
const TRUSTED_TAILNET = new Set(
  (process.env.TRUSTED_TAILNET_IPS ?? '').split(',').map(normIP)
    .filter((ip) => TAILNET_V4.test(ip) || TAILNET_V6.test(ip)),
)
if (process.env.NODE_ENV === 'production' && TRUSTED_TAILNET.size === 0) {
  console.warn('[auth] TRUSTED_TAILNET_IPS is unset: every tailnet device needs a token')
}

function socketIsLoopback(req: SocketReq): boolean {
  return LOOPBACK_IPS.includes(req.socket.remoteAddress || '')
}

function hostName(req: SocketReq): string {
  const h = String(req.headers.host ?? '').toLowerCase()
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
}

// A loopback connection a local reverse proxy (`tailscale serve`) opened for a
// remote client: it carries X-Forwarded-For, or a Host that is not loopback.
// Processes on this host call 127.0.0.1:<port> with neither.
function proxiedLocally(req: SocketReq): boolean {
  return Boolean(req.headers['x-forwarded-for']) || !LOOPBACK_HOSTS.has(hostName(req))
}

// The client a local proxy forwarded for: the LAST X-Forwarded-For entry, the
// one the proxy appended itself. Earlier entries come from the client.
function forwardedClient(req: SocketReq): string | null {
  const raw = req.headers['x-forwarded-for']
  const parts = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length ? normIP(parts[parts.length - 1]) : null
}

// A request that originated on this host, not one Cloudflare or `tailscale
// serve` forwarded. Decided on the socket peer address; forwarded headers can
// only take this trust away, never grant it.
export function isLoopbackReq(req: SocketReq): boolean {
  return socketIsLoopback(req) && !viaCloudflare(req) && !proxiedLocally(req)
}

// A request from a trusted tailnet device: either straight to the tailnet
// listener (socket peer address), or through `tailscale serve`, which reaches
// us over loopback and names the peer in X-Forwarded-For. LAN packets claiming
// a tailnet source are dropped by tailscaled's ts-input chain.
export function isTailnetReq(req: SocketReq): boolean {
  if (viaCloudflare(req)) return false
  if (socketIsLoopback(req)) {
    if (!proxiedLocally(req)) return false
    const client = forwardedClient(req)
    return client !== null && TRUSTED_TAILNET.has(client)
  }
  return TRUSTED_TAILNET.has(normIP(req.socket.remoteAddress || ''))
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
