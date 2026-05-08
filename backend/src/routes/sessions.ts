import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const router = Router()

router.get('/sessions', async (_req, res) => {
  try {
    const { stdout } = await exec('ps', ['-eo', 'pid,pcpu,rss,etime,args'])
    const lines = stdout.trim().split('\n').slice(1)
    const sessions = lines
      .map((l) => l.trim())
      .filter((l) => l.includes('claude-real') && l.includes('--model'))
      .map((l) => {
        const [pid, cpu, rss, etime, ...rest] = l.split(/\s+/)
        const args = rest.join(' ')
        const modelMatch = args.match(/--model\s+(\S+)/)
        const sessionMatch = args.match(/--resume\s+(\S+)/)
        return {
          id: sessionMatch?.[1] ?? pid,
          pid: Number(pid),
          model: modelMatch?.[1] ?? 'unknown',
          cpu: Number(cpu),
          memory: Number(rss) * 1024,
          startedAt: etime,
        }
      })
    res.json(sessions)
  } catch (err) {
    res.status(500).json({ error: 'failed to read processes', detail: (err as Error).message })
  }
})

export default router
