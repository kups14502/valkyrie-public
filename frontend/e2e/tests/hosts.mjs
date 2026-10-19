// HOSTS: System > Hosts after round 5.
//
//   hotspots  every device model (thor, odin, Loki, mimir, the phone, the
//             tablet) with its diamonds where the model is: each diamond's
//             center is within a few px of its hotspot projected through the
//             live camera and mapped onto the screen the way the canvas is (the
//             renderer's own size, so a renderer sized in zoomed px shows), and
//             the wireframe is drawn right under it. On the phone, a 1600x900
//             window, and 1920x1080 and 2560x1440 at Brendon's zoom of 1.2,
//             where every diamond used to float beside the model. The rebuilt
//             heroes (thor, odin, Loki) keep every hotspot id System maps its
//             plates by, and every hotspot is in view and on its part: within
//             5% of the model's radius of a drawn line, and inside the group it
//             names where the model has one (thor's 'gpu' lines). The Lights
//             room's bulb diamonds too (live bulbs, read only).
//   thor      (round 9) the case the right way around (board on the right,
//             PSU at the rear, so the glass is on the left as seen from the
//             front), the camera on the glass side, nothing standing on its top
//             (the LEGO skyline is gone); on the three desktops the model is at
//             least half the layout's height, the page does not scroll, the
//             grid reaches the page's bottom pad, and the last hour sits under
//             the list and ends with the detail; the memory diamond lights the
//             Memory plate and a second tap gives the lead back to the CPU
//   devices  the phone and tablet as reporting hosts (backend routes/devices.ts):
//             a host row with the battery, the detail's battery and storage
//             gauges, no "Model only"
//   cars     the cars (backend routes/vehicles.ts, generic fixture names): a row
//             per car with its battery, range and charging line and never
//             "Offline" for a car that sleeps; the picked car's Model Y
//             wireframe with its plates (Battery and its charging state,
//             Range, Charge limit, Charging power or Not plugged in) and the
//             lock, home or away and cabin facts; each diamond lights its plate
//             and each plate its diamond; a car with no wireframe (any model
//             but the Y) keeps its plates; the strip reads a sleeping car as
//             asleep. The Model Y also runs the hotspot check above.
//
// The hotspot check reads the scene's engine, which WireScene hangs on its
// element in dev builds only (the probe is one).

import { sleep } from '../lib/cdp.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })
// `spots`: the hotspot ids System maps its plates to (cpu, mem, disk...), which a rebuilt model must keep;
// `all`: every one of them must be in view and on its part from the Hosts camera (the round-6 heroes)
const MODELS = [
  { id: 'thor', label: 'Thor', spots: ['cpu', 'mem', 'gpu', 'disk'], all: true },
  { id: 'odin', label: 'Odin', spots: ['cpu', 'mem', 'disk', 'raid'], all: true },
  { id: 'frame', label: 'Loki', spots: ['cpu', 'mem', 'disk', 'battery', 'lens'], all: true },
  { id: 'mimir', label: 'Mimir' },
  { id: 'phone', label: 'Phone' },
  { id: 'tablet', label: 'Tablet' },
  { id: 'modelY', label: 'Car A', spots: ['battery', 'charge', 'cabin'], all: true },
]

/**
 * A car as /api/hosts lists it (routes/vehicles.ts vehicleHosts). Generic names
 * only. Car A: a Model Y, awake, charging at home. Car B: asleep, unplugged and
 * away, of a model with no wireframe.
 */
function carHost(id, label, o = {}) {
  const now = Date.now()
  const charging = o.charging ?? 'charging'
  const on = charging === 'charging' || charging === 'starting'
  return {
    host: `car-${id}`, label, os: 'vehicle', online: o.online ?? true, stale: false, ts: now - 180_000,
    uptime: null, cpu: null, memory: null, disk: null,
    battery: { percent: o.battery ?? 76, status: on ? 'charging' : charging === 'complete' ? 'full' : 'discharging' },
    vehicle: {
      model: o.model ?? 'Model Y', state: o.state ?? 'awake', since: now - 2 * 3_600_000,
      rangeMi: o.range ?? 230, chargeLimit: 80, charging,
      chargerKw: on ? 11.5 : 0, chargeRateMph: on ? 30 : 0, fullAt: on ? now + 3_600_000 : null,
      cable: on || charging === 'complete', locked: o.locked ?? true, home: o.home ?? true,
      insideF: 66, outsideF: 64, climateOn: false,
    },
    error: o.online === false ? 'Home Assistant cannot reach the car' : undefined,
    history: [],
  }
}
const CARS = () => [
  carHost('car_a', 'Car A'),
  carHost('car_b', 'Car B', { model: 'Model S', state: 'asleep', charging: 'disconnected', battery: 54, range: 201, locked: false, home: false }),
]

