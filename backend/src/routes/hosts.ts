import { Router } from 'express'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deviceHosts } from './devices.js'
import { vehicleHosts } from './vehicles.js'

// GET /api/hosts: health for every machine in the fleet on one panel.
//
// Transport, deliberately boring and matching the session board (workspaces.ts):
//   * odin (this host) is measured locally, right here, with os + df (every
//     disk, not only /).
//   * thor and mimir each publish a tiny stats JSON into bifrost on a timer
//     (Publish-HostStats.ps1). odin reads those files off its OWN local disk
//     (/home/brendon/bifrost/...), so there is NO network listener, NO token on
//     the wire, and nothing here ever executes anything a remote host sent.
//
//   * the phone and tablet come from routes/devices.ts: presence from odin's
//     tailscale status, battery from an iOS Shortcut. No history for them.
//
//   * the cars come from routes/vehicles.ts: Home Assistant's Tesla Fleet
//     sensors, read only. A sleeping car stays online with its last numbers.
//
//   * the Steam Frame sleeps, so it cannot publish on a timer. odin pulls it
//     instead (pollFrame below), with a key the Frame accepts only as a forced
//     command that prints key=value lines. odin parses numbers out of them.
//
// A remote host with no file, an unreadable file, or a file older than the
// stale threshold comes back { online:false } (or stale:true) instead of taking
// the route down. Every numeric field is re-validated because these files are
// written by another machine.

const exec = promisify(execFile)
const router = Router()

// Where the Windows hosts drop their stats. Overridable for tests.
const STATS_DIR = process.env.HOST_STATS_DIR
  || '/home/brendon/bifrost/host-stats'

// The publishers run on a 60s timer; anything older than this is no longer a
// live view of that machine. One interval plus generous slack for a slow write
// or clock skew.
const STALE_MS = 180_000

// A real stats file is ~230 bytes. These files are written by another machine
// and the threat model treats them as attacker-controllable, so cap the read:
// /api/hosts is polled every ~30s by every client, and an unbounded readFile of
// a deliberately huge file would load it into memory and block the event loop on
// every request. Anything over this is refused, not read.
const MAX_STATS_BYTES = 64 * 1024

// Remote hosts to surface, in display order. odin is always first and is the
// local host, so it is handled specially below.
const REMOTE_HOSTS: { host: string; label: string; os: 'windows' | 'linux' }[] = [
  { host: 'thor', label: 'thor', os: 'windows' },
  { host: 'mimir', label: 'mimir', os: 'windows' },
]

type HostMetric = { percent: number; used: number; total: number }
// One disk: a drive letter ("C:") on Windows, a mount point on Linux.
type Disk = HostMetric & { name: string }
type HistoryPoint = { t: number; cpu: number | null; mem: number | null; disk: number | null }
const BATTERY_STATUSES = ['charging', 'discharging', 'full', 'not charging', 'unknown'] as const
type BatteryStatus = typeof BATTERY_STATUSES[number]
type Battery = { percent: number; status: BatteryStatus }
type HostStat = {
  host: string
  label: string
  os: 'linux' | 'windows'
  online: boolean
  stale: boolean
  ts: number | null
  uptime: number | null
  cpu: { usage: number; cores: number; loadAvg?: [number, number, number] } | null
  memory: HostMetric | null
  // The system disk. `disks` lists every disk, the system disk first, on the
  // hosts that report more than one.
  disk: HostMetric | null
  disks?: Disk[]
  // Only hosts with a battery. While the host is offline this is the last
  // reading, taken at ts.
  battery?: Battery | null
  error?: string
  history?: HistoryPoint[]
}

// odin's CPU usage across two samples of os.cpus(). Kept as module state so the
// value is a real delta, not the since-boot average os would otherwise give.
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
// Prime the delta so the first request reports a real number, not 100%.
lastCpu = cpuTimes()

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

// Clamp a possibly-garbage percent from a file into 0..100, or null.
const pct = (v: unknown): number | null => {
  const n = num(v)
  return n == null ? null : Math.max(0, Math.min(100, n))
}

const metric = (v: unknown): HostMetric | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const percent = pct(o.percent)
  const used = num(o.used)
  const total = num(o.total)
  if (percent == null || used == null || total == null) return null
  // These files are written by another machine, so re-validate the bytes too,
  // not just their finiteness: a total of 0 or a used outside [0,total] would
  // render a nonsensical "14 GB / 0 B" tooltip. Fall back to null instead.
  if (total <= 0 || used < 0 || used > total) return null
  return { percent, used, total }
}

// A remote host's disk list, re-validated like every other field: a bounded
// count and a short plain name, since the name is shown on the page.
const MAX_DISKS = 16
const disksOf = (v: unknown): Disk[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: Disk[] = []
  for (const d of v.slice(0, MAX_DISKS)) {
    const m = metric(d)
    const name = (d as Record<string, unknown> | null)?.name
    if (m && typeof name === 'string' && /^[\w:/. -]{1,64}$/.test(name)) out.push({ name, ...m })
  }
  return out.length ? out : undefined
}

