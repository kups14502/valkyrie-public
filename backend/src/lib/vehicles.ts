import { openDb } from './db.js'
import type { BatteryStatus } from './devices.js'

// Cars on /api/hosts, read from Home Assistant's Tesla Fleet integration
// (routes/vehicles.ts polls; this module holds the pure parts and the last
// reading per car, in DATA_DIR/vehicles.sqlite, so a restart still shows where
// the battery was left).
//
// The readings are read only: polling never calls a Home Assistant service or
// wakes a car. A sleeping car is never polled for data by the integration
// either: its sensors keep the values from when it fell asleep, and that is
// what the page shows, labeled with the time. The one way to the car is the
// Car tab's POST /api/vehicles/:id/command, and only through planCommand below:
// an allowlist of named actions, each mapped to one service on that car's own
// entity, every value checked against the entity's own attributes.
//
// No timers and no network in here, so a smoke script can import it.

/** HA's /api/states rows, the fields used here */
export type HaState = {
  entity_id: string
  state: string
  last_changed?: string
  last_updated?: string
  last_reported?: string
  attributes?: Record<string, unknown>
}

/**
 * tesla_fleet's binary_sensor.<car>_status is on only while Tesla reports the
 * car online. Off covers asleep and Tesla's own "offline" (no signal), which
 * the integration treats as asleep too, so off reads Asleep, never Offline.
 * Offline is the integration itself unavailable for the car (HA cannot reach
 * Tesla, or the car is gone from the account). Unknown: HA has no status
 * sensor for the car (another integration's naming).
 */
export type VehicleState = 'awake' | 'asleep' | 'offline' | 'unknown'
export const VEHICLE_STATES: readonly VehicleState[] = ['awake', 'asleep', 'offline', 'unknown']

/** sensor.<car>_charging (tesla_fleet's enum) */
export const CHARGING_STATES = ['starting', 'charging', 'stopped', 'complete', 'disconnected', 'no_power'] as const
export type ChargingState = (typeof CHARGING_STATES)[number]

export type VehicleRead = {
  /** the entity prefix HA gives the car (sensor.<slug>_battery_level) */
  slug: string
  /** the car's name in HA (device name), else the battery sensor's friendly name less its suffix */
  name: string
  /** HA's device model ("Model Y"), null until the device registry answers */
  model: string | null
  /** ms, the newest report HA has for the car's sensors */
  ts: number
  state: VehicleState
  /** ms, when the car went awake, asleep or offline (HA's last_changed on the status sensor) */
  since: number | null
  battery: number
  rangeMi: number | null
  /** % */
  chargeLimit: number | null
  charging: ChargingState | null
  chargerKw: number | null
  /** miles of range added per hour */
  chargeRateMph: number | null
  /** ms, when the battery reaches the limit at this rate (only while charging) */
  fullAt: number | null
  cable: boolean | null
  locked: boolean | null
  /** true at the HA home zone, false anywhere else; never the place itself */
  home: boolean | null
  insideF: number | null
  outsideF: number | null
  climateOn: boolean | null
}

const SLUG = /^[a-z0-9_]{1,64}$/
/** the phone and tablet report sensor.<device>_battery_level too (routes/devices.ts) */
const PHONE_OR_TABLET = /ipad|iphone|phone/

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !/^\s*-?\d+(\.\d+)?\s*$/.test(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const ms = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) && t > Date.UTC(2020, 0, 1) ? t : null
}
const onOff = (v: string | undefined): boolean | null => (v === 'on' ? true : v === 'off' ? false : null)
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)
const clampPct = (v: number | null) => (v == null || v < 0 || v > 100 ? null : v)

/** A name fit to show: printable, trimmed, at most 40 characters. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return s ? s.slice(0, 40) : null
}

/** °F from a temperature sensor, whichever unit HA reports it in. */
function fahrenheit(st: HaState | undefined): number | null {
  const v = num(st?.state)
  if (v == null) return null
  const unit = String(st?.attributes?.unit_of_measurement ?? '')
  const f = /C$/.test(unit) ? v * 1.8 + 32 : v
  return f > -80 && f < 200 ? round1(f) : null
}

