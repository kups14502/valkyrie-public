/**
 * Today smoke test: the Capture line and the morning brief.
 *
 * Mounts routes/today.ts, routes/tasks.ts, routes/calendar.ts and routes/inbox.ts on a throwaway
 * express app over a scratch data dir, with a STUB claude CLI (it answers what the test writes to
 * answer.json and records its arguments) and a stub lilkups. Drives every kind Capture files (task in
 * a project with a due date, reminder, reminder in the past turning into a task, calendar event, note
 * in a project, note without one, an unknown project), the fallbacks that keep the line as a task
 * (no JSON, a failing CLI), undo, validation, and the brief (its prompt carries the day's facts and
 * its text is cleaned of bullets, markdown and em dashes). No real Claude run, reminder or event.
 *
 * Runs on odin only (better-sqlite3), never against the live data dir:
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/todaySmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import express from 'express'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('todaySmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const stub = path.join(dataDir, 'stub')
fs.mkdirSync(stub, { recursive: true })
const w = (f: string, s: string, mode?: number) => { fs.writeFileSync(path.join(stub, f), s); if (mode) fs.chmodSync(path.join(stub, f), mode) }
w('claude', `#!/bin/sh\nprintf '%s\\n' "$@" > '${stub}/last-args'\ncat '${stub}/answer.json'\nexit $(cat '${stub}/exit' 2>/dev/null || echo 0)\n`, 0o755)
w('lilkups', `#!/bin/sh\necho "$*" >> '${stub}/lilkups.log'\ncase "$1 $2" in "remind add") echo "abcd1234  2026  user:0  x";; "remind rm") echo "removed $3";; esac\n`, 0o755)
w('accounts.json', JSON.stringify([{ id: 'smoke', label: 'Smoke', configDir: path.join(stub, 'cfg') }]))
Object.assign(process.env, {
  CLAUDE_CLI_PATH: path.join(stub, 'claude'),
  LILKUPS_BIN: path.join(stub, 'lilkups'),
  LILKUPS_STORE: path.join(stub, 'reminders.json'),
  CLAUDE_ACCOUNTS_FILE: path.join(stub, 'accounts.json'),
  // an empty switcher vault: no pool tokens, the stub profile only
  CLAUDE_SWITCH_DIR: path.join(stub, 'switch'),
  PROJECT_AREAS_FILE: path.join(stub, 'no-areas.json'),
})
const answer = (result: string, exit = 0) => {
  w('answer.json', JSON.stringify({ type: 'result', is_error: false, result }))
  w('exit', String(exit))
}

// the server first: Capture posts calendar events to its own port, read at import
const app = express(); app.use(express.json())
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
process.env.PORT = String(port)
const store = await import('../src/lib/projectsStore.ts')
for (const r of ['today', 'tasks', 'calendar', 'inbox']) app.use('/api', (await import(`../src/routes/${r}.ts`)).default)
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json()] as [number, any]
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 500)) }
}

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const day = (n: number) => NY.format(Date.now() + n * 86_400_000)
const tomorrow = day(1)

/** Capture a line and wait until it is filed (or kept). */
async function file(text: string): Promise<any> {
  const [st, r] = await j('POST', '/capture', { text })
  if (st !== 200) return { status: st, ...r }
  for (let i = 0; i < 100; i++) {
    const c = (await j('GET', '/capture'))[1].captures.find((x: any) => x.id === r.capture.id)
    if (c && c.status !== 'filing') return c
    await new Promise((res) => setTimeout(res, 50))
  }
  return { status: 'stuck' }
}

store.createProject({ name: 'Alpha', area: 'personal', targetKey: 'personal', id: 'alpha' }, { actor: 'ui', via: 'ui' })

// a task in a project, with a due date
answer(JSON.stringify({ kind: 'task', text: 'Buy filters', projectId: 'alpha', area: 'personal', due: tomorrow }))
let c = await file('need to buy filters tomorrow for alpha')
check('task filed', c.status === 'filed' && c.kind === 'task' && /^Task · Alpha · due /.test(c.summary) && c.url === '/m/tasks' && c.undoable, c)
const prompt = fs.readFileSync(path.join(stub, 'last-args'), 'utf8')
check('prompt carries the projects and the time', prompt.includes('- alpha | personal | Alpha') && /New York time/.test(prompt) && prompt.includes('need to buy filters tomorrow for alpha'), prompt.slice(0, 300))
check('no tools for the model', prompt.includes('--disallowed-tools') && prompt.includes('Bash,Edit,Write'), prompt)
let tasks = (await j('GET', '/tasks'))[1].tasks
check('the task exists', tasks.some((t: any) => t.text === 'Buy filters' && t.due === tomorrow && t.project?.id === 'alpha'), tasks)
const taskCap = c

// a reminder, then undo cancels it
answer(JSON.stringify({ kind: 'reminder', text: 'Call mom', at: `${tomorrow}T18:00`, message: 'Call mom' }))
c = await file('remind me tomorrow at 6 to call mom')
check('reminder filed', c.status === 'filed' && c.kind === 'reminder' && /^Reminder · .+6:00 PM$/.test(c.summary), c)
let lk = fs.readFileSync(path.join(stub, 'lilkups.log'), 'utf8')
check('lilkups got the reminder', /remind add --at \S+ --name capture-Call mom --message=Call mom/.test(lk) || (lk.includes('remind add') && lk.includes('Call mom')), lk)
let [st, r] = await j('POST', `/capture/${c.id}/undo`)
check('reminder undone', st === 200 && r.capture.status === 'undone' && fs.readFileSync(path.join(stub, 'lilkups.log'), 'utf8').includes('remind rm abcd1234'), r)
check('undo twice', (await j('POST', `/capture/${c.id}/undo`))[0] === 409)

