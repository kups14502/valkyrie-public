/**
 * Session view smoke test: the transcript parser, the byte-offset reader, the
 * odin pane resolution and thor's /transcript service, end to end.
 *
 *   1. parseLines against scripts/fixtures/transcript-generic.jsonl (the line
 *      shapes of a real 2.1.28x transcript, generic text): every kind, the
 *      noise that must be skipped, the task list across TaskCreate/TaskUpdate
 *      and TodoWrite, trimming, stable ids, the same entries when the lines
 *      arrive in pieces.
 *   2. readChunk: complete lines only, forward and tail, a line still being
 *      written, a window opening mid-line, a line longer than the cap, a line
 *      past the 16 MB ceiling, and long lines cut down (screenshots, the
 *      system prompt snapshot).
 *   3. The odin reader through readerFor/pageFrom, with a sandboxed Claude
 *      config dir: the registry's tmux field, /clear (reset to the new file),
 *      a cursor past the end, a garbage cursor, widening tail windows, `more`,
 *      a pane whose Claude has exited, no transcript yet, and (Linux) a
 *      registry entry found by pid ancestry.
 *   4. thor's project-files service (when project-files.mjs is on this
 *      machine): started on a free loopback port with a sandboxed Claude dir,
 *      token and log. The registry chain across /clear, an exited process,
 *      hint, the session_id fallback for a change made before the service
 *      started, auth, and byte-for-byte parity with the odin reader.
 *
 * Self-contained: one temp dir for everything, removed at the end. Never
 * touches tmux, the real ~/.claude or the running services.
 *
 *   cd backend; node --import tsx scripts/transcriptSmoke.mts
 *
 * --live-odin (Linux, on odin, from a scratch copy of the backend as in
 * termOdinSmoke.mts) instead opens a THROWAWAY pane through the running API on
 * loopback, accepts the folder-trust prompt, sends one short prompt, reads the
 * pane through the route's own code and through the route mounted on a
 * loopback port, runs /clear, checks the reset, kills the pane and deletes
 * the two transcripts it made. It touches no other pane.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'transcript-generic.jsonl')
const LIVE = process.argv.includes('--live-odin')
const ok = (what: string) => console.log(`ok  ${what}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-smoke-')))
const ODIN_CLAUDE = path.join(T, 'odin-claude')
const THOR_CLAUDE = path.join(T, 'thor-claude')
for (const d of [path.join(ODIN_CLAUDE, 'sessions'), path.join(ODIN_CLAUDE, 'projects'), path.join(THOR_CLAUDE, 'sessions'), path.join(THOR_CLAUDE, 'projects'), path.join(T, 'data')]) {
  fs.mkdirSync(d, { recursive: true })
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port
    s.close(() => resolve(p))
  })
})

const THOR_PORT = await freePort()
const THOR_TOKEN = randomBytes(24).toString('hex')

if (!LIVE) {
  Object.assign(process.env, {
    VALKYRIE_ODIN_CLAUDE_DIR: ODIN_CLAUDE,
    PROJECT_FILES_URL: `http://127.0.0.1:${THOR_PORT}`,
    PROJECT_FILES_TOKEN: THOR_TOKEN,
    VALKYRIE_TMUX_SOCKET: 'transcript-smoke-none',
    VALKYRIE_TMUX_BIN: path.join(T, 'no-tmux'),
  })
}
Object.assign(process.env, {
  VALKYRIE_DATA_DIR: path.join(T, 'data'),
  PROJECT_AREAS_FILE: path.join(T, 'no-areas.json'),
  LILKUPS_BIN: path.join(T, 'no-lilkups'),
  LILKUPS_STORE: path.join(T, 'no-reminders.json'),
})

// Imported only now: the feed reads its directories and the thor address at import.
const P = await import('../src/terminal/transcript.js')
const F = await import('../src/terminal/transcriptFeed.js')
type Entry = import('../src/terminal/transcript.js').TranscriptEntry
type Facts = import('../src/terminal/tmux.js').PaneFacts

const uuid = (n: number) => `0e2e0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
const userLine = (id: string, text: string, sid: string) =>
  line({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: id, timestamp: '2026-10-02T10:00:00.000Z', sessionId: sid })
const assistantLine = (id: string, text: string, sid: string) =>
  line({ parentUuid: null, isSidechain: false, type: 'assistant', message: { model: 'claude-test-1', role: 'assistant', type: 'message', content: [{ type: 'text', text }] }, uuid: id, timestamp: '2026-10-02T10:00:01.000Z', sessionId: sid, session_id: sid })

let cleanup: (() => void)[] = []
const finish = (code: number) => {
  for (const f of cleanup.reverse()) { try { f() } catch { /* best effort */ } }
  cleanup = []
  fs.rmSync(T, { recursive: true, force: true })
  process.exit(code)
}
process.on('uncaughtException', (err) => { console.error(err); finish(1) })
process.on('unhandledRejection', (err) => { console.error(err); finish(1) })

