// INBOX: the inbox page (src/v2/screens/Inbox.tsx, /m/inbox) and the strip's inbox button over a
// fake inbox in the backend's shapes (routes/inbox.ts). Every write (read, archive, push setting)
// is caught in the browser and changes the fake the way the store would. Generic names only:
// this repo is public.
//
//   list       newest first, unread rows lit, the alert's hot mark, ET times, the strip's count
//              with its alert color, no overflow (phone, desktop, desk1080)
//   open       a row opens to its text with a live link and reads itself; Mark unread; Open
//              goes to the item's app path; Archive with Undo
//   bulk       Mark all read, Archive read, the source filter asking for that source
//   sources    the Sources tab and a push setting sent as a PUT
//   push-tap   ?item=<id> opens and reads that row; an archived one is found in the archive
//   strip      the strip's button on the dashboard opens the inbox
//   down       the inbox not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/inbox'
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()

function item(id, over = {}) {
  const at = iso(Date.now() - id * 7 * MIN)
  return {
    id, source: 'backups', level: 'warn', title: `Item ${id}`, body: `First line of ${id}\nSecond line`,
    url: null, tag: null, count: 1, firstAt: at, lastAt: at, readAt: null, archivedAt: null, pushedAt: at, pushDetail: 'sent to 1',
    ...over,
  }
}

/** The fake: items, the GET mocks and the write handler. Returns the state and the GET log. */
function inboxBackend(page, { down = false } = {}) {
  const st = {
    items: [
      item(1, { source: 'raid', level: 'alert', title: '[odin RAID] Fail on /dev/md0', body: 'mdstat: degraded\nSee https://example.com/raid-guide for the steps', url: '/m/system/hosts' }),
      item(2, { source: 'trade', level: 'info', title: 'Guard v2 | 10:20 ET', body: 'held', pushedAt: null, pushDetail: null }),
      item(3, { source: 'backups', title: 'Backup watchdog: 1 problem', count: 3, firstAt: iso(Date.now() - 3 * 86_400_000) }),
      item(4, { source: 'reminder', title: 'Change the filter', readAt: iso(Date.now() - 3600_000) }),
      item(40, { source: 'trade', level: 'info', title: 'Archived report', readAt: iso(Date.now() - 86_400_000), archivedAt: iso(Date.now() - 3600_000), pushedAt: null, pushDetail: null }),
    ],
    push: { raid: 'auto', trade: 'off', backups: 'auto', reminder: 'on' },
    gets: [],
  }
  const count = () => {
    const open = st.items.filter((i) => !i.archivedAt)
    const unread = open.filter((i) => !i.readAt)
    return { unread: unread.length, alerts: unread.filter((i) => i.level === 'alert').length, lastAt: open[0]?.lastAt ?? null }
  }
  const sources = () => Object.keys(st.push).map((source) => {
    const mine = st.items.filter((i) => i.source === source)
    const open = mine.filter((i) => !i.archivedAt)
    return { source, open: open.length, unread: open.filter((i) => !i.readAt).length, push: st.push[source], lastAt: mine[0]?.lastAt ?? null }
  })
  const select = (j, view) => st.items.filter((i) => (j.ids ? j.ids.includes(i.id) : (view === 'archive' ? !!i.archivedAt : !i.archivedAt) && (j.all || i.source === j.source)))
  page.mock('/api/inbox', ({ query }) => {
    st.gets.push({ ...query })
    if (down) return { status: 503, body: { error: 'down' } }
    const view = query.view === 'archive' ? 'archive' : 'open'
    const items = st.items
      .filter((i) => (view === 'archive' ? !!i.archivedAt : !i.archivedAt) && (!query.source || i.source === query.source))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    return ok({ view, items, sources: sources(), count: count() })
  })
  page.mock('/api/inbox/count', () => (down ? { status: 503, body: { error: 'down' } } : ok(count())))
  page.onWrite((w) => {
    const j = w.json ?? {}
    if (w.method === 'POST' && w.path === '/api/inbox/read') {
      let changed = 0
      for (const i of select(j, 'open')) {
        if (j.read !== false && !i.readAt) { i.readAt = iso(Date.now()); changed++ }
        if (j.read === false && i.readAt) { i.readAt = null; changed++ }
      }
      return ok({ ok: true, changed, count: count() })
    }
    if (w.method === 'POST' && w.path === '/api/inbox/archive') {
      let changed = 0
      for (const i of select(j, j.archived === false ? 'archive' : 'open')) {
        if (j.archived !== false && !i.archivedAt && (!j.readOnly || i.readAt)) { i.archivedAt = iso(Date.now()); i.readAt ??= iso(Date.now()); changed++ }
        if (j.archived === false && i.archivedAt) { i.archivedAt = null; changed++ }
      }
      return ok({ ok: true, changed, count: count() })
    }
    const m = /^\/api\/inbox\/sources\/([a-z0-9-]+)$/.exec(w.path)
    if (w.method === 'PUT' && m) {
      st.push[m[1]] = j.push
      return ok({ ok: true, sources: sources() })
    }
    return undefined
  })
  return st
}

