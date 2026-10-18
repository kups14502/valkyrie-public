// ROUTES: every v2 route on every screen v2 runs on, on live data (reads only;
// every write is answered in the browser): the iPhone upright and on its side,
// the iPad both ways, a 1600x900 window, and 1920x1080 and 2560x1440 monitors
// at the app zoom Brendon uses (1.2). Each route must render without console
// errors, keep the page inside the viewport, show the tabs at the top and the
// lights button bottom-left, and have live data on screen 8 s after it opened.

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const TABS = ['Dashboard', 'AI', 'Lights', 'Media', 'System']

/**
 * ready: what live data looks like on the route: `sel` (at least `min`
 * matches inside the active screen) and/or `text` (the screen's text matches).
 */
export const ROUTES = [
  { path: '/m/dashboard', tab: 'Dashboard', ready: { sel: '.hm-hrow', text: /\$/ } },
  { path: '/m/ai/sessions', tab: 'AI', sub: 'Sessions', ready: { text: /\d+\s*live/i } },
  { path: '/m/ai/projects', tab: 'AI', sub: 'Projects', ready: { text: /\d+\s*projects?/i } },
  { path: '/m/ai/usage', tab: 'AI', sub: 'Usage', ready: { text: /\d+\s*%/ } },
  { path: '/m/ai/skin', shell: false, ready: { sel: '.xterm-rows', text: /Claude Code/ } },
  { path: '/m/lights', tab: 'Lights', ready: { text: /\d+\s*of\s*\d+\s*on|No bulbs reported/i } },
  { path: '/m/media/dashboard', tab: 'Media', sub: 'Dashboard', ready: { text: /\b(new|newest|added)\b/i } },
  { path: '/m/media/movies', tab: 'Media', sub: 'Movies', ready: { text: /\d[\d,]*\s*titles/i } },
  { path: '/m/media/shows', tab: 'Media', sub: 'Shows', ready: { text: /\d[\d,]*\s*titles/i } },
  { path: '/m/media/music', tab: 'Media', sub: 'Music', ready: { text: /\d[\d,]*\s*artists/i } },
  { path: '/m/media/requests', tab: 'Media', sub: 'Requests', ready: { sel: '.vm-stats', text: /request/i } },
  { path: '/m/system/hosts', tab: 'System', sub: 'Hosts', ready: { text: /\d+\s*\/\s*\d+\s*online/i } },
  { path: '/m/system/services', tab: 'System', sub: 'Services', ready: { text: /\d+\s*up/i } },
  { path: '/m/system/trades', tab: 'System', sub: 'Trades', ready: { sel: '.sys-trade-eq', text: /\$\d/ } },
  { path: '/m/settings', settings: true, ready: { text: /appearance/i } },
  // the full pages outside the tabs (Calendar.tsx PageFrame): the strip and a bar back to the Dashboard
  { path: '/m/calendar', page: true, ready: { sel: '.cal-view', text: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/ } },
  { path: '/m/meals', page: true, ready: { sel: '.ml-totals[data-ready]', text: /calories/i } },
]

export const ROUTE_DEVICES = ['phone', 'landscape', 'ipad', 'ipadland', 'desktop', 'desk1080', 'desk1440']

function readyIn(spec) {
  const area = document.querySelector('.vl-page[data-active]') || document.querySelector('.vl-set') || document.querySelector('#root')
  if (!area) return false
  const n = spec.sel ? area.querySelectorAll(spec.sel).length : 1
  const txt = (area.innerText || '').replace(/\s+/g, ' ')
  const textOk = spec.text ? new RegExp(spec.text.re, spec.text.flags).test(txt) : true
  return n >= (spec.min ?? 1) && textOk
}