// odin's own disks: block-device filesystems only, so the rclone mount and
// tmpfs are never stat'd (a wedged FUSE mount would hang df). btrfs lists one
// device at every subvolume and df puts / first, so the first mount per device
// names it. /boot is vfat and left out.
const DF_TYPES = ['btrfs', 'xfs', 'ext4', 'ext3', 'f2fs']
async function odinDisks(): Promise<Disk[]> {
  const { stdout } = await exec('df', ['-B1', '--output=source,size,used,target', ...DF_TYPES.flatMap((t) => ['-t', t])], { timeout: 5_000 })
  const seen = new Set<string>()
  const disks: Disk[] = []
  for (const line of stdout.trim().split('\n').slice(1)) {
    const [source, size, used, ...target] = line.trim().split(/\s+/)
    const total = Number(size)
    const u = Number(used)
    if (!source?.startsWith('/dev/') || seen.has(source) || !(total > 0)) continue
    seen.add(source)
    disks.push({ name: target.join(' '), total, used: u, percent: (u / total) * 100 })
  }
  return disks.sort((a, b) => Number(b.name === '/') - Number(a.name === '/'))
}

async function measureOdin(): Promise<HostStat> {
  const total = os.totalmem()
  const free = os.freemem()
  let disks: Disk[] = []
  try { disks = await odinDisks() } catch { /* leave the disks empty */ }
  const root = disks.find((d) => d.name === '/')
  return {
    host: 'odin',
    label: 'odin',
    os: 'linux',
    online: true,
    stale: false,
    ts: Date.now(),
    uptime: os.uptime(),
    cpu: {
      usage: cpuUsage(),
      cores: os.cpus().length,
      loadAvg: os.loadavg() as [number, number, number],
    },
    memory: { total, used: total - free, percent: ((total - free) / total) * 100 },
    disk: root ? { total: root.total, used: root.used, percent: root.percent } : null,
    disks: disks.length ? disks : undefined,
  }
}

async function readRemote(spec: { host: string; label: string; os: 'windows' | 'linux' }): Promise<HostStat> {
  const base: HostStat = {
    host: spec.host, label: spec.label, os: spec.os,
    online: false, stale: false, ts: null, uptime: null,
    cpu: null, memory: null, disk: null,
  }
  const file = path.join(STATS_DIR, `${spec.host}.json`)
  let raw: string
  try {
    // stat first so a deliberately huge file is refused before it is read into
    // memory. The publisher writes atomically (MoveFileEx), so the size seen
    // here is the size read a moment later.
    const st = await fs.stat(file)
    if (st.size > MAX_STATS_BYTES) return { ...base, error: 'stats file too large' }
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // No file at all: the host has never published, or bifrost is unmounted.
    return { ...base, error: 'no stats published' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...base, error: 'stats file unreadable' }
  }
  // JSON.parse('null') returns null without throwing, and a bare number/string
  // is valid JSON too. Guard the top-level shape before any doc.* access, or one
  // corrupt file would throw and 500 the whole /api/hosts response.
  if (!parsed || typeof parsed !== 'object') return { ...base, error: 'stats file unreadable' }
  const doc = parsed as Record<string, unknown>
  const ts = num(doc.ts)
  const stale = ts == null || Date.now() - ts > STALE_MS
  const cpuDoc = (doc.cpu && typeof doc.cpu === 'object') ? doc.cpu as Record<string, unknown> : null
  const cpuUsagePct = cpuDoc ? pct(cpuDoc.usage) : null
  const cpu = cpuUsagePct != null
    ? { usage: cpuUsagePct, cores: num(cpuDoc!.cores) ?? 0 }
    : null
  return {
    ...base,
    online: true,
    stale,
    ts,
    uptime: num(doc.uptime),
    cpu,
    memory: metric(doc.memory),
    disk: metric(doc.disk),
    disks: disksOf(doc.disks),
  }
}

// The Steam Frame, pulled over the tailnet. `frame-stats` is an alias in odin's
// ~/.ssh/config (host, user, key, 5s connect timeout), and the Frame runs
// tools/host-stats/frame-host-stats.sh for that key whatever command is sent.
// An ssh round trip is too slow for every request and a sleeping headset costs
// the full timeout, so a timer polls it and the route serves the last result.
const FRAME_SSH = process.env.FRAME_STATS_SSH || 'frame-stats'
const FRAME_POLL_MS = 30_000
// The label is the Frame's own hostname, lowercased like the rest of the fleet.
// This one shows until its first answer after a restart.
const FRAME_BASE = { host: 'frame', label: 'loki', os: 'linux' as const }

let frameStat: HostStat = {
  ...FRAME_BASE, online: false, stale: false, ts: null, uptime: null,
  cpu: null, memory: null, disk: null, battery: null, error: 'not polled yet',
}
// The previous /proc/stat totals, so the cpu figure is a real delta.
let frameCpu: { idle: number; total: number } | null = null
let framePolling = false

