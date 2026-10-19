import { createHash } from 'node:crypto'

// The conversation in a pane, as the page's Chat view draws it.
//
// Claude Code writes every session to a JSONL transcript (<config>/projects/
// <folder>/<session id>.jsonl), one JSON object per line. This file turns a run
// of those lines into the entries the page renders. It is pure: no files, no
// network, so the smoke test (scripts/transcriptSmoke.mts) drives it with a
// fixture. transcriptFeed.ts finds and reads the lines.
//
// What a transcript holds, measured on 2.1.280 to 2.1.283:
//   - user lines: what was typed (string content, or text and image blocks),
//     tool results (tool_result blocks, with the tool's own result object in
//     the line's `toolUseResult`), and a lot that nobody typed: isMeta caveats,
//     <command-name> wrappers for slash commands, <local-command-stdout>,
//     <task-notification>, the compaction summary (isCompactSummary).
//   - assistant lines: ONE content block per line (text, thinking or tool_use),
//     several lines per API message. Thinking on current models is usually an
//     empty string with a signature, which says nothing worth drawing.
//   - system lines by subtype: informational (usage limit, hook notices),
//     away_summary, compact_boundary, local_command; turn_duration and
//     stop_hook_summary are bookkeeping.
//   - attachments: almost all are context injected for the model (the system
//     prompt snapshot alone is 100 KB or more per turn). queued_command is the
//     exception: a message Brendon typed while Claude was working.
//   - bookkeeping with no uuid: mode, permission-mode, last-prompt, ai-title,
//     cost-state, file-history-*, queue-operation, api-request-*.
// Anything not recognized is skipped, so a new Claude Code line type costs
// nothing until it is worth drawing.

export type TranscriptKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'result' | 'todo' | 'system'

export type TranscriptTodo = { content: string; status: string }

// How full the context was when Claude wrote an assistant line: the request's
// input tokens (input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens) against the model's context window.
export type TranscriptUsage = { tokens: number; window: number }

export type TranscriptEntry = {
  // Stable for the life of the transcript: the line's uuid plus the block's
  // index, so the page can merge pages by id and a re-read never duplicates.
  id: string
  at: number
  kind: TranscriptKind
  text?: string
  tool?: { name: string; input: unknown; id: string }
  result?: { toolId: string; text: string; isError: boolean; truncated: boolean }
  todos?: TranscriptTodo[]
  model?: string
  usage?: TranscriptUsage
}

export type TranscriptPage = {
  sessionId: string | null
  file: string | null
  cursor: string
  entries: TranscriptEntry[]
  more: boolean
  reset: boolean
}

// How much of each thing the page gets. A tool result is the big one: a Read
// is up to 25k tokens, a Bash run can be megabytes. The page shows the head
// and can open the raw terminal for the rest.
export const RESULT_MAX = 4000
export const TEXT_MAX = 12_000
const SYSTEM_MAX = 2000
const INPUT_STRING_MAX = 2000
const INPUT_JSON_MAX = 8000
const INPUT_ARRAY_MAX = 50

// The task list. Claude Code 2.1 keeps it with TaskCreate (subject, returns
// the id in toolUseResult.task.id) and TaskUpdate (taskId plus any of status,
// subject); older builds and other agents send the whole list with TodoWrite.
// The state is carried between reads of the same transcript (transcriptFeed.ts
// keeps one per session) because a create and its updates can land in
// different reads. Every operation is a set by id, so reading a line twice
// changes nothing. The same state carries the model the session last said it
// runs (a `model` attachment, "claude-opus-5-5[1m]"), which sets the context
// window: assistant lines name the API model only, never the [1m].
export type TodoState = {
  tasks: Map<string, TranscriptTodo>
  // tool_use id -> what the call asked for, until its result says it worked
  pending: Map<string, { name: string; input: Record<string, unknown> }>
  modelId: string
}

export const newTodoState = (): TodoState => ({ tasks: new Map(), pending: new Map(), modelId: '' })

export const CONTEXT_WINDOW = 200_000
export const CONTEXT_WINDOW_1M = 1_000_000

const ONE_M = /\[1m\]$/i