/** Miles from a distance sensor, whichever unit HA reports it in. */
function miles(st: HaState | undefined): number | null {
  const v = num(st?.state)
  if (v == null || v < 0 || v > 2000) return null
  return round1(/^km$/i.test(String(st?.attributes?.unit_of_measurement ?? '')) ? v / 1.609344 : v)
}

/** The battery status a host row shows, from the car's charging state. */
export function batteryStatus(c: ChargingState | null): BatteryStatus {
  if (c === 'charging' || c === 'starting') return 'charging'
  if (c === 'complete') return 'full'
  if (c === 'stopped' || c === 'no_power') return 'not charging'
  if (c === 'disconnected') return 'discharging'
  return 'unknown'
}

/**
 * Every car in HA's states: an entity prefix with both a battery level and a
 * battery range (the phone and tablet have no range, and are excluded by name
 * as well). `known` carries the device registry's model and name per slug.
 * `unavailable`: cars HA lists with no battery level right now (the
 * integration lost them); the route shows their last reading as Offline.
 */
export function readVehicles(states: HaState[], known: ReadonlyMap<string, { model: string | null; name: string | null }> = new Map(), now = Date.now()): { reads: VehicleRead[]; unavailable: string[] } {
  const by = new Map<string, HaState>()
  for (const st of states) if (st && typeof st.entity_id === 'string') by.set(st.entity_id, st)
  const out: VehicleRead[] = []
  const unavailable: string[] = []
  for (const [id, st] of by) {
    const m = /^sensor\.(.+)_battery_level$/.exec(id)
    if (!m || !SLUG.test(m[1]) || PHONE_OR_TABLET.test(m[1])) continue
    const slug = m[1]
    const range = by.get(`sensor.${slug}_battery_range`)
    if (!range) continue
    const e = (kind: string, key: string) => by.get(`${kind}.${slug}_${key}`)
    const status = e('binary_sensor', 'status')
    const pct = clampPct(num(st.state))
    const reg = known.get(slug)
    const friendly = cleanName(String(st.attributes?.friendly_name ?? '').replace(/\s*battery level$/i, ''))
    const name = cleanName(reg?.name) ?? friendly ?? slug.replace(/_/g, ' ')
    if (pct == null) { unavailable.push(slug); continue }
    // the status sensor unavailable is the integration not reaching the car
    const state: VehicleState = status?.state === 'on' ? 'awake' : status?.state === 'off' ? 'asleep' : status ? 'offline' : 'unknown'
    const ch = String(e('sensor', 'charging')?.state ?? '')
    const charging = (CHARGING_STATES as readonly string[]).includes(ch) ? ch as ChargingState : null
    const loc = e('device_tracker', 'location')?.state
    const lock = e('lock', 'lock')?.state
    const climate = e('climate', 'climate')?.state
    const ts = Math.max(0, ...[st, range, status].map((x) => Math.max(ms(x?.last_reported) ?? 0, ms(x?.last_updated) ?? 0)))
    const kw = num(e('sensor', 'charger_power')?.state)
    const rate = num(e('sensor', 'charge_rate')?.state)
    const full = ms(e('sensor', 'time_to_full_charge')?.state)
    out.push({
      slug,
      name,
      model: cleanName(reg?.model),
      ts: ts || now,
      state,
      since: ms(status?.last_changed),
      battery: Math.round(pct),
      rangeMi: miles(range),
      chargeLimit: clampPct(num(e('number', 'charge_limit')?.state)),
      charging,
      chargerKw: kw != null && kw >= 0 && kw < 1000 ? round1(kw) : null,
      chargeRateMph: rate != null && rate >= 0 && rate < 2000 ? round1(rate) : null,
      fullAt: charging === 'charging' || charging === 'starting' ? full : null,
      cable: onOff(e('binary_sensor', 'charge_cable')?.state),
      locked: lock === 'locked' ? true : lock === 'unlocked' ? false : null,
      home: loc === 'home' ? true : loc === 'not_home' || (typeof loc === 'string' && loc !== '' && loc !== 'unknown' && loc !== 'unavailable') ? false : null,
      insideF: fahrenheit(e('sensor', 'inside_temperature')),
      outsideF: fahrenheit(e('sensor', 'outside_temperature')),
      climateOn: climate == null || climate === 'unavailable' || climate === 'unknown' ? null : climate !== 'off',
    })
  }
  return { reads: out.sort((a, b) => a.slug.localeCompare(b.slug)), unavailable: unavailable.sort() }
}

