import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowUp, Bot, ChevronDown, FilePen, FilePlus, FileText, Globe, ListChecks, RotateCcw, Search, SquareTerminal, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { BASE, StatusStrip } from '../kit/shell'
import { Bar, Glyph, IconButton, Press, ToastHost, cx, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { applyPalette, useFont, usePalette, useStoredMode, type Palette } from '../kit/theme'
import { TERM_FONT_FAMILY, readUiZoom, setTermZoom } from '../../lib/term'
import './skin.css'

// AI > Terminal preview (/m/ai/skin): what the session terminal could become,
// a Valkyrie skin around the real Claude Code CLI. Brendon: "i have suggested
// rebuilding a skin or wrapper for claude code ourselves before, do you think
// you can give me a preview of that?"
//
// The CLI stays the engine. The page draws its output in xterm, themed from
// the scheme, and reads the screen the way a wrapper on a live pane would: tool
// lines become the activity strip, a permission question becomes tappable
// plates, the spinner line is the working state. Nothing here knows the
// script; it all comes from the text on the screen.
//
// This preview plays a RECORDED SAMPLE, written below as the ANSI output of
// Claude Code's 16-color theme (so the scheme maps every color the CLI uses).
// It never opens a socket or attaches to a session: the composer and the keys
// act on the recording only.

// ---------- the sample ----------

const SAMPLE = {
  title: 'Battery % in the hosts strip',
  host: 'thor',
  model: 'Opus 5.5',
  cwd: 'C:\\Thor\\server\\valkyrie',
  prompt: "show the frame's battery % next to its icon in the hosts strip",
  ctx: 22,
}

const SHELL = 'frontend/src/v2/kit/shell.tsx'
const DATA = 'frontend/src/v2/kit/data.ts'
const CSS = 'frontend/src/v2/v2.css'

type DiffRow = [number, ' ' | '-' | '+', string]
type Edit = { file: string; adds: number; dels: number; rows: DiffRow[] }

const EDIT_TSX: Edit = {
  file: SHELL,
  adds: 3,
  dels: 0,
  rows: [
    [286, ' ', `<Icon name={hostIcon(h.id)} size={11} tone="fg" glow={st === 'on'} />`],
    [287, ' ', '<b>{h.label}</b>'],
    [288, '+', '{h.battery && ('],
    [289, '+', '  <i className="vl-host-batt">{h.battery.percent}%</i>'],
    [290, '+', ')}'],
    [291, ' ', '<span className="sr-only">{STATE_WORD[st]}</span>'],
  ],
}

const EDIT_CSS: Edit = {
  file: CSS,
  adds: 2,
  dels: 0,
  rows: [
    [972, ' ', `.vl-host[data-state='off'] b { color: var(--faint); }`],
    [973, '+', '.vl-host-batt { font-style: normal; color: var(--dim); }'],
    [974, '+', `.vl-host[data-state='stale'] .vl-host-batt { opacity: .5; }`],
    [975, ' ', `.vl-host[data-state='stale'] b { color: var(--acc2); }`],
  ],
}

const TODO = ['Show battery % in StatusStrip', 'Style it in v2.css', 'Typecheck the frontend']
const todo = (n: number): [boolean, string][] => TODO.map((t, i) => [i < n, t])

type Step = { ctx?: number } & (
  | { t: 'block'; r: R }
  | { t: 'wait'; ms: number }
  | { t: 'user'; text: string; typed?: boolean }
  | { t: 'echo'; text: string }
  | { t: 'think'; ms: number; verb?: string }
  | { t: 'say'; text: string }
  | { t: 'tool'; name: string; arg: string; run: number; out: string[] }
  | { t: 'todos'; items: [boolean, string][] }
  | { t: 'edit'; e: Edit }
  | { t: 'end' }
)

function sampleScript(): Step[] {
  return [
    { t: 'block', r: welcomeR(SAMPLE.cwd) },
    { t: 'wait', ms: 600 },
    { t: 'user', text: SAMPLE.prompt, typed: true },
    { t: 'think', ms: 1500, verb: 'Thinking', ctx: 1 },
    { t: 'say', text: "I'll find where the strip draws each host, then check what the hosts hook already returns." },
    { t: 'think', ms: 600 },
    { t: 'tool', name: 'Search', arg: 'pattern: "vl-host", path: "frontend/src/v2"', run: 800, out: ['Found 2 files'] },
    { t: 'think', ms: 350 },
    { t: 'tool', name: 'Read', arg: SHELL, run: 650, out: ['Read 1067 lines'], ctx: 5 },
    { t: 'think', ms: 300 },
    { t: 'tool', name: 'Read', arg: DATA, run: 600, out: ['Read 885 lines'], ctx: 4 },
    { t: 'think', ms: 1900, verb: 'Pondering' },
    {
      t: 'say',
      ctx: 1,
      text: "`useHosts()` already carries `battery` on every `HostVM`, so this is a view change only. `StatusStrip` draws the hosts: I'll print the percent after the label when a host reports a battery, and dim it while the host is stale.",
    },
    { t: 'think', ms: 700 },
    { t: 'todos', items: todo(0) },
    { t: 'think', ms: 1300, verb: 'Clauding' },
    { t: 'edit', e: EDIT_TSX, ctx: 1 },
    { t: 'think', ms: 450 },
    { t: 'todos', items: todo(1) },
    { t: 'think', ms: 1000, verb: 'Percolating' },
    { t: 'edit', e: EDIT_CSS, ctx: 1 },
    { t: 'think', ms: 450 },
    { t: 'todos', items: todo(2) },
    { t: 'think', ms: 500 },
    { t: 'tool', name: 'Bash', arg: 'cd frontend && npx tsc -b', run: 2800, out: ['(No content)'], ctx: 1 },
    { t: 'think', ms: 400 },
    { t: 'todos', items: todo(3) },
    { t: 'think', ms: 1000, verb: 'Simmering' },
    {
      t: 'say',
      ctx: 1,
      text: 'Done. The strip now shows the battery next to any host that reports one.\n\n- `kit/shell.tsx`: `StatusStrip` prints `{percent}%` after the host label when `h.battery` is set.\n- `v2.css`: the percent is dim, and half strength while the host is stale.\n- `npx tsc -b` passes.',
    },
    { t: 'end' },
  ]
}

// ---------- drawing Claude Code's output (16-color SGR, hard-wrapped to the grid) ----------

const NL = '\r\n'
const sgr = (c: string, s: string) => (c && s ? `\x1b[${c}m${s}\x1b[0m` : s)
const dim = (s: string) => sgr('90', s)
/** usable columns: one short of the grid, so a full line never sits in the pending-wrap state */
const width = (cols: number) => Math.max(20, cols - 1)

type Lines = string[]
type R = (cols: number) => Lines

/** styled run of text */
type Seg = { s: string; c: string }

/** inline markdown: `code` and **bold** */
function inline(text: string, base = ''): Seg[] {
  const out: Seg[] = []
  let last = 0
  for (const m of text.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
    const at = m.index ?? 0
    if (at > last) out.push({ s: text.slice(last, at), c: base })
    out.push(m[1] !== undefined ? { s: m[1], c: '36' } : { s: m[2], c: base ? `1;${base}` : '1' })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ s: text.slice(last), c: base })
  return out
}

