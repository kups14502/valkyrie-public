import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { paneLimitState, type LimitKind } from '../../accountSwitchCore.js'
import { thorHands } from '../../../routes/hostLaunch.js'
import { remoteLabel, SSH_BIN, TMUX_BIN, UUID_RE } from '../../../terminal/tmux.js'
import { screenBusy, screenWaiting } from '../../../terminal/paneState.js'
import { RavenToolError } from './util.js'

// Claude sessions with no Valkyrie pane, as Raven reaches them. Brendon,
// 2026-11-23 (Raven thread #950, then the same night): Raven must talk back and
// forth with every Claude terminal on thor and anywhere else, windows Valkyrie
// did not open included, and must see and click thor's screen when a popup
// blocks one. Each session is found in Claude Code's own registry
// (<config>/sessions/<pid>.json, whose sessionId follows /clear and /resume) on
// its machine, and is reached the way that machine allows:
//
//   console  a Windows Terminal window on thor (Brendon's desktop session): the
//            launcher agent attaches to its console and writes key events into
//            it (C:\Thor\tools\session-board\Raven-Hands.ps1, RavenHands.exe),
//            the proven path of the usage-limit continue runner. No focus needed.
//   ssh      a Claude on thor in an ssh login (session 0, elevated): the agent,
//            running Limited in his desktop session, cannot attach there, so
//            odin runs the same exe over ssh.
//   tmux     a Claude on odin inside any tmux server: send-keys and capture-pane
//            on that server's socket.
//   none     a Claude on odin in a bare terminal: Linux refuses typed input into
//            another terminal (dev.tty.legacy_tiocsti = 0), so Raven reads it only.
//
// A session in a Valkyrie pane is not "outside": the pane tools reach it.

const exec = promisify(execFile)

export type OutsideHost = 'thor' | 'odin'
export type OutsideVia = 'console' | 'ssh' | 'tmux' | 'none'
export type OutsideSession = {
  host: OutsideHost
  sessionId: string
  pid: number
  name: string
  cwd: string
  /** the registry's own word: busy, idle, ... ('' when it has none) */
  status: string
  via: OutsideVia
  /** odin: the tmux server's socket and the pane id */
  tmux?: { socket: string; pane: string }
}

const HANDS_EXE = 'C:\\Thor\\tools\\session-board\\raven-hands\\bin\\RavenHands.exe'
const ODIN_REGISTRY = path.join(process.env.VALKYRIE_ODIN_CLAUDE_DIR || path.join(homedir(), '.claude'), 'sessions')
const VALKYRIE_SOCKET = process.env.VALKYRIE_TMUX_SOCKET || 'valkyrie'

export type OutsideIo = {
  thorSessions: () => Promise<OutsideSession[] | null>
  odinSessions: () => Promise<OutsideSession[]>
  screen: (o: OutsideSession) => Promise<string>
  type: (o: OutsideSession, text: string) => Promise<void>
  keys: (o: OutsideSession, keys: string[]) => Promise<void>
}

// ----------------------------------------------------------- the keys ----

/** The keys Raven may press in a session: what answers a question, a permission prompt or a menu. */
export const SESSION_KEYS = ['enter', 'esc', 'tab', 'shift+tab', 'space', 'backspace', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'delete', 'ctrl+u'] as const
const KEY_RE = /^[a-z0-9]$/

/** "enter", "Esc", "1", "y": checked and lowercased; a key that is not on the list throws. */
export function checkKeys(keys: string[]): string[] {
  const out = keys.map((k) => k.trim().toLowerCase()).filter(Boolean).map((k) => (k === 'escape' ? 'esc' : k === 'return' ? 'enter' : k))
  if (!out.length) throw new RavenToolError('name at least one key')
  if (out.length > 20) throw new RavenToolError('at most 20 keys at a time')
  for (const k of out) {
    if (!KEY_RE.test(k) && !(SESSION_KEYS as readonly string[]).includes(k)) {
      throw new RavenToolError(`no key "${k}". Keys: a letter or digit, or ${SESSION_KEYS.join(', ')}. Text goes with session_send.`)
    }
  }
  return out
}

const TMUX_KEY: Record<string, string> = {
  enter: 'Enter', esc: 'Escape', tab: 'Tab', 'shift+tab': 'BTab', space: 'Space', backspace: 'BSpace', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PPage', pagedown: 'NPage', delete: 'DC', 'ctrl+u': 'C-u',
}
/** tmux send-keys names for checked keys (a letter or digit is itself). */
export const tmuxKeys = (keys: string[]): string[] => keys.map((k) => TMUX_KEY[k] ?? k)