// ---------- which cars show ----------

export type VehicleFilter = { models: string[] | null; hide: Set<string> }

/**
 * VEHICLES_MODELS: HA device models to show, comma separated, default "Model Y"
 * ("*" shows every model). VEHICLES_HIDE: entity prefixes to leave out.
 * A car whose model is not known yet only shows when every model does.
 */
export function vehicleFilter(env: Record<string, string | undefined> = process.env): VehicleFilter {
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const models = list(env.VEHICLES_MODELS ?? 'Model Y')
  return {
    models: models.includes('*') || models.some((m) => m.toLowerCase() === 'all') ? null : models.map((m) => m.toLowerCase()),
    hide: new Set(list(env.VEHICLES_HIDE).map((s) => s.toLowerCase())),
  }
}

export function shows(f: VehicleFilter, v: { slug: string; model: string | null }): boolean {
  if (f.hide.has(v.slug)) return false
  if (!f.models) return true
  return v.model != null && f.models.includes(v.model.toLowerCase())
}

// ---------- the device registry, through HA's template API ----------

/**
 * A template that renders each slug's device model and name as JSON. The slugs
 * are checked against SLUG first, so they go into the template as plain string
 * literals. Rendering a template reads; it calls no service.
 */
export function registryTemplate(slugs: string[]): string {
  const safe = slugs.filter((s) => SLUG.test(s)).map((s) => `'${s}'`).join(', ')
  return `{% set ns = namespace(out=[]) %}{% for s in [${safe}] %}{% set d = device_id('sensor.' ~ s ~ '_battery_level') %}`
    + `{% if d %}{% set ns.out = ns.out + [{'slug': s, 'model': device_attr(d, 'model'), 'name': device_attr(d, 'name_by_user') or device_attr(d, 'name')}] %}{% endif %}`
    + `{% endfor %}{{ ns.out | tojson }}`
}

/** The template's answer, re-validated (it is another program's output). */
export function parseRegistry(v: unknown): Map<string, { model: string | null; name: string | null }> {
  const out = new Map<string, { model: string | null; name: string | null }>()
  if (!Array.isArray(v)) return out
  for (const r of v) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.slug !== 'string' || !SLUG.test(o.slug)) continue
    out.set(o.slug, { model: cleanName(o.model), name: cleanName(o.name) })
  }
  return out
}

// ---------- the Car tab: every control's state, and the commands ----------

/** tesla_fleet's seat heaters, in the order the seat map draws them (a car shows the ones HA has enabled). */
export const SEATS = ['front_left', 'front_right', 'rear_left', 'rear_center', 'rear_right', 'third_row_left', 'third_row_right'] as const
export type Seat = (typeof SEATS)[number]

/** tesla_fleet's door and window sensors (driver = left on a US car). */
export const DOORS = ['front_driver', 'front_passenger', 'rear_driver', 'rear_passenger'] as const
export type Door = (typeof DOORS)[number]

const TIRES = { fl: 'front_left', fr: 'front_right', rl: 'rear_left', rr: 'rear_right' } as const
export type Tire = keyof typeof TIRES

export type Opening = 'open' | 'closed' | 'opening' | 'closing'
const OPENINGS: readonly string[] = ['open', 'closed', 'opening', 'closing']

/** Every action the Car tab may send, by name. Nothing else ever reaches Home Assistant. */
export const VEHICLE_ACTIONS = [
  'lock', 'unlock', 'sentry_on', 'sentry_off',
  'climate_on', 'climate_off', 'climate_temp', 'defrost_on', 'defrost_off',
  ...SEATS.map((s) => `seat_heat_${s}` as const), 'wheel_heat',
  'charge_start', 'charge_stop', 'charge_limit', 'charge_amps', 'port_open', 'port_close',
  'frunk_open', 'trunk_open', 'trunk_close', 'windows_vent', 'windows_close',
  'flash', 'honk', 'wake',
] as const
export type VehicleAction = (typeof VEHICLE_ACTIONS)[number]

