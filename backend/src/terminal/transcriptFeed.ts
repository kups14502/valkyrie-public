import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { UUID_RE, paneFacts, type PaneFacts } from './tmux.js'
import { newTodoState, parseLines, splitLines, type TodoState, type TranscriptEntry, type TranscriptPage } from './transcript.js'

// Where a pane's transcript is, and the part of it the page has not seen.
//
// The page polls GET /terminal/sessions/:name/transcript about once a second
// while it is visible (routes/terminal.ts). Every poll is therefore one cheap
// read: a byte-offset cursor, a cap per call, never the whole file. A long
// session's transcript is 40 to 50 MB, mostly tool results and screenshots.
//
// WHICH TRANSCRIPT. A pane is opened with a conversation id (@vk_sid: the id
// minted for `claude --session-id`, or the one resumed), but /clear and an
// in-app /resume move the same Claude process to another id and another file.
// Claude Code keeps a live registry, <config>/sessions/<pid>.json, whose
// sessionId follows those moves (measured on odin, 2.1.283: /clear rewrote it
// within a second, and the new file appeared at once with the /clear line in
// it). So:
//   - odin panes run Claude here. The registry entry names its tmux pane
//     ("tmux": "vk-...:@162.%162"), and failing that the entry whose pid
//     descends from the pane's own process is the one.
//   - thor panes run Claude on thor behind ssh, where no tmux is visible.
//     thor's project-files service (C:\Thor\tools\session-board\project-files,
//     port 8767) watches the registry there, follows each process's id from
//     the minted one onward, and reads the file from a byte offset. It is
//     Node, so a read never waits behind the launcher agent on 8766, which is
//     single-threaded PowerShell and spends seconds on a session listing.
//     The last id thor named is sent back as a hint, which covers a service
//     restart between two /clears.
// A resumed conversation keeps its id and appends to its own file (measured:
// claude -p --resume grew the same file), so a resume pane needs nothing more.

const CLAUDE_DIR = process.env.VALKYRIE_ODIN_CLAUDE_DIR || path.join(homedir(), '.claude')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')
const REGISTRY_DIR = path.join(CLAUDE_DIR, 'sessions')

// The same service and token the project pages use (routes/proj.ts). Without
// PROJECT_FILES_URL it is thor's launcher address on the service's own port.
const FILES_URL = process.env.PROJECT_FILES_URL
  || (process.env.THOR_LAUNCHER_HOST ? `http://${process.env.THOR_LAUNCHER_HOST}:8767` : '')
const FILES_TOKEN = process.env.PROJECT_FILES_TOKEN || ''

// Entries on a first read, and the tail windows tried to find them. Measured
// on thor's transcripts: the newest 200 entries span 0.6 to 1 MB in a typical
// session and 9.7 MB in one full of screenshots.
export const FIRST_ENTRIES = 200
export const TAIL_WINDOWS = [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]
// Bytes per later read. A burst bigger than this (a large tool result) comes
// in several reads, `more: true` asking the page for the next one at once.
export const FORWARD_MAX = 512 * 1024
// The most one read ever takes in.
export const READ_CEIL = 16 * 1024 * 1024
const HUGE_CHUNK = 1024 * 1024
// Past this length a line is cut down before it is sent or parsed. Every cut
// keeps more than the parser shows (transcript.ts: RESULT_MAX, TEXT_MAX and
// the input limits), so a cut line parses to the same entries, truncated flag
// included. Measured on 40 of thor's transcripts: a first read moved up to
// 8.8 MB with only lines over 64 KB cut, because a tool result line carries
// its output twice (the content, and again in toolUseResult) and every
// assistant line carries a thinking signature or usage block of 1 to 4 KB.
// With these rules the most was 1.2 MB, and the newest 4 MB of 60 transcripts
// (6279 entries) parsed the same cut down as raw.
const BIG_LINE = 2 * 1024
const BIG_STRING = 16 * 1024
const RESULT_KEEP = 8000
const INPUT_KEEP = 4000

const THOR_TIMEOUT_MS = 8_000

const status = (code: number, message: string) => Object.assign(new Error(message), { status: code })

// ------------------------------------------------------------- reading ----

export type Chunk = {
  sessionId: string | null
  file: string | null
  size: number
  // Byte offsets in the real file: the first returned line starts at `start`,
  // and `end` is just past the last one. The cursor is built from `end`.
  start: number
  end: number
  text: string
  // The read stopped at its byte cap with more of the file after it.
  capped: boolean
  // The read was a tail read (a first read, or the cursor no longer fit).
  tail: boolean
}

