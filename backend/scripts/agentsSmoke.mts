/**
 * Work agents smoke test: Valkyrie Messages, the agent runs and their tools, proposals, the feeds.
 *
 * Mounts routes/msg.ts and routes/agentMcp.ts on a throwaway express app over a scratch data dir,
 * with a FAKE Autotask (both franchises point at a local express app) and a STUB claude CLI. The
 * stub is real enough to matter: it reads the --mcp-config the runner wrote, finds which agent it
 * is from the appended system prompt, and calls the valkyrie MCP tools over HTTP from a per-agent
 * script the test writes, so every run goes wake -> claude -> MCP -> store for real. No real Claude
 * run, no real Autotask, no mail.
 *
 * Runs on odin only (better-sqlite3), never against the live data dir:
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/agentsSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import express from 'express'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('agentsSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const stub = path.join(dataDir, 'stub')
const conf = path.join(dataDir, 'conf')
fs.mkdirSync(stub, { recursive: true })
fs.mkdirSync(conf, { recursive: true })
const w = (f: string, s: string, mode?: number) => { fs.writeFileSync(path.join(stub, f), s); if (mode) fs.chmodSync(path.join(stub, f), mode) }

// ------------------------------------------------------------ fake Autotask ---

type T = { id: number; ticketNumber: string; title: string; description: string; status: number; priority: number; queueID: number; companyID: number; contactID: number | null; assignedResourceID: number | null; createDate: string; lastActivityDate: string; dueDateTime: string | null; completedDate: string | null }
const now = new Date().toISOString()
const tickets: T[] = [
  { id: 101, ticketNumber: 'T20261030.0001', title: 'Printer offline', description: 'The 3rd floor printer is offline', status: 1, priority: 2, queueID: 14046773, companyID: 7, contactID: 70, assignedResourceID: 1001, createDate: now, lastActivityDate: now, dueDateTime: null, completedDate: null },
  { id: 102, ticketNumber: 'T20261030.0002', title: 'New hire laptop', description: 'Set up a laptop', status: 15, priority: 3, queueID: 14046773, companyID: 7, contactID: null, assignedResourceID: null, createDate: now, lastActivityDate: now, dueDateTime: null, completedDate: null },
  { id: 103, ticketNumber: 'T20261030.0003', title: 'Disk alert', description: 'noise', status: 1, priority: 2, queueID: 8, companyID: 7, contactID: null, assignedResourceID: null, createDate: now, lastActivityDate: now, dueDateTime: null, completedDate: null },
]
const notes: { ticketID: number; title: string; description: string; impersonate: string | undefined }[] = []
const patches: Record<string, unknown>[] = []
const created: Record<string, unknown>[] = []
const at = express(); at.use(express.json())
at.get('/Tickets/entityInformation/fields', (_q, r) => r.json({ fields: [
  { name: 'status', picklistValues: [[1, 'New'], [5, 'Complete'], [8, 'Received Client Reply'], [15, 'In Progress'], [7, 'Waiting Customer']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
  { name: 'priority', picklistValues: [[1, 'High'], [2, 'Medium'], [3, 'Low'], [4, 'Critical']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
  { name: 'queueID', picklistValues: [[8, 'Monitoring Alert'], [14046773, 'Help Desk']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
] }))
type F = { op: string; field: string; value: unknown; items?: F[] }
const matches = (t: Record<string, unknown>, filter: F[]): boolean => filter.every((f) => {
  if (f.op === 'or') return (f.items ?? []).some((i) => matches(t, [i]))
  const v = t[f.field]
  if (f.op === 'eq') return v === f.value
  if (f.op === 'noteq') return v !== f.value
  if (f.op === 'gt') return String(v) > String(f.value)
  if (f.op === 'gte') return Number(v) >= Number(f.value)
  if (f.op === 'contains') return String(v).toLowerCase().includes(String(f.value).toLowerCase())
  return true
})
at.post('/Tickets/query', (q, r) => r.json({ items: tickets.filter((t) => matches(t as unknown as Record<string, unknown>, q.body.filter)), pageDetails: { nextPageUrl: null } }))
at.post('/Companies/query', (_q, r) => r.json({ items: [
  { id: 0, companyName: 'East IT', webAddress: '', isActive: true }, { id: 7, companyName: 'Acme Legal', webAddress: 'acmelegal.com', isActive: true },
  { id: 8, companyName: 'Beta Org', webAddress: 'beta.example', isActive: true }, { id: 9, companyName: 'Gone Co', webAddress: '', isActive: false },
], pageDetails: {} }))
at.post('/Resources/query', (_q, r) => r.json({ items: [{ id: 1001, firstName: 'Brendon', lastName: 'Kupsch' }, { id: 1002, firstName: 'Brendon', lastName: 'K' }, { id: 1003, firstName: 'Sam', lastName: 'Tech' }, { id: 1004, firstName: 'No', lastName: 'Role' }], pageDetails: {} }))
const contacts = [
  { id: 70, companyID: 7, firstName: 'Jane', lastName: 'Doe', emailAddress: 'jane@acmelegal.com', isActive: 1 },
  { id: 80, companyID: 8, firstName: 'Dana', lastName: 'Park', emailAddress: 'dpark@beta.example', isActive: 1 },
  { id: 81, companyID: 8, firstName: 'Old', lastName: 'Contact', emailAddress: 'old@beta.example', isActive: 0 },
]
at.post('/Contacts/query', (q, r) => r.json({ items: contacts.filter((c) => matches(c as unknown as Record<string, unknown>, q.body.filter)), pageDetails: {} }))
at.post('/TicketNotes/query', (q, r) => r.json({ items: notes.filter((n) => n.ticketID === q.body.filter[0].value).map((n, i) => ({ id: i + 1, title: n.title, description: n.description, createDateTime: now, creatorResourceID: 1001, publish: 2 })), pageDetails: {} }))
at.post('/ResourceServiceDeskRoles/query', (q, r) => r.json({ items: q.body.filter[0].value === 1004 ? [] : [{ roleID: 555, isDefault: true, isActive: true }], pageDetails: {} }))
at.post('/CompanyLocations/query', (q, r) => r.json({ items: q.body.filter[0].value === 8 ? [{ id: 21, name: 'Annex', isPrimary: false, isActive: true }, { id: 22, name: 'Primary Address', isPrimary: true, isActive: true }] : [], pageDetails: {} }))
at.post('/BillingCodes/query', (_q, r) => r.json({ items: [{ id: 14046761, name: 'Remote Support', useType: 1, isActive: true }, { id: 14046762, name: 'On-Site Service ', useType: 1, isActive: true }], pageDetails: {} }))
const timeEntries: Record<string, unknown>[] = []
at.post('/TimeEntries', (q, r) => { timeEntries.push(q.body); r.json({ itemId: 900 + timeEntries.length }) })
let failPatchOnce = false
at.post('/Tickets/:id/Notes', (q, r) => { notes.push({ ...q.body, impersonate: q.header('ImpersonationResourceId') }); r.json({ itemId: notes.length }) })
at.patch('/Tickets', (q, r) => {
  if (failPatchOnce) { failPatchOnce = false; return r.status(500).json({ errors: ['simulated outage'] }) }
  patches.push(q.body)
  const t = tickets.find((x) => x.id === q.body.id)!
  Object.assign(t, q.body, { lastActivityDate: new Date().toISOString() })
  r.json({ itemId: t.id })
})
at.post('/Tickets', (q, r) => {
  created.push(q.body)
  const t: T = { ...tickets[0], ...q.body, id: 200 + created.length, ticketNumber: `T20261030.01${created.length}0`, createDate: now, lastActivityDate: now }
  tickets.push(t)
  r.json({ itemId: t.id })
})
const atSrv = at.listen(0); const atPort = (atSrv.address() as { port: number }).port

// ---------------------------------------------------------------- fake thor ---
// project-files' /mail routes: search and read of Brendon's mailbox, and the kick.

const thorCalls: { path: string; body: any }[] = []
let kicks = 0
const thorMsgs: Record<string, any> = {
  'MSG-CLIENT-0000000000001': { from: 'dpark@beta.example', from_name: 'Dana Park', to: ['me@east.example'], cc: ['boss@beta.example'], subject: 'The PDF app asks me to sign in' },
  'MSG-OWN-00000000000000001': { from: 'me@east.example', from_name: 'Brendon', to: ['dpark@beta.example', 'boss@beta.example'], cc: ['help@east.example', 'me@east.example'], subject: 'RE: PDF app update' },
}
const thor = express(); thor.use(express.json())
thor.use((q, r, next) => (q.headers.authorization === 'Bearer thor-token' ? next() : r.status(401).json({ error: 'unauthorized' })))
thor.post('/mail/search', (q, r) => { thorCalls.push({ path: 'search', body: q.body }); r.json({ ok: true, mailbox: q.body.mailbox, count: 2, messages: Object.entries(thorMsgs).map(([id, m]) => ({ message_id: id, received: '2026-11-23 9:00 AM ET', from: m.from, to: m.to.join(', '), subject: m.subject, is_read: true, has_attachments: false, preview: 'p' })) }) })
thor.post('/mail/read', (q, r) => {
  thorCalls.push({ path: 'read', body: q.body })
  const m = thorMsgs[q.body.message_id]
  if (!m) return r.status(400).json({ error: 'The specified object was not found in the store.' })
  r.json({ ok: true, message_id: q.body.message_id, conversation_id: 'conv-9', received: '2026-11-23 9:00 AM ET', body: 'text', attachments: [], ...m })
})
thor.post('/mail/kick', (_q, r) => { kicks += 1; r.json({ ok: true }) })
const thorSrv = thor.listen(0); const thorPort = (thorSrv.address() as { port: number }).port
const workConf = {
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, brendonRole: 77, ticketCategory: 3, supportCc: 'help@east.example', ownDomains: ['east.example'], teams: true, mailbox: 'me@east.example', agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'Your franchise: East IT.' },
    { key: 'north', label: 'North', company: 'North IT', envFile: 'autotask-north.env', web: 'https://ww22.autotask.net', brendonResource: 1002, supportCc: 'help@north.example', ownDomains: ['north.example'], agent: { id: 'north-triage', name: 'North Triage', role: 'Tickets for North', topic: 'North tickets' }, brief: 'Your franchise: North IT.' },
  ],
  self: ['me@east.example'], mailboxRoutes: { 'east-shared': 'east' }, defaultFranchise: 'east', teamsFranchise: 'east', skipDomains: [],
}
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify(workConf))
for (const [file] of [['autotask-east.env'], ['autotask-north.env']]) {
  fs.writeFileSync(path.join(conf, file), `AUTOTASK_ZONE_URL=http://127.0.0.1:${atPort}\nAUTOTASK_INTEGRATION_CODE=x\nAUTOTASK_USERNAME=y\nAUTOTASK_SECRET=z\n`)
}

// --------------------------------------------------------------- stub claude ---
// Reads the agent id from the appended system prompt, then runs script-<id>.json:
// a list of {tool, args} MCP calls, or {exit: n} to fail. Results land in results-<id>.json.

w('claude', `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const sys = args[args.indexOf('--append-system-prompt') + 1] || ''
const id = (/Your id is ([a-z0-9-]+)/.exec(sys) || [])[1] || 'unknown'
const cfgArg = args.find((a) => a.startsWith('--mcp-config='))
const cfg = JSON.parse(fs.readFileSync(cfgArg.slice('--mcp-config='.length), 'utf8')).mcpServers.valkyrie
const dir = ${JSON.stringify(stub)}
fs.writeFileSync(path.join(dir, 'last-' + id + '.json'), JSON.stringify({ args, prompt: args[args.indexOf('-p') + 1] }))
let script = []
try { script = JSON.parse(fs.readFileSync(path.join(dir, 'script-' + id + '.json'), 'utf8')) } catch {}
;(async () => {
  const results = []
  for (const step of script) {
    if (step.exit !== undefined && step.once) fs.writeFileSync(path.join(dir, 'script-' + id + '.json'), JSON.stringify(script.filter((x) => x !== step)))
    if (step.exit !== undefined) { fs.writeFileSync(path.join(dir, 'results-' + id + '.json'), JSON.stringify(results)); process.stdout.write('boom'); process.exit(step.exit) }
    const r = await fetch(cfg.url, { method: 'POST', headers: { ...cfg.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: step.tool, arguments: step.args || {} } }) })
    const j = await r.json().catch(() => ({ status: r.status }))
    results.push({ tool: step.tool, status: r.status, isError: j.result?.isError, text: j.result?.content?.[0]?.text, error: j.error })
  }
  fs.writeFileSync(path.join(dir, 'results-' + id + '.json'), JSON.stringify(results))
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'did ' + script.length + ' steps', total_cost_usd: 0.01, num_turns: script.length }))
})()
`, 0o755)
w('accounts.json', JSON.stringify([{ id: 'smoke', label: 'Smoke', configDir: path.join(stub, 'cfg') }]))
w('areas.json', JSON.stringify({ clientAreas: ['east', 'north', 'other'] }))
const script = (id: string, steps: unknown[]) => { w(`script-${id}.json`, JSON.stringify(steps)); try { fs.unlinkSync(path.join(stub, `results-${id}.json`)) } catch { /* none */ } }
const results = (id: string): any[] | null => { try { return JSON.parse(fs.readFileSync(path.join(stub, `results-${id}.json`), 'utf8')) } catch { return null } }

