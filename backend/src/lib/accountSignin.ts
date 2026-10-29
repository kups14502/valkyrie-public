import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { CLAUDE_ACCOUNTS, type ClaudeAccount } from './claudeAccounts.js'
import { postInbox } from './inboxStore.js'

// Claude sign-ins for the account switcher, one account at a time.
//
// Two kinds of sign-in, both driven by Claude Code's own CLI so the OAuth details stay its problem:
//   token  `claude setup-token`: a 1-year, inference-only token with no refresh token. It goes in
//          the account switcher's vaults (odin ~/.config/claude-switch/tokens/<id>.json, thor
//          C:\Users\Brendon\.claude-switch\tokens\<id>.json), where nothing ever refreshes it, so
//          sharing it between hosts cannot set off the refresh-token reuse that kills grants.
//   login  `claude auth login --claudeai --email <e>` into a config dir: a full grant, for a usage
//          card whose sign-in died. The new grant replaces the old one; the card's refresh lock is
//          held while the CLI writes, so the usage poller cannot write the old grant back over it.
//
// Flow: the CLI runs here in a throwaway tmux pane on its own socket (never Valkyrie's). Lil kups
// DMs Brendon its authorize URL; he signs in as that account, presses Authorize, and pastes the
// code#state the page shows into AI > Usage (POST /api/account-switch/signin/:id/code). The code is
// typed into the pane, the CLI prints the token, and the token goes to both vaults.
//
// auto:true first tries C:\Thor\tools\account-switch\browser-signin.mjs on thor (headless browser
// plus the tenant mailbox). Measured 2026-10-18: it gets through Cloudflare, the magic link and the
// verification code, and then claude.ai shows a visible hCaptcha. It stops there and never tries
// to solve one, so the route defaults to auto:false: one tap per account, and pool tokens last a
// year.
//
// "Set up all accounts" (startQueue) runs these one after another: each account without a token
// gets its own DM, the next starts when one finishes, and the queue stops on the first sign-in that
// fails or times out, so nothing keeps DMing while Brendon is away.
//
// 2026-10-18: the first one-tap sign-in "finished" at 7:05 PM ET with no token. The request
// had expired: nobody pasted a code in the 20 minutes it waited (no POST /code reached the API),
// and the record only said finishedAt with ok false. The wait is an hour now, the DM links straight
// to the paste box, the page takes the whole callback URL as well as code#state, a code from an
// older link is refused before it reaches the CLI, a refused code gets a fresh link instead of
// failing, and the history survives a restart.
//
// Secrets: the authorize URL, code#state and the token live in memory, in tmux's buffer for a
// moment, and in the vault files. None of them is logged, returned by a route, put on a command
// line, or written to the history file; they cross process boundaries on stdin only.

export type SigninMode = 'token' | 'login'
export type SigninStage =
  | 'starting' | 'browser' | 'needs-code' | 'finishing'
  | 'done' | 'failed' | 'canceled' | 'expired'

export type SigninRequest = {
  id: string
  accountId: string
  label: string
  email: string
  mode: SigninMode
  // login: the config dir the grant lands in. token: 'vault'.
  target: string
  stage: SigninStage
  // The last step reached, or why it stopped. Never a secret.
  detail: string | null
  // Set while the sign-in waits for a person: why thor could not finish it.
  fallbackReason: string | null
  needsCode: boolean
  dmSent: boolean
  // When the last DM with the link went out, and when the wait for the code ends (ISO).
  dmAt: string | null
  waitUntil: string | null
  // Codes the CLI refused that were answered with a fresh link.
  retries: number
  auto: boolean
  dryRun: boolean
  // A code reached the CLI (counts toward the daily cap, like an automated run).
  codeUsed: boolean
  // Set when "Set up all accounts" started it: its place in that run.
  queue: { n: number; of: number } | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  ok: boolean | null
  // token mode: which vaults hold the new token, and whether a probe accepted it.
  vault: { odin: boolean; thor: boolean | null; probeStatus: number | null } | null
  // token mode: how sure the new token is this account's (organization, then weekly use).
  identity: string | null
}

