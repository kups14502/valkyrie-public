import { Router } from 'express'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// GET /api/hosts: health for every machine in the fleet on one panel.
//
// Transport, deliberately boring and matching the session board (workspaces.ts):
//   * odin (this host) is measured locally, right here, with os + df.
//   * thor and mimir each publish a tiny stats JSON into bifrost on a timer
//     (Publish-HostStats.ps1). odin reads those files off its OWN local disk
//     (/home/brendon/bifrost/...), so there is NO network listener, NO token on
//     the wire, and nothing here ever executes anything a remote host sent.
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
type HistoryPoint = { t: number; cpu: number | null; mem: number | null; disk: number | null }
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
  disk: HostMetric | null
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

async function measureOdin(): Promise<HostStat> {
  const total = os.totalmem()
  const free = os.freemem()
  let disk: HostMetric | null = null
  try {
    const { stdout } = await exec('df', ['-B1', '/'])
    const parts = stdout.trim().split('\n')[1].split(/\s+/)
    const dTotal = Number(parts[1])
    const dUsed = Number(parts[2])
    if (dTotal > 0) disk = { total: dTotal, used: dUsed, percent: (dUsed / dTotal) * 100 }
  } catch { /* leave disk null */ }
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
    disk,
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
  }
}

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
  for (const s of all) record(s)
}
// No sample at startup: odin's CPU figure is a delta since the last reading,
// and the first one after a restart spans only the busy boot, so it read 90%.
setInterval(() => void sampleAll(), HISTORY_MS).unref()

router.get('/hosts', async (_req, res) => {
  const [odin, ...remotes] = await Promise.all([
    measureOdin(),
    ...REMOTE_HOSTS.map(readRemote),
  ])
  res.json({ hosts: [odin, ...remotes].map((h) => ({ ...h, history: history.get(h.host) ?? [] })) })
})

export default router
