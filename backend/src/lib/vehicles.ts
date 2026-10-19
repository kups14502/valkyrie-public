import { openDb } from './db.js'
import type { BatteryStatus } from './devices.js'

// Cars on /api/hosts, read from Home Assistant's Tesla Fleet integration
// (routes/vehicles.ts polls; this module holds the pure parts and the last
// reading per car, in DATA_DIR/vehicles.sqlite, so a restart still shows where
// the battery was left).
//
// Read only, always: nothing here or in the route calls a Home Assistant
// service, wakes a car or sends it a command. A sleeping car is never polled
// for data by the integration either: its sensors keep the values from when it
// fell asleep, and that is what the page shows, labeled with the time.
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
