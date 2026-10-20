// CAR: the Car tab (screens/Car.tsx) over a fake car. Generic names only (Car A,
// car_a, made-up coordinates). The car's view (GET /api/vehicles/car-car_a) and
// its host row are answered in the browser; every command is a write, so the
// e2e fence answers it here and nothing ever reaches odin, Home Assistant or a
// car.
//
//   render    the tab on the phone, the iPad and the desktop at zoom 1.2: the
//             head (name, Awake, battery, range), the Model Y drawn, the six
//             groups, the six tabs on screen without touching, nothing wider
//             than the screen, no em dash, and the coordinates nowhere in the
//             page (text or markup) until Map is tapped
//   controls  every control, each answered first with a failure and then with
//             success: the exact command body, the two taps where they are
//             required (the first tap sends nothing), the busy state while the
//             command is out, the failure toast, the failed mark and the real
//             state put back, then the success state
//   asleep    a sleeping car says so, and a command on it shows "Waking the car"
//             until it lands
//   key       a command the car refuses for a missing key shows the one line
//             with Tesla's key link, a view that says so shows it at load, and a
//             command that works clears it
//   offline   Home Assistant cannot reach the car: the line says so and every
//             control is off
//   noview    a backend without the car controls (404): the head still reads
//             the host list, and one line says the controls are unavailable
//   map       Map opens Apple Maps on Apple devices and Google Maps elsewhere,
//             with the coordinates put into the link only at the tap
//   open      System > Hosts' "Open Car" opens the Car tab on that car

import { sleep } from '../lib/cdp.mjs'
import { quietThor } from '../lib/fixtures.mjs'
import { carHost } from './hosts.mjs'

const ID = 'car-car_a'
const VIEW = `/api/vehicles/${ID}`
const CMD = `${VIEW}/command`
/** made-up coordinates: the page must never draw them */
const LAT = 12.345678
const LON = -45.678901
const KEY_LINE = "Add Valkyrie's key to the car: open tesla.com/_ak/kups14502.github.io on your phone"
const LEVELS = ['off', 'low', 'medium', 'high']
const ALL_ACTIONS = [
  'lock', 'unlock', 'sentry_on', 'sentry_off', 'climate_on', 'climate_off', 'climate_temp', 'defrost_on', 'defrost_off',
  'seat_heat_front_left', 'seat_heat_front_right', 'wheel_heat', 'charge_start', 'charge_stop', 'charge_limit', 'charge_amps',
  'port_open', 'port_close', 'frunk_open', 'trunk_open', 'trunk_close', 'windows_vent', 'windows_close', 'flash', 'honk', 'wake',
]

/** The car's view as GET /api/vehicles/:id gives it (backend routes/vehicles.ts VehicleView): Car A, awake, plugged in, not charging. */
export function carView(over = {}) {
  const now = Date.now()
  return {
    id: ID, label: 'Car A', model: 'Model Y', state: 'awake', since: now - 2 * 3_600_000, online: true, stale: false, keyMissing: false,
    ts: now - 120_000, battery: 75, rangeMi: 225.6,
    security: { locked: true, sentry: true, doorsOpen: [], windowsOpen: [], userPresent: false },
    climate: {
      on: false, target: 71.5, min: 59, max: 82.5, unit: 'F', insideF: 59.7, outsideF: 55.4, defrost: false,
      seats: [{ seat: 'front_left', level: 'off', options: LEVELS }, { seat: 'front_right', level: 'off', options: LEVELS }],
      wheel: { level: 'off', options: ['off', 'low', 'high'] },
    },
    charge: {
      on: false, state: 'stopped', cable: true, kw: 0, rateMph: 0, amps: 0, volts: 240, addedKwh: 27.4, fullAt: null,
      limit: { value: 80, min: 50, max: 100, step: 1 }, current: { value: 48, min: 0, max: 48, step: 1 }, port: 'closed',
    },
    openings: { frunk: 'closed', trunk: 'closed', windows: 'closed' },
    status: {
      tiresPsi: null, tireWarn: [], odometerMi: null,
      software: { installed: '2026.1.1', latest: '2026.1.1', available: false, installing: false, pct: null },
      home: false, location: { lat: LAT, lon: LON },
    },
    actions: ALL_ACTIONS,
    ...over,
  }
}