const pageUp = (page) => page.waitFor(() => !!document.querySelector('.ib .ib-tabs'), { timeout: 12_000, message: 'the inbox page did not come up' })
const rowsUp = (page, n) => page.waitFor((k) => document.querySelectorAll('.ib-row').length === k, { args: [n], timeout: 8000, message: `the inbox did not show ${n} rows` })
const titles = (page) => page.eval(() => [...document.querySelectorAll('.ib-row .ib-text b')].map((b) => b.firstChild?.textContent ?? ''))

async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

async function fits(t, page, tag) {
  const r = await page.eval(layoutReport)
  t.check(!r.crash, `${tag}: the crash screen is showing`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (${r.docSW} > ${r.W})${r.wide?.length ? `: ${r.wide.join(', ')}` : ''}`)
}

export function inboxTests() {
  const tests = []
  for (const device of ['phone', 'desktop', 'desk1080']) {
    tests.push({
      name: `inbox:list:${device}`,
      group: 'inbox',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        inboxBackend(page)
        await page.goto(ROUTE)
        await pageUp(page)
        await rowsUp(page, 4)
        const order = await titles(page)
        t.check(JSON.stringify(order) === JSON.stringify(['[odin RAID] Fail on /dev/md0', 'Guard v2 | 10:20 ET', 'Backup watchdog: 1 problem', 'Change the filter']), `rows are not newest first: ${JSON.stringify(order)}`)
        const marks = await page.eval(() => [...document.querySelectorAll('.ib-row')].map((r) => `${r.dataset.level}:${r.hasAttribute('data-unread') ? 'u' : 'r'}`))
        t.check(JSON.stringify(marks) === JSON.stringify(['alert:u', 'info:u', 'warn:u', 'warn:r']), `levels and unread marks read ${JSON.stringify(marks)}`)
        t.check(await page.eval(() => /×3/.test(document.querySelectorAll('.ib-row')[2]?.innerText ?? '')), 'the folded item does not show ×3')
        const tabN = await page.eval(() => document.querySelector('.ib-tab[data-on] .ib-tab-n')?.textContent ?? '')
        t.check(tabN === '3', `the Inbox tab counts "${tabN}" unread, want 3`)
        const strip = await page.eval(() => {
          const b = document.querySelector('.vl-strip-inbox')
          return b ? { n: b.querySelector('.vl-strip-inbox-n')?.textContent ?? '', alert: b.hasAttribute('data-alert'), label: b.getAttribute('aria-label') } : null
        })
        t.check(strip?.n === '3' && strip.alert && strip.label === 'Inbox: 3 unread, 1 alert', `the strip button reads ${JSON.stringify(strip)}`)
        const chips = await page.eval(() => [...document.querySelectorAll('.ib-chip')].map((c) => c.textContent))
        t.check(chips[0] === 'All' && chips.includes('raid1') && chips.includes('reminder'), `the source filter reads ${JSON.stringify(chips)}`)
        const times = await page.eval(() => [...document.querySelectorAll('.ib-row time')].map((e) => e.getAttribute('title') ?? ''))
        t.check(times.length === 4 && times.every((x) => / ET$/.test(x)), `row times are not labeled ET: ${JSON.stringify(times)}`)
        const txt = await page.eval(() => document.querySelector('.ib')?.innerText ?? '')
        t.check(!/—/.test(txt), 'an em dash on the inbox page')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'list')
      },
    })
  }

  tests.push({
    name: 'inbox:open',
    group: 'inbox',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      const st = inboxBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 4)
      await page.tap({ sel: '.ib-row-main', text: /RAID/ })
      let w = await waitW(page, 1)
      t.check(w.path === '/api/inbox/read' && JSON.stringify(w.json?.ids) === '[1]' && w.json?.read === true, `opening sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .ib-detail'), { message: 'the row did not open' })
      const link = await page.eval(() => document.querySelector('.ib-row[data-open] .ib-link')?.getAttribute('href'))
      t.check(link === 'https://example.com/raid-guide', `the body link is ${link}`)
      t.check(await page.eval(() => !document.querySelector('.ib-row[data-open]')?.hasAttribute('data-unread')), 'the opened row still reads as unread')
      await t.shot(page, 'open')

      await page.tap({ sel: '.ib-row[data-open] .vl-link', text: /Mark unread/ })
      w = await waitW(page, 2)
      t.check(w.path === '/api/inbox/read' && w.json?.read === false && JSON.stringify(w.json?.ids) === '[1]', `Mark unread sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => document.querySelector('.ib-row')?.hasAttribute('data-unread'), { message: 'the row did not turn unread' })

      // Archive, then Undo
      await page.tap({ sel: '.ib-row-main', text: /Backup watchdog/ })
      await waitW(page, 3)
      await page.tap({ sel: '.ib-row[data-open] .vl-link', text: /^Archive\s/ })
      w = await waitW(page, 4)
      t.check(w.path === '/api/inbox/archive' && w.json?.archived === true && JSON.stringify(w.json?.ids) === '[3]', `Archive sent ${w.method} ${w.path} ${w.body}`)
      await rowsUp(page, 3)
      await page.waitFor(() => [...document.querySelectorAll('.vl-toast-btn')].some((b) => b.textContent.trim() === 'Undo'), { message: 'no Undo after archiving' })
      await page.tap({ sel: '.vl-toast-btn', text: 'Undo' })
      w = await waitW(page, 5)
      t.check(w.path === '/api/inbox/archive' && w.json?.archived === false && JSON.stringify(w.json?.ids) === '[3]', `Undo sent ${w.method} ${w.path} ${w.body}`)
      await rowsUp(page, 4)
      t.check(!st.items.find((i) => i.id === 3).archivedAt, 'the fake still holds item 3 archived')

      // Open goes to the item's app path
      await page.tap({ sel: '.ib-row-main', text: /RAID/ })
      await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .vl-btn-line'), { message: 'the RAID row has no Open' })
      await page.tap({ sel: '.ib-row[data-open] .vl-btn-line', text: /Open/ })
      await page.waitFor(() => location.pathname === '/m/system/hosts', { message: 'Open did not go to /m/system/hosts' })
    },
  })

  tests.push({
    name: 'inbox:bulk',
    group: 'inbox',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      const st = inboxBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 4)
      await page.tap({ sel: '.ib-bar-acts .vl-link', text: /Mark all read/ })
      let w = await waitW(page, 1)
      t.check(w.path === '/api/inbox/read' && w.json?.all === true && w.json?.read === true, `Mark all read sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => !document.querySelector('.ib-row[data-unread]'), { message: 'rows stayed unread' })
      await page.waitFor(() => !document.querySelector('.vl-strip-inbox-n'), { message: 'the strip still shows a count' })
      await page.tap({ sel: '.ib-bar-acts .vl-link', text: /Archive read/ })
      w = await waitW(page, 2)
      t.check(w.path === '/api/inbox/archive' && w.json?.all === true && w.json?.readOnly === true, `Archive read sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => /Nothing new\./.test(document.querySelector('.ib')?.innerText ?? ''), { message: 'the empty inbox does not say Nothing new.' })
      t.check(st.items.every((i) => i.archivedAt), 'the fake has items left open')

      // the source filter asks for that source
      await page.tap({ sel: '.ib-tab', text: /Archive/ })
      await page.waitFor(() => document.querySelectorAll('.ib-row').length === 5, { message: 'the archive did not list all five' })
      await page.tap({ sel: '.ib-chip', text: /^raid/ })
      await page.waitFor(() => document.querySelectorAll('.ib-row').length === 1, { message: 'the raid filter did not narrow the list' })
      t.check(st.gets.some((q) => q.view === 'archive' && q.source === 'raid'), `the filter never asked for raid: ${JSON.stringify(st.gets.slice(-3))}`)
      t.check((await page.path()).includes('source=raid'), 'the filter is not in the URL')
    },
  })

  tests.push({
    name: 'inbox:sources',
    group: 'inbox',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      const st = inboxBackend(page)
      await page.goto(`${ROUTE}?view=sources`)
      await pageUp(page)
      await page.waitFor(() => document.querySelectorAll('.ib-src').length === 4, { message: 'the four sources did not show' })
      const set = await page.eval(() => [...document.querySelectorAll('.ib-src')].map((r) => `${r.querySelector('b')?.textContent}:${r.querySelector('.vl-seg-cell[data-on]')?.textContent}`))
      t.check(set.includes('trade:Off') && set.includes('reminder:On') && set.includes('raid:Auto'), `the settings read ${JSON.stringify(set)}`)
      await t.shot(page, 'sources')
      const raidRow = await page.eval(() => [...document.querySelectorAll('.ib-src')].findIndex((r) => r.querySelector('b')?.textContent === 'raid'))
      await page.tap({ sel: `.ib-src:nth-child(${raidRow + 1}) .vl-seg-cell`, text: 'Off' })
      const w = await waitW(page, 1)
      t.check(w.method === 'PUT' && w.path === '/api/inbox/sources/raid' && w.json?.push === 'off', `the setting sent ${w.method} ${w.path} ${w.body}`)
      t.check(st.push.raid === 'off', 'the fake did not take the setting')
      await fits(t, page, `${ROUTE}?view=sources @phone`)
    },
  })

  tests.push({
    name: 'inbox:push-tap',
    group: 'inbox',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      inboxBackend(page)
      await page.goto(`${ROUTE}?item=3`)
      await pageUp(page)
      await page.waitFor(() => /Backup watchdog/.test(document.querySelector('.ib-row[data-open]')?.innerText ?? ''), { message: '?item=3 did not open that row' })
      const w = await waitW(page, 1)
      t.check(w.path === '/api/inbox/read' && JSON.stringify(w.json?.ids) === '[3]', `the tap sent ${w.method} ${w.path} ${w.body}`)
      await sleep(600)
      t.check(page.writes.length === 1, `the tap read the row ${page.writes.length} times`)
      // an archived item is looked up in the archive
      const page2 = await t.page()
      inboxBackend(page2)
      await page2.goto(`${ROUTE}?item=40`)
      await page2.waitFor(() => /Archived report/.test(document.querySelector('.ib-row[data-open]')?.innerText ?? ''), { timeout: 10_000, message: '?item=40 did not open the archived row' })
      t.check(await page2.eval(() => document.querySelector('.ib-tab[data-on]')?.textContent?.trim() === 'Archive'), 'the archived item did not switch to the Archive tab')
      t.check(page2.writes.length === 0, 'an already read archived row was read again')
    },
  })

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `inbox:strip:${device}`,
      group: 'inbox',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        inboxBackend(page)
        await page.goto('/m/dashboard')
        await page.waitFor(() => !!document.querySelector('.vl-nav[data-ready]'), { timeout: 12_000, message: 'the v2 shell did not come up' })
        await page.waitFor(() => document.querySelector('.vl-strip-inbox-n')?.textContent === '3', { timeout: 8000, message: 'the strip does not count 3 unread' })
        const box = await page.eval(() => {
          const r = document.querySelector('.vl-strip-inbox')?.getBoundingClientRect()
          return r ? { w: r.width, right: r.right, vw: document.documentElement.clientWidth } : null
        })
        t.check(box && box.w > 0 && box.right <= box.vw, `the strip button is off screen: ${JSON.stringify(box)}`)
        await page.tap('.vl-strip-inbox')
        await page.waitFor(() => location.pathname === '/m/inbox', { message: 'the strip button did not open the inbox' })
        await pageUp(page)
        await page.tap('.vl-setbar-back')
        await page.waitFor(() => location.pathname === '/m/dashboard', { message: 'Back did not return to the dashboard' })
      },
    })
  }

  tests.push({
    name: 'inbox:down',
    group: 'inbox',
    device: 'desktop',
    timeout: 30_000,
    async run(t) {
      const page = await t.page()
      inboxBackend(page, { down: true })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /The inbox is not answering/.test(document.querySelector('.ib')?.innerText ?? ''), { timeout: 10_000, message: 'no plain line when the inbox is down' })
      t.check(await page.eval(() => !document.querySelector('.vl-strip-inbox-n')), 'the strip shows a count while the inbox is down')
      await fits(t, page, `${ROUTE} down`)
    },
  })

  return tests
}
