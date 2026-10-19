/**
 * Light engine unit tests (routes/lights.ts createLightEngine) against a fake
 * Home Assistant that behaves like HA's Cync integration does on odin:
 *
 *   - turn_on is one combo packet; a field the call leaves out is filled from
 *     HA's cached copy of the bulb (homeassistant/components/cync/light.py)
 *   - brightness goes out as int(b / 255 * 100) and comes back as
 *     round((level + 1) * 255 / 101); kelvin as int((k - 2000) / 5000 * 100)
 *   - a bulb applies a command after a mesh delay and pushes its new state
 *     after a report delay, or never (the office lamp), in which case HA only
 *     learns it from the coordinator's 30 s poll, which every push restarts
 *
 * Nothing here talks to Home Assistant. Run from backend/:
 *   node --import tsx --test scripts/lightsEngine.test.mts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLightEngine, haBrightnessFor, pctFromHa, apiBrightness, pctFromApi,
  type Clock, type HAClient, type HAState, type Patch, type RGB,
} from '../src/routes/lights.ts'

// ---------- a clock the test drives ----------

class FakeClock implements Clock {
  t = 1_800_000_000_000
  private seq = 0
  private timers: { id: number; at: number; fn: () => void }[] = []
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const h = { id: ++this.seq, at: this.t + Math.max(0, ms), fn }
    this.timers.push(h)
    return h
  }
  clearTimeout = (h: unknown) => { this.timers = this.timers.filter((x) => x !== h) }
  async advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      await flush()
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.timers[0]
      if (!next || next.at > end) break
      this.timers.shift()
      this.t = Math.max(this.t, next.at)
      next.fn()
    }
    this.t = end
    await flush()
  }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)) }

// ---------- a fake HA + Cync ----------

type Dev = { on: boolean; level: number; mode: 'rgb' | 'ct'; rgb: RGB; ct: number }
type BulbSim = {
  phys: Dev // what the bulb really is
  cache: Dev // what HA believes
  lastUpdated: number
  /** ms after applying until the bulb pushes its state; null = it never pushes */
  pushMs: number | null
  applyMs: number
  /** the bulb lands somewhere else on its own (a dropped or mangled command) */
  mangle?: (d: Dev) => Dev
  /** next report shows no brightness (a Cync bulb mid mode-switch) */
  nullBrightnessOnce?: boolean
  unavailable?: boolean
}

const RED: RGB = [255, 0, 0]
const AMBER: RGB = [255, 140, 40]
const BLUE: RGB = [70, 130, 255]

class FakeCync implements HAClient {
  bulbs = new Map<string, BulbSim>()
  calls: { at: number; service: string; body: Record<string, any> }[] = []
  refreshes: { at: number; entities: string[] }[] = []
  failNext = false
  private pollTimer: unknown = null
  constructor(private clock: FakeClock, ids: Record<string, Partial<BulbSim> & { dev?: Partial<Dev> }>) {
    for (const [id, o] of Object.entries(ids)) {
      const d: Dev = { on: true, level: 43, mode: 'rgb', rgb: RED, ct: 4, ...o.dev }
      this.bulbs.set(id, { phys: { ...d }, cache: { ...d }, lastUpdated: clock.now() - 60_000, pushMs: 500, applyMs: 300, ...o })
    }
    this.schedulePoll()
  }
  private schedulePoll() {
    if (this.pollTimer) this.clock.clearTimeout(this.pollTimer)
    this.pollTimer = this.clock.setTimeout(() => { this.poll(); this.schedulePoll() }, 30_000)
  }
  /** HA takes in a state for a bulb: the current one on a poll, the one the bulb sent on a push */
  private report(id: string, d?: Dev) {
    const b = this.bulbs.get(id)!
    const next = d ?? b.phys
    const changed = JSON.stringify(b.cache) !== JSON.stringify(next) || b.nullBrightnessOnce
    b.cache = { ...next }
    if (changed) b.lastUpdated = this.clock.now()
  }
  /** a push carries the state the bulb had when it sent it; HA's async_set_updated_data also restarts the 30 s poll */
  private push(id: string, d: Dev) { this.report(id, d); this.schedulePoll() }
  private poll() { for (const id of this.bulbs.keys()) this.report(id) }

