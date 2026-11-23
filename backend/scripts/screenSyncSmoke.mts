// Screen sync pacing against a fake light engine: who joins, how often a bulb
// gets a command, what the end puts back (sections 1-8, with the glide off so
// each command is the newest frame), and how the bulbs glide from one scene to
// the next (9-13, real tuning). Run: node --import tsx scripts/screenSyncSmoke.mts
import assert from 'node:assert/strict'
import { createScreenSync, SCREEN_TUNING } from '../src/routes/screenSync.ts'
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
}, { colorTauMs: 0, levelTauMs: 0 })

const blue = { rgb: [0, 64, 255] as [number, number, number], sat: 0.4, level: 0.4 }

// 1. The first frame starts the session with the bulbs that were on. The hub
//    takes one command at a time, so the second bulb gets its command one hub gap later.
await sync.frame(blue)
assert.deepEqual(sync.status().bulbs, ['light.office_lamp', 'light.tv_strip'])
assert.equal(sent.length, 1)
const lamp = sent[0].p
assert.equal(sent[0].id, 'light.office_lamp')
assert.deepEqual(lamp.color, { rgb: [0, 64, 255] })
// ceiling is its own 50%: 50 * (0.3 + 0.7 * 0.64) = 37.4
assert.equal(lamp.pct, 37)
clock += 200; await sync.frame(blue)
assert.equal(sent.length, 1, 'inside the hub gap')
clock += 300; await sync.frame(blue)
assert.equal(sent.length, 2)
assert.equal(sent[1].id, 'light.tv_strip')

// 2. A big change waits for the hub gap, then goes out one bulb at a time,
//    never inside a bulb's own gap, each with the newest frame.
clock += 100; await sync.frame({ ...blue, rgb: [255, 0, 0] })
assert.equal(sent.length, 2, 'hub still busy')
clock += 350; await sync.frame({ ...blue, rgb: [255, 0, 0] })
assert.equal(sent.length, 3)
assert.equal(sent[2].id, 'light.office_lamp', 'the strip is inside its own 600 ms gap')
clock += 450; await sync.frame({ ...blue, rgb: [255, 0, 40] })
assert.equal(sent.length, 4)
assert.deepEqual(sent[3], { id: 'light.tv_strip', p: { state: 'on', pct: 75, color: { rgb: [255, 0, 40] } }, at: clock })

// 3. A small change waits for the settle time, then lands once per bulb.
clock += 1_200; await sync.frame({ ...blue, rgb: [255, 10, 20] })
assert.equal(sent.length, 4)
clock += 2_000; await sync.frame({ ...blue, rgb: [255, 10, 20] })
assert.equal(sent.length, 5)
clock += 450; await sync.frame({ ...blue, rgb: [255, 10, 20] })
assert.equal(sent.length, 6)
clock += 3_500; await sync.frame({ ...blue, rgb: [255, 10, 20] })
assert.equal(sent.length, 6, 'an unchanged screen sends nothing more')

// 4. The bulb furthest from the screen goes first.
clock += 1_000; await sync.frame({ ...blue, rgb: [255, 10, 20], level: 0.9 })
assert.equal(sent.length, 7)
assert.equal(sent[6].id, 'light.tv_strip', 'the strip has the higher ceiling, so the bigger brightness step')
clock += 450; await sync.frame({ ...blue, rgb: [255, 10, 20], level: 0.9 })
assert.equal(sent.length, 8)

// 5. A neutral screen shows the bulb's own white: the lamp was 2700 K, the strip gets 4000 K.
clock += 1_100; await sync.frame({ rgb: [255, 255, 250], sat: 0.02, level: 0.5 })
clock += 450; await sync.frame({ rgb: [255, 255, 250], sat: 0.02, level: 0.5 })
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

// ---- the glide, with the real tuning ----------------------------------------

const rgbOf = (p: Patch) => (p.color && 'rgb' in p.color ? p.color.rgb : null)
const strip = (from: number) => sent.slice(from).filter((s) => s.id === 'light.tv_strip').map((s) => s.p)
/** thor posts ten frames a second while its screen moves */
async function hold(g: ReturnType<typeof createScreenSync>, f: typeof blue, ms: number) {
  for (let i = 0; i < ms / 100; i++) { clock += 100; await g.frame(f) }
}

