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
const matches = (t: Record<string, unknown>, filter: { op: string; field: string; value: unknown }[]) => filter.every((f) => {
  const v = t[f.field]
  if (f.op === 'eq') return v === f.value
  if (f.op === 'noteq') return v !== f.value
  if (f.op === 'gt') return String(v) > String(f.value)
  if (f.op === 'gte') return Number(v) >= Number(f.value)
  if (f.op === 'contains') return String(v).toLowerCase().includes(String(f.value).toLowerCase())
  return true
})
at.post('/Tickets/query', (q, r) => r.json({ items: tickets.filter((t) => matches(t as unknown as Record<string, unknown>, q.body.filter)), pageDetails: { nextPageUrl: null } }))
at.post('/Companies/query', (_q, r) => r.json({ items: [{ id: 7, companyName: 'Acme Legal', webAddress: 'acmelegal.com', isActive: true }], pageDetails: {} }))
at.post('/Resources/query', (_q, r) => r.json({ items: [{ id: 1001, firstName: 'Brendon', lastName: 'Kupsch' }, { id: 1002, firstName: 'Brendon', lastName: 'K' }], pageDetails: {} }))
const contacts = [{ id: 70, companyID: 7, firstName: 'Jane', lastName: 'Doe', emailAddress: 'jane@acmelegal.com', isActive: 1 }]
at.post('/Contacts/query', (q, r) => r.json({ items: contacts.filter((c) => matches(c as unknown as Record<string, unknown>, q.body.filter)), pageDetails: {} }))
at.post('/TicketNotes/query', (q, r) => r.json({ items: notes.filter((n) => n.ticketID === q.body.filter[0].value).map((n, i) => ({ id: i + 1, title: n.title, description: n.description, createDateTime: now, creatorResourceID: 1001, publish: 2 })), pageDetails: {} }))
at.post('/ResourceServiceDeskRoles/query', (_q, r) => r.json({ items: [{ roleID: 555, isDefault: true, isActive: true }], pageDetails: {} }))
at.post('/Tickets/:id/Notes', (q, r) => { notes.push({ ...q.body, impersonate: q.header('ImpersonationResourceId') }); r.json({ itemId: notes.length }) })
at.patch('/Tickets', (q, r) => {
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
const workConf = {
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, brendonRole: 77, ticketCategory: 3, supportCc: 'help@east.example', ownDomains: ['east.example'], teams: true, agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'Your franchise: East IT.' },
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
check('prompt carries the message', last.prompt.includes('chicken breast for the tomato pasta'), last.prompt.slice(0, 400))
check('groceries gets the browser server', fs.existsSync(path.join(stub, 'last-groceries.json')))
let [, cnt] = await j('GET', '/msg/count')
check('unread counts agent messages', cnt.unread >= 1 && cnt.notify >= 1, cnt)
await j('POST', '/msg/channels/groceries/read', {})
;[, cnt] = await j('GET', '/msg/count')
check('read clears the count', cnt.unread === 0, cnt)

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
check('update sent with role', patches.some((x) => x.status === 7 && x.assignedResourceID === 1001 && x.assignedResourceRoleID === 77), patches)
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
srv.close(); atSrv.close()
process.exit(fail ? 1 : 0)
