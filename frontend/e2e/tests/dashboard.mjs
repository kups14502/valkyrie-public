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
//            read, Day-open), the chart; the phone keeps the ticker only.
//            System > Trades says Live for a fresh read, never "Unchanged
//            since", and says All cash when cash is the whole total.
//   media    posters in the desktop app: over the Tauri stand-in, the app finds
//            odin's API by its healthz probe and moves its base there; every
//            poster on the Dashboard and Media > Dashboard loads from that base
//            with no token. Moved to a remote base, the posters carry the image
//            token and still load (a tokenless one gets the remote's 401).
//   layout   no Meals row; three columns on a monitor that fill the page with no
//            scroll; no apartment anywhere on the Dashboard (the one model it
//            draws is This device's).
//   device   This device: the model of the machine the page runs on (the
//            desktop app's machine name over the Tauri stand-in, held back
//            1.2 s so a guess drawn before it answers shows, else the device
//            profile: thor, mimir, Loki, the phone, the tablet), no other model
//            drawn first, its caption, name, state and numbers with what each
//            is out of (cores, used / total; battery and storage on the phone,
//            the hint before the tablet's first battery reading), the last
//            hour of CPU and memory in the monitor's box (none in the phone's
//            and iPad's block), between Lights and Systems on a monitor and at the top
//            of Systems on the phone and iPad, the model inside its box and
//            centered on its side, no diamonds, no apartment, no scroll and the
//            three columns level at 1600x900 and the monitors (app and
//            browser), and a press over the model opening System > Hosts with
//            that host picked. /api/hosts is a fixed fake here.

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { applyLight, quietThor, tradePage, tradeStatus } from '../lib/fixtures.mjs'
import { tauriStub } from '../lib/tauri.mjs'

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