/**
 * Word-wrap styled text to `w` columns. `first` leads line one (visible width
 * `firstW`), `indent` (plain spaces) leads the rest. A word longer than a line
 * is split.
 */
function wrap(segs: Seg[], w: number, first: string, firstW: number, indent: string): Lines {
  const lines: Lines = []
  let line = first
  let len = firstW
  let fresh = true
  let space = false
  const newLine = () => {
    lines.push(line)
    line = indent
    len = indent.length
    fresh = true
    space = false
  }
  for (const seg of segs) {
    for (const part of seg.s.split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        space = !fresh
        continue
      }
      let word = part
      if (!fresh && len + (space ? 1 : 0) + word.length > w) newLine()
      while (len + (space ? 1 : 0) + word.length > w) {
        const take = Math.max(1, w - len - (space ? 1 : 0))
        line += (space ? ' ' : '') + sgr(seg.c, word.slice(0, take))
        word = word.slice(take)
        newLine()
      }
      if (word) {
        line += (space ? ' ' : '') + sgr(seg.c, word)
        len += (space ? 1 : 0) + word.length
        fresh = false
        space = false
      }
    }
  }
  lines.push(line)
  return lines
}

/** code keeps its spaces: cut at the column, never at a word */
function hard(text: string, w: number): string[] {
  const out: string[] = []
  for (let i = 0; i === 0 || i < text.length; i += w) out.push(text.slice(i, i + w))
  return out
}

/**
 * The welcome header. Its sides are left open: xterm's DOM renderer draws a
 * vertical box line from the font, and with any room between lines it breaks
 * into dashes (a live skin wants xterm's WebGL renderer, which draws box lines
 * itself).
 */
function welcomeR(cwd: string): R {
  return (cols) => {
    const w = Math.min(width(cols), 46)
    const inner = w - 2
    const fit = (s: string) => (s.length > inner ? `…${s.slice(s.length - inner + 1)}` : s)
    return [
      dim(`╭${'─'.repeat(w - 2)}╮`),
      ` ${sgr('32', '✻')} ${sgr('1', 'Welcome to Claude Code!')}`,
      '',
      ` ${dim(fit('  /help for help'))}`,
      ` ${dim(fit(`  cwd: ${cwd}`))}`,
      dim(`╰${'─'.repeat(w - 2)}╯`),
    ]
  }
}

const userR = (text: string): R => (cols) => wrap([{ s: text, c: '97' }], width(cols), `${dim('>')} `, 2, '  ')

function sayR(text: string): R {
  return (cols) => {
    const w = width(cols)
    const out: Lines = []
    let first = true
    for (const para of text.split('\n')) {
      if (!para.trim()) {
        out.push('')
        continue
      }
      const lead = first ? '● ' : '  '
      if (para.startsWith('- ')) out.push(...wrap(inline(para.slice(2)), w, `${lead}- `, 4, '    '))
      else out.push(...wrap(inline(para), w, lead, 2, '  '))
      first = false
    }
    return out
  }
}

const toolHead = (name: string, arg: string | null, cols: number): Lines =>
  wrap([{ s: name, c: '1' }, ...(arg === null ? [] : [{ s: `(${arg})`, c: '' }])], width(cols), `${sgr('32', '●')} `, 2, '  ')

/** a tool's answer: "  ⎿  " leads the first line, the rest line up under it */
function result(texts: string[], cols: number, c = '90'): Lines {
  const out: Lines = []
  texts.forEach((t, i) => out.push(...wrap(inline(t, c), width(cols), i === 0 ? dim('  ⎿  ') : '     ', 5, '     ')))
  return out
}

function diffLines(rows: DiffRow[], cols: number, lead: string, mute = false): Lines {
  const out: Lines = []
  const codeW = Math.max(8, width(cols) - lead.length - 6)
  for (const [n, k, code] of rows) {
    const c = mute ? '90' : k === '+' ? '32' : k === '-' ? '31' : ''
    hard(code, codeW).forEach((part, i) => {
      const head = i === 0 ? `${dim(String(n).padStart(3))} ${k === ' ' ? ' ' : sgr(c, k)} ` : ' '.repeat(6)
      out.push(lead + head + sgr(c, part))
    })
  }
  return out
}

const changes = (e: Edit) => {
  const add = `${e.adds} ${e.adds === 1 ? 'addition' : 'additions'}`
  const del = `${e.dels} ${e.dels === 1 ? 'removal' : 'removals'}`
  return e.adds && e.dels ? `${add} and ${del}` : e.dels ? del : add
}

const editDoneR = (e: Edit): R => (cols) => [
  ...toolHead('Update', e.file, cols),
  ...result([`Updated ${e.file} with ${changes(e)}`], cols),
  ...diffLines(e.rows, cols, '     '),
]

const editRejectedR = (e: Edit): R => (cols) => [
  ...toolHead('Update', e.file, cols),
  ...result([`User rejected update to ${e.file}`], cols, '31'),
  ...diffLines(e.rows, cols, '     ', true),
]

const interruptedR: R = (cols) => result(['Interrupted by user'], cols, '31')

function todosR(items: [boolean, string][]): R {
  return (cols) => {
    const w = width(cols)
    const cur = items.findIndex(([done]) => !done)
    const out = toolHead('Update Todos', null, cols)
    items.forEach(([done, text], i) => {
      const segs: Seg[] = [{ s: done ? '☒ ' : '☐ ', c: done ? '90' : '' }, { s: text, c: done ? '9;90' : i === cur ? '1' : '' }]
      out.push(...wrap(segs, w, i === 0 ? dim('  ⎿  ') : '     ', 5, '       '))
    })
    return out
  }
}

const OPTIONS = ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No, and tell Claude what to do differently (esc)']

