import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, readFileSync, statSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { CLAUDE_ACCOUNTS, DEFAULT_CLAUDE_DIR } from '../lib/claudeAccounts.js'

const exec = promisify(execFile)
const router = Router()

type Bucket = { tokens: number; costUSD: number; messages: number }
type ProviderUsage = { today: Bucket; last7d: Bucket; last30d: Bucket }

type ClaudeBlock = {
  isActive: boolean
  startTime: string
  endTime: string
  totalTokens: number
  costUSD: number
  models: string[]
  projection: { totalTokens: number; totalCost: number; remainingMinutes: number } | null
  burnRate: { tokensPerMinute: number; costPerHour: number } | null
}

type ClaudeQuota = {
  sessionPct: number
  weeklyPct: number
  sessionResetsAt: string | null
  weeklyResetsAt: string | null
  status?: string | null
}

const emptyBucket = (): Bucket => ({ tokens: 0, costUSD: 0, messages: 0 })
const emptyProvider = (): ProviderUsage => ({ today: emptyBucket(), last7d: emptyBucket(), last30d: emptyBucket() })

const CACHE_TTL_MS = 300_000
// A dead sign-in is the one state a person acts on immediately, and five
// minutes of "sign-in expired" after a successful `claude /login` reads as the
// login having failed. Re-probe that account every minute instead.
const CACHE_TTL_AUTH_FAILED_MS = 60_000
const CCUSAGE_BIN = path.join('/home/brendon/valkyrie/backend', 'node_modules', '.bin', 'ccusage')
let cache: { at: number; data: any } | null = null
// When the last FULL read (usage + sessions + quotas) landed, tracked apart
// from cache.at so a quota-only refresh cannot stand in for it.
let fullAt = 0
let refreshing: Promise<void> | null = null

const todayStartMs = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const daysAgoMs = (days: number) => todayStartMs() - days * 86_400_000

const yyyymmdd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
const clampPct = (value: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)))

const localDateKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

// Claude.ai org UUID for the claude.ai Pro org (rate_limit_tier: default_claude_ai)
// Discovered via /api/bootstrap; cached in-memory after first discovery
let claudeAIOrgUUID: string | null = null

const CLAUDE_AI_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://claude.ai/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1',
  'Connection': 'keep-alive',
}

async function getClaudeAIOrgUUID(sessionKey: string): Promise<string | null> {
  if (claudeAIOrgUUID) return claudeAIOrgUUID
  try {
    const resp = await fetch('https://claude.ai/api/bootstrap', {
      headers: { ...CLAUDE_AI_BROWSER_HEADERS, 'Cookie': `sessionKey=${sessionKey}` },
    })
    if (!resp.ok) return null
    const data = await resp.json() as { account?: { memberships?: Array<{ organization?: { uuid?: string; rate_limit_tier?: string } }> } }
    const memberships = data.account?.memberships ?? []
    const claudeAIOrg = memberships.find((m) => m.organization?.rate_limit_tier === 'default_claude_ai')
    claudeAIOrgUUID = claudeAIOrg?.organization?.uuid ?? null
    return claudeAIOrgUUID
  } catch {
    return null
  }
}

function parseClaudeRateLimitHeaders(headers: Headers): ClaudeQuota | null {
  const sessionUtil = headers.get('anthropic-ratelimit-unified-5h-utilization')
  const weeklyUtil = headers.get('anthropic-ratelimit-unified-7d-utilization')
  if (!sessionUtil && !weeklyUtil) return null
  const resetIso = (value: string | null) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
  }
  return {
    sessionPct: clampPct(Number(sessionUtil ?? 0) * 100),
    weeklyPct: clampPct(Number(weeklyUtil ?? 0) * 100),
    sessionResetsAt: resetIso(headers.get('anthropic-ratelimit-unified-5h-reset')),
    weeklyResetsAt: resetIso(headers.get('anthropic-ratelimit-unified-7d-reset')),
    status: headers.get('anthropic-ratelimit-unified-status'),
  }
}

// Refreshing rotates the token: the refresh token dies the moment it is
// exchanged, and posting a spent one again is what an OAuth server reads as a
// stolen token, so it revokes the whole family and the account needs a fresh
// `claude /login`. Two accounts have died exactly that way (acct-c on
// 2026-08-07, acct-d on 2026-08-28), and nothing but this backend has
// touched those profile dirs since July, so the loss came from here.
//
// Three rules stop it:
//   1. one refresh at a time per profile, in this process AND across processes:
//      a deploy restart can leave two backends briefly alive and both refresh
//      at module load, which is a double exchange of one token,
//   2. the rotated token is written atomically and fsynced BEFORE it is used,
//      so a crash between the response and the write cannot lose it,
//   3. a refresh token this process already posted is never posted twice, which
//      turns a lost write into one dead account instead of a revoked family.
const REFRESH_LOCK_STALE_MS = 60_000
const refreshInFlight = new Map<string, Promise<string | null>>()
const postedRefreshTokens = new Map<string, string>()

