/**
 * Raven smoke test: the run loop, the router, the model fallback, the thread routes, files, say, notify, and the relays
 * from the work agents into Raven's thread.
 *
 * Mounts routes/msg.ts, routes/agentMcp.ts, routes/raven.ts and routes/ravenMcp.ts behind requireAuth on a throwaway
 * express app over a scratch data dir, with a STUB claude CLI. The stub reads the --mcp-config the runner wrote and
 * calls the real MCP endpoint (raven-mcp for Raven runs, agent-mcp for agents) from a script the test writes, answers
 * router calls from router.json, and refuses the models in bad-models.json the way the CLI does. No real Claude run, no
 * thor, no tmux, no push (no VAPID keys), LILKUPS_BIN stubbed.
 *
 * The session, vault, media and work tools are the tools build's (lib/raven/tools, scripts/ravenToolsSmoke.mts). Here a
 * test feature registers two tools so the run context reaching every tool group (fromBrendon) is checked end to end.
 *
 * Runs on odin only (better-sqlite3), never against the live data dir:
 *   bash C:/Thor/var/vk-lanes/lane.sh smoke l1 backend/scripts/ravenSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'
import express from 'express'
import Database from 'better-sqlite3'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR) || dataDir.includes('valkyrie/backend/data')) {
  console.error('ravenSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
fs.mkdirSync(dataDir, { recursive: true })
const stub = path.join(dataDir, 'stub')
const conf = path.join(dataDir, 'conf')
fs.mkdirSync(stub, { recursive: true })
fs.mkdirSync(conf, { recursive: true })
const w = (f: string, s: string, mode?: number) => { fs.writeFileSync(path.join(stub, f), s); if (mode) fs.chmodSync(path.join(stub, f), mode) }
const rj = (f: string, d: any = null): any => { try { return JSON.parse(fs.readFileSync(path.join(stub, f), 'utf8')) } catch { return d } }

// ------------------------------------------------- an agents.sqlite from before Raven ---
// The live database already has messages without the meta column: the migration must add it in place.

{
  const old = new Database(path.join(dataDir, 'agents.sqlite'))
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channelId TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
    refs TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]', notify INTEGER NOT NULL DEFAULT 0, hop INTEGER NOT NULL DEFAULT 0,
    proposalId INTEGER, createdAt TEXT NOT NULL)`)
  old.prepare('INSERT INTO messages (channelId, author, text, createdAt) VALUES (?, ?, ?, ?)').run('old', 'east-triage', 'from before Raven', new Date().toISOString())
  old.close()
}

// ------------------------------------------------------------------ config ---

const workConf = {
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, supportCc: 'help@east.example', ownDomains: ['east.example'], agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'Your franchise: East IT.' },
  ],
  self: ['me@east.example'], mailboxRoutes: {}, defaultFranchise: 'east', teamsFranchise: null, skipDomains: [],
}
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify(workConf))

// --------------------------------------------------------------- stub claude ---

w('claude', `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(stub)}
const args = process.argv.slice(2)
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
// -p with no prompt after it: the prompt comes on stdin, the way the CLI reads one past the 128 KB argument limit
const pArg = val('-p'), stdin = !pArg || pArg.startsWith('--')
const model = val('--model'), effort = val('--effort'), prompt = stdin ? fs.readFileSync(0, 'utf8') : pArg, sys = val('--append-system-prompt') || ''
const cfgArg = args.find((a) => a.startsWith('--mcp-config='))
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return d } }
const out = (o) => process.stdout.write(JSON.stringify(o))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfg = cfgArg ? JSON.parse(fs.readFileSync(cfgArg.slice('--mcp-config='.length), 'utf8')).mcpServers : null
const kind = !cfg ? (prompt.startsWith("Write Brendon's brief") ? 'brief' : 'ask') : cfg.raven ? 'raven' : 'agent'
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ kind, model, effort, at: Date.now(), flags: args.filter((a) => a !== prompt && a !== sys) }) + '\\n')
;(async () => {
  if (readJson('credit-models.json', []).includes(model)) {
    out({ type: 'result', is_error: true, result: 'Fable 5.1 requires usage credits. Switch to another model to continue.' })
    process.exit(1)
  }
  if (readJson('bad-models.json', []).includes(model)) {
    out({ type: 'result', is_error: true, result: "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it." })
    process.exit(1)
  }
  if (effort && readJson('bad-efforts.json', []).includes(effort)) {
    process.stderr.write("error: option '--effort <level>' argument '" + effort + "' is invalid. Allowed choices are low, medium, high, max.\\n")
    process.exit(1)
  }
  if (kind === 'brief') { out({ type: 'result', is_error: false, result: 'Light day. Dentist at 2:30 PM ET.' }); return }
  if (kind === 'ask') {
    fs.writeFileSync(path.join(dir, 'last-ask.json'), JSON.stringify({ prompt }))
    const r = readJson('router.json', {})
    if (r.sleep) await sleep(r.sleep)
    if (r.exit) { process.stdout.write('router boom'); process.exit(r.exit) }
    out({ type: 'result', is_error: false, result: r.answer || '{"kind":"simple","why":"a normal task"}' })
    return
  }
  const server = cfg.raven || cfg.valkyrie
  const call = async (tool, a) => {
    const r = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: a } }) })
    const j = await r.json().catch(() => ({ status: r.status }))
    const content = (j.result && j.result.content) || []
    return { tool, status: r.status, isError: j.result ? j.result.isError : undefined, text: (content.find((c) => c.type === 'text') || {}).text,
      texts: content.filter((c) => c.type === 'text').map((c) => c.text),
      types: content.map((c) => c.type), mime: (content.find((c) => c.type === 'image') || {}).mimeType, error: j.error }
  }
  if (kind === 'agent') {
    const id = (/Your id is ([a-z0-9-]+)/.exec(sys) || [])[1] || 'unknown'
    fs.writeFileSync(path.join(dir, 'last-' + id + '.json'), JSON.stringify({ prompt }))
    const script = readJson('script-' + id + '.json', [])
    fs.writeFileSync(path.join(dir, 'script-' + id + '.json'), '[]')
    const results = []
    for (const s of script) results.push(await call(s.tool, s.args || {}))
    fs.writeFileSync(path.join(dir, 'results-' + id + '.json'), JSON.stringify(results))
    out({ type: 'result', is_error: false, result: 'did ' + script.length, total_cost_usd: 0, num_turns: script.length })
    return
  }
  const queue = readJson('queue-raven.json', [])
  const entry = queue.shift() || { result: 'ok' }
  fs.writeFileSync(path.join(dir, 'queue-raven.json'), JSON.stringify(queue))
  const n = readJson('raven-count.json', 0) + 1
  fs.writeFileSync(path.join(dir, 'raven-count.json'), JSON.stringify(n))
  fs.writeFileSync(path.join(dir, 'last-raven.json'), JSON.stringify({ prompt, sys, model, effort, stdin }))
  const results = []
  const steps = async (list) => {
    for (const s of list || []) {
      if (s.sleep) { await sleep(s.sleep); continue }
      results.push(await call(s.tool, s.args || {}))
    }
  }
  await steps(entry.steps)
  fs.writeFileSync(path.join(dir, 'results-raven-' + n + '.json'), JSON.stringify(results))
  if (entry.stderrOnly) { process.stderr.write(entry.stderrOnly + '\\n'); process.exit(1) }
  if (entry.exit) { process.stdout.write('boom'); process.exit(entry.exit) }
  // the Stop hook from --settings, run the way the CLI runs it (the hook input on stdin): a block hands back a reason
  // and the run goes on with the next of entry.then, whose answer is the result
  let final = entry.result === undefined ? 'ok' : entry.result
  const settingsFile = val('--settings')
  const stopCmd = settingsFile ? ((((JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks || {}).Stop || [])[0] || {}).hooks || [])[0]?.command : null
  const then = [...(entry.then || [])]
  const stops = []
  for (let i = 0; stopCmd && i < 5; i++) {
    let o = {}
    try {
      const input = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: i > 0, last_assistant_message: final })
      o = JSON.parse(require('child_process').execSync(stopCmd, { input, shell: '/bin/bash' }).toString() || '{}')
    } catch (e) { o = { failed: String(e.message).slice(0, 300) } }
    stops.push(o)
    if (o.decision !== 'block') break
    const next = then.shift() || {}
    await steps(next.steps)
    final = next.result === undefined ? 'ok' : next.result
  }
  fs.writeFileSync(path.join(dir, 'results-raven-' + n + '.json'), JSON.stringify(results))
  fs.writeFileSync(path.join(dir, 'stops-raven-' + n + '.json'), JSON.stringify(stops))
  // the CLI still up after its last answer: what he writes now is too late for this run
  if (entry.afterStop) await sleep(entry.afterStop)
  out({ type: 'result', is_error: false, result: final, total_cost_usd: 0.01, num_turns: 1 })
})()
`, 0o755)
w('accounts.json', JSON.stringify([{ id: 'smoke', label: 'Smoke', configDir: path.join(stub, 'cfg') }]))
w('areas.json', JSON.stringify({ clientAreas: ['east'] }))
const calls = (): any[] => { try { return fs.readFileSync(path.join(stub, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const queue = (...entries: unknown[]) => w('queue-raven.json', JSON.stringify(entries))
const router = (r: unknown) => w('router.json', JSON.stringify(r))
const agentScript = (id: string, steps: unknown[]) => { w(`script-${id}.json`, JSON.stringify(steps)); try { fs.unlinkSync(path.join(stub, `results-${id}.json`)) } catch { /* none */ } }
const ravenCount = (): number => rj('raven-count.json', 0)
const ravenResults = (n = ravenCount()): any[] => rj(`results-raven-${n}.json`, [])
const lastRaven = (): { prompt: string; sys: string; model: string; effort: string | null; stdin: boolean } => rj('last-raven.json', {})

// ----------------------------------------------------------------- the app ---

const app = express()
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
Object.assign(process.env, {
  PORT: String(port),
  AGENTS_MCP_URL: `http://127.0.0.1:${port}/api/agent-mcp`,
  RAVEN_MCP_URL: `http://127.0.0.1:${port}/api/raven-mcp`,
  AGENTS_DELAY_SCALE: '0.002',
  RAVEN_DELAY_SCALE: '0.01',
  RAVEN_ROUTER_TIMEOUT_MS: '5000',
  RAVEN_SAY_WAIT_MS: '10000',
  RAVEN_PUSH_THROTTLE_MS: '300',
  RAVEN_HOURLY_CAP: '80',
  VALKYRIE_CONF_DIR: conf,
  CLAUDE_CLI_PATH: path.join(stub, 'claude'),
  CLAUDE_ACCOUNTS_FILE: path.join(stub, 'accounts.json'),
  CLAUDE_SWITCH_DIR: path.join(stub, 'switch'),
  PROJECT_AREAS_FILE: path.join(stub, 'areas.json'),
  LILKUPS_BIN: '/bin/true',
  LILKUPS_STORE: path.join(stub, 'reminders.json'),
})
const store = await import('../src/lib/agentsStore.ts')
const agents = await import('../src/lib/agents.ts')
const raven = await import('../src/lib/raven/run.ts')
const models = await import('../src/lib/raven/models.ts')
const pickMod = await import('../src/lib/raven/settings.ts')
const files = await import('../src/lib/raven/files.ts')
const hooks = await import('../src/lib/raven/hooks.ts')
const push = await import('../src/lib/raven/push.ts')
const brief = await import('../src/lib/brief.ts')
const { requireAuth } = await import('../src/middleware/auth.ts')
const { signAppToken, signImgToken } = await import('../src/auth/token.ts')
const { RAVEN_UPLOAD_PATH, speakable } = await import('../src/routes/raven.ts')
const jsonSmall = express.json({ limit: '1mb' })
app.use((req, res, next) => (req.method === 'POST' && req.path === RAVEN_UPLOAD_PATH ? next() : jsonSmall(req, res, next)))
app.use('/api', requireAuth)
app.use('/api', (await import('../src/routes/msg.ts')).default)
app.use('/api', (await import('../src/routes/agentMcp.ts')).default)
app.use('/api', (await import('../src/routes/raven.ts')).default)
app.use('/api', (await import('../src/routes/ravenMcp.ts')).default)
const base = `http://127.0.0.1:${port}/api`
const appToken = signAppToken().token
const CF = { 'cf-ray': 'smoke', authorization: `Bearer ${appToken}` }
const j = async (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json().catch(() => null)] as [number, any]
}
const upload = async (name: string, type: string, body: Buffer | string, h: Record<string, string> = {}) => {
  const r = await fetch(`${base}/raven/files`, { method: 'POST', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...h }, body })
  return [r.status, await r.json().catch(() => null)] as [number, any]
}