/** What the car does for an action, the way the backend's read after a command shows it. */
function applyAction(v0, action, value) {
  const v = structuredClone(v0)
  const seat = /^seat_heat_(.+)$/.exec(action)?.[1]
  if (action === 'lock' || action === 'unlock') v.security.locked = action === 'lock'
  else if (action === 'sentry_on' || action === 'sentry_off') v.security.sentry = action === 'sentry_on'
  else if (action === 'climate_on' || action === 'climate_off') v.climate.on = action === 'climate_on'
  else if (action === 'climate_temp') v.climate.target = value
  else if (action === 'defrost_on' || action === 'defrost_off') v.climate.defrost = action === 'defrost_on'
  else if (seat) v.climate.seats = v.climate.seats.map((s) => (s.seat === seat ? { ...s, level: value } : s))
  else if (action === 'wheel_heat') v.climate.wheel.level = value
  else if (action === 'charge_start') Object.assign(v.charge, { on: true, state: 'charging', kw: 11.5, amps: 48, rateMph: 30 })
  else if (action === 'charge_stop') Object.assign(v.charge, { on: false, state: 'stopped', kw: 0, amps: 0, rateMph: 0 })
  else if (action === 'charge_limit') v.charge.limit.value = value
  else if (action === 'charge_amps') v.charge.current.value = value
  else if (action === 'port_open' || action === 'port_close') v.charge.port = action === 'port_open' ? 'open' : 'closed'
  else if (action === 'frunk_open') v.openings.frunk = 'open'
  else if (action === 'trunk_open' || action === 'trunk_close') v.openings.trunk = action === 'trunk_open' ? 'open' : 'closed'
  else if (action === 'windows_vent' || action === 'windows_close') v.openings.windows = action === 'windows_vent' ? 'open' : 'closed'
  // Home Assistant wakes a sleeping car for any command
  v.state = 'awake'
  v.ts = Date.now()
  return v
}

/** The car as /api/hosts lists it (the head reads it until the view lands, and the model glows by it). */
const hostsDoc = (over = {}) => ({ hosts: [carHost('car_a', 'Car A', { charging: 'stopped', battery: 75, range: 226, ...over })] })

/**
 * The Car tab over the fake car. `st.mode`: 'ok' answers each command with the
 * car's new state, 'fail' with a 502 and the car unchanged; `st.delay` holds
 * each answer (so the busy state can be seen).
 */
async function openCar(t, { view = carView(), hosts = hostsDoc(), path = '/m/car', viewStatus = 200, waitGroups = true } = {}) {
  const page = await t.page()
  quietThor(page)
  const st = { view, mode: 'ok', delay: 450, error: 'Command failed: e2e refused it', keyMissing: false }
  page.mock('/api/hosts', () => ({ status: 200, body: hosts }))
  page.mock(VIEW, () => (viewStatus === 200 ? { status: 200, body: st.view } : { status: viewStatus, body: 'Cannot GET' }))
  page.onWrite(async (w) => {
    if (w.method !== 'POST' || w.path !== CMD) return undefined
    if (st.delay) await sleep(st.delay)
    if (st.mode === 'fail') {
      return { status: 502, body: { ok: false, error: st.error, keyMissing: st.keyMissing, view: st.keyMissing ? { ...st.view, keyMissing: true } : st.view } }
    }
    st.view = { ...applyAction(st.view, w.json?.action, w.json?.value), keyMissing: false }
    return { status: 200, body: { ok: true, view: st.view } }
  })
  await page.goto(path)
  if (waitGroups) {
    await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .car-grp').length >= 6, { timeout: 15_000, message: 'the Car tab did not draw its six groups' })
    // the build-in tilts the rows in over about a second
    await sleep(1300)
  }
  return { page, st }
}

