/**
 * Check of the cars on /api/hosts (lib/vehicles.ts + routes/vehicles.ts).
 * Runs against a throwaway data dir, so the live vehicles.sqlite is never
 * touched. Run on odin (haRequest signs with odin's Home Assistant key, which is
 * never printed), from a scratch copy of backend/ with node_modules linked:
 *
 *   node --import tsx scripts/vehiclesSmoke.mts          # a fake Home Assistant (fetch stubbed, nothing leaves the process)
 *   node --import tsx scripts/vehiclesSmoke.mts --live   # one read-only pass over the real one: GET /api/states and POST /api/template
 *
 * Both modes fail on any request other than those two reads: no service call,
 * no wake-up, no vehicle command. The fixture uses generic names only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const live = process.argv.includes('--live')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valkyrie-vehicles-'))
process.env.VALKYRIE_DATA_DIR = dir
delete process.env.VEHICLES_MODELS
delete process.env.VEHICLES_HIDE

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

// Every request the code makes, by method and path. Anything but the two reads fails the run.
const seen: string[] = []
const realFetch = globalThis.fetch
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

type St = { entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string; last_reported?: string }
const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}, at = NOW - 120_000): St =>
  ({ entity_id, state, attributes, last_changed: iso(at - 3_600_000), last_updated: iso(at), last_reported: iso(at) })

/** Two cars the way tesla_fleet names them, a third the integration lost, a phone, and noise. */
function fixture(): St[] {
  const car = (slug: string, name: string, o: { level: string; range: string; status: string; charging: string; cable: string; lock: string; where: string; inside: string; outside: string; tempUnit?: string; rangeUnit?: string; power?: string; full?: string }) => [
    st(`sensor.${slug}_battery_level`, o.level, { unit_of_measurement: '%', device_class: 'battery', friendly_name: `${name} Battery level` }),
    st(`sensor.${slug}_battery_range`, o.range, { unit_of_measurement: o.rangeUnit ?? 'mi', friendly_name: `${name} Battery range` }),
    st(`binary_sensor.${slug}_status`, o.status, { device_class: 'connectivity', friendly_name: `${name} Status` }),
    st(`sensor.${slug}_charging`, o.charging, { device_class: 'enum' }),
    st(`sensor.${slug}_charger_power`, o.power ?? '0', { unit_of_measurement: 'kW' }),
    st(`sensor.${slug}_charge_rate`, o.power ? '30.5' : '0.0', { unit_of_measurement: 'mph' }),
    st(`sensor.${slug}_time_to_full_charge`, o.full ?? 'unavailable', { device_class: 'timestamp' }),
    st(`number.${slug}_charge_limit`, '80', { unit_of_measurement: '%' }),
    st(`binary_sensor.${slug}_charge_cable`, o.cable),
    st(`lock.${slug}_lock`, o.lock),
    st(`device_tracker.${slug}_location`, o.where, { latitude: 0, longitude: 0 }),
    st(`climate.${slug}_climate`, 'off'),
    st(`sensor.${slug}_inside_temperature`, o.inside, { unit_of_measurement: o.tempUnit ?? '°F' }),
    st(`sensor.${slug}_outside_temperature`, o.outside, { unit_of_measurement: o.tempUnit ?? '°F' }),
  ]
  return [
    ...car('car_a', 'Car A', { level: '76', range: '230.5', status: 'on', charging: 'charging', cable: 'on', lock: 'locked', where: 'home', inside: '66.02', outside: '64.4', power: '11.5', full: iso(NOW + 2 * 3_600_000) }),
    ...car('car_b', 'Car B', { level: '74', range: '442.3', status: 'off', charging: 'disconnected', cable: 'off', lock: 'unlocked', where: 'not_home', inside: '40.4', outside: '26.5', tempUnit: '°C', rangeUnit: 'km' }),
    st('sensor.car_c_battery_level', 'unavailable', { friendly_name: 'Car C Battery level' }),
    st('sensor.car_c_battery_range', 'unavailable'),
    st('binary_sensor.car_c_status', 'unavailable'),
    st('sensor.test_iphone_battery_level', '30', { unit_of_measurement: '%' }),
    st('sensor.test_iphone_battery_range', '5'),
    st('light.desk', 'on'),
  ]
}
const REGISTRY: Record<string, { model: string; name: string }> = {
  car_a: { model: 'Model Y', name: 'Car A' },
  car_b: { model: 'Model S', name: 'Car B' },
  car_c: { model: 'Model Y', name: 'Car C' },
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init?.method ?? 'GET').toUpperCase()
  seen.push(`${method} ${url.pathname}`)
  if (live) {
    if (!((method === 'GET' && url.pathname === '/api/states') || (method === 'POST' && url.pathname === '/api/template'))) {
      throw new Error(`refused ${method} ${url.pathname}: the smoke only reads`)
    }
    return realFetch(input, init)
  }
  if (method === 'GET' && url.pathname === '/api/states') return Response.json(fixture())
  if (method === 'POST' && url.pathname === '/api/template') {
    const tpl = String((JSON.parse(String(init?.body ?? '{}')) as { template?: string }).template ?? '')
    const slugs = [...tpl.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).filter((s) => s in REGISTRY)
    return Response.json(slugs.map((slug) => ({ slug, ...REGISTRY[slug] })))
  }
  return new Response('not here', { status: 404 })
}) as typeof fetch