export const isVehicleAction = (v: unknown): v is VehicleAction => typeof v === 'string' && (VEHICLE_ACTIONS as readonly string[]).includes(v)

/** Actions that open the car or let someone reach inside it: the route asks for strong auth (middleware/auth.ts). */
export const STRONG_ACTIONS: ReadonlySet<VehicleAction> = new Set<VehicleAction>([
  'unlock', 'frunk_open', 'trunk_open', 'trunk_close', 'windows_vent', 'windows_close', 'port_open', 'port_close',
])

type ValueKind = 'temp' | 'option' | 'limit' | 'amps'
/** The entity (domain.<slug>_key), its service, the value it takes, and the cover feature bit it needs (open 1, close 2). */
type Spec = { domain: string; key: string; service: string; value?: ValueKind; feature?: 1 | 2 }

const SPECS: Record<Exclude<VehicleAction, `seat_heat_${Seat}`>, Spec> = {
  lock: { domain: 'lock', key: 'lock', service: 'lock' },
  unlock: { domain: 'lock', key: 'lock', service: 'unlock' },
  sentry_on: { domain: 'switch', key: 'sentry_mode', service: 'turn_on' },
  sentry_off: { domain: 'switch', key: 'sentry_mode', service: 'turn_off' },
  climate_on: { domain: 'climate', key: 'climate', service: 'turn_on' },
  climate_off: { domain: 'climate', key: 'climate', service: 'turn_off' },
  climate_temp: { domain: 'climate', key: 'climate', service: 'set_temperature', value: 'temp' },
  defrost_on: { domain: 'switch', key: 'defrost', service: 'turn_on' },
  defrost_off: { domain: 'switch', key: 'defrost', service: 'turn_off' },
  wheel_heat: { domain: 'select', key: 'steering_wheel_heater', service: 'select_option', value: 'option' },
  charge_start: { domain: 'switch', key: 'charge', service: 'turn_on' },
  charge_stop: { domain: 'switch', key: 'charge', service: 'turn_off' },
  charge_limit: { domain: 'number', key: 'charge_limit', service: 'set_value', value: 'limit' },
  charge_amps: { domain: 'number', key: 'charge_current', service: 'set_value', value: 'amps' },
  port_open: { domain: 'cover', key: 'charge_port_door', service: 'open_cover', feature: 1 },
  port_close: { domain: 'cover', key: 'charge_port_door', service: 'close_cover', feature: 2 },
  frunk_open: { domain: 'cover', key: 'frunk', service: 'open_cover', feature: 1 },
  trunk_open: { domain: 'cover', key: 'trunk', service: 'open_cover', feature: 1 },
  trunk_close: { domain: 'cover', key: 'trunk', service: 'close_cover', feature: 2 },
  windows_vent: { domain: 'cover', key: 'windows', service: 'open_cover', feature: 1 },
  windows_close: { domain: 'cover', key: 'windows', service: 'close_cover', feature: 2 },
  flash: { domain: 'button', key: 'flash_lights', service: 'press' },
  honk: { domain: 'button', key: 'honk_horn', service: 'press' },
  wake: { domain: 'button', key: 'wake', service: 'press' },
}

const specOf = (a: VehicleAction): Spec => (a.startsWith('seat_heat_')
  ? { domain: 'select', key: `seat_heater_${a.slice('seat_heat_'.length)}`, service: 'select_option', value: 'option' }
  : SPECS[a as keyof typeof SPECS])

export type HaCall = { domain: string; service: string; data: Record<string, unknown> }
export type CommandPlan = { ok: true; call: HaCall; strong: boolean } | { ok: false; status: 400 | 409; error: string }

const fmt = (n: number) => String(Math.round(n * 100) / 100)
const onGrid = (v: number, base: number, step: number) => step <= 0 || Math.abs((v - base) / step - Math.round((v - base) / step)) < 1e-6
const words = (key: string) => key.replace(/_/g, ' ')

