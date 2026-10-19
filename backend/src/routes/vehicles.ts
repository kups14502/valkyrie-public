import {
  batteryStatus, parseRegistry, readVehicleReads, readVehicles, registryTemplate, saveVehicleRead, shows, vehicleFilter,
  type ChargingState, type HaState, type VehicleRead, type VehicleState,
} from '../lib/vehicles.js'
import type { BatteryStatus } from '../lib/devices.js'
import { haRequest } from './lights.js'

// The cars as hosts on /api/hosts (hosts.ts appends vehicleHosts()), from Home
// Assistant's Tesla Fleet integration on odin.
//
// Two reads, both read only:
//   * GET /api/states every minute: every car's sensors (lib/vehicles.ts finds
//     them by their entity prefix, so a new car shows up by itself).
//   * POST /api/template, only when a car is new and every 30 minutes after:
//     renders the device registry's model and name for each car. Rendering a
//     template reads; it calls no service.
// Never a service call, a wake-up or a vehicle command. The integration itself
// polls Tesla every 10 minutes and leaves a sleeping car asleep, so a car
// asleep shows the numbers from when it fell asleep, with that time.
//
// Which cars show: VEHICLES_MODELS (HA device models, default "Model Y", "*"
// for all) and VEHICLES_HIDE (entity prefixes), see lib/vehicles.ts.

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
let polling = false

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

async function poll() {
  if (polling) return
  polling = true
  try {
    const states = (await haRequest('GET', '/api/states')) as HaState[]
    if (!Array.isArray(states)) return
    let found = readVehicles(states, registry)
    const slugs = [...found.reads.map((v) => v.slug), ...found.unavailable]
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
  } finally {
    polling = false
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
