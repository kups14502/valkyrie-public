// Unit tests for src/lib/lights.ts: the client send queue (one POST in flight,
// newest per bulb wins, a lone update goes exactly as asked) and the desire
// rules (merge, satisfied, overlay). Bundles the module with rolldown so it runs
// in plain node; nothing here touches a backend or a bulb.
//
//   node e2e/lights-unit.mjs        (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rolldown } from 'rolldown'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const bundle = await rolldown({
  input: resolve(HERE, '../src/lib/lights.ts'),
  platform: 'node',
  logLevel: 'silent',
  transform: { define: { 'import.meta.env': '{}' } },
})
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const dir = mkdtempSync(join(tmpdir(), 'lights-unit-'))
const file = join(dir, 'lights.mjs')
writeFileSync(file, output[0].code)
const L = await import(pathToFileURL(file).href)
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const tick = () => new Promise((r) => setTimeout(r, 0))

/** a fake POST /lights/turn: records order and overlap, answers when the test says */
function fakeBackend() {
  const sent = []
  let inflight = 0
  let maxInflight = 0
  const gates = []
  const send = (u) => {
    inflight += 1
    maxInflight = Math.max(maxInflight, inflight)
    sent.push(structuredClone(u))
    return new Promise((res, rej) => gates.push({ u, ok: () => { inflight -= 1; res({ ok: true }) }, fail: (e) => { inflight -= 1; rej(e) } }))
  }
  return { send, sent, gates, get maxInflight() { return maxInflight } }
}

test('one POST in flight; what waits goes as the fewest POSTs, newest per bulb winning', async () => {
  const be = fakeBackend()
  const q = L.createSendQueue(be.send)
  const p1 = q({ entity_id: ['light.a', 'light.b'], state: 'on', brightness: 128 })
  const p2 = q({ entity_id: 'light.a', state: 'on', rgb_color: [255, 0, 0] })
  const p3 = q({ entity_id: 'light.a', state: 'on', brightness: 51 })
  const p4 = q({ entity_id: 'light.b', state: 'on', brightness: 51, rgb_color: [255, 0, 0] })
  await tick()
  assert.equal(be.sent.length, 1, 'more than one POST went out at once')
  assert.deepEqual(be.sent[0], { entity_id: ['light.a', 'light.b'], state: 'on', brightness: 128 })
  be.gates[0].ok()
  await tick()
  assert.equal(be.sent.length, 2, `sent ${JSON.stringify(be.sent)}`)
  assert.deepEqual(be.sent[1], { entity_id: ['light.a', 'light.b'], state: 'on', brightness: 51, rgb_color: [255, 0, 0] })
  be.gates[1].ok()
  await Promise.all([p1, p2, p3, p4])
  assert.equal(be.maxInflight, 1)
})

test('a lone waiting update goes exactly as asked (a one-bulb array stays an array)', async () => {
  const be = fakeBackend()
  const q = L.createSendQueue(be.send)
  q({ entity_id: 'light.a', state: 'off' })
  q({ entity_id: ['light.a'], state: 'on', rgb_color: [255, 32, 128] })
  await tick()
  be.gates[0].ok()
  await tick()
  assert.deepEqual(be.sent[1], { entity_id: ['light.a'], state: 'on', rgb_color: [255, 32, 128] })
})

test('on, off, on while a POST is out ends on, never a stray off last', async () => {
  const be = fakeBackend()
  const q = L.createSendQueue(be.send)
  q({ entity_id: 'light.a', state: 'on', brightness: 200 })
  q({ entity_id: 'light.a', state: 'off' })
  q({ entity_id: 'light.a', state: 'on' })
  await tick()
  be.gates[0].ok()
  await tick()
  assert.equal(be.sent.length, 2)
  assert.equal(be.sent.at(-1).state, 'on')
  be.gates[1].ok()
})

test('a failed POST rejects only the updates it carried', async () => {
  const be = fakeBackend()
  const q = L.createSendQueue(be.send)
  const first = q({ entity_id: 'light.a', state: 'on' })
  const a = q({ entity_id: 'light.a', state: 'on', brightness: 10 })
  const b = q({ entity_id: 'light.b', state: 'on', brightness: 99 })
  await tick()
  be.gates[0].ok()
  await first
  await tick()
  assert.equal(be.sent.length, 2, 'light.a and light.b have different patches: the first of two POSTs')
  be.gates[1].fail(new Error('403'))
  await tick()
  be.gates[2].ok()
  await assert.rejects(a, /403/)
  await b
})