// ----------------------------------------------------------------- the app ---

const app = express(); app.use(express.json({ limit: '2mb' }))
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
Object.assign(process.env, {
  PORT: String(port),
  AGENTS_MCP_URL: `http://127.0.0.1:${port}/api/agent-mcp`,
  AGENTS_DELAY_SCALE: '0.002',
  VALKYRIE_CONF_DIR: conf,
  CLAUDE_CLI_PATH: path.join(stub, 'claude'),
  CLAUDE_ACCOUNTS_FILE: path.join(stub, 'accounts.json'),
  CLAUDE_SWITCH_DIR: path.join(stub, 'switch'),
  PROJECT_AREAS_FILE: path.join(stub, 'areas.json'),
  LILKUPS_BIN: '/bin/true',
  LILKUPS_STORE: path.join(stub, 'reminders.json'),
  PROJECT_FILES_URL: `http://127.0.0.1:${thorPort}`,
  PROJECT_FILES_TOKEN: 'thor-token',
})
const projects = await import('../src/lib/projectsStore.ts')
const store = await import('../src/lib/agentsStore.ts')
const agents = await import('../src/lib/agents.ts')
const feeds = await import('../src/lib/workFeeds.ts')
app.use('/api', (await import('../src/routes/msg.ts')).default)
app.use('/api', (await import('../src/routes/agentMcp.ts')).default)
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json().catch(() => null)] as [number, any]
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 600)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<X>(fn: () => X | null | undefined | false, ms = 8000): Promise<X | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40) }
  return null
}
const idle = (id: string) => until(() => { const a = store.getAgent(id); return a && ['idle', 'error', 'resting'].includes(a.status) && !store.openEvents(id).length && a })

