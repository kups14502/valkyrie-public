import { Router, type Request, type Response } from 'express'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import {
  listProjects, getProject, getProjectDoc, createProject, updateProject, archiveProject,
  addTab, updateTab, moveTab, removeTab, tabItem,
  pinFile, updateFile, unpinFile, getFileContent,
  getAutomation, saveAutomation, removeAutomation,
  takeRunBrief, linkSession, unlinkSession, addReminder, cancelReminder, reissueClientReminders, isClientArea,
  listEvents, undoEvent, revertActor, waitForChange,
} from '../lib/projectsStore.js'
import {
  KEY_RE, MIXABLE_AREAS, ProjError, UUID_RE,
  type Area, type Ctx, type FilePatch, type LinkedVia, type NewTabInput, type PinFileInput,
  type Project, type ProjectPatch, type SaveAutomationInput, type TabItemOp, type TabPatch,
} from '../lib/projectTypes.js'
import { AREAS } from '../lib/projectAreas.js'
import { takeDeskBrief } from '../lib/projectDesk.js'
import { viaCloudflare } from '../middleware/auth.js'

// The Projects page REST. Thin on purpose: the store (lib/projectsStore.ts)
// owns every rule about content, limits, history and undo, and the MCP route
// calls the same store functions, so a rule enforced here would only hold for
// the page and not for sessions. This file checks types and shapes, picks the
// actor and hides tailnet projects from Cloudflare.
//
// Bodies are never logged: tabs, pinned docs and reminders carry whatever
// Brendon or a session wrote, and api.log is plain text on odin.

const router = Router()

type Body = Record<string, unknown>

// thor's SessionStart hook relinks a conversation after /clear or a resume and
// names its launch session in this header. Its writes are then attributed to
// that session's hook instead of to 'ui', so the activity tab can tell a relink
// from a click.
function ctxOf(req: Request): Ctx {
  const sid = String(req.headers['x-valkyrie-session'] ?? '')
  return UUID_RE.test(sid) ? { actor: 'hook:' + sid, via: 'hook' } : { actor: 'ui', via: 'ui' }
}

// Client-area projects default to exposure 'tailnet'. Through Cloudflare
// such a project answers exactly like one that does not exist, so its name,
// paths and labels never leave the tailnet.
function visible(req: Request): Project {
  const id = String(req.params.id)
  if (!KEY_RE.test(id)) throw new ProjError(404, 'no such project')
  const p = getProject(id)
  if (!p || (viaCloudflare(req) && p.exposure === 'tailnet')) throw new ProjError(404, 'no such project')
  return p
}

// A project that moved into a client area (an edit, an undo) gets its
// full-text reminders rescheduled as pointers. lilkups is a process, so this
// runs after the change rather than inside it, and any reminder it could not
// reschedule is counted back to the page.
async function afterAreaChange(fromArea: Area, id: string): Promise<{ remindersUnchanged?: number }> {
  const p = getProject(id)
  if (!p || isClientArea(fromArea) || !isClientArea(p.area)) return {}
  const n = await reissueClientReminders(id)
  return n ? { remindersUnchanged: n } : {}
}

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof ProjError
      if (!known) console.error('[proj]', (e as Error).message)
      if (res.headersSent) return
      if (known) res.status(e.status).json({ error: e.message, ...(e.body ?? {}) })
      else res.status(500).json({ error: 'internal error' })
    }
  }
}

// ---------------------------------------------------------- body shapes ---

function bodyOf(req: Request): Body {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function str(b: Body, k: string): string | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ProjError(400, `${k} must be a string`)
  return v
}

function bool(b: Body, k: string): boolean | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new ProjError(400, `${k} must be true or false`)
  return v
}

function int(b: Body, k: string): number | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ProjError(400, `${k} must be a whole number`)
  return v
}

function oneOf<T extends string>(b: Body, k: string, values: readonly T[]): T | undefined {
  const v = str(b, k)
  if (v === undefined) return undefined
  if (!(values as readonly string[]).includes(v)) {
    throw new ProjError(400, `${k} must be one of ${values.map((x) => `'${x}'`).join(', ')}`)
  }
  return v as T
}

