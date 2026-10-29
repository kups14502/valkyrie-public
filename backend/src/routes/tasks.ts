import { Router, type Request, type Response } from 'express'
import { viaCloudflare } from '../middleware/auth.js'
import { KEY_RE, ProjError, type Ctx } from '../lib/projectTypes.js'
import {
  addTask, listTasks, nyToday, removeTask, restoreTask, taskAreas, taskProjects, updateTask, type TaskRef,
} from '../lib/tasksStore.js'

// The Tasks list's HTTP side; the rules are in lib/tasksStore.ts. A project
// task is addressed by its project, checklist tab and item id, a loose one by
// its own id. Through Cloudflare, tailnet-only projects and client-area loose
// tasks answer like ones that do not exist.

const router = Router()
const UI: Ctx = { actor: 'ui', via: 'ui' }

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof ProjError
      if (!known) console.error('[tasks]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? (e as ProjError).status : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

const ITEM_RE = /^[A-Za-z0-9_-]{1,64}$/

function projectRef(req: Request): TaskRef {
  const projectId = String(req.params.projectId)
  const tabId = String(req.params.tabId)
  const id = String(req.params.id)
  if (!KEY_RE.test(projectId) || !ITEM_RE.test(tabId) || !ITEM_RE.test(id)) throw new ProjError(404, 'no such task')
  return { kind: 'project', projectId, tabId, id }
}

const looseRef = (req: Request): TaskRef => ({ kind: 'loose', id: String(req.params.id) })
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>

router.get('/tasks', h((req, res) => {
  const hide = viaCloudflare(req)
  const view = req.query.view === 'done' ? 'done' : 'open'
  res.json({ view, today: nyToday(), tasks: listTasks({ view, hideTailnet: hide }), projects: taskProjects(hide), areas: taskAreas(hide) })
}))

router.post('/tasks', h((req, res) => {
  const b = body(req)
  res.json({ ok: true, task: addTask({ text: b.text, due: b.due, projectId: b.projectId, area: b.area }, UI, viaCloudflare(req)) })
}))

router.patch('/tasks/project/:projectId/:tabId/:id', h((req, res) => {
  res.json({ ok: true, task: updateTask(projectRef(req), body(req), UI, viaCloudflare(req)) })
}))

router.patch('/tasks/loose/:id', h((req, res) => {
  res.json({ ok: true, task: updateTask(looseRef(req), body(req), UI, viaCloudflare(req)) })
}))

router.delete('/tasks/project/:projectId/:tabId/:id', h((req, res) => {
  removeTask(projectRef(req), UI, viaCloudflare(req))
  res.json({ ok: true })
}))

router.delete('/tasks/loose/:id', h((req, res) => {
  removeTask(looseRef(req), UI, viaCloudflare(req))
  res.json({ ok: true })
}))

router.post('/tasks/loose/:id/restore', h((req, res) => {
  res.json({ ok: true, task: restoreTask(String(req.params.id), viaCloudflare(req)) })
}))

export default router
