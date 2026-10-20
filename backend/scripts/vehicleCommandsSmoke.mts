/**
 * Check of the Car tab's backend: lib/vehicles.ts readControls and planCommand,
 * and routes/vehicles.ts GET /api/vehicles/:id and POST /api/vehicles/:id/command,
 * against a FAKE Home Assistant. There is no live mode: no service call and no
 * vehicle command can leave this process. Every request that is not to the
 * script's own Express server is answered by the fake inside the process
 * (fetch stubbed), so the real Home Assistant is never asked anything. Runs
 * against a throwaway data dir. Run on odin from a scratch copy of backend/
 * with node_modules linked (delete the copy after):
 *
 *   node --import tsx scripts/vehicleCommandsSmoke.mts
 *
 * The fixture uses generic names only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-vehicle-cmd-'))
process.env.VALKYRIE_DATA_DIR = dir
delete process.env.VEHICLES_MODELS
delete process.env.VEHICLES_HIDE

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

// every line the code logs, to prove no token is ever in one
const logged: string[] = []
const realLog = console.log
const realWarn = console.warn
const keep = (args: unknown[]) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
console.warn = (...args: unknown[]) => { keep(args); realWarn(...args) }

// ---------- the fake Home Assistant ----------

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
type St = { entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string; last_reported?: string }
const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}, at = NOW - 120_000): St =>
  ({ entity_id, state, attributes, last_changed: iso(at - 3_600_000), last_updated: iso(at), last_reported: iso(at) })

/** Car A: a Model Y as tesla_fleet names its entities, front seat heaters only, tire pressure and odometer switched off. Car B: a Model S. */
function fixture(): St[] {
  const a = 'car_a'
  return [
    st(`sensor.${a}_battery_level`, '75', { unit_of_measurement: '%', friendly_name: 'Car A Battery level' }),
    st(`sensor.${a}_battery_range`, '225.6', { unit_of_measurement: 'mi' }),
    st(`binary_sensor.${a}_status`, 'on'),
    st(`sensor.${a}_charging`, 'disconnected'),
    st(`sensor.${a}_charger_power`, '0', { unit_of_measurement: 'kW' }),
    st(`sensor.${a}_charge_rate`, '0.0', { unit_of_measurement: 'mph' }),
    st(`sensor.${a}_charger_current`, '0', { unit_of_measurement: 'A' }),
    st(`sensor.${a}_charger_voltage`, '2', { unit_of_measurement: 'V' }),
    st(`sensor.${a}_charge_energy_added`, '27.44', { unit_of_measurement: 'kWh' }),
    st(`sensor.${a}_time_to_full_charge`, 'unavailable'),
    st(`binary_sensor.${a}_charge_cable`, 'off'),
    st(`lock.${a}_lock`, 'locked', { supported_features: 0 }),
    st(`lock.${a}_charge_cable_lock`, 'locked', { supported_features: 0 }),
    st(`switch.${a}_sentry_mode`, 'on'),
    st(`switch.${a}_defrost`, 'off'),
    st(`switch.${a}_charge`, 'off'),
    st(`climate.${a}_climate`, 'off', { hvac_modes: ['heat_cool', 'off'], min_temp: 59, max_temp: 82.5, preset_modes: ['off', 'keep', 'dog', 'camp'], current_temperature: 59.5, temperature: 71.5, preset_mode: 'off', supported_features: 401 }),
    st(`select.${a}_seat_heater_front_left`, 'off', { options: ['off', 'low', 'medium', 'high'] }),
    st(`select.${a}_seat_heater_front_right`, 'low', { options: ['off', 'low', 'medium', 'high'] }),
    st(`select.${a}_steering_wheel_heater`, 'off', { options: ['off', 'low', 'high'] }),
    st(`number.${a}_charge_limit`, '80', { min: 50, max: 100, step: 1, unit_of_measurement: '%' }),
    st(`number.${a}_charge_current`, '48', { min: 0, max: 48, step: 1, unit_of_measurement: 'A' }),
    st(`cover.${a}_charge_port_door`, 'closed', { supported_features: 3 }),
    st(`cover.${a}_frunk`, 'closed', { supported_features: 1 }),
    st(`cover.${a}_trunk`, 'closed', { supported_features: 3 }),
    st(`cover.${a}_windows`, 'closed', { supported_features: 3 }),
    st(`button.${a}_flash_lights`, 'unknown'),
    st(`button.${a}_honk_horn`, 'unknown'),
    st(`button.${a}_wake`, 'unknown'),
    st(`button.${a}_homelink`, 'unknown'),
    st(`binary_sensor.${a}_front_driver_door`, 'off'),
    st(`binary_sensor.${a}_rear_passenger_door`, 'on'),
    st(`binary_sensor.${a}_front_driver_window`, 'off'),
    st(`binary_sensor.${a}_user_present`, 'off'),
    st(`sensor.${a}_inside_temperature`, '59.72', { unit_of_measurement: '°F' }),
    st(`sensor.${a}_outside_temperature`, '55.4', { unit_of_measurement: '°F' }),
    st(`device_tracker.${a}_location`, 'not_home', { latitude: 12.5, longitude: -45.25, source_type: 'gps' }),
    st(`update.${a}_update`, 'off', { installed_version: '2026.1.1', latest_version: '2026.1.1', in_progress: false, update_percentage: null, entity_picture: 'https://example.invalid/icon.png' }),
    st('sensor.car_b_battery_level', '60', { unit_of_measurement: '%' }),
    st('sensor.car_b_battery_range', '200', { unit_of_measurement: 'mi' }),
    st('binary_sensor.car_b_status', 'off'),
    st('lock.car_b_lock', 'locked'),
    st('light.desk', 'on'),
  ]
}
const REGISTRY: Record<string, { model: string; name: string }> = { car_a: { model: 'Model Y', name: 'Car A' }, car_b: { model: 'Model S', name: 'Car B' } }