try {
  const lib = await import('../src/lib/vehicles.ts')

  if (!live) {
    // ---------- the pure parts on the fixture ----------
    const known = new Map(Object.entries(REGISTRY))
    const { reads, unavailable } = lib.readVehicles(fixture(), known, NOW)
    check('finds both cars, not the phone', reads.map((v) => v.slug).join(',') === 'car_a,car_b', reads.map((v) => v.slug).join(','))
    check('lists the car the integration lost', unavailable.join(',') === 'car_c', unavailable.join(','))
    const a = reads.find((v) => v.slug === 'car_a')!
    const b = reads.find((v) => v.slug === 'car_b')!
    check('status on is Awake', a.state === 'awake')
    check('status off is Asleep, never Offline', b.state === 'asleep')
    check('since is the status sensor\'s last change', a.since === NOW - 120_000 - 3_600_000, String(a.since))
    check('the name comes from the device registry', a.name === 'Car A' && a.model === 'Model Y')
    check('battery, range and limit', a.battery === 76 && a.rangeMi === 230.5 && a.chargeLimit === 80, JSON.stringify([a.battery, a.rangeMi, a.chargeLimit]))
    check('charging power, rate and full time while charging', a.charging === 'charging' && a.chargerKw === 11.5 && a.chargeRateMph === 30.5 && a.fullAt === NOW + 2 * 3_600_000)
    check('cable, lock, home', a.cable === true && a.locked === true && a.home === true && b.cable === false && b.locked === false && b.home === false)
    check('kilometers become miles', b.rangeMi === 274.8, String(b.rangeMi))
    check('Celsius becomes Fahrenheit', b.insideF === 104.7 && b.outsideF === 79.7, `${b.insideF} ${b.outsideF}`)
    check('no full time while unplugged', b.fullAt === null)
    check('climate off', a.climateOn === false)
    check('no location ever kept', !JSON.stringify(reads).includes('latitude'))
    check('battery status from charging', lib.batteryStatus('charging') === 'charging' && lib.batteryStatus('complete') === 'full' && lib.batteryStatus('stopped') === 'not charging' && lib.batteryStatus('disconnected') === 'discharging' && lib.batteryStatus(null) === 'unknown')
    const noStatus = lib.readVehicles(fixture().filter((s) => s.entity_id !== 'binary_sensor.car_a_status'), known, NOW).reads.find((v) => v.slug === 'car_a')
    check('no status sensor is Unknown, not Offline', noStatus?.state === 'unknown', String(noStatus?.state))
    const gone = lib.readVehicles(fixture().map((s) => (s.entity_id === 'binary_sensor.car_a_status' ? { ...s, state: 'unavailable' } : s)), known, NOW).reads.find((v) => v.slug === 'car_a')
    check('status unavailable is Offline', gone?.state === 'offline', String(gone?.state))
    const unnamed = lib.readVehicles(fixture(), new Map(), NOW).reads.find((v) => v.slug === 'car_a')
    check('without the registry the name is the sensor\'s, the model unknown', unnamed?.name === 'Car A' && unnamed.model === null, JSON.stringify(unnamed && [unnamed.name, unnamed.model]))

    // ---------- which cars show ----------
    const def = lib.vehicleFilter({})
    check('default shows a Model Y', lib.shows(def, { slug: 'car_a', model: 'Model Y' }))
    check('default hides a Model S', !lib.shows(def, { slug: 'car_b', model: 'Model S' }))
    check('default hides a car of unknown model', !lib.shows(def, { slug: 'car_a', model: null }))
    const all = lib.vehicleFilter({ VEHICLES_MODELS: '*' })
    check('* shows every model', lib.shows(all, { slug: 'car_b', model: 'Model S' }) && lib.shows(all, { slug: 'car_a', model: null }))
    const hide = lib.vehicleFilter({ VEHICLES_MODELS: 'Model Y, Model S', VEHICLES_HIDE: 'car_b' })
    check('VEHICLES_HIDE wins over the models', !lib.shows(hide, { slug: 'car_b', model: 'Model S' }) && lib.shows(hide, { slug: 'car_a', model: 'Model Y' }))

    // ---------- the template and its answer ----------
    const tpl = lib.registryTemplate(['car_a', "x'}}{{ 7*7 }}", 'CAR'])
    check('the template carries only clean slugs', tpl.includes("'car_a'") && !tpl.includes('7*7') && !tpl.includes("'CAR'"))
    const reg = lib.parseRegistry([{ slug: 'car_a', model: 'Model Y', name: 'Car A' }, { slug: '../x', model: 'M' }, null, 'junk', { slug: 'car_b', model: 42, name: '\u0007Car B ' }])
    check('the answer is re-validated', reg.size === 2 && reg.get('car_a')?.model === 'Model Y' && reg.get('car_b')?.model === null && reg.get('car_b')?.name === 'Car B')
    check('a non-list answer is empty', lib.parseRegistry({ slug: 'car_a' }).size === 0)

    // ---------- persistence ----------
    lib.saveVehicleRead(a)
    const back = lib.readVehicleReads().find((v) => v.slug === 'car_a')
    check('the last reading survives a restart', JSON.stringify(back) === JSON.stringify(a), JSON.stringify(back)?.slice(0, 120))
  }

  // ---------- the route: its own poll, then vehicleHosts() ----------
  const route = await import('../src/routes/vehicles.ts')
  let hosts = route.vehicleHosts()
  for (let k = 0; k < 40 && !seen.some((s) => s === 'GET /api/states'); k++) await new Promise((r) => setTimeout(r, 250))
  for (let k = 0; k < 40; k++) {
    hosts = route.vehicleHosts()
    // the poll has finished once a host is no longer stale (a saved reading shows stale until then)
    if (hosts.length && seen.some((s) => s.endsWith('/api/template')) && !hosts.some((h) => h.stale)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const bad = seen.filter((s) => s !== 'GET /api/states' && s !== 'POST /api/template')
  check('only the two reads were made', !bad.length, bad.join(', '))
  check('never a service call', !seen.some((s) => /\/api\/services\//.test(s)))

  if (live) {
    // the real states, through the same code the route runs (counts and models only, no names)
    const { haRequest } = await import('../src/routes/lights.ts')
    const states = await haRequest('GET', '/api/states') as unknown[]
    const first = lib.readVehicles(states as never)
    const reg = lib.parseRegistry(await haRequest('POST', '/api/template', { template: lib.registryTemplate(first.reads.map((v) => v.slug)) }))
    const { reads } = lib.readVehicles(states as never, reg)
    const models = reads.map((v) => v.model ?? 'unknown').sort()
    console.log(`live: ${reads.length} car(s) discovered, models ${models.join(', ')}, states ${reads.map((v) => v.state).join(', ')}, ${first.unavailable.length} unavailable`)
    check('live: discovery finds both cars', reads.length === 2, String(reads.length))
    check('live: one Model Y and one Model S', models.join(',') === 'Model S,Model Y', models.join(','))
    check('live: every car has a battery, a range and a state', reads.every((v) => v.battery >= 0 && v.rangeMi != null && v.state !== 'unknown'))
    check('live: the default shows only the Model Y', hosts.length === 1 && hosts[0].vehicle.model === 'Model Y', hosts.map((h) => h.vehicle.model).join(','))
    if (hosts[0]) {
      const h = hosts[0]
      console.log(`live: host ${h.host.replace(/^car-.*/, 'car-<slug>')} os ${h.os} online ${h.online} stale ${h.stale} state ${h.vehicle.state} battery ${h.battery.percent}% ${h.battery.status} range ${h.vehicle.rangeMi} mi limit ${h.vehicle.chargeLimit}% cable ${h.vehicle.cable} locked ${h.vehicle.locked} home ${h.vehicle.home}`)
      check('live: the host is a vehicle with a car- id', h.os === 'vehicle' && /^car-[a-z0-9_]+$/.test(h.host))
    }
  } else {
    check('the route shows only the Model Y by default', hosts.map((h) => h.host).join(',') === 'car-car_a', hosts.map((h) => h.host).join(','))
    const h = hosts[0]
    check('the host reads like the others', !!h && h.os === 'vehicle' && h.online && !h.stale && h.label === 'Car A' && h.cpu === null && h.memory === null && h.disk === null)
    check('battery on the host', h?.battery.percent === 76 && h.battery.status === 'charging', JSON.stringify(h?.battery))
    check('vehicle facts on the host', h?.vehicle.state === 'awake' && h.vehicle.rangeMi === 230.5 && h.vehicle.chargeLimit === 80 && h.vehicle.chargerKw === 11.5 && h.vehicle.cable === true && h.vehicle.locked === true && h.vehicle.home === true && h.vehicle.model === 'Model Y')
    check('nothing about where the car is', !JSON.stringify(hosts).match(/latitude|longitude|gps/))
  }
} catch (err) {
  console.log(`FAIL threw: ${(err as Error).stack ?? err}`)
  failed++
} finally {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
