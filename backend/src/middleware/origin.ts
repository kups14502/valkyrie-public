import type { Request, Response, NextFunction } from 'express'
import type { IncomingHttpHeaders } from 'node:http'
import { viaCloudflare } from './auth.js'

// Which browser origins may call the API, and which Host names a request may
// carry when it is trusted by its socket address. One module, so the CORS
// layer and the terminal websocket answer from the same lists.
//
// Both lists are exact. The old suffix rule ('*.ts.net', any 100.64/10 host)
// admitted a page on ANY tailnet, and Tailscale Funnel lets anyone publish one.
// A browser on Brendon's tailnet then carried that page's requests in through
// `tailscale serve`, which arrive from loopback and pass requireAuth with no
// credential. The tailnet's own names live in odin's .env, not here, because
// this repo is public:
//   TAILNET_ORIGINS  exact origins of the app as the tailnet serves it, for
//                    example the `tailscale serve` https name
//   ALLOWED_HOSTS    any further Host names a tailnet or loopback request uses

type WithHeaders = { headers: IncomingHttpHeaders }

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const hostOf = (s: string): string | null => {
  if (!s) return null
  try {
    return new URL(s.includes('://') ? s : 'http://' + s).hostname.toLowerCase()
  } catch {
    return null
  }
}

const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS)
const TAILNET_ORIGINS = list(process.env.TAILNET_ORIGINS)
// The dedicated Tauri apps run the web UI from a tauri:// (or tauri.localhost)
// origin.
const TAURI_ORIGINS = new Set(['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'])
const PAGES_RE = /^https:\/\/[a-z0-9-]+\.master-control-72u\.pages\.dev$/i
// Local dev runs vite on another port with no list set. Never in production:
// there an unset list must not mean "every site on the internet".
const DEV_ANY_ORIGIN = ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV !== 'production'

const ALLOWED_HOSTS = new Set(
  ['localhost', '127.0.0.1', '[::1]', 'odin', process.env.BIND, process.env.TAILNET_BIND,
    ...TAILNET_ORIGINS, ...list(process.env.ALLOWED_HOSTS)]
    .map((s) => hostOf(s ?? ''))
    .filter((s): s is string => Boolean(s)),
)

if (process.env.NODE_ENV === 'production' && TAILNET_ORIGINS.length === 0) {
  console.warn('[origin] TAILNET_ORIGINS is unset: the app served by `tailscale serve` will get 403 unknown host')
}

// DNS rebinding: a page on a name its owner points at odin's tailnet address
// reaches the tailnet listener with that name in Host, and would get the
// socket-address trust. Cloudflare only routes the tunnel's own hostnames, and
// a request carrying its headers never gets that trust anyway, so those pass.
export function isAllowedHost(req: WithHeaders): boolean {
  if (viaCloudflare(req)) return true
  const h = hostOf(String(req.headers.host ?? ''))
  return h !== null && ALLOWED_HOSTS.has(h)
}

export function isAllowedOrigin(origin: string, req: WithHeaders): boolean {
  if (ALLOWED_ORIGINS.includes(origin) || TAILNET_ORIGINS.includes(origin)) return true
  if (TAURI_ORIGINS.has(origin) || PAGES_RE.test(origin)) return true
  // The app this backend serves, calling its own API: a browser sends Origin
  // on a same-origin POST too. The Host it matches has passed isAllowedHost.
  try {
    if (new URL(origin).host === String(req.headers.host ?? '').toLowerCase()) return true
  } catch { /* 'null' and other opaque origins */ }
  return DEV_ANY_ORIGIN
}

const warned = new Set<string>()

export function hostGuard(req: Request, res: Response, next: NextFunction) {
  if (isAllowedHost(req)) return next()
  const host = String(req.headers.host ?? '').slice(0, 100)
  if (!warned.has(host) && warned.size < 100) {
    warned.add(host)
    console.warn('[origin] refused unknown host (add it to ALLOWED_HOSTS if it is ours)', { host, path: req.originalUrl.split('?')[0] })
  }
  return res.status(403).json({ error: 'unknown host' })
}