/** The rows of one car's entities (<domain>.<slug>_...) out of HA's states. */
export function carEntities(states: HaState[], slug: string): Map<string, HaState> {
  const out = new Map<string, HaState>()
  if (!SLUG.test(slug)) return out
  const mine = new RegExp(`^[a-z_]+\\.${slug}_[a-z0-9_]+$`)
  for (const st of states) if (st && typeof st.entity_id === 'string' && mine.test(st.entity_id)) out.set(st.entity_id, st)
  return out
}

/**
 * The one Home Assistant service call an action may make on this car, or why
 * not. `by`: the car's own entity rows (carEntities). Every value is checked
 * against that entity's attributes: a seat or wheel level against its options,
 * a temperature against min_temp and max_temp in steps of 0.5, the charge limit
 * against the number's min, max and step and never outside 50 to 100, the
 * charge current against its min, max and step. A cover action needs the
 * feature bit for it. An action that takes no value refuses one.
 */
export function planCommand(slug: string, by: ReadonlyMap<string, HaState>, action: unknown, value: unknown): CommandPlan {
  if (!SLUG.test(slug)) return { ok: false, status: 400, error: 'bad car id' }
  if (!isVehicleAction(action)) return { ok: false, status: 400, error: 'unknown action' }
  const s = specOf(action)
  const entity_id = `${s.domain}.${slug}_${s.key}`
  const st = by.get(entity_id)
  if (!st) return { ok: false, status: 400, error: `this car has no ${words(s.key)} in Home Assistant` }
  if (st.state === 'unavailable') return { ok: false, status: 409, error: `Home Assistant cannot reach the car's ${words(s.key)}` }
  const a = st.attributes ?? {}
  const call = (data: Record<string, unknown> = {}): CommandPlan => ({
    ok: true, call: { domain: s.domain, service: s.service, data: { entity_id, ...data } }, strong: STRONG_ACTIONS.has(action),
  })
  if (s.feature && ((num(a.supported_features) ?? 0) & s.feature) === 0) {
    return { ok: false, status: 400, error: `the ${words(s.key)} cannot ${s.feature === 2 ? 'close' : 'open'} from here` }
  }
  if (!s.value) return value === undefined || value === null ? call() : { ok: false, status: 400, error: `${action} takes no value` }
  if (s.value === 'option') {
    const options = Array.isArray(a.options) ? a.options.filter((o): o is string => typeof o === 'string') : []
    if (typeof value !== 'string' || !options.includes(value)) return { ok: false, status: 400, error: `${action} must be one of: ${options.join(', ') || 'nothing'}` }
    return call({ option: value })
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, status: 400, error: `${action} needs a number` }
  if (s.value === 'temp') {
    const lo = num(a.min_temp)
    const hi = num(a.max_temp)
    if (lo == null || hi == null) return { ok: false, status: 409, error: 'the climate reports no temperature range' }
    if (value < lo - 1e-9 || value > hi + 1e-9 || !onGrid(value, 0, 0.5)) return { ok: false, status: 400, error: `temperature must be ${fmt(lo)} to ${fmt(hi)} in steps of 0.5` }
    return call({ temperature: value })
  }
  let lo = num(a.min)
  let hi = num(a.max)
  const step = num(a.step) ?? 1
  if (lo == null || hi == null || step <= 0) return { ok: false, status: 409, error: `the ${words(s.key)} reports no range` }
  if (s.value === 'limit') { lo = Math.max(50, lo); hi = Math.min(100, hi) }
  const name = s.value === 'limit' ? 'charge limit' : 'charge current'
  if (value < lo || value > hi || !onGrid(value, lo, step)) {
    return { ok: false, status: 400, error: `${name} must be ${fmt(lo)} to ${fmt(hi)}${step === 1 ? ' in whole numbers' : ` in steps of ${fmt(step)}`}` }
  }
  return call({ value })
}

/** Home Assistant's error text from a failed service call ({"message": ...} or plain text), printable and short. */
export function haMessage(text: string | null | undefined): string | null {
  if (!text) return null
  let msg = text
  try {
    const j = JSON.parse(text) as { message?: unknown }
    if (j && typeof j.message === 'string') msg = j.message
  } catch { /* plain text */ }
  const s = msg.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, 240) : null
}

