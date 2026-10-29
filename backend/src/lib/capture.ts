import { randomBytes } from 'node:crypto'
import { openDb } from './db.js'
import { AREAS } from './projectAreas.js'
import { askClaude, extractJson, nyNowLine, nyOffsetMinutes, nyWallToMs } from './claudeCli.js'
import { addLilkupsReminder, removeLilkupsReminder } from './lilkups.js'
import { postInbox } from './inboxStore.js'
import {
  addReminder, addTab, cancelReminder, dueOf, getProject, getProjectDoc, listProjects, updateTab,
} from './projectsStore.js'
import { ProjError, type Ctx } from './projectTypes.js'
import { addTask, removeTask, type Task, type TaskRef } from './tasksStore.js'

// Capture: one line typed or dictated on the phone, filed where it belongs.
//
// The line is kept first (status 'filing'), then a headless Claude run
// (lib/claudeCli.ts, no tools) reads it with the projects and the time, and
// answers what it is: a task (in a project or under an area, maybe with a
// due date), a reminder at a time, a calendar event, or a note. This module
// checks that answer and does it itself, so the model never writes anything.
// When Claude cannot be reached or answers nonsense, the line becomes a
// personal task as typed: nothing captured is ever lost. Each filed capture
// can be undone once from the Today page.

const CTX: Ctx = { actor: 'capture', via: 'system' }
const TEXT_MAX = 500
const RECENT = 12
const CALENDAR = `http://127.0.0.1:${process.env.PORT || 3001}/api/calendar/local-events`

// capture.sqlite also holds the briefs (lib/brief.ts); each module makes its own table
const db = openDb('capture', '')
db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id        TEXT PRIMARY KEY,
    text      TEXT NOT NULL,
    status    TEXT NOT NULL CHECK (status IN ('filing','filed','kept','undone')),
    kind      TEXT,
    summary   TEXT NOT NULL DEFAULT '',
    result    TEXT,
    error     TEXT,
    createdAt TEXT NOT NULL,
    filedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_captures_at ON captures (createdAt);
