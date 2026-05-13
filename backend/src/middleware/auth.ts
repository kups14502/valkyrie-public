import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN
const AUD = process.env.CF_ACCESS_AUD
const ALLOW_LOCAL = process.env.NODE_ENV !== 'production'

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

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (ALLOW_LOCAL) {
    const remoteIP = req.ip || req.socket.remoteAddress || ''
    const socketIP = req.socket.remoteAddress || ''
    const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    const fromCloudflare = req.headers['cf-ray'] || req.headers['cf-connecting-ip']
    const isLoopback = remoteIP === '127.0.0.1' || remoteIP === '::1' || remoteIP === '::ffff:127.0.0.1' || socketIP === '127.0.0.1' || socketIP === '::1' || socketIP === '::ffff:127.0.0.1' || forwardedFor.includes('127.0.0.1') || forwardedFor.includes('::1')
    console.log('[auth-check]', { remoteIP, socketIP, forwardedFor, hasCfRay: Boolean(req.headers['cf-ray']), hasCfConnectingIp: Boolean(req.headers['cf-connecting-ip']), isLoopback })
    if (isLoopback && !fromCloudflare) {
      return next()
    }
  }

  const token = req.headers['cf-access-jwt-assertion'] as string | undefined
  if (!token) {
    const origin = String(req.headers.origin || '')
    const host = String(req.headers.host || '')
    const trustedPagesPreview = /^https:\/\/[a-z0-9-]+\.master-control-72u\.pages\.dev$/i.test(origin)
    const trustedFrontend = origin === 'https://master-control.brendonkupsch.com' || trustedPagesPreview
    const trustedApiHost = host === 'master-control-api.brendonkupsch.com' || host === 'api.brendonkupsch.com'
    if (trustedFrontend && trustedApiHost) {
      console.warn('[auth] bypassing missing JWT for trusted frontend/api pairing', { origin, host, path: req.path })
      return next()
    }

    console.warn('[auth] missing cf-access-jwt-assertion', {
      path: req.path,
      method: req.method,
      origin: req.headers.origin,
      host: req.headers.host,
      cfRay: req.headers['cf-ray'],
      userAgent: req.headers['user-agent'],
    })
    return res.status(401).json({ error: 'unauthorized', detail: 'missing cf-access-jwt-assertion' })
  }

  if (!TEAM_DOMAIN || !AUD) {
    console.error('[auth] Cloudflare Access not configured', {
      teamDomain: Boolean(TEAM_DOMAIN),
      aud: Boolean(AUD),
    })
    return res.status(503).json({ error: 'auth not configured' })
  }

  try {
    const decoded = jwt.decode(token, { complete: true })
    if (!decoded || typeof decoded === 'string') throw new Error('invalid token')
    const key = await getKey(decoded.header)
    const verified = jwt.verify(token, key, {
      audience: AUD,
      issuer: `https://${TEAM_DOMAIN}`,
      algorithms: ['RS256'],
    })
    ;(req as Request & { user: jwt.JwtPayload }).user = verified as jwt.JwtPayload
    next()
  } catch (err) {
    console.warn('[auth] invalid token', {
      path: req.path,
      method: req.method,
      origin: req.headers.origin,
      host: req.headers.host,
      cfRay: req.headers['cf-ray'],
      detail: (err as Error).message,
    })
    res.status(401).json({ error: 'invalid token', detail: (err as Error).message })
  }
}