function need<T>(v: T | undefined, k: string): T {
  if (v === undefined) throw new ProjError(400, `${k} is required`)
  return v
}

// The store reads "key present" as "change it", so absent fields must not
// arrive as undefined-valued keys.
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function queryNum(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// A checklist is created from strings and a links tab from {label, url}; a
// mixed list has no meaning for either kind.
function tabItems(v: unknown): NewTabInput['items'] {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new ProjError(400, 'items must be a list')
  if (v.every((x) => typeof x === 'string')) return v as string[]
  const links = v.map((x) => (x && typeof x === 'object' ? x as Body : {}))
  if (links.every((x) => typeof x.label === 'string' && typeof x.url === 'string')) {
    return links.map((x) => ({ label: x.label as string, url: x.url as string }))
  }
  throw new ProjError(400, 'items must be all strings (checklist) or all {label, url} (links)')
}

function tabItemOp(b: Body): TabItemOp {
  const op = need(oneOf(b, 'op', ['add', 'set', 'edit', 'remove'] as const), 'op')
  const text = str(b, 'text')
  const label = str(b, 'label')
  const url = str(b, 'url')
  if (op === 'add') return defined({ op, text, label, url })
  const itemId = need(str(b, 'itemId'), 'itemId')
  if (op === 'set') return { op, itemId, done: need(bool(b, 'done'), 'done') }
  if (op === 'edit') return defined({ op, itemId, text, label, url })
  return { op, itemId }
}

const LINK_VIAS = ['link', 'startup', 'resume', 'clear'] as const satisfies readonly LinkedVia[]

// ------------------------------------------------------------- projects ---

// The area list includes odin's extras, so the page never hardcodes them.
// Not /proj/areas: 'areas' is a valid project id.
router.get('/proj-areas', h((_req, res) => {
  res.json({ areas: AREAS, mixable: MIXABLE_AREAS })
}))

router.get('/proj', h((req, res) => {
  const rows = listProjects({ includeArchived: req.query.archived === '1' })
  res.json(viaCloudflare(req) ? rows.filter((p) => p.exposure !== 'tailnet') : rows)
}))

router.post('/proj', h(async (req, res) => {
  const b = bodyOf(req)
  const area = need(oneOf(b, 'area', AREAS), 'area')
  // Created through Cloudflare, a tailnet-only project would answer 404 to
  // the very client that made it, from its first refetch on.
  if (viaCloudflare(req) && isClientArea(area)) {
    throw new ProjError(403, `${area} projects are tailnet-only: create this one from the tailnet`)
  }
  const p = createProject(defined({
    name: need(str(b, 'name'), 'name'),
    area,
    targetKey: need(str(b, 'targetKey'), 'targetKey'),
    id: str(b, 'id'),
    summary: str(b, 'summary'),
  }), ctxOf(req))
  res.status(201).json(await getProjectDoc(p.id))
}))

router.get('/proj/:id', h(async (req, res) => {
  res.json(await getProjectDoc(visible(req).id))
}))

router.patch('/proj/:id', h(async (req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const patch: ProjectPatch = defined({
    name: str(b, 'name'),
    summary: str(b, 'summary'),
    nextAction: str(b, 'nextAction'),
    status: oneOf(b, 'status', ['active', 'paused'] as const),
    area: oneOf(b, 'area', AREAS),
    targetKey: str(b, 'targetKey'),
    exposure: oneOf(b, 'exposure', ['tailnet', 'anywhere'] as const),
    sessionEdits: bool(b, 'sessionEdits'),
    allowSnapshots: bool(b, 'allowSnapshots'),
  })
  // The move would reset exposure to tailnet and hide the project from the
  // client making it. An explicit 'tailnet' is a choice the edit sheet
  // already explains, so only the implied one is refused.
  if (viaCloudflare(req) && patch.area !== undefined && patch.area !== p.area && isClientArea(patch.area)
    && patch.exposure !== 'anywhere' && patch.exposure !== 'tailnet') {
    throw new ProjError(403, `moving a project into ${patch.area} hides it from Cloudflare: do this from the tailnet`)
  }
  updateProject(p.id, patch, ctxOf(req))
  const extra = await afterAreaChange(p.area, p.id)
  res.json({ ...(await getProjectDoc(p.id)), ...extra })
}))

router.post('/proj/:id/archive', h((req, res) => {
  archiveProject(visible(req).id, ctxOf(req))
  res.json({ ok: true })
}))

// The page's live update. Answers at once when the project moved past `rev`,
// otherwise holds until a change or 25 s, well inside Cloudflare's 100 s cut
// of a silent response. A client that leaves releases its listener through
// the abort instead of holding it for the full 25 s.
router.get('/proj/:id/changes', h(async (req, res) => {
  const p = visible(req)
  const since = Number(req.query.rev) || 0
  const ac = new AbortController()
  res.on('close', () => ac.abort())
  const out = await waitForChange(p.id, since, 25_000, ac.signal)
  if (!ac.signal.aborted) res.set('Cache-Control', 'no-store').json(out)
}))

router.get('/proj/:id/events', h((req, res) => {
  const p = visible(req)
  res.json(listEvents(p.id, {
    before: queryNum(req.query.before),
    limit: queryNum(req.query.limit),
    actor: typeof req.query.actor === 'string' && req.query.actor ? req.query.actor : undefined,
  }))
}))

router.post('/proj/:id/events/:eventId/undo', h(async (req, res) => {
  const p = visible(req)
  const eventId = Number(req.params.eventId)
  if (!Number.isInteger(eventId)) throw new ProjError(404, 'no such event')
  const { rev } = undoEvent(p.id, eventId, { force: bodyOf(req).force === true }, ctxOf(req))
  res.json({ ok: true, rev, ...(await afterAreaChange(p.area, p.id)) })
}))

router.post('/proj/:id/revert', h(async (req, res) => {
  const p = visible(req)
  const out = revertActor(p.id, need(str(bodyOf(req), 'actor'), 'actor'), ctxOf(req))
  res.json({ ...out, ...(await afterAreaChange(p.area, p.id)) })
}))

// ----------------------------------------------------------------- tabs ---

router.post('/proj/:id/tabs', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const input: NewTabInput = defined({
    kind: need(oneOf(b, 'kind', ['markdown', 'checklist', 'links'] as const), 'kind'),
    title: need(str(b, 'title'), 'title'),
    body: str(b, 'body'),
    items: tabItems(b.items),
    position: oneOf(b, 'position', ['start', 'end'] as const),
  })
  res.status(201).json(addTab(p.id, input, ctxOf(req)))
}))

