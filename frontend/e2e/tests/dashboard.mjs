// DASHBOARD: the round-5 Dashboard and the trade figure's honesty.
//
//   lights   the Lights box has one all-lights bar (the room's level, as the
//            head reads it) and a chip per bulb with no bar of its own (desktop,
//            iPad and phone alike), reads the preset every lit bulb shows at
//            full scale (a red of 224 is Red), and writes in order with the
//            newest press winning: fast chip taps under a slow Home Assistant
//            never put two commands for one bulb in flight and end where the
//            last tap said; a preset then a switch keep their order; a drag on
//            the all-lights bar sends one command, on release, for the bulbs
//            that are on (none while every bulb is off); all off then Undo
//            brings back only the bulbs that were on; a refusal toasts and
//            falls back. Home Assistant is a fake here: every write is answered
//            in the browser.
//            The Lights tab takes the same fast presses (a bulb's switch, three
//            presets in a row) through src/lib/lights.ts's queue: one command in
//            flight, the bulbs end where the last press said and the lit preset
//            stays put.
//   trade    the trade box (two columns and up): the ticker as its head, the
//            equity labeled by its real age (Live for a fresh broker read, Last
//            read, Day-open), the chart at its own short height (120 to 170
//            layout px, never stretched to fill a column); the phone keeps the
//            ticker only.
//            System > Trades says Live for a fresh read, never "Unchanged
//            since", and says All cash when cash is the whole total.
//   media    posters in the desktop app: over the Tauri stand-in, the app finds
//            odin's API by its healthz probe and moves its base there; every
//            poster on the Dashboard and Media > Dashboard loads from that base
//            with no token. Moved to a remote base, the posters carry the image
//            token and still load (a tokenless one gets the remote's 401).
//   layout   no Meals row; the stage (This device's model) is the Dashboard's
//            largest block on every screen: across the top on the phone (under
//            the ticker) and the upright iPad, the middle column's head on a
//            monitor (the middle column the widest, AI and the hosts side by
//            side under it); three columns on a monitor that fill the page with
//            no scroll, the calendar left and the trade box right (between
//            lights and media); the landscape iPad's board (calendar left,
//            trade right) with no scroll; the newest-addition banner on a 2560
//            px monitor only; no apartment anywhere on the Dashboard (the one
//            model it draws is This device's).
//   calendar the Calendar block over a made-up week: day headings (Today,
//            Tomorrow, then weekday and date) with empty days left out, the
//            head says ET and the times are New York time, the next event
//            leads with "in N min" (a live one with Now and when it ends), a
//            day's all-day events on one line, a meeting's Join link (Teams in
//            the notes, Zoom in the location) and a plain location otherwise,
//            a day heading opening the calendar on that day; on a monitor and
//            the landscape iPad the block keeps its natural height inside its
//            column and folds the rest into "+N more this week", the next event
//            always kept; no horizontal overflow. A week of 70 events folds
//            the same way on a monitor (no crash); an event over midnight
//            leads once, its end named with its day.
//   device   This device, the stage: the model of the machine the page runs on
//            (the desktop app's machine name over the Tauri stand-in, held back
//            1.2 s so a guess drawn before it answers shows, else the device
//            profile: thor, mimir, Loki, the phone, the tablet), no other model
//            drawn first, its caption, name, state and numbers with what each
//            is out of (cores, used / total; battery and storage on the phone,
//            the hint before the tablet's first battery reading), each number
//            off the model and tied to its part by a leader line that ends on
//            the part as the live camera projects it, the last hour of CPU and
//            memory along the monitor's stage (none on the phone and iPad), the
//            model inside its box and centered on its place, none of the
//            engine's diamonds, no apartment, no scroll and the three columns
//            level at 1600x900 and the monitors (app and browser), a drag on
//            the model turning it without leaving the Dashboard, and a tap on
//            the model opening System > Hosts with that host picked.
//            /api/hosts is a fixed fake here, with a car in it
//            (routes/vehicles.ts lists one Model Y by default).
//   cars     the cars in the Systems box (`dash:cars`): after the phone and
//            tablet, a car's battery and range and no CPU or memory, a car
//            asleep still a live row, and a press opening System > Hosts with
//            that car picked; the monitor still fits without a scroll.
//   raven    the Raven block (`dash:raven`) over a fake /api/raven: its status and the last
//            exchange (his last line, Raven's own reply after it, one or two lines each), right
//            under the stage on the phone and the iPads and under Upload on a monitor, no
//            corner button beside it, a send carrying the Raven screen's body (source app), Raven
//            working then the reply in the block (and read there), the heading opening /m/raven,
//            no scroll on a monitor or the landscape iPad, nothing wider than the screen.

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { applyLight, quietThor, tradePage, tradeStatus } from '../lib/fixtures.mjs'
import { tauriStub } from '../lib/tauri.mjs'
import { carHost } from './hosts.mjs'
import { ravenBackend } from './raven.mjs'

const ok = (body) => ({ status: 200, body })
const iso = (ms) => new Date(ms).toISOString()

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

