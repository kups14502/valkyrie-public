import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const exec = promisify(execFile)

// Durable terminal sessions, so Claude Code on THOR can be driven from the phone.
//
// The session Brendon sees is Claude Code running on thor (his Windows
// workstation) in one of his own directories: personal and work. This
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
//
// Odin is back as a BACKUP host, never the default: when thor is asleep or
// unreachable, a pane can run Claude Code on this box instead (host 'odin'
// below). Same rule as thor: the client sends a target KEY, and the directory
// comes from a private file on this box that no request can write.

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

// Where a pane's program runs. 'thor' is the pane's ssh into thor, as it has
// always been. 'odin' runs the program on this box itself.
export type TermHost = 'thor' | 'odin'
export const TERM_HOSTS: TermHost[] = ['thor', 'odin']

// ----------------------------------------------------------------- odin ----

// The odin launch targets: [{ "key": "...", "label": "...", "dir": "..." }].
// Private to this box and never committed, like thor's launch-targets.json.
// Without the file there is one target, the home directory.
const ODIN_TARGETS_PATH = process.env.VALKYRIE_ODIN_TARGETS
  || path.join(homedir(), '.config', 'valkyrie', 'odin-targets.json')
// The native installer's link, by absolute path: the tmux server's PATH comes
// from the systemd user manager, which need not include ~/.local/bin. Not
// resolved through the link, so `claude update` applies to the next pane.
export const ODIN_CLAUDE = process.env.VALKYRIE_ODIN_CLAUDE
  || path.join(homedir(), '.local', 'bin', 'claude')

export type OdinTarget = { key: string; label: string; dir: string }
export type OdinTargetList = {
  targets: OdinTarget[]
  // 'invalid' is a file that does not parse to a list: the default target
  // stands in, so the backup host still opens, and the page says why.
  source: 'config' | 'default' | 'invalid'
}

const ODIN_LABEL_MAX = 40
let odinParsed: { mtimeMs: number; list: OdinTarget[] | null } | null = null

const expandHome = (p: string): string =>
  p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// null when the file does not parse to a list. Bad entries are dropped one by
// one, each said out loud, so one typo does not take the rest down.
function parseOdinTargets(raw: string): OdinTarget[] | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.warn(`[terminal] ${ODIN_TARGETS_PATH} is not JSON:`, (err as Error).message)
    return null
  }
  const items = Array.isArray(data) ? data : (data as { targets?: unknown } | null)?.targets
  if (!Array.isArray(items)) {
    console.warn(`[terminal] ${ODIN_TARGETS_PATH} is not a list of targets`)
    return null
  }
  const seen = new Set<string>()
  const out: OdinTarget[] = []
  for (const item of items) {
    const r = (item ?? {}) as Record<string, unknown>
    const key = typeof r.key === 'string' ? r.key : ''
    const dir = typeof r.dir === 'string' ? expandHome(r.dir.trim()) : ''
    // eslint-disable-next-line no-control-regex
    const label = (typeof r.label === 'string' ? r.label : key).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!TARGET_RE.test(key) || seen.has(key)) {
      console.warn(`[terminal] odin target skipped: bad or repeated key ${JSON.stringify(key)}`)
      continue
    }
    if (!dir || !path.isAbsolute(dir)) {
      console.warn(`[terminal] odin target ${key} skipped: dir must be an absolute path`)
      continue
    }
    seen.add(key)
    out.push({ key, label: (label || key).slice(0, ODIN_LABEL_MAX), dir: path.normalize(dir) })
  }
  return out
}

// Read on every call (one stat, and a parse only when the file changed), so an
// edit to the file applies to the next open without a restart. A directory that
// has gone missing drops out of the list rather than failing at open.
export function odinTargets(): OdinTargetList {
  const fallback = (): OdinTarget[] => [{ key: 'home', label: 'Odin home', dir: homedir() }]
  let mtimeMs: number
  try {
    mtimeMs = statSync(ODIN_TARGETS_PATH).mtimeMs
  } catch {
    return { targets: fallback(), source: 'default' }
  }
  if (!odinParsed || odinParsed.mtimeMs !== mtimeMs) {
    let raw = ''
    try {
      raw = readFileSync(ODIN_TARGETS_PATH, 'utf8')
    } catch (err) {
      console.warn(`[terminal] could not read ${ODIN_TARGETS_PATH}:`, (err as Error).message)
    }
    odinParsed = { mtimeMs, list: raw ? parseOdinTargets(raw) : null }
  }
  if (!odinParsed.list) return { targets: fallback(), source: 'invalid' }
  return { targets: odinParsed.list.filter((t) => isDir(t.dir)), source: 'config' }
}

