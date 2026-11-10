// HOTKEYS: Dashboard > Hotkeys (src/v2/screens/Hotkeys.tsx, /m/dashboard/hotkeys), the iPad's
// sub-tab for the iPad under the main monitor, over fakes in the backend's shapes
// (routes/hostLaunch.ts /hosts/thor/hotkeys). Presses are caught in the browser: nothing reaches thor.
//
//   view       the iPad has the sub-tab after Overview and Today, 18 keys, the mic reads live, the
//              Claude keys take thor's names, no overflow (portrait and landscape)
//   others     the phone and the desktop have no Hotkeys sub-tab, and its URL lands on Overview
//   press      a key sends its id; the mic key flips to muted from the next state read; Mode flips
//              work to game and lights
//   down       THOR Keys not running: the status line says so and every key but Mode and VR is disabled
//   vr         a tap sends vr; the key reads Starting VR and refuses taps while thor switches, then VR on

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/dashboard/hotkeys'
const IDS = ['mic', 'discordmute', 'discorddeafen', 'claude1', 'claude2', 'claude3', 'dim', 'shot', 'clip', 'play', 'prev', 'next', 'output', 'voldown', 'volup', 'volmute', 'mode', 'vr']
const KEYS = IDS.length
const CLIPS = [{ name: 'Airhorn', file: 'airhorn.mp3', seconds: 2.4 }, { name: 'Sad trombone', file: 'sad trombone.wav', seconds: 4 }]

function fakes(page, { ready = true, player = true, clips = CLIPS } = {}) {
  const st = { ready, mic: 'live', dim: 0, output: 'Headset', mode: 'work', vr: 'off', played: [] }
  page.mock('/api/hosts/thor/hotkeys', () => ok({ ready: st.ready, mic: st.mic, dim: st.dim, output: st.output, mode: st.mode, vr: st.vr, ids: IDS, labels: { claude1: 'Home', claude2: 'Office', claude3: 'Client' } }))
  page.mock('/api/hosts/thor/soundboard', () => (player
    ? ok({ clips, mic: { connected: true, rate: 48000, channels: 2, heartbeatAgeMs: 10 } })
    : ok({ error: 'the soundboard is not running on thor' }, 503)))
  page.onWrite((w) => {
    if (w.method === 'POST' && w.path === '/api/hosts/thor/soundboard/play') {
      st.played.push(w.json?.name)
      return clips.some((c) => c.name === w.json?.name) ? ok({ ok: true }) : ok({ error: 'no such clip' }, 404)
    }
    if (w.method === 'POST' && w.path === '/api/hosts/thor/soundboard/stop') return ok({ ok: true })
    if (w.method !== 'POST' || w.path !== '/api/hosts/thor/hotkey') return undefined
    if (!IDS.includes(w.json?.id)) return ok({ error: 'unknown hotkey' }, 400)
    if (w.json.id === 'mic') st.mic = st.mic === 'muted' ? 'live' : 'muted'
    if (w.json.id === 'output') st.output = st.output === 'Headset' ? 'Speakers' : 'Headset'
    if (w.json.id === 'mode') st.mode = st.mode === 'game' ? 'work' : 'game'
    if (w.json.id === 'vr') { st.vr = st.vr === 'on' ? 'stopping' : 'starting'; setTimeout(() => { st.vr = st.vr === 'stopping' ? 'off' : 'on' }, 1500) }
    return ok({ ok: true, id: w.json.id })
  })
  return st
}

const pageUp = (page) => page.waitFor(() => !!document.querySelector('.hk .hk-head h2'), { timeout: 12_000, message: 'Hotkeys did not come up' })
const subTabs = (page) => page.eval(() => [...document.querySelectorAll('.vl-nav-subs .vl-tab-sub')].map((b) => b.textContent.trim()))