/**
 * The car refused the command's signature: Home Assistant's key is not on the
 * car (tesla_fleet_api's NotOnWhitelistFault, "Vehicle did not recognize the
 * key...", a revoked key handle) or the car wants the command protocol.
 */
export const KEY_MISSING = /not on whitelist|did not recognize the key|key is paired|paired with the vehicle|public key|key handle is not valid|could not retrieve key|key used to authorize command has been disabled|not provisioned with identity|command protocol|virtual key/i

export type NumberControl = { value: number | null; min: number; max: number; step: number }
export type LevelControl = { level: string | null; options: string[] }

export type VehicleControls = {
  /** ms, the newest report among the car's entities */
  ts: number
  battery: number | null
  rangeMi: number | null
  security: {
    locked: boolean | null
    sentry: boolean | null
    doorsOpen: Door[]
    windowsOpen: Door[]
    userPresent: boolean | null
  }
  climate: {
    on: boolean | null
    /** in `unit`, the climate entity's own (HA's unit system) */
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
    /** the charge switch: charging asked for */
    on: boolean | null
    state: ChargingState | null
    cable: boolean | null
    kw: number | null
    rateMph: number | null
    /** what the charger delivers now */
    amps: number | null
    volts: number | null
    addedKwh: number | null
    /** ms, only while charging */
    fullAt: number | null
    limit: NumberControl | null
    /** the charge current setting (number.<car>_charge_current) */
    current: NumberControl | null
    port: Opening | null
  }
  openings: { frunk: Opening | null; trunk: Opening | null; windows: Opening | null }
  status: {
    /** psi; null when Home Assistant has none of the four sensors on */
    tiresPsi: Record<Tire, number | null> | null
    tireWarn: Tire[]
    odometerMi: number | null
    software: { installed: string | null; latest: string | null; available: boolean; installing: boolean; pct: number | null } | null
    /** true at the HA home zone */
    home: boolean | null
    location: { lat: number; lon: number } | null
  }
  /** the actions this car has an entity for right now */
  actions: VehicleAction[]
}

const opening = (st: HaState | undefined): Opening | null => (st && OPENINGS.includes(st.state) ? st.state as Opening : null)

function numberControl(st: HaState | undefined, clampTo?: [number, number]): NumberControl | null {
  if (!st) return null
  const a = st.attributes ?? {}
  let lo = num(a.min)
  let hi = num(a.max)
  const step = num(a.step) ?? 1
  if (lo == null || hi == null || step <= 0) return null
  if (clampTo) { lo = Math.max(clampTo[0], lo); hi = Math.min(clampTo[1], hi) }
  if (hi < lo) return null
  return { value: num(st.state), min: lo, max: hi, step }
}

function levelControl(st: HaState | undefined): LevelControl | null {
  if (!st || st.state === 'unavailable') return null
  const options = Array.isArray(st.attributes?.options) ? (st.attributes!.options as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 8) : []
  if (!options.length) return null
  return { level: options.includes(st.state) ? st.state : null, options }
}

/** psi from a tire sensor, whichever unit HA reports it in. */
function psi(st: HaState | undefined): number | null {
  const v = num(st?.state)
  if (v == null) return null
  const unit = String(st?.attributes?.unit_of_measurement ?? '').toLowerCase()
  const p = unit === 'bar' ? v * 14.5038 : unit === 'kpa' ? v * 0.145038 : v
  return p >= 0 && p < 150 ? round1(p) : null
}

/** Whole miles from a distance sensor (the odometer), whichever unit HA reports it in. */
function odometer(st: HaState | undefined): number | null {
  const v = num(st?.state)
  if (v == null || v < 0) return null
  const mi = /^km$/i.test(String(st?.attributes?.unit_of_measurement ?? '')) ? v / 1.609344 : v
  return mi < 5_000_000 ? Math.round(mi) : null
}

function coord(v: unknown, lim: number): number | null {
  const n = num(v)
  return n != null && Math.abs(n) <= lim ? n : null
}

/**
 * Every control the Car tab shows, from one car's entity rows (carEntities):
 * each one's state and limits, and which actions the car has an entity for.
 * A sensor Home Assistant has switched off (tire pressure and the odometer are
 * off by default in tesla_fleet) has no row, and reads as null.
 */