async function waitW(page, n, timeout = 8000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}: ${page.writes.map((w) => w.body).join(' | ')}`)
  return page.writes[n - 1]
}

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

// ---------- lights ----------

/** Five bulbs: three lit red (one reporting a red of 224, the way a Cync bulb quantizes it), one off, one unreachable. */
function bulbs() {
  const b = (id, name, on, extra = {}) => ({
    entity_id: `light.e2e_${id}`, name, on, unavailable: false, brightness: on ? 128 : null, rgb_color: on ? [255, 0, 0] : null,
    color_temp_kelvin: null, color_mode: on ? 'rgb' : null, supported_color_modes: ['rgb', 'color_temp'], min_kelvin: 2000, max_kelvin: 6500,
    ...extra,
  })
  return [
    b('desk', 'Desk', true, { rgb_color: [224, 0, 0], brightness: 200 }),
    b('lamp', 'Lamp', false),
    b('strip', 'Strip', false, { unavailable: true }),
    b('office', 'Office', true),
    b('shelf', 'Shelf', true, { brightness: 64 }),
  ]
}
const ID = (name) => `light.e2e_${name.toLowerCase()}`

/**
 * A fake Home Assistant behind /api/lights: GET reads the state, a POST to
 * /api/lights/turn waits `latency` ms, then applies (or refuses with
 * `refuse(w)`'s status). Tracks how many commands per bulb were in flight at
 * once, and every command in arrival order.
 */
function fakeHA(page, { latency = 0, refuse = () => 0 } = {}) {
  const st = { lights: bulbs(), log: [], inflight: {}, maxInflight: {} }
  page.mock('/api/lights', () => ok(st.lights))
  page.onWrite(async (w) => {
    if (w.method !== 'POST' || w.path !== '/api/lights/turn') return undefined
    const ids = Array.isArray(w.json?.entity_id) ? w.json.entity_id : [w.json?.entity_id]
    st.log.push({ ...w.json, at: Date.now() })
    for (const id of ids) {
      st.inflight[id] = (st.inflight[id] ?? 0) + 1
      st.maxInflight[id] = Math.max(st.maxInflight[id] ?? 0, st.inflight[id])
    }
    if (latency) await sleep(latency)
    for (const id of ids) st.inflight[id] -= 1
    const status = refuse(w.json)
    if (status) return { status, body: { error: 'e2e refused this write' } }
    applyLight(st.lights, w.json)
    return ok({ ok: true })
  })
  return st
}

/** The Lights box as the screen draws it: the all-lights bar, one chip per bulb, the presets, in their order. */
function lightsBox() {
  const box = document.querySelector('.vl-page[data-active] .hm-lights')
  if (!box) return null
  const chips = [...box.querySelectorAll('.hm-chip')].map((c) => ({
    name: (c.querySelector('.hm-chip-name')?.textContent || '').trim(),
    on: c.hasAttribute('data-on'),
    na: c.hasAttribute('data-na'),
    pct: (c.querySelector('.hm-chip-v')?.textContent || '').trim(),
    sw: c.getAttribute('aria-label'),
    color: getComputedStyle(c).getPropertyValue('--c').trim(),
    // a chip carries no level bar of its own (2026-10-19: one bar for the room)
    bar: !!c.querySelector('.hm-sl, .hm-chip-bar, [role="slider"]'),
  }))
  const r = box.querySelector('.hm-allbar')
  const sl = r?.querySelector('.hm-sl[role="slider"]')
  const room = r ? {
    label: (r.querySelector('.hm-allbar-name')?.textContent || '').trim(),
    on: r.hasAttribute('data-on'),
    pct: (r.querySelector('.hm-allbar-pct')?.textContent || '').trim(),
    slider: sl ? { label: sl.getAttribute('aria-label'), now: sl.getAttribute('aria-valuenow') } : null,
    color: getComputedStyle(r).getPropertyValue('--c').trim(),
  } : null
  const presets = [...box.querySelectorAll('.hm-pre')].map((p) => ({ label: (p.getAttribute('aria-label') || '').split(',')[0], on: p.getAttribute('aria-pressed') === 'true' }))
  // the parts in the order they read: presets (pres), the all-lights bar (room), the chips
  const order = [...box.querySelectorAll('.hm-pres, .hm-allbar, .hm-chips')].map((e) => (e.classList.contains('hm-pres') ? 'presets' : e.classList.contains('hm-allbar') ? 'bar' : 'chips'))
  return {
    chips, room, presets, order,
    sliders: box.querySelectorAll('[role="slider"]').length,
    oldRows: box.querySelectorAll('.hm-bulb, .hm-bulb-pw').length,
    value: (box.querySelector('.hm-g-value')?.textContent || '').replace(/\s+/g, ' ').trim(),
    plate: box.querySelector('.hm-plate')?.getAttribute('aria-label') ?? null,
    model: !!box.querySelector('[data-wire-scene]'),
  }
}

/** A bulb's switch: its chip (every screen). */
const switchOf = (name) => ({ sel: '.vl-page[data-active] .hm-lights .hm-chip', text: new RegExp(`\\b${name}\\b`) })

async function isOn(page, name) {
  return page.eval((n) => {
    const box = document.querySelector('.vl-page[data-active] .hm-lights')
    const el = [...box.querySelectorAll('.hm-chip')].find((e) => new RegExp(`\\b${n}\\b`).test(e.getAttribute('aria-label') || ''))
    return el ? el.getAttribute('aria-pressed') === 'true' : null
  }, name)
}

/** A chip's figure ("40%", "Off", "n/a") by the bulb's name. */
async function chipPct(page, name) {
  return page.eval((n) => {
    const el = [...document.querySelectorAll('.vl-page[data-active] .hm-lights .hm-chip')].find((e) => (e.querySelector('.hm-chip-name')?.textContent || '').trim() === n)
    return el ? (el.querySelector('.hm-chip-v')?.textContent || '').trim() : null
  }, name)
}

/** The all-lights bar's track in viewport px (it is scrolled into view first). */
async function roomBar(page) {
  return page.eval(() => {
    const sl = document.querySelector('.vl-page[data-active] .hm-lights .hm-allbar .hm-sl')
    if (!sl) return null
    sl.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = sl.getBoundingClientRect()
    return { l: r.left, w: r.width, y: r.top + r.height / 2 }
  })
}

async function lightsUp(page) {
  await shellUp(page)
  await page.waitFor(() => {
    const box = document.querySelector('.vl-page[data-active] .hm-lights')
    return box && box.querySelectorAll('.hm-chip').length >= 5 && !box.querySelector('.hm-plate')?.disabled
  }, { timeout: 15_000, message: 'the Lights box never listed the five fake bulbs' })
  await sleep(500)
}

/**
 * n quick presses on one spot, `gap` ms apart (no wait for anything in between).
 * The presses go out on the clock, not one per answered frame: a browser that
 * draws slowly (odin's has no GPU, and the phone's Dashboard now draws its
 * stage on the first screen) took over 1.5 s to answer three presses one at a
 * time, which is no longer fast. The answers are collected at the end.
 */
async function burst(page, target, n, gap = 110) {
  const at = await page.locate(target)
  if (at.error) throw new Error(at.error)
  const sent = []
  const go = (method, params) => { sent.push(page.send(method, params)) }
  for (let k = 0; k < n; k++) {
    if (page.dev.mobile) {
      go('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] })
      await sleep(40)
      go('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      go('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
      go('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await sleep(30)
      go('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    }
    if (k < n - 1) await sleep(gap)
  }
  await Promise.all(sent)
  await sleep(80)
}

function lightsTests() {
  const out = []
  // one bar for the room, every bulb as a chip in its real color, the preset at full scale; no writes
  for (const [device, wide] of [['desk1080', true], ['ipad', true], ['phone', false]]) {
    out.push({
      name: `dash:lights:list:${device}`,
      group: 'dashboard',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        fakeHA(page)
        await page.goto('/m/dashboard')
        await lightsUp(page)
        const b = await page.eval(lightsBox)
        const list = b.chips
        t.check(sameSet(list.map((x) => x.name), ['Desk', 'Lamp', 'Strip', 'Office', 'Shelf']), `the Lights box lists ${JSON.stringify(list.map((x) => x.name))}, want all five bulbs`)
        t.check(!b.oldRows, `the ${device} still draws ${b.oldRows} per-bulb row part(s)`)
        t.check(list.every((x) => !x.bar), `a bulb chip carries its own bar: ${JSON.stringify(list.filter((x) => x.bar).map((x) => x.name))}`)
        t.check(list.filter((x) => !x.na).every((x) => /^Turn .+ (on|off)$/.test(x.sw ?? '')), `a reachable chip is not its bulb's switch: ${JSON.stringify(list.map((x) => x.sw))}`)
        const desk = list.find((x) => x.name === 'Desk')
        const lamp = list.find((x) => x.name === 'Lamp')
        const strip = list.find((x) => x.name === 'Strip')
        t.check(desk?.on && /78/.test(desk.pct), `Desk should read on at 78% ("${desk?.pct}")`)
        t.check(lamp && !lamp.on && /off/i.test(lamp.pct), `Lamp should read off ("${lamp?.pct}")`)
        t.check(strip?.na && /unavailable|n\/a/i.test(strip.pct), `the unreachable bulb does not say so ("${strip?.pct}")`)
        t.check(/^rgb\(\s*2\d\d,\s*\d{1,2},\s*\d{1,2}\s*\)$|#[ef][0-9a-f]0{4}|red/i.test(desk?.color ?? ''), `Desk's color is "${desk?.color}", want its red`)
        // the one bar: the room's level the head reads (Desk 78, Office 50, Shelf 25: 51%), in the lit bulbs' red
        t.check(b.sliders === 1, `the Lights box has ${b.sliders} brightness bars, want the one all-lights bar`)
        t.check(b.room && /^All lights$/i.test(b.room.label), `no all-lights bar (${JSON.stringify(b.room)})`)
        if (b.room) {
          const head = /·\s*(\d+)%/.exec(b.value)?.[1]
          t.check(b.room.on && head === '51' && b.room.slider?.now === '51' && /^51%$/.test(b.room.pct), `the all-lights bar reads ${b.room.pct} (bar at ${b.room.slider?.now}) and the head "${b.value}", want both at the room's 51%`)
          t.check(/all lights/i.test(b.room.slider?.label ?? ''), `the bar is labeled "${b.room.slider?.label}"`)
          t.check(/^rgb\(\s*2\d\d,\s*\d{1,2},\s*\d{1,2}\s*\)$|#[ef][0-9a-f]0{4}|red/i.test(b.room.color), `the bar's color is "${b.room.color}", want the lit bulbs' red`)
        }
        const want = wide ? 'presets>bar>chips' : 'bar>chips>presets'
        t.check(b.order.join('>') === want, `the Lights box reads ${b.order.join(' > ')}, want ${want.replace(/>/g, ' > ')}`)
        t.check(/3 of 4 on/.test(b.value), `the Lights head reads "${b.value}", want 3 of 4 on`)
        t.check(b.presets.length === 8, `${b.presets.length} presets, want all 8`)
        const lit = b.presets.filter((p) => p.on).map((p) => p.label)
        t.check(lit.length === 1 && lit[0] === 'Red', `the lit preset is ${JSON.stringify(lit)}, want Red (a red of 224 is Red at full scale)`)
        t.check(b.plate === 'Turn all lights off', `the all-lights plate says "${b.plate}"`)
        // the apartment left the Dashboard (2026-10-19): its place in the column holds This device
        t.check(!b.model, 'the Lights box still draws the apartment model')
        await t.shot(page)
        t.check(!page.writes.length, `the Dashboard wrote ${page.writes.length} time(s) on its own`)
      },
    })
  }

  // fast chip presses under a slow Home Assistant
  for (const device of ['desk1080', 'phone']) {
    out.push({
      name: `dash:lights:taps:${device}`,
      group: 'dashboard',
      device,
      timeout: 70_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const ha = fakeHA(page, { latency: 1500 })
        await page.goto('/m/dashboard')
        await lightsUp(page)

        await t.step('one chip tap: one command for that bulb, exactly as pressed', async () => {
          await page.tap(switchOf('Lamp'))
          const w = await waitW(page, 1)
          t.check(w.json?.entity_id === ID('Lamp') && w.json?.state === 'on' && Object.keys(w.json).length === 2, `Lamp's chip sent ${w.body}`)
          await page.waitFor(() => {
            const box = document.querySelector('.vl-page[data-active] .hm-lights')
            const el = [...box.querySelectorAll('.hm-chip')].find((e) => /\bLamp\b/.test(e.getAttribute('aria-label') || ''))
            return el?.getAttribute('aria-pressed') === 'true'
          }, { timeout: 1000, message: 'Lamp did not show on at once (the press waited for the slow call)' })
          await sleep(3200)
          t.check(page.writes.length === 1, `one chip tap sent ${page.writes.length} commands`)
          t.check(await isOn(page, 'Lamp') === true, 'Lamp fell back off after the call landed')
        })

        await t.step('three fast taps on a lit bulb: off, then the newest, and it ends off', async () => {
          const from = ha.log.length
          await burst(page, switchOf('Desk'), 3)
          await sleep(4500)
          const sent = ha.log.slice(from).filter((u) => u.entity_id === ID('Desk'))
          t.check(sent.length >= 1 && sent.length <= 2, `3 taps sent ${sent.length} Desk command(s): ${JSON.stringify(sent.map((u) => u.state))}, want them to collapse to 2 at most`)
          t.check(sent.at(-1)?.state === 'off', `the last Desk command was ${sent.at(-1)?.state}, want off (three taps from on)`)
          t.check(ha.lights.find((l) => l.entity_id === ID('Desk'))?.on === false, 'the fake bulb is not off at the end')
          t.check(await isOn(page, 'Desk') === false, 'the Dashboard does not show Desk off at the end')
        })

        await t.step('four fast taps: it ends where the fourth put it', async () => {
          const from = ha.log.length
          await burst(page, switchOf('Shelf'), 4)
          await sleep(4500)
          const sent = ha.log.slice(from).filter((u) => u.entity_id === ID('Shelf'))
          t.check(sent.length >= 1 && sent.length <= 3, `4 taps sent ${sent.length} Shelf commands: ${JSON.stringify(sent.map((u) => u.state))}`)
          t.check(sent.at(-1)?.state === 'on', `the last Shelf command was ${sent.at(-1)?.state}, want on (four taps from on)`)
          t.check(ha.lights.find((l) => l.entity_id === ID('Shelf'))?.on === true, 'the fake Shelf is not on at the end')
          await sleep(1500)
          t.check(await isOn(page, 'Shelf') === true, 'the Dashboard does not show Shelf on at the end')
        })

        await t.step('a preset, then a switch at once: sent in that order', async () => {
          const from = ha.log.length
          await page.tap({ sel: '.vl-page[data-active] .hm-lights .hm-pre', text: /\bBlue, for the lights that are on/ })
          await page.tap(switchOf('Office'))
          await sleep(4500)
          const sent = ha.log.slice(from)
          const pre = sent.findIndex((u) => JSON.stringify(u.rgb_color) === '[70,130,255]')
          const sw = sent.findIndex((u) => u.entity_id === ID('Office') && u.state === 'off')
          t.check(pre >= 0, `no Blue preset command went out: ${JSON.stringify(sent)}`)
          t.check(sw >= 0, `no Office switch command went out: ${JSON.stringify(sent)}`)
          t.check(pre < sw, `the switch went before the preset: ${JSON.stringify(sent)}`)
          const blue = sent[pre]
          if (blue) t.check(blue.brightness === undefined && blue.color_temp_kelvin === undefined && blue.state === 'on', `the preset carried more than a color: ${JSON.stringify(blue)}`)
        })

        t.note(`commands in arrival order: ${ha.log.map((u) => `${Array.isArray(u.entity_id) ? `[${u.entity_id.map((x) => x.replace('light.e2e_', '')).join('+')}]` : u.entity_id.replace('light.e2e_', '')} ${u.state}${u.rgb_color ? ` rgb ${u.rgb_color}` : ''} at +${u.at - ha.log[0].at} ms`).join(', ')}`)
        const over = Object.entries(ha.maxInflight).filter(([, n]) => n > 1)
        t.check(!over.length, `two commands for one bulb were in flight at once: ${over.map(([id, n]) => `${id} x${n}`).join(', ')}`)
        await t.shot(page)
      },
    })
  }

  // the all-lights bar (mouse on the monitor, a finger on the phone), then the plate and its Undo
  for (const device of ['desk1080', 'phone']) out.push({
    name: `dash:lights:bar-and-undo:${device}`,
    group: 'dashboard',
    device,
    timeout: 70_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      const ha = fakeHA(page, { latency: 300 })
      await page.goto('/m/dashboard')
      await lightsUp(page)
      const lit = ['Desk', 'Office', 'Shelf'].map(ID)

      await t.step('a drag on the all-lights bar sends one command, on release, for the bulbs that are on', async () => {
        const bar = await roomBar(page)
        if (!bar) throw new Error('no all-lights bar in the Lights box')
        await sleep(300)
        const from = ha.log.length
        await page.swipe(bar.l + bar.w * 0.2, bar.y, bar.l + bar.w * 0.4, bar.y, { steps: 10, ms: 300 })
        await sleep(1500)
        const sent = ha.log.slice(from)
        t.check(sent.length === 1, `a bar drag sent ${sent.length} commands: ${JSON.stringify(sent)}`)
        const b = sent[0]
        if (b) {
          t.check(Array.isArray(b.entity_id) && sameSet(b.entity_id, lit) && b.state === 'on', `the drag sent ${JSON.stringify(b)}, want the three lit bulbs (never Lamp, which is off, or Strip, which is unreachable) on`)
          t.check(typeof b.brightness === 'number' && Math.abs(b.brightness - 102) <= 6, `the drag to 40% sent brightness ${b.brightness}, want about 102`)
          t.check(b.rgb_color === undefined && b.color_temp_kelvin === undefined, `the bar carried a color: ${JSON.stringify(b)}`)
        }
        // the fake applied it: every lit chip reads the new level, Lamp stays off, and the bar holds it
        await sleep(1200)
        const pcts = {}
        for (const n of ['Desk', 'Office', 'Shelf', 'Lamp']) pcts[n] = await chipPct(page, n)
        t.check(['Desk', 'Office', 'Shelf'].every((n) => /^(39|40|41)%$/.test(pcts[n] ?? '')) && /^off$/i.test(pcts.Lamp ?? ''), `after the drag the chips read ${JSON.stringify(pcts)}, want the lit three at 40% and Lamp Off`)
        t.check(ha.lights.find((l) => l.entity_id === ID('Lamp'))?.on === false, 'the bar turned Lamp on')
        const room = (await page.eval(lightsBox))?.room
        t.check(room && /^(39|40|41)%$/.test(room.pct) && /^(39|40|41)$/.test(room.slider?.now ?? ''), `the all-lights bar reads ${room?.pct} (at ${room?.slider?.now}) after the drag, want 40%`)
        await t.shot(page, 'bar')
      })

      await t.step('all off, then Undo: only the bulbs that were on come back', async () => {
        const before = ha.lights.filter((l) => l.on && !l.unavailable).map((l) => l.entity_id)
        const from = ha.log.length
        const since = Date.now()
        await page.tap('.vl-page[data-active] .hm-lights .hm-plate')
        await page.waitToast(/All lights off/, { since })
        await sleep(800)
        const off = ha.log.slice(from)[0]
        t.check(off?.state === 'off' && sameSet(off.entity_id, ['Desk', 'Lamp', 'Office', 'Shelf'].map(ID)), `all off sent ${JSON.stringify(off)}, want the four reachable bulbs off`)
        await page.tap({ sel: '.vl-toast-btn', text: /Undo/ })
        await sleep(1500)
        const back = ha.log.slice(from)[1]
        t.check(back?.state === 'on' && sameSet(back.entity_id, before), `Undo sent ${JSON.stringify(back)}, want ${JSON.stringify(before)} on`)
        t.check(sameSet(ha.lights.filter((l) => l.on).map((l) => l.entity_id), before), 'after Undo the lit bulbs are not the ones that were lit')
      })

      await t.step('every bulb off: a bar drag sends nothing and says to turn a light on', async () => {
        let since = Date.now()
        await page.tap('.vl-page[data-active] .hm-lights .hm-plate')
        await page.waitToast(/All lights off/, { since })
        await sleep(1200)
        const room = (await page.eval(lightsBox))?.room
        t.check(room && !room.on && /^off$/i.test(room.pct), `with every bulb off the all-lights bar reads ${JSON.stringify(room)}, want Off`)
        const bar = await roomBar(page)
        if (!bar) throw new Error('no all-lights bar in the Lights box')
        await sleep(300)
        const writes = page.writes.length
        since = Date.now()
        await page.swipe(bar.l + bar.w * 0.2, bar.y, bar.l + bar.w * 0.6, bar.y, { steps: 10, ms: 300 })
        await page.waitToast(/Turn a light on first/, { since })
        await sleep(800)
        t.check(page.writes.length === writes, `a bar drag with every bulb off sent ${page.writes.length - writes} command(s): ${page.writes.slice(writes).map((w) => w.body).join(' | ')}`)
        t.check(ha.lights.every((l) => !l.on), 'a bulb came on from the all-lights bar')
      })
    },
  })

  out.push({
    name: 'dash:lights:refused:phone',
    group: 'dashboard',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakeHA(page, { latency: 400, refuse: (u) => (u.entity_id === ID('Lamp') ? 500 : 0) })
      await page.goto('/m/dashboard')
      await lightsUp(page)
      const since = Date.now()
      await page.tap(switchOf('Lamp'))
      // the toast carries the reason the server gave
      await page.waitToast(/Could not turn Lamp on: e2e refused this write/, { since })
      await page.waitFor(() => {
        const el = [...document.querySelectorAll('.vl-page[data-active] .hm-chip')].find((e) => /\bLamp\b/.test(e.getAttribute('aria-label') || ''))
        return el?.getAttribute('aria-pressed') === 'false'
      }, { timeout: 4000, message: 'Lamp did not fall back to off after the refusal' })
    },
  })
  return out
}

// ---------- the Lights tab: the same fast presses through src/lib/lights.ts's send queue ----------

function lightsTabTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `lights:fast:${device}`,
      group: 'lights',
      device,
      timeout: 70_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const ha = fakeHA(page, { latency: 1500 })
        let inflight = 0
        let maxAll = 0
        const handler = page.writeHandler
        page.onWrite(async (w) => {
          inflight++
          maxAll = Math.max(maxAll, inflight)
          try { return await handler(w) } finally { inflight-- }
        })
        await page.goto('/m/lights')
        await shellUp(page)
        await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .lt-tg').length >= 4, { timeout: 15_000, message: 'Lights did not list the fake bulbs' })
        await sleep(600)
        const tg = (name) => ({ sel: '.vl-page[data-active] .lt-tg', text: new RegExp(`\\b${name}\\b`) })
        const tgOn = (name) => page.eval((n) => [...document.querySelectorAll('.vl-page[data-active] .lt-tg')].find((e) => new RegExp(`\\b${n}\\b`).test(e.getAttribute('aria-label') || ''))?.getAttribute('aria-pressed') === 'true', name)

        await t.step('three fast taps on a lit bulb end off, with no older command last', async () => {
          const from = ha.log.length
          await burst(page, tg('Desk'), 3)
          await sleep(4500)
          const sent = ha.log.slice(from).filter((u) => u.entity_id === ID('Desk') || (Array.isArray(u.entity_id) && u.entity_id.includes(ID('Desk'))))
          t.check(sent.length >= 1 && sent.length <= 2, `3 taps sent ${sent.length} Desk commands: ${JSON.stringify(sent.map((u) => u.state))}`)
          t.check(sent.at(-1)?.state === 'off', `the last Desk command was ${sent.at(-1)?.state}, want off`)
          t.check(ha.lights.find((l) => l.entity_id === ID('Desk'))?.on === false, 'the fake Desk is not off at the end')
          await sleep(2500)
          t.check(await tgOn('Desk') === false, 'Lights does not show Desk off 2.5 s after the last answer')
        })

        await t.step('Red, Blue, Green in quick succession: the bulbs end Green and the plate stays Green', async () => {
          const from = ha.log.length
          for (const name of ['Red', 'Blue', 'Green']) {
            await page.tap({ sel: '.vl-page[data-active] .lt-pre', text: new RegExp(`^\\s*${name}\\b`) }, { wait: 1500 })
            await sleep(60)
          }
          await sleep(5000)
          const sent = ha.log.slice(from)
          const green = JSON.stringify([80, 230, 110])
          t.check(sent.length >= 1 && sent.length <= 3, `three presets sent ${sent.length} commands: ${JSON.stringify(sent.map((u) => u.rgb_color))}`)
          t.check(JSON.stringify(sent.at(-1)?.rgb_color) === green, `the last preset command was ${JSON.stringify(sent.at(-1)?.rgb_color)}, want Green ${green}`)
          const lit = ha.lights.filter((l) => l.on && !l.unavailable)
          t.check(lit.length > 0 && lit.every((l) => JSON.stringify(l.rgb_color) === green), `the fake bulbs ended ${JSON.stringify(lit.map((l) => [l.name, l.rgb_color]))}, want every lit one Green`)
          const plate = () => page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .lt-pre')].find((e) => e.getAttribute('aria-checked') === 'true')?.querySelector('.lt-pre-name')?.textContent?.trim() ?? null)
          t.check(await plate() === 'Green', `the lit preset is ${await plate()}, want Green`)
          await sleep(3000)
          t.check(await plate() === 'Green', 'the lit preset moved off Green after the bulbs settled')
        })
        t.check(maxAll <= 1, `${maxAll} light commands were in flight at once; the send queue keeps it to one`)
        const over = Object.entries(ha.maxInflight).filter(([, n]) => n > 1)
        t.check(!over.length, `two commands for one bulb were in flight at once: ${over.map(([id, n]) => `${id} x${n}`).join(', ')}`)
        t.note(`commands in arrival order: ${ha.log.map((u) => `${Array.isArray(u.entity_id) ? `[${u.entity_id.map((x) => x.replace('light.e2e_', '')).join('+')}]` : u.entity_id.replace('light.e2e_', '')} ${u.state}${u.rgb_color ? ` rgb ${u.rgb_color}` : ''}`).join(', ')}`)
        await t.shot(page)
      },
    })
  }
  return out
}

// ---------- trade ----------

/** The real status bent to a known age: `sampledAgo` ms since the broker read (null: day-open), `cash` the cash in it. */
function tradeAt(real, { sampledAgo = 60_000, cash = 'some', newestAgo = null } = {}) {
  const t = tradeStatus(real)
  const now = Date.now()
  const eq = t.portfolio.live_equity
  if (sampledAgo == null) {
    t.portfolio.live_equity_source = 'day_open'
    t.portfolio.live_equity_age_min = null
    t.portfolio.live_equity_sampled_at = null
    t.portfolio.newest_sample_at = newestAgo != null ? iso(now - newestAgo) : null
  } else {
    t.portfolio.live_equity_source = 'sample'
    t.portfolio.live_equity_age_min = Math.round(sampledAgo / 600) / 100
    t.portfolio.live_equity_sampled_at = iso(now - sampledAgo)
    t.portfolio.newest_sample_at = iso(now - sampledAgo)
  }
  t.portfolio.live_cash = cash === 'all' ? eq : Math.round(eq * 0.4 * 100) / 100
  return t
}

function tradeMocks(page, st) {
  page.mock('/api/tradebot/status', () => ok(st.status))
  page.mock('/api/tradebot/page', () => ok({ ...st.page, status: st.status }))
}

function tradeBoxRead() {
  const box = document.querySelector('.vl-page[data-active] .hm-trade')
  const chart = box ? [...box.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 40 && r.height > 40).length : 0
  return {
    box: !!box,
    ticker: !!box?.querySelector('.hm-tk'),
    anyTicker: !!document.querySelector('.vl-page[data-active] .hm-tk'),
    kind: box?.querySelector('.hm-trade-what')?.getAttribute('data-kind') ?? null,
    what: (box?.querySelector('.hm-trade-what')?.textContent || '').replace(/\s+/g, ' ').trim(),
    eq: (box?.querySelector('.hm-trade-eq')?.textContent || '').trim(),
    chart,
    // layout px (offsetHeight is not scaled by the desktop app's UI zoom)
    chartH: box?.querySelector('.hm-trade-chart')?.offsetHeight ?? 0,
    grow: !!box?.classList.contains('hm-grow'),
    text: (box?.innerText || '').replace(/\s+/g, ' '),
  }
}

function tradeTests() {
  const out = []
  for (const device of ['desk1080', 'ipad', 'desktop', 'phone']) {
    out.push({
      name: `dash:trade:${device}`,
      group: 'dashboard',
      device,
      timeout: 50_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const st = { status: tradeAt(t.env.trade, { sampledAgo: 60_000 }), page: tradePage(t.env.trade) }
        tradeMocks(page, st)
        await page.goto('/m/dashboard')
        await shellUp(page)
        if (device === 'phone') {
          await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-tk'), { timeout: 12_000, message: 'no trade ticker on the phone Dashboard' })
          const r = await page.eval(tradeBoxRead)
          t.check(!r.box, 'the phone Dashboard shows the whole trade box; it keeps the ticker line only')
          return
        }
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-trade .hm-trade-what'), { timeout: 12_000, message: 'no trade box on the Dashboard' })
        await sleep(1200)
        let r = await page.eval(tradeBoxRead)
        t.check(r.ticker, 'the trade box lost the ticker as its head')
        t.check(r.kind === 'live' && /^Live\b/i.test(r.what), `a broker read 1 minute old reads "${r.what}" (${r.kind}), want Live`)
        const want = `$${Math.trunc(st.status.portfolio.live_equity).toLocaleString('en-US')}`
        t.check(r.eq.startsWith(want), `the equity reads "${r.eq}", want ${want}`)
        t.check(r.chart >= 1, 'the trade box has no equity chart')
        t.check(!/Unchanged since/i.test(r.text), `the trade box says "Unchanged since": ${r.text.slice(0, 200)}`)
        // "way too tall" (2026-11-19): a short chart of its own, never stretched to fill its column
        t.check(r.chartH >= 118 && r.chartH <= 172, `the equity chart is ${r.chartH} layout px tall, want 120 to 170`)
        t.check(!r.grow, 'the trade box stretches to fill its column')
        await t.shot(page, 'live')

        // an old read and the day-open fallback are labeled as what they are
        st.status = tradeAt(t.env.trade, { sampledAgo: 2 * 3_600_000 })
        await page.eval(() => window.dispatchEvent(new Event('focus')))
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-trade .hm-trade-what')?.getAttribute('data-kind') === 'read', { timeout: 12_000, message: 'a 2 h old read is not labeled "Last read"' })
        r = await page.eval(tradeBoxRead)
        t.check(/Last read 2h ago/.test(r.what), `a 2 h old read says "${r.what}"`)
        st.status = tradeAt(t.env.trade, { sampledAgo: null, newestAgo: 3 * 3_600_000 })
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-trade .hm-trade-what')?.getAttribute('data-kind') === 'day_open', { timeout: 12_000, message: 'the day-open fallback is not labeled as such' })
        r = await page.eval(tradeBoxRead)
        t.check(/Day-open figure, not live/.test(r.what), `the day-open figure says "${r.what}"`)
      },
    })
  }

  for (const device of ['desk1080', 'phone']) {
    out.push({
      name: `trade:live:${device}`,
      group: 'trades',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const st = { status: tradeAt(t.env.trade, { sampledAgo: 60_000, cash: 'all' }), page: tradePage(t.env.trade) }
        tradeMocks(page, st)
        const read = () => page.eval(() => {
          const root = document.querySelector('.vl-page[data-active]')
          return {
            kind: root?.querySelector('.sys-trade-what')?.getAttribute('data-kind') ?? null,
            what: (root?.querySelector('.sys-trade-what')?.textContent || '').trim(),
            warn: [...(root?.querySelectorAll('.sys-trade-warn') ?? [])].map((e) => (e.textContent || '').trim()),
            text: (root?.innerText || '').replace(/\s+/g, ' '),
          }
        })
        await page.goto('/m/system/trades')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .sys-trade-what'), { timeout: 12_000, message: 'System > Trades shows no equity label' })
        await sleep(800)
        let r = await read()
        t.check(r.kind === 'live' && /^Live\b/.test(r.what), `a broker read 1 minute old reads "${r.what}" (${r.kind}), want Live`)
        t.check(!/Unchanged since/i.test(r.text), 'System > Trades says "Unchanged since" for a live read')
        t.check(!/repeated figure/i.test(r.text), 'System > Trades calls a live read a repeated figure')
        t.check(r.warn.some((w) => /All cash, no open positions/.test(w)), `cash equal to the total does not say All cash (${JSON.stringify(r.warn)})`)
        await t.shot(page, 'live')

        // day-open: says when the broker was last read, never "Unchanged since"
        st.status = tradeAt(t.env.trade, { sampledAgo: null, newestAgo: 30 * 60_000 })
        await page.goto('/m/system/trades')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .sys-trade-what')?.getAttribute('data-kind') === 'day_open', { timeout: 12_000, message: 'the day-open fallback is not labeled as such' })
        r = await read()
        t.check(r.warn.some((w) => /^Not a live reading\. Last broker read .+; this is the bot's day-open total\.$/.test(w)), `the day-open note reads ${JSON.stringify(r.warn)}`)
        t.check(!/Unchanged since/i.test(r.text), 'System > Trades still says "Unchanged since"')

        // the real status, read once at the start: a sample under 12 minutes old must read Live
        const real = t.env.trade?.portfolio
        const at = real?.live_equity_sampled_at ? Date.parse(real.live_equity_sampled_at) : NaN
        if (real?.live_equity_source === 'sample' && Number.isFinite(at) && Date.now() - at < 12 * 60_000) {
          const p2 = await t.page()
          quietThor(p2)
          await p2.goto('/m/system/trades')
          await p2.waitFor(() => document.querySelector('.vl-page[data-active] .sys-trade-what'), { timeout: 15_000, message: 'System > Trades shows no equity label on live data' })
          await sleep(800)
          const live = await p2.eval(() => ({ kind: document.querySelector('.vl-page[data-active] .sys-trade-what')?.getAttribute('data-kind'), what: document.querySelector('.vl-page[data-active] .sys-trade-what')?.textContent?.trim() }))
          t.check(live.kind === 'live', `odin's own status has a ${Math.round((Date.now() - at) / 60_000)} min old broker read, and System > Trades says "${live.what}"`)
        } else {
          t.note(`odin's own status has no fresh broker read (source ${real?.live_equity_source ?? 'none'}, sampled ${real?.live_equity_sampled_at ?? 'never'}): the live-data check was skipped`)
        }
      },
    })
  }
  return out
}

// ---------- media posters in the desktop app ----------

/** Every Plex image on the active screen: where it loads from and whether it did. */
function posterReport(sel) {
  const root = document.querySelector('.vl-page[data-active]')
  const imgs = [...(root?.querySelectorAll(`${sel} img`) ?? [])].filter((i) => /\/plex\/img\?/.test(i.src))
  const holders = [...(root?.querySelectorAll(sel) ?? [])]
  const count = (a) => a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})
  return {
    holders: holders.length,
    states: count(holders.map((h) => h.getAttribute('data-state') || 'none')),
    imgs: imgs.length,
    loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.replace(/token=[^&]+/, 'token=<t>')).slice(0, 3),
    bases: [...new Set(imgs.map((i) => i.src.split('/plex/img')[0]))],
    tokens: [...new Set(imgs.map((i) => new URL(i.src).searchParams.get('token')))],
  }
}