export class SigninError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const HOME = homedir()
const CLAUDE_BIN = process.env.VALKYRIE_ODIN_CLAUDE || path.join(HOME, '.local', 'bin', 'claude')
const TMUX_BIN = process.env.VALKYRIE_TMUX_BIN || 'tmux'
const SOCKET = process.env.ACCOUNT_SWITCH_TMUX_SOCKET || 'claude-signin'
const API_BASE = process.env.ACCOUNT_SWITCH_API_BASE || 'https://api.anthropic.com'
const SWITCH_DIR = process.env.CLAUDE_SWITCH_DIR || path.join(HOME, '.config', 'claude-switch')
const SCRATCH_ROOT = path.join(SWITCH_DIR, 'signin')
export const VAULT_DIR = path.join(SWITCH_DIR, 'tokens')
const HISTORY_FILE = path.join(SWITCH_DIR, 'signin-history.json')
const QUEUE_FILE = path.join(SWITCH_DIR, 'signin-queue.json')
const LILKUPS_BIN = process.env.LILKUPS_BIN || path.join(HOME, 'lilkups', 'lilkups')
const SSH_BIN = process.env.VALKYRIE_SSH_BIN || '/usr/bin/ssh'
const THOR = `${process.env.THOR_SSH_USER || 'brendon'}@${process.env.THOR_SSH_HOST || process.env.THOR_LAUNCHER_HOST || '100.118.7.57'}`
const THOR_TOOLS = process.env.ACCOUNT_SWITCH_THOR_TOOLS || 'C:/Thor/tools/account-switch'
const PUBLIC_URL = (process.env.VALKYRIE_PUBLIC_URL || 'https://valkyrie.brendonkupsch.com').replace(/\/+$/, '')
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`

const DEBUG = process.env.ACCOUNT_SWITCH_DEBUG === '1'
const URL_WAIT_MS = 30_000
const BROWSER_LEG_MS = 7 * 60_000
const CODE_WAIT_MS = Number(process.env.ACCOUNT_SWITCH_CODE_WAIT_MS) || 60 * 60_000
const RESULT_WAIT_MS = 60_000
const DM_RESEND_MS = 60_000
const MAX_RETRIES = 2
// Runs that could have sent sign-in mail (automated ones, or a code that reached the CLI). Repeated
// sign-in mail can get an account flagged.
const MAX_MAIL_PER_ACCOUNT_PER_DAY = 3
// Every run, including one-tap runs nobody answered: a cap on DMs.
const MAX_PER_ACCOUNT_PER_DAY = 8
const HISTORY = 30
const EXPIRING_MS = 14 * 86_400_000
const QUEUE_NEXT_MS = 1500
// The usage poller's refresh lock (routes/aiUsage.ts); stale after 60 s there.
const CARD_LOCK = '.credentials.refresh.lock'

const ID_RE = /^[0-9a-f]{12}$/
const CODE_RE = /^[A-Za-z0-9_-]{10,}#[A-Za-z0-9_-]{10,}$/
// The CLI token shape: two, three and three lowercase letters plus two digits, then the body.
const TOKEN_RE = /\b[a-z]{2}-[a-z]{3}-[a-z]{3}\d{2}-[A-Za-z0-9_-]{40,}/
const AUTH_URL_RE = /https:\/\/\S*\/oauth\/authorize\?\S+/g
const LIVE_STAGES: readonly SigninStage[] = ['starting', 'browser', 'needs-code', 'finishing']

// For the one place CLI text reaches a status line: a failure message.
const scrub = (t: string) => t
  .replace(/https?:\/\/\S+/g, '<url>')
  .replace(/[A-Za-z0-9_\-#.]{24,}/g, '<long>')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120)

// setup-token prints "Your OAuth token (valid for ...):", the token on its own line, then "Store
// this token securely". Tokens have the CLI's own prefix shape (TOKEN_RE); the line after the
// heading is the fallback if that prefix ever changes.
export function extractToken(text: string): string | null {
  const m = text.match(TOKEN_RE)
  if (m) return m[0]
  const lines = text.split('\n')
  const i = lines.findIndex((l) => /Your OAuth token/i.test(l))
  if (i < 0) return null
  for (const l of lines.slice(i + 1, i + 6)) {
    const t = l.trim()
    if (!t) continue
    return /^[A-Za-z0-9_\-.]{40,}$/.test(t) ? t : null
  }
  return null
}

// What a person pastes: code#state as the page shows it, or the whole callback URL (or its query),
// with any whitespace the phone added. Null when it is neither.
export function parseCode(raw: string): string | null {
  const t = String(raw ?? '').trim()
  const c = t.match(/(?:^|[?&#])code=([A-Za-z0-9_-]{10,})/)
  const s = t.match(/(?:^|[?&])state=([A-Za-z0-9_-]{10,})/)
  if (c && s) return `${c[1]}#${s[1]}`
  const flat = t.replace(/\s+/g, '')
  return CODE_RE.test(flat) ? flat : null
}

// The state an authorize URL carries; its callback hands the same state back in code#state.
export function stateOf(authUrl: string | null): string | null {
  if (!authUrl) return null
  try { return new URL(authUrl).searchParams.get('state') } catch { return null }
}

// The newest authorize URL on a screen (the CLI prints a new one after a refused code).
export function lastAuthUrl(text: string): string | null {
  const all = text.match(AUTH_URL_RE)
  return all ? all[all.length - 1] : null
}

// ------------------------------------------------------------------- state

type Active = {
  req: SigninRequest
  session: string
  scratch: string | null
  account: ClaudeAccount
  url: string | null
  settle: ((code: string) => void) | null
  waitUntil: number | null
  fromQueue: boolean
}

let active: Active | null = null

const now = () => new Date().toISOString()
const log = (req: SigninRequest, what: string) => console.log(`[account-signin] ${req.id} ${req.accountId} ${req.mode} ${what}`)

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function writePrivate(file: string, text: string): void {
  ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

// The history file holds what the routes return and nothing else: no URL, code or token.
function loadHistory(): SigninRequest[] {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is SigninRequest => !!r && typeof r === 'object' && typeof (r as SigninRequest).id === 'string' && typeof (r as SigninRequest).accountId === 'string')
      .map((r) => {
        // Records from before a field existed get its default.
        const base = {
          dmAt: null, waitUntil: null, retries: 0, auto: false, dryRun: false, codeUsed: false, queue: null, identity: null,
          ...(r as Partial<SigninRequest>),
        } as SigninRequest
        // The CLI that request was talking to died with the old process.
        return LIVE_STAGES.includes(base.stage)
          ? { ...base, stage: 'failed' as const, ok: false, needsCode: false, finishedAt: base.updatedAt, detail: 'Valkyrie restarted during this sign-in; start it again' }
          : base
      })
      .slice(0, HISTORY)
  } catch {
    return []
  }
}

const requests: SigninRequest[] = loadHistory()

function saveHistory(): void {
  try {
    writePrivate(HISTORY_FILE, JSON.stringify(requests.slice(0, HISTORY), null, 2))
  } catch (err) {
    console.error('[account-signin] history write failed:', (err as Error).message)
  }
}

function update(req: SigninRequest, patch: Partial<SigninRequest>): void {
  Object.assign(req, patch, { updatedAt: now() })
  saveHistory()
}

const copyReq = (r: SigninRequest): SigninRequest => ({ ...r, vault: r.vault ? { ...r.vault } : null, queue: r.queue ? { ...r.queue } : null })

export function listSignins(): SigninRequest[] {
  return requests.map(copyReq)
}

export function getSignin(id: string): SigninRequest | null {
  const r = requests.find((x) => x.id === id)
  return r ? copyReq(r) : null
}

