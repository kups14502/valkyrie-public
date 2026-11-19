/**
 * One REAL Raven run against a scratch data dir: the real claude CLI (pool tokens), the real router call, the real
 * raven-mcp wiring. A message goes in, a reply comes out; it prints the tier, model and effort the router chose and
 * the reply. Before that it tries each tier's model id (configured and fallback) with the smallest possible answer
 * and --effort on each level, and prints which the CLI accepts.
 *
 * Nothing reaches thor, Plex's request services, tmux panes or the phone: the env below points every write path at a
 * closed port or a scratch tmux socket before anything is imported. Run it on odin from ~/valkyrie/backend with the
 * real HOME (the pool tokens live there):
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/ravenProbe.mts ["the message to send"]
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import express from 'express'

const dataDir = process.env.VALKYRIE_DATA_DIR
const live = path.join(homedir(), 'valkyrie', 'backend', 'data')
if (!dataDir || path.resolve(dataDir) === live || dataDir.includes('valkyrie/backend/data')) {
  console.error('ravenProbe: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
fs.mkdirSync(dataDir, { recursive: true })
const conf = path.join(dataDir, 'conf')
fs.mkdirSync(conf, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'areas.json'), JSON.stringify({ clientAreas: ['east'] }))
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify({
  franchises: [{ key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1, supportCc: '', ownDomains: [], agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: '' }, brief: '' }],
  self: [], mailboxRoutes: {}, defaultFranchise: 'east', teamsFranchise: null, skipDomains: [],
}))

const app = express(); app.use(express.json({ limit: '2mb' }))
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
const DEAD = 'http://127.0.0.1:9'
Object.assign(process.env, {
  PORT: String(port),
  RAVEN_MCP_URL: `http://127.0.0.1:${port}/api/raven-mcp`,
  AGENTS_MCP_URL: `http://127.0.0.1:${port}/api/agent-mcp`,
  VALKYRIE_CONF_DIR: conf,
  PROJECT_AREAS_FILE: path.join(dataDir, 'areas.json'),
  LILKUPS_BIN: '/bin/true',
  LILKUPS_STORE: path.join(dataDir, 'reminders.json'),
  // every write path off: thor, the vault note service, the request services, ssh, the real tmux panes, push
  THOR_LAUNCHER_HOST: '127.0.0.1', THOR_LAUNCHER_PORT: '9', THOR_LAUNCHER_TOKEN: '',
  PROJECT_FILES_URL: DEAD, PROJECT_FILES_TOKEN: '',
  RADARR_URL: DEAD, RADARR_API_KEY: '', SONARR_URL: DEAD, SONARR_API_KEY: '', LIDARR_URL: DEAD, LIDARR_API_KEY: '',
  VALKYRIE_SSH_BIN: '/bin/false', THOR_SSH_HOST: '127.0.0.1',
  VALKYRIE_TMUX_SOCKET: `raven-probe-${process.pid}`, TMUX_TMPDIR: tmpdir(),
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
})

const message = process.argv[2] || 'Quick check from the Raven probe: reply in one short line with today\'s date in New York and one thing you can reach.'
const store = await import('../src/lib/agentsStore.ts')
const raven = await import('../src/lib/raven/run.ts')
const models = await import('../src/lib/raven/models.ts')
const { askClaude, runClaude } = await import('../src/lib/claudeCli.ts')
app.use('/api', (await import('../src/routes/raven.ts')).default)
app.use('/api', (await import('../src/routes/ravenMcp.ts')).default)

// ------------------------------------------------------- which ids work ---

const tiers = ['haiku', 'sonnet', 'opus'] as const
const configured = Object.fromEntries(tiers.map((t) => [t, models.modelFor(t)]))
const ids = [...new Set([...Object.values(configured), 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5'])]
console.log('configured tiers:', JSON.stringify(configured))
for (const id of ids) {
  const t0 = Date.now()
  try {
    const a = await askClaude('Reply with exactly: ok', { model: id, timeoutMs: 90_000 })
    console.log(`model ${id}: accepted (${Math.round((Date.now() - t0) / 1000)} s, said "${a.trim().slice(0, 40)}")`)
  } catch (e) {
    const err = models.errorText(e).replace(/\s+/g, ' ').slice(0, 300)
    console.log(`model ${id}: REFUSED${models.isUnknownModelError(err) ? ' (unknown-model error, Raven falls back)' : ''}: ${err}`)
  }
}

const scratch = fs.mkdtempSync(path.join(tmpdir(), 'raven-probe-effort-'))
fs.mkdirSync(path.join(scratch, 'work'))
const cheap = (() => { for (const id of ids) if (/haiku/.test(id)) return id; return ids[0] })()
for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  try {
    await runClaude(['-p', 'Reply with exactly: ok', '--model', cheap, '--effort', effort, '--output-format', 'json', '--no-session-persistence',
      '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite'],
    { cwd: path.join(scratch, 'work'), scratch, timeoutMs: 90_000, retryable: () => false })
    console.log(`--effort ${effort} on ${cheap}: accepted`)
  } catch (e) {
    const err = models.errorText(e).replace(/\s+/g, ' ').slice(0, 300)
    console.log(`--effort ${effort} on ${cheap}: REFUSED${models.isEffortError(err) ? ' (Raven retries lower)' : ''}: ${err}`)
  }
}
fs.rmSync(scratch, { recursive: true, force: true })

// --------------------------------------------------------- one real run ---

raven.startRaven([])
const sent = raven.brendonToRaven({ text: message, source: 'app' })
console.log(`\nsent message ${sent.id}: ${message}`)
const t0 = Date.now()
let lastNote = ''
while (Date.now() - t0 < 12 * 60_000) {
  const st = raven.ravenState()
  if (st.statusNote && st.statusNote !== lastNote) { lastNote = st.statusNote; console.log(`status: ${st.status}, ${st.statusNote}`) }
  if (!raven.ravenBusy() && st.status === 'idle' && !store.openEvents('raven').length && store.listRuns('raven', 1)[0]?.status !== 'running') break
  await new Promise((r) => setTimeout(r, 1000))
}
const run = store.listRuns('raven', 1)[0]
console.log('run:', JSON.stringify({ status: run?.status, cred: run?.cred, turns: run?.turns, cost: run?.costUsd, secs: Math.round((run?.durationMs ?? 0) / 1000), error: run?.error }))
for (const m of store.listMessages('raven', { limit: 20 })) {
  const meta = m.meta.tier ? ` [tier ${m.meta.tier} · model ${m.meta.model} · effort ${m.meta.effort} · why: ${m.meta.why}]` : m.meta.error ? ` [error: ${m.meta.error.slice(0, 200)}]` : ''
  console.log(`\n[${m.author}]${meta}\n${m.text}`)
}
console.log('\nbad model ids this run:', JSON.stringify(models.badModels()))
srv.close()
process.exit(0)