  async states(): Promise<HAState[]> {
    return [...this.bulbs.entries()].map(([id, b]) => {
      const c = b.cache
      const attrs: Record<string, any> = { friendly_name: id, supported_color_modes: ['color_temp', 'rgb'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 7000 }
      if (c.on) {
        attrs.brightness = b.nullBrightnessOnce ? null : Math.min(255, Math.max(1, Math.round(((c.level + 1) * 255) / 101)))
        attrs.color_mode = c.mode === 'ct' ? 'color_temp' : 'rgb'
        if (c.mode === 'ct') attrs.color_temp_kelvin = Math.trunc((c.ct * 5001) / 100) + 1999
        else attrs.rgb_color = c.rgb.map((v) => Math.round(v * 0.88)) // bulbs scale rgb their own way
      }
      if (b.nullBrightnessOnce && c.on) b.nullBrightnessOnce = false
      return { entity_id: id, state: b.unavailable ? 'unavailable' : c.on ? 'on' : 'off', attributes: attrs, last_updated: new Date(b.lastUpdated).toISOString() }
    })
  }

  async call(service: 'turn_on' | 'turn_off', body: Record<string, any>): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('HA POST -> 500') }
    this.calls.push({ at: this.clock.now(), service, body })
    const id = body.entity_id as string
    const b = this.bulbs.get(id)!
    // what HA's Cync light.async_turn_on sends, filling gaps from its cache
    let next: Dev
    if (service === 'turn_off') next = { ...b.phys, on: false }
    else {
      const c = b.cache
      const level = body.brightness != null ? Math.trunc((body.brightness / 255) * 100) : c.level
      let mode = c.mode, rgb = c.rgb, ct = c.ct
      if (body.color_temp_kelvin != null) { mode = 'ct'; ct = Math.max(1, Math.trunc(((body.color_temp_kelvin - 2000) / 5000) * 100)) }
      else if (body.rgb_color) { mode = 'rgb'; rgb = body.rgb_color }
      next = { on: true, level, mode, rgb, ct }
    }
    await new Promise<void>((r) => this.clock.setTimeout(r, 15)) // the REST round trip
    this.clock.setTimeout(() => {
      b.phys = b.mangle ? b.mangle(next) : next
      const sent = { ...b.phys }
      if (b.pushMs != null) this.clock.setTimeout(() => this.push(id, sent), b.pushMs)
    }, b.applyMs)
  }

  async refresh(entities: string[]): Promise<void> {
    this.refreshes.push({ at: this.clock.now(), entities })
    this.clock.setTimeout(() => this.poll(), 800)
  }

  /** an out-of-order report: HA hears an old state with a fresh timestamp */
  injectReport(id: string, d: Partial<Dev>) {
    const b = this.bulbs.get(id)!
    b.cache = { ...b.cache, ...d }
    b.lastUpdated = this.clock.now()
  }
  callsFor(id: string) { return this.calls.filter((c) => c.body.entity_id === id) }
}

function rig(ids: Record<string, Partial<BulbSim> & { dev?: Partial<Dev> }>, opts: { refresh?: boolean } = {}) {
  const clock = new FakeClock()
  const ha = new FakeCync(clock, ids)
  const logs: string[] = []
  const engine = createLightEngine({ ha, clock, lights: Object.keys(ids), refresh: opts.refresh ?? false, log: (m) => { logs.push(m) } })
  const row = async (id: string) => (await engine.lights()).find((r) => r.entity_id === id)!
  const send = (id: string, p: Patch) => engine.submit(id, p)
  /** submit and run the clock until HA has accepted it (or refused it) */
  const sendNow = async (id: string, p: Patch) => {
    let settled = false
    const pr = engine.submit(id, p)
    pr.then(() => { settled = true }, () => { settled = true })
    for (let i = 0; i < 200 && !settled; i++) await clock.advance(10)
    return pr
  }
  return { clock, ha, engine, logs, row, send, sendNow }
}

const pct = (p: number): Patch => ({ state: 'on', pct: p })

// ---------- tests ----------