// The switcher (accountSwitch.ts) links itself in at load, so this module never imports it:
// thor's vault ids from its last check, the accounts whose pool token was refused, and a note when
// a token lands so the switcher can use it at once.
export type SwitchLink = {
  thorVaultIds: () => string[] | null
  deadIds: () => string[]
  provisioned: (accountId: string, onThor: boolean) => void
  // hosts with their own auto-switch on that the switcher has not taken over yet
  notAdopted: () => string[]
}
let link: SwitchLink | null = null
export function linkSwitcher(l: SwitchLink): void { link = l }

// ------------------------------------------------------------------ processes

type RunResult = { code: number | null; stdout: string; stderr: string }

// stdin is the only way anything secret enters a child process.
function run(bin: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env })
    let stdout = '', stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.on('error', () => { /* the child exited first */ })
    child.stdin.end(opts.input ?? '')
  })
}

const tmux = (args: string[], input?: string) => run(TMUX_BIN, ['-f', '/dev/null', '-L', SOCKET, ...args], { input, timeoutMs: 15_000 })
const paneOf = (session: string) => `${session}:0.0`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function capture(session: string): Promise<string> {
  const r = await tmux(['capture-pane', '-p', '-J', '-S', '-200', '-t', paneOf(session)])
  return r.code === 0 ? r.stdout : ''
}

async function killPane(session: string): Promise<void> {
  await tmux(['kill-session', '-t', session]).catch(() => undefined)
}

// A pane that outlived its request (the API restarted mid-sign-in) only holds a CLI waiting for a
// code nobody will send. The socket is this module's alone.
async function sweepStale(): Promise<void> {
  if (active) return
  await tmux(['kill-server']).catch(() => undefined)
  // let the old server finish exiting before the next new-session reaches for its socket
  await sleep(250)
  try {
    for (const name of fs.readdirSync(SCRATCH_ROOT)) fs.rmSync(path.join(SCRATCH_ROOT, name), { recursive: true, force: true })
  } catch { /* none yet */ }
}

// ------------------------------------------------------------------- start

export type StartOpts = {
  accountId: string
  mode: SigninMode
  // false skips thor and goes straight to the DM (the one-tap path).
  auto?: boolean
  // login mode only: a different config dir than the account's own (tests use a scratch dir).
  configDir?: string
  // Test hook: thor checks the page and the mailbox and sends no mail; the request then fails.
  dryRun?: boolean
  // Internal: started by the setup queue, with its place in it.
  queuePos?: { n: number; of: number }
}

function recentRuns(accountId: string): SigninRequest[] {
  const day = Date.now() - 86_400_000
  return requests.filter((r) => r.accountId === accountId && !r.dryRun && Date.parse(r.startedAt) > day)
}

export async function startSignin(opts: StartOpts): Promise<SigninRequest> {
  const account = CLAUDE_ACCOUNTS.find((a) => a.id === opts.accountId)
  if (!account) throw new SigninError(404, 'no such account')
  if (opts.mode !== 'token' && opts.mode !== 'login') throw new SigninError(400, 'mode must be token or login')
  if (!account.email) throw new SigninError(400, 'the account has no email in claude-accounts.json')
  if (active) throw new SigninError(409, `a sign-in for ${active.req.label} is already running`)
  if (!opts.queuePos && queue?.state === 'running') throw new SigninError(409, 'Set up all accounts is running; stop it first')
  const recent = recentRuns(account.id)
  if (!opts.dryRun) {
    const mail = recent.filter((r) => r.auto || r.codeUsed).length
    if (opts.auto && mail >= MAX_MAIL_PER_ACCOUNT_PER_DAY) {
      throw new SigninError(429, `${MAX_MAIL_PER_ACCOUNT_PER_DAY} sign-ins for this account in 24 hours already; repeated sign-in mail can get an account flagged`)
    }
    if (mail >= MAX_MAIL_PER_ACCOUNT_PER_DAY || recent.length >= MAX_PER_ACCOUNT_PER_DAY) {
      throw new SigninError(429, `too many sign-ins for this account in 24 hours (${recent.length}); try again tomorrow`)
    }
  }

  const target = opts.mode === 'login' ? path.resolve(opts.configDir || account.configDir) : 'vault'
  if (opts.mode === 'login' && !fs.existsSync(target)) throw new SigninError(400, 'the config dir does not exist')

  await sweepStale()
  if (active) throw new SigninError(409, `a sign-in for ${(active as Active).req.label} is already running`)
  ensurePrivateDir(SCRATCH_ROOT)
  const id = randomBytes(6).toString('hex')
  const session = `si-${id}`
  const scratch = opts.mode === 'token' ? path.join(SCRATCH_ROOT, id) : null
  if (scratch) ensurePrivateDir(scratch)

  const req: SigninRequest = {
    id, accountId: account.id, label: account.label, email: account.email, mode: opts.mode, target,
    stage: 'starting', detail: null, fallbackReason: null, needsCode: false, dmSent: false,
    dmAt: null, waitUntil: null, retries: 0, auto: opts.auto === true, dryRun: opts.dryRun === true, codeUsed: false,
    queue: opts.queuePos ? { ...opts.queuePos } : null,
    startedAt: now(), updatedAt: now(), finishedAt: null, ok: null,
    vault: opts.mode === 'token' ? { odin: false, thor: null, probeStatus: null } : null,
    identity: null,
  }
  requests.unshift(req)
  requests.splice(HISTORY)
  saveHistory()
  active = { req, session, scratch, account, url: null, settle: null, waitUntil: null, fromQueue: !!opts.queuePos }
  log(req, 'start')

  void drive(opts).catch((err) => {
    finishRequest(false, 'failed', (err as Error).message)
  })
  return getSignin(id)!
}

