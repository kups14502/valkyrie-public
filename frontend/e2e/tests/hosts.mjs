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
//   devices   the phone and tablet as reporting hosts (backend routes/devices.ts):
//             a host row with the battery, the detail's battery and storage
//             gauges, no "Model only"
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
async function hostsDoc(base, devices = true) {
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
  return { hosts }
}

/**
 * Every diamond of the picked host's model: where it is on screen, where its
 * hotspot projects through the live camera (mapped by the renderer's own size
 * onto the canvas's box), and how far the nearest drawn line is.
 */
function hotspotReport(sel = '.vl-page[data-active] .sys-detail-model [data-wire-scene], .vl-page[data-active] .sys-device-model [data-wire-scene]') {
  const scene = document.querySelector(sel)
  if (!scene) return { error: `no model scene at ${sel}` }
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
        await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .sys-host').length >= 6, { timeout: 15_000, message: 'System > Hosts did not list the six hosts' })
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
            t.note(`${m.label} @zoom ${r.zoom}: ${drawn.length}/${r.rows.length} diamonds in view, worst ${worst('off').toFixed(1)} px off, wireframe within ${worst('ink').toFixed(1)} px`)
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

export function hostTests() {
  return [...hotspotTests(), ...roomTests(), ...deviceTests()]
}

export { hostsDoc }
