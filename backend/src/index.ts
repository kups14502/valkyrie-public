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
import sessionsRoute from './routes/sessions.js'
import aiUsageRoute from './routes/aiUsage.js'
import projectsRoute from './routes/projects.js'
import vaultRoute from './routes/vault.js'
import lightsRoute from './routes/lights.js'
import tradingRoute from './routes/trading.js'
import activityRoute from './routes/activity.js'
import servicesRoute from './routes/services.js'
import launcherRoute from './routes/launcher.js'
import emailsRoute from './routes/emails.js'
import emailSignalsRoute from './routes/emailSignals.js'
import gigsRoute from './routes/gigs.js'
import gigChatRoute from './routes/gigChat.js'
import intakeRoute from './routes/intake.js'
import assistantRoute from './assistant/index.js'
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
app.use(helmet())

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
// The dedicated Tauri apps run the web UI from a tauri:// (or tauri.localhost)
// origin — allow those so their API calls aren't CORS-blocked.
const TAURI_ORIGINS = new Set(['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'])
const isAllowedOrigin = (origin: string) => {
  if (allowedOrigins.includes(origin)) return true
  if (TAURI_ORIGINS.has(origin)) return true
  if (/^https:\/\/[a-z0-9-]+\.master-control-72u\.pages\.dev$/i.test(origin)) return true
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
app.use(express.json({ limit: '1mb' }))

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

// Kiosk build of the frontend (vite --base=/kiosk/ --outDir dist-kiosk),
// served by the backend itself so the odin touchscreen browser hits
// http://127.0.0.1:3001/kiosk/jarvis — same origin as the API, which makes the
// loopback auth bypass and mic capture (localhost = secure context) both work.
// Static assets only; all data still goes through /api and its auth.
const KIOSK_DIR = process.env.KIOSK_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist-kiosk')
const kioskCsp: express.RequestHandler = (_req, res, next) => {
  // Looser CSP than helmet's default: poster images come from TMDB et al.,
  // and TTS audio plays from blob: URLs.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'",
  )
  next()
}
app.use('/kiosk', kioskCsp, express.static(KIOSK_DIR, { index: 'index.html' }))
app.use('/kiosk', kioskCsp, (_req, res) => {
  const index = path.join(KIOSK_DIR, 'index.html')
  if (existsSync(index)) return res.sendFile(index)
  res.status(404).send('kiosk build missing — run: cd frontend && npm run build:kiosk')
})

// Public endpoints (no token required): auth (login/setup/status) and the
// desktop app's auto-update mirror.
app.use('/api', authRoute)
app.use('/api', updatesRoute)

app.use('/api', requireAuth)
app.use('/api', systemRoute)
app.use('/api', sessionsRoute)
app.use('/api', aiUsageRoute)
app.use('/api', projectsRoute)
app.use('/api', vaultRoute)
app.use('/api', lightsRoute)
app.use('/api', tradingRoute)
app.use('/api', activityRoute)
app.use('/api', servicesRoute)
app.use('/api', launcherRoute)
app.use('/api', emailsRoute)
app.use('/api', emailSignalsRoute)
app.use('/api', gigsRoute)
app.use('/api', gigChatRoute)
app.use('/api', intakeRoute)
app.use('/api', assistantRoute)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

server.listen(PORT, BIND, () => {
  console.log(`Valkyrie API listening on ${BIND}:${PORT}`)
  startAlerts()
})