export type ReadOpts = { from: number; max?: number } | { tail: number }

// A line too long to send as it is, made small: screenshots and documents go,
// tool output is cut (system reminders and terminal escapes out first, so the
// parser's own cut still sees a long result), toolUseResult keeps only what the
// task list reads, thinking loses its signature, and the context Claude Code
// attaches for the model (the system prompt snapshot is 100 KB or more per
// turn) becomes a stub, since the page never draws it. thor's service runs the
// same rules, so a thor pane and an odin pane parse the same way.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

const keep = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '\u2026' : s)
const resultKeep = (s: string): string => keep(s.replace(REMINDER_RE, '').replace(ANSI_RE, ''), RESULT_KEEP)
const skipped = (line: string) => JSON.stringify({ type: 'valkyrie-skipped', bytes: Buffer.byteLength(line) })

export function shrinkLine(line: string): string {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return skipped(line)
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return skipped(line)
  const r = o as Record<string, unknown>
  const att = r.attachment as Record<string, unknown> | undefined
  const kind = String(r.type ?? '')
  if ((kind === 'attachment' && att?.type !== 'queued_command') || /^(api-request|file-history)/.test(kind)) {
    return JSON.stringify({ type: kind, uuid: r.uuid, timestamp: r.timestamp, attachment: att ? { type: att.type } : undefined })
  }
  if ('toolUseResult' in r) r.toolUseResult = slimToolUseResult(r.toolUseResult)
  for (const k of LINE_DROP) delete r[k]
  const msg = r.message as Record<string, unknown> | undefined
  if (msg && typeof msg === 'object') {
    const m: Record<string, unknown> = { ...msg }
    for (const k of MESSAGE_DROP) delete m[k]
    if (Array.isArray(m.content)) m.content = m.content.map(slimBlock)
    r.message = m
  }
  return JSON.stringify(capValue(r, 0, BIG_STRING))
}

// Per-line weight the parser never reads: the tool inputs again
// (wireToolInputs), rate-limit state, and the API's usage and diagnostics.
const LINE_DROP = ['wireToolInputs', 'quotaLimits']
const MESSAGE_DROP = ['usage', 'container', 'context_management', 'diagnostics', 'stop_details', 'input_transformations']

function slimBlock(b: unknown): unknown {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b
  const r = b as Record<string, unknown>
  if (r.type === 'tool_result') {
    const c = r.content
    const content = typeof c === 'string'
      ? resultKeep(c)
      : Array.isArray(c)
        ? c.map((x) => {
          const t = x as Record<string, unknown> | null
          return t && typeof t === 'object' && t.type === 'text' && typeof t.text === 'string' ? { ...t, text: resultKeep(t.text) } : x
        })
        : c
    return { ...r, content }
  }
  if (r.type === 'thinking' || r.type === 'redacted_thinking') {
    const out = { ...r }
    delete out.signature
    delete out.data
    return out
  }
  if (r.type === 'tool_use' || r.type === 'server_tool_use') return { ...r, input: capValue(r.input, 0, INPUT_KEEP) }
  return r
}

// The parser reads toolUseResult only for the task list.
function slimToolUseResult(v: unknown): unknown {
  if (typeof v === 'string') return keep(v, 300)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const task = r.task as Record<string, unknown> | undefined
  if (task && typeof task === 'object') out.task = { id: task.id, subject: task.subject }
  if ('success' in r) out.success = r.success
  if ('taskId' in r) out.taskId = r.taskId
  return out
}

function capValue(v: unknown, depth: number, max: number): unknown {
  if (typeof v === 'string') return keep(v, max)
  if (Array.isArray(v)) return v.map((x) => capValue(x, depth + 1, max))
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>
    if (r.type === 'image' || r.type === 'document') return { type: r.type }
    if (r.type === 'base64') return { type: 'base64' }
    if (depth > 12) return null
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(r)) out[k] = capValue(x, depth + 1, max)
    return out
  }
  return v
}

