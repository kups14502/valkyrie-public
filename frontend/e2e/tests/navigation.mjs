// NAVIGATION: tab and sub-tab taps, Settings behind the gear and the way back,
// swiping between tabs, the old addresses, the iPhone profile landing on v2,
// and the classic pages staying classic (no html[data-v2] left behind).

import { sleep } from '../lib/cdp.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const PRIMS = [
  { label: 'AI', id: 'ai' },
  { label: 'Lights', id: 'lights' },
  { label: 'Media', id: 'media' },
  { label: 'System', id: 'system' },
  { label: 'Dashboard', id: 'dashboard' },
]

const tabSel = (label) => ({ sel: '.vl-nav .vl-tab-prim', text: new RegExp(`^\\s*${label}\\s*$`) })
const subSel = (label) => ({ sel: '.vl-nav .vl-tab-sub', text: new RegExp(`^\\s*${label}\\s*$`) })

/** The shell is up: tabs drawn and laid out. */
async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 10_000, message: 'the v2 shell did not come up' })
  await sleep(400)
}

/**
 * The screen has caught up with the address: react-router renders a navigation
 * as a transition, so the address changes before the screen does. Waits for the
 * active page, the lit tab and the lit sub-tab to read `want`.
 */
async function onScreen(page, want, timeout = 8000) {
  let last = null
  try {
    await page.waitFor((w) => {
      const p = document.querySelector('.vl-page[data-active]')
      const tab = document.querySelector('.vl-nav .vl-tab-prim[aria-current="page"]')
      const sub = document.querySelector('.vl-nav .vl-tab-sub[aria-current="page"]')
      const got = { screen: p?.getAttribute('data-screen') ?? null, tab: tab?.textContent?.trim() ?? null, sub: sub?.textContent?.trim() ?? null }
      window.__e2eLastScreen = got
      return (!w.screen || got.screen === w.screen) && (!w.tab || got.tab === w.tab) && (!w.sub || got.sub === w.sub)
    }, { args: [want], timeout })
  } catch {
    last = await page.eval(() => window.__e2eLastScreen ?? null).catch(() => null)
    throw new Error(`the screen did not show ${JSON.stringify(want)} (it shows ${JSON.stringify(last)})`)
  }
  await sleep(250)
}

/** A point on the active screen where a horizontal drag belongs to the pager. */
function swipeRow() {
  const pager = document.querySelector('.vl-pager')
  if (!pager) return null
  const r = pager.getBoundingClientRect()
  for (let y = r.top + r.height * 0.45; y < r.bottom - 60; y += 24) {
    let ok = true
    for (const x of [r.left + r.width * 0.15, r.left + r.width * 0.5, r.left + r.width * 0.85]) {
      const el = document.elementFromPoint(x, y)
      if (!el || !pager.contains(el) || el.closest('[data-no-swipe], canvas, input, textarea, .vc-swipe')) { ok = false; break }
    }
    if (ok) return { x1: r.left + r.width * 0.85, x2: r.left + r.width * 0.12, y }
  }
  return null
}