// The window an assistant line ran in: 1M when its model id ends in [1m], when
// the session's model attachment says [1m] for the same model, or when the
// line used more than 200k (only a 1M window holds that); else 200k.
export function contextWindow(lineModel: string, sessionModel: string, tokens: number): number {
  if (ONE_M.test(lineModel)) return CONTEXT_WINDOW_1M
  const base = sessionModel.replace(ONE_M, '')
  if (base !== sessionModel && lineModel && (base === lineModel || base.startsWith(lineModel) || lineModel.startsWith(base))) return CONTEXT_WINDOW_1M
  return tokens > CONTEXT_WINDOW ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

function usageOf(msg: Json, model: string, st: TodoState): TranscriptUsage | null {
  const u = isObj(msg.usage) ? msg.usage : null
  if (!u) return null
  const tokens = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)
  return tokens ? { tokens, window: contextWindow(model, st.modelId, tokens) } : null
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export const stripAnsi = (s: string): string => s.replace(ANSI, '')

function cut(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  // Never split a surrogate pair: half an emoji is an invalid string.
  let end = max
  const c = s.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end -= 1
  return { text: s.slice(0, end) + '…', truncated: true }
}

const clean = (s: string): string => stripAnsi(s.replace(REMINDER, '')).replace(/\r\n?/g, '\n').trim()

const tag = (s: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)
  return m ? m[1] : null
}

// A tool's input, every long string cut and every long array shortened, so
// one Write of a large file cannot make a page of entries megabytes long.
export function trimInput(v: unknown, strMax = INPUT_STRING_MAX, depth = 0): unknown {
  if (typeof v === 'string') return cut(v, strMax).text
  if (Array.isArray(v)) return v.slice(0, INPUT_ARRAY_MAX).map((x) => trimInput(x, strMax, depth + 1))
  if (isObj(v)) {
    if (depth > 6) return '…'
    const out: Json = {}
    for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, strMax, depth + 1)
    return out
  }
  return v
}

function toolInput(input: unknown): unknown {
  const first = trimInput(input)
  if (JSON.stringify(first ?? null).length <= INPUT_JSON_MAX) return first
  return trimInput(input, 400)
}

// Text and placeholders out of a content array (user prompts, tool results,
// queued messages). Images and documents are never sent: a placeholder says
// one was there.
function blocksText(blocks: unknown[], opts: { imageNote: boolean }): string {
  const parts: string[] = []
  const refs: string[] = []
  let images = 0
  for (const b of blocks) {
    if (typeof b === 'string') { parts.push(b); continue }
    if (!isObj(b)) continue
    if (b.type === 'text') parts.push(str(b.text))
    else if (b.type === 'image') images += 1
    else if (b.type === 'document') parts.push('[document]')
    else if (b.type === 'tool_reference') refs.push(str(b.tool_name))
  }
  let text = parts.join('\n')
  if (refs.length) text = (text ? text + '\n' : '') + `Loaded ${refs.filter(Boolean).join(', ')}`
  // A typed prompt already says "[Image #1]" where each picture was pasted, so
  // a second marker would only repeat it.
  if (images && (opts.imageNote || !/\[Image #?\d*/.test(text))) {
    text = (text ? text + '\n' : '') + (images === 1 ? '[image]' : `[${images} images]`)
  }
  return text
}

// A string a user line carries. Most are what Brendon typed; the rest are
// Claude Code's own wrappers, which become a short system line or nothing.
function userString(raw: string): { kind: 'user' | 'system'; text: string } | null {
  const s = raw.trim()
  if (!s) return null
  if (s.startsWith('<local-command-caveat>') || s.startsWith('<system-reminder>')) return null
  const name = tag(s, 'command-name')
  if (name !== null) {
    const args = (tag(s, 'command-args') ?? '').trim()
    return { kind: 'user', text: args ? `${name.trim()} ${args}` : name.trim() }
  }
  if (s.startsWith('<local-command-stdout>') || s.startsWith('<local-command-stderr>')) {
    const out = clean([tag(s, 'local-command-stdout'), tag(s, 'local-command-stderr')].filter(Boolean).join('\n'))
    return out ? { kind: 'system', text: cut(out, SYSTEM_MAX).text } : null
  }
  if (s.startsWith('<bash-input>')) return { kind: 'user', text: `! ${(tag(s, 'bash-input') ?? '').trim()}` }
  if (s.startsWith('<bash-stdout>') || s.startsWith('<bash-stderr>')) {
    const out = clean([tag(s, 'bash-stdout'), tag(s, 'bash-stderr')].filter(Boolean).join('\n'))
    return out ? { kind: 'system', text: cut(out, SYSTEM_MAX).text } : null
  }
  if (s.startsWith('<task-notification>')) {
    const status = (tag(s, 'status') ?? '').trim()
    const summary = clean(tag(s, 'summary') ?? '')
    const text = [status ? `Background task ${status}` : 'Background task', summary].filter(Boolean).join(': ')
    return { kind: 'system', text: cut(text, SYSTEM_MAX).text }
  }
  const text = clean(s.replace(/<\/?pasted_content[^>]*>/g, ''))
  return text ? { kind: 'user', text: cut(text, TEXT_MAX).text } : null
}

const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

const timeOf = (o: Json): number => {
  const t = Date.parse(str(o.timestamp))
  return Number.isFinite(t) ? t : 0
}

// A line with no uuid (none of the drawn kinds lack one today) still needs an
// id that is the same on every read.
const lineId = (o: Json, line: string): string =>
  str(o.uuid) || `h${createHash('sha1').update(line).digest('hex').slice(0, 16)}`

function todoList(st: TodoState): TranscriptTodo[] {
  return [...st.tasks.entries()]
    .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0) || a[0].localeCompare(b[0]))
    .map(([, t]) => ({ ...t }))
}