function shrinkText(buf: Buffer): string {
  const lines = buf.toString('utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => (l.length > BIG_LINE ? shrinkLine(l) : l)).join('\n') + (lines.length ? '\n' : '')
}

async function readAt(fh: fsp.FileHandle, pos: number, len: number): Promise<Buffer> {
  if (len <= 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got === len ? buf : buf.subarray(0, got)
}

// Complete lines only, from a byte offset (`from`, a cursor's offset, always a
// line start) or from the end (`tail`, which drops the line the window opens
// in the middle of). A line still being written is left for the next read.
// thor's service has the same function in JavaScript (readLines in
// project-files.mjs); keep the two in step.
export async function readChunk(file: string, opts: ReadOpts): Promise<Omit<Chunk, 'sessionId' | 'file' | 'tail'>> {
  const fh = await fsp.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    if ('tail' in opts) {
      const start = Math.max(0, size - Math.min(opts.tail, READ_CEIL))
      const buf = await readAt(fh, start, size - start)
      let lead = 0
      if (start > 0) {
        const prev = await readAt(fh, start - 1, 1)
        if (prev[0] !== 10) {
          const nl = buf.indexOf(10)
          if (nl < 0) return { size, start: size, end: size, text: '', capped: false }
          lead = nl + 1
        }
      }
      const last = buf.lastIndexOf(10)
      if (last < lead) return { size, start: start + lead, end: start + lead, text: '', capped: false }
      return { size, start: start + lead, end: start + last + 1, text: shrinkText(buf.subarray(lead, last + 1)), capped: false }
    }

    const start = Math.min(Math.max(0, opts.from), size)
    const max = Math.min(Math.max(1, opts.max ?? FORWARD_MAX), READ_CEIL)
    let buf = await readAt(fh, start, Math.min(max, size - start))
    let last = buf.lastIndexOf(10)
    if (last < 0 && start + buf.length < size) {
      // One line longer than the cap: read on to its end, up to the ceiling.
      while (last < 0 && start + buf.length < size && buf.length < READ_CEIL) {
        const more = await readAt(fh, start + buf.length, Math.min(HUGE_CHUNK, size - start - buf.length, READ_CEIL - buf.length))
        if (!more.length) break
        buf = Buffer.concat([buf, more])
        last = buf.lastIndexOf(10)
      }
      if (last < 0 && buf.length >= READ_CEIL) {
        // Past the ceiling: skip the line, and say so in its place.
        let pos = start + buf.length
        while (pos < size) {
          const b = await readAt(fh, pos, Math.min(HUGE_CHUNK, size - pos))
          if (!b.length) break
          const at = b.indexOf(10)
          if (at >= 0) {
            const end = pos + at + 1
            return { size, start, end, text: JSON.stringify({ type: 'valkyrie-skipped', bytes: end - start }) + '\n', capped: end < size }
          }
          pos += b.length
        }
        return { size, start, end: start, text: '', capped: false }
      }
    }
    if (last < 0) return { size, start, end: start, text: '', capped: false }
    const end = start + last + 1
    return { size, start, end, text: shrinkText(buf.subarray(0, last + 1)), capped: start + buf.length < size }
  } finally {
    await fh.close()
  }
}

// --------------------------------------------------------------- odin ----

type Registry = { pid: number; sessionId: string; cwd: string; tmux: string }

async function readRegistry(): Promise<Registry[]> {
  let names: string[]
  try {
    names = await fsp.readdir(REGISTRY_DIR)
  } catch {
    return []
  }
  const out: Registry[] = []
  await Promise.all(names.filter((n) => /^\d+\.json$/.test(n)).map(async (n) => {
    try {
      const r = JSON.parse(await fsp.readFile(path.join(REGISTRY_DIR, n), 'utf8')) as Record<string, unknown>
      const sessionId = String(r.sessionId ?? '')
      if (!UUID_RE.test(sessionId) || !Number.isInteger(r.pid)) return
      out.push({ pid: r.pid as number, sessionId, cwd: typeof r.cwd === 'string' ? r.cwd : '', tmux: typeof r.tmux === 'string' ? r.tmux : '' })
    } catch { /* being rewritten, or not ours */ }
  }))
  return out
}

async function parentOf(pid: number): Promise<number> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0
  } catch {
    return 0
  }
}

async function descends(pid: number, ancestor: number): Promise<boolean> {
  let p = pid
  for (let i = 0; i < 6 && p > 1; i++) {
    p = await parentOf(p)
    if (p === ancestor) return true
  }
  return false
}

// The id each odin pane was last seen on, for when its Claude has exited and
// left the registry: the pane then still shows the conversation it ended on.
const odinLast = new Map<string, { sessionId: string; cwd: string }>()

