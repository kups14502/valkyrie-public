import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { CLAUDE_ACCOUNTS, type ClaudeAccount } from './claudeAccounts.js'

// Automated Claude sign-in, one account at a time, without anyone pasting codes.
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
// Flow: the CLI runs here in a throwaway tmux pane on its own socket (never Valkyrie's), its
// authorize URL goes to thor, where C:\Thor\tools\account-switch\browser-signin.mjs signs in with
// the headless browser and the tenant mailbox (the claude.ai email is a magic link) and answers
// with code#state, which is pasted into the pane. When thor cannot finish (bot check, a mailbox
// outside the tenant, thor asleep), Lil kups DMs Brendon the authorize URL and the sign-in waits
// for him to paste code#state into AI > Usage (POST /api/account-switch/signin/:id/code).
//
// Measured 2026-10-18: the thor leg gets through Cloudflare, "Continue with email", the magic link
// (about 6 to 9 s via Graph) and the verification code, and then claude.ai shows a visible
// hCaptcha challenge. The thor leg stops there and never tries to solve one, so in practice every
// sign-in ends in the one-tap DM; the route therefore defaults to auto:false. Pool tokens last a
// year, so that is one tap per account per year. An account whose mailbox is outside the work
// tenant is always one-tap.
//
// Secrets: the authorize URL, code#state and the token live in memory, in tmux's buffer for a
// moment, and in the vault files. None of them is logged, returned by a route, or put on a
// command line; they cross process boundaries on stdin only.

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
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  ok: boolean | null
  // token mode: which vaults hold the new token, and whether a probe accepted it.
  vault: { odin: boolean; thor: boolean | null; probeStatus: number | null } | null
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
const LILKUPS_BIN = process.env.LILKUPS_BIN || path.join(HOME, 'lilkups', 'lilkups')
const SSH_BIN = process.env.VALKYRIE_SSH_BIN || '/usr/bin/ssh'
const THOR = `${process.env.THOR_SSH_USER || 'brendon'}@${process.env.THOR_SSH_HOST || process.env.THOR_LAUNCHER_HOST || '100.118.7.57'}`
const THOR_TOOLS = process.env.ACCOUNT_SWITCH_THOR_TOOLS || 'C:/Thor/tools/account-switch'

const DEBUG = process.env.ACCOUNT_SWITCH_DEBUG === '1'
const URL_WAIT_MS = 30_000
const BROWSER_LEG_MS = 7 * 60_000
const CODE_WAIT_MS = 20 * 60_000
const RESULT_WAIT_MS = 60_000
const MAX_PER_ACCOUNT_PER_DAY = 3
const HISTORY = 20
// The usage poller's refresh lock (routes/aiUsage.ts); stale after 60 s there.
const CARD_LOCK = '.credentials.refresh.lock'

const ID_RE = /^[0-9a-f]{12}$/
const CODE_RE = /^[A-Za-z0-9_-]{10,}#[A-Za-z0-9_-]{10,}$/
// The CLI token shape: two, three and three lowercase letters plus two digits, then the body.
const TOKEN_RE = /\b[a-z]{2}-[a-z]{3}-[a-z]{3}\d{2}-[A-Za-z0-9_-]{40,}/

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

const requests: SigninRequest[] = []
let active: { req: SigninRequest; session: string; scratch: string | null; account: ClaudeAccount; url: string | null; settle: ((code: string) => void) | null } | null = null
const startsByAccount = new Map<string, number[]>()

const now = () => new Date().toISOString()
const log = (req: SigninRequest, what: string) => console.log(`[account-signin] ${req.id} ${req.accountId} ${req.mode} ${what}`)

function update(req: SigninRequest, patch: Partial<SigninRequest>): void {
  Object.assign(req, patch, { updatedAt: now() })
}

export function listSignins(): SigninRequest[] {
  return requests.map((r) => ({ ...r, vault: r.vault ? { ...r.vault } : null }))
}

export function getSignin(id: string): SigninRequest | null {
  const r = requests.find((x) => x.id === id)
  return r ? { ...r, vault: r.vault ? { ...r.vault } : null } : null
}

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
  try {
    for (const name of fs.readdirSync(SCRATCH_ROOT)) fs.rmSync(path.join(SCRATCH_ROOT, name), { recursive: true, force: true })
  } catch { /* none yet */ }
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
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
}

