/**
 * Odin backup host smoke test: the pieces of the terminal route that decide
 * what runs on odin, all pure. No tmux, no network, no Claude, no systemd.
 *
 *   1. odin-targets.json parsing: missing file, not JSON, not a list, bad
 *      entries one by one (keys, '../' keys, relative and missing dirs, labels),
 *      the { targets } wrapper, '~/' dirs, live reload on change.
 *   2. GET /terminal/odin-targets answers keys and labels, never a directory.
 *   3. POST /terminal/sessions validation for host odin: new and shell only,
 *      resume refused, unknown or malformed key, unknown host, projects, agent
 *      runs and the desk refused. Driven through the route's own handler with
 *      a fake request, and only on paths that answer before a pane is made.
 *   4. odinCommand: its argv, and the sh wrapper's quoting, run for real with
 *      /bin/sh against a directory named to break a shell ($(...), quotes,
 *      spaces, ;), with printf as the program, never Claude.
 *   5. The equity tail parser in routes/tradebot.ts (newestSampleInTail,
 *      readNewestSample, applyNewestSample), when that file exports them.
 *
 * Linux only (/bin/sh). Self-contained: it makes its own temp dir and points
 * HOME, the data dir, the targets file, the tmux socket and the Claude path
 * into it before anything is imported, puts a fake tmux and systemctl first on
 * PATH that only record being called (the test fails if either is), and
 * removes the dir at the end. It never writes outside that dir.
 *
 * Run on odin from a scratch copy of thor's backend, never inside ~/valkyrie
 * (the copy only borrows odin's node_modules through a symlink). From thor's
 * backend folder, in bash:
 *   S=$(ssh odin mktemp -d /tmp/term-odin-copy-XXXXXX)
 *   tar -cf - src scripts package.json tsconfig.json | ssh odin "cd $S && tar -xf - && ln -s ~/valkyrie/backend/node_modules node_modules"
 *   ssh odin "cd $S && node --import tsx scripts/termOdinSmoke.mts"; ssh odin "rm -rf -- $S"
 * The "[terminal] ... skipped" warnings and the one "create failed" stack are
 * the code under test saying what it refused; the last line is the verdict.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.platform === 'win32') {
  console.error('termOdinSmoke: Linux only (it runs the odin wrapper with /bin/sh). Run it on odin.')
  process.exit(2)
}

// ------------------------------------------------------- the sandbox ----

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-odin-smoke-')))
const REAL_HOME = os.homedir()
const HOME = path.join(T, 'home')
const BIN = path.join(T, 'fake-bin')
const MARK = path.join(T, 'called')
const TARGETS = path.join(T, 'odin-targets.json')
const CLAUDE = path.join(T, 'claude-bin', 'claude')
for (const d of [HOME, BIN, path.dirname(CLAUDE), path.join(T, 'data'), path.join(T, 'tmux')]) fs.mkdirSync(d, { recursive: true })
// anything that tries to reach tmux or systemd leaves a mark and fails
for (const name of ['tmux', 'systemctl']) {
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${MARK}"\nexit 1\n`, { mode: 0o755 })
}
Object.assign(process.env, {
  HOME,
  VALKYRIE_DATA_DIR: path.join(T, 'data'),
  VALKYRIE_ODIN_TARGETS: TARGETS,
  VALKYRIE_ODIN_CLAUDE: CLAUDE,
  VALKYRIE_TMUX_BIN: path.join(BIN, 'tmux'),
  VALKYRIE_TMUX_SOCKET: 'term-odin-smoke',
  VALKYRIE_TMUX_CONF: path.join(T, 'no-tmux.conf'),
  TMUX_TMPDIR: path.join(T, 'tmux'),
  VALKYRIE_SSH_BIN: path.join(T, 'no-ssh'),
  PROJECT_AREAS_FILE: path.join(T, 'no-areas.json'),
  LILKUPS_BIN: path.join(T, 'no-lilkups'),
  LILKUPS_STORE: path.join(T, 'no-reminders.json'),
  PATH: `${BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`,
})
assert.equal(os.homedir(), HOME, 'HOME did not move into the sandbox')
assert.notEqual(HOME, REAL_HOME)

// Imported only now: tmux.ts reads its paths, and db.ts its data dir, at import.
const X = await import('../src/terminal/tmux.js')
const terminalRoute = (await import('../src/routes/terminal.js')).default as unknown as RouterLike

const ok = (what: string) => console.log(`ok  ${what}`)
let mtime = Math.floor(Date.now() / 1000) - 1000
/** Writes the targets file with a new mtime (the parse is cached by mtime). */
function writeTargets(content: string | null): void {
  if (content === null) {
    fs.rmSync(TARGETS, { force: true })
    return
  }
  fs.writeFileSync(TARGETS, content)
  mtime += 10
  fs.utimesSync(TARGETS, mtime, mtime)
}
const dir = (name: string) => {
  const d = path.join(T, 'dirs', name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function throwsStatus(status: number, re: RegExp, fn: () => unknown): void {
  try {
    fn()
  } catch (err) {
    const e = err as { status?: number; message?: string }
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`)
    assert.match(String(e.message), re)
    return
  }
  assert.fail(`expected a ${status} matching ${re}`)
}

// --------------------------------------------- 1. odin-targets.json ----

writeTargets(null)
let list = X.odinTargets()
assert.equal(list.source, 'default')
assert.deepEqual(list.targets, [{ key: 'home', label: 'Odin home', dir: HOME }])
ok('no targets file: one target, the home directory')

writeTargets('{ not json')
list = X.odinTargets()
assert.equal(list.source, 'invalid')
assert.deepEqual(list.targets.map((t) => t.key), ['home'])
writeTargets('{"targets": "nope"}')
assert.equal(X.odinTargets().source, 'invalid')
writeTargets('7')
assert.equal(X.odinTargets().source, 'invalid')
writeTargets('')
assert.equal(X.odinTargets().source, 'invalid')
ok('a file that is not a list (bad JSON, wrong shape, empty) falls back to home, marked invalid')

const good = dir('good')
const weirdName = 'we ird "q" \'s\' $(touch PWNED) `touch PWNED2`; x'
const weird = dir(weirdName)
fs.mkdirSync(path.join(HOME, 'dirs', 'tilde'), { recursive: true })
writeTargets(JSON.stringify([
  { key: 'good', label: 'Good one', dir: good },
  { key: 'Upper', label: 'upper case', dir: good },
  { key: '../etc', label: 'traversal', dir: good },
  { key: '..', dir: good },
  { key: 'a/b', dir: good },
  { key: '-lead', dir: good },
  { key: 'x'.repeat(33), dir: good },
  { key: '', dir: good },
  { key: 7, dir: good },
  { key: 'good', label: 'repeat', dir: dir('other') },
  { key: 'rel', dir: 'relative/path' },
  { key: 'nodir' },
  { key: 'gone', dir: path.join(T, 'dirs', 'missing') },
  { key: 'tilde', label: 'Tilde', dir: '~/dirs/tilde' },
  { key: 'ctl', label: 'Bad\u0007label\n  with \t spaces', dir: good },
  { key: 'long', label: 'L'.repeat(80), dir: good },
  { key: 'nolabel', dir: `${good}/../good` },
  { key: 'weird', label: 'Weird dir', dir: weird },
  null, 42, 'string', [],
]))
list = X.odinTargets()
assert.equal(list.source, 'config')
assert.deepEqual(list.targets.map((t) => t.key), ['good', 'tilde', 'ctl', 'long', 'nolabel', 'weird'])
const by = Object.fromEntries(list.targets.map((t) => [t.key, t]))
assert.equal(by.good.label, 'Good one')
assert.equal(by.good.dir, good)
assert.equal(by.tilde.dir, path.join(HOME, 'dirs', 'tilde'))
assert.equal(by.ctl.label, 'Bad label with spaces')
assert.equal(by.long.label.length, 40)
assert.equal(by.nolabel.label, 'nolabel')
assert.equal(by.nolabel.dir, good)
assert.equal(by.weird.dir, weird)
ok('bad keys (case, ../, slashes, length, repeats), relative and missing dirs dropped one by one; labels cleaned and capped')

for (const k of ['../etc', '..', 'Upper', 'gone', 'rel', 'nodir', 'nope', '', 'a/b', 'good/../good']) {
  assert.equal(X.findOdinTarget(k), null, `findOdinTarget(${JSON.stringify(k)})`)
}
assert.equal(X.findOdinTarget('good')?.dir, good)
assert.equal(X.findOdinTarget('weird')?.dir, weird)
ok('findOdinTarget: only a listed, well-formed key with a real directory')

writeTargets(JSON.stringify({ targets: [{ key: 'wrapped', label: 'Wrapped', dir: good }] }))
assert.deepEqual(X.odinTargets().targets.map((t) => t.key), ['wrapped'])
ok('{ "targets": [...] } is read like a bare list, and an edit applies without a restart')

writeTargets(JSON.stringify([{ key: 'good', label: 'Good one', dir: good }, { key: 'weird', label: 'Weird dir', dir: weird }]))
fs.rmSync(path.join(T, 'dirs', 'good'), { recursive: true })
assert.deepEqual(X.odinTargets().targets.map((t) => t.key), ['weird'])
dir('good')
assert.deepEqual(X.odinTargets().targets.map((t) => t.key), ['good', 'weird'])
ok('a directory that disappears drops out of the list, and comes back with it')

// ------------------------------------------ 2. GET /terminal/odin-targets ----

type Handler = (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown
type RouterLike = { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[] }

function routeHandler(method: string, p: string): Handler {
  const layer = terminalRoute.stack.find((l) => l.route?.path === p && l.route.methods[method])
  assert.ok(layer?.route, `no ${method.toUpperCase()} ${p} on the terminal router`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}

type FakeRes = { statusCode: number; body: unknown; status: (n: number) => FakeRes; json: (b: unknown) => FakeRes }
async function call(method: string, p: string, body: unknown = {}): Promise<FakeRes> {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(n) { this.statusCode = n; return this },
    json(b) { this.body = b; return this },
  }
  const req = { method: method.toUpperCase(), body, query: {}, params: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' } }
  let nextErr: unknown
  await routeHandler(method, p)(req, res, (e) => { nextErr = e })
  if (nextErr) throw nextErr
  return res
}

const listed = await call('get', '/terminal/odin-targets')
const lb = listed.body as { host: string; ready: boolean; detail: string | null; source: string; targets: Record<string, unknown>[] }
assert.equal(lb.host, 'odin')
assert.equal(lb.ready, false)
assert.match(String(lb.detail), /claude CLI is not installed/)
assert.deepEqual(lb.targets, [{ key: 'good', label: 'Good one' }, { key: 'weird', label: 'Weird dir' }])
assert.ok(!JSON.stringify(lb).includes(T), 'a directory left the box')
ok('GET /terminal/odin-targets: keys and labels only, never a path; ready false without claude')

// ------------------------------------- 3. POST /terminal/sessions, odin ----

const UUID = '0e2e0000-0000-4000-8000-000000000001'
const refusals: [string, Record<string, unknown>, number, RegExp][] = [
  ['resume on odin', { host: 'odin', mode: 'resume', sessionId: UUID }, 400, /not resumes/],
  ['a project on odin', { host: 'odin', mode: 'new', project: 'someproj', target: 'good' }, 400, /start on thor/],
  ['an agent run on odin', { host: 'odin', mode: 'new', project: 'someproj', automation: 'daily', automationRev: 1 }, 400, /start on thor/],
  ['the desk on odin', { host: 'odin', mode: 'new', desk: true }, 400, /start on thor/],
  ['an unknown host', { host: 'mimir', mode: 'new', target: 'good' }, 400, /host must be one of thor, odin/],
  ['a host in capitals', { host: 'ODIN', mode: 'new', target: 'good' }, 400, /host must be one of/],
  ['an unknown odin key', { host: 'odin', mode: 'new', target: 'nope' }, 400, /no odin target named 'nope'/],
  ['a ../ key', { host: 'odin', mode: 'shell', target: '../etc' }, 400, /target must be a launch-target key/],
  ['a missing key', { host: 'odin', mode: 'new' }, 400, /target must be a launch-target key/],
  ['a key whose dir is gone', { host: 'odin', mode: 'shell', target: 'gone' }, 400, /no odin target named 'gone'/],
  ['an unknown mode', { host: 'odin', mode: 'continue', target: 'good' }, 400, /mode must be one of/],
  ['thor resume with a bad id (thor unchanged)', { mode: 'resume', sessionId: 'not-a-uuid' }, 400, /sessionId must be a uuid/],
]
for (const [what, body, status, re] of refusals) {
  const r = await call('post', '/terminal/sessions', body)
  assert.equal(r.statusCode, status, `${what}: ${r.statusCode} ${JSON.stringify(r.body)}`)
  assert.match(String((r.body as { error?: string }).error), re, what)
}
// a well-formed odin open with no claude installed stops at the program check, before any pane
fs.rmSync(CLAUDE, { force: true })
const noClaude = await call('post', '/terminal/sessions', { host: 'odin', mode: 'new', target: 'good', label: 'x' })
assert.equal(noClaude.statusCode, 503)
assert.match(String((noClaude.body as { error?: string }).error), /claude is not installed/)
assert.ok(!fs.existsSync(MARK), `tmux or systemd was called: ${fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8') : ''}`)
ok(`POST /terminal/sessions refuses for odin: ${refusals.map((r) => r[0]).join(', ')}; no claude is a 503 before any pane`)

// --------------------------------------------- 4. odinCommand and sh ----

throwsStatus(400, /not resumes/, () => X.odinCommand({ mode: 'resume', target: 'good' }))
throwsStatus(400, /not resumes/, () => X.odinCommand({ mode: 'new', target: 'good', resumeId: UUID }))
throwsStatus(400, /start on thor/, () => X.odinCommand({ mode: 'new', target: 'good', projectId: 'p' }))
throwsStatus(400, /start on thor/, () => X.odinCommand({ mode: 'new', target: 'good', runId: UUID }))
throwsStatus(400, /start on thor/, () => X.odinCommand({ mode: 'new', target: 'good', desk: true }))
throwsStatus(400, /odin target key/, () => X.odinCommand({ mode: 'shell', target: '../etc' }))
throwsStatus(400, /odin target key/, () => X.odinCommand({ mode: 'shell' }))
throwsStatus(400, /no odin target named/, () => X.odinCommand({ mode: 'shell', target: 'nope' }))
throwsStatus(503, /claude is not installed/, () => X.odinCommand({ mode: 'new', target: 'good' }))
ok('odinCommand refuses resume, projects, runs, the desk, bad and unknown keys; 503 without claude')

const sh = X.odinCommand({ mode: 'shell', target: 'weird' })
assert.equal(sh.dir, weird)
assert.equal(sh.argv[0], '/bin/sh')
assert.equal(sh.argv[1], '-c')
assert.match(sh.argv[2], /^cd -- "\$1"/)
assert.ok(!sh.argv[2].includes(weird) && !sh.argv[2].includes('weird'), 'the directory leaked into the script text')
assert.equal(sh.argv[3], 'valkyrie-odin')
assert.equal(sh.argv[4], weird)
assert.ok(path.isAbsolute(sh.argv[5]), `login shell ${sh.argv[5]}`)
assert.equal(sh.argv[6], '-l')
assert.equal(sh.argv.length, 7)
ok('a shell: /bin/sh -c <fixed script> valkyrie-odin <dir> <login shell> -l, the directory only ever an argument')

fs.writeFileSync(CLAUDE, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const neu = X.odinCommand({ mode: 'new', target: 'good', newId: UUID })
assert.deepEqual(neu.argv.slice(4), [good, CLAUDE, '--session-id', UUID])
assert.deepEqual(X.odinCommand({ mode: 'new', target: 'good', newId: 'not-a-uuid; rm -rf /' }).argv.slice(4), [good, CLAUDE])
assert.deepEqual(X.odinCommand({ mode: 'new', target: 'good' }).argv.slice(4), [good, CLAUDE])
fs.rmSync(CLAUDE)
ok('a new session: claude by absolute path, --session-id only for a real uuid')

/** Runs the wrapper with a stand-in program, never Claude. */
function wrap(dirArg: string, program: string[], env: Record<string, string> = {}) {
  const r = spawnSync(sh.argv[0], [sh.argv[1], sh.argv[2], sh.argv[3], dirArg, ...program], {
    cwd: T, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000,
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const PROG = ['/bin/sh', '-c', 'printf "[%s]" "$PWD" "$@"; exit "${EXIT:-0}"', 'prog', 'arg one', '$(touch PWNED3)', '"; touch PWNED4; "']
let w = wrap(weird, PROG)
assert.equal(w.code, 0, w.err)
assert.ok(w.out.includes(`odin  ${weird}\n`), `banner: ${JSON.stringify(w.out)}`)
assert.ok(w.out.includes(`[${weird}][arg one][$(touch PWNED3)]["; touch PWNED4; "]`), `argv through the wrapper: ${JSON.stringify(w.out)}`)
const pwned = (fs.readdirSync(T, { recursive: true }) as string[]).filter((f) => /^PWNED\d*$/.test(path.basename(f)))
assert.deepEqual(pwned, [], 'the wrapper ran part of a directory name or an argument')
ok('sh wrapper: a directory named with $(), backticks, quotes, spaces and ; is entered literally, arguments pass untouched, nothing runs')

w = wrap(weird, PROG, { EXIT: '3' })
assert.equal(w.code, 3)
assert.match(w.out, /odin: sh exited with 3/)
assert.ok(w.out.includes('\x1b[?1049l'), 'the terminal modes were not reset after a failed exit')
assert.equal(wrap(weird, PROG, { EXIT: '130' }).code, 0)
ok('sh wrapper: a failing program keeps its exit code with one line on screen; 0 and Ctrl-C (130) close cleanly')

w = wrap(path.join(T, 'dirs', 'missing'), PROG)
assert.equal(w.code, 2)
assert.match(w.out, /odin: cannot open/)
ok('sh wrapper: a directory that vanished between the list and the open exits 2 with a line')

w = wrap(weird, ['/bin/sh', '-c', 'printf "%s:%s:%s:%s" "$CLAUDE_CODE_NO_FLICKER" "$CLAUDE_CODE_DISABLE_MOUSE_CLICKS" "${CLAUDE_CODE_DISABLE_MOUSE-unset}" "${CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN-unset}"'], {
  CLAUDE_CODE_DISABLE_MOUSE: '1', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
})
assert.ok(w.out.endsWith('1:1:unset:unset'), `env: ${JSON.stringify(w.out)}`)
w = wrap(weird, ['/bin/sh', '-c', 'printf "%s" "$PATH"'], { PATH: '/usr/bin:/bin' })
assert.ok(w.out.split('\n').pop()?.startsWith(`${HOME}/.local/bin:`), `PATH: ${JSON.stringify(w.out)}`)
ok('sh wrapper: fullscreen on, mouse clicks off, the wheel kept, ~/.local/bin on PATH')

// ------------------------------------------ 5. the equity tail parser ----

type Sample = { ms: number; ts: string; total: number; cash: number | null }
type TradeExports = {
  newestSampleInTail?: (text: string) => Sample | null
  readNewestSample?: (file?: string) => Promise<Sample | null>
  applyNewestSample?: (status: Record<string, unknown>, sample: Sample | null, nowMs: number) => Record<string, unknown>
}
const TB = (await import('../src/routes/tradebot.js')) as unknown as TradeExports
if (!TB.newestSampleInTail || !TB.readNewestSample || !TB.applyNewestSample) {
  console.log('skip the equity tail parser: routes/tradebot.ts does not export it')
} else {
  const { newestSampleInTail: tail, readNewestSample: readNewest, applyNewestSample: apply } = TB
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const at = (iso: string) => Date.parse(iso)

  assert.equal(tail(''), null)
  assert.equal(tail(line({ ts: '2026-10-16T14:00:00-04:00', total: 1, source: 'live' })), null, 'a line with no newline is an append in flight')
  const t1 = tail([
    line({ ts: '2026-10-16T14:00:00-04:00', total: 100.5, cash: 10, source: 'live' }),
    'garbage',
    '{"ts": broken',
    line({ ts: '2026-10-16T14:05:00-04:00', total: 'NaN', source: 'live' }),
    line({ ts: '2026-10-16T14:06:00', total: 300, source: 'live' }),
    line({ ts: '2026-10-16T14:07:00-04:00', total: 400, source: 'v1_log' }),
    line({ ts: '2026-10-16T14:01:00-04:00', total: '101.25', source: 'live' }),
    line({ ts: '2026-10-16T13:00:00-04:00', total: 50, source: 'live' }),
    line({ ts: '2026-10-16T14:09:00-04:00', total: 999, source: 'live' }).slice(0, 30),
  ].join('\n') + '\n')
  assert.deepEqual(t1, { ms: at('2026-10-16T14:01:00-04:00'), ts: '2026-10-16T14:01:00-04:00', total: 101.25, cash: null })
  const t2 = tail(line({ ts: '2026-10-16T18:00:00Z', total: 7, cash: 2, source: 'live' }) + '\n' + line({ ts: '2026-10-16T18:10:00Z', total: 8, source: 'live' }))
  assert.equal(t2?.total, 7, 'the last line without a newline is torn, not a sample')
  ok('tail: complete lines only; source live, zoned ts and a finite total; newest by ts (backfill appends older rows), garbage skipped')

  const big = path.join(T, 'equity_history.jsonl')
  const rows: string[] = []
  for (let i = 0; i < 400; i++) rows.push(line({ ts: new Date(at('2026-10-16T13:30:00Z') + i * 60_000).toISOString(), total: 1000 + i, cash: 5, source: 'live' }))
  fs.writeFileSync(big, rows.join('\n') + '\n')
  assert.ok(fs.statSync(big).size > 16 * 1024)
  const newest = await readNewest(big)
  assert.equal(newest?.total, 1399)
  assert.equal(newest?.cash, 5)
  assert.equal(await readNewest(path.join(T, 'missing.jsonl')), null)
  fs.writeFileSync(big, '')
  assert.equal(await readNewest(big), null)
  ok('readNewestSample: the newest row from the tail of a large file; missing or empty file is null')

  const now = at('2026-10-16T18:30:00Z')
  const sample = (iso: string, total = 7600, cash: number | null = 12): Sample => ({ ms: at(iso), ts: iso, total, cash })
  const status = (portfolio: Record<string, unknown> | undefined, generated = '2026-10-16T18:25:00Z') =>
    ({ generated_at: generated, ...(portfolio ? { portfolio } : {}) }) as Record<string, unknown>
  const pf = (s: Record<string, unknown>) => s.portfolio as Record<string, unknown>

  const bare = status(undefined)
  assert.equal(apply(bare, sample('2026-10-16T18:29:00Z'), now), bare)

  let s = apply(status({ live_equity: 7554.15, live_cash: null, live_equity_source: 'day_open', live_equity_age_min: null }), sample('2026-10-16T18:29:00Z'), now)
  assert.equal(pf(s).live_equity, 7600)
  assert.equal(pf(s).live_cash, 12)
  assert.equal(pf(s).live_equity_source, 'sample')
  assert.equal(pf(s).live_equity_age_min, 1)
  assert.equal(pf(s).live_equity_sampled_at, '2026-10-16T18:29:00.000Z')
  ok('apply: a current sample replaces the day-open fallback, cash and all, with its exact time and age')

  // status.json's own sample was taken at 18:25 minus 4 min = 18:21
  const fromSample = { live_equity: 7590, live_cash: 3, live_equity_source: 'sample', live_equity_age_min: 4 }
  s = apply(status(fromSample), sample('2026-10-16T18:29:00Z'), now)
  assert.equal(pf(s).live_equity, 7600)
  s = apply(status(fromSample), sample('2026-10-16T18:21:00Z', 7590), now)
  assert.equal(pf(s).live_equity, 7590)
  assert.equal(pf(s).live_equity_sampled_at, '2026-10-16T18:21:00.000Z')
  assert.equal(pf(s).live_equity_age_min, 9)
  s = apply(status(fromSample), sample('2026-10-16T18:10:00Z'), now)
  assert.equal(pf(s).live_equity, 7590)
  assert.equal(pf(s).live_equity_sampled_at, null)
  ok('apply: only a strictly newer sample wins over status.json\'s own; the same one gets its exact time and a fresh age')

  s = apply(status({ ...fromSample, live_equity_source: 'day_open' }), sample('2026-10-16T16:00:00Z'), now)
  assert.equal(pf(s).live_equity_source, 'day_open', 'a sample older than 2 h is not current')
  assert.equal(pf(s).live_equity_sampled_at, null)
  s = apply(status({ ...fromSample, live_equity_source: 'day_open' }), sample('2026-10-16T18:40:00Z'), now)
  assert.equal(pf(s).live_equity_source, 'day_open', 'a sample from the future is a bad row')
  s = apply(status({ ...fromSample, live_equity_age_min: null }), sample('2026-10-16T18:24:00Z'), now)
  assert.equal(pf(s).live_equity, 7590, 'with no recoverable sample time, a sample must postdate generated_at')
  s = apply(status({ ...fromSample, live_equity_age_min: null }), sample('2026-10-16T18:26:00Z'), now)
  assert.equal(pf(s).live_equity, 7600)
  assert.equal(pf(apply(status(fromSample), null, now)).live_equity_sampled_at, null)
  assert.equal(pf(apply(status(fromSample), null, now)).live_equity, 7590)
  ok('apply: never fabricates: stale (over 2 h), future and not-newer samples leave status.json alone')
}

// ------------------------------------------------------------ done ----

assert.ok(!fs.existsSync(MARK), `tmux or systemd was called: ${fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8') : ''}`)
fs.rmSync(T, { recursive: true, force: true })
console.log('termOdinSmoke: all passed')
process.exit(0)