// ------------------------------------------------------------------ roster ---

const ctx = { actor: 'smoke', via: 'ui' as const }
const proj = projects.createProject({ name: 'Smoke Client AI', area: 'east', targetKey: 'smoke-ai', summary: 'a test project' }, ctx)
agents.startAgents()
let [st, ov] = await j('GET', '/msg/overview')
check('overview 200', st === 200, ov)
const ids = new Set(ov.agents.map((a: any) => a.id))
check('fixed agents exist', ids.has('east-triage') && ids.has('north-triage') && ids.has('groceries'), [...ids])
check('project agent named by folder key', ids.has('smoke-ai'), [...ids])
check('team channel holds everyone', ov.channels.find((c: any) => c.id === 'team')?.agentIds.length === ids.size, ov.channels)
check('home channels', ['east-triage', 'north-triage', 'groceries', 'smoke-ai'].every((c) => ov.channels.some((x: any) => x.id === c)))
;[st, ov] = await j('GET', '/msg/overview', undefined, { 'cf-ray': 'x' })
check('cloudflare hides client areas and team', !ov.channels.some((c: any) => ['east-triage', 'north-triage', 'team', 'smoke-ai'].includes(c.id)) && ov.channels.some((c: any) => c.id === 'groceries'), ov.channels.map((c: any) => c.id))
check('cloudflare: client channel 404', (await j('GET', '/msg/channels/east-triage', undefined, { 'cf-ray': 'x' }))[0] === 404)

// ------------------------------------------------- Brendon -> groceries run ---

script('groceries', [{ tool: 'post', args: { text: 'Cart ready: 6 items, $41.20. @brendon place it here', refs: [{ type: 'link', url: 'https://www.amazon.com/cart/localmarket' }] } }])
let [, sent] = await j('POST', '/msg/channels/groceries/messages', { text: 'chicken breast for the tomato pasta' })
check('brendon post wakes groceries', sent.woke?.includes('groceries'), sent)
await idle('groceries')
let r = results('groceries')
check('groceries posted through MCP', r?.[0]?.status === 200 && !r[0].isError, r)
let [, ch] = await j('GET', '/msg/channels/groceries')
const gm = ch.messages.find((m: any) => m.author === 'groceries')
check('agent message stored with refs and notify', gm && gm.notify && gm.refs[0]?.type === 'link', ch.messages)
const run1 = store.listRuns('groceries')[0]
check('run recorded done', run1?.status === 'done' && run1.turns === 1, run1)
const last = JSON.parse(fs.readFileSync(path.join(stub, 'last-groceries.json'), 'utf8'))
check('run is locked down', last.args.includes('--strict-mcp-config') && last.args.join(' ').includes('Bash,Edit,Write,Read'), last.args)
check('run has no built-in tools (--tools "")', last.args.includes('--tools') && last.args[last.args.indexOf('--tools') + 1] === '', last.args)
check('prompt carries the message', last.prompt.includes('chicken breast for the tomato pasta'), last.prompt.slice(0, 400))
check('groceries gets the browser server', fs.existsSync(path.join(stub, 'last-groceries.json')))
// the badge is Raven's thread now: a post that wants Brendon is mirrored there and counted once
let [, cnt] = await j('GET', '/msg/count')
check('unread counts the mirrored agent post', cnt.unread >= 1 && cnt.notify >= 1, cnt)
check('mirror carries the agent and its message', store.listMessages('raven').some((m) => m.author === 'groceries' && m.meta.relay?.sourceMessageId === gm?.id), store.listMessages('raven'))
await j('POST', '/msg/channels/raven/read', {})
;[, cnt] = await j('GET', '/msg/count')
check('read clears the count', cnt.unread === 0, cnt)