let states = fixture()
/** every service call the fake received: domain.service and its data */
const calls: { service: string; data: Record<string, unknown> }[] = []
let statesReads = 0
/** the fake's answer to the next service calls, in order; empty = 200 and the state change */
const next: (() => Response | Promise<Response>)[] = []
let holdMs = 0

/** What the car does for a call the fake accepts, so the read after the command shows it. */
function apply(service: string, data: Record<string, unknown>) {
  const id = String(data.entity_id)
  const set = (state: string, attrs?: Record<string, unknown>) => {
    states = states.map((s) => (s.entity_id === id ? { ...s, state, attributes: { ...s.attributes, ...attrs }, last_updated: iso(Date.now()), last_reported: iso(Date.now()) } : s))
  }
  if (service === 'lock.lock') set('locked')
  else if (service === 'lock.unlock') set('unlocked')
  else if (service === 'switch.turn_on') set('on')
  else if (service === 'switch.turn_off') set('off')
  else if (service === 'climate.turn_on') set('heat_cool')
  else if (service === 'climate.turn_off') set('off')
  else if (service === 'climate.set_temperature') set(states.find((s) => s.entity_id === id)?.state ?? 'off', { temperature: data.temperature })
  else if (service === 'select.select_option') set(String(data.option))
  else if (service === 'number.set_value') set(String(data.value))
  else if (service === 'cover.open_cover') set('open')
  else if (service === 'cover.close_cover') set('closed')
}

let serverPort = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  // the script's own Express server: the only thing ever reached over the network
  if (serverPort && url.hostname === '127.0.0.1' && Number(url.port) === serverPort) return realFetch(input, init)
  // everything else is the fake Home Assistant, answered here
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method === 'GET' && url.pathname === '/api/states') { statesReads++; return Response.json(states) }
  if (method === 'POST' && url.pathname === '/api/template') {
    const tpl = String((JSON.parse(String(init?.body ?? '{}')) as { template?: string }).template ?? '')
    const slugs = [...tpl.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).filter((s) => s in REGISTRY)
    return Response.json(slugs.map((slug) => ({ slug, ...REGISTRY[slug] })))
  }
  const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url.pathname)
  if (method === 'POST' && svc) {
    const data = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const service = `${svc[1]}.${svc[2]}`
    calls.push({ service, data })
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs))
    const answer = next.shift()
    if (answer) return answer()
    apply(service, data)
    return Response.json([])
  }
  return new Response('not here', { status: 404 })
}) as typeof fetch