`)

type Kind = 'task' | 'reminder' | 'event' | 'note'

type Result =
  | { type: 'task'; ref: TaskRef }
  | { type: 'reminder'; projectId: string; reminderId: string }
  | { type: 'reminder'; lilkupsId: string }
  | { type: 'event'; eventId: string }
  | { type: 'note'; projectId: string; tabId: string }
  | { type: 'note'; inboxId: number }

type Row = {
  id: string; text: string; status: 'filing' | 'filed' | 'kept' | 'undone'; kind: Kind | null
  summary: string; result: string | null; error: string | null; createdAt: string; filedAt: string | null
}

export type Capture = {
  id: string; text: string; status: Row['status']; kind: Kind | null; summary: string
  /** where Open goes, when there is somewhere to go */
  url: string | null
  undoable: boolean
  error: string | null; createdAt: string; filedAt: string | null
}

const nowIso = () => new Date().toISOString()
const get = (id: string) => db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as Row | undefined

function urlOf(r: Result | null): string | null {
  if (!r) return null
  if (r.type === 'task') return '/m/tasks'
  if (r.type === 'event') return '/m/calendar'
  if (r.type === 'note' && 'inboxId' in r) return `/m/inbox?item=${r.inboxId}`
  if ('projectId' in r) return `/m/ai/projects?p=${encodeURIComponent(r.projectId)}`
  return null
}

function view(row: Row): Capture {
  const r = row.result ? JSON.parse(row.result) as Result : null
  return {
    id: row.id, text: row.text, status: row.status, kind: row.kind, summary: row.summary, url: urlOf(r),
    undoable: (row.status === 'filed' || row.status === 'kept') && !!r && r.type !== 'note',
    error: row.error, createdAt: row.createdAt, filedAt: row.filedAt,
  }
}

export function recentCaptures(limit = RECENT): Capture[] {
  return (db.prepare('SELECT * FROM captures ORDER BY createdAt DESC LIMIT ?').all(Math.min(50, limit)) as Row[]).map(view)
}

// ------------------------------------------------------------- the time ----

const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' (New York) as "Fri, Oct 30" or "Fri, Oct 30, 6:00 PM". */
function whenLabel(wall: string): string {
  const ms = wall.length > 10 ? nyWallToMs(wall) : nyWallToMs(`${wall}T12:00`)
  return wall.length > 10 ? `${NY_DAY.format(ms)}, ${NY_TIME.format(ms)}` : NY_DAY.format(ms)
}

/** A New York wall-clock time as ISO with its offset, the form lilkups wants. */
function withOffset(wall: string): string {
  const ms = nyWallToMs(wall)
  const off = nyOffsetMinutes(ms)
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  return `${wall}:00${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

// ------------------------------------------------------------- Claude ----

type Plan = {
  kind: Kind; text: string; projectId: string | null; area: string
  due: string | null; at: string | null; message: string | null
  title: string | null; start: string | null; end: string | null
}

function prompt(text: string): string {
  const projects = listProjects()
    .filter((p) => p.status !== 'archived')
    .map((p) => `- ${p.id} | ${p.area} | ${p.name} | ${p.summary.replace(/\s+/g, ' ').slice(0, 160)} | next: ${p.nextAction || '-'}`)
  return [
    'You file one note Brendon typed or dictated on his phone into his own organizer.',
    `Now: ${nyNowLine()}.`,
    'Decide what it is and answer with ONE JSON object and nothing else.',
    '',
    'His projects (id | area | name | summary | next action):',
    ...(projects.length ? projects : ['- (none)']),
    '',
    `Areas: ${AREAS.join(', ')}. personal is his own life; server is his home servers and apps; the others are work.`,
    '',
    'Kinds:',
    '- task: something to do. projectId when it clearly belongs to one project above, else null with the best area.',
    '  due only when he named a day or time (tomorrow, Friday 3pm, by Nov 3): YYYY-MM-DD or YYYY-MM-DDTHH:mm, New York time.',
    '- reminder: he wants to be told at a time ("remind me at 6 to call mom"). at: YYYY-MM-DDTHH:mm New York time, in the future.',
    '  message: what to tell him, short. projectId when it is about one project.',
    '- event: something that happens at a time and belongs on his calendar (dentist Tuesday 2pm).',
    '  title, start (YYYY-MM-DD for all day, or YYYY-MM-DDTHH:mm), end only if he said one.',
    '- note: information to keep, not to do. projectId when it clearly belongs to one project.',
    '',
    'text: his note rewritten short and plain (a task starts with a verb). US English, no em dashes.',
    'Keep every name, number and date he gave. Never add facts he did not give. When unsure, it is a task.',
    '',
    'Answer shape:',
    '{"kind":"task","text":"","projectId":null,"area":"personal","due":null,"at":null,"message":null,"title":null,"start":null,"end":null}',
    '',
    `The note: """${text.replace(/"""/g, '"')}"""`,
  ].join('\n')
}

const KINDS: Kind[] = ['task', 'reminder', 'event', 'note']
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s*\u2014\s*/g, ', ').slice(0, max) : null)