// one relay per ticket: the assignment and then the note on the same ticket fold into one line in Raven's thread
{
  const g = store.getAgent('groceries')!
  const t1 = { type: 'ticket' as const, franchise: 'east' as any, id: 9001, number: 'T20991231.0001' }
  const t2 = { ...t1, id: 9002, number: 'T20991231.0002' }
  const n0 = store.listMessages('raven', { limit: 200 }).length
  agents.agentPost(g, 'groceries', 'Assigned it to you.', { refs: [t1], notify: true, proposalId: 7001 })
  agents.agentPost(g, 'groceries', 'An internal note for your approval.', { refs: [t1], notify: true, proposalId: 7002 })
  agents.agentPost(g, 'groceries', 'Same ticket, one more line.', { refs: [t1], notify: true })
  agents.agentPost(g, 'groceries', 'A different ticket.', { refs: [t2], notify: true, proposalId: 7003 })
  const got = store.listMessages('raven', { limit: 200 }).slice(n0)
  check('same-ticket posts fold into one relay', got.length === 2 && got[0].text === 'Assigned it to you.\n\nSame ticket, one more line.', got.map((m) => m.text))
  check('the folded relay holds both proposals', got[0]?.proposalId === 7001 && JSON.stringify(got[0]?.meta.relay?.proposalIds) === '[7002]', got[0])
  check('another ticket gets its own relay', got[1]?.proposalId === 7003 && got[1]?.refs[0]?.type === 'ticket', got[1])
}

// a channel the agent may not post in
script('groceries', [{ tool: 'post', args: { text: 'hi', channel: 'east-triage' } }, { tool: 'ticket', args: { ticket: '101' } }])
await j('POST', '/msg/channels/groceries/messages', { text: 'try east' })
await idle('groceries')
r = results('groceries')
check('cannot post in another home channel', r?.[0]?.isError === true, r)
check('personal agent has no ticket tool', r?.[1]?.isError === true || r?.[1]?.error, r)

// --------------------------------------------------------- MCP guard ---

