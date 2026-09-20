import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import helmet from 'helmet'
import { requireAuth } from './middleware/auth.js'
import authRoute from './routes/auth.js'
import updatesRoute from './routes/updates.js'
import systemRoute from './routes/system.js'
import hostsRoute from './routes/hosts.js'
import sessionsRoute from './routes/sessions.js'
import aiUsageRoute from './routes/aiUsage.js'
import projectsRoute from './routes/projects.js'
import vaultRoute from './routes/vault.js'
import lightsRoute from './routes/lights.js'
import tradingRoute from './routes/trading.js'
import tradebotRoute from './routes/tradebot.js'
import slopfactoryRoute from './routes/slopfactory.js'
import activityRoute from './routes/activity.js'
import servicesRoute from './routes/services.js'
import launcherRoute from './routes/launcher.js'
import plexRoute from './routes/plex.js'
import workspacesRoute from './routes/workspaces.js'
import hostLaunchRoute from './routes/hostLaunch.js'
import terminalRoute, { attachTerminalWs } from './routes/terminal.js'
import calendarRoute from './routes/calendar.js'
import mealsRoute from './routes/meals.js'
import supplementsRoute from './routes/supplements.js'
import { startAlerts } from './alerts.js'

// Keep the process alive on stray errors. A single unhandled rejection or
// exception (e.g. a transient error inside a poller) would otherwise kill the
// whole backend.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

const app = express()
const server = createServer(app)
const PORT = Number(process.env.PORT) || 3001
const BIND = process.env.BIND || '127.0.0.1'

app.disable('x-powered-by')
app.set('trust proxy', true)
// CSP off: this server also serves the built frontend (tailnet access), whose
// HTML loads Google Fonts and TMDB posters; helmet's default CSP (and its
// upgrade-insecure-requests) would break it over plain-http tailnet origins.
// CORP cross-origin: the Plex poster proxy is embedded as <img> from the
// Cloudflare Pages origin, which same-origin CORP would block.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
// The dedicated Tauri apps run the web UI from a tauri:// (or tauri.localhost)
// origin — allow those so their API calls aren't CORS-blocked.
const TAURI_ORIGINS = new Set(['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'])
// Origins that reach us over the tailnet (the app served from this box on the
// tailscale interface, or via `tailscale serve` at *.ts.net). The socket-level
// tailnet/loopback check in requireAuth is what actually authorizes them; this
// only keeps the browser's CORS preflight from rejecting the origin header.
const isTailnetOrigin = (origin: string) => {
  try {
    const host = new URL(origin).hostname
    return host === 'odin' || host.endsWith('.ts.net')
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  } catch {
    return false
  }
}
const isAllowedOrigin = (origin: string) => {
  if (allowedOrigins.includes(origin)) return true
  if (TAURI_ORIGINS.has(origin)) return true
  if (/^https:\/\/[a-z0-9-]+\.master-control-72u\.pages\.dev$/i.test(origin)) return true
  if (isTailnetOrigin(origin)) return true
  return false
}
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (allowedOrigins.length === 0 || isAllowedOrigin(origin)) return callback(null, true)
    console.warn('[cors] blocked origin', { origin })
    return callback(new Error(`Origin not allowed: ${origin}`))
  },
  credentials: true,
}))
// 1mb everywhere, except the endpoints that carry a photo: a meal snapshot is
// a few megabytes of base64 and the global limit would 413 it before the route
// ever ran.
const jsonSmall = express.json({ limit: '1mb' })
const jsonLarge = express.json({ limit: '12mb' })
const LARGE_BODY_PATHS = new Set(['/api/meals/estimate'])
app.use((req, res, next) => (LARGE_BODY_PATHS.has(req.path) ? jsonLarge : jsonSmall)(req, res, next))

app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    console.log('[request]', {
      method: req.method,
      path: req.path,
      host: req.headers.host,
      origin: req.headers.origin,
      hasCfAccessJwt: Boolean(req.headers['cf-access-jwt-assertion']),
      cfRay: req.headers['cf-ray'],
      ip: req.ip,
    })
  }
  next()
})

app.get('/healthz', (_req, res) => res.json({ ok: true }))

