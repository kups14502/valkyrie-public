import { Router } from 'express'
import {
  KEY_MISSING, batteryStatus, carEntities, haMessage, parseRegistry, planCommand, readControls, readVehicleReads, readVehicles,
  registryTemplate, saveVehicleRead, shows, vehicleFilter,
  type ChargingState, type HaState, type VehicleControls, type VehicleRead, type VehicleState,
} from '../lib/vehicles.js'
import type { BatteryStatus } from '../lib/devices.js'
import { isStrongAuth } from '../middleware/auth.js'
import { haFetch, haRequest } from './lights.js'

// The cars as hosts on /api/hosts (hosts.ts appends vehicleHosts()), and the
// Car tab's controls, from Home Assistant's Tesla Fleet integration on odin.
//
// Two reads:
//   * GET /api/states every minute: every car's sensors (lib/vehicles.ts finds
//     them by their entity prefix, so a new car shows up by itself).
//   * POST /api/template, only when a car is new and every 30 minutes after:
//     renders the device registry's model and name for each car. Rendering a
//     template reads; it calls no service.
// The poll never calls a service or wakes a car. The integration itself polls
// Tesla every 10 minutes and leaves a sleeping car asleep, so a car asleep
// shows the numbers from when it fell asleep, with that time.
//
// The one write: POST /api/vehicles/:id/command { action, value? }, the Car
// tab's buttons. lib/vehicles.ts planCommand turns a named action from its
// allowlist into one service call on that car's own entity, every value
// checked against the entity's attributes; anything else is a 400. Unlock and
// whatever opens the car (frunk, trunk, windows, charge port) also need strong
// auth. Home Assistant wakes a sleeping car itself before the command, which
// can take about 30 s. Each command is logged (action, ok, Home Assistant's
// status, never a token), and one fresh read of the states follows it, so the
// page sees what the car did.
//
// Which cars show: VEHICLES_MODELS (HA device models, default "Model Y", "*"
// for all) and VEHICLES_HIDE (entity prefixes), see lib/vehicles.ts. A car that
// does not show takes no command either.

const POLL_MS = 60_000
const REGISTRY_MS = 30 * 60_000
/** no good read from HA for this long: the numbers on screen are marked stale */
const STALE_MS = 30 * 60_000
/** a car gone from HA altogether stops showing once its last reading is this old */
const FORGET_MS = 14 * 86_400_000

const filter = vehicleFilter()
// The last reading per car, from SQLite at start, then from every poll.
const reads = new Map<string, VehicleRead>(readVehicleReads().map((v) => [v.slug, v]))
// The newest good poll: cars with a reading, and cars HA lists without a battery level (the integration lost them).
let listed = new Set<string>()
let lost = new Set<string>()
let registry = new Map<string, { model: string | null; name: string | null }>(
  [...reads.values()].map((v) => [v.slug, { model: v.model, name: v.name }]),
)
let registryAt = 0
let registryTried = 0
let okAt = 0
// Each car's own entity rows from the newest good poll: the Car tab's controls and the commands' checks.
const rows = new Map<string, Map<string, HaState>>()
let pollP: Promise<void> | null = null
let pollStarted = 0

async function readRegistry(slugs: string[]) {
  registryTried = Date.now()
  try {
    const next = parseRegistry(await haRequest('POST', '/api/template', { template: registryTemplate(slugs) }))
    // keep what is known for a car the answer left out
    registry = new Map([...registry, ...next])
    registryAt = Date.now()
  } catch (err) {
    console.warn('[vehicles] device registry read failed', { error: (err as Error).message.slice(0, 120) })
  }
}

/** One poll at a time: a second call while one runs gets the one running. */
function poll(): Promise<void> {
  if (pollP) return pollP
  pollStarted = Date.now()
  pollP = pollOnce().finally(() => { pollP = null })
  return pollP
}

/** A read of the states that starts after `t` (a command's end): a poll already running from before then is waited out, then one more runs. */
async function freshRead(t: number): Promise<void> {
  if (pollP && pollStarted >= t) return pollP
  if (pollP) await pollP
  return poll()
}

