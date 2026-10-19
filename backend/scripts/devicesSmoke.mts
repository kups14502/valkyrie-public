/**
 * Offline check of the phone/tablet battery reports (lib/devices.ts +
 * routes/devices.ts). Runs against a throwaway data dir and a loopback server
 * on a random port, so the live devices.sqlite and the running API are never
 * touched. Presence comes from the real `tailscale status --json` (read only).
 * Never prints a token.
 *
 *   node --import tsx scripts/devicesSmoke.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-devices-'))
process.env.VALKYRIE_DATA_DIR = dir

const { default: express } = await import('express')
const lib = await import('../src/lib/devices.ts')
const route = await import('../src/routes/devices.ts')

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api', route.default)
const server = http.createServer(app)
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}
const post = async (id: string, body: unknown, token?: string) => {
  const r = await fetch(`${base}/devices/${id}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null }
}

try {
  const phone = lib.issueDeviceToken('phone')
  check('token is long and url-safe', /^[A-Za-z0-9_-]{40,}$/.test(phone))
  check('only the hash is stored', fs.readdirSync(dir).every((f) => !fs.readFileSync(path.join(dir, f)).includes(Buffer.from(phone))))

  let r = await post('phone', { battery: 80, charging: true })
  check('no token is 401', r.status === 401, String(r.status))
  r = await post('phone', { battery: 80, charging: true }, phone.slice(0, -2) + 'xx')
  check('wrong token is 401', r.status === 401, String(r.status))
  r = await post('watch', { battery: 80 }, phone)
  check('unknown device is 404', r.status === 404, String(r.status))
  const tablet = lib.issueDeviceToken('tablet')
  r = await post('phone', { battery: 80 }, tablet)
  check("the tablet's token does not open the phone", r.status === 401, String(r.status))

  r = await post('phone', { battery: 87, charging: true, connected: true }, phone)
  check('a good report is 200', r.status === 200 && r.body?.status === 'charging' && r.body?.battery === 87, JSON.stringify(r.body))
  r = await post('phone', { battery: '64%', charging: 'No', connected: 'No' }, phone)
  check('Shortcut text values parse', r.status === 200 && r.body?.battery === 64 && r.body?.status === 'discharging', JSON.stringify(r.body))
  r = await post('phone', { battery: 100, charging: false, connected: true }, phone)
  check('on the charger at 100 is full', r.body?.status === 'full', JSON.stringify(r.body))
  r = await post('phone', { battery: 0.42 }, phone)
  check('a fraction becomes a percent', r.body?.battery === 42 && r.body?.status === 'unknown', JSON.stringify(r.body))
  r = await post('phone', { battery: 80, charging: false, connected: true }, phone)
  check('on the charger, holding at 80, is not charging', r.body?.status === 'not charging', JSON.stringify(r.body))
  for (const bad of [{ battery: 140 }, { battery: -1 }, { battery: 'lots' }, { battery: 50, charging: 'maybe' }, { battery: 50, storageUsedGb: 300, storageTotalGb: 256 }, { battery: 50, storageUsedGb: 10 }, [1, 2], {}]) {
    r = await post('phone', bad, phone)
    check(`rejects ${JSON.stringify(bad)}`, r.status === 400, `${r.status} ${r.body?.error ?? ''}`)
  }
  r = await post('tablet', { battery: 55, charging: false, connected: false, storageUsedGb: 101.5, storageTotalGb: 256 }, tablet)
  check('storage is accepted', r.status === 200 && r.body?.storage === true, JSON.stringify(r.body))

  const hosts = route.deviceHosts()
  const ph = hosts.find((h) => h.host === 'phone')
  const tb = hosts.find((h) => h.host === 'tablet')
  check('phone is a host with its last battery', ph?.battery?.percent === 80 && ph?.battery?.status === 'not charging' && ph.online, JSON.stringify(ph))
  check('tablet disk comes from storage', tb?.disk != null && Math.round(tb.disk.percent) === 40 && tb.disk.total === 256e9, JSON.stringify(tb?.disk))
  const later = route.deviceHosts(Date.now() + 4 * 3_600_000).find((h) => h.host === 'phone')
  check('a 4 h old reading never looks fresh (stale, or offline)', later != null && (later.stale || !later.online), JSON.stringify({ online: later?.online, stale: later?.stale }))

  // the failure budget: 10 bad tokens per address per 10 minutes, then 429 even for a good one
  let last = 0
  for (let i = 0; i < 7; i++) last = (await post('tablet', { battery: 50 }, 'nope')).status
  check('bad tokens keep answering 401 inside the budget', last === 401, String(last))
  r = await post('tablet', { battery: 50 }, tablet)
  check('after 10 failures the address waits', r.status === 429, String(r.status))

  check('revoke works', lib.revokeDeviceToken('phone') && !lib.checkDeviceToken('phone', phone))

  // presence, read only: what odin's tailscale says about the two iOS nodes right now
  await new Promise((res) => setTimeout(res, 1500))
  for (const h of route.deviceHosts()) {
    console.log(`info ${h.host}: online=${h.online} seen=${h.seen ? new Date(h.seen).toISOString() : 'never'} battery=${h.battery?.percent ?? '-'}`)
  }
} finally {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