async function fits(t, page, tag) {
  const r = await page.eval(layoutReport)
  t.check(!r.crash, `${tag}: the crash screen is showing`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (${r.docSW} > ${r.W})${r.wide?.length ? `: ${r.wide.join(', ')}` : ''}`)
}

export function hotkeysTests() {
  const tests = []
  for (const device of ['ipad', 'ipadland']) {
    tests.push({
      name: `hotkeys:view:${device}`,
      group: 'hotkeys',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        fakes(page)
        await page.goto(ROUTE)
        await pageUp(page)
        const subs = await subTabs(page)
        t.check(subs.join(',') === 'Overview,Today,Hotkeys', `the Dashboard sub-tabs read ${JSON.stringify(subs)}`)
        await page.waitFor(() => /Mic live/.test(document.querySelector('.hk-mic')?.textContent ?? ''), { message: 'the mic key never read live' })
        const keys = await page.eval(() => document.querySelectorAll('.hk .hk-key:not(.hk-clip)').length)
        t.check(keys === KEYS, `${keys} keys, expected ${KEYS}`)
        const named = await page.eval(() => [...document.querySelectorAll('.hk .hk-key .hk-label')].map((l) => l.textContent).filter((l) => /^(Home|Office|Client)$/.test(l)))
        t.check(named.join(',') === 'Home,Office,Client', `the Claude keys did not take thor's names: ${JSON.stringify(named)}`)
        const small = await page.eval(() => [...document.querySelectorAll('.hk .hk-key')].filter((k) => k.getBoundingClientRect().height < (k.classList.contains('hk-clip') ? 56 : 76)).map((k) => k.textContent))
        t.check(small.length === 0, `keys under a finger's height: ${JSON.stringify(small)}`)
        await fits(t, page, `${ROUTE} ${device}`)
        await t.shot(page, device)
      },
    })
  }

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `hotkeys:others:${device}`,
      group: 'hotkeys',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        fakes(page)
        await page.goto(ROUTE)
        await page.waitPath('/m/dashboard/overview', 10_000)
        const subs = await subTabs(page)
        t.check(!subs.includes('Hotkeys'), `${device} has a Hotkeys sub-tab: ${JSON.stringify(subs)}`)
        t.check(!(await page.eval(() => !!document.querySelector('.hk'))), `${device} drew the Hotkeys screen`)
      },
    })
  }

  tests.push({
    name: 'hotkeys:press',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => !document.querySelector('.hk-key:disabled'), { message: 'the keys stayed disabled' })
      await page.tap({ sel: '.hk-key', text: /Vol up/ })
      await page.waitFor(() => !!document.querySelector('.hk-key[data-sent]'), { message: 'Volume up never lit' })
      const w1 = page.writes.at(-1)
      t.check(w1?.path === '/api/hosts/thor/hotkey' && w1?.json?.id === 'volup', `Volume up sent ${w1?.path} ${w1?.body}`)
      await page.tap({ sel: '.hk-mic' })
      await sleep(200)
      const w2 = page.writes.at(-1)
      t.check(w2?.json?.id === 'mic', `the mic key sent ${w2?.body}`)
      await page.waitFor(() => /Mic muted/.test(document.querySelector('.hk-mic')?.textContent ?? '') && document.querySelector('.hk-mic')?.hasAttribute('data-muted'), { message: 'the mic key never read muted' })
      // muted reads in the alarm color, never the accent, flash or not (after the .2 s color transition)
      await sleep(400)
      const colors = await page.eval(() => {
        const mic = getComputedStyle(document.querySelector('.hk-mic')).color
        const probe = document.createElement('i')
        probe.style.color = 'var(--acc2)'
        document.querySelector('.hk').appendChild(probe)
        const acc2 = getComputedStyle(probe).color
        probe.remove()
        return { mic, acc2 }
      })
      t.check(colors.mic === colors.acc2, `the muted mic reads ${colors.mic}, not the alarm color ${colors.acc2}`)
      await t.shot(page, 'muted')
      // Mode: work to game, from the next state read
      await page.waitFor(() => /Work mode/.test(document.querySelector('.hk-mode')?.textContent ?? ''), { message: 'the Mode key never read work' })
      await page.tap({ sel: '.hk-mode' })
      await sleep(200)
      t.check(page.writes.at(-1)?.json?.id === 'mode', `the Mode key sent ${page.writes.at(-1)?.body}`)
      await page.waitFor(() => /Game mode/.test(document.querySelector('.hk-mode')?.textContent ?? '') && document.querySelector('.hk-mode')?.hasAttribute('data-game'), { message: 'the Mode key never read game' })
      // state colors: game mode reads yellow, the live-to-muted mic red (checked above), work mode the accent
      await sleep(400)
      const tones = await page.eval(() => {
        const probe = (v) => {
          const i = document.createElement('i')
          i.style.color = v
          document.querySelector('.hk').appendChild(i)
          const c = getComputedStyle(i).color
          i.remove()
          return c
        }
        const mode = document.querySelector('.hk-mode')
        return { tone: mode.dataset.tone, color: getComputedStyle(mode).color, hot: probe('var(--hot)') }
      })
      t.check(tones.tone === 'hot' && tones.color === tones.hot, `game mode reads ${tones.color} (tone ${tones.tone}), not yellow ${tones.hot}`)
      await t.shot(page, 'tones')
    },
  })

  tests.push({
    name: 'hotkeys:down',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page, { ready: false })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /THOR Keys is not running on thor/.test(document.querySelector('.hk-status')?.textContent ?? ''), { message: 'no line saying THOR Keys is down' })
      const live = await page.eval(() => [...document.querySelectorAll('.hk .hk-key:not(.hk-clip):not(.hk-mode):not(.hk-vr)')].filter((k) => !k.disabled).length)
      t.check(live === 0, `${live} keys still enabled while THOR Keys is down`)
      // Mode runs in thor's agent, not in THOR Keys
      t.check(await page.eval(() => document.querySelector('.hk-mode')?.disabled === false), 'Mode was disabled while THOR Keys is down')
    },
  })

  tests.push({
    name: 'hotkeys:soundboard',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      const st = fakes(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => document.querySelectorAll('.hk-clip').length === 2, { message: 'the two clip keys did not show' })
      await page.tap({ sel: '.hk-clip', text: /Sad trombone/ })
      await page.waitFor(() => !!document.querySelector('.hk-clip[data-sent]'), { message: 'the clip key never lit' })
      t.check(st.played.join(',') === 'Sad trombone', `the clip key sent ${JSON.stringify(st.played)}`)
      await page.tap({ sel: '.hk-stop' })
      await sleep(200)
      t.check(page.writes.at(-1)?.path === '/api/hosts/thor/soundboard/stop', `Stop all sent ${page.writes.at(-1)?.path}`)
      // the Output key names the device and follows a switch
      await page.waitFor(() => /Headset/.test([...document.querySelectorAll('.hk-key')].find((k) => /Output/.test(k.textContent))?.textContent ?? ''), { message: 'Output did not name the headset' })
      await page.tap({ sel: '.hk-key', text: /Output/ })
      await page.waitFor(() => /Speakers/.test([...document.querySelectorAll('.hk-key')].find((k) => /Output/.test(k.textContent))?.textContent ?? ''), { timeout: 6000, message: 'Output did not switch to speakers' })
      // the landscape iPad shows the whole page without scrolling
      const fit = await page.eval(() => {
        const p = document.querySelector('.vl-page[data-active]')
        return p ? { sh: p.scrollHeight, ch: p.clientHeight } : null
      })
      t.check(fit && fit.sh <= fit.ch + 2, `the landscape page scrolls: ${JSON.stringify(fit)}`)
      await t.shot(page, 'soundboard')
    },
  })

  // the iPad's own Overview in landscape: one screen with lights, tracker, AI, calendar, trade and
  // the hosts, nothing that scrolls; portrait keeps the two-column board
  tests.push({
    name: 'hotkeys:pad-overview',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      await page.goto('/m/dashboard/overview')
      await page.waitFor(() => !!document.querySelector('.hm-layout[data-pad]'), { timeout: 15_000, message: 'the landscape iPad did not get the pad board' })
      await page.waitFor(() => !!document.querySelector('.hm-trade .hm-trade-chart'), { timeout: 15_000, message: 'the trade box never drew' })
      await sleep(800)
      const r = await page.eval(() => {
        const has = (s) => !!document.querySelector(`.hm-layout ${s}`)
        const p = document.querySelector('.vl-page[data-active]')
        return {
          want: { lights: has('.hm-lights'), tracker: has('.hm-tracker'), ai: has('.hm-ai'), cal: has('.hm-cal'), trade: has('.hm-trade'), sys: has('.hm-sys') },
          gone: { quick: /Quick start/i.test(document.querySelector('.hm-layout')?.textContent ?? ''), upload: has('.hm-up'), media: has('.hm-media'), device: has('.hm-dev') },
          sh: p?.scrollHeight ?? 0,
          ch: p?.clientHeight ?? 0,
        }
      })
      t.check(Object.values(r.want).every(Boolean), `missing blocks: ${JSON.stringify(r.want)}`)
      t.check(!Object.values(r.gone).some(Boolean), `blocks that should be off: ${JSON.stringify(r.gone)}`)
      t.check(r.sh <= r.ch + 2, `the pad board scrolls: ${r.sh} > ${r.ch}`)
      await fits(t, page, 'pad overview')
      await t.shot(page, 'pad-overview')
      const portrait = await t.page({ device: 'ipad' })
      quietThor(portrait)
      await portrait.goto('/m/dashboard/overview')
      await portrait.waitFor(() => !!document.querySelector('.hm-layout[data-cols]'), { timeout: 15_000, message: 'the portrait board did not come up' })
      t.check(!(await portrait.eval(() => !!document.querySelector('.hm-layout[data-pad]'))), 'portrait iPad got the landscape board')
    },
  })

  // VR: a tap sends 'vr', the key reads Starting VR (and refuses taps) while thor switches, then VR on
  tests.push({
    name: 'hotkeys:vr',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /VR off/.test(document.querySelector('.hk-vr')?.textContent ?? ''), { message: 'the VR key never read off' })
      await page.tap({ sel: '.hk-vr' })
      await sleep(200)
      t.check(page.writes.at(-1)?.json?.id === 'vr', `the VR key sent ${page.writes.at(-1)?.body}`)
      await page.waitFor(() => /Starting VR/.test(document.querySelector('.hk-vr')?.textContent ?? '') && document.querySelector('.hk-vr')?.disabled, { timeout: 4000, message: 'the VR key never read Starting VR' })
      await page.waitFor(() => /VR on/.test(document.querySelector('.hk-vr')?.textContent ?? '') && document.querySelector('.hk-vr')?.hasAttribute('data-on'), { timeout: 8000, message: 'the VR key never read on' })
      await t.shot(page, 'vr-on')
    },
  })

  tests.push({
    name: 'hotkeys:soundboard-off',
    group: 'hotkeys',
    device: 'ipadland',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page, { player: false })
      t.allowProblems.push(/503|Service Unavailable/)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /not running on thor/.test(document.querySelector('.hk-sb .hk-note')?.textContent ?? ''), { message: 'no line saying the soundboard is off' })
      t.check(!(await page.eval(() => document.querySelectorAll('.hk-clip').length)), 'clip keys showed with the soundboard off')
      t.check(!(await page.eval(() => document.querySelector('.hk-key:not(.hk-clip):disabled'))), 'the soundboard being off disabled the other keys')
    },
  })

  return tests
}