async function drive(opts: StartOpts): Promise<void> {
  const a = active!
  const { req, session } = a
  const configDir = a.scratch ? path.join(a.scratch, 'cfg') : req.target
  if (a.scratch) ensurePrivateDir(configDir)
  const cli = req.mode === 'token'
    ? [CLAUDE_BIN, 'setup-token']
    : [CLAUDE_BIN, 'auth', 'login', '--claudeai', '--email', req.email]
  // 1000 columns: the authorize URL and the token each fit one line, so a capture reads them whole.
  // No display and a no-op BROWSER: valkyrie-api carries the KDE session's DISPLAY, and the CLI
  // would otherwise open the authorize page in a browser window on odin's desktop.
  const args = [
    'new-session', '-d', '-s', session, '-x', '1000', '-y', '50',
    'env', '-u', 'ANTHROPIC_API_KEY', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', '-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY',
    'BROWSER=/bin/true', `CLAUDE_CONFIG_DIR=${configDir}`, ...cli,
    ';', 'set-option', '-t', session, 'remain-on-exit', 'on',
  ]
  let started = await tmux(args)
  // A server still shutting down from the last sign-in answers "server exited unexpectedly"; the
  // next try starts a fresh one.
  if (started.code !== 0) {
    await sleep(800)
    started = await tmux(args)
  }
  if (started.code !== 0) throw new Error('could not start the sign-in pane: ' + started.stderr.trim().slice(0, 160))

  a.url = await waitForUrl(session, null)
  if (!a.url) throw new Error('the CLI printed no authorize URL')
  if (active !== a) return

  let reason = 'manual'
  if (opts.auto === true) {
    update(req, { stage: 'browser', detail: 'thor: starting' })
    const leg = await browserLeg(a.url, req, opts.dryRun === true)
    if (active !== a) return
    if (leg.code) {
      const out = await finishWithCode(leg.code)
      if (out !== 'retry') return
      if (!await freshLink()) return
      reason = 'refused'
    } else {
      reason = leg.reason
      if (opts.dryRun) { finishRequest(false, 'failed', `dry run stopped at ${reason}`); return }
    }
  }
  await waitForPerson(reason)
}

// Waits for an authorize URL on the pane that is not `old` (the CLI prints a new one on retry).
async function waitForUrl(session: string, old: string | null): Promise<string | null> {
  const until = Date.now() + URL_WAIT_MS
  while (Date.now() < until) {
    await sleep(500)
    const u = lastAuthUrl(await capture(session))
    if (u && u !== old) return u
  }
  return null
}

// After the CLI refused a code it says "Press Enter to retry" and, on Enter, starts over with a new
// authorize URL. False when the request ended instead.
async function freshLink(): Promise<boolean> {
  const a = active!
  const { req } = a
  if (req.retries >= MAX_RETRIES) { finishRequest(false, 'failed', `the code was refused ${req.retries + 1} times; start the sign-in again`); return false }
  update(req, { retries: req.retries + 1, stage: 'finishing', detail: 'the code was refused; getting a new link' })
  const old = a.url
  await tmux(['send-keys', '-t', paneOf(a.session), 'Enter'])
  const next = await waitForUrl(a.session, old)
  if (active !== a) return false
  if (!next) { finishRequest(false, 'failed', 'the code was refused and the CLI gave no new link'); return false }
  a.url = next
  return true
}

// ------------------------------------------------------------- thor's part

async function browserLeg(url: string, req: SigninRequest, dryRun: boolean): Promise<{ code?: string; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(SSH_BIN, [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      THOR, `node ${THOR_TOOLS}/browser-signin.mjs`,
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const settle = (v: { code?: string; reason: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* gone */ }
      resolve(v)
    }
    const timer = setTimeout(() => settle({ reason: 'thor-timeout' }), BROWSER_LEG_MS)
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        let o: { stage?: string; result?: string; code?: string; reason?: string }
        try { o = JSON.parse(line) } catch { continue }
        if (o.result === 'code' && typeof o.code === 'string' && CODE_RE.test(o.code)) { settle({ code: o.code, reason: 'ok' }); return }
        if (o.result) { settle({ reason: String(o.reason || o.result).slice(0, 80) }); return }
        // Progress lines are redacted on thor (no URL query, link, code or token). The result line,
        // which carries code#state, is handled above and never reaches this log.
        if (o.stage && DEBUG) console.log(`[account-signin] ${req.id} thor ${line}`)
        if (o.stage && o.stage !== 'page') {
          update(req, { detail: `thor: ${o.stage}` })
          if (!DEBUG) log(req, `thor ${o.stage}`)
        }
      }
    })
    child.on('error', () => settle({ reason: 'thor-unreachable' }))
    child.on('close', (code) => settle({ reason: code === 255 ? 'thor-unreachable' : 'thor-ended' }))
    child.stdin.on('error', () => { /* ssh failed before reading */ })
    child.stdin.end(JSON.stringify({ url, email: req.email, timeoutSec: 300, dryRun }))
  })
}

// ------------------------------------------------------------ a person's part

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

// The sign-in steps go to the inbox (lib/inboxStore.ts), pushed, with Open on the paste page.
// Only if the inbox refuses it, Lil' kups sends a Discord DM: --message - reads stdin, so the
// authorize URL is never on a command line, and lilkups logs the length only.
async function dm(text: string, id?: string): Promise<boolean> {
  try {
    await postInbox({ source: 'claude', level: 'warn', push: true, body: text, url: id ? `/m/ai/usage?signin=${id}` : '/m/ai/usage' })
    return true
  } catch (err) {
    console.error('[account-signin] inbox post failed:', (err as Error).message)
  }
  try {
    const r = await run(LILKUPS_BIN, ['send', '--discord', '--message', '-'], { input: text, timeoutMs: 20_000 })
    return r.code === 0
  } catch {
    return false
  }
}

const WHY: Record<string, string> = {
  'mailbox-not-in-tenant': 'its mailbox is outside the work tenant, so the sign-in mail cannot be read automatically',
  captcha: 'claude.ai showed a captcha to the automated browser',
  cloudflare: 'Cloudflare blocked the headless browser',
  'no-email': 'the sign-in email did not arrive',
  'thor-unreachable': 'thor did not answer over ssh',
  'thor-timeout': 'the automated sign-in on thor took too long',
}

export const pastePage = (id: string) => `${PUBLIC_URL}/m/ai/usage?signin=${id}`

