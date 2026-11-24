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
// the Personal calendar's own routes, and thor's work calendar add (project-files calendar.mjs)
const localEvents: Record<string, unknown>[] = [{ id: 'old-1', title: 'Dentist', allDay: false, start: '2026-12-01T09:00', end: '2026-12-01T10:00' }]
const localPosts: Record<string, unknown>[] = []
api.get('/api/calendar/local-events', (_q, r) => r.json({ events: localEvents }))
api.post('/api/calendar/local-events', (q, r) => {
  localPosts.push(q.body)
  const ev = { id: `new-${localPosts.length}`, ...q.body }
  localEvents.push(ev)
  r.json({ ok: true, event: ev })
})
const workAdds: { auth: string | undefined; body: Record<string, unknown> }[] = []
let workAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, added: true, event_id: 'AAMk1', web_link: 'https://outlook.example/ev/1', start: '2026-12-02T15:00:00', end: '2026-12-02T15:30:00' } }
api.post('/calendar/add', (q, r) => { workAdds.push({ auth: q.header('authorization'), body: q.body }); r.status(workAnswer.status).json(workAnswer.body) })
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
const outsideMod = await import('../src/lib/raven/tools/outside.ts')
const autoclose = await import('../src/lib/raven/tools/autoclose.ts')
const utilMod = await import('../src/lib/raven/tools/util.ts')
const paneStateMod = await import('../src/terminal/paneState.ts')
const originMod = await import('../src/lib/sessionOrigin.ts')
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
// panes that printed nothing for a minute: the busy rule never reads their screen
const quiet = new Set<string>()
// panes nobody typed in, opened or printed in for an hour: the auto-close may look at them
const away = new Set<string>()
const typed: { pane: string; text: string }[] = []
const created: Record<string, unknown>[] = []
// session_recover's reopens (the Desk's Recover, terminal/resume.ts), and an answer to throw instead
const resumed: { sessionId: string; label: string; cols: number; rows: number }[] = []
let resumeThrows: Error | null = null
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
// a turn that ended with a background shell still running: the footer counts it (vk-7f99bde0a3 on odin, 2026-11-20)
const WAITING = [
  '● The fix is committed. A background check is waiting for v0.3.208 to finish.',
  '  Ran 5 shell commands',
  '✻ Worked for 9m 38s · done 11:03 PM · 1 shell still running',
  '%RULE%> ',
  '%RULE%  Opus 5.5 C:\\...\\server\\valkyrie (main) | eff xhigh wk 25%',
  '  ⏵⏵ bypass permissions on · 1 shell · ← 5 agents',
].join('\n').replaceAll('%RULE%', '─'.repeat(60))
// the same screen once the shell is done: "← 5 agents" lists other sessions, no work of its own
const WAITED = WAITING.replace(' · 1 shell still running', '').replace(' · 1 shell ·', ' ·')

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
const doneMarks: string[] = []
let doneFails = false
// thor's stop (Kill-Session.ps1): what was asked, and which panes were killed by then
const thorStops: { sid: string; killedThen: string[] }[] = []
let thorStopAnswer: 'stopped' | 'none' | 'failed' = 'stopped'
let targetsUp = true
async function fakeCapture(p: string): Promise<string | null> {
  const list = screensBy.get(p) ?? [IDLE]
  return list.length > 1 ? list.shift()! : list[0]
}
const fakeIo = {
  listPanes: async () => panes.filter((p) => states.get(p.name) !== 'gone').map((p) => {
    const at = away.has(p.name) ? clock - 3_600_000 : quiet.has(p.name) ? clock - 60_000 : clock
    return { ...p, activityAt: at, ...(at < clock ? { outputAt: at } : {}), dead: states.get(p.name) === 'dead' }
  }),
  createPane: async (o: Record<string, unknown>) => {
    created.push(o)
    const name = `vk-${String(++paneSeq).padStart(10, '0')}`
    pane(name, String(o.label), String(o.target), String(o.newId))
    screensBy.set(name, ['', '', IDLE])
    return name
  },
  resumePane: async (o: { sessionId: string; label: string; cols: number; rows: number }) => {
    if (resumeThrows) throw resumeThrows
    resumed.push(o)
    const name = `vk-${String(++paneSeq).padStart(10, '0')}`
    const p = pane(name, o.label, o.sessionId, o.sessionId)
    p.mode = 'resume'
    screensBy.set(name, ['', IDLE])
    // the pane reads the same conversation its board row does
    const t = transcripts.get(`sid:${o.sessionId}`) ?? { sessionId: o.sessionId, entries: [] }
    transcripts.set(`sid:${o.sessionId}`, t)
    transcripts.set(name, t)
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
  markDone: async (ids: string[]) => { if (doneFails) return false; doneMarks.push(...ids); return true },
  stopOnThor: async (sid: string) => { thorStops.push({ sid, killedThen: [...killed] }); return thorStopAnswer },
  sleep: async (ms: number) => { clock += ms },
  now: () => clock,
}
ioMod.setRavenToolsIo(fakeIo)

// ------------------------------------------------------------ tool list ---

{
  const listed = (await (await client({ fromBrendon: true })).listTools()).tools.map((t) => t.name)
  const want = ['agents', 'agent_channel', 'agent_ask', 'agents_pause', 'agent_check', 'proposals', 'main_terminals', 'sessions', 'session_start',
    'session_send', 'session_read', 'session_screen', 'session_keys', 'session_watch', 'session_tend', 'thor_screen', 'thor_windows', 'thor_button', 'thor_click', 'thor_press', 'session_stop', 'session_keep', 'session_done', 'sessions_closed', 'session_recover', 'media_search', 'media_requests', 'media_request', 'vault_search', 'vault_read',
    'vault_recent', 'vault_list', 'vault_note', 'thor_files', 'thor_file_read', 'thor_files_search', 'tasks', 'task_add', 'task_done', 'projects',
    'project_get', 'tickets', 'inbox', 'calendar', 'calendar_add', 'brief', 'thread_search', 'thread_read']
  check('every tool is registered', want.every((n) => listed.includes(n)), want.filter((n) => !listed.includes(n)))
  check('the core tools are left to the endpoint', !['post', 'notebook_set', 'now', 'attachment', 'attachments'].some((n) => listed.includes(n)), listed)
  check('no extra tools', listed.length === want.length, listed)
}

// ---------------------------------------------------- the fromBrendon gate ---

{
  const gated: [string, Record<string, unknown>][] = [
    ['agents_pause', { paused: true }], ['agent_check', { agent: 'east-triage' }],
    ['session_start', { target: 'work', prompt: 'hi' }],
    ['session_watch', { session: 'personal', on: true }], ['session_stop', { session: 'personal' }], ['session_done', { session: 'personal' }],
    ['session_recover', { session: 'closed one' }], ['session_recover', { area: 'Thor' }],
    ['media_request', { kind: 'movie', title: 'Heat 2', tmdbId: 5000 }], ['vault_note', { title: 'x', text: 'y' }],
    ['task_add', { text: 'buy milk' }], ['task_done', { id: 'loose/abc' }],
    ['calendar_add', { title: 'Haircut', start: '2026-12-02T12:00' }], ['calendar_add', { title: 'Standup', start: '2026-12-02T15:00', calendar: 'work' }],
    ['thor_files', {}], ['thor_file_read', { path: 'C:\\Users\\Brendon\\Documents\\x.txt' }], ['thor_files_search', { query: 'resume' }],
  ]
  const before = acted
  for (const [tool, args] of gated) {
    const r = await call(tool, args, false)
    check(`gate: ${tool} refused without Brendon`, r.isError && /Brendon's own message/.test(r.text), r)
  }
  check('gate: nothing acted', acted === before, acted - before)
  check('gate: no media add, no vault note', adds.length === 0 && notes.length === 0)
  check('gate: no calendar event, personal or work', localPosts.length === 0 && workAdds.length === 0, { localPosts, workAdds })
  check('gate: no pane opened, nothing typed or stopped, no watch, no task', created.length === 0 && resumed.length === 0 && typed.length === 0 && killed.length === 0
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

  // calendar_add: Personal through the local-events route, work through thor
  let before = acted
  r = await call('calendar_add', { title: 'AK Studio barber haircut', start: '2026-11-25T12:00' })
  show('calendar_add personal', r.json)
  check('calendar_add: personal by default, one hour', !r.isError && r.json.added === true && r.json.calendar === 'Personal' && r.json.id === 'new-1'
    && localPosts[0]?.start === '2026-11-25T12:00' && localPosts[0]?.end === '2026-11-25T13:00' && localPosts[0]?.allDay === false, { r, localPosts })
  check('calendar_add: New York words', r.json?.when === 'Wed, Nov 25, 12:00 PM to 1:00 PM ET', r.json)
  check('calendar_add: counts as acted', acted === before + 1, acted - before)
  before = acted
  r = await call('calendar_add', { title: 'ak studio barber haircut ', start: '2026-11-25T12:00', minutes: 30 })
  check('calendar_add: the same title at the same start is not added twice', !r.isError && r.json.added === false && /Already/.test(r.json.note)
    && localPosts.length === 1 && acted === before, { r, localPosts })
  r = await call('calendar_add', { title: 'Late call', start: '2026-11-25T23:30', minutes: 90, location: 'Home', notes: 'bring the notes' })
  check('calendar_add: minutes past midnight', !r.isError && localPosts[1]?.end === '2026-11-26T01:00' && localPosts[1]?.location === 'Home'
    && localPosts[1]?.notes === 'bring the notes' && r.json.when === 'Wed, Nov 25, 11:30 PM to Thu, Nov 26, 1:00 AM ET', { r, post: localPosts[1] })
  r = await call('calendar_add', { title: 'Trip', start: '2026-12-04', end: '2026-12-06', allDay: true })
  check('calendar_add: all day, several days', !r.isError && localPosts[2]?.allDay === true && localPosts[2]?.end === '2026-12-06'
    && r.json.when === 'Fri, Dec 4 to Sun, Dec 6, all day', { r, post: localPosts[2] })
  r = await call('calendar_add', { title: 'Garbage', start: '2026-12-07', allDay: true })
  check('calendar_add: all day, one day', !r.isError && localPosts[3]?.end === '2026-12-07' && r.json.when === 'Mon, Dec 7, all day', r.json)
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['a date for a timed event', { title: 'x', start: '2026-12-02' }, /start must be/],
    ['a time for an all-day event', { title: 'x', start: '2026-12-02T10:00', allDay: true }, /start must be/],
    ['no such day', { title: 'x', start: '2026-02-30T10:00' }, /start must be a real/],
    ['no such hour', { title: 'x', start: '2026-12-02T25:00' }, /start must be a real/],
    ['end before start', { title: 'x', start: '2026-12-02T10:00', end: '2026-12-02T09:00' }, /end must be after start/],
    ['end equal to start', { title: 'x', start: '2026-12-02T10:00', end: '2026-12-02T10:00' }, /end must be after start/],
    ['a blank title', { title: '   ', start: '2026-12-02T10:00' }, /title is empty/],
  ]
  for (const [what, args, want] of bad) {
    r = await call('calendar_add', args)
    check(`calendar_add: refuses ${what}`, r.isError && want.test(r.text), r)
  }
  check('calendar_add: nothing posted for a refused one', localPosts.length === 4 && workAdds.length === 0, { localPosts, workAdds })
  check('calendar_add: no existing event touched', localEvents[0].title === 'Dentist' && localEvents[0].start === '2026-12-01T09:00', localEvents[0])

  before = acted
  r = await call('calendar_add', { title: 'Client call', start: '2026-12-02T15:00', minutes: 30, location: 'Teams', calendar: 'work' })
  show('calendar_add work', r.json)
  check('calendar_add: work goes to thor with the token', !r.isError && r.json.added === true && r.json.calendar === 'Work'
    && workAdds[0]?.auth === 'Bearer files-token' && r.json.link === 'https://outlook.example/ev/1' && acted === before + 1, { r, workAdds })
  check('calendar_add: thor gets New York wall clock and no mailbox', workAdds[0]?.body.subject === 'Client call' && workAdds[0]?.body.start === '2026-12-02T15:00'
    && workAdds[0]?.body.end === '2026-12-02T15:30' && workAdds[0]?.body.allDay === false && workAdds[0]?.body.location === 'Teams'
    && !('mailbox' in (workAdds[0]?.body ?? {})), workAdds[0])
  check('calendar_add: the Personal calendar is not touched for work', localPosts.length === 4, localPosts.length)
  workAnswer = { status: 200, body: { ok: true, added: false, already: true, event_id: 'AAMk1', web_link: 'https://outlook.example/ev/1' } }
  before = acted
  r = await call('calendar_add', { title: 'Client call', start: '2026-12-02T15:00', calendar: 'work' })
  check('calendar_add: work already there is not acted', !r.isError && r.json.added === false && /Already/.test(r.json.note) && acted === before, r)
  workAnswer = { status: 400, body: { error: 'end must be after start' } }
  r = await call('calendar_add', { title: 'Client call', start: '2026-12-02T16:00', calendar: 'work' })
  check('calendar_add: a refusal from thor comes back as text', r.isError && /end must be after start/.test(r.text), r)

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

// ------------------------------------------------------------- thread ---

{
  const say = (author: string, text: string, meta: Record<string, unknown> = {}) => store.addMessage({ channelId: 'raven', author, text, meta })
  const idea = say('brendon', 'Can you tell the crewtastrophe session: what happens to the factions is also affected by the player (destroying faction ships or not helping them in events, getting closer into their territory). '
    + 'x'.repeat(900) + ' Wormholes could jump you around the map.')
  const reply = say('raven', 'I could not pass it on to that session.', { replyTo: idea.id })
  store.addMessage({ channelId: 'east-triage', author: 'east-triage', text: 'Not in the thread: factions and wormholes.' })
  const pic = say('brendon', 'the sketch', { files: [{ id: 'f1', name: 'sector-map.png', mime: 'image/png', size: 10, createdAt: new Date().toISOString() }] })
  const ran = say('raven', 'Filed it.', { sessions: [{ from: 'vk-1', label: 'Crew', lines: [{ at: new Date().toISOString(), text: 'Backlog item written to docs/BACKLOG.md' }] }] })
  const before = acted

  let r = await call('thread_search', { query: 'Factions WORMHOLES' }, false)
  check('thread_search: every word, any run, case-insensitive', !r.isError && r.json?.mode === 'all' && r.json.total === 1 && r.json.hits[0].id === idea.id, r)
  check('thread_search: the hit has ET time, author and a snippet', / ET$/.test(r.json?.hits?.[0]?.at ?? '') && r.json.hits[0].author === 'Brendon' && /factions/i.test(r.json.hits[0].snippet), r.json)
  check('thread_search: other channels are left out', !r.text.includes('Not in the thread'), r.text)
  r = await call('thread_search', { query: 'crewtraswtrophe factions territory' })
  check('thread_search: a typo falls back to any word, most words first', r.json?.mode === 'any' && r.json.hits[0].id === idea.id && r.json.hits[0].words === 2, r.json)
  r = await call('thread_search', { query: '"getting closer into their territory"' })
  check('thread_search: a quoted phrase', r.json?.total === 1 && r.json.hits[0].id === idea.id, r.json)
  r = await call('thread_search', { query: 'pass it on', from: 'brendon' })
  check('thread_search: from narrows the author', /^No message/.test(r.text), r.text)
  r = await call('thread_search', { query: 'sector-map' })
  check('thread_search: a file name', r.json?.hits?.[0]?.id === pic.id && r.json.hits[0].snippet === '[file: sector-map.png]', r.json)
  r = await call('thread_search', { query: 'BACKLOG.md' })
  check('thread_search: session lines only when asked', /^No message/.test(r.text), r.text)
  r = await call('thread_search', { query: 'BACKLOG.md', sessions: true })
  check('thread_search: session lines', r.json?.hits?.[0]?.id === ran.id && /^\[session Crew\]/.test(r.json.hits[0].snippet), r.json)

  r = await call('thread_read', { id: idea.id }, false)
  check('thread_read: one message in full', !r.isError && r.text.startsWith(`#${idea.id} · `) && r.text.includes('Wormholes could jump you') && r.text.length > 1000, r.text.slice(0, 200))
  r = await call('thread_read', { around: reply.id, context: 1 })
  check('thread_read: around, oldest first, reply marked', r.text.indexOf(`#${idea.id} ·`) < r.text.indexOf(`#${reply.id} ·`) && r.text.includes(`reply to #${idea.id}`) && r.text.includes(`#${pic.id} ·`), r.text.slice(0, 400))
  r = await call('thread_read', { from: pic.id, to: ran.id, sessions: true })
  check('thread_read: a range with files and session lines', r.text.includes('[files: sector-map.png (id f1)]') && r.text.includes('Backlog item written') && !r.text.includes(`#${idea.id} ·`), r.text)
  r = await call('thread_read', { id: 999_999 })
  check('thread_read: a missing number is an error', r.isError && /no message #999999/.test(r.text), r)
  r = await call('thread_read', {})
  check('thread_read: nothing named is an error', r.isError, r)
  check('thread: reading acts on nothing', acted === before, acted - before)
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
  check('session_send: a main it opened is on record as Raven\'s', originMod.ravenStartedIds().has(main.newId) && originMod.originOf(originMod.ravenStartedIds(), main.newId) === 'raven', [...originMod.ravenStartedIds()])
  check('session origin: a conversation it never started is his', originMod.originOf(originMod.ravenStartedIds(), '00000000-0000-4000-8000-000000000000') === 'brendon' && originMod.originOf(originMod.ravenStartedIds(), '') === 'brendon')
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
  // a window on thor (outside.ts): typed through thor's console once its own screen shows an empty prompt
  {
    const outTyped: { sid: string; text: string }[] = []
    const outKeys: { sid: string; keys: string[] }[] = []
    const outScreens = new Map<string, string>([[BOARD_ID, DIALOG]])
    const ODIN_TMUX = '22222222-3333-4444-8555-666666666666'
    const ODIN_BARE = '66666666-7777-4888-8999-000000000000'
    outsideMod.setOutsideIo({
      thorSessions: async () => [{ host: 'thor', sessionId: BOARD_ID, pid: 4242, name: 'Router firmware upgrade', cwd: 'C:\\Thor', status: 'idle', via: 'console' }],
      odinSessions: async () => [
        { host: 'odin', sessionId: ODIN_TMUX, pid: 99, name: 'odin backup check', cwd: '/home/brendon', status: 'idle', via: 'tmux', tmux: { socket: '/tmp/tmux-1000/default', pane: '%3' } },
        { host: 'odin', sessionId: ODIN_BARE, pid: 98, name: 'odin bare shell', cwd: '/home/brendon', status: 'idle', via: 'none' },
      ],
      screen: async (o) => outScreens.get(o.sessionId) ?? IDLE,
      type: async (o, text) => { outTyped.push({ sid: o.sessionId, text }) },
      keys: async (o, keys) => { outKeys.push({ sid: o.sessionId, keys }) },
    })
    r = await call('session_send', { session: 'router', text: 'hello' })
    check('session_send: a window on thor with a prompt open is refused', r.isError && /not at Claude's prompt/.test(r.text) && !outTyped.length, r)
    r = await call('session_screen', { session: 'router' })
    check('session_screen: a window on thor reads asking from its screen', !r.isError && r.json?.state === 'asking' && r.json.in === 'a window on thor', r)
    r = await call('session_keys', { session: 'router', keys: ['1'] })
    check('session_keys: a window on thor gets the keys', !r.isError && outKeys.length === 1 && outKeys[0].sid === BOARD_ID && outKeys[0].keys.join() === '1', { r, outKeys })
    r = await call('session_keys', { session: 'router', keys: ['rm -rf'] })
    check('session_keys: only named keys', r.isError && /no key/.test(r.text) && outKeys.length === 1, r)
    outScreens.set(BOARD_ID, TYPED)
    r = await call('session_send', { session: 'router', text: 'hello' })
    check('session_send: a window with text typed in it is left alone', r.isError && /Brendon is typing/.test(r.text) && !outTyped.length, r)
    outScreens.set(BOARD_ID, IDLE)
    r = await call('session_send', { session: 'router', text: 'Carry on.\nThen report.', watch: false })
    check('session_send: a window on thor is typed into, as one line', !r.isError && outTyped.length === 1 && outTyped[0].sid === BOARD_ID && outTyped[0].text === 'Carry on. Then report.' && r.json.in === 'a window on thor', { r, outTyped })
    r = await call('sessions')
    check('sessions: thor windows typeable, odin terminals listed', !r.isError && r.json.thor.find((x: { sessionId: string }) => x.sessionId === BOARD_ID)?.typeable === true
      && r.json.odin.length === 2 && r.json.odin.find((x: { sessionId: string }) => x.sessionId === ODIN_BARE)?.typeable === false, r.json)
    r = await call('session_send', { session: 'odin backup', text: 'status?', watch: false })
    check('session_send: a tmux pane on odin outside Valkyrie', !r.isError && outTyped.at(-1)?.sid === ODIN_TMUX && /tmux pane on odin/.test(r.json.in), { r, outTyped })
    r = await call('session_send', { session: 'odin bare', text: 'status?', watch: false })
    check('session_send: a bare terminal on odin is read-only', r.isError && /bare terminal/.test(r.text), r)
    const c = await sessionsMod.sessionCheck('router')
    check('sessionCheck: a window on thor', c.alive && c.state === 'idle' && c.where === 'a window on thor', c)
    outsideMod.setOutsideIo(null)
  }
  check('plainRules: a named rule loses its name, the prompt box stays', outsideMod.screenVerdict('──────────── Crewtastrophe ─\n❯\u00a0\n──────────────────────────').state === 'idle'
    && outsideMod.screenVerdict('────────────\n❯ hi\n────────────').state === 'typed', outsideMod.plainRules('──────────── Crewtastrophe ─\n❯\n────────'))
  check('checkKeys: names and single keys', outsideMod.checkKeys(['Enter', 'ESC', '1', 'down']).join() === 'enter,esc,1,down' && outsideMod.tmuxKeys(['enter', 'shift+tab', 'y']).join() === 'Enter,BTab,y')
  r = await call('session_send', { session: 'nothing like it', text: 'hello' })
  check('session_send: no match', r.isError && /no session matches/.test(r.text), r)

  // a run Brendon did not start (a session's answer woke Raven) sends too; the same refusals guard his pane
  screensBy.set(mainPane, [TYPED])
  r = await call('session_send', { session: mainPane, text: 'The branch is ready for the release.' }, false)
  check('session_send: without Brendon, still refused while he is typing there', r.isError && /typing there/.test(r.text) && typed.length === 2, r)
  screensBy.set(mainPane, [DIALOG])
  r = await call('session_send', { session: mainPane, text: 'The branch is ready for the release.' }, false)
  check('session_send: without Brendon, still refused at a dialog', r.isError && /not at Claude's prompt/.test(r.text) && typed.length === 2, r)
  screensBy.set(mainPane, [IDLE])
  const actedRelay = acted
  r = await call('session_send', { session: mainPane, text: 'The branch is ready for the release.' }, false)
  check('session_send: a relay run sends without Brendon', !r.isError && typed.length === 3 && typed[2].pane === mainPane && typed[2].text === 'The branch is ready for the release.' && acted > actedRelay, { r, typed })

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
  check('session_start: on record as Raven\'s before it typed', originMod.ravenStartedIds().has((created[1] as { newId: string }).newId), [...originMod.ravenStartedIds()])
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
  check('session_start: no model or effort asked, none passed', !('model' in odd) && !('effort' in odd) && r.json.model === undefined && r.json.effort === undefined, { odd, r })
  states.set(r.json.pane, 'gone')

  // model and effort: a key or id from Raven's model list, onto the new pane's claude
  r = await call('session_start', { target: 'work', prompt: 'model test', model: 'Sonnet', effort: 'low', watch: false })
  const picked = created[created.length - 1] as { model?: string; effort?: string }
  check('session_start: a model key becomes its id, with the effort', !r.isError && picked.model === 'claude-sonnet-5-5' && picked.effort === 'low'
    && r.json.model === 'claude-sonnet-5-5' && r.json.effort === 'low', { r, picked })
  states.set(r.json.pane, 'gone')
  r = await call('session_start', { target: 'work', prompt: 'model id test', model: 'claude-opus-5-5', watch: false })
  const byId = created[created.length - 1] as { model?: string; effort?: string }
  check('session_start: a model id from the list is taken as is, no effort', !r.isError && byId.model === 'claude-opus-5-5' && !('effort' in byId), { r, byId })
  states.set(r.json.pane, 'gone')
  const c0 = created.length
  const t1 = typed.length
  r = await call('session_start', { target: 'work', prompt: 'x', model: 'gpt-5' })
  check('session_start: a model off the list is refused, nothing started', r.isError && /no model "gpt-5"/.test(r.text) && /opus, sonnet, haiku/.test(r.text) && created.length === c0, r)
  r = await call('session_start', { target: 'work', prompt: 'x', effort: 'extreme' })
  check('session_start: an effort off the list fails the schema', r.isError && created.length === c0, r)
  r = await call('session_start', { target: 'personal', prompt: 'x', main: true, model: 'opus' })
  check('session_start: no model for a main already open, nothing typed', r.isError && /already running/.test(r.text) && created.length === c0 && typed.length === t1, r)
  r = await call('session_send', { session: mainPane, text: 'x', effort: 'high' })
  check('session_send: no effort for a session already running, nothing typed', r.isError && /already running/.test(r.text) && typed.length === t1, r)
  r = await call('session_send', { session: 'work', text: 'Start the work main', model: 'haiku', effort: 'max', watch: false })
  const workMain = created[created.length - 1] as { model?: string; effort?: string; target?: string }
  check('session_send: starting a main passes the model and effort', !r.isError && r.json.started === true && workMain.target === 'work'
    && workMain.model === 'claude-haiku-5-5' && workMain.effort === 'max' && r.json.model === 'claude-haiku-5-5', { r, workMain })
  r = await call('session_stop', { session: 'work' })
  check('session_stop: the work main closed again', !r.isError, r)
  {
    const tools = (await (await client({ fromBrendon: true })).listTools()).tools
    const start = tools.find((t) => t.name === 'session_start')
    const props = (start?.inputSchema as { properties?: Record<string, { enum?: string[] }> })?.properties ?? {}
    check('session_start: the schema offers the efforts, the description the models', props.effort?.enum?.join() === 'low,medium,high,xhigh,max'
      && 'model' in props && /opus, sonnet, haiku, fable-5-2, fable/.test(start?.description ?? ''), { props, d: start?.description })
  }

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
  check('ravenSessionsState: a main terminal sent to with no label keeps its own label, idle, no board copy needed',
    !!mainWatch?.sessionId && mainWatch.title === undefined && mainWatch.label === 'Personal' && mainWatch.state === 'idle' && Number.isFinite(Date.parse(mainWatch.lastAt)), mainWatch)
  ;(fakeIo as any).boardCached = () => [{ sessionId: mainWatch?.sessionId, title: 'Printer migration plan' }, { sessionId: 'other', title: 'Other' }]
  ioMod.setRavenToolsIo(fakeIo)
  const titled = (await tools.ravenSessionsState()).watching.find((w) => w.pane === mainPane)
  check('ravenSessionsState: Claude\'s own title never names the card', titled?.title === undefined && titled?.label === mainWatch?.label, titled)
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

  // Raven closes what it started with session_start on its own; his sessions stay gated
  {
    const startSid = (await fakeIo.listPanes()).find((p: TermSession) => p.name === startPane)?.sessionId ?? ''
    const actedBefore = acted
    r = await call('session_stop', { session: startPane }, false)
    check('session_stop: Raven closes its own session_start pane without Brendon', !r.isError && killed.includes(startPane) && r.json.markedDone === true && acted > actedBefore, r)
    check('session_stop: its own pane is marked done on the Desk and leaves the Watching list', doneMarks.includes(startSid) && !watch.getWatch(startPane) && !watch.listWatches().some((w) => w.sessionId === startSid), { doneMarks, w: watch.listWatches() })
    const atThor = thorStops.find((x) => x.sid === startSid)
    check('session_stop: its background work and Claude end on thor before the pane is killed', !!atThor && !atThor.killedThen.includes(startPane), thorStops)
    const card = (await tools.ravenSessionsState()).watching.find((w: { sessionId?: string }) => w.sessionId === startSid) as { state?: string } | undefined
    check('session_stop: it leaves the Watching card at once', !card, card)
    const k0 = killed.length
    r = await call('session_stop', { session: mainPane }, false)
    check('session_stop: his main terminal stays gated', r.isError && /Brendon's own message/.test(r.text) && killed.length === k0, r)
    r = await call('session_keep', { session: mainPane }, false)
    check('session_keep: never for his main terminal', r.isError && /only for a session you started/.test(r.text), r)
    const his = pane('vk-6666666666', 'His own work', 'work', '66666666-2222-4333-8444-555555555555')
    r = await call('session_stop', { session: his.name }, false)
    check('session_stop: a pane Brendon opened stays gated', r.isError && /Brendon's own message/.test(r.text) && killed.length === k0, r)
    r = await call('session_stop', { session: 'router' }, false)
    check('session_stop: a window on thor stays gated', r.isError && /Brendon's own message/.test(r.text), r)
    r = await call('session_stop', { session: 'no such thing' }, false)
    check('session_stop: an unknown name without Brendon gets the gate', r.isError && /Brendon's own message/.test(r.text), r)
    states.set(his.name, 'gone')
    r = await call('session_start', { target: 'work', prompt: 'quick job', watch: false })
    const quick = r.json.pane as string
    doneFails = true
    r = await call('session_stop', { session: quick }, false)
    check('session_stop: thor not answering still closes it, and says it is not marked done', !r.isError && killed.includes(quick) && r.json.markedDone === false && /not marked done/.test(r.json.note), r)
    doneFails = false
    // the pane already gone in tmux (no remain-on-exit) after thor ended its Claude: still stopped
    r = await call('session_start', { target: 'work', prompt: 'gone job', watch: false })
    const gonePane = r.json.pane as string
    const realKill = fakeIo.killPane
    fakeIo.killPane = async (p: string) => { states.set(p, 'gone'); return false }
    ioMod.setRavenToolsIo(fakeIo)
    r = await call('session_stop', { session: gonePane }, false)
    check('session_stop: thor ended it and the pane went with it, still stopped and marked done', !r.isError && r.json.markedDone === true, r)
    fakeIo.killPane = realKill
    ioMod.setRavenToolsIo(fakeIo)

    // session_done: the Sessions tab's done flag; his own sessions only when he asks
    r = await call('session_start', { target: 'work', prompt: 'another job', watch: false })
    const job = r.json.pane as string
    const jobSid = r.json.sessionId as string
    const m0 = doneMarks.length
    r = await call('session_done', { session: job }, false)
    check('session_done: Raven marks its own session done without Brendon, and leaves it running', !r.isError && r.json.done === true && r.json.sessionId === jobSid
      && doneMarks.at(-1) === jobSid && !killed.includes(job), r)
    r = await call('session_done', { session: jobSid }, false)
    check('session_done: by conversation id too', !r.isError && doneMarks.at(-1) === jobSid, r)
    const m1 = doneMarks.length
    r = await call('session_done', { session: mainPane }, false)
    check('session_done: his main terminal stays gated', r.isError && /Brendon's own message/.test(r.text) && doneMarks.length === m1, r)
    r = await call('session_done', { session: 'router' }, false)
    check('session_done: a window on thor he runs stays gated', r.isError && /Brendon's own message/.test(r.text) && doneMarks.length === m1, r)
    r = await call('session_done', { session: 'closed one' })
    check('session_done: with Brendon, a closed session by its title', !r.isError && r.json.session === 'Closed one' && doneMarks.at(-1) === '99999999-2222-4333-8444-555555555555', r)
    r = await call('session_done', { session: 'router firmware' })
    check('session_done: with Brendon, a running window on thor', !r.isError && doneMarks.at(-1) === BOARD_ID, r)
    r = await call('session_done', { session: 'nothing like it' })
    check('session_done: no match says so', r.isError && /no session matches/.test(r.text), r)
    doneFails = true
    r = await call('session_done', { session: job }, false)
    check('session_done: thor not answering is an error', r.isError && /not marked done/.test(r.text), r)
    doneFails = false
    check('session_done: marks only what was asked', doneMarks.length === m0 + 4, doneMarks.slice(m0))
    states.set(job, 'gone')
  }

  // stop
  const marks0 = doneMarks.length
  r = await call('session_stop', { session: 'personal' })
  check('session_stop: the main pane is killed, unwatched, unmapped', !r.isError && killed.includes(mainPane) && !watch.getWatch(mainPane), r)
  check('session_stop: his main is not marked done (he resumes it)', doneMarks.length === marks0 && r.json.markedDone === undefined, { doneMarks, r })
  check('session_stop: his main is not ended on thor either', !thorStops.some((x) => x.sid === main.newId), thorStops)
  r = await call('main_terminals')
  check('main_terminals: closed again', r.json[0].pane === null && r.json[0].state === 'closed', r.json)
  r = await call('session_stop', { session: 'router' })
  check('session_stop: not for windows on thor', r.isError && /never stops it/.test(r.text), r)
  for (const w of watch.listWatches()) watch.removeWatch(w.key)
}

// --------------------------------------------------------- the watcher ---

{
  posts.length = 0
  wakes.length = 0
  const tick = async (ms = 0) => { clock += ms; await watch.tickWatches() }
  type Said = { at: number; from: string; text: string }
  const saidIn = (w?: { payload: Record<string, unknown> }) => ((w?.payload.said ?? []) as Said[]).map((s) => `${s.from}:${s.text}`)
  const lastWake = () => wakes[wakes.length - 1]
  const sid = '22222222-3333-4444-8555-666666666666'
  const p = pane('vk-aaaaaaaaaa', 'Server work', 'server', sid)
  screensBy.set(p.name, [IDLE])
  // history before the watch never reaches Raven
  say(p.name, sid, entry('user', 'old prompt'), entry('assistant', 'An old answer.'))
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid })
  await tick(20_000)
  check('watch: history is not handed over', posts.length === 0 && wakes.length === 0, { posts, wakes })

  // an answer: held 12 s, then handed to Raven once with its prompt; nothing posts in the thread
  say(p.name, sid, entry('user', 'is nginx up?'))
  await tick(1_000)
  say(p.name, sid, entry('assistant', 'Yes, nginx is up.'))
  await tick(8_000)
  check('watch: the answer just arrived, held', wakes.length === 0, wakes)
  await tick(8_000)
  check('watch: 8 s of quiet is not enough', wakes.length === 0, wakes)
  await tick(8_000)
  check('watch: after 12 s of quiet the turn goes to Raven', wakes.length === 1 && wakes[0].kind === 'session_reply'
    && saidIn(wakes[0]).join('|') === 'prompt:is nginx up?|claude:Yes, nginx is up.' && wakes[0].payload.turnEnded === true, wakes)
  check('watch: the hand-off names the session', wakes[0]?.payload.pane === p.name && wakes[0].payload.label === 'Server work' && wakes[0].payload.sessionId === sid
    && !wakes[0].payload.asking && !wakes[0].payload.ended && !wakes[0].payload.followUp, wakes[0]?.payload)
  check('watch: nothing a session writes posts in the thread', posts.length === 0, posts)
  await tick(8_000)
  await tick(8_000)
  check('watch: never twice', wakes.length === 1, wakes)

  // narration, tools and the answer: every line, in order, once the spinner is gone. Claude's newest line can be the
  // answer, so a minute of spinner after it hands nothing over mid-turn
  say(p.name, sid, entry('user', 'restart it'), entry('assistant', 'Restarting nginx now.'), entry('tool'), entry('result'), entry('assistant', 'Done.'), entry('assistant', 'It came back in 2 s.'))
  screensBy.set(p.name, [BUSY])
  await tick(1_000)
  await tick(61_000)
  check('watch: held while the pane shows the spinner, the newest line too', wakes.length === 1, wakes.slice(1))
  screensBy.set(p.name, [IDLE])
  await tick(8_000)
  check('watch: every line of the turn, the narration too', wakes.length === 2 && wakes[1].kind === 'session_reply'
    && saidIn(wakes[1]).join('|') === 'prompt:restart it|claude:Restarting nginx now.|claude:Done.|claude:It came back in 2 s.', wakes.slice(1))

  // mid-turn: a line older than a minute, Claude in a tool step since, goes as progress; the rest at the turn's end
  say(p.name, sid, entry('user', 'build it'), entry('assistant', 'Building the frontend now.'), entry('tool'))
  screensBy.set(p.name, [BUSY])
  await tick(1_000)
  await tick(30_000)
  check('watch: mid-turn lines wait for a minute', wakes.length === 2, wakes.slice(2))
  await tick(31_000)
  check('watch: a minute on, mid-turn lines go as progress', wakes.length === 3 && wakes[2].kind === 'session_progress' && wakes[2].payload.turnEnded === false
    && saidIn(wakes[2]).join('|') === 'prompt:build it|claude:Building the frontend now.', wakes.slice(2))
  say(p.name, sid, entry('result'), entry('assistant', 'Built in 3 min.'))
  screensBy.set(p.name, [IDLE])
  await tick(1_000)
  await tick(13_000)
  check('watch: the turn end carries only what came after the progress', wakes.length === 4 && wakes[3].kind === 'session_reply'
    && saidIn(wakes[3]).join('|') === 'claude:Built in 3 min.', wakes.slice(3))

  // follow-up: on the turn's end, once; never on a progress batch
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid, followUp: 'If it failed, open a task' })
  say(p.name, sid, entry('user', 'check certs'), entry('assistant', 'Reading the certs.'), entry('tool'))
  screensBy.set(p.name, [BUSY])
  await tick(1_000)
  await tick(61_000)
  check('watch: a progress batch leaves the follow-up', lastWake()?.kind === 'session_progress' && !lastWake().payload.followUp && watch.getWatch(p.name)?.followUp === 'If it failed, open a task', lastWake())
  say(p.name, sid, entry('result'), entry('assistant', 'Certs expire in 60 days.'))
  screensBy.set(p.name, [IDLE])
  await tick(1_000)
  await tick(13_000)
  check('watch: the follow-up rides the turn end', lastWake()?.kind === 'session_reply' && lastWake().payload.followUp === 'If it failed, open a task'
    && saidIn(lastWake()).join('|') === 'claude:Certs expire in 60 days.', lastWake())
  const w0 = wakes.length
  say(p.name, sid, entry('user', 'thanks'), entry('assistant', 'Any time.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: the follow-up is used once', wakes.length === w0 + 1 && !lastWake().payload.followUp && saidIn(lastWake()).join('|') === 'prompt:thanks|claude:Any time.', lastWake())

  // a long line reaches Raven whole; a long prompt is context, its head is enough
  say(p.name, sid, entry('user', `dump it ${'p'.repeat(3000)}`), entry('assistant', 'x'.repeat(5000)))
  await tick(1_000)
  await tick(13_000)
  const long = (lastWake()?.payload.said ?? []) as Said[]
  check('watch: a long line is never cut', long.find((s) => s.from === 'claude')?.text.length === 5000, long.map((s) => s.text.length))
  check('watch: a long prompt keeps its head', (long.find((s) => s.from === 'prompt')?.text.length ?? 0) <= 1000, long.map((s) => s.text.length))

  // a question or permission prompt open after a tool step, nothing written: Raven hears it waits on him
  say(p.name, sid, entry('user', 'deploy it'), entry('tool'))
  screensBy.set(p.name, [DIALOG])
  const w1 = wakes.length
  await tick(1_000)
  await tick(13_000)
  check('watch: an open dialog after a tool step is a hand-off that asks', wakes.length === w1 + 1 && lastWake().payload.asking === true && lastWake().kind === 'session_reply'
    && saidIn(lastWake()).join('|') === 'prompt:deploy it', lastWake())
  await tick(8_000)
  await tick(8_000)
  check('watch: the same quiet spell is read once', wakes.length === w1 + 1, wakes.slice(w1))
  // a tool step that ends at the prompt with nothing written hands nothing over
  say(p.name, sid, entry('result'), entry('tool'))
  screensBy.set(p.name, [IDLE])
  await tick(1_000)
  await tick(13_000)
  check('watch: a quiet tool step at the prompt, nothing written, is not news', wakes.length === w1 + 1, wakes.slice(w1))

  // a turn that ended with a background shell still running says so
  say(p.name, sid, entry('result'), entry('assistant', 'Waiting on the release in the background.'))
  screensBy.set(p.name, [WAITING])
  await tick(1_000)
  await tick(13_000)
  check('watch: background work still out is in the hand-off', lastWake()?.payload.background === true && !lastWake().payload.asking, lastWake())
  screensBy.set(p.name, [IDLE])

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
  const before = wakes.length
  await tick(0)
  await tick(13_000)
  check('watch: after a rewind only the new lines', wakes.length === before + 1 && saidIn(lastWake()).join('|') === 'prompt:a different question|claude:A different answer.', wakes.slice(before))
  fakeIo.paneTranscript = origPT
  ioMod.setRavenToolsIo(fakeIo)

  // the pane dies: its last lines and the end go to Raven at once, and the watch is gone
  say(p.name, sid, entry('user', 'last one'), entry('assistant', 'Bye.'))
  states.set(p.name, 'dead')
  const b2 = wakes.length
  await tick(1_000)
  check('watch: a dying pane hands over its last lines and its end', wakes.length === b2 + 1 && wakes[b2].payload.ended === true && wakes[b2].kind === 'session_reply'
    && saidIn(wakes[b2]).join('|') === 'prompt:last one|claude:Bye.' && !watch.getWatch(p.name) && posts.length === 0, { wakes: wakes.slice(b2), posts })
  await tick(13_000)
  check('watch: nothing after the end', wakes.length === b2 + 1)

  // a window on thor: no pane, no spinner check
  const bsid = '33333333-3333-4444-8555-666666666666'
  say(`sid:${bsid}`, bsid, entry('user', 'earlier'))
  await watch.startWatch({ pane: '', label: 'Desk session', sessionId: bsid })
  say(`sid:${bsid}`, bsid, entry('assistant', 'Desk answer.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: a window on thor hands over by its conversation', lastWake()?.payload.pane === '' && lastWake().payload.sessionId === bsid && saidIn(lastWake()).join('|') === 'claude:Desk answer.', lastWake())

  // a fresh session: everything in it is news
  const fsid = '44444444-3333-4444-8555-666666666666'
  const fp = pane('vk-bbbbbbbbbb', 'Fresh one', 'work', fsid)
  screensBy.set(fp.name, [IDLE])
  await watch.startWatch({ pane: fp.name, label: fp.label, sessionId: fsid, fresh: true, title: 'Fresh job' })
  say(fp.name, fsid, entry('user', 'first prompt'), entry('assistant', 'First answer.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: a fresh session hands over its first turn, with the job', saidIn(lastWake()).join('|') === 'prompt:first prompt|claude:First answer.' && lastWake().payload.title === 'Fresh job', lastWake())

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
  const b3 = wakes.length
  await tick(1_000)
  await tick(13_000)
  check('watch: only what came after the watch', wakes.length === b3 + 1 && saidIn(wakes[b3]).join('|') === 'prompt:go|claude:After the watch.', wakes.slice(b3))
  fakeIo.paneTranscript = realPT
  ioMod.setRavenToolsIo(fakeIo)

  // 24 h with nothing new drops a watch without a word
  const b4 = wakes.length
  await tick(25 * 3_600_000)
  check('watch: stale watches drop silently', watch.listWatches().length === 0 && wakes.length === b4 && posts.length === 0, watch.listWatches())

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

  // a tool refreshing a watch while a pass hands it over: the lines and the follow-up go once
  const rsid = '66666666-3333-4444-8555-666666666666'
  const rp = pane('vk-dddddddddd', 'Race one', 'work', rsid)
  screensBy.set(rp.name, [IDLE])
  await watch.startWatch({ pane: rp.name, label: rp.label, sessionId: rsid, fresh: true, followUp: 'Tell him' })
  say(rp.name, rsid, entry('user', 'go'), entry('assistant', 'Raced answer.'))
  await tick(1_000)
  const w5 = wakes.length
  clock += 13_000
  const open5 = gated(rp.name)
  const pass5 = watch.tickWatches()
  await watch.startWatch({ pane: rp.name, label: rp.label, sessionId: rsid })
  open5()
  await pass5
  await tick(8_000)
  await tick(8_000)
  check('watch: a refresh during a pass hands over once', wakes.length === w5 + 1 && saidIn(wakes[w5]).join('|') === 'prompt:go|claude:Raced answer.' && wakes[w5].payload.followUp === 'Tell him', wakes.slice(w5))

  // a watch removed during a pass: nothing more from it
  say(rp.name, rsid, entry('user', 'again'), entry('assistant', 'Not wanted.'))
  await tick(1_000)
  const b6 = wakes.length
  clock += 13_000
  const open6 = gated(rp.name)
  const pass6 = watch.tickWatches()
  watch.removeWatch(rp.name)
  open6()
  await pass6
  check('watch: removed during a pass hands nothing over', wakes.length === b6, wakes.slice(b6))

  // more text after a hand-off, with no prompt or tool between: only the new part goes
  const msid = '77777777-3333-4444-8555-666666666666'
  say(`sid:${msid}`, msid, entry('user', 'earlier'))
  await watch.startWatch({ pane: '', label: 'Desk two', sessionId: msid })
  say(`sid:${msid}`, msid, entry('user', 'plan it'), entry('assistant', 'Part one.'))
  await tick(1_000)
  await tick(13_000)
  say(`sid:${msid}`, msid, entry('assistant', 'Part two.'))
  await tick(1_000)
  await tick(13_000)
  check('watch: a later part goes alone', saidIn(wakes[wakes.length - 2]).join('|') === 'prompt:plan it|claude:Part one.' && saidIn(lastWake()).join('|') === 'claude:Part two.', wakes.slice(-2))
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
  const b7 = wakes.length
  await tick(8_000)
  check('watch: dies while thor is unreadable, still ends', wakes.length === b7 + 1 && wakes[b7].payload.ended === true && saidIn(wakes[b7]).length === 0 && !watch.getWatch(dp.name),
    { wakes: wakes.slice(b7), w: watch.getWatch(dp.name) })
  fakeIo.paneTranscript = okPT
  ioMod.setRavenToolsIo(fakeIo)

  // Raven not running: mid-turn lines wait, the turn's answer posts raw as it did before, and the end posts its line
  hooks.setRavenWaker(null)
  const nsid = 'abababab-3333-4444-8555-666666666666'
  const np = pane('vk-gggggggggg', 'No Raven', 'work', nsid)
  screensBy.set(np.name, [BUSY])
  await watch.startWatch({ pane: np.name, label: np.label, sessionId: nsid, fresh: true })
  say(np.name, nsid, entry('user', 'go'), entry('assistant', 'Progress.'), entry('tool'))
  const p8 = posts.length
  await tick(1_000)
  await tick(61_000)
  check('no Raven: mid-turn lines are kept, nothing posts', posts.length === p8 && watch.getWatch(np.name)?.pending.length === 2, watch.getWatch(np.name)?.pending)
  say(np.name, nsid, entry('result'), entry('assistant', 'Final.'))
  screensBy.set(np.name, [IDLE])
  await tick(1_000)
  await tick(13_000)
  const raw = posts[p8]
  check('no Raven: the answer posts raw, with its link and a push', posts.length === p8 + 1 && raw.text === 'Progress.\n\nFinal.' && raw.opts?.meta?.relay?.kind === 'session'
    && raw.opts.meta.relay.from === np.name && raw.opts?.refs?.[0]?.url === `/m/ai/term/${np.name}` && raw.opts?.push === true && watch.getWatch(np.name)?.pending.length === 0, posts.slice(p8))
  states.set(np.name, 'dead')
  await tick(1_000)
  check('no Raven: an ended pane posts its line', posts.length === p8 + 2 && posts[p8 + 1].text === 'No Raven ended', posts.slice(p8))
  hooks.setRavenWaker((kind, payload) => { wakes.push({ kind, payload }) })

  // a watch stored before every line went to Raven: its unrelayed answer is unread, its old fields go
  store.setKv('raven:watches', JSON.stringify([{
    key: 'vk-hhhhhhhhhh', pane: 'vk-hhhhhhhhhh', label: 'Old one', sessionId: 'cdcdcdcd-3333-4444-8555-666666666666', since: new Date(clock).toISOString(),
    lastActivityAt: new Date(clock).toISOString(), cursor: '4', baselined: true, lastNewAt: clock, lastSeenAt: clock,
    tail: [{ id: 'o1', text: 'Sent before.' }, { id: 'o2', text: 'Not sent yet.' }], lastRelayedId: 'o1', followUp: '', title: '', status: '',
  }]))
  const old = watch.getWatch('vk-hhhhhhhhhh') as (ReturnType<typeof watch.getWatch> & { tail?: unknown; lastRelayedId?: unknown }) | null
  check('old watch: the unrelayed part is unread, the old fields gone', old?.pending.map((s) => `${s.from}:${s.text}`).join('|') === 'claude:Not sent yet.' && old.pendingSince > 0
    && old.tail === undefined && old.lastRelayedId === undefined, old)
  store.setKv('raven:watches', JSON.stringify([{ ...JSON.parse(store.getKv('raven:watches')!)[0], tail: [{ id: 'o1', text: 'Sent.' }], lastRelayedId: 'o1' }]))
  const idle = watch.getWatch('vk-hhhhhhhhhh')
  check('old watch: all relayed, its quiet spell already read', idle?.pending.length === 0 && idle.settledAt === idle.lastNewAt, idle)
  watch.removeWatch('vk-hhhhhhhhhh')

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

// ------------------------------------------- jobs: Raven closes what it started ---
// 2026-11-21: "iPad: match desktop dashboard layout" reported "I shipped v0.3.211" at 1:39 AM ET with no follow-up set,
// so no run read it, and a poll it left running kept its card on Working until he asked at 2:01 AM ET.

{
  posts.length = 0
  wakes.length = 0
  const MIN = 60_000
  const step = async (ms = 0) => { clock += ms; await watch.tickWatches(); return autoclose.closeQuietJobs() }
  const card = async (key: string) => (await tools.ravenSessionsState()).watching.find((w) => w.pane === key)
  const LEFTOVER = WAITING
  const start = async (label: string) => {
    const r = await call('session_start', { target: 'work', prompt: `Do the ${label} job and ship it`, label })
    const pane = r.json.pane as string
    away.add(pane)
    screensBy.set(pane, [IDLE])
    return { pane, sid: r.json.sessionId as string }
  }
  // an answer, relayed once the 12 s of quiet are over
  const answer = async (j: { pane: string; sid: string }, text: string, prompt = true) => {
    if (prompt) say(j.pane, j.sid, entry('user', 'go on'))
    say(j.pane, j.sid, entry('tool'), entry('assistant', text))
    await step(1_000)
    await step(13_000)
  }

  const job = await start('iPad: match desktop dashboard layout')
  check('session_start: a session it starts is a job', watch.getWatch(job.pane)?.job === true, watch.getWatch(job.pane))
  await answer(job, 'Release v0.3.211 is building on odin at nice 19. Waiting on the odin release to finish.')
  const w1 = wakes.at(-1)
  check('job: an answer wakes Raven with no follow-up set, marked a job', wakes.length === 1 && w1?.kind === 'session_reply' && w1.payload.job === true
    && w1.payload.pane === job.pane && w1.payload.title === 'iPad: match desktop dashboard layout' && /Waiting on the odin release/.test(JSON.stringify(w1.payload.said)), wakes)
  const relayAt = watch.getWatch(job.pane)?.relayedAt ?? 0
  check('job: the relay time is kept, and the close time is 15 minutes after it', relayAt === clock && watch.closesAt(watch.getWatch(job.pane)!) === relayAt + 15 * MIN, watch.getWatch(job.pane))
  {
    const snap = await tools.ravenSnapshot()
    check('snapshot: a job says it is Raven\'s to close and when it closes on its own', /a job you started \(session_stop it once it reports the job done\), closes on its own at .+ ET/.test(snap), snap)
  }

  // it waits on the release: Raven keeps it open
  let r = await call('session_keep', { session: job.pane, minutes: 30 }, false)
  check('session_keep: a relay run keeps its own job open', !r.isError && r.json.kept === job.pane && / ET$/.test(r.json.until), r)
  screensBy.set(job.pane, [LEFTOVER])
  let closed = await step(16 * MIN)
  check('job: kept, it is not closed 16 minutes after its answer', !closed.length && !!watch.getWatch(job.pane) && !killed.includes(job.pane), closed)
  check('card: kept, its background wait still reads Working', (await card(job.pane))?.state === 'working')

  // the final report, with its poll left running behind it
  await answer(job, 'I shipped v0.3.211. It gives the iPad the desktop dashboard layout and it is live now.')
  check('job: the final report wakes Raven too', wakes.length === 2 && wakes[1].payload.job === true && /I shipped v0\.3\.211/.test(JSON.stringify(wakes[1].payload.said)), wakes)
  const shippedAt = watch.getWatch(job.pane)!.relayedAt!
  closed = await step(14 * MIN)
  check('job: 14 minutes after its report it is still open', !closed.length && !!watch.getWatch(job.pane), closed)
  check('card: a background wait 14 minutes after the last activity is Working', (await card(job.pane))?.state === 'working')
  clock += MIN + 1_000
  check('card: a background wait quiet 15 minutes after the last answer reads Idle', (await card(job.pane))?.state === 'idle')
  const k0 = killed.length
  const p0 = posts.length
  closed = await step(0)
  check('auto-close: quiet 15 minutes after its report, it closes', closed.length === 1 && closed[0] === job.pane && killed.length === k0 + 1 && killed.at(-1) === job.pane, { closed, killed: killed.slice(k0) })
  const stop = thorStops.find((x) => x.sid === job.sid)
  check('auto-close: its leftover wait and Claude end on thor before the pane goes', !!stop && !stop.killedThen.includes(job.pane), thorStops)
  check('auto-close: marked done on the Desk, gone from Watching', doneMarks.includes(job.sid) && !watch.getWatch(job.pane) && !(await card(job.pane)), { doneMarks, w: watch.getWatch(job.pane) })
  const line = posts.slice(p0)
  check('auto-close: one quiet line in the thread, no buzz, no run', line.length === 1 && line[0].text === `iPad: match desktop dashboard layout closed and marked done: quiet for 15 minutes after its last answer (${utilMod.etClock(shippedAt)}).`
    && !line[0].opts?.push && line[0].opts?.meta?.relay?.from === job.pane && wakes.length === 2, { line, wakes: wakes.length })
  states.set(job.pane, 'gone')
  await step(8_000)
  check('auto-close: no "ended" line after it', posts.length === p0 + 1, posts.slice(p0))

  // without a keep, no background work: closed 15 minutes after the answer
  const plain = await start('Rotate the backup keys')
  await answer(plain, 'The backup keys are rotated and the old ones are revoked.')
  closed = await step(15 * MIN)
  check('auto-close: a job quiet 15 minutes with nothing left running closes too', closed.includes(plain.pane) && doneMarks.includes(plain.sid), closed)

  // never while he could be there, mid-turn, at a question, with text in its prompt
  const guard = await start('Guarded job')
  await answer(guard, 'Done with the guarded job.')
  clock += 16 * MIN
  const gp = panes.find((x) => x.name === guard.pane)!
  gp.clients = 1
  check('auto-close: never while a client is attached', !(await autoclose.closeQuietJobs()).length)
  gp.clients = 0
  away.delete(guard.pane)
  check('auto-close: never when he typed in it or opened it in the last 15 minutes', !(await autoclose.closeQuietJobs()).length)
  away.add(guard.pane)
  screensBy.set(guard.pane, [BUSY])
  check('auto-close: never while the spinner shows', !(await autoclose.closeQuietJobs()).length)
  screensBy.set(guard.pane, [DIALOG])
  check('auto-close: never at a question or a permission prompt', !(await autoclose.closeQuietJobs()).length)
  screensBy.set(guard.pane, [TYPED])
  check('auto-close: never with text typed in its prompt', !(await autoclose.closeQuietJobs()).length && !killed.includes(guard.pane))
  screensBy.set(guard.pane, [IDLE])
  // Raven types a follow-up into it: anything after the relay holds it off
  r = await call('session_send', { session: guard.pane, text: 'Now push the branch to GitHub as well.' }, false)
  check('auto-close: Raven typing into it after the relay holds it off', !r.isError && watch.closesAt(watch.getWatch(guard.pane)!) === null && !(await autoclose.closeQuietJobs()).length, watch.getWatch(guard.pane))
  say(guard.pane, guard.sid, entry('user', 'Now push the branch to GitHub as well.'))
  await step(1_000)
  check('auto-close: the new prompt in its transcript keeps it open', watch.closesAt(watch.getWatch(guard.pane)!) === null)
  r = await call('session_stop', { session: guard.pane }, false)
  check('session_stop: Raven stops its job in a relay run', !r.isError && r.json.markedDone === true && killed.includes(guard.pane), r)

  // only jobs: never his main terminal or a pane he opened, even with a watch that says job
  const forged = async (name: string, label: string, target: string, sid: string) => {
    const p = pane(name, label, target, sid)
    away.add(name)
    screensBy.set(name, [IDLE])
    await watch.startWatch({ pane: name, label, sessionId: sid, fresh: true, job: true })
    say(name, sid, entry('user', 'x'), entry('assistant', 'Finished.'))
    await step(1_000)
    await step(13_000)
    return p
  }
  const hisSid = 'dddddddd-3333-4444-8555-666666666666'
  const hisPane = await forged('vk-7777777777', 'His session', 'work', hisSid)
  r = await call('session_start', { target: 'personal', prompt: 'Main job', main: true, watch: false })
  const mainName = r.json.pane as string
  const mainSid = r.json.sessionId as string
  away.add(mainName)
  await watch.startWatch({ pane: mainName, label: 'Personal', sessionId: mainSid, fresh: true, job: true })
  say(mainName, mainSid, entry('user', 'x'), entry('assistant', 'Main finished.'))
  await step(1_000)
  await step(13_000)
  const kBefore = killed.length
  closed = await step(20 * MIN)
  check('auto-close: never a pane he opened, never his main terminal', !closed.length && killed.length === kBefore && !!watch.getWatch(hisPane.name) && !!watch.getWatch(mainName), { closed, killed: killed.slice(kBefore) })
  r = await call('session_keep', { session: hisPane.name }, false)
  check('session_keep: never for a pane he opened', r.isError && /only for a session you started/.test(r.text), r)
  watch.removeWatch(hisPane.name)
  watch.removeWatch(mainName)
  states.set(hisPane.name, 'gone')
  r = await call('session_stop', { session: 'personal' })
  states.set(mainName, 'gone')

  // a main terminal Raven started is no job, and its answers wake nobody without a follow-up
  r = await call('session_send', { session: 'work', text: 'Look at the queue', label: 'Queue check' })
  const workMain = r.json.pane as string
  const wBefore = wakes.length
  say(workMain, (await fakeIo.listPanes()).find((p: TermSession) => p.name === workMain)!.sessionId, entry('user', 'Look at the queue'), entry('assistant', 'The queue is empty.'))
  await step(1_000)
  await step(13_000)
  check('main terminal: not a job; its turn reaches Raven with no close request', !watch.getWatch(workMain)?.job && wakes.length === wBefore + 1 && !wakes.at(-1)!.payload.job
    && /The queue is empty\./.test(JSON.stringify(wakes.at(-1)!.payload.said)), { w: watch.getWatch(workMain), wakes: wakes.slice(wBefore) })
  await call('session_stop', { session: 'work' })

  // a job that ends by itself hands its last answer to Raven without asking Raven to close it
  const ends = await start('Ends by itself')
  say(ends.pane, ends.sid, entry('user', 'go'), entry('assistant', 'All done here.'))
  await step(1_000)
  states.set(ends.pane, 'dead')
  const wEnd = wakes.length
  await step(13_000)
  check('job: a pane that ended hands over its answer, with no close request', wakes.length === wEnd + 1 && wakes.at(-1)!.payload.ended === true && !wakes.at(-1)!.payload.job
    && /All done here\./.test(JSON.stringify(wakes.at(-1)!.payload.said)) && !posts.some((x) => x.text === 'All done here.') && !watch.getWatch(ends.pane), wakes.slice(wEnd))
  states.set(ends.pane, 'gone')

  // thor not answering: still closed, and the line says it is not marked done
  const dark = await start('Dark job')
  await answer(dark, 'Dark job is done.')
  thorStopAnswer = 'failed'
  doneFails = true
  const pDark = posts.length
  closed = await step(15 * MIN)
  check('auto-close: thor not answering still closes the pane, and says it is not marked done', closed.includes(dark.pane)
    && /^Dark job closed: quiet for 15 minutes after its last answer \(.+ ET\)\. It is not marked done on the Desk yet: thor did not answer\.$/.test(posts.slice(pDark).at(-1)?.text ?? ''), posts.slice(pDark))
  thorStopAnswer = 'stopped'
  doneFails = false

  for (const w of watch.listWatches()) watch.removeWatch(w.key)
}

// --------------------------------------- closed sessions: list and recover ---
// 2026-11-24, Brendon: "use the existing X session" when X is closed made Raven start a duplicate or ask him to tap
// Recover. sessions_closed lists the Desk's closed, not done sessions; session_recover reopens one, or a whole area.

{
  posts.length = 0
  wakes.length = 0
  const MIN = 60_000
  const iso = (agoMs: number) => new Date(clock - agoMs).toISOString()
  const ids = {
    laptop: 'aaaaaaaa-1111-4111-8111-000000000001', printer: 'aaaaaaaa-1111-4111-8111-000000000002',
    garden: 'aaaaaaaa-1111-4111-8111-000000000003', old: 'aaaaaaaa-1111-4111-8111-000000000004',
    mine: 'aaaaaaaa-1111-4111-8111-000000000005', live: 'aaaaaaaa-1111-4111-8111-000000000006',
  }
  const rows = [
    { sessionId: ids.laptop, title: 'Laptop data recovery', area: 'work', live: false, activity: 'closed', disposition: 'open', host: 'thor', lastActivityUtc: iso(1 * 3_600_000), cwd: 'C:\\Work\\Docs' },
    { sessionId: ids.printer, title: 'Printer queue cleanup', area: 'work', live: false, activity: 'closed', disposition: 'open', host: 'thor', lastActivityUtc: iso(2 * 3_600_000) },
    { sessionId: ids.garden, title: 'Garden irrigation plan', area: 'north', live: false, activity: 'closed', disposition: 'open', host: 'thor', lastActivityUtc: iso(3 * 3_600_000) },
    { sessionId: ids.old, title: 'Old finished printer thing', area: 'work', live: false, activity: 'closed', disposition: 'done', host: 'thor', lastActivityUtc: iso(4 * 3_600_000) },
    { sessionId: ids.mine, title: 'Raven research job', area: 'personal', live: false, activity: 'closed', disposition: 'open', host: 'thor', lastActivityUtc: iso(5 * 3_600_000) },
    { sessionId: ids.live, title: 'Live printer window', area: 'work', live: true, activity: 'idle', disposition: 'open', host: 'thor', lastActivityUtc: iso(60_000) },
  ]
  const added = rows.length
  board.push(...rows)
  originMod.noteRavenStarted(ids.mine, clock)
  say(`sid:${ids.laptop}`, ids.laptop, entry('user', 'recover the photos'), entry('assistant', 'Recovered 4,210 photos to the NAS.\nThe Desktop folder is next.'))

  // the list
  let r = await call('sessions_closed', {}, false)
  const listed = (r.json?.sessions ?? []).map((x: { sessionId: string }) => x.sessionId)
  check('sessions_closed: no gate, the Desk\'s closed not done, newest first', !r.isError && listed[0] === ids.laptop && listed.includes(ids.garden) && listed.includes(ids.mine)
    && !listed.includes(ids.old) && !listed.includes(ids.live), r.json)
  const v = r.json.sessions[0]
  check('sessions_closed: id, title, area by the Desk\'s name, closed in ET, folder, last answer', v.title === 'Laptop data recovery' && v.area === 'Work'
    && / ET$/.test(v.closed) && v.folder === 'Docs' && v.lastAnswer === 'Recovered 4,210 photos to the NAS. The Desktop folder is next.', v)
  check('sessions_closed: personal reads Thor, one Raven started says so', r.json.sessions.some((x: { sessionId: string; area: string; startedBy?: string }) => x.sessionId === ids.mine && x.area === 'Thor' && x.startedBy === 'raven'), r.json.sessions)
  check('sessions_closed: counts per area', r.json.byArea.some((x: { area: string; n: number }) => x.area === 'Work' && x.n === 2), r.json.byArea)
  r = await call('sessions_closed', { area: 'work' })
  check('sessions_closed: by area key', !r.isError && r.json.closed === 2 && r.json.sessions.every((x: { area: string }) => x.area === 'Work'), r.json)
  r = await call('sessions_closed', { area: 'Thor' })
  check('sessions_closed: by area name (personal is Thor)', !r.isError && r.json.sessions.some((x: { sessionId: string }) => x.sessionId === ids.mine) && r.json.sessions.every((x: { area: string }) => x.area === 'Thor'), r.json)
  r = await call('sessions_closed', { area: 'Mars' })
  check('sessions_closed: an unknown area says which have closed ones', r.json === null && /No closed, not done sessions in "Mars"\. Closed ones by area: .*Work 2/.test(r.text), r.text)
  r = await call('sessions_closed', { query: 'printer', answers: false })
  check('sessions_closed: by part of the title, no answers read', r.json?.closed === 1 && r.json.sessions[0].sessionId === ids.printer && r.json.sessions[0].lastAnswer === undefined, r.json)
  r = await call('sessions')
  check('sessions: counts the closed ones per area', /Work 2/.test(r.json?.closed?.byArea ?? '') && r.json.closed.total >= 4, r.json?.closed)

  // one session, by part of its title
  const before = acted
  r = await call('session_recover', { session: 'laptop', label: 'Photo recovery status' })
  const lPane = r.json?.pane as string
  check('session_recover: reopens it as the Desk does, at its prompt', !r.isError && /^vk-/.test(lPane) && r.json.state === 'idle' && r.json.sessionId === ids.laptop
    && r.json.area === 'Work' && r.json.watching === true && acted > before, r)
  check('session_recover: a resume of that conversation under its own title', resumed.at(-1)?.sessionId === ids.laptop && resumed.at(-1)?.label === 'Laptop data recovery'
    && resumed.at(-1)?.cols === 120 && resumed.at(-1)?.rows === 40 && !created.some((c) => c.newId === ids.laptop), resumed.at(-1))
  const wv = watch.getWatch(lPane)
  check('session_recover: watched as a job of his it reopened, old answers not news', wv?.job === true && wv.reopened === true && wv.baselined === true && wv.title === 'Photo recovery status', wv)
  check('session_recover: his session stays his on the Desk', !originMod.ravenStartedIds().has(ids.laptop))
  let state = await tools.ravenSessionsState()
  check('session_recover: on the Watching card', state.watching.some((w) => w.pane === lPane && w.title === 'Photo recovery status' && w.state === 'idle'), state.watching)
  r = await call('sessions_closed', { area: 'Work' })
  check('sessions_closed: a reopened one leaves the list', r.json.closed === 1 && r.json.sessions[0].sessionId === ids.printer, r.json)

  // already running: the same pane, nothing new
  const n0 = resumed.length
  r = await call('session_recover', { session: 'laptop' })
  check('session_recover: already open answers that pane', !r.isError && r.json.pane === lPane && r.json.already === true && resumed.length === n0, r)
  r = await call('session_recover', { session: ids.laptop })
  check('session_recover: by conversation id too', r.json?.pane === lPane && r.json.already === true && resumed.length === n0, r)
  r = await call('session_recover', { session: 'live printer' })
  check('session_recover: running in a window on thor opens nothing', !r.isError && r.json.already === true && r.json.sessionId === ids.live && /session_send/.test(r.json.note) && resumed.length === n0, r)

  // work in it, then close it: Raven's to close, his to keep not done
  r = await call('session_send', { session: lPane, text: 'status?' }, false)
  check('session_recover: session_send types into it right after', !r.isError && typed.at(-1)?.pane === lPane && typed.at(-1)?.text === 'status?', r)
  away.add(lPane)
  say(lPane, ids.laptop, entry('tool'), entry('assistant', 'Status: 4,210 photos recovered, the Desktop folder copy is at 60%.'))
  await watch.tickWatches()
  clock += 13_000
  await watch.tickWatches()
  const wk = wakes.at(-1)
  check('session_recover: its answer wakes Raven as a job it reopened', wk?.kind === 'session_reply' && wk.payload.pane === lPane && wk.payload.job === true && wk.payload.reopened === true, wakes)
  const m0 = doneMarks.length
  r = await call('session_keep', { session: lPane, minutes: 30 }, false)
  check('session_keep: allowed for one it reopened', !r.isError && r.json.kept === lPane, r)
  r = await call('session_stop', { session: lPane }, false)
  check('session_stop: one it reopened closes without Brendon, not marked done', !r.isError && r.json.stopped === lPane && r.json.markedDone === false && /closed list/.test(r.json.note)
    && doneMarks.length === m0 && killed.includes(lPane) && thorStops.some((x) => x.sid === ids.laptop) && !watch.getWatch(lPane), r)
  r = await call('session_done', { session: ids.laptop }, false)
  check('session_done: one it reopened, closed again, it may mark without Brendon', !r.isError && doneMarks.at(-1) === ids.laptop, r)
  doneMarks.splice(m0)
  r = await call('session_done', { session: ids.printer }, false)
  check('session_done: a closed one it never reopened stays gated', r.isError && /Brendon's own message/.test(r.text), r)

  // a session marked done: only by its exact id
  r = await call('session_recover', { session: 'old finished' })
  check('session_recover: a done one is refused by its title', r.isError && /marked done/.test(r.text) && r.text.includes(ids.old) && resumed.length === n0, r)
  r = await call('session_recover', { session: 'printer' })
  check('session_recover: two that match are refused with their ids', r.isError && /matches 2 sessions/.test(r.text) && r.text.includes(ids.printer) && r.text.includes(ids.live), r)
  r = await call('session_recover', { session: ids.old, watch: false })
  const oPane = r.json?.pane as string
  check('session_recover: a done one by its exact id, said so, unwatched', !r.isError && r.json.wasDone === true && resumed.at(-1)?.sessionId === ids.old && !watch.getWatch(oPane), r)
  r = await call('session_stop', { session: oPane }, false)
  check('session_stop: unwatched, it is still Raven\'s to close', !r.isError && r.json.markedDone === false, r)
  r = await call('session_recover', { session: 'nothing like it' })
  check('session_recover: no match says where to look', r.isError && /sessions_closed/.test(r.text), r)
  r = await call('session_recover', {})
  check('session_recover: a session or an area', r.isError && /one of them/.test(r.text), r)

  // a pane that dies at once: refused, unwatched
  const realResume = fakeIo.resumePane
  fakeIo.resumePane = async (o) => { const name = await realResume(o); states.set(name, 'dead'); return name }
  ioMod.setRavenToolsIo(fakeIo)
  r = await call('session_recover', { session: 'garden' })
  const dPane = resumed.at(-1) && watch.listWatches().find((w) => w.sessionId === ids.garden)
  check('session_recover: a pane that ends at once is an error, not watched', r.isError && /ended right after it opened/.test(r.text) && !dPane, r)
  fakeIo.resumePane = realResume
  ioMod.setRavenToolsIo(fakeIo)

  // a whole area, as the Desk's Recover Work
  const k0 = resumed.length
  const c0 = clock
  r = await call('session_recover', { area: 'Work' })
  const got = (r.json?.sessions ?? []) as { pane: string; sessionId: string; state: string }[]
  check('session_recover area: every closed, not done one there, newest first', !r.isError && r.json.area === 'Work' && r.json.reopened === 2 && r.json.of === 2
    && got[0].sessionId === ids.laptop && got[1].sessionId === ids.printer && got.every((x) => x.state === 'idle') && resumed.length === k0 + 2, r.json)
  check('session_recover area: a gap between the logins', clock - c0 >= 700, clock - c0)
  check('session_recover area: each watched as one it reopened', got.every((x) => watch.getWatch(x.pane)?.reopened === true), watch.listWatches())
  state = await tools.ravenSessionsState()
  check('session_recover area: all on the Watching card', got.every((x) => state.watching.some((w) => w.pane === x.pane)), state.watching)

  // auto-close: quiet 15 minutes after an answer, closed and left not done
  const pw = got[1]
  away.add(pw.pane)
  screensBy.set(pw.pane, [IDLE])
  say(pw.pane, ids.printer, entry('user', 'status?'), entry('tool'), entry('assistant', 'The queue is clear.'))
  await watch.tickWatches()
  clock += 13_000
  await watch.tickWatches()
  const d0 = doneMarks.length
  const pc = posts.length
  const shut = await autoclose.closeQuietJobs().then(async () => { clock += 15 * MIN; await watch.tickWatches(); return autoclose.closeQuietJobs() })
  check('auto-close: one it reopened closes on its own, not marked done', shut.includes(pw.pane) && doneMarks.length === d0
    && /back on the Desk's closed list, not marked done\.$/.test(posts.slice(pc).at(-1)?.text ?? ''), { shut, posts: posts.slice(pc) })

  // a full pane list stops an area recover
  for (const x of got) if (states.get(x.pane) !== 'gone') { states.set(x.pane, 'gone'); watch.removeWatch(x.pane) }
  resumeThrows = Object.assign(new Error('32 sessions already open (max 32) \u2014 close one first'), { status: 409 })
  r = await call('session_recover', { area: 'work' })
  check('session_recover area: a full pane list stops it and says so', !r.isError && r.json.reopened === 0 && /no room for more terminals/.test(r.json.stopped), r.json)
  resumeThrows = null
  boardUp = false
  // past the 20 s copy of thor's list
  clock += 21_000
  r = await call('session_recover', { session: ids.garden })
  check('session_recover: thor\'s list not answering opens nothing', r.isError && /not answering/.test(r.text), r)
  boardUp = true

  for (const w of watch.listWatches()) watch.removeWatch(w.key)
  board.splice(board.length - added, added)
}

// ------------------------------------------- a turn the transcript holds open ---

// vk-9bbd600d87 and vk-bbdcd8078f, 2026-11-21 2:48 AM ET: in the middle of a job, a progress line and then a long
// Edit or Bash with nothing new in the transcript; the screen's busy line was one the old rule did not know. Watching
// showed them Idle and Raven heard "Its turn is over".
{
  posts.length = 0
  wakes.length = 0
  const tick = async (ms = 0) => { clock += ms; await watch.tickWatches() }
  const card = async (key: string) => (await tools.ravenSessionsState()).watching.find((w) => (w.pane || `sid:${w.sessionId}`) === key)
  type Said = { from: string; text: string }
  const saidIn = (w?: { payload: Record<string, unknown> }) => ((w?.payload.said ?? []) as Said[]).map((s) => `${s.from}:${s.text}`)
  const replies = () => wakes.filter((w) => w.kind === 'session_reply')
  const stopped = (e: TranscriptEntry, stop: string): TranscriptEntry => ({ ...e, stop })
  const midTurn = (text: string) => stopped(entry('assistant', text), 'tool_use')
  const step = () => stopped(entry('tool'), 'tool_use')
  // 2.1.322's busy line, no "esc to interrupt": just above the prompt box
  const SPIN = IDLE.replace(/^(?=─{20,})/m, '✶ Zigzagging… (12m 18s · ↓ 54.7k tokens · still thinking with xhigh effort)\n\n')
  check('busy rule 2.1.322: the fixture\'s spinner line is busy, the idle screen is not', paneStateMod.screenBusy(SPIN) && !paneStateMod.screenBusy(IDLE) && !paneStateMod.screenBusy(DIALOG))

  const sid = 'bbbbbbbb-3333-4444-8555-666666666666'
  const p = pane('vk-0pen00turn', 'Watch: monitor every service', 'server', sid)
  screensBy.set(p.name, [IDLE])
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid })
  say(p.name, sid, entry('user', 'monitor every service'), midTurn('Merges. Now the report sync edits (views, daily snapshot, down time, page read).'), step())
  await tick(1_000)
  await tick(13_000)
  await tick(8_000)
  check('open turn: a progress line and a tool still running, quiet with no spinner, is no turn end', replies().length === 0, wakes)
  check('open turn: Watching shows it working', (await card(p.name))?.state === 'working', await card(p.name))
  await tick(40_000)
  check('open turn: a minute on, its lines go as progress', wakes.length === 1 && wakes[0].kind === 'session_progress' && wakes[0].payload.turnEnded === false
    && saidIn(wakes[0]).join('|') === 'prompt:monitor every service|claude:Merges. Now the report sync edits (views, daily snapshot, down time, page read).', wakes)

  // the tool's result came back and the newest line stopped for a tool: still mid-turn, so it goes as progress, never as the end
  say(p.name, sid, entry('result'), midTurn('The report part is written and type-checks.'))
  await tick(1_000)
  await tick(13_000)
  check('open turn: a newest line that stopped for a tool is no turn end', replies().length === 0, wakes)
  check('open turn: Watching still shows it working', (await card(p.name))?.state === 'working')
  await tick(50_000)
  check('open turn: that line goes as progress after a minute', wakes.length === 2 && wakes[1].kind === 'session_progress' && saidIn(wakes[1]).join('|') === 'claude:The report part is written and type-checks.', wakes)

  // the answer: its message ended the turn, so the quiet check hands it over
  say(p.name, sid, step(), entry('result'), stopped(entry('assistant', 'All four connectors write their daily trends now.'), 'end_turn'))
  await tick(1_000)
  await tick(13_000)
  check('open turn: the answer ends the turn', replies().length === 1 && wakes.at(-1)?.kind === 'session_reply' && saidIn(wakes.at(-1)).join('|') === 'claude:All four connectors write their daily trends now.', wakes.slice(2))
  check('open turn: Watching shows it idle after the answer', (await card(p.name))?.state === 'idle', await card(p.name))

  // an older build's lines say no stop reason: 2.1.322's spinner line on the screen holds the turn instead
  say(p.name, sid, entry('user', 'and the video line'), entry('assistant', 'Reading the video records.'))
  screensBy.set(p.name, [SPIN])
  await tick(1_000)
  await tick(13_000)
  await tick(8_000)
  check('open turn: the 2.1.322 spinner line holds a turn whose lines say no stop reason', replies().length === 1, wakes.slice(2))
  check('open turn: Watching shows the 2.1.322 spinner as working', (await card(p.name))?.state === 'working')
  screensBy.set(p.name, [IDLE])
  await tick(8_000)
  check('open turn: the spinner gone, the turn ends', replies().length === 2 && saidIn(wakes.at(-1)).join('|') === 'prompt:and the video line|claude:Reading the video records.', wakes.slice(2))

  // an open tool step with a dialog on the screen waits on him: handed over as asking, and Watching does not say working
  say(p.name, sid, entry('user', 'delete the old builds'), midTurn('Removing the old build folders.'), step())
  screensBy.set(p.name, [DIALOG])
  await tick(1_000)
  await tick(13_000)
  check('open turn: a dialog on an open step is handed over as asking', replies().length === 3 && wakes.at(-1)?.payload.asking === true, wakes.at(-1))
  check('open turn: Watching does not show a turn waiting on him as working', (await card(p.name))?.state === 'idle', await card(p.name))
  screensBy.set(p.name, [IDLE])

  // a turn the transcript never closed (Claude killed mid-step) stops counting after 15 quiet minutes
  say(p.name, sid, entry('result'), midTurn('Checking the disk.'), step())
  await tick(1_000)
  await tick(13_000)
  check('open turn: held while it is fresh', replies().length === 3)
  await tick(15 * 60_000)
  check('open turn: 15 quiet minutes on, it is read as over', replies().length === 4 && saidIn(wakes.at(-1)).join('|').endsWith('claude:Checking the disk.'), wakes.at(-1))
  check('open turn: and Watching shows it idle', (await card(p.name))?.state === 'idle')

  // an interrupt closes the turn
  say(p.name, sid, entry('user', 'try again'), midTurn('Trying again.'), step(), entry('result'), entry('system', 'Interrupted'))
  await tick(1_000)
  await tick(13_000)
  check('open turn: an interrupt ends it', replies().length === 5 && saidIn(wakes.at(-1)).join('|') === 'prompt:try again|claude:Trying again.', wakes.at(-1))

  // a session watched in the middle of a job is working from the first read
  const msid = 'cccccccc-3333-4444-8555-666666666666'
  const mp = pane('vk-0pen00mid1', 'Thor 3D model', 'server', msid)
  screensBy.set(mp.name, [IDLE])
  say(mp.name, msid, entry('user', 'label the fan and M.2 slots'), midTurn('Now System > Hosts: each disk plate lights its own slot.'), step())
  await watch.startWatch({ pane: mp.name, label: mp.label, sessionId: msid })
  check('open turn: a session watched mid-job shows working at once', (await card(mp.name))?.state === 'working', await card(mp.name))

  // a window on thor has no screen: thor's board says when it waits on him
  const tsid = 'dddddddd-3333-4444-8555-666666666666'
  say(`sid:${tsid}`, tsid, entry('user', 'earlier'), entry('assistant', 'Earlier answer.'))
  await watch.startWatch({ pane: '', label: 'Desk session', sessionId: tsid })
  say(`sid:${tsid}`, tsid, entry('user', 'clean up'), midTurn('Cleaning up.'), step())
  const before = replies().length
  await tick(1_000)
  await tick(13_000)
  check('open turn: a window on thor mid-step is no turn end', replies().length === before, wakes.at(-1))
  ;(fakeIo as any).boardCached = () => [{ sessionId: tsid, live: true, activity: 'asking' }]
  ioMod.setRavenToolsIo(fakeIo)
  await tick(8_000)
  check('open turn: a window on thor the board says asks is handed over as asking', replies().length === before + 1 && wakes.at(-1)?.payload.asking === true, wakes.at(-1))
  delete (fakeIo as any).boardCached
  ioMod.setRavenToolsIo(fakeIo)

  for (const w of watch.listWatches()) watch.removeWatch(w.key)
}

// ------------------------------------------------------ the Watching card ---

{
  const tick = async (ms = 0) => { clock += ms; await watch.tickWatches() }
  const card = async (key: string) => (await tools.ravenSessionsState()).watching.find((w) => (w.pane || `sid:${w.sessionId}`) === key)
  const titleNow = (key: string) => watch.getWatch(key)?.title
  check('statusOf: the first sentence, its markdown gone', watch.statusOf('**v0.3.209 is out.** It published at 11:40 PM ET.\n\nMore.') === 'v0.3.209 is out.', watch.statusOf('**v0.3.209 is out.** It published at 11:40 PM ET.'))
  check('statusOf: a list lead and code ticks go, a version number is no sentence end', watch.statusOf('- Built `v0.3.208` on odin. Next.') === 'Built v0.3.208 on odin.', watch.statusOf('- Built `v0.3.208` on odin. Next.'))
  check('statusOf: a first sentence too long for one line is left out', watch.statusOf(`${'word '.repeat(40)}end.`) === '')

  // a pane Raven types a job into: Raven's label names the card, and nothing in the transcript renames it
  const sid = 'aaaaaaaa-3333-4444-8555-666666666666'
  const p = pane('vk-1111111111', 'Server work', 'server', sid)
  screensBy.set(p.name, [IDLE])
  let r = await call('session_send', { session: p.name, text: 'Brendon asks: rotate the nginx certificates on odin tonight', label: 'Rotate nginx certs' })
  check('session_send: the label names the job', !r.isError && titleNow(p.name) === 'Rotate nginx certs', { r, w: watch.getWatch(p.name) })
  say(p.name, sid, entry('user', 'Brendon asks: rotate the nginx certificates on odin tonight'), entry('assistant', 'On it. Starting with the cert on odin.'))
  const said = clock
  await tick(1_000)
  check('watch: Raven\'s own prompt keeps Raven\'s name for the job', titleNow(p.name) === 'Rotate nginx certs', watch.getWatch(p.name))
  let c = await card(p.name)
  check('card: the label over the pane, its status line under it, idle, last activity its newest transcript line',
    c?.title === 'Rotate nginx certs' && c.label === 'Server work' && c.status === 'On it.' && c.state === 'idle' && Date.parse(c.lastAt) === said, c)
  screensBy.set(p.name, [BUSY])
  check('card: working while the spinner shows', (await card(p.name))?.state === 'working')
  screensBy.set(p.name, [IDLE])

  // waiting on background work: working while it runs, quiet or printing, then idle once it is done
  quiet.add(p.name)
  screensBy.set(p.name, [WAITING])
  clock += 6_000
  check('card: a quiet pane with a background shell running is working', (await card(p.name))?.state === 'working')
  screensBy.set(p.name, [WAITED])
  check('card: a quiet pane\'s screen is read again only after 5 s', (await card(p.name))?.state === 'working')
  clock += 6_000
  check('card: the background shell done and nothing printed, idle', (await card(p.name))?.state === 'idle')
  quiet.delete(p.name)
  screensBy.set(p.name, [WAITING])
  check('card: a printing pane with a background shell running is working', (await card(p.name))?.state === 'working')
  check('the waiting rule: only the footer counts, and not the other sessions\' "← 5 agents"',
    paneStateMod.screenWaiting(WAITING) && !paneStateMod.screenWaiting(WAITED) && !paneStateMod.screenWaiting(IDLE) && !paneStateMod.screenWaiting(BUSY)
      && !paneStateMod.screenWaiting('  Ran 4 shell commands\n1 shell still running'))
  check('the waiting rule: a running background agent under the footer',
    paneStateMod.screenWaiting(`${WAITED}\n                    ● main\n  ( ) general-purpose  Footer probe agent         2s · ↓ 29.3k tokens\n`))
  check('the waiting rule: a monitor beside a shell', paneStateMod.screenWaiting(WAITED.replace('· ← 5', '· 1 shell, 1 monitor · /tasks to see subagents · ← 5')))
  check('Desk tabs: a waiting pane stays idle there', !(await paneStateMod.paneBusy({ name: p.name, dead: false, activityAt: clock, outputAt: clock }, async () => WAITING, clock)))
  screensBy.set(p.name, [IDLE])

  // prompts and answers never rename it: his own prompt, a Raven follow-up, an answer that reads like a headline
  say(p.name, sid, entry('user', 'now check the disk usage on the backup volume'))
  await tick(1_000)
  check('watch: a prompt he typed does not rename the card, and clears the old status', titleNow(p.name) === 'Rotate nginx certs' && !(await card(p.name))?.status, watch.getWatch(p.name))
  say(p.name, sid, entry('assistant', `"hor" was a typo for "thor", the PC where his sessions run, so I read it as thor and ${'went on with the job '.repeat(6)}.`))
  await tick(1_000)
  c = await card(p.name)
  check('card: an answer never names it, and a long first sentence shows no status', c?.title === 'Rotate nginx certs' && c.status === undefined, c)
  say(p.name, sid, entry('assistant', 'v0.3.208 published at 11:16 PM ET. Odin is free.'))
  await tick(1_000)
  c = await card(p.name)
  check('card: a release headline is a status line, never the title', c?.title === 'Rotate nginx certs' && c.status === 'v0.3.208 published at 11:16 PM ET.', c)
  r = await call('session_send', { session: p.name, text: 'Brendon approved: go ahead and delete the old snapshots' })
  check('session_send: a follow-up with no label keeps the name', !r.isError && titleNow(p.name) === 'Rotate nginx certs', titleNow(p.name))
  r = await call('session_send', { session: p.name, text: 'Brendon asks: now recover the sessions list on the Desk', label: 'Desk: recover sessions list' })
  check('session_send: a new label renames it', !r.isError && (await card(p.name))?.title === 'Desk: recover sessions list', titleNow(p.name))
  // a session with no label: its pane label, never the prompt Raven types
  const nsid = 'cccccccc-3333-4444-8555-666666666666'
  const np = pane('vk-3333333333', 'Nameless', 'server', nsid)
  screensBy.set(np.name, [IDLE])
  r = await call('session_send', { session: np.name, text: "Brendon's request: list the failed cron jobs from last night" })
  const nc = await card(np.name)
  check('session_send: no label, the card shows the pane label', !r.isError && !titleNow(np.name) && nc?.title === undefined && nc?.label === 'Nameless', { w: watch.getWatch(np.name), nc })
  watch.removeWatch(np.name)
  states.set(np.name, 'gone')

  // the pane ends: its card goes at once; watched again, it is back
  states.set(p.name, 'dead')
  c = await card(p.name)
  check('card: a dead pane still watched is not listed', !!watch.getWatch(p.name) && !c, c)
  await tick(8_000)
  check('card: an ended pane leaves Watching at once', !watch.getWatch(p.name) && !(await card(p.name)))
  states.set(p.name, 'live')
  await watch.startWatch({ pane: p.name, label: p.label, sessionId: sid })
  check('card: watched again, back on the card', (await card(p.name))?.state === 'idle')
  states.set(p.name, 'dead')
  await tick(8_000)
  check('card: ended again, gone again', !(await card(p.name)))

  // a window on thor: its label (the board title it was watched by) names it, never its prompts; state and time from the board
  const bsid = 'bbbbbbbb-3333-4444-8555-666666666666'
  const row: Record<string, unknown> = { sessionId: bsid, title: 'Quarterly cleanup plan', area: 'work', live: true, activity: 'working', lastActivityUtc: new Date(clock + 5_000).toISOString() }
  board.push(row)
  ;(fakeIo as any).boardCached = () => board
  ioMod.setRavenToolsIo(fakeIo)
  say(`sid:${bsid}`, bsid, entry('user', 'plan the quarterly cleanup for the shares'), entry('assistant', 'Planned.'), entry('user', 'now draft the email to the client about it'))
  await watch.startWatch({ pane: '', label: 'Quarterly cleanup plan', sessionId: bsid })
  c = await card(`sid:${bsid}`)
  check('card: a window on thor, by its label, working and its time from the board',
    c?.title === undefined && c?.label === 'Quarterly cleanup plan' && c.state === 'working' && c.lastAt === row.lastActivityUtc, c)
  row.activity = 'idle'
  check('card: idle from the board', (await card(`sid:${bsid}`))?.state === 'idle')
  row.live = false
  row.activity = 'closed'
  check('card: closed on the board, off the card', !(await card(`sid:${bsid}`)))
  delete (fakeIo as any).boardCached
  ioMod.setRavenToolsIo(fakeIo)
  check('card: no board copy, no state', (await card(`sid:${bsid}`))?.state === null)

  // a watch saved before this change: its old prompt-made job is never shown
  const raw = JSON.parse(store.getKv('raven:watches') ?? '[]') as Record<string, unknown>[]
  for (const w of raw) if (w.key === `sid:${bsid}`) w.job = 'Now draft the email to the client about it'
  store.setKv('raven:watches', JSON.stringify(raw))
  ;(fakeIo as any).boardCached = () => board
  ioMod.setRavenToolsIo(fakeIo)
  row.live = true
  row.activity = 'idle'
  c = await card(`sid:${bsid}`)
  check('card: an older watch\'s prompt-made job is not its title', c?.title === undefined && c?.label === 'Quarterly cleanup plan', c)
  const op = { name: 'vk-4444444444' }

  for (const w of watch.listWatches()) watch.removeWatch(w.key)
  board.pop()
  states.set(op.name, 'gone')
  states.set(p.name, 'gone')
}

// ---------------------------------------------------------------- done ---

hooks.setRavenPoster(null)
hooks.setRavenWaker(null)
apiSrv.close()
for (const c of clients.values()) await c.close()
console.log(`ravenToolsSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
