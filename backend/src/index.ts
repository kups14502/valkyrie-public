import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import cors from 'cors'
import helmet from 'helmet'
import { requireAuth } from './middleware/auth.js'
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
import codeDeckRoute, { attachCodeDeckWs } from './routes/codeDeck.js'
import { attachCodeDeckAgentWs } from './routes/codeDeckAgent.js'
import { startAlerts } from './alerts.js'

const app = express()
const server = createServer(app)
const PORT = Number(process.env.PORT) || 3001
const BIND = process.env.BIND || '127.0.0.1'

app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(helmet())

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
const isAllowedOrigin = (origin: string) => {
  if (allowedOrigins.includes(origin)) return true
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
app.use('/api', codeDeckRoute)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

attachCodeDeckWs(server)
attachCodeDeckAgentWs(server)

server.listen(PORT, BIND, () => {
  console.log(`Master Control API listening on ${BIND}:${PORT}`)
  startAlerts()
})