// TodoWrite carries the whole list in its input.
function todoWriteList(input: Json): TranscriptTodo[] | null {
  if (!Array.isArray(input.todos)) return null
  return input.todos
    .filter(isObj)
    .map((t) => ({ content: cut(str(t.content) || str(t.subject), 300).text, status: str(t.status) || 'pending' }))
}

// A TaskCreate or TaskUpdate whose result came back. True when the list changed.
function applyTask(st: TodoState, call: { name: string; input: Json }, line: Json, resultText: string, isError: boolean): boolean {
  if (isError) return false
  const tur = isObj(line.toolUseResult) ? line.toolUseResult : {}
  if (call.name === 'TaskCreate') {
    const task = isObj(tur.task) ? tur.task : {}
    const id = str(task.id) || (/#(\d+)/.exec(resultText)?.[1] ?? '')
    if (!id) return false
    const prev = st.tasks.get(id)
    st.tasks.set(id, {
      content: cut(str(call.input.subject) || str(task.subject) || prev?.content || `Task ${id}`, 300).text,
      status: prev?.status || 'pending',
    })
    return true
  }
  if (tur.success === false) return false
  const id = str(call.input.taskId) || str(tur.taskId)
  if (!id) return false
  const status = str(call.input.status)
  if (status === 'deleted') return st.tasks.delete(id)
  const prev = st.tasks.get(id)
  // Created before the first line this state saw: the update names no subject.
  st.tasks.set(id, {
    content: cut(str(call.input.subject) || prev?.content || `Task ${id}`, 300).text,
    status: status || prev?.status || 'pending',
  })
  return true
}

// The entries for a run of complete transcript lines, in file order. `chain`,
// when given, collects each line's place in the conversation tree (see
// abandoned below).
export function parseLines(lines: Iterable<string>, st: TodoState = newTodoState(), chain?: ChainNode[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  const seen = new Set<string>()
  const push = (e: TranscriptEntry) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }

  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue
    let o: Json
    try {
      const v = JSON.parse(line) as unknown
      if (!isObj(v)) continue
      o = v
    } catch {
      continue
    }
    // Subagent turns in the main file, and anything Claude Code marks as for
    // the model only.
    if (o.isSidechain === true) continue
    const type = str(o.type)
    const at = timeOf(o)
    const id = lineId(o, line)
    const msg = isObj(o.message) ? o.message : {}
    const content = msg.content
    if (chain && typeof o.uuid === 'string' && o.uuid && 'parentUuid' in o) chain.push(chainNode(o, type, content))

    if (type === 'user') {
      if (o.isCompactSummary === true) {
        const body = clean(typeof content === 'string' ? content : Array.isArray(content) ? blocksText(content, { imageNote: false }) : '')
        push({ id, at, kind: 'system', text: cut(body ? `Earlier conversation compacted.\n\n${body}` : 'Earlier conversation compacted.', SYSTEM_MAX).text })
        continue
      }
      if (o.isMeta === true) continue
      if (typeof content === 'string') {
        const u = userString(content)
        if (u) push({ id, at, kind: u.kind, text: u.text })
        continue
      }
      if (!Array.isArray(content)) continue
      const typed: unknown[] = []
      content.forEach((b, i) => {
        if (!isObj(b)) return
        if (b.type === 'tool_result') {
          const toolId = str(b.tool_use_id)
          const raw = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? blocksText(b.content, { imageNote: true }) : ''
          const { text, truncated } = cut(clean(raw), RESULT_MAX)
          const isError = b.is_error === true
          push({ id: `${id}:${i}`, at, kind: 'result', result: { toolId, text, isError, truncated } })
          const call = st.pending.get(toolId)
          if (call) {
            st.pending.delete(toolId)
            if (applyTask(st, call, o, raw, isError)) push({ id: `${id}:${i}:todo`, at, kind: 'todo', todos: todoList(st) })
          }
          return
        }
        if (b.type === 'text' && INTERRUPTED.test(str(b.text).trim())) {
          push({ id: `${id}:${i}`, at, kind: 'system', text: 'Interrupted' })
          return
        }
        typed.push(b)
      })
      if (typed.length) {
        const text = clean(blocksText(typed, { imageNote: false }))
        if (text) push({ id, at, kind: 'user', text: cut(text, TEXT_MAX).text })
      }
      continue
    }

    if (type === 'assistant') {
      if (!Array.isArray(content)) continue
      const model = str(msg.model)
      const synthetic = model === '<synthetic>' || !model
      if (o.isApiErrorMessage === true) {
        const text = clean(blocksText(content, { imageNote: false }))
        if (text) push({ id, at, kind: 'system', text: cut(text, SYSTEM_MAX).text })
        continue
      }
      // Every line of one API message carries that request's usage, so each
      // entry an assistant line makes says how full the context was.
      const usage = synthetic ? null : usageOf(msg, model, st)
      const m = synthetic ? {} : usage ? { model, usage } : { model }
      content.forEach((b, i) => {
        if (!isObj(b)) return
        const bid = content.length === 1 ? id : `${id}:${i}`
        if (b.type === 'text') {
          const text = str(b.text).trim()
          if (text) push({ id: bid, at, kind: 'assistant', text: cut(text, TEXT_MAX).text, ...m })
        } else if (b.type === 'thinking') {
          const text = str(b.thinking).trim()
          if (text) push({ id: bid, at, kind: 'thinking', text: cut(text, TEXT_MAX).text, ...m })
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const name = str(b.name) || 'tool'
          const toolId = str(b.id)
          const input = isObj(b.input) ? b.input : {}
          push({ id: bid, at, kind: 'tool', tool: { name, input: toolInput(b.input ?? null), id: toolId }, ...m })
          if (name === 'TodoWrite') {
            const todos = todoWriteList(input)
            if (todos) push({ id: `${bid}:todo`, at, kind: 'todo', todos })
          } else if (TASK_TOOLS.has(name) && toolId) {
            st.pending.set(toolId, { name, input })
            // A call whose result never comes (an interrupted turn) must not
            // pile up for the life of the server.
            if (st.pending.size > 200) st.pending.delete(st.pending.keys().next().value as string)
          }
        } else if (typeof b.type === 'string' && b.type.endsWith('_tool_result')) {
          // Server tools (web search) answer inside the assistant message.
          const n = Array.isArray(b.content) ? b.content.length : 0
          push({ id: bid, at, kind: 'result', result: { toolId: str(b.tool_use_id), text: n ? `${n} results` : '', isError: false, truncated: false }, ...(usage ? { usage } : {}) })
        }
      })
      continue
    }

    if (type === 'system') {
      const sub = str(o.subtype)
      let text = ''
      if (sub === 'compact_boundary') text = 'Conversation compacted'
      else if (sub === 'informational' || sub === 'away_summary' || sub === 'api_error') text = clean(str(o.content))
      else if (sub === 'local_command') {
        const c = str(o.content)
        text = clean([tag(c, 'local-command-stdout'), tag(c, 'local-command-stderr')].filter((x) => x !== null).join('\n'))
      }
      if (text) push({ id, at, kind: 'system', text: cut(text, SYSTEM_MAX).text })
      continue
    }

    if (type === 'attachment') {
      const a = isObj(o.attachment) ? o.attachment : {}
      // The model the session runs, at its start and after /model.
      if (a.type === 'model' && isObj(a.identity) && str(a.identity.modelId)) {
        st.modelId = cut(str(a.identity.modelId), 120).text
        continue
      }
      // A message typed while Claude was busy. It reaches the model as a
      // reminder, so this is the only record of it in Brendon's words.
      if (a.type === 'queued_command' && (a.humanTurn === true || (isObj(a.origin) && a.origin.kind === 'human'))) {
        const p = a.prompt
        const text = clean(typeof p === 'string' ? p : Array.isArray(p) ? blocksText(p, { imageNote: false }) : '')
        if (text) push({ id, at, kind: 'user', text: cut(text, TEXT_MAX).text })
      }
      continue
    }
  }
  return out
}

