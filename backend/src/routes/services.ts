import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const router = Router()

const CACHE_TTL_MS = 10_000

type Container = {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string[]
  project: string | null
}

type Service = {
  name: string
  load: string
  active: string
  sub: string
  description: string
}

type ServicesResponse = {
  containers: Container[]
  services: Service[]
}

let cache: { at: number; data: ServicesResponse } | null = null

async function readContainers(): Promise<Container[]> {
  try {
    const { stdout } = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })
    const out: Container[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line) as Record<string, any>
        const labels = typeof raw.Labels === 'string' ? raw.Labels : ''
        const projectMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/)
        const ports = typeof raw.Ports === 'string'
          ? raw.Ports.split(',').map((p: string) => p.trim()).filter(Boolean).slice(0, 4)
          : []
        out.push({
          id: String(raw.ID ?? '').slice(0, 12),
          name: String(raw.Names ?? ''),
          image: String(raw.Image ?? ''),
          state: String(raw.State ?? ''),
          status: String(raw.Status ?? ''),
          ports,
          project: projectMatch ? projectMatch[1] : null,
        })
      } catch { /* skip malformed line */ }
    }
    out.sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1
      if (b.state === 'running' && a.state !== 'running') return 1
      return a.name.localeCompare(b.name)
    })
    return out
  } catch {
    return []
  }
}

async function readServices(): Promise<Service[]> {
  try {
    const { stdout } = await exec('systemctl', [
      '--user', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend',
    ], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })
    const out: Service[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 4) continue
      const [name, load, active, sub, ...descParts] = parts
      // skip inactive units that are just dormant timers/sockets-not-running
      if (active === 'inactive' && sub === 'dead') continue
      out.push({
        name,
        load,
        active,
        sub,
        description: descParts.join(' '),
      })
    }
    out.sort((a, b) => {
      if (a.sub === 'running' && b.sub !== 'running') return -1
      if (b.sub === 'running' && a.sub !== 'running') return 1
      if (a.active === 'failed' && b.active !== 'failed') return -1
      if (b.active === 'failed' && a.active !== 'failed') return 1
      return a.name.localeCompare(b.name)
    })
    return out
  } catch {
    return []
  }
}

router.get('/services', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  const [containers, services] = await Promise.all([readContainers(), readServices()])
  const data = { containers, services }
  cache = { at: Date.now(), data }
  res.json(data)
})

const SAFE_NAME = /^[A-Za-z0-9_.@-]+$/

router.post('/services/restart', async (req, res) => {
  const { kind, name } = req.body ?? {}
  if (kind !== 'container' && kind !== 'service') return res.status(400).json({ error: 'invalid kind' })
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return res.status(400).json({ error: 'invalid name' })
  try {
    if (kind === 'container') {
      await exec('docker', ['restart', name], { timeout: 30_000 })
    } else {
      await exec('systemctl', ['--user', 'restart', name], { timeout: 30_000 })
    }
    cache = null
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'restart failed', detail: (err as Error).message })
  }
})

export default router
