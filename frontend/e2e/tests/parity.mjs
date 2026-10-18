// PARITY: the classic pages' functions, natively in v2, each against a fake
// backend (every write answered in the browser; a write a test did not expect
// is a 418 and a failure). Most run on a phone and on a monitor, since v2 is
// now the UI on both.
//
//   Media     Movies: the search (accents, every word, the year) and the four
//             sorts; Music: the search over the index and the server
//   Trades    positions, fills (an order's legs summed) and the judged scans,
//             in the phone's view tabs and in the monitor's three columns
//   Services  Restart on a running container and a user unit (two taps, 200
//             and 500); a system unit offers none
//   Calendar  the five views, stepping, Today; add, edit and delete an event
//             (and Undo), a refused save
//   Meals     log food by hand, change the servings, delete (and Undo)
//   Projects  New project by hand, edit (only what changed is sent),
//             archive (two taps), Show archived and Restore

import { sleep } from '../lib/cdp.mjs'
import {
  MUSIC_BEA, PROJ_ID, TARGETS, calendarBackend, calendarState, localDay, mealsBackend, mealsState, musicServer, plexLibrary,
  projList, projState, quietThor, servicesState, tradePage,
} from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })
const REFUSED = 'e2e refused this write'

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
  await sleep(300)
}

/** Waits (Node side) until the page has sent `n` writes; returns the n-th. */
async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}${page.writes.length ? `: ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}` : ''}`)
  return page.writes[n - 1]
}

/** Sets an input's (or a select's) value the way the user would, so React sees it. */
function setValue(sel, v, events = ['input', 'change'], index = 0) {
  const el = document.querySelectorAll(sel)[index]
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  for (const e of events) el.dispatchEvent(new Event(e, { bubbles: true }))
  return true
}

/** Types into a field: a tap to focus it, then the text as one insert. */
async function typeInto(page, sel, text) {
  await page.tap(sel)
  await page.eval((s) => { const el = document.querySelector(s); el?.focus(); el?.select?.() }, sel)
  await page.type(text)
}

// ---------- Media ----------

const VIEW = '.vl-page[data-active] .vm-view[data-on]'
const tileTitles = (v) => [...document.querySelectorAll(`${v} .vm-gtile .vm-tile-t`)].map((e) => e.textContent.trim())

function mediaTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `parity:movies:search-sort:${device}`,
      group: 'parity',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        plexLibrary(page)
        await page.goto('/m/media/movies')
        await shellUp(page)
        const titles = () => page.eval(tileTitles, VIEW)
        const head = () => page.eval((v) => document.querySelector(`${v} .vm-head-value`)?.textContent?.trim() ?? '', VIEW)
        await page.waitFor((v) => document.querySelectorAll(`${v} .vm-gtile`).length === 6, { args: [VIEW], timeout: 12_000, message: 'the six e2e movies did not show' })
        t.check(/^6 titles$/.test(await head()), `the header reads "${await head()}", want "6 titles"`)
        await t.step('Title: A to Z the way Plex files them (articles off, digits first)', async () => {
          const want = ['2001: A Space Odyssey', 'The Amazing Spider-Man', 'Amélie', 'Spider-Man', 'Spider-Man: Into the Spider-Verse', 'Zodiac']
          t.check(JSON.stringify(await titles()) === JSON.stringify(want), `title order ${JSON.stringify(await titles())}`)
          const az = await page.eval((v) => [...document.querySelectorAll(`${v} .vm-az-l:not([data-off])`)].map((e) => (e.getAttribute('aria-label') === 'Jump to numbers and symbols' ? '#' : e.getAttribute('aria-label').replace('Jump to ', ''))).join(''), VIEW)
          t.check(az === '#ASZ', `the A to Z strip lights ${az}, want #ASZ`)
        })
        const search = `${VIEW} input[aria-label="Search movies"]`
        await t.step('search: every word, accents and punctuation ignored, a year matches', async () => {
          await typeInto(page, search, 'spider man')
          await page.waitFor((v) => document.querySelectorAll(`${v} .vm-gtile`).length === 3, { args: [VIEW], message: '"spider man" did not narrow the list to three' })
          t.check(/^3 of 6$/.test(await head()), `the header reads "${await head()}" while searching, want "3 of 6"`)
          for (const [q, want] of [['amelie', ['Amélie']], ['2012', ['The Amazing Spider-Man']], ['verse spider', ['Spider-Man: Into the Spider-Verse']]]) {
            await page.eval(setValue, search, q, ['input'])
            await page.waitFor((v, w) => JSON.stringify([...document.querySelectorAll(`${v} .vm-gtile .vm-tile-t`)].map((e) => e.textContent.trim())) === JSON.stringify(w), { args: [VIEW, want], message: `"${q}" did not find ${want.join(', ')}` })
          }
          await page.eval(setValue, search, 'no such film', ['input'])
          await page.waitFor((v) => /Nothing in Movies matches/.test(document.querySelector(v)?.textContent ?? ''), { args: [VIEW], message: 'a search with no match says nothing' })
          await page.eval(setValue, search, '', ['input'])
          await page.waitFor((v) => document.querySelectorAll(`${v} .vm-gtile`).length === 6, { args: [VIEW], message: 'clearing the search did not bring the list back' })
        })
        for (const [aria, key, want] of [
          ['Sort by year, newest first', 'year', ['Spider-Man: Into the Spider-Verse', 'The Amazing Spider-Man', 'Zodiac', 'Spider-Man', 'Amélie', '2001: A Space Odyssey']],
          ['Sort by recently added', 'added', ['The Amazing Spider-Man', 'Zodiac', 'Spider-Man: Into the Spider-Verse', 'Spider-Man', 'Amélie', '2001: A Space Odyssey']],
          ['Sort by rating, highest first', 'rating', ['Spider-Man: Into the Spider-Verse', 'Amélie', '2001: A Space Odyssey', 'Zodiac', 'Spider-Man', 'The Amazing Spider-Man']],
        ]) {
          await t.step(`sort: ${key}`, async () => {
            await page.tap(`${VIEW} .vm-toggle[aria-label="${aria}"]`)
            await page.waitFor((v, w) => JSON.stringify([...document.querySelectorAll(`${v} .vm-gtile .vm-tile-t`)].map((e) => e.textContent.trim())) === JSON.stringify(w), { args: [VIEW, want], message: `sorting by ${key} did not give ${want.join(', ')}` })
            const s = await page.eval((v, a) => ({ pressed: document.querySelector(`${v} .vm-toggle[aria-label="${a}"]`)?.getAttribute('aria-pressed'), noaz: document.querySelector(`${v} .vm-lib`)?.hasAttribute('data-noaz'), stored: localStorage.getItem('v2.media.sort.movie') }), VIEW, aria)
            t.check(s.pressed === 'true' && s.noaz && s.stored === key, `sort ${key}: pressed ${s.pressed}, A to Z hidden ${s.noaz}, stored ${s.stored}`)
          })
        }
        await t.step('a sort keeps the search', async () => {
          await page.eval(setValue, search, 'spider', ['input'])
          await page.waitFor((v) => JSON.stringify([...document.querySelectorAll(`${v} .vm-gtile .vm-tile-t`)].map((e) => e.textContent.trim())) === JSON.stringify(['Spider-Man: Into the Spider-Verse', 'Spider-Man', 'The Amazing Spider-Man']), { args: [VIEW], message: 'searching under the rating sort lost the order or the filter' })
          await page.tap(`${VIEW} .vm-toggle[aria-label="Sort by title, A to Z"]`)
          await page.waitFor((v) => JSON.stringify([...document.querySelectorAll(`${v} .vm-gtile .vm-tile-t`)].map((e) => e.textContent.trim())) === JSON.stringify(['The Amazing Spider-Man', 'Spider-Man', 'Spider-Man: Into the Spider-Verse']), { args: [VIEW], message: 'back to Title under a search did not sort A to Z' })
        })
        if (device === 'desk1080') {
          await t.step('a monitor opens a title beside the grid; Escape closes it', async () => {
            await page.eval(setValue, search, '', ['input'])
            await page.waitFor((v) => document.querySelectorAll(`${v} .vm-gtile`).length === 6, { args: [VIEW], message: 'clearing the search did not bring the list back' })
            await page.tap(`${VIEW} .vm-gtile[aria-label^="Zodiac,"]`)
            await page.waitFor(() => document.querySelector('.vl-page[data-active] .vm-ldetail[aria-label="Zodiac"]'), { message: 'Zodiac did not open beside the grid' })
            await t.shot(page, 'pane')
            await page.key('Escape')
            await page.waitFor(() => !document.querySelector('.vl-page[data-active] .vm-ldetail'), { message: 'Escape did not close the title pane' })
          })
        }
        t.check(!page.writes.length, 'Movies wrote something')
      },
    })
  }
  out.push({
    name: 'parity:music:search',
    group: 'parity',
    device: 'desktop',
    timeout: 50_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      musicServer(page, { bea: MUSIC_BEA })
      await page.goto('/m/media/music')
      await shellUp(page)
      const sec = () => page.eval((v) => [...document.querySelectorAll(`${v} .vm-mres .vm-rsec`)].map((s) => ({
        head: s.querySelector('.vm-head-label')?.textContent?.trim(), n: s.querySelector('.vm-head-value')?.textContent?.trim(),
        rows: [...s.querySelectorAll('li')].map((li) => (li.querySelector('[aria-label]')?.getAttribute('aria-label') ?? li.textContent).trim()),
      })), VIEW)
      await page.waitFor((v) => /3 artists/.test(document.querySelector(`${v} .vm-head-value`)?.textContent ?? ''), { args: [VIEW], timeout: 12_000, message: 'the artist index did not read "3 artists"' })
      const box = `${VIEW} input[aria-label="Search music"]`
      await t.step('artists from the index, plus what the server found: an artist, an album, a track', async () => {
        await typeInto(page, box, 'bea')
        await page.waitFor((v) => document.querySelectorAll(`${v} .vm-mres .vm-rsec`).length === 3, { args: [VIEW], timeout: 6000, message: '"bea" did not show artists, albums and tracks' })
        const s = await sec()
        t.check(s[0]?.head === 'Artists' && s[0].n === '2' && /The Beatles/.test(s[0].rows[0]) && /Beach House/.test(s[0].rows[1] ?? ''), `Artists: ${JSON.stringify(s[0])}`)
        t.check(s[1]?.head === 'Albums' && /Abbey Road/.test(s[1].rows.join(' ')), `Albums: ${JSON.stringify(s[1])}`)
        t.check(s[2]?.head === 'Tracks' && /Come Together/.test(s[2].rows.join(' ')), `Tracks: ${JSON.stringify(s[2])}`)
        const asked = page.api.filter((r) => r.path === '/api/plex/music/search').map((r) => new URL(r.url).searchParams.get('q'))
        t.check(asked.length === 1 && asked[0] === 'bea', `the server was searched for ${JSON.stringify(asked)}, want once for "bea"`)
        await t.shot(page, 'bea')
      })
      await t.step('an accent in the name does not hide it', async () => {
        await page.eval(setValue, box, 'asgeir', ['input'])
        await page.waitFor((v) => [...document.querySelectorAll(`${v} .vm-mres .vm-rsec li`)].some((li) => /Ásgeir/.test(li.textContent)), { args: [VIEW], message: '"asgeir" did not find Ásgeir in the index' })
      })
      await t.step('no match says so', async () => {
        await page.eval(setValue, box, 'zzzz', ['input'])
        await page.waitFor((v) => /Nothing on the music server matches "zzzz"/.test(document.querySelector(`${v} .vm-mres`)?.textContent ?? ''), { args: [VIEW], timeout: 6000, message: 'a search with no match says nothing' })
      })
      await t.step('clearing it brings the artist list back', async () => {
        await page.tap(`${VIEW} .vm-msearch .vm-search-x`)
        await page.waitFor((v) => !document.querySelector(`${v} .vm-mres`) && /3 artists/.test(document.querySelector(`${v} .vm-head-value`)?.textContent ?? ''), { args: [VIEW], message: 'Clear search did not bring the artists back' })
      })
      t.check(!page.writes.length, 'Music wrote something')
    },
  })
  return out
}

