import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const router = Router()

const TRACKED = [
  '/home/brendon/master-control',
  '/home/brendon/msp-platform',
  '/home/brendon/slop-factory',
  '/home/brendon/trading',
  '/home/brendon/infra',
]

const HOUR = 1000 * 60 * 60

const fmtRelative = (date: Date) => {
  const diff = Date.now() - date.getTime()
  if (diff < HOUR) return `${Math.floor(diff / 60000)}m ago`
  if (diff < HOUR * 24) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / (HOUR * 24))}d ago`
}

const statusFor = (mtime: Date): 'active' | 'paused' | 'idle' => {
  const days = (Date.now() - mtime.getTime()) / (HOUR * 24)
  if (days < 2) return 'active'
  if (days < 14) return 'paused'
  return 'idle'
}

router.get('/projects', async (_req, res) => {
  const out = await Promise.all(
    TRACKED.map(async (p) => {
      try {
        const stat = await fs.stat(p)
        return {
          name: path.basename(p),
          path: p,
          status: statusFor(stat.mtime),
          lastTouched: fmtRelative(stat.mtime),
        }
      } catch {
        return null
      }
    }),
  )
  res.json(out.filter(Boolean))
})

export default router