/** The phone and tablet as /api/hosts lists them once they report (routes/devices.ts deviceHosts). */
function deviceHost(id, { battery, status, storage = null }) {
  const now = Date.now()
  return {
    host: id, label: id, os: 'ios', online: true, stale: false, ts: now - 120_000, seen: now - 60_000,
    uptime: null, cpu: null, memory: null,
    disk: storage ? { used: storage[0] * 1e9, total: storage[1] * 1e9, percent: (storage[0] / storage[1]) * 100 } : null,
    battery: { percent: battery, status }, history: [],
  }
}

/** odin's real hosts (one GET through the probe), every one online, plus the two devices. */
async function hostsDoc(base, devices = true, cars = devices) {
  let real = []
  try {
    real = (await (await fetch(`${base}/api/hosts`, { signal: AbortSignal.timeout(10_000) })).json()).hosts ?? []
  } catch { /* the fallback below */ }
  const now = Date.now()
  const fallback = (host, label) => ({
    host, label, os: 'linux', online: true, stale: false, ts: now, uptime: 86_400,
    cpu: { usage: 12, cores: 8 }, memory: { percent: 40, used: 8 * 1024 ** 3, total: 20 * 1024 ** 3 }, disk: { percent: 50, used: 250e9, total: 500e9 }, history: [],
  })
  const want = [['odin', 'odin'], ['thor', 'thor'], ['frame', 'loki'], ['mimir', 'mimir']]
  const hosts = want.map(([id, label]) => {
    const r = real.find((h) => h.host === id)
    const h = r ? { ...r } : fallback(id, label)
    // offline hosts still draw their model; online keeps the gauges beside it the same for every model
    h.online = true
    h.stale = false
    h.cpu ??= { usage: 12, cores: 8 }
    h.memory ??= { percent: 40, used: 8 * 1024 ** 3, total: 20 * 1024 ** 3 }
    h.disk ??= { percent: 50, used: 250e9, total: 500e9 }
    delete h.error
    return h
  })
  if (devices) {
    hosts.push(deviceHost('phone', { battery: 80, status: 'not charging' }))
    hosts.push(deviceHost('tablet', { battery: 55, status: 'charging', storage: [101.5, 256] }))
  }
  if (cars) hosts.push(...CARS())
  return { hosts }
}

/**
 * Every diamond of the picked host's model: where it is on screen, where its
 * hotspot projects through the live camera (mapped by the renderer's own size
 * onto the canvas's box), and how far the nearest drawn line is.
 */