// a reminder in the past is a task
answer(JSON.stringify({ kind: 'reminder', text: 'Check the oven', at: `${day(-1)}T08:00`, message: 'Check the oven' }))
c = await file('remind me to check the oven')
check('past reminder becomes a task', c.status === 'filed' && c.kind === 'task', c)

// a calendar event, then undo deletes it
answer(JSON.stringify({ kind: 'event', text: 'Dentist', title: 'Dentist', start: `${tomorrow}T14:00`, end: `${tomorrow}T15:00` }))
c = await file('dentist tomorrow at 2')
check('event filed', c.status === 'filed' && c.kind === 'event' && /^Event · .+2:00 PM$/.test(c.summary) && c.url === '/m/calendar', c)
let evs = (await j('GET', '/calendar/local-events'))[1]
const list = evs.events ?? evs
check('event on the calendar', Array.isArray(list) && list.some((e: any) => e.title === 'Dentist' && e.start === `${tomorrow}T14:00` && e.end === `${tomorrow}T15:00`), evs)
;[st, r] = await j('POST', `/capture/${c.id}/undo`)
evs = (await j('GET', '/calendar/local-events'))[1]
check('event undone', st === 200 && !(evs.events ?? evs).some((e: any) => e.title === 'Dentist'), evs)

// a note in a project lands in its notes tab; undo is refused
answer(JSON.stringify({ kind: 'note', text: 'The filter size is 20x25x1', projectId: 'alpha' }))
c = await file('alpha filter size 20x25x1')
check('project note filed', c.status === 'filed' && c.kind === 'note' && c.summary === 'Note · Alpha · notes' && !c.undoable, c)
const notes = (await store.getProjectDoc('alpha')).tabs.find((t) => t.title === 'notes')
check('note appended', !!notes && /- \d{4}-\d{2}-\d{2}: The filter size is 20x25x1/.test(notes.body), notes?.body)
check('note undo refused', (await j('POST', `/capture/${c.id}/undo`))[0] === 409)

// a note without a project goes to the inbox
answer(JSON.stringify({ kind: 'note', text: 'Wifi password is on the router label' }))
c = await file('wifi password is on the router label')
check('inbox note', c.status === 'filed' && c.summary === 'Note · kept in the inbox' && /^\/m\/inbox\?item=\d+$/.test(c.url), c)
const inbox = (await j('GET', '/inbox?source=capture'))[1].items
check('inbox item', inbox.length === 1 && inbox[0].title === 'Wifi password is on the router label' && inbox[0].pushDetail === null, inbox)

// an unknown project: a task under the area, no project
answer(JSON.stringify({ kind: 'task', text: 'Fix the gate', projectId: 'nope', area: 'server' }))
c = await file('fix the gate')
check('unknown project dropped', c.status === 'filed' && c.summary === 'Task · no project · server', c)

// no JSON in the answer: kept as the line as typed
answer('Sure, I filed that for you.')
c = await file('order more coffee')
check('no JSON kept as task', c.status === 'kept' && c.summary.startsWith('Kept as a personal task') && /JSON/.test(c.error ?? '') && c.undoable, c)
tasks = (await j('GET', '/tasks'))[1].tasks
check('kept task exists', tasks.some((t: any) => t.text === 'order more coffee' && t.area === 'personal' && !t.project), tasks.map((t: any) => t.text))

// the CLI failing: kept too
answer('', 1)
c = await file('book a haircut')
check('cli failure kept', c.status === 'kept' && /no Claude profile answered/.test(c.error ?? ''), c)

// undo a task capture
;[st, r] = await j('POST', `/capture/${taskCap.id}/undo`)
tasks = (await j('GET', '/tasks'))[1].tasks
check('task undone', st === 200 && !tasks.some((t: any) => t.text === 'Buy filters'), tasks.map((t: any) => t.text))

// validation
check('empty capture', (await j('POST', '/capture', { text: '  ' }))[0] === 400)
check('long capture', (await j('POST', '/capture', { text: 'x'.repeat(501) }))[0] === 400)
check('unknown undo', (await j('POST', '/capture/ffffffffffff/undo'))[0] === 404)
check('recent list newest first', (await j('GET', '/capture'))[1].captures[0].text === 'book a haircut')

// the brief
check('no brief yet', (await j('GET', '/brief'))[1].brief === null)
answer('Send the invoice first — it is overdue.\n- Dentist at 2:00 PM\n**Inbox**: one alert\n\n3. Water the plants')
;[st, r] = await j('POST', '/brief/refresh')
check('refresh starts', st === 200)
let b: any = null
for (let i = 0; i < 100; i++) {
  b = (await j('GET', '/brief'))[1].brief
  if (b && b.status !== 'writing') break
  await new Promise((res) => setTimeout(res, 50))
}
check('brief written and cleaned', b?.status === 'done' && b.text === 'Send the invoice first, it is overdue.\nDentist at 2:00 PM\nInbox: one alert\nWater the plants', b)
const bp = fs.readFileSync(path.join(stub, 'last-args'), 'utf8')
check('brief prompt carries the facts', bp.includes('Calendar, today and tomorrow:') && bp.includes('Tasks:') && bp.includes('Inbox:') && bp.includes('no em dashes'), bp.slice(0, 400))
answer('', 1)
await j('POST', '/brief/refresh')
for (let i = 0; i < 100; i++) {
  b = (await j('GET', '/brief'))[1].brief
  if (b && b.status !== 'writing') break
  await new Promise((res) => setTimeout(res, 50))
}
check('failed brief says so', b?.status === 'failed' && /no Claude profile answered/.test(b.error ?? ''), b)

console.log(`today smoke: ${pass} passed, ${fail} failed`)
srv.close(); process.exit(fail ? 1 : 0)