// Bytes of complete lines into lines. The reader only ever hands over whole
// lines, so a trailing newline is the only thing to drop.
export const splitLines = (text: string): string[] => text.split('\n').filter((l) => l.length > 0)

// ------------------------------------------------------------ branches ----
//
// Esc Esc, /rewind, and a prompt sent and then canceled before Claude answered
// all leave the dropped turn in the file. The transcript is append-only and a
// tree: every line names its parent (parentUuid), and the new prompt names
// the line before the turn it replaces. What Claude Code shows is the chain
// from the newest line back through the parents. Measured on 200 of thor's
// transcripts (2.1.28x):
//   - 93 rewinds and canceled sends. Each dropped branch starts with a user
//     line (a prompt, a slash command); the new prompt names the same parent.
//   - Parallel tool calls branch too, without dropping anything: a result
//     names its own call, so all but one result of a batch hang off the chain.
//     They must stay.
//   - A compact boundary has no parent. Its logicalParentUuid names the line
//     before the compaction, or, when the compaction kept a segment, a line
//     after the boundary (followed, that would loop).
//   - 2633 prompts: 2539 name the line just before them as their parent, 93
//     are the rewinds above, and 1 follows a stray tool call hanging off the
//     chain (a forward read treats it as a rewind: one harmless reset).
// So a line is off the conversation only when its branch leaves the chain at
// a user line. A line whose ancestors leave the window (a tail window starts
// mid-file) without meeting the chain stays: nothing says it was dropped.

