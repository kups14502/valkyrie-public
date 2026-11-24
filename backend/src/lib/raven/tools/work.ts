import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTracked, trackerCounts } from '../../agentsStore.js'
import { todaysBrief } from '../../brief.js'
import { nyWallToMs } from '../../claudeCli.js'
import { listInbox } from '../../inboxStore.js'
import { getProjectDoc, listProjects } from '../../projectsStore.js'
import type { ChecklistItem, Ctx } from '../../projectTypes.js'
import { addTask, listTasks, nyToday, updateTask, type Task, type TaskRef } from '../../tasksStore.js'
import { franchiseLabel } from '../../psa.js'
import { workConf } from '../../workConfig.js'
import { workCalendarAdd } from '../../thorMail.js'
import type { RavenToolCtx } from '../types.js'
import { apiJson, clip, dueLabel, et, etClock, etDay, needBrendon, RavenToolError, routeError, toolRun } from './util.js'

// Personal and company work as Raven tracks it: tasks (every project's
// checklists plus the loose ones), projects, the triage tracker's tickets per
// work area (read-only), the inbox, the calendar and the morning brief. Work
// areas come from work-agents.json at run time, never named here.

const RAVEN_CTX: Ctx = { actor: 'raven', via: 'mcp' }

/** A task's id as Raven passes it back: "loose/<id>" or "project/<project>/<tab>/<item>". */
export const taskId = (r: TaskRef): string => (r.kind === 'loose' ? `loose/${r.id}` : `project/${r.projectId}/${r.tabId}/${r.id}`)

function parseTaskId(id: string): TaskRef {
  const p = id.trim().split('/')
  if (p[0] === 'loose' && p.length === 2 && p[1]) return { kind: 'loose', id: p[1] }
  if (p[0] === 'project' && p.length === 4 && p.every(Boolean)) return { kind: 'project', projectId: p[1], tabId: p[2], id: p[3] }
  throw new RavenToolError(`"${id}" is not a task id; tasks lists them`)
}

const taskView = (t: Task) => ({
  id: taskId(t.ref), text: t.text, due: dueLabel(t.due) || undefined, area: t.area, project: t.project?.name, list: t.list ?? undefined,
  done: t.done ? et(t.doneAt) || true : undefined,
})

const dayOf = (due: string | null) => (due ? due.slice(0, 10) : '')

