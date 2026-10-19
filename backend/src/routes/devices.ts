import { Router, type Request, type Response } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DEVICE_IDS, checkDeviceToken, isDeviceId, readDeviceReport, saveDeviceReport,
  type BatteryStatus, type DeviceId, type DeviceReport,
} from '../lib/devices.js'
import { haRequest } from './lights.js'

// The iPhone and iPad as hosts on /api/hosts (hosts.ts appends deviceHosts()).
//
// Two sources, neither of which runs anything a device sends:
//   * presence: odin's own `tailscale status --json`, read on a timer. iOS
//     drops its control connection while the Tailscale app idles, so a phone
//     in use shows Online:false with a LastSeen a few minutes old. A device
//     counts as online while either source heard from it in the last 15 min.
//   * battery (and storage, when the Shortcut can read it): an iOS Shortcuts
//     automation POSTs it to /api/devices/<id>/report with that device's own
//     token (scripts/deviceToken.mts issues it, lib/devices.ts keeps its hash).
//     The steps to build the Shortcut are in scripts/ios-battery-shortcut.md.
//
//   * battery, charging and storage from the Home Assistant iOS app, which reports
//     sensor.<device>_battery_level, _battery_state and _storage by itself. Its
//     sign-in is password-free from the phone's and iPad's tailnet addresses only
//     (HA trusted_networks, set up 2026-10-19). The newest of the two sources wins.
//
// The report route is mounted ahead of requireAuth (index.ts): a Shortcut has
// no app token, so the per-device token is its whole credential. It is
// checked in constant time, failures and floods are rate limited per address,
// and the body is parsed into numbers and booleans only.

const exec = promisify(execFile)
const router = Router()

const ONLINE_MS = 15 * 60_000
// A battery reading older than this, from a device that is online, shows as stale.
const STALE_MS = 3 * 3_600_000
const POLL_MS = 60_000
const TAILSCALE = process.env.TAILSCALE_BIN || 'tailscale'

// Which tailnet node is which device: DEVICE_TAILSCALE_NAMES="phone=<label>,tablet=<label>",
// the first label of each node's MagicDNS name. Unset, the iOS node whose label
// starts with "iphone" is the phone and "ipad" the tablet (the most recently seen
// one when there are several).
const NAMES: Partial<Record<DeviceId, string>> = {}
for (const pair of (process.env.DEVICE_TAILSCALE_NAMES ?? '').split(',')) {
  const [k, v] = pair.split('=').map((s) => s.trim().toLowerCase())
  if (isDeviceId(k) && v && /^[a-z0-9-]{1,63}$/.test(v)) NAMES[k] = v
}
const PREFIX: Record<DeviceId, string> = { phone: 'iphone', tablet: 'ipad' }
const LABEL: Record<DeviceId, string> = { phone: 'phone', tablet: 'tablet' }

// ---------- presence from tailscale ----------

type Seen = { online: boolean; lastSeen: number | null }
let presence: Partial<Record<DeviceId, Seen>> = {}
let polling = false

const seenAt = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  // tailscale writes the zero time (0001-01-01) for "never"
  return Number.isFinite(t) && t > Date.UTC(2020, 0, 1) ? t : null
}

async function pollTailscale() {
  if (polling) return
  polling = true
  try {
    const { stdout } = await exec(TAILSCALE, ['status', '--json'], { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 })
    const doc = JSON.parse(stdout) as { Peer?: Record<string, Record<string, unknown>> } | null
    const peers = doc && typeof doc.Peer === 'object' && doc.Peer ? Object.values(doc.Peer) : []
    const now = Date.now()
    const next: Partial<Record<DeviceId, Seen>> = {}
    for (const id of DEVICE_IDS) {
      for (const p of peers) {
        if (!p || typeof p !== 'object') continue
        const label = String(p.DNSName ?? '').split('.')[0].toLowerCase()
        const match = NAMES[id] ? label === NAMES[id] : p.OS === 'iOS' && label.startsWith(PREFIX[id])
        if (!match) continue
        const online = p.Online === true
        const lastSeen = online ? now : seenAt(p.LastSeen)
        const cur = next[id]
        if (!cur || (lastSeen ?? 0) > (cur.lastSeen ?? 0)) next[id] = { online, lastSeen }
      }
    }
    presence = next
  } catch (err) {
    // tailscale down or not installed: keep the last answer, the 15 min window ages it out
    console.warn('[devices] tailscale status failed', { error: (err as Error).message.slice(0, 120) })
  } finally {
    polling = false
  }
}
void pollTailscale()
setInterval(() => void pollTailscale(), POLL_MS).unref()

// ---------- battery and storage from the Home Assistant app ----------