/** Claude's answer, checked: unknown projects dropped, dates valid, a reminder in the future. */
function planOf(raw: unknown, fallbackText: string): Plan {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = KINDS.includes(o.kind as Kind) ? o.kind as Kind : 'task'
  const pid = typeof o.projectId === 'string' ? o.projectId : null
  const project = pid ? getProject(pid) : null
  const area = typeof o.area === 'string' && AREAS.includes(o.area) ? o.area : project?.area ?? 'personal'
  const date = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v) return null
    try { return dueOf(v) } catch { return null }
  }
  const plan: Plan = {
    kind,
    text: str(o.text, 300) ?? fallbackText.slice(0, 300),
    projectId: project && project.status !== 'archived' ? project.id : null,
    area,
    due: date(o.due),
    at: date(o.at),
    message: str(o.message, 400),
    title: str(o.title, 200),
    start: date(o.start),
    end: date(o.end),
  }
  if (plan.kind === 'reminder' && (!plan.at || plan.at.length <= 10 || nyWallToMs(plan.at) < Date.now() + 60_000)) {
    // no usable time: it is a task, dated if a date came with it
    plan.kind = 'task'
    plan.due = plan.at ?? plan.due
  }
  if (plan.kind === 'event' && !plan.start) plan.kind = 'task'
  return plan
}

// ------------------------------------------------------------- doing it ----

async function doPlan(plan: Plan): Promise<{ result: Result; summary: string }> {
  const projectName = plan.projectId ? getProject(plan.projectId)?.name ?? plan.projectId : null
  switch (plan.kind) {
    case 'reminder': {
      const at = plan.at!
      const message = plan.message ?? plan.text
      if (plan.projectId) {
        const r = await addReminder(plan.projectId, { at: withOffset(at), message }, CTX)
        return { result: { type: 'reminder', projectId: plan.projectId, reminderId: r.id }, summary: `Reminder · ${whenLabel(at)} · ${projectName}` }
      }
      const id = await addLilkupsReminder(new Date(nyWallToMs(at)).toISOString().replace(/\.\d{3}Z$/, '+00:00'), `capture-${message.slice(0, 30)}`, message)
      return { result: { type: 'reminder', lilkupsId: id }, summary: `Reminder · ${whenLabel(at)}` }
    }
    case 'event': {
      const allDay = plan.start!.length === 10
      const body: Record<string, unknown> = { title: plan.title ?? plan.text, allDay, start: plan.start, notes: 'Added from Capture' }
      if (plan.end && plan.end.length === plan.start!.length && plan.end >= plan.start!) body.end = plan.end
      const r = await fetch(CALENDAR, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({})) as { event?: { id?: string }; error?: string }
      if (!r.ok || !j.event?.id) throw new Error(`the calendar refused it: ${j.error ?? r.status}`)
      return { result: { type: 'event', eventId: j.event.id }, summary: `Event · ${whenLabel(plan.start!)}` }
    }
    case 'note': {
      if (plan.projectId) {
        const doc = await getProjectDoc(plan.projectId)
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now())
        const line = `- ${day}: ${plan.text}`
        const md = doc.tabs.find((t) => t.kind === 'markdown')
        const tab = md
          ? updateTab(plan.projectId, md.id, { appendBody: line }, CTX)
          : addTab(plan.projectId, { kind: 'markdown', title: 'notes', body: line }, CTX)
        return { result: { type: 'note', projectId: plan.projectId, tabId: tab.id }, summary: `Note · ${projectName} · ${tab.title}` }
      }
      const r = await postInbox({ source: 'capture', level: 'info', title: plan.text, push: false })
      return { result: { type: 'note', inboxId: r.item.id }, summary: 'Note · kept in the inbox' }
    }
    default: {
      const t: Task = addTask({ text: plan.text, due: plan.due, ...(plan.projectId ? { projectId: plan.projectId } : { area: plan.area }) }, CTX, false)
      const where = t.project ? t.project.name : `no project · ${t.area}`
      return { result: { type: 'task', ref: t.ref }, summary: `Task · ${where}${t.due ? ` · due ${whenLabel(t.due)}` : ''}` }
    }
  }
}

// One at a time: captures are rare, and two CLI runs at once only race each other.
let queue: Promise<void> = Promise.resolve()