if (LIVE) {
  await liveOdin()
  finish(0)
}

// ----------------------------------------------------------- 1. parser ----

const fixture = fs.readFileSync(FIXTURE, 'utf8')
const fixtureLines = P.splitLines(fixture)
const all = P.parseLines(fixtureLines)
const brief = (e: Entry) => [e.kind, e.text ?? e.tool?.name ?? (e.result ? `${e.result.toolId}${e.result.isError ? '!' : ''}` : '') ?? '']
assert.deepEqual(all.map((e) => e.kind), [
  'system', 'user', 'thinking', 'assistant',
  'tool', 'result',
  'tool', 'result', 'todo', 'tool', 'result', 'todo', 'tool', 'result', 'todo',
  'tool', 'result', 'tool', 'result', 'tool', 'result',
  'tool', 'todo', 'result',
  'tool', 'result', 'system',
  'user', 'system', 'user', 'system', 'user', 'user', 'user',
  'system', 'system', 'system', 'system', 'system',
  'tool', 'result', 'todo', 'assistant',
], JSON.stringify(all.map(brief)))
const at = (i: number) => all[i]
assert.equal(at(0).text, 'Session started in a demo folder')
assert.equal(at(1).text, 'Please list the files in the demo folder and make a plan.')
assert.equal(at(2).text, 'The user wants a listing first.')
assert.equal(at(2).model, 'claude-test-1')
assert.equal(at(3).text, 'I will start with a listing.')
assert.deepEqual(at(4).tool, { name: 'Bash', input: { command: 'ls', description: 'List files' }, id: 'toolu_demo_A' })
assert.deepEqual(at(5).result, { toolId: 'toolu_demo_A', text: 'a.txt\nb.txt', isError: false, truncated: false })
ok('parser: prompts, empty thinking skipped, text, tool calls with inputs, results with system reminders stripped')

assert.deepEqual(at(8).todos, [{ content: 'Read a.txt', status: 'pending' }])
assert.deepEqual(at(11).todos, [{ content: 'Read a.txt', status: 'pending' }, { content: 'Summarize b.txt', status: 'pending' }])
assert.deepEqual(at(14).todos, [{ content: 'Read a.txt', status: 'in_progress' }, { content: 'Summarize b.txt', status: 'pending' }])
assert.deepEqual(at(22).todos, [{ content: 'Check the plan', status: 'completed' }, { content: 'Write notes', status: 'in_progress' }])
assert.deepEqual(at(41).todos, [{ content: 'Read a.txt', status: 'in_progress' }])
ok('parser: the task list from TaskCreate results, TaskUpdate status and delete, and TodoWrite\'s whole list')

assert.equal(at(16).result?.truncated, true)
assert.equal(at(16).result?.text.length, P.RESULT_MAX + 1)
assert.ok(at(16).result?.text.endsWith('\u2026'))
assert.deepEqual([at(18).result?.isError, at(18).result?.text.startsWith('Exit code 1')], [true, true])
assert.equal(at(20).result?.text, '[image]')
assert.ok(!JSON.stringify(all).includes('iVBOR'), 'image data reached an entry')
const ask = at(24).tool?.input as { questions: { options: { label: string }[] }[] }
assert.deepEqual(ask.questions[0].options.map((o) => o.label), ['a.txt', 'b.txt'])
assert.equal(at(25).result?.isError, true)
assert.equal(at(26).text, 'Interrupted')
ok('parser: long results cut with truncated, errors, image placeholders and no image bytes, AskUserQuestion input whole, interrupts')

assert.equal(at(27).text, '/model sonnet')
assert.equal(at(28).text, 'Set model to sonnet')
assert.equal(at(29).text, '! git status')
assert.equal(at(30).text, 'On branch main\nnothing to commit')
assert.equal(at(31).text, 'also check c.txt')
assert.equal(at(32).text, '[Image #1] what is in this picture')
assert.equal(at(33).text, '[image]')
assert.equal(at(34).text, 'API Error: the demo service is busy, try again later')
assert.equal(at(34).model, undefined)
assert.equal(at(35).text, 'Conversation compacted')
assert.ok(at(36).text?.startsWith('Earlier conversation compacted.\n\nThis session is being continued'))
assert.equal(at(37).text, 'Background task completed: Background build finished')
assert.ok(at(38).text?.startsWith('You were reviewing the demo files.'))
assert.equal(at(42).text, 'Done. Two files listed.')
assert.ok(!all.some((e) => /subagent|Caveat|internal|Platform|demo assistant/.test(e.text ?? '')), 'skipped lines reached the entries')
ok('parser: slash commands, local and ! output (ANSI stripped), queued messages, pasted images, API errors, compaction, notifications; meta, sidechain, attachments, bookkeeping and broken lines skipped')

assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'ids repeat')
assert.ok(all.every((e) => e.at > 0))
const again = P.parseLines(fixtureLines)
assert.deepEqual(again, all)
const st = P.newTodoState()
const pieces = [...P.parseLines(fixtureLines.slice(0, 17), st), ...P.parseLines(fixtureLines.slice(17, 30), st), ...P.parseLines(fixtureLines.slice(30), st)]
assert.deepEqual(pieces, all)
ok('parser: unique stable ids, timestamps, and the same entries whether the lines come at once or in three reads')

const bigInput = P.parseLines([line({ type: 'assistant', uuid: uuid(900), timestamp: '2026-10-02T10:00:00.000Z', message: { model: 'm', content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/x', content: 'y'.repeat(50_000) } }] } })])
const wi = bigInput[0].tool?.input as { content: string }
assert.ok(wi.content.length <= 2001 && JSON.stringify(bigInput).length < 10_000)
ok('parser: a large tool input is cut down (one Write cannot make a page megabytes long)')

// ------------------------------------------------------------ 2. reader ----

const R = path.join(T, 'reader')
fs.mkdirSync(R)
const fx = path.join(R, 'fixture.jsonl')
fs.copyFileSync(FIXTURE, fx)
const fxSize = fs.statSync(fx).size

let c = await F.readChunk(fx, { tail: 512 * 1024 })
assert.deepEqual([c.start, c.end, c.size, c.capped], [0, fxSize, fxSize, false])
assert.deepEqual(P.parseLines(P.splitLines(c.text)), all)

const stepped: Entry[] = []
const stState = P.newTodoState()
let pos = 0
let reads = 0
for (;;) {
  const r = await F.readChunk(fx, { from: pos, max: 1000 })
  reads += 1
  assert.ok(r.end > pos || r.end === fxSize, `no progress at ${pos}`)
  assert.equal(fs.readFileSync(fx)[r.end - 1], 10, 'a read did not end on a line')
  stepped.push(...P.parseLines(P.splitLines(r.text), stState))
  pos = r.end
  if (!r.capped) break
}
assert.equal(pos, fxSize)
assert.deepEqual(stepped, all)
ok(`reader: tail of a small file is the whole file; ${reads} capped forward reads of 1000 bytes (one line is 25 KB) give the same entries`)

const grow = path.join(R, 'grow.jsonl')
fs.writeFileSync(grow, userLine(uuid(1), 'first', uuid(500)))
const g1 = await F.readChunk(grow, { from: 0 })
const half = userLine(uuid(2), 'second', uuid(500))
fs.appendFileSync(grow, half.slice(0, 40))
const g2 = await F.readChunk(grow, { from: g1.end })
assert.deepEqual([g2.end, g2.text, g2.capped], [g1.end, '', false])
fs.appendFileSync(grow, half.slice(40))
const g3 = await F.readChunk(grow, { from: g1.end })
assert.equal(P.parseLines(P.splitLines(g3.text))[0].text, 'second')
ok('reader: a line still being written is left for the next read, then read whole')

const mid = fs.statSync(grow).size - Math.floor(half.length / 2)
const g4 = await F.readChunk(grow, { tail: fs.statSync(grow).size - (Buffer.byteLength(userLine(uuid(1), 'first', uuid(500))) - 10) })
assert.equal(P.parseLines(P.splitLines(g4.text)).map((e) => e.text).join(','), 'second')
const g5 = await F.readChunk(grow, { tail: fs.statSync(grow).size - mid })
assert.deepEqual([g5.text, g5.start], ['', fs.statSync(grow).size])
ok('reader: a tail window that opens mid-line drops that line')

const big = path.join(R, 'big.jsonl')
const png = 'iVBORw0KGgo' + 'A'.repeat(300_000)
fs.writeFileSync(big, [
  line({ type: 'user', uuid: uuid(10), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Image #1] look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } }),
  line({ type: 'attachment', uuid: uuid(11), timestamp: '2026-10-02T10:00:00.000Z', attachment: { type: 'prompt_snapshot', systemPrompt: ['p'.repeat(150_000)] } }),
  line({ type: 'assistant', uuid: uuid(12), timestamp: '2026-10-02T10:00:00.000Z', message: { model: 'm', content: [{ type: 'text', text: 'w'.repeat(100_000) }] } }),
  line({ type: 'user', uuid: uuid(13), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', content: [{ type: 'text', text: 'r'.repeat(90_000) }, { type: 'image', source: { type: 'base64', data: png } }] }] } }),
].join(''))
const b1 = await F.readChunk(big, { tail: 4 * 1024 * 1024 })
assert.ok(b1.text.length < 60_000, `cut-down text is ${b1.text.length} bytes`)
assert.ok(!b1.text.includes('AAAAAAAAAAAAAAAA'), 'image bytes survived')
assert.equal(b1.end, fs.statSync(big).size)
const be = P.parseLines(P.splitLines(b1.text))
assert.deepEqual(be.map((e) => e.kind), ['user', 'assistant', 'result'])
assert.equal(be[0].text, '[Image #1] look')
assert.equal(be[1].text?.length, P.TEXT_MAX + 1)
assert.equal(be[2].result?.truncated, true)
assert.ok(be[2].result?.text.startsWith('rrrr'))
ok('reader: long lines cut down before parsing: screenshots gone, the prompt snapshot a stub, strings capped; offsets stay the real file\'s')

const reminder = `<system-reminder>${'Note for the model. '.repeat(100)}</system-reminder>\n`
const ansiOut = Array.from({ length: 400 }, (_, i) => `\u001b[32mok\u001b[0m step ${i}`).join('\r\n')
const sameParse: [string, string][] = [
  ['a result behind a long system reminder', line({ type: 'user', uuid: uuid(30), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: reminder + 'c'.repeat(3500) }] }, toolUseResult: { file: { content: 'c'.repeat(20_000) } } })],
  ['a long result behind a long system reminder', line({ type: 'user', uuid: uuid(31), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: reminder + 'd'.repeat(30_000) }] } })],
  ['colored CRLF output', line({ type: 'user', uuid: uuid(32), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: ansiOut }] }] } })],
  ['a task result with a big toolUseResult', line({ type: 'user', uuid: uuid(33), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'Task #7 created' }] }, toolUseResult: { task: { id: '7', subject: 'S' }, extra: 'e'.repeat(40_000) } })],
  ['a large Write and a signed thought', line({ type: 'assistant', uuid: uuid(34), timestamp: '2026-10-02T10:00:00.000Z', message: { model: 'm', content: [{ type: 'thinking', thinking: 'Thought.', signature: 's'.repeat(20_000) }, { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/x', content: 'y'.repeat(50_000), list: Array.from({ length: 80 }, (_, i) => i) } }] } })],
  ['a long typed prompt', line({ type: 'user', uuid: uuid(35), timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: 'q'.repeat(30_000) } })],
]
for (const [what, raw] of sameParse) {
  const cutDown = F.shrinkLine(raw.trimEnd())
  assert.ok(cutDown.length < raw.length, `${what}: not cut down`)
  const st1 = P.newTodoState()
  const st2 = P.newTodoState()
  st1.pending.set('toolu_x', { name: 'TaskCreate', input: { subject: 'S' } })
  st2.pending.set('toolu_x', { name: 'TaskCreate', input: { subject: 'S' } })
  assert.deepEqual(P.parseLines([cutDown], st2), P.parseLines([raw.trimEnd()], st1), what)
}
ok(`reader: a cut-down line parses exactly like the original (${sameParse.map((s) => s[0]).join('; ')})`)

const huge = path.join(R, 'huge.jsonl')
const hugeLine = line({ type: 'user', uuid: uuid(20), message: { role: 'user', content: 'h'.repeat(F.READ_CEIL + 1024) } })
fs.writeFileSync(huge, userLine(uuid(19), 'before', uuid(501)) + hugeLine + userLine(uuid(21), 'after', uuid(501)))
const h0 = await F.readChunk(huge, { from: 0, max: 64 })
const h1 = await F.readChunk(huge, { from: h0.end })
assert.equal(h1.end - h0.end, Buffer.byteLength(hugeLine))
assert.match(h1.text, /valkyrie-skipped/)
assert.equal(h1.capped, true)
const h2 = await F.readChunk(huge, { from: h1.end })
assert.equal(P.parseLines(P.splitLines(h2.text))[0].text, 'after')
assert.deepEqual(P.parseLines(P.splitLines(h1.text)), [])
const empty = path.join(R, 'empty.jsonl')
fs.writeFileSync(empty, '')
assert.deepEqual(await F.readChunk(empty, { tail: 1000 }), { size: 0, start: 0, end: 0, text: '', capped: false })
ok('reader: a line past the 16 MB ceiling is skipped with a stub and the read goes on; an empty file reads empty')

// --------------------------------------------------------- 3. odin feed ----

const S1 = uuid(601)
const S2 = uuid(602)
const ODIN_FOLDER = path.join(ODIN_CLAUDE, 'projects', '-srv-demo')
fs.mkdirSync(ODIN_FOLDER, { recursive: true })
const odinFile = (sid: string) => path.join(ODIN_FOLDER, `${sid}.jsonl`)
const reg = (pid: number, sid: string, extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(path.join(ODIN_CLAUDE, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: '/srv/demo', kind: 'interactive', ...extra }))
const facts = (sessionId: string, host: 'odin' | 'thor' = 'odin', panePid = 0): Facts => ({ host, mode: 'new', sessionId, panePid, dead: false })

assert.equal(F.projectFolder('/home/someone'), '-home-someone')
assert.equal(F.projectFolder('C:\\Work\\demo app'), 'C--Work-demo-app')

const PANE = 'vk-00000000a1'
reg(4242, S1, { tmux: `${PANE}:@1.%1` })
const read1 = F.readerFor(PANE, facts(S1))
let page = await F.pageFrom(read1, '', 'smoke:a')
assert.deepEqual([page.sessionId, page.file, page.entries.length, page.reset, page.more], [null, null, 0, false, false])
ok('odin: a pane whose Claude has not written a line yet answers sessionId null and no entries')

fs.copyFileSync(FIXTURE, odinFile(S1))
page = await F.pageFrom(read1, '', 'smoke:a')
assert.equal(page.sessionId, S1)
assert.equal(page.file, `${S1}.jsonl`)
assert.equal(page.cursor, `${S1}:${fxSize}`)
assert.deepEqual(page.entries, all)
assert.deepEqual([page.reset, page.more], [false, false])
const cursor1 = page.cursor
page = await F.pageFrom(read1, cursor1, 'smoke:a')
assert.deepEqual([page.entries.length, page.cursor, page.reset], [0, cursor1, false])
ok('odin: found by the registry\'s tmux field and the cwd\'s project folder; first read is everything, a quiet second read is empty')

fs.appendFileSync(odinFile(S1),
  line({ type: 'assistant', uuid: uuid(700), timestamp: '2026-10-02T10:00:00.000Z', message: { model: 'claude-test-1', content: [{ type: 'tool_use', id: 'toolu_more', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } })
  + line({ type: 'user', uuid: uuid(701), timestamp: '2026-10-02T10:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_more', content: 'Updated task #1 status' }] }, toolUseResult: { success: true, taskId: '1' } })
  + assistantLine(uuid(702), 'All done.', S1))
page = await F.pageFrom(read1, cursor1, 'smoke:a')
assert.deepEqual(page.entries.map((e) => e.kind), ['tool', 'result', 'todo', 'assistant'])
assert.deepEqual(page.entries[2].todos, [{ content: 'Read a.txt', status: 'completed' }])
assert.equal(page.reset, false)
const cursor2 = page.cursor
ok('odin: a later read is only what was appended, and the task list carries over from the earlier read')

fs.writeFileSync(odinFile(S2), userLine(uuid(800), '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', S2))
reg(4242, S2, { tmux: `${PANE}:@1.%1` })
page = await F.pageFrom(read1, cursor2, 'smoke:a')
assert.deepEqual([page.sessionId, page.reset, page.entries.map((e) => e.text).join()], [S2, true, '/clear'])
const cursor3 = page.cursor
ok('odin: after /clear the registry names the new id: reset, and the new file from its start')

page = await F.pageFrom(read1, `${S2}:999999`, 'smoke:a')
assert.deepEqual([page.reset, page.sessionId, page.entries.length], [true, S2, 1])
page = await F.pageFrom(read1, 'not-a-cursor', 'smoke:a')
assert.deepEqual([page.reset, page.sessionId], [true, S2])
page = await F.pageFrom(read1, cursor3, 'smoke:a')
assert.deepEqual([page.reset, page.entries.length], [false, 0])
ok('odin: a cursor past the end of the file, or one that does not parse, is a reset to the newest entries')

fs.rmSync(path.join(ODIN_CLAUDE, 'sessions', '4242.json'))
page = await F.pageFrom(read1, cursor3, 'smoke:a')
assert.deepEqual([page.sessionId, page.reset], [S2, false])
ok('odin: a pane whose Claude exited keeps showing the conversation it ended on')

const S3 = uuid(603)
const many = Array.from({ length: 300 }, (_, i) => userLine(uuid(1000 + i), `prompt ${i + 1} ${'p'.repeat(5000)}`, S3)).join('')
fs.writeFileSync(odinFile(S3), many)
reg(4343, S3, { tmux: 'vk-00000000a2:@2.%2' })
const read2 = F.readerFor('vk-00000000a2', facts(S3))
page = await F.pageFrom(read2, '', 'smoke:b')
assert.equal(page.entries.length, F.FIRST_ENTRIES)
assert.ok(page.entries[0].text?.startsWith('prompt 101 '))
assert.ok(page.entries[199].text?.startsWith('prompt 300 '))
assert.equal(page.cursor, `${S3}:${Buffer.byteLength(many)}`)
ok('odin: the first read widens its tail window until it has the newest 200 entries')

const cursorB = page.cursor
const burst = Array.from({ length: 12 }, (_, i) => userLine(uuid(2000 + i), `burst ${i} ${'b'.repeat(60_000)}`, S3)).join('')
fs.appendFileSync(odinFile(S3), burst)
page = await F.pageFrom(read2, cursorB, 'smoke:b')
assert.equal(page.more, true)
const firstBurst = page.entries.length
page = await F.pageFrom(read2, page.cursor, 'smoke:b')
assert.equal(page.more, false)
assert.equal(firstBurst + page.entries.length, 12)
ok('odin: an append bigger than one read comes in two, more:true asking for the second at once')

if (process.platform === 'linux') {
  const child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' })
  cleanup.push(() => child.kill())
  await sleep(200)
  reg(child.pid as number, S1)
  const read3 = F.readerFor('vk-00000000a3', facts('', 'odin', process.pid))
  page = await F.pageFrom(read3, '', 'smoke:c')
  assert.equal(page.sessionId, S1)
  child.kill()
  ok('odin: with no tmux field, the registry entry whose pid descends from the pane\'s process is the one')
} else {
  console.log('skip odin pid ancestry: Linux only (/proc)')
}

const read4 = F.readerFor('vk-00000000a4', facts(''))
page = await F.pageFrom(read4, '', 'smoke:d')
assert.deepEqual([page.sessionId, page.entries.length], [null, 0])
ok('odin: a shell pane with no Claude in it answers nothing')

// ---------------------------------------------------- 4. thor's service ----

const MJS = process.env.THOR_PROJECT_FILES_MJS || 'C:/Thor/tools/session-board/project-files/project-files.mjs'
if (!fs.existsSync(MJS)) {
  console.log(`skip thor's service: ${MJS} is not on this machine`)
} else {
  const tokenFile = path.join(T, 'thor-token.txt')
  fs.writeFileSync(tokenFile, THOR_TOKEN)
  const svc: ChildProcess = spawn(process.execPath, [MJS], {
    env: {
      ...process.env,
      PROJECT_FILES_PORT: String(THOR_PORT),
      PROJECT_FILES_BIND: '127.0.0.1',
      PROJECT_FILES_PEERS: '127.0.0.1,::1',
      PROJECT_FILES_TOKEN_FILE: tokenFile,
      PROJECT_FILES_LOG: path.join(T, 'thor.log'),
      PROJECT_FILES_CLAUDE_DIR: THOR_CLAUDE,
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  cleanup.push(() => svc.kill())
  const thor = async (q: string, token = THOR_TOKEN) => {
    const r = await fetch(`http://127.0.0.1:${THOR_PORT}${q}`, { headers: { Authorization: `Bearer ${token}` } })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }
  for (let i = 0; i < 50; i++) {
    try { if ((await thor('/health')).status === 200) break } catch { /* not up yet */ }
    await sleep(100)
  }
  assert.equal((await thor('/health')).status, 200, 'the service never came up')
  assert.equal((await thor('/health', 'x'.repeat(48))).status, 401)
  assert.equal((await thor('/transcript?sid=../../secrets')).status, 400)
  assert.equal((await thor(`/transcript?sid=${S1}&from=-4`)).status, 400)
  ok('thor: the service starts sandboxed; wrong token 401, a sid that is not a uuid or a negative offset 400')

  const A = uuid(901)
  const B = uuid(902)
  const TF = path.join(THOR_CLAUDE, 'projects', 'C--Work-demo')
  fs.mkdirSync(TF, { recursive: true })
  fs.copyFileSync(FIXTURE, path.join(TF, `${A}.jsonl`))
  const thorReg = path.join(THOR_CLAUDE, 'sessions', `${process.pid}.json`)
  fs.writeFileSync(thorReg, JSON.stringify({ pid: process.pid, sessionId: A, cwd: 'C:\\Work\\demo', procStart: '77', kind: 'interactive' }))
  fs.writeFileSync(path.join(THOR_CLAUDE, 'sessions', `${process.pid}.deadbeef.key`), 'never read')
  await sleep(2500)

  const TP = 'vk-00000000b1'
  const readT = F.readerFor(TP, facts(A, 'thor'))
  page = await F.pageFrom(readT, '', 'smoke:t')
  assert.equal(page.sessionId, A)
  assert.equal(page.file, `${A}.jsonl`)
  assert.deepEqual(page.entries, all)
  const tc1 = page.cursor
  ok('thor: a pane\'s transcript through /transcript parses to exactly the fixture\'s entries')

  const odinCopy = await F.readChunk(path.join(TF, `${A}.jsonl`), { tail: 4 * 1024 * 1024 })
  const thorCopy = (await thor(`/transcript?sid=${A}&tail=${4 * 1024 * 1024}`)).body
  assert.deepEqual([thorCopy.text, thorCopy.start, thorCopy.end, thorCopy.size], [odinCopy.text, odinCopy.start, odinCopy.end, odinCopy.size])
  fs.copyFileSync(big, path.join(TF, `${uuid(905)}.jsonl`))
  const bigThor = (await thor(`/transcript?sid=${uuid(905)}&tail=${4 * 1024 * 1024}`)).body
  assert.equal(bigThor.text, b1.text, 'thor and odin cut long lines differently')
  const hugeCopy = path.join(TF, `${uuid(906)}.jsonl`)
  fs.copyFileSync(huge, hugeCopy)
  const hugeThor = (await thor(`/transcript?sid=${uuid(906)}&expect=${uuid(906)}&from=${h0.end}`)).body
  assert.deepEqual([hugeThor.text, hugeThor.end, hugeThor.capped, hugeThor.tail], [h1.text, h1.end, true, false])
  ok('thor: byte-for-byte the same reads as odin\'s reader (plain, long lines cut down, a line past the ceiling)')

  fs.appendFileSync(path.join(TF, `${A}.jsonl`), assistantLine(uuid(910), 'More from thor.', A))
  page = await F.pageFrom(readT, tc1, 'smoke:t')
  assert.deepEqual([page.reset, page.entries.map((e) => e.text).join()], [false, 'More from thor.'])
  const tc2 = page.cursor

  fs.writeFileSync(path.join(TF, `${B}.jsonl`), userLine(uuid(911), '<command-name>/clear</command-name>\n<command-args></command-args>', B))
  fs.writeFileSync(thorReg, JSON.stringify({ pid: process.pid, sessionId: B, cwd: 'C:\\Work\\demo', procStart: '77', kind: 'interactive' }))
  await sleep(2500)
  page = await F.pageFrom(readT, tc2, 'smoke:t')
  assert.deepEqual([page.sessionId, page.reset, page.entries.map((e) => e.text).join()], [B, true, '/clear'])
  const tc3 = page.cursor
  ok('thor: the watcher follows the process from its first id to the one /clear gave it; the page resets onto the new file')

  fs.rmSync(thorReg)
  await sleep(2500)
  page = await F.pageFrom(readT, tc3, 'smoke:t')
  assert.deepEqual([page.sessionId, page.reset], [B, false])
  ok('thor: after the process exits, the pane still leads to its last conversation')

  assert.equal((await thor(`/transcript?sid=${uuid(920)}&hint=${B}`)).body.sessionId, B)
  ok('thor: an id the watcher never saw follows the hint odin sends back (a restart between two /clears)')

  const D = uuid(930)
  const E = uuid(931)
  fs.writeFileSync(path.join(TF, `${D}.jsonl`), userLine(uuid(932), 'old conversation', D))
  const past = (Date.now() - 3600_000) / 1000
  fs.utimesSync(path.join(TF, `${D}.jsonl`), past, past)
  fs.writeFileSync(path.join(TF, `${E}.jsonl`), userLine(uuid(933), '<command-name>/clear</command-name>', E) + assistantLine(uuid(934), 'after the clear', E).replace(`"session_id":"${E}"`, `"session_id":"${D}"`))
  const viaScan = (await thor(`/transcript?sid=${D}`)).body
  assert.deepEqual([viaScan.sessionId, viaScan.file], [E, `${E}.jsonl`])
  ok('thor: a /clear from before the service started is found by the session_id Claude Code writes in the new file')

  const none = (await thor(`/transcript?sid=${uuid(940)}`)).body
  assert.deepEqual([none.sessionId, none.file, none.text], [null, null, ''])
  ok('thor: a session with no transcript yet answers sessionId null')
  svc.kill()
}

console.log('transcriptSmoke: all passed')
finish(0)

// ------------------------------------------------------- --live-odin ----

async function liveOdin(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('--live-odin runs on odin')
  const API = process.env.VALKYRIE_API_LOOPBACK || 'http://127.0.0.1:3001/api'
  const tmux = (...args: string[]) => {
    const r = spawnSync('/usr/bin/tmux', ['-L', process.env.VALKYRIE_TMUX_SOCKET || 'valkyrie', ...args], { encoding: 'utf8', timeout: 5000 })
    return r.stdout ?? ''
  }
  const created = await (await fetch(`${API}/terminal/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: 'odin', mode: 'new', target: 'home', label: 'transcript smoke (throwaway)', cols: 120, rows: 40 }),
  })).json() as { name?: string; conversationId?: string; error?: string }
  const name = created.name ?? ''
  const minted = created.conversationId ?? ''
  assert.match(name, /^vk-[0-9a-f]{10}$/, `no pane: ${JSON.stringify(created)}`)
  console.log(`live: throwaway pane ${name}, conversation ${minted}`)
  const made = new Set<string>()
  cleanup.push(() => {
    spawnSync('curl', ['-s', '-X', 'POST', `${API}/terminal/sessions/${name}/kill`], { timeout: 5000 })
    console.log(`live: killed ${name}`)
    // Claude writes a last line or two as it exits, which would bring a
    // removed transcript back.
    spawnSync('sleep', ['3'])
    const folder = path.join(os.homedir(), '.claude', 'projects')
    for (const sid of made) {
      for (const d of fs.readdirSync(folder)) {
        const f = path.join(folder, d, `${sid}.jsonl`)
        if (fs.existsSync(f)) { fs.rmSync(f); console.log(`live: removed its transcript ${d}/${sid}.jsonl`) }
      }
    }
  })

  const { paneTranscript } = await import('../src/terminal/transcriptFeed.js')
  const express = (await import('express')).default
  const terminalRoute = (await import('../src/routes/terminal.js')).default
  const app = express()
  app.use('/api', terminalRoute)
  const port = await freePort()
  const server = app.listen(port, '127.0.0.1')
  cleanup.push(() => server.close())

  for (let i = 0; i < 40; i++) {
    const screen = tmux('capture-pane', '-p', '-t', name)
    if (screen.includes('Yes, I trust this folder')) {
      tmux('send-keys', '-t', name, 'Down')
      await sleep(400)
      tmux('send-keys', '-t', name, 'Enter')
      console.log('live: accepted the folder-trust prompt')
      await sleep(3000)
      break
    }
    if (/\u276f\s*$/m.test(screen) && !screen.includes('trust')) break
    await sleep(500)
  }

  let p = await paneTranscript(name, '')
  assert.ok(p, 'no pane facts')
  assert.ok(!p.entries.some((e) => e.kind === 'user' || e.kind === 'assistant'), JSON.stringify(p.entries))
  ok(`live: before the first prompt the pane answers no conversation (sessionId ${p.sessionId}, ${p.entries.length} entries)`)

  tmux('send-keys', '-t', name, '-l', 'Reply with the single word ok.')
  await sleep(500)
  tmux('send-keys', '-t', name, 'Enter')
  let cursor = ''
  const seen: Entry[] = []
  for (let i = 0; i < 90 && !seen.some((e) => e.kind === 'assistant'); i++) {
    await sleep(1000)
    p = await paneTranscript(name, cursor)
    assert.ok(p)
    if (p.reset) seen.length = 0
    seen.push(...p.entries)
    cursor = p.cursor || cursor
  }
  assert.equal(p?.sessionId, minted, 'the pane is not on the conversation it was opened with')
  made.add(minted)
  assert.ok(seen.some((e) => e.kind === 'user' && e.text === 'Reply with the single word ok.'), JSON.stringify(seen))
  const reply = seen.find((e) => e.kind === 'assistant')
  assert.ok(reply && /ok/i.test(reply.text ?? ''), JSON.stringify(seen))
  ok(`live: polled with a cursor, the prompt and the reply ("${reply?.text}", ${reply?.model}) arrived as entries`)

  const viaHttp = await (await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${name}/transcript`)).json() as { sessionId: string; entries: Entry[]; cursor: string }
  assert.equal(viaHttp.sessionId, minted)
  assert.ok(viaHttp.entries.some((e) => e.kind === 'assistant'))
  const quiet = await (await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${name}/transcript?after=${encodeURIComponent(viaHttp.cursor)}`)).json() as { entries: Entry[]; reset: boolean }
  assert.deepEqual([quiet.entries.length, quiet.reset], [0, false])
  const missing = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/vk-0000000000/transcript`)
  assert.equal(missing.status, 404)
  ok('live: GET /api/terminal/sessions/:name/transcript answers the same over HTTP; a quiet cursor is empty; an unknown pane is 404')

  tmux('send-keys', '-t', name, '-l', '/clear')
  await sleep(500)
  tmux('send-keys', '-t', name, 'Enter')
  let cleared = null as Awaited<ReturnType<typeof paneTranscript>>
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    cleared = await paneTranscript(name, cursor)
    if (cleared?.reset) break
  }
  assert.ok(cleared?.reset, 'no reset after /clear')
  assert.ok(cleared.sessionId && cleared.sessionId !== minted)
  made.add(cleared.sessionId)
  assert.ok(cleared.entries.some((e) => e.text === '/clear'), JSON.stringify(cleared.entries))
  ok(`live: /clear moved the pane to ${cleared.sessionId}: reset, and the new transcript starts with /clear`)
}