const glideRows = [
  row('light.office_lamp', true),
  row('light.tv_strip', true, { color_mode: 'rgb', rgb_color: [255, 0, 0], color_temp_kelvin: null, brightness: 255 }),
]
const glide = createScreenSync({
  rows: async () => glideRows,
  submit: async (id, p) => { sent.push({ id, p, at: clock }) },
  now: () => clock,
  log: () => {},
})
const red = { rgb: [255, 0, 0] as [number, number, number], sat: 0.4, level: 0.4 }
sent.length = 0
clock += 60_000
await glide.frame(blue)
await hold(glide, blue, 3_000)
assert.deepEqual(rgbOf(strip(0).at(-1)!), [0, 64, 255], 'the session starts on the screen as it is')

// 9. A cut from blue to red fades: nothing at the cut itself, then steps that
//    each move further toward red, the first still nearer blue.
let mark = sent.length
const cutAt = clock
await glide.frame(red)
assert.equal(sent.length, mark, 'no time has passed, so the bulbs have not moved yet')
await hold(glide, red, 10_000)
const steps = strip(mark).map((p) => rgbOf(p)!)
assert.ok(steps.length >= 3, `the strip fades in steps, got ${JSON.stringify(steps)}`)
assert.ok(steps[0][0] < 128 && steps[0][2] === 255, `the first step is still mostly blue: ${steps[0]}`)
for (let i = 1; i < steps.length; i++) {
  assert.ok(steps[i][0] >= steps[i - 1][0] && steps[i][2] <= steps[i - 1][2], `each step moves toward red: ${JSON.stringify(steps)}`)
}
assert.ok(Math.max(...steps.at(-1)!.map((v, i) => Math.abs(v - red.rgb[i]))) <= 4, `the strip ends on red: ${steps.at(-1)}`)

// 10. Quick enough to follow: the strip is within two command steps of red
//     3 tau (4.5 s) after the cut, with the hub serving two bulbs in turn. The
//     faint rest lands on the settle rule.
const lateAt = sent.slice(mark).find((s) => s.id === 'light.tv_strip' && rgbOf(s.p)![2] <= 2 * SCREEN_TUNING.rgbStep)?.at
assert.ok(lateAt != null && lateAt - cutAt <= 3 * SCREEN_TUNING.colorTauMs, `the strip is near red within 3 tau (${lateAt == null ? 'never' : lateAt - cutAt} ms)`)

// 11. Brightness glides too: 0.4 to 0.9 takes the strip from 75% toward 100% in steps.
mark = sent.length
await hold(glide, { ...red, level: 0.9 }, 6_000)
const pcts = strip(mark).map((p) => p.pct!)
assert.ok(pcts.length >= 2 && pcts[0] > 75 && pcts[0] < 100 && pcts.at(-1) === 100, `brightness steps up: ${pcts}`)

// 12. A flash (one white frame) barely moves the bulbs.
mark = sent.length
await hold(glide, { rgb: [255, 255, 255], sat: 0.02, level: 1 }, 100)
await hold(glide, { ...red, level: 0.9 }, 4_000)
const flashed = sent.slice(mark).map((s) => rgbOf(s.p))
assert.ok(flashed.every((c) => c && c[1] <= 22 && c[2] <= 22), `a flash stays off the bulbs: ${JSON.stringify(flashed)}`)

// 13. With no frames at all (thor posts only every 2 s while its screen holds),
//     the session keeps stepping the glide on its own timer.
await glide.frame(blue)
mark = sent.length
clock += 700
await new Promise((r) => setTimeout(r, 600))
const solo = sent.slice(mark).map((s) => rgbOf(s.p)!)
assert.ok(solo.length >= 1 && solo[0][2] > 22 && solo[0][2] < 255, `a step goes out between frames: ${JSON.stringify(solo)}`)
assert.ok(glide.status().shown != null)
glide.dispose()

// 14. The pace is by time, not by how often frames come: ten a second or one
//     after 2 s land on the same color.
async function after(stepMs: number) {
  const g = createScreenSync({ rows: async () => glideRows, submit: async () => {}, now: () => clock, log: () => {} })
  await g.frame(blue)
  clock += 100; await g.frame(red)
  for (let ms = 0; ms < 2_000; ms += stepMs) { clock += stepMs; await g.frame(red) }
  const shown = g.status().shown!.rgb
  g.dispose()
  return shown
}
const fine = await after(100)
const coarse = await after(2_000)
assert.ok(Math.max(...fine.map((v, i) => Math.abs(v - coarse[i]))) <= 1, `same glide at any frame rate: ${fine} vs ${coarse}`)
console.log('screenSyncSmoke: ok')
