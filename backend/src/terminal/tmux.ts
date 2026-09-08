import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const exec = promisify(execFile)

// Durable terminal sessions, so Claude Code can be driven from the phone.
//
// The pty a browser talks to is NOT the session: it is a short-lived
// `tmux attach` client. The session itself lives in a tmux server on its own
// socket (-L valkyrie) owned by valkyrie-term.service. That split is what makes
// this usable rather than a demo:
//
//   - Restarting this API (every deploy does) drops the attach clients and
//     touches nothing that is running. In-process ptys die with the process,
//     and losing a session mid-thought to a deploy is the exact failure this
//     is meant to avoid.
//   - Reattaching redraws from tmux's own buffer, so there is no scrollback to
//     capture, cap, or replay at the wrong offset.
//
// The tmux server MUST be started by its own unit rather than by us: systemd
// kills a service's whole cgroup, so a server this process spawned would be
// killed by the next API restart even though tmux daemonises itself.
//
// Nothing a client sends ever becomes a path. A request carries a session NAME
// minted here or a target KEY from the table below, and the directory is
// resolved on this side.

export const TMUX_BIN = process.env.VALKYRIE_TMUX_BIN || '/usr/bin/tmux'
const SOCKET = process.env.VALKYRIE_TMUX_SOCKET || 'valkyrie'
const CONF = process.env.VALKYRIE_TMUX_CONF
  || path.join(homedir(), '.config', 'valkyrie', 'tmux.conf')
const TERM_UNIT = 'valkyrie-term.service'
const SOCKET_PATH = path.join(
  process.env.TMUX_TMPDIR || '/tmp',
  `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`,
  SOCKET,
)

export const MAX_SESSIONS = 12
// Session names are minted here and are the only name a client may hand back,
// so they are deliberately boring. Anything else on this socket is neither
// listed nor attachable through the API.
export const SESSION_NAME_RE = /^vk-[0-9a-f]{10}$/

export type TermMode = 'new' | 'continue' | 'resume' | 'shell'
export const MODES: TermMode[] = ['new', 'continue', 'resume', 'shell']

function baseArgs(): string[] {
  const a = ['-L', SOCKET]
  // -f on a missing file is a hard error, and the server reads it only at
  // start anyway, so this stays optional rather than assumed.
  if (existsSync(CONF)) a.push('-f', CONF)
  return a
}

