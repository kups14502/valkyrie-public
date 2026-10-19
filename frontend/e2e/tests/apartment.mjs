// APARTMENT: the apartment model (src/v2/kit/three/models/apartment.ts) on the
// Lights tab and in the Dashboard's Lights box, over a fake Home Assistant
// that reports the five bulbs the model knows by their entity ids.
//
//   lights:apartment   the Lights tab draws the apartment with a diamond per
//                      bulb: every bulb's hotspot sits on its own fixture (the
//                      lines in its bulb.<id> group), projects inside the box,
//                      and its diamond is within a few px of that point with
//                      wireframe under it; a lit bulb glows there in its own
//                      color and an off one does not. Tapping each diamond
//                      selects that bulb (the panel's header names it, its row
//                      is marked), a second tap lets go, and nothing is sent.
//   dash:apartment     the Dashboard's Lights box (three columns) draws the
//                      same apartment with no diamonds: all five hotspots sit
//                      on their fixtures and project inside the box, below its
//                      cap, each fixture drawn within a few px of its point,
//                      and the lit bulbs glow there in their colors.
//
// Both read the scene's engine, which WireScene hangs on its element in dev
// builds only (the probe is one). Every write is answered in the browser and
// any write fails the test.

import { sleep } from '../lib/cdp.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })

/** The five bulbs the model places, by entity id: two lit in colors, one lit at an unknown level, two off. */
function bulbs() {
  const b = (entity_id, name, on, extra = {}) => ({
    entity_id, name, on, unavailable: false, brightness: on ? 255 : null, rgb_color: on ? [255, 217, 160] : null,
    color_temp_kelvin: null, color_mode: on ? 'rgb' : null, supported_color_modes: ['rgb', 'color_temp'], min_kelvin: 2000, max_kelvin: 6500,
    ...extra,
  })
  return [
    b('light.office_lamp', 'Desk Lamp', true, { rgb_color: [255, 32, 32] }),
    b('light.tv_strip', 'TV Strip', true, { rgb_color: [40, 80, 255], brightness: 128 }),
    b('light.kitche_light', 'Kitchen', false),
    b('light.nightsand', 'Table Lamp', true, { rgb_color: [60, 255, 90], brightness: null }),
    b('light.dresser', 'Bedroom', false),
  ]
}
const IDS = bulbs().map((l) => l.entity_id)

function fakeLights(page) {
  const st = bulbs()
  page.mock('/api/lights', () => ok(st))
  return st
}

/**
 * The apartment scene at `sel`: each hotspot, the fixture lines of its bulb
 * group (model-space box and on-screen box), where it projects through the
 * live camera (mapped by the renderer's own size onto the canvas's box), its
 * diamond if the scene draws them, the nearest drawn ink, and the light the
 * renderer draws for it.
 */
