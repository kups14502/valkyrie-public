import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, readdirSync, statSync } from 'node:fs'
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

const emptyBucket = (): Bucket => ({ tokens: 0, costUSD: 0, messages: 0 })
const emptyProvider = (): ProviderUsage => ({ today: emptyBucket(), last7d: emptyBucket(), last30d: emptyBucket() })

const CACHE_TTL_MS = 60_000
let cache: { at: number; data: any } | null = null

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

async function readClaudeBlocks(): Promise<{ activeBlock: ClaudeBlock | null; weeklyPct: number; prev7dAvgDailyTokens: number; cur7dTokens: number }> {
  try {
    const since = new Date()
    since.setDate(since.getDate() - 35)
    const { stdout } = await exec('npx', ['-y', 'ccusage@latest', 'blocks', '--json', '--since', yyyymmdd(since)], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout) as { blocks?: any[] }
    const blocks = parsed.blocks ?? []

    const activeBlock: ClaudeBlock | null = (() => {
      const b = blocks.find((b: any) => b.isActive)
      if (!b) return null
      return {
        isActive: true,
        startTime: b.startTime,
        endTime: b.endTime,
        totalTokens: b.totalTokens ?? 0,
        costUSD: b.costUSD ?? 0,
        models: b.models ?? [],
        projection: b.projection ?? null,
        burnRate: b.burnRate ?? null,
      }
    })()

    const sevenCutoff = daysAgoMs(7)
    const prev7dCutoff = daysAgoMs(14)
    let cur7dTokens = 0
    let prev7dTokens = 0
    for (const b of blocks) {
      if (b.isGap || b.isActive) continue
      const t = Date.parse(b.startTime)
      if (t >= sevenCutoff) cur7dTokens += b.totalTokens ?? 0
      else if (t >= prev7dCutoff) prev7dTokens += b.totalTokens ?? 0
    }
    if (activeBlock) cur7dTokens += activeBlock.totalTokens

    const weeklyPct = prev7dTokens > 0 ? Math.round((cur7dTokens / prev7dTokens) * 100) : 0
    const prev7dAvgDailyTokens = Math.round(prev7dTokens / 7)

    return { activeBlock, weeklyPct, prev7dAvgDailyTokens, cur7dTokens }
  } catch (err) {
    console.error('[ai-usage] ccusage blocks failed', (err as Error).message)
    return { activeBlock: null, weeklyPct: 0, prev7dAvgDailyTokens: 0, cur7dTokens: 0 }
  }
}

async function readClaudeUsage(): Promise<ProviderUsage & { byModel: Record<string, Bucket> }> {
  const since = new Date()
  since.setDate(since.getDate() - 30)
  const result = { ...emptyProvider(), byModel: {} as Record<string, Bucket> }
  try {
    const { stdout } = await exec('npx', ['-y', 'ccusage@latest', 'daily', '--json', '--offline', '--since', yyyymmdd(since)], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout) as { daily?: Array<{ date: string; totalTokens: number; totalCost: number; modelBreakdowns?: Array<{ modelName: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number }> }> }
    const todayKey = localDateKey(Date.now())
    const sevenAgo = localDateKey(daysAgoMs(7) + 86_400_000)
    for (const day of parsed.daily ?? []) {
      result.last30d.tokens += day.totalTokens
      result.last30d.costUSD += day.totalCost
      result.last30d.messages += 1
      if (day.date >= sevenAgo) {
        result.last7d.tokens += day.totalTokens
        result.last7d.costUSD += day.totalCost
        result.last7d.messages += 1
      }
      if (day.date === todayKey) {
        result.today.tokens += day.totalTokens
        result.today.costUSD += day.totalCost
        result.today.messages += 1
      }
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

async function readCodexUsage(): Promise<ProviderUsage & { weeklyPct: number }> {
  const sessionsDir = path.join(homedir(), '.openclaw', 'agents', 'main', 'sessions')
  const out = { ...emptyProvider(), weeklyPct: 0 }
  const cutoff = daysAgoMs(14)
  let files: string[] = []
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.') && !f.includes('.trajectory.'))
  } catch {
    return out
  }
  const todayCutoff = todayStartMs()
  const sevenCutoff = daysAgoMs(7)
  const prev7dCutoff = daysAgoMs(14)
  let prev7dTokens = 0

  await Promise.all(files.map(async (f) => {
    const full = path.join(sessionsDir, f)
    let stat
    try { stat = statSync(full) } catch { return }
    if (stat.mtimeMs < cutoff) return

    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line || line.length < 50) return
        if (!line.includes('"provider":"openai-codex"') && !line.includes('"modelId":"gpt-')) return
        let obj: any
        try { obj = JSON.parse(line) } catch { return }
        const msg = obj?.message
        if (!msg) return
        if (msg.provider !== 'openai-codex') return
        const usage = msg.usage
        if (!usage) return
        const ts = typeof msg.timestamp === 'number' ? msg.timestamp : (typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN)
        if (!Number.isFinite(ts)) return
        const tokens = Number(usage.totalTokens ?? usage.total ?? (Number(usage.input) + Number(usage.output) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0)))
        const cost = Number(usage.cost?.total ?? 0)
        if (ts >= sevenCutoff) {
          out.last7d.tokens += tokens
          out.last7d.costUSD += cost
          out.last7d.messages += 1
        } else if (ts >= prev7dCutoff) {
          prev7dTokens += tokens
        }
        if (ts >= todayCutoff) {
          out.today.tokens += tokens
          out.today.costUSD += cost
          out.today.messages += 1
        }
        if (ts >= cutoff) {
          out.last30d.tokens += tokens
          out.last30d.costUSD += cost
          out.last30d.messages += 1
        }
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
  }))

  out.weeklyPct = prev7dTokens > 0 ? Math.round((out.last7d.tokens / prev7dTokens) * 100) : 0
  return out
}

router.get('/ai-usage', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(cache.data)
  }
  try {
    const [claudeBlocks, claude, codex] = await Promise.all([readClaudeBlocks(), readClaudeUsage(), readCodexUsage()])

    const sessionPct = (() => {
      const b = claudeBlocks.activeBlock
      if (!b) return 0
      if (b.projection?.totalTokens && b.projection.totalTokens > 0) {
        return Math.min(Math.round((b.totalTokens / b.projection.totalTokens) * 100), 100)
      }
      const start = Date.parse(b.startTime)
      const end = Date.parse(b.endTime)
      const now = Date.now()
      return Math.min(Math.round(((now - start) / (end - start)) * 100), 100)
    })()

    const data = {
      claude: {
        ...claude,
        session: claudeBlocks.activeBlock ? {
          ...claudeBlocks.activeBlock,
          pct: sessionPct,
        } : null,
        weeklyPct: claudeBlocks.weeklyPct,
      },
      codex: {
        ...codex,
      },
      updatedAt: new Date().toISOString(),
    }
    cache = { at: Date.now(), data }
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: 'failed to read AI usage', detail: (err as Error).message })
  }
})

export default router
