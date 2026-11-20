/**
 * Raven tools smoke test: every tool group under lib/raven/tools and the relay watcher.
 *
 * The groups are registered on an in-process McpServer with a fake RavenToolCtx and driven by the
 * SDK's own Client over an in-memory transport, so the tool names, schemas, isError results and
 * the fromBrendon gate are what a real run sees. Everything outside the process is fake: the tmux
 * panes, thor's launcher and file service, the transcripts (lib/raven/tools/io.ts), the loopback
 * API the media and calendar tools read (RAVEN_API_BASE), the vault copy (RAVEN_VAULT_DIR), and
 * Raven's poster and waker (setRavenPoster / setRavenWaker). No tmux session, no ssh, no thor, no
 * Claude run, no push.
 *
 * Runs on odin (better-sqlite3), against a scratch data dir:
 *   bash C:/Thor/var/vk-lanes/lane.sh smoke <lane> backend/scripts/ravenToolsSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import express from 'express'
import type { TranscriptEntry, TranscriptPage } from '../src/terminal/transcript.ts'
import type { TermSession } from '../src/terminal/tmux.ts'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('ravenToolsSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const scratch = path.join(dataDir, 'raven-tools')
const conf = path.join(scratch, 'conf')
fs.mkdirSync(conf, { recursive: true })

// ------------------------------------------------------------- config ---

fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify({
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, supportCc: 'help@east.example', ownDomains: ['east.example'], agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'East.' },
    { key: 'north', label: 'North', company: 'North IT', envFile: 'autotask-north.env', web: 'https://ww22.autotask.net', brendonResource: 1002, supportCc: 'help@north.example', ownDomains: ['north.example'], agent: { id: 'north-triage', name: 'North Triage', role: 'Tickets for North', topic: 'North tickets' }, brief: 'North.' },
  ],
  self: [], mailboxRoutes: {}, defaultFranchise: 'east', teamsFranchise: null, skipDomains: [],
}))
fs.writeFileSync(path.join(conf, 'areas.json'), JSON.stringify({ clientAreas: ['east', 'north'] }))
// a claude that fails at once: nothing here may start a real run
fs.writeFileSync(path.join(conf, 'claude'), '#!/bin/sh\necho "no claude in the smoke test" >&2\nexit 3\n', { mode: 0o755 })

// ------------------------------------------------------------- vault copy ---

const vaultReal = path.join(scratch, 'vault-real')
const vaultLink = path.join(scratch, 'vault')
const vw = (rel: string, text: string, mtime?: number) => {
  const f = path.join(vaultReal, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000)
}
const nyDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
const today = nyDate(Date.now())
const yesterday = nyDate(Date.now() - 86_400_000)
const longAgo = nyDate(Date.now() - 20 * 86_400_000)
vw('Vault Home.md', '# Home\n\nThe start page.\n')
vw('10-Work/Sessions/' + `${yesterday}-printer-queue-fix.md`, '---\ntitle: Printer queue fix\n---\nCleared the spooler on the front desk PC.\n')
vw('10-Work/Runbooks/Spooler.md', 'Restart the spooler service.\nThen print a test page.\n')
vw('30-Personal/Sessions/' + `${today}-tesla-charging.md`, '---\ntitle: "Tesla charging schedule"\n---\nSet the charge limit to 80 percent.\n')
vw('30-Personal/Sessions/' + `${longAgo}-old-thing.md`, 'an old session about the spooler\n')
vw('40-Daily/' + `${yesterday}.md`, '# daily\n\n## Sessions\n- printer\n')
fs.mkdirSync(path.join(scratch, 'outside'), { recursive: true })
fs.writeFileSync(path.join(scratch, 'outside', 'secret.md'), 'TOP SECRET outside the vault\n')
fs.symlinkSync(path.join(scratch, 'outside', 'secret.md'), path.join(vaultReal, '30-Personal', 'escape.md'))
fs.symlinkSync(vaultReal, vaultLink)

// --------------------------------------------- fake API and thor services ---

type SearchResult = { kind: string; title: string; artist: string | null; year: number | null; overview: string; poster: string | null; tmdbId: number | null; tvdbId: number | null; foreignAlbumId: string | null; inLibrary: boolean; downloaded: boolean }
const searchResults: SearchResult[] = [
  { kind: 'movie', title: 'Heat', artist: null, year: 1995, overview: 'A heist movie', poster: null, tmdbId: 949, tvdbId: null, foreignAlbumId: null, inLibrary: true, downloaded: true },
  { kind: 'movie', title: 'Heat 2', artist: null, year: 2027, overview: 'The sequel', poster: null, tmdbId: 5000, tvdbId: null, foreignAlbumId: null, inLibrary: false, downloaded: false },
  { kind: 'show', title: 'Heat Wave', artist: null, year: 2020, overview: 'A show', poster: null, tmdbId: null, tvdbId: 77, foreignAlbumId: null, inLibrary: false, downloaded: false },
]
const adds: Record<string, unknown>[] = []
const notes: { auth: string | undefined; body: Record<string, unknown> }[] = []
let addAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, detail: 'Heat 2 sent to radarr \u2014 it will appear in Plex once downloaded' } }
const hourMs = 3_600_000
const nowMs = Date.now()
const calEvents = [
  { summary: 'Over already', start: new Date(nowMs - 3 * hourMs).toISOString(), end: new Date(nowMs - 2 * hourMs).toISOString(), allDay: false, location: '', url: '', sourceLabel: 'Home' },
  { summary: 'Standup', start: new Date(nowMs + hourMs).toISOString(), end: new Date(nowMs + 1.5 * hourMs).toISOString(), allDay: false, location: 'Teams', url: 'https://teams.example/join', sourceLabel: 'Work' },
  { summary: 'Trash day', start: new Date(nowMs + 2 * hourMs).toISOString(), end: new Date(nowMs + 26 * hourMs).toISOString(), allDay: true, location: '', url: '', sourceLabel: 'Home' },
]
const api = express(); api.use(express.json())
api.get('/api/plex/request/search', (q, r) => r.json({ results: searchResults.filter((x) => x.title.toLowerCase().includes(String(q.query.q).toLowerCase())) }))
api.post('/api/plex/request/add', (q, r) => { adds.push(q.body); r.status(addAnswer.status).json(addAnswer.body) })
api.get('/api/plex/requests', (_q, r) => r.json({ requests: [
  { at: new Date(nowMs - hourMs).toISOString(), kind: 'movie', title: 'Heat 2', status: 'downloading 40%', tone: 'active' },
  { at: new Date(nowMs - 2 * hourMs).toISOString(), kind: 'show', title: 'Stuck Show', status: 'import stuck', tone: 'stuck' },
] }))
let calendarQuery: Record<string, unknown> = {}
api.get('/api/calendar/events', (q, r) => { calendarQuery = q.query; r.json({ events: calEvents }) })
api.post('/vault/note', (q, r) => { notes.push({ auth: q.header('authorization'), body: q.body }); r.json({ path: `C:\\Vault\\00-Inbox\\${q.body.title}.md` }) })
// thor's live read routes (project-files reader.mjs): off until the live block turns them on, so the vault tests above
// first see an older service (a bare 404) and read odin's copy
let thorLive = false
const thorReads: { route: string; auth: string | undefined; q: Record<string, unknown> }[] = []
const liveOnly = (route: string, fn: (q: express.Request, r: express.Response) => void) => api.get(route, (q, r, next) => {
  if (!thorLive) return next()
  thorReads.push({ route, auth: q.header('authorization'), q: q.query as Record<string, unknown> })
  fn(q, r)
})
liveOnly('/vault/search', (_q, r) => r.json({ hits: [{ file: '00-Inbox/Today.md', line: 3, text: 'written this morning' }] }))
liveOnly('/vault/read', (q, r) => (q.query.path === 'missing'
  ? r.status(404).json({ error: 'no note at missing' })
  : r.json({ path: '00-Inbox/Today.md', size: 70_000, mtime: nowMs, text: 'live text', next: 61_440 })))
liveOnly('/vault/recent', (_q, r) => r.json({ notes: [{ path: '00-Inbox/Today.md', mtime: nowMs, title: 'Today' }] }))
liveOnly('/vault/list', (_q, r) => r.json({ rel: '', entries: [{ name: '10-Work', dir: true, size: 0, mtime: nowMs }, { name: 'Vault Home.md', dir: false, size: 30, mtime: nowMs }] }))
liveOnly('/files/list', (q, r) => (q.query.path
  ? r.json({ path: 'C:\\Users\\Brendon\\Documents', entries: [{ name: 'Resume', dir: true, size: 0, mtime: nowMs }, { name: 'notes.txt', dir: false, size: 2048, mtime: nowMs }] })
  : r.json({ roots: [{ label: 'Documents', path: 'C:\\Users\\Brendon\\Documents' }], vault: 'C:\\Vault' })))
liveOnly('/files/read', (q, r) => {
  const p = String(q.query.path)
  if (p.includes('secrets')) return r.status(403).json({ error: 'not served: a place secrets live' })
  if (p.endsWith('.pdf')) return r.json({ path: p, size: 2_000_000, mtime: nowMs, binary: true, type: 'pdf' })
  r.json({ path: p, size: 10, mtime: nowMs, offset: 0, next: null, text: 'file text' })
})
liveOnly('/files/search', (q, r) => r.json({
  files: [{ path: 'C:\\Users\\Brendon\\Documents\\Resume\\resume.docx', size: 30_000, mtime: nowMs }],
  lines: q.query.content === '1' ? [{ file: 'C:\\x.txt', line: 2, text: 'hit' }] : undefined,
  partial: true,
}))
const apiSrv = api.listen(0, '127.0.0.1')
await new Promise((r) => apiSrv.once('listening', r))
const apiPort = (apiSrv.address() as { port: number }).port

Object.assign(process.env, {
  VALKYRIE_CONF_DIR: conf,
  PROJECT_AREAS_FILE: path.join(conf, 'areas.json'),
  CLAUDE_CLI_PATH: path.join(conf, 'claude'),
  LILKUPS_BIN: process.env.LILKUPS_BIN || '/bin/true',
  LILKUPS_STORE: path.join(scratch, 'reminders.json'),
  // any agent wake lands far past the end of the test (the timers are unref'd)
  AGENTS_DELAY_SCALE: '100000',
  RAVEN_API_BASE: `http://127.0.0.1:${apiPort}/api`,
  RAVEN_VAULT_DIR: vaultLink,
  PROJECT_FILES_URL: `http://127.0.0.1:${apiPort}`,
  PROJECT_FILES_TOKEN: 'files-token',
  // never thor: a launcher call that slipped past the fakes would fail here, not reach the desk
  THOR_LAUNCHER_HOST: '127.0.0.1',
  THOR_LAUNCHER_PORT: '9',
  THOR_LAUNCHER_TOKEN: '',
  // and never the live tmux server: no socket here, and a tmux that does nothing
  VALKYRIE_TMUX_SOCKET: 'raven-smoke-none',
  TMUX_TMPDIR: scratch,
  VALKYRIE_TMUX_BIN: '/bin/false',
  VALKYRIE_SSH_BIN: '/bin/false',
})
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

// imported only now: the stores open their databases and read the env at import time
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const store = await import('../src/lib/agentsStore.ts')
const agents = await import('../src/lib/agents.ts')
const projects = await import('../src/lib/projectsStore.ts')
const tasks = await import('../src/lib/tasksStore.ts')
const inbox = await import('../src/lib/inboxStore.ts')
const hooks = await import('../src/lib/raven/hooks.ts')
const tools = await import('../src/lib/raven/tools/index.ts')
const ioMod = await import('../src/lib/raven/tools/io.ts')
const watch = await import('../src/lib/raven/tools/watch.ts')
const sessionsMod = await import('../src/lib/raven/tools/sessions.ts')
const vaultMod = await import('../src/lib/raven/tools/vault.ts')
const screens = JSON.parse(fs.readFileSync(new URL('./fixtures/pane-screens.json', import.meta.url), 'utf8')).screens as { name: string; screen: string }[]
const screen = (name: string) => screens.find((s) => s.name === name)!.screen

let pass = 0, fail = 0
// RAVEN_SMOKE_SHOW=1 prints what the model would read, for a look at the wording
const show = (label: string, v: unknown) => { if (process.env.RAVEN_SMOKE_SHOW) console.log(`--- ${label}
${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`) }
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 700)) }
}

// ------------------------------------------------------------ the hooks ---

type Post = { text: string; opts?: { refs?: { type: string; url?: string; label?: string }[]; meta?: { relay?: { kind: string; from: string; label: string; sessionId?: string } }; push?: boolean } }
const posts: Post[] = []
const wakes: { kind: string; payload: Record<string, unknown> }[] = []
hooks.setRavenPoster((text, opts) => { posts.push({ text, opts: opts as Post['opts'] }) })
hooks.setRavenWaker((kind, payload) => { wakes.push({ kind, payload }) })

// ---------------------------------------------------------- the client ---

let acted = 0
type Ctx = { fromBrendon: boolean }
const clients = new Map<boolean, InstanceType<typeof Client>>()
async function client(c: Ctx) {
  const have = clients.get(c.fromBrendon)
  if (have) return have
  const server = new McpServer({ name: 'raven-smoke', version: '0.0.0' })
  tools.registerRavenTools(server, {
    runId: 'smoke-run', fromBrendon: c.fromBrendon, acted: () => { acted += 1 },
    post: (text, opts) => { posts.push({ text, opts: opts as Post['opts'] }) },
    wakeRaven: (kind, payload) => { wakes.push({ kind, payload }) },
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const cl = new Client({ name: 'raven-smoke', version: '0.0.0' })
  await server.connect(a)
  await cl.connect(b)
  clients.set(c.fromBrendon, cl)
  return cl
}
type Res = { isError: boolean; text: string; json: any }
async function call(tool: string, args: Record<string, unknown> = {}, fromBrendon = true): Promise<Res> {
  const r = await (await client({ fromBrendon })).callTool({ name: tool, arguments: args }) as { isError?: boolean; content: { type: string; text?: string }[] }
  const text = r.content?.[0]?.text ?? ''
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* plain text */ }
  return { isError: Boolean(r.isError), text, json }
}

