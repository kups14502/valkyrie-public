/**
 * One REAL agent run against a scratch data dir: the real claude CLI (pool tokens), the real MCP
 * wiring, a fake Autotask with one ticket and one contact, and one fake work mail. It proves an
 * agent can see its work and act through the valkyrie tools; nothing reaches a real PSA or mailbox.
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/agentsProbe.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || dataDir.includes('valkyrie/backend/data')) { console.error('scratch VALKYRIE_DATA_DIR only'); process.exit(2) }
const conf = path.join(dataDir, 'conf'); fs.mkdirSync(conf, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'areas.json'), JSON.stringify({ clientAreas: ['east', 'north', 'other'] }))

const now = new Date().toISOString()
const at = express(); at.use(express.json())
at.get('/Tickets/entityInformation/fields', (_q, r) => r.json({ fields: [
  { name: 'status', picklistValues: [[1, 'New'], [5, 'Complete'], [8, 'Received Client Reply'], [7, 'Waiting Customer']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
  { name: 'priority', picklistValues: [[2, 'Medium']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
  { name: 'queueID', picklistValues: [[8, 'Monitoring Alert'], [14046773, 'Help Desk']].map(([v, l]) => ({ value: String(v), label: l, isActive: true })) },
] }))
const ticket = { id: 101, ticketNumber: 'T20261030.0001', title: 'Printer offline on 3rd floor', description: 'HP printer on 3 shows offline for everyone', status: 8, priority: 2, queueID: 14046773, companyID: 7, contactID: 70, assignedResourceID: 1001, createDate: now, lastActivityDate: now, dueDateTime: null, completedDate: null }
at.post('/Tickets/query', (q, r) => r.json({ items: q.body.filter.some((f: any) => f.field === 'queueID' && f.op === 'eq') ? [] : [ticket], pageDetails: {} }))
at.post('/Companies/query', (_q, r) => r.json({ items: [{ id: 7, companyName: 'Acme Legal', webAddress: 'acmelegal.com', isActive: true }], pageDetails: {} }))
at.post('/Resources/query', (_q, r) => r.json({ items: [{ id: 1001, firstName: 'Brendon', lastName: 'Kupsch' }], pageDetails: {} }))
at.post('/Contacts/query', (_q, r) => r.json({ items: [{ id: 70, companyID: 7, firstName: 'Jane', lastName: 'Doe', emailAddress: 'jane@acmelegal.com', isActive: 1 }], pageDetails: {} }))
at.post('/TicketNotes/query', (_q, r) => r.json({ items: [{ id: 1, title: 'Checked', description: 'Printer pings. Static IP was reset by the firmware update last night. Set it back to 10.0.3.50.', createDateTime: now, creatorResourceID: 1001, publish: 2 }], pageDetails: {} }))
const atSrv = at.listen(0); const atPort = (atSrv.address() as { port: number }).port
const workConf = {
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, brendonRole: 77, ticketCategory: 3, supportCc: 'help@east.example', ownDomains: ['east.example'], teams: true, agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'Your franchise: East IT.' },
    { key: 'north', label: 'North', company: 'North IT', envFile: 'autotask-north.env', web: 'https://ww22.autotask.net', brendonResource: 1002, supportCc: 'help@north.example', ownDomains: ['north.example'], agent: { id: 'north-triage', name: 'North Triage', role: 'Tickets for North', topic: 'North tickets' }, brief: 'Your franchise: North IT.' },
  ],
  self: ['me@east.example'], mailboxRoutes: { 'east-shared': 'east' }, defaultFranchise: 'east', teamsFranchise: 'east', skipDomains: [],
}
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify(workConf))
for (const f of ['autotask-east.env', 'autotask-north.env']) fs.writeFileSync(path.join(conf, f), `AUTOTASK_ZONE_URL=http://127.0.0.1:${atPort}\nAUTOTASK_INTEGRATION_CODE=x\nAUTOTASK_USERNAME=y\nAUTOTASK_SECRET=z\n`)

const app = express(); app.use(express.json({ limit: '2mb' }))
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
Object.assign(process.env, {
  PORT: String(port), AGENTS_MCP_URL: `http://127.0.0.1:${port}/api/agent-mcp`, AGENTS_DELAY_SCALE: '0.01',
  VALKYRIE_CONF_DIR: conf, PROJECT_AREAS_FILE: path.join(dataDir, 'areas.json'), LILKUPS_BIN: '/bin/true', LILKUPS_STORE: path.join(dataDir, 'r.json'),
})
const store = await import('../src/lib/agentsStore.ts')
const agents = await import('../src/lib/agents.ts')
const feeds = await import('../src/lib/workFeeds.ts')
app.use('/api', (await import('../src/routes/msg.ts')).default)
app.use('/api', (await import('../src/routes/agentMcp.ts')).default)
agents.startAgents()
await feeds.refreshSenders('east')
store.setKv('tracker-seeded-east', '1')
await feeds.pollTickets('east')

const r = await fetch(`http://127.0.0.1:${port}/api/msg/feed/mail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  mailbox: 'work', address: 'me@east.example', messages: [{
    id: 'PROBE1', conversationId: 'conv1', subject: 'RE: Printer offline on 3rd floor [T20261030.0001]', fromName: 'Jane Doe', fromAddress: 'jane@acmelegal.com',
    to: ['me@east.example'], receivedAt: new Date().toISOString(), focused: true,
    body: 'Hi Brendon,\n\nIs the printer on 3 working again? People keep asking me.\n\nThanks,\nJane',
  }],
}) })
console.log('feed:', await r.json())
const t0 = Date.now()
while (Date.now() - t0 < 300_000) {
  const a = store.getAgent('east-triage')!
  if (store.listRuns('east-triage').some((x) => x.status !== 'running') && a.status !== 'working' && a.status !== 'queued') break
  await new Promise((res) => setTimeout(res, 2000))
}
const run = store.listRuns('east-triage')[0]
console.log('run:', JSON.stringify({ status: run?.status, cred: run?.cred, turns: run?.turns, cost: run?.costUsd, secs: Math.round((run?.durationMs ?? 0) / 1000), summary: run?.summary, error: run?.error }))
for (const m of store.listMessages('east-triage')) console.log(`\n[${m.author}]${m.proposalId ? ` (proposal #${m.proposalId})` : ''} ${m.text}`)
for (const p of store.pendingProposals()) console.log(`\nPROPOSAL #${p.id} ${p.kind}: ${p.title}\n${JSON.stringify(p.payload, null, 1)}`)
console.log('\nmail state:', store.getMail(1)?.state, store.getMail(1)?.outcome)
console.log('tracker:', JSON.stringify(store.trackedTicket('east', 101)))
srv.close(); atSrv.close(); process.exit(0)