/** The checks every route shares, on one layout report. */
export function shellChecks(t, r, route) {
  const tag = `${route.path} @${t.test.device}`
  t.check(!r.crash, `${tag}: the crash screen is showing (render failed)`)
  t.check(r.v2, `${tag}: html[data-v2] is missing (the page shows "${r.body}")`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (scrollWidth ${r.docSW} > ${r.W})${r.wide.length ? `: ${r.wide.join(', ')}` : ''}`)
  t.check(r.areaSW <= r.areaCW + 1, `${tag}: the screen's content is wider than the screen (${r.areaSW} > ${r.areaCW})`)

  // the status strip (Brendon: the 5h preview was cutting into the date; it does not belong at the top)
  t.check(r.strip && r.strip.t <= 2, `${tag}: the status strip is not at the top`)
  t.check(!r.five, `${tag}: the AI 5h preview is still in the status strip`)
  t.check(!/\b5h\b/i.test(r.stripText), `${tag}: the status strip still says "5h" (${r.stripText.slice(0, 80)})`)
  t.check(r.dateShown, `${tag}: the date in the status strip is not showing`)
  t.check(!r.dateClipped, `${tag}: the date in the status strip ("${r.dateText}") is ${r.dateClipped}`)
  t.check(!r.overlapsDate.length, `${tag}: ${r.overlapsDate.join(', ')} sits on the date in the status strip`)
  if (r.date) t.check(r.date.l >= 0 && r.date.r <= r.W + 0.5, `${tag}: the date runs off the screen`)

  if (route.shell === false) return
  // tabs at the top (Settings shows its own bar with the way back instead)
  if (route.settings || route.page) {
    t.check(r.setbar && r.setbar.t < Math.min(90, r.H * 0.25), `${tag}: the ${route.page ? 'page' : 'Settings'} bar is not at the top`)
  } else {
    t.check(r.nav && r.nav.t < Math.min(90, r.H * 0.25), `${tag}: the tabs are not at the top (nav top ${r.nav ? Math.round(r.nav.t) : 'missing'})`)
    const labels = r.tabs.map((x) => x.label)
    t.check(TABS.every((l) => labels.includes(l)), `${tag}: tabs are ${JSON.stringify(labels)}, want ${JSON.stringify(TABS)}`)
    const off = r.tabs.filter((x) => !x.shown || x.box.l < -0.5 || x.box.r > r.W + 0.5 || x.box.t > r.H * 0.25)
    t.check(!off.length, `${tag}: tabs off screen or hidden: ${off.map((x) => x.label).join(', ')}`)
    const on = r.tabs.find((x) => x.on)
    t.check(on?.label === route.tab, `${tag}: the lit tab is ${on?.label ?? 'none'}, want ${route.tab}`)
    if (route.sub) {
      const s = r.subs.find((x) => x.on)
      t.check(s?.label === route.sub, `${tag}: the lit sub-tab is ${s?.label ?? 'none'}, want ${route.sub}`)
    }
  }
  t.check(r.gear, `${tag}: the Settings gear is missing from the status strip`)
  // a full page outside the tabs carries no lights button
  if (route.page) return
  // the lights button: bottom-left, on top of everything
  t.check(r.lamp && r.lampShown, `${tag}: the lights button is missing`)
  if (r.lamp) {
    t.check(r.lamp.l <= 32 && r.lamp.r <= r.W * 0.25, `${tag}: the lights button is not at the left (left ${Math.round(r.lamp.l)})`)
    t.check(r.lamp.b >= r.H - 40 && r.lamp.b <= r.H + 0.5, `${tag}: the lights button is not at the bottom (bottom ${Math.round(r.lamp.b)} of ${r.H})`)
    t.check(r.lampHit === 'self', `${tag}: the lights button is covered by ${r.lampHit}`)
  }
}

/** Brendon's notes, on the screens they are about. */
async function noteChecks(t, page, r, route) {
  const tag = `${route.path} @${t.test.device}`
  if (route.path === '/m/dashboard') {
    // "all the ticker needs to be is whether the trade bot is up or down, and whether is online or not. and then i like the 7 day thing"
    const tk = await page.eval(() => {
      const el = document.querySelector('.vl-page[data-active] .hm-tk')
      if (!el) return null
      return { text: (el.innerText || '').replace(/\s+/g, ' ').trim(), label: el.getAttribute('aria-label') || '' }
    })
    if (t.check(tk, `${tag}: the trade ticker is missing`)) {
      t.check(/\b(online|offline)\b|\bold\b/i.test(tk.text), `${tag}: the ticker does not say whether the bot is online ("${tk.text}")`)
      t.check(/\b7\s*D\b|7-day|7 day/i.test(tk.text), `${tag}: the ticker lost the 7-day change ("${tk.text}")`)
      t.check(/\b(up|down|flat)\b/i.test(tk.label), `${tag}: the ticker does not say up or down ("${tk.label}")`)
      t.check(!/\b(Mkt|Trips|Last)\b/.test(tk.text), `${tag}: the ticker still carries market, trips or last-trade cells ("${tk.text}")`)
    }
  }
  if (route.path === '/m/system/hosts') {
    // "its weird that the ai usage stats are under system under each host, and not under ai"
    const usage = await page.eval(() => !!document.querySelector('.vl-page[data-active] .sys-usage'))
    t.check(!usage && !/\bAI usage\b/i.test(r.txt), `${tag}: AI usage is still on System > Hosts`)
  }
  if (route.path === '/m/ai/usage') {
    t.check(/week/i.test(r.txt) && /\b5\s*h|5 hours?/i.test(r.txt), `${tag}: AI > Usage does not show the 5h and week windows`)
  }
}

export function routeTests() {
  const tests = []
  for (const route of ROUTES) {
    for (const device of ROUTE_DEVICES) {
      tests.push({
        name: `route:${route.path.replace(/^\/m\//, '')}:${device}`,
        group: 'routes',
        device,
        timeout: 45_000,
        async run(t) {
          const page = await t.page()
          const t0 = Date.now()
          await page.goto(route.path)
          const spec = { sel: route.ready.sel, min: route.ready.min, text: route.ready.text ? { re: route.ready.text.source, flags: route.ready.text.flags } : null }
          const ready = await page.waitFor(readyIn, { args: [spec], timeout: 8000, interval: 200 }).then(() => true, () => false)
          // "not stuck on loading after 8 s": the read below happens 8 s after the page opened
          await sleep(Math.max(600, 8000 - (Date.now() - t0)))
          const r = await page.eval(layoutReport)
          // a slow read says whether the backend (thor asleep, odin busy) or the page is behind
          const slow = page.slowApi(5000)
          const why = slow.length ? `; slow or failed reads: ${slow.slice(0, 5).join(', ')}` : '; every read answered in time, so the page is stuck'
          t.check(ready, `${route.path} @${device}: no live data after 8 s (want ${route.ready.sel ?? ''} ${route.ready.text ?? ''})${why}`)
          t.check(!r.loading.length, `${route.path} @${device}: still loading after 8 s: ${r.loading.map((s) => `"${s}"`).join(', ')}${why}`)
          if (slow.length && ready) t.note(`slow or failed reads: ${slow.join(', ')}`)
          const want = route.path
          t.check(r.path === want, `${route.path} @${device}: the address moved to ${r.path}`)
          t.check(r.visibility === 'visible', `${route.path} @${device}: the page is ${r.visibility} (rAF would not run)`)
          shellChecks(t, r, route)
          await noteChecks(t, page, r, route)
          await t.shot(page)
        },
      })
    }
  }
  return tests
}