let pass = 0, fail = 0
const check = (name: string, ok: unknown, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 700)) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<X>(fn: () => X | null | undefined | false, ms = 10_000): Promise<X | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(30) }
  return null
}
const ravenIdle = () => until(() => !raven.ravenBusy() && raven.ravenState().status === 'idle' && !store.openEvents('raven').length, 15_000)
const agentIdle = (id: string) => until(() => { const a = store.getAgent(id); return a && ['idle', 'error', 'resting'].includes(a.status) && !store.openEvents(id).length && a })
const thread = () => store.listMessages('raven', { limit: 200 })
const lastRavenMsg = () => thread().filter((m) => m.author === 'raven').pop()
const runsOf = () => store.listRuns('raven', 500).length

// ------------------------------------------------------------ migration ---

const oldRow = store.listMessages('old')[0]
check('meta column added in place: old row reads meta {}', oldRow && oldRow.text === 'from before Raven' && JSON.stringify(oldRow.meta) === '{}', oldRow)
check('meta migration is idempotent', store.ensureMessageMeta() === false)

// --------------------------------------------------------------- start ---

const gateSeen: boolean[] = []
agents.startAgents()
raven.startRaven([{
  id: 'demo',
  status: () => 'Demo: 2 items waiting for review',
  tools: (server, ctx) => {
    server.registerTool('probe_gate', { description: 'test: the run context', inputSchema: {} }, async () => {
      gateSeen.push(ctx.fromBrendon)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ fromBrendon: ctx.fromBrendon, hop: ctx.hop }) }] }
    })
    server.registerTool('gated_write', { description: 'test: acts only for Brendon', inputSchema: {} }, async () => {
      if (!ctx.fromBrendon) return { isError: true, content: [{ type: 'text' as const, text: 'only when Brendon asks' }] }
      ctx.acted()
      return { content: [{ type: 'text' as const, text: 'done' }] }
    })
  },
}])

let [st, rv] = await j('GET', '/raven')
check('GET /raven 200', st === 200 && rv.status === 'idle' && Array.isArray(rv.messages) && typeof rv.seq === 'number', rv)
check('state carries agents and the pause', rv.agents?.some((a: any) => a.id === 'groceries') && rv.agents?.some((a: any) => a.id === 'east-triage') && rv.paused === false, rv.agents)
check('state carries mains and watching', Array.isArray(rv.mains) && Array.isArray(rv.watching), rv)
check('thread channel made', store.getChannel('raven')?.sortOrder === -10 && store.getChannel('raven')?.area === 'raven', store.getChannel('raven'))

// ----------------------------------------------------------- cloudflare ---

check('cloudflare: GET /raven 404', (await j('GET', '/raven', undefined, CF))[0] === 404)
check('cloudflare: POST /raven/messages 404', (await j('POST', '/raven/messages', { text: 'hi' }, CF))[0] === 404)
check('cloudflare: /raven/files 404', (await j('GET', '/raven/files/0123456789abcdef01234567', undefined, CF))[0] === 404)
check('cloudflare: say 404', (await j('POST', '/raven/say', { text: 'hi' }, CF))[0] === 404)
let [, ovc] = await j('GET', '/msg/overview', undefined, CF)
check('cloudflare: overview hides the raven thread', ovc && !ovc.channels.some((c: any) => c.id === 'raven'), ovc?.channels?.map((c: any) => c.id))
let [, ov] = await j('GET', '/msg/overview')
check('tailnet: overview lists the raven thread', ov.channels.some((c: any) => c.id === 'raven'), ov.channels.map((c: any) => c.id))
check('no raven message posted by the cloudflare tries', !thread().length, thread())

// ------------------------------------------- router sorts it as complex ---

router({ answer: '{"kind":"complex","why":"planning a migration"}' })
queue({ steps: [{ tool: 'probe_gate' }, { tool: 'gated_write' }, { tool: 'now' }], result: 'Plan: three steps.' })
let [pst, posted] = await j('POST', '/raven/messages', { text: 'plan the move to the new NAS' })
check('post returns the message', pst === 200 && posted.message.author === 'brendon' && posted.message.text === 'plan the move to the new NAS', posted)
await ravenIdle()
let reply = lastRavenMsg()
check('reply posted', reply?.text === 'Plan: three steps.', thread())
check('reply meta: tier, model, effort, why, rule, replyTo', reply?.meta.tier === 'opus' && reply.meta.model === 'claude-opus-5-5' && reply.meta.effort === 'high'
  && reply.meta.why === 'planning a migration' && reply.meta.rule === 'complex' && reply.meta.asked === undefined && reply.meta.replyTo === posted.message.id, reply?.meta)
let cs = calls()
const ask1 = cs.filter((c) => c.kind === 'ask').pop()
const run1 = cs.filter((c) => c.kind === 'raven').pop()
check('router ran on the haiku tier', ask1?.model === 'claude-haiku-5-5', ask1)
check('run flags: model, effort', run1?.model === 'claude-opus-5-5' && run1.effort === 'high', run1)
const f1 = (run1?.flags ?? []).join(' ')
check('run flags: locked down', f1.includes('--strict-mcp-config') && /--mcp-config=\S+mcp\.json/.test(f1) && f1.includes('Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,Task,TodoWrite')
  && f1.includes('--no-session-persistence') && f1.includes('bypassPermissions') && f1.includes('--output-format json'), f1)
// the deny list alone leaves Monitor (a shell) and the tools that message other sessions: --tools names the only built-ins
const fl1: string[] = run1?.flags ?? []
check('run flags: the only built-in tools are WebSearch and WebFetch', fl1.includes('--tools') && fl1[fl1.indexOf('--tools') + 1] === 'WebSearch,WebFetch', fl1)
check('run flags: a run he started gets the Stop hook that hands it his follow-ups', fl1.includes('--settings') && /settings\.json$/.test(fl1[fl1.indexOf('--settings') + 1] ?? ''), fl1)
const deny1 = (fl1[fl1.indexOf('--disallowed-tools') + 1] ?? '').split(',')
check('run flags: web tools not denied, the shell and file tools are', !deny1.includes('WebSearch') && !deny1.includes('WebFetch') && ['Bash', 'Edit', 'Write', 'Read'].every((t) => deny1.includes(t)), deny1)
let lr = lastRaven()
check('prompt carries his message, the notebook, the snapshot and the feature status', lr.prompt.includes('plan the move to the new NAS') && lr.prompt.includes('## Your notebook')
  && lr.prompt.includes('Demo: 2 items waiting for review') && lr.prompt.includes('Tickets per work area') && lr.prompt.includes('New York time'), lr.prompt?.slice(0, 800))
check('system brief: Raven, the rules, work areas from config', lr.sys.includes('You are Raven') && lr.sys.includes('East (key east') && lr.sys.includes('(no reply)') && !/\u2014/.test(lr.sys), lr.sys?.slice(0, 400))
check('system brief: names the web tools', lr.sys.includes('WebSearch and WebFetch'), lr.sys?.slice(0, 400))
let rr = ravenResults()
check('tools: run context says fromBrendon, hop 0', rr[0]?.text === '{"fromBrendon":true,"hop":0}', rr)
check('tools: gated tool acts for Brendon', rr[1] && !rr[1].isError && rr[1].text === 'done', rr[1])
check('core tool now answers the snapshot', rr[2]?.text?.includes('Agents') && rr[2].text.includes('Inbox'), rr[2])
check('run recorded done', store.listRuns('raven', 1)[0]?.status === 'done', store.listRuns('raven', 1))
check('state back to idle, last run stamped', raven.ravenState().status === 'idle' && raven.ravenState().lastRunAt, raven.ravenState())

// ----------------------------------------------------- router fallbacks ---

router({ exit: 1 })
queue({ result: 'fine' })
await j('POST', '/raven/messages', { text: 'what is on today' })
await ravenIdle()
reply = lastRavenMsg()
check('router failure: the complex rule (opus/high)', reply?.meta.tier === 'opus' && reply.meta.effort === 'high' && reply.meta.model === 'claude-opus-5-5' && reply.meta.why === 'router failed' && reply.meta.rule === 'complex', reply?.meta)

router({ sleep: 15000 })
queue({ result: 'fine again' })
const tRoute = Date.now()
await j('POST', '/raven/messages', { text: 'and tomorrow' })
await ravenIdle()
reply = lastRavenMsg()
check('router timeout: the complex rule within the limit', reply?.meta.why === 'router timed out' && reply.meta.tier === 'opus' && Date.now() - tRoute < 15000, { meta: reply?.meta, ms: Date.now() - tRoute })

router({ answer: 'I think sonnet would be best' })
queue({ result: 'ok' })
await j('POST', '/raven/messages', { text: 'hello' })
await ravenIdle()
check('router nonsense: the complex rule', lastRavenMsg()?.meta.why === 'router answer unreadable' && lastRavenMsg()?.meta.rule === 'complex', lastRavenMsg()?.meta)
check('router: an old tier answer is not a sort', models.parseRoute('{"tier":"opus","effort":"high"}') === null && models.parseRoute('{"kind":"Simple","why":"hi"}')?.kind === 'simple')

w('bad-models.json', JSON.stringify(['claude-haiku-5-5']))
let [kst, sv] = await j('POST', '/raven/settings', { rules: { simple: { model: 'haiku' } } })
check('settings: a rule changed alone', kst === 200 && sv.settings.rules.simple.model === 'haiku' && sv.settings.rules.simple.effort === 'low' && sv.settings.model === 'auto', sv)
router({ answer: '{"kind":"simple","why":"chit-chat"}' })
queue({ result: 'hi' })
let before = calls().length
await j('POST', '/raven/messages', { text: 'hey' })
await ravenIdle()
cs = calls().slice(before)
check('router: unknown haiku id retried on the fallback', cs.filter((c) => c.kind === 'ask').map((c) => c.model).join(',') === 'claude-haiku-5-5,claude-haiku-4-5-20251001', cs)
reply = lastRavenMsg()
check('haiku run on the fallback id, the wanted id kept', reply?.meta.tier === 'haiku' && reply.meta.model === 'claude-haiku-4-5-20251001' && reply.meta.effort === 'low'
  && reply.meta.rule === 'simple' && reply.meta.asked === 'claude-haiku-5-5', reply?.meta)