// ---------- Trades ----------

function tradeTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `parity:trades:${device}`,
      group: 'parity',
      device,
      timeout: 50_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const doc = tradePage(t.env.trade)
        page.mock('/api/tradebot/page', () => ok(doc))
        page.mock('/api/tradebot/status', () => ok(doc.status))
        await page.goto('/m/system/trades')
        await shellUp(page)
        const root = '.vl-page[data-active] .sys-trade'
        await page.waitFor((r) => document.querySelector(r), { args: [root], timeout: 12_000, message: 'Trades did not render' })
        const cols = await page.eval((r) => Number(document.querySelector(r)?.getAttribute('data-cols')), root)
        if (device === 'desk1080') t.check(cols === 3, `a 1920 monitor at zoom 1.2 shows ${cols} Trades column(s), want 3`)
        else t.check(cols === 1, `the phone shows ${cols} Trades columns, want 1`)
        const tab = async (label) => {
          if (cols !== 1) return
          await page.tap({ sel: `${root} .sys-trade-tabs .sys-filter-btn`, text: new RegExp(`^\\s*${label}\\s*$`) })
          await sleep(300)
        }
        await t.step('positions', async () => {
          await tab('Overview')
          await page.waitFor((r) => document.querySelectorAll(`${r} .sys-positions .sys-pos:not(.sys-pos-head)`).length === 2, { args: [root], timeout: 10_000, message: 'Positions does not list the two open positions' })
          const rows = await page.eval((r) => [...document.querySelectorAll(`${r} .sys-positions .sys-pos:not(.sys-pos-head)`)].map((e) => [...e.children].map((c) => c.textContent.trim())), root)
          t.check(rows[0]?.[0] === 'E2EA' && rows[0][1] === '3' && /12\.34/.test(rows[0][3]), `the first position reads ${JSON.stringify(rows[0])}`)
          t.check(rows[1]?.[0] === 'E2EB' && /0\.5/.test(rows[1][1]) && /101\.50/.test(rows[1][3]), `the second position reads ${JSON.stringify(rows[1])}`)
        })
        await t.step('fills: one row per order, the legs summed, newest first', async () => {
          await tab('Fills')
          await page.waitFor((r) => document.querySelectorAll(`${r} .sys-fills .sys-fill`).length === 2, { args: [root], timeout: 8000, message: 'Recent fills does not show two orders' })
          const f = await page.eval((r) => [...document.querySelectorAll(`${r} .sys-fills .sys-fill`)].map((e) => ({ side: e.getAttribute('data-side'), sym: e.querySelector('.sys-fill-what b')?.textContent ?? '', what: e.querySelector('.sys-fill-what em')?.textContent ?? '', usd: e.querySelector('.sys-fill-usd')?.textContent ?? '', title: e.title })), root)
          t.check(f[0].side === 'buy' && f[0].sym === 'E2EA' && /^3 @ \$12\.34$/.test(f[0].what) && f[0].usd === '$37.02' && /2 legs/.test(f[0].title), `the newest fill reads ${JSON.stringify(f[0])} (want E2EA, 3 @ $12.34 over 2 legs, $37.02)`)
          t.check(f[1].side === 'sell' && f[1].sym === 'E2EC' && /^4 @ \$20\.00$/.test(f[1].what) && /^\$80(\.00)?$/.test(f[1].usd), `the older fill reads ${JSON.stringify(f[1])}`)
          const head = await page.eval((r) => document.querySelector(`${r} .sys-fills .vl-panel-head, ${r} .sys-fills header`)?.textContent ?? document.querySelector(`${r} .sys-fills`)?.textContent ?? '', root)
          t.check(/2 orders/.test(head), `the fills header does not say 2 orders: ${head.slice(0, 80)}`)
        })
        await t.step('decisions: the judged scans, the executed one marked, a tap opens the rest', async () => {
          await tab('Decisions')
          await page.waitFor((r) => document.querySelectorAll(`${r} .sys-decisions .sys-dec`).length === 2, { args: [root], timeout: 8000, message: 'Decisions does not list the two scans' })
          const d = await page.eval((r) => [...document.querySelectorAll(`${r} .sys-decisions .sys-dec`)].map((e) => ({ out: e.querySelector('.sys-dec-out')?.textContent ?? '', conf: e.querySelector('.sys-dec-conf b')?.textContent ?? '', sum: e.querySelector('.sys-dec-sum')?.textContent ?? '', notable: e.hasAttribute('data-notable') })), root)
          t.check(d[0].out === 'Executed' && d[0].conf === '0.82' && d[0].notable && /E2E executed scan/.test(d[0].sum), `the newest scan reads ${JSON.stringify(d[0])}`)
          t.check(d[1].out === 'No trade wanted' && d[1].conf === '0.20' && !d[1].notable, `the older scan reads ${JSON.stringify(d[1])}`)
          const chart = await page.eval((r) => document.querySelector(`${r} .sys-conf-plot`)?.getAttribute('aria-label') ?? '', root)
          t.check(/2 scans against the 0\.70 gate: 1 reached it/.test(chart), `the confidence chart says "${chart}"`)
          await page.tap({ sel: `${root} .sys-decisions .sys-dec-main`, index: 0 })
          await page.waitFor((r) => /Wanted 1 trade/.test(document.querySelector(`${r} .sys-dec[data-open] .sys-dec-more`)?.textContent ?? ''), { args: [root], message: 'a tap on the scan did not open its details' })
        })
        await t.shot(page)
        t.check(!page.writes.length, 'Trades wrote something')
      },
    })
  }
  return out
}

