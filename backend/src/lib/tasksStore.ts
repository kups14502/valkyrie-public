import { randomBytes } from 'node:crypto'
import { openDb } from './db.js'
import { AREAS } from './projectAreas.js'
import {
  addTab, dueOf, firstChecklistTab, getProject, isClientArea, listChecklistTasks, listProjects, tabItem,
} from './projectsStore.js'
import { LIMITS, ProjError, type Area, type ChecklistItem, type Ctx } from './projectTypes.js'

// The Tasks list: every open thing to do, across every project, in one place.
//
// WHY THIS SHAPE. Projects already hold their to-dos as checklist items (the
// "open tasks", "Plan" and "Setup" tabs), and sessions write them through the
// project MCP. A second task system would split that in two, so a project's
// tasks ARE its checklist items: this module reads them across projects and
// changes them through tabItem, which keeps the event log, undo and the page's
// live updates. Only a task that belongs to no project lives here, in its own
// small table, under an area (personal, server or a client area).
//
// Due dates are New York wall-clock strings, 'YYYY-MM-DD' or
// 'YYYY-MM-DDTHH:mm', the same on both kinds, so "today" and "overdue" are a
// string comparison against New York's date.
//
// Through Cloudflare (hideTailnet) the list leaves out tailnet-only projects
// and loose tasks in client areas, the same rule the project routes follow.

const db = openDb('tasks', `
  CREATE TABLE IF NOT EXISTS loose_tasks (
    id        TEXT PRIMARY KEY,
    area      TEXT NOT NULL,
    text      TEXT NOT NULL,
    due       TEXT,
    done      INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
    doneAt    TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    deletedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_loose_open ON loose_tasks (deletedAt, done, due);
`)

type LooseRow = {
  id: string; area: Area; text: string; due: string | null; done: 0 | 1; doneAt: string | null
  createdBy: string; createdAt: string; updatedAt: string; deletedAt: string | null
}

export type TaskRef = { kind: 'project'; projectId: string; tabId: string; id: string } | { kind: 'loose'; id: string }

export type Task = {
  ref: TaskRef
  text: string
  due: string | null
  done: boolean
  doneAt: string | null
  area: Area
  /** null for a task that belongs to no project */
  project: { id: string; name: string } | null
  /** the checklist tab it sits in */
  list: string | null
  createdAt: string | null
}

export type TaskView = 'open' | 'done'

/** Done tasks stay listed under Done this long. */
const DONE_DAYS = 30
const LOOSE_OPEN_CAP = 500
const ID_RE = /^[0-9a-f]{12}$/

const nowIso = () => new Date().toISOString()

function clean(v: unknown): string {
  if (typeof v !== 'string') throw new ProjError(400, 'text must be text')
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFC')
  if (!s) throw new ProjError(400, 'text is required')
  if (s.length > LIMITS.checklistText) throw new ProjError(400, `text is longer than ${LIMITS.checklistText} characters`)
  return s
}

function areaOf(v: unknown, hideTailnet: boolean): Area {
  const a = v == null || v === '' ? 'personal' : String(v)
  if (!AREAS.includes(a)) throw new ProjError(400, `area must be one of ${AREAS.join(', ')}`)
  if (hideTailnet && isClientArea(a)) throw new ProjError(404, 'no such area')
  return a
}

const fromLoose = (r: LooseRow): Task => ({
  ref: { kind: 'loose', id: r.id }, text: r.text, due: r.due, done: r.done === 1, doneAt: r.doneAt,
  area: r.area, project: null, list: null, createdAt: r.createdAt,
})

function fromItem(p: { id: string; name: string; area: Area }, tab: { id: string; title: string }, it: ChecklistItem): Task {
  return {
    ref: { kind: 'project', projectId: p.id, tabId: tab.id, id: it.id }, text: it.text, due: it.due ?? null,
    done: it.done, doneAt: it.doneAt, area: p.area, project: { id: p.id, name: p.name }, list: tab.title, createdAt: null,
  }
}