export function readControls(slug: string, by: ReadonlyMap<string, HaState>, now = Date.now()): VehicleControls {
  const e = (domain: string, key: string) => by.get(`${domain}.${slug}_${key}`)
  const live = (st: HaState | undefined) => (st && st.state !== 'unavailable' ? st : undefined)
  const climate = live(e('climate', 'climate'))
  const ca = climate?.attributes ?? {}
  const insideUnit = String(e('sensor', 'inside_temperature')?.attributes?.unit_of_measurement ?? '')
  const maxT = num(ca.max_temp)
  const unit: 'F' | 'C' = /C$/.test(insideUnit) ? 'C' : /F$/.test(insideUnit) ? 'F' : maxT != null && maxT < 45 ? 'C' : 'F'
  const ch = String(e('sensor', 'charging')?.state ?? '')
  const charging = (CHARGING_STATES as readonly string[]).includes(ch) ? ch as ChargingState : null
  const kw = num(e('sensor', 'charger_power')?.state)
  const rate = num(e('sensor', 'charge_rate')?.state)
  const amps = num(e('sensor', 'charger_current')?.state)
  const volts = num(e('sensor', 'charger_voltage')?.state)
  const added = num(e('sensor', 'charge_energy_added')?.state)
  const lock = e('lock', 'lock')?.state
  const loc = e('device_tracker', 'location')
  const lat = coord(loc?.attributes?.latitude, 90)
  const lon = coord(loc?.attributes?.longitude, 180)
  const upd = live(e('update', 'update'))
  const ua = upd?.attributes ?? {}
  const pct = num(ua.update_percentage) ?? (typeof ua.in_progress === 'number' ? ua.in_progress : null)
  const tires = Object.fromEntries((Object.keys(TIRES) as Tire[]).map((t) => [t, psi(e('sensor', `tire_pressure_${TIRES[t]}`))])) as Record<Tire, number | null>
  const anyTire = (Object.keys(TIRES) as Tire[]).some((t) => e('sensor', `tire_pressure_${TIRES[t]}`))
  let ts = 0
  for (const st of by.values()) ts = Math.max(ts, ms(st.last_reported) ?? 0, ms(st.last_updated) ?? 0)
  const version = (v: unknown) => (typeof v === 'string' ? cleanName(v) : null)

  const actions = VEHICLE_ACTIONS.filter((a) => {
    const s = specOf(a)
    const st = by.get(`${s.domain}.${slug}_${s.key}`)
    if (!st || st.state === 'unavailable') return false
    if (s.feature && ((num(st.attributes?.supported_features) ?? 0) & s.feature) === 0) return false
    if (s.value === 'option') return levelControl(st) != null
    return true
  })

  return {
    ts: ts || now,
    battery: clampPct(num(e('sensor', 'battery_level')?.state)),
    rangeMi: miles(e('sensor', 'battery_range')),
    security: {
      locked: lock === 'locked' ? true : lock === 'unlocked' ? false : null,
      sentry: onOff(e('switch', 'sentry_mode')?.state),
      doorsOpen: DOORS.filter((d) => e('binary_sensor', `${d}_door`)?.state === 'on'),
      windowsOpen: DOORS.filter((d) => e('binary_sensor', `${d}_window`)?.state === 'on'),
      userPresent: onOff(e('binary_sensor', 'user_present')?.state),
    },
    climate: {
      on: climate && climate.state !== 'unknown' ? climate.state !== 'off' : null,
      target: num(ca.temperature),
      min: num(ca.min_temp),
      max: maxT,
      unit,
      insideF: fahrenheit(e('sensor', 'inside_temperature')),
      outsideF: fahrenheit(e('sensor', 'outside_temperature')),
      defrost: onOff(e('switch', 'defrost')?.state),
      seats: SEATS.flatMap((seat) => {
        const c = levelControl(e('select', `seat_heater_${seat}`))
        return c ? [{ seat, ...c }] : []
      }),
      wheel: levelControl(e('select', 'steering_wheel_heater')),
    },
    charge: {
      on: onOff(e('switch', 'charge')?.state),
      state: charging,
      cable: onOff(e('binary_sensor', 'charge_cable')?.state),
      kw: kw != null && kw >= 0 && kw < 1000 ? round1(kw) : null,
      rateMph: rate != null && rate >= 0 && rate < 2000 ? round1(rate) : null,
      amps: amps != null && amps >= 0 && amps < 1000 ? Math.round(amps) : null,
      volts: volts != null && volts >= 0 && volts < 2000 ? Math.round(volts) : null,
      addedKwh: added != null && added >= 0 && added < 1000 ? round1(added) : null,
      fullAt: charging === 'charging' || charging === 'starting' ? ms(e('sensor', 'time_to_full_charge')?.state) : null,
      limit: numberControl(e('number', 'charge_limit'), [50, 100]),
      current: numberControl(e('number', 'charge_current')),
      port: opening(e('cover', 'charge_port_door')),
    },
    openings: { frunk: opening(e('cover', 'frunk')), trunk: opening(e('cover', 'trunk')), windows: opening(e('cover', 'windows')) },
    status: {
      tiresPsi: anyTire ? tires : null,
      tireWarn: (Object.keys(TIRES) as Tire[]).filter((t) => e('binary_sensor', `tire_pressure_warning_${TIRES[t]}`)?.state === 'on'),
      odometerMi: odometer(e('sensor', 'odometer')),
      software: upd ? {
        installed: version(ua.installed_version),
        latest: version(ua.latest_version),
        available: upd.state === 'on',
        installing: ua.in_progress === true || (typeof ua.in_progress === 'number' && ua.in_progress > 0),
        pct: pct != null && pct >= 0 && pct <= 100 ? Math.round(pct) : null,
      } : null,
      home: loc?.state === 'home' ? true : loc && loc.state !== 'unknown' && loc.state !== 'unavailable' && loc.state !== '' ? false : null,
      location: lat != null && lon != null ? { lat, lon } : null,
    },
    actions,
  }
}