function hotspotReport(sel = '.vl-page[data-active] .sys-detail-model [data-wire-scene], .vl-page[data-active] .sys-device-model [data-wire-scene]') {
  const scene = document.querySelector(sel)
  if (!scene) {
    const act = [...document.querySelectorAll('.vl-page[data-active]')].map((p) => p.getAttribute('data-screen') || p.id || p.className).join('+') || 'none'
    const heroes = [...document.querySelectorAll('.vl-page[data-active] [data-hero]')].map((h) => `${h.getAttribute('data-hero')}${h.querySelector('[data-wire-scene]') ? '' : ' (no scene)'}`).join(', ') || 'none'
    return { error: `no model scene at ${sel} (on ${location.pathname}, active page ${act}, heroes ${heroes})` }
  }
  const e = scene.__wire
  if (!e) return { error: 'the scene has no engine handle (__wire): not a dev build?' }
  const rect = scene.getBoundingClientRect()
  const kx = rect.width / e.r.w
  const ky = rect.height / e.r.h
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
  // on its part: how far the point is from the nearest drawn segment, and whether it sits inside the
  // box of the group named after it (thor's 'gpu' lines for the GPU spot) where the model has one,
  // both in model units against a tolerance of 5% of the model's radius (a few px on screen)
  const c = e.r.model
  const tol = (c?.radius ?? 4) * 0.05
  const segDist = (p, i) => {
    const o = i * 6
    const ax = c.pos[o], ay = c.pos[o + 1], az = c.pos[o + 2]
    const dx = c.pos[o + 3] - ax, dy = c.pos[o + 4] - ay, dz = c.pos[o + 5] - az
    const L2 = dx * dx + dy * dy + dz * dz
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / L2)) : 0
    return Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1], az + dz * t - p[2])
  }
  const groupBox = (g) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    let n = 0
    for (let i = 0; i < c.n; i++) {
      if (c.styles[c.style[i]].group !== g) continue
      n++
      for (const k of [0, 3]) for (let a = 0; a < 3; a++) { const v = c.pos[i * 6 + k + a]; lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v) }
    }
    return n ? { lo, hi } : null
  }
  const out = [0, 0, 0]
  const spots = c?.hotspots ?? []
  const rows = spots.map((h) => {
    let part = Infinity
    for (let i = 0; i < c.n; i++) { const d = segDist(h.at, i); if (d < part) part = d }
    const gb = groupBox(h.id)
    const inGroup = gb ? h.at.every((v, a) => v >= gb.lo[a] - tol && v <= gb.hi[a] + tol) : null
    const ok = e.cam.project(h.at[0], h.at[1], h.at[2], out)
    const vis = ok && out[0] > 0 && out[0] < e.r.w && out[1] > 0 && out[1] < e.r.h
    const btn = scene.querySelector(`[data-hotspot="${h.id}"]`)
    const dia = btn?.querySelector('span')
    const br = dia?.getBoundingClientRect()
    const shown = !!btn && Number(getComputedStyle(btn).opacity) > 0.05
    const px = rect.left + out[0] * kx
    const py = rect.top + out[1] * ky
    const cx = br ? br.left + br.width / 2 : NaN
    const cy = br ? br.top + br.height / 2 : NaN
    return { id: h.id, vis, shown, off: Math.hypot(cx - px, cy - py), ink: vis ? inkNear(out[0], out[1], 24) : null, part, inGroup, tol }
  })
  return {
    model: scene.closest('[data-hero]')?.getAttribute('data-hero') ?? null,
    zoom: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1,
    size: { r: [e.r.w, e.r.h], client: [scene.clientWidth, scene.clientHeight], screen: [Math.round(rect.width), Math.round(rect.height)] },
    moving: JSON.stringify(e.cam.cur) !== JSON.stringify(e.cam.to),
    rows,
  }
}

/**
 * thor's case as the Hosts camera sees it: where its board and PSU sit in the
 * model (the real case has the glass on the left as seen from the front, so
 * the board is on the right, +x, and the PSU at the rear, -z), which side the
 * camera looks from, and the model's top (nothing stands on the case: the
 * LEGO skyline is gone).
 */
function thorReport(sel = '.vl-page[data-active] .sys-detail-model [data-hero="thor"] [data-wire-scene]') {
  const scene = document.querySelector(sel)
  const e = scene?.__wire
  const c = e?.r?.model
  if (!c) return { error: `no thor scene at ${sel}` }
  const box = (g) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < c.n; i++) {
      if (c.styles[c.style[i]].group !== g) continue
      for (const k of [0, 3]) for (let a = 0; a < 3; a++) { const v = c.pos[i * 6 + k + a]; lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v) }
    }
    return lo.map((v, a) => (v + hi[a]) / 2)
  }
  let top = -Infinity, topShell = -Infinity
  for (let i = 0; i < c.n; i++) {
    const y = Math.max(c.pos[i * 6 + 1], c.pos[i * 6 + 4])
    top = Math.max(top, y)
    if (c.styles[c.style[i]].layer === 'shell') topShell = Math.max(topShell, y)
  }
  // the top panel's bright rim (the 'fg' rectangle at the case's top)
  let rim = -Infinity
  for (let i = 0; i < c.n; i++) if (c.styles[c.style[i]].layer === 'fg' && c.pos[i * 6 + 1] === c.pos[i * 6 + 4]) rim = Math.max(rim, c.pos[i * 6 + 1])
  return { board: box('board'), psu: box('psu'), center: c.center, cam: [e.cam.px, e.cam.py, e.cam.pz], top, topShell, rim }
}

/** The desktop page: the model's box against the layout, the page's scroll, and how far the grid reaches down. */
function fillReport() {
  const page = document.querySelector('.vl-page[data-active]')
  const grid = page?.querySelector('.sys-hosts')
  const model = page?.querySelector('.sys-detail-model')
  const detail = page?.querySelector('.sys-detail')
  const chart = page?.querySelector('.sys-chart')
  const list = page?.querySelector('.sys-hosts-panel')
  if (!page || !grid || !model || !detail) return { error: 'no hosts grid, detail or model on the page' }
  const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
  const r = (el) => el?.getBoundingClientRect() ?? null
  const pr = r(page), gr = r(grid), dr = r(detail), cr = r(chart), lr = r(list)
  return {
    zoom,
    layout: [Math.round(innerWidth / zoom), Math.round(innerHeight / zoom)],
    model: [model.clientWidth, model.clientHeight],
    scroll: [page.scrollHeight, page.clientHeight],
    // screen px below the grid, against the page's own bottom pad (the lights button's room) plus the screen's padding
    below: Math.round(pr.bottom - gr.bottom),
    allowed: Math.round((parseFloat(getComputedStyle(page).paddingBottom) + 40) * zoom),
    detailBottom: Math.round(dr.bottom),
    chartBottom: cr ? Math.round(cr.bottom) : null,
    chartUnderList: cr && lr ? cr.top >= lr.bottom - 1 : null,
  }
}