async function file(id: string): Promise<void> {
  const row = get(id)
  if (!row || row.status !== 'filing') return
  let error: string | null = null
  try {
    const answer = await askClaude(prompt(row.text), { timeoutMs: 90_000 })
    const raw = extractJson(answer)
    if (!raw) throw new Error('Claude answered without the JSON')
    const plan = planOf(raw, row.text)
    const { result, summary } = await doPlan(plan)
    db.prepare("UPDATE captures SET status = 'filed', kind = ?, summary = ?, result = ?, error = NULL, filedAt = ? WHERE id = ?")
      .run(plan.kind, summary, JSON.stringify(result), nowIso(), id)
    return
  } catch (err) {
    error = (err as Error).message.slice(0, 300)
    console.error('[capture] filing failed, keeping it as a task:', error)
  }
  // nothing captured is lost: the line as typed, a personal task
  try {
    const t = addTask({ text: row.text.slice(0, 300), area: 'personal' }, CTX, false)
    db.prepare("UPDATE captures SET status = 'kept', kind = 'task', summary = ?, result = ?, error = ?, filedAt = ? WHERE id = ?")
      .run('Kept as a personal task (Claude could not file it)', JSON.stringify({ type: 'task', ref: t.ref } satisfies Result), error, nowIso(), id)
  } catch (err2) {
    db.prepare("UPDATE captures SET status = 'kept', summary = ?, error = ?, filedAt = ? WHERE id = ?")
      .run('Kept here only (filing failed)', `${error}; then ${(err2 as Error).message}`.slice(0, 300), nowIso(), id)
  }
}

/** Keep the line now, file it in the background. */
export function capture(text: unknown): Capture {
  if (typeof text !== 'string') throw new ProjError(400, 'text must be text')
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) throw new ProjError(400, 'text is required')
  if (t.length > TEXT_MAX) throw new ProjError(400, `text is longer than ${TEXT_MAX} characters`)
  const row: Row = {
    id: randomBytes(6).toString('hex'), text: t, status: 'filing', kind: null, summary: 'Filing',
    result: null, error: null, createdAt: nowIso(), filedAt: null,
  }
  db.prepare(`INSERT INTO captures (id, text, status, kind, summary, result, error, createdAt, filedAt)
    VALUES (@id, @text, @status, @kind, @summary, @result, @error, @createdAt, @filedAt)`).run(row)
  queue = queue.then(() => file(row.id)).catch(() => {})
  return view(row)
}

/** Take a filed capture back: the task removed, the reminder canceled, the event deleted. Notes stay. */
export async function undoCapture(id: string): Promise<Capture> {
  const row = get(id)
  if (!row) throw new ProjError(404, 'no such capture')
  if (row.status !== 'filed' && row.status !== 'kept') throw new ProjError(409, 'nothing to undo')
  const r = row.result ? JSON.parse(row.result) as Result : null
  if (!r || r.type === 'note') throw new ProjError(409, 'a note stays; remove it where it was kept')
  if (r.type === 'task') {
    try { removeTask(r.ref, CTX, false) } catch (e) { if (!(e instanceof ProjError && e.status === 404)) throw e }
  } else if (r.type === 'reminder') {
    if ('reminderId' in r) await cancelReminder(r.projectId, r.reminderId, CTX).catch((e: unknown) => { if (!(e instanceof ProjError && e.status === 404)) throw e })
    else await removeLilkupsReminder(r.lilkupsId)
  } else if (r.type === 'event') {
    await fetch(`${CALENDAR}/${encodeURIComponent(r.eventId)}`, { method: 'DELETE' })
  }
  db.prepare("UPDATE captures SET status = 'undone', summary = ? WHERE id = ?").run(`Undone: ${row.summary}`, id)
  return view(get(id)!)
}

/** A capture still 'filing' after a restart is filed again. */
export function resumeCaptures(): void {
  const stuck = db.prepare("SELECT id FROM captures WHERE status = 'filing'").all() as { id: string }[]
  for (const s of stuck) queue = queue.then(() => file(s.id)).catch(() => {})
}