const parseKv = (out: string): Map<string, string> => {
  const kv = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return kv
}

const kvNum = (kv: Map<string, string>, key: string): number | null => {
  const v = kv.get(key)
  return v != null && /^\d+(\.\d+)?$/.test(v) ? num(Number(v)) : null
}

async function pollFrame() {
  if (framePolling) return
  framePolling = true
  try {
    const { stdout } = await exec('ssh', ['-T', FRAME_SSH], { timeout: 10_000, maxBuffer: 16 * 1024 })
    const kv = parseKv(stdout)
    const percent = pct(kvNum(kv, 'battery'))
    const status = (kv.get('battery_status') ?? '').toLowerCase()
    const battery: Battery | null = percent == null ? null : {
      percent,
      status: (BATTERY_STATUSES as readonly string[]).includes(status) ? status as BatteryStatus : 'unknown',
    }
    let cpu: HostStat['cpu'] = null
    const ticks = (kv.get('cpu') ?? '').split(/\s+/).map(Number)
    if (ticks.length >= 8 && ticks.every((n) => Number.isFinite(n) && n >= 0)) {
      // user nice system idle iowait irq softirq steal. Guest time is already
      // inside user, so these eight are the whole.
      const total = ticks.slice(0, 8).reduce((a, b) => a + b, 0)
      const idle = ticks[3] + ticks[4]
      if (frameCpu && total > frameCpu.total) {
        const usage = pct(100 - (100 * (idle - frameCpu.idle)) / (total - frameCpu.total))
        if (usage != null) cpu = { usage, cores: kvNum(kv, 'cores') ?? 0 }
      }
      frameCpu = { idle, total }
    }
    const memTotal = kvNum(kv, 'mem_total_kb')
    const memAvail = kvNum(kv, 'mem_avail_kb')
    const diskTotal = kvNum(kv, 'disk_total')
    const diskUsed = kvNum(kv, 'disk_used')
    const name = (kv.get('hostname') ?? '').toLowerCase()
    frameStat = {
      ...FRAME_BASE, online: true, stale: false, ts: Date.now(),
      label: /^[a-z0-9-]{1,32}$/.test(name) ? name : FRAME_BASE.label,
      uptime: kvNum(kv, 'uptime'),
      cpu,
      memory: memTotal != null && memAvail != null
        ? metric({ total: memTotal * 1024, used: (memTotal - memAvail) * 1024, percent: ((memTotal - memAvail) / memTotal) * 100 })
        : null,
      disk: diskTotal != null && diskUsed != null
        ? metric({ total: diskTotal, used: diskUsed, percent: (diskUsed / diskTotal) * 100 })
        : null,
      battery,
    }
  } catch {
    // Asleep, off, or out of range. Keep the last battery reading and its ts so
    // the panel can say where it was left. It may reboot before the next answer,
    // which resets /proc/stat, so the cpu delta starts over.
    frameCpu = null
    frameStat = {
      ...frameStat, online: false, uptime: null, cpu: null, memory: null, disk: null, error: 'asleep or off',
    }
  } finally {
    framePolling = false
  }
}
void pollFrame()
setInterval(() => void pollFrame(), FRAME_POLL_MS).unref()

// The last hour of every host, a point a minute, for the dashboard's graphs.
// In memory only: a restart starts the graphs over, which is fine for a glance
// at the last hour and keeps this route free of any file it would have to own.
const HISTORY_SIZE = 60
const HISTORY_MS = 60_000
const history = new Map<string, HistoryPoint[]>()

const record = (s: HostStat) => {
  if (!s.online || s.ts == null) return
  const points = history.get(s.host) ?? []
  // thor and mimir publish once a minute on their own clocks, so a read can
  // land twice on the same file. Their ts is the sample's identity.
  if (points.length > 0 && points[points.length - 1].t === s.ts) return
  points.push({ t: s.ts, cpu: s.cpu?.usage ?? null, mem: s.memory?.percent ?? null, disk: s.disk?.percent ?? null })
  while (points.length > HISTORY_SIZE) points.shift()
  history.set(s.host, points)
}

const sampleAll = async () => {
  const all = await Promise.all([measureOdin(), ...REMOTE_HOSTS.map(readRemote)])
  for (const s of [...all, frameStat]) record(s)
}
// No sample at startup: odin's CPU figure is a delta since the last reading,
// and the first one after a restart spans only the busy boot, so it read 90%.
setInterval(() => void sampleAll(), HISTORY_MS).unref()

router.get('/hosts', async (_req, res) => {
  const [odin, ...remotes] = await Promise.all([
    measureOdin(),
    ...REMOTE_HOSTS.map(readRemote),
  ])
  res.json({
    hosts: [
      ...[odin, ...remotes, frameStat].map((h) => ({ ...h, history: history.get(h.host) ?? [] })),
      ...deviceHosts().map((d) => ({ ...d, history: [] })),
      ...vehicleHosts().map((v) => ({ ...v, history: [] })),
    ],
  })
})

export default router