// ---------- the last reading per car ----------

const db = openDb('vehicles', `
  CREATE TABLE IF NOT EXISTS vehicle_reads (
    slug TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    doc TEXT NOT NULL
  );
`)

export function saveVehicleRead(v: VehicleRead): void {
  db.prepare(`INSERT INTO vehicle_reads (slug, ts, doc) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET ts = excluded.ts, doc = excluded.doc`).run(v.slug, v.ts, JSON.stringify(v))
}

/** Every saved reading, re-validated field by field (a hand-edited or older row must not reach the page as junk). */
export function readVehicleReads(): VehicleRead[] {
  const rows = db.prepare('SELECT slug, doc FROM vehicle_reads').all() as { slug: string; doc: string }[]
  const out: VehicleRead[] = []
  for (const row of rows) {
    let d: Record<string, unknown>
    try { d = JSON.parse(row.doc) as Record<string, unknown> } catch { continue }
    if (!d || typeof d !== 'object' || d.slug !== row.slug || !SLUG.test(row.slug)) continue
    const n = (k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? d[k] as number : null)
    const b = (k: string) => (typeof d[k] === 'boolean' ? d[k] as boolean : null)
    const battery = clampPct(n('battery'))
    const ts = n('ts')
    if (battery == null || ts == null) continue
    const ch = String(d.charging ?? '')
    out.push({
      slug: row.slug,
      name: cleanName(d.name) ?? row.slug,
      model: cleanName(d.model),
      ts,
      state: (VEHICLE_STATES as readonly unknown[]).includes(d.state) ? d.state as VehicleState : 'unknown',
      since: n('since'),
      battery,
      rangeMi: n('rangeMi'),
      chargeLimit: clampPct(n('chargeLimit')),
      charging: (CHARGING_STATES as readonly string[]).includes(ch) ? ch as ChargingState : null,
      chargerKw: n('chargerKw'),
      chargeRateMph: n('chargeRateMph'),
      fullAt: n('fullAt'),
      cable: b('cable'),
      locked: b('locked'),
      home: b('home'),
      insideF: n('insideF'),
      outsideF: n('outsideF'),
      climateOn: b('climateOn'),
    })
  }
  return out
}