/** the permission question, as Claude Code draws it under a rule at the bottom of the pane */
function dialogR(e: Edit, sel: number): R {
  return (cols) => {
    const w = width(cols)
    const name = e.file.slice(e.file.lastIndexOf('/') + 1)
    const lines: Lines = [
      sgr('34', '─'.repeat(w)),
      ` ${sgr('1;34', 'Edit file')}`,
      ...wrap([{ s: e.file, c: '90' }], w, ' ', 1, ' '),
      '',
      ...diffLines(e.rows, cols, ' '),
      '',
      ...wrap([{ s: 'Do you want to make this edit to ', c: '' }, { s: name, c: '1' }, { s: '?', c: '' }], w, ' ', 1, ' '),
    ]
    OPTIONS.forEach((o, i) => {
      const on = i === sel
      const m = /^(.*?)(\s\([^)]+\))?$/.exec(o)
      const label = m?.[1] ?? o
      const hint = m?.[2] ?? ''
      const segs: Seg[] = [{ s: `${i + 1}. ${label}`, c: on ? '32' : '' }]
      if (hint) segs.push({ s: hint, c: '90' })
      lines.push(...wrap(segs, w, ` ${on ? `${sgr('32', '❯')} ` : '  '}`, 3, '      '))
    })
    return lines
  }
}

// ---------- the replay: plays the script into xterm the way the CLI would ----------