/** Open: soonest due first, undated last. Done: most recently done first. */
function sortTasks(list: (Task & { order: number })[], view: TaskView): Task[] {
  const byDue = (a: Task, b: Task) => {
    if (a.due && b.due) return a.due.localeCompare(b.due)
    return a.due ? -1 : b.due ? 1 : 0
  }
  list.sort(view === 'done'
    ? (a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')
    : (a, b) => byDue(a, b)
      || (a.project ? 0 : 1) - (b.project ? 0 : 1)
      || (a.project?.name ?? '').localeCompare(b.project?.name ?? '')
      || a.order - b.order)
  return list.map(({ order: _o, ...t }) => t)
}

export function listTasks(opts: { view: TaskView; hideTailnet: boolean }): Task[] {
  const done = opts.view === 'done'
  const since = new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString()
  const keep = (t: { done: boolean; doneAt: string | null }) => (done ? t.done && (t.doneAt ?? '') >= since : !t.done)
  const out: (Task & { order: number })[] = []
  for (const c of listChecklistTasks()) {
    if (opts.hideTailnet && c.project.exposure === 'tailnet') continue
    if (!keep(c.item)) continue
    out.push({ ...fromItem(c.project, c.tab, c.item), order: c.tab.sortOrder * 1000 + c.order })
  }
  const rows = db.prepare(`SELECT * FROM loose_tasks WHERE deletedAt IS NULL AND done = ?${done ? ' AND doneAt >= ?' : ''} ORDER BY createdAt`)
    .all(...(done ? [1, since] : [0])) as LooseRow[]
  rows.forEach((r, i) => {
    if (opts.hideTailnet && isClientArea(r.area)) return
    out.push({ ...fromLoose(r), order: i })
  })
  return sortTasks(out, opts.view)
}

/** The projects a task can be added to, for the picker. */
export function taskProjects(hideTailnet: boolean): { id: string; name: string; area: Area }[] {
  return listProjects()
    .filter((p) => p.status !== 'archived' && !(hideTailnet && p.exposure === 'tailnet'))
    .map((p) => ({ id: p.id, name: p.name, area: p.area }))
}

export function taskAreas(hideTailnet: boolean): Area[] {
  return AREAS.filter((a) => !(hideTailnet && isClientArea(a)))
}

function visibleProject(projectId: string, hideTailnet: boolean) {
  const p = getProject(projectId)
  if (!p || p.status === 'archived' || (hideTailnet && p.exposure === 'tailnet')) throw new ProjError(404, 'no such project')
  return p
}

function liveLoose(id: string, hideTailnet: boolean): LooseRow {
  const r = ID_RE.test(id) ? db.prepare('SELECT * FROM loose_tasks WHERE id = ? AND deletedAt IS NULL').get(id) as LooseRow | undefined : undefined
  if (!r || (hideTailnet && isClientArea(r.area))) throw new ProjError(404, 'no such task')
  return r
}

/** The task as it stands in its project now (after a write). */
function projectTask(projectId: string, tab: { id: string; title: string; items: unknown[] }, itemId: string): Task {
  const p = getProject(projectId)!
  const it = (tab.items as ChecklistItem[]).find((x) => x.id === itemId)
  if (!it) throw new ProjError(404, 'no such task')
  return fromItem(p, tab, it)
}

export type NewTask = { text: unknown; due?: unknown; projectId?: unknown; area?: unknown }

/**
 * A new task: into the project's first checklist (a "Tasks" checklist is made
 * when it has none, as the project page does), or a loose one under an area.
 */
export function addTask(input: NewTask, ctx: Ctx, hideTailnet: boolean): Task {
  const text = clean(input.text)
  const due = input.due == null || input.due === '' ? null : dueOf(input.due)
  if (typeof input.projectId === 'string' && input.projectId) {
    const p = visibleProject(input.projectId, hideTailnet)
    const tabId = firstChecklistTab(p.id)
    if (tabId) {
      const tab = tabItem(p.id, tabId, { op: 'add', text, due }, ctx)
      const it = (tab.items as ChecklistItem[])[tab.items.length - 1]
      return projectTask(p.id, tab, it.id)
    }
    const made = addTab(p.id, { kind: 'checklist', title: 'Tasks', items: [text] }, ctx)
    const it = (made.items as ChecklistItem[])[0]
    if (!due) return projectTask(p.id, made, it.id)
    return projectTask(p.id, tabItem(p.id, made.id, { op: 'edit', itemId: it.id, due }, ctx), it.id)
  }
  const area = areaOf(input.area, hideTailnet)
  const open = (db.prepare('SELECT COUNT(*) AS n FROM loose_tasks WHERE deletedAt IS NULL AND done = 0').get() as { n: number }).n
  if (open >= LOOSE_OPEN_CAP) throw new ProjError(400, `at most ${LOOSE_OPEN_CAP} open tasks outside projects`)
  const at = nowIso()
  const row: LooseRow = {
    id: randomBytes(6).toString('hex'), area, text, due, done: 0, doneAt: null,
    createdBy: ctx.actor, createdAt: at, updatedAt: at, deletedAt: null,
  }
  db.prepare(`INSERT INTO loose_tasks (id, area, text, due, done, doneAt, createdBy, createdAt, updatedAt, deletedAt)
    VALUES (@id, @area, @text, @due, @done, @doneAt, @createdBy, @createdAt, @updatedAt, @deletedAt)`).run(row)
  return fromLoose(row)
}

export type TaskPatch = { done?: unknown; text?: unknown; due?: unknown; area?: unknown }

/** Tick, untick, rename or (re)date a task. A project task's change is logged in its project like any edit. */
export function updateTask(ref: TaskRef, patch: TaskPatch, ctx: Ctx, hideTailnet: boolean): Task {
  const done = patch.done === undefined ? undefined : patch.done
  if (done !== undefined && typeof done !== 'boolean') throw new ProjError(400, 'done must be true or false')
  const text = patch.text === undefined ? undefined : clean(patch.text)
  const due = patch.due === undefined ? undefined : patch.due === null || patch.due === '' ? null : dueOf(patch.due)
  if (done === undefined && text === undefined && due === undefined && patch.area === undefined) throw new ProjError(400, 'nothing to change')

  if (ref.kind === 'project') {
    if (patch.area !== undefined) throw new ProjError(400, 'a project task takes its area from the project')
    visibleProject(ref.projectId, hideTailnet)
    let tab: { id: string; title: string; items: unknown[] } | null = null
    if (done !== undefined) tab = tabItem(ref.projectId, ref.tabId, { op: 'set', itemId: ref.id, done }, ctx)
    if (text !== undefined || due !== undefined) {
      const op: { op: 'edit'; itemId: string; text?: string; due?: string | null } = { op: 'edit', itemId: ref.id }
      if (text !== undefined) op.text = text
      if (due !== undefined) op.due = due
      tab = tabItem(ref.projectId, ref.tabId, op, ctx)
    }
    return projectTask(ref.projectId, tab!, ref.id)
  }

  const r = liveLoose(ref.id, hideTailnet)
  const next: LooseRow = { ...r, updatedAt: nowIso() }
  if (done !== undefined) {
    next.done = done ? 1 : 0
    next.doneAt = done ? (r.done ? r.doneAt : next.updatedAt) : null
  }
  if (text !== undefined) next.text = text
  if (due !== undefined) next.due = due
  if (patch.area !== undefined) next.area = areaOf(patch.area, hideTailnet)
  db.prepare('UPDATE loose_tasks SET area = @area, text = @text, due = @due, done = @done, doneAt = @doneAt, updatedAt = @updatedAt WHERE id = @id')
    .run(next)
  return fromLoose(next)
}

/** Remove a task: a project task through its checklist (undoable in the project), a loose one softly. */
export function removeTask(ref: TaskRef, ctx: Ctx, hideTailnet: boolean): void {
  if (ref.kind === 'project') {
    visibleProject(ref.projectId, hideTailnet)
    tabItem(ref.projectId, ref.tabId, { op: 'remove', itemId: ref.id }, ctx)
    return
  }
  liveLoose(ref.id, hideTailnet)
  db.prepare('UPDATE loose_tasks SET deletedAt = ?, updatedAt = ? WHERE id = ?').run(nowIso(), nowIso(), ref.id)
}

/** Bring back a loose task removed by mistake (the list's Undo). */
export function restoreTask(id: string, hideTailnet: boolean): Task {
  const r = ID_RE.test(id) ? db.prepare('SELECT * FROM loose_tasks WHERE id = ? AND deletedAt IS NOT NULL').get(id) as LooseRow | undefined : undefined
  if (!r || (hideTailnet && isClientArea(r.area))) throw new ProjError(404, 'no such task')
  db.prepare('UPDATE loose_tasks SET deletedAt = NULL, updatedAt = ? WHERE id = ?').run(nowIso(), id)
  return fromLoose({ ...r, deletedAt: null })
}

/** Today in New York, 'YYYY-MM-DD': the line between due and overdue. */
export function nyToday(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
