// What a tool call shows as one line in the Chat view: its kind (the icon), a
// verb, the one argument that says what it did (the file, the command, the
// pattern, the URL), and a few words of its result. Built from the call's
// input and the result text the transcript carries; nothing is read from disk.

export type ToolKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'web' | 'agent' | 'todo' | 'ask' | 'plan' | 'skill' | 'mcp' | 'tool'

export type ToolLine = {
  kind: ToolKind
  verb: string
  /** the bold part: a file name, a command, a pattern */
  main: string
  /** the dim part after it: the folder, a description, the search path */
  sub: string
  /** a whole path or command for the tooltip */
  full: string
}

const KIND: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'run', PowerShell: 'run', BashOutput: 'run', KillShell: 'run', KillBash: 'run', Monitor: 'run',
  Grep: 'search', Glob: 'search', LS: 'search', ToolSearch: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent', Workflow: 'agent', TaskStop: 'agent', TaskOutput: 'agent',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo',
  AskUserQuestion: 'ask',
  ExitPlanMode: 'plan', EnterPlanMode: 'plan',
  Skill: 'skill', SlashCommand: 'skill',
}

const VERB: Record<string, string> = {
  Read: 'Read', NotebookRead: 'Read', Edit: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit', Write: 'Write',
  Bash: 'Run', PowerShell: 'PS', BashOutput: 'Output', KillShell: 'Kill', KillBash: 'Kill', Monitor: 'Watch',
  Grep: 'Grep', Glob: 'Glob', LS: 'List', ToolSearch: 'Tools', WebFetch: 'Fetch', WebSearch: 'Search',
  Agent: 'Agent', Task: 'Agent', Workflow: 'Flow', TaskStop: 'Stop', TaskOutput: 'Output',
  TodoWrite: 'Todos', TaskCreate: 'Task', TaskUpdate: 'Task', TaskList: 'Tasks',
  AskUserQuestion: 'Ask', ExitPlanMode: 'Plan', EnterPlanMode: 'Plan', Skill: 'Skill', SlashCommand: 'Cmd',
}

type Input = Record<string, unknown>
const obj = (v: unknown): Input => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Input) : {})
export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** A path as its last part and the folder before it, either slash. */
export function splitPath(p: string): { name: string; dir: string } {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  return i < 0 ? { name: t, dir: '' } : { name: t.slice(i + 1), dir: t.slice(0, i) }
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? ''

function host(url: string): { main: string; sub: string } {
  try {
    const u = new URL(url)
    return { main: u.host.replace(/^www\./, ''), sub: (u.pathname + u.search).replace(/^\/$/, '') }
  } catch {
    return { main: url, sub: '' }
  }
}

/** The first short string in an input, for a tool this file does not know. */
function anyArg(i: Input): string {
  for (const v of Object.values(i)) {
    const s = str(v)
    if (s && s.length <= 200) return s
  }
  for (const v of Object.values(i)) {
    const s = str(v)
    if (s) return firstLine(s)
  }
  return ''
}

export const toolKind = (name: string): ToolKind => KIND[name] ?? (name.startsWith('mcp__') ? 'mcp' : 'tool')

export function toolLine(name: string, input: unknown): ToolLine {
  const i = obj(input)
  const kind = toolKind(name)
  const verb = VERB[name] ?? (kind === 'mcp' ? 'MCP' : name.length <= 8 ? name : 'Tool')
  const file = (p: string, extra = '') => {
    const s = splitPath(p)
    return { kind, verb, main: s.name || p, sub: [s.dir, extra].filter(Boolean).join('  '), full: p }
  }
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const p = str(i.file_path) || str(i.notebook_path) || str(i.path)
      const off = Number(i.offset)
      const lim = Number(i.limit)
      const range = off > 0 || lim > 0 ? `lines ${off > 0 ? off : 1}${lim > 0 ? `-${(off > 0 ? off : 1) + lim - 1}` : '+'}` : ''
      return file(p, range)
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file(str(i.file_path) || str(i.notebook_path) || str(i.path))
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(i.command)
      return { kind, verb, main: firstLine(cmd) || cmd, sub: str(i.description), full: cmd }
    }
    case 'Grep': {
      const where = [str(i.glob) && `in ${str(i.glob)}`, str(i.type) && `type ${str(i.type)}`, str(i.path)].filter(Boolean).join('  ')
      return { kind, verb, main: str(i.pattern), sub: where, full: `${str(i.pattern)}  ${where}`.trim() }
    }
    case 'Glob':
    case 'LS':
      return { kind, verb, main: str(i.pattern) || str(i.path), sub: str(i.pattern) ? str(i.path) : '', full: [str(i.pattern), str(i.path)].filter(Boolean).join('  ') }
    case 'WebFetch': {
      const u = str(i.url)
      const h = host(u)
      return { kind, verb, main: h.main, sub: h.sub, full: u }
    }
    case 'WebSearch':
      return { kind, verb, main: str(i.query), sub: '', full: str(i.query) }
    case 'Agent':
    case 'Task': {
      const d = str(i.description) || firstLine(str(i.prompt))
      return { kind, verb, main: d, sub: str(i.subagent_type), full: d }
    }
    case 'TodoWrite': {
      const t = Array.isArray(i.todos) ? (i.todos as unknown[]) : []
      const done = t.filter((x) => str(obj(x).status) === 'completed').length
      return { kind, verb, main: `${done}/${t.length} done`, sub: '', full: '' }
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as unknown[]) : []
      const q = str(obj(qs[0]).question) || str(i.question)
      return { kind, verb, main: q || 'A question', sub: qs.length > 1 ? `+${qs.length - 1} more` : '', full: q }
    }
    case 'ExitPlanMode':
      return { kind, verb, main: 'Plan ready', sub: '', full: '' }
    case 'Skill':
    case 'SlashCommand': {
      const s = str(i.skill) || str(i.command) || str(i.name)
      return { kind, verb, main: s, sub: str(i.args), full: s }
    }
    default: {
      if (kind === 'mcp') {
        const [, server = '', tool = ''] = name.split('__')
        const a = anyArg(i)
        return { kind, verb, main: tool.replace(/_/g, ' ') || name, sub: [server, a].filter(Boolean).join('  '), full: `${server} ${tool} ${a}`.trim() }
      }
      const a = anyArg(i)
      return { kind, verb, main: VERB[name] ? a || name : name, sub: VERB[name] ? '' : a, full: `${name} ${a}`.trim() }
    }
  }
}