// ------------------------------------------------------- the screen word ----

export type ScreenVerdict = {
  /** working: Claude is on a turn; asking: a question, permission prompt or menu is open; limit: stopped on a usage limit; idle: at an empty prompt; typed: text sits in the prompt */
  state: 'working' | 'asking' | 'limit' | 'idle' | 'typed' | 'unknown'
  promptFound: boolean
  promptEmpty: boolean
  limit: LimitKind | null
  /** Claude Code waits to continue on its own when the limit resets */
  armed: boolean
  /** the turn ended with background work still out (a shell, a monitor, an agent, a workflow) */
  background: boolean
}

/**
 * A named session draws its name into the rule over the prompt ("──── Crewtastrophe ─"), and the prompt check
 * (accountSwitchCore.ts paneLimitState) wants a bare rule there: the name comes out first.
 */
export function plainRules(screen: string): string {
  // [ \t], never \s: \s takes a newline, and the rule, the prompt line and the rule under it would read as one titled rule
  return screen.replace(/^([ \t]*─{8,})[ \t]+[^─\n]{1,80}?[ \t]+(─+)[ \t]*$/gm, (_m, a: string, b: string) => `${a}${'─'.repeat(Math.max(8, b.length))}`)
}

export function screenVerdict(screen: string | null | undefined): ScreenVerdict {
  if (!screen) return { state: 'unknown', promptFound: false, promptEmpty: false, limit: null, armed: false, background: false }
  const v = paneLimitState(plainRules(screen))
  const busy = screenBusy(screen)
  const background = screenWaiting(screen)
  const base = { promptFound: v.promptFound, promptEmpty: v.promptEmpty, limit: v.limit, armed: v.armed, background }
  if (busy) return { state: 'working', ...base }
  if (!v.promptFound) return { state: 'asking', ...base }
  if (v.limit) return { state: 'limit', ...base }
  return { state: v.promptEmpty ? 'idle' : 'typed', ...base }
}

/** The last lines of a screen, blank runs squeezed, for a tool's answer. */
export function screenTail(screen: string, lines = 45): string {
  const all = screen.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''))
  const out: string[] = []
  for (const l of all) if (l || (out.length && out[out.length - 1])) out.push(l)
  return out.slice(-lines).join('\n').trim()
}

// --------------------------------------------------------------- thor ----

function handsError(r: { status: number; body: Record<string, unknown> } | null, what: string): never {
  if (!r) throw new RavenToolError(`thor's launcher is not answering, so ${what} did not happen`)
  throw new RavenToolError(`${what}: ${String(r.body.error ?? `thor answered ${r.status}`).slice(0, 300)}`)
}

/** RavenHands.exe over ssh, for a Claude in an ssh login on thor. Every argument is a number, a key name or base64. */
async function sshHands(args: string[]): Promise<Record<string, unknown>> {
  for (const a of args) if (!/^[A-Za-z0-9+/=,]+$/.test(a)) throw new RavenToolError('a bad argument for thor')
  const cmd = `& '${HANDS_EXE}' ${args.join(' ')}`
  try {
    const { stdout } = await exec(SSH_BIN, ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'WarnWeakCrypto=no', '-o', 'ConnectTimeout=10', remoteLabel(), cmd], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    const line = stdout.trim().split('\n').pop() ?? ''
    return JSON.parse(line) as Record<string, unknown>
  } catch (e) {
    throw new RavenToolError(`thor did not answer over ssh (${(e as Error).message.split('\n')[0].slice(0, 200)})`)
  }
}

async function thorSessions(): Promise<OutsideSession[] | null> {
  const r = await thorHands('GET', '/sessions', undefined, 15_000)
  if (!r || r.status !== 200 || !Array.isArray(r.body.sessions)) return null
  return (r.body.sessions as Record<string, unknown>[]).filter((s) => UUID_RE.test(String(s.sessionId))).map((s) => ({
    host: 'thor' as const, sessionId: String(s.sessionId), pid: Number(s.pid) || 0, name: String(s.name ?? ''), cwd: String(s.cwd ?? ''),
    status: String(s.status ?? ''), via: Number(s.winSession) > 0 ? 'console' as const : 'ssh' as const,
  }))
}

// --------------------------------------------------------------- odin ----