// ------------------------------------------------------- fake panes and thor ---

let clock = Date.now()
const panes: TermSession[] = []
const screensBy = new Map<string, string[]>()
const states = new Map<string, 'live' | 'dead' | 'gone'>()
const typed: { pane: string; text: string }[] = []
const created: Record<string, unknown>[] = []
const killed: string[] = []
const uploads: { name: string; size: number }[] = []
let uploadFails = false
let modeLeft = 0
const transcripts = new Map<string, { sessionId: string; entries: TranscriptEntry[] }>()
const boardReads: string[] = []
const IDLE = screen('v283-idle')
const TYPED = screen('v283-typed')
const DIALOG = screen('v283-dialog')
const BUSY = `${IDLE}\n✻ Thinking… (12s · esc to interrupt)\n`

const page = (key: string, after: string): TranscriptPage | null => {
  const t = transcripts.get(key)
  if (!t) return { sessionId: null, file: null, cursor: '', entries: [], more: false, reset: false }
  const from = after === '' ? 0 : Number(after)
  return { sessionId: t.sessionId, file: `${t.sessionId}.jsonl`, cursor: String(t.entries.length), entries: t.entries.slice(from), more: false, reset: false }
}
let n = 0
const entry = (kind: TranscriptEntry['kind'], text?: string): TranscriptEntry => ({ id: `e${++n}`, at: clock, kind, text })
const say = (key: string, sessionId: string, ...es: TranscriptEntry[]) => {
  const t = transcripts.get(key) ?? { sessionId, entries: [] }
  t.entries.push(...es)
  transcripts.set(key, t)
}
const pane = (name: string, label: string, target: string, sessionId: string): TermSession => {
  const p: TermSession = { name, label, mode: 'new', host: 'thor', target, sessionId, createdAt: clock, activityAt: clock, clients: 0, dead: false, deadStatus: null, deadText: '', size: '120x40', projectId: '', outputAt: clock, title: '' }
  panes.push(p)
  states.set(name, 'live')
  return p
}
let paneSeq = 0
const BOARD_ID = '11111111-2222-4333-8444-555555555555'
const board = [
  { sessionId: BOARD_ID, title: 'Router firmware upgrade', area: 'server', live: true, activity: 'idle', lastActivityUtc: new Date().toISOString() },
  { sessionId: '99999999-2222-4333-8444-555555555555', title: 'Closed one', area: 'personal', live: false, activity: 'closed' },
]
let boardUp = true
let targetsUp = true
async function fakeCapture(p: string): Promise<string | null> {
  const list = screensBy.get(p) ?? [IDLE]
  return list.length > 1 ? list.shift()! : list[0]
}
const fakeIo = {
  listPanes: async () => panes.filter((p) => states.get(p.name) !== 'gone').map((p) => ({ ...p, activityAt: clock, dead: states.get(p.name) === 'dead' })),
  createPane: async (o: Record<string, unknown>) => {
    created.push(o)
    const name = `vk-${String(++paneSeq).padStart(10, '0')}`
    pane(name, String(o.label), String(o.target), String(o.newId))
    screensBy.set(name, ['', '', IDLE])
    return name
  },
  capture: async (p: string) => fakeCapture(p),
  // the fake screens carry no colors: the read without dim text is the same read
  capturePrompt: async (p: string) => fakeCapture(p),
  typeLine: async (p: string, text: string) => { typed.push({ pane: p, text }) },
  killPane: async (p: string) => { killed.push(p); states.set(p, 'gone'); return true },
  paneInMode: async () => false,
  leaveMode: async () => { modeLeft += 1 },
  paneState: async (p: string) => states.get(p) ?? 'gone',
  paneTranscript: async (p: string, after: string) => (states.get(p) === 'gone' ? null : page(p, after)),
  boardTranscript: async (sid: string, after: string) => { boardReads.push(sid); return page(`sid:${sid}`, after) },
  launchTargets: async () => (targetsUp ? [
    { key: 'personal', label: 'Personal', exists: true, phone: true, project: false },
    { key: 'work', label: 'Work', exists: true, phone: true, project: false },
    { key: 'garage', label: 'Garage', exists: true, phone: true, project: true },
    { key: 'scratch', label: 'Scratch', exists: true, phone: false, project: false },
  ] : null),
  boardSessions: async () => (boardUp ? board : null),
  uploadToThor: async (name: string, data: Buffer) => {
    if (uploadFails) throw new Error('only pictures and videos can be sent to thor')
    uploads.push({ name, size: data.length })
    return { path: `C:\\Thor\\uploads\\20261119-${name}` }
  },
  ravenFile: (id: string) => (id === 'f1' ? { file: { id: 'f1', name: 'photo.jpg', mime: 'image/jpeg', size: 4, createdAt: new Date().toISOString() }, path: '/fake/f1.jpg' } : null),
  readFile: async () => Buffer.from('jpeg'),
  sleep: async (ms: number) => { clock += ms },
  now: () => clock,
}
ioMod.setRavenToolsIo(fakeIo)

