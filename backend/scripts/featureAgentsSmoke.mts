/**
 * Feature agents smoke test (lib/featureAgents.ts): an agent a feature adds, with its own brief, status, tools
 * and approvable actions, and the Raven notices it takes instead of the thread.
 *
 * Same harness as agentsSmoke.mts: routes/msg.ts and routes/agentMcp.ts on a throwaway express app over a scratch
 * data dir, and a STUB claude CLI that calls the valkyrie MCP tools over HTTP from a per-agent script. The feature
 * here is made up (widgets). It also proves the agents table migration: the scratch DB starts with the old kind
 * CHECK and one row, before the store is loaded.
 *
 * Runs on odin only (better-sqlite3), never against the live data dir:
 *   bash C:/Thor/var/vk-lanes/lane.sh smoke l2 backend/scripts/featureAgentsSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import express from 'express'
import Database from 'better-sqlite3'
import { z } from 'zod'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('featureAgentsSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const stub = path.join(dataDir, 'stub')
const conf = path.join(dataDir, 'conf')
fs.mkdirSync(stub, { recursive: true })
fs.mkdirSync(conf, { recursive: true })
const w = (f: string, s: string, mode?: number) => { fs.writeFileSync(path.join(stub, f), s); if (mode) fs.chmodSync(path.join(stub, f), mode) }

// ------------------------------------------------------- the old schema ---

const OLD_AGENTS = `CREATE TABLE IF NOT EXISTS agents (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL CHECK (kind IN ('triage','project','shopping')),
    area       TEXT NOT NULL,
    franchise  TEXT,
    projectId  TEXT,
    channelId  TEXT NOT NULL,
    model      TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    notebook   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'idle',
    statusNote TEXT NOT NULL DEFAULT '',
    lastRunAt  TEXT,
    createdAt  TEXT NOT NULL,
    updatedAt  TEXT NOT NULL
  );`
{
  const old = new Database(path.join(dataDir, 'agents.sqlite'))
  old.exec(OLD_AGENTS)
  old.prepare(`INSERT INTO agents (id, name, role, kind, area, channelId, model, notebook, createdAt, updatedAt)
    VALUES ('legacy', 'Legacy', 'an old row', 'shopping', 'personal', 'legacy', 'claude-opus-5-5', 'keep me', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run()
  let refused = false
  try { old.prepare("INSERT INTO agents (id, name, kind, area, channelId, createdAt, updatedAt) VALUES ('x', 'x', 'feature', 'a', 'x', 'n', 'n')").run() } catch { refused = true }
  if (!refused) { console.error('the old schema took kind feature: the test is wrong'); process.exit(2) }
  old.close()
}

// --------------------------------------------------------------- stub claude ---
// Reads the agent id from the appended system prompt, then runs script-<id>.json: {tool, args} MCP calls, or
// {exit: n} to fail. Results land in results-<id>.json.

w('claude', `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const sys = args[args.indexOf('--append-system-prompt') + 1] || ''
const id = (/Your id is ([a-z0-9-]+)/.exec(sys) || [])[1] || 'unknown'
const cfgArg = args.find((a) => a.startsWith('--mcp-config='))
const cfg = JSON.parse(fs.readFileSync(cfgArg.slice('--mcp-config='.length), 'utf8')).mcpServers.valkyrie
const dir = ${JSON.stringify(stub)}
fs.writeFileSync(path.join(dir, 'last-' + id + '.json'), JSON.stringify({ args, system: sys, prompt: args[args.indexOf('-p') + 1] }))
let script = []
try { script = JSON.parse(fs.readFileSync(path.join(dir, 'script-' + id + '.json'), 'utf8')) } catch {}
;(async () => {
  const results = []
  for (const step of script) {
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
w('areas.json', JSON.stringify({ clientAreas: ['east'] }))
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify({
  franchises: [{ key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, supportCc: 'help@east.example', ownDomains: ['east.example'], agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'Your franchise: East IT.' }],
  self: [], mailboxRoutes: {}, defaultFranchise: 'east', teamsFranchise: 'east', skipDomains: [],
}))
const script = (id: string, steps: unknown[]) => { w(`script-${id}.json`, JSON.stringify(steps)); try { fs.unlinkSync(path.join(stub, `results-${id}.json`)) } catch { /* none */ } }
const results = (id: string): any[] | null => { try { return JSON.parse(fs.readFileSync(path.join(stub, `results-${id}.json`), 'utf8')) } catch { return null } }
const lastRun = (id: string): { args: string[]; system: string; prompt: string } => JSON.parse(fs.readFileSync(path.join(stub, `last-${id}.json`), 'utf8'))

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

let pass = 0, fail = 0
const check = (name: string, ok: unknown, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 700)) }
}