function dmText(a: Active, reason: string, until: number, lead: string | null): string {
  const { req } = a
  const head = req.queue ? `Claude sign-in ${req.queue.n} of ${req.queue.of}: ${req.label} (${req.email})` : `Claude sign-in for ${req.label} (${req.email})`
  const why = reason === 'refused'
    ? 'The last code was refused (it may have been old). This is a new link.'
    : reason !== 'manual' ? `The automatic sign-in stopped: ${WHY[reason] ?? reason}.` : null
  return [
    lead,
    head,
    why,
    `1. Open this link in a private window and sign in as ${req.email}:`,
    a.url!,
    '2. Press Authorize and copy the code it shows.',
    `3. Paste it in Valkyrie, AI > Usage: ${pastePage(req.id)}`,
    `The link works until ${NY.format(until)} ET.`,
  ].filter((l): l is string => !!l).join('\n')
}

// The line the next DM opens with when the setup queue just finished an account.
let dmLead: string | null = null

async function waitForPerson(firstReason: string): Promise<void> {
  const a = active!
  const { req } = a
  let reason = firstReason
  for (;;) {
    const until = Date.now() + CODE_WAIT_MS
    a.waitUntil = until
    const lead = dmLead
    dmLead = null
    const dmSent = await dm(dmText(a, reason, until, lead), req.id)
    if (active !== a) return
    update(req, {
      stage: 'needs-code', needsCode: true, fallbackReason: reason, dmSent, dmAt: now(),
      waitUntil: new Date(until).toISOString(),
      detail: dmSent ? 'waiting for the pasted code' : 'waiting for the pasted code (the DM failed)',
    })
    log(req, `needs-code reason=${reason} dm=${dmSent}`)

    const code = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { a.settle = null; resolve(null) }, Math.max(0, until - Date.now()))
      a.settle = (c: string) => { clearTimeout(timer); a.settle = null; resolve(c) }
    })
    if (active !== a) return
    if (!code) { finishRequest(false, 'expired', `no code was pasted by ${NY.format(until)} ET`); return }
    const out = await finishWithCode(code)
    if (out !== 'retry') return
    if (!await freshLink()) return
    reason = 'refused'
  }
}

export async function submitCode(id: string, raw: string): Promise<SigninRequest> {
  if (!ID_RE.test(id)) throw new SigninError(400, 'bad sign-in id')
  const code = parseCode(raw)
  if (!code) throw new SigninError(400, 'that is not a code from the Claude authorize page (it looks like letters#letters)')
  if (!active || active.req.id !== id) throw new SigninError(404, 'that sign-in is not running')
  if (!active.settle) throw new SigninError(409, 'that sign-in is not waiting for a code')
  const want = stateOf(active.url)
  if (want && code.slice(code.indexOf('#') + 1) !== want) {
    throw new SigninError(409, 'that code is from an older sign-in link; use the newest link in the DM')
  }
  active.settle(code)
  return getSignin(id)!
}

export async function resendDm(id: string): Promise<SigninRequest> {
  if (!ID_RE.test(id)) throw new SigninError(400, 'bad sign-in id')
  const a = active
  if (!a || a.req.id !== id) throw new SigninError(404, 'that sign-in is not running')
  if (!a.settle || !a.waitUntil) throw new SigninError(409, 'that sign-in is not waiting for a code')
  if (a.req.dmAt && Date.now() - Date.parse(a.req.dmAt) < DM_RESEND_MS) throw new SigninError(429, 'the DM went out less than a minute ago')
  const dmSent = await dm(dmText(a, a.req.fallbackReason ?? 'manual', a.waitUntil, null), a.req.id)
  if (active === a) update(a.req, { dmSent, dmAt: now(), detail: dmSent ? 'waiting for the pasted code' : 'waiting for the pasted code (the DM failed)' })
  if (!dmSent) throw new SigninError(502, 'Lil kups did not send the DM')
  return getSignin(id)!
}

export async function cancelSignin(id: string): Promise<SigninRequest> {
  if (!active || active.req.id !== id) throw new SigninError(404, 'that sign-in is not running')
  finishRequest(false, 'canceled', 'canceled')
  return getSignin(id)!
}

// --------------------------------------------------------------- finishing

function takeCardLock(configDir: string): string | null {
  const lock = path.join(configDir, CARD_LOCK)
  try {
    fs.closeSync(fs.openSync(lock, 'wx', 0o600))
    return lock
  } catch {
    return null
  }
}

// 'retry': the CLI refused the code and offers a new link (token mode).
async function finishWithCode(code: string): Promise<'done' | 'failed' | 'retry' | 'gone'> {
  const a = active!
  const { req, session } = a
  update(req, { stage: 'finishing', needsCode: false, codeUsed: true, detail: 'sending the code to the CLI' })

  // login: hold the usage poller's refresh lock while the CLI writes the new grant.
  let lock: string | null = null
  if (req.mode === 'login') {
    for (let i = 0; i < 30 && !lock; i++) {
      lock = takeCardLock(req.target)
      if (!lock) await sleep(1000)
    }
    if (!lock) { finishRequest(false, 'failed', 'the usage poller held the refresh lock for 30 s'); return 'failed' }
  }
  try {
    const before = await capture(session)
    const buf = `code-${req.id}`
    const loaded = await tmux(['load-buffer', '-b', buf, '-'], code)
    if (loaded.code !== 0) throw new Error('tmux would not take the code')
    await tmux(['paste-buffer', '-d', '-b', buf, '-t', paneOf(session)])
    await sleep(400)
    await tmux(['send-keys', '-t', paneOf(session), 'Enter'])
    update(req, { detail: 'checking the code' })

    const until = Date.now() + RESULT_WAIT_MS
    while (Date.now() < until) {
      await sleep(1000)
      if (active !== a) return 'gone'
      const text = await capture(session)
      if (req.mode === 'token') {
        const token = extractToken(text)
        if (token) {
          const validFor = text.match(/valid for ([^)\n]{1,40})\)/i)?.[1]?.trim() ?? null
          await killPane(session)
          return await storeToken(token, validFor)
        }
      } else if (/Login successful/i.test(text)) {
        if (lock) { try { fs.unlinkSync(lock) } catch { /* swept */ } lock = null }
        await confirmLogin()
        return req.ok ? 'done' : 'failed'
      }
      const failed = text.match(/(Login failed[^\n]*|OAuth error[^\n]*|Invalid code[^\n]*|Error:[^\n]*)/i)
      if (failed && !before.includes(failed[1])) {
        // Measured with the real CLI (2.1.283): a refused code prints "OAuth error: Request failed
        // with status code 400" and "Press Enter to retry."; Enter starts over with a new URL.
        if (req.mode === 'token' && /Press Enter to retry/i.test(text)) return 'retry'
        finishRequest(false, 'failed', scrub(failed[1]))
        return 'failed'
      }
    }
    finishRequest(false, 'failed', 'the CLI did not confirm within a minute')
    return 'failed'
  } finally {
    if (lock) { try { fs.unlinkSync(lock) } catch { /* swept */ } }
  }
}