type HaState = { entity_id: string; state: string; last_updated?: string; last_reported?: string; attributes?: Record<string, unknown> }
const haReads: Partial<Record<DeviceId, DeviceReport>> = {}
const deviceOfEntity = (slug: string): DeviceId | null => (/ipad/.test(slug) ? 'tablet' : /iphone|phone/.test(slug) ? 'phone' : null)
/** "127.87 GB" (the app's storage attributes) in bytes, else null. */
const bytesOf = (v: unknown): number | null => {
  const m = /^\s*([\d.]+)\s*(KB|MB|GB|TB)\s*$/i.exec(String(v ?? ''))
  if (!m) return null
  const mult: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }
  const n = Number(m[1]) * mult[m[2].toUpperCase()]
  return Number.isFinite(n) ? n : null
}
const tsOf = (s: HaState): number => Math.max(Date.parse(s.last_reported ?? '') || 0, Date.parse(s.last_updated ?? '') || 0)

let haPolling = false
async function pollHa() {
  if (haPolling) return
  haPolling = true
  try {
    const states = (await haRequest('GET', '/api/states')) as HaState[]
    if (!Array.isArray(states)) return
    const by = new Map(states.map((st) => [st.entity_id, st]))
    for (const st of states) {
      const m = /^sensor\.(.+)_battery_level$/.exec(st.entity_id)
      if (!m) continue
      const dev = deviceOfEntity(m[1])
      const pct = Number(st.state)
      if (!dev || !Number.isFinite(pct) || pct < 0 || pct > 100) continue
      const bs = String(by.get(`sensor.${m[1]}_battery_state`)?.state ?? '').toLowerCase()
      const status: BatteryStatus = bs === 'charging' ? 'charging' : bs === 'full' ? 'full'
        : bs === 'not charging' || bs === 'unplugged' || bs === 'discharging' ? 'discharging' : 'unknown'
      const stor = by.get(`sensor.${m[1]}_storage`)
      const total = bytesOf(stor?.attributes?.Total)
      const avail = bytesOf(stor?.attributes?.Available)
      const ts = tsOf(st) || Date.now()
      const cur = haReads[dev]
      if (cur && cur.ts > ts) continue
      haReads[dev] = {
        ts, battery: Math.round(pct), status,
        storageTotal: total, storageUsed: total != null && avail != null ? Math.max(0, total - avail) : null,
      }
    }
  } catch (err) {
    console.warn('[devices] home assistant read failed', { error: (err as Error).message.slice(0, 120) })
  } finally {
    haPolling = false
  }
}
void pollHa()
setInterval(() => void pollHa(), POLL_MS).unref()

// ---------- the hosts view ----------

type HostMetric = { percent: number; used: number; total: number }
export type DeviceHost = {
  host: DeviceId
  label: string
  os: 'ios'
  online: boolean
  stale: boolean
  /** when the numbers were taken (the last report), else when tailscale last saw it */
  ts: number | null
  /** ms, the last time either source heard from the device */
  seen: number | null
  uptime: null
  cpu: null
  memory: null
  disk: HostMetric | null
  battery: { percent: number; status: BatteryStatus } | null
  error?: string
}

// The last report per device, read from SQLite once and then kept current by the route.
const reports = new Map<DeviceId, DeviceReport | null>()
const report = (id: DeviceId): DeviceReport | null => {
  if (!reports.has(id)) reports.set(id, readDeviceReport(id))
  return reports.get(id) ?? null
}

/** The phone and tablet as /api/hosts entries. A device neither source has ever heard from is left out (it stays a model-only row). */
export function deviceHosts(now = Date.now()): DeviceHost[] {
  const out: DeviceHost[] = []
  for (const id of DEVICE_IDS) {
    const p = presence[id]
    const own = report(id)
    const ha = haReads[id] ?? null
    const r = own && ha ? (own.ts >= ha.ts ? own : ha) : own ?? ha
    if (!p && !r) continue
    const seen = Math.max(p?.lastSeen ?? 0, r?.ts ?? 0) || null
    const online = Boolean(p?.online) || (seen != null && now - seen < ONLINE_MS)
    const disk = r && r.storageUsed != null && r.storageTotal != null && r.storageTotal > 0
      ? { used: r.storageUsed, total: r.storageTotal, percent: (r.storageUsed / r.storageTotal) * 100 }
      : null
    out.push({
      host: id,
      label: LABEL[id],
      os: 'ios',
      online,
      stale: online && r != null && now - r.ts > STALE_MS,
      ts: r?.ts ?? seen,
      seen,
      uptime: null,
      cpu: null,
      memory: null,
      disk,
      battery: r ? { percent: r.battery, status: r.status } : null,
      ...(r ? {} : { error: 'no battery report yet' }),
    })
  }
  return out
}

// ---------- rate limits ----------

