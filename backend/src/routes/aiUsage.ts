import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
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
  email: string
  subscription: string
  configDir: string
}

type CodexRateLimit = {
  pct: number
  windowMins: number
  resetsAt: number
}

const emptyBucket = (): Bucket => ({ tokens: 0, costUSD: 0, messages: 0 })
const emptyProvider = (): ProviderUsage => ({ today: emptyBucket(), last7d: emptyBucket(), last30d: emptyBucket() })

const CACHE_TTL_MS = 300_000
const CCUSAGE_BIN = path.join('/home/brendon/master-control/backend', 'node_modules', '.bin', 'ccusage')
let cache: { at: number; data: any } | null = null
let refreshing: Promise<void> | null = null

const todayStartMs = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const daysAgoMs = (days: number) => todayStartMs() - days * 86_400_000

const yyyymmdd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

const localDateKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const CODEX_BIN = '/home/brendon/.npm/_npx/c8ab89660c602c20/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex'
const OPENCLAW_AUTH_PROFILES = path.join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json')
const CODEX_AUTH_JSON = path.join(homedir(), '.codex', 'auth.json')
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

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

const CLAUDE_ACCOUNTS: ClaudeAccount[] = [
  { email: 'user@example.com', subscription: 'Claude Pro', configDir: '/home/brendon/.claude' },
  { email: 'bot@example.com', subscription: 'Claude plan', configDir: '/home/brendon/dm-bot-runtime/.claude' },
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
    sessionPct: Math.round(Number(sessionUtil ?? 0) * 100),
    weeklyPct: Math.round(Number(weeklyUtil ?? 0) * 100),
    sessionResetsAt: resetIso(headers.get('anthropic-ratelimit-unified-5h-reset')),
    weeklyResetsAt: resetIso(headers.get('anthropic-ratelimit-unified-7d-reset')),
    status: headers.get('anthropic-ratelimit-unified-status'),
  }
}

async function readClaudeOAuthQuota(configDir: string): Promise<ClaudeQuota | null> {
  try {
    const creds = JSON.parse(readFileSync(path.join(configDir, '.credentials.json'), 'utf8'))
    const accessToken = creds?.claudeAiOauth?.accessToken
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
    if (!resp.ok) return null
    return parseClaudeRateLimitHeaders(resp.headers)
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
      sessionPct: Math.round(data.five_hour?.utilization ?? 0),
      weeklyPct: Math.round(data.seven_day?.utilization ?? 0),
      sessionResetsAt: data.five_hour?.resets_at ?? null,
      weeklyResetsAt: data.seven_day?.resets_at ?? null,
    }
  } catch (err) {
    console.error('[ai-usage] claude.ai quota fetch failed', (err as Error).message)
    return null
  }
}

async function syncCodexAuth(): Promise<void> {
  const profiles = JSON.parse(readFileSync(OPENCLAW_AUTH_PROFILES, 'utf8'))
  const profile = profiles?.profiles?.['openai-codex:user@example.com']
  if (!profile?.access || !profile?.refresh) throw new Error('no openai-codex profile')

  const accessExp = JSON.parse(Buffer.from(profile.access.split('.')[1], 'base64url').toString()).exp * 1000
  const needsRefresh = Date.now() > accessExp - 60_000

  let accessToken = profile.access
  let refreshToken = profile.refresh

  if (needsRefresh) {
    const { stdout } = await exec('curl', [
      '-s', '-X', 'POST', 'https://auth.openai.com/oauth/token',
      '-H', 'Content-Type: application/x-www-form-urlencoded',
      '-d', `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${OPENAI_CLIENT_ID}`,
    ], { timeout: 15_000 })
    const tokenData = JSON.parse(stdout)
    if (!tokenData.access_token) throw new Error('refresh failed')
    accessToken = tokenData.access_token
    refreshToken = tokenData.refresh_token ?? refreshToken

    profiles.profiles['openai-codex:user@example.com'].access = accessToken
    profiles.profiles['openai-codex:user@example.com'].refresh = refreshToken
    profiles.profiles['openai-codex:user@example.com'].expires = Date.now() + tokenData.expires_in * 1000
    writeFileSync(OPENCLAW_AUTH_PROFILES, JSON.stringify(profiles, null, 2))

    const idToken = tokenData.id_token
    const now = new Date()
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
    const fmt = (d: Date) => d.toISOString().replace(/(\.\d{3})Z$/, 'Z')
    writeFileSync(CODEX_AUTH_JSON, JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        token_type: tokenData.token_type ?? 'Bearer',
        scope: tokenData.scope ?? '',
        expires_at: fmt(expiresAt),
      },
      last_refresh: fmt(now),
    }, null, 2))
  }
}

