// SCHEMES: the Dashboard and System > Trades in two of Valkyrie's schemes
// (Cyan and Matrix). The scheme must paint (accent on <html>, no console
// errors), and Trades must carry no yellow (Brendon: "i love the trades tab but
// i dont like the yellow very much"): the equity chart's canvas pixels and
// every element's computed colors are sampled.

import { sleep } from '../lib/cdp.mjs'
import { yellowReport } from '../lib/checks.mjs'
import { quietThor, tradeStatus } from '../lib/fixtures.mjs'

const SCHEMES = [
  { id: 'cyan', accent: '#00ffe5' },
  { id: 'matrix', accent: '#00ff41' },
]

const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`

async function schemePainted(t, page, s) {
  const got = await page.waitFor(() => {
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()
    return fg ? { fg, mode: document.documentElement.dataset.mode } : null
  }, { message: 'no --fg on <html>' })
  t.check(got.mode === s.id, `html[data-mode] is ${got.mode}, want ${s.id}`)
  // the probe paints a hex; a registered @property may hand it back as rgb()
  const fg = got.fg.toLowerCase()
  t.check(fg === s.accent || fg.replace(/\s+/g, '') === hexToRgb(s.accent).replace(/\s+/g, ''), `--fg is ${got.fg}, want ${s.accent}`)
}

export function schemeTests() {
  const tests = []
  for (const s of SCHEMES) {
    tests.push({
      name: `scheme:${s.id}:dashboard`,
      group: 'schemes',
      device: 'phone',
      timeout: 40_000,
      async run(t) {
        const page = await t.page({ storage: { 'valkyrie-accent': s.accent } })
        quietThor(page)
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-hrow'), { timeout: 12_000, message: 'the Dashboard never showed its hosts' })
        await sleep(2500)
        await schemePainted(t, page, s)
        await t.shot(page)
      },
    })
    tests.push({
      name: `scheme:${s.id}:trades`,
      group: 'schemes',
      device: 'phone',
      timeout: 40_000,
      async run(t) {
        const page = await t.page({ storage: { 'valkyrie-accent': s.accent } })
        quietThor(page)
        // the real status, with history enough for the chart to draw
        page.mock('/api/tradebot/status', () => ({ status: 200, body: tradeStatus(t.env.trade, 0) }))
        await page.goto('/m/system/trades')
        await page.waitFor(() => {
          const c = document.querySelector('.vl-page[data-active] .sys-trade canvas')
          return c && c.width > 0
        }, { timeout: 12_000, message: 'the equity chart never drew' })
        // the draw-in takes about 1.2 s; give the glow pass time too
        await sleep(3000)
        await schemePainted(t, page, s)
        const y = await page.eval(yellowReport, '.vl-page[data-active] .sys-trade')
        if (y.error) { t.check(false, y.error); return }
        const ink = y.canvases.reduce((a, c) => a + (c.ink ?? 0), 0)
        const yellow = y.canvases.reduce((a, c) => a + (c.yellow ?? 0), 0)
        const errs = y.canvases.filter((c) => c.error).map((c) => c.error)
        t.check(!errs.length, `could not read the chart canvas: ${errs.join(', ')}`)
        t.check(ink > 200, `the chart canvas is nearly empty (${ink} inked pixels)`)
        const pct = ink ? (yellow / ink) * 100 : 0
        t.note(`chart: ${yellow} yellow of ${ink} inked pixels (${pct.toFixed(2)}%) across ${y.canvases.length} canvas(es)`)
        t.check(yellow <= Math.max(40, ink * 0.002), `the Trades chart draws yellow: ${yellow} of ${ink} inked pixels (${pct.toFixed(2)}%), e.g. ${y.canvases.flatMap((c) => c.sample ?? []).slice(0, 3).join(' ')}`)
        t.check(!y.dom.length, `yellow on the Trades view: ${y.dom.slice(0, 8).join('; ')}`)
        await t.shot(page)
      },
    })
  }
  return tests
}