const readCreds = (credsPath: string): any => JSON.parse(readFileSync(credsPath, 'utf8'))

function writeCredsDurable(credsPath: string, creds: unknown): void {
  const tmp = `${credsPath}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(creds, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, credsPath)
}

// O_EXCL create is the lock. A lock older than the stale window belonged to a
// process that died holding it, so it gets taken over.
function acquireRefreshLock(configDir: string): string | null {
  const lockPath = path.join(configDir, '.credentials.refresh.lock')
  const take = (): boolean => {
    try {
      closeSync(openSync(lockPath, 'wx'))
      return true
    } catch {
      return false
    }
  }
  if (take()) return lockPath
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS) {
      unlinkSync(lockPath)
      if (take()) return lockPath
    }
  } catch { /* another writer got there first */ }
  return null
}

async function refreshUnderLock(configDir: string, credsPath: string): Promise<string | null> {
  const lockPath = acquireRefreshLock(configDir)
  // Someone else is mid-exchange. Their write lands in a moment; reading the
  // token that is being spent right now and posting it too is the exact reuse
  // that revokes the family, so wait for the next cycle. Not an auth failure.
  if (!lockPath) throw new Error('refresh deferred: another writer holds the lock')

  try {
    // Re-read inside the lock: another process may have just rotated it.
    const creds = readCreds(credsPath)
    const oauth = creds?.claudeAiOauth
    if (!oauth?.refreshToken) return oauth?.accessToken ?? null
    if (oauth.expiresAt && Date.now() < Number(oauth.expiresAt) - 60_000) return oauth.accessToken
    if (postedRefreshTokens.get(configDir) === oauth.refreshToken) {
      // Already exchanged this exact token and the file never advanced, so the
      // server has rotated past it. Sending it again would revoke the family.
      throw new Error('refresh failed: stored refresh token was already spent')
    }

    postedRefreshTokens.set(configDir, oauth.refreshToken)
    const resp = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }),
    })
    if (!resp.ok) throw new Error(`refresh failed: ${resp.status}`)
    const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!data.access_token) throw new Error('refresh returned no access token')
    oauth.accessToken = data.access_token
    oauth.refreshToken = data.refresh_token ?? oauth.refreshToken
    oauth.expiresAt = Date.now() + Number(data.expires_in ?? 0) * 1000 - 5 * 60 * 1000
    writeCredsDurable(credsPath, creds)
    console.log(`[ai-usage] ${new Date().toISOString()} rotated oauth token for ${configDir}`)
    return oauth.accessToken
  } finally {
    try { unlinkSync(lockPath) } catch { /* stale sweep will clear it */ }
  }
}

async function getClaudeOAuthAccessToken(configDir: string): Promise<string | null> {
  const credsPath = path.join(configDir, '.credentials.json')
  const oauth = readCreds(credsPath)?.claudeAiOauth
  if (!oauth?.accessToken) return null
  if (oauth.expiresAt && Date.now() < Number(oauth.expiresAt) - 60_000) return oauth.accessToken
  // No refresh token: hand the probe what we have and let its status speak.
  if (!oauth.refreshToken) return oauth.accessToken

  const running = refreshInFlight.get(configDir)
  if (running) return running
  const attempt = refreshUnderLock(configDir, credsPath)
    .finally(() => { refreshInFlight.delete(configDir) })
  refreshInFlight.set(configDir, attempt)
  return attempt
}

// A null quota has two very different causes: the probe came back without
// rate-limit headers (transient, nothing to do), or the account's stored
// sign-in is dead (needs `claude /login` against its config dir). Report the
// second one so the dashboard can say so instead of rendering an empty card.
type QuotaRead = { quota: ClaudeQuota | null; authError: string | null }

// A dead sign-in stays dead until someone runs `claude /login`, so re-probing
// it every refresh cycle only burns a token-endpoint request and repeats the
// same log line forever. Remember the hard failure and skip the probe until
// either the cooldown lapses or .credentials.json is rewritten (a re-login).
const AUTH_FAIL_COOLDOWN_MS = 30 * 60_000
const authFailures = new Map<string, { at: number; error: string; credsMtimeMs: number }>()

const credsMtimeMs = (configDir: string): number => {
  try {
    return statSync(path.join(configDir, '.credentials.json')).mtimeMs
  } catch {
    return 0
  }
}

async function readClaudeOAuthQuota(configDir: string, label: string): Promise<QuotaRead> {
  const held = authFailures.get(configDir)
  if (held && held.credsMtimeMs === credsMtimeMs(configDir) && Date.now() - held.at < AUTH_FAIL_COOLDOWN_MS) {
    return { quota: null, authError: held.error }
  }
  const fail = (error: string): QuotaRead => {
    authFailures.set(configDir, { at: Date.now(), error, credsMtimeMs: credsMtimeMs(configDir) })
    return { quota: null, authError: error }
  }
  try {
    const accessToken = await getClaudeOAuthAccessToken(configDir)
    if (!accessToken) return fail('not signed in')
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }],
      }),
    })
    const quota = parseClaudeRateLimitHeaders(resp.headers)
    if (quota) {
      authFailures.delete(configDir)
      return { quota, authError: null }
    }
    if (resp.status === 401 || resp.status === 403) {
      console.error(`[ai-usage] claude oauth rejected (${label}): ${resp.status}`)
      return fail('sign-in expired')
    }
    return { quota: null, authError: null }
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[ai-usage] claude oauth quota failed (${label})`, msg)
    if (msg.includes('ENOENT')) return fail('not signed in')
    // a 400 from the token endpoint means the stored refresh token is spent or revoked
    if (/refresh failed|no access token/.test(msg)) return fail('sign-in expired')
    return { quota: null, authError: null }
  }
}

