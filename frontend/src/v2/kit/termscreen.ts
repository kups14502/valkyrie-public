import { useEffect, useState } from 'react'
import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import type { IconName, IconTone } from './icons'
import type { Palette } from './theme'

// The Valkyrie skin around Claude Code, shared by the live terminal
// (screens/Term.tsx, a real tmux pane) and the preview that plays a recorded
// sample (screens/Skin.tsx). The CLI stays the engine: everything here reads
// what is on its screen. Tool lines become the activity strip, a numbered
// question at the bottom becomes tappable plates, the spinner line is the
// working state. The pieces that draw it are in termskin.tsx; their styles live
// in screens/skin.css, which both screens load.

// ---------- reading the CLI's text: tool lines become activity rows ----------

export type ActKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'web' | 'agent' | 'todo' | 'tool'
export type Act = { id: number; kind: ActKind; tool: string; arg: string; detail: string; state: 'run' | 'ok' | 'no' }
export type TodoSnap = { done: number; total: number; current: string | null }

const TOOL_KIND: Record<string, ActKind> = {
  Read: 'read', Update: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
  Bash: 'run', Search: 'search', Grep: 'search', Glob: 'search', LS: 'search', List: 'search',
  WebFetch: 'web', Fetch: 'web', WebSearch: 'web', 'Web Search': 'web', Task: 'agent', Agent: 'agent',
}

// eslint-disable-next-line no-control-regex -- escape sequences are what this strips
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[78=>]/g
const TODO_LINE = /^\s*(?:⎿\s+)?([☐☒□■✔✓◻◼])\s+(.*)$/
const TODO_DONE = /[☒✔✓]/

/**
 * Turns the CLI's text into activity rows: "● Read(path)" opens a row, the
 * "⎿ ..." under it closes it with its result, "● Update Todos" carries the
 * todo list. Only what the screen says; nothing else is consulted. Fed either a
 * stream (the preview) or the lines of a screen (the live pane, see scanTerm).
 */
export class StreamParser {
  acts: Act[] = []
  todos: TodoSnap | null = null
  onChange: () => void = () => {}
  private buf = ''
  private seq = 0
  /** a tool line the CLI wrapped over several rows */
  private open: { tool: string; arg: string } | null = null
  private list: { done: boolean; text: string }[] | null = null
  /** the row whose result may continue on the next line */
  private result: Act | null = null

  reset() {
    this.acts = []
    this.todos = null
    this.buf = ''
    this.seq = 0
    this.open = null
    this.list = null
    this.result = null
    this.onChange()
  }