// ------------------------------------------------------------ tool list ---

{
  const listed = (await (await client({ fromBrendon: true })).listTools()).tools.map((t) => t.name)
  const want = ['agents', 'agent_channel', 'agent_ask', 'agents_pause', 'agent_check', 'proposals', 'main_terminals', 'sessions', 'session_start',
    'session_send', 'session_read', 'session_watch', 'session_stop', 'media_search', 'media_requests', 'media_request', 'vault_search', 'vault_read',
    'vault_recent', 'vault_list', 'vault_note', 'thor_files', 'thor_file_read', 'thor_files_search', 'tasks', 'task_add', 'task_done', 'projects',
    'project_get', 'tickets', 'inbox', 'calendar', 'brief']
  check('every tool is registered', want.every((n) => listed.includes(n)), want.filter((n) => !listed.includes(n)))
  check('the core tools are left to the endpoint', !['post', 'notebook_set', 'now', 'attachment', 'attachments'].some((n) => listed.includes(n)), listed)
  check('no extra tools', listed.length === want.length, listed)
}

// ---------------------------------------------------- the fromBrendon gate ---

{
  const gated: [string, Record<string, unknown>][] = [
    ['agents_pause', { paused: true }], ['agent_check', { agent: 'east-triage' }],
    ['session_start', { target: 'work', prompt: 'hi' }], ['session_send', { session: 'personal', text: 'hi' }],
    ['session_watch', { session: 'personal', on: true }], ['session_stop', { session: 'personal' }],
    ['media_request', { kind: 'movie', title: 'Heat 2', tmdbId: 5000 }], ['vault_note', { title: 'x', text: 'y' }],
    ['task_add', { text: 'buy milk' }], ['task_done', { id: 'loose/abc' }],
    ['thor_files', {}], ['thor_file_read', { path: 'C:\\Users\\Brendon\\Documents\\x.txt' }], ['thor_files_search', { query: 'resume' }],
  ]
  const before = acted
  for (const [tool, args] of gated) {
    const r = await call(tool, args, false)
    check(`gate: ${tool} refused without Brendon`, r.isError && /Brendon's own message/.test(r.text), r)
  }
  check('gate: nothing acted', acted === before, acted - before)
  check('gate: no media add, no vault note', adds.length === 0 && notes.length === 0)
  check('gate: no pane opened, nothing typed or stopped, no watch, no task', created.length === 0 && typed.length === 0 && killed.length === 0
    && watch.listWatches().length === 0 && tasks.listTasks({ view: 'open', hideTailnet: false }).length === 0 && !agents.isPaused(),
  { created, typed, killed, watches: watch.listWatches().length })
  const off = await call('session_watch', { session: 'nothing-watched', on: false }, false)
  check('gate: watch off is allowed without Brendon', !off.isError, off)
}

// ------------------------------------------------------------- agents ---

agents.syncRoster()
{
  let r = await call('agents')
  const ids = (r.json?.agents ?? []).map((a: { id: string }) => a.id)
  check('agents: the roster', ids.includes('east-triage') && ids.includes('north-triage') && ids.includes('groceries') && r.json.paused === false, r.json)
  store.addMessage({ channelId: 'east-triage', author: 'east-triage', text: 'Two tickets need you today.' })
  r = await call('agent_channel', { agent: 'East Triage' })
  check('agent_channel: by name', r.json?.agent === 'east-triage' && r.json.messages.some((m: { text: string; at: string }) => m.text.includes('Two tickets') && / ET$/.test(m.at)), r.json)
  r = await call('agent_channel', { agent: 'triage' })
  check('agent_channel: an ambiguous name is refused', r.isError && /matches/.test(r.text), r)
  const before = acted
  r = await call('agent_ask', { agent: '@east-triage', text: 'What is open for the front desk?' }, false)
  const ev = store.openEvents('east-triage').find((e) => e.kind === 'message')
  check('agent_ask: allowed in any run', !r.isError && acted === before + 1, r)
  check('agent_ask: a message event from raven in #raven', ev?.payload.channelId === 'raven' && ev.payload.from === 'raven' && String(ev.payload.text).includes('front desk') && ev.hop === 1, ev)
  check('agent_ask: the agent is woken', store.getAgent('east-triage')?.status === 'queued', store.getAgent('east-triage'))
  // a run its answer woke cannot ask the same agent straight back: no Raven and agent loop
  r = await call('agent_ask', { agent: 'east-triage', text: 'And then?' }, false)
  check('agent_ask: no loop without Brendon', r.isError && /asked East Triage/.test(r.text) && store.openEvents('east-triage').filter((e) => e.kind === 'message').length === 1, r)
  r = await call('agent_ask', { agent: 'east-triage', text: 'Brendon wants the front desk list too.' })
  check('agent_ask: Brendon can always ask again', !r.isError && store.openEvents('east-triage').filter((e) => e.kind === 'message').length === 2, r)
  r = await call('agents_pause', { paused: true })
  check('agents_pause: pauses', !r.isError && agents.isPaused(), r)
  r = await call('agent_ask', { agent: 'north-triage', text: 'anything new?' })
  check('agent_ask: paused says so', /paused/.test(r.json?.note ?? ''), r)
  r = await call('agents_pause', { paused: false })
  check('agents_pause: resumes', !agents.isPaused(), r)
  r = await call('agent_check', { agent: 'north-triage' })
  check('agent_check: a check event', !r.isError && store.openEvents('north-triage').some((e) => e.kind === 'check'), r)
  const p = store.addProposal({ agentId: 'east-triage', channelId: 'east-triage', kind: 'mail_reply', title: 'Reply to the front desk', payload: {} })
  r = await call('proposals')
  check('proposals: pending listed with the agent name', Array.isArray(r.json) && r.json.some((x: { id: number; agent: string }) => x.id === p.id && x.agent === 'East Triage'), r.json)
  r = await call('agents')
  show('agents', r.json)
  check('agents: pending count', r.json.agents.find((a: { id: string }) => a.id === 'east-triage')?.pendingProposals === 1, r.json)
}

// --------------------------------------------------------------- work ---

{
  const ctx = { actor: 'smoke', via: 'ui' as const }
  const proj = projects.createProject({ name: 'Garage Shelves', area: 'personal', targetKey: 'garage', summary: 'Build shelves' }, ctx)
  let r = await call('task_add', { text: 'Buy brackets', due: today, projectId: proj.id })
  check('task_add: on a project', !r.isError && r.json.project === 'Garage Shelves' && /^project\//.test(r.json.id), r)
  const projTask = r.json.id as string
  r = await call('task_add', { text: 'Renew the registration', due: yesterday, area: 'personal' })
  check('task_add: loose, overdue', !r.isError && /^loose\//.test(r.json.id), r)
  const looseTask = r.json.id as string
  r = await call('task_add', { text: 'Call the dentist' })
  check('task_add: no due', !r.isError && r.json.area === 'personal', r)
  r = await call('tasks')
  show('tasks', r.json)
  check('tasks: open has all three', r.json?.count === 3, r.json)
  r = await call('tasks', { view: 'today' })
  check('tasks: today', r.json?.count === 1 && r.json.tasks[0].text === 'Buy brackets', r.json)
  r = await call('tasks', { view: 'overdue' })
  check('tasks: overdue', r.json?.count === 1 && r.json.tasks[0].text === 'Renew the registration', r.json)
  r = await call('tasks', { projectId: proj.id })
  check('tasks: by project', r.json?.count === 1, r.json)
  r = await call('task_done', { id: looseTask })
  check('task_done: loose', !r.isError && r.json.done, r)
  r = await call('task_done', { id: projTask })
  check('task_done: project item', !r.isError && r.json.done, r)
  r = await call('task_done', { id: 'nonsense' })
  check('task_done: a bad id is refused', r.isError, r)
  r = await call('tasks', { view: 'done' })
  check('tasks: done', r.json?.count === 2, r.json)
  r = await call('projects')
  check('projects: listed', Array.isArray(r.json) && r.json.some((p: { id: string; name: string }) => p.id === proj.id), r.json)
  await call('task_add', { text: 'Cut the boards', projectId: proj.id })
  r = await call('project_get', { id: proj.id })
  check('project_get: open tasks', r.json?.name === 'Garage Shelves' && r.json.openTasks.length === 1 && r.json.openTasks[0].text === 'Cut the boards', r.json)
  r = await call('project_get', { id: 'no-such' })
  check('project_get: missing is an error', r.isError, r)

  const t = (id: number, n: string, mine: boolean) => ({
    franchise: 'east', id, number: n, title: `Ticket ${id}`, description: '', status: 'New', statusValue: 1, priority: 'Medium', queue: 'Help Desk', queueId: 1,
    companyId: 7, company: 'Front Desk Co', contactId: null, assignee: mine ? 'Brendon' : null, assigneeId: null, mine,
    created: new Date().toISOString(), lastActivity: new Date().toISOString(), due: null, completed: null, url: 'https://example.invalid',
  })
  store.upsertTracked(t(1, 'T1', true), false)
  store.upsertTracked(t(2, 'T2', false), false)
  store.upsertTracked(t(3, 'T3', false), false)
  store.trackNote('east', 2, { needsBrendon: true, summary: 'waiting on him' })
  r = await call('tickets')
  show('tickets', r.json)
  const east = Array.isArray(r.json) ? r.json.find((x: { area: string }) => x.area === 'east') : null
  check('tickets: counts per area', east?.open === 3 && east.assignedToBrendon === 1 && east.needsBrendon === 1, r.json)
  check('tickets: only his and the ones needing him, needing him first', east?.tickets.length === 2 && east.tickets[0].number === 'T2', east)
  check('tickets: every work area', Array.isArray(r.json) && r.json.length === 2, r.json)
  r = await call('tickets', { area: 'north' })
  check('tickets: one area', r.json?.length === 1 && r.json[0].open === 0, r.json)

  await inbox.postInbox({ source: 'backups', level: 'alert', title: 'Backup failed', body: 'The 3 AM backup did not run', push: false })
  await inbox.postInbox({ source: 'updates', level: 'info', title: 'Updates done', push: false })
  r = await call('inbox')
  check('inbox: needs-you is warn and alert only', r.json?.count === 1 && r.json.items[0].title === 'Backup failed', r.json)
  r = await call('inbox', { needsYou: false })
  check('inbox: everything unread', r.json?.count === 2, r.json)

  r = await call('calendar', { days: 2 })
  show('calendar', r.json)
  check('calendar: ended events dropped', Array.isArray(r.json) && r.json.length === 2 && !r.json.some((e: { title: string }) => e.title === 'Over already'), r.json)
  const standup = Array.isArray(r.json) ? r.json.find((e: { title: string }) => e.title === 'Standup') : null
  check('calendar: ET times, place and link', / ET$/.test(standup?.when ?? '') && standup.where === 'Teams' && standup.link === 'https://teams.example/join', standup)
  check('calendar: all day', Array.isArray(r.json) && /all day$/.test(r.json.find((e: { title: string }) => e.title === 'Trash day')?.when ?? ''), r.json)
  check('calendar: two days from New York midnight', Number(calendarQuery.to) - Number(calendarQuery.from) === 2 * 86_400_000, calendarQuery)
  r = await call('brief')
  check('brief: none yet', /No brief yet/.test(r.text), r)
}

// -------------------------------------------------------------- media ---

{
  let r = await call('media_search', { query: 'heat' })
  check('media_search: on Plex flagged', Array.isArray(r.json) && r.json.find((x: { title: string }) => x.title === 'Heat')?.onPlex === true, r.json)
  r = await call('media_search', { query: 'heat', kind: 'show' })
  check('media_search: kind filter', Array.isArray(r.json) && r.json.length === 1 && r.json[0].tvdbId === 77, r.json)
  const before = acted
  r = await call('media_request', { kind: 'movie', title: 'Heat', tmdbId: 949 })
  check('media_request: already on Plex is not requested', /already on Plex/.test(r.text) && adds.length === 0 && acted === before, r)
  r = await call('media_request', { kind: 'movie', title: 'Heat 2', tmdbId: 5000 })
  check('media_request: requested', !r.isError && adds.length === 1 && (adds[0] as { tmdbId: number }).tmdbId === 5000 && acted === before + 1, { r, adds })
  check('media_request: no dash in the wording', !/\u2014/.test(r.text), r.text)
  addAnswer = { status: 409, body: { error: 'already added', detail: 'it is already being tracked \u2014 check downloads' } }
  r = await call('media_request', { kind: 'show', title: 'Heat Wave', tvdbId: 77 })
  check('media_request: requested before', /requested before/.test(r.text) && !/\u2014/.test(r.text), r)
  r = await call('media_request', { kind: 'album', title: 'Some album' })
  check('media_request: needs its id', r.isError && /foreignAlbumId/.test(r.text), r)
  r = await call('media_requests')
  check('media_requests: live status', Array.isArray(r.json) && r.json[0].status === 'downloading 40%' && r.json[1].stuck === true && / ET$/.test(r.json[0].asked), r.json)
}

// -------------------------------------------------------------- vault ---

{
  check('vault: plain words are not a regex', !vaultMod.looksLikeRegex('front desk PC') && vaultMod.looksLikeRegex('spool(er)?\\b') && vaultMod.looksLikeRegex('charge.*limit'))
  let r = await call('vault_search', { query: 'SPOOLER' })
  check('vault_search: case-insensitive, file and line', Array.isArray(r.json?.hits) && r.json.hits.some((h: { file: string; line: number }) => h.file === '10-Work/Runbooks/Spooler.md' && h.line === 1), r.json)
  r = await call('vault_search', { query: 'spooler', area: 'work' })
  check('vault_search: area by its short name', r.json?.hits?.length >= 1 && r.json.hits.every((h: { file: string }) => h.file.startsWith('10-Work/')), r.json)
  r = await call('vault_search', { query: 'charge.*limit' })
  check('vault_search: a regex', r.json?.hits?.some((h: { file: string }) => h.file.includes('tesla-charging')), r.json)
  r = await call('vault_search', { query: 'spooler', area: 'nowhere' })
  check('vault_search: unknown area lists the real ones', r.isError && /10-Work/.test(r.text), r)
  r = await call('vault_search', { query: 'zebra crossing' })
  check('vault_search: nothing found is plain text', !r.isError && /No note/.test(r.text), r)
  r = await call('vault_search', { query: 'TOP SECRET' })
  check('vault_search: never follows a link out', !r.isError && /No note/.test(r.text), r)
  r = await call('vault_read', { path: '10-Work/Runbooks/Spooler.md' })
  check('vault_read: by path', !r.isError && r.text.includes('Restart the spooler'), r)
  r = await call('vault_read', { path: '[[Spooler]]' })
  check('vault_read: a wiki link', !r.isError && r.text.startsWith('10-Work/Runbooks/Spooler.md'), r)
  r = await call('vault_read', { path: 'Vault Home' })
  check('vault_read: a bare name', !r.isError && r.text.includes('The start page'), r)
  r = await call('vault_read', { path: '../outside/secret.md' })
  check('vault_read: ../ refused', r.isError && /outside the vault/.test(r.text) && !r.text.includes('TOP SECRET'), r)
  r = await call('vault_read', { path: '30-Personal/escape.md' })
  check('vault_read: a symlink out refused', r.isError && /outside the vault/.test(r.text), r)
  r = await call('vault_read', { path: path.join(scratch, 'outside', 'secret.md') })
  check('vault_read: an absolute path outside refused', r.isError && /outside the vault/.test(r.text), r)
  r = await call('vault_read', { path: `${vaultLink}/Vault Home.md` })
  check('vault_read: an absolute path inside works', !r.isError && r.text.includes('The start page'), r)
  r = await call('vault_read', { path: '10-Work' })
  check('vault_read: a folder is refused', r.isError, r)
  r = await call('vault_recent', { days: 3 })
  show('vault_recent', r.json)
  const recent = r.json?.notes ?? []
  check('vault_recent: sessions and daily notes, newest first', recent.length === 3 && recent[0].title === 'Tesla charging schedule' && recent.some((n: { kind: string }) => n.kind === 'daily'), r.json)
  check('vault_recent: old notes left out', !recent.some((n: { path: string }) => n.path.includes('old-thing')), recent)
  check('vault_recent: frontmatter titles', recent.some((n: { title: string }) => n.title === 'Printer queue fix'), recent)
  r = await call('vault_note', { title: 'Shelf plan', text: '- 4 brackets', area: 'personal' })
  check('vault_note: written on thor with the token', !r.isError && notes.length === 1 && notes[0].auth === 'Bearer files-token' && notes[0].body.title === 'Shelf plan' && /Shelf plan/.test(r.json?.written ?? ''), { r, notes })
  for (const area of ['../../Windows', '10-Work/../..', 'C:\\Users', '.obsidian']) {
    r = await call('vault_note', { title: 'x', text: 'y', area })
    check(`vault_note: area ${JSON.stringify(area)} is not a folder name, refused`, r.isError && /folder name/.test(r.text) && notes.length === 1, r)
  }
  process.env.PROJECT_FILES_URL = 'http://127.0.0.1:9'
  r = await call('vault_note', { title: 'x', text: 'y' })
  check('vault_note: thor down says so, nothing queued', r.isError && /not answering/.test(r.text) && /Nothing is queued/.test(r.text), r)
  process.env.PROJECT_FILES_URL = `http://127.0.0.1:${apiPort}`
}

// ------------------------------------------------ the live vault and files on thor ---

{
  // an older service on thor (no read routes): the files tools say so; the vault above read the copy
  let r = await call('thor_files')
  check('thor_files: no route on thor says so', r.isError && /does not have this route/.test(r.text), r)
  thorLive = true
  r = await call('vault_search', { query: 'morning' })
  check('vault_search: live from thor, no copy note', !r.isError && r.json?.hits?.[0]?.file === '00-Inbox/Today.md' && !r.json.source, r)
  check('vault_search: the token and text mode', thorReads.at(-1)?.auth === 'Bearer files-token' && thorReads.at(-1)?.q.mode === 'text', thorReads.at(-1))
  r = await call('vault_search', { query: 'charge.*limit' })
  check('vault_search: a regex goes to thor as one', thorReads.at(-1)?.q.mode === 'regex', thorReads.at(-1))
  r = await call('vault_read', { path: 'Today' })
  check('vault_read: live, with the next offset', !r.isError && r.text.startsWith('00-Inbox/Today.md\n\nlive text') && /offset 61440/.test(r.text), r)
  r = await call('vault_read', { path: 'missing' })
  check('vault_read: thor\'s refusal is the answer, no fallback', r.isError && /no note at missing/.test(r.text), r)
  r = await call('vault_recent', {})
  check('vault_recent: live, times in ET', !r.isError && r.json?.notes?.[0]?.title === 'Today' && / ET$/.test(r.json.notes[0].changed), r)
  r = await call('vault_list', {})
  check('vault_list: live top folders', !r.isError && r.json?.entries?.[0] === '10-Work/', r)
  r = await call('thor_files')
  check('thor_files: no path lists the roots', !r.isError && r.json?.roots?.[0]?.label === 'Documents', r)
  r = await call('thor_files', { path: 'Documents' })
  check('thor_files: a folder with sizes', !r.isError && r.json?.entries?.[0]?.name === 'Resume\\' && r.json.entries[1].size === '2 KB', r)
  r = await call('thor_file_read', { path: 'C:\\Users\\Brendon\\Documents\\notes.txt' })
  check('thor_file_read: text', !r.isError && r.text.includes('file text'), r)
  r = await call('thor_file_read', { path: 'C:\\Thor\\secrets\\x.txt' })
  check('thor_file_read: thor refuses secrets', r.isError && /secrets live/.test(r.text), r)
  r = await call('thor_file_read', { path: 'C:\\Users\\Brendon\\Documents\\scan.pdf' })
  check('thor_file_read: a PDF says what it is', !r.isError && /\.pdf file/.test(r.text), r)
  r = await call('thor_files_search', { query: 'resume', content: true })
  check('thor_files_search: files, lines, partial', !r.isError && r.json?.files?.length === 1 && r.json.lines?.length === 1 && /stopped early/.test(r.json.partial), r)
  check('thor_files_search: content goes to thor', thorReads.at(-1)?.q.content === '1', thorReads.at(-1))
  // thor off: the vault reads the copy and says so; the files tools fail plainly
  process.env.PROJECT_FILES_URL = 'http://127.0.0.1:9'
  r = await call('vault_search', { query: 'SPOOLER' })
  check('vault_search: thor off reads the copy and says so', !r.isError && r.json?.hits?.length >= 1 && /nightly copy/.test(r.json.source) && /not answering/.test(r.json.source), r)
  r = await call('vault_read', { path: '[[Spooler]]' })
  check('vault_read: thor off reads the copy', !r.isError && r.text.startsWith('10-Work/Runbooks/Spooler.md') && /nightly copy/.test(r.text), r)
  r = await call('thor_file_read', { path: 'C:\\x.txt' })
  check('thor_file_read: thor off says so', r.isError && /not answering/.test(r.text), r)
  process.env.PROJECT_FILES_URL = `http://127.0.0.1:${apiPort}`
  thorLive = false
}

// ------------------------------------------------------------- sessions ---

{
  check('oneLine joins a multi-line prompt', sessionsMod.oneLine('Fix the build.\n\n  Then run the tests.\r\n\tReport back.') === 'Fix the build. Then run the tests. Report back.')
  let r = await call('main_terminals')
  check('main_terminals: phone, not project, from thor', Array.isArray(r.json) && r.json.map((m: { target: string }) => m.target).join() === 'personal,work' && r.json.every((m: { state: string }) => m.state === 'closed'), r.json)

  // a main target with no pane: one is started, the prompt waited for, the line typed
  const before = acted
  r = await call('session_send', { session: 'personal', text: 'Check the backups.\nThen tell me what failed.' })
  const main = created[0] as { mode: string; host: string; target: string; newId: string; label: string }
  check('session_send: starts the main terminal', !r.isError && r.json.started === true && main?.mode === 'new' && main.host === 'thor' && main.target === 'personal' && main.label === 'Personal' &&/^[0-9a-f-]{36}$/.test(main.newId), { r, main })
  check('session_send: typed once the prompt showed, as one line', typed.length === 1 && typed[0].text === 'Check the backups. Then tell me what failed.' && typed[0].pane === r.json.pane, typed)
  check('session_send: acted', acted > before)
  const mainPane = r.json.pane as string
  check('session_send: watched from the start', watch.getWatch(mainPane)?.baselined === true && watch.getWatch(mainPane)?.cursor === '', watch.listWatches())
  r = await call('main_terminals')
  check('main_terminals: the pane is the main', r.json.find((m: { target: string }) => m.target === 'personal')?.pane === mainPane && r.json[0].state === 'idle' && r.json[0].watched === true, r.json)

  // the same main again: typed into the live pane, no new one
  r = await call('session_send', { session: 'personal', text: 'And the disk space.', watch: false })
  check('session_send: reuses the live main', !r.isError && created.length === 1 && typed[1]?.pane === mainPane, { r, created })

  // refusals
  screensBy.set(mainPane, [TYPED])
  r = await call('session_send', { session: mainPane, text: 'hello' })
  check('session_send: refused while he is typing there', r.isError && /typing there/.test(r.text) && typed.length === 2, r)
  screensBy.set(mainPane, [DIALOG])
  r = await call('session_send', { session: mainPane, text: 'hello' })
  check('session_send: refused at a dialog', r.isError && /not at Claude's prompt/.test(r.text) && typed.length === 2, r)
  screensBy.set(mainPane, [IDLE])
  r = await call('session_send', { session: mainPane, text: '!rm -rf /' })
  check('session_send: a shell-mode line is refused', r.isError && /shell command/.test(r.text) && typed.length === 2, r)
  r = await call('session_send', { session: 'router', text: 'hello' })
  check('session_send: a window on thor is read-only', r.isError && /cannot type/.test(r.text), r)
  r = await call('session_send', { session: 'nothing like it', text: 'hello' })
  check('session_send: no match', r.isError && /no session matches/.test(r.text), r)

  // attachments: copied to thor, the path after the text
  r = await call('session_send', { session: mainPane, text: 'What is in this photo?', files: ['f1'] })
  check('session_send: attachment copied to thor', !r.isError && uploads.length === 1 && uploads[0].name === 'photo.jpg', { r, uploads })
  check('session_send: its thor path follows the text', typed[typed.length - 1].text === 'What is in this photo? (attached, on thor: C:\\Thor\\uploads\\20261119-photo.jpg)', typed[typed.length - 1])
  {
    // the phone alerts skip a session Raven typed into (routes/push.ts session-waiting)
    const ownedMod = await import('../src/lib/raven/tools/owned.ts')
    const sid = (await fakeIo.listPanes()).find((p: any) => p.name === mainPane)?.sessionId
    check('owned: a session Raven typed into is Raven\'s, so its alerts are skipped', !!sid && ownedMod.ravenOwnsSession(sid) !== null, { sid, why: sid && ownedMod.ravenOwnsSession(sid) })
    check('owned: a session Raven never touched is his', ownedMod.ravenOwnsSession('11111111-2222-3333-4444-555555555555') === null && ownedMod.ravenOwnsSession('') === null)
  }
  const typedBefore = typed.length
  uploadFails = true
  r = await call('session_send', { session: mainPane, text: 'and this one', files: ['f1'] })
  check('session_send: a refused upload types nothing', r.isError && /could not copy photo.jpg/.test(r.text) && typed.length === typedBefore, r)
  uploadFails = false
  r = await call('session_send', { session: mainPane, text: 'x', files: ['nope'] })
  check('session_send: an unknown attachment', r.isError && /no attachment nope/.test(r.text), r)

  // session_start: a new pane in a target, labeled, watched
  r = await call('session_start', { target: 'work', prompt: 'Summarize open tickets', followUp: 'Tell Brendon the top three' })
  const startPane = r.json?.pane as string
  check('session_start: started and typed', !r.isError && created.length === 2 && (created[1] as { label: string }).label === 'Work' && typed[typed.length - 1].pane === startPane, { r, created })
  check('session_start: follow-up kept on the watch', watch.getWatch(startPane)?.followUp === 'Tell Brendon the top three', watch.getWatch(startPane))
  r = await call('session_start', { target: 'nope', prompt: 'x' })
  check('session_start: unknown target lists the real ones', r.isError && /personal/.test(r.text) && created.length === 2, r)
  r = await call('session_start', { target: 'scratch', prompt: 'x', main: true })
  check('session_start: main only for main targets', r.isError && /not one of the main terminals/.test(r.text), r)
  r = await call('session_start', { target: 'personal', prompt: 'Second thing', main: true })
  check('session_start: main already open types there', !r.isError && r.json.pane === mainPane && created.length === 2 && /already open/.test(r.json.note), r)
  // a pane whose prompt never shows: nothing typed, the pane named
  const t0 = typed.length
  const origCreate = fakeIo.createPane
  fakeIo.createPane = async (o) => { const name = await origCreate(o); screensBy.set(name, [DIALOG]); return name }
  ioMod.setRavenToolsIo(fakeIo)
  r = await call('session_start', { target: 'work', prompt: 'never typed' })
  check('session_start: no prompt in 45 s', r.isError && /did not show within 45 s/.test(r.text) && typed.length === t0, r)
  fakeIo.createPane = origCreate
  ioMod.setRavenToolsIo(fakeIo)
  // a label is one printable line: tmux lists panes one per line with \x1f between fields
  r = await call('session_start', { target: 'work', prompt: 'label test', label: 'Fake\nvk-0000000001\u001fodin\u001fshell', watch: false })
  const odd = created[created.length - 1] as { label: string }
  check('session_start: a label loses its line breaks and field separators', !r.isError && odd.label === 'Fake vk-0000000001 odin shell', odd)
  states.set(r.json.pane, 'gone')

  // reading
  say(mainPane, main.newId, entry('user', 'Check the backups. Then tell me what failed.'), entry('tool'), entry('assistant', 'The 3 AM backup failed: disk full.'))
  r = await call('session_read', { session: 'Personal', last: 2 })
  check('session_read: prompts and answers only', r.json?.entries?.length === 2 && r.json.entries[1].from === 'claude' && /disk full/.test(r.json.entries[1].text) && / ET$/.test(r.json.entries[1].at), r.json)
  say(`sid:${BOARD_ID}`, BOARD_ID, entry('user', 'upgrade the router'), entry('assistant', 'Firmware 7.2 is installed.'))
  r = await call('session_read', { session: 'router firmware' })
  check('session_read: a window on thor, by title', boardReads.includes(BOARD_ID) && r.json?.entries?.[1]?.text === 'Firmware 7.2 is installed.', r.json)

  // the list
  r = await call('sessions')
  show('sessions', r.json)
  check('sessions: panes typeable, thor windows not, running only', r.json?.panes?.length >= 2 && r.json.panes.every((p: { typeable: boolean }) => p.typeable) && r.json.thor.length === 1 && r.json.thor[0].typeable === false, r.json)
  check('sessions: the main is marked', r.json.panes.find((p: { pane: string }) => p.pane === mainPane)?.main === 'personal', r.json.panes)
  boardUp = false
  r = await call('sessions')
  check('sessions: thor not answering is said', typeof r.json?.thor === 'string', r.json)
  boardUp = true

  // watch on and off
  r = await call('session_watch', { session: 'router', on: true })
  check('session_watch: a window on thor', !r.isError && watch.getWatch(`sid:${BOARD_ID}`)?.baselined === true, { r, w: watch.listWatches() })
  r = await call('session_watch', { session: 'Router firmware', on: false })
  check('session_watch: off by label', !r.isError && !watch.getWatch(`sid:${BOARD_ID}`), r)

  // state for the page and the prompt
  const st = await tools.ravenSessionsState()
  check('ravenSessionsState: mains and watches', st.mains.length === 2 && st.mains[0].pane === mainPane && st.watching.some((w) => w.pane === mainPane), st)
  const mainWatch = st.watching.find((w) => w.pane === mainPane)
  check('ravenSessionsState: no board copy, no title', !!mainWatch?.sessionId && mainWatch.title === undefined, mainWatch)
  ;(fakeIo as any).boardCached = () => [{ sessionId: mainWatch?.sessionId, title: 'Printer migration plan' }, { sessionId: 'other', title: 'Other' }]
  ioMod.setRavenToolsIo(fakeIo)
  const titled = (await tools.ravenSessionsState()).watching.find((w) => w.pane === mainPane)
  check('ravenSessionsState: a watch carries its conversation title, its label kept', titled?.title === 'Printer migration plan' && titled.label === mainWatch?.label, titled)
  const relayTitle = tools.ravenRelayTitles()
  check('relay titles: the title when it says more than the label, never the label again',
    relayTitle(mainWatch?.sessionId, 'Personal') === 'Printer migration plan' && relayTitle(mainWatch?.sessionId, 'printer migration plan') === undefined
    && relayTitle('nope', 'Personal') === undefined && relayTitle(undefined, 'Personal') === undefined)
  delete (fakeIo as any).boardCached
  ioMod.setRavenToolsIo(fakeIo)
  screensBy.set(mainPane, [BUSY])
  check('ravenSessionsState: working while the spinner shows', (await tools.ravenSessionsState()).mains[0].state === 'working')
  screensBy.set(mainPane, [IDLE])
  const snap = await tools.ravenSnapshot()
  show('snapshot', snap)
  check('ravenSnapshot: main terminals and watches in words', /Personal \(target personal\): idle, pane vk-/.test(snap) && /Work \(target work\): no pane yet/.test(snap) && /Watched sessions/.test(snap), snap)
  targetsUp = false
  ioMod.setRavenToolsIo(fakeIo)
  const snap2 = await tools.ravenSnapshot()
  check('ravenSnapshot: without thor, the mains Raven opened', /Personal \(target personal\)/.test(snap2) && !/Work \(target work\)/.test(snap2), snap2)
  targetsUp = true
  ioMod.setRavenToolsIo(fakeIo)
  // a thor that hangs holds GET /api/raven 2.5 s at most
  const hang = fakeIo.launchTargets
  fakeIo.launchTargets = () => new Promise((r) => setTimeout(() => r(null), 6_000).unref())
  ioMod.setRavenToolsIo(fakeIo)
  const hungAt = Date.now()
  const hung = await tools.ravenSessionsState()
  check('ravenSessionsState: a hanging thor costs 2.5 s at most', Date.now() - hungAt < 4_000 && hung.mains.some((m) => m.target === 'personal'), { ms: Date.now() - hungAt, hung })
  // the run loop gives the snapshot 5 s (run.ts); a hanging thor must not cost the watched sessions with it
  ioMod.setRavenToolsIo(fakeIo)
  const snapAt = Date.now()
  const hungSnap = await tools.ravenSnapshot()
  check('ravenSnapshot: a hanging thor answers inside the run loop\'s 5 s', Date.now() - snapAt < 4_800 && /Personal \(target personal\)/.test(hungSnap), { ms: Date.now() - snapAt, hungSnap })
  fakeIo.launchTargets = hang
  ioMod.setRavenToolsIo(fakeIo)

  // a shell pane is never typed into
  const sh = pane('vk-5555555555', 'odin shell', 'home', '')
  sh.mode = 'shell'
  r = await call('session_send', { session: sh.name, text: 'ls' })
  check('session_send: never into a shell', r.isError && /is a shell/.test(r.text), r)
  r = await call('sessions')
  const shRow = r.json?.panes?.find((x: { pane: string }) => x.pane === sh.name)
  check('sessions: a shell is marked and not typeable', shRow?.shell === true && shRow.typeable === false, shRow)
  states.set(sh.name, 'gone')

  // tmux refusing a pane reads as plain words
  const okCreate = fakeIo.createPane
  fakeIo.createPane = async () => { throw new Error('12 sessions already open (max 12) \u2014 close one first') }
  ioMod.setRavenToolsIo(fakeIo)
  r = await call('session_start', { target: 'work', prompt: 'x' })
  check('session_start: a full tmux says so, without a dash', r.isError && /could not open a pane: 12 sessions already open/.test(r.text) && !/\u2014/.test(r.text), r)
  fakeIo.createPane = okCreate
  ioMod.setRavenToolsIo(fakeIo)

  // stop
  r = await call('session_stop', { session: 'personal' })
  check('session_stop: the main pane is killed, unwatched, unmapped', !r.isError && killed.includes(mainPane) && !watch.getWatch(mainPane), r)
  r = await call('main_terminals')
  check('main_terminals: closed again', r.json[0].pane === null && r.json[0].state === 'closed', r.json)
  r = await call('session_stop', { session: 'router' })
  check('session_stop: not for windows on thor', r.isError && /cannot type into it or stop it/.test(r.text), r)
  for (const w of watch.listWatches()) watch.removeWatch(w.key)
}

// --------------------------------------------------------- the watcher ---

{
  posts.length = 0
  wakes.length = 0
  const tick = async (ms = 0) => { clock += ms; await watch.tickWatches() }
  const sid = '22222222-3333-4444-8555-666666666666'
  const p = pane('vk-aaaaaaaaaa', 'Server work', 'server', sid)
  screensBy.set(p.name, [IDLE])
  // history before the watch is never relayed
  say(p.name, sid, entry('user', 'old prompt'), entry('assistant', 'An old answer.'))
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid })
  await tick(20_000)
  check('watch: history is not relayed', posts.length === 0, posts)

  // an answer: held 12 s, then relayed once
  say(p.name, sid, entry('user', 'is nginx up?'))
  await tick(1_000)
  say(p.name, sid, entry('assistant', 'Yes, nginx is up.'))
  await tick(8_000)
  check('watch: the answer just arrived, held', posts.length === 0, posts)
  await tick(8_000)
  check('watch: 8 s of quiet is not enough', posts.length === 0, posts)
  await tick(8_000)
  check('watch: relayed after 12 s of quiet', posts.length === 1 && posts[0].text === 'Yes, nginx is up.', posts)
  const m = posts[0]?.opts
  check('watch: relay meta, link and push', m?.meta?.relay?.kind === 'session' && m.meta.relay.from === p.name && m.meta.relay.label === 'Server work' && m.meta.relay.sessionId === sid
    && m.refs?.[0]?.url === `/m/ai/term/${p.name}` && m.push === true, m)
  await tick(8_000)
  await tick(8_000)
  check('watch: never twice', posts.length === 1, posts)

  // narration then tools then the answer: only the answer; held while the spinner shows
  say(p.name, sid, entry('user', 'restart it'), entry('assistant', 'Restarting nginx now.'), entry('tool'), entry('result'), entry('assistant', 'Done.'), entry('assistant', 'It came back in 2 s.'))
  screensBy.set(p.name, [BUSY])
  await tick(1_000)
  await tick(15_000)
  check('watch: held while the pane shows the spinner', posts.length === 1, posts)
  screensBy.set(p.name, [IDLE])
  await tick(8_000)
  check('watch: only the final answer, its parts joined', posts.length === 2 && posts[1].text === 'Done.\n\nIt came back in 2 s.', posts)

  // follow-up: woken once with the answer
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid, followUp: 'If it failed, open a task' })
  say(p.name, sid, entry('user', 'check certs'), entry('assistant', 'Certs expire in 60 days.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: follow-up wakes Raven', wakes.length === 1 && wakes[0].kind === 'session_reply' && wakes[0].payload.followUp === 'If it failed, open a task' && wakes[0].payload.text === 'Certs expire in 60 days.', wakes)
  say(p.name, sid, entry('user', 'thanks'), entry('assistant', 'Any time.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: the follow-up is used once', wakes.length === 1 && posts[posts.length - 1].text === 'Any time.', { wakes, last: posts[posts.length - 1] })

  // a long answer is cut at 3,000 characters
  say(p.name, sid, entry('user', 'dump it'), entry('assistant', 'x'.repeat(5000)))
  await tick(1_000)
  await tick(13_000)
  check('watch: cut at 3000', posts[posts.length - 1].text.length === 3000, posts[posts.length - 1].text.length)

  // a rewind: the page holds already-seen entries plus the new branch
  const t = transcripts.get(p.name)!
  const origPT = fakeIo.paneTranscript
  let rewindOnce = true
  fakeIo.paneTranscript = async (name: string, after: string) => {
    if (rewindOnce && name === p.name) {
      rewindOnce = false
      clock += 1_000
      const fresh = [entry('user', 'a different question'), entry('assistant', 'A different answer.')]
      t.entries.push(...fresh)
      return { sessionId: sid, file: 'x', cursor: String(t.entries.length), entries: t.entries.slice(-6), more: false, reset: true }
    }
    return origPT(name, after)
  }
  ioMod.setRavenToolsIo(fakeIo)
  const before = posts.length
  await tick(0)
  await tick(13_000)
  check('watch: after a rewind only the new answer', posts.length === before + 1 && posts[posts.length - 1].text === 'A different answer.', posts.slice(before))
  fakeIo.paneTranscript = origPT
  ioMod.setRavenToolsIo(fakeIo)

  // the pane dies: the last answer, then one "ended" line, and the watch is gone
  say(p.name, sid, entry('user', 'last one'), entry('assistant', 'Bye.'))
  states.set(p.name, 'dead')
  const b2 = posts.length
  await tick(1_000)
  check('watch: a dying pane relays its last answer and ends', posts.length === b2 + 2 && posts[b2].text === 'Bye.' && posts[b2 + 1].text === 'Server work ended' && !watch.getWatch(p.name), posts.slice(b2))
  await tick(13_000)
  check('watch: nothing after the end', posts.length === b2 + 2)

  // a window on thor: no link, no spinner check
  const bsid = '33333333-3333-4444-8555-666666666666'
  say(`sid:${bsid}`, bsid, entry('user', 'earlier'))
  await watch.startWatch({ pane: '', label: 'Desk session', sessionId: bsid })
  say(`sid:${bsid}`, bsid, entry('assistant', 'Desk answer.'))
  await tick(1_000)
  await tick(13_000)
  const last = posts[posts.length - 1]
  check('watch: a window on thor relays without a link', last.text === 'Desk answer.' && (last.opts?.refs ?? []).length === 0 && last.opts?.meta?.relay?.from === bsid, last)

  // a fresh session: everything in it is news
  const fsid = '44444444-3333-4444-8555-666666666666'
  const fp = pane('vk-bbbbbbbbbb', 'Fresh one', 'work', fsid)
  screensBy.set(fp.name, [IDLE])
  await watch.startWatch({ pane: fp.name, label: fp.label, sessionId: fsid, fresh: true })
  say(fp.name, fsid, entry('user', 'first prompt'), entry('assistant', 'First answer.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: a fresh session relays its first answer', posts[posts.length - 1].text === 'First answer.', posts[posts.length - 1])

  // a session whose first read failed: only entries after the watch began count
  const lsid = '55555555-3333-4444-8555-666666666666'
  const lp = pane('vk-cccccccccc', 'Late one', 'work', lsid)
  screensBy.set(lp.name, [IDLE])
  say(lp.name, lsid, { id: 'late-old', at: clock - 60_000, kind: 'assistant', text: 'Before the watch.' })
  const realPT = fakeIo.paneTranscript
  fakeIo.paneTranscript = async (name: string, after: string) => { if (name === lp.name && after === '' && !watch.getWatch(lp.name)) throw new Error('thor asleep'); return realPT(name, after) }
  ioMod.setRavenToolsIo(fakeIo)
  await watch.startWatch({ pane: lp.name, label: lp.label, sessionId: lsid })
  check('watch: a failed first read leaves it unbaselined', watch.getWatch(lp.name)?.baselined === false)
  say(lp.name, lsid, entry('user', 'go'), entry('assistant', 'After the watch.'))
  const b3 = posts.length
  await tick(1_000)
  await tick(13_000)
  check('watch: only what came after the watch', posts.length === b3 + 1 && posts[b3].text === 'After the watch.', posts.slice(b3))
  fakeIo.paneTranscript = realPT
  ioMod.setRavenToolsIo(fakeIo)

  // 24 h with nothing new drops a watch without a word
  const b4 = posts.length
  await tick(25 * 3_600_000)
  check('watch: stale watches drop silently', watch.listWatches().length === 0 && posts.length === b4, watch.listWatches())

  // a read that holds the pass open, released by hand
  const gated = (name: string) => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const orig = fakeIo.paneTranscript
    let armed = true
    fakeIo.paneTranscript = async (n: string, after: string) => {
      if (armed && n === name) { armed = false; await gate }
      return orig(n, after)
    }
    ioMod.setRavenToolsIo(fakeIo)
    return () => { release(); fakeIo.paneTranscript = orig; ioMod.setRavenToolsIo(fakeIo) }
  }

  // a tool refreshing a watch while a pass relays it: the answer and the follow-up go out once
  const rsid = '66666666-3333-4444-8555-666666666666'
  const rp = pane('vk-dddddddddd', 'Race one', 'work', rsid)
  screensBy.set(rp.name, [IDLE])
  await watch.startWatch({ pane: rp.name, label: rp.label, sessionId: rsid, fresh: true, followUp: 'Tell him' })
  say(rp.name, rsid, entry('user', 'go'), entry('assistant', 'Raced answer.'))
  await tick(1_000)
  const b5 = posts.length
  const w5 = wakes.length
  clock += 13_000
  const open5 = gated(rp.name)
  const pass5 = watch.tickWatches()
  await watch.startWatch({ pane: rp.name, label: rp.label, sessionId: rsid })
  open5()
  await pass5
  await tick(8_000)
  await tick(8_000)
  check('watch: a refresh during a pass relays once', posts.length === b5 + 1 && posts[b5].text === 'Raced answer.', posts.slice(b5).map((x) => x.text))
  check('watch: a refresh during a pass wakes once', wakes.length === w5 + 1, wakes.slice(w5))

  // a watch removed during a pass: nothing more from it
  say(rp.name, rsid, entry('user', 'again'), entry('assistant', 'Not wanted.'))
  await tick(1_000)
  const b6 = posts.length
  clock += 13_000
  const open6 = gated(rp.name)
  const pass6 = watch.tickWatches()
  watch.removeWatch(rp.name)
  open6()
  await pass6
  check('watch: removed during a pass relays nothing', posts.length === b6, posts.slice(b6).map((x) => x.text))

  // more text after a relay, with no prompt or tool between: only the new part goes out
  const msid = '77777777-3333-4444-8555-666666666666'
  say(`sid:${msid}`, msid, entry('user', 'earlier'))
  await watch.startWatch({ pane: '', label: 'Desk two', sessionId: msid })
  say(`sid:${msid}`, msid, entry('user', 'plan it'), entry('assistant', 'Part one.'))
  await tick(1_000)
  await tick(13_000)
  say(`sid:${msid}`, msid, entry('assistant', 'Part two.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: a later part is relayed alone', posts.length >= 2 && posts[posts.length - 2].text === 'Part one.' && posts[posts.length - 1].text === 'Part two.', posts.slice(-2).map((x) => x.text))
  watch.removeWatch(`sid:${msid}`)

  // a pane that dies while thor's transcripts cannot be read still ends
  const dsid = '88888888-3333-4444-8555-666666666666'
  const dp = pane('vk-eeeeeeeeee', 'Dark one', 'work', dsid)
  screensBy.set(dp.name, [IDLE])
  await watch.startWatch({ pane: dp.name, label: dp.label, sessionId: dsid, fresh: true })
  const okPT = fakeIo.paneTranscript
  fakeIo.paneTranscript = async (n: string, after: string) => { if (n === dp.name) throw new Error('thor asleep'); return okPT(n, after) }
  ioMod.setRavenToolsIo(fakeIo)
  states.set(dp.name, 'dead')
  const b7 = posts.length
  await tick(8_000)
  check('watch: dies while thor is unreadable, still ends', posts.length === b7 + 1 && posts[b7].text === 'Dark one ended' && !watch.getWatch(dp.name), { posts: posts.slice(b7).map((x) => x.text), w: watch.getWatch(dp.name) })
  fakeIo.paneTranscript = okPT
  ioMod.setRavenToolsIo(fakeIo)

  // a thor board row whose conversation runs in a pane here is that pane, never a second watch
  const psid = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
  const pp = pane('vk-ffffffffff', 'Phone pane', 'work', psid)
  board.push({ sessionId: psid, title: 'Quarterly cleanup', area: 'work', live: true, activity: 'idle', lastActivityUtc: new Date().toISOString() })
  const qw = await call('session_watch', { session: 'quarterly', on: true })
  check('session_watch: a board title in a pane watches the pane', !qw.isError && qw.json?.pane === pp.name && Boolean(watch.getWatch(pp.name)) && !watch.getWatch(`sid:${psid}`), { qw, w: watch.listWatches().map((x) => x.key) })
  const qs = await call('session_send', { session: 'quarterly', text: 'status?' })
  check('session_send: a board title in a pane types into the pane', !qs.isError && qs.json?.pane === pp.name, qs)
  watch.removeWatch(pp.name)
  board.pop()
  states.set(pp.name, 'gone')

  // turning a watch off needs a name
  await watch.startWatch({ pane: '', label: 'Keep me', sessionId: msid })
  const off = await call('session_watch', { session: '  ', on: false }, false)
  check('session_watch: a blank name turns nothing off', off.isError && Boolean(watch.getWatch(`sid:${msid}`)), off)
  for (const w of watch.listWatches()) watch.removeWatch(w.key)

  // the timer exists and does not hold the process open
  tools.startRavenTools()
  watch.stopWatcher()
}

// ---------------------------------------------------------------- done ---

hooks.setRavenPoster(null)
hooks.setRavenWaker(null)
apiSrv.close()
for (const c of clients.values()) await c.close()
console.log(`ravenToolsSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