test('every percent lands exactly through HA\'s Cync scaling and reads back the same', () => {
  for (let p = 1; p <= 100; p++) {
    const sent = haBrightnessFor(p)
    const level = Math.trunc((sent / 255) * 100)
    assert.equal(level, p, `pct ${p}: HA would send level ${level}`)
    const reported = Math.min(255, Math.max(1, Math.round(((level + 1) * 255) / 101)))
    assert.equal(pctFromHa(reported), p, `pct ${p}: reads back ${pctFromHa(reported)}`)
    assert.equal(pctFromApi(apiBrightness(p)), p)
    // and the frontend's own conversion of the API figure
    assert.equal(Math.round((apiBrightness(p) / 255) * 100), p)
  }
})

test('rapid changes to one bulb: one send in flight, the newest target wins, nothing older lands last', async () => {
  const { clock, ha, engine, send, sendNow } = rig({ 'light.a': {} })
  await engine.lights()
  const done = [send('light.a', pct(50)), send('light.a', pct(80)), send('light.a', pct(30)), send('light.a', { state: 'on', color: { rgb: BLUE } })]
  await clock.advance(5_000)
  await Promise.all(done)
  const calls = ha.callsFor('light.a')
  assert.equal(calls.length, 2, `sent ${calls.length} commands: ${JSON.stringify(calls.map((c) => c.body))}`)
  assert.equal(calls[0].body.brightness, haBrightnessFor(50))
  assert.deepEqual(calls[1].body, { entity_id: 'light.a', brightness: haBrightnessFor(30), rgb_color: BLUE })
  assert.ok(calls[1].at - calls[0].at >= 350, 'the second send went out inside the minimum gap')
  const phys = ha.bulbs.get('light.a')!.phys
  assert.deepEqual([phys.level, phys.mode, phys.rgb], [30, 'rgb', BLUE])
  engine.stop()
})

test('the office lamp bug: a brightness change carries the color just picked, so HA cannot fill in its stale red', async () => {
  // the lamp never pushes; HA believes it is red
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.office': { pushMs: null, dev: { mode: 'rgb', rgb: RED, level: 43 } } })
  await engine.lights()
  await sendNow('light.office', { state: 'on', color: { rgb: AMBER } })
  await clock.advance(2_000)
  await sendNow('light.office', pct(100))
  await clock.advance(2_000)
  const last = ha.callsFor('light.office').at(-1)!
  assert.deepEqual(last.body.rgb_color, AMBER, `brightness change sent ${JSON.stringify(last.body)}`)
  assert.equal(last.body.brightness, haBrightnessFor(100))
  const phys = ha.bulbs.get('light.office')!.phys
  assert.deepEqual([phys.level, phys.rgb], [100, AMBER], 'the lamp did not end at amber 100%')
  // HA still says red at 43%; the row shows the target until the lamp reports
  const r = await row('light.office')
  assert.equal(r.pending, true)
  assert.deepEqual(r.rgb_color, AMBER)
  assert.equal(r.brightness, apiBrightness(100))
  engine.stop()
})

test('control: the same two calls without completion do turn the lamp red (what HA does on its own)', async () => {
  const clock = new FakeClock()
  const ha = new FakeCync(clock, { 'light.office': { pushMs: null, dev: { mode: 'rgb', rgb: RED, level: 43 } } })
  void ha.call('turn_on', { entity_id: 'light.office', rgb_color: AMBER })
  await clock.advance(2_000)
  void ha.call('turn_on', { entity_id: 'light.office', brightness: 255 })
  await clock.advance(2_000)
  assert.deepEqual(ha.bulbs.get('light.office')!.phys.rgb, RED)
})

test('a preset keeps the brightness that was just set, not the stale one HA still reports', async () => {
  const { clock, ha, engine, send, sendNow } = rig({ 'light.office': { pushMs: null, dev: { level: 43 } } })
  await engine.lights()
  await sendNow('light.office', pct(100))
  await clock.advance(1_500)
  await sendNow('light.office', { state: 'on', color: { kelvin: 2200 } })
  await clock.advance(1_500)
  const last = ha.callsFor('light.office').at(-1)!
  assert.deepEqual(last.body, { entity_id: 'light.office', brightness: haBrightnessFor(100), color_temp_kelvin: 2200 })
  engine.stop()
})

