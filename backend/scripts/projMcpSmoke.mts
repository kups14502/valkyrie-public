/**
 * Projects MCP end-to-end smoke test.
 *
 * Serves the proj and mcp routers from a throwaway express app on loopback and
 * drives them the way a project session on thor does: the SDK's own Client
 * over Streamable HTTP with the X-Valkyrie-Session header, plus raw requests
 * for the guards, the page's REST and the change long-poll. projSmoke.mts
 * covers the store's rules; this covers the wire: tool names and schemas, the
 * guard, actor attribution, isError results and the live update.
 *
 * Runs on odin only (better-sqlite3 has no Windows build on thor), against a
 * scratch data dir and a fake lilkups, never the live ones:
 *   T=$(mktemp -d)
 *   printf '#!/bin/bash\nif [ "$2" = add ]; then echo "abcd1234  x  user:0  fake"; else echo "removed abcd1234"; fi\n' > $T/lk
 *   chmod +x $T/lk
 *   VALKYRIE_DATA_DIR=$T LILKUPS_BIN=$T/lk node --import tsx scripts/projMcpSmoke.mts
 *   rm -rf $T
 *
 * Nothing leaves the box. The server listens on 127.0.0.1 on a free port, the
 * VAPID keys are dropped before routes/push.ts loads (so notify logs its event
 * and pushes nothing), and reminders go to the fake lilkups.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  Automation, ChecklistItem, FileContent, FileRef, ProjChange, ProjectDoc, ProjectEvent, ProjectSummary, Reminder, Run, Tab,
} from '../src/lib/projectTypes.js'

const real = (p: string) => {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}
const dataDir = process.env.VALKYRIE_DATA_DIR
const lilkups = process.env.LILKUPS_BIN
if (!dataDir || real(dataDir) === real(path.join(homedir(), 'valkyrie', 'backend', 'data'))
  || !lilkups || real(lilkups) === real(path.join(homedir(), 'lilkups', 'lilkups'))) {
  console.error('projMcpSmoke: set VALKYRIE_DATA_DIR to a scratch directory (never the live data dir) and LILKUPS_BIN to a fake lilkups')
  process.exit(2)
}
process.env.LILKUPS_STORE ||= path.join(dataDir, 'reminders.json')
// The client connects from loopback, and nothing else should reach a scratch
// server, whatever MCP_PEERS the operator's shell carries.
process.env.MCP_PEERS = '127.0.0.1,::1'
// A stand-in for odin's private area table (lib/projectAreas.ts).
process.env.PROJECT_AREAS_FILE = path.join(dataDir, 'project-areas.json')
fs.writeFileSync(process.env.PROJECT_AREAS_FILE, JSON.stringify({
  clientAreas: ['work', 'client2'],
  sessionRules: [{ match: '^C:\\\\Clients2\\\\', fromArea: 'work', area: 'client2' }],
}))
// push.ts reads these once at load and sends nothing without both.
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

// Imported only now: the store opens its database, and lilkups.ts, mcp.ts and
// push.ts read their environment, at import time.
const { default: express } = await import('express')
const { default: helmet } = await import('helmet')
const { default: projRoute } = await import('../src/routes/proj.js')
const { default: mcpRoute } = await import('../src/routes/mcp.js')
const S = await import('../src/lib/projectsStore.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

type McpClient = InstanceType<typeof Client>

const SID = '11111111-2222-3333-4444-555555555555'
const ACTOR = `session:${SID}`
const PID = 'vk-smoke'
const WORK = 'vk-smoke-work'
const TOOLS = [
  'project_get', 'project_update', 'tab_get', 'tab_add', 'tab_update', 'tab_append', 'tab_move', 'tab_remove', 'tab_item',
  'file_pin', 'file_unpin', 'reminder_add', 'reminder_list', 'reminder_cancel', 'automation_save', 'automation_get',
  'automation_remove', 'run_report', 'session_status', 'notify', 'history', 'undo',
]

const ok = (what: string) => console.log(`ok  ${what}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Same middleware order as index.ts, minus requireAuth (loopback passes it
// anyway) and the request logger.
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '1mb' }))
app.use('/api', projRoute)
app.use('/api', mcpRoute)
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

type Reply<T> = { status: number; body: T; headers: Headers }

async function rest<T>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T, headers: r.headers }
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vk-smoke', version: '0' } },
}
const rawMcp = (projectId: string, headers: Record<string, string> = {}) =>
  rest<{ error?: string; result?: { instructions?: string } }>('POST', `/mcp/${projectId}`, INIT, {
    Accept: 'application/json, text/event-stream', 'X-Valkyrie-Session': SID, ...headers,
  })

async function connect(projectId: string, headers: Record<string, string>): Promise<McpClient> {
  const client = new Client({ name: 'vk-smoke', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${projectId}`), { requestInit: { headers } }))
  return client
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }) as CallToolResult
  const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  return { isError: r.isError === true, text }
}

async function tool<T>(client: McpClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(client, name, args)
  assert.ok(!r.isError, `${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function toolFails(client: McpClient, name: string, args: Record<string, unknown>, re: RegExp): Promise<string> {
  const r = await call(client, name, args)
  assert.ok(r.isError, `${name} should have failed, got ${r.text.slice(0, 200)}`)
  assert.match(r.text, re)
  return r.text
}

const docOf = async (id: string) => {
  const r = await rest<ProjectDoc>('GET', `/proj/${id}`)
  assert.equal(r.status, 200)
  return r.body
}

// -------------------------------------------------------------- setup ----

const created = await rest<ProjectDoc>('POST', '/proj', { id: PID, name: 'vk smoke', area: 'personal', targetKey: 'personal' })
assert.equal(created.status, 201)
assert.equal(created.body.project.id, PID)
const notesId = created.body.tabs[0].id
ok('REST creates the project')

// ------------------------------------------------------------- guards ----

const fromBrowser = await rawMcp(PID, { Origin: 'http://example.com' })
assert.equal(fromBrowser.status, 403)
assert.equal(fromBrowser.body.error, 'no browser access')
assert.equal((await rawMcp(PID, { 'cf-ray': 'test' })).status, 403)
assert.equal((await rawMcp('vk-nope')).status, 404)
assert.equal((await rawMcp('Not A Key')).status, 404)
const get = await rest<{ error?: { message?: string } }>('GET', `/mcp/${PID}`)
assert.equal(get.status, 405)
assert.equal(get.headers.get('allow'), 'POST')
const raw = await rawMcp(PID)
assert.equal(raw.status, 200)
assert.match(raw.body.result?.instructions ?? '', /Valkyrie project 'vk smoke' \(id vk-smoke, area personal\)/)
ok('Origin and cf-ray get 403, unknown project 404, GET 405, a plain initialize 200')

// --------------------------------------------------------- initialize ----

const mcp = await connect(PID, { 'X-Valkyrie-Session': SID })
assert.match(mcp.getInstructions() ?? '', /^This Claude Code session belongs to the Valkyrie project 'vk smoke' \(id vk-smoke, area personal\)\./)
assert.equal(mcp.getServerVersion()?.name, 'valkyrie')
const { tools } = await mcp.listTools()
assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort())
const tabAddSchema = tools.find((t) => t.name === 'tab_add')?.inputSchema as { properties?: Record<string, { maxLength?: number }>; required?: string[] }
assert.equal(tabAddSchema.properties?.title?.maxLength, 40)
assert.deepEqual([...(tabAddSchema.required ?? [])].sort(), ['kind', 'title'])
ok(`SDK client initializes, instructions name the project, exactly the ${TOOLS.length} tools`)

// -------------------------------------------------------------- reads ----

type Got = ProjectDoc & { you: { launchSessionId: string | null; runId: string | null } }
let got = await tool<Got>(mcp, 'project_get')
assert.equal(got.project.id, PID)
assert.equal(got.tabs[0].title, 'notes')
assert.deepEqual(got.you, { launchSessionId: SID, runId: null })
const long = await rest<Tab>('POST', `/proj/${PID}/tabs`, { kind: 'markdown', title: 'long', body: 'x'.repeat(2500) })
assert.equal(long.status, 201)
assert.equal(long.body.createdBy, 'ui')
got = await tool<Got>(mcp, 'project_get')
const cut = got.tabs.find((t) => t.id === long.body.id)
assert.equal(cut?.body.length, 2000)
assert.equal(cut?.bodyTruncated, true)
assert.equal(cut?.rev, null)
assert.equal((await tool<Tab>(mcp, 'tab_get', { tabId: long.body.id })).body.length, 2500)
ok('project_get with you, bodies cut at 2,000, marked and given no rev, tab_get in full')

// --------------------------------------------------------------- tabs ----

const test = await tool<Tab>(mcp, 'tab_add', { kind: 'checklist', title: 'test', items: ['a', 'b'] })
assert.equal(test.items.length, 2)
assert.equal(test.createdBy, ACTOR)
const first = test.items[0] as ChecklistItem
const set = await tool<Tab>(mcp, 'tab_item', { tabId: test.id, op: 'set', itemId: first.id, done: true })
assert.equal((set.items[0] as ChecklistItem).done, true)
await toolFails(mcp, 'tab_item', { tabId: test.id, op: 'set', itemId: first.id }, /set needs done/)
await toolFails(mcp, 'tab_item', { tabId: test.id, op: 'remove' }, /remove needs itemId/)
const grown = await tool<Tab>(mcp, 'tab_append', { tabId: test.id, text: '- c\n\nd' })
assert.deepEqual((grown.items as ChecklistItem[]).map((i) => i.text), ['a', 'b', 'c', 'd'])
const appended = await tool<Tab>(mcp, 'tab_append', { tabId: notesId, text: 'from the session' })
assert.equal(appended.body, 'from the session')
ok('tab_add checklist with 2 items, tab_item set, tab_append')

const tabUpdateSchema = tools.find((t) => t.name === 'tab_update')?.inputSchema as { required?: string[] }
assert.deepEqual([...(tabUpdateSchema.required ?? [])].sort(), ['baseRev', 'tabId'])
await toolFails(mcp, 'tab_update', { tabId: notesId, body: 'replaced' }, /Invalid arguments for tool tab_update/)
const stale = await toolFails(mcp, 'tab_update', { tabId: notesId, baseRev: appended.rev - 1, body: 'replaced' }, /^changed since current: /)
const current = JSON.parse(stale.slice('changed since current: '.length)) as Tab
assert.equal(current.id, notesId)
assert.equal(current.rev, appended.rev)
const replaced = await tool<Tab>(mcp, 'tab_update', { tabId: notesId, baseRev: current.rev, body: 'replaced' })
assert.equal(replaced.body, 'replaced')
assert.equal(replaced.rev, current.rev + 1)
await toolFails(mcp, 'tab_add', { kind: 'markdown', title: 'x'.repeat(41) }, /title/)
const huge = await rest<Tab>('POST', `/proj/${PID}/tabs`, { kind: 'markdown', title: 'huge', body: 'y'.repeat(7000) })
const hugeStale = await toolFails(mcp, 'tab_update', { tabId: huge.body.id, baseRev: huge.body.rev - 1, body: 'z' }, /^changed since current: /)
const hugeCurrent = JSON.parse(hugeStale.slice('changed since current: '.length)) as { rev: number; bodyTruncated: boolean; body?: string }
assert.equal(hugeCurrent.rev, huge.body.rev)
assert.equal(hugeCurrent.bodyTruncated, true)
assert.equal(hugeCurrent.body, undefined)
ok('tab_update: no baseRev and a stale one are refused (with the current tab, or its rev when too long), the right one lands; schema caps hold')

// -------------------------------------------------------------- files ----

const pin1 = await tool<FileRef>(mcp, 'file_pin', { label: 'readme', relPath: 'docs/readme.md' })
assert.equal(pin1.kind, 'path')
assert.equal(pin1.hasContent, false)
const pin2 = await tool<FileRef>(mcp, 'file_pin', { label: 'readme', relPath: 'docs/readme.md', content: '# hi' })
assert.equal(pin2.id, pin1.id)
assert.equal(pin2.contentType, 'markdown')
let doc = await docOf(PID)
assert.equal(doc.files.filter((f) => f.relPath === 'docs/readme.md').length, 1)
assert.equal((await rest<FileContent>('GET', `/proj/${PID}/files/${pin1.id}/content`)).body.content, '# hi')
await toolFails(mcp, 'file_pin', { label: 'x', relPath: '../outside' }, /relPath must be relative/)
await toolFails(mcp, 'file_pin', { label: 'x', relPath: 'a', url: 'https://example.com' }, /not both/)
ok('file_pin by relPath twice leaves one row, the second adds the snapshot')

// -------------------------------------------------------- automations ----

const saved = await tool<Automation & { note: string }>(mcp, 'automation_save', {
  kind: 'agent', key: 'hello', name: 'hello', body: 'Call session_status with note hi, then run_report done.', model: 'haiku',
})
assert.equal(saved.key, 'hello')
assert.equal(saved.updatedBy, ACTOR)
assert.match(saved.note, /starts runs from the project page/)
assert.equal((await tool<Automation>(mcp, 'automation_get', { key: 'hello' })).model, 'haiku')
await toolFails(mcp, 'automation_save', { kind: 'agent', key: 'Bad Key', name: 'x', body: 'x' }, /key/)
ok('automation_save and automation_get')

// ---------------------------------------------------------- reminders ----

const at = new Date(Date.now() + 2 * 86_400_000).toISOString()
const rem = await tool<Reminder>(mcp, 'reminder_add', { at, message: 'smoke' })
assert.equal(rem.state, 'pending')
assert.equal(rem.createdBy, ACTOR)
assert.match(rem.at, /\+00:00$/)
await toolFails(mcp, 'reminder_add', { at: '2026-10-07T09:00:00', message: 'naive' }, /explicit offset/)
assert.ok((await tool<Reminder[]>(mcp, 'reminder_list')).some((r) => r.id === rem.id && r.state === 'pending'))
await tool(mcp, 'reminder_cancel', { reminderId: rem.id })
assert.equal((await tool<Reminder[]>(mcp, 'reminder_list')).find((r) => r.id === rem.id)?.state, 'canceled')
ok('reminder_add through the fake lilkups, reminder_list, reminder_cancel')

// -------------------------------------------------- sessions and runs ----

assert.deepEqual(await tool(mcp, 'session_status', { note: 'hi' }), { updated: 0 })
const link = await rest<{ ok: boolean; created: boolean }>('POST', `/proj/${PID}/sessions/link`,
  { sessionId: SID, via: 'startup', launchSessionId: SID }, { 'X-Valkyrie-Session': SID })
assert.deepEqual(link.body, { ok: true, created: true })
assert.deepEqual(await tool(mcp, 'session_status', { note: 'hi' }), { updated: 1 })
doc = await docOf(PID)
assert.equal(doc.sessions[0].statusNote, 'hi')
assert.equal(doc.sessions[0].linkedBy, `hook:${SID}`)
ok('session_status updates nothing until the session is linked, then its row')

await toolFails(mcp, 'run_report', { status: 'done', summary: 'ok' }, /not an agent or workflow run/)
// Runs start only from the terminal route, which needs tmux, so the run is
// minted on the store directly, exactly as that route does it.
const run = S.createRun(PID, 'hello', saved.rev, { actor: 'ui', via: 'terminal' })
const runClient = await connect(PID, { 'X-Valkyrie-Session': SID, 'X-Valkyrie-Run': run.id })
assert.equal((await tool<Got>(runClient, 'project_get')).you.runId, run.id)
const reported = await tool<Run>(runClient, 'run_report', { status: 'done', summary: 'ok' })
assert.equal(reported.status, 'done')
assert.equal(reported.summary, 'ok')
await runClient.close()
// A run resumed from the page carries no run header, only its session id.
const RUN_SID = '44444444-5555-6666-7777-888888888888'
S.attachRun(run.id, RUN_SID, 'vk-0123456789')
const resumedRun = await connect(PID, { 'X-Valkyrie-Session': RUN_SID })
assert.equal((await tool<Got>(resumedRun, 'project_get')).you.runId, run.id)
assert.equal((await tool<Run>(resumedRun, 'run_report', { status: 'blocked', summary: 'again' })).status, 'blocked')
await resumedRun.close()
ok('run_report refused without X-Valkyrie-Run, recorded with it, and found again from a resumed run session')

// -------------------------------------------------------------- other ----

assert.deepEqual(await tool(mcp, 'notify', { title: 'smoke', body: 'harness' }), { sent: 0 })

const scratch = await tool<Tab>(mcp, 'tab_add', { kind: 'markdown', title: 'scratch', body: 'temp' })
const history = await tool<ProjectEvent[]>(mcp, 'history', { limit: 50 })
assert.ok(history.length <= 50)
assert.equal(history[0].action, 'tab.add')
assert.equal(history[0].actor, ACTOR)
assert.equal(history[0].via, 'mcp')
assert.ok(history.some((e) => e.action === 'notify' && e.summary === 'sent a notification' && !e.undoable))
const own = history.find((e) => e.action === 'tab.add' && e.entityId === scratch.id)
assert.ok(own?.undoable)
const undone = await tool<{ rev: number }>(mcp, 'undo', { eventId: own.id })
assert.equal(undone.rev, (await docOf(PID)).project.rev)
assert.ok(!(await docOf(PID)).tabs.some((t) => t.id === scratch.id))
await toolFails(mcp, 'undo', { eventId: own.id }, /already undone/)
const uiAdd = history.find((e) => e.action === 'tab.add' && e.actor === 'ui')
assert.ok(uiAdd)
await toolFails(mcp, 'undo', { eventId: uiAdd.id }, /only undo your own/)
ok('notify (push off, sent 0), history, undo of its own change only')

// ------------------------------------------------------ session edits ----

assert.equal((await rest('PATCH', `/proj/${PID}`, { sessionEdits: false })).status, 200)
await toolFails(mcp, 'tab_add', { kind: 'markdown', title: 'nope' }, /session edits are off/)
await tool<Got>(mcp, 'project_get')
await toolFails(mcp, 'project_update', { nextAction: 'nope' }, /session edits are off/)
assert.equal((await rest('PATCH', `/proj/${PID}`, { sessionEdits: true })).status, 200)
const upd = await tool<{ nextAction: string }>(mcp, 'project_update', { nextAction: 'verify relink' })
assert.equal(upd.nextAction, 'verify relink')
ok('sessionEdits off refuses writes and still serves reads')

// ---------------------------------------------------------- long-poll ----

const now0 = await rest<ProjChange>('GET', `/proj/${PID}/changes?rev=0`)
assert.equal(now0.status, 200)
assert.equal(now0.headers.get('cache-control'), 'no-store')
assert.ok(now0.body.rev > 0)

let settled = false
const poll = rest<ProjChange>('GET', `/proj/${PID}/changes?rev=${now0.body.rev}`).finally(() => { settled = true })
await sleep(1_000)
assert.equal(settled, false, 'the long-poll answered with nothing changed')
const t0 = Date.now()
await tool(mcp, 'tab_append', { tabId: notesId, text: 'wake the page' })
const woke = await poll
const took = Date.now() - t0
assert.ok(took < 2_000, `long-poll took ${took} ms after the tool call`)
assert.ok(woke.body.rev > now0.body.rev)
assert.equal(woke.body.lastEvent?.action, 'tab.append')
assert.equal(woke.body.lastEvent?.actor, ACTOR)

const ac = new AbortController()
const abandoned = fetch(`${BASE}/proj/${PID}/changes?rev=${woke.body.rev}`, { signal: ac.signal })
setTimeout(() => ac.abort(), 200)
await assert.rejects(abandoned, { name: 'AbortError' })
const after = await rest<ProjChange>('GET', `/proj/${PID}/changes?rev=${woke.body.rev - 1}`)
assert.equal(after.body.rev, woke.body.rev)
ok(`long-poll holds, answers ${took} ms after a tool call, and a client that leaves is released`)

// ------------------------------------------------------- work project ----

assert.equal((await rest('POST', '/proj', { id: WORK, name: 'vk smoke work', area: 'work', targetKey: 'work' })).status, 201)
const work = await connect(WORK, { 'X-Valkyrie-Session': SID })
assert.match(work.getInstructions() ?? '', /File contents are off for this project/)
await toolFails(work, 'file_pin', { label: 'doc', content: 'text' }, /file contents are off/)
assert.equal((await tool<FileRef>(work, 'file_pin', { label: 'p', relPath: 'a.txt' })).kind, 'path')
const rel = await tool<Reminder & { atLocal: string }>(work, 'reminder_add', { inMinutes: 90, message: 'relative' })
assert.ok(Math.abs(Date.parse(rel.at) - (Date.now() + 90 * 60_000)) < 60_000)
assert.match(rel.atLocal, /GMT-[45]$/)
await toolFails(work, 'reminder_add', { at: rel.at, inMinutes: 5, message: 'both' }, /exactly one of at or inMinutes/)
await work.close()
const cf = { 'cf-ray': 'test' }
const listCf = await rest<ProjectSummary[]>('GET', '/proj', undefined, cf)
assert.ok(listCf.body.some((p) => p.id === PID))
assert.ok(!listCf.body.some((p) => p.id === WORK))
assert.ok((await rest<ProjectSummary[]>('GET', '/proj')).body.some((p) => p.id === WORK))
assert.equal((await rest('GET', `/proj/${WORK}`, undefined, cf)).status, 404)
assert.equal((await rest('POST', '/proj', { name: 'vk smoke cf', area: 'work', targetKey: 'work' }, cf)).status, 403)
const areas = (await rest<{ areas: string[]; mixable: string[] }>('GET', '/proj-areas')).body
assert.deepEqual(areas.areas, ['personal', 'server', 'work', 'client2'])
const { sessionArea } = await import('../src/lib/projectAreas.js')
assert.equal(sessionArea('work', 'C:\\Clients2\\acme'), 'client2')
assert.equal(sessionArea('work', 'C:\\Other\\acme'), 'work')
assert.equal(sessionArea('personal', 'C:\\Clients2\\acme'), 'personal')
assert.equal((await rest('PATCH', `/proj/${PID}`, { area: 'client2' }, cf)).status, 403)
assert.equal((await rest('PATCH', `/proj/${PID}`, { area: 'nope' })).status, 400)
assert.equal((await docOf(PID)).project.area, 'personal')
assert.equal((await rest('POST', `/proj/${WORK}/archive`)).status, 200)
assert.equal((await rawMcp(WORK)).status, 404)
ok('work project: no file contents, hidden from Cloudflare requests and not made through them, archived means 404 to sessions')

// ---------------------------------------------------------- the page ----

doc = await docOf(PID)
const onPage = doc.tabs.find((t) => t.id === test.id)
assert.equal(onPage?.createdBy, ACTOR)
assert.equal(onPage?.updatedBy, ACTOR)
assert.equal(doc.project.nextAction, 'verify relink')
assert.equal(doc.lastEvent?.actor, ACTOR)
ok(`the REST doc shows the session's tab, createdBy ${ACTOR}`)

await mcp.close()
server.closeAllConnections()
server.close()
console.log('projects mcp smoke ok')
process.exit(0)