export async function odinCurrent(name: string, facts: Pick<PaneFacts, 'sessionId' | 'panePid'>): Promise<{ sessionId: string; cwd: string } | null> {
  const reg = await readRegistry()
  let hit = reg.find((r) => r.tmux.split(':')[0] === name)
  if (!hit && facts.panePid > 1) {
    for (const r of reg) {
      if (await descends(r.pid, facts.panePid)) { hit = r; break }
    }
  }
  if (hit) {
    const cur = { sessionId: hit.sessionId, cwd: hit.cwd }
    odinLast.set(name, cur)
    if (odinLast.size > 64) odinLast.delete(odinLast.keys().next().value as string)
    return cur
  }
  return odinLast.get(name) ?? (facts.sessionId ? { sessionId: facts.sessionId, cwd: '' } : null)
}

// Claude Code names a project folder after the cwd with every character that
// is not a letter or digit turned into '-' (/home/brendon -> -home-brendon,
// C:\Thor -> C--Thor). Very long paths are shortened with a hash, which is why
// a miss falls back to looking in every folder.
export const projectFolder = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

const fileHits = new Map<string, string>()
const fileMisses = new Map<string, number>()

const isFile = (p: string) => fsp.stat(p).then((s) => s.isFile(), () => false)

export async function odinTranscriptPath(sessionId: string, cwd: string, root = PROJECTS_DIR): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null
  const key = `${root}\0${sessionId}`
  const held = fileHits.get(key)
  if (held && await isFile(held)) return held
  fileHits.delete(key)
  const remember = (p: string) => {
    fileHits.set(key, p)
    if (fileHits.size > 256) fileHits.delete(fileHits.keys().next().value as string)
    return p
  }
  if (cwd) {
    const p = path.join(root, projectFolder(cwd), `${sessionId}.jsonl`)
    if (await isFile(p)) return remember(p)
  }
  // A session that has not written its first line yet is asked about every
  // second; one sweep of the folders every few seconds is plenty.
  const missed = fileMisses.get(key)
  if (missed && Date.now() - missed < 3_000) return null
  let dirs: string[] = []
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* no projects folder yet */ }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    if (await isFile(p)) return remember(p)
  }
  fileMisses.set(key, Date.now())
  if (fileMisses.size > 256) fileMisses.delete(fileMisses.keys().next().value as string)
  return null
}

async function odinRead(name: string, facts: PaneFacts, want: { expect: string; from: number } | null, tail: number): Promise<Chunk> {
  const cur = await odinCurrent(name, facts)
  const file = cur ? await odinTranscriptPath(cur.sessionId, cur.cwd) : null
  if (!cur || !file) return { sessionId: null, file: null, size: 0, start: 0, end: 0, text: '', capped: false, tail: false }
  let forward = want !== null && want.expect === cur.sessionId
  if (forward) {
    const size = await fsp.stat(file).then((s) => s.size, () => -1)
    if (size < 0 || want!.from > size) forward = false
  }
  const r = await readChunk(file, forward ? { from: want!.from, max: FORWARD_MAX } : { tail })
  return { sessionId: cur.sessionId, file: path.basename(file), ...r, tail: !forward }
}

// --------------------------------------------------------------- thor ----

// The last current id thor named for each pane, sent back as the hint.
const thorLast = new Map<string, string>()

async function thorRead(name: string, facts: PaneFacts, want: { expect: string; from: number } | null, tail: number): Promise<Chunk> {
  if (!FILES_TOKEN) throw status(503, 'PROJECT_FILES_TOKEN is not set on the api host')
  if (!FILES_URL) throw status(503, 'PROJECT_FILES_URL is not set on the api host')
  const q = new URLSearchParams({ sid: facts.sessionId, tail: String(tail), max: String(FORWARD_MAX) })
  const hint = thorLast.get(name)
  if (hint && hint !== facts.sessionId) q.set('hint', hint)
  if (want) {
    q.set('expect', want.expect)
    q.set('from', String(want.from))
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), THOR_TIMEOUT_MS)
  let r: globalThis.Response
  try {
    r = await fetch(`${FILES_URL}/transcript?${q}`, { signal: ac.signal, headers: { Authorization: `Bearer ${FILES_TOKEN}` } })
  } catch (e) {
    throw status(502, `thor's file service is not answering (${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message})`)
  } finally {
    clearTimeout(timer)
  }
  let body: Record<string, unknown> | null = null
  try { body = (await r.json()) as Record<string, unknown> } catch { /* not json */ }
  if (!r.ok || !body) {
    // 404 is a thor service that predates /transcript: the page treats it
    // like an API without the route and asks again rarely.
    const msg = typeof body?.error === 'string' ? body.error : `thor answered ${r.status}`
    throw status(r.status === 404 ? 404 : 502, msg)
  }
  const sessionId = typeof body.sessionId === 'string' && UUID_RE.test(body.sessionId) ? body.sessionId : null
  const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)
  if (sessionId) {
    thorLast.set(name, sessionId)
    if (thorLast.size > 64) thorLast.delete(thorLast.keys().next().value as string)
  }
  const file = typeof body.file === 'string' && body.file ? path.basename(body.file) : null
  return {
    sessionId: file ? sessionId : null,
    file: sessionId ? file : null,
    size: num(body.size),
    start: num(body.start),
    end: num(body.end),
    text: typeof body.text === 'string' ? body.text : '',
    capped: body.capped === true,
    tail: body.tail !== false,
  }
}