type Mode = 'default' | 'accept' | 'plan'
const MODES: Mode[] = ['default', 'accept', 'plan']
type EngineInfo = { ctx: number; finished: boolean; mode: Mode }
type SendResult = 'sent' | 'queued' | 'cleared'

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const UNIT = /\x1b\[[0-9;?]*[A-Za-z]|\r\n|[\s\S]/g

class Replay {
  info: EngineInfo = { ctx: SAMPLE.ctx, finished: false, mode: 'default' }
  private term: XTerm
  private emit: (s: string, quiet: boolean) => void
  private onReset: () => void
  private notify: (i: EngineInfo) => void
  /** everything printed so far, re-drawable at any width */
  private log: R[] = []
  /** a tool line still waiting for its result */
  private pending: R | null = null
  private dialog: { e: Edit; sel: number } | null = null
  private queue: Step[] = []
  private current: Step | null = null
  private stream: { units: string[]; i: number; r: R; done: () => void } | null = null
  private timer = 0
  private spinTimer = 0
  private turnAt = 0
  private verb = 'Thinking'
  private frame = 0
  private tokens = 0
  /** the line under the output holds the spinner (in a turn) or the prompt (idle) */
  private tail = false
  private draft = ''
  private typing: string | null = null
  private interrupted = false
  private rejected = false
  private paused = false
  private held: (() => void) | null = null
  private dead = false

  constructor(term: XTerm, emit: (s: string, quiet: boolean) => void, onReset: () => void, notify: (i: EngineInfo) => void) {
    this.term = term
    this.emit = emit
    this.onReset = onReset
    this.notify = notify
  }

  // ---- output ----

  private out(s: string, quiet = false) {
    if (!this.dead && s) this.emit(s, quiet)
  }

  private paint(r: R): string {
    return r(this.term.cols).join(NL)
  }

  private clearTail() {
    if (!this.tail) return
    this.out('\r\x1b[2K', true)
    this.tail = false
  }

  private drawTail() {
    if (this.dead || this.dialog || this.stream) return
    if (this.turnAt) {
      this.out(`\x1b[?25l\r\x1b[2K${this.spinText()}\r`)
    } else {
      const room = Math.max(4, width(this.term.cols) - 2)
      const src = this.typing ?? this.draft
      const line = src.split('\n')[0]
      const shown = line.length > room || src.includes('\n') ? `${line.slice(0, room - 1)}…` : line
      this.out(`\r\x1b[2K${dim('>')} ${shown}\x1b[?25h`, true)
    }
    this.tail = true
  }

  private spinText(): string {
    const secs = Math.floor((Date.now() - this.turnAt) / 1000)
    const tok = this.tokens >= 1000 ? `${(this.tokens / 1000).toFixed(1)}k` : String(this.tokens)
    const head = `${SPIN[this.frame % SPIN.length]} ${this.verb}…`
    const room = width(this.term.cols)
    const tails = [` (${secs}s · ↓ ${tok} tokens · esc to interrupt)`, ` (${secs}s · esc to interrupt)`, ` (${secs}s)`, '']
    return sgr('32', head) + dim(tails.find((t) => head.length + t.length <= room) ?? '')
  }

  private commit(r: R) {
    this.clearTail()
    this.out(this.paint(r) + NL + NL)
    this.log.push(r)
    this.drawTail()
  }

  // ---- turns ----

  private startTurn() {
    this.turnAt = Date.now()
    this.tokens = 0
    if (this.info.finished) this.setInfo({ finished: false })
    if (this.spinTimer) return
    this.spinTimer = window.setInterval(() => {
      if (this.paused || !this.turnAt || this.dialog || this.stream) return
      this.frame++
      this.tokens += 8 + Math.floor(Math.random() * 30)
      this.drawTail()
    }, 120)
  }

  private endTurn() {
    this.turnAt = 0
    window.clearInterval(this.spinTimer)
    this.spinTimer = 0
    this.clearTail()
    this.drawTail()
  }

  private setInfo(p: Partial<EngineInfo>) {
    this.info = { ...this.info, ...p }
    this.notify(this.info)
  }

  // ---- timing (one timer; held while the page is hidden) ----

  private after(ms: number, fn: () => void) {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = 0
      if (this.dead) return
      if (this.paused) {
        this.held = fn
        return
      }
      fn()
    }, ms)
  }

  pause(on: boolean) {
    this.paused = on
    if (!on && this.held) {
      const f = this.held
      this.held = null
      f()
    }
  }

  // ---- the script ----

  private next() {
    if (this.dead || this.dialog) return
    const s = this.queue.shift() ?? null
    this.current = s
    if (!s) {
      if (this.turnAt) this.endTurn()
      return
    }
    if (s.ctx) this.setInfo({ ctx: Math.min(100, this.info.ctx + s.ctx) })
    switch (s.t) {
      case 'block':
        this.commit(s.r)
        this.after(150, () => this.next())
        return
      case 'wait':
        this.after(s.ms, () => this.next())
        return
      case 'user': {
        const go = () => {
          this.typing = null
          this.commit(userR(s.text))
          this.startTurn()
          this.after(300, () => this.next())
        }
        if (s.typed) this.typeOut(s.text, go)
        else go()
        return
      }
      case 'echo':
        this.commit(userR(s.text))
        this.after(200, () => this.next())
        return
      case 'think':
        if (s.verb) this.verb = s.verb
        this.after(s.ms, () => this.next())
        return
      case 'say':
        this.streamOut(sayR(s.text), () => this.after(250, () => this.next()))
        return
      case 'tool': {
        const head: R = (c) => toolHead(s.name, s.arg, c)
        this.clearTail()
        this.out(this.paint(head) + NL)
        this.pending = head
        this.drawTail()
        this.after(s.run, () => {
          this.clearTail()
          this.out(this.paint((c) => result(s.out, c)) + NL + NL)
          this.pending = null
          this.log.push((c) => [...toolHead(s.name, s.arg, c), ...result(s.out, c)])
          this.drawTail()
          this.after(250, () => this.next())
        })
        return
      }
      case 'todos':
        this.commit(todosR(s.items))
        this.after(350, () => this.next())
        return
      case 'edit':
        // accept-edits mode never asks, as in Claude Code
        if (this.info.mode === 'accept') {
          this.commit(editDoneR(s.e))
          this.after(400, () => this.next())
          return
        }
        this.clearTail()
        this.dialog = { e: s.e, sel: 0 }
        this.out(`${this.paint(dialogR(s.e, 0))}${NL}\x1b[?25l`)
        return
      case 'end':
        this.setInfo({ finished: true })
        this.endTurn()
        return
    }
  }

  /** the sample's own prompt, typed into Claude's input line before it is sent */
  private typeOut(text: string, done: () => void) {
    let i = 0
    const step = () => {
      i = Math.min(text.length, i + 1 + (Math.random() < 0.3 ? 1 : 0))
      this.typing = text.slice(0, i)
      this.drawTail()
      if (i < text.length) this.after(24 + Math.random() * 50, step)
      else this.after(380, done)
    }
    this.after(200, step)
  }

  /** assistant text arrives in bursts of a few characters, like a token stream */
  private streamOut(r: R, done: () => void) {
    this.clearTail()
    const st = { units: (this.paint(r) + NL + NL).match(UNIT) ?? [], i: 0, r, done }
    this.stream = st
    const tick = () => {
      if (this.stream !== st) return
      let n = 3 + Math.floor(Math.random() * 12)
      let chunk = ''
      while (st.i < st.units.length && n > 0) {
        const u = st.units[st.i++]
        chunk += u
        if (u.charCodeAt(0) !== 27) n--
      }
      while (st.i < st.units.length && st.units[st.i].charCodeAt(0) === 27) chunk += st.units[st.i++]
      this.out(chunk)
      if (st.i < st.units.length) {
        this.after(30 + Math.random() * 50, tick)
        return
      }
      this.stream = null
      this.log.push(r)
      this.drawTail()
      done()
    }
    tick()
  }

  // ---- what the page can do ----

  /**
   * An empty screen, in order with the writes already queued. term.reset()
   * acts at once while earlier writes still wait in xterm's buffer, and those
   * then land on the fresh screen (a stray "> " ahead of the welcome box when
   * the page opens from Sessions). RIS through write() keeps the order.
   */
  private wipe() {
    if (!this.dead) this.term.write('\x1bc')
    this.onReset()
  }

  /** Start the sample from the top (a fresh session: default mode, empty screen). */
  restart() {
    window.clearTimeout(this.timer)
    window.clearInterval(this.spinTimer)
    this.timer = 0
    this.spinTimer = 0
    this.held = null
    this.log = []
    this.pending = null
    this.dialog = null
    this.stream = null
    this.typing = null
    this.current = null
    this.turnAt = 0
    this.interrupted = false
    this.rejected = false
    this.queue = sampleScript()
    this.setInfo({ ctx: SAMPLE.ctx, finished: false, mode: 'default' })
    this.wipe()
    this.tail = false
    this.out('\x1b[?25l', true)
    this.next()
  }

  /** Draw everything again at the grid's width (a resize, or a question that closed). */
  rerender() {
    if (this.dead) return
    const st = this.stream
    if (st) {
      // a stream in flight lands whole
      this.stream = null
      this.log.push(st.r)
      this.after(200, st.done)
    }
    this.wipe()
    const c = this.term.cols
    let s = '\x1b[?25l'
    for (const r of this.log) s += r(c).join(NL) + NL + NL
    if (this.pending) s += this.pending(c).join(NL) + NL
    if (this.dialog) s += dialogR(this.dialog.e, this.dialog.sel)(c).join(NL) + NL
    this.tail = false
    this.out(s, true)
    this.drawTail()
  }

  /** Pick option n of the question on screen (1 yes, 2 yes for the session, 3 no). */
  answer(n: number): boolean {
    const d = this.dialog
    if (!d) return false
    this.dialog = null
    if (n === 3) {
      // Claude stops and waits for a word; the same edit comes back after it
      this.log.push(editRejectedR(d.e))
      this.rejected = true
      this.interrupted = true
      this.queue.unshift({ t: 'edit', e: d.e })
      this.turnAt = 0
      window.clearInterval(this.spinTimer)
      this.spinTimer = 0
      this.rerender()
      return true
    }
    if (n === 2) this.setInfo({ mode: 'accept' })
    this.log.push(editDoneR(d.e))
    this.rerender()
    this.after(450, () => this.next())
    return true
  }

  /** Esc while Claude works: it stops where it is; the next prompt picks it up. */
  interrupt(): boolean {
    if (!this.turnAt || this.dialog) return false
    window.clearTimeout(this.timer)
    this.timer = 0
    this.held = null
    const st = this.stream
    if (st) {
      this.out(st.units.slice(st.i).join(''))
      this.stream = null
      this.log.push(st.r)
    } else {
      this.clearTail()
    }
    const cur = this.current
    const head = this.pending
    if (head && cur?.t === 'tool') {
      // the tool line gets its stop, and the tool runs again on resume
      this.pending = null
      this.out(this.paint(interruptedR) + NL + NL)
      this.log.push((c) => [...head(c), ...interruptedR(c)])
      this.queue.unshift(cur)
    } else {
      this.out(this.paint(interruptedR) + NL + NL)
      this.log.push(interruptedR)
    }
    this.tail = false
    this.interrupted = true
    this.turnAt = 0
    window.clearInterval(this.spinTimer)
    this.spinTimer = 0
    this.drawTail()
    return true
  }

  /** The composer's text, echoed as Claude Code shows a prompt. */
  send(text: string): SendResult {
    // typing over a question is option 3 with a reason
    if (this.dialog) this.answer(3)
    const slash = /^\/(\S+)/.exec(text)
    // a prompt sent while Claude works is queued, and lands between steps
    if (this.turnAt || this.typing !== null || (this.queue.length && !this.interrupted)) {
      this.queue.unshift({ t: 'echo', text })
      return 'queued'
    }
    if (slash?.[1] === 'clear') {
      this.log = []
      this.rerender()
      return 'cleared'
    }
    if (slash) {
      const cmd = slash[1]
      this.commit((c) => [...userR(text)(c), ...result([`(preview) /${cmd} runs inside Claude Code`], c)])
      return 'sent'
    }
    this.commit(userR(text))
    this.startTurn()
    if (this.interrupted) {
      const word = this.rejected ? 'Understood. Here is the change again with that in mind.' : 'Continuing where I stopped.'
      this.interrupted = false
      this.rejected = false
      this.queue.unshift({ t: 'think', ms: 1100, verb: 'Mulling' }, { t: 'say', text: word }, { t: 'think', ms: 600 })
    } else {
      this.queue = [
        { t: 'think', ms: 1300, verb: 'Mulling' },
        { t: 'say', text: 'This is a recorded sample, so nothing ran. In the live terminal this prompt goes to Claude Code on thor, typed through this same composer.' },
        { t: 'end' },
      ]
    }
    this.after(250, () => this.next())
    return 'sent'
  }

  /** Claude's input line follows the composer while nothing runs. */
  setDraft(text: string) {
    this.draft = text
    if (!this.turnAt && !this.dialog && !this.stream && this.typing === null) this.drawTail()
  }

  cycleMode(): Mode {
    const m = MODES[(MODES.indexOf(this.info.mode) + 1) % MODES.length]
    this.setInfo({ mode: m })
    return m
  }

  dispose() {
    this.dead = true
    window.clearTimeout(this.timer)
    window.clearInterval(this.spinTimer)
  }
}

