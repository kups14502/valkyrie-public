import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, createReadStream, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, cpus } from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const router = Router()

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

async function findSessionFile(sessionId: string): Promise<string | null> {
  try {
    const dirs = await fs.readdir(PROJECTS_DIR)
    for (const d of dirs) {
      const candidate = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        return candidate
      } catch { /* try next */ }
    }
  } catch { /* projects dir missing */ }
  return null
}

type SessionContext = { cwd: string | null; gitBranch: string | null; lastActivity: number | null }

async function readSessionContext(file: string): Promise<SessionContext> {
  const empty: SessionContext = { cwd: null, gitBranch: null, lastActivity: null }
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - 32_768)
    const stream = createReadStream(file, { start, encoding: 'utf8' })
    let lastWithCwd: { cwd?: string; gitBranch?: string; timestamp?: string } | null = null
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue
      try {
        const obj = JSON.parse(line) as { cwd?: string; gitBranch?: string; timestamp?: string }
        if (obj.cwd) lastWithCwd = obj
      } catch { /* skip malformed */ }
    }
    if (!lastWithCwd) return empty
    const ts = lastWithCwd.timestamp ? Date.parse(lastWithCwd.timestamp) : NaN
    return {
      cwd: lastWithCwd.cwd ?? null,
      gitBranch: lastWithCwd.gitBranch ?? null,
      lastActivity: Number.isFinite(ts) ? ts : null,
    }
  } catch {
    return empty
  }
}

function projectLabel(cwd: string | null): string | null {
  if (!cwd) return null
  if (cwd === '/home/brendon' || cwd === homedir()) return 'home'
  return path.basename(cwd)
}

router.get('/sessions', async (_req, res) => {
  try {
    const coreCount = cpus().length || 1
    const { stdout } = await exec('ps', ['-eo', 'pid,pcpu,rss,etime,args'])
    const lines = stdout.trim().split('\n').slice(1)
    const rough = lines
      .map((l) => l.trim())
      .filter((l) => l.includes('--resume') && l.includes('--model') && l.includes('claude'))
      .map((l) => {
        const [pid, cpu, rss, etime, ...rest] = l.split(/\s+/)
        const args = rest.join(' ')
        const modelMatch = args.match(/--model\s+(\S+)/)
        const sessionMatch = args.match(/--resume\s+(\S+)/)
        return {
          pid: Number(pid),
          cpu: Math.round((Number(cpu) / coreCount) * 100) / 100,
          memory: Number(rss) * 1024,
          startedAt: etime,
          model: modelMatch?.[1] ?? 'unknown',
          sessionId: sessionMatch?.[1] ?? null,
        }
      })

    const enriched = await Promise.all(rough.map(async (s) => {
      let ctx: SessionContext = { cwd: null, gitBranch: null, lastActivity: null }
      if (s.sessionId) {
        const file = await findSessionFile(s.sessionId)
        if (file) ctx = await readSessionContext(file)
      }
      return {
        id: s.sessionId ?? String(s.pid),
        pid: s.pid,
        model: s.model,
        cpu: s.cpu,
        memory: s.memory,
        startedAt: s.startedAt,
        project: projectLabel(ctx.cwd),
        cwd: ctx.cwd,
        gitBranch: ctx.gitBranch,
        lastActivity: ctx.lastActivity,
      }
    }))

    res.json(enriched)
  } catch (err) {
    console.error('[500] failed to read processes:', err)
    res.status(500).json({ error: 'failed to read processes', detail: (err as Error).message })
  }
})

export default router
