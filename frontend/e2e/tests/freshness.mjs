// READ freshness: Brendon asked for the trades number to be live, or at least
// updated every minute. On System > Trades and on the Dashboard (the ticker),
// the trade status must be read about every 60 s, and a new figure must reach
// the screen. Real time, about 130 s in one context; these two run first and
// in parallel with the rest of the suite.

import { sleep } from '../lib/cdp.mjs'
import { quietThor, tradeStatus } from '../lib/fixtures.mjs'

const WATCH_MS = 132_000

/** Read rounds: requests closer than 5 s apart are one round (two hooks reading together). */
function rounds(times) {
  const out = []
  for (const t of times) if (!out.length || t - out[out.length - 1] > 5000) out.push(t)
  return out
}

function freshTest({ id, route, readSel, label }) {
  return {
    name: `fresh:${id}`,
    group: 'freshness',
    device: 'phone',
    // mostly waiting: runs beside the pool instead of holding a slot
    background: true,
    timeout: WATCH_MS + 40_000,
    async run(t) {
      const page = await t.page()
      // only the trade reads matter here: thor's reads would only queue the other tests behind them
      quietThor(page)
      let bump = 0
      // the real status, with the equity and the 7-day change moved by $1 on every read
      page.mock('/api/tradebot/status', () => ({ status: 200, body: tradeStatus(t.env.trade, bump++) }))
      const t0 = Date.now()
      await page.goto(route)
      await page.waitFor((s) => {
        const el = document.querySelector(s)
        return el && /\$\d/.test(el.textContent || '')
      }, { args: [readSel], timeout: 15_000, message: `${label} never showed a figure` })
      const seen = [await page.eval((s) => document.querySelector(s)?.textContent?.trim() ?? '', readSel)]
      while (Date.now() - t0 < WATCH_MS) {
        await sleep(2000)
        const v = await page.eval((s) => document.querySelector(s)?.textContent?.trim() ?? '', readSel).catch(() => '')
        if (v && v !== seen[seen.length - 1]) seen.push(v)
      }
      const reads = page.api.filter((a) => a.path === '/api/tradebot/status' && a.method === 'GET').map((a) => a.at)
      const r = rounds(reads)
      const gaps = r.slice(1).map((x, k) => Math.round((x - r[k]) / 1000))
      t.note(`${reads.length} status reads in ${r.length} rounds, gaps ${gaps.join(', ')} s; ${label} showed ${seen.length} value(s): ${seen.join(' | ')}`)
      t.check(r.length >= 3, `${label}: the trade status was read in ${r.length} round(s) over ${Math.round(WATCH_MS / 1000)} s, want at least 3 (about every 60 s)`)
      t.check(gaps.length > 0 && Math.max(...gaps) <= 75, `${label}: the longest gap between reads was ${gaps.length ? Math.max(...gaps) : 'n/a'} s, want 75 s or less`)
      t.check(seen.length >= 2, `${label}: the figure on screen never changed while the status moved ($1 a read): ${seen.join(' | ')}`)
      await t.shot(page)
    },
  }
}

export function freshnessTests() {
  return [
    freshTest({ id: 'trades', route: '/m/system/trades', readSel: '.vl-page[data-active] .sys-trade-eq', label: 'System > Trades equity' }),
    freshTest({ id: 'ticker', route: '/m/dashboard', readSel: '.vl-page[data-active] .hm-tk', label: 'the Dashboard ticker' }),
  ]
}