// ---------- reading the stream: tool lines become activity rows ----------

type ActKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'web' | 'agent' | 'todo' | 'tool'
type Act = { id: number; kind: ActKind; tool: string; arg: string; detail: string; state: 'run' | 'ok' | 'no' }
type TodoSnap = { done: number; total: number; current: string | null }

const TOOL_KIND: Record<string, ActKind> = {
  Read: 'read', Update: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
  Bash: 'run', Search: 'search', Grep: 'search', Glob: 'search', LS: 'search', List: 'search',
  WebFetch: 'web', Fetch: 'web', WebSearch: 'web', Task: 'agent', Agent: 'agent',
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[78=>]/g
const TODO_LINE = /^\s*(?:⎿\s+)?([☐☒□■✔✓◻◼])\s+(.*)$/
const TODO_DONE = /[☒✔✓]/

/**
 * Turns the CLI's text into activity rows: "● Read(path)" opens a row, the
 * "⎿ ..." under it closes it with its result, "● Update Todos" carries the
 * todo list. Only what the screen says; the script is never consulted.
 */
class StreamParser {
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
    const head = /^[●⏺]\s+([A-Z][A-Za-z]+)\((.*)$/.exec(l)
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

// ---------- reading the screen: the question and the spinner ----------

type Opt = { n: number; label: string; hint: string; sel: boolean }
type Question = { kind: string; file: string; text: string; options: Opt[] }
type ScreenState = { q: Question | null; spinning: boolean }

const OPT_LINE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.*)$/
const RULE_LINE = /^\s*[─━╌]{6,}\s*$/
const SPIN_LINE = /^\s*[·✢✳✶✻✽*]\s+\S.*…/
const NO_SCREEN: ScreenState = { q: null, spinning: false }

/**
 * What a wrapper on a live pane can know from the screen alone: a numbered
 * list at the bottom under a question is a permission prompt (its kind and
 * file sit under the rule that opens it), and a spinner line last means Claude
 * is working.
 */
function readScreen(term: XTerm): ScreenState {
  const b = term.buffer.active
  const end = Math.min(b.length - 1, b.baseY + b.cursorY)
  const lines: string[] = []
  for (let y = Math.max(0, end - 60); y <= end; y++) {
    const ln = b.getLine(y)
    if (!ln) continue
    const t = ln.translateToString(true)
    if (ln.isWrapped && lines.length) lines[lines.length - 1] += t
    else lines.push(t)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const last = lines[lines.length - 1] ?? ''
  return { q: findQuestion(lines), spinning: SPIN_LINE.test(last) || last.includes('esc to interrupt') }
}

function findQuestion(lines: string[]): Question | null {
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

const sameScreen = (a: ScreenState, b: ScreenState) => a.spinning === b.spinning && JSON.stringify(a.q) === JSON.stringify(b.q)

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
function termTheme(p: Palette): ITheme {
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

// ---------- page ----------

type Phase = 'working' | 'asking' | 'idle'
const PHASE: Record<Phase, { icon: IconName; tone: IconTone; glow: boolean; word: string }> = {
  working: { icon: 'working', tone: 'fg', glow: true, word: 'working' },
  asking: { icon: 'asking', tone: 'acc2', glow: true, word: 'asking' },
  idle: { icon: 'idle', tone: 'dim', glow: false, word: 'idle' },
}

type KeyId = 'esc' | 'ctrlc' | 'tab' | 'stab' | 'up' | 'down' | 'slash' | 'y' | 'n' | '1' | '2' | '3'
const KEYS: { id: KeyId; label: string; aria: string; sub?: string }[] = [
  { id: 'esc', label: 'Esc', aria: 'Escape' },
  { id: 'ctrlc', label: '^C', aria: 'Control C' },
  { id: 'tab', label: 'Tab', aria: 'Tab' },
  { id: 'stab', label: '⇧Tab', aria: 'Shift Tab, change mode', sub: 'mode' },
  { id: 'up', label: '↑', aria: 'Up' },
  { id: 'down', label: '↓', aria: 'Down' },
  { id: 'slash', label: '/', aria: 'Slash command' },
  { id: 'y', label: 'y', aria: 'y' },
  { id: 'n', label: 'n', aria: 'n' },
  { id: '1', label: '1', aria: '1' },
  { id: '2', label: '2', aria: '2' },
  { id: '3', label: '3', aria: '3' },
]
const ANSWER_KEYS = new Set<KeyId>(['esc', 'y', 'n', '1', '2', '3'])

const SLASH = ['/clear', '/compact', '/context', '/cost', '/model', '/resume', '/review']
const MODE_LABEL: Record<Mode, string> = { default: '', accept: '⏵⏵ accept edits on', plan: '⏸ plan mode on' }

const PREVIEW_MSG = 'Preview: this stays on the page. Nothing reaches Claude.'

// index.html loads JetBrains Mono's text subsets only, so the CLI's box lines,
// bullets, checkboxes and spinner fell back to another font, a cell too narrow
// (rules drew as dashes). Google's text= subset adds exactly those glyphs to the
// same family under a unicode-range, leaving every other character alone.
const CLI_GLYPHS = '─│╭╮╰╯├┤┬┴┼╌━⎿●⏺❯›☐☒✻✢✳✶✽⏵⏸✔✓■◼◻⇧'
const CLI_GLYPH_CSS = `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&text=${encodeURIComponent(CLI_GLYPHS)}&display=swap`

function useCliGlyphs() {
  useEffect(() => {
    if (document.querySelector(`link[href="${CLI_GLYPH_CSS}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = CLI_GLYPH_CSS
    document.head.appendChild(link)
  }, [])
}

function useMedia(query: string): boolean {
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
const termFont = (w: number) => (w < 640 ? { size: 12.5, line: 1.12 } : w < 1200 ? { size: 13.5, line: 1.04 } : { size: 14, line: 1.04 })

export default function Skin() {
  const navigate = useNavigate()
  const palette = usePalette()
  // no shell here: follow the stored scheme and font the way it does
  const stored = useStoredMode()
  useLayoutEffect(() => { applyPalette(stored) }, [stored])
  useFont()
  useCliGlyphs()

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const engRef = useRef<Replay | null>(null)
  const fitRef = useRef<() => void>(() => {})
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [parser] = useState(() => new StreamParser())
  const [acts, setActs] = useState<Act[]>([])
  const [todos, setTodos] = useState<TodoSnap | null>(null)
  const [screen, setScreen] = useState<ScreenState>(NO_SCREEN)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<EngineInfo>({ ctx: SAMPLE.ctx, finished: false, mode: 'default' })
  const [draft, setDraft] = useState('')
  const history = useRef<string[]>([SAMPLE.prompt])
  const histAt = useRef(-1)

  const wide = useMedia('(min-width: 760px)')
  const md = useMedia('(min-width: 640px)')
  const lg = useMedia('(min-width: 1200px)')
  const coarse = useMedia('(pointer: coarse)')
  const short = useMedia('(max-height: 480px)')
  // the list opens by itself where there is room for it: a wide screen that is not a landscape phone
  const [actPick, setActPick] = useState<boolean | null>(null)
  const actOpen = actPick ?? (wide && !short)

  const theme = useMemo(() => termTheme(palette), [palette.fg]) // eslint-disable-line react-hooks/exhaustive-deps
  const themeRef = useRef(theme)
  themeRef.current = theme
  const font = lg ? termFont(1600) : md ? termFont(800) : termFont(390)

  // the terminal and the replay, once
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let dead = false
    let started = false
    let cols = 0
    const zoom = readUiZoom()
    setTermZoom(host, zoom)
    const f0 = termFont(window.innerWidth)
    const term = new XTerm({
      fontFamily: TERM_FONT_FAMILY,
      fontSize: f0.size * zoom,
      lineHeight: f0.line,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'bar',
      scrollback: 3000,
      disableStdin: true,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
      theme: themeRef.current,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    // the composer types; the grid never takes the keyboard (no iOS keyboard on a tap)
    const ta = term.textarea
    if (ta) {
      ta.readOnly = true
      ta.tabIndex = -1
      ta.setAttribute('inputmode', 'none')
      ta.setAttribute('aria-hidden', 'true')
    }

    // one screen read per frame
    let raf = 0
    const scan = () => {
      raf = 0
      if (dead) return
      const next = readScreen(term)
      setScreen((cur) => (sameScreen(cur, next) ? cur : next))
    }
    const queueScan = () => { if (!raf && !dead) raf = requestAnimationFrame(scan) }

    // output in the last moment counts as working, as bytes from a live pane would
    let lastOut = 0
    let busyT = 0
    const markBusy = () => {
      lastOut = Date.now()
      setBusy(true)
      if (busyT) return
      const check = () => {
        const left = 1200 - (Date.now() - lastOut)
        if (left > 0) busyT = window.setTimeout(check, left)
        else {
          busyT = 0
          setBusy(false)
        }
      }
      busyT = window.setTimeout(check, 1200)
    }

    parser.onChange = () => {
      setActs(parser.acts.map((a) => ({ ...a })))
      setTodos(parser.todos)
    }
    const emit = (s: string, quiet: boolean) => {
      if (dead) return
      term.write(s, queueScan)
      parser.feed(s)
      if (!quiet) markBusy()
    }
    const eng = new Replay(term, emit, () => parser.reset(), (i) => setInfo(i))
    engRef.current = eng

    // the phone terminal's fit: never a hidden or squeezed box
    const safeFit = () => {
      if (dead || host.clientWidth < 40 || host.clientHeight < 40) return
      let d: { cols: number; rows: number } | undefined
      try { d = fit.proposeDimensions() } catch { return }
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 20 || d.rows < 2) return
      if (d.cols === term.cols && d.rows === term.rows) return
      try { fit.fit() } catch { /* the next resize fits */ }
    }
    fitRef.current = safeFit
    // a new width draws the whole session again at that width, as the CLI repaints on a resize
    const onResize = term.onResize(({ cols: c }) => {
      if (c === cols) return
      cols = c
      if (started) eng.rerender()
    })
    let frame = 0
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; safeFit() })
    })
    ro.observe(host)
    safeFit()
    cols = term.cols
    // cell metrics measured before the webfont lands are a fraction off: start once it has
    const start = () => {
      if (started || dead) return
      started = true
      safeFit()
      cols = term.cols
      eng.restart()
    }
    void document.fonts?.ready.then(start)
    const startT = window.setTimeout(start, 700)

    const onVis = () => eng.pause(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    toast('Preview: a recorded Claude Code session plays here. Nothing reaches Claude.', { ms: 3600 })

    return () => {
      dead = true
      eng.dispose()
      if (engRef.current === eng) engRef.current = null
      window.clearTimeout(startT)
      window.clearTimeout(busyT)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVis)
      ro.disconnect()
      onResize.dispose()
      parser.onChange = () => {}
      term.dispose()
      setTermZoom(host, 1)
      if (termRef.current === term) termRef.current = null
    }
  }, [parser])

  useEffect(() => {
    const t = termRef.current
    if (t) t.options.theme = theme
  }, [theme])

  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.fontSize = font.size * readUiZoom()
    t.options.lineHeight = font.line
    const raf = requestAnimationFrame(() => fitRef.current())
    return () => cancelAnimationFrame(raf)
  }, [font.size, font.line])

  // Claude's input line follows the composer
  useEffect(() => { engRef.current?.setDraft(draft) }, [draft])

  // the composer grows to five lines, then scrolls
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 124)}px`
  }, [draft])

  const q = screen.q
  const phase: Phase = q ? 'asking' : screen.spinning || busy ? 'working' : 'idle'

  const answer = (n: number) => {
    if (engRef.current?.answer(n)) toast(PREVIEW_MSG)
  }

  const recall = (dir: -1 | 1) => {
    const h = history.current
    if (!h.length) return
    let i = histAt.current
    if (dir < 0) i = i < 0 ? h.length - 1 : Math.max(0, i - 1)
    else {
      if (i < 0) return
      i += 1
      if (i >= h.length) {
        histAt.current = -1
        setDraft('')
        return
      }
    }
    histAt.current = i
    setDraft(h[i])
  }

  const send = () => {
    const text = draft.trim()
    const eng = engRef.current
    if (!text || !eng) return
    history.current.push(text)
    histAt.current = -1
    setDraft('')
    const r = eng.send(text)
    toast(r === 'queued' ? 'Preview: queued until this step ends. Nothing reaches Claude.' : r === 'cleared' ? 'Preview: screen cleared' : PREVIEW_MSG)
  }

  const onKey = (k: KeyId) => {
    const eng = engRef.current
    if (!eng) return
    switch (k) {
      case 'esc':
        if (q) answer(3)
        else if (eng.interrupt()) toast(PREVIEW_MSG)
        else toast('Esc: nothing is running')
        return
      case 'ctrlc':
        if (draft) {
          setDraft('')
          toast(PREVIEW_MSG)
        } else if (eng.interrupt()) toast(PREVIEW_MSG)
        else toast('Preview: Ctrl+C twice exits Claude Code')
        return
      case 'tab': {
        const hit = draft.startsWith('/') && !draft.includes(' ') ? SLASH.find((c) => c.startsWith(draft) && c !== draft) : undefined
        if (hit) setDraft(`${hit} `)
        else toast('Tab: completes a / command')
        return
      }
      case 'stab': {
        const m = eng.cycleMode()
        toast(m === 'default' ? 'Mode: ask before edits' : m === 'accept' ? 'Mode: accept edits' : 'Mode: plan')
        return
      }
      case 'up':
        recall(-1)
        return
      case 'down':
        recall(1)
        return
      case 'slash':
        setDraft((d) => d || '/')
        if (!coarse) taRef.current?.focus()
        return
      case 'y':
        if (q) answer(1)
        else setDraft((d) => d + 'y')
        return
      case 'n':
        if (q) answer(3)
        else setDraft((d) => d + 'n')
        return
      default:
        if (q) answer(Number(k))
        else setDraft((d) => d + k)
    }
  }

  // a keyboard outside the composer: Esc, and 1/2/3/y/n while Claude asks
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  const askRef = useRef(!!q)
  askRef.current = !!q
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.key === 'Escape') {
        e.preventDefault()
        keyRef.current('esc')
      } else if (askRef.current && /^[123yn]$/.test(e.key)) {
        e.preventDefault()
        keyRef.current(e.key as KeyId)
      }
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [])

  const onTaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onKey('esc')
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      onKey('stab')
    } else if (e.key === 'Tab' && draft.startsWith('/')) {
      e.preventDefault()
      onKey('tab')
    } else if (e.key === 'ArrowUp' && !draft.includes('\n') && e.currentTarget.selectionStart === 0) {
      e.preventDefault()
      recall(-1)
    } else if (e.key === 'ArrowDown' && !draft.includes('\n') && histAt.current >= 0) {
      e.preventDefault()
      recall(1)
    }
  }

  const back = () => {
    const st = window.history.state as { idx?: number } | null
    if (st?.idx) navigate(-1)
    else navigate(`${BASE}/ai/sessions`, { replace: true })
  }

  const slash = draft.startsWith('/') && !draft.includes(' ') ? SLASH.filter((c) => c.startsWith(draft) && c !== draft) : []
  const modeLabel = MODE_LABEL[info.mode]
  const ctx = Math.round(info.ctx)

  return (
    <div className="vsk" data-phase={phase}>
      <header className="vsk-head">
        <StatusStrip onSettings={() => navigate(`${BASE}/settings`)} />
        <div className="vsk-bar">
          <Press className="vsk-back" aria-label="Back to Sessions" onPress={back}>
            <Glyph name="left" size={11} />
            <span>Sessions</span>
          </Press>
          <div className="vsk-title">
            <StateGlyph phase={phase} />
            <h1 className="vl-ellipsis">{SAMPLE.title}</h1>
          </div>
          <span className="vsk-tag" title="A recorded sample: nothing here reaches Claude">Preview</span>
        </div>
        <div className="vl-nav-line vsk-line" />
      </header>

      <div className="vsk-body">
        <div className="vsk-termbox">
          <div ref={hostRef} className="vsk-term" />
        </div>

        <div className="vsk-comp">
          {(slash.length > 0 || modeLabel) && (
            <div className="vsk-comp-top">
              {slash.map((c) => (
                <Press key={c} className="vsk-chip" onPress={() => setDraft(`${c} `)}>{c}</Press>
              ))}
              {modeLabel && <span className="vsk-mode" data-m={info.mode}>{modeLabel}</span>}
            </div>
          )}
          <div className="vsk-comp-row">
            <textarea
              ref={taRef}
              className="vsk-input"
              rows={1}
              value={draft}
              placeholder={q ? 'Or tell Claude instead' : 'Message Claude'}
              aria-label="Message Claude"
              enterKeyHint={coarse ? 'enter' : 'send'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                histAt.current = -1
                setDraft(e.target.value)
              }}
              onKeyDown={onTaKey}
            />
            <Press className="vl-btn vsk-send" aria-label="Send" disabled={!draft.trim()} onPress={send}>
              <ArrowUp size={18} strokeWidth={2} className="vl-icon vl-icon-ink" aria-hidden />
            </Press>
          </div>
        </div>

        {/* the side column on wide screens; on the phone its parts take their own rows */}
        <aside className="vsk-side">
          <div className="vsk-meta">
            <span className="vsk-m vsk-m-host" title={`Runs on ${SAMPLE.host}`}>
              <Icon name={hostIcon(SAMPLE.host)} size={12} tone="fg" glow />
              <b>{SAMPLE.host}</b>
            </span>
            <span className="vsk-m">{SAMPLE.model}</span>
            <span className="vsk-m" title="Context used">
              <span className="vsk-m-k">ctx</span>
              <Bar value={ctx} ticks={4} tone={ctx >= 80 ? 'acc2' : 'fg'} className="vsk-ctx" />
              <b>{ctx}%</b>
            </span>
            {todos && todos.total > 0 && (
              <span className="vsk-m" title={todos.current ? `Next: ${todos.current}` : 'All done'}>
                <ListChecks size={12} strokeWidth={1.8} className={cx('vl-icon', todos.done === todos.total ? 'vl-icon-fg' : 'vl-icon-dim')} aria-hidden />
                <b>{todos.done}/{todos.total}</b>
              </span>
            )}
            <span className="vsk-m vsk-m-word" data-p={phase}>{PHASE[phase].word}</span>
            <IconButton
              className="vsk-replay"
              icon={<RotateCcw size={15} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />}
              label="Play the sample again"
              onPress={() => engRef.current?.restart()}
            />
          </div>

          {q && <Choices q={q} onPick={answer} />}

          <ActivityStrip acts={acts} open={actOpen} onToggle={() => setActPick(!actOpen)} />

          <div className="vsk-keys" role="toolbar" aria-label="Keys">
            {KEYS.map((k) => {
              const lit = q && ANSWER_KEYS.has(k.id) ? 'ask' : (k.id === 'stab' && info.mode !== 'default') || (k.id === 'esc' && phase === 'working') ? 'on' : undefined
              return (
                <Press key={k.id} className="vsk-key" data-k={k.id} data-lit={lit} aria-label={k.aria} onPress={() => onKey(k.id)}>
                  <span>{k.label}</span>
                  {k.sub && <small>{k.sub}</small>}
                </Press>
              )
            })}
          </div>
        </aside>
      </div>

      <ToastHost className="vsk-toasts" />
    </div>
  )
}

function StateGlyph({ phase }: { phase: Phase }) {
  const s = PHASE[phase]
  return (
    <span className="vsk-sicon" data-p={phase} title={s.word}>
      <Icon name={s.icon} size={16} tone={s.tone} glow={s.glow} />
    </span>
  )
}

/** The question on screen as big plates: 1 is the lit one, the CLI's key hints ride along. */
function Choices({ q, onPick }: { q: Question; onPick: (n: number) => void }) {
  const file = q.file.slice(Math.max(q.file.lastIndexOf('/'), q.file.lastIndexOf('\\')) + 1)
  return (
    <section className="vsk-ask" aria-label="Claude is asking">
      <header className="vsk-ask-head">
        <Icon name="asking" size={14} tone="acc2" glow />
        <span>{q.kind || 'Asking'}</span>
        {file && <b className="vl-ellipsis">{file}</b>}
      </header>
      <p className="vsk-ask-q">{q.text}</p>
      <div className="vsk-ask-opts" role="group" aria-label="Answers">
        {q.options.map((o, i) => (
          <Press
            key={o.n}
            className={cx('vsk-opt', i === 0 && 'vsk-opt-yes')}
            data-sel={o.sel || undefined}
            aria-label={`${o.n}. ${o.label}`}
            onPress={() => onPick(o.n)}
          >
            <b className="vsk-opt-n">{o.n}</b>
            <span className="vsk-opt-l">{o.label}</span>
            {o.hint && <kbd className="vsk-opt-k">{o.hint}</kbd>}
          </Press>
        ))}
      </div>
    </section>
  )
}

const KIND_ICON: Record<ActKind, LucideIcon> = {
  read: FileText, edit: FilePen, write: FilePlus, run: SquareTerminal, search: Search, web: Globe, agent: Bot, todo: ListChecks, tool: Wrench,
}
const KIND_VERB: Record<ActKind, string> = {
  read: 'Read', edit: 'Edit', write: 'Write', run: 'Run', search: 'Find', web: 'Fetch', agent: 'Agent', todo: 'Todo', tool: 'Tool',
}

function KindIcon({ kind, lit, size = 14 }: { kind: ActKind; lit?: boolean; size?: number }) {
  const C = KIND_ICON[kind]
  return <C size={size} strokeWidth={size <= 12 ? 1.8 : 1.6} className={cx('vl-icon', lit ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />
}

function actTarget(a: Act): { name: string; dir: string } {
  if (a.kind === 'read' || a.kind === 'edit' || a.kind === 'write') {
    const i = Math.max(a.arg.lastIndexOf('/'), a.arg.lastIndexOf('\\'))
    return i < 0 ? { name: a.arg, dir: '' } : { name: a.arg.slice(i + 1), dir: a.arg.slice(0, i) }
  }
  if (a.kind === 'search') {
    const p = /pattern:\s*"([^"]*)"/.exec(a.arg)
    const d = /path:\s*"([^"]*)"/.exec(a.arg)
    return { name: p ? `"${p[1]}"` : a.arg, dir: d?.[1] ?? '' }
  }
  return { name: a.arg || a.tool, dir: '' }
}

