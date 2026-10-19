// The session view's pages as the real backend answers them, for
// tests/chat.mjs (chat:server). Builds a generic transcript in a temp dir and
// reads it through backend/src/terminal/transcriptFeed.ts (pageFrom with a
// local reader that has the prefix scan), the same code the route runs:
//   - first:   a first read. Its tail window starts long after three tasks
//              were made (and one finished) and after the model attachment
//              that says [1m]; in the window, two parallel reads, a task
//              update, a send canceled and sent again.
//   - rewound: the next read after a rewind is appended (Esc Esc to before the
//              resent prompt, and a new one).
//   - quiet:   the read after that, nothing new.
// Prints { first, rewound, quiet } as JSON and removes the temp dir.
//
//   cd backend; node --import tsx ../frontend/e2e/lib/transcript-pages.mts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const F = await import(pathToFileURL(path.join(process.cwd(), 'src', 'terminal', 'transcriptFeed.ts')).href)

const SID = '0e2e0000-0000-4000-8000-0000000d0001'
const uuid = (n: number) => `0e2e0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const t0 = Date.now() - 30 * 60_000
let tick = 0
const line = (n: number, parent: number | null, o: Record<string, unknown>) =>
  JSON.stringify({ parentUuid: parent === null ? null : uuid(parent), isSidechain: false, uuid: uuid(n), timestamp: new Date(t0 + 1000 * tick++).toISOString(), sessionId: SID, ...o }) + '\n'
const usage = (cacheRead: number) => ({ input_tokens: 5, cache_creation_input_tokens: 10_000, cache_read_input_tokens: cacheRead, output_tokens: 60, service_tier: 'standard' })
const MODEL = 'claude-test-1'
const prompt = (n: number, parent: number | null, text: string) => line(n, parent, { type: 'user', message: { role: 'user', content: text } })
const said = (n: number, parent: number, text: string, cacheRead = 50_000) =>
  line(n, parent, { type: 'assistant', message: { model: MODEL, role: 'assistant', type: 'message', content: [{ type: 'text', text }], usage: usage(cacheRead) } })
const call = (n: number, parent: number, id: string, name: string, input: Record<string, unknown>) =>
  line(n, parent, { type: 'assistant', message: { model: MODEL, role: 'assistant', type: 'message', content: [{ type: 'tool_use', id, name, input }], usage: usage(50_000) } })
const answer = (n: number, parent: number, id: string, text: string, toolUseResult?: Record<string, unknown>) =>
  line(n, parent, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...(toolUseResult ? { toolUseResult } : {}) })
const turnEnd = (n: number, parent: number) => line(n, parent, { type: 'system', subtype: 'turn_duration', durationMs: 1000 })

let head = line(5001, null, { type: 'attachment', attachment: { type: 'model', identity: { modelId: `${MODEL}[1m]`, marketingName: 'Test 1 (1M context)' }, text: 'You are powered by a test model.' } })
head += prompt(5002, 5001, 'Plan the sample report')
const tasks = ['Write the outline', 'Draft section one', 'Check the numbers']
let prev = 5002
tasks.forEach((subject, i) => {
  const n = 5003 + 2 * i
  head += call(n, prev, `toolu_e2e_srv_c${i + 1}`, 'TaskCreate', { subject, description: 'sample' })
  head += answer(n + 1, n, `toolu_e2e_srv_c${i + 1}`, `Task #${i + 1} created successfully: ${subject}`, { task: { id: String(i + 1), subject } })
  prev = n + 1
})
head += call(5009, prev, 'toolu_e2e_srv_u1', 'TaskUpdate', { taskId: '1', status: 'completed' })
head += answer(5010, 5009, 'toolu_e2e_srv_u1', 'Updated task #1 status', { success: true, taskId: '1' })

// enough filler that the newest 200 entries start well after the tasks
let filler = ''
prev = 5010
for (let i = 0; i < 120; i++) {
  const n = 5100 + 2 * i
  filler += prompt(n, prev, `Filler question ${i + 1}: ${'Sample words for the filler. '.repeat(160)}`)
  filler += said(n + 1, n, `Filler answer ${i + 1}.`)
  prev = n + 1
}

let tree = prompt(5400, prev, 'Read both sample files.')
tree += call(5401, 5400, 'toolu_e2e_srv_ra', 'Read', { file_path: '/srv/sample/a.txt' })
tree += call(5402, 5401, 'toolu_e2e_srv_rb', 'Read', { file_path: '/srv/sample/b.txt' })
// parallel calls: this result names its own call and hangs off the chain
tree += answer(5403, 5401, 'toolu_e2e_srv_ra', '     1\tsample a')
tree += answer(5404, 5402, 'toolu_e2e_srv_rb', '     1\tsample b')
tree += call(5405, 5404, 'toolu_e2e_srv_u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' })
tree += answer(5406, 5405, 'toolu_e2e_srv_u2', 'Updated task #2 status', { success: true, taskId: '2' })
tree += said(5407, 5406, 'Both sample files are read.', 110_000)
tree += turnEnd(5408, 5407)
tree += prompt(5409, 5408, 'Summarize them, sent too soon')
tree += line(5410, 5409, { type: 'attachment', attachment: { type: 'total_tokens_reminder', text: 'sample' } })
tree += prompt(5411, 5408, 'Summarize them in one line')
tree += said(5412, 5411, 'Abandoned summary of the files.', 160_000)
tree += turnEnd(5413, 5412)

const rewind = prompt(5414, 5408, 'Compare them instead') + said(5415, 5414, 'Compared on the new branch.', 80_000)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-e2e-pages-'))
try {
  const file = path.join(dir, `${SID}.jsonl`)
  fs.writeFileSync(file, head + filler + tree)
  const read = Object.assign(
    async (want: { expect: string; from: number } | null, tail: number) =>
      ({ ...(await F.readChunk(file, want ? { from: want.from } : { tail })), sessionId: SID, file: `${SID}.jsonl`, tail: !want }),
    { scan: async (sessionId: string, end: number) => ({ sessionId, ...(await F.scanLines(file, end)) }) },
  )
  const first = await F.pageFrom(read, '', 'e2e')
  fs.appendFileSync(file, rewind)
  const rewound = await F.pageFrom(read, first.cursor, 'e2e')
  const quiet = await F.pageFrom(read, rewound.cursor, 'e2e')
  process.stdout.write(JSON.stringify({ first, rewound, quiet }))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