export async function startSignin(opts: StartOpts): Promise<SigninRequest> {
  const account = CLAUDE_ACCOUNTS.find((a) => a.id === opts.accountId)
  if (!account) throw new SigninError(404, 'no such account')
  if (opts.mode !== 'token' && opts.mode !== 'login') throw new SigninError(400, 'mode must be token or login')
  if (!account.email) throw new SigninError(400, 'the account has no email in claude-accounts.json')
  if (active) throw new SigninError(409, `a sign-in for ${active.req.label} is already running`)
  const day = Date.now() - 86_400_000
  const recent = (startsByAccount.get(account.id) ?? []).filter((t) => t > day)
  if (recent.length >= MAX_PER_ACCOUNT_PER_DAY && !opts.dryRun) {
    throw new SigninError(429, `${MAX_PER_ACCOUNT_PER_DAY} sign-ins for this account in 24 hours already; repeated sign-in mail can get an account flagged`)
  }

  const target = opts.mode === 'login' ? path.resolve(opts.configDir || account.configDir) : 'vault'
  if (opts.mode === 'login' && !fs.existsSync(target)) throw new SigninError(400, 'the config dir does not exist')

  await sweepStale()
  ensurePrivateDir(SCRATCH_ROOT)
  const id = randomBytes(6).toString('hex')
  const session = `si-${id}`
  const scratch = opts.mode === 'token' ? path.join(SCRATCH_ROOT, id) : null
  if (scratch) ensurePrivateDir(scratch)

  const req: SigninRequest = {
    id, accountId: account.id, label: account.label, email: account.email, mode: opts.mode, target,
    stage: 'starting', detail: null, fallbackReason: null, needsCode: false, dmSent: false,
    startedAt: now(), updatedAt: now(), finishedAt: null, ok: null,
    vault: opts.mode === 'token' ? { odin: false, thor: null, probeStatus: null } : null,
  }
  requests.unshift(req)
  requests.splice(HISTORY)
  if (!opts.dryRun) startsByAccount.set(account.id, [...recent, Date.now()])
  active = { req, session, scratch, account, url: null, settle: null }
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
  const started = await tmux([
    'new-session', '-d', '-s', session, '-x', '1000', '-y', '50',
    'env', '-u', 'ANTHROPIC_API_KEY', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', `CLAUDE_CONFIG_DIR=${configDir}`, ...cli,
    ';', 'set-option', '-t', session, 'remain-on-exit', 'on',
  ])
  if (started.code !== 0) throw new Error('could not start the sign-in pane: ' + started.stderr.trim().slice(0, 160))

  const until = Date.now() + URL_WAIT_MS
  while (!a.url && Date.now() < until) {
    await sleep(500)
    const m = (await capture(session)).match(/https:\/\/\S*\/oauth\/authorize\?\S+/)
    if (m) a.url = m[0]
  }
  if (!a.url) throw new Error('the CLI printed no authorize URL')
  if (active !== a) return

  let reason = 'manual'
  if (opts.auto !== false) {
    update(req, { stage: 'browser', detail: 'thor: starting' })
    const leg = await browserLeg(a.url, req, opts.dryRun === true)
    if (active !== a) return
    if (leg.code) {
      await finishWithCode(leg.code)
      return
    }
    reason = leg.reason
    if (opts.dryRun) { finishRequest(false, 'failed', `dry run stopped at ${reason}`); return }
  }
  await waitForPerson(reason)
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

async function dm(text: string): Promise<boolean> {
  try {
    // --message - reads stdin, so the authorize URL is never on a command line; lilkups logs the
    // length only.
    const r = await run(LILKUPS_BIN, ['send', '--message', '-'], { input: text, timeoutMs: 20_000 })
    return r.code === 0
  } catch {
    return false
  }
}

async function waitForPerson(reason: string): Promise<void> {
  const a = active!
  const { req } = a
  const expires = Date.now() + CODE_WAIT_MS
  const why: Record<string, string> = {
    manual: 'you asked for the manual sign-in',
    'mailbox-not-in-tenant': 'its mailbox is outside the work tenant, so the sign-in mail cannot be read automatically',
    captcha: 'claude.ai showed a captcha',
    cloudflare: 'Cloudflare blocked the headless browser',
    'no-email': 'the sign-in email did not arrive',
    'thor-unreachable': 'thor did not answer over ssh',
    'thor-timeout': 'the automated sign-in on thor took too long',
  }
  const text = [
    `Claude sign-in needed for ${req.label} (${req.email}): ${why[reason] ?? `the automated sign-in stopped (${reason})`}.`,
    `1. Open this in a private window and sign in as ${req.email}:`,
    a.url!,
    '2. Press Authorize and copy the code it shows.',
    `3. Paste the code in Valkyrie, AI > Usage. It waits until ${NY.format(expires)} ET.`,
  ].join('\n')
  const dmSent = await dm(text)
  if (active !== a) return
  update(req, { stage: 'needs-code', needsCode: true, fallbackReason: reason, dmSent, detail: dmSent ? 'waiting for the pasted code' : 'waiting for the pasted code (the DM failed)' })
  log(req, `needs-code reason=${reason} dm=${dmSent}`)

  const code = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => { a.settle = null; resolve(null) }, CODE_WAIT_MS)
    a.settle = (c: string) => { clearTimeout(timer); a.settle = null; resolve(c) }
  })
  if (active !== a) return
  if (!code) { finishRequest(false, 'expired', 'nobody pasted a code in time'); return }
  await finishWithCode(code)
}