/** Waits until the active screen's posters under `sel` have loaded (at least `min`), then reports them. */
async function postersLoaded(page, sel, min, what) {
  await page.eval(() => { for (const i of document.querySelectorAll('img[loading="lazy"]')) i.loading = 'eager' })
  await page.waitFor((s, m) => {
    const root = document.querySelector('.vl-page[data-active]')
    const imgs = [...(root?.querySelectorAll(`${s} img`) ?? [])].filter((i) => /\/plex\/img\?/.test(i.src))
    return imgs.filter((i) => i.complete && i.naturalWidth > 0).length >= m
  }, { args: [sel, min], timeout: 20_000, interval: 300, message: `${what}: fewer than ${min} posters loaded` }).catch((e) => e)
  await sleep(1200)
  return page.eval(posterReport, sel)
}

const ODIN = 'http://odin:8420'
const REMOTE = 'http://e2e-remote.test'
const IMG_TOKEN = 'e2e-img-token'

function mediaTests() {
  return [
    {
      name: 'dash:media:tauri-odin',
      group: 'dashboard',
      device: 'desk1080',
      timeout: 90_000,
      async run(t) {
        const page = await t.page({ scripts: [tauriStub()], apiHosts: [{ origin: ODIN, healthz: true }] })
        quietThor(page)
        await page.goto('/m/dashboard')
        await shellUp(page)
        const dash = await postersLoaded(page, '.hm-media .hm-poster', 4, 'Dashboard')
        t.check(page.hostApi.some((r) => r.path.startsWith('/api/')), 'the app never moved its API base to odin (no request reached it)')
        t.check(dash.loaded >= 4, `the Dashboard loaded ${dash.loaded} of ${dash.imgs} posters (states ${JSON.stringify(dash.states)})`)
        t.check(!dash.broken.length, `broken posters on the Dashboard: ${dash.broken.join(', ')}`)
        t.check(dash.bases.length === 1 && dash.bases[0] === `${ODIN}/api`, `Dashboard posters load from ${JSON.stringify(dash.bases)}, want odin's base the app moved to`)
        t.check(dash.tokens.every((x) => x === null), 'posters on the tailnet base carry an image token (they need none)')
        t.check(!dash.states.err, `${dash.states.err} Dashboard poster(s) show the title-only fallback`)
        // 1920x1080: the stage is the Dashboard's picture; the newest addition is named under the posters
        const newest = await page.eval(() => ({
          ban: !!document.querySelector('.vl-page[data-active] .hm-ban'),
          cap: (document.querySelector('.vl-page[data-active] .hm-media-cap')?.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        t.check(!newest.ban, 'a 1920x1080 Dashboard still draws the newest-addition banner (a 2560 px monitor only)')
        t.check(/^Newest \S/.test(newest.cap), `the newest addition is not named under the posters ("${newest.cap}")`)
        await t.shot(page, 'dash')

        await page.tap({ sel: '.vl-nav .vl-tab-prim', text: 'Media' })
        await page.waitPath(/^\/m\/media(\/dashboard)?$/)
        const media = await postersLoaded(page, '.vm-art', 6, 'Media > Dashboard')
        t.check(media.loaded >= 6, `Media > Dashboard loaded ${media.loaded} of ${media.imgs} images (states ${JSON.stringify(media.states)})`)
        t.check(!media.broken.length, `broken images on Media > Dashboard: ${media.broken.join(', ')}`)
        t.check(media.bases.length === 1 && media.bases[0] === `${ODIN}/api`, `Media > Dashboard images load from ${JSON.stringify(media.bases)}`)
        await t.shot(page, 'media')
        t.check(!page.writes.length, 'a write was sent')
      },
    },
    {
      name: 'dash:media:remote-token',
      group: 'dashboard',
      device: 'desktop',
      timeout: 90_000,
      async run(t) {
        // the desktop app off the tailnet: its bundle carries a remote API (the production
        // .env's VITE_API_URL), the tailnet probe fails, and every image needs the token
        const page = await t.page({
          scripts: [tauriStub()],
          apiHosts: [{ origin: REMOTE, healthz: false, imgToken: IMG_TOKEN }],
          patch: [{ path: '/src/lib/api.ts', from: 'const configuredApiUrl = import.meta.env.VITE_API_URL', to: `const configuredApiUrl = ${JSON.stringify(REMOTE)}` }],
        })
        quietThor(page)
        let tokenReads = 0
        page.mock('/api/plex/img-token', () => { tokenReads++; return ok({ token: IMG_TOKEN, expiresAt: Date.now() + 12 * 3_600_000 }) })
        await page.goto('/m/dashboard')
        await shellUp(page)
        const dash = await postersLoaded(page, '.hm-media .hm-poster', 4, 'Dashboard on a remote base')
        t.check(page.hostApi.some((r) => r.path.startsWith('/api/')), 'the app never used the remote base (the module patch did not take)')
        t.check(tokenReads >= 1, 'the page never asked for the image token on a base that needs one')
        t.check(dash.loaded >= 4, `the Dashboard loaded ${dash.loaded} of ${dash.imgs} posters on a remote base (states ${JSON.stringify(dash.states)})`)
        t.check(dash.bases.length === 1 && dash.bases[0] === `${REMOTE}/api`, `Dashboard posters load from ${JSON.stringify(dash.bases)}, want the remote base`)
        t.check(dash.tokens.length === 1 && dash.tokens[0] === IMG_TOKEN, `Dashboard posters carry tokens ${JSON.stringify(dash.tokens)}, want the image token on every one`)
        await t.shot(page, 'dash')
        await page.tap({ sel: '.vl-nav .vl-tab-prim', text: 'Media' })
        await page.waitPath(/^\/m\/media(\/dashboard)?$/)
        const media = await postersLoaded(page, '.vm-art', 6, 'Media > Dashboard on a remote base')
        t.check(media.loaded >= 6, `Media > Dashboard loaded ${media.loaded} of ${media.imgs} images on a remote base (states ${JSON.stringify(media.states)})`)
        t.check(media.bases.length === 1 && media.bases[0] === `${REMOTE}/api`, `images load from ${JSON.stringify(media.bases)}, want the remote base`)
        t.check(media.tokens.length === 1 && media.tokens[0] === IMG_TOKEN, `images carry tokens ${JSON.stringify(media.tokens)}, want the image token on every one`)
        const refused = page.hostApi.filter((r) => r.path === '/api/plex/img' && r.status === 401).length
        t.check(!refused, `${refused} image request(s) went out without the token and got the remote's 401`)
        await t.shot(page, 'media')
      },
    },
  ]
}

// ---------- layout: no Meals, three columns that fill the page ----------

/**
 * Every x-ray scene on the Dashboard: how many, which sit outside This device,
 * and how many draw the apartment (its fixtures are the bulb.* line groups).
 */
function dashboardScenes() {
  const root = document.querySelector('.vl-page[data-active]')
  const scenes = [...(root?.querySelectorAll('[data-wire-scene]') ?? [])]
  return {
    scenes: scenes.length,
    outside: scenes.filter((s) => !s.closest('.hm-dev-in')).map((s) => String(s.closest('.vl-panel, section, [class]')?.className ?? s.tagName).slice(0, 60)),
    apartment: scenes.filter((s) => (s.__wire?.r?.model?.styles ?? []).some((st) => typeof st?.group === 'string' && st.group.startsWith('bulb.'))).length,
    room: !!root?.querySelector('.hm-room, .lt-room'),
  }
}

/** No apartment anywhere on the Dashboard (2026-10-19): the one model it draws is This device's. */
function checkNoRoom(t, s) {
  t.check(!s.room, 'the Dashboard still has a room block')
  t.check(!s.apartment, `the Dashboard draws the apartment model (${s.apartment} scene(s) with bulb fixtures)`)
  t.check(!s.outside.length, `the Dashboard draws a model outside This device: ${s.outside.join(', ')}`)
  t.check(s.scenes <= 1, `the Dashboard draws ${s.scenes} models, want This device's alone`)
}

/** The page's scroll against its height, and where each column's last block ends. */
function pageFit() {
  const root = document.querySelector('.vl-page[data-active]')
  const ends = [...(root?.querySelectorAll('.hm-layout > .hm-col') ?? [])].map((c) => {
    const last = [...c.children].filter((e) => e.getBoundingClientRect().height > 0).at(-1)
    return last ? Math.round(last.getBoundingClientRect().bottom) : null
  })
  return { scrollH: root.scrollHeight, clientH: root.clientHeight, ends }
}

function layoutTests() {
  const out = []
  for (const device of ['phone', 'ipad', 'ipadland', 'desktop', 'desk1080', 'desk1440']) {
    out.push({
      name: `dash:layout:${device}`,
      group: 'dashboard',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        await page.goto('/m/dashboard')
        await shellUp(page)
        // the landscape iPad's board has no media block (a tab away)
        await page.waitFor((pad) => document.querySelector('.vl-page[data-active] .hm-lights') && (pad || document.querySelector('.vl-page[data-active] .hm-media')), { timeout: 12_000, args: [device === 'ipadland'], message: 'the Dashboard did not draw its blocks' })
        await sleep(2500)
        const r = await page.eval(() => {
          const root = document.querySelector('.vl-page[data-active]')
          const lay = root.querySelector('.hm-layout')
          const colOf = (sel) => {
            const el = root.querySelector(sel)
            const c = el?.closest('.hm-col')
            return c ? ['hm-a', 'hm-b', 'hm-c'].find((k) => c.classList.contains(k)) ?? '?' : null
          }
          // every block of the Dashboard as drawn (the columns dissolve on the phone), by area, largest first
          const area = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.width * b.height) }
          // the calendar's slot (a fill layout) is the column's room, not a block: the box inside it is
          const blocks = [...lay.querySelectorAll(':scope > .hm-stage, :scope > .hm-tk, .hm-col > *, .hm-pair > *, .hm-cal-slot .hm-cal')].filter((e) => !e.classList.contains('hm-pair') && !e.classList.contains('hm-cal-slot'))
          const stage = root.querySelector('.hm-stage')
          const sb = stage?.getBoundingClientRect()
          const lb = lay.getBoundingClientRect()
          const cs = getComputedStyle(lay)
          const colW = [...lay.querySelectorAll(':scope > .hm-col')].map((c) => Math.round(c.getBoundingClientRect().width))
          return {
            cols: lay?.getAttribute('data-cols') ?? null,
            meals: [...root.querySelectorAll('*')].some((e) => e.children.length === 0 && /\bMeals\b/.test(e.textContent || '')),
            mealsLink: !!root.querySelector('a[href*="/meals"], [data-to*="meals"]'),
            scrollH: root.scrollHeight, clientH: root.clientHeight,
            where: { lights: colOf('.hm-lights'), trade: colOf('.hm-trade'), media: colOf('.hm-media'), stage: colOf('.hm-stage'), ai: colOf('.hm-ai'), sys: colOf('.hm-sys'), cal: colOf('.hm-cal') },
            stage: stage ? {
              area: area(stage),
              biggest: blocks.every((e) => e === stage || area(e) <= area(stage)),
              bigger: blocks.filter((e) => e !== stage && area(e) > area(stage)).map((e) => String(e.className).slice(0, 40)),
              // how much of the layout's inner width it spans
              span: (sb.width / (lb.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))),
              top: Math.round(sb.top), bottom: Math.round(sb.bottom),
              before: ['.hm-lights', '.hm-starts, .hm-starts-empty', '.hm-ai', '.hm-sys'].every((q) => { const e = root.querySelector(q); return !e || !!(stage.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) }),
              afterTicker: (() => { const tk = lay.querySelector(':scope > .hm-tk'); return !tk || !!(tk.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING) })(),
              pair: !!root.querySelector('.hm-pair .hm-ai') && !!root.querySelector('.hm-pair .hm-sys'),
            } : null,
            colW,
            banner: !!root.querySelector('.hm-ban'),
            pad: !!lay.hasAttribute('data-pad'),
            tradeChart: root.querySelector('.hm-trade-chart')?.offsetHeight ?? null,
            H: innerHeight,
          }
        })
        t.check(!r.meals && !r.mealsLink, 'the Dashboard still has a Meals row')
        const desk = device.startsWith('desk')
        // the stage: the model of this device, the Dashboard's largest block on every screen
        if (t.check(r.stage, 'the Dashboard has no stage (This device)')) {
          // the phone's Lights box (every bulb and preset) runs longer than its stage; everywhere else the stage is the largest block
          if (r.cols !== '1') t.check(r.stage.biggest, `the stage (${r.stage.area} px2) is not the Dashboard's largest block: larger are ${JSON.stringify(r.stage.bigger)}`)
          if (r.cols !== '3') {
            t.check(r.stage.before && r.stage.afterTicker, 'the stage does not lead the Dashboard (under the trade ticker on the phone)')
            t.check(r.stage.span > 0.98, `the stage spans ${Math.round(r.stage.span * 100)}% of the ${device}'s width, want all of it`)
            t.check(r.stage.top >= 0 && r.stage.bottom <= r.H, `the stage is not whole on the first screen (${r.stage.top} to ${r.stage.bottom} of ${r.H})`)
          }
        }
        if (device === 'ipadland') {
          t.check(r.pad && r.cols === '3', `the landscape iPad has ${r.cols} columns${r.pad ? '' : ' and not its own board'}`)
          t.check(r.where.lights === 'hm-a' && r.where.cal === 'hm-a' && r.where.stage === 'hm-b' && r.where.ai === 'hm-b' && r.where.trade === 'hm-c' && r.where.sys === 'hm-c',
            `blocks sit in ${JSON.stringify(r.where)}, want lights and the calendar left, the stage and AI in the middle, trade and the hosts right`)
          t.check(r.scrollH <= r.clientH + 2, `the landscape iPad board scrolls (${r.scrollH} > ${r.clientH})`)
        }
        // the trade chart keeps its own short height wherever the box shows (the phone has the ticker only)
        if (r.tradeChart !== null) t.check(r.tradeChart >= 118 && r.tradeChart <= 172, `the equity chart is ${r.tradeChart} layout px tall, want 120 to 170`)
        if (desk) {
          t.check(r.cols === '3', `a monitor Dashboard has ${r.cols} columns, want 3`)
          const xl = device === 'desk1440'
          t.check(r.where.cal === 'hm-a' && r.where.stage === 'hm-b' && r.where.lights === 'hm-c' && r.where.trade === 'hm-c' && r.where.media === 'hm-c',
            `blocks sit in ${JSON.stringify(r.where)}, want the calendar left, the stage in the middle, lights, trade and media right`)
          t.check(r.stage?.pair && r.where.ai === 'hm-b' && r.where.sys === 'hm-b', `AI and the hosts are not side by side under the stage (${JSON.stringify(r.where)})`)
          t.check(r.colW.length === 3 && r.colW[1] > r.colW[0] * 1.4 && Math.abs(r.colW[0] - r.colW[2]) <= 2, `the columns are ${JSON.stringify(r.colW)} px wide, want the stage's the widest by half and the other two equal`)
          t.check(r.banner === xl, xl ? 'a 2560 px monitor lost the newest-addition banner' : 'the newest-addition banner is back on a 1920x1080 Dashboard')
          t.check(r.scrollH <= r.clientH + 2, `the monitor Dashboard scrolls (${r.scrollH} > ${r.clientH}): the columns should fill the page exactly`)
        }
        checkNoRoom(t, await page.eval(dashboardScenes))
        const lr = await page.eval(layoutReport)
        t.check(lr.docSW <= lr.W + 1, `the Dashboard is wider than the screen (${lr.docSW} > ${lr.W})`)
        await t.shot(page)
      },
    })
  }
  return out
}

