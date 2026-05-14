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

const HISTORY_SIZE = 60
type Sample = { t: number; cpu: number; mem: number; disk: number }
const history: Sample[] = []

const sampleDisk = async (): Promise<number> => {
  try {
    const { stdout } = await exec('df', ['-B1', '/'])
    const parts = stdout.trim().split('\n')[1].split(/\s+/)
    const dTotal = Number(parts[1])
    const dUsed = Number(parts[2])
    return dTotal > 0 ? (dUsed / dTotal) * 100 : 0
  } catch {
    return 0
  }
}

const recordSample = async () => {
  const total = os.totalmem()
  const free = os.freemem()
  const mem = ((total - free) / total) * 100
  const cpu = cpuUsage()
  const disk = await sampleDisk()
  history.push({ t: Date.now(), cpu, mem, disk })
  while (history.length > HISTORY_SIZE) history.shift()
}

void recordSample()
setInterval(() => void recordSample(), 60_000).unref()

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

router.get('/system/history', (_req, res) => {
  res.json({
    samples: history.map((s) => ({ t: s.t, cpu: s.cpu, mem: s.mem, disk: s.disk })),
    intervalMs: 60_000,
    capacity: HISTORY_SIZE,
  })
})

export default router
