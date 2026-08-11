import jwt from 'jsonwebtoken'
import { getJwtSecret } from './store.js'

// App session tokens for the dedicated desktop/mobile apps. Signed with the
// self-hosted secret (see store.getJwtSecret). Long-lived (30d) because the
// apps gate day-to-day reopen with a biometric/device unlock rather than a
// fresh login each time.

const TOKEN_TTL = '30d'
export const APP_TOKEN_SUBJECT = 'owner'

export type AppTokenPayload = jwt.JwtPayload & { sub: string }

export function signAppToken(): { token: string; expiresAt: number } {
  const token = jwt.sign({ sub: APP_TOKEN_SUBJECT, kind: 'app' }, getJwtSecret(), { expiresIn: TOKEN_TTL })
  const decoded = jwt.decode(token) as jwt.JwtPayload | null
  return { token, expiresAt: (decoded?.exp ?? 0) * 1000 }
}

// Verify a bearer/app token. Returns the payload, or null if missing/invalid.
// Rejects image-scoped tokens: those are URL-carried and must never grant
// general API access.
export function verifyAppToken(token: string | undefined | null): AppTokenPayload | null {
  if (!token) return null
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload
    if (payload.sub !== APP_TOKEN_SUBJECT) return null
    if (payload.kind === 'img') return null
    return payload as AppTokenPayload
  } catch {
    return null
  }
}

// Image-scoped tokens ride in <img> URLs (query string), which end up in proxy
// logs and browser caches — so they are short-lived and good for nothing but
// the poster proxy.
const IMG_TOKEN_TTL = '12h'

export function signImgToken(): { token: string; expiresAt: number } {
  const token = jwt.sign({ sub: APP_TOKEN_SUBJECT, kind: 'img' }, getJwtSecret(), { expiresIn: IMG_TOKEN_TTL })
  const decoded = jwt.decode(token) as jwt.JwtPayload | null
  return { token, expiresAt: (decoded?.exp ?? 0) * 1000 }
}

export function verifyImgToken(token: string | undefined | null): boolean {
  if (!token) return false
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload
    return payload.sub === APP_TOKEN_SUBJECT && payload.kind === 'img'
  } catch {
    return false
  }
}