/**
 * thor (round 9): the case the right way around and seen through its glass, no
 * skyline on top; on a desktop the model is the page's largest thing and the
 * page fills the window without scrolling; a diamond tap lights its plate.
 */
async function thorChecks(t, page, device) {
  const o = await page.eval(thorReport)
  if (o.error) throw new Error(o.error)
  const f2 = (v) => v.toFixed(2)
  t.check(o.board[0] > 0.2, `thor is mirrored: its board sits at x ${f2(o.board[0])}, want the right side (+x), the glass on the left as seen from the front`)
  t.check(o.psu[2] < -0.5, `thor's PSU sits at z ${f2(o.psu[2])}, want the rear (-z)`)
  t.check(o.cam[0] < o.center[0] - 1, `the Hosts camera looks at thor from x ${f2(o.cam[0])}, the solid side; want the glass side (-x)`)
  t.check(o.top - o.rim < 0.05 && o.topShell - o.rim < 0.05, `something stands ${f2(Math.max(o.top, o.topShell) - o.rim)} units above thor's top panel (the LEGO skyline is gone)`)

  if (device !== 'phone') {
    const f = await page.eval(fillReport)
    if (f.error) throw new Error(f.error)
    t.note(`thor @${device}: model ${f.model.join('x')} in a ${f.layout.join('x')} layout, ${f.below} px under the grid (up to ${f.allowed})`)
    t.check(f.model[1] >= f.layout[1] * 0.5 && f.model[0] >= f.layout[0] * 0.38, `thor's model is ${f.model.join('x')} px in a ${f.layout.join('x')} layout: want at least half the height and 38% of the width`)
    t.check(f.scroll[0] <= f.scroll[1] + 1, `System > Hosts scrolls on a desktop (${f.scroll[0]} px of content in ${f.scroll[1]})`)
    t.check(f.below <= f.allowed, `the hosts grid stops ${f.below} screen px above the page's bottom (up to ${f.allowed}): the window is not filled`)
    if (f.chartBottom == null) t.note('thor has no last-hour chart in this data: the chart checks are skipped')
    else {
      t.check(f.chartUnderList, 'the last-hour chart is not under the host list')
      t.check(Math.abs(f.chartBottom - f.detailBottom) <= 2, `the last-hour chart ends at ${f.chartBottom}, the detail at ${f.detailBottom}: the columns do not line up`)
    }
  }

  // a diamond lights its plate, a second tap gives the lead back to the CPU
  const lit = () => document.querySelector('.vl-page[data-active] .sys-detail .sys-gauge[data-lit]')?.getAttribute('aria-label') ?? null
  const dia = { sel: '.vl-page[data-active] .sys-detail-model [data-hotspot="mem"]' }
  await page.tap(dia)
  await sleep(300)
  const a = await page.eval(lit)
  t.check(/^Memory /.test(a ?? ''), `the memory diamond lit "${a}", want the Memory plate`)
  await page.tap(dia)
  await sleep(300)
  const b = await page.eval(lit)
  t.check(/^CPU /.test(b ?? ''), `a second tap on the memory diamond left "${b}" lit, want the CPU plate back`)
}

async function pick(page, label) {
  await page.tap({ sel: '.vl-page[data-active] .sys-host', text: new RegExp(`^\\s*${label}\\b|${label}:`) })
}