function apartmentReport(sel) {
  const scene = document.querySelector(sel)
  if (!scene) return { error: `no model scene at ${sel}` }
  const e = scene.__wire
  if (!e) return { error: 'the scene has no engine handle (__wire): not a dev build?' }
  const c = e.r.model
  const rect = scene.getBoundingClientRect()
  const kx = rect.width / e.r.w
  const ky = rect.height / e.r.h
  const out = [0, 0, 0]
  const groups = {}
  for (let i = 0; i < c.n; i++) {
    const st = c.styles[c.style[i]]
    if (!st.group || !st.group.startsWith('bulb.')) continue
    const g = groups[st.group] ??= { segs: 0, layer: st.layer, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], s: [Infinity, Infinity, -Infinity, -Infinity] }
    g.segs++
    for (const k of [0, 3]) {
      const p = [c.pos[i * 6 + k], c.pos[i * 6 + k + 1], c.pos[i * 6 + k + 2]]
      for (let a = 0; a < 3; a++) { g.lo[a] = Math.min(g.lo[a], p[a]); g.hi[a] = Math.max(g.hi[a], p[a]) }
      if (e.cam.project(p[0], p[1], p[2], out)) {
        g.s = [Math.min(g.s[0], out[0]), Math.min(g.s[1], out[1]), Math.max(g.s[2], out[0]), Math.max(g.s[3], out[1])]
      }
    }
  }
  const sharp = scene.querySelectorAll('canvas')[1]
  let data = null
  try { data = sharp.getContext('2d').getImageData(0, 0, sharp.width, sharp.height).data } catch { /* no pixels */ }
  const dpr = e.r.dpr
  const inkNear = (x, y, maxPx) => {
    if (!data) return null
    const bx = Math.round(x * dpr), by = Math.round(y * dpr), R = Math.round(maxPx * dpr)
    let best = Infinity
    for (let yy = Math.max(0, by - R); yy <= Math.min(sharp.height - 1, by + R); yy++) {
      for (let xx = Math.max(0, bx - R); xx <= Math.min(sharp.width - 1, bx + R); xx++) {
        if (data[(yy * sharp.width + xx) * 4 + 3] < 60) continue
        const d = Math.hypot(xx - bx, yy - by)
        if (d < best) best = d
      }
    }
    return best === Infinity ? null : best / dpr
  }
  const lights = e.r.lights ?? []
  const rows = c.hotspots.map((h) => {
    const g = groups[`bulb.${h.id}`] ?? null
    const pad = 0.03
    const onFixture = !!g && h.at.every((v, a) => v >= g.lo[a] - pad && v <= g.hi[a] + pad)
    const okp = e.cam.project(h.at[0], h.at[1], h.at[2], out)
    const x = out[0], y = out[1]
    const vis = okp && x > 0 && x < e.r.w && y > 0 && y < e.r.h
    // how far the point is outside its fixture's drawn box on screen (0 = inside it)
    const fixPx = g && Number.isFinite(g.s[0]) ? Math.hypot(Math.max(0, g.s[0] - x, x - g.s[2]), Math.max(0, g.s[1] - y, y - g.s[3])) : null
    const btn = scene.querySelector(`[data-hotspot="${CSS.escape(h.id)}"]`)
    const dia = btn?.querySelector('span')
    const br = dia?.getBoundingClientRect()
    const cx = br ? br.left + br.width / 2 : NaN
    const cy = br ? br.top + br.height / 2 : NaN
    const L = lights.find((l) => Math.abs(l.at[0] - h.at[0]) < 1e-6 && Math.abs(l.at[1] - h.at[1]) < 1e-6 && Math.abs(l.at[2] - h.at[2]) < 1e-6)
    return {
      id: h.id, label: h.label, vis, x, y, onFixture, fixPx,
      fixture: g ? { segs: g.segs, layer: g.layer, w: Math.round((g.s[2] - g.s[0]) * 10) / 10, h: Math.round((g.s[3] - g.s[1]) * 10) / 10 } : null,
      diamond: !!btn, shown: !!btn && Number(getComputedStyle(btn).opacity) > 0.05,
      off: br ? Math.hypot(cx - (rect.left + x * kx), cy - (rect.top + y * ky)) : null,
      ink: vis ? inkNear(x, y, 24) : null,
      light: L ? { rgb: [...L.rgb].map((v) => Math.round(v)), I: Math.round(L.I * 100) / 100, cone: L.cone } : null,
    }
  })
  return {
    segs: c.n,
    zoom: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1,
    size: { r: [e.r.w, e.r.h], client: [scene.clientWidth, scene.clientHeight], screen: [Math.round(rect.width), Math.round(rect.height)] },
    moving: JSON.stringify(e.cam.cur) !== JSON.stringify(e.cam.to),
    rows,
  }
}

/** Reads the report once the camera has landed (it flies about 900 ms, longer on a tab's first open). */
async function landed(page, sel) {
  await page.waitFor((s) => !!document.querySelector(s)?.__wire, { args: [sel], timeout: 15_000, message: `the apartment did not draw at ${sel}` })
  let r
  for (let k = 0; k < 24; k++) {
    await sleep(250)
    r = await page.eval(apartmentReport, sel)
    if (r.error || (!r.moving && r.rows.length)) break
  }
  if (r.error) throw new Error(r.error)
  return r
}

/**
 * Taps the middle of one diamond. Two bulbs that line up in depth put their
 * 44 px targets over each other; WireScene gives the press to the nearest
 * diamond, so another diamond of the same scene on top is allowed. Anything
 * else over it fails, as page.tap's cover check does.
 */