async function pollOnce() {
  try {
    const states = (await haRequest('GET', '/api/states')) as HaState[]
    if (!Array.isArray(states)) return
    let found = readVehicles(states, registry)
    const slugs = [...found.reads.map((v) => v.slug), ...found.unavailable]
    for (const s of slugs) rows.set(s, carEntities(states, s))
    for (const s of [...rows.keys()]) if (!slugs.includes(s)) rows.delete(s)
    // a failed read is retried after five minutes, not on every poll
    const due = slugs.some((s) => !registry.get(s)?.model) || Date.now() - registryAt > REGISTRY_MS
    if (slugs.length && due && Date.now() - registryTried > 5 * 60_000) {
      await readRegistry(slugs)
      found = readVehicles(states, registry)
    }
    for (const v of found.reads) {
      const cur = reads.get(v.slug)
      if (cur && cur.ts > v.ts) continue
      reads.set(v.slug, v)
      saveVehicleRead(v)
    }
    listed = new Set(found.reads.map((v) => v.slug))
    lost = new Set(found.unavailable)
    okAt = Date.now()
  } catch (err) {
    console.warn('[vehicles] home assistant read failed', { error: (err as Error).message.slice(0, 120) })
  }
}
void poll()
setInterval(() => void poll(), POLL_MS).unref()

export type VehicleHost = {
  host: string
  label: string
  os: 'vehicle'
  /** false only while the integration cannot reach the car; a sleeping car is online */
  online: boolean
  stale: boolean
  /** ms, when these numbers were read */
  ts: number
  uptime: null
  cpu: null
  memory: null
  disk: null
  battery: { percent: number; status: BatteryStatus }
  vehicle: {
    model: string | null
    state: VehicleState
    since: number | null
    rangeMi: number | null
    chargeLimit: number | null
    charging: ChargingState | null
    chargerKw: number | null
    chargeRateMph: number | null
    fullAt: number | null
    cable: boolean | null
    locked: boolean | null
    home: boolean | null
    insideF: number | null
    outsideF: number | null
    climateOn: boolean | null
  }
  error?: string
}

