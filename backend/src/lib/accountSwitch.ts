import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CLAUDE_ACCOUNTS } from './claudeAccounts.js'
import { linkSwitcher } from './accountSignin.js'
import { capturePane, listSessions, paneInMode, remoteLabel, SSH_BIN, typeLine } from '../terminal/tmux.js'
import {
  ACCOUNT_ID_RE, HOSTS, buildLiveCredentials, classifyLimitText, countRecent, decide, eligibility, exhaustedMessage,
  fmtET, normalizeConfig, ownerOf, paneLimitState, parsePoolToken, parseRateLimitHeaders, pausedMessage,
  pickTarget, switchMessage,
  type AccountView, type Decision, type HostName, type HostView, type LimitEvent, type LimitKind, type Owner,
  type PoolToken, type Quota, type QuotaRead, type SwitchConfig,
} from './accountSwitchCore.js'

const exec = promisify(execFile)

// The Claude account switcher. When the account a host's terminals use gets
// near its 5-hour limit (or a session hits it), it writes another account's
// pool token into that host's one live credential file, then types a
// continue into the Valkyrie panes that stopped on the limit. Sessions in
// thor's own Windows Terminal tabs are not Valkyrie panes (no tmux here can
// see them): thor's StopFailure hook queues each one, and thor's
// Continue-Stopped.ps1 types the continue there once continueCheck() says the
// active account has room. The rules are in accountSwitchCore.ts; this file
// is the I/O around them.
//
// Everything lives in ~/.config/claude-switch (dir 700, files 600, outside
// every repo):
//   config.json    what accountSwitchCore.normalizeConfig reads; absent = off
//   state.json     per host: active account, owner, pause, switch times
//   switches.log   one JSON line per switch, dry run, block, pause or error
//   disabled       the kill switch: while this file exists nothing automatic runs
//   tokens/<id>.json  the pool tokens (written by the sign-in automation)
//   live/.credentials.json  odin's live store; ODIN_WRAP in terminal/tmux.ts
//                  points odin panes at it once it exists
// thor's live file is C:\Users\Brendon\.claude\.credentials.json, written by
// C:\Thor\tools\account-switch\Set-ClaudeAccount.ps1 from thor's own vault,
// so a token never crosses the wire at switch time. Only an account id does.
//
// Never logged, printed or sent anywhere: a token, or any part of one.

