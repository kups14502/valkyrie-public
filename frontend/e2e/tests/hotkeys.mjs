// HOTKEYS: Dashboard > Hotkeys (src/v2/screens/Hotkeys.tsx, /m/dashboard/hotkeys), the iPad's
// sub-tab for the iPad under the main monitor, over fakes in the backend's shapes
// (routes/hostLaunch.ts /hosts/thor/hotkeys). Presses are caught in the browser: nothing reaches thor.
//
//   view       the iPad has the sub-tab after Overview and Today, 13 keys, the mic reads live, the
//              Claude keys take thor's names, no overflow (portrait and landscape)
//   others     the phone and the desktop have no Hotkeys sub-tab, and its URL lands on Overview
//   press      a key sends its id; the mic key flips to muted from the next state read
//   down       THOR Keys not running: the status line says so and every key is disabled

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/dashboard/hotkeys'
const IDS = ['mic', 'claude1', 'claude2', 'claude3', 'dim', 'shot', 'paste', 'play', 'prev', 'next', 'voldown', 'volup', 'volmute']

function fakes(page, { ready = true } = {}) {
  const st = { ready, mic: 'live', dim: 0 }
  page.mock('/api/hosts/thor/hotkeys', () => ok({ ready: st.ready, mic: st.mic, dim: st.dim, ids: IDS, labels: { claude1: 'Home', claude2: 'Office', claude3: 'Client' } }))
  page.onWrite((w) => {
    if (w.method !== 'POST' || w.path !== '/api/hosts/thor/hotkey') return undefined
    if (!IDS.includes(w.json?.id)) return ok({ error: 'unknown hotkey' }, 400)
    if (w.json.id === 'mic') st.mic = st.mic === 'muted' ? 'live' : 'muted'
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
        const keys = await page.eval(() => document.querySelectorAll('.hk .hk-key').length)
        t.check(keys === 13, `${keys} keys, expected 13`)
        const named = await page.eval(() => [...document.querySelectorAll('.hk .hk-key .hk-label')].map((l) => l.textContent).filter((l) => /^(Home|Office|Client)$/.test(l)))
        t.check(named.join(',') === 'Home,Office,Client', `the Claude keys did not take thor's names: ${JSON.stringify(named)}`)
        const small = await page.eval(() => [...document.querySelectorAll('.hk .hk-key')].filter((k) => k.getBoundingClientRect().height < 88).map((k) => k.textContent))
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
      await page.tap({ sel: '.hk-key', text: /Volume up/ })
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
      const live = await page.eval(() => [...document.querySelectorAll('.hk .hk-key')].filter((k) => !k.disabled).length)
      t.check(live === 0, `${live} keys still enabled while THOR Keys is down`)
    },
  })

  return tests
}