// ---------- Services: Restart on running services ----------

function serviceTests() {
  const out = []
  const targets = [
    { id: 'container', name: 'e2e-web', body: { kind: 'container', name: 'e2e-web' }, note: 'docker restart on odin' },
    { id: 'unit', name: 'e2e-api', body: { kind: 'service', name: 'e2e-api.service' }, note: 'systemctl --user restart on odin' },
  ]
  for (const s of targets) {
    for (const outcome of [200, 500]) {
      out.push({
        name: `parity:restart-running:${s.id}:${outcome === 200 ? 'ok' : 'fail500'}`,
        group: 'parity',
        device: s.id === 'unit' ? 'desk1080' : 'phone',
        timeout: 45_000,
        async run(t) {
          const st = servicesState()
          st.systemServices = [{ name: 'e2e-sys.service', load: 'loaded', active: 'active', sub: 'running', description: 'E2E system unit' }]
          const page = await t.page()
          quietThor(page)
          page.mock('/api/services', () => ok(st))
          page.onWrite((w) => {
            if (w.method !== 'POST' || w.path !== '/api/services/restart') return undefined
            return outcome === 200 ? ok({ ok: true }) : { status: 500, body: { error: REFUSED } }
          })
          await page.goto('/m/system/services')
          await shellUp(page)
          const row = (n) => ({ sel: '.vl-page[data-active] .sys-svc-item .sys-svc-main', text: new RegExp(`^\\s*${n}`) })
          await page.waitFor((n) => [...document.querySelectorAll('.vl-page[data-active] .sys-svc-item')].some((e) => e.querySelector('.sys-svc-name')?.textContent?.trim() === n), { args: [s.name], timeout: 12_000, message: `no ${s.name} row` })
          t.check(await page.eval((n) => ![...document.querySelectorAll('.vl-page[data-active] .sys-svc-down .sys-svc-name')].some((e) => e.textContent.trim() === n), s.name), `${s.name} is listed as down`)
          await page.tap(row(s.name))
          const btn = `.vl-page[data-active] .sys-svc-act[aria-label="Restart ${s.name}"]`
          await page.waitFor((b) => document.querySelector(b), { args: [btn], message: `the opened ${s.name} row has no Restart` })
          const note = await page.eval((n) => [...document.querySelectorAll('.vl-page[data-active] .sys-svc-item')].find((e) => e.querySelector('.sys-svc-name')?.textContent?.trim() === n)?.querySelector('.sys-more-act em')?.textContent ?? '', s.name)
          t.check(note === s.note, `the Restart note reads "${note}", want "${s.note}"`)
          await page.tap(btn)
          await page.waitFor((n) => document.querySelector(`.vl-page[data-active] .sys-svc-act[aria-label="Confirm: restart ${n}"]`), { args: [s.name], message: 'Restart did not ask to confirm' })
          await sleep(400)
          t.check(page.writes.length === 0, 'the first tap sent the restart without a confirm')
          const since = Date.now()
          const reads = page.api.filter((r) => r.path === '/api/services').length
          await page.tap(`.vl-page[data-active] .sys-svc-act[aria-label="Confirm: restart ${s.name}"]`)
          const w = await waitW(page, 1)
          t.check(JSON.stringify(w.json) === JSON.stringify(s.body), `restart sent ${w.body}, want ${JSON.stringify(s.body)}`)
          if (outcome === 200) {
            await page.waitToast(new RegExp(`Restarted ${s.name}`), { since })
            const t0 = Date.now()
            while (page.api.filter((r) => r.path === '/api/services').length <= reads && Date.now() - t0 < 4000) await sleep(100)
            t.check(page.api.filter((r) => r.path === '/api/services').length > reads, 'the list was not read again after the restart')
          } else {
            await page.waitToast(new RegExp(`Could not restart ${s.name}: 500`), { since })
            await page.waitFor((b) => document.querySelector(b), { args: [btn], message: 'the button did not go back to Restart after the refusal' })
          }
          if (s.id === 'unit') {
            await t.step('a system unit offers no Restart', async () => {
              await page.tap(row('e2e-sys'))
              await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] .sys-more-note')].some((e) => /System unit: Valkyrie restarts containers and user units only/.test(e.textContent)), { message: 'the system unit does not say why it has no Restart' })
              t.check(await page.eval(() => !document.querySelector('.vl-page[data-active] .sys-svc-act[aria-label="Restart e2e-sys"]')), 'the system unit offers a Restart')
            })
          }
          await sleep(300)
          t.check(page.writes.length === 1, `${page.writes.length} writes, want 1`)
          await t.shot(page)
        },
      })
    }
  }
  return out
}

