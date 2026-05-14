import { Router } from 'express'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)
const router = Router()

const TRACKED = [
  '/home/brendon/master-control',
  '/home/brendon/msp-platform',
  '/home/brendon/slop-factory',
  '/home/brendon/trading',
  '/home/brendon/infra',
]

const HOUR = 1000 * 60 * 60
const CACHE_TTL_MS = 30_000

let cache: { at: number; data: ProjectInfo[] } | null = null

type ProjectInfo = {
  name: string
  path: string
  status: 'active' | 'paused' | 'idle'
  lastTouched: string
  lastCommit: { subject: string; sha: string; relative: string } | null
  dirty: boolean
  dirtyCount: number
  commitsToday: number
}

const fmtRelative = (date: Date) => {
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < HOUR * 24) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / (HOUR * 24))}d ago`
}

const statusFor = (recent: Date, dirty: boolean): 'active' | 'paused' | 'idle' => {
  if (dirty) return 'active'
  const days = (Date.now() - recent.getTime()) / (HOUR * 24)
  if (days < 1) return 'active'
  if (days < 14) return 'paused'
  return 'idle'
}

type GitInfo = {
  commitTs: number | null
  subject: string | null
  sha: string | null
  dirtyCount: number
  commitsToday: number
}

async function readGitInfo(p: string): Promise<GitInfo> {
  const empty: GitInfo = { commitTs: null, subject: null, sha: null, dirtyCount: 0, commitsToday: 0 }
  try {
    const [{ stdout: logOut }, { stdout: statusOut }, { stdout: todayOut }] = await Promise.all([
      exec('git', ['-C', p, 'log', '-1', '--format=%ct%x09%h%x09%s'], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
      exec('git', ['-C', p, 'status', '--porcelain'], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
      exec('git', ['-C', p, 'log', '--since=midnight', '--oneline'], { timeout: 5_000 }).catch(() => ({ stdout: '' })),
    ])

    const out = { ...empty }
    const logLine = logOut.trim()
    if (logLine) {
      const [ts, sha, ...rest] = logLine.split('\t')
      const tsNum = Number(ts)
      if (Number.isFinite(tsNum)) {
        out.commitTs = tsNum * 1000
        out.sha = sha
        out.subject = rest.join('\t')
      }
    }
    out.dirtyCount = statusOut.split('\n').filter((line) => line.trim().length > 0).length
    out.commitsToday = todayOut.split('\n').filter((line) => line.trim().length > 0).length
    return out
  } catch {
    return empty
  }
}

async function readProject(p: string): Promise<ProjectInfo | null> {
  try {
    const stat = await fs.stat(p)
    const git = await readGitInfo(p)
    const recentMs = Math.max(git.commitTs ?? 0, stat.mtimeMs)
    const recentDate = new Date(recentMs)
    const dirty = git.dirtyCount > 0
    return {
      name: path.basename(p),
      path: p,
      status: statusFor(recentDate, dirty),
      lastTouched: fmtRelative(recentDate),
      lastCommit: git.commitTs && git.subject && git.sha
        ? { subject: git.subject, sha: git.sha, relative: fmtRelative(new Date(git.commitTs)) }
        : null,
      dirty,
      dirtyCount: git.dirtyCount,
      commitsToday: git.commitsToday,
    }
  } catch {
    return null
  }
}

router.get('/projects', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(cache.data)
  }
  const out = await Promise.all(TRACKED.map(readProject))
  const filtered = out.filter((p): p is ProjectInfo => Boolean(p))
  filtered.sort((a, b) => {
    const aRank = a.status === 'active' ? 0 : a.status === 'paused' ? 1 : 2
    const bRank = b.status === 'active' ? 0 : b.status === 'paused' ? 1 : 2
    return aRank - bRank
  })
  cache = { at: Date.now(), data: filtered }
  res.json(filtered)
})

export default router
