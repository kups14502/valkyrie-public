import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const exec = promisify(execFile)

// Durable terminal sessions, so Claude Code on THOR can be driven from the phone.
//
// The session Brendon sees is Claude Code running on thor (his Windows
// workstation) in one of his own directories: personal, work, work2. This
// box holds none of that work. What lives here is a tmux session whose pane is
// an SSH client into thor, and tmux is what makes the phone usable rather than
// a demo:
//
//   - The pty a browser talks to is NOT the session: it is a short-lived
//     `tmux attach` client. Locking the phone, closing the tab, or restarting
//     this API (every deploy does) drops the attach client and touches nothing
//     that is running. In-process ptys die with the process, and losing a
//     session mid-thought to a deploy is the exact failure this is meant to
//     avoid.
//   - Reattaching redraws from tmux's own buffer, so there is no scrollback to
//     capture, cap, or replay at the wrong offset.
//   - The SSH client sits inside the pane, so a phone that drops off wifi
//     detaches from tmux and the SSH session to thor stays up. Claude never
//     notices.
//
// The tmux server MUST be started by its own unit rather than by us: systemd
// kills a service's whole cgroup, so a server this process spawned would be
// killed by the next API restart even though tmux daemonises itself.
//
// Nothing a client sends ever becomes a path. A request carries a session NAME
// minted here, a launch-target KEY from thor's own list, or a session id, and
// the directory is resolved on thor by Remote-Session.ps1 out of thor's local
// launch-targets.json. This box never learns the path at all.
//
// The first cut of this ran Claude on odin in odin's own checkouts. That was
// the wrong machine: Brendon's work is on thor, and a "valkyrie" session on
// odin is not a session he ever opens by hand.

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

// The far end. THOR_LAUNCHER_HOST is already thor's tailnet address in .env
// for the launcher proxy, so the SSH hop follows it unless told otherwise.
export const SSH_BIN = process.env.VALKYRIE_SSH_BIN || '/usr/bin/ssh'
const THOR_USER = process.env.THOR_SSH_USER || 'brendon'
const THOR_HOST = process.env.THOR_SSH_HOST || process.env.THOR_LAUNCHER_HOST || '100.118.7.57'
// Forward slashes on purpose: this string is parsed by PowerShell on thor (the
// sshd default shell there) and -File accepts either separator, while a
// backslash would have to survive two more quoting layers to get there.
const REMOTE_SCRIPT = process.env.THOR_REMOTE_SCRIPT || 'C:/Thor/tools/session-board/Remote-Session.ps1'

export const remoteLabel = (): string => `${THOR_USER}@${THOR_HOST}`

export const MAX_SESSIONS = 12
// Session names are minted here and are the only name a client may hand back,
// so they are deliberately boring. Anything else on this socket is neither
// listed nor attachable through the API.
export const SESSION_NAME_RE = /^vk-[0-9a-f]{10}$/

// No `continue`. Claude's --continue picks the newest conversation in the cwd,
// and on thor that is usually the Obsidian hook's summariser run (92% of
// transcripts there), not Brendon's. Resume is by id, from the session board.
export type TermMode = 'new' | 'resume' | 'shell'
export const MODES: TermMode[] = ['new', 'resume', 'shell']

// Same shape the launcher agent enforces for /launch-new, so a key that passes
// here is one thor will at least look up.
export const TARGET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

export function sshPresent(): boolean {
  return existsSync(SSH_BIN)
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
  await tmux(['set-option', '-g', 'remain-on-exit', 'failed']).catch(() => {})
}

// ------------------------------------------------------------- sessions ----

// Unit separator, written as an escape rather than the literal byte so no
// editor or copy-paste can quietly eat it. A label may contain anything
// printable, tabs and pipes included, so the delimiter has to be a byte a human
// never types.
const SEP = '\u001f'
const FORMAT = [
  '#{session_name}',
  '#{session_created}',
  '#{session_activity}',
  '#{session_attached}',
  '#{@vk_label}',
  '#{@vk_host}',
  '#{@vk_mode}',
  '#{@vk_target}',
  '#{@vk_sid}',
  '#{pane_dead}',
  '#{window_width}x#{window_height}',
].join(SEP)