function hotspotTests() {
  const out = []
  for (const device of ['phone', 'desktop', 'desk1080', 'desk1440']) {
    out.push({
      name: `hosts:hotspots:${device}`,
      group: 'hosts',
      device,
      timeout: 120_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const doc = await hostsDoc(t.env.base)
        page.mock('/api/hosts', () => ok(doc))
        await page.goto('/m/system/hosts')
        await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .sys-host').length >= 8, { timeout: 15_000, message: 'System > Hosts did not list the six hosts and two cars' })
        for (const m of MODELS) {
          await t.step(`${m.label}`, async () => {
            await pick(page, m.label)
            // a boolean, never the engine itself: returned by value, its canvases and caches would overflow the CDP socket
            await page.waitFor((id) => !!document.querySelector(`.vl-page[data-active] .sys-detail-model [data-hero="${id}"] [data-wire-scene]`)?.__wire, { args: [m.id], timeout: 8000, message: `${m.label}'s model did not draw` })
            // the camera flies about 900 ms; read once it has landed
            let r
            for (let k = 0; k < 20; k++) {
              await sleep(250)
              r = await page.eval(hotspotReport)
              if (r.error || !r.moving) break
            }
            if (r.error) throw new Error(r.error)
            if (r.model !== m.id) throw new Error(`the detail draws ${r.model}, want ${m.id}`)
            const drawn = r.rows.filter((x) => x.vis)
            const worst = (k) => Math.max(0, ...drawn.map((x) => (Number.isFinite(x[k]) ? x[k] : 999)))
            const bareId = drawn.reduce((m0, x) => ((x.ink ?? 999) > (m0?.ink ?? -1) ? x : m0), null)?.id ?? '-'
            t.note(`${m.label} @zoom ${r.zoom}: ${drawn.length}/${r.rows.length} diamonds in view, worst ${worst('off').toFixed(1)} px off, wireframe within ${worst('ink').toFixed(1)} px (${bareId})`)
            t.check(drawn.length >= Math.min(2, r.rows.length), `${m.label}: only ${drawn.length} of ${r.rows.length} hotspots project inside the scene (size ${JSON.stringify(r.size)})`)
            if (m.spots) {
              const ids = r.rows.map((x) => x.id)
              const lost = m.spots.filter((id) => !ids.includes(id))
              t.check(!lost.length, `${m.label}: the model lost the hotspots System maps by id: ${lost.join(', ')} (has ${ids.join(', ')})`)
            }
            if (m.all) {
              const outside = r.rows.filter((x) => !x.vis)
              t.check(!outside.length, `${m.label} @zoom ${r.zoom}: hotspots outside the scene: ${outside.map((x) => x.id).join(', ')} (size ${JSON.stringify(r.size)})`)
              const loose = r.rows.filter((x) => !(x.part <= x.tol))
              t.check(!loose.length, `${m.label}: hotspots off their parts: ${loose.map((x) => `${x.id} ${x.part.toFixed(2)} units from the nearest line`).join(', ')}`)
              const stray = r.rows.filter((x) => x.inGroup === false)
              t.check(!stray.length, `${m.label}: hotspots outside the part they name: ${stray.map((x) => x.id).join(', ')}`)
            }
            const far = drawn.filter((x) => !(x.off <= 3))
            t.check(!far.length, `${m.label} @zoom ${r.zoom}: diamonds off their points: ${far.map((x) => `${x.id} ${Number.isFinite(x.off) ? x.off.toFixed(1) : 'missing'} px`).join(', ')} (renderer ${r.size.r}, box ${r.size.client}, on screen ${r.size.screen})`)
            const hidden = drawn.filter((x) => !x.shown)
            t.check(!hidden.length, `${m.label}: diamonds hidden although their points are in view: ${hidden.map((x) => x.id).join(', ')}`)
            const bare = drawn.filter((x) => x.ink == null || x.ink > 18)
            t.check(!bare.length, `${m.label} @zoom ${r.zoom}: no wireframe under these diamonds: ${bare.map((x) => `${x.id} (${x.ink == null ? 'none within 24 px' : `${x.ink.toFixed(0)} px away`})`).join(', ')}`)
            t.check(Math.abs(r.size.r[0] - r.size.client[0]) <= 1 && Math.abs(r.size.r[1] - r.size.client[1]) <= 1, `${m.label}: the renderer is ${r.size.r} for a ${r.size.client} box (zoomed px?)`)
            if (m.id === 'thor') await thorChecks(t, page, device)
          })
        }
        await t.shot(page)
        t.check(!page.writes.length, 'System > Hosts wrote something')
      },
    })
  }
  return out
}