async function confirmLogin(): Promise<void> {
  const a = active!
  const { req } = a
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: req.target }
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  let who: { loggedIn?: boolean; email?: string } = {}
  try {
    const r = await run(CLAUDE_BIN, ['auth', 'status', '--json'], { env, timeoutMs: 30_000 })
    const j = JSON.parse(r.stdout) as Record<string, unknown>
    who = { loggedIn: j.loggedIn === true, email: typeof j.email === 'string' ? j.email : undefined }
  } catch { /* reported below */ }
  if (!who.loggedIn) { finishRequest(false, 'failed', 'Login successful, but auth status says not logged in'); return }
  if (who.email && who.email.toLowerCase() !== req.email.toLowerCase()) {
    finishRequest(false, 'failed', `signed in as a different account (${who.email})`)
    return
  }
  finishRequest(true, 'done', `signed in${who.email ? ' as ' + who.email : ''}`)
}

type Probe = { status: number; sessionPct: number | null; weeklyPct: number | null; org: string | null }

// One 1-token Haiku call, the same probe the usage cards make. Its headers name the organization
// and carry the account's own 5-hour and weekly use.
async function probe(token: string): Promise<Probe> {
  const resp = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    signal: AbortSignal.timeout(30_000),
  })
  const pct = (h: string) => { const v = resp.headers.get(h); return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) }
  await resp.arrayBuffer().catch(() => undefined)
  return {
    status: resp.status,
    sessionPct: pct('anthropic-ratelimit-unified-5h-utilization'),
    weeklyPct: pct('anthropic-ratelimit-unified-7d-utilization'),
    org: resp.headers.get('anthropic-organization-id'),
  }
}

// The plan fields a credential file carries next to the token. Read from the account's own sign-in
// (never its tokens), since a setup-token says nothing about the plan.
function planOf(account: ClaudeAccount): { subscriptionType: string | null; rateLimitTier: string | null } {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(account.configDir, '.credentials.json'), 'utf8'))?.claudeAiOauth ?? {}
    return {
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
    }
  } catch {
    return { subscriptionType: null, rateLimitTier: null }
  }
}

// The organization Claude Code recorded for the account's own sign-in (.claude.json oauthAccount).
function orgOf(account: ClaudeAccount): string | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(account.configDir, '.claude.json'), 'utf8'))?.oauthAccount
    return typeof o?.organizationUuid === 'string' && o.organizationUuid ? o.organizationUuid : null
  } catch {
    return null
  }
}

// The usage cards' weekly readings (the backend polls each account's own grant), when fresh.
async function cardWeekly(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const r = await fetch(`${BACKEND}/api/ai-usage`, { headers: { 'X-Alerts-Internal': '1' }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return out
    const j = await r.json() as { aiClients?: Array<{ id?: string; quota?: { weeklyPct?: number } | null; authError?: string | null }>; updatedAt?: string }
    const at = j.updatedAt ? Date.parse(j.updatedAt) : NaN
    if (!Number.isFinite(at) || Date.now() - at > 15 * 60_000) return out
    for (const c of j.aiClients ?? []) {
      if (c.id && !c.authError && typeof c.quota?.weeklyPct === 'number') out.set(c.id, c.quota.weeklyPct)
    }
  } catch { /* no reading: the seat stays unconfirmed */ }
  return out
}

// A token is only as good as the account that pressed Authorize. A browser already signed in to
// claude.ai as someone else authorizes that someone else, so before a token is filed under an
// account: the organization the API names must be the account's own, and when other accounts share
// that organization (seats on one Team plan), the token's weekly use must not plainly be another
// seat's. Measured 2026-10-18: the four work seats share one organization and one workspace, so the
// organization alone cannot tell them apart.
export async function checkIdentity(p: { org: string | null; weeklyPct: number | null }, account: ClaudeAccount): Promise<{ ok: boolean; note: string }> {
  const own = orgOf(account)
  if (!own || !p.org) return { ok: true, note: 'organization not checked' }
  if (p.org !== own) {
    const other = CLAUDE_ACCOUNTS.filter((x) => x.id !== account.id && orgOf(x) === p.org)
    const who = other.length === 1 ? ` (it looks like ${other[0].label})` : ''
    return { ok: false, note: `the token belongs to another organization${who}: the browser was signed in as a different account` }
  }
  const peers = CLAUDE_ACCOUNTS.filter((x) => x.id !== account.id && orgOf(x) === own)
  if (!peers.length) return { ok: true, note: 'organization matches' }
  const cards = await cardWeekly()
  const mine = cards.get(account.id)
  if (p.weeklyPct == null || mine == null) return { ok: true, note: 'organization matches; seat not confirmed' }
  const diff = Math.abs(mine - p.weeklyPct)
  if (diff > 5) {
    const match = peers.filter((x) => { const c = cards.get(x.id); return c != null && Math.abs(c - p.weeklyPct!) <= 1 })
    if (match.length === 1) {
      return { ok: false, note: `the token's weekly use (${p.weeklyPct}%) matches ${match[0].label}, not ${account.label} (${mine}%): the browser was signed in as a different account` }
    }
  }
  return { ok: true, note: diff <= 3 ? 'organization and weekly use match' : 'organization matches; seat not confirmed' }
}

export function writeOdinVault(record: Record<string, unknown> & { accountId: string }): void {
  ensurePrivateDir(SWITCH_DIR)
  ensurePrivateDir(VAULT_DIR)
  const final = path.join(VAULT_DIR, `${record.accountId}.json`)
  const tmp = path.join(VAULT_DIR, `.${record.accountId}.${process.pid}.tmp`)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, final)
}

