import { api } from '../../lib/api'

// The Car tab's data: GET /api/vehicles/:id (every control's state and limits,
// backend routes/vehicles.ts VehicleView) and POST /api/vehicles/:id/command.
// The view model is re-checked field by field, since it is persisted and fed
// back on the next open (kit/data.ts useLive). The car's coordinates never go
// into it: they stay in memory (carPlace) for the Map button only, so they are
// never written to storage and never drawn as text.

export type CarState = 'awake' | 'asleep' | 'offline' | 'unknown'
export type ChargingState = 'starting' | 'charging' | 'stopped' | 'complete' | 'disconnected' | 'no_power'
export type Opening = 'open' | 'closed' | 'opening' | 'closing'
export type Seat = 'front_left' | 'front_right' | 'rear_left' | 'rear_center' | 'rear_right' | 'third_row_left' | 'third_row_right'
export type Door = 'front_driver' | 'front_passenger' | 'rear_driver' | 'rear_passenger'
export type Tire = 'fl' | 'fr' | 'rl' | 'rr'

/** The actions the backend takes (lib/vehicles.ts VEHICLE_ACTIONS). */
export type CarAction =
  | 'lock' | 'unlock' | 'sentry_on' | 'sentry_off'
  | 'climate_on' | 'climate_off' | 'climate_temp' | 'defrost_on' | 'defrost_off'
  | `seat_heat_${Seat}` | 'wheel_heat'
  | 'charge_start' | 'charge_stop' | 'charge_limit' | 'charge_amps' | 'port_open' | 'port_close'
  | 'frunk_open' | 'trunk_open' | 'trunk_close' | 'windows_vent' | 'windows_close'
  | 'flash' | 'honk' | 'wake'

export type NumberControl = { value: number | null; min: number; max: number; step: number }
export type LevelControl = { level: string | null; options: string[] }

export type CarVM = {
  id: string
  label: string
  model: string | null
  state: CarState
  since: number | null
  online: boolean
  stale: boolean
  keyMissing: boolean
  /** ms, the newest report among the car's entities */
  ts: number
  battery: number | null
  rangeMi: number | null
  security: { locked: boolean | null; sentry: boolean | null; doorsOpen: Door[]; windowsOpen: Door[] }
  climate: {
    on: boolean | null
    target: number | null
    min: number | null
    max: number | null
    unit: 'F' | 'C'
    insideF: number | null
    outsideF: number | null
    defrost: boolean | null
    seats: ({ seat: Seat } & LevelControl)[]
    wheel: LevelControl | null
  }
  charge: {
    on: boolean | null
    state: ChargingState | null
    cable: boolean | null
    kw: number | null
    rateMph: number | null
    amps: number | null
    volts: number | null
    addedKwh: number | null
    fullAt: number | null
    limit: NumberControl | null
    current: NumberControl | null
    port: Opening | null
  }
  openings: { frunk: Opening | null; trunk: Opening | null; windows: Opening | null }
  status: {
    tiresPsi: Record<Tire, number | null> | null
    tireWarn: Tire[]
    odometerMi: number | null
    software: { installed: string | null; latest: string | null; available: boolean; installing: boolean; pct: number | null } | null
    home: boolean | null
    /** the backend has a position for the Map button (the position itself is in carPlace, memory only) */
    located: boolean
  }
  actions: CarAction[]
}

const SEATS: readonly Seat[] = ['front_left', 'front_right', 'rear_left', 'rear_center', 'rear_right', 'third_row_left', 'third_row_right']
const DOORS: readonly Door[] = ['front_driver', 'front_passenger', 'rear_driver', 'rear_passenger']
const TIRES: readonly Tire[] = ['fl', 'fr', 'rl', 'rr']
const STATES: readonly CarState[] = ['awake', 'asleep', 'offline', 'unknown']
const CHARGING: readonly ChargingState[] = ['starting', 'charging', 'stopped', 'complete', 'disconnected', 'no_power']
const OPENINGS: readonly Opening[] = ['open', 'closed', 'opening', 'closing']
const ACTIONS: readonly string[] = [
  'lock', 'unlock', 'sentry_on', 'sentry_off', 'climate_on', 'climate_off', 'climate_temp', 'defrost_on', 'defrost_off',
  ...SEATS.map((s) => `seat_heat_${s}`), 'wheel_heat', 'charge_start', 'charge_stop', 'charge_limit', 'charge_amps', 'port_open', 'port_close',
  'frunk_open', 'trunk_open', 'trunk_close', 'windows_vent', 'windows_close', 'flash', 'honk', 'wake',
]

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {})
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\p{Cc}/gu, '').trim().slice(0, max) : null)
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : null)
const listOf = <T extends string>(v: unknown, list: readonly T[]): T[] => (Array.isArray(v) ? v.filter((x): x is T => (list as readonly string[]).includes(x)) : [])

function numberControl(v: unknown): NumberControl | null {
  const o = obj(v)
  const min = fin(o.min)
  const max = fin(o.max)
  const step = fin(o.step)
  if (min == null || max == null || step == null || step <= 0 || max < min) return null
  return { value: fin(o.value), min, max, step }
}

function levelControl(v: unknown): LevelControl | null {
  const o = obj(v)
  const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  if (!options.length) return null
  return { level: typeof o.level === 'string' && options.includes(o.level) ? o.level : null, options }
}

/** Where each car is, from the newest read: memory only (the Map button), never persisted or drawn. */
const places = new Map<string, { lat: number; lon: number }>()
export const carPlace = (id: string): { lat: number; lon: number } | null => places.get(id) ?? null