// ---------- Calendar ----------

function calendarWrites(st, mode = 'ok') {
  return (w) => {
    if (mode !== 'ok') return { status: 500, body: { error: REFUSED } }
    const m = /^\/api\/calendar\/local-events(?:\/([\w-]+))?$/.exec(w.path)
    if (!m) return undefined
    if (w.method === 'POST' && !m[1]) {
      const ev = { id: `e2e-ev${++st.seq}`, ...w.json }
      st.local.push(ev)
      return ok({ ok: true, event: ev })
    }
    const i = st.local.findIndex((e) => e.id === m[1])
    if (i < 0) return { status: 404, body: { error: 'no such event' } }
    if (w.method === 'PATCH') {
      st.local[i] = { ...st.local[i], ...w.json }
      return ok({ ok: true, event: st.local[i] })
    }
    if (w.method === 'DELETE') {
      st.local.splice(i, 1)
      return ok({ ok: true })
    }
    return undefined
  }
}

const notice = (re) => (page) => page.waitFor((s) => new RegExp(s.re, s.flags).test(document.querySelector('.cal-notice')?.textContent ?? ''), { args: [{ re: re.source, flags: re.flags }], message: `no calendar notice matching ${re}` })

function calendarTests() {
  const out = []
  out.push({
    name: 'parity:calendar:views',
    group: 'parity',
    device: 'desk1080',
    timeout: 50_000,
    async run(t) {
      const st = calendarState()
      const page = await t.page()
      quietThor(page)
      calendarBackend(page, st)
      await page.goto('/m/calendar?view=week')
      await page.waitFor(() => document.querySelector('.cal-ui[data-layout="page"] .cal-view'), { timeout: 12_000, message: 'the calendar page did not render' })
      await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E standup"]'), { timeout: 8000, message: 'the week does not show the e2e event' })
      const title = () => page.eval(() => document.querySelector('.cal-title')?.textContent?.trim() ?? '')
      for (const [label, view, sel] of [
        ['Day', 'day', '.cal-g[data-cols="1"]'], ['Work week', 'workweek', '.cal-g[data-cols="5"]'], ['Week', 'week', '.cal-g[data-cols="7"]'],
        ['Month', 'month', '.cal-m'], ['Agenda', 'agenda', '.cal-agenda'],
      ]) {
        await t.step(`${label}`, async () => {
          await page.tap({ sel: '.cal-tabs .cal-tab', text: new RegExp(`^\\s*${label}\\s*$`) })
          await page.waitFor((v, s) => document.querySelector(`.cal-view[data-view="${v}"] ${s}`), { args: [view, sel], message: `${label} did not draw its view` })
          const s = await page.eval((v) => ({ url: location.search, stored: localStorage.getItem('v2.cal.view'), on: document.querySelector('.cal-tab[aria-selected="true"]')?.textContent?.trim() }), view)
          t.check(new URLSearchParams(s.url).get('view') === view && s.stored === view && s.on === label, `${label}: address ${s.url}, stored ${s.stored}, lit tab ${s.on}`)
          if (view !== 'workweek' || ![0, 6].includes(new Date().getDay())) {
            const shows = await page.eval(() => /E2E standup/.test(document.querySelector('.cal-view')?.textContent ?? '') || !!document.querySelector('.cal-ev[aria-label^="E2E standup"]'))
            t.check(shows, `${label} does not show today's e2e event`)
          }
          // forward, back, and Today
          const t0 = await title()
          await page.tap(`.cal-nav .cal-step:nth-of-type(2)`)
          await page.waitFor((x) => (document.querySelector('.cal-title')?.textContent?.trim() ?? '') !== x, { args: [t0], message: `${label}: the next step did not change the title (${t0})` })
          await page.waitFor(() => document.querySelector('.cal-nav .cal-today'), { message: `${label}: no Today away from today` })
          await page.tap('.cal-nav .cal-today')
          await page.waitFor((x) => (document.querySelector('.cal-title')?.textContent?.trim() ?? '') === x, { args: [t0], message: `${label}: Today did not come back to ${t0}` })
        })
      }
      await t.step('the arrow keys step the calendar, not the tabs', async () => {
        const t0 = await title()
        await page.key('ArrowRight')
        await page.waitFor((x) => (document.querySelector('.cal-title')?.textContent?.trim() ?? '') !== x, { args: [t0], message: 'ArrowRight did not step the calendar' })
        t.check((await page.path()).startsWith('/m/calendar'), `ArrowRight left the calendar for ${await page.path()}`)
      })
      t.check(!page.writes.length, 'the views wrote something')
    },
  })
  for (const device of ['desk1080', 'ipadland']) {
    out.push({
      name: `parity:calendar:crud:${device}`,
      group: 'parity',
      device,
      timeout: 60_000,
      async run(t) {
        const st = calendarState()
        const day = localDay()
        const page = await t.page()
        quietThor(page)
        calendarBackend(page, st)
        page.onWrite(calendarWrites(st))
        await page.goto('/m/calendar?view=day')
        await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E standup"]'), { timeout: 12_000, message: 'the day does not show the e2e event' })
        await t.step('add: New event, a title, Save', async () => {
          await page.tap({ sel: '.cal-new', text: 'New event' })
          await page.waitFor(() => document.querySelector('.cal-edit[aria-label="New event"] input[aria-label="Title"]'), { message: 'New event did not open the editor' })
          // a mouse gets the cursor in the title at once; a touch screen waits for a tap on it
          if (!t.test.device.startsWith('ipad')) t.check(await page.eval(() => document.activeElement?.getAttribute('aria-label') === 'Title'), 'the title field is not focused when the editor opens')
          await typeInto(page, '.cal-edit input[aria-label="Title"]', 'E2E new event')
          await page.eval(setValue, '.cal-edit input[type="time"]', '13:00', ['input'], 0)
          await page.eval(setValue, '.cal-edit input[type="time"]', '14:00', ['input'], 1)
          await page.tap('.cal-edit .cal-save')
          const w = await waitW(page, 1)
          t.check(w.method === 'POST' && w.path === '/api/calendar/local-events', `add sent ${w.method} ${w.path}`)
          const b = w.json ?? {}
          t.check(b.title === 'E2E new event' && b.sourceId === 'e2e-local' && b.allDay === false && b.start === `${day}T13:00` && b.end === `${day}T14:00` && b.rrule === '', `add sent ${w.body}`)
          await notice(/Added E2E new event/)(page)
          await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E new event"]'), { message: 'the new event did not show on the day' })
        })
        await t.step('edit: the title and the place, Save sends the event', async () => {
          await page.tap('.cal-ev[aria-label^="E2E standup"]')
          await page.waitFor(() => document.querySelector('.cal-detail[aria-label="E2E standup, details"]'), { message: 'the event did not open its details' })
          await page.tap({ sel: '.cal-detail-acts button, .cal-detail-acts .vl-press', text: 'Edit' })
          await page.waitFor(() => document.querySelector('.cal-edit[aria-label="Edit event"]'), { message: 'Edit did not open the editor' })
          await page.eval(setValue, '.cal-edit input[aria-label="Title"]', 'E2E standup moved', ['input'])
          await page.eval(setValue, '.cal-edit input[aria-label="Location"]', 'Kitchen', ['input'])
          await page.tap('.cal-edit .cal-save')
          const w = await waitW(page, 2)
          t.check(w.method === 'PATCH' && w.path === '/api/calendar/local-events/e2e-ev1', `edit sent ${w.method} ${w.path}`)
          t.check(w.json?.title === 'E2E standup moved' && w.json?.location === 'Kitchen' && w.json?.start === `${day}T10:00` && w.json?.end === `${day}T10:30`, `edit sent ${w.body}`)
          await notice(/Saved E2E standup moved/)(page)
          await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E standup moved"]'), { message: 'the edited event did not show its new title' })
        })
        await t.step('delete, then Undo puts it back', async () => {
          if (!(await page.eval(() => !!document.querySelector('.cal-detail[aria-label="E2E standup moved, details"]')))) await page.tap('.cal-ev[aria-label^="E2E standup moved"]')
          await page.waitFor(() => document.querySelector('.cal-detail[aria-label="E2E standup moved, details"] .cal-del'), { message: 'the details have no Delete' })
          await page.tap('.cal-detail .cal-del')
          const w = await waitW(page, 3)
          t.check(w.method === 'DELETE' && w.path === '/api/calendar/local-events/e2e-ev1', `delete sent ${w.method} ${w.path}`)
          await notice(/Deleted E2E standup moved/)(page)
          await page.waitFor(() => !document.querySelector('.cal-ev[aria-label^="E2E standup moved"]'), { message: 'the deleted event stayed on the day' })
          await page.tap('.cal-notice .cal-notice-btn')
          const u = await waitW(page, 4)
          t.check(u.method === 'POST' && u.json?.title === 'E2E standup moved' && u.json?.location === 'Kitchen' && u.json?.start === `${day}T10:00`, `Undo sent ${u.method} ${u.body}`)
          await notice(/Put back/)(page)
          await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E standup moved"]'), { message: 'Undo did not bring the event back' })
        })
        await t.step('a read-only feed event has no Edit or Delete', async () => {
          await page.tap('.cal-ev[aria-label^="E2E feed meeting"]')
          await page.waitFor(() => document.querySelector('.cal-detail[aria-label="E2E feed meeting, details"]'), { message: 'the feed event did not open' })
          const s = await page.eval(() => ({ acts: !!document.querySelector('.cal-detail .cal-detail-acts'), ro: /read-only feed/.test(document.querySelector('.cal-detail')?.textContent ?? '') }))
          t.check(!s.acts && s.ro, `the feed event: actions ${s.acts}, says read-only ${s.ro}`)
        })
        await t.shot(page)
        t.check(page.writes.length === 4, `${page.writes.length} writes, want 4`)
      },
    })
  }
  // the Dashboard's Calendar block: the sheet on an upright iPad (and it stays open after the tap), the page on a monitor
  for (const [device, want] of [['ipad', 'sheet'], ['desk1080', 'page']]) {
    out.push({
      name: `parity:calendar:open:${device}`,
      group: 'parity',
      device,
      timeout: 40_000,
      async run(t) {
        const st = calendarState()
        const page = await t.page()
        quietThor(page)
        calendarBackend(page, st)
        await page.goto('/m/dashboard')
        await shellUp(page)
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-g-press'), { timeout: 12_000, message: 'no Calendar block on the Dashboard' })
        await sleep(600)
        await page.tap('.vl-page[data-active] .hm-cal .hm-g-press')
        if (want === 'sheet') {
          await page.waitFor(() => document.querySelector('.cal-root[data-shown] .cal-ui[data-layout="sheet"]'), { message: 'the Calendar block did not open the sheet' })
          await sleep(900)
          t.check(await page.eval(() => !!document.querySelector('.cal-root[data-shown]')), 'the sheet closed again right after the tap that opened it')
          // a press on the dimmed backdrop still closes it
          await page.tap({ x: 20, y: 60 })
          await page.waitFor(() => !document.querySelector('.cal-root'), { timeout: 3000, message: 'a tap on the backdrop did not close the sheet' })
        } else {
          await page.waitPath('/m/calendar', 8000)
          await page.waitFor(() => document.querySelector('.cal-ui[data-layout="page"] .cal-ev[aria-label^="E2E standup"]'), { timeout: 10_000, message: 'the page did not open on today with its event' })
          await page.tap('.vl-setbar-back')
          await page.waitPath('/m/dashboard', 8000)
        }
        t.check(!page.writes.length, 'opening the calendar wrote something')
      },
    })
  }
  out.push({
    name: 'parity:calendar:refused',
    group: 'parity',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const st = calendarState()
      const page = await t.page()
      quietThor(page)
      calendarBackend(page, st)
      page.onWrite(calendarWrites(st, 'fail'))
      await page.goto('/m/calendar?view=day')
      await page.waitFor(() => document.querySelector('.cal-ev[aria-label^="E2E standup"]'), { timeout: 12_000, message: 'the day does not show the e2e event' })
      await page.tap({ sel: '.cal-new', text: 'New event' })
      await page.waitFor(() => document.querySelector('.cal-edit[aria-label="New event"]'), { message: 'New event did not open the editor' })
      await page.type('E2E refused event')
      await page.tap('.cal-edit .cal-save')
      await waitW(page, 1)
      await page.waitFor(() => /500|refused|failed/i.test(document.querySelector('.cal-edit .cal-err')?.textContent ?? ''), { message: 'a refused save shows no error in the editor' })
      t.check(await page.eval(() => !!document.querySelector('.cal-edit[aria-label="New event"]') && document.querySelector('.cal-edit input[aria-label="Title"]')?.value === 'E2E refused event'), 'the editor closed or lost the title after a refused save')
      t.check(await page.eval(() => !document.querySelector('.cal-ev[aria-label^="E2E refused event"]')), 'the refused event shows on the calendar')
      // the delete refused too: the event stays, the details say why
      await page.tap('.cal-edit .cal-close')
      await page.tap('.cal-ev[aria-label^="E2E standup"]')
      await page.tap('.cal-detail .cal-del')
      await waitW(page, 2)
      await page.waitFor(() => (document.querySelector('.cal-detail .cal-err')?.textContent ?? '').length > 0, { message: 'a refused delete shows no error' })
      t.check(await page.eval(() => !!document.querySelector('.cal-ev[aria-label^="E2E standup"]')), 'the event left the calendar after a refused delete')
    },
  })
  return out
}