export async function submitCode(id: string, raw: string): Promise<SigninRequest> {
  if (!ID_RE.test(id)) throw new SigninError(400, 'bad sign-in id')
  const code = String(raw ?? '').replace(/\s+/g, '')
  if (!CODE_RE.test(code)) throw new SigninError(400, 'that is not a code#state from the Claude authorize page')
  if (!active || active.req.id !== id) throw new SigninError(404, 'that sign-in is not running')
  if (!active.settle) throw new SigninError(409, 'that sign-in is not waiting for a code')
  active.settle(code)
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

async function finishWithCode(code: string): Promise<void> {
  const a = active!
  const { req, session } = a
  update(req, { stage: 'finishing', needsCode: false, detail: 'sending the code to the CLI' })

  // login: hold the usage poller's refresh lock while the CLI writes the new grant.
  let lock: string | null = null
  if (req.mode === 'login') {
    for (let i = 0; i < 30 && !lock; i++) {
      lock = takeCardLock(req.target)
      if (!lock) await sleep(1000)
    }
    if (!lock) { finishRequest(false, 'failed', 'the usage poller held the refresh lock for 30 s'); return }
  }
  try {
    const before = await capture(session)
    const buf = `code-${req.id}`
    const loaded = await tmux(['load-buffer', '-b', buf, '-'], code)
    if (loaded.code !== 0) throw new Error('tmux would not take the code')
    await tmux(['paste-buffer', '-d', '-b', buf, '-t', paneOf(session)])
    await sleep(400)
    await tmux(['send-keys', '-t', paneOf(session), 'Enter'])

    const until = Date.now() + RESULT_WAIT_MS
    while (Date.now() < until) {
      await sleep(1000)
      if (active !== a) return
      const text = await capture(session)
      if (req.mode === 'token') {
        const token = extractToken(text)
        if (token) {
          const validFor = text.match(/valid for ([^)\n]{1,40})\)/i)?.[1]?.trim() ?? null
          await killPane(session)
          await storeToken(token, validFor)
          return
        }
      } else if (/Login successful/i.test(text)) {
        if (lock) { try { fs.unlinkSync(lock) } catch { /* swept */ } lock = null }
        await confirmLogin()
        return
      }
      const failed = text.match(/(Login failed[^\n]*|OAuth error[^\n]*|Invalid code[^\n]*|Error:[^\n]*)/i)
      if (failed && !before.includes(failed[1])) { finishRequest(false, 'failed', scrub(failed[1])); return }
    }
    finishRequest(false, 'failed', 'the CLI did not confirm within a minute')
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

type Probe = { status: number; sessionPct: number | null; weeklyPct: number | null }

// One 1-token Haiku call, the same probe the usage cards make.
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
  const pct = (h: string) => { const v = resp.headers.get(h); return v == null ? null : Math.round(Number(v) * 100) }
  return { status: resp.status, sessionPct: pct('anthropic-ratelimit-unified-5h-utilization'), weeklyPct: pct('anthropic-ratelimit-unified-7d-utilization') }
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
  return writeThorVault(record)
}

async function storeToken(token: string, validFor: string | null): Promise<void> {
  const a = active!
  const { req, account } = a
  update(req, { detail: 'checking the new token' })
  let p: Probe | null = null
  try { p = await probe(token) } catch { /* recorded as null */ }
  if (p && (p.status === 401 || p.status === 403)) {
    finishRequest(false, 'failed', `the new token was refused (${p.status})`)
    return
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
  const thor = await writeThorVault(record)
  update(req, { vault: { odin: true, thor, probeStatus: p?.status ?? null } })
  finishRequest(true, 'done', `token stored on odin${thor ? ' and thor' : '; thor did not answer, retry with sync'}${p ? `, probe ${p.status}` : ''}`)
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
}
