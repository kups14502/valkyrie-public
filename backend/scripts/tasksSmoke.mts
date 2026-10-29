/**
 * Tasks smoke test.
 *
 * Mounts routes/tasks.ts and routes/proj.ts on a throwaway express app over a
 * scratch data dir and drives them over HTTP: adding to a project (its first
 * checklist, or a new "Tasks" one), loose tasks under an area, due validation,
 * the open list's order, ticking and dating a project task (and that it lands
 * in the project's event log), loose edits, remove and restore, the Done view,
 * the checklist item route taking due, and the Cloudflare rule (tailnet-only
 * projects and client-area loose tasks answer like missing ones).
 *
 * Runs on odin only (better-sqlite3), never against the live data dir:
 *   T=$(mktemp -d); printf '#!/bin/sh\necho ok\n' > $T/lk; chmod +x $T/lk
 *   VALKYRIE_DATA_DIR=$T LILKUPS_BIN=$T/lk node --import tsx scripts/tasksSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import express from 'express'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR) || !process.env.LILKUPS_BIN) {
  console.error('tasksSmoke: set VALKYRIE_DATA_DIR to a scratch directory and LILKUPS_BIN to a fake lilkups')
  process.exit(2)
}
process.env.LILKUPS_STORE ||= path.join(dataDir, 'reminders.json')
// no area file: the one client area is 'work' (lib/projectAreas.ts)
process.env.PROJECT_AREAS_FILE = path.join(dataDir, 'no-areas.json')

const store = await import('../src/lib/projectsStore.ts')
const { default: tasks } = await import('../src/routes/tasks.ts')
const { default: proj } = await import('../src/routes/proj.ts')
const app = express(); app.use(express.json()); app.use('/api', tasks); app.use('/api', proj)
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: unknown, cf = false) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cf) headers['cf-ray'] = 'smoke'
  const r = await fetch(base + p, { method: m, headers, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json()] as [number, any]
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 400)) }
}

const ui = { actor: 'ui', via: 'ui' } as const
store.createProject({ name: 'Alpha', area: 'personal', targetKey: 'personal', id: 'alpha' }, ui)
store.createProject({ name: 'Beta', area: 'work', targetKey: 'work', id: 'beta' }, ui)
check('client project is tailnet only', store.getProject('beta')?.exposure === 'tailnet', store.getProject('beta'))

// adding to a project with no checklist makes one named Tasks
let [st, r] = await j('POST', '/tasks', { text: 'Book the flight', projectId: 'alpha', due: '2026-11-03' })
check('add to project', st === 200 && r.task.list === 'Tasks' && r.task.due === '2026-11-03' && r.task.project.id === 'alpha', r)
const flight = r.task
;[st, r] = await j('POST', '/tasks', { text: 'Pack', projectId: 'alpha' })
check('second goes to the same checklist', st === 200 && r.task.ref.tabId === flight.ref.tabId && r.task.due === null, r)
const pack = r.task
;[st, r] = await j('POST', '/tasks', { text: 'Send the report', projectId: 'beta', due: '2026-11-01T09:30' })
check('timed due on a client project', st === 200 && r.task.due === '2026-11-01T09:30' && r.task.area === 'work', r)
const report = r.task

// loose tasks
;[st, r] = await j('POST', '/tasks', { text: '  Call   the dentist ', due: '2026-10-30' })
check('loose defaults to personal, text cleaned', st === 200 && r.task.ref.kind === 'loose' && r.task.area === 'personal' && r.task.text === 'Call the dentist', r)
const dentist = r.task
;[st, r] = await j('POST', '/tasks', { text: 'Renew the license', area: 'work' })
check('loose under a client area', st === 200 && r.task.area === 'work', r)
const license = r.task

// validation
check('bad area', (await j('POST', '/tasks', { text: 'x', area: 'nope' }))[0] === 400)
check('empty text', (await j('POST', '/tasks', { text: '   ' }))[0] === 400)
check('not a real date', (await j('POST', '/tasks', { text: 'x', due: '2026-02-30' }))[0] === 400)
check('not a real time', (await j('POST', '/tasks', { text: 'x', due: '2026-11-03T25:00' }))[0] === 400)
check('bad due shape', (await j('POST', '/tasks', { text: 'x', due: 'tomorrow' }))[0] === 400)
check('unknown project', (await j('POST', '/tasks', { text: 'x', projectId: 'nope' }))[0] === 404)

// the open list: soonest first, undated last
;[st, r] = await j('GET', '/tasks')
const order = r.tasks.map((t: any) => t.text)
check('open order', JSON.stringify(order) === JSON.stringify(['Call the dentist', 'Send the report', 'Book the flight', 'Pack', 'Renew the license']), order)
check('today is New York', /^\d{4}-\d{2}-\d{2}$/.test(r.today), r.today)
check('areas listed', r.areas.includes('personal') && r.areas.includes('work'), r.areas)
check('projects listed', r.projects.some((p: any) => p.id === 'alpha') && r.projects.some((p: any) => p.id === 'beta'), r.projects)

// through Cloudflare: the client project and client-area loose tasks are gone
;[st, r] = await j('GET', '/tasks', undefined, true)
check('cf hides client work', !r.tasks.some((t: any) => t.area === 'work') && !r.areas.includes('work') && !r.projects.some((p: any) => p.id === 'beta'), r)
const rp = (t: any) => `/tasks/project/${t.ref.projectId}/${t.ref.tabId}/${t.ref.id}`
check('cf cannot tick a hidden project task', (await j('PATCH', rp(report), { done: true }, true))[0] === 404)
check('cf cannot add under a client area', (await j('POST', '/tasks', { text: 'x', area: 'work' }, true))[0] === 404)
check('cf cannot touch a client loose task', (await j('PATCH', `/tasks/loose/${license.ref.id}`, { done: true }, true))[0] === 404)

// tick and date a project task; both land in the project's event log
;[st, r] = await j('PATCH', rp(flight), { done: true })
check('tick project task', st === 200 && r.task.done === true && !!r.task.doneAt, r)
;[st, r] = await j('PATCH', rp(pack), { due: '2026-11-02' })
check('date project task', st === 200 && r.task.due === '2026-11-02', r)
;[st, r] = await j('PATCH', rp(pack), { due: null })
check('clear project due', st === 200 && r.task.due === null, r)
const events = store.listEvents('alpha', { limit: 10 }).map((e) => e.summary)
check('events logged', events.some((s) => /checked 'Book the flight'/.test(s)) && events.some((s) => /set 'Pack' due 2026-11-02/.test(s)) && events.some((s) => /cleared the due date of 'Pack'/.test(s)), events)
check('nothing to change', (await j('PATCH', rp(pack), {}))[0] === 400)
check('project task has no own area', (await j('PATCH', rp(pack), { area: 'server' }))[0] === 400)

// loose edits
;[st, r] = await j('PATCH', `/tasks/loose/${dentist.ref.id}`, { text: 'Call the dentist back', due: '2026-10-31T14:00', area: 'server' })
check('loose edit', st === 200 && r.task.text === 'Call the dentist back' && r.task.due === '2026-10-31T14:00' && r.task.area === 'server', r)
;[st, r] = await j('PATCH', `/tasks/loose/${dentist.ref.id}`, { done: true })
check('loose tick', st === 200 && r.task.done && !!r.task.doneAt, r)
check('bad loose id', (await j('PATCH', '/tasks/loose/zzz', { done: true }))[0] === 404)

// the Done view
;[st, r] = await j('GET', '/tasks?view=done')
check('done view', r.view === 'done' && r.tasks.map((t: any) => t.text).sort().join('|') === 'Book the flight|Call the dentist back', r.tasks)
;[st, r] = await j('GET', '/tasks')
check('open view drops done', !r.tasks.some((t: any) => t.done), r.tasks)

// remove and restore
check('remove loose', (await j('DELETE', `/tasks/loose/${license.ref.id}`))[0] === 200)
check('removed loose gone', !(await j('GET', '/tasks'))[1].tasks.some((t: any) => t.text === 'Renew the license'))
;[st, r] = await j('POST', `/tasks/loose/${license.ref.id}/restore`)
check('restore loose', st === 200 && r.task.text === 'Renew the license', r)
check('restore twice', (await j('POST', `/tasks/loose/${license.ref.id}/restore`))[0] === 404)
check('remove project task', (await j('DELETE', rp(pack)))[0] === 200)
const alphaItems = store.getTab('alpha', flight.ref.tabId).items.map((i: any) => i.text)
check('removed from the checklist', JSON.stringify(alphaItems) === JSON.stringify(['Book the flight']), alphaItems)

// the project page's own item route takes due too
;[st, r] = await j('POST', `/proj/alpha/tabs/${flight.ref.tabId}/items`, { op: 'add', text: 'Print the boarding pass', due: '2026-11-03T06:00' })
check('item route add with due', st === 200 && r.items.at(-1).due === '2026-11-03T06:00', r)
const printId = r.items.at(-1).id
;[st, r] = await j('POST', `/proj/alpha/tabs/${flight.ref.tabId}/items`, { op: 'edit', itemId: printId, due: null })
check('item route clears due', st === 200 && r.items.at(-1).due === null, r)
check('item route refuses a bad due', (await j('POST', `/proj/alpha/tabs/${flight.ref.tabId}/items`, { op: 'edit', itemId: printId, due: '11/3' }))[0] === 400)

// an archived project's tasks leave the list
store.archiveProject('beta', ui)
check('archived project hidden', !(await j('GET', '/tasks'))[1].tasks.some((t: any) => t.text === 'Send the report'))

console.log(`tasks smoke: ${pass} passed, ${fail} failed`)
srv.close(); process.exit(fail ? 1 : 0)