const store = await import('../src/lib/agentsStore.ts')
const sqlOf = () => (new Database(path.join(dataDir, 'agents.sqlite'), { readonly: true }).prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get() as { sql: string }).sql
check('migration: the agents table takes kind feature', sqlOf().includes("'feature'"), sqlOf())
const legacy = store.getAgent('legacy')
check('migration: old rows kept as they were', legacy?.kind === 'shopping' && legacy.model === 'claude-opus-5-5' && legacy.notebook === 'keep me' && legacy.createdAt === '2026-01-01T00:00:00Z', legacy)
check('migration: a second run is a no-op', store.ensureAgentKinds() === false)
check('migration: no work table left over', !sqlOf().includes('agents_wide'))

const fa = await import('../src/lib/featureAgents.ts')
const agents = await import('../src/lib/agents.ts')
const actions = await import('../src/lib/agentActions.ts')
const hooks = await import('../src/lib/raven/hooks.ts')
const raven = await import('../src/lib/raven/run.ts')
const { RAVEN_CHANNEL } = await import('../src/lib/raven/types.ts')
app.use('/api', (await import('../src/routes/msg.ts')).default)
app.use('/api', (await import('../src/routes/agentMcp.ts')).default)
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json().catch(() => null)] as [number, any]
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<X>(fn: () => X | null | undefined | false, ms = 8000): Promise<X | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40) }
  return null
}
const idle = (id: string) => until(() => { const a = store.getAgent(id); return a && ['idle', 'error', 'resting'].includes(a.status) && !store.openEvents(id).length && a })
const ravenMsgs = () => store.listMessages(RAVEN_CHANNEL, { limit: 200 })
const rawNotice = (title: string) => ravenMsgs().find((m) => m.meta.relay?.kind === 'feature' && m.meta.relay.from === 'widgets' && m.text.startsWith(title))
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

// ------------------------------------------------------------ the feature ---

const applied: Record<string, unknown>[] = []
const widget: import('../src/lib/featureAgents.ts').FeatureAgent = {
  id: 'widget', feature: 'widgets', name: 'Widget', role: 'Watches the widgets', area: 'widgets', topic: 'Widget problems', tailnetOnly: true,
  brief: () => 'You are Widget, the widget supervisor.',
  status: () => 'Widgets: 3 running, 1 jammed (w2).',
  tools: (server, ctx) => {
    server.registerTool('widget_status', { description: 'widgets', inputSchema: {} }, () => text(JSON.stringify({ jammed: ['w2'], runId: ctx.runId.length > 0 })))
    server.registerTool('propose_unjam', { description: 'unjam', inputSchema: { widget: z.string(), why: z.string(), action: z.string().optional() } }, (a) => {
      try { return text(JSON.stringify(ctx.propose({ action: a.action ?? 'unjam', args: { widget: a.widget }, title: `Unjam ${a.widget}`, note: a.why }))) } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }
      }
    })
  },
  actions: {
    unjam: { check: (args) => { if (args.widget !== 'w2') throw new Error('only w2 is jammed') }, apply: (args) => { applied.push(args); return `Unjammed ${String(args.widget)}` } },
    boom: { apply: () => { throw new Error('the widget API refused') } },
  },
  takesNotice: (n) => n.source === 'widgets' && /^jam-/.test(n.tag ?? ''),
}
const intruder = { ...widget, id: 'east-triage', name: 'Intruder', takesNotice: undefined }
fa.setFeatureAgents([widget, intruder, { ...widget, name: 'Twin' }, { ...widget, id: 'Bad Id' }])
check('setFeatureAgents keeps the first of a repeated id and drops a bad id', fa.featureAgents().map((d) => d.id).join() === 'widget,east-triage', fa.featureAgents().map((d) => d.id))

hooks.setRavenNoticeHandler((n, o) => { raven.postNotice(n, o) })
agents.startAgents()

// ------------------------------------------------------------------ roster ---

const wa = store.getAgent('widget')
check('feature agent in the roster', wa?.kind === 'feature' && wa.enabled && wa.area === 'widgets' && wa.channelId === 'widget' && wa.role === 'Watches the widgets', wa)
check('its home channel', store.getChannel('widget')?.kind === 'home' && store.getChannel('widget')?.area === 'widgets', store.getChannel('widget'))
check('a feature agent never takes a fixed agent\'s id', store.getAgent('east-triage')?.kind === 'triage' && store.getAgent('east-triage')?.name === 'East Triage', store.getAgent('east-triage'))
check('team channel holds it', store.getChannel('team')?.agentIds.includes('widget'), store.getChannel('team'))
let [st, ov] = await j('GET', '/msg/overview', undefined, { 'cf-ray': 'x' })
check('tailnet only: hidden through Cloudflare', st === 200 && !ov.channels.some((c: any) => c.id === 'widget'), ov?.channels?.map((c: any) => c.id))
check('tailnet only: its channel 404s through Cloudflare', (await j('GET', '/msg/channels/widget', undefined, { 'cf-ray': 'x' }))[0] === 404)