router.patch('/proj/:id/tabs/:tabId', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const patch: TabPatch = defined({
    baseRev: int(b, 'baseRev'),
    title: str(b, 'title'),
    body: str(b, 'body'),
    appendBody: str(b, 'appendBody'),
  })
  res.json(updateTab(p.id, String(req.params.tabId), patch, ctxOf(req)))
}))

router.post('/proj/:id/tabs/:tabId/items', h((req, res) => {
  const p = visible(req)
  res.json(tabItem(p.id, String(req.params.tabId), tabItemOp(bodyOf(req)), ctxOf(req)))
}))

router.post('/proj/:id/tabs/:tabId/move', h((req, res) => {
  const p = visible(req)
  const toIndex = need(int(bodyOf(req), 'toIndex'), 'toIndex')
  moveTab(p.id, String(req.params.tabId), toIndex, ctxOf(req))
  res.json({ ok: true })
}))

router.delete('/proj/:id/tabs/:tabId', h((req, res) => {
  const p = visible(req)
  removeTab(p.id, String(req.params.tabId), ctxOf(req))
  res.json({ ok: true })
}))

// ---------------------------------------------------------------- files ---

const CONTENT_TYPES = ['markdown', 'text'] as const

router.post('/proj/:id/files', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const input: PinFileInput = defined({
    kind: need(oneOf(b, 'kind', ['path', 'url', 'doc'] as const), 'kind'),
    label: need(str(b, 'label'), 'label'),
    relPath: str(b, 'relPath'),
    url: str(b, 'url'),
    note: str(b, 'note'),
    content: str(b, 'content'),
    contentType: oneOf(b, 'contentType', CONTENT_TYPES),
  })
  res.status(201).json(pinFile(p.id, input, ctxOf(req)))
}))