// ---------- calendar: the week under day headings, New York time ----------

const NY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const NY_HEAD = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const keyPlus = (key, n) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** the instant New York's day `key` starts */
const nyStart = (key) => {
  const [y, m, d] = key.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d, 5)
  return NY_KEY.format(t - 3_600_000) === key ? t - 3_600_000 : t
}
/** `h:m` New York wall time on the day `n` days after today */
const nyAt = (n, h, m = 0) => nyStart(keyPlus(NY_KEY.format(Date.now()), n)) + (h * 60 + m) * 60_000

/**
 * A made-up week in /api/calendar/events' shape, generic names only. Today: an all-day event and
 * "Team sync" (a Teams link in its notes) 25 minutes out; tomorrow: two all-day events, "Standup"
 * at 9:30 (a Zoom link as its location) and "Budget review" at 2:00 PM in Room 4; three days on a
 * haircut; nothing on the other days. `live`: a focus block on now. `busy`: more rows than fit.
 * `long`: ten hour blocks on each of the seven days, a week far past any column (the line fitting
 * once crashed the Dashboard on one). `overnight`: a migration from soon to 3:00 AM tomorrow.
 */
function calWeek({ live = false, busy = false, long = false, overnight = false } = {}) {
  const now = Date.now()
  const t0 = NY_KEY.format(now)
  const day = (n) => nyStart(keyPlus(t0, n))
  const soon = Math.ceil((now + 25 * 60_000) / 60_000) * 60_000
  const ev = (uid, summary, start, end, extra = {}) => ({
    uid, summary, location: '', description: '', organizer: '', status: '', start: iso(start), end: iso(end),
    allDay: false, recurring: false, url: '', sourceId: 'work', sourceLabel: 'Work', color: '#44aaff', ...extra,
  })
  const events = [
    ev('e-allday', 'Trash day', day(0), day(1), { allDay: true, sourceLabel: 'Personal', color: '#00ff41' }),
    ev('e-sync', 'Team sync', soon, soon + 30 * 60_000, {
      location: 'Microsoft Teams Meeting',
      description: 'Join the meeting now <https://teams.microsoft.com/l/meetup-join/19%3ameeting_e2e%40thread.v2/0?context=e2e>\nMeeting options <https://teams.microsoft.com/meetingOptions/?organizerId=e2e>',
    }),
    ev('e-off1', 'Office closed', day(1), day(2), { allDay: true }),
    ev('e-off2', 'Filter change', day(1), day(2), { allDay: true, sourceLabel: 'Personal', color: '#00ff41' }),
    ev('e-standup', 'Standup', nyAt(1, 9, 30), nyAt(1, 9, 45), { location: 'https://us02web.zoom.us/j/1234567890?pwd=e2e' }),
    ev('e-budget', 'Budget review', nyAt(1, 14), nyAt(1, 15), { location: 'Room 4' }),
    ev('e-hair', 'Haircut', nyAt(3, 11), nyAt(3, 11, 45), { sourceLabel: 'Personal', color: '#00ff41' }),
  ]
  if (live) events.push(ev('e-focus', 'Focus block', now - 10 * 60_000, now + 50 * 60_000))
  if (busy) {
    for (let k = 0; k < 6; k++) events.push(ev(`e-busy${k}`, `Planning block ${k + 1}`, nyAt(5, 8 + k), nyAt(5, 8 + k, 45)))
  }
  if (long) {
    // today's blocks start after Team sync ends, so none is on now and Team sync stays the next event at any hour
    for (let d = 0; d < 7; d++) for (let k = 0; k < 10; k++) {
      if (d === 0 && nyAt(d, 8 + k) < soon + 30 * 60_000) continue
      events.push(ev(`e-long${d}-${k}`, `Block ${d}.${k}`, nyAt(d, 8 + k), nyAt(d, 8 + k, 45)))
    }
  }
  if (overnight) events.push(ev('e-night', 'Server migration', soon + 60 * 60_000, nyAt(1, 3), { location: 'Remote' }))
  return { events, t0, soon }
}

function calMocks(page, st) {
  page.mock('/api/calendar/events', () => ok({ events: st.week.events, tz: 'America/New_York', sources: [] }))
  // one overdue task, so the block's tasks line is the same on every run
  page.mock('/api/tasks', () => ok({
    view: 'open', today: st.week.t0, projects: [], areas: ['personal'],
    tasks: [{ ref: { kind: 'loose', id: 'e2etask00001' }, text: 'Send the invoice', due: keyPlus(st.week.t0, -1), done: false, doneAt: null, area: 'personal', project: null, list: null, createdAt: null }],
  }))
}

/** The Calendar block as drawn. */
function calRead() {
  const root = document.querySelector('.vl-page[data-active]')
  const cal = root?.querySelector('.hm-cal')
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const next = cal?.querySelector('.hm-cnext')
  const rows = [...(cal?.querySelectorAll('.hm-crow') ?? [])].map((r) => ({
    day: r.closest('.hm-cday')?.querySelector('.hm-cday-name')?.textContent ?? null,
    time: txt(r.querySelector('.hm-ctime')),
    title: txt(r.querySelector('.hm-ctitle')),
    place: txt(r.querySelector('.hm-cplace')),
    join: r.querySelector('a.hm-join')?.getAttribute('href') ?? null,
    allDay: r.hasAttribute('data-allday'),
  }))
  const slot = root?.querySelector('.hm-cal-slot')
  const b = (el) => (el ? el.getBoundingClientRect() : null)
  return {
    found: !!cal,
    tz: txt(cal?.querySelector('.hm-cal-tz')),
    value: txt(cal?.querySelector('.hm-g-value')),
    heads: [...(cal?.querySelectorAll('.hm-cday') ?? [])].map((d) => ({ name: d.querySelector('.hm-cday-name')?.textContent ?? '', date: d.querySelector('.hm-cday-date')?.textContent ?? null })),
    next: next ? {
      day: next.closest('.hm-cday')?.querySelector('.hm-cday-name')?.textContent ?? null,
      title: txt(next.querySelector('.hm-cnext-title')),
      when: txt(next.querySelector('.hm-cnext-when')),
      meta: txt(next.querySelector('.hm-cnext-meta')),
      join: next.querySelector('a.hm-join')?.getAttribute('href') ?? null,
      live: next.hasAttribute('data-live'),
    } : null,
    rows,
    soon: txt(cal?.querySelector('.hm-csoon')),
    more: txt(cal?.querySelector('.hm-cmore')),
    tasks: !!cal?.querySelector('.hm-tasks-head'),
    text: (cal?.innerText || '').replace(/\s+/g, ' '),
    slot: slot ? { calBottom: Math.round(b(cal).bottom), slotBottom: Math.round(b(slot).bottom) } : null,
    scrollH: root?.scrollHeight ?? 0,
    clientH: root?.clientHeight ?? 0,
  }
}

function calendarTests() {
  const out = []
  for (const device of ['phone', 'desktop', 'ipadland']) {
    out.push({
      name: `dash:calendar:${device}`,
      group: 'dashboard',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const st = { week: calWeek() }
        calMocks(page, st)
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-cnext'), { timeout: 15_000, message: 'the Calendar block never showed the next event' })
        await sleep(900)
        let r = await page.eval(calRead)
        const { t0, soon } = st.week
        const k3 = keyPlus(t0, 3)
        const fit = device !== 'phone'

        // the head says the zone once; the next event leads, 25 minutes out, its time range in ET and its Join link
        t.check(r.tz === 'ET', `the Calendar head reads "${r.tz}" for its zone, want ET`)
        // (run in the last 25 minutes of a New York day, the sync lands tomorrow)
        const wantLeft = soon < nyStart(keyPlus(t0, 1)) ? /^1 left today\b/ : /^Nothing left today\b/
        t.check(wantLeft.test(r.value), `the head value reads "${r.value}", want ${wantLeft}`)
        t.check(r.next?.title === 'Team sync' && /^in 2[4-6] min$/.test(r.next.when), `the next event reads ${JSON.stringify(r.next)}, want Team sync in 25 min`)
        // "9:30 to 10:00 AM ET", "11:45 AM to 12:15 PM ET" (Intl may put a narrow space before AM; the read folds spaces)
        const [ta, tb] = [NY_TIME.format(soon), NY_TIME.format(soon + 30 * 60_000)]
        const range = `${ta.slice(-2) === tb.slice(-2) ? ta.slice(0, -3) : ta} to ${tb} ET`.replace(/\s+/g, ' ')
        t.check(r.next?.meta === range, `the next event's time reads "${r.next?.meta}", want "${range}"`)
        t.check(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//.test(r.next?.join ?? ''), `the Teams meeting's Join goes to ${r.next?.join}, want its meetup-join link`)
        t.check(!/Microsoft Teams Meeting/.test(r.text), 'the block repeats "Microsoft Teams Meeting" next to its Join link')
        t.check(!/meetingOptions/.test(r.next?.join ?? ''), 'Join opens the meeting options page')

        // day headings: Today, Tomorrow, then weekday and date; empty days left out
        if (!fit) {
          const want = ['Today', 'Tomorrow', NY_HEAD.format(nyStart(k3) + 12 * 3_600_000)]
          t.check(r.heads.map((h) => h.name).join('|') === want.join('|'), `the day headings read ${JSON.stringify(r.heads.map((h) => h.name))}, want ${JSON.stringify(want)} (empty days left out)`)
          t.check(r.heads[0]?.date === NY_HEAD.format(nyStart(t0) + 12 * 3_600_000), `Today's heading carries "${r.heads[0]?.date}", want its date`)
          // tomorrow: both all-day events on one line, then the timed rows in New York time
          const tm = r.rows.filter((x) => x.day === 'Tomorrow')
          t.check(tm[0]?.allDay && tm[0].title === 'Office closed · Filter change' && tm[0].time === 'All day', `tomorrow's all-day line reads ${JSON.stringify(tm[0])}`)
          const standup = tm.find((x) => x.title === 'Standup')
          t.check(standup?.time === '9:30 AM' && /^https:\/\/us02web\.zoom\.us\/j\//.test(standup.join ?? '') && !standup.place, `Standup reads ${JSON.stringify(standup)}, want 9:30 AM with a Zoom Join and no bare link`)
          const budget = tm.find((x) => x.title === 'Budget review')
          t.check(budget?.time === '2:00 PM' && budget.place === 'Room 4' && !budget.join, `Budget review reads ${JSON.stringify(budget)}, want 2:00 PM in Room 4`)
          t.check(r.rows.some((x) => x.title === 'Trash day' && x.allDay && x.day === 'Today'), 'today\'s all-day event has no line of its own')
        } else {
          // a fill layout: the box ends inside its column, nothing scrolls
          t.check(r.slot && r.slot.calBottom <= r.slot.slotBottom + 1, `the Calendar box runs past its column (${JSON.stringify(r.slot)})`)
          t.check(r.scrollH <= r.clientH + 2, `the Dashboard scrolls (${r.scrollH} > ${r.clientH}) with the calendar's week on it`)
          t.check(r.heads[0]?.name === 'Today', `the first day heading reads "${r.heads[0]?.name}", want Today`)
          t.check(!r.heads.some((h) => h.name === NY_HEAD.format(nyStart(keyPlus(t0, 2)) + 12 * 3_600_000)), 'an empty day has a heading')
        }
        t.check(r.tasks, 'the block lost its tasks line')
        const lr = await page.eval(layoutReport)
        t.check(lr.docSW <= lr.W + 1, `the Dashboard is wider than the screen (${lr.docSW} > ${lr.W})`)
        await t.shot(page, 'week')

        // a meeting on now leads with Now and when it ends; the next one says when it starts
        st.week = calWeek({ live: true, busy: fit })
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-cnext[data-live]'), { timeout: 15_000, message: 'an event on now does not lead the block' })
        await sleep(900)
        r = await page.eval(calRead)
        t.check(r.next?.title === 'Focus block' && r.next.when === 'Now' && /^Until \d{1,2}:\d{2} [AP]M ET$/.test(r.next.meta), `the live event reads ${JSON.stringify(r.next)}, want Focus block, Now, Until ... ET`)
        if (!fit) t.check(/^in 2[4-6] min$/.test(r.soon), `the next event after it says "${r.soon}", want in 25 min`)
        if (fit) {
          // more than fits: the rest folds into one line, the event on now stays
          t.check(/^\+\d+ more this week$/.test(r.more), `a busy week ends with "${r.more}", want "+N more this week"`)
          t.check(r.slot && r.slot.calBottom <= r.slot.slotBottom + 1 && r.scrollH <= r.clientH + 2, `a busy week runs past the column (${JSON.stringify(r.slot)}, ${r.scrollH} > ${r.clientH})`)
        }
        await t.shot(page, 'live')

        // a day heading opens the calendar on that day: the sheet on the phone, the Calendar page on a wide
        // screen (the landscape iPad's short column may end before tomorrow: then today's heading)
        const target = r.heads.some((h) => h.name === 'Tomorrow') ? 'Tomorrow' : 'Today'
        const tomorrow = target === 'Tomorrow' ? keyPlus(t0, 1) : t0
        await page.tap({ sel: '.vl-page[data-active] .hm-cday-head', text: new RegExp(`^${target}`) })
        if (device === 'phone') {
          await page.waitFor(() => document.querySelector('.cal-root[data-shown] .cal-ui[data-layout="sheet"]'), { timeout: 12_000, message: 'the Tomorrow heading did not open the calendar sheet' })
          await sleep(500)
          t.check(await page.eval(() => /Tomorrow/i.test(document.querySelector('.cal-root .cal-bar-rel')?.textContent ?? '')), 'the sheet did not open on tomorrow')
        } else {
          await page.waitFor(() => location.pathname === '/m/calendar', { timeout: 12_000, message: 'the Tomorrow heading did not open the Calendar page' })
          const q = await page.eval(() => location.search)
          t.check(new URLSearchParams(q).get('date') === tomorrow, `the ${target} heading opened the Calendar page on ${q}, want date=${tomorrow}`)
        }
      },
    })
  }
  return out
}

/**
 * The Calendar block's edges: a week far longer than the monitor's column folds into "+N more" in
 * a few renders (no "Maximum update depth" crash: a console error fails the test by itself), and
 * a timed event over midnight leads once, its end named with its day.
 */
function calendarEdgeTests() {
  return [{
    name: 'dash:calendar:long-week:desk1080',
    group: 'dashboard',
    device: 'desk1080',
    timeout: 60_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      const st = { week: calWeek({ long: true }) }
      calMocks(page, st)
      await page.goto('/m/dashboard')
      await shellUp(page)
      await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-cmore'), { timeout: 15_000, message: 'a long week never folded into "+N more"' })
      await sleep(900)
      const r = await page.eval(calRead)
      t.check(r.next?.title === 'Team sync', `the next event reads ${JSON.stringify(r.next)}, want Team sync kept`)
      t.check(/^\+\d+ more this week$/.test(r.more), `a long week ends with "${r.more}", want "+N more this week"`)
      t.check(r.slot && r.slot.calBottom <= r.slot.slotBottom + 1 && r.scrollH <= r.clientH + 2, `a long week runs past the column (${JSON.stringify(r.slot)}, ${r.scrollH} > ${r.clientH})`)
      await t.shot(page, 'long')
    },
  }, {
    name: 'dash:calendar:overnight:phone',
    group: 'dashboard',
    device: 'phone',
    timeout: 60_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      const st = { week: calWeek({ overnight: true }) }
      st.week.events = st.week.events.filter((e) => e.uid !== 'e-sync')
      calMocks(page, st)
      await page.goto('/m/dashboard')
      await shellUp(page)
      await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-cnext'), { timeout: 15_000, message: 'the Calendar block never showed the next event' })
      await sleep(900)
      const r = await page.eval(calRead)
      const n = await page.eval(() => document.querySelectorAll('.vl-page[data-active] .hm-cal .hm-cnext').length)
      t.check(n === 1, `${n} events lead the block, want 1 (an event over midnight leads once)`)
      // (run in the last 85 minutes of a New York day, the migration starts tomorrow: only the count holds)
      if (st.week.soon + 3_600_000 >= nyStart(keyPlus(st.week.t0, 1))) return
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(nyAt(1, 3))
      t.check(r.next?.title === 'Server migration' && r.next.meta.includes(`to ${wd} 3:00 AM ET`), `the overnight event reads ${JSON.stringify(r.next)}, want its end as "${wd} 3:00 AM ET"`)
      t.check(r.rows.some((x) => x.title === 'Server migration' && x.time === 'Cont.'), 'the overnight event has no Cont. row on its second day')
    },
  }]
}