// -------------------------------------------------------------- the feed ----

// One task list per transcript, carried from read to read (transcript.ts).
const todoStates = new Map<string, TodoState>()

function todoStateFor(key: string): TodoState {
  let st = todoStates.get(key)
  if (st) {
    todoStates.delete(key)
  } else {
    st = newTodoState()
  }
  todoStates.set(key, st)
  if (todoStates.size > 64) todoStates.delete(todoStates.keys().next().value as string)
  return st
}

// "<session id>:<byte offset>". Opaque to the page, which only hands it back.
const CURSOR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,15})$/

export function parseCursor(after: string): { sessionId: string; offset: number } | null {
  const m = CURSOR_RE.exec(after)
  return m ? { sessionId: m[1], offset: Number(m[2]) } : null
}

export const makeCursor = (sessionId: string, offset: number): string => `${sessionId}:${offset}`

export type ReadFn = (want: { expect: string; from: number } | null, tail: number) => Promise<Chunk>

// A page of entries from a reader, whichever machine it reads. Exported for
// the smoke test, which drives it with a local reader.
export async function pageFrom(read: ReadFn, after: string, todoKey: string): Promise<TranscriptPage> {
  const cur = parseCursor(after)
  const empty = (reset: boolean): TranscriptPage => ({ sessionId: null, file: null, cursor: '', entries: [], more: false, reset })

  let chunk = await read(cur ? { expect: cur.sessionId, from: cur.offset } : null, TAIL_WINDOWS[0])
  if (!chunk.sessionId || !chunk.file) return empty(after !== '')
  const st = todoStateFor(`${todoKey}:${chunk.sessionId}`)

  if (!chunk.tail) {
    const entries = parseLines(splitLines(chunk.text), st)
    return { sessionId: chunk.sessionId, file: chunk.file, cursor: makeCursor(chunk.sessionId, chunk.end), entries, more: chunk.capped, reset: false }
  }

  // A first read, or a cursor that no longer fits (another file, or a file
  // shorter than the cursor): the newest entries, widening the window until
  // there are enough or the window reaches the start of the file.
  let entries: TranscriptEntry[] = parseLines(splitLines(chunk.text), st)
  for (let i = 1; i < TAIL_WINDOWS.length && entries.length < FIRST_ENTRIES && chunk.start > 0; i++) {
    const wider = await read(null, TAIL_WINDOWS[i])
    if (wider.sessionId !== chunk.sessionId || !wider.file) break
    chunk = wider
    entries = parseLines(splitLines(chunk.text), st)
  }
  return {
    sessionId: chunk.sessionId,
    file: chunk.file,
    cursor: makeCursor(chunk.sessionId as string, chunk.end),
    entries: entries.slice(-FIRST_ENTRIES),
    more: false,
    reset: after !== '',
  }
}

// The reader for one pane, on the machine its Claude runs on.
export function readerFor(name: string, facts: PaneFacts): ReadFn {
  return facts.host === 'odin'
    ? (want, tail) => odinRead(name, facts, want, tail)
    : (want, tail) => thorRead(name, facts, want, tail)
}

// The route's whole job. null when there is no such pane.
export async function paneTranscript(name: string, after: string): Promise<TranscriptPage | null> {
  const facts = await paneFacts(name)
  if (!facts) return null
  // A shell, or a pane opened before panes carried their conversation id: on
  // odin the registry can still name its Claude, on thor there is nothing to ask.
  if (facts.host === 'thor' && !facts.sessionId) {
    return { sessionId: null, file: null, cursor: '', entries: [], more: false, reset: after !== '' }
  }
  return pageFrom(readerFor(name, facts), after, `${facts.host}:${name}`)
}