export async function writeThorVault(record: Record<string, unknown> & { accountId: string }): Promise<boolean> {
  try {
    const r = await run(SSH_BIN, [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', '-o', 'StrictHostKeyChecking=accept-new',
      THOR, `powershell -NoProfile -ExecutionPolicy Bypass -File ${THOR_TOOLS}/Write-VaultToken.ps1`,
    ], { input: JSON.stringify(record), timeoutMs: 60_000 })
    return r.stdout.trim().split(/\r?\n/).pop() === `ok ${record.accountId}`
  } catch {
    return false
  }
}

// Copies odin's vault record for one account to thor again, for when thor was asleep at sign-in.
export async function syncThorVault(accountId: string): Promise<boolean> {
  if (!CLAUDE_ACCOUNTS.some((a) => a.id === accountId)) throw new SigninError(404, 'no such account')
  let record: Record<string, unknown> & { accountId: string }
  try {
    record = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, `${accountId}.json`), 'utf8'))
  } catch {
    throw new SigninError(404, 'odin has no token for that account')
  }
  const ok = await writeThorVault(record)
  if (ok) link?.provisioned(accountId, true)
  return ok
}

async function storeToken(token: string, validFor: string | null): Promise<'done' | 'failed' | 'gone'> {
  const a = active!
  const { req, account } = a
  update(req, { detail: 'checking the new token' })
  let p: Probe | null = null
  try { p = await probe(token) } catch { /* recorded as null */ }
  if (active !== a) return 'gone'
  if (p && (p.status === 401 || p.status === 403)) {
    finishRequest(false, 'failed', `the new token was refused (${p.status})`)
    return 'failed'
  }
  const who = p ? await checkIdentity(p, account) : { ok: true, note: 'not checked (the probe did not answer)' }
  if (active !== a) return 'gone'
  update(req, { identity: who.note })
  if (!who.ok) {
    finishRequest(false, 'failed', `${who.note}. Sign in again in a private window as ${account.email}`)
    return 'failed'
  }
  const record = {
    version: 1,
    accountId: account.id,
    label: account.label,
    email: account.email,
    kind: 'setup-token',
    accessToken: token,
    refreshToken: null,
    // setup-token says "valid for 1 year" and prints no expiry; a day short of it, to be safe.
    expiresAt: Date.now() + 364 * 86_400_000,
    expiresAtEstimated: true,
    validFor,
    scopes: ['user:inference'],
    ...planOf(account),
    createdAt: now(),
  }
  writeOdinVault(record)
  update(req, { vault: { odin: true, thor: null, probeStatus: p?.status ?? null }, detail: 'saved on odin; copying to thor' })
  const thor = await writeThorVault(record)
  if (active !== a) return 'gone'
  update(req, { vault: { odin: true, thor, probeStatus: p?.status ?? null } })
  link?.provisioned(account.id, thor)
  finishRequest(true, 'done', thor ? 'token saved on odin and thor' : 'token saved on odin; thor did not answer, use Copy to thor')
  return 'done'
}

function finishRequest(ok: boolean, stage: SigninStage, detail: string): void {
  const a = active
  if (!a) return
  active = null
  if (a.settle) a.settle = null
  update(a.req, { ok, stage, detail, needsCode: false, finishedAt: now() })
  log(a.req, `${stage}: ${detail}`)
  void killPane(a.session)
  if (a.scratch) fs.rmSync(a.scratch, { recursive: true, force: true })
  if (a.fromQueue) queueFinished(a.req)
}

// ---------------------------------------------------- Set up all accounts

export type QueueItem = {
  accountId: string
  label: string
  // sign in: no usable token on odin. copy: odin has one, thor's vault does not.
  kind: 'signin' | 'copy'
  status: 'waiting' | 'running' | 'done' | 'failed'
  detail: string | null
  requestId: string | null
}

export type SigninQueue = {
  id: string
  state: 'running' | 'stopped' | 'finished' | 'canceled'
  // Why it stopped, or a note when it had nothing to do.
  reason: string | null
  items: QueueItem[]
  // Accounts that already had a token on both hosts when it started.
  already: number
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

function loadQueue(): SigninQueue | null {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) as SigninQueue
    if (!q || typeof q !== 'object' || !Array.isArray(q.items)) return null
    if (q.state === 'running') {
      q.state = 'stopped'
      q.reason = 'Valkyrie restarted during setup; press Continue'
      for (const i of q.items) if (i.status === 'running') i.status = 'waiting'
    }
    return q
  } catch {
    return null
  }
}

let queue: SigninQueue | null = loadQueue()
let advancing = false

function saveQueue(): void {
  if (!queue) return
  queue.updatedAt = now()
  try {
    writePrivate(QUEUE_FILE, JSON.stringify(queue, null, 2))
  } catch (err) {
    console.error('[account-signin] queue write failed:', (err as Error).message)
  }
}

export function getQueue(): SigninQueue | null {
  return queue ? { ...queue, items: queue.items.map((i) => ({ ...i })) } : null
}

export type VaultEntry = { accountId: string; present: boolean; kind: string | null; createdAt: string | null; expiresAt: number | null }