// Public endpoints (no token required): auth (login/setup/status) and the
// desktop app's auto-update mirror.
app.use('/api', authRoute)
app.use('/api', updatesRoute)

app.use('/api', requireAuth)
app.use('/api', systemRoute)
app.use('/api', hostsRoute)
app.use('/api', sessionsRoute)
app.use('/api', aiUsageRoute)
app.use('/api', projectsRoute)
app.use('/api', vaultRoute)
app.use('/api', lightsRoute)
app.use('/api', tradingRoute)
app.use('/api', tradebotRoute)
app.use('/api', slopfactoryRoute)
app.use('/api', activityRoute)
app.use('/api', servicesRoute)
app.use('/api', launcherRoute)
app.use('/api', plexRoute)
app.use('/api', workspacesRoute)
app.use('/api', hostLaunchRoute)
app.use('/api', terminalRoute)
app.use('/api', calendarRoute)
app.use('/api', mealsRoute)
app.use('/api', supplementsRoute)

// Serve the built web frontend when it's present (odin serves the app to
// tailnet devices this way — same origin as the API, so iPhone/iPad hit
// http://<odin tailscale ip>:8420 and everything just works with no login).
// FRONTEND_DIST overrides; the default resolves to ../frontend/dist from
// backend/dist/index.js as well as from backend/src via tsx.
const distCandidates = [
  process.env.FRONTEND_DIST,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist'),
  path.resolve(process.cwd(), '../frontend/dist'),
].filter((p): p is string => Boolean(p))
const FRONTEND_DIST = distCandidates.find((p) => existsSync(path.join(p, 'index.html')))
if (FRONTEND_DIST) {
  app.use(express.static(FRONTEND_DIST, {
    setHeaders(res, filePath) {
      // Hashed bundles can cache forever; index.html must always revalidate so
      // a deploy is picked up on the next open (no service worker on plain-http
      // tailnet origins to do it for us).
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache')
      }
    },
  }))
  // SPA fallback: a real page navigation gets the app shell. Matched on the
  // Accept header containing text/html explicitly, NOT req.accepts('html'):
  // asset fetches send Accept: */* which req.accepts() happily matches, so a
  // missing file (e.g. manifest.webmanifest) came back as 200 index.html and
  // masked its own absence. Anything that isn't a navigation now 404s honestly.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/healthz') return next()
    if (!String(req.headers.accept || '').includes('text/html')) return next()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
  console.log(`[static] serving frontend from ${FRONTEND_DIST}`)
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

// The terminal websocket rides every listener this app has: the loopback
// one behind cloudflared, and the tailnet one below, which is the path the
// phone actually takes while it is on the tailnet.
attachTerminalWs(server)

server.listen(PORT, BIND, () => {
  console.log(`Valkyrie API listening on ${BIND}:${PORT}`)
  startAlerts()
})

// Optional second listener on the tailscale interface: tailnet devices talk to
// the API (and the static frontend above) directly, and requireAuth trusts
// them by their 100.64.0.0/10 socket address — no login, no Cloudflare.
const TAILNET_BIND = process.env.TAILNET_BIND
if (TAILNET_BIND) {
  const TAILNET_PORT = Number(process.env.TAILNET_PORT) || 8420
  const RETRY_MS = 15_000
  // At boot the tailscale interface often doesn't exist yet, so binding to its
  // address fails with EADDRNOTAVAIL. Retry instead of giving up, or a reboot
  // would silently leave the iPad/iPhone with no way in until a manual restart.
  const listenTailnet = () => {
    const tailnetServer = createServer(app)
    attachTerminalWs(tailnetServer)
    tailnetServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE') {
        console.warn(`[tailnet] ${err.code} binding ${TAILNET_BIND}:${TAILNET_PORT} — retrying in ${RETRY_MS / 1000}s`)
      } else {
        console.error('[tailnet] listener error', err)
      }
      tailnetServer.close()
      setTimeout(listenTailnet, RETRY_MS).unref()
    })
    tailnetServer.listen(TAILNET_PORT, TAILNET_BIND, () => {
      console.log(`Valkyrie tailnet listener on ${TAILNET_BIND}:${TAILNET_PORT}`)
    })
  }
  listenTailnet()
}