type CalEvent = { summary: string; start: string; end: string; allDay: boolean; location?: string; url?: string; sourceLabel?: string; status?: string }
type LocalEvent = { id: string; title: string; allDay: boolean; start: string; end: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
// wall-clock math on a New York 'YYYY-MM-DDTHH:mm' read as if it were UTC, so no zone ever shifts it
const wallMs = (s: string) => Date.parse(`${s.length === 10 ? `${s}T00:00` : s}:00Z`)
const realWall = (s: string, re: RegExp) => re.test(s) && Number.isFinite(wallMs(s)) && new Date(wallMs(s)).toISOString().slice(0, s.length) === s

/** "Wed, Nov 25, 12:00 PM to 1:00 PM ET", "Wed, Nov 25, all day", "Wed, Nov 25 to Fri, Nov 27, all day" for New York wall clock. */
function whenLabel(start: string, end: string, allDay: boolean): string {
  if (allDay) return start === end ? `${dueLabel(start)}, all day` : `${dueLabel(start)} to ${dueLabel(end)}, all day`
  const endClock = dueLabel(end).replace(/^.*, (\d{1,2}:\d{2} [AP]M ET)$/, '$1')
  return start.slice(0, 10) === end.slice(0, 10)
    ? `${dueLabel(start).replace(/ ET$/, '')} to ${endClock}`
    : `${dueLabel(start).replace(/ ET$/, '')} to ${dueLabel(end)}`
}

export function registerWorkTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('tasks', {
    description: "Brendon's tasks: every project's checklist items and the loose ones. view: open (default), today (due today), overdue, done "
      + '(last 30 days). area or projectId narrows it. Due times are New York time.',
    inputSchema: {
      view: z.enum(['open', 'today', 'overdue', 'done']).optional(), area: z.string().max(32).optional(), projectId: z.string().max(40).optional(),
    },
  }, (a) => toolRun(() => {
    const view = a.view ?? 'open'
    const today = nyToday()
    const all = listTasks({ view: view === 'done' ? 'done' : 'open', hideTailnet: false })
      .filter((t) => (!a.area || t.area === a.area) && (!a.projectId || t.project?.id === a.projectId))
      .filter((t) => view === 'today' ? dayOf(t.due) === today : view === 'overdue' ? Boolean(t.due) && dayOf(t.due) < today : true)
    return { today: etDay(Date.now()), count: all.length, tasks: all.slice(0, 60).map(taskView), more: all.length > 60 || undefined }
  }))

  server.registerTool('task_add', {
    description: 'Add a task. due is New York time, YYYY-MM-DD or YYYY-MM-DDTHH:mm. projectId puts it on that project\'s checklist; otherwise it is a '
      + 'loose task under area (personal when none). Only when Brendon\'s message asks.',
    inputSchema: { text: z.string().min(1).max(300), due: z.string().max(16).optional(), area: z.string().max(32).optional(), projectId: z.string().max(40).optional() },
  }, (a) => toolRun(() => {
    needBrendon(ctx, 'Adding a task')
    const t = addTask({ text: a.text, due: a.due, area: a.area, projectId: a.projectId }, RAVEN_CTX, false)
    ctx.acted()
    return taskView(t)
  }))

  server.registerTool('task_done', {
    description: 'Tick a task done, by its id from tasks. Only when Brendon\'s message asks.',
    inputSchema: { id: z.string().min(3).max(200) },
  }, (a) => toolRun(() => {
    needBrendon(ctx, 'Ticking a task')
    const t = updateTask(parseTaskId(a.id), { done: true }, RAVEN_CTX, false)
    ctx.acted()
    return taskView(t)
  }))

  server.registerTool('projects', {
    description: 'Projects (not archived): id, name, area, status, the next action and a short summary.',
    inputSchema: { area: z.string().max(32).optional() },
  }, (a) => toolRun(() => listProjects().filter((p) => !a.area || p.area === a.area).map((p) => ({
    id: p.id, name: p.name, area: p.area, status: p.status, next: p.nextAction || undefined, summary: p.summary ? clip(p.summary, 200) : undefined,
    reminder: p.nextReminderAt ? et(p.nextReminderAt) || p.nextReminderAt : undefined,
  }))))

  server.registerTool('project_get', {
    description: 'One project page: summary, next action, its open tasks, tabs (long bodies cut), pinned files, linked sessions, reminders.',
    inputSchema: { id: z.string().max(40) },
  }, (a) => toolRun(async () => {
    const doc = await getProjectDoc(a.id)
    const p = doc.project
    const open = doc.tabs.filter((t) => t.kind === 'checklist').flatMap((t) => (t.items as ChecklistItem[]).filter((i) => !i.done)
      .map((i) => ({ id: taskId({ kind: 'project', projectId: p.id, tabId: t.id, id: i.id }), text: i.text, due: dueLabel(i.due) || undefined, list: t.title })))
    return {
      id: p.id, name: p.name, area: p.area, status: p.status, summary: p.summary || undefined, next: p.nextAction || undefined,
      openTasks: open.slice(0, 40),
      tabs: doc.tabs.map((t) => ({ title: t.title, kind: t.kind, body: t.kind === 'markdown' ? clip(t.body, 1500) : undefined, items: t.kind === 'checklist' ? t.items.length : undefined })),
      files: doc.files.slice(0, 20).map((f) => ({ label: f.label, path: f.relPath ?? undefined, url: f.url ?? undefined })),
      sessions: doc.sessions.slice(0, 6).map((s) => ({ sessionId: s.sessionId, pane: s.tmuxName ?? undefined, linked: et(s.linkedAt), status: s.statusNote || undefined })),
      reminders: doc.reminders.filter((r) => r.state === 'pending').slice(0, 8).map((r) => ({ at: et(r.at) || r.at, message: r.message })),
      lastChange: doc.lastEvent ? `${doc.lastEvent.summary} (${et(doc.lastEvent.at)})` : undefined,
    }
  }))

  server.registerTool('tickets', {
    description: "Per work area, from its triage agent's tracker (read-only): open tickets, how many are assigned to Brendon and how many need him, "
      + 'and the top 15 that need him or are his. Ticket changes are proposals the agents make; Raven never edits tickets.',
    inputSchema: { area: z.string().max(32).optional() },
  }, (a) => toolRun(() => {
    const areas = workConf().franchises.filter((f) => !a.area || f.key === a.area)
    if (!areas.length) return a.area ? `No work area "${a.area}".` : 'No work areas are set up.'
    return areas.map((f) => {
      const c = trackerCounts(f.key)
      const top = listTracked(f.key, { open: true, limit: 300 }).filter((t) => t.needsBrendon || t.mine).slice(0, 15)
      return {
        area: f.key, label: franchiseLabel(f.key), open: c.open, assignedToBrendon: c.mine, needsBrendon: c.needsBrendon,
        tickets: top.map((t) => ({
          number: t.number, id: t.id, title: t.title, company: t.company, status: t.status, priority: t.priority,
          assignee: t.assignee ?? undefined, needsBrendon: t.needsBrendon || undefined, his: t.mine || undefined,
          lastActivity: et(t.lastActivity) || undefined, due: et(t.due) || undefined,
          summary: t.summary || undefined, next: t.next || undefined, waitingOn: t.waitingOn || undefined,
        })),
      }
    })
  }))

  server.registerTool('inbox', {
    description: "Brendon's Valkyrie inbox (alerts from his services and scripts). needsYou (default) is the unread warn and alert items; false is every unread item.",
    inputSchema: { needsYou: z.boolean().optional() },
  }, (a) => toolRun(() => {
    const needs = a.needsYou !== false
    const items = listInbox({ view: 'open', limit: 300 }).filter((i) => !i.readAt && (!needs || i.level === 'warn' || i.level === 'alert'))
    if (!items.length) return needs ? 'Nothing unread that needs him.' : 'Nothing unread.'
    return {
      count: items.length,
      items: items.slice(0, 40).map((i) => ({
        id: i.id, source: i.source, level: i.level, title: i.title, body: i.body ? clip(i.body, 300) : undefined,
        at: et(i.lastAt), times: i.count > 1 ? i.count : undefined,
      })),
    }
  }))

  server.registerTool('calendar', {
    description: "Brendon's calendar from today on, as the dashboard shows it, every time in New York time. days is how many days (default 2).",
    inputSchema: { days: z.number().int().min(1).max(14).optional() },
  }, (a) => toolRun(async () => {
    const from = nyWallToMs(`${nyToday()}T00:00`)
    const to = from + (a.days ?? 2) * 86_400_000
    const { status, body } = await apiJson<{ events?: CalEvent[] }>(`/calendar/events?from=${from}&to=${to}`)
    if (status !== 200) throw new RavenToolError(`the calendar did not answer: ${routeError(body, status)}`)
    const now = Date.now()
    const events = (body?.events ?? []).filter((e) => Date.parse(e.end) > now && e.status?.toUpperCase() !== 'CANCELLED')
    if (!events.length) return 'Nothing on the calendar.'
    return events.slice(0, 60).map((e) => {
      const s = Date.parse(e.start)
      return {
        title: e.summary,
        when: e.allDay ? `${etDay(s)}, all day` : `${etDay(s)}, ${etClock(s).replace(/ ET$/, '')} to ${etClock(Date.parse(e.end))}`,
        now: !e.allDay && s <= now ? true : undefined,
        where: e.location || undefined, link: e.url || undefined, calendar: e.sourceLabel || undefined,
      }
    })
  }))

  server.registerTool('calendar_add', {
    description: "Add one event to Brendon's calendar, the calendar the dashboard shows. calendar: personal (default; Valkyrie's own Personal "
      + 'calendar, shows at once) or work (his own work Outlook calendar, written on thor; the dashboard shows it once Outlook republishes its '
      + 'feed, which can take a while). start is New York wall clock, YYYY-MM-DDTHH:mm, or YYYY-MM-DD with allDay true. end is the same shape '
      + '(all-day end is the last day, inclusive); without end, minutes sets the length (default 60; all day: one day). Never invites anyone. '
      + 'The same title at the same start is not added twice. Never changes or removes an event. Only when Brendon\'s message asks.',
    inputSchema: {
      title: z.string().min(1).max(200), start: z.string().max(16), end: z.string().max(16).optional(), minutes: z.number().int().min(5).max(1440).optional(),
      allDay: z.boolean().optional(), location: z.string().max(300).optional(), notes: z.string().max(4000).optional(),
      calendar: z.enum(['personal', 'work']).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Adding a calendar event')
    const title = a.title.trim()
    if (!title) throw new RavenToolError('title is empty')
    const allDay = a.allDay === true
    const re = allDay ? DATE_RE : DATETIME_RE
    const shape = allDay ? 'YYYY-MM-DD (allDay)' : 'YYYY-MM-DDTHH:mm'
    const start = a.start.trim()
    if (!realWall(start, re)) throw new RavenToolError(`start must be a real ${shape} in New York time`)
    let end = a.end?.trim() || ''
    if (end && !realWall(end, re)) throw new RavenToolError(`end must be a real ${shape} in New York time`)
    if (!end) end = allDay ? start : new Date(wallMs(start) + (a.minutes ?? 60) * 60_000).toISOString().slice(0, 16)
    if (allDay ? end < start : end <= start) throw new RavenToolError('end must be after start')
    const calendar = a.calendar ?? 'personal'
    const where = a.location?.trim() || undefined
    const out = (added: boolean, extra: Record<string, unknown>) => ({
      added, calendar: calendar === 'work' ? 'Work' : 'Personal', title, when: whenLabel(start, end, allDay), where, ...extra,
    })

    if (calendar === 'work') {
      const r = await workCalendarAdd({ subject: title, start, end, allDay, location: where, notes: a.notes })
      if (r.already) return out(false, { note: 'Already on his work calendar at that time; nothing was added.', link: r.webLink || undefined })
      ctx.acted()
      return out(true, { link: r.webLink || undefined, note: 'Added to his work Outlook calendar. The dashboard shows it once Outlook republishes the feed.' })
    }

    const list = await apiJson<{ events?: LocalEvent[] }>('/calendar/local-events')
    if (list.status !== 200) throw new RavenToolError(`the calendar did not answer: ${routeError(list.body, list.status)}`)
    const same = (list.body?.events ?? []).find((e) => e.start === start && e.allDay === allDay && e.title.trim().toLowerCase() === title.toLowerCase())
    if (same) return out(false, { id: same.id, note: 'Already on his Personal calendar at that time; nothing was added.' })
    const r = await apiJson<{ event?: LocalEvent }>('/calendar/local-events', {
      method: 'POST', body: { title, allDay, start, end, location: where ?? '', notes: a.notes ?? '' },
    })
    if (r.status !== 200 || !r.body?.event) throw new RavenToolError(`the calendar did not add it: ${routeError(r.body, r.status)}`)
    ctx.acted()
    return out(true, { id: r.body.event.id })
  }))

  server.registerTool('brief', {
    description: "Today's morning brief (written at 7:30 AM ET), as it shows on Today.",
    inputSchema: {},
  }, () => toolRun(() => {
    const b = todaysBrief()
    if (!b) return 'No brief yet today (it is written at 7:30 AM ET).'
    if (b.status === 'writing') return 'The brief is being written now.'
    if (b.status === 'failed') return `Today's brief failed: ${b.error ?? 'no reason given'}`
    return b.text
  }))
}
