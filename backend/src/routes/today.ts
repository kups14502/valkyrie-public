import { Router, type Request, type Response } from 'express'
import { ProjError } from '../lib/projectTypes.js'
import { capture, recentCaptures, undoCapture } from '../lib/capture.js'
import { todaysBrief, writeBrief } from '../lib/brief.js'

// The Today page's own endpoints: the Capture line (lib/capture.ts) and the
// morning brief (lib/brief.ts). Calendar, tasks, inbox and sessions come from
// their own routes.

const router = Router()

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof ProjError
      if (!known) console.error('[today]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? (e as ProjError).status : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

router.post('/capture', h((req, res) => {
  res.json({ ok: true, capture: capture((req.body ?? {}).text) })
}))

router.get('/capture', h((req, res) => {
  res.json({ captures: recentCaptures(Number(req.query.limit) || undefined) })
}))

router.post('/capture/:id/undo', h(async (req, res) => {
  res.json({ ok: true, capture: await undoCapture(String(req.params.id)) })
}))

router.get('/brief', h((_req, res) => {
  res.json({ brief: todaysBrief() })
}))

// Writes it in the background; the page polls GET /brief for the result.
router.post('/brief/refresh', h((_req, res) => {
  void writeBrief()
  res.json({ ok: true, brief: todaysBrief() })
}))

export default router