  feed(s: string) {
    this.buf += s.replace(ANSI, '')
    let changed = false
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      // a carriage return redraws the line: what counts is the last thing drawn on it
      const parts = raw.split('\r').filter((x) => x.length > 0)
      if (this.line(parts.length ? parts[parts.length - 1] : '')) changed = true
    }
    if (this.buf.length > 8192) this.buf = this.buf.slice(-8192)
    if (changed) this.onChange()
  }

  /** The end of a screen: a todo list still open at the bottom counts as drawn. */
  flush() {
    if (this.list) this.endList()
  }

  private settle(a: Act, detail: string) {
    a.detail = detail
    a.state = /rejected|interrupted|error|denied/i.test(detail) ? 'no' : 'ok'
  }

  private push(tool: string, arg: string) {
    this.result = null
    this.acts.push({ id: this.seq++, kind: TOOL_KIND[tool] ?? (tool === 'Todos' ? 'todo' : 'tool'), tool, arg: arg.trim(), detail: '', state: 'run' })
  }

  private endList() {
    const list = this.list ?? []
    this.list = null
    const done = list.filter((x) => x.done).length
    this.todos = { done, total: list.length, current: list.find((x) => !x.done)?.text ?? null }
    const last = this.acts[this.acts.length - 1]
    if (last?.kind === 'todo') {
      last.detail = `${done}/${list.length}`
      last.arg = this.todos.current ?? 'All done'
      last.state = 'ok'
    }
  }

  private line(l: string): boolean {
    let changed = false
    if (this.list) {
      const t = TODO_LINE.exec(l)
      if (t) {
        this.list.push({ done: TODO_DONE.test(t[1]), text: t[2].trim() })
        return false
      }
      const tail = this.list[this.list.length - 1]
      if (tail && /^\s{6,}\S/.test(l)) {
        tail.text += ` ${l.trim()}`
        return false
      }
      this.endList()
      changed = true
    }
    if (this.open) {
      this.open.arg += ` ${l.trim()}`
      if (/\)\s*$/.test(l)) {
        this.push(this.open.tool, this.open.arg.replace(/\)\s*$/, ''))
        this.open = null
      }
      return true
    }
    if (/^[●⏺]\s+Update Todos\s*$/.test(l)) {
      this.push('Todos', '')
      this.list = []
      return true
    }
    const head = /^[●⏺]\s+([A-Z][A-Za-z]+(?: [A-Z][a-z]+)?)\((.*)$/.exec(l)
    if (head && head[1] in TOOL_KIND) {
      if (/\)\s*$/.test(head[2])) this.push(head[1], head[2].replace(/\)\s*$/, ''))
      else this.open = { tool: head[1], arg: head[2] }
      return true
    }
    const res = /^\s*⎿\s+(.*)$/.exec(l)
    const last = this.acts[this.acts.length - 1]
    if (res && last && last.state === 'run') {
      this.result = last
      this.settle(last, res[1].trim())
      return true
    }
    // a result the CLI wrapped onto the next rows; a diff row ("NNN + code") ends it
    const more = this.result
    if (more && /^\s{5}\S/.test(l) && !/^\s+\d+\s[ +-]\s/.test(l)) {
      this.settle(more, `${more.detail} ${l.trim()}`)
      return true
    }
    this.result = null
    return changed
  }
}

const actKey = (a: Act) => `${a.tool}\u0000${a.arg}`

/**
 * The live pane's activity, kept across screens. A full-screen CLI redraws in
 * place instead of streaming lines, so the pane is read a screen at a time and
 * each screen's rows are lined up against what was already seen: the longest
 * run that ends the log and starts the screen is the same rows (their state and
 * result are refreshed), whatever follows it on the screen is new. A screen
 * that sits wholly inside the log (scrolled back) adds nothing.
 */
export class ActivityLog {
  acts: Act[] = []
  private seq = 0

  reset() {
    this.acts = []
  }

  merge(next: Act[]): boolean {
    if (!next.length) return false
    const acc = this.acts
    const have = acc.map(actKey)
    const want = next.map(actKey)
    let tailAt = -1
    let tailLen = 0
    let inside = -1
    for (let j = 0; j < acc.length; j++) {
      let m = 0
      while (m < want.length && j + m < acc.length && have[j + m] === want[m]) m++
      if (!m) continue
      if (j + m === acc.length) {
        if (m > tailLen) {
          tailAt = j
          tailLen = m
        }
      } else if (m === want.length && inside < 0) inside = j
    }
    let changed = false
    const refresh = (at: number, from: Act) => {
      const a = acc[at]
      if (a.state === from.state && a.detail === from.detail) return
      acc[at] = { ...a, state: from.state, detail: from.detail }
      changed = true
    }
    const add = (from: Act) => {
      acc.push({ ...from, id: this.seq++ })
      changed = true
    }
    if (tailAt >= 0) {
      for (let i = 0; i < tailLen; i++) refresh(tailAt + i, next[i])
      for (let i = tailLen; i < next.length; i++) add(next[i])
    } else if (inside >= 0) {
      for (let i = 0; i < next.length; i++) refresh(inside + i, next[i])
    } else {
      for (const a of next) add(a)
    }
    if (acc.length > 300) acc.splice(0, acc.length - 300)
    return changed
  }
}

// ---------- reading the screen: the question, the spinner, the mode ----------

export type Opt = { n: number; label: string; hint: string; sel: boolean }
export type Question = { kind: string; file: string; text: string; options: Opt[] }
/** Claude Code's permission mode, from the line under its prompt */
export type CliMode = 'default' | 'accept' | 'plan' | 'bypass'
export type ScreenState = { q: Question | null; spinning: boolean; mode: CliMode }

