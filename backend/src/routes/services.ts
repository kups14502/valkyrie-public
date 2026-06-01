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
  composeFile: string | null
}

type Service = {
  name: string
  load: string
  active: string
  sub: string
  description: string
  scope: 'user' | 'system'
}

type Timer = {
  name: string
  service: string
  next: string
  left: string
  last: string
  passed: string
}

type Port = {
  protocol: string
  local: string
  port: number | null
  process: string | null
  pid: number | null
  exposure: 'public' | 'tailscale' | 'local' | 'docker' | 'lan' | 'unknown'
}

type ComposeFile = {
  path: string
  project: string
}

type ServicesResponse = {
  containers: Container[]
  services: Service[]
  systemServices: Service[]
  timers: Timer[]
  ports: Port[]
  composeFiles: ComposeFile[]
}

let cache: { at: number; data: ServicesResponse } | null = null

const run = (cmd: string, args: string[], timeout = 5_000, maxBuffer = 4 * 1024 * 1024) =>
  exec(cmd, args, { timeout, maxBuffer })

function parseLabels(labels: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of labels.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    out[part.slice(0, idx)] = part.slice(idx + 1)
  }
  return out
}

async function readContainers(): Promise<Container[]> {
  try {
    const { stdout } = await run('docker', ['ps', '-a', '--format', '{{json .}}'])
    const out: Container[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line) as Record<string, any>
        const labels = parseLabels(typeof raw.Labels === 'string' ? raw.Labels : '')
        const ports = typeof raw.Ports === 'string'
          ? raw.Ports.split(',').map((p: string) => p.trim()).filter(Boolean).slice(0, 6)
          : []
        out.push({
          id: String(raw.ID ?? '').slice(0, 12),
          name: String(raw.Names ?? ''),
          image: String(raw.Image ?? ''),
          state: String(raw.State ?? ''),
          status: String(raw.Status ?? ''),
          ports,
          project: labels['com.docker.compose.project'] ?? null,
          composeFile: labels['com.docker.compose.project.config_files'] ?? null,
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

function parseSystemctlUnits(stdout: string, scope: 'user' | 'system', includeInactive = false): Service[] {
  const out: Service[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 4) continue
    const [name, load, active, sub, ...descParts] = parts
    if (!includeInactive && active === 'inactive' && sub === 'dead') continue
    out.push({ name, load, active, sub, description: descParts.join(' '), scope })
  }
  out.sort((a, b) => {
    if (a.active === 'failed' && b.active !== 'failed') return -1
    if (b.active === 'failed' && a.active !== 'failed') return 1
    if (a.sub === 'running' && b.sub !== 'running') return -1
    if (b.sub === 'running' && a.sub !== 'running') return 1
    return a.name.localeCompare(b.name)
  })
  return out
}

async function readUserServices(): Promise<Service[]> {
  try {
    const { stdout } = await run('systemctl', [
      '--user', 'list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend',
    ], 5_000, 2 * 1024 * 1024)
    return parseSystemctlUnits(stdout, 'user')
  } catch {
    return []
  }
}

async function readSystemServices(): Promise<Service[]> {
  const interesting = /(docker|caddy|cloudflare|tailscale|ssh|smb|samba|plex|vault|home|openclaw|master|trading|kiwix|rclone|nginx|apache)/i
  try {
    const { stdout } = await run('systemctl', [
      'list-units', '--type=service', '--state=running', '--no-pager', '--plain', '--no-legend',
    ], 5_000, 2 * 1024 * 1024)
    return parseSystemctlUnits(stdout, 'system', true).filter((svc) => interesting.test(`${svc.name} ${svc.description}`))
  } catch {
    return []
  }
}

async function readTimers(): Promise<Timer[]> {
  try {
    const { stdout } = await run('systemctl', ['--user', 'list-timers', '--all', '--no-pager', '--plain', '--no-legend'], 5_000, 1024 * 1024)
    const out: Timer[] = []
    const weekdays = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'n/a'])
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const tail = trimmed.match(/(\S+\.timer)\s+(\S+\.service)$/)
      if (!tail) continue
      const name = tail[1]
      const service = tail[2]
      const prefix = trimmed.slice(0, tail.index).trim()
      const parts = prefix.split(/\s+/)
      const next = parts.slice(0, 4).join(' ')
      let i = 4
      const leftParts: string[] = []
      while (i < parts.length && !weekdays.has(parts[i])) leftParts.push(parts[i++])
      const last = parts.slice(i, i + 4).join(' ')
      const passed = parts.slice(i + 4).join(' ')
      out.push({ name, service, next, left: leftParts.join(' '), last, passed })
    }
    return out
  } catch {
    return []
  }
}

function classifyExposure(local: string): Port['exposure'] {
  if (local.startsWith('127.') || local.startsWith('[::1]') || local.startsWith('::1')) return 'local'
  if (local.startsWith('100.')) return 'tailscale'
  if (local.startsWith('172.')) return 'docker'
  if (local.startsWith('192.168.') || local.startsWith('10.')) return 'lan'
  if (local.startsWith('0.0.0.0') || local.startsWith('[::]') || local === '*') return 'public'
  return 'unknown'
}

async function readPorts(): Promise<Port[]> {
  try {
    const { stdout } = await run('ss', ['-tulpnH'], 5_000, 2 * 1024 * 1024)
    const out: Port[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 5 || parts[1] !== 'LISTEN') continue
      const protocol = parts[0]
      const local = parts[4]
      const pm = local.match(/:(\d+)$/)
      const port = pm ? Number(pm[1]) : null
      const users = trimmed.match(/users:\(\("([^"]+)",pid=(\d+)/)
      out.push({
        protocol,
        local,
        port,
        process: users ? users[1] : null,
        pid: users ? Number(users[2]) : null,
        exposure: classifyExposure(local),
      })
    }
    const seen = new Set<string>()
    return out
      .filter((p) => {
        const key = `${p.protocol}|${p.local}|${p.process ?? ''}|${p.pid ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => (a.port ?? 0) - (b.port ?? 0) || a.local.localeCompare(b.local))
  } catch {
    return []
  }
}

async function readComposeFiles(): Promise<ComposeFile[]> {
  try {
    const { stdout } = await run('bash', ['-lc', "find /home/brendon -maxdepth 4 \\( -name docker-compose.yml -o -name compose.yml -o -name docker-compose.yaml -o -name compose.yaml \\) -print 2>/dev/null || true"], 5_000, 1024 * 1024)
    return stdout.split('\n').map((path) => path.trim()).filter(Boolean).map((path) => {
      const parent = path.split('/').slice(-2, -1)[0] || path
      return { path, project: parent }
    }).sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

router.get('/services', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  const [containers, services, systemServices, timers, ports, composeFiles] = await Promise.all([
    readContainers(), readUserServices(), readSystemServices(), readTimers(), readPorts(), readComposeFiles(),
  ])
  const data = { containers, services, systemServices, timers, ports, composeFiles }
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