// Sliding windows in memory, keyed by address or device. Small and bounded:
// the map is cleared outright if it ever grows past MAX_KEYS.
const WINDOW_MS = 10 * 60_000
const MAX_KEYS = 2_000
const hits = new Map<string, number[]>()
function over(key: string, limit: number, now: number): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (list.length >= limit) { hits.set(key, list); return true }
  list.push(now)
  if (hits.size >= MAX_KEYS && !hits.has(key)) hits.clear()
  hits.set(key, list)
  return false
}
// Peek without counting (the failure budget is spent only by failures).
function spent(key: string, limit: number, now: number): boolean {
  return (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS).length >= limit
}
const PER_ADDRESS = 60
const FAILURES_PER_ADDRESS = 10
const PER_DEVICE = 30

// ---------- the report ----------

const MAX_STORAGE_GB = 100_000

/** A number from JSON or from a Shortcut text field ("87", "87%"), else null. */
const toNum = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^\s*\d{1,6}(\.\d{1,6})?\s*%?\s*$/.test(v)) return Number(v.replace('%', '').trim())
  return null
}
/** A Shortcuts boolean: true/false, Yes/No (a boolean dropped into a text field), 1/0. */
const toBool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 0) return v === 1
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === 'yes' || s === '1') return true
    if (s === 'false' || s === 'no' || s === '0') return false
  }
  return null
}

type Parsed = { ok: true; report: Omit<DeviceReport, 'ts'> } | { ok: false; error: string }

export function parseReport(body: unknown): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'send a JSON object' }
  const b = body as Record<string, unknown>
  if (Object.keys(b).length > 12) return { ok: false, error: 'too many fields' }
  let battery = toNum(b.battery)
  if (battery == null) return { ok: false, error: 'battery must be a number from 0 to 100' }
  // an older Shortcut can hand over a fraction (0.87)
  if (battery > 0 && battery < 1 && !Number.isInteger(battery)) battery *= 100
  if (battery < 0 || battery > 100) return { ok: false, error: 'battery must be a number from 0 to 100' }
  const charging = b.charging === undefined ? null : toBool(b.charging)
  const connected = b.connected === undefined ? null : toBool(b.connected)
  if (b.charging !== undefined && charging == null) return { ok: false, error: 'charging must be true or false' }
  if (b.connected !== undefined && connected == null) return { ok: false, error: 'connected must be true or false' }
  const status: BatteryStatus =
    charging === true ? 'charging'
      : connected === true ? (battery >= 99 ? 'full' : 'not charging')
        : charging === false || connected === false ? 'discharging'
          : 'unknown'
  let storageUsed: number | null = null
  let storageTotal: number | null = null
  if (b.storageUsedGb !== undefined || b.storageTotalGb !== undefined) {
    const used = toNum(b.storageUsedGb)
    const total = toNum(b.storageTotalGb)
    if (used == null || total == null || total <= 0 || total > MAX_STORAGE_GB || used < 0 || used > total) {
      return { ok: false, error: 'storageUsedGb and storageTotalGb must both be numbers, used no more than total' }
    }
    // iOS counts storage in decimal gigabytes
    storageUsed = used * 1e9
    storageTotal = total * 1e9
  }
  return { ok: true, report: { battery: Math.round(battery * 10) / 10, status, storageUsed, storageTotal } }
}

const bearer = (req: Request): string | undefined => {
  const h = String(req.headers.authorization ?? '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

router.post('/devices/:id/report', (req: Request, res: Response) => {
  const now = Date.now()
  // the socket address: forwarded headers are client-controlled
  const addr = req.socket.remoteAddress || 'unknown'
  if (over(`a:${addr}`, PER_ADDRESS, now)) return res.status(429).json({ error: 'too many requests' })
  if (spent(`f:${addr}`, FAILURES_PER_ADDRESS, now)) return res.status(429).json({ error: 'too many failed attempts, wait 10 minutes' })
  const id = req.params.id
  if (!isDeviceId(id)) return res.status(404).json({ error: 'unknown device' })
  if (!checkDeviceToken(id, bearer(req))) {
    over(`f:${addr}`, FAILURES_PER_ADDRESS, now)
    console.warn('[devices] report refused: bad or missing token', { device: id })
    return res.status(401).json({ error: 'bad or missing device token' })
  }
  if (over(`d:${id}`, PER_DEVICE, now)) return res.status(429).json({ error: 'too many reports from this device' })
  const parsed = parseReport(req.body)
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })
  const r: DeviceReport = { ts: now, ...parsed.report }
  saveDeviceReport(id, r)
  reports.set(id, r)
  res.json({ ok: true, device: id, battery: r.battery, status: r.status, storage: r.storageTotal != null })
})

export default router