/** The cars that pass VEHICLES_MODELS and VEHICLES_HIDE, as /api/hosts entries. */
export function vehicleHosts(now = Date.now()): VehicleHost[] {
  const out: VehicleHost[] = []
  for (const v of [...reads.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const model = registry.get(v.slug)?.model ?? v.model
    if (!shows(filter, { slug: v.slug, model })) continue
    // gone from HA altogether (before the first poll, the saved reading stands)
    const gone = okAt > 0 && !listed.has(v.slug) && !lost.has(v.slug)
    if (gone && now - v.ts > FORGET_MS) continue
    const state: VehicleState = lost.has(v.slug) || gone ? 'offline' : v.state
    out.push({
      host: `car-${v.slug}`,
      label: registry.get(v.slug)?.name ?? v.name,
      os: 'vehicle',
      online: state !== 'offline',
      stale: state !== 'offline' && (okAt === 0 || now - okAt > STALE_MS),
      ts: v.ts,
      uptime: null,
      cpu: null,
      memory: null,
      disk: null,
      battery: { percent: v.battery, status: batteryStatus(v.charging) },
      vehicle: {
        model,
        state,
        since: state === v.state ? v.since : null,
        rangeMi: v.rangeMi,
        chargeLimit: v.chargeLimit,
        charging: v.charging,
        chargerKw: v.chargerKw,
        chargeRateMph: v.chargeRateMph,
        fullAt: v.fullAt != null && v.fullAt > now - 60_000 ? v.fullAt : null,
        cable: v.cable,
        locked: v.locked,
        home: v.home,
        insideF: v.insideF,
        outsideF: v.outsideF,
        climateOn: v.climateOn,
      },
      ...(state === 'offline' ? { error: 'Home Assistant cannot reach the car' } : {}),
    })
  }
  return out
}

// ---------- the Car tab: GET /api/vehicles/:id and POST /api/vehicles/:id/command ----------

const router = Router()
const CAR_ID = /^car-([a-z0-9_]{1,64})$/
/** Home Assistant wakes a sleeping car first (up to about 30 s, tesla_fleet helpers.wake_up_vehicle), then sends the command */
const COMMAND_MS = 75_000
/** commands out at once per car; one more is a 429 */
const MAX_INFLIGHT = 3
/** a view asked for while the newest read is older than this starts one more read, in the background */
const VIEW_FRESH_MS = 20_000

const inflight = new Map<string, number>()
/** cars whose newest command failed because the car does not have Home Assistant's key */
const keyMissing = new Set<string>()

/** GET /api/vehicles/:id: the car as the host list shows it, every control's state and limits, and the actions it takes. */
export type VehicleView = VehicleControls & {
  id: string
  label: string
  model: string | null
  state: VehicleState
  since: number | null
  online: boolean
  stale: boolean
  /** the newest command failed on the car's key: the page says how to add it */
  keyMissing: boolean
}

/** A car the host list shows (VEHICLES_MODELS, VEHICLES_HIDE); any other id is no car. */
function shownCar(id: string): { slug: string; host: VehicleHost } | null {
  const m = CAR_ID.exec(id)
  if (!m) return null
  const host = vehicleHosts().find((h) => h.host === id)
  return host ? { slug: m[1], host } : null
}

function viewOf(id: string): VehicleView | null {
  const car = shownCar(id)
  const by = car && rows.get(car.slug)
  if (!car || !by) return null
  const v = car.host.vehicle
  return {
    ...readControls(car.slug, by),
    id: car.host.host,
    label: car.host.label,
    model: v.model,
    state: v.state,
    since: v.since,
    online: car.host.online,
    stale: car.host.stale,
    keyMissing: keyMissing.has(car.slug),
  }
}

/** an action name as the log may show it (it came from the client) */
const logName = (a: unknown) => (typeof a === 'string' ? a.replace(/[^a-z0-9_]/gi, '?').slice(0, 40) : typeof a)

router.get('/vehicles/:id', (req, res) => {
  const id = String(req.params.id)
  if (!shownCar(id)) return res.status(404).json({ error: 'no such car' })
  if (Date.now() - okAt > VIEW_FRESH_MS) void poll()
  const view = viewOf(id)
  if (!view) return res.status(503).json({ error: 'Home Assistant has not answered yet' })
  res.setHeader('Cache-Control', 'no-store')
  return res.json(view)
})

router.post('/vehicles/:id/command', async (req, res) => {
  const id = String(req.params.id)
  const car = shownCar(id)
  if (!car) return res.status(404).json({ error: 'no such car' })
  const body: unknown = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'send { action, value? }' })
  const extra = Object.keys(body).filter((k) => k !== 'action' && k !== 'value')
  if (extra.length) return res.status(400).json({ error: `unexpected field: ${logName(extra[0])}` })
  const { action, value } = body as { action?: unknown; value?: unknown }
  const by = rows.get(car.slug)
  if (!by) return res.status(503).json({ error: 'Home Assistant has not answered yet' })
  const plan = planCommand(car.slug, by, action, value)
  if (!plan.ok) {
    console.log('[vehicles] command', { car: id, action: logName(action), ok: false, haStatus: null, refused: plan.error })
    return res.status(plan.status).json({ error: plan.error })
  }
  if (plan.strong && !(await isStrongAuth(req))) {
    console.log('[vehicles] command', { car: id, action: logName(action), ok: false, haStatus: null, refused: 'strong auth' })
    // 403, never 401: a 401 makes the app drop its token
    return res.status(403).json({ error: 'this needs the tailnet or a signed-in app token' })
  }
  const out = inflight.get(car.slug) ?? 0
  if (out >= MAX_INFLIGHT) return res.status(429).json({ error: 'the car still has commands on the way' })
  inflight.set(car.slug, out + 1)

  const t0 = Date.now()
  let ha: { status: number; text: string } | null = null
  let failure: string | null = null
  try {
    ha = await haFetch('POST', `/api/services/${plan.call.domain}/${plan.call.service}`, plan.call.data, COMMAND_MS)
  } catch (err) {
    const e = err as Error
    failure = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `no answer in ${COMMAND_MS / 1000} s; the car may still do it`
      : 'Home Assistant did not answer'
  } finally {
    const n = (inflight.get(car.slug) ?? 1) - 1
    if (n > 0) inflight.set(car.slug, n)
    else inflight.delete(car.slug)
  }
  const ok = !!ha && ha.status >= 200 && ha.status < 300
  const error = ok ? null : failure ?? haMessage(ha?.text) ?? `Home Assistant answered ${ha?.status}`
  const missing = !ok && KEY_MISSING.test(error ?? '')
  if (ok) keyMissing.delete(car.slug)
  else if (missing) keyMissing.add(car.slug)
  console.log('[vehicles] command', {
    car: id, action: logName(action), ok,
    haStatus: ha?.status ?? (failure?.startsWith('no answer') ? 'timeout' : 'no answer'), ms: Date.now() - t0,
    ...(missing ? { keyMissing: true } : {}),
  })
  // one fresh read either way: the page shows what the car did, or what it still is
  await freshRead(Date.now())
  const view = viewOf(id)
  if (ok) return res.json({ ok: true, view })
  return res.status(failure?.startsWith('no answer') ? 504 : 502).json({ ok: false, error, keyMissing: missing, view })
})

export default router