try {
  const lib = await import('../src/lib/vehicles.ts')

  // ---------- readControls ----------
  const by = lib.carEntities(fixture(), 'car_a')
  check('carEntities keeps one car\'s rows only', [...by.keys()].every((k) => /^[a-z_]+\.car_a_/.test(k)) && by.size > 30 && !by.has('lock.car_b_lock'), String(by.size))
  const c = lib.readControls('car_a', by, NOW)
  check('battery and range', c.battery === 75 && c.rangeMi === 225.6)
  check('security: locked, sentry on, the open door', c.security.locked === true && c.security.sentry === true && c.security.doorsOpen.join() === 'rear_passenger' && !c.security.windowsOpen.length)
  check('climate: off, 71.5 in 59 to 82.5 °F', c.climate.on === false && c.climate.target === 71.5 && c.climate.min === 59 && c.climate.max === 82.5 && c.climate.unit === 'F' && c.climate.insideF === 59.7)
  check('climate: the two front seats only, with their levels', c.climate.seats.map((s) => `${s.seat}=${s.level}`).join() === 'front_left=off,front_right=low' && c.climate.seats[0].options.join() === 'off,low,medium,high')
  check('climate: wheel off of off/low/high, defrost off', c.climate.wheel?.level === 'off' && c.climate.wheel.options.join() === 'off,low,high' && c.climate.defrost === false)
  check('charge: limit 80 of 50-100, current 48 of 0-48, port closed', c.charge.limit?.value === 80 && c.charge.limit.min === 50 && c.charge.limit.max === 100 && c.charge.current?.value === 48 && c.charge.current.max === 48 && c.charge.port === 'closed' && c.charge.on === false && c.charge.cable === false)
  check('openings', c.openings.frunk === 'closed' && c.openings.trunk === 'closed' && c.openings.windows === 'closed')
  check('status: tires and odometer off in HA read null', c.status.tiresPsi === null && c.status.odometerMi === null)
  check('status: software and away', c.status.software?.installed === '2026.1.1' && c.status.software.available === false && c.status.home === false)
  check('status: the location for the Map button', c.status.location?.lat === 12.5 && c.status.location.lon === -45.25)
  check('actions: what the car has', ['lock', 'unlock', 'climate_temp', 'seat_heat_front_right', 'frunk_open', 'trunk_close', 'honk', 'wake', 'charge_amps'].every((a) => c.actions.includes(a as never)))
  check('actions: what it does not have', !c.actions.includes('seat_heat_rear_left' as never) && !c.actions.includes('seat_heat_third_row_left' as never))
  const withTires = new Map(by)
  withTires.set('sensor.car_a_tire_pressure_front_left', st('sensor.car_a_tire_pressure_front_left', '2.9', { unit_of_measurement: 'bar' }))
  withTires.set('sensor.car_a_tire_pressure_rear_right', st('sensor.car_a_tire_pressure_rear_right', '42', { unit_of_measurement: 'psi' }))
  withTires.set('sensor.car_a_odometer', st('sensor.car_a_odometer', '12000', { unit_of_measurement: 'km' }))
  const t = lib.readControls('car_a', withTires, NOW)
  check('tires in psi from bar and psi, odometer in miles', t.status.tiresPsi?.fl === 42.1 && t.status.tiresPsi.rr === 42 && t.status.tiresPsi.fr === null && t.status.odometerMi === 7456, JSON.stringify([t.status.tiresPsi, t.status.odometerMi]))

  // ---------- planCommand ----------
  const plan = (action: unknown, value?: unknown) => lib.planCommand('car_a', by, action, value)
  const calls1 = (action: string, value?: unknown) => {
    const p = plan(action, value)
    return p.ok ? `${p.call.domain}.${p.call.service} ${JSON.stringify(p.call.data)}${p.strong ? ' strong' : ''}` : `refused ${p.status}`
  }
  const want: [string, unknown, string][] = [
    ['lock', undefined, 'lock.lock {"entity_id":"lock.car_a_lock"}'],
    ['unlock', undefined, 'lock.unlock {"entity_id":"lock.car_a_lock"} strong'],
    ['sentry_on', undefined, 'switch.turn_on {"entity_id":"switch.car_a_sentry_mode"}'],
    ['sentry_off', undefined, 'switch.turn_off {"entity_id":"switch.car_a_sentry_mode"}'],
    ['climate_on', undefined, 'climate.turn_on {"entity_id":"climate.car_a_climate"}'],
    ['climate_off', undefined, 'climate.turn_off {"entity_id":"climate.car_a_climate"}'],
    ['climate_temp', 72.5, 'climate.set_temperature {"entity_id":"climate.car_a_climate","temperature":72.5}'],
    ['defrost_on', undefined, 'switch.turn_on {"entity_id":"switch.car_a_defrost"}'],
    ['defrost_off', null, 'switch.turn_off {"entity_id":"switch.car_a_defrost"}'],
    ['seat_heat_front_left', 'high', 'select.select_option {"entity_id":"select.car_a_seat_heater_front_left","option":"high"}'],
    ['wheel_heat', 'low', 'select.select_option {"entity_id":"select.car_a_steering_wheel_heater","option":"low"}'],
    ['charge_start', undefined, 'switch.turn_on {"entity_id":"switch.car_a_charge"}'],
    ['charge_stop', undefined, 'switch.turn_off {"entity_id":"switch.car_a_charge"}'],
    ['charge_limit', 90, 'number.set_value {"entity_id":"number.car_a_charge_limit","value":90}'],
    ['charge_amps', 16, 'number.set_value {"entity_id":"number.car_a_charge_current","value":16}'],
    ['port_open', undefined, 'cover.open_cover {"entity_id":"cover.car_a_charge_port_door"} strong'],
    ['port_close', undefined, 'cover.close_cover {"entity_id":"cover.car_a_charge_port_door"} strong'],
    ['frunk_open', undefined, 'cover.open_cover {"entity_id":"cover.car_a_frunk"} strong'],
    ['trunk_open', undefined, 'cover.open_cover {"entity_id":"cover.car_a_trunk"} strong'],
    ['trunk_close', undefined, 'cover.close_cover {"entity_id":"cover.car_a_trunk"} strong'],
    ['windows_vent', undefined, 'cover.open_cover {"entity_id":"cover.car_a_windows"} strong'],
    ['windows_close', undefined, 'cover.close_cover {"entity_id":"cover.car_a_windows"} strong'],
    ['flash', undefined, 'button.press {"entity_id":"button.car_a_flash_lights"}'],
    ['honk', undefined, 'button.press {"entity_id":"button.car_a_honk_horn"}'],
    ['wake', undefined, 'button.press {"entity_id":"button.car_a_wake"}'],
  ]
  for (const [a, v, w] of want) check(`plan ${a}`, calls1(a, v) === w, calls1(a, v))
  check('the allowlist is exactly the planned actions plus the other seats', lib.VEHICLE_ACTIONS.length === want.length + lib.SEATS.length - 1)
  const refused: [string, unknown, number][] = [
    ['open_sesame', undefined, 400], ['homelink', undefined, 400], ['play_fart', undefined, 400], ['lock', true, 400], ['honk', 'loud', 400],
    ['climate_temp', 90, 400], ['climate_temp', 58, 400], ['climate_temp', 72.3, 400], ['climate_temp', '72', 400], ['climate_temp', undefined, 400], ['climate_temp', Number.NaN, 400],
    ['seat_heat_front_left', 'max', 400], ['seat_heat_front_left', 3, 400], ['seat_heat_rear_left', 'low', 400], ['wheel_heat', 'medium', 400],
    ['charge_limit', 49, 400], ['charge_limit', 101, 400], ['charge_limit', 80.5, 400], ['charge_limit', '80', 400],
    ['charge_amps', 49, 400], ['charge_amps', -1, 400], ['charge_amps', 15.5, 400],
  ]
  for (const [a, v, s] of refused) {
    const p = plan(a, v)
    check(`refuses ${a} ${JSON.stringify(v) ?? ''}`, !p.ok && p.status === s, p.ok ? 'planned' : `${p.status} ${p.error}`)
  }
  const frunkOnlyOpens = new Map(by)
  frunkOnlyOpens.set('cover.car_a_trunk', st('cover.car_a_trunk', 'closed', { supported_features: 1 }))
  const tc = lib.planCommand('car_a', frunkOnlyOpens, 'trunk_close', undefined)
  check('a cover without the close feature refuses close', !tc.ok && tc.status === 400)
  const gone = new Map(by)
  gone.set('lock.car_a_lock', st('lock.car_a_lock', 'unavailable'))
  const lu = lib.planCommand('car_a', gone, 'lock', undefined)
  check('an unavailable entity is a 409', !lu.ok && lu.status === 409)
  check('a bad slug is refused', !lib.planCommand('car_a/../x', by, 'lock', undefined).ok)
  check('only the car\'s own entity: another car\'s rows give nothing', !lib.planCommand('car_a', lib.carEntities(fixture(), 'car_b'), 'lock', undefined).ok)
  check('the key-missing text', lib.KEY_MISSING.test('Command failed: Vehicle did not recognize the key used to authorize command. Make sure your key is paired with the vehicle')
    && lib.KEY_MISSING.test('Command failed: Not on whitelist fault on signed command.') && !lib.KEY_MISSING.test('Could not wake up vehicle'))
  check('HA\'s message out of its JSON', lib.haMessage('{"message":"Command failed: x"}') === 'Command failed: x' && lib.haMessage('400: Bad Request') === '400: Bad Request' && lib.haMessage('') === null)

  // ---------- the route, on its own Express app ----------
  const express = (await import('express')).default
  const route = (await import('../src/routes/vehicles.ts')).default
  const app = express()
  app.use(express.json())
  app.use('/api', route)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  serverPort = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${serverPort}/api`
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null } }
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null }
  }

  // the route's first poll
  for (let k = 0; k < 40 && (await get('/vehicles/car-car_a')).status !== 200; k++) await new Promise((r) => setTimeout(r, 250))
  console.log = (...args: unknown[]) => { keep(args); realLog(...args) }

  const v = await get('/vehicles/car-car_a')
  const vb = v.body as Record<string, any>
  check('GET the view', v.status === 200 && vb.id === 'car-car_a' && vb.label === 'Car A' && vb.model === 'Model Y' && vb.state === 'awake' && vb.keyMissing === false, `${v.status} ${JSON.stringify(vb)?.slice(0, 160)}`)
  check('the view carries controls and limits', vb.security?.locked === true && vb.climate?.max === 82.5 && vb.charge?.limit?.min === 50 && Array.isArray(vb.actions))
  check('the view names no entity', !/\.car_a_/.test(JSON.stringify(vb)))
  check('the view carries the coordinates for the Map button', vb.status?.location?.lat === 12.5)
  check('a hidden car (Model S) is no car', (await get('/vehicles/car-car_b')).status === 404)
  check('an unknown id is no car', (await get('/vehicles/car-nope')).status === 404 && (await get('/vehicles/thor')).status === 404)

  // a good command: one service call on the car's own entity, then one read, and the view shows it
  let reads0 = statesReads
  let r = await post('/vehicles/car-car_a/command', { action: 'lock' })
  check('lock: 200 with the view', r.status === 200 && r.body?.ok === true && (r.body?.view as any)?.security?.locked === true, `${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`)
  check('lock: the exact service call', calls.at(-1)?.service === 'lock.lock' && JSON.stringify(calls.at(-1)?.data) === '{"entity_id":"lock.car_a_lock"}')
  check('lock: one fresh read after it', statesReads - reads0 === 1, String(statesReads - reads0))

  reads0 = statesReads
  r = await post('/vehicles/car-car_a/command', { action: 'unlock' })
  check('unlock from loopback: 200, the view shows unlocked', r.status === 200 && (r.body?.view as any)?.security?.locked === false)
  const n0 = calls.length
  r = await post('/vehicles/car-car_a/command', { action: 'unlock' }, { 'cf-ray': 'test' })
  check('unlock without strong auth: 403, nothing sent', r.status === 403 && calls.length === n0, `${r.status}`)
  r = await post('/vehicles/car-car_a/command', { action: 'frunk_open' }, { 'cf-ray': 'test' })
  check('frunk without strong auth: 403', r.status === 403 && calls.length === n0)
  r = await post('/vehicles/car-car_a/command', { action: 'honk' }, { 'cf-ray': 'test' })
  check('honk is not a strong action (the route\'s requireAuth guards it)', r.status === 200 && calls.at(-1)?.service === 'button.press')

  const n1 = calls.length
  for (const [label, body] of [
    ['an extra field', { action: 'lock', entity_id: 'lock.car_b_lock' }],
    ['an unknown action', { action: 'self_destruct' }],
    ['a raw service', { action: 'lock.unlock' }],
    ['a temperature out of range', { action: 'climate_temp', value: 120 }],
    ['a charge limit under 50', { action: 'charge_limit', value: 40 }],
    ['an array', [{ action: 'lock' }]],
    ['no body', 'null'],
  ] as [string, unknown][]) {
    const x = await post('/vehicles/car-car_a/command', body)
    check(`400 for ${label}`, x.status === 400, `${x.status} ${JSON.stringify(x.body)}`)
  }
  check('nothing sent for any refusal', calls.length === n1)
  check('a command to a hidden car is a 404', (await post('/vehicles/car-car_b/command', { action: 'lock' })).status === 404 && calls.length === n1)

  // Home Assistant refuses: the car does not have its key
  next.push(() => Response.json({ message: 'Command failed: Vehicle did not recognize the key used to authorize command. Make sure your key is paired with the vehicle' }, { status: 500 }))
  r = await post('/vehicles/car-car_a/command', { action: 'climate_on' })
  check('a refused command is a 502 with keyMissing', r.status === 502 && r.body?.ok === false && r.body?.keyMissing === true && /did not recognize the key/.test(String(r.body?.error)), `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`)
  check('the failed command leaves the real state in its view', (r.body?.view as any)?.climate?.on === false)
  check('the view remembers the missing key', (await get('/vehicles/car-car_a')).body?.keyMissing === true)
  r = await post('/vehicles/car-car_a/command', { action: 'climate_on' })
  check('a command that works clears it', r.status === 200 && (r.body?.view as any)?.keyMissing === false && (r.body?.view as any)?.climate?.on === true)

  next.push(() => Response.json({ message: 'Missing vehicle commands scope.' }, { status: 400 }))
  r = await post('/vehicles/car-car_a/command', { action: 'flash' })
  check('a validation error from HA is a 502 with its message', r.status === 502 && r.body?.error === 'Missing vehicle commands scope.' && r.body?.keyMissing === false)

  next.push(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') })
  r = await post('/vehicles/car-car_a/command', { action: 'wake' })
  check('no answer in time is a 504', r.status === 504 && /no answer in 75 s/.test(String(r.body?.error)), `${r.status} ${JSON.stringify(r.body)}`)

  // every value-taking control, through the route
  for (const [action, value, svc, data] of [
    ['climate_temp', 68, 'climate.set_temperature', '{"entity_id":"climate.car_a_climate","temperature":68}'],
    ['seat_heat_front_right', 'medium', 'select.select_option', '{"entity_id":"select.car_a_seat_heater_front_right","option":"medium"}'],
    ['wheel_heat', 'high', 'select.select_option', '{"entity_id":"select.car_a_steering_wheel_heater","option":"high"}'],
    ['charge_limit', 85, 'number.set_value', '{"entity_id":"number.car_a_charge_limit","value":85}'],
    ['charge_amps', 32, 'number.set_value', '{"entity_id":"number.car_a_charge_current","value":32}'],
  ] as [string, unknown, string, string][]) {
    const x = await post('/vehicles/car-car_a/command', { action, value })
    check(`${action} ${value}`, x.status === 200 && calls.at(-1)?.service === svc && JSON.stringify(calls.at(-1)?.data) === data, `${x.status} ${calls.at(-1)?.service} ${JSON.stringify(calls.at(-1)?.data)}`)
  }
  const after = (await get('/vehicles/car-car_a')).body as Record<string, any>
  check('the view follows the commands', after.climate.target === 68 && after.climate.seats[1].level === 'medium' && after.climate.wheel.level === 'high' && after.charge.limit.value === 85 && after.charge.current.value === 32)

  // three at once is the limit per car
  holdMs = 400
  const burst = await Promise.all([0, 1, 2, 3].map(() => post('/vehicles/car-car_a/command', { action: 'flash' })))
  holdMs = 0
  const codes = burst.map((x) => x.status).sort()
  check('a fourth command while three are out is a 429', codes.join() === '200,200,200,429', codes.join())

  // the log: every command, never a token
  const cmdLines = logged.filter((l) => l.includes('[vehicles] command'))
  check('each command is logged with its action, ok and HA status', cmdLines.some((l) => /"action":"lock".*"ok":true.*"haStatus":200/.test(l)) && cmdLines.some((l) => /"keyMissing":true/.test(l)) && cmdLines.some((l) => /"haStatus":"timeout"/.test(l)), cmdLines.slice(0, 2).join(' | '))
  check('no token in any log line', !logged.some((l) => /Bearer|eyJ[A-Za-z0-9_-]{10,}/.test(l)))
  check('every request to Home Assistant was a read or an allowlisted service', calls.every((x) => /^(lock\.(lock|unlock)|switch\.turn_(on|off)|climate\.(turn_on|turn_off|set_temperature)|select\.select_option|number\.set_value|cover\.(open|close)_cover|button\.press)$/.test(x.service)))
  check('every service call named one of Car A\'s entities', calls.every((x) => /^[a-z_]+\.car_a_[a-z_]+$/.test(String(x.data.entity_id))))
  server.close()
} catch (err) {
  realLog(`FAIL threw: ${(err as Error).stack ?? err}`)
  failed++
} finally {
  console.log = realLog
  console.warn = realWarn
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
