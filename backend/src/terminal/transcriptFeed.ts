import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { UUID_RE, paneFacts, type PaneFacts } from './tmux.js'
import {
  newTodoState, parseLines, parseLive, rewound, splitLines,
  type ChainNode, type TodoState, type TranscriptEntry, type TranscriptPage,
} from './transcript.js'

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
// task list reads, thinking loses its signature, usage keeps only the input
// counts the context meter adds up, and the context Claude Code attaches for
// the model (the system prompt snapshot is 100 KB or more per turn) becomes a
// stub that keeps the line's place in the tree (parentUuid) and, for the model
// attachment, the model id, since the page draws none of it. thor's service
// runs the same rules, so a thor pane and an odin pane parse the same way.
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
    return JSON.stringify({ type: kind, uuid: r.uuid, parentUuid: r.parentUuid, isSidechain: r.isSidechain, timestamp: r.timestamp, attachment: att ? slimAttachment(att) : undefined })
  }
  if ('toolUseResult' in r) r.toolUseResult = slimToolUseResult(r.toolUseResult)
  for (const k of LINE_DROP) delete r[k]
  const msg = r.message as Record<string, unknown> | undefined
  if (msg && typeof msg === 'object') {
    const m: Record<string, unknown> = { ...msg }
    for (const k of MESSAGE_DROP) delete m[k]
    if ('usage' in m) m.usage = slimUsage(m.usage)
    if (Array.isArray(m.content)) m.content = m.content.map(slimBlock)
    r.message = m
  }
  return JSON.stringify(capValue(r, 0, BIG_STRING))
}

// Per-line weight the parser never reads: the tool inputs again
// (wireToolInputs), rate-limit state, and the API's diagnostics.
const LINE_DROP = ['wireToolInputs', 'quotaLimits']
const MESSAGE_DROP = ['container', 'context_management', 'diagnostics', 'stop_details', 'input_transformations']
const USAGE_KEEP = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']

function slimUsage(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of USAGE_KEEP) if (typeof r[k] === 'number') out[k] = r[k]
  return out
}

function slimAttachment(att: Record<string, unknown>): Record<string, unknown> {
  const id = att.identity as Record<string, unknown> | undefined
  if (att.type === 'model' && id && typeof id === 'object' && typeof id.modelId === 'string') return { type: att.type, identity: { modelId: keep(id.modelId, 200) } }
  return { type: att.type }
}

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

// The lines that build the task list and name the model, from the start of
// the file to `end` (where a first read's tail window starts), so the first
// page knows tasks made before its window and the model's context window. One
// streamed pass; only matching lines are kept, cut down like any other, the
// newest SCAN_MAX bytes of them. A line matches when it names a task tool or
// a model id, or answers a task call it saw (the result names the call's id,
// not the tool). Quoted names skip most prose about them: in a tool result
// the quotes are escaped. thor's service has the same function (scanLines in
// project-files.mjs); keep the two in step.
export const SCAN_MAX = 2 * 1024 * 1024
const SCAN_WORDS = ['"TaskCreate"', '"TaskUpdate"', '"TodoWrite"', '"modelId"']
const SCAN_TASKS = ['"TaskCreate"', '"TaskUpdate"']

function taskCallIds(line: string): string[] {
  try {
    const o = JSON.parse(line) as { message?: { content?: unknown } }
    const c = o?.message?.content
    if (!Array.isArray(c)) return []
    return c.filter((b) => b && typeof b === 'object' && b.type === 'tool_use' && (b.name === 'TaskCreate' || b.name === 'TaskUpdate') && typeof b.id === 'string' && b.id)
      .map((b) => b.id as string)
  } catch {
    return []
  }
}