export type ChainNode = { uuid: string; parent: string | null; logical: string | null; boundary: boolean; prompt: boolean }

function chainNode(o: Json, type: string, content: unknown): ChainNode {
  const prompt = type === 'user' && o.isMeta !== true && o.isCompactSummary !== true &&
    !(Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result'))
  return {
    uuid: str(o.uuid),
    parent: str(o.parentUuid) || null,
    logical: str(o.logicalParentUuid) || null,
    boundary: type === 'system' && o.subtype === 'compact_boundary',
    prompt,
  }
}

/** The line an entry came from: its id up to the first ':' (a uuid has none). */
export const lineOf = (entryId: string): string => {
  const i = entryId.indexOf(':')
  return i < 0 ? entryId : entryId.slice(0, i)
}

/** The uuids of the lines in `chain` (one window, file order) that a rewind left behind. */
export function abandoned(chain: ChainNode[]): Set<string> {
  const out = new Set<string>()
  if (chain.length < 2) return out
  const at = new Map<string, number>()
  chain.forEach((n, i) => { if (!at.has(n.uuid)) at.set(n.uuid, i) })
  // the live chain, from the newest line back
  const live = new Set<string>()
  let i: number | undefined = chain.length - 1
  while (i !== undefined && !live.has(chain[i].uuid)) {
    const n: ChainNode = chain[i]
    live.add(n.uuid)
    let next = n.parent
    if (!next && n.boundary) {
      const l = n.logical ? at.get(n.logical) : undefined
      next = l !== undefined && l < i ? n.logical : i > 0 ? chain[i - 1].uuid : null
    }
    i = next ? at.get(next) : undefined
  }
  // every other line: the first line of its branch, when the branch starts on
  // the chain (parents come before children in the file)
  const branch = new Map<string, ChainNode | null>()
  for (const n of chain) {
    if (live.has(n.uuid)) continue
    let root: ChainNode | null = null
    if (n.parent && at.has(n.parent)) root = live.has(n.parent) ? n : branch.get(n.parent) ?? null
    branch.set(n.uuid, root)
    if (root?.prompt) out.add(n.uuid)
  }
  return out
}

/**
 * Whether the lines after `leaf` (the newest line the page has seen) rewind:
 * a user line whose parent is not the line just before it.
 */
export function rewound(chain: ChainNode[], leaf: string | null): boolean {
  let prev = leaf
  for (const n of chain) {
    if (n.prompt && n.parent && prev && n.parent !== prev) return true
    prev = n.uuid
  }
  return false
}

/** A window of lines as the page should see it: the live branch only, and the newest line's uuid. */
export function parseLive(lines: Iterable<string>, st: TodoState = newTodoState()): { entries: TranscriptEntry[]; leaf: string | null } {
  const chain: ChainNode[] = []
  const all = parseLines(lines, st, chain)
  const drop = abandoned(chain)
  return {
    entries: drop.size ? all.filter((e) => !drop.has(lineOf(e.id))) : all,
    leaf: chain.length ? chain[chain.length - 1].uuid : null,
  }
}