async function tapDiamond(page, scene, id) {
  let at = null
  for (let k = 0; k < 20; k++) {
    const r = await page.eval((s, hid) => {
      const root = document.querySelector(s)
      const dia = root?.querySelector(`[data-hotspot="${CSS.escape(hid)}"] span`)
      if (!dia) return { error: `no diamond for ${hid}` }
      dia.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      const b = dia.getBoundingClientRect()
      const x = b.left + b.width / 2, y = b.top + b.height / 2
      const el = document.elementFromPoint(x, y)
      const spot = el?.closest('[data-hotspot]')
      const mine = spot && root.contains(spot)
      return { x, y, over: mine ? spot.getAttribute('data-hotspot') : null, cover: mine ? null : el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` : 'nothing' }
    }, scene, id)
    if (r.error) throw new Error(r.error)
    if (at && Math.abs(at.x - r.x) < 0.5 && Math.abs(at.y - r.y) < 0.5) { at = r; break }
    at = r
    await sleep(120)
  }
  if (at.cover) throw new Error(`${id}'s diamond is covered by ${at.cover}`)
  await page.tap({ x: at.x, y: at.y })
  return at.over
}

const near = (a, b, tol = 6) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && a.every((v, k) => Math.abs(v - b[k]) <= tol)

/** The checks both screens share: five bulbs, each on its fixture and in view, lit ones glowing there in their colors. */
function modelChecks(t, r, st, where) {
  t.check(r.segs > 1000, `${where}: the model has ${r.segs} segments; the apartment has well over 1000 (the old room had a few hundred)`)
  const ids = r.rows.map((x) => x.id)
  t.check(ids.length === IDS.length && IDS.every((id) => ids.includes(id)), `${where}: the model's hotspots are ${JSON.stringify(ids)}, want the five bulbs ${JSON.stringify(IDS)}`)
  const bare = r.rows.filter((x) => !x.fixture || x.fixture.layer !== 'hot')
  t.check(!bare.length, `${where}: no lit fixture (hot lines in bulb.<id>) for ${bare.map((x) => x.id).join(', ')}`)
  const off = r.rows.filter((x) => x.fixture && !x.onFixture)
  t.check(!off.length, `${where}: hotspots off their own fixture: ${off.map((x) => x.id).join(', ')}`)
  const out = r.rows.filter((x) => !x.vis)
  t.check(!out.length, `${where}: bulbs outside the box: ${out.map((x) => `${x.id} at ${x.x.toFixed(0)},${x.y.toFixed(0)}`).join(', ')} (renderer ${r.size.r})`)
  const fixFar = r.rows.filter((x) => x.vis && !(x.fixPx != null && x.fixPx <= 3))
  t.check(!fixFar.length, `${where}: fixtures not drawn at their points: ${fixFar.map((x) => `${x.id} ${x.fixPx == null ? 'none' : `${x.fixPx.toFixed(1)} px`}`).join(', ')}`)
  for (const l of st) {
    const row = r.rows.find((x) => x.id === l.entity_id)
    if (!row) continue
    if (l.on) {
      t.check(!!row.light, `${where}: ${l.name} is on but draws no light at its fixture`)
      if (row.light) {
        t.check(near(row.light.rgb, l.rgb_color), `${where}: ${l.name} glows ${JSON.stringify(row.light.rgb)}, want its color ${JSON.stringify(l.rgb_color)}`)
        t.check(row.light.cone === false, `${where}: ${l.name} draws a cone; lamps get a glow and a floor pool only`)
      }
    } else {
      t.check(!row.light, `${where}: ${l.name} is off but glows`)
    }
  }
  t.check(Math.abs(r.size.r[0] - r.size.client[0]) <= 1 && Math.abs(r.size.r[1] - r.size.client[1]) <= 1, `${where}: the renderer is ${r.size.r} for a ${r.size.client} box (zoomed px?)`)
}

const ROOM = '.vl-page[data-active] .lt-room [data-wire-scene]'

function lightsTabTests() {
  const out = []
  for (const device of ['phone', 'desktop', 'desk1080', 'ipadland']) {
    out.push({
      name: `lights:apartment:${device}`,
      group: 'lights',
      device,
      timeout: 75_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const st = fakeLights(page)
        await page.goto('/m/lights')
        await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .lt-bulb-wrap').length >= 5, { timeout: 15_000, message: 'Lights did not list the five bulbs' })
        let r = await landed(page, ROOM)
        t.note(`${device} @zoom ${r.zoom}: box ${r.size.client}, ${r.segs} segments, ${r.rows.map((x) => `${x.id.replace('light.', '')} ${x.off == null ? '-' : x.off.toFixed(1)} px`).join(', ')}`)
        const label = await page.eval(() => document.querySelector('.vl-page[data-active] .lt-room-label')?.textContent?.trim() ?? null)
        t.check(label === 'Apartment', `the room panel is labeled "${label}", want Apartment`)
        modelChecks(t, r, st, 'Lights')
        const far = r.rows.filter((x) => x.vis && !(x.off != null && x.off <= 3))
        t.check(!far.length, `Lights @zoom ${r.zoom}: diamonds off their bulbs: ${far.map((x) => `${x.id} ${x.off == null ? 'missing' : `${x.off.toFixed(1)} px`}`).join(', ')}`)
        const hidden = r.rows.filter((x) => x.vis && !x.shown)
        t.check(!hidden.length, `Lights: diamonds hidden although their bulbs are in view: ${hidden.map((x) => x.id).join(', ')}`)
        const noInk = r.rows.filter((x) => x.vis && (x.ink == null || x.ink > 18))
        t.check(!noInk.length, `Lights: no wireframe under these diamonds: ${noInk.map((x) => x.id).join(', ')}`)

        // each diamond selects its bulb; the next one moves the pick; a second tap lets go
        const selRead = () => page.eval(() => ({
          head: document.querySelector('.vl-page[data-active] .lt-room-sel')?.textContent?.trim() ?? null,
          rows: [...document.querySelectorAll('.vl-page[data-active] .lt-bulb-wrap[data-sel]')].map((e) => e.querySelector('.lt-bulb-name')?.textContent?.trim()),
        }))
        for (const l of st) {
          await t.step(`tap ${l.name}'s diamond`, async () => {
            const over = await tapDiamond(page, ROOM, l.entity_id)
            if (over !== l.entity_id) t.note(`${device}: ${l.name}'s diamond lies under ${over}'s target; the nearest diamond takes the press`)
            await page.waitFor((n) => document.querySelector('.vl-page[data-active] .lt-room-sel')?.textContent?.trim() === n, { args: [l.name], timeout: 3000, message: `the room header does not name ${l.name} after its diamond was tapped` })
            const s = await selRead()
            t.check(s.rows.length === 1 && s.rows[0] === l.name, `after tapping ${l.name}'s diamond the marked rows are ${JSON.stringify(s.rows)}`)
          })
        }
        await t.step('a second tap lets go', async () => {
          const last = st.at(-1)
          await tapDiamond(page, ROOM, last.entity_id)
          await page.waitFor(() => !document.querySelector('.vl-page[data-active] .lt-room-sel'), { timeout: 3000, message: `the room still names a bulb after a second tap on ${last.name}` })
          const s = await selRead()
          t.check(!s.rows.length, `rows still marked after the second tap: ${JSON.stringify(s.rows)}`)
        })
        // the taps moved nothing: every diamond still on its bulb
        await sleep(400)
        r = await page.eval(apartmentReport, ROOM)
        if (!r.error) {
          const moved = r.rows.filter((x) => x.vis && !(x.off != null && x.off <= 3))
          t.check(!moved.length, `after the taps, diamonds off their bulbs: ${moved.map((x) => `${x.id} ${x.off == null ? 'missing' : x.off.toFixed(1)}`).join(', ')}`)
        }
        await t.shot(page)
        t.check(!page.writes.length, `selecting bulbs in the apartment sent ${page.writes.length} write(s): ${page.writes.map((w) => `${w.method} ${w.path} ${w.body}`).join(' | ')}`)
      },
    })
  }
  return out
}

function dashboardTests() {
  const out = []
  for (const device of ['desktop', 'desk1080']) {
    out.push({
      name: `dash:apartment:${device}`,
      group: 'dashboard',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const st = fakeLights(page)
        await page.goto('/m/dashboard')
        const sel = '.vl-page[data-active] .hm-lights .hm-room [data-wire-scene]'
        await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .hm-lights .hm-bulb').length >= 5, { timeout: 15_000, message: 'the Lights box did not list the five bulbs' })
        const r = await landed(page, sel)
        t.note(`${device} @zoom ${r.zoom}: box ${r.size.client}, ${r.segs} segments, ${r.rows.map((x) => `${x.id.replace('light.', '')} at ${x.x.toFixed(0)},${x.y.toFixed(0)}`).join(', ')}`)
        const box = await page.eval(() => {
          const el = document.querySelector('.vl-page[data-active] .hm-lights .hm-room')
          const cap = el?.querySelector('.hm-room-cap')
          const er = el?.getBoundingClientRect()
          const cr = cap?.getBoundingClientRect()
          return {
            aria: el?.getAttribute('aria-label') ?? null,
            cap: cap?.textContent?.trim() ?? null,
            // the cap's bottom edge in the scene's own px
            capBottom: er && cr ? (cr.bottom - er.top) / (er.height / el.clientHeight) : null,
          }
        })
        t.check(box.cap === 'Apartment', `the Lights box's room cap reads "${box.cap}", want Apartment`)
        t.check(box.aria === 'The apartment, 3 of 5 bulbs lit', `the room says "${box.aria}", want "The apartment, 3 of 5 bulbs lit"`)
        modelChecks(t, r, st, 'Dashboard')
        t.check(r.rows.every((x) => !x.diamond), 'the Dashboard room draws diamonds; its list names the bulbs')
        const under = r.rows.filter((x) => box.capBottom != null && x.y < box.capBottom + 2)
        t.check(!under.length, `bulbs under the room's cap: ${under.map((x) => x.id).join(', ')}`)
        await t.shot(page)
        t.check(!page.writes.length, `the Dashboard wrote something: ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
      },
    })
  }
  return out
}

export function apartmentTests() {
  return [...lightsTabTests(), ...dashboardTests()]
}

export { apartmentReport }