/** The Lights room (Lights.tsx): a diamond per bulb on the room model, on live bulbs (read only). */
function roomTests() {
  const out = []
  for (const device of ['desktop', 'desk1080']) {
    out.push({
      name: `hosts:hotspots:lights-room:${device}`,
      group: 'hosts',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        await page.goto('/m/lights')
        const sel = '.vl-page[data-active] .lt-room [data-wire-scene]'
        await page.waitFor((s) => !!document.querySelector(s)?.__wire, { args: [sel], timeout: 15_000, message: 'the Lights room model did not draw' })
        let r
        for (let k = 0; k < 24; k++) {
          await sleep(250)
          r = await page.eval(hotspotReport, sel)
          if (r.error || (!r.moving && r.rows.length)) break
        }
        if (r.error) throw new Error(r.error)
        const drawn = r.rows.filter((x) => x.vis)
        t.note(`room @zoom ${r.zoom}: ${drawn.length}/${r.rows.length} diamonds in view, worst ${Math.max(0, ...drawn.map((x) => x.off)).toFixed(1)} px off`)
        t.check(r.rows.length > 0, 'the room model has no bulb hotspots')
        const far = drawn.filter((x) => !(x.off <= 3))
        t.check(!far.length, `room @zoom ${r.zoom}: diamonds off their bulbs: ${far.map((x) => `${x.id} ${Number.isFinite(x.off) ? x.off.toFixed(1) : 'missing'} px`).join(', ')}`)
        t.check(Math.abs(r.size.r[0] - r.size.client[0]) <= 1 && Math.abs(r.size.r[1] - r.size.client[1]) <= 1, `the room renderer is ${r.size.r} for a ${r.size.client} box`)
        await t.shot(page)
        t.check(!page.writes.length, 'Lights wrote something')
      },
    })
  }
  return out
}

function deviceTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `hosts:devices:${device}`,
      group: 'hosts',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const doc = await hostsDoc(t.env.base)
        page.mock('/api/hosts', () => ok(doc))
        await page.goto('/m/system/hosts')
        await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] .sys-host')].some((e) => /Tablet/.test(e.textContent || '')), { timeout: 15_000, message: 'the tablet is not on System > Hosts' })
        await sleep(600)
        const rows = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .sys-host')].map((e) => ({
          name: (e.querySelector('.sys-host-name')?.textContent || '').trim(),
          model: e.hasAttribute('data-model'),
          bat: (e.querySelector('.sys-host-bat')?.textContent || '').trim(),
          meta: (e.querySelector('.sys-host-meta')?.textContent || '').trim(),
        })))
        const phone = rows.find((r) => r.name === 'Phone')
        const tablet = rows.find((r) => r.name === 'Tablet')
        t.check(phone && !phone.model && phone.bat === '80%', `the reporting phone reads ${JSON.stringify(phone)}, want a host row with its battery at 80%`)
        t.check(tablet && !tablet.model && tablet.bat === '55%', `the reporting tablet reads ${JSON.stringify(tablet)}, want a host row with its battery at 55%`)
        t.check(!rows.some((r) => /Model only/.test(r.meta)), 'a reporting device still says "Model only"')
        await pick(page, 'Tablet')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .sys-detail [data-hero="tablet"]'), { timeout: 8000, message: 'the tablet detail did not show its model' })
        const g = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .sys-detail .sys-gauge')].map((e) => e.getAttribute('aria-label')))
        t.check(g.some((x) => /^Battery 55%/.test(x ?? '')), `the tablet detail has no battery gauge at 55% (${JSON.stringify(g)})`)
        t.check(g.some((x) => /\b40%/.test(x ?? '')), `the tablet detail has no storage gauge at 40% (${JSON.stringify(g)})`)
        t.check(!g.some((x) => /^(CPU|Memory) /.test(x ?? '')), `the tablet detail shows CPU or Memory plates it never reports (${JSON.stringify(g)})`)
        const lit = await page.eval(() => document.querySelector('.vl-page[data-active] .sys-detail .sys-gauge[data-lit]')?.getAttribute('aria-label') ?? null)
        t.check(/^Battery /.test(lit ?? ''), `the tablet detail leads with "${lit}", want its battery`)
        const state = await page.eval(() => document.querySelector('.vl-page[data-active] .sys-detail-state')?.textContent?.trim())
        t.check(state === 'Online', `the tablet detail says "${state}", want Online`)
        await t.shot(page)
      },
    })
  }
  return out
}

/** The picked car's detail as drawn: its words, plates, facts, model and diamonds. */
function carReport() {
  const d = document.querySelector('.vl-page[data-active] .sys-car-detail')
  if (!d) return { error: 'no car detail on the page' }
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  return {
    id: txt(d.querySelector('.sys-detail-id > span:nth-child(2)')),
    state: txt(d.querySelector('.sys-detail-state')),
    when: txt(d.querySelector('.sys-detail-up')),
    hero: d.querySelector('[data-hero]')?.getAttribute('data-hero') ?? null,
    nomodel: d.hasAttribute('data-nomodel'),
    plates: [...d.querySelectorAll('.sys-gauge')].map((g) => ({ id: g.getAttribute('data-plate'), aria: g.getAttribute('aria-label'), text: txt(g), lit: g.hasAttribute('data-lit'), bar: !!g.querySelector('.vl-bar') })),
    facts: [...d.querySelectorAll('.sys-car-fact')].map((f) => ({ id: f.getAttribute('data-fact'), text: txt(f), lit: f.hasAttribute('data-lit') })),
    // a diamond is active when it carries its label (WireScene adds a third span)
    active: [...d.querySelectorAll('[data-hotspot]')].filter((b) => b.children.length >= 3).map((b) => b.getAttribute('data-hotspot')),
    spots: [...d.querySelectorAll('[data-hotspot]')].map((b) => b.getAttribute('data-hotspot')),
  }
}

function carTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `hosts:cars:${device}`,
      group: 'hosts',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const doc = await hostsDoc(t.env.base)
        page.mock('/api/hosts', () => ok(doc))
        await page.goto('/m/system/hosts')
        await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] .sys-car')].length >= 2, { timeout: 15_000, message: 'the two cars are not on System > Hosts' })
        await sleep(600)

        // ---- the rows ----
        const rows = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .sys-car')].map((e) => ({
          name: (e.querySelector('.sys-host-name')?.textContent || '').trim(),
          meta: (e.querySelector('.sys-host-meta')?.textContent || '').replace(/\s+/g, ' ').trim(),
          bat: (e.querySelector('.sys-host-bat')?.textContent || '').trim(),
          range: (e.querySelector('.sys-car-range')?.textContent || '').replace(/\s+/g, '').trim(),
          charge: (e.querySelector('.sys-car-charge')?.textContent || '').replace(/\s+/g, ' ').trim(),
          off: e.hasAttribute('data-off'),
          cells: e.querySelectorAll('.sys-cell, .sys-spark').length,
          tile: e.querySelector('.sys-host-tile')?.getAttribute('data-state'),
        })))
        const a = rows.find((r) => r.name === 'Car A')
        const b = rows.find((r) => r.name === 'Car B')
        t.note(`rows: ${JSON.stringify(rows)}`)
        t.check(a && /^Awake/.test(a.meta) && a.bat === '76%' && a.range === '230mi' && a.charge === 'Charging 11.5 kW', `Car A's row reads ${JSON.stringify(a)}, want Awake, 76%, 230 mi, Charging 11.5 kW`)
        t.check(b && /^Asleep/.test(b.meta) && b.bat === '54%' && b.range === '201mi' && b.charge === 'Not plugged in', `Car B's row reads ${JSON.stringify(b)}, want Asleep, 54%, 201 mi, Not plugged in`)
        t.check(b && !b.off && b.tile === 'sleep' && !/Offline/.test(b.meta), `a sleeping car reads as offline: ${JSON.stringify(b)}`)
        t.check(rows.every((r) => r.cells === 0), 'a car row draws CPU, memory, disk or the last hour')
        const strip = await page.eval(() => [...document.querySelectorAll('.vl-strip-hosts .vl-host')].map((e) => `${(e.querySelector('b')?.textContent || '').trim()}:${e.getAttribute('data-state')}`))
        t.check(strip.includes('Car A:on') && strip.includes('Car B:sleep'), `the strip reads the cars as ${JSON.stringify(strip)}, want Car A on and Car B asleep`)

        // ---- Car A: its model, plates and facts ----
        await pick(page, 'Car A')
        await page.waitFor(() => !!document.querySelector('.vl-page[data-active] .sys-car-detail [data-hero="modelY"] [data-wire-scene]')?.__wire, { timeout: 8000, message: "Car A's Model Y did not draw" })
        await sleep(1200)
        let r = await page.eval(carReport)
        if (r.error) throw new Error(r.error)
        t.check(r.id === 'Car A' && r.state === 'Awake', `the detail head reads "${r.id}" "${r.state}", want Car A Awake`)
        t.check(/^read \d+m ago$/.test(r.when), `the detail says "${r.when}", want how long ago it was read`)
        t.check(r.hero === 'modelY' && !r.nomodel, `Car A draws ${r.hero}, want modelY`)
        t.check(['battery', 'charge', 'cabin'].every((id) => r.spots.includes(id)), `Car A's diamonds are ${r.spots.join(', ')}, want battery, charge and cabin`)
        const aria = r.plates.map((p) => p.aria)
        const want = [/^Battery 76%/, /^Range 230 mi/, /^Charge limit 80%/, /^Charging 11\.5 kW/]
        t.check(r.plates.length === 4 && want.every((re, k) => re.test(aria[k] ?? '')), `Car A's plates are ${JSON.stringify(aria)}, want Battery 76%, Range 230 mi, Charge limit 80%, Charging 11.5 kW`)
        t.check(/Charging/.test(r.plates[0]?.text ?? '') && /303 mi at 100%/.test(r.plates[1]?.text ?? '') && /4% to go/.test(r.plates[2]?.text ?? '') && /\+30 mi\/h · full .+ ET/.test(r.plates[3]?.text ?? ''),
          `Car A's plate notes read ${JSON.stringify(r.plates.map((p) => p.text))}`)
        t.check(r.plates[0]?.lit && r.plates.filter((p) => p.lit).length === 1, `Car A leads with ${JSON.stringify(r.plates.filter((p) => p.lit).map((p) => p.id))}, want the battery alone`)
        const facts = r.facts.map((f) => f.text)
        t.check(facts[0] === 'Locked' && facts[1] === 'Home' && /66°F inside · 64°F out/.test(facts[2] ?? ''), `Car A's facts read ${JSON.stringify(facts)}, want Locked, Home, 66°F inside · 64°F out`)
        t.check(!/[—]/.test(JSON.stringify(r)), 'an em dash in the car detail')

        // each diamond lights its plate, each plate its diamond
        const tapSpot = async (id) => { await page.tap({ sel: `.vl-page[data-active] .sys-car-detail [data-hotspot="${id}"]` }); await sleep(350) }
        await tapSpot('charge')
        r = await page.eval(carReport)
        t.check(r.plates.find((p) => p.lit)?.id === 'charge' && r.active.join() === 'charge', `the charge port diamond lit ${JSON.stringify(r.plates.find((p) => p.lit)?.id)} (active ${r.active}), want the Charging plate`)
        await tapSpot('cabin')
        r = await page.eval(carReport)
        t.check(r.facts.find((f) => f.id === 'cabin')?.lit && !r.plates.some((p) => p.lit) && r.active.join() === 'cabin', `the cabin diamond lit ${JSON.stringify(r.facts)} (active ${r.active}), want the cabin fact`)
        await tapSpot('cabin')
        r = await page.eval(carReport)
        t.check(r.plates.find((p) => p.lit)?.id === 'battery' && !r.active.length, `a second tap on the cabin diamond left ${JSON.stringify(r.plates.find((p) => p.lit)?.id)} lit (active ${r.active}), want the battery back`)
        await page.tap({ sel: '.vl-page[data-active] .sys-car-detail .sys-gauge[data-plate="range"]' })
        await sleep(350)
        r = await page.eval(carReport)
        t.check(r.plates.find((p) => p.lit)?.id === 'range' && r.active.join() === 'battery', `the Range plate lit ${JSON.stringify(r.plates.find((p) => p.lit)?.id)} with diamond ${r.active}, want Range and the battery pack`)
        await t.shot(page, 'car-a')

        // ---- Car B: asleep, unplugged, away, no wireframe for its model ----
        await pick(page, 'Car B')
        await page.waitFor(() => /^Car B$/.test(document.querySelector('.vl-page[data-active] .sys-car-detail .sys-detail-id > span:nth-child(2)')?.textContent || ''), { timeout: 8000, message: 'Car B did not show' })
        await sleep(600)
        r = await page.eval(carReport)
        t.check(r.state === 'Asleep' && /^asleep since .+ ET$/.test(r.when), `Car B's head reads "${r.state}" "${r.when}", want Asleep, asleep since a time in ET`)
        t.check(r.nomodel && r.hero == null, `Car B (no wireframe for its model) draws ${r.hero}`)
        const bAria = r.plates.map((p) => p.aria)
        t.check(/^Battery 54%/.test(bAria[0] ?? '') && /^Range 201 mi/.test(bAria[1] ?? '') && /^Charging: not plugged in/.test(bAria[3] ?? ''), `Car B's plates are ${JSON.stringify(bAria)}`)
        t.check(/Not plugged in/.test(r.plates[3]?.text ?? '') && !r.plates[3]?.bar, `Car B's charging plate reads ${JSON.stringify(r.plates[3])}, want Not plugged in with no bar`)
        t.check(r.facts.map((f) => f.text).slice(0, 2).join('|') === 'Unlocked|Away', `Car B's facts read ${JSON.stringify(r.facts.map((f) => f.text))}, want Unlocked, Away`)
        await t.shot(page, 'car-b')
        t.check(!page.writes.length, 'System > Hosts wrote something')
      },
    })
  }
  return out
}

export function hostTests() {
  return [...hotspotTests(), ...roomTests(), ...deviceTests(), ...carTests()]
}

export { hostsDoc, carHost }