async function parentOf(pid: number): Promise<number> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0
  } catch {
    return 0
  }
}

/** Every tmux server of this user: its socket path and pane pid to pane id. Valkyrie's own server is left out. */
async function tmuxPanes(): Promise<{ socket: string; byPid: Map<number, string> }[]> {
  const dir = `/tmp/tmux-${process.getuid?.() ?? 1000}`
  let names: string[] = []
  try { names = await fsp.readdir(dir) } catch { return [] }
  const out: { socket: string; byPid: Map<number, string> }[] = []
  for (const n of names) {
    if (n === VALKYRIE_SOCKET) continue
    const socket = path.join(dir, n)
    try {
      const { stdout } = await exec(TMUX_BIN, ['-S', socket, 'list-panes', '-a', '-F', '#{pane_pid} #{pane_id}'], { timeout: 4_000 })
      const byPid = new Map<number, string>()
      for (const l of stdout.split('\n')) {
        const [p, id] = l.trim().split(' ')
        if (Number(p) > 0 && /^%\d+$/.test(id ?? '')) byPid.set(Number(p), id)
      }
      out.push({ socket, byPid })
    } catch { /* a dead socket */ }
  }
  return out
}

async function odinSessions(): Promise<OutsideSession[]> {
  let names: string[] = []
  try { names = await fsp.readdir(ODIN_REGISTRY) } catch { return [] }
  const regs: Record<string, unknown>[] = []
  for (const n of names.filter((x) => /^\d+\.json$/.test(x))) {
    try {
      const r = JSON.parse(await fsp.readFile(path.join(ODIN_REGISTRY, n), 'utf8')) as Record<string, unknown>
      if (!UUID_RE.test(String(r.sessionId)) || !Number.isInteger(r.pid)) continue
      if (r.entrypoint && r.entrypoint !== 'cli') continue
      // a Valkyrie pane's Claude: the pane tools reach it
      if (typeof r.tmux === 'string' && r.tmux.startsWith('vk-')) continue
      if (!(await fsp.stat(`/proc/${r.pid as number}`).then(() => true, () => false))) continue
      regs.push(r)
    } catch { /* being rewritten */ }
  }
  if (!regs.length) return []
  const servers = await tmuxPanes()
  const out: OutsideSession[] = []
  for (const r of regs) {
    const pid = r.pid as number
    let tmux: OutsideSession['tmux']
    let p = pid
    for (let i = 0; i < 8 && p > 1 && !tmux; i++) {
      for (const s of servers) {
        const pane = s.byPid.get(p)
        if (pane) { tmux = { socket: s.socket, pane }; break }
      }
      p = await parentOf(p)
    }
    out.push({
      host: 'odin', sessionId: String(r.sessionId), pid, name: String(r.name ?? ''), cwd: String(r.cwd ?? ''), status: String(r.status ?? ''),
      via: tmux ? 'tmux' : 'none', ...(tmux ? { tmux } : {}),
    })
  }
  return out
}

