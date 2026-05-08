import { Router } from 'express'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const router = Router()

let lastCpu = { idle: 0, total: 0 }

const cpuTimes = () => {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t
    idle += c.times.idle
  }
  return { idle, total }
}

const cpuUsage = () => {
  const cur = cpuTimes()
  const idleDiff = cur.idle - lastCpu.idle
  const totalDiff = cur.total - lastCpu.total
  lastCpu = cur
  if (totalDiff === 0) return 0
  return 100 - (100 * idleDiff) / totalDiff
}

router.get('/system', async (_req, res) => {
  const total = os.totalmem()
  const free = os.freemem()
  let disk = { total: 0, used: 0, percent: 0 }
  try {
    const { stdout } = await exec('df', ['-B1', '/'])
    const line = stdout.trim().split('\n')[1]
    const parts = line.split(/\s+/)
    const dTotal = Number(parts[1])
    const dUsed = Number(parts[2])
    disk = { total: dTotal, used: dUsed, percent: (dUsed / dTotal) * 100 }
  } catch { /* ignore */ }

  res.json({
    cpu: {
      cores: os.cpus().length,
      loadAvg: os.loadavg() as [number, number, number],
      usage: cpuUsage(),
    },
    memory: {
      total,
      used: total - free,
      free,
      percent: ((total - free) / total) * 100,
    },
    disk,
    uptime: os.uptime(),
    hostname: os.hostname(),
  })
})

export default router
