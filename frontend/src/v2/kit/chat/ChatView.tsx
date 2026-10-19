import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import {
  ArrowDown, Bot, Brain, Check, ChevronDown, CircleAlert, CircleDot, ClipboardList, Copy, FilePen, FilePlus, FileText,
  Globe, Info, ListChecks, MessageCircleQuestion, Plug, Search, Sparkles, Square, SquareTerminal, Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { TranscriptEntry, TranscriptTodo } from '../../../lib/api'
import type { TermConnState } from '../../../lib/termSession'
import { safeHref } from '../../../components/Markdown'
import { copyText } from '../../../lib/clipboard'
import { Press, cx, toast } from '../ui'
import { StateGlyph } from '../termskin'
import type { Phase } from '../termscreen'
import type { Foot } from './foot'
import { latestModel, todosOfInput, type Transcript } from './transcript'
import { resultWords, str, toolDiff, toolKind, toolLine, type Diff, type ToolKind } from './tools'
import { stripAnsi, userPart, type UserPart } from './user'
import './chat.css'

// The Chat view of a session (screens/Term.tsx): the conversation drawn from
// the pane's transcript instead of from its screen. Prompts, Claude's answers
// as markdown, thinking folded to a line, every tool call as one line with its
// key argument and its result folded under it, the live todo list, and a
// footer with what the screen says (working, context, usage). The CLI stays the
// engine: the composer, the keys and the question plates all still talk to the
// real pane, and the raw terminal is one tap away.

// ---------- rows ----------

type RunItem =
  | { t: 'tool'; e: TranscriptEntry; r: TranscriptEntry | null }
  | { t: 'think'; e: TranscriptEntry }
  | { t: 'todo'; e: TranscriptEntry }

type Row =
  | { t: 'time'; key: string; at: number }
  | { t: 'user'; key: string; part: Exclude<UserPart, { kind: 'hidden' }> }
  | { t: 'said'; key: string; text: string }
  | { t: 'run'; key: string; items: RunItem[] }
  | { t: 'sys'; key: string; text: string }

/** A gap this long between two entries gets a time line. */
const GAP_MS = 20 * 60_000
/** Quiet steps in a row (reads, searches, thinking) past this many fold into one line. */
const QUIET_MAX = 3
/** How many of them stay in sight under the fold while Claude is still at it. */
const LIVE_TAIL = 2

const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const ET_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const todayKey = () => ET_KEY.format(new Date())

function timeLabel(at: number, today: string): string {
  const d = new Date(at)
  return ET_KEY.format(d) === today ? `${ET_TIME.format(d)} ET` : `${ET_DAY.format(d)}, ${ET_TIME.format(d)} ET`
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? ''

function buildRows(entries: TranscriptEntry[]): Row[] {
  const results = new Map<string, TranscriptEntry>()
  const calls = new Set<string>()
  let todoEntries = false
  for (const e of entries) {
    if (e.kind === 'result' && e.result?.toolId) results.set(e.result.toolId, e)
    else if (e.kind === 'tool' && e.tool?.id) calls.add(e.tool.id)
    else if (e.kind === 'todo') todoEntries = true
  }
  const rows: Row[] = []
  let run: RunItem[] | null = null
  let prevAt = 0
  const step = (it: RunItem, key: string) => {
    if (!run) {
      run = []
      rows.push({ t: 'run', key, items: run })
    }
    run.push(it)
  }
  for (const e of entries) {
    if (e.at > 0 && (prevAt === 0 || e.at - prevAt >= GAP_MS)) {
      rows.push({ t: 'time', key: `t-${e.id}`, at: e.at })
      run = null
    }
    if (e.at > 0) prevAt = e.at
    switch (e.kind) {
      case 'tool':
        if (!e.tool) break
      {
        const r = e.tool.id ? results.get(e.tool.id) ?? null : null
        // the list comes as its own todo entries: TodoWrite or a task call would say it twice
        if (todoEntries && toolKind(e.tool.name) === 'todo' && !r?.result?.isError) break
        step({ t: 'tool', e, r }, `r-${e.id}`)
        break
      }
      case 'result':
        // drawn under its call; one whose call is before the window has nothing to say
        if (!e.result?.toolId || !calls.has(e.result.toolId)) {
          if (e.result && !e.result.toolId && e.result.text.trim()) step({ t: 'tool', e: { ...e, kind: 'tool', tool: { name: 'Result', input: {}, id: '' } }, r: e }, `r-${e.id}`)
        }
        break
      case 'thinking':
        step({ t: 'think', e }, `r-${e.id}`)
        break
      case 'todo':
        if (e.todos?.length) step({ t: 'todo', e }, `r-${e.id}`)
        break
      case 'assistant': {
        const text = (e.text ?? '').trim()
        if (!text) break
        rows.push({ t: 'said', key: e.id, text })
        run = null
        break
      }
      case 'user': {
        const part = userPart(e.text ?? '')
        if (part.kind === 'hidden') break
        rows.push({ t: 'user', key: e.id, part })
        run = null
        break
      }
      case 'system': {
        const text = (e.text ?? '').trim()
        if (!text) break
        rows.push({ t: 'sys', key: e.id, text })
        run = null
        break
      }
    }
  }
  return rows
}

// ---------- markdown ----------

function MdLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = href ? safeHref(href) : null
  if (!safe) return <span className="vch-md-nolink">{children}</span>
  if (safe.startsWith('/')) return <Link to={safe}>{children}</Link>
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
}

type HastNode = { type?: string; value?: unknown; children?: HastNode[]; properties?: { className?: unknown } }
const hastText = (n: HastNode | undefined): string =>
  !n ? '' : typeof n.value === 'string' ? n.value : Array.isArray(n.children) ? n.children.map(hastText).join('') : ''

async function copy(text: string, what = 'Copied') {
  toast((await copyText(text)) ? what : 'Could not copy')
}

function CodeBlock({ node, children }: { node: HastNode | undefined; children: ReactNode }) {
  const code = hastText(node).replace(/\n$/, '')
  const cls = node?.children?.[0]?.properties?.className
  const lang = (Array.isArray(cls) ? cls.map(String) : []).find((c) => c.startsWith('language-'))?.slice(9) ?? ''
  return (
    <div className="vch-code">
      {lang && <span className="vch-code-lang">{lang}</span>}
      <Press className="vch-code-copy" aria-label="Copy code" title="Copy code" onPress={() => void copy(code)}>
        <Copy size={13} strokeWidth={1.7} aria-hidden />
      </Press>
      <pre>{children}</pre>
    </div>
  )
}

const MD_PLUGINS = [remarkGfm]
const mdUrl = (u: string) => safeHref(u) ?? ''
const MD: Components = {
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  img: ({ src, alt }) => <MdLink href={typeof src === 'string' ? src : undefined}>{alt || 'image'}</MdLink>,
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  table: ({ children }) => <div className="vch-md-table"><table>{children}</table></div>,
}

/**
 * Claude's text. Written by a model, so treated like the project notes are
 * (components/Markdown.tsx): raw HTML skipped, links only http, https, mailto
 * or a same-origin path, images as links.
 */
const Md = memo(function Md({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('vch-md', className)}>
      <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD} skipHtml urlTransform={mdUrl}>{text}</ReactMarkdown>
    </div>
  )
})