function actDetail(a: Act): ReactNode {
  if (a.state === 'run') return a.kind === 'todo' ? null : <span className="vsk-arow-run">running</span>
  if (a.state === 'no') return /rejected/i.test(a.detail) ? 'rejected' : 'stopped'
  switch (a.kind) {
    case 'read': {
      const n = /Read (\d+) lines?/.exec(a.detail)?.[1]
      return n ? `${n} lines` : a.detail
    }
    case 'edit':
    case 'write': {
      const add = /(\d+) additions?/.exec(a.detail)?.[1]
      const del = /(\d+) removals?/.exec(a.detail)?.[1]
      if (!add && !del) return 'saved'
      return (
        <>
          {add && <em className="vsk-add">+{add}</em>}
          {del && <em className="vsk-del">−{del}</em>}
        </>
      )
    }
    case 'search': {
      const m = /Found (\d+) (\w+)/.exec(a.detail)
      return m ? `${m[1]} ${m[2]}` : a.detail
    }
    case 'run':
      return a.detail === '(No content)' ? 'ok' : a.detail.length > 16 ? `${a.detail.slice(0, 15)}…` : a.detail
    default:
      return a.detail
  }
}

/** Tool calls as icon rows, newest last. Collapsed it is one line: the latest call. */
function ActivityStrip({ acts, open, onToggle }: { acts: Act[]; open: boolean; onToggle: () => void }) {
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [acts.length, open])
  const count = (k: ActKind[]) => acts.filter((a) => k.includes(a.kind)).length
  const parts = [
    [count(['read']), 'read'],
    [count(['edit', 'write']), 'edited'],
    [count(['run']), 'run'],
    [count(['search', 'web']), 'searched'],
  ].filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} ${w}`)
  const last = acts[acts.length - 1]
  const lastT = last ? actTarget(last) : null
  return (
    <section className="vsk-act" data-open={open || undefined} aria-label="Activity">
      <Press className="vsk-act-head" aria-expanded={open} onPress={onToggle}>
        <Icon name="system" size={13} tone={last?.state === 'run' ? 'fg' : 'dim'} glow={last?.state === 'run'} />
        <span className="vsk-act-k">Activity</span>
        <span className="vsk-act-n">{parts.length ? parts.join(' · ') : 'none yet'}</span>
        {!open && last && lastT && (
          <span className="vsk-act-last">
            <KindIcon kind={last.kind} lit={last.state === 'run'} size={12} />
            <span className="vl-ellipsis">{lastT.name}</span>
          </span>
        )}
        <ChevronDown size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim vsk-act-chev" aria-hidden />
      </Press>
      {open && (acts.length ? (
        <ol className="vsk-act-list" ref={listRef}>
          {acts.map((a) => {
            const t = actTarget(a)
            return (
              <li key={a.id} className="vsk-arow" data-s={a.state}>
                <KindIcon kind={a.kind} lit={a.state === 'run'} />
                <span className="vsk-arow-verb">{KIND_VERB[a.kind]}</span>
                <span className="vsk-arow-main">
                  <b>{t.name}</b>
                  {t.dir && <i>{t.dir}</i>}
                </span>
                <span className="vsk-arow-d">{actDetail(a)}</span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="vsk-act-empty">Files Claude reads or edits, and the commands it runs, list here.</p>
      ))}
    </section>
  )
}