router.patch('/proj/:id/files/:fileId', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const patch: FilePatch = defined({
    label: str(b, 'label'),
    note: str(b, 'note'),
    content: str(b, 'content'),
    contentType: oneOf(b, 'contentType', CONTENT_TYPES),
  })
  res.json(updateFile(p.id, String(req.params.fileId), patch, ctxOf(req)))
}))

router.delete('/proj/:id/files/:fileId', h((req, res) => {
  const p = visible(req)
  unpinFile(p.id, String(req.params.fileId), ctxOf(req))
  res.json({ ok: true })
}))

router.get('/proj/:id/files/:fileId/content', h((req, res) => {
  const p = visible(req)
  res.json(getFileContent(p.id, String(req.params.fileId)))
}))

// ------------------------------------------------------- folder files ---
// The project folder itself, browsed and read through thor's project-files
// service (C:\Thor\tools\session-board\project-files). odin passes the
// project's folder KEY and a relative path; thor resolves and guards both.
// Contents stream through and are never stored here, client areas included:
// the page shows what is on thor's disk, the same as a session there reads it.

const FILES_URL = process.env.PROJECT_FILES_URL || 'http://100.118.7.57:8767'
const FILES_TOKEN = process.env.PROJECT_FILES_TOKEN || ''

// Only these leave odin with their own type. Everything else is plain text or
// a download, so a file in the folder can never run as a page on this origin.
const SAFE_TYPES = /^(text\/plain|application\/pdf|image\/(png|jpeg|gif|webp|bmp))\b/

async function thorFiles(pathAndQuery: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<globalThis.Response> {
  if (!FILES_TOKEN) throw new ProjError(503, 'PROJECT_FILES_TOKEN is not set on the api host')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 15_000)
  try {
    return await fetch(FILES_URL + pathAndQuery, {
      ...init,
      signal: ac.signal,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${FILES_TOKEN}` },
    })
  } catch (e) {
    throw new ProjError(502, `thor's file service is not answering (${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message})`)
  } finally {
    clearTimeout(timer)
  }
}

async function thorError(r: globalThis.Response): Promise<never> {
  let msg = `thor answered ${r.status}`
  try { msg = ((await r.json()) as { error?: string }).error || msg } catch { /* not json */ }
  throw new ProjError(r.status >= 500 ? 502 : r.status, msg)
}

const relOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v : ''
  if (s.length > 1024) throw new ProjError(400, 'path too long')
  return s
}

router.get('/proj/:id/fs/tree', h(async (req, res) => {
  const p = visible(req)
  const q = new URLSearchParams({ target: p.targetKey, rel: relOf(req.query.rel) })
  const r = await thorFiles(`/tree?${q}`)
  if (!r.ok) await thorError(r)
  res.set('Cache-Control', 'no-store').json(await r.json())
}))

router.get('/proj/:id/fs/file', h(async (req, res) => {
  const p = visible(req)
  const q = new URLSearchParams({ target: p.targetKey, rel: relOf(req.query.rel) })
  const range = typeof req.headers.range === 'string' ? { Range: req.headers.range } : undefined
  const r = await thorFiles(`/file?${q}`, { headers: range })
  if (!r.ok && r.status !== 206) await thorError(r)
  const type = r.headers.get('content-type') || 'application/octet-stream'
  const safe = SAFE_TYPES.test(type)
  res.status(r.status)
  res.set({
    'Content-Type': safe ? type : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  })
  if (!safe) res.set('Content-Disposition', 'attachment')
  for (const name of ['content-length', 'content-range', 'last-modified']) {
    const v = r.headers.get(name)
    if (v) res.set(name, v)
  }
  if (!r.body) return res.end()
  const body = Readable.fromWeb(r.body as unknown as WebReadableStream)
  res.on('close', () => body.destroy())
  body.on('error', () => res.destroy())
  body.pipe(res)
}))

router.post('/proj/:id/fs/open', h(async (req, res) => {
  const p = visible(req)
  const r = await thorFiles('/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: p.targetKey, rel: relOf(bodyOf(req).rel) }),
  })
  if (!r.ok) await thorError(r)
  res.json({ ok: true })
}))