async function tmux(args: string[], timeoutMs = 8_000): Promise<string> {
  const { stdout } = await exec(TMUX_BIN, [...baseArgs(), ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

// argv for the pty a websocket drives. `=` pins the target to an exact name:
// bare `-t foo` prefix-matches, which would let a truncated name attach to a
// neighbouring session.
export function attachArgs(name: string): string[] {
  return [...baseArgs(), 'attach-session', '-t', `=${name}`]
}

export function tmuxVersion(): Promise<string> {
  return exec(TMUX_BIN, ['-V'], { timeout: 4_000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
}

export function serverUp(): boolean {
  return existsSync(SOCKET_PATH)
}

let warnedColdStart = false

export async function ensureServer(): Promise<void> {
  if (serverUp()) return
  try {
    await exec('systemctl', ['--user', 'start', TERM_UNIT], { timeout: 10_000 })
  } catch (err) {
    console.warn(`[terminal] could not start ${TERM_UNIT}:`, (err as Error).message)
  }
  for (let i = 0; i < 30 && !serverUp(); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (serverUp()) return
  // Last resort. Sessions on a server we started ourselves die with this
  // process, which is the one thing the unit exists to prevent — so say it out
  // loud instead of degrading quietly.
  if (!warnedColdStart) {
    console.warn(`[terminal] ${TERM_UNIT} never came up; starting tmux inline — sessions will NOT survive an API restart`)
    warnedColdStart = true
  }
  await tmux(['start-server'])
  await tmux(['set-option', '-g', 'exit-empty', 'off']).catch(() => {})
}

// ------------------------------------------------------------- sessions ----

// Unit separator, written as an escape rather than the literal byte so no
// editor or copy-paste can quietly eat it. A label or a path may contain
// anything printable, tabs and pipes included, so the delimiter has to be a
// byte a human never types.
const SEP = '\u001f'
const FORMAT = [
  '#{session_name}',
  '#{session_created}',
  '#{session_activity}',
  '#{session_attached}',
  '#{@vk_label}',
  '#{@vk_cwd}',
  '#{@vk_mode}',
  '#{pane_current_command}',
  '#{window_width}x#{window_height}',
].join(SEP)

export type TermSession = {
  name: string
  label: string
  mode: string
  cwd: string
  createdAt: number
  activityAt: number
  clients: number
  command: string
  size: string
}

export async function listSessions(): Promise<TermSession[]> {
  if (!serverUp()) return []
  let out: string
  try {
    out = await tmux(['list-sessions', '-F', FORMAT])
  } catch {
    // No server, or a server with no sessions. Both are "nothing open", not
    // an error the page should show.
    return []
  }
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const f = line.split(SEP)
      return {
        name: f[0] ?? '',
        label: f[4] || f[0] || '',
        mode: f[6] || 'shell',
        cwd: f[5] || '',
        createdAt: (Number(f[1]) || 0) * 1000,
        activityAt: (Number(f[2]) || 0) * 1000,
        clients: Number(f[3]) || 0,
        command: f[7] || '',
        size: f[8] || '',
      }
    })
    .filter((s) => SESSION_NAME_RE.test(s.name))
    .sort((a, b) => b.activityAt - a.activityAt)
}

export async function hasSession(name: string): Promise<boolean> {
  if (!SESSION_NAME_RE.test(name)) return false
  try {
    await tmux(['has-session', '-t', `=${name}`], 5_000)
    return true
  } catch {
    return false
  }
}

export async function killSession(name: string): Promise<boolean> {
  if (!SESSION_NAME_RE.test(name)) return false
  try {
    await tmux(['kill-session', '-t', `=${name}`], 5_000)
    return true
  } catch {
    return false
  }
}

// -------------------------------------------------------------- targets ----

export type Target = { key: string; label: string; path: string }

// The whole allow-list. A directory that is not here cannot be opened from the
// phone at all, which is the point: the client picks a key, never a path.
const CANDIDATES: Target[] = [
  { key: 'valkyrie', label: 'valkyrie', path: '/home/brendon/valkyrie' },
  { key: 'msp-platform', label: 'msp-platform', path: '/home/brendon/msp-platform' },
  { key: 'slop-factory', label: 'slop-factory', path: '/home/brendon/slop-factory' },
  { key: 'trade-bot', label: 'trade-bot', path: '/home/brendon/trade-bot' },
  { key: 'raven', label: 'raven', path: '/home/brendon/raven' },
  { key: 'projectb-ai', label: 'projectb-ai', path: '/home/brendon/projectb-ai' },
  { key: 'infra', label: 'infra', path: '/home/brendon/infra' },
  { key: 'side-proj', label: 'side-proj', path: '/home/brendon/side-proj' },
  { key: 'home', label: 'home', path: '/home/brendon' },
]

export function targets(): Target[] {
  return CANDIDATES.filter((t) => {
    try { return statSync(t.path).isDirectory() } catch { return false }
  })
}

export function targetFor(key: string): Target | null {
  return targets().find((t) => t.key === key) ?? null
}

// A resumed session reopens where it ran, and that path comes out of its own
// transcript rather than off the wire. Keep it inside the home tree so a
// transcript written by something else still cannot point us anywhere odd.
export function isAllowedCwd(dir: string): boolean {
  const home = homedir()
  const resolved = path.resolve(dir)
  if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) return false
  try { return statSync(resolved).isDirectory() } catch { return false }
}

// --------------------------------------------------------------- claude ----

const CLAUDE_CANDIDATES = [
  process.env.VALKYRIE_CLAUDE_BIN,
  path.join(homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/usr/bin/claude',
].filter((p): p is string => Boolean(p))

// Resolved to an absolute path on purpose: this box's login shell does not put
// ~/.local/bin on PATH, so `claude` alone resolves under an interactive
// session and nowhere else. A session that dies instantly with "command not
// found" is not worth the guess.
export function claudeBin(): string | null {
  return CLAUDE_CANDIDATES.find((p) => existsSync(p)) ?? null
}

// --------------------------------------------------------------- create ----

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export type CreateOpts = {
  mode: TermMode
  cwd: string
  label: string
  resumeId?: string
  cols?: number
  rows?: number
}

async function setOpt(name: string, option: string, value: string): Promise<void> {
  try {
    await tmux(['set-option', '-t', name, option, value], 5_000)
  } catch (err) {
    // Not fatal — the session runs fine without a label — but it is a bug
    // rather than a condition, so it gets said out loud.
    console.warn(`[terminal] could not set ${option} on ${name}:`, (err as Error).message)
  }
}

export async function createSession(o: CreateOpts): Promise<string> {
  await ensureServer()
  const open = await listSessions()
  if (open.length >= MAX_SESSIONS) {
    throw Object.assign(
      new Error(`${open.length} sessions already open (max ${MAX_SESSIONS}) — close one first`),
      { status: 409 },
    )
  }

  const name = `vk-${randomBytes(5).toString('hex')}`
  const cols = clamp(o.cols, 20, 400, 80)
  const rows = clamp(o.rows, 8, 200, 24)

  // -x/-y size the window now. Without them a detached session starts 80x24
  // and Claude Code paints its first frame to that, which on a phone means a
  // wrapped mess until the first resize lands.
  const args = ['new-session', '-d', '-s', name, '-c', o.cwd, '-x', String(cols), '-y', String(rows)]

  if (o.mode !== 'shell') {
    const bin = claudeBin()
    if (!bin) throw Object.assign(new Error('claude is not installed on this host'), { status: 503 })
    const cli = [shq(bin)]
    if (o.mode === 'continue') cli.push('--continue')
    if (o.mode === 'resume') {
      if (!o.resumeId) throw Object.assign(new Error('resume needs a session id'), { status: 400 })
      cli.push('--resume', shq(o.resumeId))
    }
    // A login shell, then exec: claude picks up the profile PATH (git, node, rg
    // all live there) and still owns the pane, so the session ends when claude
    // ends rather than dropping to a stray shell nobody is watching.
    args.push('--', 'bash', '-lc', `exec ${cli.join(' ')}`)
  }

  await tmux(args, 20_000)

  // Metadata rides on the session as tmux user options, so it dies with the
  // session. A sidecar file would outlive it and go stale.
  //
  // Bare name, no `=` prefix: set-option takes a target-PANE, so `-t =vk-...`
  // is not an exact-match session target there, it is a malformed pane spec,
  // and tmux answers "no such session". Prefix matching is harmless here
  // anyway since every name is the same length, so none can prefix another.
  // This failed silently behind a swallowed catch at first, and the only
  // symptom was a session strip full of raw ids.
  await Promise.all([
    setOpt(name, '@vk_label', o.label.slice(0, 60)),
    setOpt(name, '@vk_cwd', o.cwd),
    setOpt(name, '@vk_mode', o.mode),
  ])

  return name
}