/** Waits (Node side) until the page has sent `n` writes. */
async function waitWrites(page, n, timeout = 8000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(40)
  if (page.writes.length < n) throw new Error(`expected ${n} command(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

/** Every control's state as drawn, in one read. */
function readCar() {
  const root = document.querySelector('.vl-page[data-active]')
  if (!root) return null
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const has = (el, a) => !!el && el.hasAttribute(a)
  const rows = {}
  for (const r of root.querySelectorAll('.car-row[data-k]')) {
    const act = r.querySelector('.car-act')
    rows[r.getAttribute('data-k')] = {
      label: txt(r.querySelector('.car-row-text b')), sub: txt(r.querySelector('.car-row-text em')),
      act: txt(act), actBusy: has(act, 'data-busy'), actArmed: has(act, 'data-armed'), actFailed: has(act, 'data-failed'), actOff: !!act?.disabled,
      busy: has(r, 'data-busy'), failed: has(r, 'data-failed'),
    }
  }
  const sw = {}
  for (const s of root.querySelectorAll('.car-sw[data-k]')) {
    sw[s.getAttribute('data-k')] = { on: s.getAttribute('aria-checked') === 'true', word: txt(s.querySelector('.car-sw-word')), busy: has(s, 'data-busy'), failed: has(s, 'data-failed'), off: s.disabled }
  }
  const steps = {}
  for (const s of root.querySelectorAll('.car-step[data-k]')) {
    steps[s.getAttribute('data-k')] = { val: txt(s.querySelector('.car-step-val')), busy: has(s, 'data-busy'), failed: has(s, 'data-failed'), draft: has(s, 'data-draft') }
  }
  const bar = root.querySelector('.car-bar[data-k="limit"]')
  const seats = {}
  for (const e of root.querySelectorAll('.car-seat[data-seat]')) {
    seats[e.getAttribute('data-seat')] = { level: e.getAttribute('data-level'), busy: has(e, 'data-busy'), failed: has(e, 'data-failed'), draft: has(e, 'data-draft') }
  }
  const quick = {}
  for (const a of root.querySelectorAll('.car-quick .car-act')) {
    quick[a.getAttribute('data-act')] = { text: txt(a), busy: has(a, 'data-busy'), failed: has(a, 'data-failed'), armed: has(a, 'data-armed') }
  }
  return {
    head: txt(root.querySelector('.car-head')),
    rows, sw, steps, seats, quick,
    bar: bar ? { val: txt(bar.querySelector('.car-bar-val')), busy: has(bar, 'data-busy'), failed: has(bar, 'data-failed'), now: Number(bar.getAttribute('aria-valuenow')) } : null,
    wheel: txt(root.querySelector('.car-row[data-k="wheel"] .car-opt[data-on]')),
    waking: txt(root.querySelector('.car-waking')),
    key: txt(root.querySelector('.car-key')),
    keyHref: root.querySelector('.car-key a')?.getAttribute('href') ?? null,
  }
}

const A = (k) => `.vl-page[data-active] .car-row[data-k="${k}"] .car-act`
const SW = (k) => `.vl-page[data-active] .car-sw[data-k="${k}"]`
const STEP = (k, up) => ({ sel: `.vl-page[data-active] .car-step[data-k="${k}"] .car-step-btn`, index: up ? 1 : 0 })
const SEAT = (s) => `.vl-page[data-active] .car-seat[data-seat="${s}"]`
const Q = (a) => `.vl-page[data-active] .car-quick .car-act[data-act="${a}"]`

/** A tap at the charge limit bar's point for `value`. */
async function tapLimit(page, value) {
  const at = await page.eval((v) => {
    const bar = document.querySelector('.vl-page[data-active] .car-bar[data-k="limit"]')
    const tr = bar?.querySelector('.car-bar-track')
    if (!tr) return null
    tr.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = tr.getBoundingClientRect()
    return { x: r.left + (r.width * (v - 50)) / 50, y: r.top + r.height / 2 }
  }, value)
  if (!at) throw new Error('no charge limit bar')
  await sleep(250)
  await page.tap(at)
}

/**
 * The controls, in the order they run on one page. Each: how to press it
 * (`press`, with `confirm` when it takes two taps), the exact body, and three
 * reads of readCar(): `busy` while its command is out, `failed` after a 502
 * (the real state back and the control marked), `done` after the 200.
 */
const CONTROLS = {
  security: [
    {
      id: 'unlock', confirm: true, press: A('lock'), body: { action: 'unlock' },
      busy: (s) => s.rows.lock.actBusy && s.rows.lock.act === 'Unlocking',
      failed: (s) => s.rows.lock.label === 'Locked' && s.rows.lock.act === 'Unlock' && s.rows.lock.actFailed,
      done: (s) => s.rows.lock.label === 'Unlocked' && s.rows.lock.act === 'Lock' && !s.rows.lock.actBusy,
    },
    {
      id: 'lock', press: A('lock'), body: { action: 'lock' },
      busy: (s) => s.rows.lock.actBusy && s.rows.lock.act === 'Locking',
      failed: (s) => s.rows.lock.label === 'Unlocked' && s.rows.lock.act === 'Lock' && s.rows.lock.actFailed,
      done: (s) => s.rows.lock.label === 'Locked' && s.rows.lock.act === 'Unlock',
    },
    {
      id: 'sentry_off', press: SW('sentry'), body: { action: 'sentry_off' },
      busy: (s) => s.sw.sentry.busy && s.sw.sentry.word === 'Turning off' && !s.sw.sentry.on,
      failed: (s) => s.sw.sentry.on && s.sw.sentry.failed && s.sw.sentry.word === 'On',
      done: (s) => !s.sw.sentry.on && s.sw.sentry.word === 'Off' && !s.sw.sentry.busy,
    },
    {
      id: 'sentry_on', press: SW('sentry'), body: { action: 'sentry_on' },
      busy: (s) => s.sw.sentry.busy && s.sw.sentry.word === 'Turning on',
      failed: (s) => !s.sw.sentry.on && s.sw.sentry.failed,
      done: (s) => s.sw.sentry.on && s.sw.sentry.word === 'On',
    },
  ],
  climate: [
    {
      id: 'climate_on', press: SW('climate'), body: { action: 'climate_on' },
      busy: (s) => s.sw.climate.busy && s.sw.climate.word === 'Turning on' && s.sw.climate.on,
      failed: (s) => !s.sw.climate.on && s.sw.climate.failed,
      done: (s) => s.sw.climate.on && s.sw.climate.word === 'On',
    },
    {
      id: 'climate_temp', press: [STEP('temp', true), STEP('temp', true)], body: { action: 'climate_temp', value: 73.5 },
      busy: (s) => s.steps.temp.busy && s.steps.temp.val === '73.5°F',
      failed: (s) => s.steps.temp.failed && s.steps.temp.val === '71.5°F',
      done: (s) => s.steps.temp.val === '73.5°F' && !s.steps.temp.busy,
    },
    {
      id: 'defrost_on', press: SW('defrost'), body: { action: 'defrost_on' },
      busy: (s) => s.sw.defrost.busy && s.sw.defrost.on,
      failed: (s) => !s.sw.defrost.on && s.sw.defrost.failed,
      done: (s) => s.sw.defrost.on && !s.sw.defrost.busy,
    },
    {
      id: 'seat_heat_front_left', press: [SEAT('front_left'), SEAT('front_left')], body: { action: 'seat_heat_front_left', value: 'medium' },
      busy: (s) => s.seats.front_left.busy && s.seats.front_left.level === 'medium',
      failed: (s) => s.seats.front_left.failed && s.seats.front_left.level === 'off',
      done: (s) => s.seats.front_left.level === 'medium' && !s.seats.front_left.busy,
    },
    {
      id: 'seat_heat_front_right', press: [SEAT('front_right')], body: { action: 'seat_heat_front_right', value: 'low' },
      busy: (s) => s.seats.front_right.busy && s.seats.front_right.level === 'low',
      failed: (s) => s.seats.front_right.failed && s.seats.front_right.level === 'off',
      done: (s) => s.seats.front_right.level === 'low',
    },
    {
      id: 'wheel_heat', press: { sel: '.vl-page[data-active] .car-row[data-k="wheel"] .car-opt', text: /^\s*High\s*$/ }, body: { action: 'wheel_heat', value: 'high' },
      busy: (s) => s.rows.wheel.busy && s.wheel === 'High',
      failed: (s) => s.rows.wheel.failed && s.wheel === 'Off',
      done: (s) => s.wheel === 'High' && !s.rows.wheel.busy,
    },
    {
      id: 'defrost_off', press: SW('defrost'), body: { action: 'defrost_off' },
      busy: (s) => s.sw.defrost.busy && !s.sw.defrost.on,
      failed: (s) => s.sw.defrost.on && s.sw.defrost.failed,
      done: (s) => !s.sw.defrost.on,
    },
    {
      id: 'climate_off', press: SW('climate'), body: { action: 'climate_off' },
      busy: (s) => s.sw.climate.busy && s.sw.climate.word === 'Turning off',
      failed: (s) => s.sw.climate.on && s.sw.climate.failed,
      done: (s) => !s.sw.climate.on,
    },
  ],
  charging: [
    {
      id: 'charge_start', press: A('charge'), body: { action: 'charge_start' },
      busy: (s) => s.rows.charge.actBusy && s.rows.charge.act === 'Starting',
      failed: (s) => s.rows.charge.act === 'Start' && s.rows.charge.actFailed,
      done: (s) => s.rows.charge.act === 'Stop' && /^Charging/.test(s.rows.charge.label),
    },
    {
      id: 'charge_stop', press: A('charge'), body: { action: 'charge_stop' },
      busy: (s) => s.rows.charge.actBusy && s.rows.charge.act === 'Stopping',
      failed: (s) => s.rows.charge.act === 'Stop' && s.rows.charge.actFailed,
      done: (s) => s.rows.charge.act === 'Start',
    },
    {
      id: 'charge_limit', press: async (page) => tapLimit(page, 90), body: { action: 'charge_limit', value: 90 },
      busy: (s) => s.bar.busy && s.bar.val === '90%',
      failed: (s) => s.bar.failed && s.bar.val === '80%',
      done: (s) => s.bar.val === '90%' && !s.bar.busy,
    },
    {
      id: 'charge_amps', press: [STEP('amps', false)], body: { action: 'charge_amps', value: 47 },
      busy: (s) => s.steps.amps.busy && s.steps.amps.val === '47A',
      failed: (s) => s.steps.amps.failed && s.steps.amps.val === '48A',
      done: (s) => s.steps.amps.val === '47A' && !s.steps.amps.busy,
    },
    {
      id: 'port_open', confirm: true, press: A('port'), body: { action: 'port_open' },
      busy: (s) => s.rows.port.actBusy && s.rows.port.act === 'Opening',
      failed: (s) => s.rows.port.act === 'Open' && s.rows.port.actFailed && s.rows.port.sub === 'Closed',
      done: (s) => s.rows.port.act === 'Close' && s.rows.port.sub === 'Open',
    },
    {
      id: 'port_close', press: A('port'), body: { action: 'port_close' },
      busy: (s) => s.rows.port.actBusy && s.rows.port.act === 'Closing',
      failed: (s) => s.rows.port.act === 'Close' && s.rows.port.actFailed,
      done: (s) => s.rows.port.act === 'Open' && s.rows.port.sub === 'Closed',
    },
  ],
  openings: [
    {
      id: 'frunk_open', confirm: true, press: A('frunk'), body: { action: 'frunk_open' },
      busy: (s) => s.rows.frunk.actBusy && s.rows.frunk.act === 'Opening',
      failed: (s) => s.rows.frunk.act === 'Open' && s.rows.frunk.actFailed && s.rows.frunk.sub === 'Closed',
      done: (s) => !s.rows.frunk.act && /^Open/.test(s.rows.frunk.sub),
    },
    {
      id: 'trunk_open', confirm: true, press: A('trunk'), body: { action: 'trunk_open' },
      busy: (s) => s.rows.trunk.actBusy && s.rows.trunk.act === 'Opening',
      failed: (s) => s.rows.trunk.act === 'Open' && s.rows.trunk.actFailed,
      done: (s) => s.rows.trunk.act === 'Close' && s.rows.trunk.sub === 'Open',
    },
    {
      id: 'trunk_close', press: A('trunk'), body: { action: 'trunk_close' },
      busy: (s) => s.rows.trunk.actBusy && s.rows.trunk.act === 'Closing',
      failed: (s) => s.rows.trunk.act === 'Close' && s.rows.trunk.actFailed,
      done: (s) => s.rows.trunk.act === 'Open' && s.rows.trunk.sub === 'Closed',
    },
    {
      id: 'windows_vent', confirm: true, press: A('windows'), body: { action: 'windows_vent' },
      busy: (s) => s.rows.windows.actBusy && s.rows.windows.act === 'Venting',
      failed: (s) => s.rows.windows.act === 'Vent' && s.rows.windows.actFailed,
      done: (s) => s.rows.windows.act === 'Close' && s.rows.windows.sub === 'Vented',
    },
    {
      id: 'windows_close', press: A('windows'), body: { action: 'windows_close' },
      busy: (s) => s.rows.windows.actBusy && s.rows.windows.act === 'Closing',
      failed: (s) => s.rows.windows.act === 'Close' && s.rows.windows.actFailed,
      done: (s) => s.rows.windows.act === 'Vent' && s.rows.windows.sub === 'Closed',
    },
  ],
  quick: [
    {
      id: 'flash', press: Q('flash'), body: { action: 'flash' },
      busy: (s) => s.quick.flash.busy && s.quick.flash.text === 'Flashing',
      failed: (s) => s.quick.flash.failed && s.quick.flash.text === 'Flash lights',
      done: (s) => !s.quick.flash.busy && !s.quick.flash.failed,
    },
    {
      id: 'honk', confirm: true, press: Q('honk'), body: { action: 'honk' },
      busy: (s) => s.quick.honk.busy && s.quick.honk.text === 'Honking',
      failed: (s) => s.quick.honk.failed && s.quick.honk.text === 'Honk',
      done: (s) => !s.quick.honk.busy && s.quick.honk.text === 'Honk',
    },
    {
      id: 'wake', press: Q('wake'), body: { action: 'wake' },
      busy: (s) => s.quick.wake.busy && s.quick.wake.text === 'Waking',
      failed: (s) => s.quick.wake.failed && s.quick.wake.text === 'Wake',
      done: (s) => !s.quick.wake.busy,
    },
  ],
}

/** Runs one control twice: a 502 first (busy, toast, failed mark, the real state back), then a 200 (busy, the new state). */
async function runControl(t, page, st, c) {
  const read = () => page.eval(readCar)
  const press = async () => {
    const before = page.writes.length
    if (typeof c.press === 'function') { await c.press(page); return }
    const taps = Array.isArray(c.press) ? c.press : [c.press]
    if (c.confirm) {
      await page.tap(taps[0])
      await sleep(350)
      t.check(page.writes.length === before, `${c.id}: the first tap sent a command; it must take two`)
      const armed = await page.eval((sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0)
        return el ? { armed: el.hasAttribute('data-armed'), text: (el.textContent || '').trim() } : null
      }, typeof taps[0] === 'string' ? taps[0] : taps[0].sel)
      t.check(armed?.armed && /\?$/.test(armed.text), `${c.id}: the first tap did not arm the button (${JSON.stringify(armed)})`)
    }
    for (const x of taps) await page.tap(x)
  }
  for (const mode of ['fail', 'ok']) {
    await t.step(`${c.id} ${mode}`, async () => {
      st.mode = mode
      const n = page.writes.length + 1
      const since = Date.now()
      await press()
      const w = await waitWrites(page, n)
      t.check(w.method === 'POST' && w.path === CMD, `${c.id}: sent ${w.method} ${w.path}`)
      t.check(JSON.stringify(w.json) === JSON.stringify(c.body), `${c.id} ${mode}: sent ${w.body}, want ${JSON.stringify(c.body)}`)
      const s1 = await read()
      t.check(c.busy(s1), `${c.id} ${mode}: not shown as busy while the command is out (${JSON.stringify(pick(s1, c.id))})`)
      if (mode === 'fail') {
        await page.waitToast(/failed: Command failed: e2e refused it/, { since, timeout: 6000 })
        await page.waitFor(() => !document.querySelector('.vl-page[data-active] [data-busy]'), { timeout: 4000, message: `${c.id}: still busy after the failure` })
        const s2 = await read()
        t.check(c.failed(s2), `${c.id}: after the failure the real state is not back or the control is not marked (${JSON.stringify(pick(s2, c.id))})`)
        // the failed mark fades; the next press must not wait on it
        await sleep(200)
      } else {
        await page.waitFor(() => !document.querySelector('.vl-page[data-active] [data-busy]'), { timeout: 4000, message: `${c.id}: still busy after the success` })
        await sleep(150)
        const s2 = await read()
        t.check(c.done(s2), `${c.id}: after the success the screen reads ${JSON.stringify(pick(s2, c.id))}`)
      }
    })
  }
}

/** The part of a readCar() snapshot that matters to one control, for a failure message. */
function pick(s, id) {
  if (!s) return null
  const k = { unlock: 'lock', lock: 'lock', charge_start: 'charge', charge_stop: 'charge', port_open: 'port', port_close: 'port', frunk_open: 'frunk', trunk_open: 'trunk', trunk_close: 'trunk', windows_vent: 'windows', windows_close: 'windows', wheel_heat: 'wheel' }[id]
  if (k) return { row: s.rows[k], wheel: id === 'wheel_heat' ? s.wheel : undefined }
  if (/^sentry/.test(id)) return s.sw.sentry
  if (/^climate_(on|off)$/.test(id)) return s.sw.climate
  if (/^defrost/.test(id)) return s.sw.defrost
  if (id === 'climate_temp') return s.steps.temp
  if (id === 'charge_amps') return s.steps.amps
  if (id === 'charge_limit') return s.bar
  if (/^seat_heat_/.test(id)) return s.seats
  return s.quick[id] ?? null
}

/** The six tabs: each on screen, none touching the next. */
function tabsReport() {
  const W = document.documentElement.clientWidth
  const tabs = [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((e) => {
    const r = e.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(e)
    const tr = range.getBoundingClientRect()
    return { label: (e.textContent || '').trim(), l: r.left, r: r.right, tl: tr.left, tr: tr.right }
  })
  const off = tabs.filter((x) => x.l < -0.5 || x.r > W + 0.5).map((x) => x.label)
  const touching = tabs.slice(1).filter((x, i) => x.tl < tabs[i].tr + 6).map((x, i) => `${tabs[i].label}|${x.label}`)
  return { labels: tabs.map((x) => x.label), off, touching, W }
}

function renderTests() {
  const out = []
  for (const device of ['phone', 'ipad', 'desk1080', 'desktop']) {
    out.push({
      name: `car:render:${device}`,
      group: 'car',
      device,
      timeout: 60_000,
      async run(t) {
        const { page } = await openCar(t)
        await page.waitFor(() => !!document.querySelector('.vl-page[data-active] .car-model [data-hero="modelY"] [data-wire-scene]'), { timeout: 8000, message: 'the Model Y did not draw on the Car tab' })
        await sleep(600)
        const r = await page.eval(() => {
          const root = document.querySelector('.vl-page[data-active]')
          const W = document.documentElement.clientWidth
          const wide = [...root.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > W + 1 }).slice(0, 4).map((e) => e.className)
          const model = root.querySelector('.car-model')?.getBoundingClientRect()
          return {
            screen: root.getAttribute('data-screen'),
            text: (root.innerText || '').replace(/\s+/g, ' '),
            groups: [...root.querySelectorAll('.car-grp')].map((g) => g.getAttribute('data-grp')),
            head: (root.querySelector('.car-head')?.innerText || '').replace(/\s+/g, ' ').trim(),
            spots: [...root.querySelectorAll('.car-model [data-hotspot]')].map((b) => b.getAttribute('data-hotspot')),
            modelH: model ? Math.round(model.height) : 0,
            modelW: model ? Math.round(model.width) : 0,
            docSW: document.documentElement.scrollWidth, W, wide,
            html: document.documentElement.outerHTML,
            lit: document.querySelector('.vl-nav .vl-tab-prim[aria-current="page"]')?.textContent?.trim(),
            seats: [...root.querySelectorAll('.car-seat[data-seat]')].map((e) => e.getAttribute('data-seat')),
          }
        })
        t.check(r.screen === 'car' && r.lit === 'Car', `the Car tab is not the lit one (${r.screen}, ${r.lit})`)
        t.check(/Car A/i.test(r.head) && /Awake/i.test(r.head) && /75\s*%/.test(r.head) && /226\s*mi/.test(r.head), `the head reads "${r.head}", want Car A, Awake, 75%, 226 mi`)
        t.check(['security', 'climate', 'charging', 'openings', 'quick', 'status'].every((g) => r.groups.includes(g)), `the groups are ${r.groups.join(', ')}`)
        t.check(['battery', 'charge', 'cabin'].every((s) => r.spots.includes(s)), `the model's diamonds are ${r.spots.join(', ')}`)
        t.check(r.modelH >= 200 && r.modelW >= 300, `the model is ${r.modelW}x${r.modelH}, want it large`)
        t.check(r.seats.join() === 'front_left,front_right', `the seat map shows ${r.seats.join(', ')}`)
        t.check(r.docSW <= r.W + 1 && !r.wide.length, `the page is wider than the screen (${r.docSW} > ${r.W}): ${r.wide.join(', ')}`)
        t.check(!/[—]/.test(r.text), 'an em dash on the Car tab')
        t.check(!r.html.includes('12.345') && !r.html.includes('45.678'), 'the coordinates are in the page before Map was tapped')
        t.check(/Tires Off in Home Assistant/.test(r.text) && /Odometer Off in Home Assistant/.test(r.text), 'tires and odometer do not say they are off in Home Assistant')
        const tabs = await page.eval(tabsReport)
        t.check(tabs.labels.join() === 'Dashboard,AI,Lights,Car,Media,System', `the tabs are ${tabs.labels.join(', ')}`)
        t.check(!tabs.off.length, `tabs off the screen at ${tabs.W}px: ${tabs.off.join(', ')}`)
        t.check(!tabs.touching.length, `tab labels run into each other at ${tabs.W}px: ${tabs.touching.join(', ')}`)
        t.check(!page.writes.length, 'the Car tab sent a command on its own')
        await t.shot(page)
      },
    })
  }
  return out
}