// ---------------------------------------------------------- automations ---

router.get('/proj/:id/automations/:key', h((req, res) => {
  const p = visible(req)
  res.json(getAutomation(p.id, String(req.params.key)))
}))

router.put('/proj/:id/automations/:key', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const input: SaveAutomationInput = defined({
    kind: need(oneOf(b, 'kind', ['agent', 'workflow'] as const), 'kind'),
    name: need(str(b, 'name'), 'name'),
    description: str(b, 'description'),
    body: need(str(b, 'body'), 'body'),
    model: oneOf(b, 'model', ['', 'opus', 'sonnet', 'haiku'] as const),
    baseRev: int(b, 'baseRev'),
  })
  res.json(saveAutomation(p.id, String(req.params.key), input, ctxOf(req)))
}))

router.delete('/proj/:id/automations/:key', h((req, res) => {
  const p = visible(req)
  removeAutomation(p.id, String(req.params.key), ctxOf(req))
  res.json({ ok: true })
}))

// ----------------------------------------------------------------- runs ---

// Remote-Session.ps1 on thor is the only caller. The brief is handed out once,
// so a replayed ssh line cannot start the same run a second time.
router.get('/proj/:id/runs/:runId/brief', h((req, res) => {
  const p = visible(req)
  const runId = String(req.params.runId)
  if (!UUID_RE.test(runId)) throw new ProjError(404, 'no such run')
  res.json(takeRunBrief(p.id, runId))
}))

// A new-project session's brief (lib/projectDesk.ts). Same reply shape as a
// run brief, so Remote-Session.ps1 reads both with one function.
router.get('/proj-desk/briefs/:runId', h((req, res) => {
  const runId = String(req.params.runId)
  if (!UUID_RE.test(runId)) throw new ProjError(404, 'no such brief')
  res.json(takeDeskBrief(runId))
}))

// ------------------------------------------------------------- sessions ---

router.post('/proj/:id/sessions/link', h((req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const sessionId = str(b, 'sessionId') ?? ''
  if (!UUID_RE.test(sessionId)) throw new ProjError(400, 'sessionId must be a uuid')
  const launchSessionId = str(b, 'launchSessionId')
  if (launchSessionId !== undefined && !UUID_RE.test(launchSessionId)) {
    throw new ProjError(400, 'launchSessionId must be a uuid')
  }
  const via = oneOf(b, 'via', LINK_VIAS) ?? 'link'
  const { created } = linkSession(p.id, defined({ sessionId, launchSessionId, via }), ctxOf(req))
  res.json({ ok: true, created })
}))

router.delete('/proj/:id/sessions/:sessionId', h((req, res) => {
  const p = visible(req)
  const sessionId = String(req.params.sessionId)
  if (!UUID_RE.test(sessionId)) throw new ProjError(400, 'sessionId must be a uuid')
  unlinkSession(p.id, sessionId, ctxOf(req))
  res.json({ ok: true })
}))

// ------------------------------------------------------------ reminders ---

router.post('/proj/:id/reminders', h(async (req, res) => {
  const p = visible(req)
  const b = bodyOf(req)
  const reminder = await addReminder(p.id, {
    at: need(str(b, 'at'), 'at'),
    message: need(str(b, 'message'), 'message'),
  }, ctxOf(req))
  res.status(201).json(reminder)
}))

router.delete('/proj/:id/reminders/:reminderId', h(async (req, res) => {
  const p = visible(req)
  await cancelReminder(p.id, String(req.params.reminderId), ctxOf(req))
  res.json({ ok: true })
}))

export default router