test('held until the bulb reports it: no resend off stale reads, then the exact target', async () => {
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.office': { pushMs: null, dev: { level: 43 } }, 'light.b': {} })
  await engine.lights()
  await sendNow('light.office', { state: 'on', pct: 57, color: { kelvin: 6500 } })
  for (let s = 0; s < 25; s++) {
    await clock.advance(1_000)
    const r = await row('light.office')
    assert.equal(r.pending, true, `released at ${s + 1}s while HA was still stale`)
    assert.equal(r.brightness, apiBrightness(57))
    assert.equal(r.color_temp_kelvin, 6500)
  }
  assert.equal(ha.callsFor('light.office').length, 1, 'resent off a stale read')
  await clock.advance(10_000) // HA's 30 s poll lands
  const r = await row('light.office')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 57, 'not exactly 57%')
  assert.equal(r.color_temp_kelvin, 6500)
  assert.equal(r.color_mode, 'color_temp')
  assert.equal(ha.callsFor('light.office').length, 1)
  engine.stop()
})

test('asking HA to poll pulls the lagging lamp in seconds instead of 30', async () => {
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.office': { pushMs: null } }, { refresh: true })
  await engine.lights()
  await sendNow('light.office', pct(20))
  await clock.advance(4_500)
  assert.equal(ha.refreshes.length, 1, `asked HA to poll ${ha.refreshes.length} times`)
  assert.deepEqual(ha.refreshes[0].entities, ['light.office'])
  assert.equal((await row('light.office')).pending, false, 'not confirmed after the poll')
  assert.equal(ha.callsFor('light.office').length, 1)
  engine.stop()
})

test('a report with no brightness mid-transition neither confirms nor causes a resend', async () => {
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.a': { pushMs: 400 } })
  await engine.lights()
  ha.bulbs.get('light.a')!.nullBrightnessOnce = true
  await sendNow('light.a', pct(70))
  await clock.advance(800)
  // the push came with brightness null
  let r = await row('light.a')
  assert.equal(r.pending, true)
  assert.equal(r.brightness, apiBrightness(70), 'the row showed the null instead of the target')
  await clock.advance(5_000)
  r = await row('light.a')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 70)
  assert.equal(ha.callsFor('light.a').length, 1)
  engine.stop()
})

test('a bulb that settles elsewhere gets exactly one resend, then its own word', async () => {
  const { clock, ha, engine, send, sendNow, row, logs } = rig({ 'light.a': { mangle: (d) => ({ ...d, level: 12 }) } })
  await engine.lights()
  await sendNow('light.a', pct(80))
  await clock.advance(12_000)
  assert.equal(ha.callsFor('light.a').length, 2, `sent ${ha.callsFor('light.a').length} times`)
  const r = await row('light.a')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 12, 'did not fall back to what the bulb reports')
  assert.ok(logs.some((l) => /sending once more/.test(l)) && logs.some((l) => /settled elsewhere twice/.test(l)))
  engine.stop()
})

test('a dropped command is caught by the poll Valkyrie asks for and sent once more', async () => {
  let drops = 1
  const { clock, ha, engine, sendNow, row } = rig({ 'light.a': { dev: { level: 43 }, mangle: (d) => (drops-- > 0 ? { ...d, level: 43 } : d) } }, { refresh: true })
  await engine.lights()
  await sendNow('light.a', pct(75))
  await clock.advance(8_000)
  assert.equal(ha.refreshes.length >= 1, true, 'never asked HA to poll')
  assert.equal(ha.callsFor('light.a').length, 2, `sent ${ha.callsFor('light.a').length} times`)
  await clock.advance(3_000)
  const r = await row('light.a')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 75)
  engine.stop()
})

test('an older command report arriving after a newer send is not taken for the answer', async () => {
  const { clock, ha, engine, send, row, logs } = rig({ 'light.a': { pushMs: 1_500 } })
  await engine.lights()
  void send('light.a', pct(30))
  await clock.advance(1_000)
  void send('light.a', pct(80))
  await clock.advance(1_000) // the 30% push lands now, after the 80% went out
  let r = await row('light.a')
  assert.equal(r.pending, true)
  assert.equal(r.brightness, apiBrightness(80), 'the row jumped back to the older value')
  await clock.advance(2_000)
  r = await row('light.a')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 80)
  assert.equal(ha.callsFor('light.a').length, 2, 'resent because of the older report')
  assert.ok(!logs.length, `logged: ${logs.join('; ')}`)
  engine.stop()
})

