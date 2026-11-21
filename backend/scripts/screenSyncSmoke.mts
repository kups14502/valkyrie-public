// Screen sync pacing against a fake light engine: who joins, how often a bulb
// gets a command, and what the end puts back. Run: node --import tsx scripts/screenSyncSmoke.mts
import assert from 'node:assert/strict'
import { createScreenSync } from '../src/routes/screenSync.ts'
import type { LightRow, Patch } from '../src/routes/lights.ts'

const row = (id: string, on: boolean, extra: Partial<LightRow> = {}): LightRow => ({
  entity_id: id, name: id, on, unavailable: false, brightness: on ? 128 : null,
  rgb_color: null, color_temp_kelvin: on ? 2700 : null, color_mode: on ? 'color_temp' : null,
  supported_color_modes: ['color_temp', 'rgb'], min_kelvin: 2000, max_kelvin: 6500, pending: false, ...extra,
})

let clock = 0
const sent: { id: string; p: Patch; at: number }[] = []
const rows = [
  row('light.office_lamp', true),
  row('light.tv_strip', true, { color_mode: 'rgb', rgb_color: [255, 0, 0], color_temp_kelvin: null, brightness: 255 }),
  row('light.kitche_light', false),
  row('light.dresser', false, { unavailable: true }),
]
const sync = createScreenSync({
  rows: async () => rows,
  submit: async (id, p) => { sent.push({ id, p, at: clock }) },
  now: () => clock,
  log: () => {},
})

const blue = { rgb: [0, 64, 255] as [number, number, number], sat: 0.4, level: 0.4 }

// 1. The first frame starts the session with the bulbs that were on, and each gets a command.
await sync.frame(blue)
assert.deepEqual(sync.status().bulbs, ['light.office_lamp', 'light.tv_strip'])
assert.equal(sent.length, 2)
const lamp = sent.find((s) => s.id === 'light.office_lamp')!.p
assert.deepEqual(lamp.color, { rgb: [0, 64, 255] })
// ceiling is its own 50%: 50 * (0.3 + 0.7 * 0.64) = 37.4
assert.equal(lamp.pct, 37)

// 2. Frames inside the 1 s gap send nothing, even for a big change.
clock += 250; await sync.frame({ ...blue, rgb: [255, 0, 0] })
clock += 250; await sync.frame({ ...blue, rgb: [255, 0, 0] })
assert.equal(sent.length, 2)

// 3. After the gap, the big change goes out.
clock += 600; await sync.frame({ ...blue, rgb: [255, 0, 0] })
assert.equal(sent.length, 4)

// 4. A small change waits for the settle time, then lands once.
clock += 1_200; await sync.frame({ ...blue, rgb: [255, 10, 0] })
assert.equal(sent.length, 4)
clock += 2_000; await sync.frame({ ...blue, rgb: [255, 10, 0] })
assert.equal(sent.length, 6)
clock += 3_500; await sync.frame({ ...blue, rgb: [255, 10, 0] })
assert.equal(sent.length, 6, 'an unchanged screen sends nothing more')

// 5. A neutral screen shows the bulb's own white: the lamp was 2700 K, the strip gets 4000 K.
clock += 1_100; await sync.frame({ rgb: [255, 255, 250], sat: 0.02, level: 0.5 })
const last = (id: string) => [...sent].reverse().find((s) => s.id === id)!.p
assert.deepEqual(last('light.office_lamp').color, { kelvin: 2700 })
assert.deepEqual(last('light.tv_strip').color, { kelvin: 4000 })

// 6. A bulb changed by hand leaves the session.
sync.release(['light.tv_strip'])
assert.deepEqual(sync.status().bulbs, ['light.office_lamp'])

// 7. Stop puts the remaining bulb back exactly, and the strip is left alone.
const before = sent.length
await sync.stop('test')
const back = sent.slice(before)
assert.equal(back.length, 1)
assert.deepEqual(back[0], { id: 'light.office_lamp', p: { state: 'on', pct: 50, color: { kelvin: 2700 } }, at: clock })
assert.equal(sync.status().active, false)

// 8. With every bulb off, every available bulb joins and goes off again at the end.
for (const r of rows) { r.on = false; r.brightness = null; r.color_mode = null }
sent.length = 0
clock += 5_000; await sync.frame(blue)
assert.deepEqual(sync.status().bulbs, ['light.office_lamp', 'light.tv_strip', 'light.kitche_light'])
assert.equal(sent[0].p.pct, Math.round(80 * (0.3 + 0.7 * 0.64)))
sent.length = 0
await sync.stop('test')
assert.ok(sent.every((s) => s.p.state === 'off') && sent.length === 3)

sync.dispose()
console.log('screenSyncSmoke: ok')