async function readClaudeAIQuota(): Promise<ClaudeQuota | null> {
  const sessionKey = process.env.CLAUDE_SESSION_KEY
  if (!sessionKey) return null
  try {
    const orgUUID = await getClaudeAIOrgUUID(sessionKey)
    if (!orgUUID) return null
    const resp = await fetch(`https://claude.ai/api/organizations/${orgUUID}/usage`, {
      headers: { ...CLAUDE_AI_BROWSER_HEADERS, 'Cookie': `sessionKey=${sessionKey}` },
    })
    if (!resp.ok) return null
    const data = await resp.json() as {
      five_hour?: { utilization?: number; resets_at?: string }
      seven_day?: { utilization?: number; resets_at?: string }
    }
    return {
      sessionPct: clampPct(data.five_hour?.utilization ?? 0),
      weeklyPct: clampPct(data.seven_day?.utilization ?? 0),
      sessionResetsAt: data.five_hour?.resets_at ?? null,
      weeklyResetsAt: data.seven_day?.resets_at ?? null,
    }
  } catch (err) {
    console.error('[ai-usage] claude.ai quota fetch failed', (err as Error).message)
    return null
  }
}

async function readClaudeBlocks(env?: NodeJS.ProcessEnv): Promise<{ activeBlock: ClaudeBlock | null; cur7dTokens: number }> {
  try {
    const since = new Date()
    since.setDate(since.getDate() - 35)
    const { stdout } = await exec(CCUSAGE_BIN, ['blocks', '--json', '--since', yyyymmdd(since)], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    })
    const parsed = JSON.parse(stdout) as { blocks?: any[] }
    const blocks = parsed.blocks ?? []

    const activeBlock: ClaudeBlock | null = (() => {
      const b = blocks.find((b: any) => b.isActive)
      if (!b) return null
      return { isActive: true, startTime: b.startTime, endTime: b.endTime, totalTokens: b.totalTokens ?? 0, costUSD: b.costUSD ?? 0, models: b.models ?? [], projection: b.projection ?? null, burnRate: b.burnRate ?? null }
    })()

    const sevenCutoff = daysAgoMs(7)
    let cur7dTokens = 0
    for (const b of blocks) {
      if (b.isGap || b.isActive) continue
      const t = Date.parse(b.startTime)
      if (t >= sevenCutoff) cur7dTokens += b.totalTokens ?? 0
    }
    if (activeBlock) cur7dTokens += activeBlock.totalTokens

    return { activeBlock, cur7dTokens }
  } catch (err) {
    console.error('[ai-usage] ccusage blocks failed', (err as Error).message)
    return { activeBlock: null, cur7dTokens: 0 }
  }
}