/** The backend's view, re-checked. The position goes to carPlace, never into the view model. */
export function carVM(raw: unknown): CarVM | null {
  const r = obj(raw)
  const id = typeof r.id === 'string' && /^car-[a-z0-9_]{1,64}$/.test(r.id) ? r.id : null
  if (!id) return null
  const sec = obj(r.security)
  const cl = obj(r.climate)
  const ch = obj(r.charge)
  const op = obj(r.openings)
  const st = obj(r.status)
  const loc = obj(st.location)
  const lat = fin(loc.lat)
  const lon = fin(loc.lon)
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) places.set(id, { lat, lon })
  else if ('location' in st) places.delete(id)
  const tires = obj(st.tiresPsi)
  const sw = st.software ? obj(st.software) : null
  return {
    id,
    label: str(r.label) ?? 'Car',
    model: str(r.model),
    state: oneOf(r.state, STATES) ?? 'unknown',
    since: fin(r.since),
    online: r.online !== false,
    stale: r.stale === true,
    keyMissing: r.keyMissing === true,
    ts: fin(r.ts) ?? 0,
    battery: fin(r.battery),
    rangeMi: fin(r.rangeMi),
    security: {
      locked: bool(sec.locked),
      sentry: bool(sec.sentry),
      doorsOpen: listOf(sec.doorsOpen, DOORS),
      windowsOpen: listOf(sec.windowsOpen, DOORS),
    },
    climate: {
      on: bool(cl.on),
      target: fin(cl.target),
      min: fin(cl.min),
      max: fin(cl.max),
      unit: cl.unit === 'C' ? 'C' : 'F',
      insideF: fin(cl.insideF),
      outsideF: fin(cl.outsideF),
      defrost: bool(cl.defrost),
      seats: Array.isArray(cl.seats) ? cl.seats.flatMap((s) => {
        const seat = oneOf(obj(s).seat, SEATS)
        const c = levelControl(s)
        return seat && c ? [{ seat, ...c }] : []
      }) : [],
      wheel: cl.wheel ? levelControl(cl.wheel) : null,
    },
    charge: {
      on: bool(ch.on),
      state: oneOf(ch.state, CHARGING),
      cable: bool(ch.cable),
      kw: fin(ch.kw),
      rateMph: fin(ch.rateMph),
      amps: fin(ch.amps),
      volts: fin(ch.volts),
      addedKwh: fin(ch.addedKwh),
      fullAt: fin(ch.fullAt),
      limit: ch.limit ? numberControl(ch.limit) : null,
      current: ch.current ? numberControl(ch.current) : null,
      port: oneOf(ch.port, OPENINGS),
    },
    openings: { frunk: oneOf(op.frunk, OPENINGS), trunk: oneOf(op.trunk, OPENINGS), windows: oneOf(op.windows, OPENINGS) },
    status: {
      tiresPsi: st.tiresPsi ? Object.fromEntries(TIRES.map((t) => [t, fin(tires[t])])) as Record<Tire, number | null> : null,
      tireWarn: listOf(st.tireWarn, TIRES),
      odometerMi: fin(st.odometerMi),
      software: sw ? { installed: str(sw.installed), latest: str(sw.latest), available: sw.available === true, installing: sw.installing === true, pct: fin(sw.pct) } : null,
      home: bool(st.home),
      located: (lat != null && lon != null) || st.located === true,
    },
    actions: listOf(r.actions, ACTIONS as readonly CarAction[]),
  }
}

/** A persisted view model from an older build, or junk: re-checked, or dropped. */
export const reviveCar = (d: unknown): CarVM | undefined => {
  const v = carVM(d)
  if (!v) return undefined
  // a persisted model never carries a position; `located` stays false until a live read says otherwise
  return { ...v, status: { ...v.status, located: places.has(v.id) } }
}

export async function fetchCar(id: string): Promise<CarVM> {
  const r = await api.get(`/vehicles/${encodeURIComponent(id)}`)
  const v = carVM(r.data)
  if (!v) throw new Error('the car view is not readable')
  return v
}

export type CommandResult = { ok: true; view: CarVM | null }

/** Thrown for a command that did not go through: the server's words, the car's real state, and whether the car lacks the key. */
export class CarCommandError extends Error {
  status: number
  keyMissing: boolean
  view: CarVM | null
  constructor(message: string, status: number, keyMissing: boolean, view: CarVM | null) {
    super(message)
    this.status = status
    this.keyMissing = keyMissing
    this.view = view
  }
}

/** One command. A sleeping car is woken by Home Assistant first, so this can take about 30 s. */
export async function sendCarCommand(id: string, action: CarAction, value?: number | string): Promise<CommandResult> {
  try {
    const r = await api.post(`/vehicles/${encodeURIComponent(id)}/command`, value === undefined ? { action } : { action, value })
    return { ok: true, view: carVM(obj(r.data).view) }
  } catch (e) {
    const x = (e ?? {}) as { response?: { status?: number; data?: unknown }; message?: unknown }
    const d = obj(x.response?.data)
    const status = x.response?.status ?? 0
    const msg = str(d.error, 200) ?? (status ? `the server answered ${status}` : 'no answer from the server')
    throw new CarCommandError(msg, status, d.keyMissing === true, carVM(d.view))
  }
}

/** Where Valkyrie's key is added to the car (Tesla's virtual key page for the app's domain). */
export const KEY_URL = 'https://tesla.com/_ak/kups14502.github.io'

/**
 * The car's position in Apple Maps on an Apple device, Google Maps anywhere
 * else. Built only when the Map button is pressed.
 */
export function mapUrl(p: { lat: number; lon: number }, label: string): string {
  const ll = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`
  const apple = typeof navigator !== 'undefined' && /iPhone|iPad|Macintosh/.test(navigator.userAgent)
  return apple
    ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(label)}`
    : `https://www.google.com/maps/search/?api=1&query=${ll}`
}
