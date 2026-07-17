import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

type ClaudeAccount = {
  id: string
  label: string
  email: string
  subscription: string
  configDir: string
}

const emptyBucket = (): Bucket => ({ tokens: 0, costUSD: 0, messages: 0 })
const emptyProvider = (): ProviderUsage => ({ today: emptyBucket(), last7d: emptyBucket(), last30d: emptyBucket() })

const CACHE_TTL_MS = 300_000
const CCUSAGE_BIN = path.join('/home/brendon/valkyrie/backend', 'node_modules', '.bin', 'ccusage')
let cache: { at: number; data: any } | null = null
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

const DEFAULT_CLAUDE_DIR = '/home/brendon/.claude'

const CLAUDE_ACCOUNTS: ClaudeAccount[] = [
  { id: 'claude-acct-a', label: 'Account A', email: 'user@example.com', subscription: 'Claude plan', configDir: DEFAULT_CLAUDE_DIR },
  { id: 'claude-acct-b', label: 'Account B', email: 'user@example.com', subscription: 'Claude plan', configDir: '/home/brendon/.claude-accounts/acct-b' },
  { id: 'claude-acct-c', label: 'Account C', email: 'user@example.com', subscription: 'Claude plan', configDir: '/home/brendon/.claude-accounts/acct-c' },
  { id: 'claude-acct-d', label: 'Account D', email: 'user@example.com', subscription: 'Claude plan', configDir: '/home/brendon/.claude-accounts/acct-d' },
  { id: 'claude-acct-e', label: 'Account E', email: 'user@example.com', subscription: 'Claude Pro', configDir: '/home/brendon/.claude-accounts/acct-e' },
]

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

async function getClaudeOAuthAccessToken(configDir: string): Promise<string | null> {
  const credsPath = path.join(configDir, '.credentials.json')
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
  const oauth = creds?.claudeAiOauth
  if (!oauth?.accessToken) return null

  if (oauth.refreshToken && (!oauth.expiresAt || Date.now() > Number(oauth.expiresAt) - 60_000)) {
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
    writeFileSync(credsPath, JSON.stringify(creds, null, 2))
  }

  return oauth.accessToken
}

async function readClaudeOAuthQuota(configDir: string): Promise<ClaudeQuota | null> {
  try {
    const accessToken = await getClaudeOAuthAccessToken(configDir)
    if (!accessToken) return null
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
    if (quota) return quota
    if (!resp.ok) return null
    return null
  } catch (err) {
    console.error('[ai-usage] claude oauth quota failed', (err as Error).message)
    return null
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
          readClaudeOAuthQuota(acct.configDir),
        ])
        return { acct, blocks, usage, quota }
      }))

      const claudeClients = claudeResults.map(({ acct, blocks, usage, quota }) => ({
        id: acct.id, kind: 'claude', label: acct.label, subscription: acct.subscription,
        ...usage, session: blocks.activeBlock, quota,
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
    } catch (err) {
      console.error('[ai-usage] refresh failed', (err as Error).message)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

void refreshAIUsage()

router.get('/ai-usage', async (_req, res) => {
  if (cache) {
    if (Date.now() - cache.at >= CACHE_TTL_MS) void refreshAIUsage()
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