/** n quick presses on one spot, `gap` ms apart (no wait for anything in between). */
async function burst(page, target, n, gap = 110) {
  const at = await page.locate(target)
  if (at.error) throw new Error(at.error)
  for (let k = 0; k < n; k++) {
    await page.tap({ x: at.x, y: at.y })
    if (k < n - 1) await sleep(gap)
  }
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

        t.note(`commands in arrival order: ${ha.log.map((u) => `${Array.isArray(u.entity_id) ? `[${u.entity_id.map((x) => x.replace('light.e2e_', '')).join('+')}]` : u.entity_id.replace('light.e2e_', '')} ${u.state}${u.rgb_color ? ` rgb ${u.rgb_color}` : ''}`).join(', ')}`)
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
        const ban = await page.eval(() => {
          const b = document.querySelector('.vl-page[data-active] .hm-ban')
          const img = b?.querySelector('img')
          return b ? { state: b.getAttribute('data-state'), ok: !!img && img.complete && img.naturalWidth > 0, src: img?.src.split('/plex/img')[0] ?? null } : null
        })
        if (t.check(ban, 'no newest-item banner on the desktop Dashboard')) {
          t.check(ban.ok && ban.src === `${ODIN}/api`, `the banner image did not load from odin's base (${JSON.stringify(ban)})`)
        }
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
  for (const device of ['phone', 'ipad', 'desktop', 'desk1080', 'desk1440']) {
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
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-lights') && document.querySelector('.vl-page[data-active] .hm-media'), { timeout: 12_000, message: 'the Dashboard did not draw its blocks' })
        await sleep(2500)
        const r = await page.eval(() => {
          const root = document.querySelector('.vl-page[data-active]')
          const lay = root.querySelector('.hm-layout')
          const colOf = (sel) => {
            const el = root.querySelector(sel)
            const c = el?.closest('.hm-col')
            return c ? ['hm-a', 'hm-b', 'hm-c'].find((k) => c.classList.contains(k)) ?? '?' : null
          }
          return {
            cols: lay?.getAttribute('data-cols') ?? null,
            meals: [...root.querySelectorAll('*')].some((e) => e.children.length === 0 && /\bMeals\b/.test(e.textContent || '')),
            mealsLink: !!root.querySelector('a[href*="/meals"], [data-to*="meals"]'),
            scrollH: root.scrollHeight, clientH: root.clientHeight,
            where: { lights: colOf('.hm-lights'), trade: colOf('.hm-trade'), media: colOf('.hm-media') },
          }
        })
        t.check(!r.meals && !r.mealsLink, 'the Dashboard still has a Meals row')
        const desk = device.startsWith('desk')
        if (desk) {
          t.check(r.cols === '3', `a monitor Dashboard has ${r.cols} columns, want 3`)
          t.check(r.where.media === 'hm-a' && r.where.trade === 'hm-b' && r.where.lights === 'hm-c', `blocks sit in ${JSON.stringify(r.where)}, want media left, trade middle, lights right`)
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

// ---------- this device: the model of the machine the page runs on ----------

/** /api/hosts with every case the box words differently: thor up, mimir down, Loki on battery, the phone reporting, the tablet before its first battery reading. */
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
  const order = col ? [...col.children].map((c) => (c.contains(inner) ? (c.classList.contains('hm-sys') ? 'sys+dev' : 'dev') : c.classList.contains('hm-lights') ? 'lights' : c.classList.contains('hm-sys') ? 'sys' : 'other')) : []
  const inSys = inner.closest('.hm-sys')
  let outline = null
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
    outline = { ok, w: e.r.w, h: e.r.h, x0, y0, x1, y1, a, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, moving: JSON.stringify(e.cam.cur) !== JSON.stringify(e.cam.to) }
  }
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
    // the text column against the model's anchor: nothing written over the model
    textRight: Math.round(Math.max(0, ...[...inner.querySelectorAll('.hm-dev-id, .hm-dev-rows, .hm-dev-hist')].map((e) => e.getBoundingClientRect().right))),
    anchorLeft: Math.round(inner.querySelector('.hm-dev-anchor')?.getBoundingClientRect().left ?? 0),
    tall: inner.hasAttribute('data-tall'),
    // the text column's blocks top to bottom (head, name, numbers, last hour), as [top, bottom]
    blocks: [...inner.querySelectorAll('.hm-dev-top, .hm-dev-id, .hm-dev-rows, .hm-dev-hist')].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)] }),
    aria: press?.getAttribute('aria-label') ?? '',
    order, inSys: !!inSys,
    beforeRows: inSys ? !!inSys.querySelector('.hm-hrows') && !!(inner.compareDocumentPosition(inSys.querySelector('.hm-hrows')) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
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
      page.mock('/api/hosts', () => ok(deviceHosts()))
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
      t.check(r.hero === c.want, `This device draws ${r.hero}, want ${c.want}`)
      const heroes = (await page.eval(() => window.__devHeroes ?? [])) ?? []
      t.check(heroes.join('>') === c.want, `This device drew ${heroes.join(' > ') || 'nothing'} on the way; want ${c.want} alone (no other model first)`)
      t.check(/^this device$/i.test(r.cap), `the block's caption reads "${r.cap}", want This device`)
      t.check(r.visible, `This device is not on screen (${JSON.stringify(r.box)})`)
      t.check(r.name === c.label, `This device is named "${r.name}", want ${c.label}`)
      t.check(c.state.test(r.state), `This device reads "${r.state}", want ${c.state}`)
      t.check(r.rows.join('|') === c.rows.join('|'), `This device's numbers are ${JSON.stringify(r.rows)}, want ${JSON.stringify(c.rows)}`)
      t.check(r.sizes.join('|') === c.sizes.join('|'), `This device's numbers are out of ${JSON.stringify(r.sizes)}, want ${JSON.stringify(c.sizes)}`)
      if (c.hour) {
        t.check(r.hist && HOUR_CAP.test(r.hist.cap), `This device's last hour reads ${JSON.stringify(r.hist)}, want "Last hour CPU Mem peak 50%"`)
        if (r.hist) t.check(r.hist.cpu >= 59 && r.hist.mem >= 59 && r.hist.h >= 18 && r.hist.w >= 100, `the last hour draws CPU ${r.hist.cpu} and memory ${r.hist.mem} points in ${r.hist.w}x${r.hist.h}, want the 60 samples each in a visible line`)
        // no large empty area beside the model: the text column runs to the box's foot, no gap in it over a fifth of the box
        const bottom = r.box.t + r.box.h
        const lastEnd = r.blocks.at(-1)?.[1] ?? r.box.t
        const gaps = r.blocks.slice(1).map((b, k) => b[0] - r.blocks[k][1])
        t.check(bottom - lastEnd <= 24 && Math.max(0, ...gaps) <= r.box.h / 5, `This device's text column leaves empty space: blocks ${JSON.stringify(r.blocks)} in a box from ${r.box.t} to ${bottom}`)
      } else {
        t.check(!r.hist, `This device draws a last hour it has no samples for: ${JSON.stringify(r.hist)}`)
      }
      if (c.tall != null) t.check(r.tall === c.tall, `This device ${r.tall ? 'is' : 'is not'} in its tall layout (${JSON.stringify(r.box)}), want ${c.tall ? 'tall' : 'short'}`)
      t.check(r.textRight <= r.anchorLeft + 2, `This device's text runs over the model (text right ${r.textRight}, model anchor left ${r.anchorLeft})`)
      if (c.hint) t.check(c.hint.test(r.hint), `no battery hint (got "${r.hint}")`)
      else t.check(!r.hint, `a battery hint where a reading came in: "${r.hint}"`)
      const desk = c.device.startsWith('desk')
      if (desk) t.check(r.order.join('>') === 'lights>dev>sys', `the right column reads ${r.order.join(' > ')}, want lights > this device > systems`)
      else t.check(r.inSys && r.beforeRows, `This device is not at the top of the Systems box (in it: ${r.inSys}, before the hosts: ${r.beforeRows})`)
      checkNoRoom(t, await page.eval(dashboardScenes))
      // a monitor (and the app's window) shows the whole Dashboard: no scroll, the three columns ending together
      if (desk && !c.storage) {
        const f = await page.eval(pageFit)
        t.check(f.scrollH <= f.clientH + 2, `the Dashboard scrolls (${f.scrollH} > ${f.clientH}) with This device in the right column`)
        const ends = f.ends.filter((v) => v != null)
        t.check(ends.length === 3 && Math.max(...ends) - Math.min(...ends) <= 3, `the three columns end at ${JSON.stringify(f.ends)}, want them level`)
      }
      t.check(!r.diamonds && !r.orbit, `This device shows ${r.diamonds} diamond(s)${r.orbit ? ' and an orbit zone' : ''}; the press lies over the model`)
      const o = r.outline
      t.check(o && o.ok, 'the model does not project through the live camera')
      if (o) {
        const in1 = (v, lo, hi) => v >= lo - 2 && v <= hi + 2
        t.check(in1(o.x0, 0, o.w) && in1(o.x1, 0, o.w) && in1(o.y0, 0, o.h) && in1(o.y1, 0, o.h), `the model runs out of its box: ${[o.x0, o.y0, o.x1, o.y1].map(Math.round)} in ${o.w}x${o.h}`)
        t.check(in1(o.cx, o.a.l, o.a.r) && in1(o.cy, o.a.t, o.a.b), `the model is not centered on its side of the box: center ${Math.round(o.cx)},${Math.round(o.cy)}, anchor ${JSON.stringify(Object.fromEntries(Object.entries(o.a).map(([k, v]) => [k, Math.round(v)])))}`)
      }
      t.check(new RegExp(`^This device, ${c.label}:`).test(r.aria), `the press says "${r.aria}"`)
      await t.shot(page, 'dash')
      // the press, over the model, opens System > Hosts with this device picked
      const at = await page.eval(() => {
        const a = document.querySelector('.vl-page[data-active] .hm-dev-anchor')
        a.scrollIntoView({ block: 'center', behavior: 'instant' })
        const b = a.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      })
      await sleep(300)
      await page.tap({ x: at.x, y: at.y })
      await page.waitPath('/m/system/hosts', 6000)
      await sleep(600)
      const picked = await page.eval(() => (document.querySelector('.vl-page[data-active] .sys-detail-id')?.textContent || '').trim())
      t.check(picked.toLowerCase().startsWith(c.label.toLowerCase()), `System > Hosts picked "${picked}", want ${c.label}`)
      await t.shot(page)
      t.check(!page.writes.length, `the Dashboard wrote ${page.writes.length} time(s)`)
    },
  }))
}

export function dashboardTests() {
  return [...lightsTests(), ...lightsTabTests(), ...tradeTests(), ...mediaTests(), ...layoutTests(), ...deviceTests()]
}