export function findOdinTarget(key: string): OdinTarget | null {
  if (!TARGET_RE.test(key)) return null
  return odinTargets().targets.find((t) => t.key === key) ?? null
}

export function odinClaudeReady(): boolean {
  try {
    accessSync(ODIN_CLAUDE, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// The pane's program on odin goes through this fixed script, and every
// variable part (the directory, the program and its arguments) arrives as a
// positional argument, never inside the script text. It sets what
// Remote-Session.ps1 sets on thor (fullscreen forced, mouse clicks off, the
// wheel on), puts ~/.local/bin on PATH for Claude's own tools, and treats a
// quit (0, or 130 for Ctrl-C) as a clean finish so the pane closes. Any other
// exit resets the terminal modes a dead TUI leaves on, prints one line, and
// exits non-zero, so remain-on-exit=failed keeps that line on screen.
const ODIN_WRAP = [
  'cd -- "$1" || { printf "\\n  odin: cannot open %s\\n" "$1"; exit 2; }',
  'shift',
  'export CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
  'unset CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN CLAUDE_CODE_DISABLE_MOUSE',
  'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac',
  // The account switcher's live store (lib/accountSwitch.ts). Only the
  // credential moves: memory, hooks and transcripts stay in ~/.claude. Until
  // the switcher has written the store, panes keep ~/.claude's own sign-in.
  '[ -s "$HOME/.config/claude-switch/live/.credentials.json" ] && { CLAUDE_SECURESTORAGE_CONFIG_DIR="$HOME/.config/claude-switch/live"; export CLAUDE_SECURESTORAGE_CONFIG_DIR; }',
  'printf "odin  %s\\n" "$PWD"',
  '"$@"',
  's=$?',
  'case $s in 0|130) exit 0 ;; esac',
  'printf "\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?25h\\033[?1049l"',
  'printf "\\n  odin: %s exited with %s\\n" "${1##*/}" "$s"',
  'exit "$s"',
].join('\n')

const SH_BIN = '/bin/sh'

function loginShell(): string {
  try {
    const s = userInfo().shell
    if (s && path.isAbsolute(s) && existsSync(s)) return s
  } catch { /* no passwd entry */ }
  return '/bin/bash'
}

// The pane on odin: its directory and argv. Same validation as remoteCommand,
// narrower scope: a new Claude or a shell in an odin target. Projects, agent
// runs and the desk stay on thor, where their files and MCP wiring live, and a
// resume would need the transcript's own folder, which only thor tracks.
export function odinCommand(o: Pick<CreateOpts, 'mode' | 'target' | 'resumeId' | 'newId' | 'projectId' | 'runId' | 'desk'>): { dir: string; argv: string[] } {
  if (o.mode === 'resume' || o.resumeId) throw Object.assign(new Error('odin opens new sessions and shells, not resumes'), { status: 400 })
  if (o.projectId || o.runId || o.desk) throw Object.assign(new Error('projects, agent runs and new-project sessions start on thor'), { status: 400 })
  if (!o.target || !TARGET_RE.test(o.target)) throw Object.assign(new Error('target must be an odin target key'), { status: 400 })
  const t = findOdinTarget(o.target)
  if (!t) throw Object.assign(new Error(`no odin target named '${o.target}'`), { status: 400 })
  let program: string[]
  if (o.mode === 'shell') {
    program = [loginShell(), '-l']
  } else {
    if (!odinClaudeReady()) throw Object.assign(new Error(`claude is not installed at ${ODIN_CLAUDE}`), { status: 503 })
    program = [ODIN_CLAUDE]
    if (o.newId && UUID_RE.test(o.newId)) program.push('--session-id', o.newId)
  }
  return { dir: t.dir, argv: [SH_BIN, '-c', ODIN_WRAP, 'valkyrie-odin', t.dir, ...program] }
}

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
  '#{pane_dead_status}',
  // Last on purpose: every index above keeps its meaning, and a session made
  // before projects existed simply reads back an empty field here.
  '#{@vk_project}',
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
  // The exit status of the pane's ssh, and the last lines it printed. The page
  // shows these over a dead pane, because what tmux leaves there is one raw
  // "Pane is dead (status 255, <date>)" line, cut off at a phone's width, in
  // the middle of an empty screen. 255 is ssh's own failure: no connection, or
  // a login thor refused. Anything else came from thor's side.
  deadStatus: number | null
  deadText: string
  size: string
  // The Valkyrie project this pane was opened for, '' for none.
  projectId: string
}

// The pane's last few printed lines, minus tmux's own dead-pane line. Only ever
// read for a dead pane, so the list poll pays for it only while one is on
// screen. Bare name: capture-pane takes a target-PANE.
async function deadText(name: string): Promise<string> {
  try {
    const out = await tmux(['capture-pane', '-p', '-J', '-t', name, '-S', '-60'], 5_000)
    return out
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l && !l.startsWith('Pane is dead'))
      .slice(-6)
      .join('\n')
      .slice(-600)
  } catch {
    return ''
  }
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
  const rows: TermSession[] = out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const f = line.split(SEP)
      const dead = f[9] === '1'
      const status = f[11] ? Number(f[11]) : NaN
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
        dead,
        deadStatus: dead && Number.isFinite(status) ? status : null,
        deadText: '',
        size: f[10] || '',
        projectId: f[12] || '',
      }
    })
    .filter((s) => SESSION_NAME_RE.test(s.name))
  await Promise.all(rows.filter((s) => s.dead).map(async (s) => { s.deadText = await deadText(s.name) }))
  return rows.sort((a, b) => b.activityAt - a.activityAt)
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