export async function scanLines(file: string, end: number): Promise<{ text: string; capped: boolean; end: number }> {
  const fh = await fsp.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    const stop = Math.min(Math.max(0, end), size)
    const kept: string[] = []
    let bytes = 0
    let capped = false
    let pending: string[] = []
    const take = (l: string) => {
      let hit = SCAN_WORDS.some((w) => l.includes(w))
      if (!hit && pending.length) {
        const i = pending.findIndex((id) => l.includes(id))
        if (i >= 0) { pending.splice(i, 1); hit = true }
      }
      if (!hit) return
      if (SCAN_TASKS.some((w) => l.includes(w))) pending = [...pending, ...taskCallIds(l)].slice(-200)
      const out = l.length > BIG_LINE ? shrinkLine(l) : l
      kept.push(out)
      bytes += Buffer.byteLength(out) + 1
      while (bytes > SCAN_MAX && kept.length) {
        bytes -= Buffer.byteLength(kept.shift() as string) + 1
        capped = true
      }
    }
    let rest: Buffer = Buffer.alloc(0)
    let skipping = false
    let pos = 0
    while (pos < stop) {
      const buf = await readAt(fh, pos, Math.min(HUGE_CHUNK, stop - pos))
      if (!buf.length) break
      pos += buf.length
      let data = rest.length ? Buffer.concat([rest, buf]) : buf
      if (skipping) {
        // the rest of a line past the ceiling
        const nl = data.indexOf(10)
        if (nl < 0) { rest = Buffer.alloc(0); continue }
        data = data.subarray(nl + 1)
        skipping = false
      }
      const last = data.lastIndexOf(10)
      if (last < 0) {
        rest = data
      } else {
        const text = data.toString('utf8', 0, last)
        rest = data.subarray(last + 1)
        // most of a long transcript names no task: one look per chunk
        if (pending.length || SCAN_WORDS.some((w) => text.includes(w))) for (const l of text.split('\n')) take(l)
      }
      if (rest.length > READ_CEIL) { rest = Buffer.alloc(0); skipping = true }
    }
    return { text: kept.length ? kept.join('\n') + '\n' : '', capped, end: pos }
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

async function odinScan(name: string, facts: PaneFacts, sessionId: string, end: number): Promise<Scan | null> {
  const cur = await odinCurrent(name, facts)
  if (!cur || cur.sessionId !== sessionId) return null
  const file = await odinTranscriptPath(cur.sessionId, cur.cwd)
  if (!file) return null
  const r = await scanLines(file, end)
  return { sessionId, text: r.text, capped: r.capped }
}

// --------------------------------------------------------------- thor ----

// The last current id thor named for each pane, sent back as the hint.
const thorLast = new Map<string, string>()

async function thorGet(name: string, facts: PaneFacts, q: URLSearchParams): Promise<Record<string, unknown>> {
  if (!FILES_TOKEN) throw status(503, 'PROJECT_FILES_TOKEN is not set on the api host')
  if (!FILES_URL) throw status(503, 'PROJECT_FILES_URL is not set on the api host')
  q.set('sid', facts.sessionId)
  const hint = thorLast.get(name)
  if (hint && hint !== facts.sessionId) q.set('hint', hint)
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
  return body
}

// The task and model lines before a tail window, scanned on thor so odin never
// pulls the whole file over the network. A service that predates todos=1
// answers a plain tail read without `todos: true`, which is ignored.
async function thorScan(name: string, facts: PaneFacts, sessionId: string, end: number): Promise<Scan | null> {
  const body = await thorGet(name, facts, new URLSearchParams({ todos: '1', expect: sessionId, end: String(end) }))
  if (body.todos !== true || body.sessionId !== sessionId || typeof body.text !== 'string') return null
  return { sessionId, text: body.text, capped: body.capped === true }
}

async function thorRead(name: string, facts: PaneFacts, want: { expect: string; from: number } | null, tail: number): Promise<Chunk> {
  const q = new URLSearchParams({ tail: String(tail), max: String(FORWARD_MAX) })
  if (want) {
    q.set('expect', want.expect)
    q.set('from', String(want.from))
  }
  const body = await thorGet(name, facts, q)
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

// One task list (and model) per transcript, carried from read to read
// (transcript.ts). A first read builds a new one from the whole file.
const todoStates = new Map<string, TodoState>()

function keepState(key: string, st: TodoState): TodoState {
  todoStates.delete(key)
  todoStates.set(key, st)
  if (todoStates.size > 64) todoStates.delete(todoStates.keys().next().value as string)
  return st
}

// "<session id>:<byte offset>:<uuid of the newest line read>". The uuid is
// how a later read tells a rewind from an append; a cursor without one (from
// before it was added) still reads forward. Opaque to the page, which only
// hands it back.
const CURSOR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,15})(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/

export function parseCursor(after: string): { sessionId: string; offset: number; leaf: string | null } | null {
  const m = CURSOR_RE.exec(after)
  return m ? { sessionId: m[1], offset: Number(m[2]), leaf: m[3] ?? null } : null
}

export const makeCursor = (sessionId: string, offset: number, leaf: string | null = null): string =>
  leaf && UUID_RE.test(leaf) ? `${sessionId}:${offset}:${leaf}` : `${sessionId}:${offset}`

export type Scan = { sessionId: string; text: string; capped: boolean }

// A reader: one call reads lines (forward from a cursor, or a tail window);
// `scan`, when the machine has it, returns the task and model lines before a
// byte offset (scanLines).
export type ReadFn = ((want: { expect: string; from: number } | null, tail: number) => Promise<Chunk>) & {
  scan?: (sessionId: string, end: number) => Promise<Scan | null>
}

// The task list and model as they stood at byte `end`, built from the scan.
// The newest list it produced is returned for the page to start with.
async function seedState(read: ReadFn, sessionId: string, end: number, st: TodoState): Promise<TranscriptEntry | null> {
  if (end <= 0 || !read.scan) return null
  let scan: Scan | null = null
  try {
    scan = await read.scan(sessionId, end)
  } catch (err) {
    // the page still works without it: tasks made earlier show by number
    console.error('[terminal] transcript scan failed', (err as Error).message)
  }
  if (!scan || scan.sessionId !== sessionId) return null
  let last: TranscriptEntry | null = null
  for (const e of parseLines(splitLines(scan.text), st)) if (e.kind === 'todo') last = e
  return last
}

// A page of entries from a reader, whichever machine it reads. Exported for
// the smoke test, which drives it with a local reader.
export async function pageFrom(read: ReadFn, after: string, todoKey: string): Promise<TranscriptPage> {
  const cur = parseCursor(after)
  const empty = (reset: boolean): TranscriptPage => ({ sessionId: null, file: null, cursor: '', entries: [], more: false, reset })

  const chunk = await read(cur ? { expect: cur.sessionId, from: cur.offset } : null, TAIL_WINDOWS[0])
  if (!chunk.sessionId || !chunk.file) return empty(after !== '')

  if (!chunk.tail && cur) {
    const key = `${todoKey}:${chunk.sessionId}`
    let st = todoStates.get(key)
    if (!st) {
      // the server restarted under a page that kept reading
      st = newTodoState()
      await seedState(read, chunk.sessionId, chunk.start, st)
    }
    keepState(key, st)
    const chain: ChainNode[] = []
    const entries = parseLines(splitLines(chunk.text), st, chain)
    if (!rewound(chain, cur.leaf)) {
      const leaf = chain.length ? chain[chain.length - 1].uuid : cur.leaf
      return { sessionId: chunk.sessionId, file: chunk.file, cursor: makeCursor(chunk.sessionId, chunk.end, leaf), entries, more: chunk.capped, reset: false }
    }
    // A rewind (Esc Esc, /rewind, a send canceled and sent again): entries
    // the page holds are off the conversation now. Old and new pages both
    // handle reset by dropping what they hold for the newest entries.
    const fresh = await read(null, TAIL_WINDOWS[0])
    if (!fresh.sessionId || !fresh.file) return empty(true)
    return firstPage(read, fresh, todoKey, true)
  }

  // A first read, or a cursor that no longer fits (another file, or a file
  // shorter than the cursor).
  return firstPage(read, chunk, todoKey, after !== '')
}

// The newest entries of the live branch, widening the window until there are
// enough or it reaches the start of the file, with the task list built from
// everything before the window.
async function firstPage(read: ReadFn, first: Chunk, todoKey: string, reset: boolean): Promise<TranscriptPage> {
  let chunk = first
  const sessionId = chunk.sessionId as string
  let count = parseLive(splitLines(chunk.text)).entries.length
  for (let i = 1; i < TAIL_WINDOWS.length && count < FIRST_ENTRIES && chunk.start > 0; i++) {
    const wider = await read(null, TAIL_WINDOWS[i])
    if (wider.sessionId !== sessionId || !wider.file) break
    chunk = wider
    count = parseLive(splitLines(chunk.text)).entries.length
  }
  const st = keepState(`${todoKey}:${sessionId}`, newTodoState())
  let seed = await seedState(read, sessionId, chunk.start, st)
  const { entries, leaf } = parseLive(splitLines(chunk.text), st)
  const cut = Math.max(0, entries.length - FIRST_ENTRIES)
  for (let i = cut - 1; i >= 0; i--) {
    if (entries[i].kind === 'todo') { seed = entries[i]; break }
  }
  const page = entries.slice(cut)
  // The list as it stood where the page starts, so tasks made before it show
  // by name and the ones nothing has touched since are there at all.
  if (seed?.todos?.length) page.unshift({ id: seed.id, at: page[0]?.at || seed.at, kind: 'todo', todos: seed.todos })
  return {
    sessionId,
    file: chunk.file,
    cursor: makeCursor(sessionId, chunk.end, leaf),
    entries: page,
    more: false,
    reset,
  }
}

// The reader for one pane, on the machine its Claude runs on.
export function readerFor(name: string, facts: PaneFacts): ReadFn {
  return facts.host === 'odin'
    ? Object.assign((want: { expect: string; from: number } | null, tail: number) => odinRead(name, facts, want, tail), {
      scan: (sessionId: string, end: number) => odinScan(name, facts, sessionId, end),
    })
    : Object.assign((want: { expect: string; from: number } | null, tail: number) => thorRead(name, facts, want, tail), {
      scan: (sessionId: string, end: number) => thorScan(name, facts, sessionId, end),
    })
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