const OPT_LINE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.*)$/
const RULE_LINE = /^\s*[╭╰]?[─━╌]{6,}[╮╯]?\s*$/
const SPIN_LINE = /^\s*[·✢✳✶✻✽*]\s+\S.*…/
export const NO_SCREEN: ScreenState = { q: null, spinning: false, mode: 'default' }

// A boxed dialog's side borders, so its rows read like an open one.
const unbox = (l: string) => l.replace(/^(\s*)│ ?/, '$1').replace(/\s*│\s*$/, '')

/**
 * The screen as text: the rows of the active screen plus up to `history` rows
 * of scrollback above it, a soft-wrapped row joined to the one it continues,
 * box borders dropped, blank rows at the bottom trimmed. The whole active
 * screen, not just down to the cursor: a full-screen CLI parks the cursor
 * wherever it likes.
 */
export function screenLines(term: XTerm, history = 40): string[] {
  const b = term.buffer.active
  const end = Math.min(b.length - 1, b.baseY + term.rows - 1)
  const lines: string[] = []
  for (let y = Math.max(0, b.baseY - history); y <= end; y++) {
    const ln = b.getLine(y)
    if (!ln) continue
    const t = ln.translateToString(true)
    if (ln.isWrapped && lines.length) lines[lines.length - 1] += t
    else lines.push(t)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.map(unbox)
}

/**
 * What a wrapper on a live pane can know from the screen alone: a numbered
 * list at the bottom under a question is a permission prompt (its kind and
 * file sit under the rule that opens it), a spinner line near the bottom means
 * Claude is working, and the line under the prompt names the mode.
 */
export function readLines(lines: string[], ask = true): ScreenState {
  const tail = lines.slice(-12)
  const foot = lines.slice(-4).join(' ')
  const mode: CliMode = /plan mode on/i.test(foot) ? 'plan'
    : /accept edits on/i.test(foot) ? 'accept'
      : /bypass permissions on/i.test(foot) ? 'bypass'
        : 'default'
  return {
    q: ask ? findQuestion(lines) : null,
    spinning: tail.some((l) => SPIN_LINE.test(l) || /esc to interrupt/i.test(l)),
    mode,
  }
}

export const readScreen = (term: XTerm, ask = true): ScreenState => readLines(screenLines(term), ask)

export function findQuestion(lines: string[]): Question | null {
  let first = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 24); i--) {
    const m = OPT_LINE.exec(lines[i])
    if (m && m[1] === '1') {
      first = i
      break
    }
  }
  if (first < 0) return null
  const options: Opt[] = []
  let i = first
  for (; i < lines.length; i++) {
    const l = lines[i]
    const m = OPT_LINE.exec(l)
    if (m && Number(m[1]) === options.length + 1) {
      options.push({ n: Number(m[1]), label: m[2].trim(), hint: '', sel: /[❯›]/.test(l.slice(0, l.indexOf(`${m[1]}.`))) })
      continue
    }
    const prev = options[options.length - 1]
    if (prev && /^\s{4,}\S/.test(l)) {
      prev.label += ` ${l.trim()}`
      continue
    }
    break
  }
  // a prompt is the last thing on the screen: at most one short hint may follow it
  const rest = lines.slice(i).filter((l) => l.trim() && !RULE_LINE.test(l))
  if (options.length < 2 || rest.length > 1) return null
  for (const o of options) {
    const h = /\s*\(([^()]+)\)\s*$/.exec(o.label)
    if (h) {
      o.hint = h[1]
      o.label = o.label.slice(0, h.index).trim()
    }
  }
  const qs: string[] = []
  let j = first - 1
  while (j >= 0 && lines[j].trim() && !RULE_LINE.test(lines[j]) && qs.length < 4) qs.unshift(lines[j--].trim())
  const text = qs.join(' ')
  if (!text.includes('?')) return null
  let kind = ''
  let file = ''
  for (let k = j; k >= Math.max(0, j - 40); k--) {
    if (RULE_LINE.test(lines[k])) {
      kind = (lines[k + 1] ?? '').trim()
      file = (lines[k + 2] ?? '').trim()
      break
    }
  }
  if (file && !/[\\/.]/.test(file)) file = ''
  return { kind, file, text, options }
}