// ------------------------------------------------------- account switch ----

// The account switcher (lib/accountSwitch.ts) reads a pane's screen to find a
// session that stopped on a usage limit, and types one line into that pane
// after it moved the host to another account. These are its only two hooks
// into a pane, both by the minted name.

// The visible screen, wrapped lines joined. null when the pane cannot be read.
export async function capturePane(name: string): Promise<string | null> {
  if (!SESSION_NAME_RE.test(name)) return null
  try {
    return await tmux(['capture-pane', '-p', '-J', '-t', name], 5_000)
  } catch {
    return null
  }
}

// True while the pane is in copy-mode (a swipe) or any other tmux mode. Keys
// sent then go to the mode instead of Claude, so such a pane is left alone.
export async function paneInMode(name: string): Promise<boolean> {
  if (!SESSION_NAME_RE.test(name)) return true
  try {
    const out = await tmux(['display-message', '-p', '-t', name, '#{pane_in_mode}'], 5_000)
    return out.trim() !== '0'
  } catch {
    return true
  }
}

// One line of text, then Enter as its own key a moment later, so the Enter
// is read as a key press rather than as the end of the typed burst.
export async function typeLine(name: string, text: string): Promise<void> {
  if (!SESSION_NAME_RE.test(name)) throw new Error('not a Valkyrie session name')
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  if (!clean) throw new Error('nothing to type')
  await tmux(['send-keys', '-t', name, '-l', '--', clean], 5_000)
  await new Promise((r) => setTimeout(r, 400))
  await tmux(['send-keys', '-t', name, 'Enter'], 5_000)
}

// Everything above is for Claude's inline renderer. A session started since
// 2026-10-12 runs fullscreen (Remote-Session.ps1 forces it): it draws on the
// alternate screen, so tmux keeps no history of it and copy-mode would scroll
// an empty buffer. It also asks for the mouse, and tmux's WheelUpPane binding
// hands a wheel event straight to a pane that did, so the scroll goes to
// Claude's own view instead. Anything else (an inline session from before, a
// plain shell) keeps copy-mode.
export async function paneTakesWheel(name: string): Promise<boolean> {
  if (!SESSION_NAME_RE.test(name)) return false
  try {
    const out = await tmux(['display-message', '-p', '-t', name, '#{alternate_on}#{mouse_any_flag}'], 5_000)
    return out.trim() === '11'
  } catch {
    return false
  }
}

// SGR wheel reports for the attach client to type, aimed at the middle of its
// screen. tmux reads them as that client's mouse and forwards them to the pane.
// 64 is wheel up (older output), which is positive lines here as in scrollPane.
export function wheelInput(lines: number, cols: number, rows: number): string {
  const n = Math.min(200, Math.abs(Math.trunc(lines)))
  const x = Math.max(1, Math.floor(cols / 2))
  const y = Math.max(1, Math.floor(rows / 2))
  return `\x1b[<${lines > 0 ? 64 : 65};${x};${y}M`.repeat(n)
}

// Ctrl+End, Claude's "jump to bottom". Measured on 2.1.280: it moves neither
// the prompt's cursor nor the highlight in an open menu.
export const APP_SCROLL_END = '\x1b[1;5F'

// --------------------------------------------------------------- create ----

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

