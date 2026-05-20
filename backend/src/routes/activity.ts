import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const exec = promisify(execFile)
const router = Router()

const PROJECTS = [
  '/home/brendon/master-control',
  '/home/brendon/msp-platform',
  '/home/brendon/slop-factory',
  '/home/brendon/trading',
  '/home/brendon/infra',
]
const TRADE_LOG = '/home/brendon/trading/trade.log'
const VAULT_BACKUPS = '/home/brendon/vaultwarden-backups'
const CACHE_TTL_MS = 60_000

type Activity = {
  id: string
  type: 'commit' | 'trade' | 'backup'
  timestamp: number
  title: string
  subtitle: string | null
  tone: 'ok' | 'watch' | 'alert' | 'dim'
}

let cache: { at: number; data: Activity[] } | null = null

async function readGitActivity(): Promise<Activity[]> {
  const results: Activity[] = []
  await Promise.all(PROJECTS.map(async (p) => {
    try {
      const { stdout } = await exec('git', [
        '-C', p, 'log', '--since=7 days ago', '--pretty=format:%H%x09%ct%x09%s', '-n', '20',
      ], { timeout: 5_000 })
      const projectName = path.basename(p)
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const [sha, ts, ...rest] = line.split('\t')
        const tsNum = Number(ts)
        if (!Number.isFinite(tsNum)) continue
        results.push({
          id: `commit:${sha}`,
          type: 'commit',
          timestamp: tsNum * 1000,
          title: rest.join('\t'),
          subtitle: `${projectName} · ${sha.slice(0, 7)}`,
          tone: 'ok',
        })
      }
    } catch { /* not a git repo or no commits */ }
  }))
  return results
}

async function readTradeActivity(): Promise<Activity[]> {
  try {
    const raw = await fs.readFile(TRADE_LOG, 'utf8')
    const lines = raw.split('\n')
    const results: Activity[] = []
    let currentMs: number | null = null
    let expecting = 0
    for (const line of lines) {
      const tsMatch = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\]/)
      if (tsMatch) {
        const [, yy, mm, dd, hh, mi, ss] = tsMatch
        currentMs = new Date(`${yy}-${mm}-${dd}T${hh}:${mi}:${ss}`).getTime()
      }
      if (/Executing \d+ trade/.test(line)) {
        const m = line.match(/Executing (\d+) trade/)
        expecting = m ? Number(m[1]) : 0
        continue
      }
      if (expecting > 0) {
        const tradeMatch = line.match(/^\s+\[([\w.]+)\]\s+(\w+)\s+(\w+)(?:\s+[—-]\s+(.+))?$/)
        if (tradeMatch && currentMs) {
          const [, symbol, action, assetType, status] = tradeMatch
          const act = action.toLowerCase()
          results.push({
            id: `trade:${currentMs}:${symbol}:${act}`,
            type: 'trade',
            timestamp: currentMs,
            title: `${act} ${symbol}`,
            subtitle: `${assetType.toLowerCase()} · ${(status ?? 'submitted').trim()}`,
            tone: act === 'buy' ? 'ok' : act === 'sell' ? 'watch' : 'dim',
          })
          expecting--
        }
      }
    }
    return results
  } catch {
    return []
  }
}

async function readBackupActivity(): Promise<Activity[]> {
  try {
    const files = await fs.readdir(VAULT_BACKUPS)
    const entries = await Promise.all(
      files
        .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite3'))
        .map(async (f) => {
          const stat = await fs.stat(path.join(VAULT_BACKUPS, f))
          return { file: f, mtimeMs: stat.mtimeMs, size: stat.size }
        }),
    )
    return entries.map((e) => ({
      id: `backup:${e.file}`,
      type: 'backup' as const,
      timestamp: e.mtimeMs,
      title: 'vault backup',
      subtitle: `${(e.size / 1024).toFixed(0)} KB`,
      tone: 'dim' as const,
    }))
  } catch {
    return []
  }
}

router.get('/activity', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  try {
    const [commits, trades, backups] = await Promise.all([
      readGitActivity(),
      readTradeActivity(),
      readBackupActivity(),
    ])
    const all = [...commits, ...trades, ...backups].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
    cache = { at: Date.now(), data: all }
    res.json(all)
  } catch (err) {
    res.status(500).json({ error: 'failed to read activity', detail: (err as Error).message })
  }
})

export default router