// -------------------------------------------------- a run, its tools, its prompt ---

script('widget', [{ tool: 'widget_status' }, { tool: 'task_add', args: { text: 'x' } }, { tool: 'post', args: { text: 'w2 is jammed since 3 PM ET.' } }])
let [, sent] = await j('POST', '/msg/channels/widget/messages', { text: 'what is jammed?' })
check('Brendon wakes it in its channel', sent?.woke?.includes('widget'), sent)
await idle('widget')
let r = results('widget')
check('its own tool works', r?.[0]?.status === 200 && !r[0].isError && r[0].text.includes('w2') && r[0].text.includes('"runId":true'), r?.[0])
check('no task_add for a feature agent', r?.[1]?.error || r?.[1]?.isError, r?.[1])
check('shared tools still work (post)', r?.[2]?.status === 200 && !r[2].isError, r?.[2])
let last = lastRun('widget')
check('system prompt: shared rules, its brief, its id', last.system.includes('You are Widget, the widget supervisor.') && last.system.includes('Your id is widget') && last.system.includes('Proposals: anything you want changed'), last.system.slice(-600))
check('prompt: its live status', last.prompt.includes('## Your area now') && last.prompt.includes('Widgets: 3 running, 1 jammed (w2).'), last.prompt.slice(0, 600))
check('run is locked down', last.args.includes('--strict-mcp-config') && last.args[last.args.indexOf('--tools') + 1] === '', last.args)
script('groceries', [{ tool: 'widget_status' }])
await j('POST', '/msg/channels/groceries/messages', { text: 'milk' })
await idle('groceries')
r = results('groceries')
check('another agent never gets the feature tools', r?.[0]?.error || r?.[0]?.isError, r?.[0])

// -------------------------------------------------------------- proposals ---

script('widget', [
  { tool: 'propose_unjam', args: { widget: 'w1', why: 'w1 looks stuck.' } },
  { tool: 'propose_unjam', args: { widget: 'w2', why: 'w2 jammed \u2014 badly.' } },
  { tool: 'propose_unjam', args: { widget: 'w2', why: 'w9', action: 'fly' } },
  { tool: 'propose_unjam', args: { widget: 'w2', why: 'w2 jammed at 3 PM ET. Unjamming restarts its feed.' } },
])
await j('POST', '/msg/channels/widget/messages', { text: 'fix it' })
await idle('widget')
r = results('widget')
script('widget', [])
check('check() refuses bad args at proposal time', r?.[0]?.isError && r[0].text.includes('only w2'), r?.[0])
check('an em dash in the note is refused', r?.[1]?.isError && r[1].text.includes('em dash'), r?.[1])
check('an unknown action is refused', r?.[2]?.isError && r[2].text.includes('no action fly'), r?.[2])
const pid = JSON.parse(r?.[3]?.text ?? '{}').proposal
let p = store.getProposal(pid)
check('proposal stored as kind feature', p?.kind === 'feature' && p.status === 'pending' && p.payload.feature === 'widgets' && p.payload.action === 'unjam' && (p.payload.args as any)?.widget === 'w2', p)
const card = store.listMessages('widget', { limit: 50 }).find((m) => m.proposalId === pid)
check('its note posts with the card and buzzes', card?.notify && card.text.startsWith('w2 jammed at 3 PM ET.'), card)
check('mirrored into Raven\'s thread with the card', ravenMsgs().some((m) => m.author === 'widget' && m.proposalId === pid), ravenMsgs().slice(-3))
check('nothing ran before approval', applied.length === 0)
check('approve through Cloudflare 404s', (await j('POST', `/msg/proposals/${pid}/approve`, {}, { 'cf-ray': 'x' }))[0] === 404)
let [ast, ap] = await j('POST', `/msg/proposals/${pid}/approve`, {})
check('approve runs the action once', ast === 200 && ap.proposal.status === 'done' && ap.proposal.result === 'Unjammed w2' && applied.length === 1, ap)
check('the agent hears the result', store.openEvents('widget').some((e) => e.kind === 'proposal' && (e.payload as any).status === 'done'), store.openEvents('widget'))
check('a second approve is refused', (await j('POST', `/msg/proposals/${pid}/approve`, {}))[0] === 409)
const boom = actions.proposeFeature(store.getAgent('widget')!, { action: 'boom', title: 'Boom', note: 'This fails.' }, 0)
;[ast, ap] = await j('POST', `/msg/proposals/${boom.id}/approve`, {})
check('an action that throws fails with its words', ap?.proposal?.status === 'failed' && ap.proposal.result === 'the widget API refused', ap)
let threw = ''
try { actions.proposeFeature(store.getAgent('groceries')!, { action: 'unjam', args: { widget: 'w2' }, title: 't', note: 'n' }, 0) } catch (e) { threw = (e as Error).message }
check('only a feature agent proposes feature actions', threw.includes('only a feature agent'), threw)
await idle('widget')