// ---------- this device: the model of the machine the page runs on ----------

/** /api/hosts with every case the box words differently: thor up, mimir down, Loki on battery, the phone reporting, the tablet before its first battery reading, and a car (generic name). */
function deviceHosts() {
  const now = Date.now()
  const load = (host, label, os, extra = {}) => ({
    host, label, os, online: true, stale: false, ts: now, uptime: 90_000,
    cpu: { usage: 23, cores: 16 }, memory: { percent: 41, used: 13 * 1024 ** 3, total: 32 * 1024 ** 3 }, disk: { percent: 62, used: 1.2e12, total: 2e12 },
    history: [], ...extra,
  })
  const ios = (host, extra) => ({ host, label: host, os: 'ios', online: true, stale: false, ts: now - 60_000, seen: now - 60_000, uptime: null, cpu: null, memory: null, disk: null, battery: null, history: [], ...extra })
  // thor's last hour: a sample a minute, CPU 20-50%, memory 40-42%
  const hour = Array.from({ length: 60 }, (_, k) => ({ t: now - (59 - k) * 60_000, cpu: 20 + ((k * 7) % 31), mem: 40 + (k % 3), disk: 62 }))
  return {
    hosts: [
      load('thor', 'thor', 'windows', { history: hour }),
      load('odin', 'odin', 'linux'),
      load('frame', 'loki', 'linux', { battery: { percent: 72, status: 'discharging' } }),
      { host: 'mimir', label: 'mimir', os: 'windows', online: false, stale: false, ts: now - 86_400_000, uptime: null, cpu: null, memory: null, disk: null, history: [] },
      ios('phone', { battery: { percent: 64, status: 'not charging' }, disk: { used: 101e9, total: 256e9, percent: 39.5 } }),
      ios('tablet', {}),
      carHost('car_a', 'Car A'),
    ],
  }
}

/** The This device block as drawn: its model, words, rows, place, and the model's projected outline against its box. */
function deviceReport() {
  const root = document.querySelector('.vl-page[data-active]')
  const inner = root?.querySelector('.hm-dev-in')
  if (!inner) return { error: 'no This device block' }
  const scene = inner.querySelector('[data-wire-scene]')
  const e = scene?.__wire
  const press = inner.querySelector('.hm-dev-press')
  const col = inner.closest('.hm-col')
  const stage = inner.closest('.hm-stage')
  // where the stage sits: its column's blocks in order (a monitor), or the layout's own children (phone, upright iPad)
  const kind = (c) => (c.contains(inner) ? 'stage' : c.classList.contains('hm-pair') ? 'ai+sys' : c.classList.contains('hm-tk') ? 'ticker' : c.classList.contains('hm-rv') ? 'raven' : c.classList.contains('hm-col') ? 'col' : 'other')
  const order = [...(col ?? stage?.parentElement)?.children ?? []].map(kind)
  let outline = null
  let spots = {}
  if (e?.r?.model) {
    const c = e.r.model
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < c.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c.pos[i + k]); hi[k] = Math.max(hi[k], c.pos[i + k]) }
    const out = [0, 0, 0]
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
      if (!e.cam.project(x, y, z, out)) { ok = false; continue }
      x0 = Math.min(x0, out[0]); x1 = Math.max(x1, out[0]); y0 = Math.min(y0, out[1]); y1 = Math.max(y1, out[1])
    }
    // the anchor in the scene's own px
    const sr = scene.getBoundingClientRect()
    const ar = inner.querySelector('.hm-dev-anchor').getBoundingClientRect()
    const k = sr.width / e.r.w
    const a = { l: (ar.left - sr.left) / k, r: (ar.right - sr.left) / k, t: (ar.top - sr.top) / k, b: (ar.bottom - sr.top) / k }
    outline = { ok, w: e.r.w, h: e.r.h, x0, y0, x1, y1, a, k, sl: sr.left, st: sr.top, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, moving: JSON.stringify(e.cam.cur) !== JSON.stringify(e.cam.to), yaw: e.cam.dragYaw }
    // every part of the model as the live camera projects it now, in the scene's px
    for (const h of c.hotspots) spots[h.id] = e.cam.project(h.at[0], h.at[1], h.at[2], out) ? [out[0], out[1]] : null
  }
  // each number: its box and its bar's ends in the scene's px, and its leader line (where it starts and ends)
  const px = (r) => outline ? { l: (r.left - outline.sl) / outline.k, r: (r.right - outline.sl) / outline.k, t: (r.top - outline.st) / outline.k, b: (r.bottom - outline.st) / outline.k } : null
  const reads = [...inner.querySelectorAll('.hm-dev-row')].map((row) => {
    const key = row.getAttribute('data-k')
    const g = inner.querySelector(`.hm-dev-lines g[data-k="${key}"]`)
    const nums = ((g?.querySelector('path')?.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g) || []).map(Number)
    return {
      key,
      side: row.closest('.hm-dev-rows')?.getAttribute('data-side') ?? null,
      box: px(row.getBoundingClientRect()),
      bar: px(row.querySelector('.hm-mini-bar').getBoundingClientRect()),
      line: g ? { opacity: parseFloat(getComputedStyle(g).opacity), from: nums.slice(0, 2), to: nums.slice(-2) } : null,
    }
  })
  const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
  const ib = inner.getBoundingClientRect()
  return {
    cap: (inner.querySelector('.hm-dev-top > span')?.textContent || '').replace(/\s+/g, ' ').trim(),
    box: { l: Math.round(ib.left), t: Math.round(ib.top), w: Math.round(ib.width), h: Math.round(ib.height) },
    visible: ib.width >= 120 && ib.height >= 80 && ib.top >= -1 && ib.bottom <= innerHeight + 1 && ib.left >= -1 && ib.right <= innerWidth + 1,
    hero: inner.querySelector('.vl-hero')?.getAttribute('data-hero') ?? null,
    name: (inner.querySelector('.hm-dev-name')?.textContent || '').trim(),
    state: (inner.querySelector('.hm-dev-state')?.textContent || '').replace(/\s+/g, ' ').trim(),
    rows: [...inner.querySelectorAll('.hm-dev-row')].map((r) => `${(r.querySelector('.hm-dev-k')?.textContent || '').trim()} ${(r.querySelector('.hm-mini-v')?.textContent || '').trim()}`),
    sizes: [...inner.querySelectorAll('.hm-dev-row')].map((r) => (r.querySelector('.hm-dev-sz')?.textContent || '').trim()),
    hint: (inner.querySelector('.hm-dev-hint')?.textContent || '').trim(),
    // the last hour: its caption and how many line segments each series draws
    hist: (() => {
      const h = inner.querySelector('.hm-dev-hist')
      if (!h || !shown(h)) return null
      const seg = (sel) => ((h.querySelector(sel)?.getAttribute('d') || '').match(/[ML]/g) || []).length
      const sv = h.querySelector('svg')?.getBoundingClientRect()
      return { cap: (h.querySelector('.hm-dev-hist-cap')?.textContent || '').replace(/\s+/g, ' ').trim(), cpu: seg('.hm-spark-cpu'), mem: seg('.hm-spark-mem'), h: sv ? Math.round(sv.height) : 0, w: sv ? Math.round(sv.width) : 0 }
    })(),
    reads, spots,
    layout: inner.getAttribute('data-reads'),
    tall: inner.hasAttribute('data-tall'),
    // the last hour's foot against the stage's
    histEnd: Math.round(inner.querySelector('.hm-dev-hist')?.getBoundingClientRect().bottom ?? 0),
    aria: press?.getAttribute('aria-label') ?? '',
    order, inCol: col ? ['hm-a', 'hm-b', 'hm-c'].find((k) => col.classList.contains(k)) ?? '?' : null,
    path: location.pathname,
    diamonds: [...inner.querySelectorAll('[data-hotspot]')].filter(shown).length,
    orbit: shown(inner.querySelector('[data-orbit-zone]')),
    outline,
  }
}

/**
 * Holds the desktop app's local_hostname answer back `ms` (run after the Tauri
 * stub): a Dashboard that draws a guess before the name answers gets caught.
 */
const slowHostname = (ms) => `(() => {
  const t = window.__TAURI_INTERNALS__
  if (!t) return
  const inv = t.invoke
  t.invoke = (cmd, args) => (cmd === 'local_hostname' ? new Promise((r) => setTimeout(r, ${ms})).then(() => inv(cmd, args)) : inv(cmd, args))
})()`

/** Every model This device draws, in order, from the first paint (window.__devHeroes). */
const HERO_WATCH = `(() => {
  const seen = window.__devHeroes = []
  const look = () => {
    for (const el of document.querySelectorAll('.hm-dev-in .vl-hero[data-hero]')) {
      const id = el.getAttribute('data-hero')
      if (seen[seen.length - 1] !== id) seen.push(id)
    }
  }
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hero'] })
})()`