// ---------- the result, in a few words ----------

const lineCount = (s: string) => (s ? s.replace(/\n+$/, '').split('\n').length : 0)

/** The words at the end of a tool's line once its result is in. */
export function resultWords(name: string, text: string, isError: boolean, truncated: boolean): string {
  const t = text.trim()
  if (isError) {
    const l = firstLine(t.replace(/^<tool_use_error>|<\/tool_use_error>$/g, ''))
    if (/rejected|denied|doesn't want to proceed|did not want/i.test(l)) return 'rejected'
    if (/interrupted/i.test(l)) return 'stopped'
    // a command's output starts with what it echoed, not with why it failed
    if (KIND[name] === 'run') {
      const code = /^Exit code (\d+)/.exec(t)?.[1]
      return code ? `exit ${code}` : 'failed'
    }
    return l ? `error: ${l}` : 'error'
  }
  const plus = truncated ? '+' : ''
  const lines = (n: number) => `${n}${plus} ${n === 1 && !plus ? 'line' : 'lines'}`
  switch (KIND[name]) {
    case 'read': {
      // the server drops an image a Read returned to a placeholder
      if (/^\[(\d+ )?images?\]$/.test(t)) return 'image'
      const n = lineCount(t)
      return n ? lines(n) : 'empty'
    }
    case 'search': {
      const m = /Found (\d+) (\w+)/.exec(t)
      if (m) return `${m[1]} ${m[2]}`
      if (/^No (files|matches) found/i.test(t)) return 'none'
      const n = lineCount(t)
      return n ? lines(n) : 'none'
    }
    case 'run': {
      if (!t || t === '(No content)') return 'ok'
      const n = lineCount(t)
      return n > 1 ? lines(n) : firstLine(t)
    }
    case 'edit':
    case 'write':
    case 'todo':
      return ''
    case 'agent':
      return 'done'
    case 'web': {
      const n = lineCount(t)
      return n ? lines(n) : 'ok'
    }
    default:
      return firstLine(t)
  }
}

// ---------- a small diff for an edit ----------

export type DiffLine = { t: '+' | '-' | ' '; s: string }
export type Diff = { lines: DiffLine[]; add: number; del: number }

/**
 * A line diff of one replacement: the lines both sides share at the top and
 * bottom are context (one each side), the rest of the old side is removed and
 * the rest of the new side added. An edit is a small replacement, so this
 * reads the way Claude Code's own diff does without a real diff algorithm.
 */
function diffPair(a: string, b: string): Diff {
  const x = a.split('\n')
  const y = b.split('\n')
  let top = 0
  while (top < x.length && top < y.length && x[top] === y[top]) top++
  let end = 0
  while (end < x.length - top && end < y.length - top && x[x.length - 1 - end] === y[y.length - 1 - end]) end++
  const lines: DiffLine[] = []
  if (top > 0) lines.push({ t: ' ', s: x[top - 1] })
  const del = x.slice(top, x.length - end)
  const add = y.slice(top, y.length - end)
  for (const s of del) lines.push({ t: '-', s })
  for (const s of add) lines.push({ t: '+', s })
  if (end > 0) lines.push({ t: ' ', s: x[x.length - end] })
  return { lines, add: add.length, del: del.length }
}

/** The diff an Edit, MultiEdit or Write call makes, from its input alone. */
export function toolDiff(name: string, input: unknown): Diff | null {
  const i = obj(input)
  if (name === 'Edit') {
    if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return null
    return diffPair(i.old_string, i.new_string)
  }
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    const out: Diff = { lines: [], add: 0, del: 0 }
    for (const raw of i.edits as unknown[]) {
      const e = obj(raw)
      if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue
      const d = diffPair(e.old_string, e.new_string)
      if (out.lines.length) out.lines.push({ t: ' ', s: '…' })
      out.lines.push(...d.lines)
      out.add += d.add
      out.del += d.del
    }
    return out.lines.length ? out : null
  }
  if (name === 'Write' && typeof i.content === 'string') {
    const lines = i.content.replace(/\n$/, '').split('\n')
    return { lines: lines.map((s) => ({ t: '+' as const, s })), add: lines.length, del: 0 }
  }
  if (name === 'NotebookEdit' && typeof i.new_source === 'string') {
    const lines = i.new_source.split('\n')
    return { lines: lines.map((s) => ({ t: '+' as const, s })), add: lines.length, del: 0 }
  }
  return null
}