// ---------- Meals ----------

function mealsTests() {
  const out = []
  for (const device of ['desk1080', 'phone']) {
    out.push({
      name: `parity:meals:${device}`,
      group: 'parity',
      device,
      timeout: 60_000,
      async run(t) {
        const day = localDay()
        const st = mealsState(day)
        const page = await t.page({ storage: { 'v2.meals.add': 'hand' } })
        quietThor(page)
        mealsBackend(page, st, day)
        page.onWrite((w) => {
          if (w.method === 'POST' && w.path === '/api/meals') {
            const meal = { id: `e2e-meal${++st.seq}`, servings: 1, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, note: '', source: 'manual', photoId: '', time: '', slot: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...w.json }
            st.meals.push(meal)
            return ok({ ok: true, meal })
          }
          const m = /^\/api\/meals\/([\w-]+)$/.exec(w.path)
          const i = m ? st.meals.findIndex((x) => x.id === m[1]) : -1
          if (w.method === 'PATCH' && i >= 0) {
            st.meals[i] = { ...st.meals[i], ...w.json }
            return ok({ ok: true, meal: st.meals[i] })
          }
          if (w.method === 'DELETE' && i >= 0) {
            st.meals.splice(i, 1)
            return ok({ ok: true })
          }
          return undefined
        })
        await page.goto('/m/meals')
        await page.waitFor(() => document.querySelector('.ml-totals[data-ready]') && document.querySelectorAll('.ml-row').length === 2, { timeout: 12_000, message: 'Meals did not show the day\'s two entries' })
        const cal = () => page.eval(() => (document.querySelector('.ml-totals')?.textContent ?? '').replace(/\s+/g, ' '))
        t.check(/910/.test(await cal()), `the totals do not add up to 910 cal: ${await cal()}`)
        await t.step('log food by hand', async () => {
          if (!(await page.eval(() => !!document.querySelector('.ml-add')))) {
            await page.tap({ sel: '.ml-logbtn', text: 'Log food' })
            await page.waitFor(() => document.querySelector('.ml-add'), { message: 'Log food did not open the add panel' })
          }
          await page.waitFor(() => document.querySelector('.ml-add input[aria-label="What you ate"]'), { message: 'the add panel is not on By hand' })
          await typeInto(page, '.ml-add input[aria-label="What you ate"]', 'E2E apple')
          const fields = await page.eval(() => [...document.querySelectorAll('.ml-add .ml-flabel')].map((l) => l.querySelector('span')?.textContent?.trim()))
          const at = (label) => `.ml-add .ml-flabel:nth-of-type(${fields.indexOf(label) + 1}) input`
          await page.eval(setValue, at('Calories'), '95', ['input'])
          await page.eval(setValue, at('Carbs (g)'), '25', ['input'])
          await page.eval(setValue, at('Fiber (g)'), '4.4', ['input'])
          await page.tap({ sel: '.ml-add .ml-acts button, .ml-add .ml-acts .vl-press', text: 'Log it' })
          const w = await waitW(page, 1)
          const b = w.json ?? {}
          t.check(w.path === '/api/meals' && b.date === day && b.name === 'E2E apple' && b.calories === 95 && b.carbs === 25 && b.fiber === 4.4 && b.servings === 1 && b.source === 'manual', `log sent ${w.body}`)
          await page.waitToast(/Logged E2E apple/)
          await page.waitFor(() => [...document.querySelectorAll('.ml-row')].some((r) => /E2E apple/.test(r.textContent)), { message: 'the logged food did not show in the log' })
          await page.waitFor(() => /1,005/.test(document.querySelector('.ml-totals')?.textContent ?? ''), { message: `the totals did not move to 1,005 cal (${''})` })
        })
        await t.step('change the servings', async () => {
          await page.tap({ sel: '.ml-row .ml-row-main', text: 'E2E burrito bowl' })
          await page.waitFor(() => document.querySelector('.ml-edit input[aria-label="Servings"]'), { message: 'the row did not open' })
          await page.tap('.ml-edit .ml-sbtn[aria-label="Half a serving more"]')
          await page.tap({ sel: '.ml-edit .ml-save', text: 'Save' })
          const w = await waitW(page, 2)
          t.check(w.method === 'PATCH' && w.path === '/api/meals/e2e-meal2' && JSON.stringify(w.json) === '{"servings":1.5}', `servings sent ${w.method} ${w.path} ${w.body}`)
          await page.waitToast(/E2E burrito bowl: 1\.5 servings/)
        })
        await t.step('delete, then Undo logs it again', async () => {
          await page.tap({ sel: '.ml-row .ml-row-main', text: 'E2E yogurt' })
          await page.waitFor(() => document.querySelector('.ml-edit .ml-del'), { message: 'the row has no Delete' })
          await page.tap('.ml-edit .ml-del')
          const w = await waitW(page, 3)
          t.check(w.method === 'DELETE' && w.path === '/api/meals/e2e-meal1', `delete sent ${w.method} ${w.path}`)
          await page.waitToast(/Deleted E2E yogurt/)
          await page.waitFor(() => ![...document.querySelectorAll('.ml-row')].some((r) => /E2E yogurt/.test(r.textContent)), { message: 'the deleted entry stayed' })
          await page.tap({ sel: '.vl-toast-btn', text: /Undo/ })
          const u = await waitW(page, 4)
          t.check(u.method === 'POST' && u.json?.name === 'E2E yogurt' && u.json?.calories === 220 && u.json?.date === day && u.json?.slot === 'breakfast', `Undo sent ${u.method} ${u.body}`)
          await page.waitToast(/E2E yogurt is back/)
        })
        await t.step('the day bar steps to an empty day and back', async () => {
          await page.tap('.ml-step[aria-label="The day before"]')
          await page.waitFor(() => /Nothing logged for this day/.test(document.querySelector('.ml-log')?.textContent ?? ''), { message: 'the day before is not empty' })
          await page.tap({ sel: '.ml-today', text: 'Today' })
          await page.waitFor(() => document.querySelectorAll('.ml-row').length >= 3, { message: 'Today did not come back' })
        })
        await t.shot(page)
        t.check(page.writes.length === 4, `${page.writes.length} writes, want 4`)
      },
    })
  }
  return out
}