// ---------- small pieces ----------

/** Long text shows its head and a Show all. */
function Folded({ text, lines = 14, chars = 1400, className, mono }: { text: string; lines?: number; chars?: number; className?: string; mono?: boolean }) {
  const [all, setAll] = useState(false)
  const rows = text.split('\n')
  const long = rows.length > lines || text.length > chars
  const shown = all || !long ? text : rows.slice(0, lines).join('\n').slice(0, chars)
  return (
    <div className={className}>
      {mono ? <pre className="vch-pre">{shown}</pre> : <div className="vch-text">{shown}</div>}
      {long && (
        <Press className="vch-more" onPress={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${rows.length > lines ? `${rows.length} lines` : ''}`.trim()}
        </Press>
      )}
    </div>
  )
}

function DiffView({ diff, max }: { diff: Diff; max: number }) {
  const lines = diff.lines.slice(0, max)
  return (
    <div className="vch-diff" role="group" aria-label="Changes">
      {lines.map((l, i) => (
        <div key={i} className="vch-diff-l" data-t={l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}>
          <span className="vch-diff-m" aria-hidden>{l.t}</span>
          <span className="vch-diff-s">{l.s || ' '}</span>
        </div>
      ))}
      {diff.lines.length > max && <div className="vch-diff-more">{diff.lines.length - max} more lines</div>}
    </div>
  )
}

const TODO_ICON = (s: string) => (s === 'completed' ? Check : s === 'in_progress' ? CircleDot : Square)

function TodoRows({ todos }: { todos: TranscriptTodo[] }) {
  return (
    <ul className="vch-todo-list">
      {todos.map((t, i) => {
        const I = TODO_ICON(t.status)
        return (
          <li key={i} className="vch-todo" data-s={t.status}>
            <I size={13} strokeWidth={t.status === 'in_progress' ? 2.2 : 1.7} className="vch-todo-i" aria-hidden />
            <span>{t.content}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The todo list as it stands now. `strip` (the phone): one line over the
 * conversation, the step in progress, opening to the whole list. `side` (a wide
 * screen's side column): the whole list.
 */
export function TodoChecklist({ todos, variant }: { todos: TranscriptTodo[]; variant: 'strip' | 'side' }) {
  const [open, setOpen] = useState(false)
  const done = todos.filter((t) => t.status === 'completed').length
  const now = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed')
  const all = done === todos.length
  if (variant === 'side') {
    return (
      <section className="vch-todos" data-v="side" aria-label="Todos">
        <header className="vch-todos-head">
          <ListChecks size={13} strokeWidth={1.7} className={cx('vl-icon', all ? 'vl-icon-dim' : 'vl-icon-fg vl-icon-glow')} aria-hidden />
          <span className="vch-todos-k">Todos</span>
          <span className="vch-todos-n">{done}/{todos.length}</span>
        </header>
        <TodoRows todos={todos} />
      </section>
    )
  }
  return (
    <section className="vch-todos" data-v="strip" data-open={open || undefined} aria-label="Todos">
      <Press className="vch-todos-head" aria-expanded={open} onPress={() => setOpen((v) => !v)}>
        <ListChecks size={13} strokeWidth={1.7} className={cx('vl-icon', all ? 'vl-icon-dim' : 'vl-icon-fg vl-icon-glow')} aria-hidden />
        <span className="vch-todos-k">Todos</span>
        <span className="vch-todos-n">{done}/{todos.length}</span>
        <span className="vch-todos-now vl-ellipsis">{all ? 'All done' : now?.content}</span>
        <ChevronDown size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim vch-chev" aria-hidden />
      </Press>
      {open && <div className="vch-todos-body"><TodoRows todos={todos} /></div>}
    </section>
  )
}

// ---------- a tool call ----------

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileText, edit: FilePen, write: FilePlus, run: SquareTerminal, search: Search, web: Globe, agent: Bot,
  todo: ListChecks, ask: MessageCircleQuestion, plan: ClipboardList, skill: Sparkles, mcp: Plug, tool: Wrench,
}

/** Result text past this many characters is cut in the page too (the server already cut it to a few KB). */
const RESULT_MAX = 24_000

const ToolItem = memo(function ToolItem({ e, r, live }: { e: TranscriptEntry; r: TranscriptEntry | null; live: boolean }) {
  const tool = e.tool ?? { name: 'Tool', input: null, id: '' }
  const line = useMemo(() => toolLine(tool.name, tool.input), [tool.name, tool.input])
  const diff = useMemo(() => toolDiff(tool.name, tool.input), [tool.name, tool.input])
  const todos = useMemo(() => (line.kind === 'todo' ? todosOfInput(tool.input) : null), [line.kind, tool.input])
  const plan = tool.name === 'ExitPlanMode' ? str((tool.input as { plan?: unknown } | null)?.plan) : ''
  const res = r?.result ?? null
  const err = !!res?.isError
  const state = res ? (err ? 'err' : 'ok') : live ? 'run' : 'none'
  const [open, setOpen] = useState(() => !!plan)
  const text = res ? stripAnsi(res.text).replace(/\s+$/, '') : ''
  // an edit's own "updated successfully" says nothing the diff does not
  const quiet = !err && (line.kind === 'edit' || line.kind === 'write' || line.kind === 'todo')
  const showText = !!text && !quiet
  const longCmd = line.kind === 'run' && line.full.trim() !== line.main
  const canOpen = showText || !!diff || !!todos || !!plan || longCmd || (!!line.full && line.full !== line.main)
  const I = KIND_ICON[line.kind]
  const inlineDiff = !!diff && !err && line.kind === 'edit'

  let right: ReactNode
  if (diff && !err && (line.kind === 'edit' || line.kind === 'write')) {
    right = (
      <>
        <em className="vch-add">+{diff.add}</em>
        {line.kind === 'edit' && <em className="vch-del">−{diff.del}</em>}
      </>
    )
  } else if (res) right = resultWords(tool.name, res.text, err, res.truncated)
  else if (live) right = <span className="vch-run">running</span>

  return (
    <div className="vch-tool" data-s={state} data-k={line.kind} data-open={open || undefined}>
      <Press className="vch-tool-head" aria-expanded={canOpen ? open : undefined} disabled={!canOpen} title={line.full || undefined} onPress={() => setOpen((v) => !v)}>
        <I size={14} strokeWidth={1.6} className={cx('vl-icon vch-tool-i', state === 'run' ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />
        <span className="vch-tool-verb">{line.verb}</span>
        <span className="vch-tool-main">
          <b>{line.main || tool.name}</b>
          {line.sub && <i>{line.sub}</i>}
        </span>
        {right !== undefined && right !== '' && <span className="vch-tool-d">{right}</span>}
      </Press>
      {inlineDiff && !open && <DiffView diff={diff} max={8} />}
      {open && (
        <div className="vch-tool-body">
          {longCmd && <pre className="vch-pre vch-cmd">{line.full}</pre>}
          {plan && <Md text={plan} className="vch-plan" />}
          {todos && <TodoRows todos={todos} />}
          {diff && <DiffView diff={diff} max={line.kind === 'write' ? 400 : 1200} />}
          {showText && (line.kind === 'agent'
            ? <Md text={text.slice(0, RESULT_MAX)} className="vch-agent" />
            : <pre className="vch-pre" data-err={err || undefined}>{text.slice(0, RESULT_MAX)}</pre>)}
          {res?.truncated && <p className="vch-note">Cut short here. The whole output is in the terminal.</p>}
          {!res && !live && !diff && !todos && !plan && <p className="vch-note">No result in the transcript.</p>}
        </div>
      )}
    </div>
  )
})

const ThinkItem = memo(function ThinkItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const t = text.trim()
  return (
    <div className="vch-think" data-open={open || undefined}>
      <Press className="vch-think-head" disabled={!t} aria-expanded={t ? open : undefined} onPress={() => setOpen((v) => !v)}>
        <Brain size={13} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />
        <span className="vch-think-k" title="Thinking">Think</span>
        {t && <span className="vch-think-t">{firstLine(t)}</span>}
      </Press>
      {open && <div className="vch-think-body">{t}</div>}
    </div>
  )
})

const TodoItem = memo(function TodoItem({ todos }: { todos: TranscriptTodo[] }) {
  const [open, setOpen] = useState(false)
  const done = todos.filter((t) => t.status === 'completed').length
  const now = todos.find((t) => t.status === 'in_progress')
  return (
    <div className="vch-tool" data-k="todo" data-s="ok" data-open={open || undefined}>
      <Press className="vch-tool-head" aria-expanded={open} onPress={() => setOpen((v) => !v)}>
        <ListChecks size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim vch-tool-i" aria-hidden />
        <span className="vch-tool-verb">Todos</span>
        <span className="vch-tool-main">
          <b>{done}/{todos.length} done</b>
          {now && <i>{now.content}</i>}
        </span>
      </Press>
      {open && <div className="vch-tool-body"><TodoRows todos={todos} /></div>}
    </div>
  )
})

// What a step is for the fold: the ones that change something or went wrong
// always show; reads, searches, fetches, thinking and todo updates in a row
// fold into one line that counts them.
const LOUD: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'run', 'agent', 'ask', 'plan'])

function quiet(it: RunItem, live: boolean): boolean {
  if (it.t !== 'tool') return true
  if (!it.r) return !live
  if (it.r.result?.isError) return false
  return !LOUD.has(toolKind(it.e.tool?.name ?? ''))
}

const COUNT_WORD: Partial<Record<ToolKind | 'think', [string, string]>> = {
  read: ['read', 'reads'], search: ['search', 'searches'], web: ['fetch', 'fetches'], think: ['thought', 'thoughts'],
  todo: ['todo update', 'todo updates'], mcp: ['MCP call', 'MCP calls'], skill: ['skill', 'skills'],
}

function countWords(items: RunItem[]): string {
  const n = new Map<string, number>()
  for (const it of items) {
    const k = it.t === 'think' ? 'think' : it.t === 'todo' ? 'todo' : toolKind(it.e.tool?.name ?? '')
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  return [...n.entries()].map(([k, c]) => {
    const w = COUNT_WORD[k as ToolKind] ?? ['step', 'steps']
    return `${c} ${c === 1 ? w[0] : w[1]}`
  }).join(' · ')
}

type Seg = { key: string; items: RunItem[]; fold: boolean }

/** A run of steps (tool calls, thinking, todo updates) between two messages. */
function Run({ items, live }: { items: RunItem[]; live: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const segs: Seg[] = []
  for (const it of items) {
    const q = quiet(it, live)
    const last = segs[segs.length - 1]
    if (q && last?.fold) last.items.push(it)
    else segs.push({ key: it.e.id, items: [it], fold: q })
  }
  const step = (it: RunItem) => (it.t === 'tool'
    ? <ToolItem key={it.e.id} e={it.e} r={it.r} live={live && !it.r} />
    : it.t === 'think'
      ? <ThinkItem key={it.e.id} text={it.e.text ?? ''} />
      : <TodoItem key={it.e.id} todos={it.e.todos ?? []} />)
  return (
    <div className="vch-run-list">
      {segs.map((s, i) => {
        if (!s.fold || s.items.length <= QUIET_MAX) return s.items.map(step)
        const isOpen = open.has(s.key)
        // the newest steps of a run still going stay in sight under the fold
        const tail = i === segs.length - 1 && live ? s.items.slice(-LIVE_TAIL) : []
        const body = isOpen ? s.items : tail
        const folded = s.items.slice(0, s.items.length - (isOpen ? 0 : tail.length))
        return (
          <div key={`f-${s.key}`} className="vch-seg">
            <Press
              className="vch-fold"
              data-open={isOpen || undefined}
              aria-expanded={isOpen}
              onPress={() => setOpen((cur) => {
                const next = new Set(cur)
                if (next.has(s.key)) next.delete(s.key)
                else next.add(s.key)
                return next
              })}
            >
              <ChevronDown size={13} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />
              <span>{countWords(isOpen ? s.items : folded)}</span>
            </Press>
            {body.map(step)}
          </div>
        )
      })}
    </div>
  )
}

const UserRow = memo(function UserRow({ part }: { part: Exclude<UserPart, { kind: 'hidden' }> }) {
  switch (part.kind) {
    case 'prompt':
      return (
        <div className="vch-user" aria-label="You">
          <Folded text={part.text} />
        </div>
      )
    case 'command':
      return <div className="vch-user vch-user-cmd" aria-label="You ran"><code>{part.text}</code></div>
    case 'output':
      return <Folded text={part.text} lines={6} chars={800} mono className={cx('vch-out', part.isError && 'vch-out-err')} />
    case 'interrupt':
      return <div className="vch-sys" data-tone="alert"><CircleAlert size={12} strokeWidth={1.7} aria-hidden /><span>{part.text}</span></div>
    case 'notice':
      return <div className="vch-sys"><Info size={12} strokeWidth={1.7} aria-hidden /><span>{part.text}</span></div>
  }
})

function SysRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const head = firstLine(text)
  const more = text.trim() !== head
  const alert = /^(Interrupted\b|API Error)/.test(head)
  const I = alert ? CircleAlert : Info
  return (
    <div className="vch-sys-wrap">
      <Press className="vch-sys" data-tone={alert ? 'alert' : undefined} disabled={!more} aria-expanded={more ? open : undefined} onPress={() => setOpen((v) => !v)}>
        <I size={12} strokeWidth={1.7} aria-hidden />
        <span>{head}</span>
      </Press>
      {open && <pre className="vch-pre">{text}</pre>}
    </div>
  )
}

/** The conversation: rebuilt only when the entries or the working state change, never for the footer. */
const ChatList = memo(function ChatList({ entries, live }: { entries: TranscriptEntry[]; live: boolean }) {
  const rows = useMemo(() => buildRows(entries), [entries])
  const today = todayKey()
  let lastRun = ''
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].t === 'run') { lastRun = rows[i].key; break }
    if (rows[i].t === 'user') break
  }
  return (
    <>
      {rows.map((row) => {
        switch (row.t) {
          case 'time':
            return <div key={row.key} className="vch-time"><span>{timeLabel(row.at, today)}</span></div>
          case 'user':
            return <UserRow key={row.key} part={row.part} />
          case 'said':
            return <div key={row.key} className="vch-said"><Md text={row.text} /></div>
          case 'run':
            return <Run key={row.key} items={row.items} live={live && row.key === lastRun} />
          case 'sys':
            return <SysRow key={row.key} text={row.text} />
        }
      })}
    </>
  )
})

// ---------- the footer ----------

const CONN_WORD: Record<TermConnState, string> = { idle: 'Starting', connecting: 'Connecting', live: '', closed: 'Offline' }

export function ChatFoot({ phase, foot, model, conn, retrying }: {
  phase: Phase
  foot: Foot
  model: string | null
  conn: TermConnState
  retrying: boolean
}) {
  const word = CONN_WORD[conn] || (phase === 'asking' ? 'Waiting for your answer' : phase === 'working' ? `${foot.verb ?? 'Working'}…` : 'Ready')
  return (
    <div className="vch-foot" data-p={phase} data-conn={conn} role="status" aria-live="off">
      <StateGlyph phase={phase} />
      <span className="vch-foot-word vl-ellipsis">{word}</span>
      {phase === 'working' && conn === 'live' && foot.detail && <span className="vch-foot-d">{foot.detail}</span>}
      <span className="vch-foot-meta">
        {retrying && <span className="vch-foot-m" data-hot>transcript retrying</span>}
        {model && <span className="vch-foot-m vch-foot-model">{model}</span>}
        {foot.ctx !== null && <span className="vch-foot-m" data-hot={foot.ctx <= 15 || undefined}>ctx <b>{foot.ctx}%</b></span>}
        {foot.five !== null && <span className="vch-foot-m" data-hot={foot.five >= 80 || undefined}>5h <b>{foot.five}%</b></span>}
        {foot.week !== null && <span className="vch-foot-m" data-hot={foot.week >= 80 || undefined}>wk <b>{foot.week}%</b></span>}
      </span>
    </div>
  )
}

// ---------- the view ----------

/** Within this many px of the bottom counts as at the bottom. */
const STICK_PX = 48

export function ChatView({ tx, phase, foot, conn, plates, todos, cover = 0, scrollRef, onTerminal }: {
  tx: Transcript
  phase: Phase
  foot: Foot
  conn: TermConnState
  /** the question plates (termskin Choices), drawn over the footer while Claude asks */
  plates: ReactNode
  /** the live todo list, drawn as a strip at the top (the phone); null where the side column has it */
  todos: TranscriptTodo[] | null
  /** px to reach up over the row above the stage (a phone's hidden activity row), so the terminal keeps its size */
  cover?: number
  /** the scroller, for the More panel's page up and down */
  scrollRef?: RefObject<HTMLDivElement | null>
  onTerminal: () => void
}) {
  const own = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // at the bottom: new entries scroll into view. Away: they wait behind the chip.
  const stick = useRef(true)
  const count = tx.entries.length
  // the newest entry, not the count: past MAX_ENTRIES the oldest drop off as new ones come, so the count stays put
  const lastId = count ? tx.entries[count - 1].id : ''
  const lastRef = useRef(lastId)
  const genRef = useRef(tx.gen)
  const [away, setAway] = useState<{ last: string; gen: number } | null>(null)
  const model = useMemo(() => latestModel(tx.entries), [tx.entries])
  const live = phase === 'working'

  const setScroller = useCallback((el: HTMLDivElement | null) => {
    own.current = el
    if (scrollRef) scrollRef.current = el
  }, [scrollRef])

  const toBottom = useCallback((smooth = false) => {
    const el = own.current
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [])

  // At the bottom or away, read off the scroller: on a scroll, and after the
  // page moves it or its content changes, since a scrollTop that cannot change
  // (a conversation shorter than the screen) fires no scroll event.
  const measure = useCallback(() => {
    const el = own.current
    if (!el) return
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stick.current = at
    if (at) setAway((cur) => (cur ? null : cur))
    else setAway((cur) => cur ?? { last: lastRef.current, gen: genRef.current })
  }, [])

  // new entries: follow them at the bottom; a new transcript starts at the bottom
  useLayoutEffect(() => {
    const reset = tx.gen !== genRef.current
    lastRef.current = lastId
    genRef.current = tx.gen
    if (reset) stick.current = true
    if (!stick.current) return
    toBottom()
    measure()
  }, [lastId, tx.gen, toBottom, measure])

  // anything that changes the height (a fold opened, an image, the keyboard) keeps the bottom in view
  useEffect(() => {
    const el = own.current
    const list = listRef.current
    if (!el || !list) return
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom()
      measure()
    })
    ro.observe(el)
    ro.observe(list)
    return () => ro.disconnect()
  }, [toBottom, measure])

  // entries after the newest one on screen when he scrolled away (all of them if it has dropped off)
  const unseen = useMemo(() => {
    if (!away || away.gen !== tx.gen || away.last === lastId) return 0
    if (!away.last) return count
    for (let i = count - 1; i >= 0; i--) if (tx.entries[i].id === away.last) return count - 1 - i
    return count
  }, [away, tx.gen, tx.entries, lastId, count])
  const empty = count === 0

  return (
    <div className="vch" data-chat data-cover={cover > 0 || undefined} style={cover > 0 ? { top: -cover } : undefined}>
      {todos && todos.length > 0 && <TodoChecklist todos={todos} variant="strip" />}
      <div ref={setScroller} className="vch-scroll" data-term-scroll onScroll={measure}>
        <div ref={listRef} className="vch-list">
          {empty ? (
            <div className="vch-empty">
              {tx.status === 'loading' && <p>Reading the conversation</p>}
              {tx.status === 'missing' && <p>This server does not serve transcripts yet, so the conversation cannot be drawn here. The terminal works.</p>}
              {tx.status === 'error' && <p>Could not read the conversation ({tx.error ?? 'error'}). Trying again.</p>}
              {tx.status === 'ok' && <p>{tx.sessionId ? 'Nothing in this conversation yet.' : 'No transcript yet. Claude writes one after the first message.'}</p>}
              {tx.status !== 'loading' && tx.status !== 'ok' && (
                <Press className="vch-more" onPress={onTerminal}>Show the terminal</Press>
              )}
            </div>
          ) : (
            <ChatList entries={tx.entries} live={live} />
          )}
        </div>
      </div>
      {away && !empty && (
        <Press className="vch-new" data-n={unseen || undefined} onPress={() => { stick.current = true; toBottom(true) }}>
          <ArrowDown size={13} strokeWidth={1.8} aria-hidden />
          <span>{unseen ? `${unseen} new` : 'Latest'}</span>
        </Press>
      )}
      {plates && <div className="vtm-askdock vch-ask">{plates}</div>}
      <ChatFoot phase={phase} foot={foot} model={model} conn={conn} retrying={tx.status === 'error' && !empty} />
    </div>
  )
}