async function readCodexRateLimits(): Promise<{ session5h: CodexRateLimit | null; weekly: CodexRateLimit | null }> {
  try {
    if (!existsSync(CODEX_AUTH_JSON)) {
      await syncCodexAuth()
    }

    const { spawn } = await import('node:child_process')
    const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'master-control', version: '1.0' } } }) + '\n'
    const rateLimitsMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'account/rateLimits/read', params: {} }) + '\n'

    return await new Promise((resolve) => {
      const proc = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const lines: string[] = []
      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => lines.push(line))

      let done = false
      const finish = () => {
        if (done) return
        done = true
        proc.stdin.end()
        const rateLimitLine = lines.find((l) => l.includes('"rateLimits"'))
        if (!rateLimitLine) return resolve({ session5h: null, weekly: null })
        try {
          const parsed = JSON.parse(rateLimitLine)
          const rl = parsed?.result?.rateLimits
          if (!rl) return resolve({ session5h: null, weekly: null })
          resolve({
            session5h: rl.primary ? { pct: rl.primary.usedPercent, windowMins: rl.primary.windowDurationMins, resetsAt: rl.primary.resetsAt } : null,
            weekly: rl.secondary ? { pct: rl.secondary.usedPercent, windowMins: rl.secondary.windowDurationMins, resetsAt: rl.secondary.resetsAt } : null,
          })
        } catch {
          resolve({ session5h: null, weekly: null })
        }
      }

      const timer = setTimeout(() => { proc.kill(); finish() }, 20_000)
      proc.on('close', () => { clearTimeout(timer); finish() })

      proc.stdin.write(initMsg)
      setTimeout(() => {
        if (!done) {
          proc.stdin.write(rateLimitsMsg)
          setTimeout(() => { proc.kill(); finish() }, 15_000)
        }
      }, 1_000)
    })
  } catch (err) {
    console.error('[ai-usage] codex rate limits failed', (err as Error).message)
    return { session5h: null, weekly: null }
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

async function readCodexUsage(): Promise<ProviderUsage> {
  const sessionsDir = path.join(homedir(), '.openclaw', 'agents', 'main', 'sessions')
  const out = emptyProvider()
  const cutoff = daysAgoMs(30)
  let files: string[] = []
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.') && !f.includes('.trajectory.'))
  } catch { return out }
  const todayCutoff = todayStartMs()
  const sevenCutoff = daysAgoMs(7)

  await Promise.all(files.map(async (f) => {
    const full = path.join(sessionsDir, f)
    let stat
    try { stat = statSync(full) } catch { return }
    if (stat.mtimeMs < cutoff) return
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line || line.length < 50) return
        if (!line.includes('"provider":"openai-codex"')) return
        let obj: any
        try { obj = JSON.parse(line) } catch { return }
        const msg = obj?.message
        if (!msg || msg.provider !== 'openai-codex') return
        const usage = msg.usage
        if (!usage) return
        const ts = typeof msg.timestamp === 'number' ? msg.timestamp : (typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN)
        if (!Number.isFinite(ts)) return
        const tokens = Number(usage.totalTokens ?? usage.total ?? (Number(usage.input) + Number(usage.output) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0)))
        const cost = Number(usage.cost?.total ?? 0)
        if (ts >= cutoff) { out.last30d.tokens += tokens; out.last30d.costUSD += cost; out.last30d.messages += 1 }
        if (ts >= sevenCutoff) { out.last7d.tokens += tokens; out.last7d.costUSD += cost; out.last7d.messages += 1 }
        if (ts >= todayCutoff) { out.today.tokens += tokens; out.today.costUSD += cost; out.today.messages += 1 }
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
  }))
  return out
}