export type CreateOpts = {
  mode: TermMode
  // Where the program runs; thor when absent, as every caller before odin.
  host?: TermHost
  // A launch-target key (new, shell) — validated against TARGET_RE by the route.
  // On odin it is a key from odin-targets.json instead of thor's list.
  target?: string
  // A conversation id (resume) — validated against UUID_RE by the route.
  resumeId?: string
  // The id a NEW session is told to use — minted by the route, never sent by a
  // client. Same shape, so the same regex guards it.
  newId?: string
  label: string
  cols?: number
  rows?: number
  // A project key and a run id minted by the route, both regex-checked again
  // in remoteCommand before they reach the ssh line.
  projectId?: string
  runId?: string
  // A session started from the Projects list to set up a new project. It gets
  // the unbound MCP endpoint instead of a project's, and its brief by -Run.
  desk?: boolean
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

// A desk session creates its project after it started, so the pane learns its
// project then. Same option createSession sets for a project launch.
export async function tagProject(name: string, projectId: string): Promise<void> {
  if (!SESSION_NAME_RE.test(name) || !TARGET_RE.test(projectId)) return
  await setOpt(name, '@vk_project', projectId)
}

// The command sshd runs on thor. The whole string is one PowerShell command
// line (PowerShell is thor's sshd default shell), and every variable part of
// it has already been matched against a regex that admits only [a-z0-9-] or a
// uuid, so there is nothing here for a shell on either side to interpret.
//
// Project arguments go after everything else, so a launch without a project is
// the same string, byte for byte, that thor has always been sent. A thor
// script that predates -Project would fail parameter binding on it, which is
// why thor is updated first.
export function remoteCommand(o: Pick<CreateOpts, 'mode' | 'target' | 'resumeId' | 'newId' | 'projectId' | 'runId' | 'desk'>): string {
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
  if (o.projectId) {
    if (!TARGET_RE.test(o.projectId)) throw Object.assign(new Error('project must be a project id'), { status: 400 })
    // Thor names the session's MCP config after the conversation id, and the
    // project link is keyed on it, so a project session never starts without one.
    if (o.mode === 'new' && !(o.newId && UUID_RE.test(o.newId))) {
      throw Object.assign(new Error('a project session needs a minted id'), { status: 400 })
    }
    parts.push('-Project', o.projectId)
  }
  if (o.desk) {
    if (o.projectId || o.mode !== 'new' || !(o.newId && UUID_RE.test(o.newId))) {
      throw Object.assign(new Error('a desk session is a new session with a minted id and no project'), { status: 400 })
    }
    parts.push('-Desk')
  }
  if (o.runId) {
    if (!(o.projectId || o.desk) || o.mode !== 'new' || !UUID_RE.test(o.runId)) {
      throw Object.assign(new Error('a run needs a project or the desk, mode new and a run id'), { status: 400 })
    }
    parts.push('-Run', o.runId)
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
// for the kernel default (about two minutes), and ssh prints nothing at all
// while it waits, which on
// a phone is indistinguishable from Claude thinking. Ten seconds gets a
// readable "Connection timed out" and a dead pane instead.
//
// The keepalives are the other half: a phone that vanishes detaches from tmux
// and never touches this SSH connection, so an established connection only
// ever dies when the tailnet does, and this is how sshd finds out.
//
// LogLevel is INFO, not ERROR. OpenSSH prints "Connection reset by" and
// "Connection closed by" at INFO, so under ERROR a login thor refused left the
// pane completely blank before it died (2026-09-28: sshd there could not build
// a logon token, and the phone showed nothing but tmux's dead-pane line).
// WarnWeakCrypto=no drops the post-quantum banner that INFO would otherwise
// print on every connect, since thor's sshd offers no PQ key exchange.
export function sshArgs(remote: string): string[] {
  return [
    SSH_BIN,
    '-t',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=INFO',
    '-o', 'WarnWeakCrypto=no',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    remoteLabel(),
    remote,
  ]
}

export async function createSession(o: CreateOpts): Promise<string> {
  const host: TermHost = o.host ?? 'thor'
  if (!TERM_HOSTS.includes(host)) throw Object.assign(new Error(`host must be one of ${TERM_HOSTS.join(', ')}`), { status: 400 })
  if (host === 'thor' && !sshPresent()) throw Object.assign(new Error(`ssh is not installed at ${SSH_BIN}`), { status: 503 })

  // Validates before anything is spawned, and before the tmux server is
  // touched, so a bad request costs nothing.
  const pane = host === 'odin'
    ? odinCommand(o)
    : { dir: homedir(), argv: sshArgs(remoteCommand(o)) }

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
  // wrapped mess until the first resize lands. For thor, -c is this box's home
  // purely because tmux needs a cwd for the pane; nothing in it runs here. For
  // odin it is the target's directory, where the program does run.
  const args = [
    'new-session', '-d', '-s', name, '-c', pane.dir, '-x', String(cols), '-y', String(rows),
    '--', ...pane.argv,
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
    setOpt(name, '@vk_host', host),
    setOpt(name, '@vk_mode', o.mode),
    setOpt(name, '@vk_target', o.mode === 'resume' ? (o.resumeId ?? '') : (o.target ?? '')),
    setOpt(name, '@vk_sid', o.mode === 'resume' ? (o.resumeId ?? '') : (o.mode === 'new' ? (o.newId ?? '') : '')),
    setOpt(name, '@vk_project', o.projectId ?? ''),
  ])

  return name
}
