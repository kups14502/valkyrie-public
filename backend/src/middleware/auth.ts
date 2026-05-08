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
    if (remoteIP === '127.0.0.1' || remoteIP === '::1' || remoteIP === '::ffff:127.0.0.1') {
      return next()
    }
  }

  const token = req.headers['cf-access-jwt-assertion'] as string | undefined
  if (!token) return res.status(401).json({ error: 'unauthorized' })

  if (!TEAM_DOMAIN || !AUD) {
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
    res.status(401).json({ error: 'invalid token', detail: (err as Error).message })
  }
}
