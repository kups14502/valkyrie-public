import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { requireAuth } from './middleware/auth.js'
import systemRoute from './routes/system.js'
import sessionsRoute from './routes/sessions.js'
import aiUsageRoute from './routes/aiUsage.js'
import projectsRoute from './routes/projects.js'

const app = express()
const PORT = Number(process.env.PORT) || 3001
const BIND = process.env.BIND || '127.0.0.1'

app.disable('x-powered-by')
app.set('trust proxy', 'loopback')
app.use(helmet())
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? true,
  credentials: true,
}))
app.use(express.json({ limit: '64kb' }))

app.get('/healthz', (_req, res) => res.json({ ok: true }))

app.use('/api', requireAuth)
app.use('/api', systemRoute)
app.use('/api', sessionsRoute)
app.use('/api', aiUsageRoute)
app.use('/api', projectsRoute)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ error: 'internal error' })
})

app.listen(PORT, BIND, () => {
  console.log(`Master Control API listening on ${BIND}:${PORT}`)
})
