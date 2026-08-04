import { Router } from 'express'
import { promises as fs } from 'node:fs'

const router = Router()

// Status file written atomically by /home/brendon/trade-bot/status.py (the v2
// bot's generator). We pass the document through untouched and only add a
// `stale` flag so the frontend doesn't have to reason about clocks.
const STATUS_FILE = '/home/brendon/trade-bot/logs/status.json'
const STALE_AFTER_MS = 10 * 60_000

router.get('/tradebot/status', async (_req, res) => {
  let raw: string
  try {
    raw = await fs.readFile(STATUS_FILE, 'utf8')
  } catch {
    return res.status(503).json({ error: 'status unavailable', detail: 'status.json missing (generator has not run yet)' })
  }
  let status: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    status = parsed as Record<string, unknown>
  } catch {
    return res.status(503).json({ error: 'status unavailable', detail: 'status.json unreadable (corrupt or torn write)' })
  }
  const generatedAt = Date.parse(String(status.generated_at ?? ''))
  const stale = !Number.isFinite(generatedAt) || Date.now() - generatedAt > STALE_AFTER_MS
  res.json({ ...status, stale })
})

export default router