test('rapid taps from a page, answered in random time: the bulb ends where the last tap put it', async () => {
  const state = {}
  const q = L.createSendQueue(async (u) => {
    await new Promise((r) => setTimeout(r, Math.random() * 15))
    for (const id of Array.isArray(u.entity_id) ? u.entity_id : [u.entity_id]) {
      state[id] = u.state === 'off' ? { ...(state[id] ?? {}), on: false } : { ...state[id], on: true, ...(u.brightness ? { b: u.brightness } : {}), ...(u.rgb_color ? { rgb: u.rgb_color, k: undefined } : {}), ...(u.color_temp_kelvin ? { k: u.color_temp_kelvin, rgb: undefined } : {}) }
    }
    return { ok: true }
  })
  const asks = []
  let last
  for (let i = 0; i < 40; i++) {
    const r = Math.random()
    const u = r < 0.3 ? { entity_id: 'light.a', state: 'on', brightness: 1 + Math.floor(Math.random() * 254) }
      : r < 0.6 ? { entity_id: ['light.a', 'light.b'], state: 'on', color_temp_kelvin: 2200 + Math.floor(Math.random() * 4300) }
      : r < 0.85 ? { entity_id: 'light.a', state: 'on', rgb_color: [255, Math.floor(Math.random() * 255), 0] }
      : { entity_id: 'light.a', state: Math.random() < 0.5 ? 'off' : 'on' }
    asks.push(q(u))
    last = u
    if (Math.random() < 0.3) await new Promise((r) => setTimeout(r, Math.random() * 10))
  }
  await Promise.all(asks)
  if (last.state === 'off') assert.equal(state['light.a'].on, false)
  else {
    assert.equal(state['light.a'].on, true)
    if (last.brightness) assert.equal(state['light.a'].b, last.brightness)
    if (last.rgb_color) assert.deepEqual(state['light.a'].rgb, last.rgb_color)
    if (last.color_temp_kelvin) assert.equal(state['light.a'].k, last.color_temp_kelvin)
  }
})

test('mergePatch: a brightness then a color hold both; rgb and kelvin replace each other; off wins', () => {
  assert.deepEqual(L.mergePatch({ state: 'on', brightness: 50 }, { state: 'on', rgb_color: [1, 2, 3] }), { state: 'on', brightness: 50, rgb_color: [1, 2, 3] })
  assert.deepEqual(L.mergePatch({ state: 'on', rgb_color: [1, 2, 3] }, { state: 'on', color_temp_kelvin: 2200 }), { state: 'on', color_temp_kelvin: 2200 })
  assert.deepEqual(L.mergePatch({ state: 'on', color_temp_kelvin: 2200, brightness: 9 }, { state: 'on', brightness: 200 }), { state: 'on', brightness: 200, color_temp_kelvin: 2200 })
  assert.deepEqual(L.mergePatch({ state: 'on', brightness: 50 }, { state: 'off' }), { state: 'off' })
  assert.deepEqual(L.mergePatch({ state: 'off' }, { state: 'on' }), { state: 'on' })
  assert.deepEqual(L.mergePatch(undefined, { state: 'on', brightness: 3 }), { state: 'on', brightness: 3 })
})

test('satisfied: a bulb reporting no brightness mid-switch is not there yet; quantized values are', () => {
  const row = { entity_id: 'light.a', name: 'A', on: true, unavailable: false, brightness: null, rgb_color: [255, 0, 0], color_temp_kelvin: null, color_mode: 'rgb', supported_color_modes: [], min_kelvin: null, max_kelvin: null }
  assert.equal(L.satisfied(row, { state: 'on', brightness: 128 }), false)
  assert.equal(L.satisfied({ ...row, brightness: 130 }, { state: 'on', brightness: 128 }), true)
  assert.equal(L.satisfied({ ...row, brightness: 128, color_mode: 'color_temp', color_temp_kelvin: 2199, rgb_color: null }, { state: 'on', color_temp_kelvin: 2200 }), true)
  assert.equal(L.satisfied({ ...row, on: false }, { state: 'off' }), true)
})

test('overlay: a kelvin pick blanks the old rgb so the dot never shows the color it left', () => {
  const row = { entity_id: 'light.a', name: 'A', on: true, unavailable: false, brightness: 100, rgb_color: [255, 0, 0], color_temp_kelvin: null, color_mode: 'rgb', supported_color_modes: [], min_kelvin: null, max_kelvin: null }
  const o = L.overlay(row, { state: 'on', color_temp_kelvin: 2200 })
  assert.deepEqual([o.rgb_color, o.color_temp_kelvin, o.color_mode, o.brightness], [null, 2200, 'color_temp', 100])
})