test('a late report of an older value right after confirming gets the target sent once more', async () => {
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.a': {} })
  await engine.lights()
  await sendNow('light.a', pct(60))
  await clock.advance(2_500)
  assert.equal((await row('light.a')).pending, false)
  ha.injectReport('light.a', { level: 25 }) // an older command's echo
  await clock.advance(1_200)
  assert.equal(ha.callsFor('light.a').length, 2)
  assert.equal(ha.callsFor('light.a')[1].body.brightness, haBrightnessFor(60))
  await clock.advance(3_000)
  const r = await row('light.a')
  assert.equal(Math.round((r.brightness! / 255) * 100), 60)
  // after the window, a change made elsewhere (the Cync app) is believed, not fought
  await clock.advance(20_000)
  ha.bulbs.get('light.a')!.phys.level = 33
  ha.injectReport('light.a', { level: 33 })
  await clock.advance(3_000)
  assert.equal(ha.callsFor('light.a').length, 2, 'fought a change made outside Valkyrie')
  assert.equal(Math.round(((await row('light.a')).brightness! / 255) * 100), 33)
  engine.stop()
})

test('a preset to several bulbs keeps each at its own level', async () => {
  const { clock, ha, engine, send, sendNow } = rig({ 'light.a': { dev: { level: 20 } }, 'light.b': { dev: { level: 90 } } })
  await engine.lights()
  const both = Promise.all(['light.a', 'light.b'].map((id) => send(id, { state: 'on', color: { rgb: AMBER } })))
  await clock.advance(1_000)
  await both
  assert.equal(ha.callsFor('light.a')[0].body.brightness, haBrightnessFor(20))
  assert.equal(ha.callsFor('light.b')[0].body.brightness, haBrightnessFor(90))
  engine.stop()
})

test('quick off then on brings back the level and color that were set', async () => {
  const { clock, ha, engine, send, sendNow } = rig({ 'light.a': {} })
  await engine.lights()
  await sendNow('light.a', { state: 'on', pct: 64, color: { rgb: BLUE } })
  await clock.advance(3_000)
  const off = send('light.a', { state: 'off' })
  const on = send('light.a', { state: 'on' })
  await clock.advance(3_000)
  await Promise.all([off, on])
  const last = ha.callsFor('light.a').at(-1)!
  assert.deepEqual(last.body, { entity_id: 'light.a', brightness: haBrightnessFor(64), rgb_color: BLUE })
  const phys = ha.bulbs.get('light.a')!.phys
  assert.deepEqual([phys.on, phys.level, phys.rgb], [true, 64, BLUE])
  engine.stop()
})

test('a failed send rejects its caller and the row falls back to the bulb', async () => {
  const { clock, ha, engine, send, sendNow, row } = rig({ 'light.a': { dev: { level: 43 } } })
  await engine.lights()
  ha.failNext = true
  await assert.rejects(send('light.a', pct(90)), /500/)
  await clock.advance(1_000)
  const r = await row('light.a')
  assert.equal(r.pending, false)
  assert.equal(Math.round((r.brightness! / 255) * 100), 43)
  engine.stop()
})

test('commands from two clients interleaved per bulb never put an older target last', async () => {
  const { clock, ha, engine, send, sendNow } = rig({ 'light.a': { pushMs: 2_500 }, 'light.b': { pushMs: 2_500 } })
  await engine.lights()
  const seq: Promise<void>[] = []
  for (let i = 0; i < 10; i++) {
    seq.push(send('light.a', pct(10 + i * 9)))
    seq.push(send('light.b', { state: 'on', color: { kelvin: 2200 + i * 400 } }))
    await clock.advance(120)
  }
  await clock.advance(20_000)
  await Promise.all(seq)
  const a = ha.callsFor('light.a').at(-1)!
  const b = ha.callsFor('light.b').at(-1)!
  assert.equal(a.body.brightness, haBrightnessFor(91))
  assert.equal(b.body.color_temp_kelvin, 5800)
  for (const id of ['light.a', 'light.b']) {
    const ts = ha.callsFor(id).map((c) => c.at)
    assert.ok(ts.every((x, i) => i === 0 || x - ts[i - 1] >= 350), `${id} sends closer than the gap: ${ts}`)
  }
  assert.ok(ha.callsFor('light.a').length < 10, `light.a got ${ha.callsFor('light.a').length} sends for 10 changes`)
  engine.stop()
})