function controlTests() {
  const plan = [
    ['security', 'phone'], ['climate', 'phone'], ['charging', 'phone'], ['openings', 'phone'], ['quick', 'phone'],
    ['security', 'desk1080'], ['charging', 'desk1080'],
  ]
  return plan.map(([group, device]) => ({
    name: `car:controls:${group}:${device}`,
    group: 'car',
    device,
    timeout: 150_000,
    async run(t) {
      const { page, st } = await openCar(t)
      for (const c of CONTROLS[group]) await runControl(t, page, st, c)
      const bad = page.writes.filter((w) => w.path !== CMD)
      t.check(!bad.length, `writes other than commands: ${bad.map((w) => `${w.method} ${w.path}`).join(', ')}`)
    },
  }))
}

function stateTests() {
  return [
    {
      name: 'car:asleep:phone',
      group: 'car',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const { page, st } = await openCar(t, { view: carView({ state: 'asleep', since: Date.now() - 3 * 3_600_000 }), hosts: hostsDoc({ state: 'asleep' }) })
        let s = await page.eval(readCar)
        t.check(/Asleep/.test(s.head) && /asleep since .+ ET/.test(s.head), `the head reads "${s.head}", want Asleep and since when (ET)`)
        t.check(/A command wakes it first/.test(s.head), `no word that a command wakes the car first ("${s.head}")`)
        t.check(!s.waking, 'it says waking before any command')
        st.delay = 2500
        const since = Date.now()
        await page.tap(SW('climate'))
        await waitWrites(page, 1)
        await sleep(300)
        s = await page.eval(readCar)
        t.check(/Waking the car/.test(s.waking), `a command on the sleeping car does not say it is waking it ("${s.waking}")`)
        // the head may be scrolled away from the control: a toast says it too
        await page.waitToast(/^Waking the car\. A command on a sleeping car can take 30 s\.$/, { since })
        await page.waitFor(() => !document.querySelector('.vl-page[data-active] .car-waking'), { timeout: 6000, message: 'still waking after the command landed' })
        s = await page.eval(readCar)
        t.check(/Awake/.test(s.head) && s.sw.climate.on, `after the command the head reads "${s.head}" and climate ${JSON.stringify(s.sw.climate)}`)
        await t.shot(page)
      },
    },
    {
      name: 'car:key:phone',
      group: 'car',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const { page, st } = await openCar(t)
        let s = await page.eval(readCar)
        t.check(!s.key, 'the key line shows before any command failed')
        st.mode = 'fail'
        st.keyMissing = true
        st.error = 'Command failed: Vehicle did not recognize the key used to authorize command. Make sure your key is paired with the vehicle'
        const since = Date.now()
        await page.tap(Q('flash'))
        await waitWrites(page, 1)
        await page.waitToast(/Flash lights failed: the car does not have Valkyrie's key/, { since })
        const btns = await page.eval(() => [...document.querySelectorAll('.vl-toast-btn')].map((b) => (b.textContent || '').trim()))
        t.check(btns.includes('Add key'), `the failure toast offers ${JSON.stringify(btns)}, want Add key`)
        s = await page.eval(readCar)
        t.check(s.key === KEY_LINE, `the key line reads "${s.key}", want "${KEY_LINE}"`)
        t.check(s.keyHref === 'https://tesla.com/_ak/kups14502.github.io', `the key link goes to ${s.keyHref}`)
        await t.shot(page)
        st.mode = 'ok'
        st.keyMissing = false
        await page.tap(Q('flash'))
        await waitWrites(page, 2)
        await page.waitFor(() => !document.querySelector('.vl-page[data-active] .car-key'), { timeout: 5000, message: 'the key line stays after a command that worked' })

        // a view that says the key is missing shows the line at load
        const again = await openCar(t, { view: carView({ keyMissing: true }) })
        s = await again.page.eval(readCar)
        t.check(s.key === KEY_LINE, `a view with keyMissing shows "${s.key}"`)
      },
    },
    {
      name: 'car:offline:phone',
      group: 'car',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const { page } = await openCar(t, { view: carView({ online: false, state: 'offline' }), hosts: hostsDoc({ online: false }) })
        const s = await page.eval(readCar)
        t.check(/Offline/.test(s.head) && /Home Assistant cannot reach the car/.test(s.head), `the head reads "${s.head}"`)
        const off = await page.eval(() => {
          const root = document.querySelector('.vl-page[data-active]')
          const ctl = [...root.querySelectorAll('button.car-act, .car-sw, .car-step-btn, .car-seat, .car-opt')]
          return { n: ctl.length, live: ctl.filter((e) => !e.disabled).map((e) => e.textContent.trim()), bar: root.querySelector('.car-bar')?.getAttribute('aria-disabled') }
        })
        t.check(off.n > 10 && !off.live.length && off.bar === 'true', `controls still live with the car out of reach: ${JSON.stringify(off)}`)
        await page.tap(Q('flash')).catch(() => {})
        await sleep(400)
        t.check(!page.writes.length, 'a control sent a command while the car is out of reach')
      },
    },
    {
      name: 'car:noview:phone',
      group: 'car',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const { page } = await openCar(t, { viewStatus: 404, waitGroups: false })
        await page.waitFor(() => /Controls unavailable/.test(document.querySelector('.vl-page[data-active] .car-head')?.textContent || ''), { timeout: 10_000, message: 'no line saying the controls are unavailable' })
        const r = await page.eval(() => ({
          head: (document.querySelector('.vl-page[data-active] .car-head')?.innerText || '').replace(/\s+/g, ' '),
          groups: document.querySelectorAll('.vl-page[data-active] .car-grp').length,
        }))
        t.check(/Car A/i.test(r.head) && /75\s*%/.test(r.head) && /226\s*mi/.test(r.head), `the head without a view reads "${r.head}", want the host list's reading`)
        t.check(/Controls unavailable: this server has no car controls yet/.test(r.head), `the line reads "${r.head}"`)
        t.check(r.groups === 0, `${r.groups} control groups drawn with no view`)
      },
    },
  ]
}