async function tmuxOn(o: OutsideSession, args: string[]): Promise<string> {
  if (!o.tmux) throw new RavenToolError('that session is in no tmux')
  const { stdout } = await exec(TMUX_BIN, ['-S', o.tmux.socket, ...args], { timeout: 6_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

// ------------------------------------------------------------- the io ----

const NOT_TYPEABLE = 'runs in a terminal on odin with no tmux, and Linux refuses typed input into another terminal: Raven can read it (session_read) but not type into it'

const real: OutsideIo = {
  thorSessions,
  odinSessions,
  screen: async (o) => {
    if (o.via === 'console') {
      const r = await thorHands('POST', '/console/screen', { pid: o.pid })
      if (!r || r.status !== 200 || typeof r.body.screen !== 'string') handsError(r, 'reading its screen')
      return r.body.screen as string
    }
    if (o.via === 'ssh') {
      const r = await sshHands(['screen', String(o.pid)])
      if (r.ok !== true || typeof r.screen !== 'string') throw new RavenToolError(`reading its screen: ${String(r.error ?? 'no answer')}`)
      return r.screen
    }
    if (o.via === 'tmux') return tmuxOn(o, ['capture-pane', '-p', '-J', '-t', o.tmux!.pane])
    throw new RavenToolError(`${o.name || o.sessionId} ${NOT_TYPEABLE}`)
  },
  type: async (o, text) => {
    if (o.via === 'console') {
      const r = await thorHands('POST', '/console/type', { pid: o.pid, text, enter: true }, 60_000)
      if (!r || r.status !== 200) handsError(r, 'typing')
      return
    }
    if (o.via === 'ssh') {
      const r = await sshHands(['type', String(o.pid), Buffer.from(text, 'utf8').toString('base64')])
      if (r.ok !== true) throw new RavenToolError(`typing: ${String(r.error ?? 'no answer')}`)
      await new Promise((res) => setTimeout(res, 400))
      const e = await sshHands(['keys', String(o.pid), 'enter'])
      if (e.ok !== true) throw new RavenToolError(`pressing Enter: ${String(e.error ?? 'no answer')}`)
      return
    }
    if (o.via === 'tmux') {
      // the pane rules of terminal/tmux.ts typeLine: one bracketed paste past 800 bytes, else keys, then Enter on its own
      const pane = o.tmux!.pane
      if (Buffer.byteLength(text, 'utf8') > 800) {
        const buf = `raven-${Date.now().toString(36)}`
        await tmuxOn(o, ['set-buffer', '-b', buf, '--', text.endsWith(';') ? `${text.slice(0, -1)}\\;` : text])
        await tmuxOn(o, ['paste-buffer', '-p', '-d', '-b', buf, '-t', pane])
      } else {
        await tmuxOn(o, ['send-keys', '-t', pane, '-l', '--', text.endsWith(';') ? `${text.slice(0, -1)}\\;` : text])
      }
      await new Promise((res) => setTimeout(res, 400))
      await tmuxOn(o, ['send-keys', '-t', pane, 'Enter'])
      return
    }
    throw new RavenToolError(`${o.name || o.sessionId} ${NOT_TYPEABLE}`)
  },
  keys: async (o, keys) => {
    if (o.via === 'console') {
      const r = await thorHands('POST', '/console/keys', { pid: o.pid, keys: keys.join(',') })
      if (!r || r.status !== 200) handsError(r, 'pressing keys')
      return
    }
    if (o.via === 'ssh') {
      const r = await sshHands(['keys', String(o.pid), keys.join(',')])
      if (r.ok !== true) throw new RavenToolError(`pressing keys: ${String(r.error ?? 'no answer')}`)
      return
    }
    if (o.via === 'tmux') {
      for (const k of tmuxKeys(keys)) {
        await tmuxOn(o, k.length === 1 ? ['send-keys', '-t', o.tmux!.pane, '-l', '--', k] : ['send-keys', '-t', o.tmux!.pane, k])
      }
      return
    }
    throw new RavenToolError(`${o.name || o.sessionId} ${NOT_TYPEABLE}`)
  },
}

export const outsideIo: OutsideIo = { ...real }

/** Swap parts (the smoke test); null puts the real ones back. */
export function setOutsideIo(patch: Partial<OutsideIo> | null): void {
  Object.assign(outsideIo, real, patch ?? {})
  listCache = null
}

// ----------------------------------------------------------- the list ----

let listCache: { at: number; thor: OutsideSession[] | null; odin: OutsideSession[] } | null = null

/** Every outside session on thor and odin, held 10 s. thor null: its launcher did not answer. */
export async function outsideSessions(fresh = false): Promise<{ thor: OutsideSession[] | null; odin: OutsideSession[] }> {
  if (!fresh && listCache && Date.now() - listCache.at < 10_000) return listCache
  const [thor, odin] = await Promise.all([outsideIo.thorSessions().catch(() => null), outsideIo.odinSessions().catch(() => [] as OutsideSession[])])
  listCache = { at: Date.now(), thor, odin }
  return listCache
}

/** The outside session running a conversation, on any host; null when none does (or its host is not answering). */
export async function findOutside(sessionId: string): Promise<OutsideSession | null> {
  const find = (l: { thor: OutsideSession[] | null; odin: OutsideSession[] }) => [...(l.thor ?? []), ...l.odin].find((o) => o.sessionId === sessionId) ?? null
  return find(await outsideSessions()) ?? find(await outsideSessions(true))
}

export const outsideLabel = (o: OutsideSession): string => o.name || path.basename(o.cwd.replace(/\\/g, '/')) || o.sessionId.slice(0, 8)

export const viaWords = (o: OutsideSession): string => (o.via === 'console' ? 'a window on thor'
  : o.via === 'ssh' ? 'an ssh login on thor'
    : o.via === 'tmux' ? 'a tmux pane on odin outside Valkyrie' : 'a bare terminal on odin (read-only)')