export const sameScreen = (a: ScreenState, b: ScreenState) =>
  a.spinning === b.spinning && a.mode === b.mode && JSON.stringify(a.q) === JSON.stringify(b.q)

/** One read of a live pane: its screen state, and the activity rows on it. */
export function scanTerm(term: XTerm, ask: boolean): { screen: ScreenState; acts: Act[]; todos: TodoSnap | null } {
  const lines = screenLines(term)
  const p = new StreamParser()
  p.feed(lines.join('\n') + '\n')
  p.flush()
  return { screen: readLines(lines, ask), acts: p.acts, todos: p.todos }
}

// ---------- theme: the scheme's tones on the 16 ANSI colors ----------

const rgbOf = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const mix = (a: string, b: string, t: number) => {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}
const rgba = (h: string, a: number) => `rgba(${rgbOf(h).join(', ')}, ${a})`

/**
 * Green is the accent (tool bullets, the spinner, added lines, the picked
 * option), red the scheme's alert (removed lines, rejections), yellow its
 * second highlight, gray its dim tone, white its body text.
 */
export function termTheme(p: Palette): ITheme {
  const wash = mix(p.fg, p.acc2, 0.5)
  return {
    background: '#000000',
    foreground: p.text,
    cursor: p.fg,
    cursorAccent: '#000000',
    selectionBackground: rgba(p.fg, 0.32),
    selectionInactiveBackground: rgba(p.fg, 0.18),
    scrollbarSliderBackground: rgba(p.fg, 0.2),
    scrollbarSliderHoverBackground: rgba(p.fg, 0.34),
    scrollbarSliderActiveBackground: rgba(p.fg, 0.48),
    black: '#000000',
    brightBlack: p.dim,
    red: p.acc2,
    brightRed: mix(p.acc2, '#ffffff', 0.3),
    green: p.fg,
    brightGreen: mix(p.fg, '#ffffff', 0.35),
    yellow: p.hot,
    brightYellow: mix(p.hot, '#ffffff', 0.3),
    blue: mix(p.fg, p.dim, 0.45),
    brightBlue: mix(p.fg, '#ffffff', 0.2),
    magenta: wash,
    brightMagenta: mix(wash, '#ffffff', 0.3),
    cyan: mix(p.fg, p.text, 0.45),
    brightCyan: mix(p.fg, '#ffffff', 0.55),
    white: p.text,
    brightWhite: mix(p.text, '#ffffff', 0.6),
  }
}

// ---------- fonts and media ----------

// index.html loads JetBrains Mono's text subsets only, so the CLI's box lines,
// bullets, checkboxes and spinner fell back to another font, a cell too narrow
// (rules drew as dashes). Google's text= subset adds exactly those glyphs to the
// same family under a unicode-range, leaving every other character alone.
const CLI_GLYPHS = '─│╭╮╰╯├┤┬┴┼╌━⎿●⏺❯›☐☒✻✢✳✶✽⏵⏸✔✓■◼◻⇧'
const CLI_GLYPH_CSS = `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&text=${encodeURIComponent(CLI_GLYPHS)}&display=swap`

export function useCliGlyphs() {
  useEffect(() => {
    if (document.querySelector(`link[href="${CLI_GLYPH_CSS}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = CLI_GLYPH_CSS
    document.head.appendChild(link)
  }, [])
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const f = () => setM(mq.matches)
    f()
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [query])
  return m
}

/**
 * JetBrains Mono already draws a tall line (about 1.32 em), so the multiplier
 * stays small: the phone gets a little room between lines, wider screens a
 * step bigger and nearly tight.
 */
export const termFont = (w: number) => (w < 640 ? { size: 12.5, line: 1.12 } : w < 1200 ? { size: 13.5, line: 1.04 } : { size: 14, line: 1.04 })

// ---------- the state ----------

export type Phase = 'working' | 'asking' | 'idle'
export const PHASE: Record<Phase, { icon: IconName; tone: IconTone; glow: boolean; word: string }> = {
  working: { icon: 'working', tone: 'fg', glow: true, word: 'working' },
  asking: { icon: 'asking', tone: 'acc2', glow: true, word: 'asking' },
  idle: { icon: 'idle', tone: 'dim', glow: false, word: 'idle' },
}
