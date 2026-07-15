import { Router } from 'express'
import { listQuests, createQuest, updateQuest, deleteQuest, addLink, deleteLink } from '../quests/store.js'

const router = Router()

// Store functions throw plain Errors for bad input ("title required", "quest
// not found", ...). Map those to 400s; anything else is a real 500.
function fail(res: import('express').Response, err: unknown, action: string) {
  const message = (err as Error).message || 'unknown error'
  const isInputError = /required|not found|invalid|cannot/.test(message)
  if (!isInputError) console.error(`[500] ${action}:`, err)
  res.status(isInputError ? 400 : 500).json({ error: action, detail: message })
}

router.get('/quests', (_req, res) => {
  try {
    res.json({ quests: listQuests() })
  } catch (err) {
    fail(res, err, 'failed to list quests')
  }
})

router.post('/quests', (req, res) => {
  try {
    const { title, detail, category, parentId, tracked } = req.body ?? {}
    res.json({ quest: createQuest({ title, detail, category, parentId, tracked }) })
  } catch (err) {
    fail(res, err, 'failed to create quest')
  }
})

router.patch('/quests/:id', (req, res) => {
  try {
    const { title, detail, category, status, tracked, sort } = req.body ?? {}
    res.json({ quest: updateQuest(req.params.id, { title, detail, category, status, tracked, sort }) })
  } catch (err) {
    fail(res, err, 'failed to update quest')
  }
})

router.delete('/quests/:id', (req, res) => {
  try {
    deleteQuest(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err, 'failed to delete quest')
  }
})

router.post('/quests/:id/links', (req, res) => {
  try {
    const { kind, ref, label } = req.body ?? {}
    res.json({ link: addLink(req.params.id, { kind, ref, label }) })
  } catch (err) {
    fail(res, err, 'failed to add link')
  }
})

router.delete('/quests/:id/links/:linkId', (req, res) => {
  try {
    deleteLink(req.params.id, Number(req.params.linkId))
    res.json({ ok: true })
  } catch (err) {
    fail(res, err, 'failed to delete link')
  }
})

export default router