// ---------- Projects: new, edit, archive ----------

function projectsTests() {
  return [{
    name: 'parity:projects:new-edit-archive',
    group: 'parity',
    device: 'desk1080',
    timeout: 70_000,
    async run(t) {
      const base = projState()
      const NEW = 'e2e-new-project'
      const docs = { [PROJ_ID]: base.doc }
      const list = () => Object.values(docs).map((doc) => projList({ doc })[0])
      const page = await t.page()
      quietThor(page)
      page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
      page.mock('/api/proj', ({ query }) => ok(query.archived === '1' ? list() : list().filter((p) => p.status !== 'archived')))
      page.mock(/^\/api\/proj\/[\w-]+$/, ({ path }) => {
        const doc = docs[path.split('/').pop()]
        return doc ? ok(doc) : { status: 404, body: { error: 'no such project' } }
      })
      page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
      page.onWrite((w) => {
        if (w.method === 'POST' && w.path === '/api/proj') {
          const doc = structuredClone(base.doc)
          Object.assign(doc.project, { id: NEW, name: w.json.name, area: w.json.area, targetKey: w.json.targetKey, summary: w.json.summary ?? '', nextAction: '', status: 'active' })
          doc.tabs = []
          doc.reminders = []
          docs[NEW] = doc
          return { status: 201, body: doc }
        }
        const m = /^\/api\/proj\/([\w-]+)(\/archive)?$/.exec(w.path)
        if (!m || !docs[m[1]]) return undefined
        if (w.method === 'PATCH' && !m[2]) {
          Object.assign(docs[m[1]].project, w.json, { updatedAt: new Date().toISOString() })
          return ok(docs[m[1]])
        }
        if (w.method === 'POST' && m[2]) {
          docs[m[1]].project.status = 'archived'
          return ok({ ok: true })
        }
        return undefined
      })
      await page.goto('/m/ai/projects?new=1')
      await shellUp(page)
      await t.step('New project: Set up by hand, name, folder, summary, Create', async () => {
        await page.waitFor(() => document.querySelector('.vc-sheet .vp-form'), { timeout: 10_000, message: '?new=1 did not open the New project sheet' })
        await page.tap({ sel: '.vc-sheet .vp-form .vl-link', text: 'Set up by hand' })
        await page.waitFor(() => document.querySelector('.vc-sheet .vp-form input.vc-field'), { message: 'Set up by hand did not open the form' })
        await typeInto(page, '.vc-sheet .vp-form input.vc-field', 'E2E New Project')
        await page.waitFor(() => /id: e2e-new-project/.test(document.querySelector('.vc-sheet .vp-form')?.textContent ?? ''), { message: 'the form does not show the id the name becomes' })
        t.check(await page.eval(() => document.querySelector('.vc-sheet .vp-main')?.disabled === true), 'Create is enabled before a folder is picked')
        await page.waitFor(() => [...document.querySelectorAll('.vc-sheet select.vp-select option')].some((o) => o.value === 'alpha'), { message: 'the folder list has no Alpha' })
        await page.eval(setValue, '.vc-sheet select.vp-select', 'alpha', ['change'])
        await page.eval(setValue, '.vc-sheet .vp-form textarea.vc-field', 'Made by the e2e suite.', ['input'])
        await page.tap({ sel: '.vc-sheet .vp-main', text: 'Create' })
        const w = await waitW(page, 1)
        t.check(w.method === 'POST' && w.path === '/api/proj' && JSON.stringify(w.json) === JSON.stringify({ name: 'E2E New Project', area: 'personal', targetKey: 'alpha', summary: 'Made by the e2e suite.' }), `create sent ${w.method} ${w.path} ${w.body}`)
        await page.waitToast(/Created E2E New Project/)
        await page.waitFor(() => !document.querySelector('.vc-sheet-root[data-shown] .vp-form'), { message: 'the sheet stayed open after Create' })
        await page.waitFor(() => document.querySelector('.vc-detail .vc-detail-name')?.textContent?.trim() === 'E2E New Project', { timeout: 8000, message: 'the new project did not open beside the list' })
        await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] .vc-prow .vc-row-title')].some((e) => e.textContent.trim() === 'E2E New Project'), { message: 'the new project is not on the list' })
      })
      await t.step('Edit: rename and pause, Save sends only what changed', async () => {
        await page.tap({ sel: '.vc-detail .vc-pd-links .vl-link', text: 'Edit' })
        await page.waitFor(() => document.querySelector('.vc-detail form.vp-settings'), { message: 'Edit did not open the settings form' })
        await page.eval(setValue, '.vc-detail form.vp-settings .vc-flabel:nth-child(1) input', 'E2E Renamed', ['input'])
        await page.tap({ sel: '.vc-detail form.vp-settings .vl-seg-cell', text: 'Paused' })
        await page.tap('.vc-detail form.vp-settings .vc-edit-save')
        const w = await waitW(page, 2)
        t.check(w.method === 'PATCH' && w.path === `/api/proj/${NEW}` && JSON.stringify(w.json) === JSON.stringify({ name: 'E2E Renamed', status: 'paused' }), `edit sent ${w.method} ${w.path} ${w.body}`)
        await page.waitToast(/Saved E2E Renamed/)
        await page.waitFor(() => !document.querySelector('.vc-detail form.vp-settings'), { message: 'the form stayed open after Save' })
      })
      await t.step('Archive: two taps; it leaves the list', async () => {
        await page.tap({ sel: '.vc-detail .vc-pd-links .vl-link', text: 'Edit' })
        await page.waitFor(() => document.querySelector('.vc-detail form.vp-settings .vp-archive'), { message: 'the settings form has no Archive' })
        await page.tap('.vc-detail form.vp-settings .vp-archive')
        await page.waitFor(() => /Archive\?/.test(document.querySelector('.vc-detail .vp-archive')?.textContent ?? ''), { message: 'the first tap did not arm Archive' })
        await sleep(300)
        t.check(page.writes.length === 2, 'the first tap on Archive already archived')
        await page.tap('.vc-detail form.vp-settings .vp-archive')
        const w = await waitW(page, 3)
        t.check(w.method === 'POST' && w.path === `/api/proj/${NEW}/archive`, `archive sent ${w.method} ${w.path}`)
        await page.waitToast(/Archived E2E Renamed\. Show archived brings it back/)
        await page.waitFor(() => document.querySelector('.vc-detail .vc-detail-name')?.textContent?.trim() !== 'E2E Renamed', { message: 'the archived project stayed open' })
        await page.waitFor(() => ![...document.querySelectorAll('.vl-page[data-active] .vc-group:not([data-g="archived"]) .vc-prow .vc-row-title')].some((e) => e.textContent.trim() === 'E2E Renamed'), { message: 'the archived project stayed on the list' })
      })
      await t.step('Show archived lists it; Restore puts it back', async () => {
        await page.tap({ sel: '.vl-page[data-active] .vc-arch-foot .vl-link', text: 'Show archived' })
        await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] [data-g="archived"] .vc-prow .vc-row-title')].some((e) => e.textContent.trim() === 'E2E Renamed'), { timeout: 8000, message: 'Show archived does not list the archived project' })
        await page.tap({ sel: '.vl-page[data-active] [data-g="archived"] .vc-prow', text: 'E2E Renamed' })
        await page.waitFor(() => document.querySelector('.vc-detail .vc-pd-start') && /Restore project/.test(document.querySelector('.vc-detail .vc-pd-start')?.textContent ?? ''), { message: 'the archived project does not offer Restore' })
        await page.tap('.vc-detail .vc-pd-start')
        const w = await waitW(page, 4)
        t.check(w.method === 'PATCH' && w.path === `/api/proj/${NEW}` && JSON.stringify(w.json) === '{"status":"active"}', `restore sent ${w.method} ${w.path} ${w.body}`)
      })
      await t.shot(page)
      t.check(page.writes.length === 4, `${page.writes.length} writes, want 4`)
    },
  }, {
    name: 'parity:projects:refused',
    group: 'parity',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const st = projState()
      const page = await t.page()
      quietThor(page)
      page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
      page.mock('/api/proj', () => ok(projList(st)))
      page.mock(`/api/proj/${PROJ_ID}`, () => ok(st.doc))
      page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
      page.onWrite(() => ({ status: 500, body: { error: REFUSED } }))
      await page.goto(`/m/ai/projects?p=${PROJ_ID}`)
      await shellUp(page)
      await page.waitFor(() => document.querySelector('.vc-detail .vc-detail-name')?.textContent?.trim() === 'E2E Project', { timeout: 12_000, message: '?p= did not open the project beside the list' })
      await page.tap({ sel: '.vc-detail .vc-pd-links .vl-link', text: 'Edit' })
      await page.waitFor(() => document.querySelector('.vc-detail form.vp-settings .vp-archive'), { message: 'no Archive in the settings form' })
      await page.tap('.vc-detail form.vp-settings .vp-archive')
      await page.tap('.vc-detail form.vp-settings .vp-archive')
      await waitW(page, 1)
      await page.waitFor(() => /Could not archive it: .*e2e refused/i.test(document.querySelector('.vc-detail form.vp-settings')?.textContent ?? ''), { message: 'a refused archive does not say why' })
      t.check(await page.eval(() => document.querySelector('.vc-detail .vc-detail-name')?.textContent?.trim() === 'E2E Project'), 'the project closed after a refused archive')
      await page.eval(setValue, '.vc-detail form.vp-settings .vc-flabel:nth-child(2) input', 'Next step after a refusal', ['input'])
      await page.tap('.vc-detail form.vp-settings .vc-edit-save')
      await waitW(page, 2)
      await page.waitFor(() => /Could not save: .*e2e refused/i.test(document.querySelector('.vc-detail form.vp-settings')?.textContent ?? ''), { message: 'a refused save does not say why' })
      t.check(await page.eval(() => !!document.querySelector('.vc-detail form.vp-settings')), 'the form closed after a refused save')
    },
  }]
}

export function parityTests() {
  return [...mediaTests(), ...tradeTests(), ...serviceTests(), ...calendarTests(), ...mealsTests(), ...projectsTests()]
}