// ---------------------------------------------------------------- notices ---

script('widget', [{ tool: 'post', args: { text: 'w3 jammed: its feed timed out twice. I would unjam it.', notify: true } }])
let n = raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: 'w3 jammed', body: 'Stalled.', url: '/m/widgets', tag: 'jam-w3' })
check('a notice it takes is handed over, not posted', n.handedTo === 'widget' && !n.posted, n)
check('it becomes a notice event', store.openEvents('widget').some((e) => e.kind === 'notice' && (e.payload as any).title === 'w3 jammed'), store.openEvents('widget'))
await idle('widget')
last = lastRun('widget')
check('the run prompt carries the notice', last.prompt.includes('Problem notice from Widgets (warn)') && last.prompt.includes('w3 jammed') && last.prompt.includes('Link: /m/widgets'), last.prompt.slice(0, 900))
check('its own message reached the thread, the raw notice did not', ravenMsgs().some((m) => m.author === 'widget' && m.text.startsWith('w3 jammed: its feed')) && !rawNotice('w3 jammed'), ravenMsgs().slice(-3))
check('the same tag within 30 minutes folds (no second run)', raven.postNotice({ source: 'widgets', level: 'warn', title: 'w3 jammed', tag: 'jam-w3' }).handedTo === undefined && !store.openEvents('widget').length)

n = raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: '2 widgets wait for review', tag: 'review-9' })
check('a notice it does not take posts as before', n.posted && !n.handedTo && rawNotice('2 widgets wait for review'), n)

script('widget', [])
raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: 'w4 jammed', tag: 'jam-w4' })
await idle('widget')
check('a run that posts nothing: the notice goes to the thread as it came', await until(() => rawNotice('w4 jammed')), ravenMsgs().slice(-3))

script('widget', [{ exit: 1 }])
raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: 'w5 jammed', tag: 'jam-w5' })
await until(() => store.listRuns('widget').filter((x) => x.status === 'failed').length >= 1)
check('a failed run that retries holds the notice back', !rawNotice('w5 jammed'))
check('after the retry fails too, the notice goes to the thread', await until(() => rawNotice('w5 jammed'), 10_000), store.listRuns('widget').slice(0, 3))
await idle('widget')
script('widget', [])

agents.setPaused(true)
n = raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: 'w6 jammed', tag: 'jam-w6' })
check('paused agents: the notice posts as before', n.posted && rawNotice('w6 jammed') && !store.openEvents('widget').length, n)
agents.setPaused(false)
store.patchAgent('widget', { enabled: false })
n = raven.postNotice({ source: 'widgets', label: 'Widgets', level: 'warn', title: 'w7 jammed', tag: 'jam-w7' })
check('agent switched off: the notice posts as before', n.posted && rawNotice('w7 jammed'), n)
store.patchAgent('widget', { enabled: true })
n = raven.postNotice({ source: 'widgets', level: 'warn', title: 'w8 jammed', tag: 'jam-w8' }, { direct: true })
check('direct skips the agent', n.posted && !n.handedTo, n)
await idle('widget')

// ---------------------------------------------------------- feature removed ---

const late = actions.proposeFeature(store.getAgent('widget')!, { action: 'unjam', args: { widget: 'w2' }, title: 'Unjam w2', note: 'Again.' }, 0)
fa.setFeatureAgents([])
agents.syncRoster()
check('feature gone: its agent switches off', store.getAgent('widget')?.enabled === false && store.getAgent('widget')?.statusNote.startsWith('feature removed'), store.getAgent('widget'))
;[, ap] = await j('POST', `/msg/proposals/${late.id}/approve`, {})
check('feature gone: its waiting proposal fails, nothing runs', ap?.proposal?.status === 'failed' && applied.length === 1, ap)
n = raven.postNotice({ source: 'widgets', level: 'warn', title: 'w10 jammed', tag: 'jam-w10' })
check('feature gone: its notices post as before', n.posted && !n.handedTo, n)
fa.setFeatureAgents([widget])
agents.syncRoster()
check('feature back: its agent switches on again', store.getAgent('widget')?.enabled === true && store.getAgent('widget')?.statusNote === '', store.getAgent('widget'))

console.log(`featureAgentsSmoke: ${pass} passed, ${fail} failed`)
srv.close()
process.exit(fail ? 1 : 0)