async function readClaudeUsage(env?: NodeJS.ProcessEnv): Promise<ProviderUsage & { byModel: Record<string, Bucket> }> {
  const since = new Date()
  since.setDate(since.getDate() - 30)
  const result = { ...emptyProvider(), byModel: {} as Record<string, Bucket> }
  try {
    const { stdout } = await exec(CCUSAGE_BIN, ['daily', '--json', '--offline', '--since', yyyymmdd(since)], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    })
    const parsed = JSON.parse(stdout) as { daily?: Array<{ date: string; totalTokens: number; totalCost: number; modelBreakdowns?: Array<{ modelName: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number }> }> }
    const todayKey = localDateKey(Date.now())
    const sevenAgo = localDateKey(daysAgoMs(7) + 86_400_000)
    for (const day of parsed.daily ?? []) {
      result.last30d.tokens += day.totalTokens
      result.last30d.costUSD += day.totalCost
      result.last30d.messages += 1
      if (day.date >= sevenAgo) { result.last7d.tokens += day.totalTokens; result.last7d.costUSD += day.totalCost; result.last7d.messages += 1 }
      if (day.date === todayKey) { result.today.tokens += day.totalTokens; result.today.costUSD += day.totalCost; result.today.messages += 1 }
      for (const m of day.modelBreakdowns ?? []) {
        if (!result.byModel[m.modelName]) result.byModel[m.modelName] = emptyBucket()
        const b = result.byModel[m.modelName]
        b.tokens += m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens
        b.costUSD += m.cost
      }
    }
  } catch (err) {
    console.error('[ai-usage] ccusage failed', (err as Error).message)
  }
  return result
}

async function refreshAIUsage(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      // Read each Claude account from its own config dir. Accounts without a
      // logged-in .credentials.json simply return empty usage / null quota.
      const claudeResults = await Promise.all(CLAUDE_ACCOUNTS.map(async (acct) => {
        const env = acct.configDir === DEFAULT_CLAUDE_DIR ? undefined : { CLAUDE_CONFIG_DIR: acct.configDir }
        const [blocks, usage, quota] = await Promise.all([
          readClaudeBlocks(env),
          readClaudeUsage(env),
          readClaudeOAuthQuota(acct.configDir, acct.label),
        ])
        return { acct, blocks, usage, quota: quota.quota, authError: quota.authError }
      }))

      const claudeClients = claudeResults.map(({ acct, blocks, usage, quota, authError }) => ({
        id: acct.id, kind: 'claude', label: acct.label, email: acct.email, subscription: acct.subscription,
        ...usage, session: blocks.activeBlock, quota, authError,
      }))

      // legacy `claude` field kept for alerts / older deployed frontends: first listed account
      const primary = claudeResults[0]
      const claude = { ...primary.usage, session: primary.blocks.activeBlock, quota: primary.quota }
      const data = {
        claude,
        // explicit client list for the dashboard panel; display quota percentages, not token totals
        aiClients: claudeClients,
        updatedAt: new Date().toISOString(),
      }
      cache = { at: Date.now(), data }
      fullAt = Date.now()
    } catch (err) {
      console.error('[ai-usage] refresh failed', (err as Error).message)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

// The cheap path: re-read the quotas and merge them into the cached numbers.
// Whether a signed-out account came back is worth asking every minute; ccusage
// over 292 MB of transcripts is 14 s of CPU that has nothing to do with the
// answer. A held auth failure short-circuits before any request, so this costs
// one probe for the account that actually changed.
async function refreshQuotasOnly(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const current = cache?.data
      if (!current?.aiClients) return
      const reads = await Promise.all(CLAUDE_ACCOUNTS.map((acct) => readClaudeOAuthQuota(acct.configDir, acct.label)))
      const byId = new Map(CLAUDE_ACCOUNTS.map((acct, i) => [acct.id, reads[i]]))
      const aiClients = current.aiClients.map((c: { id: string }) => {
        const read = byId.get(c.id)
        return read ? { ...c, quota: read.quota, authError: read.authError } : c
      })
      const primary = byId.get(CLAUDE_ACCOUNTS[0].id)
      const claude = primary ? { ...current.claude, quota: primary.quota } : current.claude
      cache = {
        at: Date.now(),
        data: { ...current, claude, aiClients, updatedAt: new Date().toISOString() },
      }
    } catch (err) {
      console.error('[ai-usage] quota refresh failed', (err as Error).message)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

void refreshAIUsage()

router.get('/ai-usage', async (_req, res) => {
  if (cache) {
    const anyDead = (cache.data?.aiClients ?? []).some((c: { authError?: string | null }) => c.authError)
    // fullAt, not cache.at: the quota-only path below stamps cache.at, and
    // reading that here would postpone the full refresh for as long as an
    // account stayed signed out, freezing every token and cost number with it.
    if (Date.now() - fullAt >= CACHE_TTL_MS) void refreshAIUsage()
    else if (anyDead && Date.now() - cache.at >= CACHE_TTL_AUTH_FAILED_MS) void refreshQuotasOnly()
    return res.json(cache.data)
  }
  try {
    await refreshAIUsage()
    const c = cache as { at: number; data: any } | null
    if (!c) return res.status(503).json({ error: 'AI usage warming up' })
    res.json(c.data)
  } catch (err) {
    console.error('[500] failed to read AI usage:', err)
    res.status(500).json({ error: 'failed to read AI usage', detail: (err as Error).message })
  }
})

export default router