export function navigationTests() {
  const tests = []

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `nav:tabs:${device}`,
      group: 'navigation',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        await page.goto('/m/dashboard')
        await shellUp(page)
        for (const p of PRIMS) {
          await t.step(`tap ${p.label}`, async () => {
            await page.tap(tabSel(p.label))
            await page.waitPath(new RegExp(`^/m/${p.id}(/[a-z]+)?$`))
            await onScreen(page, { screen: p.id, tab: p.label })
          })
        }
      },
    })
  }

  tests.push({
    name: 'nav:subtabs:phone',
    group: 'navigation',
    device: 'phone',
    timeout: 70_000,
    async run(t) {
      const page = await t.page()
      await page.goto('/m/ai/sessions')
      await shellUp(page)
      const plan = [
        ['ai', ['Projects', 'Usage', 'Sessions']],
        ['media', ['Movies', 'Shows', 'Music', 'Requests', 'Dashboard']],
        ['system', ['Services', 'Trades', 'Hosts']],
      ]
      for (const [id, subs] of plan) {
        const label = PRIMS.find((p) => p.id === id).label
        await t.step(`open ${id}`, async () => {
          await page.tap(tabSel(label))
          await page.waitPath(new RegExp(`^/m/${id}/`))
          await onScreen(page, { screen: id, tab: label })
        })
        for (const s of subs) {
          await t.step(`${id} > ${s}`, async () => {
            await page.tap(subSel(s))
            await page.waitPath(`/m/${id}/${s.toLowerCase()}`)
            await onScreen(page, { screen: id, tab: label, sub: s })
          })
        }
      }
      // a tab remembers its sub-tab: AI > Projects, away, back to AI lands on Projects
      await t.step('sub-tab remembered', async () => {
        await page.tap(tabSel('AI'))
        await onScreen(page, { screen: 'ai' })
        await page.tap(subSel('Projects'))
        await page.waitPath('/m/ai/projects')
        await onScreen(page, { screen: 'ai', sub: 'Projects' })
        await page.tap(tabSel('Lights'))
        await page.waitPath('/m/lights')
        await onScreen(page, { screen: 'lights', tab: 'Lights' })
        await page.tap(tabSel('AI'))
        await page.waitPath('/m/ai/projects')
        await onScreen(page, { screen: 'ai', sub: 'Projects' })
      })
    },
  })

  tests.push({
    name: 'nav:settings:phone',
    group: 'navigation',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      await page.goto('/m/lights')
      await shellUp(page)
      const settingsOpen = (open) => page.waitFor((o) => !!document.querySelector('.vl-set') === o && !!document.querySelector('.vl-setbar-back') === o, { args: [open], message: open ? 'Settings did not open' : 'Settings is still open' }).then(() => sleep(300))
      await t.step('the gear opens Settings', async () => {
        await page.tap('.vl-strip-gear')
        await page.waitPath('/m/settings')
        await settingsOpen(true)
        const back = await page.eval(() => document.querySelector('.vl-setbar-back')?.textContent?.trim())
        t.check(/lights/i.test(back ?? ''), `the way back says "${back}", want Lights`)
      })
      await t.step('Back returns to the tab', async () => {
        await page.tap('.vl-setbar-back')
        await page.waitPath('/m/lights')
        await settingsOpen(false)
        await onScreen(page, { screen: 'lights', tab: 'Lights' })
      })
      await t.step('the phone back gesture closes Settings', async () => {
        await page.tap('.vl-strip-gear')
        await page.waitPath('/m/settings')
        await settingsOpen(true)
        await page.eval(() => { history.back() })
        await page.waitPath('/m/lights')
        await settingsOpen(false)
      })
      await t.step('the gear closes an open Settings', async () => {
        await page.tap('.vl-strip-gear')
        await page.waitPath('/m/settings')
        await settingsOpen(true)
        await page.tap('.vl-strip-gear')
        await page.waitPath('/m/lights')
        await settingsOpen(false)
      })
      await t.step('Settings opened by address goes back to the Dashboard', async () => {
        await page.goto('/m/settings')
        await shellUp(page)
        await settingsOpen(true)
        await page.tap('.vl-setbar-back')
        await page.waitPath('/m/dashboard')
        await onScreen(page, { screen: 'dashboard', tab: 'Dashboard' })
      })
    },
  })

  tests.push({
    name: 'nav:swipe:phone',
    group: 'navigation',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      await page.goto('/m/dashboard')
      await shellUp(page)
      await sleep(1500)
      await t.step('swipe left: Dashboard to AI', async () => {
        const row = await page.eval(swipeRow)
        if (!row) throw new Error('no free row on the Dashboard to swipe on')
        await page.swipe(row.x1, row.y, row.x2, row.y, { steps: 10, ms: 160 })
        await page.waitPath(/^\/m\/ai\//)
        await onScreen(page, { screen: 'ai', tab: 'AI' })
      })
      await sleep(900)
      await t.step('swipe right: AI back to the Dashboard', async () => {
        const row = await page.eval(swipeRow)
        if (!row) throw new Error('no free row on AI to swipe on')
        await page.swipe(row.x2, row.y, row.x1, row.y, { steps: 10, ms: 160 })
        await page.waitPath('/m/dashboard')
        await onScreen(page, { screen: 'dashboard', tab: 'Dashboard' })
      })
      await sleep(600)
      await t.step('a vertical drag does not change the tab', async () => {
        const row = await page.eval(swipeRow)
        if (!row) throw new Error('no free row')
        await page.swipe(row.x1 - 40, row.y + 120, row.x1 - 30, row.y - 120, { steps: 10, ms: 200 })
        await sleep(500)
        const p = await page.path()
        t.check(p === '/m/dashboard', `a vertical drag moved to ${p}`)
      })
    },
  })

  // the presses that open another tab: the ticker opens Trades, the usage meters open AI > Usage
  tests.push({
    name: 'nav:links:phone',
    group: 'navigation',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      await page.goto('/m/dashboard')
      await shellUp(page)
      await t.step('the ticker opens System > Trades', async () => {
        await page.waitFor(() => /\$\d/.test(document.querySelector('.vl-page[data-active] .hm-tk')?.textContent ?? ''), { timeout: 10_000, message: 'the ticker never showed a figure' })
        await page.tap({ sel: '.vl-page[data-active] .hm-tk' })
        await page.waitPath('/m/system/trades')
        await onScreen(page, { screen: 'system', tab: 'System', sub: 'Trades' })
      })
      await t.step('the Dashboard usage meters open AI > Usage', async () => {
        await page.tap(tabSel('Dashboard'))
        await page.waitPath('/m/dashboard')
        await onScreen(page, { screen: 'dashboard', tab: 'Dashboard' })
        await page.tap({ sel: '.vl-page[data-active] .hm-g-meters' })
        await page.waitPath('/m/ai/usage')
        await onScreen(page, { screen: 'ai', tab: 'AI', sub: 'Usage' })
      })
      await t.step('the Sessions usage panel opens AI > Usage', async () => {
        await page.tap(subSel('Sessions'))
        await page.waitPath('/m/ai/sessions')
        await onScreen(page, { screen: 'ai', tab: 'AI', sub: 'Sessions' })
        await page.tap({ sel: '.vl-page[data-active] .vc-week' })
        await page.waitPath('/m/ai/usage')
        await onScreen(page, { screen: 'ai', tab: 'AI', sub: 'Usage' })
      })
    },
  })

  tests.push({
    name: 'nav:legacy:phone',
    group: 'navigation',
    device: 'phone',
    timeout: 60_000,
    async run(t) {
      const page = await t.page()
      for (const [from, to] of [['/m/home/today', '/m/dashboard'], ['/m/claude/sessions', '/m/ai/sessions'], ['/m/claude/projects', '/m/ai/projects'], ['/m/home/settings', '/m/settings'], ['/m', '/m/dashboard'], ['/m/ai/nope', '/m/ai/sessions']]) {
        await t.step(`${from} -> ${to}`, async () => {
          await page.goto(from)
          await page.waitPath(to, 8000)
        })
      }
    },
  })

  tests.push({
    name: 'nav:iphone-profile',
    group: 'navigation',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      await t.step('iPhone profile: /dashboard opens /m/dashboard', async () => {
        const page = await t.page({ storage: { 'valkyrie-device-mode': 'iphone' } })
        await page.goto('/dashboard')
        await page.waitPath('/m/dashboard', 8000)
        await page.waitFor(() => document.documentElement.hasAttribute('data-v2'), { message: 'html[data-v2] is missing on /m/dashboard' })
      })
      await t.step('auto profile on a phone: / opens /m/dashboard', async () => {
        const page = await t.page()
        await page.goto('/')
        await page.waitPath('/m/dashboard', 8000)
      })
    },
  })

  tests.push({
    name: 'nav:classic-desktop',
    group: 'navigation',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      await t.step('/dashboard stays the classic dashboard', async () => {
        await page.goto('/dashboard')
        await page.waitFor(() => document.querySelector('[data-shell]'), { timeout: 10_000, message: 'the classic shell did not render' })
        await sleep(800)
        const s = await page.eval(() => ({ path: location.pathname, v2: document.documentElement.hasAttribute('data-v2'), shell: !!document.querySelector('.vl-shell') }))
        t.check(s.path === '/dashboard', `/dashboard moved to ${s.path}`)
        t.check(!s.v2 && !s.shell, 'the classic dashboard has v2 on it')
      })
      await t.step('after v2 in the same tab, the classic page has no data-v2', async () => {
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.eval(() => {
          history.pushState({}, '', '/dashboard')
          dispatchEvent(new PopStateEvent('popstate', { state: {} }))
        })
        await page.waitFor(() => document.querySelector('[data-shell]'), { timeout: 10_000, message: 'the classic shell did not render after v2' })
        await sleep(500)
        const s = await page.eval(() => ({ v2: document.documentElement.hasAttribute('data-v2'), boot: document.documentElement.hasAttribute('data-boot'), shell: !!document.querySelector('.vl-shell') }))
        t.check(!s.v2, 'html[data-v2] stayed on after leaving v2')
        t.check(!s.boot, 'html[data-boot] stayed on after leaving v2')
        t.check(!s.shell, 'the v2 shell is still in the page')
      })
    },
  })

  tests.push({
    name: 'nav:classic-phone',
    group: 'navigation',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      await t.step('Settings > Classic opens /phone without v2', async () => {
        await page.goto('/m/settings')
        await shellUp(page)
        const open = await page.eval(() => {
          const row = [...document.querySelectorAll('.vl-set *')].find((e) => e.textContent?.trim() === 'Classic')
          return !!row
        })
        if (!open) throw new Error('no Classic row in Settings')
        await page.tap({ sel: '.vl-set .st-row-act', text: /^\s*Open\s*$/ })
        await page.waitPath('/phone')
        await page.waitFor(() => document.querySelector('[data-shell]'), { timeout: 10_000, message: 'the classic phone page did not render' })
        await sleep(500)
        const s = await page.eval(() => ({ v2: document.documentElement.hasAttribute('data-v2'), shell: !!document.querySelector('.vl-shell') }))
        t.check(!s.v2, 'html[data-v2] stayed on after Settings > Classic')
        t.check(!s.shell, 'the v2 shell is still in the page on /phone')
      })
      await t.step('/phone by address stays classic', async () => {
        const p2 = await t.page()
        await p2.goto('/phone')
        await p2.waitFor(() => document.querySelector('[data-shell]'), { timeout: 10_000, message: 'the classic phone page did not render' })
        const s = await p2.eval(() => ({ path: location.pathname, v2: document.documentElement.hasAttribute('data-v2') }))
        t.check(s.path === '/phone', `/phone moved to ${s.path}`)
        t.check(!s.v2, '/phone has html[data-v2]')
      })
    },
  })

  return tests
}
