// SCHEMES: the Dashboard and System > Trades in four of Valkyrie's schemes
// (Cyan, Matrix, Red and Pink). The scheme must paint (accent on <html>, no
// console errors), and Trades must carry no yellow (Brendon: "i love the trades
// tab but i dont like the yellow very much"): the equity chart's canvas pixels
// and every element's computed colors are sampled.
//
// Red and Pink are the hard cases: their alert color (acc2) is Valkyrie's
// yellow, so a loss there takes the palette's loss tone (kit/theme.ts: the
// pale text tone) instead. The trade status is bent to a losing week, so the
// loss cells (the ticker's 7-day figure, Trades' change line and its down
// arrow) are on screen and checked: never yellow, and the loss tone.

import { sleep } from '../lib/cdp.mjs'
import { yellowReport } from '../lib/checks.mjs'
import { quietThor, tradeStatus } from '../lib/fixtures.mjs'

const SCHEMES = [
  { id: 'cyan', accent: '#00ffe5' },
  { id: 'matrix', accent: '#00ff41' },
  { id: 'red', accent: '#ff2a1a', reddish: true },
  { id: 'pink', accent: '#ff2d78', reddish: true },
]

const hexToRgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`

/** The real status with a losing week (and a losing day), so every loss cell shows. */
function losingStatus(real) {
  const t = tradeStatus(real, 0)
  t.history.change_usd = -Math.abs(Number(t.history.change_usd) || 12.5) - 3.21
  t.history.change_pct = -Math.abs(Number(t.history.change_pct) || 0.5) - 0.11
  return t
}

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

/**
 * The loss cells under `rootSel`: each one's color, the palette's --loss and
 * --acc2, and whether each reads as yellow (the same hue test as yellowReport).
 */
function lossReport(rootSel, cellSels) {
  const root = document.querySelector(rootSel)
  if (!root) return { error: `no ${rootSel}` }
  const rgb = (v) => {
    const s = String(v).trim()
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
    if (hex) return [1, 2, 3].map((k) => parseInt(hex[k], 16))
    const m = /rgba?\(([^)]+)\)/.exec(s)
    return m ? m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number) : null
  }
  const isYellow = (c) => {
    if (!c) return false
    const [r, g, b] = c
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    if (max < 140 || max === min || (max - min) / max < 0.45) return false
    let h
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h = (h * 60 + 360) % 360
    return h >= 40 && h <= 70
  }
  const css = getComputedStyle(document.documentElement)
  const loss = rgb(css.getPropertyValue('--loss'))
  const acc2 = rgb(css.getPropertyValue('--acc2'))
  const cells = []
  for (const sel of cellSels) {
    for (const el of root.querySelectorAll(sel)) {
      const c = rgb(getComputedStyle(el).color)
      cells.push({ sel, color: c, yellow: isYellow(c), isLoss: !!c && !!loss && c.every((v, k) => Math.abs(v - loss[k]) <= 2) })
    }
  }
  return { loss, acc2, lossYellow: isYellow(loss), acc2Yellow: isYellow(acc2), cells }
}

function checkLoss(t, r, s, where) {
  if (r.error) { t.check(false, r.error); return }
  t.check(!!r.loss, `${where}: no --loss on <html>`)
  t.check(!r.lossYellow, `${where}: --loss is yellow (${r.loss})`)
  // Red and Pink: the alert is the yellow, so the loss tone must differ from it; elsewhere it is the alert red
  if (s.reddish) t.check(r.acc2Yellow, `${where}: expected the alert to be yellow on ${s.id} (${r.acc2}); the test's premise changed`)
  else t.check(!!r.acc2 && !!r.loss && r.acc2.every((v, k) => v === r.loss[k]), `${where}: on ${s.id} the loss tone should be the alert red, got ${r.loss} vs ${r.acc2}`)
  t.check(r.cells.length > 0, `${where}: no loss cell on screen`)
  for (const c of r.cells) {
    t.check(!c.yellow, `${where}: ${c.sel} is yellow (${c.color})`)
    t.check(c.isLoss, `${where}: ${c.sel} is ${c.color}, want the loss tone ${r.loss}`)
  }
  t.note(`${where}: loss rgb(${r.loss}), ${r.cells.length} loss cell(s)`)
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
        page.mock('/api/tradebot/status', () => ({ status: 200, body: losingStatus(t.env.trade) }))
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-hrow'), { timeout: 12_000, message: 'the Dashboard never showed its hosts' })
        await page.waitFor(() => document.querySelector(".vl-page[data-active] .hm-tk-cell[data-dir='down']"), { timeout: 12_000, message: 'the ticker never showed the losing week' })
        await sleep(2500)
        await schemePainted(t, page, s)
        checkLoss(t, await page.eval(lossReport, '.vl-page[data-active] .hm-tk', [".hm-tk-cell[data-dir='down'] .hm-tk-v", '.hm-loss']), s, 'ticker')
        // nothing on the trade line is yellow (the bot's offline alert included)
        const y = await page.eval(yellowReport, '.vl-page[data-active] .hm-tk')
        if (y.error) t.check(false, y.error)
        else t.check(!y.dom.length, `yellow on the trade ticker: ${y.dom.slice(0, 6).join('; ')}`)
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
        // the real status, with history enough for the chart to draw, and a losing week
        page.mock('/api/tradebot/status', () => ({ status: 200, body: losingStatus(t.env.trade) }))
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
        checkLoss(t, await page.eval(lossReport, '.vl-page[data-active] .sys-trade', ['.sys-trade-chg[data-neg]', '.sys-trade-chg .sys-loss']), s, 'trades')
        await t.shot(page)
      },
    })
  }
  return tests
}