const BASE = process.env.CLAUDE_SWITCH_DIR || path.join(homedir(), '.config', 'claude-switch')
const P = {
  config: path.join(BASE, 'config.json'),
  state: path.join(BASE, 'state.json'),
  log: path.join(BASE, 'switches.log'),
  kill: path.join(BASE, 'disabled'),
  lock: path.join(BASE, 'switch.lock'),
  vault: process.env.CLAUDE_SWITCH_VAULT || path.join(BASE, 'tokens'),
  // Must stay the path ODIN_WRAP tests. The override exists for tests only.
  odinLive: process.env.CLAUDE_SWITCH_ODIN_LIVE || path.join(homedir(), '.config', 'claude-switch', 'live'),
}
const API_BASE = (process.env.CLAUDE_SWITCH_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '')
const PROBE_MODEL = process.env.CLAUDE_SWITCH_PROBE_MODEL || 'claude-haiku-4-5-20251001'
const THOR_SCRIPT = process.env.CLAUDE_SWITCH_THOR_SCRIPT || 'C:/Thor/tools/account-switch/Set-ClaudeAccount.ps1'
const DM_TARGET = process.env.CLAUDE_SWITCH_DM_TARGET || 'user:193470714848739328'
const LILKUPS = process.env.LILKUPS_BIN || '/home/brendon/lilkups/lilkups'
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`

const TICK_MS = 60_000
const ACTIVE_PROBE_MS = 55_000
const OTHER_PROBE_MS = 10 * 60_000
const OTHER_PROBES_PER_TICK = 2
const TARGET_PROBE_MS = 60_000
const THOR_CHECK_MS = 5 * 60_000
const USAGE_CACHE_MS = 60_000
const LOCK_STALE_MS = 180_000
const CC_LOCK_STALE_MS = 60_000
const LOG_MAX_BYTES = 1_000_000
const EVENT_KEEP_MS = 30 * 60_000
const FAILED_RETRY_MS = 15 * 60_000
const SWEEP_MS = 60_000
const SWEEP_COOLDOWN_MS = 5 * 60_000

// ------------------------------------------------------------------ state --

type HostState = {
  active: string | null
  owner: Owner | null
  // The switcher may overwrite this host's live file. Set by Resume or a
  // manual switch, never on its own: the first write replaces whatever
  // sign-in the host had.
  adopted: boolean
  paused: boolean
  pausedReason: string | null
  lastSwitchAt: number | null
  lastDryRunAt: number | null
  switches: number[]
  checkedAt: number | null
  lastError: string | null
  lastBlocked: string | null
  // thor only: the ids its own vault holds, from the last -Status. An account
  // missing there cannot be switched to on thor, whatever odin's vault says.
  vaultIds: string[] | null
  // Account id -> when a write of it failed on this host. Not retried for
  // FAILED_RETRY_MS, so one broken entry is not hammered every minute.
  failed: Record<string, number>
}

type ProbeRec = { at: number; httpStatus: number; quota: Quota | null }

type State = {
  version: 1
  hosts: Record<HostName, HostState>
  probes: Record<string, ProbeRec>
  // Account id -> when its pool token was refused (401/403).
  dead: Record<string, number>
  // DM and log dedupe keys -> when.
  notified: Record<string, number>
}

const NOT_ADOPTED = 'not adopted yet: press Resume to let the switcher take over this host'

const freshHost = (): HostState => ({
  active: null, owner: null, adopted: false, paused: true, pausedReason: NOT_ADOPTED,
  lastSwitchAt: null, lastDryRunAt: null, switches: [], checkedAt: null, lastError: null, lastBlocked: null,
  vaultIds: null, failed: {},
})

function ensureBase(): void {
  mkdirSync(BASE, { recursive: true, mode: 0o700 })
  try { chmodSync(BASE, 0o700) } catch { /* not ours to fix */ }
}

function writeDurable(file: string, text: string): void {
  ensureBase()
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function loadState(): State {
  const raw = (readJson(P.state) ?? {}) as Partial<State>
  const hosts = {} as Record<HostName, HostState>
  for (const h of HOSTS) hosts[h] = { ...freshHost(), ...((raw.hosts as Record<string, Partial<HostState>> | undefined)?.[h] ?? {}) }
  return {
    version: 1,
    hosts,
    probes: raw.probes && typeof raw.probes === 'object' ? raw.probes : {},
    dead: raw.dead && typeof raw.dead === 'object' ? raw.dead : {},
    notified: raw.notified && typeof raw.notified === 'object' ? raw.notified : {},
  }
}

/** The newest pool-token probe for an account: the usage card's reading when the account's own sign-in is dead. */
export function poolProbe(id: string): { quota: Quota; at: number } | null {
  const p = loadState().probes[id]
  return p?.quota ? { quota: p.quota, at: p.at } : null
}

function saveState(s: State): void {
  const now = Date.now()
  for (const h of HOSTS) s.hosts[h].switches = s.hosts[h].switches.filter((t) => now - t < 7 * 86_400_000).slice(-100)
  for (const [k, t] of Object.entries(s.notified)) if (now - t > 7 * 86_400_000) delete s.notified[k]
  writeDurable(P.state, JSON.stringify(s, null, 2))
}

export function readConfig(): SwitchConfig {
  return normalizeConfig(readJson(P.config))
}

export const killed = (): boolean => existsSync(P.kill)

// ------------------------------------------------------------------- log ---

export type LogKind = 'switch' | 'manual' | 'adopt' | 'dry-run' | 'blocked' | 'exhausted' | 'paused' | 'error' | 'config' | 'continue'
export type LogEntry = {
  at: string
  kind: LogKind
  host: HostName | null
  from: string | null
  to: string | null
  reason: string
  ok: boolean
  fromPct?: number | null
  toPct?: number | null
  nudged?: number
  detail?: string
}

function writeLog(e: Omit<LogEntry, 'at'>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...e })
  try {
    ensureBase()
    appendFileSync(P.log, line + '\n', { mode: 0o600 })
    if (statSync(P.log).size > LOG_MAX_BYTES) {
      const keep = readFileSync(P.log, 'utf8').split('\n').filter(Boolean).slice(-2000)
      writeDurable(P.log, keep.join('\n') + '\n')
    }
  } catch (err) {
    console.error('[account-switch] log write failed', (err as Error).message)
  }
  console.log(`[account-switch] ${e.kind} ${e.host ?? '-'} ${e.from ?? '-'} -> ${e.to ?? '-'}: ${e.reason}${e.ok ? '' : ' (failed)'}`)
}

export function readLog(limit = 50): LogEntry[] {
  try {
    return readFileSync(P.log, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, limit)))
      .map((l) => { try { return JSON.parse(l) as LogEntry } catch { return null } })
      .filter((e): e is LogEntry => e !== null)
      .reverse()
  } catch {
    return []
  }
}

// ------------------------------------------------------------- notify ----

async function dm(text: string): Promise<void> {
  try {
    await exec(LILKUPS, ['send', '--target', DM_TARGET, '--message=' + text], { timeout: 15_000 })
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: unknown }
    const why = String(e.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? `exit ${String(e.code ?? '?')}`
    console.error('[account-switch] Lil kups DM failed:', why.slice(0, 200))
  }
}

// One DM per key per window, so a condition that holds for an hour is one
// message, not sixty.
async function dmOnce(s: State, key: string, windowMs: number, text: string): Promise<boolean> {
  const at = s.notified[key]
  if (at && Date.now() - at < windowMs) return false
  s.notified[key] = Date.now()
  await dm(text)
  return true
}

// --------------------------------------------------------------- vault ----

let vaultCache: { sig: string; tokens: Map<string, PoolToken> } | null = null

export type VaultHealth = { dir: string; exists: boolean; modeOk: boolean; entries: number; badFiles: string[] }

function vaultSig(): string {
  try {
    return readdirSync(P.vault)
      .filter((f) => f.endsWith('.json'))
      .map((f) => `${f}:${statSync(path.join(P.vault, f)).mtimeMs}`)
      .join('|')
  } catch {
    return 'none'
  }
}

function loadPool(): Map<string, PoolToken> {
  const sig = vaultSig()
  if (vaultCache && vaultCache.sig === sig) return vaultCache.tokens
  const tokens = new Map<string, PoolToken>()
  try {
    for (const f of readdirSync(P.vault)) {
      const id = f.replace(/\.json$/, '')
      if (!f.endsWith('.json') || !ACCOUNT_ID_RE.test(id)) continue
      try {
        const t = parsePoolToken(readFileSync(path.join(P.vault, f), 'utf8'), id)
        if (t) tokens.set(id, t)
      } catch { /* unreadable entry: reported by vaultHealth */ }
    }
  } catch { /* no vault yet */ }
  vaultCache = { sig, tokens }
  return tokens
}

export function vaultHealth(): VaultHealth {
  const h: VaultHealth = { dir: P.vault, exists: false, modeOk: false, entries: 0, badFiles: [] }
  try {
    const st = statSync(P.vault)
    h.exists = st.isDirectory()
    let ok = (st.mode & 0o077) === 0
    for (const f of readdirSync(P.vault)) {
      if (!f.endsWith('.json')) continue
      const fp = path.join(P.vault, f)
      if ((statSync(fp).mode & 0o077) !== 0) ok = false
      const id = f.replace(/\.json$/, '')
      let parsed: PoolToken | null = null
      try { parsed = ACCOUNT_ID_RE.test(id) ? parsePoolToken(readFileSync(fp, 'utf8'), id) : null } catch { parsed = null }
      if (parsed) h.entries++
      else h.badFiles.push(f)
    }
    h.modeOk = ok
  } catch { /* missing */ }
  return h
}

// --------------------------------------------------------------- probes ----

// One 1-token Haiku request with the pool token; the answer's headers carry
// the account's 5-hour and weekly utilization. A 429 still carries them.
async function probe(t: PoolToken): Promise<ProbeRec> {
  const at = Date.now()
  try {
    const resp = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${t.accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
      signal: AbortSignal.timeout(20_000),
    })
    const quota = parseRateLimitHeaders((n) => resp.headers.get(n))
    await resp.arrayBuffer().catch(() => undefined)
    return { at, httpStatus: resp.status, quota }
  } catch (err) {
    console.error(`[account-switch] probe failed (${t.id}):`, (err as Error).name)
    return { at, httpStatus: 0, quota: null }
  }
}

async function probeInto(s: State, t: PoolToken): Promise<ProbeRec> {
  const r = await probe(t)
  if (r.httpStatus === 401 || r.httpStatus === 403) {
    if (!s.dead[t.id]) {
      s.dead[t.id] = r.at
      writeLog({ kind: 'error', host: null, from: null, to: t.id, reason: `pool token refused (${r.httpStatus})`, ok: false })
      await dmOnce(s, `dead:${t.id}`, 86_400_000, `Claude auto-switch: the pool token for ${labelOf(t.id)} was refused (${r.httpStatus}). It is out of the rotation until it is provisioned again.`)
    }
  } else if (r.quota) {
    delete s.dead[t.id]
  }
  if (r.quota || r.httpStatus) s.probes[t.id] = r
  return r
}

type UsageClient = { id: string; quota: Quota | null; authError?: string | null }
let usageCache: { at: number; dataAt: number; clients: UsageClient[] } | null = null

// The backend's own per-account readings (its grants, polled every 5 min),
// fetched the way alerts.ts does it. Spares a probe per account.
async function fetchUsage(): Promise<typeof usageCache> {
  if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache
  try {
    const r = await fetch(`${BACKEND}/api/ai-usage`, { headers: { 'X-Alerts-Internal': '1' }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json() as { aiClients?: UsageClient[]; updatedAt?: string }
    const dataAt = j.updatedAt ? Date.parse(j.updatedAt) : Date.now()
    usageCache = { at: Date.now(), dataAt: Number.isFinite(dataAt) ? dataAt : Date.now(), clients: j.aiClients ?? [] }
  } catch {
    usageCache = usageCache ?? null
  }
  return usageCache
}

const labelOf = (id: string | null): string => {
  if (!id) return 'none'
  return CLAUDE_ACCOUNTS.find((a) => a.id === id)?.label ?? id
}

function accountIds(pool: Map<string, PoolToken>): string[] {
  const out = CLAUDE_ACCOUNTS.map((a) => a.id)
  for (const id of pool.keys()) if (!out.includes(id)) out.push(id)
  return out
}

function readingFor(s: State, id: string): QuotaRead | null {
  const p = s.probes[id]
  const own: QuotaRead | null = p?.quota ? { quota: p.quota, at: p.at, source: 'probe' } : null
  const u = usageCache?.clients.find((c) => c.id === id)
  const theirs: QuotaRead | null = u?.quota && !u.authError
    ? { quota: { ...u.quota, status: u.quota.status ?? null }, at: usageCache!.dataAt, source: 'usage' }
    : null
  if (own && theirs) return own.at >= theirs.at ? own : theirs
  return own ?? theirs
}

// The accounts as one host can use them: with a host, an account thor's own
// vault lacks, or one whose write just failed there, has no usable token.
function views(s: State, pool: Map<string, PoolToken>, h?: HostName): AccountView[] {
  const hs = h ? s.hosts[h] : null
  const now = Date.now()
  return accountIds(pool).map((id) => {
    const t = pool.get(id)
    const missingThere = Boolean(hs && h === 'thor' && hs.vaultIds && !hs.vaultIds.includes(id))
    const failedThere = Boolean(hs && hs.failed[id] && now - hs.failed[id] < FAILED_RETRY_MS)
    return {
      id,
      label: labelOf(id),
      token: { present: Boolean(t) && !missingThere, dead: Boolean(s.dead[id]) || failedThere, expiresAt: t?.expiresAt ?? null },
      quota: readingFor(s, id),
    }
  })
}

// ------------------------------------------------------------- hosts -----

type HostCheck = { owner: Owner; account: string | null; error?: string; vaultIds?: string[] }
type ApplyResult = { ok: true; previous: string | null } | { ok: false; refused: boolean; error: string }

async function thorScript(args: string[], timeoutMs = 45_000): Promise<Record<string, unknown>> {
  for (const a of args) if (!/^-?[A-Za-z0-9][A-Za-z0-9-]*$/.test(a)) throw new Error('bad argument for thor')
  const remote = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', THOR_SCRIPT, ...args].join(' ')
  let stdout = ''
  try {
    ;({ stdout } = await exec(SSH_BIN, [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR',
      remoteLabel(), remote,
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }))
  } catch (err) {
    const e = err as Error & { stdout?: string; code?: unknown; killed?: boolean }
    stdout = String(e.stdout ?? '')
    if (!stdout.trim()) throw new Error(e.killed ? 'thor timed out' : `ssh to thor failed (exit ${String(e.code ?? '?')})`)
  }
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error('thor answered nothing readable')
  return JSON.parse(line) as Record<string, unknown>
}

const OWNERS: Owner[] = ['pool', 'grant', 'unknown', 'missing', 'unreachable']

async function checkThor(): Promise<HostCheck> {
  try {
    const j = await thorScript(['-Status'])
    const owner = OWNERS.includes(j.owner as Owner) ? j.owner as Owner : 'unknown'
    const account = typeof j.account === 'string' && ACCOUNT_ID_RE.test(j.account) ? j.account : null
    const vaultIds = Array.isArray(j.vault) ? j.vault.filter((v): v is string => typeof v === 'string' && ACCOUNT_ID_RE.test(v)) : undefined
    return { owner, account, vaultIds }
  } catch (err) {
    return { owner: 'unreachable', account: null, error: (err as Error).message }
  }
}

const odinLiveFile = () => path.join(P.odinLive, '.credentials.json')

function checkOdin(pool: Map<string, PoolToken>): HostCheck {
  let raw: string | null = null
  try { raw = readFileSync(odinLiveFile(), 'utf8') } catch { raw = null }
  return ownerOf(raw, [...pool.values()])
}

async function checkHost(h: HostName, pool: Map<string, PoolToken>): Promise<HostCheck> {
  return h === 'thor' ? checkThor() : checkOdin(pool)
}

// Claude Code's own refresh locks on a credential store: proper-lockfile
// mkdir locks at <store>/.oauth_refresh.lock and the legacy <store>.lock,
// stale after 60 s. Holding both while the file is swapped means no Claude
// Code refresh can interleave with the write.
async function withClaudeLocks<T>(storeDir: string, fn: () => T): Promise<T> {
  const locks = [path.join(storeDir, '.oauth_refresh.lock'), `${storeDir.replace(/[\\/]+$/, '')}.lock`]
  const held: string[] = []
  const deadline = Date.now() + 15_000
  try {
    for (const l of locks) {
      for (;;) {
        try {
          mkdirSync(l)
          held.push(l)
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          try {
            if (Date.now() - statSync(l).mtimeMs > CC_LOCK_STALE_MS) { rmdirSync(l); continue }
          } catch { continue }
          if (Date.now() > deadline) throw new Error('Claude Code holds the credential lock')
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }
    return fn()
  } finally {
    for (const l of held.reverse()) { try { rmdirSync(l) } catch { /* gone */ } }
  }
}

async function applyOdin(t: PoolToken, pool: Map<string, PoolToken>, adopt: boolean): Promise<ApplyResult> {
  try {
    mkdirSync(P.odinLive, { recursive: true, mode: 0o700 })
    try { chmodSync(P.odinLive, 0o700) } catch { /* ignore */ }
    return await withClaudeLocks(P.odinLive, (): ApplyResult => {
      const file = odinLiveFile()
      let raw: string | null = null
      try { raw = readFileSync(file, 'utf8') } catch { raw = null }
      const before = ownerOf(raw, [...pool.values()])
      if (!adopt && (before.owner === 'grant' || before.owner === 'unknown')) {
        return { ok: false, refused: true, error: before.owner === 'grant' ? 'the live sign-in came from /login' : 'the live token is in no vault entry' }
      }
      const tmp = `${file}.${process.pid}.swap`
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeFileSync(fd, buildLiveCredentials(raw, t, Date.now()))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      const after = ownerOf(readFileSync(file, 'utf8'), [t])
      if (after.owner !== 'pool' || after.account !== t.id) return { ok: false, refused: false, error: 'read-back did not match' }
      return { ok: true, previous: before.account }
    })
  } catch (err) {
    return { ok: false, refused: false, error: (err as Error).message }
  }
}

async function applyThor(id: string, adopt: boolean): Promise<ApplyResult> {
  try {
    const j = await thorScript(['-Account', id, ...(adopt ? ['-Adopt'] : [])])
    if (j.ok === true && j.account === id) return { ok: true, previous: typeof j.previous === 'string' ? j.previous : null }
    const code = String(j.error ?? 'failed')
    return { ok: false, refused: code === 'grant' || code === 'unknown', error: String(j.detail ?? code).slice(0, 200) }
  } catch (err) {
    return { ok: false, refused: false, error: (err as Error).message }
  }
}

async function applyHost(h: HostName, t: PoolToken, pool: Map<string, PoolToken>, adopt: boolean): Promise<ApplyResult> {
  return h === 'thor' ? applyThor(t.id, adopt) : applyOdin(t, pool, adopt)
}

// --------------------------------------------------------------- nudge ----

// Limit events the hook reported, per host, kept for the "outside Valkyrie"
// count after the next switch. Memory only.
const events: Array<{ host: HostName; at: number; sessionId: string; limit: LimitKind }> = []

// When the sweep last typed into each pane. Memory only.
const nudgedAt = new Map<string, number[]>()
// A pane the sweep keeps continuing and that keeps stopping is on a sign-in
// the switch does not reach (an odin pane started before the live store
// existed reads ~/.claude). Three tries an hour, then it is left alone.
const SWEEP_MAX_PER_HOUR = 3

// cooldownMs 0 after a switch: every pane stopped on the old account is
// continued on the new one, and that does not count toward the sweep's
// cooldown. The sweep passes SWEEP_COOLDOWN_MS, so a pane that keeps stopping
// is not typed into every minute.
async function nudgePanes(h: HostName, cfg: SwitchConfig, cooldownMs = 0): Promise<{ nudged: string[]; seenSessions: string[] }> {
  const nudged: string[] = []
  const seenSessions: string[] = []
  let sessions: Awaited<ReturnType<typeof listSessions>> = []
  try { sessions = await listSessions() } catch { sessions = [] }
  for (const s of sessions) {
    if (s.host !== h || s.dead) continue
    if (s.sessionId) seenSessions.push(s.sessionId)
    if (!cfg.nudge) continue
    const recent = (nudgedAt.get(s.name) ?? []).filter((t) => Date.now() - t < 3600_000)
    if (cooldownMs && recent.length && (Date.now() - recent[recent.length - 1] < cooldownMs || recent.length >= SWEEP_MAX_PER_HOUR)) continue
    try {
      if (await paneInMode(s.name)) continue
      const first = await capturePane(s.name)
      if (first === null || !paneLimitState(first).nudge) continue
      // Read it again a moment later: a prompt that changed in between is
      // someone typing, and that pane is theirs.
      await new Promise((r) => setTimeout(r, 1500))
      const second = await capturePane(s.name)
      if (second === null || !paneLimitState(second).nudge || await paneInMode(s.name)) continue
      await typeLine(s.name, cfg.nudgeText)
      if (cooldownMs) nudgedAt.set(s.name, [...recent, Date.now()])
      nudged.push(s.name)
    } catch (err) {
      console.error(`[account-switch] nudge ${s.name} failed:`, (err as Error).message)
    }
  }
  return { nudged, seenSessions }
}

// ---------------------------------------------------------------- lock ----

let chain: Promise<unknown> = Promise.resolve()

// One writer at a time: in this process by a promise chain, across processes
// (a deploy can leave two backends alive for a moment) by an O_EXCL file.
// state.json is read and written only inside it.
function withLock<T>(fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const run = async (): Promise<T> => {
    ensureBase()
    const deadline = Date.now() + waitMs
    for (;;) {
      try {
        closeSync(openSync(P.lock, 'wx', 0o600))
        break
      } catch {
        try {
          if (Date.now() - statSync(P.lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(P.lock); continue }
        } catch { continue }
        if (Date.now() > deadline) throw Object.assign(new Error('another switcher holds the lock'), { status: 409 })
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    try {
      return await fn()
    } finally {
      try { unlinkSync(P.lock) } catch { /* stale sweep */ }
    }
  }
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------- tick ----

function hostView(s: State, h: HostName, cfg: SwitchConfig, now: number): HostView {
  const hs = s.hosts[h]
  return {
    host: h,
    enabled: cfg.hosts[h],
    active: hs.active,
    owner: hs.owner,
    paused: hs.paused,
    pausedReason: hs.pausedReason,
    lastSwitchAt: cfg.dryRun ? hs.lastDryRunAt : hs.lastSwitchAt,
    switchesToday: countRecent(hs.switches, now),
  }
}

function recordCheck(s: State, h: HostName, c: HostCheck): void {
  const hs = s.hosts[h]
  hs.checkedAt = Date.now()
  hs.owner = c.owner
  if (c.owner === 'pool') hs.active = c.account
  else if (c.owner === 'grant' || c.owner === 'unknown' || c.owner === 'missing') hs.active = null
  hs.lastError = c.error ?? null
  if (c.vaultIds) hs.vaultIds = c.vaultIds
}

async function pauseHost(s: State, h: HostName, why: string): Promise<void> {
  const hs = s.hosts[h]
  if (hs.paused) return
  hs.paused = true
  hs.pausedReason = why
  writeLog({ kind: 'paused', host: h, from: hs.active, to: null, reason: why, ok: true })
  await dmOnce(s, `paused:${h}:${why}`, 6 * 3600_000, pausedMessage(h, why))
}

async function doSwitch(
  s: State, h: HostName, d: Extract<Decision, { action: 'switch' }>, cfg: SwitchConfig, pool: Map<string, PoolToken>,
  kind: 'switch' | 'manual' | 'adopt', adopt: boolean,
): Promise<{ ok: boolean; error?: string; nudged: number }> {
  const t = pool.get(d.to)
  if (!t) return { ok: false, error: 'no pool token for the target', nudged: 0 }
  const now = Date.now()
  const fromQ = d.from ? readingFor(s, d.from)?.quota ?? null : null
  const toQ = readingFor(s, d.to)?.quota ?? null
  const hs = s.hosts[h]

  if (kind === 'switch' && cfg.dryRun) {
    hs.lastDryRunAt = now
    writeLog({ kind: 'dry-run', host: h, from: d.from, to: d.to, reason: d.reason, ok: true, fromPct: fromQ?.sessionPct ?? null, toPct: toQ?.sessionPct ?? null })
    await dmOnce(s, `dry:${h}:${d.from}:${d.to}`, 3 * 3600_000, switchMessage({
      host: h, from: d.from ? { label: labelOf(d.from), quota: fromQ } : null, to: { label: labelOf(d.to), quota: toQ },
      reason: d.reason, dryRun: true, nudged: 0, outside: 0,
    }, now))
    return { ok: true, nudged: 0 }
  }

  const r = await applyHost(h, t, pool, adopt)
  if (!r.ok) {
    hs.lastError = r.error
    if (!r.refused) hs.failed[d.to] = Date.now()
    writeLog({ kind: 'error', host: h, from: d.from, to: d.to, reason: d.reason, ok: false, detail: r.error })
    if (r.refused) await pauseHost(s, h, r.error)
    else await dmOnce(s, `err:${h}`, 3600_000, `Claude auto-switch could not switch ${h} to ${labelOf(d.to)}: ${r.error}.`)
    return { ok: false, error: r.error, nudged: 0 }
  }

  hs.active = d.to
  hs.owner = 'pool'
  hs.adopted = true
  if (kind !== 'switch') { hs.paused = false; hs.pausedReason = null }
  hs.lastSwitchAt = now
  hs.switches.push(now)
  hs.checkedAt = now
  hs.lastError = null
  hs.lastBlocked = null
  delete hs.failed[d.to]

  // Running sessions pick the token up on their next request; give the
  // write a moment to land before typing into a stopped pane.
  await new Promise((res) => setTimeout(res, 1000))
  const { nudged, seenSessions } = await nudgePanes(h, cfg)
  const since = now - EVENT_KEEP_MS
  const outsideIds = new Set(events.filter((e) => e.host === h && e.at >= since && e.sessionId && !seenSessions.includes(e.sessionId)).map((e) => e.sessionId))
  for (let i = events.length - 1; i >= 0; i--) if (events[i].host === h) events.splice(i, 1)

  writeLog({
    kind, host: h, from: d.from ?? r.previous, to: d.to, reason: d.reason, ok: true,
    fromPct: fromQ?.sessionPct ?? null, toPct: toQ?.sessionPct ?? null, nudged: nudged.length,
  })
  await dm(switchMessage({
    host: h, from: d.from || r.previous ? { label: labelOf(d.from ?? r.previous), quota: fromQ } : null,
    to: { label: labelOf(d.to), quota: toQ }, reason: d.reason, dryRun: false, nudged: nudged.length, outside: outsideIds.size,
  }, now))
  return { ok: true, nudged: nudged.length }
}

// Re-checks the chosen target with a fresh probe before anything is written,
// and re-decides when the probe says it is no longer a good pick.
async function confirmTarget(
  s: State, h: HostName, first: Decision, cfg: SwitchConfig, pool: Map<string, PoolToken>, event: LimitEvent | null, isKilled: boolean,
): Promise<Decision> {
  let d = first
  const tried = new Set<string>()
  while (d.action === 'switch' && !tried.has(d.to)) {
    tried.add(d.to)
    const t = pool.get(d.to)
    if (!t) break
    const p = s.probes[d.to]
    if (!p || Date.now() - p.at > TARGET_PROBE_MS) await probeInto(s, t)
    const again = decide({ cfg, killed: isKilled, host: hostView(s, h, cfg, Date.now()), accounts: views(s, pool, h), now: Date.now(), event })
    if (again.action === 'switch' && again.to === d.to) return again
    d = again
  }
  return d
}

let tickRunning = false
let tickAgain = false
let pendingEventHosts = new Set<HostName>()

async function tickLocked(force: boolean): Promise<void> {
  const cfg = readConfig()
  const isKilled = killed()
  if (!force && (!cfg.enabled || isKilled)) return
  const eventHosts = pendingEventHosts
  pendingEventHosts = new Set()

  const s = loadState()
  const pool = loadPool()
  const now = Date.now()

  for (const h of HOSTS) {
    if (!cfg.hosts[h]) continue
    const hs = s.hosts[h]
    const due = h === 'odin' || eventHosts.has(h) || !hs.checkedAt || now - hs.checkedAt > THOR_CHECK_MS
    if (!due) continue
    const c = await checkHost(h, pool)
    recordCheck(s, h, c)
    if (hs.adopted && !hs.paused && (c.owner === 'grant' || c.owner === 'unknown')) {
      await pauseHost(s, h, c.owner === 'grant' ? 'the live sign-in came from /login' : 'the live token is in no vault entry')
    }
  }

  // The active accounts every minute, and at once for a host that reported a
  // limit, so the decision can tell a stale event from a real one.
  const actives = new Set<string>()
  for (const h of HOSTS) {
    const id = s.hosts[h].active
    if (!cfg.hosts[h] || !id) continue
    const p = s.probes[id]
    if (eventHosts.has(h) || !p || now - p.at > ACTIVE_PROBE_MS) actives.add(id)
  }
  await Promise.all([...actives].map((id) => { const t = pool.get(id); return t ? probeInto(s, t) : null }))

  await fetchUsage()
  let extra = 0
  for (const v of views(s, pool)) {
    if (extra >= OTHER_PROBES_PER_TICK) break
    if (actives.has(v.id) || !v.token.present || v.token.dead) continue
    const p = s.probes[v.id]
    if (v.quota && v.quota.source === 'usage' && now - v.quota.at < OTHER_PROBE_MS) continue
    if (p && now - p.at < OTHER_PROBE_MS) continue
    const t = pool.get(v.id)
    if (t) { extra++; await probeInto(s, t) }
  }

  for (const h of HOSTS) {
    const hostEvents = events.filter((e) => e.host === h)
    const ev = hostEvents.length ? { at: hostEvents[hostEvents.length - 1].at, limit: hostEvents[hostEvents.length - 1].limit } : null
    // An event counts once: it triggered this decision or it never will.
    const eventForDecision = eventHosts.has(h) ? ev : null
    let d = decide({ cfg, killed: isKilled, host: hostView(s, h, cfg, Date.now()), accounts: views(s, pool, h), now: Date.now(), event: eventForDecision })
    if (d.action === 'switch') d = await confirmTarget(s, h, d, cfg, pool, eventForDecision, isKilled)
    await act(s, h, d, cfg, pool)
    await sweep(s, h, d, cfg, eventHosts.has(h))
  }
  saveState(s)
}

const lastSweep = new Map<HostName, number>()

type Gate = { ok: boolean; why: string }

// Whether a stopped session on host h may be typed into now: the switcher
// holds the host's sign-in, nothing is off, paused or in dry run, and the
// decision for the host found its active account with room (or the limit
// event older than the last switch). The Valkyrie pane sweep below and thor's
// own continue runner (GET /continue-check) both go through this, so the two
// can never disagree about when a continue is safe.
function continueGate(s: State, h: HostName, d: Decision, cfg: SwitchConfig, isKilled: boolean): Gate {
  const hs = s.hosts[h]
  if (isKilled) return { ok: false, why: 'kill switch is on' }
  if (!cfg.enabled) return { ok: false, why: 'auto-switch is off' }
  if (cfg.dryRun) return { ok: false, why: 'dry run' }
  if (!cfg.nudge) return { ok: false, why: 'continue is off in config' }
  if (!cfg.hosts[h]) return { ok: false, why: `${h} is off` }
  if (hs.paused) return { ok: false, why: `paused: ${hs.pausedReason ?? 'by hand'}` }
  if (!hs.adopted || hs.owner !== 'pool' || !hs.active) return { ok: false, why: 'the switcher does not hold this host' }
  if (d.action !== 'none' || !/has room|predates the last switch/.test(d.reason)) return { ok: false, why: d.reason }
  return { ok: true, why: d.reason }
}

// A pane can stop on the limit after its host already moved: a request that
// left on the old token a moment before the switch comes back refused after
// the nudge pass ran. While the active account has room, any Valkyrie pane
// still stopped on a limit gets the same continue, at once when the hook
// reported one, otherwise once a minute. Never in dry run.
async function sweep(s: State, h: HostName, d: Decision, cfg: SwitchConfig, hadEvent: boolean): Promise<void> {
  const hs = s.hosts[h]
  // tickLocked only runs this with auto-switch on and the kill switch off (or forced)
  if (!continueGate(s, h, d, { ...cfg, enabled: true }, false).ok) return
  if (!hadEvent && Date.now() - (lastSweep.get(h) ?? 0) < SWEEP_MS) return
  lastSweep.set(h, Date.now())
  // The hook fires as the turn ends, a moment before the input box and the
  // armed banner are drawn again; read the screen after it settles.
  if (hadEvent) await new Promise((r) => setTimeout(r, 3000))
  const { nudged } = await nudgePanes(h, cfg, SWEEP_COOLDOWN_MS)
  if (nudged.length) {
    writeLog({ kind: 'continue', host: h, from: null, to: hs.active, reason: `continued ${nudged.length} pane${nudged.length === 1 ? '' : 's'} stopped on a limit`, ok: true, nudged: nudged.length })
  }
}

async function act(s: State, h: HostName, d: Decision, cfg: SwitchConfig, pool: Map<string, PoolToken>): Promise<void> {
  const hs = s.hosts[h]
  if (d.action === 'switch') {
    await doSwitch(s, h, d, cfg, pool, 'switch', false)
    return
  }
  if (d.action === 'exhausted') {
    const relief = d.earliestRelief
    const key = `exh:${h}:${hs.active}:${relief ? `${relief.id}:${Math.floor(relief.at / 600_000)}` : 'none'}`
    if (await dmOnce(s, key, 6 * 3600_000, exhaustedMessage(h, hs.active ? labelOf(hs.active) : null, d.reason,
      relief ? { label: labelOf(relief.id), at: relief.at } : null, Date.now()))) {
      writeLog({ kind: 'exhausted', host: h, from: hs.active, to: null, reason: d.reason, ok: false,
        detail: relief ? `earliest relief ${labelOf(relief.id)} at ${fmtET(relief.at, Date.now())}` : undefined })
    }
    return
  }
  if (d.action === 'blocked') {
    if (hs.lastBlocked !== d.reason && !d.reason.startsWith('paused')) {
      writeLog({ kind: 'blocked', host: h, from: hs.active, to: d.to ?? null, reason: d.reason, ok: false })
      if (/switches in 24 hours/.test(d.reason)) {
        await dmOnce(s, `cap:${h}`, 12 * 3600_000, `Claude auto-switch stopped switching ${h}: ${d.reason}.`)
      }
    }
    hs.lastBlocked = d.reason
    return
  }
  hs.lastBlocked = null
}

async function tick(force = false): Promise<void> {
  // Off means off: no lock file, no directory, nothing but this read.
  if (!force) {
    const cfg = readConfig()
    if (!cfg.enabled || killed()) return
  }
  if (tickRunning) { tickAgain = true; return }
  tickRunning = true
  try {
    do {
      tickAgain = false
      try {
        await withLock(() => tickLocked(force), 5_000)
      } catch (err) {
        if ((err as { status?: number }).status !== 409) console.error('[account-switch] tick failed', (err as Error).message)
      }
    } while (tickAgain)
  } finally {
    tickRunning = false
  }
}

let timer: NodeJS.Timeout | null = null

// Started with the server. Each tick reads config.json and the kill switch
// first and does nothing else while either says off, so a disabled switcher
// costs one stat and one small read a minute.
export function startAccountSwitch(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  setTimeout(() => { void tick() }, 15_000).unref()
}

// ------------------------------------------------------------ actions ----

// The StopFailure hook's report: a session on `host` ended its turn on a
// limit. Only Claude Code's account-limit lines count.
export function reportLimit(host: HostName, payload: { sessionId?: string; message?: string; error?: string }): { accepted: boolean; limit: LimitKind | null; why: string } {
  const limit = classifyLimitText(payload.message)
  if (!limit) return { accepted: false, limit: null, why: 'not an account limit message' }
  const cfg = readConfig()
  const now = Date.now()
  for (let i = events.length - 1; i >= 0; i--) if (now - events[i].at > EVENT_KEEP_MS) events.splice(i, 1)
  events.push({ host, at: now, sessionId: typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 64) : '', limit })
  if (!cfg.enabled || killed()) return { accepted: true, limit, why: 'recorded; auto-switch is off' }
  pendingEventHosts.add(host)
  void tick()
  return { accepted: true, limit, why: 'checking now' }
}

// thor's continue runner (C:\Thor\tools\account-switch\Continue-Stopped.ps1) asks this before it
// types into a Windows Terminal session that stopped on a limit: the same gate the Valkyrie pane
// sweep uses, on the decision a tick would make now with no limit event. Reads only, no lock (the
// state file is replaced whole), so the runner's polls never wait on a tick.
export function continueCheck(host: HostName): { ok: boolean; why: string; active: string | null; text: string } {
  const cfg = readConfig()
  const isKilled = killed()
  const s = loadState()
  const pool = loadPool()
  const d = decide({ cfg, killed: isKilled, host: hostView(s, host, cfg, Date.now()), accounts: views(s, pool, host), now: Date.now(), event: null })
  const g = continueGate(s, host, d, cfg, isKilled)
  return { ok: g.ok, why: g.why, active: s.hosts[host].active, text: cfg.nudgeText }
}

// The runner's report: it typed the continue into `count` sessions on `host`. One log line, so
// AI > Usage's history shows the sessions outside Valkyrie that were continued.
export function reportContinued(host: HostName, count: number): void {
  const s = loadState()
  writeLog({
    kind: 'continue', host, from: null, to: s.hosts[host].active,
    reason: `continued ${count} terminal${count === 1 ? '' : 's'} outside Valkyrie stopped on a limit`, ok: true, nudged: count,
  })
}

// The pool token's own probe and the account's usage card (its /login grant) read the same
// account's weekly use. Far apart while both are fresh, the pool token is another seat's: the
// browser that pressed Authorize was signed in as someone else.
function identityWarning(s: State, id: string): string | null {
  const p = s.probes[id]
  const u = usageCache?.clients.find((c) => c.id === id)
  if (!p?.quota || !u?.quota || u.authError || !usageCache) return null
  if (Math.abs(p.at - usageCache.dataAt) > 15 * 60_000) return null
  const a = Math.round(p.quota.weeklyPct)
  const b = Math.round(u.quota.weeklyPct)
  if (Math.abs(a - b) <= 5) return null
  return `the pool token's weekly use (${a}%) does not match this account's card (${b}%); it may belong to another seat, so sign it in again in a private window`
}

export type SwitchStatus = Awaited<ReturnType<typeof getStatus>>

export async function getStatus(opts: { refresh?: boolean } = {}) {
  const cfg = readConfig()
  const pool = loadPool()
  if (opts.refresh) {
    await withLock(async () => {
      const s = loadState()
      for (const h of HOSTS) recordCheck(s, h, await checkHost(h, pool))
      saveState(s)
    }, 15_000).catch((err) => console.error('[account-switch] status refresh failed', (err as Error).message))
  }
  await fetchUsage()
  const s = loadState()
  const now = Date.now()
  const accts = views(s, pool)
  const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null)
  return {
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    killed: killed(),
    config: cfg,
    vault: vaultHealth(),
    hosts: HOSTS.map((h) => {
      const hs = s.hosts[h]
      const next = pickTarget(views(s, pool, h), hs.active, cfg, now)
      return {
        host: h,
        enabled: cfg.hosts[h],
        active: hs.active ? { id: hs.active, label: labelOf(hs.active) } : null,
        owner: hs.owner,
        adopted: hs.adopted,
        paused: hs.paused,
        pausedReason: hs.pausedReason,
        lastSwitchAt: iso(hs.lastSwitchAt),
        lastDryRunAt: iso(hs.lastDryRunAt),
        switches24h: countRecent(hs.switches, now),
        checkedAt: iso(hs.checkedAt),
        lastError: hs.lastError,
        // thor: the ids its own vault held at the last check (null before the first). odin reads
        // the vault above directly.
        vaultIds: h === 'thor' ? hs.vaultIds : null,
        next: next.target ? { id: next.target.id, label: next.target.label } : null,
        nextReason: next.target ? 'most room' : (next.ranked.find((r) => !r.ok && r.why !== 'active now')?.why ?? 'no other account'),
      }
    }),
    accounts: accts.map((a) => {
      const acct = CLAUDE_ACCOUNTS.find((c) => c.id === a.id)
      const e = eligibility(a, cfg, now)
      return {
        id: a.id,
        label: a.label,
        email: acct?.email ?? '',
        token: { present: a.token.present, dead: a.token.dead, expiresAt: iso(a.token.expiresAt) },
        quota: a.quota?.quota ?? null,
        quotaAt: iso(a.quota?.at),
        quotaSource: a.quota?.source ?? null,
        eligible: e.ok,
        why: e.why,
        activeOn: HOSTS.filter((h) => s.hosts[h].active === a.id),
        onThor: s.hosts.thor.vaultIds ? s.hosts.thor.vaultIds.includes(a.id) : null,
        identityWarning: identityWarning(s, a.id),
      }
    }),
    recent: readLog(20),
  }
}

const hostList = (host: HostName | 'all'): HostName[] => (host === 'all' ? [...HOSTS] : [host])

// A switch Brendon asked for: any account with a working token, thresholds
// and dry run aside. It also takes the host over when its live file holds a
// /login sign-in, because asking is the consent the automatic path waits for.
export async function switchNow(host: HostName | 'all', to: string): Promise<{ results: Array<{ host: HostName; ok: boolean; error?: string; nudged: number }> }> {
  if (!ACCOUNT_ID_RE.test(to)) throw Object.assign(new Error('not an account id'), { status: 400 })
  return withLock(async () => {
    const cfg = readConfig()
    const s = loadState()
    const pool = loadPool()
    const t = pool.get(to)
    if (!t) throw Object.assign(new Error(`no pool token for ${to}`), { status: 409 })
    const p = await probeInto(s, t)
    if (p.httpStatus === 401 || p.httpStatus === 403) {
      saveState(s)
      throw Object.assign(new Error(`the pool token for ${labelOf(to)} was refused`), { status: 409 })
    }
    const results: Array<{ host: HostName; ok: boolean; error?: string; nudged: number }> = []
    for (const h of hostList(host)) {
      const from = s.hosts[h].active
      const r = await doSwitch(s, h, { action: 'switch', from, to, reason: 'switched by hand', hard: false }, cfg, pool, 'manual', true)
      results.push({ host: h, ...r })
    }
    saveState(s)
    return { results }
  }, 60_000)
}

// Lets the switcher own a host again: clears the pause and, when the live
// file is not a pool token, replaces it with the account that has the most room.
export async function resumeHost(host: HostName): Promise<{ ok: boolean; switchedTo: string | null; error?: string }> {
  return withLock(async () => {
    const cfg = readConfig()
    const s = loadState()
    const pool = loadPool()
    const c = await checkHost(host, pool)
    recordCheck(s, host, c)
    if (c.owner === 'unreachable') {
      saveState(s)
      return { ok: false, switchedTo: null, error: c.error ?? `${host} is unreachable` }
    }
    const hs = s.hosts[host]
    if (c.owner === 'pool') {
      hs.paused = false
      hs.pausedReason = null
      hs.adopted = true
      writeLog({ kind: 'adopt', host, from: null, to: c.account, reason: 'resumed; host already on a pool token', ok: true })
      saveState(s)
      return { ok: true, switchedTo: null }
    }
    await fetchUsage()
    const pick = pickTarget(views(s, pool, host), null, cfg, Date.now())
    let target = pick.target
    // Confirm the pick with a fresh probe, falling down the ranking once.
    for (let i = 0; target && i < 3; i++) {
      await probeInto(s, pool.get(target.id)!)
      const again = pickTarget(views(s, pool, host), null, cfg, Date.now()).target
      if (again && again.id === target.id) break
      target = again
    }
    if (!target) {
      saveState(s)
      return { ok: false, switchedTo: null, error: 'no account has room or a working pool token' }
    }
    const r = await doSwitch(s, host, { action: 'switch', from: null, to: target.id, reason: 'host taken over by Resume', hard: false }, cfg, pool, 'adopt', true)
    saveState(s)
    return r.ok ? { ok: true, switchedTo: target.id } : { ok: false, switchedTo: null, error: r.error }
  }, 60_000)
}

export async function pauseHostByHand(host: HostName): Promise<void> {
  await withLock(async () => {
    const s = loadState()
    s.hosts[host].paused = true
    s.hosts[host].pausedReason = 'paused by hand'
    writeLog({ kind: 'paused', host, from: s.hosts[host].active, to: null, reason: 'paused by hand', ok: true })
    saveState(s)
  })
}

// A sign-in just filed a token (lib/accountSignin.ts): forget the old token's refusal, failures
// and reading, and count it in thor's vault when it reached thor, so the switcher can use it at
// once instead of after thor's next 5-minute check.
async function markProvisioned(id: string, onThor: boolean): Promise<void> {
  try {
    await withLock(async () => {
      const s = loadState()
      delete s.dead[id]
      delete s.probes[id]
      delete s.notified[`dead:${id}`]
      for (const h of HOSTS) delete s.hosts[h].failed[id]
      const v = s.hosts.thor.vaultIds
      if (onThor && v && !v.includes(id)) s.hosts.thor.vaultIds = [...v, id].sort()
      saveState(s)
    }, 15_000)
    vaultCache = null
    writeLog({ kind: 'config', host: null, from: null, to: id, reason: `pool token stored for ${labelOf(id)} (odin${onThor ? ' and thor' : ' only'})`, ok: true })
  } catch (err) {
    console.error('[account-switch] could not note the new token', (err as Error).message)
  }
}

linkSwitcher({
  thorVaultIds: () => loadState().hosts.thor.vaultIds,
  deadIds: () => Object.keys(loadState().dead),
  provisioned: (id, onThor) => { void markProvisioned(id, onThor) },
  notAdopted: () => {
    const cfg = readConfig()
    const s = loadState()
    return HOSTS.filter((h) => cfg.hosts[h] && !s.hosts[h].adopted)
  },
})

export function setKill(on: boolean): void {
  ensureBase()
  if (on) {
    writeDurable(P.kill, `${new Date().toISOString()}\n`)
    writeLog({ kind: 'config', host: null, from: null, to: null, reason: 'kill switch on', ok: true })
  } else {
    try { unlinkSync(P.kill) } catch { /* already off */ }
    writeLog({ kind: 'config', host: null, from: null, to: null, reason: 'kill switch off', ok: true })
  }
}

// Partial update: only the keys given change, and the result goes through
// normalizeConfig, so a bad value falls back to its default.
export function updateConfig(patch: Record<string, unknown>): SwitchConfig {
  const current = (readJson(P.config) ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'hosts' && v && typeof v === 'object') {
      merged.hosts = { ...((current.hosts as Record<string, unknown>) ?? {}), ...(v as Record<string, unknown>) }
    } else {
      merged[k] = v
    }
  }
  const cfg = normalizeConfig(merged)
  writeDurable(P.config, JSON.stringify(cfg, null, 2) + '\n')
  writeLog({ kind: 'config', host: null, from: null, to: null, reason: `config changed: ${Object.keys(patch).join(', ')}`, ok: true })
  return cfg
}

// For the smoke test's end-to-end run only.
export const __test = { tick: (force = false) => withLock(() => tickLocked(force), 5_000), paths: P }