function deviceTests() {
  const LOAD = ['CPU 23%', 'Memory 41%', 'Disk 62%']
  const SIZES = ['16 cores', '13.0 / 32.0 GB', '1.2 / 2.0 TB']
  // thor's fake last hour peaks at 50% CPU
  const HOUR_CAP = /^Last hour\s*CPU\s*Mem\s*peak 50%$/
  const cases = [
    { name: 'app-thor', device: 'desk1080', app: 'THOR', want: 'thor', label: 'Thor', state: /^Online · up 25h 0m$/, rows: LOAD, sizes: SIZES, hour: true },
    { name: 'app-thor-1600', device: 'desktop', app: 'thor', want: 'thor', label: 'Thor', state: /^Online · up 25h 0m$/, rows: LOAD, sizes: SIZES, hour: true },
    { name: 'app-thor-1440', device: 'desk1440', app: 'thor', want: 'thor', label: 'Thor', state: /^Online · up 25h 0m$/, rows: LOAD, sizes: SIZES, hour: true, tall: true },
    { name: 'app-mimir', device: 'desk1440', app: 'mimir', want: 'mimir', label: 'Mimir', state: /^Offline$/, rows: [], sizes: [] },
    { name: 'app-mimir-1080', device: 'desk1080', app: 'mimir', want: 'mimir', label: 'Mimir', state: /^Offline$/, rows: [], sizes: [] },
    { name: 'browser', device: 'desktop', want: 'thor', label: 'Thor', state: /^Online/, rows: LOAD, sizes: SIZES, hour: true },
    { name: 'headset', device: 'desktop', storage: { 'valkyrie-device-mode': 'vr' }, want: 'frame', label: 'Loki', state: /^Online/, rows: [...LOAD, 'Battery 72%'], sizes: [...SIZES, ''] },
    { name: 'phone', device: 'phone', want: 'phone', label: 'Phone', state: /^Online$/, rows: ['Battery 64%', 'Storage 40%'], sizes: ['', '101 / 256 GB'] },
    // the iPad once it reports: two numbers beside a wide slab stand in the stage's lower corners
    { name: 'ipad-reads', device: 'ipad', want: 'tablet', label: 'Tablet', state: /^Online$/, rows: ['Battery 81%', 'Storage 25%'], sizes: ['', '64 / 256 GB'], foot: true, tablet: { battery: { percent: 81, status: 'discharging' }, disk: { used: 64e9, total: 256e9, percent: 25 } } },
    { name: 'ipadland', device: 'ipadland', want: 'tablet', label: 'Tablet', state: /^Online$/, rows: [], sizes: [], hint: /No battery reading yet/, pad: true },
    { name: 'ipad', device: 'ipad', want: 'tablet', label: 'Tablet', state: /^Online$/, rows: [], sizes: [], hint: /No battery reading yet/ },
  ]
  return cases.map((c) => ({
    name: `dash:device:${c.name}`,
    group: 'dashboard',
    device: c.device,
    timeout: 45_000,
    async run(t) {
      const page = await t.page({ storage: c.storage ?? {}, scripts: [...(c.app ? [tauriStub({ hostname: c.app }), slowHostname(1200)] : []), HERO_WATCH] })
      quietThor(page)
      const doc = deviceHosts()
      if (c.tablet) Object.assign(doc.hosts.find((h) => h.host === 'tablet'), c.tablet)
      page.mock('/api/hosts', () => ok(doc))
      await page.goto('/m/dashboard')
      await shellUp(page)
      await page.waitFor(() => !!document.querySelector('.vl-page[data-active] .hm-dev-in [data-wire-scene]')?.__wire, { timeout: 15_000, message: 'This device drew no model' })
      if (c.app) {
        const asked = (await page.eval(() => (window.__tauriCalls ?? []).filter((x) => x.cmd === 'local_hostname').length)) ?? 0
        t.check(asked >= 1, 'the desktop app never asked its machine name (local_hostname)')
      }
      // on screen (an off-screen scene does not draw), then the camera flies to the fitted pose once the column has its height: read it once it holds still
      await page.eval(() => document.querySelector('.vl-page[data-active] .hm-dev-in').scrollIntoView({ block: 'center', behavior: 'instant' }))
      let r
      for (let k = 0; k < 30; k++) {
        await sleep(250)
        r = await page.eval(deviceReport)
        if (r.error || (r.outline && !r.outline.moving && k >= 3)) break
      }
      if (r.error) throw new Error(r.error)
      t.check(!r.outline?.moving, 'the camera never settled on This device')
      t.note(`${c.name}: ${r.hero} "${r.name}" "${r.state}" [${r.rows.join(', ')}] order ${r.order.join(' > ')}`)
      // how fast this browser draws the stage (odin's has no GPU): frames in one second, and the scene's own draw time
      const pace = await page.eval(() => new Promise((res) => {
        let n = 0
        const t0 = performance.now()
        const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res({ fps: n, ms: document.querySelector('.vl-page[data-active] .hm-dev-in [data-wire-scene]')?.getAttribute('data-ms') ?? null }) }
        requestAnimationFrame(tick)
      }))
      t.note(`${c.name}: the stage draws at ${pace.fps} frames a second here, ${pace.ms} ms of drawing a frame`)
      t.check(r.hero === c.want, `This device draws ${r.hero}, want ${c.want}`)
      const heroes = (await page.eval(() => window.__devHeroes ?? [])) ?? []
      t.check(heroes.join('>') === c.want, `This device drew ${heroes.join(' > ') || 'nothing'} on the way; want ${c.want} alone (no other model first)`)
      t.check(/^this device$/i.test(r.cap), `the block's caption reads "${r.cap}", want This device`)
      t.check(r.visible, `This device is not on screen (${JSON.stringify(r.box)})`)
      t.check(r.name === c.label, `This device is named "${r.name}", want ${c.label}`)
      t.check(c.state.test(r.state), `This device reads "${r.state}", want ${c.state}`)
      // the numbers stand on the side their part is on, so their order follows the model: compare them as a set, each with what it is out of
      const pairs = (rows, sizes) => rows.map((x, k) => `${x} (${sizes[k] ?? ''})`).sort().join('|')
      t.check(pairs(r.rows, r.sizes) === pairs(c.rows, c.sizes), `This device's numbers are ${JSON.stringify(r.rows)} out of ${JSON.stringify(r.sizes)}, want ${JSON.stringify(c.rows)} out of ${JSON.stringify(c.sizes)}`)
      if (c.hour) {
        t.check(r.hist && HOUR_CAP.test(r.hist.cap), `This device's last hour reads ${JSON.stringify(r.hist)}, want "Last hour CPU Mem peak 50%"`)
        if (r.hist) t.check(r.hist.cpu >= 59 && r.hist.mem >= 59 && r.hist.h >= 18 && r.hist.w >= 100, `the last hour draws CPU ${r.hist.cpu} and memory ${r.hist.mem} points in ${r.hist.w}x${r.hist.h}, want the 60 samples each in a visible line`)
        // the last hour runs along the stage's foot
        const bottom = r.box.t + r.box.h
        t.check(bottom - r.histEnd >= 0 && bottom - r.histEnd <= 24, `the last hour ends at ${r.histEnd}, the stage at ${bottom}: want it along the stage's foot`)
      } else {
        t.check(!r.hist, `This device draws a last hour it has no samples for: ${JSON.stringify(r.hist)}`)
      }
      if (c.tall != null) t.check(r.tall === c.tall, `This device ${r.tall ? 'is' : 'is not'} in its tall layout (${JSON.stringify(r.box)}), want ${c.tall ? 'tall' : 'short'}`)
      if (c.hint) t.check(c.hint.test(r.hint), `no battery hint (got "${r.hint}")`)
      else t.check(!r.hint, `a battery hint where a reading came in: "${r.hint}"`)
      const desk = c.device.startsWith('desk') || !!c.pad
      if (c.pad) t.check(r.inCol === 'hm-b' && r.order[0] === 'stage', `the landscape iPad's stage sits in ${r.inCol}, which reads ${r.order.join(' > ')}: want it at the head of the middle column`)
      else if (desk) t.check(r.inCol === 'hm-b' && r.order.join('>') === 'stage>ai+sys', `the stage sits in ${r.inCol}, which reads ${r.order.join(' > ')}: want the middle column as stage > AI and the hosts`)
      else t.check(r.inCol === null && /^(ticker>)?stage>raven>col>col$/.test(r.order.join('>')), `the layout reads ${r.order.join(' > ')}, want the stage across the top (under the ticker on the phone), Raven under it, then the columns`)
      checkNoRoom(t, await page.eval(dashboardScenes))
      // a monitor (and the app's window) shows the whole Dashboard: no scroll, the three columns ending together
      // (the left one ends with the calendar's slot: the room the block lists its days in)
      if (desk && !c.storage && !c.pad) {
        const f = await page.eval(pageFit)
        t.check(f.scrollH <= f.clientH + 2, `the Dashboard scrolls (${f.scrollH} > ${f.clientH}) with This device in the right column`)
        const ends = f.ends.filter((v) => v != null)
        t.check(ends.length === 3 && Math.max(...ends) - Math.min(...ends) <= 3, `the three columns end at ${JSON.stringify(f.ends)}, want them level`)
      }
      t.check(!r.diamonds, `the stage shows ${r.diamonds} of the engine's diamonds; its numbers mark the parts`)
      t.check(r.orbit, 'no orbit zone on the stage: a drag cannot turn the model')
      const o = r.outline
      t.check(o && o.ok, 'the model does not project through the live camera')
      if (o) {
        const in1 = (v, lo, hi) => v >= lo - 2 && v <= hi + 2
        t.check(in1(o.x0, 0, o.w) && in1(o.x1, 0, o.w) && in1(o.y0, 0, o.h) && in1(o.y1, 0, o.h), `the model runs out of its box: ${[o.x0, o.y0, o.x1, o.y1].map(Math.round)} in ${o.w}x${o.h}`)
        t.check(in1(o.cx, o.a.l, o.a.r) && in1(o.cy, o.a.t, o.a.b), `the model is not centered on its place in the stage: center ${Math.round(o.cx)},${Math.round(o.cy)}, anchor ${JSON.stringify(Object.fromEntries(Object.entries(o.a).map(([k, v]) => [k, Math.round(v)])))}`)
        // the model is the stage's subject: its outline takes most of its place one way or the other
        const fillW = (o.x1 - o.x0) / (o.a.r - o.a.l), fillH = (o.y1 - o.y0) / (o.a.b - o.a.t)
        t.check(Math.max(fillW, fillH) >= 0.85, `the model fills ${Math.round(fillW * 100)}% by ${Math.round(fillH * 100)}% of its place, want about 94% one way`)
        // every number off the model, on its own side, and tied to its part: the line starts at its bar's inner end and ends on the part
        const SPOT = { cpu: 'cpu', mem: 'mem', disk: 'disk', bat: 'battery' }
        for (const rd of r.reads) {
          const hit = rd.box && rd.box.l < o.x1 && rd.box.r > o.x0 && rd.box.t < o.y1 && rd.box.b > o.y0
          t.check(!hit, `the ${rd.key} number lies over the model: ${JSON.stringify(rd.box)} against the model's ${[o.x0, o.y0, o.x1, o.y1].map(Math.round)}`)
          const at = r.spots[SPOT[rd.key]]
          if (!t.check(at, `the ${r.hero} model has no ${SPOT[rd.key]} part for the ${rd.key} number`)) continue
          if (!t.check(rd.line && rd.line.opacity > 0.3 && rd.line.to.length === 2, `the ${rd.key} number has no leader line (${JSON.stringify(rd.line)})`)) continue
          t.check(Math.hypot(rd.line.to[0] - at[0], rd.line.to[1] - at[1]) <= 2.5, `the ${rd.key} line ends at ${rd.line.to.map(Math.round)}, its part is at ${at.map(Math.round)}`)
          const inner = rd.side === 'l' ? rd.bar.r : rd.bar.l
          t.check(Math.abs(rd.line.from[0] - inner) <= 8 && rd.line.from[1] >= rd.bar.t - 3 && rd.line.from[1] <= rd.bar.b + 3, `the ${rd.key} line starts at ${rd.line.from.map(Math.round)}, its bar's inner end is at ${Math.round(inner)},${Math.round((rd.bar.t + rd.bar.b) / 2)}`)
          t.check(rd.side === 'l' ? at[0] > rd.box.l : at[0] < rd.box.r, `the ${rd.key} number stands on the ${rd.side === 'l' ? 'left' : 'right'}, its part at x ${Math.round(at[0])} is on the other side of it`)
        }
        t.check(r.layout === (c.foot ? 'foot' : 'side'), `the numbers stand ${r.layout === 'foot' ? 'in the lower corners' : 'left and right of the model'}, want ${c.foot ? 'the lower corners' : 'left and right'}`)
      }
      t.check(new RegExp(`^This device, ${c.label}:`).test(r.aria), `the press says "${r.aria}"`)
      await t.shot(page, 'dash')
      // the model's own middle on screen
      const at = await page.eval(() => {
        const inner = document.querySelector('.vl-page[data-active] .hm-dev-in')
        inner.scrollIntoView({ block: 'center', behavior: 'instant' })
        const z = inner.querySelector('[data-orbit-zone]').getBoundingClientRect()
        return { x: z.left + z.width / 2, y: z.top + z.height / 2 }
      })
      await sleep(300)
      // a drag across the model turns it and stays on the Dashboard
      await page.swipe(at.x - 30, at.y, at.x + 50, at.y, { steps: 10, ms: 260 })
      // the turn's inertia dies out well inside this; the ease back starts 2.5 s after the release
      await sleep(700)
      const turned = await page.eval(deviceReport)
      t.check(turned.path === '/m/dashboard' || turned.path === '/m/dashboard/overview', `a drag on the model left the Dashboard for ${turned.path}`)
      t.check(Math.abs(turned.outline?.yaw ?? 0) > 5, `a drag on the model did not turn it (yaw ${turned.outline?.yaw})`)
      // turned, every line still ends on its part
      for (const rd of turned.reads) {
        const p = turned.spots[{ cpu: 'cpu', mem: 'mem', disk: 'disk', bat: 'battery' }[rd.key]]
        if (p && rd.line?.to.length === 2 && rd.line.opacity > 0) t.check(Math.hypot(rd.line.to[0] - p[0], rd.line.to[1] - p[1]) <= 4, `turned, the ${rd.key} line ends at ${rd.line.to.map(Math.round)}, its part is at ${p.map(Math.round)}`)
      }
      // a tap on the model opens System > Hosts with this device picked
      await page.tap({ x: at.x, y: at.y })
      await page.waitPath('/m/system/hosts', 6000)
      // the System tab mounts with its large model: on a slower browser (odin, no GPU) that takes
      // well over the old fixed 600 ms, so wait for its header rather than sleeping a set time
      const picked = await page.waitFor(() => (document.querySelector('.vl-page[data-active] .sys-detail-id')?.textContent || '').trim(), { timeout: 8000 }).catch(() => '')
      t.check(picked.toLowerCase().startsWith(c.label.toLowerCase()), `System > Hosts picked "${picked}", want ${c.label}`)
      await t.shot(page)
      t.check(!page.writes.length, `the Dashboard wrote ${page.writes.length} time(s)`)
    },
  }))
}