function mapTests() {
  return [['phone', /^https:\/\/maps\.apple\.com\/\?ll=12\.345678,-45\.678901&q=Car%20A$/], ['desktop', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=12\.345678,-45\.678901$/]].map(([device, want]) => ({
    name: `car:map:${device}`,
    group: 'car',
    device,
    timeout: 45_000,
    async run(t) {
      const { page } = await openCar(t)
      // the tap's navigation is caught after the page's own handler ran, so nothing opens
      await page.eval(() => {
        window.__e2eMap = []
        window.addEventListener('click', (e) => {
          const a = e.target instanceof Element ? e.target.closest('a') : null
          if (!a) return
          window.__e2eMap.push({ href: a.href, target: a.target, rel: a.rel })
          e.preventDefault()
        })
      })
      await page.tap({ sel: '.vl-page[data-active] .car-map' })
      await sleep(250)
      const r = await page.eval(() => ({ hits: window.__e2eMap, text: document.querySelector('.vl-page[data-active]').innerText }))
      const hit = r.hits?.[0]
      t.check(hit && want.test(hit.href), `Map opened ${hit?.href}, want ${want}`)
      t.check(hit?.target === '_blank' && /noopener/.test(hit?.rel ?? ''), `the Map link is ${JSON.stringify(hit)}`)
      t.check(!r.text.includes('12.345') && !r.text.includes('45.678'), 'the coordinates show as text after Map')
    },
  }))
}

function openTests() {
  return [{
    name: 'car:open:desk1080',
    group: 'car',
    device: 'desk1080',
    timeout: 60_000,
    async run(t) {
      const { page } = await openCar(t, { path: '/m/system/hosts', waitGroups: false })
      await page.waitFor(() => !!document.querySelector('.vl-page[data-active] .sys-car'), { timeout: 12_000, message: 'Car A is not on System > Hosts' })
      await sleep(600)
      await page.tap({ sel: '.vl-page[data-active] .sys-host', text: /Car A/ })
      await page.waitFor(() => !!document.querySelector('.vl-page[data-active] .sys-car-open'), { timeout: 8000, message: 'no Open Car link on the car detail' })
      await sleep(400)
      await page.tap({ sel: '.vl-page[data-active] .sys-car-open' })
      await page.waitPath('/m/car')
      await page.waitFor(() => /Car A/.test(document.querySelector('.vl-page[data-active] .car-head')?.textContent || ''), { timeout: 10_000, message: 'the Car tab did not open on Car A' })
      t.check(!page.writes.length, 'opening the Car tab sent a command')
    },
  }]
}

export function carTests() {
  return [...renderTests(), ...controlTests(), ...stateTests(), ...mapTests(), ...openTests()]
}