export type TermSession = {
  name: string
  label: string
  mode: string
  host: string
  // The launch-target key for new/shell sessions, the session id for a resume.
  target: string
  // The conversation running in this pane, for new and resume alike. A new
  // session is TOLD its id (claude --session-id) rather than asked for one
  // afterwards, so the chip can carry the session's own title from the first
  // poll instead of the target key it was opened with. Empty for a shell, and
  // for any terminal opened before this existed.
  sessionId: string
  createdAt: number
  activityAt: number
  clients: number
  // remain-on-exit kept the pane after its command failed: the last screen is
  // still there to read, and nothing is running behind it.
  dead: boolean
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
        host: f[5] || 'thor',
        mode: f[6] || 'shell',
        target: f[7] || '',
        sessionId: f[8] || '',
        createdAt: (Number(f[1]) || 0) * 1000,
        activityAt: (Number(f[2]) || 0) * 1000,
        clients: Number(f[3]) || 0,
        dead: f[9] === '1',
        size: f[10] || '',
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

// Kills the tmux session, which ends the SSH client in its pane. sshd on thor
// then tears down that login's ConPTY and the process tree under it, so this
// is also how a Claude session started from the phone is stopped. The
// transcript on thor is untouched and the conversation resumes anywhere by id.
export async function killSession(name: string): Promise<boolean> {
  if (!SESSION_NAME_RE.test(name)) return false
  try {
    await tmux(['kill-session', '-t', `=${name}`], 5_000)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------ scrollback ----

// Scrolling has to be done by tmux, and only tmux.
//
// The history is in tmux's pane (history-limit 20000), not in the browser's
// terminal: tmux repaints just the visible pane, so xterm holds barely a
// screenful of its own and a swipe on the phone scrolled nothing at all.
//
// Nor can the swipe be forwarded as wheel events. tmux's `mouse on` would
// handle those, but only while nothing inside the pane has asked for the
// mouse, and Claude Code's TUI asks: tmux then passes the events straight
// through to it and the view never moves. Driving copy-mode from this side is
// what works whatever happens to be running in there.
//
// Positive lines scroll toward older output, which is the direction a finger
// dragging DOWN expects.
export async function scrollPane(name: string, lines: number): Promise<void> {
  if (!SESSION_NAME_RE.test(name)) return
  const n = Math.min(500, Math.abs(Math.trunc(lines)))
  if (!n) return
  // Entering copy-mode while already in it is a no-op, which is what makes a
  // stream of swipe deltas cheap. Bare name, not `=name`: these take a
  // target-PANE, where `=` is not exact-match syntax but a malformed spec.
  await tmux(['copy-mode', '-t', name], 5_000).catch(() => {})
  await tmux(
    ['send-keys', '-t', name, '-X', '-N', String(n), lines < 0 ? 'scroll-down' : 'scroll-up'],
    5_000,
  ).catch(() => {})
}

// Leave copy-mode, so the next keystroke reaches the application instead of
// being read as a copy-mode command. Errors when the pane is not in a mode,
// which is why this is fire-and-forget.
export async function endScroll(name: string): Promise<void> {
  if (!SESSION_NAME_RE.test(name)) return
  await tmux(['send-keys', '-t', name, '-X', 'cancel'], 5_000).catch(() => {})
}

// --------------------------------------------------------------- create ----

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

export type CreateOpts = {
  mode: TermMode
  // A launch-target key (new, shell) — validated against TARGET_RE by the route.
  target?: string
  // A conversation id (resume) — validated against UUID_RE by the route.
  resumeId?: string
  // The id a NEW session is told to use — minted by the route, never sent by a
  // client. Same shape, so the same regex guards it.
  newId?: string
  label: string
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

// The command sshd runs on thor. The whole string is one PowerShell command
// line (PowerShell is thor's sshd default shell), and every variable part of
// it has already been matched against a regex that admits only [a-z0-9-] or a
// uuid, so there is nothing here for a shell on either side to interpret.
export function remoteCommand(o: Pick<CreateOpts, 'mode' | 'target' | 'resumeId' | 'newId'>): string {
  const parts = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REMOTE_SCRIPT, '-Mode', o.mode]
  if (o.mode === 'resume') {
    if (!o.resumeId || !UUID_RE.test(o.resumeId)) throw Object.assign(new Error('resume needs a session id'), { status: 400 })
    parts.push('-SessionId', o.resumeId)
  } else {
    if (!o.target || !TARGET_RE.test(o.target)) throw Object.assign(new Error('target must be a launch-target key'), { status: 400 })
    parts.push('-Target', o.target)
    // `claude --session-id` on the far end. A shell has no conversation, and a
    // thor that still runs the older script ignores the argument rather than
    // failing: the parameter has always existed there for resume.
    if (o.mode === 'new' && o.newId && UUID_RE.test(o.newId)) parts.push('-SessionId', o.newId)
  }
  return parts.join(' ')
}

// argv for the pane. `-t` forces the pty the TUI needs; tmux is already
// giving ssh one, so a plain -t suffices. BatchMode makes a missing key fail
// with "Permission denied" instead of sitting at a password prompt nobody can
// see, and remain-on-exit=failed keeps that line on screen.
//
// That last part only covers failures on THIS side of the connection. Once a
// pty is allocated, the Windows OpenSSH server runs the command under a ConPTY
// and reports exit 0 to the client however the command ended, so nothing thor
// does can make this ssh exit non-zero. Measured: the same failing command
// gives 1 with no pty and 0 with one. Remote failures therefore have to keep
// their own pane alive, which is what Remote-Session.ps1's Hold-Pane does.
//
// ConnectTimeout is the one that matters day to day: thor is a workstation and
// it sleeps. Without it a connection that never opens sits in TCP SYN retries
// for the kernel default (about two minutes), and BatchMode plus
// LogLevel=ERROR mean the pane prints nothing at all while it waits, which on
// a phone is indistinguishable from Claude thinking. Ten seconds gets a
// readable "Connection timed out" and a dead pane instead.
//
// The keepalives are the other half: a phone that vanishes detaches from tmux
// and never touches this SSH connection, so an established connection only
// ever dies when the tailnet does, and this is how sshd finds out.
export function sshArgs(remote: string): string[] {
  return [
    SSH_BIN,
    '-t',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    remoteLabel(),
    remote,
  ]
}

export async function createSession(o: CreateOpts): Promise<string> {
  if (!sshPresent()) throw Object.assign(new Error(`ssh is not installed at ${SSH_BIN}`), { status: 503 })
  await ensureServer()
  const open = await listSessions()
  if (open.length >= MAX_SESSIONS) {
    throw Object.assign(
      new Error(`${open.length} sessions already open (max ${MAX_SESSIONS}) — close one first`),
      { status: 409 },
    )
  }

  // Validates before anything is spawned.
  const remote = remoteCommand(o)

  const name = `vk-${randomBytes(5).toString('hex')}`
  const cols = clamp(o.cols, 20, 400, 80)
  const rows = clamp(o.rows, 8, 200, 24)

  // -x/-y size the window now. Without them a detached session starts 80x24
  // and Claude Code paints its first frame to that, which on a phone means a
  // wrapped mess until the first resize lands. -c is this box's home purely
  // because tmux needs a cwd for the pane; nothing in it runs here.
  const args = [
    'new-session', '-d', '-s', name, '-c', homedir(), '-x', String(cols), '-y', String(rows),
    '--', ...sshArgs(remote),
  ]

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
    setOpt(name, '@vk_host', 'thor'),
    setOpt(name, '@vk_mode', o.mode),
    setOpt(name, '@vk_target', o.mode === 'resume' ? (o.resumeId ?? '') : (o.target ?? '')),
    setOpt(name, '@vk_sid', o.mode === 'resume' ? (o.resumeId ?? '') : (o.mode === 'new' ? (o.newId ?? '') : '')),
  ])

  return name
}