/** The Systems box's rows as drawn: name, the numbers and their icons, the press's words. */
function systemRows() {
  return [...document.querySelectorAll('.vl-page[data-active] .hm-sys .hm-hrow')].map((r) => ({
    name: (r.querySelector('.hm-hrow-name')?.textContent || '').trim(),
    car: r.hasAttribute('data-car'),
    off: r.hasAttribute('data-off'),
    minis: [...r.querySelectorAll('.hm-mini')].map((m) => `${m.getAttribute('title')}=${(m.querySelector('.hm-mini-v')?.textContent || '').trim()}${m.querySelector('.hm-mini-bar') ? '' : ' (no bar)'}`),
    aria: r.getAttribute('aria-label') || '',
  }))
}

function carTests() {
  return ['desk1080', 'phone'].map((device) => ({
    name: `dash:cars:${device}`,
    group: 'dashboard',
    device,
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      const doc = deviceHosts()
      doc.hosts.push(carHost('car_b', 'Car B', { state: 'asleep', charging: 'disconnected', battery: 54, range: 201 }))
      page.mock('/api/hosts', () => ok(doc))
      await page.goto('/m/dashboard')
      await shellUp(page)
      await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .hm-sys .hm-hrow[data-car]').length >= 2, { timeout: 15_000, message: 'the cars are not in the Systems box' })
      await sleep(500)
      const rows = await page.eval(systemRows)
      t.note(`rows: ${rows.map((r) => `${r.name} [${r.minis.join(', ')}]`).join(' | ')}`)
      const names = rows.map((r) => r.name)
      t.check(names.slice(-2).join('|') === 'Car A|Car B' && names.indexOf('Tablet') < names.indexOf('Car A'), `the Systems rows run ${names.join(', ')}, want the cars last`)
      const a = rows.find((r) => r.name === 'Car A')
      const b = rows.find((r) => r.name === 'Car B')
      t.check(a && a.car && a.minis.join('|') === 'Battery, charging=76%|Range=230mi (no bar)', `Car A's row shows ${JSON.stringify(a?.minis)}, want its battery (charging) and range`)
      t.check(a && !a.minis.some((m) => /^(CPU|Mem|Memory|Disk)=/.test(m)), `Car A's row shows CPU, memory or disk: ${JSON.stringify(a?.minis)}`)
      t.check(a && /^Car A: Battery, charging 76%, Range 230 mi\. Open in System$/.test(a.aria), `Car A's row says "${a?.aria}"`)
      t.check(b && !b.off && b.minis.join('|') === 'Battery=54%|Range=201mi (no bar)' && /^Car B: asleep, /.test(b.aria), `a sleeping car's row reads ${JSON.stringify(b)}, want a live row with its battery and range`)
      if (device.startsWith('desk')) {
        const f = await page.eval(pageFit)
        t.check(f.scrollH <= f.clientH + 2, `the Dashboard scrolls (${f.scrollH} > ${f.clientH}) with two cars in Systems`)
      }
      await t.shot(page, 'dash')
      await page.tap({ sel: '.vl-page[data-active] .hm-sys .hm-hrow', text: /^\s*Car A|Car A:/ })
      await page.waitPath('/m/system/hosts', 6000)
      // the System tab mounts with its large model: on a slower browser (odin, no GPU) that takes
      // well over the old fixed 600 ms, so wait for its header rather than sleeping a set time
      const picked = await page.waitFor(() => (document.querySelector('.vl-page[data-active] .sys-detail-id')?.textContent || '').trim(), { timeout: 8000 }).catch(() => '')
      t.check(/^Car A/.test(picked), `System > Hosts picked "${picked}", want Car A`)
      t.check(!page.writes.length, `the Dashboard wrote ${page.writes.length} time(s)`)
    },
  }))
}

// ---------- Raven: the block on Dashboard > Overview (Dashboard.tsx RavenBlock) ----------

/** The Raven block in one read. */
function ravenBlockSnap() {
  const root = document.querySelector('.vl-page[data-active]')
  const rv = root?.querySelector('.hm-rv')
  const lay = root?.querySelector('.hm-layout')
  const text = (who) => rv?.querySelector(`.hm-rv-text[data-who="${who}"]`)
  const lines = (el) => (el ? Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) : 0)
  const prev = rv?.previousElementSibling
  const W = document.documentElement.clientWidth
  const b = rv?.getBoundingClientRect()
  return {
    found: !!rv,
    status: rv?.querySelector('.hm-rv-status')?.textContent?.trim() ?? null,
    me: text('me')?.textContent ?? null,
    raven: text('raven')?.textContent ?? null,
    wait: !!rv?.querySelector('.hm-rv-wait'),
    meLines: lines(text('me')),
    ravenLines: lines(text('raven')),
    box: rv?.querySelector('.hm-rv-form input')?.value ?? null,
    focused: document.activeElement === rv?.querySelector('.hm-rv-form input'),
    // where it sits: right after the stage (phone, iPads) or right under Upload (monitors)
    after: prev ? (prev.classList.contains('hm-stage') ? 'stage' : prev.classList.contains('hm-up') ? 'upload' : prev.querySelector('.hm-starts, .hm-starts-empty') ? 'quick start' : String(prev.className).slice(0, 40)) : null,
    col: rv?.closest('.hm-col') ? ['hm-a', 'hm-b', 'hm-c'].find((k) => rv.closest('.hm-col').classList.contains(k)) : null,
    cols: lay?.getAttribute('data-cols') ?? null,
    pad: !!lay?.hasAttribute('data-pad'),
    inside: b ? b.left >= -0.5 && b.right <= W + 0.5 : false,
    fab: !!document.querySelector('.vl-shell > .rv-fab'),
    scrollH: root?.scrollHeight ?? 0,
    clientH: root?.clientHeight ?? 0,
    dash: /—/.test(rv?.innerText ?? ''),
  }
}

function ravenBlockTests() {
  const out = []
  for (const device of ['phone', 'ipad', 'ipadland', 'desktop', 'desk1440']) {
    out.push({
      name: `dash:raven:${device}`,
      group: 'dashboard',
      device,
      timeout: 300_000,
      async run(t) {
        const page = await t.page()
        const st = ravenBackend(page, { replyMs: 10_000 })
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-rv .hm-rv-x'), { timeout: 90_000, message: 'the Raven block did not show the last exchange' })
        await sleep(2500)
        const s = await page.eval(ravenBlockSnap)
        // the fake's newest line from him (106, two files) and Raven's own reply after it (107); the agent relay after that is not part of it
        t.check(s.status === 'idle', `the block's status reads ${JSON.stringify(s.status)}, want idle`)
        t.check(s.me === 'Here are the photo and the notes', `his last line reads ${JSON.stringify(s.me)}`)
        t.check(s.raven === 'Got both. The photo shows the jammed tray.', `Raven's line reads ${JSON.stringify(s.raven)}`)
        t.check(s.meLines >= 1 && s.meLines <= 2 && s.ravenLines >= 1 && s.ravenLines <= 2, `the exchange takes ${s.meLines} and ${s.ravenLines} lines, want one or two each`)
        t.check(!s.fab, 'the corner button shows on the Dashboard beside the Raven block')
        t.check(!s.dash, 'an em dash in the Raven block')
        t.check(s.inside, 'the Raven block runs past the screen')
        const desk = device.startsWith('desk')
        if (device === 'desktop' || desk) {
          t.check(s.cols === '3' && s.col === 'hm-a' && s.after === 'upload', `on a monitor the block sits in ${s.col} after ${s.after}, want the left column right under Upload`)
        } else if (device === 'ipadland') {
          t.check(s.pad && s.col === 'hm-b' && s.after === 'stage', `on the landscape iPad the block sits in ${s.col} after ${s.after}, want right under the stage`)
        } else {
          t.check(!s.col && s.after === 'stage', `on the ${device} the block sits after ${s.after} (column ${s.col}), want right under the stage`)
        }
        if (device !== 'phone' && device !== 'ipad') t.check(s.scrollH <= s.clientH + 2, `the Dashboard scrolls with the Raven block (${s.scrollH} > ${s.clientH})`)
        const lr = await page.eval(layoutReport)
        t.check(lr.docSW <= lr.W + 1, `the Dashboard is wider than the screen (${lr.docSW} > ${lr.W})${lr.wide?.length ? `: ${lr.wide.join(', ')}` : ''}`)
        await t.shot(page, 'idle')

        // a send: the button on a touch screen, Enter on a keyboard; the Raven screen's body (source app)
        const want = `Check the printer from ${device}`
        if (device === 'desktop' || desk) {
          await page.eval(() => document.querySelector('.vl-page[data-active] .hm-rv-form input')?.focus())
          await page.type(want)
          await page.key('Enter')
        } else {
          await page.tap({ sel: '.vl-page[data-active] .hm-rv-form input' }, { wait: 40_000 })
          await page.type(want)
          await page.tap({ sel: '.vl-page[data-active] .hm-rv-send' }, { wait: 40_000 })
        }
        const t0 = Date.now()
        while (!st.sent.length && Date.now() - t0 < 60_000) await sleep(100)
        t.check(st.sent.length === 1 && st.sent[0].text === want && st.sent[0].source === 'app' && !st.sent[0].files, `the send carried ${JSON.stringify(st.sent)}`)
        await page.waitFor((w) => {
          const rv = document.querySelector('.vl-page[data-active] .hm-rv')
          return rv?.querySelector('.hm-rv-text[data-who="me"]')?.textContent === w && rv.querySelector('.hm-rv-form input')?.value === ''
        }, { args: [want], timeout: 60_000, interval: 250, message: 'the sent line did not show in the block, or the box kept the text' })
          .catch(async (e) => t.check(false, `${e.message}: ${JSON.stringify(await page.eval(ravenBlockSnap))}`))
        await page.waitFor(() => {
          const rv = document.querySelector('.vl-page[data-active] .hm-rv')
          return rv?.querySelector('.hm-rv-status')?.textContent?.trim() === 'thinking · Sonnet 5.5 · high' && /thinking · Sonnet 5\.5 · high/.test(rv.querySelector('.hm-rv-wait')?.textContent ?? '')
        }, { timeout: 60_000, interval: 250, message: 'the block did not show Raven working (status and the waiting line)' })
          .catch(async (e) => t.check(false, `${e.message}: ${JSON.stringify(await page.eval(ravenBlockSnap))}`))
        await t.shot(page, 'working')
        await page.waitFor((w) => {
          const rv = document.querySelector('.vl-page[data-active] .hm-rv')
          return rv?.querySelector('.hm-rv-text[data-who="raven"]')?.textContent === `Done: ${w}` && rv.querySelector('.hm-rv-status')?.textContent?.trim() === 'idle'
        }, { args: [want], timeout: 90_000, interval: 250, message: 'the reply did not show in the block' })
          .catch(async (e) => t.check(false, `${e.message}: ${JSON.stringify(await page.eval(ravenBlockSnap))}`))
        // the reply to his line is read where he saw it
        const replyId = st.messages.find((m) => m.author === 'raven' && m.meta.replyTo !== undefined && m.text === `Done: ${want}`)?.id
        const t1 = Date.now()
        while (!st.reads.includes(replyId) && Date.now() - t1 < 30_000) await sleep(100)
        t.check(replyId && st.reads.includes(replyId), `the reply (${replyId}) was not marked read: reads ${JSON.stringify(st.reads)}`)
        const lr2 = await page.eval(layoutReport)
        t.check(lr2.docSW <= lr2.W + 1, `after the reply the Dashboard is wider than the screen (${lr2.docSW} > ${lr2.W})`)
        await t.shot(page, 'reply')

        // the heading opens the conversation
        await page.tap({ sel: '.vl-page[data-active] .hm-rv-head' }, { wait: 40_000 })
        await page.waitPath('/m/raven', 60_000).catch((e) => t.check(false, `the heading: ${e.message}`))
        await page.waitFor(() => document.querySelector('.vl-page[data-active][data-screen="raven"] .rv-msg'), { timeout: 90_000, message: 'the Raven screen did not come up from the heading' })
          .catch((e) => t.check(false, e.message))
      },
    })
  }
  return out
}

export function dashboardTests() {
  return [...lightsTests(), ...lightsTabTests(), ...tradeTests(), ...mediaTests(), ...layoutTests(), ...calendarTests(), ...calendarEdgeTests(), ...deviceTests(), ...carTests(), ...ravenBlockTests()]
}
