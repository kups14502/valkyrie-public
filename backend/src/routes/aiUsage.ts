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
    const localDateKey = (ms: number) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
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

async function readCodexUsage(): Promise<ProviderUsage> {
  const sessionsDir = path.join(homedir(), '.openclaw', 'agents', 'main', 'sessions')
  const out = emptyProvider()
  const cutoff = daysAgoMs(30)
  let files: string[] = []
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.') && !f.includes('.trajectory.'))
  } catch {
    return out
  }
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
        if (ts >= cutoff) {
          out.last30d.tokens += tokens
          out.last30d.costUSD += cost
          out.last30d.messages += 1
        }
        if (ts >= sevenCutoff) {
          out.last7d.tokens += tokens
          out.last7d.costUSD += cost
          out.last7d.messages += 1
        }
        if (ts >= todayCutoff) {
          out.today.tokens += tokens
          out.today.costUSD += cost
          out.today.messages += 1
        }
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
  }))

  return out
}

router.get('/ai-usage', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(cache.data)
  }
  try {
    const [claude, codex] = await Promise.all([readClaudeUsage(), readCodexUsage()])
    const data = {
      claude,
      codex,
      updatedAt: new Date().toISOString(),
    }
    cache = { at: Date.now(), data }
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: 'failed to read AI usage', detail: (err as Error).message })
  }
})

export default router