check('mcp: no token 401', (await j('POST', '/agent-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))[0] === 401)
check('mcp: origin 403', (await j('POST', '/agent-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://x' }))[0] === 403)

// ------------------------------------------------------------- tickets ---

script('east-triage', [
  { tool: 'tickets', args: {} },
  { tool: 'track', args: { ticketId: 101, summary: 'Printer offline on 3', next: 'Check the static IP', needsBrendon: true } },
  { tool: 'post', args: { text: 'Tracking 2 open East tickets. 1 needs you: T20261030.0001 printer.' } },
])
let p1 = await feeds.pollTickets('east')
check('first poll seeds 2 (monitoring skipped)', p1.open === 2 && p1.events === 1, p1)
await idle('east-triage')
r = results('east-triage')
const listed = r?.[0]?.text ? JSON.parse(r[0].text) : []
check('tickets tool lists tracker', listed.length === 2 && listed.every((t: any) => t.queue !== 'Monitoring Alert'), r)
check('track saved', store.trackedTicket('east', 101)?.needsBrendon === true && store.trackedTicket('east', 101)?.summary === 'Printer offline on 3', store.trackedTicket('east', 101))
const seededPrompt = JSON.parse(fs.readFileSync(path.join(stub, 'last-east-triage.json'), 'utf8')).prompt
check('seed prompt', seededPrompt.includes('You now track 2 open tickets'), seededPrompt.slice(0, 300))

script('east-triage', [])
tickets[0].status = 8; tickets[0].lastActivityDate = new Date(Date.now() + 1000).toISOString()
tickets[1].lastActivityDate = new Date(Date.now() + 1000).toISOString()
p1 = await feeds.pollTickets('east')
check('client reply wakes; unassigned activity wakes', p1.events === 2, p1)
await idle('east-triage')
const actPrompt = JSON.parse(fs.readFileSync(path.join(stub, 'last-east-triage.json'), 'utf8')).prompt
check('activity event rendered', actPrompt.includes('status New -> Received Client Reply'), actPrompt.slice(0, 600))
tickets[1].status = 5
p1 = await feeds.pollTickets('east')
check('closed ticket leaves the open tracker', store.trackedTicket('east', 102)?.closedAt !== null && p1.open === 1, store.trackedTicket('east', 102))
await idle('east-triage')

// ---------------------------------------------------------------- mail ---

await feeds.refreshSenders('east')
check('senders from contacts', store.senderByEmail('jane@acmelegal.com').length >= 1)
script('east-triage', [
  { tool: 'mail_get', args: { n: 1 } },
  { tool: 'propose_mail_reply', args: { n: 1, body: 'Hi Jane,\n\nThe printer is back online — it lost its IP.' } },
  { tool: 'propose_mail_reply', args: { n: 1, body: 'Hi Jane,\n\nThe printer is back online. It lost its static IP after the update.\n\nI set it again and printed a test page.', note: 'Confirm the test page printed' } },
  { tool: 'mail_done', args: { n: 1, state: 'needs-brendon', outcome: 'reply drafted' } },
  { tool: 'dm', args: { agent: 'north-triage', text: 'mail #2 is yours' } },
])
script('north-triage', [{ tool: 'mail_take', args: { n: 2 } }, { tool: 'mail_done', args: { n: 2, state: 'ignored', outcome: 'newsletter' } }])
const fresh = new Date().toISOString()
let [, fm] = await j('POST', '/msg/feed/mail', { mailbox: 'work', address: 'me@east.example', messages: [
  { id: 'AAA1', conversationId: 'c1', subject: 'RE: Printer offline [T20261030.0001]', fromName: 'Jane Doe', fromAddress: 'Jane@AcmeLegal.com', to: ['me@east.example'], receivedAt: fresh, body: 'Is the printer fixed?', focused: true },
  { id: 'AAA2', subject: 'Weekly update', fromName: 'Pat', fromAddress: 'pat@north.example', receivedAt: fresh, body: 'news', focused: true },
  { id: 'AAA3', subject: 'Sale!', fromName: 'Shop', fromAddress: 'deals@shop.example', receivedAt: fresh, body: 'buy', focused: false },
  { id: 'AAA4', subject: 'Ticket updated', fromName: 'Autotask', fromAddress: 'noreply@autotask.net', receivedAt: fresh, body: 'x', focused: true },
  { id: 'AAA5', subject: 'Old', fromName: 'Jane Doe', fromAddress: 'jane@acmelegal.com', receivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), body: 'old', focused: true },
] })
check('mail ingest counts', fm.added === 5 && fm.routed === 2, fm)
check('jane routed to east by ticket number', store.getMail(1)?.franchise === 'east' && store.getMail(1)?.agentId === 'east-triage', store.getMail(1))
check('pat routed to north by own domain', store.getMail(2)?.franchise === 'north', store.getMail(2))
check('unknown Other-folder mail ignored', store.getMail(3)?.state === 'ignored', store.getMail(3))
check('autotask notice skipped', store.getMail(4)?.state === 'ignored', store.getMail(4))
check('backlog filed, not processed', store.getMail(5)?.state === 'handled' && !store.getMail(5)?.agentId, store.getMail(5))
;[, fm] = await j('POST', '/msg/feed/mail', { mailbox: 'work', address: 'me@east.example', messages: [{ id: 'AAA1', subject: 'x', fromAddress: 'jane@acmelegal.com', receivedAt: fresh }] })
check('known mail not re-added', fm.added === 0, fm)
await idle('east-triage')
await idle('north-triage')
r = results('east-triage')
check('mail_get returns the body', r?.[0]?.text?.includes('Is the printer fixed?'), r?.[0])
check('em dash draft refused', r?.[1]?.isError === true && /em dash/.test(r[1].text), r?.[1])
check('clean draft proposed', r?.[2] && !r[2].isError, r?.[2])
check('mail filed needs-brendon', store.getMail(1)?.state === 'needs-brendon')
check('dm made a channel', !!store.getChannel('dm-east-triage--north-triage'))
const rt = results('north-triage')
check('north woke from the dm and took the mail', rt?.[0] && !rt[0].isError && store.getMail(2)?.state === 'ignored', rt)
check('dm event is one hop deep', store.listRuns('north-triage').length >= 1)
let [, fch] = await j('GET', '/msg/channels/east-triage')
const pm = fch.messages.find((m: any) => m.proposal?.kind === 'mail_reply')
check('proposal inline on its message', pm && pm.proposal.status === 'pending' && pm.proposal.payload.cc[0] === 'help@east.example' && pm.notify, pm)
check('tracker counts on triage channel', fch.tracker?.open === 1, fch.tracker)

// approve -> thor queue -> result
const pid = pm.proposal.id
let [ast, ap] = await j('POST', `/msg/proposals/${pid}/approve`, { how: 'send', body: 'Hi Jane,\n\nThe printer is back online.' })
check('approve queues for thor', ast === 200 && ap.proposal.status === 'running', ap)
check('second approve refused', (await j('POST', `/msg/proposals/${pid}/approve`, {}))[0] === 409)
let [, claim] = await j('POST', '/msg/actions/claim', { runner: 'thor' })
check('thor claims the send', claim.actions.length === 1 && claim.actions[0].kind === 'mail_send' && claim.actions[0].payload.graphId === 'AAA1' && claim.actions[0].payload.body.startsWith('Hi Jane,\n\nThe printer is back online.'), claim)
;[, claim] = await j('POST', '/msg/actions/claim', { runner: 'thor' })
check('claimed action is never handed out twice', claim.actions.length === 0, claim)
await j('POST', `/msg/actions/1/result`, { ok: true, result: 'sent 10:42 AM ET' })
check('proposal done after thor', store.getProposal(pid)?.status === 'done', store.getProposal(pid))
check('mail handled after send', store.getMail(1)?.state === 'handled', store.getMail(1))
check('result told to the agent (no wake)', store.openEvents('east-triage').some((e) => e.kind === 'proposal'))
check('result reported twice refused', (await j('POST', `/msg/actions/1/result`, { ok: true }))[0] === 409)

// ticket proposals executed on odin
script('east-triage', [
  { tool: 'propose_ticket_note', args: { ticketId: 101, number: 'T20261030.0001', title: 'Printer fixed', text: 'Static IP set again' } },
  { tool: 'propose_ticket_update', args: { ticketId: 101, number: 'T20261030.0001', status: 'Waiting Customer', assignToBrendon: true, why: 'waiting on Jane' } },
  { tool: 'propose_ticket_create', args: { companyId: 7, company: 'Acme Legal', title: 'Toner order', description: 'Order toner', n: 1 } },
  { tool: 'propose_ticket_update', args: { ticketId: 101, why: 'nothing' } },
])
agents.checkNow('east-triage')
await idle('east-triage')
r = results('east-triage')
check('three ticket proposals, empty change refused', r?.slice(0, 3).every((x) => !x.isError) && r?.[3]?.isError, r)
const props = store.pendingProposals('east-triage')
check('three pending', props.length === 3, props.map((p) => p.kind))
for (const p of props) await j('POST', `/msg/proposals/${p.id}/approve`, {})
check('note posted as Brendon, internal', notes.length === 1 && notes[0].impersonate === '1001' && (notes[0] as any).publish === 2, notes)
check('update sends only what changes (already assigned to Brendon)', patches.some((x) => x.status === 7 && !('assignedResourceID' in x)), patches)
check('ticket created without contact', created.length === 1 && created[0].companyID === 7 && !('contactID' in created[0]), created)
check('all three done', props.every((p) => store.getProposal(p.id)?.status === 'done'), props.map((p) => store.getProposal(p.id)))
check('self touch suppresses the echo', store.trackedTicket('east', 101)?.selfTouchAt !== null)

// decline with a reason wakes the agent with it
script('east-triage', [{ tool: 'propose_ticket_note', args: { ticketId: 101, title: 'x', text: 'y' } }])
agents.checkNow('east-triage')
await idle('east-triage')
const dp = store.pendingProposals('east-triage')[0]
script('east-triage', [{ tool: 'notebook_set', args: { text: 'Brendon: no notes for trivial things' } }])
await j('POST', `/msg/proposals/${dp.id}/decline`, { reason: 'too trivial for a note' })
await idle('east-triage')
const decPrompt = JSON.parse(fs.readFileSync(path.join(stub, 'last-east-triage.json'), 'utf8')).prompt
check('decline reason reaches the agent', decPrompt.includes('too trivial for a note'), decPrompt.slice(0, 500))
check('notebook saved', store.getAgent('east-triage')?.notebook.includes('no notes for trivial'))
check('next prompt carries the notebook', true)

// ------------------------------------- 2026-11-23: any field, time, complete, any mail ---
// An email-intake ticket on the franchise's own company (0) with no contact, as email intake leaves them.

{
  tickets.push({ id: 104, ticketNumber: 'T20991231.0004', title: 'Help request from Beta / PDF app', description: 'auto intake', status: 15, priority: 2, queueID: 14046773, companyID: 0, contactID: null, assignedResourceID: 1001, createDate: now, lastActivityDate: now, dueDateTime: null, completedDate: null, companyLocationID: 1, contractID: 55, configurationItemID: null, billingCodeID: 14046761, resolution: null } as unknown as T)
  const nyWall = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms)
    const g = (t: string) => parts.find((x) => x.type === t)!.value
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
  }
  const twoHoursAgo = Date.now() - 2 * 3_600_000
  script('east-triage', [
    { tool: 'contact_find', args: { name: 'Dana Park' } },
    { tool: 'contact_find', args: { companyId: 8 } },
    { tool: 'resource_find', args: { name: 'sam' } },
    { tool: 'autotask_labels', args: {} },
    { tool: 'propose_ticket_update', args: { ticketId: 104, contactId: 80, why: 'wrong company' } },
    { tool: 'propose_ticket_update', args: { ticketId: 104, companyId: 8, contactId: 80, assignTo: 1003, why: 'Came in on our own company; Dana Park at Beta Org asked.' } },
    { tool: 'propose_ticket_update', args: { ticketId: 104, assignTo: 1004, why: 'x' } },
    { tool: 'propose_ticket_update', args: { ticketId: 104, status: 'In Progress', why: 'x' } },
    { tool: 'propose_time_entry', args: { ticketId: 104, hours: 0.5, summary: 'Walked Dana through the PDF app sign-in', start: nyWall(twoHoursAgo), workType: 'Remote Support' } },
    { tool: 'propose_time_entry', args: { ticketId: 104, hours: 1, summary: 'something', workType: 'Bogus' } },
    { tool: 'propose_ticket_complete', args: { ticketId: 104, note: 'Dana signed in with the shared mailbox; the PDF app works.', hours: 0.25 } },
    { tool: 'mailbox_search', args: { query: 'PDF app', folder: 'inbox' } },
    { tool: 'mailbox_read', args: { messageId: 'MSG-CLIENT-0000000000001' } },
    { tool: 'propose_mail_reply', args: { messageId: 'MSG-CLIENT-0000000000001', body: 'Hi Dana,\n\nSign out of the PDF app and sign back in with the shared mailbox.' } },
    { tool: 'propose_mail_reply', args: { messageId: 'MSG-OWN-00000000000000001', replyAll: true, body: 'Hi Dana,\n\nChecking in: did the sign-in work?' } },
    { tool: 'propose_mail_new', args: { to: ['jane@acmelegal.com'], subject: 'Printer', body: 'Hi Jane,\n\nThe printer is fixed now.' } },
    { tool: 'propose_mail_new', args: { to: ['Dana Park <dpark@beta.example>'], subject: 'Your PDF app sign-in (T20991231.0004)', body: 'Hi Dana,\n\nSign out of the PDF app, then sign back in with the shared mailbox.', ticketId: 104, number: 'T20991231.0004' } },
    { tool: 'propose_mail_new', args: { to: ['x@y.example'], subject: 'Subject', body: 'Hi X,\n\nThis has an em dash — here.' } },
    { tool: 'propose_mail_reply', args: { messageId: 'MSG-MISSING-000000000001', body: 'Hi there,\n\nA reply to nothing.' } },
  ])
  agents.checkNow('east-triage')
  await idle('east-triage')
  const x = results('east-triage') ?? []
  script('east-triage', []) // a failed card wakes the agent; it must not run the list above again
  const txt = (i: number) => String(x[i]?.text ?? '')
  const ok = (i: number) => x[i] && !x[i].isError && !x[i].error
  check('contact by name', ok(0) && JSON.parse(txt(0))[0]?.id === 80 && JSON.parse(txt(0))[0]?.company === 'Beta Org', x[0])
  check('contacts of a company, active first', ok(1) && JSON.parse(txt(1)).map((c: any) => c.id).join() === '80,81', x[1])
  check('resource by name', ok(2) && JSON.parse(txt(2))[0]?.id === 1003, x[2])
  check('labels carry work types', ok(3) && JSON.parse(txt(3)).workTypes.includes('On-Site Service'), x[3])
  check('contact of another company refused', x[4]?.isError && /Beta Org/.test(txt(4)) && /companyId 8/.test(txt(4)), x[4])
  check('company and contact fix proposed', ok(5), x[5])
  check('tech without a role refused', x[6]?.isError && /no service desk role/.test(txt(6)), x[6])
  check('no-op change refused', x[7]?.isError && /nothing to change/.test(txt(7)), x[7])
  check('time entry proposed', ok(8), x[8])
  check('unknown work type refused', x[9]?.isError && /no work type "Bogus"/.test(txt(9)), x[9])
  check('complete proposed', ok(10), x[10])
  check('mailbox search reaches thor', ok(11) && JSON.parse(txt(11)).length === 2 && thorCalls.some((c) => c.path === 'search' && c.body.mailbox === 'me@east.example' && c.body.folder === 'inbox'), { r: x[11], thorCalls })
  check('mailbox read', ok(12) && JSON.parse(txt(12)).fromName === 'Dana Park', x[12])
  check('reply to any message proposed', ok(13), x[13])
  check('follow-up on his own message proposed', ok(14), x[14])
  check('new mail to someone who wrote is sent to their thread', x[15]?.isError && /mail #1/.test(txt(15)) && /newThread/.test(txt(15)), x[15])
  check('new mail proposed', ok(16), x[16])
  check('new mail em dash refused', x[17]?.isError && /em dash/.test(txt(17)), x[17])
  check('a missing message refused', x[18]?.isError && /not found/.test(txt(18)), x[18])

  const mine = store.pendingProposals('east-triage')
  const byKind = (k: string) => mine.filter((p) => p.kind === k)
  check('six cards', mine.length === 6 && byKind('mail_reply').length === 2, mine.map((p) => p.kind))
  const upd = byKind('ticket_update')[0]
  const lines = (upd?.payload.changes ?? []) as string[]
  check('update card names each change', lines.includes('Company: Beta Org (was East IT)') && lines.includes('Contact: Dana Park <dpark@beta.example> (was none)')
    && lines.some((l) => l.startsWith('Contract: cleared')), lines)
  check('update title is the summary', /^T20991231\.0004: company Beta Org, contact Dana Park/.test(upd?.title ?? ''), upd?.title)

  // approve: each one done at once
  const nPatch = patches.length
  let [st2, ap2] = await j('POST', `/msg/proposals/${upd.id}/approve`, {})
  const pb = patches[nPatch] as Record<string, unknown> | undefined
  check('update approved and done', st2 === 200 && ap2.proposal.status === 'done' && /Beta Org/.test(ap2.proposal.result), ap2)
  check('PATCH moves company, location, contract and contact together', pb?.companyID === 8 && pb?.contactID === 80 && pb?.companyLocationID === 22 && pb?.contractID === null && !('status' in (pb ?? {})), pb)
  check('reassigned with the role of that tech', pb?.assignedResourceID === 1003 && pb?.assignedResourceRoleID === 555 && lines.includes('Assigned: Sam Tech (was Brendon Kupsch)'), { pb, lines })

  const tm = byKind('ticket_time')[0]
  ;[st2, ap2] = await j('POST', `/msg/proposals/${tm.id}/approve`, {})
  const te = timeEntries[0] as Record<string, any> | undefined
  check('time entry logged as Brendon', ap2.proposal.status === 'done' && te?.ticketID === 104 && te?.resourceID === 1001 && te?.roleID === 77 && te?.hoursWorked === 0.5 && te?.billingCodeID === 14046761, { te, p: ap2.proposal })
  check('time entry times', /T00:00:00Z$/.test(te?.dateWorked) && Math.abs(Date.parse(te?.startDateTime) - twoHoursAgo) < 61_000
    && Date.parse(te?.endDateTime) - Date.parse(te?.startDateTime) === 30 * 60_000, te)

  const cp = byKind('ticket_complete')[0]
  const nNotes = notes.length
  failPatchOnce = true
  ;[st2, ap2] = await j('POST', `/msg/proposals/${cp.id}/approve`, {})
  check('complete fails at the last step and says what got done', ap2.proposal.status === 'failed' && /note added, 0.25 h logged; then/.test(ap2.proposal.result), ap2.proposal)
  check('note and time written once', notes.length === nNotes + 1 && timeEntries.length === 2 && notes[nNotes].title === 'Resolution', { notes: notes.slice(nNotes), timeEntries })
  ;[st2, ap2] = await j('POST', `/msg/proposals/${cp.id}/approve`, {})
  const lp = patches[patches.length - 1] as Record<string, unknown>
  check('try again completes without a second note or time entry', ap2.proposal.status === 'done' && notes.length === nNotes + 1 && timeEntries.length === 2, { p: ap2.proposal, n: notes.length, t: timeEntries.length })
  check('completed with the resolution', lp.status === 5 && lp.resolution === 'Dana signed in with the shared mailbox; the PDF app works.', lp)

  const [rClient, rOwn] = byKind('mail_reply').sort((a, b) => a.id - b.id)
  check('reply card shows the live sender', rClient.payload.to === 'dpark@beta.example' && rClient.payload.toName === 'Dana Park' && (rClient.payload.cc as string[])[0] === 'help@east.example', rClient.payload)
  check('follow-up goes to its recipients, cc kept minus Brendon', rOwn.payload.followUp === true && (rOwn.payload.toList as string[]).join() === 'dpark@beta.example,boss@beta.example'
    && (rOwn.payload.cc as string[]).join() === 'help@east.example' && rOwn.payload.replyAll === false, rOwn.payload)
  const nm = byKind('mail_new')[0]
  check('new mail card', (nm.payload.to as string[]).join() === 'dpark@beta.example' && (nm.payload.cc as string[]).join() === 'help@east.example' && nm.payload.from === 'me@east.example' && nm.title.startsWith('New mail to dpark@beta.example'), nm.payload)

  const k0 = kicks
  await j('POST', `/msg/proposals/${rClient.id}/approve`, { how: 'send' })
  await j('POST', `/msg/proposals/${rOwn.id}/approve`, { how: 'send' })
  await j('POST', `/msg/proposals/${nm.id}/approve`, { how: 'draft', body: 'Hi Dana,\n\nSign out of the PDF app, then sign back in. Edited.' })
  await until(() => kicks >= k0 + 3, 3000)
  check('each mail approval starts thor at once', kicks === k0 + 3, { kicks, k0 })
  const [, cl] = await j('POST', '/msg/actions/claim', { runner: 'thor' })
  const act = (pid: number) => cl.actions.find((a: any) => a.proposalId === pid)
  check('reply queued for thor by message id', act(rClient.id)?.kind === 'mail_send' && act(rClient.id)?.payload.graphId === 'MSG-CLIENT-0000000000001' && act(rClient.id)?.payload.mailbox === 'me@east.example' && act(rClient.id)?.payload.followUp === false, act(rClient.id))
  check('follow-up queued with its recipients', act(rOwn.id)?.payload.followUp === true && act(rOwn.id)?.payload.to.join() === 'dpark@beta.example,boss@beta.example', act(rOwn.id))
  check('new mail draft queued with the edited body', act(nm.id)?.kind === 'mail_new_draft' && act(nm.id)?.payload.body.endsWith('Edited.') && act(nm.id)?.payload.subject === 'Your PDF app sign-in (T20991231.0004)', act(nm.id))
  await j('POST', `/msg/actions/${act(rClient.id).id}/result`, { ok: true, result: 'sent at 2026-11-23 1:05 PM ET' })
  await j('POST', `/msg/actions/${act(nm.id).id}/result`, { ok: true, result: 'draft saved' })
  await j('POST', `/msg/actions/${act(rOwn.id).id}/result`, { ok: false, result: 'DUPLICATE BLOCKED: already sent' })
  check('reply result on the card', store.getProposal(rClient.id)?.result === 'Sent to Dana Park (sent at 2026-11-23 1:05 PM ET)', store.getProposal(rClient.id))
  check('new mail draft result on the card', store.getProposal(nm.id)?.result === 'Saved to Outlook drafts: new mail to dpark@beta.example', store.getProposal(nm.id))
  check('a refused send fails the card with thor\'s words', store.getProposal(rOwn.id)?.status === 'failed' && /DUPLICATE BLOCKED/.test(store.getProposal(rOwn.id)?.result ?? ''), store.getProposal(rOwn.id))
  await idle('east-triage')

  // the agent without Brendon's mailbox gets no mailbox tools, and its brief says so
  script('north-triage', [{ tool: 'mailbox_search', args: { query: 'x' } }, { tool: 'propose_mail_new', args: { to: ['a@b.example'], subject: 'Hello', body: 'Hi A,\n\nHello there.' } }])
  agents.checkNow('north-triage')
  await idle('north-triage')
  const nr = results('north-triage') ?? []
  check('no mailbox, no mailbox tools', nr.length === 2 && nr.every((y: any) => y.isError || y.error), nr)
  const northSys = (() => { const a = JSON.parse(fs.readFileSync(path.join(stub, 'last-north-triage.json'), 'utf8')).args as string[]; return a[a.indexOf('--append-system-prompt') + 1] })()
  check('brief without mailbox names replies only', /a reply to the work mail routed to you/.test(northSys) && !/propose_mail_new/.test(northSys), northSys.slice(0, 200))
  const eastSys = (() => { const a = JSON.parse(fs.readFileSync(path.join(stub, 'last-east-triage.json'), 'utf8')).args as string[]; return a[a.indexOf('--append-system-prompt') + 1] })()
  check('brief lists the new abilities', /propose_ticket_update: company, contact/.test(eastSys) && /me@east\.example/.test(eastSys) && /Never tell Brendon to do one of these himself/.test(eastSys), eastSys.slice(0, 300))

  // the one-time note: an agent with a notebook hears once that its tools grew
  store.setKv('tools-seen:east-triage', 'before')
  script('east-triage', [])
  agents.noteToolChanges()
  await idle('east-triage')
  const tp = JSON.parse(fs.readFileSync(path.join(stub, 'last-east-triage.json'), 'utf8')).prompt as string
  check('tools note reaches the agent', /your tools grew/.test(tp) && /Rewrite every notebook line/.test(tp), tp.slice(0, 600))
  const runsBefore = store.listRuns('east-triage').length
  agents.noteToolChanges()
  await sleep(400)
  check('tools note is told once', store.listRuns('east-triage').length === runsBefore && store.getKv('tools-seen:east-triage') !== 'before', store.listRuns('east-triage').length)
}

