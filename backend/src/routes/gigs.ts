import { Router } from 'express'
import { listGigs, createGig, updateGig, deleteGig, addLink, deleteLink } from '../gigs/store.js'

const router = Router()

// Store functions throw plain Errors for bad input ("title required", "gig
// not found", ...). Map those to 400s; anything else is a real 500.
function fail(res: import('express').Response, err: unknown, action: string) {
  const message = (err as Error).message || 'unknown error'
  const isInputError = /required|not found|invalid|cannot/.test(message)
  if (!isInputError) console.error(`[500] ${action}:`, err)
  res.status(isInputError ? 400 : 500).json({ error: action, detail: message })
}

router.get('/gigs', (_req, res) => {
  try {
    res.json({ gigs: listGigs() })
  } catch (err) {
    fail(res, err, 'failed to list gigs')
  }
})

router.post('/gigs', (req, res) => {
  try {
    const { title, detail, category, section, parentId, tracked } = req.body ?? {}
    res.json({ gig: createGig({ title, detail, category, section, parentId, tracked }) })
  } catch (err) {
    fail(res, err, 'failed to create gig')
  }
})

router.patch('/gigs/:id', (req, res) => {
  try {
    const { title, detail, category, section, status, tracked, sort } = req.body ?? {}
    res.json({ gig: updateGig(req.params.id, { title, detail, category, section, status, tracked, sort }) })
  } catch (err) {
    fail(res, err, 'failed to update gig')
  }
})

router.delete('/gigs/:id', (req, res) => {
  try {
    deleteGig(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err, 'failed to delete gig')
  }
})

router.post('/gigs/:id/links', (req, res) => {
  try {
    const { kind, ref, label } = req.body ?? {}
    res.json({ link: addLink(req.params.id, { kind, ref, label }) })
  } catch (err) {
    fail(res, err, 'failed to add link')
  }
})

router.delete('/gigs/:id/links/:linkId', (req, res) => {
  try {
    deleteLink(req.params.id, Number(req.params.linkId))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err, 'failed to delete link')
  }
})

export default router