const DM_BOT_SESSIONS_DIR = '/home/brendon/dm-bot-runtime/.claude/projects/-home-brendon-dm-bot-runtime-workspace'

async function readDMBotUsage(): Promise<ProviderUsage & { byModel: Record<string, Bucket> }> {
  const result = { ...emptyProvider(), byModel: {} as Record<string, Bucket> }
  const cutoff = daysAgoMs(30)
  let files: string[] = []
  try {
    files = readdirSync(DM_BOT_SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))
  } catch { return result }
  const todayCutoff = todayStartMs()
  const sevenCutoff = daysAgoMs(7)

  await Promise.all(files.map(async (f) => {
    const full = path.join(DM_BOT_SESSIONS_DIR, f)
    let stat
    try { stat = statSync(full) } catch { return }
    if (stat.mtimeMs < cutoff) return
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line || line.length < 50) return
        if (!line.includes('"usage"')) return
        let obj: any
        try { obj = JSON.parse(line) } catch { return }
        const usage = obj?.message?.usage
        if (!usage) return
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
        if (!Number.isFinite(ts) || ts < cutoff) return
        const tokens = (
          Number(usage.input_tokens || 0) +
          Number(usage.cache_creation_input_tokens || 0) +
          Number(usage.cache_read_input_tokens || 0) +
          Number(usage.output_tokens || 0)
        )
        if (tokens === 0) return
        if (ts >= cutoff) { result.last30d.tokens += tokens; result.last30d.messages += 1 }
        if (ts >= sevenCutoff) { result.last7d.tokens += tokens; result.last7d.messages += 1 }
        if (ts >= todayCutoff) { result.today.tokens += tokens; result.today.messages += 1 }
        const model = String(obj?.message?.model ?? 'unknown')
        if (!result.byModel[model]) result.byModel[model] = emptyBucket()
        result.byModel[model].tokens += tokens
        result.byModel[model].messages += 1
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
  }))
  return result
}

async function refreshAIUsage(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const botClaudeEnv = { CLAUDE_CONFIG_DIR: CLAUDE_ACCOUNTS[1].configDir }
      const [teamClaudeBlocks, teamClaude, botClaudeBlocks, botClaude, teamClaudeQuota, botClaudeQuota, codexUsage, codexRateLimits, dmBot] = await Promise.all([
        readClaudeBlocks(),
        readClaudeUsage(),
        readClaudeBlocks(botClaudeEnv),
        readClaudeUsage(botClaudeEnv),
        readClaudeOAuthQuota(CLAUDE_ACCOUNTS[0].configDir),
        readClaudeOAuthQuota(CLAUDE_ACCOUNTS[1].configDir),
        readCodexUsage(),
        readCodexRateLimits(),
        readDMBotUsage(),
      ])
      const claude = { ...teamClaude, session: teamClaudeBlocks.activeBlock, quota: teamClaudeQuota }
      const data = {
        // legacy fields kept for alerts / older deployed frontends
        claude,
        codex: { ...codexUsage, rateLimits: codexRateLimits },
        // explicit client list for the dashboard panel; display quota/rate-limit percentages, not token totals
        aiClients: [
          { id: 'claude-work', kind: 'claude', label: 'user@example.com', subscription: CLAUDE_ACCOUNTS[0].subscription, ...teamClaude, session: teamClaudeBlocks.activeBlock, quota: teamClaudeQuota },
          { id: 'claude-botacct', kind: 'claude', label: 'bot@example.com', subscription: CLAUDE_ACCOUNTS[1].subscription, ...botClaude, session: botClaudeBlocks.activeBlock, quota: botClaudeQuota },
          { id: 'codex-work', kind: 'codex', label: 'Codex user@example.com', subscription: 'Codex', ...codexUsage, rateLimits: codexRateLimits },
        ],
        dmBot,
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
    res.status(500).json({ error: 'failed to read AI usage', detail: (err as Error).message })
  }
})

export default router