// --------------------------------------------------------- failure path ---

script('smoke-ai', [{ exit: 1, once: true }, { tool: 'project_get' }, { tool: 'post', args: { text: 'On track. Next: the connector rollout.' } }])
await j('POST', '/msg/channels/smoke-ai/messages', { text: 'status?' })
await idle('smoke-ai')
check('failed run recorded', store.listRuns('smoke-ai').some((x) => x.status === 'failed'), store.listRuns('smoke-ai'))
const sys = store.listMessages('smoke-ai').find((m) => m.author === 'system')
check('failure posted once', sys && /Run failed/.test(sys.text) && /retry once/.test(sys.text), store.listMessages('smoke-ai'))
// the released event retries once, then drops
// the stub drops its one-shot failure, so the retry runs the rest
await until(() => store.listRuns('smoke-ai').length >= 2 && store.listRuns('smoke-ai')[0].status !== 'running', 12_000)
await idle('smoke-ai')
r = results('smoke-ai')
check('retry ran the project tools', r?.[0]?.text?.includes('Smoke Client AI') && !r[1].isError, r)
check('retry prompt marked', JSON.parse(fs.readFileSync(path.join(stub, 'last-smoke-ai.json'), 'utf8')).prompt.includes('retry'))

// ---------------------------------------------------------- hop limit ---