// What the page needs to know about each stored token, read without returning it.
export function vaultStatus(): VaultEntry[] {
  return CLAUDE_ACCOUNTS.map((a) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, `${a.id}.json`), 'utf8')) as Record<string, unknown>
      return {
        accountId: a.id,
        present: typeof r.accessToken === 'string' && r.accessToken.length > 0,
        kind: typeof r.kind === 'string' ? r.kind : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
        expiresAt: typeof r.expiresAt === 'number' ? r.expiresAt : null,
      }
    } catch {
      return { accountId: a.id, present: false, kind: null, createdAt: null, expiresAt: null }
    }
  })
}

// What each account still needs: a sign-in (no usable token on odin), a copy to thor (odin has
// it, thor's vault does not), or nothing.
export function setupPlan(only?: string[]): { items: QueueItem[]; already: number } {
  const vault = vaultStatus()
  const dead = new Set(link?.deadIds() ?? [])
  const thorIds = link?.thorVaultIds() ?? null
  const items: QueueItem[] = []
  let already = 0
  for (const a of CLAUDE_ACCOUNTS) {
    if (only && !only.includes(a.id)) continue
    const v = vault.find((x) => x.accountId === a.id)
    const usable = !!v?.present && !dead.has(a.id) && (v.expiresAt == null || v.expiresAt - Date.now() > EXPIRING_MS)
    const base = { accountId: a.id, label: a.label, status: 'waiting' as const, detail: null, requestId: null }
    if (!usable) {
      if (!a.email) continue
      items.push({ ...base, kind: 'signin' })
    } else if (thorIds && !thorIds.includes(a.id)) {
      items.push({ ...base, kind: 'copy' })
    } else {
      already++
    }
  }
  return { items, already }
}

export async function startQueue(only?: string[]): Promise<SigninQueue> {
  if (queue?.state === 'running') throw new SigninError(409, 'Set up all accounts is already running')
  if (active) throw new SigninError(409, `a sign-in for ${active.req.label} is running; finish or cancel it first`)
  if (only) {
    for (const id of only) if (!CLAUDE_ACCOUNTS.some((a) => a.id === id)) throw new SigninError(404, `no such account: ${id}`)
  }
  const plan = setupPlan(only)
  const t = now()
  queue = {
    id: randomBytes(6).toString('hex'),
    state: plan.items.length ? 'running' : 'finished',
    reason: plan.items.length ? null : 'every account already has a token on odin and thor',
    items: plan.items,
    already: plan.already,
    startedAt: t,
    updatedAt: t,
    finishedAt: plan.items.length ? null : t,
  }
  saveQueue()
  console.log(`[account-signin] setup ${queue.id} start: ${plan.items.map((i) => `${i.accountId}:${i.kind}`).join(' ') || 'nothing to do'}`)
  void advance()
  return getQueue()!
}

export function cancelQueue(): SigninQueue {
  if (!queue || queue.state !== 'running') throw new SigninError(409, 'Set up all accounts is not running')
  queue.state = 'canceled'
  queue.reason = 'stopped by hand'
  queue.finishedAt = now()
  saveQueue()
  if (active?.fromQueue) finishRequest(false, 'canceled', 'setup stopped')
  return getQueue()!
}

function stopQueue(reason: string): void {
  if (!queue || queue.state !== 'running') return
  queue.state = 'stopped'
  queue.reason = reason
  queue.finishedAt = now()
  saveQueue()
  console.log(`[account-signin] setup ${queue.id} stopped: ${reason}`)
}

function queueFinished(req: SigninRequest): void {
  if (!queue) return
  const item = queue.items.find((i) => i.requestId === req.id)
    ?? queue.items.find((i) => i.kind === 'signin' && i.accountId === req.accountId && i.status === 'running')
  if (!item) return
  item.requestId = req.id
  item.status = req.ok ? 'done' : 'failed'
  item.detail = req.detail
  saveQueue()
  if (queue.state !== 'running') return
  if (!req.ok) {
    const why = req.stage === 'expired' ? `no code was pasted for ${req.label} in time` : `${req.label}: ${req.detail ?? req.stage}`
    stopQueue(why)
    return
  }
  dmLead = `${req.label} is set up.`
  setTimeout(() => { void advance() }, QUEUE_NEXT_MS)
}

async function advance(): Promise<void> {
  if (advancing) return
  advancing = true
  try {
    for (;;) {
      if (!queue || queue.state !== 'running' || active) return
      const next = queue.items.find((i) => i.status === 'waiting')
      if (!next) {
        queue.state = 'finished'
        queue.reason = null
        queue.finishedAt = now()
        saveQueue()
        const n = queue.items.filter((i) => i.status === 'done').length
        console.log(`[account-signin] setup ${queue.id} finished`)
        if (n) {
          dmLead = null
          const hosts = link?.notAdopted() ?? ['thor']
          const next = hosts.length
            ? `Next: press Resume on ${hosts.join(' and ')} in Valkyrie, AI > Usage: ${PUBLIC_URL}/m/ai/usage`
            : 'Auto-switch can use them now.'
          await dm(`Claude setup done: ${n} ${n === 1 ? 'account is' : 'accounts are'} signed in for a year. ${next}`)
        }
        return
      }
      if (next.kind === 'copy') {
        next.status = 'running'
        saveQueue()
        let ok = false
        try { ok = await syncThorVault(next.accountId) } catch { ok = false }
        next.status = ok ? 'done' : 'failed'
        next.detail = ok ? 'copied to thor' : 'thor did not answer; use Copy to thor later'
        saveQueue()
        // odin has the token, so a failed copy does not stop the rest.
        continue
      }
      const signins = queue.items.filter((i) => i.kind === 'signin')
      next.status = 'running'
      saveQueue()
      try {
        const r = await startSignin({ accountId: next.accountId, mode: 'token', auto: false, queuePos: { n: signins.indexOf(next) + 1, of: signins.length } })
        next.requestId ??= r.id
        saveQueue()
      } catch (err) {
        next.status = 'failed'
        next.detail = (err as Error).message
        saveQueue()
        stopQueue(`${next.label}: ${(err as Error).message}`)
      }
      return
    }
  } finally {
    advancing = false
  }
}