before = calls().length
queue({ result: 'hi again' })
await j('POST', '/raven/messages', { text: 'hey again' })
await ravenIdle()
cs = calls().slice(before)
check('bad id remembered: no second try on it', !cs.some((c) => c.model === 'claude-haiku-5-5') && cs.filter((c) => c.kind === 'ask').length === 1, cs)
;[kst, sv] = await j('POST', '/raven/settings', { reset: true })
check('settings: reset puts the rules back', kst === 200 && sv.settings.rules.simple.model === 'sonnet' && sv.settings.rules.complex.model === 'opus', sv.settings)

// --------------------------------------------------- model fallback, run ---

w('bad-models.json', JSON.stringify(['claude-haiku-5-5', 'claude-sonnet-5-5']))
router({ answer: '{"kind":"simple","why":"a task"}' })
queue({ result: 'done on the fallback' })
before = calls().length
await j('POST', '/raven/messages', { text: 'add milk to groceries' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('run: unknown model retried once on the fallback', cs.map((c) => c.model).join(',') === 'claude-sonnet-5-5,claude-sonnet-5', cs)
reply = lastRavenMsg()
check('reply names the model that ran', reply?.text === 'done on the fallback' && reply.meta.model === 'claude-sonnet-5', reply)
check('fallback remembered', models.modelFor('sonnet') === 'claude-sonnet-5' && models.badModels().includes('claude-sonnet-5-5'), models.badModels())

// -------------------------------------------------- effort refused by CLI ---

w('bad-efforts.json', JSON.stringify(['high']))
router({ answer: '{"kind":"complex","why":"big plan"}' })
queue({ result: 'planned at high' })
before = calls().length
await j('POST', '/raven/messages', { text: 'plan the whole quarter' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('refused effort level retried one lower', cs.map((c) => c.effort).join(',') === 'high,medium' && lastRavenMsg()?.meta.effort === 'medium', cs)
w('bad-efforts.json', '[]')

// ------------------------------------------------------------ failures ---

router({})
queue({ exit: 1 })
await j('POST', '/raven/messages', { text: 'this one breaks' })
await ravenIdle()
reply = lastRavenMsg()
check('failed run: one short line with meta.error', reply?.text === 'That failed: boom.' && reply.meta.error && reply.meta.replyTo, reply)
check('failed run recorded, state idle', store.listRuns('raven', 1)[0]?.status === 'failed' && raven.ravenState().status === 'idle', store.listRuns('raven', 1))
check('error line reads a CLI envelope', raven.errorLine(Object.assign(new Error('smoke: x'), { detail: '{"type":"result","is_error":true,"result":"Prompt is too long"}' })) === 'Prompt is too long')

// a CLI that dies with only stderr: his own words in the prompt must never be read as the CLI's error
process.env.RAVEN_MODELS = JSON.stringify({ opus: 'claude-opus-smoke' })
router({ answer: '{"kind":"complex","why":"debugging"}' })
queue({ stderrOnly: 'segfault in the renderer' })
before = calls().length
await j('POST', '/raven/messages', { text: 'the selected model is invalid, rate limit reached, it timed out: why?' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
reply = lastRavenMsg()
check('a stderr-only failure is not read from the prompt: no model fallback', cs.length === 1 && !models.badModels().includes('claude-opus-smoke'), { cs, bad: models.badModels() })
check('a stderr-only failure says what the CLI printed', reply?.text === 'That failed: segfault in the renderer.', reply?.text)
check('the error kept never carries the prompt', !/Command failed|Brendon wrote/.test(reply?.meta.error ?? '') && !/Command failed|Brendon wrote/.test(store.listRuns('raven', 1)[0]?.error ?? ''),
  { meta: reply?.meta.error, run: store.listRuns('raven', 1)[0]?.error })
delete process.env.RAVEN_MODELS

// "No reply." is an answer; only "(no reply)" means post nothing
router({ answer: '{"kind":"simple","why":"a status"}' })
queue({ result: 'No reply.' })
await j('POST', '/raven/messages', { text: 'did the landlord answer my mail?' })
await ravenIdle()
check('"No reply." as an answer is posted', lastRavenMsg()?.text === 'No reply.', lastRavenMsg()?.text)
// he wrote: a run that ends in (no reply) goes again once, and he always gets an answer
queue({ result: '`(no reply)`' }, { result: 'Noted.' })
let msgsNow = thread().length
before = calls().length
await j('POST', '/raven/messages', { text: 'fyi only' })
await ravenIdle()
check('(no reply) to his own message runs again and answers', calls().slice(before).filter((c) => c.kind === 'raven').length === 2 && lastRavenMsg()?.text === 'Noted.',
  thread().slice(msgsNow).map((m) => m.text))
queue({ result: '(no reply)' }, { result: '' })
msgsNow = thread().length
await j('POST', '/raven/messages', { text: 'fyi again' })
await ravenIdle()
check('two silent tries still answer him', thread().length === msgsNow + 2 && /no answer/i.test(lastRavenMsg()?.text ?? ''), thread().slice(msgsNow).map((m) => m.text))
router({})

// --------------------------------------------------- the model and effort pick ---

;[, rv] = await j('GET', '/raven')
check('GET /raven carries the pick: Automatic, the default rules', rv.settings?.model === 'auto' && rv.settings.effort === 'auto'
  && rv.settings.rules.simple.model === 'sonnet' && rv.settings.rules.simple.effort === 'low' && rv.settings.rules.complex.model === 'opus'
  && rv.settings.rules.complex.effort === 'high' && rv.settings.rules.voice.model === 'sonnet' && rv.settings.rules.background.effort === 'low', rv.settings)
check('GET /raven lists the five models in order', rv.models?.map((m: any) => `${m.key}:${m.label}`).join(',') === 'opus:Opus 5.5,sonnet:Sonnet 5.5,haiku:Haiku 5.5,fable-5-2:Fable 5.2,fable:Fable 5.1', rv.models)
check('a refused model says why', rv.models.find((m: any) => m.key === 'sonnet')?.unavailable === 'not available' && !rv.models.find((m: any) => m.key === 'opus')?.unavailable, rv.models)
const seq0 = store.currentSeq()
const refusedPicks = [
  { model: 'gpt' }, { effort: 'ultra' }, { rules: { nightly: { model: 'opus' } } }, { rules: { simple: { effort: 'huge' } } }, { rules: 'opus' },
]
const codes: number[] = []
for (const b of refusedPicks) codes.push((await j('POST', '/raven/settings', b))[0])
;[, sv] = await j('GET', '/raven/settings')
check('settings: bad values refused with 400, nothing changed', codes.every((c) => c === 400) && sv.settings.model === 'auto' && sv.settings.effort === 'auto' && store.currentSeq() === seq0, { codes, sv })

;[kst, sv] = await j('POST', '/raven/settings', { model: 'opus', effort: 'medium' })
check('settings: saved, every open app told (seq moved)', kst === 200 && sv.settings.model === 'opus' && sv.settings.effort === 'medium' && store.currentSeq() > seq0, sv)
check('settings: kept in kv for every device', JSON.parse(store.getKv('raven:settings') ?? '{}').model === 'opus', store.getKv('raven:settings'))
router({ answer: '{"kind":"simple","why":"never asked"}' })
queue({ result: 'fixed pick' })
before = calls().length
await j('POST', '/raven/messages', { text: 'plan my week' })
await ravenIdle()
cs = calls().slice(before)
let pickRun = cs.find((c) => c.kind === 'raven')
reply = lastRavenMsg()
check('both fixed: no router call, the run on his pick', !cs.some((c) => c.kind === 'ask') && pickRun?.model === 'claude-opus-5-5' && pickRun.effort === 'medium', cs)
check('both fixed: the reply carries it, no rule', reply?.text === 'fixed pick' && reply.meta.model === 'claude-opus-5-5' && reply.meta.effort === 'medium'
  && reply.meta.rule === undefined && reply.meta.why === 'your pick', reply?.meta)

await j('POST', '/raven/settings', { effort: 'auto' })
router({ answer: '{"kind":"simple","why":"a lookup"}' })
queue({ result: 'mixed pick' })
before = calls().length
await j('POST', '/raven/messages', { text: 'what time is it in Tokyo' })
await ravenIdle()
cs = calls().slice(before)
pickRun = cs.find((c) => c.kind === 'raven')
reply = lastRavenMsg()
check('fixed model, automatic effort: the router ran, the model his, the effort the simple rule', cs.filter((c) => c.kind === 'ask').length === 1
  && pickRun?.model === 'claude-opus-5-5' && pickRun.effort === 'low' && reply?.meta.rule === 'simple', { cs, meta: reply?.meta })

await j('POST', '/raven/settings', { model: 'auto', rules: { voice: { model: 'opus', effort: 'low' } } })
queue({ result: 'Spoken answer.' })
before = calls().length
const [vst, vs] = await j('POST', '/raven/say', { text: 'what is next on my calendar', wait: true, source: 'siri' })
cs = calls().slice(before)
pickRun = cs.find((c) => c.kind === 'raven')
check('voice: no router call, the voice rule', vst === 200 && vs.reply === 'Spoken answer.' && !cs.some((c) => c.kind === 'ask')
  && pickRun?.model === 'claude-opus-5-5' && pickRun.effort === 'low' && lastRavenMsg()?.meta.rule === 'voice', { vs, cs, meta: lastRavenMsg()?.meta })

// Fable on an account without usage credits: the run goes to Opus, the reply names both, the picker marks Fable
w('credit-models.json', JSON.stringify(['claude-fable-5-1']))
await j('POST', '/raven/settings', { model: 'fable', effort: 'medium', reset: true })
queue({ result: 'on opus instead' })
before = calls().length
await j('POST', '/raven/messages', { text: 'write the summary' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
reply = lastRavenMsg()
check('fable refused for credits: retried once on opus', cs.map((c) => c.model).join(',') === 'claude-fable-5-1,claude-opus-5-5', cs)
check('the reply names the model that ran and the one wanted', reply?.meta.tier === 'fable' && reply.meta.model === 'claude-opus-5-5'
  && reply.meta.asked === 'claude-fable-5-1' && reply.meta.effort === 'medium', reply?.meta)
;[, sv] = await j('GET', '/raven/settings')
check('the picker marks fable: needs usage credits, runs Opus 5.5', sv.models.find((m: any) => m.key === 'fable')?.unavailable === 'needs usage credits'
  && sv.models.find((m: any) => m.key === 'fable')?.label === 'Fable 5.1' && sv.models.find((m: any) => m.key === 'fable')?.fallback === 'Opus 5.5', sv.models)
queue({ result: 'straight to opus' })
before = calls().length
await j('POST', '/raven/messages', { text: 'and the next one' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('fable remembered: the next run goes straight to opus', cs.map((c) => c.model).join(',') === 'claude-opus-5-5' && lastRavenMsg()?.meta.asked === 'claude-fable-5-1', cs)

// Fable 5.2 ("You're out of usage credits. Switch to another model") and the two top efforts
w('credit-models.json', JSON.stringify(['claude-fable-5-1', 'claude-fable-5-2']))
await j('POST', '/raven/settings', { model: 'fable-5-2', effort: 'max' })
queue({ result: 'max on opus' })
before = calls().length
await j('POST', '/raven/messages', { text: 'think hard about this' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('fable 5.2 at max: the CLI gets claude-fable-5-2 --effort max, then Opus 5.5 at max', cs.map((c) => `${c.model}/${c.effort}`).join(',') === 'claude-fable-5-2/max,claude-opus-5-5/max'
  && lastRavenMsg()?.meta.asked === 'claude-fable-5-2' && lastRavenMsg()?.meta.effort === 'max', cs)
;[kst, sv] = await j('POST', '/raven/settings', { model: 'auto', effort: 'auto', rules: { complex: { model: 'fable-5-2', effort: 'xhigh' } } })
check('a rule can take Fable 5.2 and xhigh', kst === 200 && sv.settings.rules.complex.model === 'fable-5-2' && sv.settings.rules.complex.effort === 'xhigh', sv.settings)
router({ answer: '{"kind":"complex","why":"a big plan"}' })
queue({ result: 'planned' })
before = calls().length
await j('POST', '/raven/messages', { text: 'plan the quarter' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('the complex rule runs Fable 5.2 (on Opus) at xhigh', cs.map((c) => `${c.model}/${c.effort}`).join(',') === 'claude-opus-5-5/xhigh' && lastRavenMsg()?.meta.rule === 'complex', cs)
// a model added by config alone joins the picker and can be picked
process.env.RAVEN_MODELS = JSON.stringify([{ key: 'opus-next', id: 'claude-opus-6-0' }])
;[, sv] = await j('GET', '/raven/settings')
check('RAVEN_MODELS adds a model at the end of the picker', sv.models.at(-1)?.key === 'opus-next' && sv.models.at(-1)?.label === 'Opus 6.0' && sv.models.length === 6, sv.models)
;[kst] = await j('POST', '/raven/settings', { model: 'opus-next', effort: 'low' })
queue({ result: 'on the next opus' })
before = calls().length
await j('POST', '/raven/messages', { text: 'try the new one' })
await ravenIdle()
cs = calls().slice(before).filter((c) => c.kind === 'raven')
check('the added model runs with its own id', kst === 200 && cs.map((c) => c.model).join(',') === 'claude-opus-6-0', cs)
delete process.env.RAVEN_MODELS
const bgRoute = await pickMod.chooseRoute({ ...pickMod.ravenSettings(), rules: { ...pickMod.ravenSettings().rules, background: { model: 'opus', effort: 'medium' } } },
  { fromBrendon: false, voice: false, text: '', files: 0 })
check('a run he did not start follows the background rule', bgRoute.tier === 'opus' && bgRoute.effort === 'medium' && bgRoute.rule === 'background', bgRoute)
;[kst, sv] = await j('POST', '/raven/settings', { model: 'auto', effort: 'auto', reset: true })
check('settings: back to Automatic with the default rules', kst === 200 && sv.settings.model === 'auto' && sv.settings.effort === 'auto' && sv.settings.rules.voice.model === 'sonnet', sv.settings)
router({})

// ---------------------------------------------- what he writes during a run ---
// A run he started takes his follow-ups in: in its next tool result, or at its Stop hook, which keeps the run going
// to answer them under the answer it had. Each is claimed for that run. One sent after the run's last answer, or
// during a run he did not start, gets a run of its own, as before.

const evDb = new Database(path.join(dataDir, 'agents.sqlite'), { readonly: true })
const runOfMessage = (id: number): string | null => (evDb.prepare("SELECT runId FROM events WHERE agentId = 'raven' AND kind = 'message' AND json_extract(payload, '$.messageId') = ?").get(id) as { runId: string | null } | undefined)?.runId ?? null
const stopsOf = (n = ravenCount()): any[] => rj(`stops-raven-${n}.json`, [])
const wokeBy = () => (lastRaven().prompt ?? '').split('## Your notebook')[0]

// at the Stop hook: two follow-ups sent while it works, one run, one reply
queue({ steps: [{ sleep: 1500 }], result: 'first', then: [{ result: 'second' }] }, { result: 'never used' })
let runsBefore = runsOf()
const [, q1] = await j('POST', '/raven/messages', { text: 'first ask' })
await until(() => raven.ravenState().status === 'working')
check('working while it runs, with the model and effort', raven.ravenState().statusNote.startsWith('Thinking · Sonnet 5') && raven.ravenState().effort === 'low', raven.ravenState())
;[, rv] = await j('GET', '/raven')
check('GET /raven shows working', rv.status === 'working' && rv.tier === 'sonnet' && rv.model === 'claude-sonnet-5', rv)
const [, q2] = await j('POST', '/raven/messages', { text: 'second ask' })
const [, q3] = await j('POST', '/raven/messages', { text: 'third ask' })
await ravenIdle()
let stops = stopsOf()
check('mid-run: one run for three messages', runsOf() - runsBefore === 1, runsOf() - runsBefore)
check('mid-run: its prompt held only the first', wokeBy().includes('first ask') && !wokeBy().includes('second ask'), wokeBy().slice(0, 600))
check('mid-run: the Stop hook hands both over and keeps the run going', stops.length === 2 && stops[0].decision === 'block'
  && stops[0].reason.includes(`message ${q2.message.id}`) && stops[0].reason.includes('second ask') && stops[0].reason.includes('third ask')
  && stops[0].reason.includes('Your answer above stands') && JSON.stringify(stops[1]) === '{}', stops)
reply = lastRavenMsg()
check('mid-run: one reply, its first answer with the next under it, to the newest message', reply?.text === 'first\n\nsecond' && reply.meta.replyTo === q3.message.id, reply)
const runQ = store.listRuns('raven', 1)[0]
check('mid-run: both follow-ups marked handled by that run, nothing left open', runOfMessage(q2.message.id) === runQ?.id && runOfMessage(q3.message.id) === runQ?.id
  && runOfMessage(q1.message.id) === runQ?.id && !store.openEvents('raven').length && runQ?.summary === 'first\n\nsecond', { runQ, q2: runOfMessage(q2.message.id) })
await sleep(300)
check('mid-run: no second run follows', runsOf() - runsBefore === 1 && lastRavenMsg()?.id === reply?.id, runsOf() - runsBefore)

// in the next tool result: shown there, so the Stop hook lets the run end
queue({ steps: [{ sleep: 800 }, { tool: 'now' }], result: 'backups fine, NAS fine' })
runsBefore = runsOf()
const [, t1] = await j('POST', '/raven/messages', { text: 'check the backups' })
await until(() => raven.ravenState().status === 'working')
const [, t2] = await j('POST', '/raven/messages', { text: 'and the NAS too' })
await ravenIdle()
let tr = ravenResults()
check('mid-run: the next tool result carries his new message under its own text', tr[0]?.texts?.length === 2 && tr[0].texts[0].includes('Agents')
  && tr[0].texts[1].startsWith('Brendon wrote again while you work') && tr[0].texts[1].includes(`message ${t2.message.id}`) && tr[0].texts[1].includes('and the NAS too'), tr[0])
check('mid-run: shown in a tool result, so the Stop hook lets it end', JSON.stringify(stopsOf()) === '[{}]', stopsOf())
check('mid-run: one run, the reply to the newest', runsOf() - runsBefore === 1 && lastRavenMsg()?.text === 'backups fine, NAS fine'
  && lastRavenMsg()?.meta.replyTo === t2.message.id && runOfMessage(t2.message.id) === runOfMessage(t1.message.id), { runs: runsOf() - runsBefore, last: lastRavenMsg() })

// from Siri, at the Stop hook: the spoken rule goes with it, and Siri gets the part written for it
queue({ steps: [{ sleep: 1200 }], result: 'Typed answer:\n\n- one\n- two', then: [{ result: 'It is **sunny** today.' }] })
runsBefore = runsOf()
const [, s1] = await j('POST', '/raven/messages', { text: 'list the two things' })
await until(() => raven.ravenState().status === 'working')
const [sayMidSt, sayMid] = await j('POST', '/raven/say', { text: 'what is the weather', wait: true, source: 'siri' })
await ravenIdle()
stops = stopsOf()
check('mid-run siri: the hand-over keeps the spoken rule', stops[0]?.decision === 'block' && stops[0].reason.includes('by voice through Siri') && stops[0].reason.includes('spoken aloud'), stops)
check('mid-run siri: Siri gets only the part written after it, speakable', sayMidSt === 200 && sayMid.done === true && sayMid.reply === 'It is sunny today.', sayMid)
check('mid-run siri: the thread gets the whole reply from one run', runsOf() - runsBefore === 1 && lastRavenMsg()?.text === 'Typed answer:\n\n- one\n- two\n\nIt is **sunny** today.'
  && lastRavenMsg()?.meta.replyTo === sayMid.id && s1.message.id < sayMid.id, lastRavenMsg())

// a run that repeats its held answer in full: posted once
queue({ steps: [{ sleep: 900 }], result: 'Lights off.', then: [{ result: 'Lights off.\n\nFan on too.' }] })
const [, r1] = await j('POST', '/raven/messages', { text: 'lights off' })
await until(() => raven.ravenState().status === 'working')
await j('POST', '/raven/messages', { text: 'and the fan on' })
await ravenIdle()
check('mid-run: an answer repeated in full is posted once', lastRavenMsg()?.text === 'Lights off.\n\nFan on too.' && runOfMessage(r1.message.id) !== null, lastRavenMsg()?.text)

// too late: sent after the run's last answer (its Stop hook passed) while the CLI is still up
queue({ steps: [{ sleep: 200 }], result: 'answer one', afterStop: 1500 }, { result: 'answer two' })
runsBefore = runsOf()
const nLate = ravenCount() + 1
const [, l1] = await j('POST', '/raven/messages', { text: 'first question' })
await until(() => fs.existsSync(path.join(stub, `stops-raven-${nLate}.json`)))
const [, l2] = await j('POST', '/raven/messages', { text: 'too late question' })
await ravenIdle()
const lateReplies = thread().filter((m) => m.author === 'raven').slice(-2)
check('late: the run that already answered does not take it', JSON.stringify(stopsOf(nLate)) === '[{}]' && lateReplies[0]?.text === 'answer one'
  && lateReplies[0].meta.replyTo === l1.message.id && runOfMessage(l2.message.id) !== runOfMessage(l1.message.id), { stops: stopsOf(nLate), lateReplies })
check('late: the next run answers it, as before', runsOf() - runsBefore === 2 && lateReplies[1]?.text === 'answer two' && lateReplies[1].meta.replyTo === l2.message.id
  && wokeBy().includes('too late question') && !wokeBy().includes('first question'), { runs: runsOf() - runsBefore, woke: wokeBy().slice(0, 500) })

// a run he did not start never takes his message: it gets a run of its own, on his rules
queue({ steps: [{ sleep: 800 }, { tool: 'now' }], result: '(no reply)' }, { result: 'his own run' })
runsBefore = runsOf()
hooks.wakeRavenWith('session_progress', { pane: 'vk-0123456789', label: 'Server work', turnEnded: false, said: [{ at: Date.now(), from: 'claude', text: 'Building.' }] })
await until(() => raven.ravenState().status === 'working')
const [, relayMsg] = await j('POST', '/raven/messages', { text: 'during a relay' })
await ravenIdle()
const bgN = ravenCount() - 1
const bgCalls = calls().filter((c) => c.kind === 'raven').slice(-2)
tr = ravenResults(bgN)
check('relay run: no Stop hook, and his message stays out of its tool results', !bgCalls[0]?.flags.includes('--settings') && bgCalls[1]?.flags.includes('--settings')
  && tr[0]?.texts?.length === 1 && JSON.stringify(stopsOf(bgN)) === '[]', { bgCalls, tr })
check('relay run: his message gets its own run and reply', runsOf() - runsBefore === 2 && lastRavenMsg()?.text === 'his own run' && lastRavenMsg()?.meta.replyTo === relayMsg.message.id,
  { runs: runsOf() - runsBefore, last: lastRavenMsg()?.text })
queue()

// --------------------------------------------------------- a long paste ---
// He pastes long text (a mail chain, a log). Up to 100,000 characters is kept whole and reaches the run's prompt
// whole, on stdin once the prompt passes what one Linux argument carries. The router sees its start and its end.
// A long follow-up taken in mid-run is cut in the tool result with the thread_read call that reads on, and
// thread_read reads a long message in parts.

const history = await import('../src/lib/raven/history.ts')
const LONG_HEAD = 'PASTE-HEAD the chain starts here.\n'
const LONG_TAIL = '\nPASTE-TAIL: what do they want from me?'
// é is two bytes in UTF-8: the prompt passes 100 KB with room to spare
const longText = (n: number) => LONG_HEAD + 'Re: the quote, see below é\n'.repeat(Math.ceil(n / 27)).slice(0, n - LONG_HEAD.length - LONG_TAIL.length) + LONG_TAIL
check('long: the limit is 100,000 characters', raven.RAVEN_TEXT_MAX === 100_000 && longText(100_000).length === 100_000, raven.RAVEN_TEXT_MAX)
let threadLen = thread().length
const [overSt, overBody] = await j('POST', '/raven/messages', { text: longText(100_001) })
check('long: one past 100,000 characters is refused with the limit, nothing posted', overSt === 400 && overBody?.error === 'keep a message under 100,000 characters'
  && thread().length === threadLen, { overSt, overBody })

router({ answer: '{"kind":"simple","why":"read a paste"}' })
queue({ result: 'They want the quote by Friday.' })
const long = longText(100_000)
const [longSt, longPosted] = await j('POST', '/raven/messages', { text: long })
await ravenIdle()
const longId: number = longPosted?.message?.id
check('long: 100,000 characters taken and kept whole', longSt === 200 && store.getMessage(longId)?.text === long, { longSt, len: store.getMessage(longId)?.text.length })
lr = lastRaven()
check('long: the run prompt holds all of it, on stdin', lr.stdin === true && lr.prompt.includes(`message ${longId}): ${long}`), { stdin: lr.stdin, len: lr.prompt?.length })
const routerAsk: string = rj('last-ask.json', {}).prompt ?? ''
check('long: the router sees its start and its end, with how much is left out', routerAsk.includes('PASTE-HEAD') && routerAsk.includes('PASTE-TAIL: what do they want from me?')
  && routerAsk.includes('more characters of the 100,000') && routerAsk.length < 6000, routerAsk.length)
check('long: answered', lastRavenMsg()?.text === 'They want the quote by Friday.' && lastRavenMsg()?.meta.replyTo === longId, lastRavenMsg())
router({})

queue({ result: 'short answer' })
const [, shortPosted] = await j('POST', '/raven/messages', { text: 'a short one' })
await ravenIdle()
check('long: the next prompt cuts it in the thread at 700 and goes as an argument, as before', lastRaven().stdin === false
  && lastRaven().prompt.includes(`[cut at 700 of 100000 characters: thread_read id ${longId} reads all of it]`), lastRaven().stdin)

const part1 = history.readThread({ id: longId })
const part2 = history.readThread({ id: longId, start: 60_000 })
check('thread_read: a long message comes in parts', part1.includes('PASTE-HEAD') && !part1.includes('PASTE-TAIL') && part1.length < 61_000
  && part1.endsWith(`[characters 1 to 60,000 of 100,000: thread_read id ${longId} start 60000 reads on]`), part1.slice(-200))
check('thread_read: start reads on to the end', !part2.includes('PASTE-HEAD') && part2.endsWith('PASTE-TAIL: what do they want from me?\n[characters 60,001 to 100,000 of 100,000: the end]'), part2.slice(-200))
check('thread_read: past the end says so', history.readThread({ id: longId, start: 100_000 }).endsWith('[the text ends at character 100,000]'))
check('thread_read: a short message reads whole, as before', history.readThread({ id: shortPosted.message.id }).endsWith('\na short one'))
const ranged = history.readThread({ from: longId, to: shortPosted.message.id })
check('thread_read: a range cuts the long one and goes on from the next', ranged.includes(`start 60000 reads on]`) && ranged.includes('[stopped at 60 KB: call again with from')
  && !ranged.includes('PASTE-TAIL'), ranged.slice(-300))

// a long follow-up while a run works: its next tool result carries the first 20,000 characters and the read-on call
queue({ steps: [{ sleep: 800 }, { tool: 'now' }], result: 'read both' })
await j('POST', '/raven/messages', { text: 'start on this' })
await until(() => raven.ravenState().status === 'working')
const [, longFollow] = await j('POST', '/raven/messages', { text: longText(50_000) })
await ravenIdle()
const news: string = ravenResults()[0]?.texts?.[1] ?? ''
check('long follow-up: the tool result cuts it at 20,000 with the call that reads on', news.startsWith('Brendon wrote again while you work') && news.includes('PASTE-HEAD')
  && !news.includes('PASTE-TAIL') && news.includes(`[cut at 20,000 of 50,000 characters: thread_read id ${longFollow.message.id} start 20000 reads on]`)
  && news.length < 21_000, news.slice(-300))
check('long follow-up: kept whole in the thread', store.getMessage(longFollow.message.id)?.text.length === 50_000, store.getMessage(longFollow.message.id)?.text.length)
queue()

// ---------------------------------------------------------------- stop ---

queue({ steps: [{ sleep: 8000 }], result: 'never posted' })
await j('POST', '/raven/messages', { text: 'something slow' })
await until(() => raven.ravenState().status === 'working')
const tStop = Date.now()
let [sst, sp] = await j('POST', '/raven/stop', {})
check('stop answers', sst === 200 && sp.ok === true && sp.stopped === true, sp)
await ravenIdle()
reply = lastRavenMsg()
check('stop kills the run and says so', reply?.text === 'Stopped.' && reply.meta.error === 'stopped' && Date.now() - tStop < 4000, { reply, ms: Date.now() - tStop })
check('stopped run recorded failed', store.listRuns('raven', 1)[0]?.error === 'stopped', store.listRuns('raven', 1)[0])
check('stop with nothing running', (await j('POST', '/raven/stop', {}))[1]?.stopped === false)
await sleep(300)
check('a stopped run never posts its answer', !thread().some((m) => m.text === 'never posted'))

// --------------------------------------------------------------- files ---

const tinyPng = (wpx: number, hpx: number) => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(wpx, 0); ihdr.writeUInt32BE(hpx, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((wpx * 3 + 1) * hpx))), chunk('IEND', Buffer.alloc(0))])
}
const tinyPdf = (text: string) => {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

let [ust, txt] = await upload('notes ü.txt', 'text/plain', 'hello raven file')
check('upload text', ust === 200 && /^[a-f0-9]{24}$/.test(txt.id) && txt.name === 'notes ü.txt' && txt.mime === 'text/plain' && txt.size === 16, txt)
let r = await fetch(`${base}/raven/files/${txt.id}`)
check('serve text inline', r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('text/plain') && (await r.text()) === 'hello raven file'
  && (r.headers.get('content-disposition') ?? '').startsWith('inline'), r.headers.get('content-type'))
let [, png] = await upload('photo.png', 'image/png', tinyPng(4, 3))
r = await fetch(`${base}/raven/files/${png.id}`)
check('serve image with its real type', r.status === 200 && r.headers.get('content-type') === 'image/png' && (r.headers.get('content-security-policy') ?? '').includes('sandbox'), r.headers.get('content-type'))
let [, html] = await upload('page.html', 'text/html', '<script>alert(1)</script>')
r = await fetch(`${base}/raven/files/${html.id}`)
check('html served as plain text, sandboxed', (r.headers.get('content-type') ?? '').startsWith('text/plain') && (r.headers.get('content-security-policy') ?? '').includes('sandbox'), r.headers.get('content-type'))
let [, bigPng] = await upload('big.png', 'image/png', tinyPng(2400, 1800))
let [, pdf] = await upload('memo.pdf', 'application/pdf', tinyPdf('Hello PDF from Raven'))
let [, zip] = await upload('stuff.zip', '', Buffer.from('PK\u0003\u0004 not really'))
check('mime from the extension when none is sent', zip.mime === 'application/zip', zip)
r = await fetch(`${base}/raven/files/${png.id}`)
check('image served inline, nosniff', (r.headers.get('content-disposition') ?? '').startsWith('inline') && r.headers.get('x-content-type-options') === 'nosniff', [...r.headers])
r = await fetch(`${base}/raven/files/${zip.id}`)
check('another kind is a download with its real type', r.status === 200 && r.headers.get('content-type') === 'application/zip'
  && (r.headers.get('content-disposition') ?? '').startsWith('attachment;'), [r.headers.get('content-type'), r.headers.get('content-disposition')])
for (const [name, type] of [['feed.atom', 'application/atom+xml'], ['run.js', 'application/x-javascript'], ['page.xhtml', 'application/xhtml+xml'], ['pic.svg', 'image/svg+xml']]) {
  const [, f] = await upload(name, type, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  r = await fetch(`${base}/raven/files/${f.id}`)
  check(`${type} served as plain text`, (r.headers.get('content-type') ?? '').startsWith('text/plain') && (r.headers.get('content-security-policy') ?? '').includes('sandbox'), r.headers.get('content-type'))
}
let [, quoted] = await upload("it's (a) *b*.zip", 'application/zip', 'PK')
r = await fetch(`${base}/raven/files/${quoted.id}`)
check('file name in the header is RFC 5987 encoded', (r.headers.get('content-disposition') ?? '').endsWith("filename*=UTF-8''it%27s%20%28a%29%20%2Ab%2A.zip"), r.headers.get('content-disposition'))
// ffmpeg reads by content, not by name: a playlist named .png must never reach it (it would open other files on this host)
let [, trap] = await upload('trap.png', 'image/png', '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n'.padEnd(2 * 1024 * 1024, '#'))
await files.attachmentContent(trap.id)
check('a non-image named .png never goes to ffmpeg', !fs.existsSync(path.join(dataDir, 'raven-files', `${trap.id}.view.jpg`)), fs.readdirSync(path.join(dataDir, 'raven-files')).filter((f) => f.startsWith(trap.id)))
check('looksLikeImage: png yes, playlist no', files.looksLikeImage(tinyPng(4, 3)) && !files.looksLikeImage(Buffer.from('#EXTM3U\n')), null)
check('empty upload refused', (await upload('empty.txt', 'text/plain', ''))[0] === 400)
let over: unknown = null
try { await files.saveRavenFile(Readable.from([Buffer.alloc(3000)]), { name: 'big.bin', maxBytes: 1000 }) } catch (e) { over = e }
check('over the cap: 413 and nothing kept', (over as any)?.status === 413 && !fs.readdirSync(path.join(dataDir, 'raven-files')).some((f) => f.endsWith('.bin')), over)
check('unknown file 404', (await j('GET', '/raven/files/0123456789abcdef01234567'))[0] === 404)
const img = signImgToken().token
const remote = { 'x-forwarded-for': '203.0.113.9' }
r = await fetch(`${base}/raven/files/${png.id}?token=${img}`, { headers: remote })
check('img token opens a file from off the tailnet', r.status === 200, r.status)
r = await fetch(`${base}/raven/files/${png.id}`, { headers: remote })
check('no token: 401', r.status === 401, r.status)
r = await fetch(`${base}/raven?token=${img}`, { headers: remote })
check('img token opens nothing else', r.status === 401, r.status)

queue({ steps: [
  { tool: 'attachment', args: { id: png.id } }, { tool: 'attachment', args: { id: txt.id } }, { tool: 'attachment', args: { id: bigPng.id } },
  { tool: 'attachment', args: { id: pdf.id } }, { tool: 'attachment', args: { id: zip.id } }, { tool: 'attachments', args: {} },
  { tool: 'attachment', args: { id: 'nope' } },
], result: 'Looked at them.' })
const [fst, fm] = await j('POST', '/raven/messages', { text: '', files: [png.id, txt.id] })
check('a message can be files only', fst === 200 && fm.message.text === '' && fm.message.meta.files?.length === 2 && fm.message.meta.files[0].name === 'photo.png', fm)
check('a missing file is refused', (await j('POST', '/raven/messages', { text: 'x', files: ['0123456789abcdef01234567'] }))[0] === 400)
check('empty message refused', (await j('POST', '/raven/messages', { text: '  ' }))[0] === 400)
await ravenIdle()
rr = ravenResults()
check('attachment: small image as an image', rr[0]?.types?.join(',') === 'text,image' && rr[0].mime === 'image/png', rr[0])
check('attachment: text file as text', rr[1]?.text?.includes('hello raven file'), rr[1])
check('attachment: when it was sent is an ET label', / ET\)/.test(rr[1]?.text ?? '') && !/\d{4}-\d{2}-\d{2}T\d/.test(rr[1]?.text ?? ''), rr[1]?.text?.slice(0, 120))
const ffmpeg = fs.existsSync('/usr/bin/ffmpeg')
check(`attachment: large image downscaled to JPEG${ffmpeg ? '' : ' (ffmpeg absent, skipped)'}`, !ffmpeg || (rr[2]?.mime === 'image/jpeg' && /downscaled/.test(rr[2].text ?? '')), rr[2])
const pdftotext = fs.existsSync('/usr/bin/pdftotext')
check(`attachment: PDF as text${pdftotext ? '' : ' (pdftotext absent, skipped)'}`, !pdftotext || rr[3]?.text?.includes('Hello PDF from Raven'), rr[3])
check('attachment: other kinds as name, type and size', rr[4]?.text?.includes('stuff.zip') && /only its name, type and size/.test(rr[4].text), rr[4])
check('attachments lists recent files', JSON.parse(rr[5]?.text ?? '[]').some((f: any) => f.id === png.id && f.sent?.endsWith('ET')), rr[5])
check('attachment: unknown id is an error', rr[6]?.isError === true, rr[6])
check('prompt names the attachments', lastRaven().prompt.includes(`id ${png.id}`) && lastRaven().prompt.includes('Look at it with attachment'), lastRaven().prompt?.slice(0, 600))

// ------------------------------------------------------------------ say ---

queue({ result: 'Done. **Lights** are [off](https://x.example/a).\n\n- bedroom\n- kitchen' })
let [yst, say] = await j('POST', '/raven/say', { text: 'lights off', wait: true, source: 'siri' })
check('say waits for the reply, speakable', yst === 200 && say.ok && say.done === true && say.reply === 'Done. Lights are off. bedroom. kitchen.', say)
const sayMsg = store.getMessage(say.id)
check('say message marked siri', sayMsg?.meta.source === 'siri' && sayMsg.author === 'brendon', sayMsg)
check('siri prompt asks for a spoken answer', lastRaven().prompt.includes('Siri') && lastRaven().prompt.includes('spoken aloud'), lastRaven().prompt?.slice(0, 400))
queue({ steps: [{ sleep: 16000 }], result: 'late answer' })
const tSay = Date.now()
;[yst, say] = await j('POST', '/raven/say', { text: 'something long', wait: true, source: 'hotkey' })
check('say times out: done false, still working', say.done === false && /Still working/.test(say.reply) && Date.now() - tSay < 16000, say)
await ravenIdle()
check('the late answer still lands in the thread', lastRavenMsg()?.text === 'late answer' && lastRavenMsg()?.meta.replyTo === say.id, lastRavenMsg())
queue({ result: 'ok' })
;[yst, say] = await j('POST', '/raven/say', { text: 'note this', wait: false })
check('say without wait answers at once', yst === 200 && say.ok && typeof say.id === 'number' && say.reply === undefined, say)
await ravenIdle()
check('say from off the tailnet without a token: 401', (await j('POST', '/raven/say', { text: 'x' }, remote))[0] === 401)
check('speakable strips markdown and links', speakable('## Plan\n1. **One** `x`\n2. See https://a.example/b\n| a | b |') === 'Plan. One x. See. a, b.', speakable('## Plan\n1. **One** `x`\n2. See https://a.example/b\n| a | b |'))

// --------------------------------------------------------------- notify ---

const runsNow = runsOf()
let [nst, nr] = await j('POST', '/raven/notify', { source: 'backup', level: 'warn', title: 'Backup failed', body: 'The disk refused the write.', tag: 'run-1', url: 'https://example.com/l/1' })
check('notify posts', nst === 200 && nr.posted === true, nr)
let nm = lastRavenMsg()
check('notice: feature relay labeled Backup, notify, link', nm?.meta.relay?.kind === 'feature' && nm.meta.relay.label === 'Backup' && nm.meta.relay.from === 'backup'
  && nm.notify === true && nm.text === 'Backup failed\n\nThe disk refused the write.' && nm.refs[0]?.type === 'link', nm)
;[, nr] = await j('POST', '/raven/notify', { source: 'backup', level: 'warn', title: 'Backup failed again', tag: 'run-1' })
check('same source and tag within 30 min: nothing posted', nr.posted === false && lastRavenMsg()?.id === nm?.id, nr)
;[, nr] = await j('POST', '/raven/notify', { source: 'backup', level: 'info', title: 'Run 2 is done', tag: 'run-2' })
check('another tag posts; info does not notify', nr.posted === true && lastRavenMsg()?.notify === false, lastRavenMsg())
;[, nr] = await j('POST', '/raven/notify', { source: 'valkyrie', level: 'info', title: 'Backups fine' })
check('another source is a system relay', nr.posted === true && lastRavenMsg()?.meta.relay?.kind === 'system', lastRavenMsg()?.meta)
check('notify: bad source 400', (await j('POST', '/raven/notify', { source: 'Bad Source!', title: 'x' }))[0] === 400)
check('notify: no title 400', (await j('POST', '/raven/notify', { source: 'backup' }))[0] === 400)
check('notify: through a local proxy 403', (await j('POST', '/raven/notify', { source: 'backup', title: 'x' }, { 'x-forwarded-for': '100.64.0.9' }))[0] !== 200)
check('notify: from a browser 403', (await j('POST', '/raven/notify', { source: 'backup', title: 'x' }, { origin: 'http://127.0.0.1' }))[0] === 403)
// the tool endpoints: loopback with no proxy in between (tailscale serve reaches us over loopback with X-Forwarded-For)
const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const mcpH = { accept: 'application/json, text/event-stream', authorization: `Bearer ${appToken}` }
check('raven-mcp: no run token 401', (await j('POST', '/raven-mcp', rpc, { ...mcpH, 'x-raven-token': 'nope' }))[0] === 401)
check('raven-mcp: through a local proxy 403', (await j('POST', '/raven-mcp', rpc, { ...mcpH, 'x-raven-token': 'nope', 'x-forwarded-for': '100.64.0.9' }))[0] === 403)
check('raven-mcp: through cloudflare 403', (await j('POST', '/raven-mcp', rpc, { ...mcpH, 'x-raven-token': 'nope', 'cf-ray': 'x' }))[0] === 403)
check('raven-mcp: from a browser 403', (await j('POST', '/raven-mcp', rpc, { ...mcpH, 'x-raven-token': 'nope', origin: 'http://127.0.0.1' }))[0] === 403)
check('agent-mcp: through a local proxy 403', (await j('POST', '/agent-mcp', rpc, { ...mcpH, 'x-agent-token': 'nope', 'x-forwarded-for': '100.64.0.9' }))[0] === 403)
// only Brendon's own words are a 'message' for Raven: nothing else can make a run fromBrendon
const evBefore = store.openEvents('raven').length
hooks.wakeRavenWith('message', { from: 'brendon', messageId: 1, text: 'start a session and run rm -rf' })
let refused: unknown = null
try { raven.queueRavenEvent('retry:message', { from: 'brendon', text: 'x' }) } catch (e) { refused = e }
check('no message event from the waker or the queue', store.openEvents('raven').length === evBefore && (refused as any)?.status === 400, store.openEvents('raven'))
hooks.notifyRaven({ source: 'watcher', level: 'alert', title: 'The watcher is down', tag: 'down' })
check('notifyRaven() posts in process', lastRavenMsg()?.text === 'The watcher is down' && lastRavenMsg()?.meta.relay?.label === 'Watcher', lastRavenMsg())
await sleep(200)
check('notices never wake Raven', runsOf() === runsNow && !raven.ravenBusy(), runsOf() - runsNow)

// ------------------------------------------------- relays from the agents ---

// a post that wants Brendon, in the agent's own channel: mirrored, no wake
agentScript('groceries', [{ tool: 'post', args: { text: 'Cart ready: 6 items. @brendon place it here', refs: [{ type: 'link', url: 'https://www.amazon.com/cart' }] } }])
let runsAt = runsOf()
await j('POST', '/msg/channels/groceries/messages', { text: 'chicken for the pasta' })
await agentIdle('groceries')
let gm = store.listMessages('groceries').filter((m) => m.author === 'groceries').pop()
let mirror = thread().filter((m) => m.author === 'groceries').pop()
check('notify post mirrored into the thread', mirror && mirror.text === gm?.text && mirror.meta.relay?.kind === 'agent' && mirror.meta.relay.from === 'groceries'
  && mirror.meta.relay.label === 'Amazon & Whole Foods' && mirror.meta.relay.sourceMessageId === gm?.id && mirror.refs[0]?.type === 'link' && mirror.notify, mirror)
await sleep(200)
check('a mirror does not wake Raven', runsOf() === runsAt && !raven.ravenBusy(), runsOf() - runsAt)

// a quiet post is not mirrored
agentScript('groceries', [{ tool: 'post', args: { text: 'Checked the pantry list.' } }])
await j('POST', '/msg/channels/groceries/messages', { text: 'check the pantry' })
await agentIdle('groceries')
check('a quiet post stays in its channel', !thread().some((m) => m.text === 'Checked the pantry list.'))

// a proposal: mirrored with its card
agentScript('east-triage', [{ tool: 'propose_ticket_note', args: { ticketId: 101, number: 'T20261119.0001', title: 'Printer fixed', text: 'Static IP set again' } }])
agents.checkNow('east-triage')
await agentIdle('east-triage')
check('proposal tool ran', rj('results-east-triage.json')?.[0] && !rj('results-east-triage.json')[0].isError, rj('results-east-triage.json'))
;[, rv] = await j('GET', '/raven')
const card = rv.messages.find((m: any) => m.proposal?.kind === 'ticket_note')
check('proposal mirrored with its card in GET /raven', card && card.author === 'east-triage' && card.proposal.status === 'pending' && card.meta.relay?.label === 'East Triage', card)
check('state counts the pending proposal', rv.agents.find((a: any) => a.id === 'east-triage')?.pending === 1, rv.agents)
{
  const w = rv.agents.find((a: any) => a.id === 'east-triage')?.waiting
  check('state lists the waiting proposal with its card', Array.isArray(w) && w.length === 1 && w[0].id === card.proposal.id && w[0].msgId === card.id
    && w[0].kind === 'ticket_note' && w[0].ticket === 'T20261119.0001' && w[0].title === card.proposal.title && Number.isFinite(Date.parse(w[0].at)) && !('subject' in w[0]), w)
  check('an agent with nothing waiting lists nothing', rv.agents.filter((a: any) => a.pending === 0).every((a: any) => Array.isArray(a.waiting) && a.waiting.length === 0), rv.agents)
}
await j('POST', `/msg/proposals/${card.proposal.id}/decline`, { reason: '' })
;[, rv] = await j('GET', '/raven')
check('the card follows the decision', rv.messages.find((m: any) => m.proposal?.id === card.proposal.id)?.proposal.status === 'declined', rv.messages.find((m: any) => m.proposal?.id === card.proposal.id))

// Decline all: the oldest N waiting proposals of one agent, nothing sent or applied, one note to the agent, no wake
{
  const ch = card.proposal ? store.getProposal(card.proposal.id)!.channelId : 'east'
  const made = [1, 2, 3, 4].map((i) => store.addProposal({ agentId: 'east-triage', channelId: ch, kind: 'ticket_note', title: `Bulk ${i}`, payload: { ticketId: 900 + i, title: `n${i}`, text: 'x' } }))
  // the list under the count: a card of its own, one folded into that relay, a mail's subject, none in the thread
  const relay = store.addMessage({ channelId: 'raven', author: 'east-triage', text: 'Two notes', proposalId: made[0].id,
    meta: { relay: { kind: 'agent', from: 'east-triage', label: 'East Triage', proposalIds: [made[1].id] } } })
  store.addMessage({ channelId: 'raven', author: 'east-triage', text: 'Again', proposalId: made[0].id, meta: { relay: { kind: 'agent', from: 'east-triage', label: 'East Triage' } } })
  const mailP = store.addProposal({ agentId: 'east-triage', channelId: ch, kind: 'mail_reply', title: 'Reply to Pat: Printer', payload: { subject: 'Printer offline', body: 'x' } })
  {
    const [, sv] = await j('GET', '/raven')
    const w: any[] = sv.agents.find((a: any) => a.id === 'east-triage')?.waiting ?? []
    const at = (id: number) => w.find((x) => x.id === id)
    check('waiting: oldest first, every one listed', JSON.stringify(w.map((x) => x.id)) === JSON.stringify([...made.map((p) => p.id), mailP.id]), w)
    check('waiting: a card of its own and a folded one both point at the relay (the oldest message wins)', at(made[0].id)?.msgId === relay.id && at(made[1].id)?.msgId === relay.id, w.slice(0, 2))
    check('waiting: a proposal with no card in the thread has msgId null', at(made[2].id)?.msgId === null, at(made[2].id))
    check('waiting: a mail names its subject and no ticket', at(mailP.id)?.subject === 'Printer offline' && !('ticket' in at(mailP.id)), at(mailP.id))
  }
  store.moveProposal(mailP.id, ['pending'], 'declined')
  const eventsBefore = store.openEvents('east-triage').length
  const runsBefore = store.listRuns('east-triage', 50).length
  let [dst, dr] = await j('POST', '/msg/proposals/decline-all', { agentId: 'east-triage' })
  check('decline all: a missing count is refused', dst === 400, dr)
  ;[dst, dr] = await j('POST', '/msg/proposals/decline-all', { agentId: 'nobody', count: 3 })
  check('decline all: an unknown agent is a 404', dst === 404, dr)
  ;[dst, dr] = await j('POST', '/msg/proposals/decline-all', { agentId: 'east-triage', count: 3 })
  check('decline all: the oldest 3 declined, the newest left waiting', dst === 200 && dr.declined === 3 && JSON.stringify(dr.ids) === JSON.stringify(made.slice(0, 3).map((p) => p.id))
    && store.getProposal(made[3].id)?.status === 'pending', dr)
  check('decline all: declined, with nothing sent or applied', made.slice(0, 3).every((p) => store.getProposal(p.id)?.status === 'declined' && store.getProposal(p.id)?.result === 'Declined with Decline all')
    , made.map((p) => store.getProposal(p.id)?.status))
  const ev = store.openEvents('east-triage').slice(eventsBefore)
  check('decline all: one note to the agent, not one per card', ev.length === 1 && ev[0].kind === 'proposals_declined' && ev[0].payload.count === 3, ev)
  await new Promise((r) => setTimeout(r, 300))
  check('decline all: the agent is not woken for it', store.listRuns('east-triage', 50).length === runsBefore, store.listRuns('east-triage', 3))
  ;[dst, dr] = await j('POST', '/msg/proposals/decline-all', { count: 50 })
  check('decline all for every agent: the rest declined', dst === 200 && dr.ids.includes(made[3].id) && store.pendingProposals().length === 0, dr)
  store.claimEvents('east-triage', 'smoke-clear', store.openEvents('east-triage').map((e: any) => e.id))
}

// an agent posting in #raven wakes Raven (relay run: no router, sonnet/low, not fromBrendon)
agentScript('groceries', [{ tool: 'post', args: { channel: 'raven', text: 'For Raven: the cart is ready.' } }, { tool: 'read_channel', args: { channel: 'raven' } }])
queue({ steps: [{ tool: 'probe_gate' }, { tool: 'gated_write' }], result: '(no reply)' })
runsAt = runsOf()
const asksBefore = calls().filter((c) => c.kind === 'ask').length
const msgsBefore = thread().length
agents.checkNow('groceries')
await agentIdle('groceries')
const gr = rj('results-groceries.json')
check('an agent may post in #raven', gr?.[0] && !gr[0].isError, gr)
check('an agent may not read #raven', gr?.[1]?.isError === true, gr?.[1])
const inRaven = thread().filter((m) => m.author === 'groceries').pop()
check('agent post in #raven is a relay', inRaven?.text === 'For Raven: the cart is ready.' && inRaven.meta.relay?.kind === 'agent', inRaven)
await until(() => runsOf() > runsAt)
await ravenIdle()
check('it woke Raven once', runsOf() - runsAt === 1, runsOf() - runsAt)
const relayRun = calls().filter((c) => c.kind === 'raven').pop()
check('relay run skips the router: sonnet/low', calls().filter((c) => c.kind === 'ask').length === asksBefore && relayRun?.model === 'claude-sonnet-5' && relayRun.effort === 'low', relayRun)
rr = ravenResults()
check('relay run: tools see fromBrendon false and the hop it came in on', rr[0]?.text === '{"fromBrendon":false,"hop":1}', rr[0])
check('relay prompt: the post is already in the thread, do not repeat it', lastRaven().prompt.includes('already in the thread'), lastRaven().prompt?.slice(-600))
check('relay run: gated tool refuses', rr[1]?.isError === true, rr[1])
check('(no reply) posts nothing', thread().length === msgsBefore + 1 && lastRaven().prompt.includes('For Raven: the cart is ready.'), thread().slice(msgsBefore))
check('gate log', gateSeen.includes(true) && gateSeen.includes(false), gateSeen)

// a job Raven started answered (lib/raven/tools/watch.ts): the run that reads it is told to close it when it is done
queue({ result: '(no reply)' })
runsAt = runsOf()
hooks.wakeRavenWith('session_reply', {
  pane: 'vk-0000000009', label: 'Work', sessionId: '3c2608cc-c46d-4710-a697-0e6e79248681', turnEnded: true,
  said: [{ at: Date.now(), from: 'claude', text: 'I shipped v0.3.211. It is live now.' }], job: true, title: 'iPad: match desktop dashboard layout',
})
await until(() => runsOf() > runsAt)
await ravenIdle()
{
  const jp = lastRaven().prompt ?? ''
  check('job answer: the run is told to session_stop it now when done, or session_keep it', jp.includes('I shipped v0.3.211.')
    && jp.includes('You started this session for a job ("iPad: match desktop dashboard layout")') && jp.includes('session_stop vk-0000000009 now, in this run')
    && jp.includes('session_keep it') && jp.includes('closed and marked done on its own 15 minutes after this turn'), jp.slice(0, 1200))
  check('job answer: a finished job is stopped in the run, and he gets the result in one line',
    jp.includes('A job you started that reports it is done: session_stop it in this run (that marks it done) and tell him the result in one line.'), jp.slice(-700))
  check('brief: a session Raven started is its to close, in the same run', lastRaven().sys.includes('is yours to close. In the same run its answer reports the job done, session_stop it')
    && lastRaven().sys.includes('Start a session, reopen a closed one, stop one he opened or one of his main terminals'), lastRaven().sys)
  check('brief: an existing session is recovered, never a duplicate', lastRaven().sys.includes('Never start a duplicate.') && lastRaven().sys.includes('session_recover it, then session_send'), lastRaven().sys)
}

// one of his Raven reopened (session_recover) answered: closing it leaves it not done
queue({ result: '(no reply)' })
runsAt = runsOf()
hooks.wakeRavenWith('session_reply', {
  pane: 'vk-0000000010', label: 'Laptop data recovery', sessionId: '3c2608cc-c46d-4710-a697-0e6e79248682', turnEnded: true,
  said: [{ at: Date.now(), from: 'claude', text: 'Status: 4,210 photos recovered.' }], job: true, reopened: true, title: 'Photo recovery status',
})
await until(() => runsOf() > runsAt)
await ravenIdle()
{
  const jp = lastRaven().prompt ?? ''
  check('reopened answer: stop it once his ask is answered, never marked done by that', jp.includes('Status: 4,210 photos recovered.')
    && jp.includes(`You reopened this session of Brendon's with session_recover for "Photo recovery status"`) && jp.includes('session_stop vk-0000000010 in this run')
    && jp.includes('leaves it on his closed list, not done') && jp.includes('still not done') && !jp.includes('You started this session for a job'), jp.slice(0, 1400))
}

// Brendon naming an agent in the thread wakes it as well as Raven
agentScript('groceries', [{ tool: 'post', args: { channel: 'raven', text: 'Added milk.' } }])
queue({ result: 'Asked Groceries.' }, { result: '(no reply)' })
runsAt = runsOf()
await j('POST', '/raven/messages', { text: '@groceries add milk please' })
await agentIdle('groceries')
await until(() => thread().some((m) => m.text === 'Added milk.'))
await ravenIdle()
const gp = rj('last-groceries.json')?.prompt ?? ''
check('@agent in the thread wakes the agent', thread().some((m) => m.author === 'groceries' && m.text === 'Added milk.') && gp.includes('In #raven') && gp.includes('add milk please'), gp.slice(0, 500))
check("the agent's prompt never shows the thread", !gp.includes('Listing failed') && !gp.includes('plan the move'), gp.slice(0, 800))
check('and Raven ran for it too', runsOf() - runsAt >= 1 && thread().some((m) => m.text === 'Asked Groceries.'), runsOf() - runsAt)

// ----------------------------------------------------- the morning brief ---

const b1 = await brief.writeBrief()
check('brief written', b1?.status === 'done', b1)
let bm = lastRavenMsg()
check('brief posted in the thread', bm?.text === 'Light day. Dentist at 2:30 PM ET.' && bm.meta.relay?.kind === 'system' && bm.meta.relay.label === 'Morning brief', bm)
await brief.writeBrief()
check('a rewrite is not posted again', thread().filter((m) => m.meta.relay?.label === 'Morning brief').length === 1)
await sleep(200)
check('the brief does not wake Raven', !raven.ravenBusy())

// ---------------------------------------------------- the old app's route ---

queue({ result: 'answered the old app' })
let [ost, om] = await j('POST', '/msg/channels/raven/messages', { text: 'from the old app' })
check('old app post in the raven channel goes to Raven', ost === 200 && om.message.author === 'brendon', om)
await ravenIdle()
check('and Raven answers it', lastRavenMsg()?.text === 'answered the old app', lastRavenMsg())

// --------------------------------------------------------- read, paging ---

;[, rv] = await j('GET', '/raven')
check('unread counts the thread', rv.unread > 0, rv.unread)
let [, cnt] = await j('GET', '/msg/count')
check('/msg/count is the thread', cnt.unread === rv.unread, { cnt, unread: rv.unread })
await j('POST', '/raven/read', {})
;[, rv] = await j('GET', '/raven')
;[, cnt] = await j('GET', '/msg/count')
check('read clears it', rv.unread === 0 && cnt.unread === 0, { rv: rv.unread, cnt })
const all = thread()
check('GET /raven: newest 60, oldest first', rv.messages.length === Math.min(60, all.length) && rv.messages[0].id < rv.messages[rv.messages.length - 1].id && rv.messages[rv.messages.length - 1].id === all[all.length - 1].id, rv.messages.length)
const pivot = rv.messages[10].id
let [, pg] = await j('GET', `/raven/messages?before=${pivot}&limit=5`)
check('paging back', pg.messages.length === 5 && pg.messages.every((m: any) => m.id < pivot) && pg.messages[4].id === rv.messages[9].id, pg.messages.map((m: any) => m.id))
check('message shape is the contract', Object.keys(rv.messages[0]).sort().join(',') === 'author,createdAt,id,meta,proposal,refs,text', Object.keys(rv.messages[0]))
check('cloudflare: /msg/count hides the thread', (await j('GET', '/msg/count', undefined, CF))[1]?.unread === 0)

// ----------------------------------------------------------------- push ---

await sleep(350)
check('push: first goes', push.ravenPush('Raven', 'one') === true)
check('push: second within the window is held', push.ravenPush('Raven', 'two') === false)
check('push: a reply to Brendon goes anyway', push.ravenPush('Raven', 'three', { force: true }) === true)
check('push line is plain', push.pushLine('**Done.** See [the card](https://x)') === 'Done. See the card')

// ------------------------------------------------------------ notebook ---

queue({ steps: [{ tool: 'notebook_set', args: { text: 'Brendon prefers short answers.' } }], result: 'Noted.' }, { result: 'ok' })
await j('POST', '/raven/messages', { text: 'keep answers short' })
await ravenIdle()
check('notebook saved', raven.ravenNotebook() === 'Brendon prefers short answers.')
await j('POST', '/raven/messages', { text: 'what do you remember' })
await ravenIdle()
check('next prompt carries the notebook', lastRaven().prompt.includes('Brendon prefers short answers.'))

// ------------------------------------------------- stop while routing ---

router({ sleep: 15000 })
queue({ result: 'never posted either' })
before = calls().length
await j('POST', '/raven/messages', { text: 'route me slowly' })
await until(() => raven.ravenState().status === 'routing')
const tStopR = Date.now()
check('stop while routing answers stopped', (await j('POST', '/raven/stop', {}))[1]?.stopped === true)
await ravenIdle()
check('stop while routing: Stopped. and no run started', lastRavenMsg()?.text === 'Stopped.' && Date.now() - tStopR < 4000
  && !calls().slice(before).some((c) => c.kind === 'raven'), { last: lastRavenMsg()?.text, ms: Date.now() - tStopR, calls: calls().slice(before).map((c) => c.kind) })
await sleep(300)
check('stop while routing: no late post', !thread().some((m) => m.text === 'never posted either'))
router({})
queue()

// ---------------------------------------- what a watched session wrote ---
// Every line goes to Raven whole (lib/raven/tools/watch.ts); the thread gets only Raven's take, the lines kept under it.

{
  const SID = 'abcdabcd-1111-4222-8333-444455556666'
  const long = `Step two of three. ${'detail '.repeat(700)}END-OF-LONG`
  queue({ result: '(no reply)' })
  runsAt = runsOf()
  const msgs0 = thread().length
  hooks.wakeRavenWith('session_progress', {
    pane: 'vk-0123456789', label: 'Server work', title: 'Rotate certs', sessionId: SID, turnEnded: false,
    said: [{ at: Date.now(), from: 'prompt', text: 'rotate the certs' }, { at: Date.now(), from: 'claude', text: long }],
  })
  await until(() => runsOf() > runsAt)
  await ravenIdle()
  let pr = lastRaven().prompt ?? ''
  check('session lines: a long line reaches the prompt whole', pr.includes('Step two of three.') && pr.includes('END-OF-LONG') && pr.includes('It is still working.')
    && pr.includes('Prompt typed into it: rotate the certs') && pr.includes('(job: Rotate certs)'), pr.slice(0, 900))
  check('session prompt: only Raven reads them, and the bar for telling him', pr.includes('He has not seen what the watched sessions wrote') && pr.includes('a job finished or shipped')
    && pr.includes('exactly (no reply)') && !pr.includes('is already in the thread'), pr.slice(-1400))
  check('session lines Raven drops: nothing in the thread', thread().length === msgs0, thread().slice(msgs0))

  queue({ result: 'Certs rotated on odin; nginx reloaded clean.' })
  runsAt = runsOf()
  hooks.wakeRavenWith('session_reply', {
    pane: 'vk-0123456789', label: 'Server work', sessionId: SID, turnEnded: true, asking: true, background: true,
    said: [{ at: Date.now(), from: 'claude', text: 'All three certs rotated. nginx -t passed and it reloaded.' }],
  })
  await until(() => runsOf() > runsAt)
  await ravenIdle()
  pr = lastRaven().prompt ?? ''
  check('session reply: turn over, an open dialog and background work said', pr.includes('Its turn is over.') && pr.includes('no prompt box') && pr.includes('background work'), pr.slice(0, 900))
  const take = lastRavenMsg()
  check('session reply: Raven\'s take posts, never a raw session row', take?.text === 'Certs rotated on odin; nginx reloaded clean.' && !thread().slice(msgs0).some((m) => m.meta.relay?.kind === 'session'),
    thread().slice(msgs0).map((m) => m.text))
  const copy = (take?.meta as any)?.sessions?.[0]
  check('session reply: the lines kept under the take', copy?.from === 'vk-0123456789' && copy.label === 'Server work' && copy.sessionId === SID && copy.lines.length === 1
    && copy.lines[0].text.startsWith('All three certs') && !copy.more, take?.meta)
  ;[, rv] = await j('GET', '/raven')
  check('GET /raven: the copy rides the message', rv.messages.find((m: any) => m.id === take?.id)?.meta.sessions?.[0]?.lines?.length === 1)

  // more than one run holds: the newest lines whole, a note for the oldest; the copy keeps the newest it can
  queue({ result: 'Still on it.' })
  runsAt = runsOf()
  const big = Array.from({ length: 12 }, (_, i) => ({ at: Date.now(), from: 'claude', text: `L${i} ${'z'.repeat(5000)}` }))
  hooks.wakeRavenWith('session_progress', { pane: 'vk-0123456789', label: 'Server work', said: big, turnEnded: false })
  await until(() => runsOf() > runsAt)
  await ravenIdle()
  pr = lastRaven().prompt ?? ''
  check('session lines past the budget: the newest whole, the oldest named', pr.includes(`L11 ${'z'.repeat(5000)}`) && pr.includes('L3 z') && !pr.includes('L2 z')
    && pr.includes('3 older lines left out'), pr.length)
  const bigCopy = (lastRavenMsg()?.meta as any)?.sessions?.[0]
  check('the copy: the newest line, the rest counted', bigCopy?.lines.length === 1 && bigCopy.lines[0].text.startsWith('L11') && bigCopy.more === 11, { n: bigCopy?.lines.length, more: bigCopy?.more })

  // an answer queued by an older API (text, no lines) still reads
  queue({ result: '(no reply)' })
  runsAt = runsOf()
  hooks.wakeRavenWith('session_reply', { pane: 'vk-0123456789', label: 'Server work', text: 'OLD-SHAPE answer.' })
  await until(() => runsOf() > runsAt)
  await ravenIdle()
  check('an older session_reply still reads', (lastRaven().prompt ?? '').includes('answered: OLD-SHAPE answer.'))
}

// ----------------------------------------- a restart with a run in flight ---
// The run row is left 'running' and its events claimed; the next start closes it and gives them one more try.

const ghostMsg = store.addMessage({ channelId: 'raven', author: 'brendon', text: 'asked just before the restart' })
const ghostEv = store.addEvent('raven', 'message', { messageId: ghostMsg.id, from: 'brendon', text: 'asked just before the restart', source: 'app', files: [] }, 0)
store.claimEvents('raven', 'ghost-run', [ghostEv])
store.startRun('ghost-run', 'raven', 'your message')
check('restart: the cut-off run is closed', store.failStaleRuns('raven') === 1 && store.listRuns('raven', 50).find((x) => x.id === 'ghost-run')?.status === 'failed')
queue({ result: 'answered after the restart' })
before = calls().length
raven.wakeRaven(0)
await until(() => raven.ravenBusy())
await ravenIdle()
reply = lastRavenMsg()
check('restart: its message runs once more, as his (router ran, replyTo kept)', reply?.text === 'answered after the restart' && reply.meta.replyTo === ghostMsg.id
  && calls().slice(before).some((c) => c.kind === 'ask') && lastRaven().prompt.includes('a retry'), { reply, calls: calls().slice(before).map((c) => c.kind) })

// ----------------------------------------------------------------- caps ---

// a run he did not start stops short of the cap: the last runs of the hour stay his
{
  const now0 = store.runsSince('raven', new Date(Date.now() - 3_600_000).toISOString())
  check('reserve: the smoke reaches the cap share from below', now0 < 65, now0)
  for (let i = now0; i < 65; i++) store.startRun(`bg-${i}`, 'raven', 'cap filler')
  runsAt = runsOf()
  const m0 = thread().length
  hooks.wakeRavenWith('session_reply', { pane: 'vk-0123456789', label: 'Server work', turnEnded: true, said: [{ at: Date.now(), from: 'claude', text: 'HELD-LINE shipped v9.9.9.' }] })
  await until(() => /Holding updates/.test(raven.ravenState().statusNote), 3000)
  check('reserve: a session hand-off waits quietly near the cap', runsOf() === runsAt && thread().length === m0 && /Holding updates/.test(raven.ravenState().statusNote),
    { runs: runsOf() - runsAt, note: raven.ravenState().statusNote, msgs: thread().slice(m0).map((m) => m.text) })
  queue({ result: 'Here. Also: Server work shipped v9.9.9.' })
  await j('POST', '/raven/messages', { text: 'are you there' })
  await until(() => runsOf() > runsAt)
  await ravenIdle()
  const lp = lastRaven().prompt ?? ''
  check('reserve: his message still runs, the held lines with it', lastRavenMsg()?.text.startsWith('Here.') && lp.includes('HELD-LINE') && lp.includes('he has not seen'), lp.slice(-900))
}

const have = store.runsSince('raven', new Date(Date.now() - 3_600_000).toISOString())
for (let i = have; i < 80; i++) store.startRun(`cap-${i}`, 'raven', 'cap filler')
runsAt = runsOf()
await j('POST', '/raven/messages', { text: 'over the cap' })
await until(() => thread().some((m) => m.text.startsWith('Resting:')), 3000)
check('hourly cap: one resting line, no run', thread().some((m) => m.text.startsWith('Resting: I hit the hourly cap of 80 runs') && m.text.endsWith('ET.')) && runsOf() === runsAt, thread().slice(-2))

console.log(`ravenSmoke: ${pass} passed, ${fail} failed`)
srv.close()
process.exit(fail ? 1 : 0)