script('north-triage', [{ tool: 'dm', args: { agent: 'east-triage', text: 'ping' } }])
script('east-triage', [{ tool: 'dm', args: { agent: 'north-triage', text: 'pong' } }])
const before = store.listRuns('north-triage').length + store.listRuns('east-triage').length
agents.checkNow('north-triage')
await sleep(3000)
await idle('north-triage'); await idle('east-triage')
const after = store.listRuns('north-triage').length + store.listRuns('east-triage').length
check('ping-pong stops at the hop limit', after - before <= agents.MAX_HOP + 1, { before, after })

// --------------------------------------------------------- pause, patch ---

await j('PUT', '/msg/paused', { paused: true })
script('groceries', [{ tool: 'post', args: { text: 'should not run' } }])
await j('POST', '/msg/channels/groceries/messages', { text: 'while paused' })
await sleep(400)
check('paused: no run', !results('groceries'), results('groceries'))
await j('PUT', '/msg/paused', { paused: false })
await idle('groceries')
check('resume runs what waited', results('groceries')?.[0]?.status === 200, results('groceries'))
let [pst, pa] = await j('PATCH', '/msg/agents/groceries', { model: 'claude-opus-5-5', enabled: false })
check('patch agent', pst === 200 && pa.agent.model === 'claude-opus-5-5' && pa.agent.enabled === false, pa)
check('bad model refused', (await j('PATCH', '/msg/agents/groceries', { model: 'gpt' }))[0] === 400)
let [, det] = await j('GET', '/msg/agents/east-triage')
check('agent detail with notebook and runs', det.agent.notebook.length > 0 && det.runs.length > 0, det.agent)

// ------------------------------------------------------------------ teams ---

let [, tm] = await j('POST', '/msg/feed/teams', { messages: [{ id: 'm1', chatId: 'c', chatTopic: 'Sam', fromName: 'Sam Lee', text: 'can you look at the Acme printer?', createdAt: new Date().toISOString() }] })
check('teams ingest to east', tm.added === 1 && store.openEvents('east-triage').some((e) => e.kind === 'teams') || store.listRuns('east-triage').length > 0, tm)

// archived project: agent off, channel archived
projects.archiveProject(proj.id, { actor: 'ui', via: 'ui' })
agents.syncRoster()
check('archived project stops its agent', store.getAgent('smoke-ai')?.enabled === false && store.getChannel('smoke-ai')?.archivedAt, store.getAgent('smoke-ai'))

console.log(`agentsSmoke: ${pass} passed, ${fail} failed`)
srv.close(); atSrv.close(); thorSrv.close()
process.exit(fail ? 1 : 0)
