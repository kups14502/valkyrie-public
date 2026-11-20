// INBOX: the inbox page (src/v2/screens/Inbox.tsx, /m/inbox) and the strip's inbox button over a
// fake inbox in the backend's shapes (routes/inbox.ts). Every write (read, archive, push setting)
// is caught in the browser and changes the fake the way the store would. Generic names only:
// this repo is public.
//
//   list       the board: Needs you (alerts first, then warnings, read last) and Reports, no
//              Mail panel without mail, unread rows lit, the alert's hot mark, ET times, the
//              strip's count with its alert color, no overflow (phone, desktop, desk1080)
//   board      mail: one block per mailbox, one row per sender; a sender's row opens to its
//              items, an item reads itself, Copy, Archive all; read senders fold behind "Show n more"
//   open       a row opens to its text with a live link and reads itself; Mark unread; Open
//              goes to the item's app path; Archive with Undo
//   mail-body  an open mail item shows its whole message (GET /api/mail/item/:id), the help
//              desk marker and quoted mail folded behind "Show quoted text"; Open is a real link
//              to the message (Outlook), or "Open iCloud" to the web mail for a message with no
//              link of its own; with no mail behind the item, its preview and its own link
//   mail-open:tauri  in the desktop app, Open, Open iCloud and a link in the body go to the
//              system browser (the open_external command), the page stays put
//   bulk       Read all, Archive read, the source filter asking for that source
//   sources    the Sources tab and a push setting sent as a PUT
//   push-tap   ?item=<id> opens and reads that row; an archived one is found in the archive
//   strip      the strip's button on the dashboard opens the inbox
//   down       the inbox not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { tauriCallsFull, tauriStub } from '../lib/tauri.mjs'

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
function inboxBackend(page, { down = false, extra = [], mail = {} } = {}) {
  // the mail behind an item (routes/mail.ts GET /api/mail/item/:id), by item id; any other id is 404
  page.mock(/^\/api\/mail\/item\/\d+$/, ({ path }) => {
    const m = mail[Number(path.split('/').pop())]
    return m ? ok(m) : { status: 404, body: { error: 'no mail for that item' } }
  })
  const st = {
    items: [
      ...extra,
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

// Mail with its whole text (the mail-body tests): a help desk reply in iCloud, whose item holds only
// the preview cut mid-word and whose mailbox has no link to one message, and an Outlook reply that
// quotes the message before it. A third item has no mail behind it (the 404 an older backend gives).
const DESK_BODY = [
  '##- Please type your reply above this line -##',
  '',
  '----------------------------------------------',
  '',
  'Hi Alex,',
  '',
  "Thanks for the follow-up. I'm sorry that your package is still delayed. While Sam is unavailable, I'm happy to assist you.",
  '',
  "We've checked the tracking, and it still shows the package in transit. We'll follow up with the carrier.",
  '',
  'Best regards,',
  'Pat',
  '',
  '--------------------------------',
  'This email is a service from Example Help.',
  '',
  '[AB12CD-EF34G]',
].join('\n')
const DESK_PREVIEW = "##- Please type your reply above this line -## ---------------------------------------------- Hi Alex, Thanks for the follow-up. I'm sorry that your package is still delayed. While Sam is unavailable, I'm happy to assist you. We've chec"
const ICLOUD_WEB = 'https://www.icloud.com/mail/'
const OUTLOOK_LINK = 'https://outlook.office365.com/owa/?ItemID=e2e-32&exvsurl=1&viewmodel=ReadMessageItem'
const REPLY_BODY = 'Fixed it this morning. The steps are at https://example.com/printer-guide\n\nSam\n\nOn Mon, Nov 16, 2026 at 10:00 AM Pat Example <pat@example.com> wrote:\n\n> Is the printer on the third floor fixed?'

function mailFake(page) {
  const mail = (id, source, from, subject, body, url) => item(id, { source, level: 'info', title: `${from}: ${subject}`, body, url, pushedAt: null, pushDetail: null })
  const at = (id) => iso(Date.now() - id * 7 * MIN)
  return inboxBackend(page, {
    extra: [
      mail(31, 'personal-mail', 'Pat (Example Help)', 'Order Status - 001-12345', DESK_PREVIEW, ICLOUD_WEB),
      mail(32, 'work-mail', 'Sam Example', 'Re: Printer offline', REPLY_BODY.replace(/\s+/g, ' ').slice(0, 240), OUTLOOK_LINK),
      mail(33, 'work-mail', 'Lee Example', 'Lunch Friday', 'Are you free for lunch Friday?', 'https://outlook.office365.com/owa/?ItemID=e2e-33'),
    ],
    mail: {
      31: { mailbox: 'icloud', label: 'iCloud', fromName: 'Pat (Example Help)', fromAddress: 'help@example.com', subject: 'Order Status - 001-12345', receivedAt: at(31), preview: DESK_PREVIEW, body: DESK_BODY, webLink: null, web: ICLOUD_WEB },
      32: { mailbox: 'work', label: 'Work mail', fromName: 'Sam Example', fromAddress: 'sam@example.com', subject: 'Re: Printer offline', receivedAt: at(32), preview: '', body: REPLY_BODY, webLink: OUTLOOK_LINK, web: null },
    },
  })
}

/** The open row's links among its actions: text, href, target and rel. */
const actLinks = (page) => page.eval(() => [...document.querySelectorAll('.ib-row[data-open] .ib-acts a')]
  .map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })))
const openText = (page) => page.eval(() => document.querySelector('.ib-row[data-open] .ib-mailtext')?.innerText ?? '')

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
        t.check(JSON.stringify(order) === JSON.stringify(['[odin RAID] Fail on /dev/md0', 'Backup watchdog: 1 problem', 'Change the filter', 'Trade']), `rows are not alert, warning, read, then reports: ${JSON.stringify(order)}`)
        const marks = await page.eval(() => [...document.querySelectorAll('.ib-row')].map((r) => `${r.dataset.level}:${r.hasAttribute('data-unread') ? 'u' : 'r'}`))
        t.check(JSON.stringify(marks) === JSON.stringify(['alert:u', 'warn:u', 'warn:r', 'info:u']), `levels and unread marks read ${JSON.stringify(marks)}`)
        t.check(await page.eval(() => /×3/.test(document.querySelectorAll('.ib-row')[1]?.innerText ?? '')), 'the folded item does not show ×3')
        const tabN = await page.eval(() => document.querySelector('.ib-tab[data-on] .ib-tab-n')?.textContent ?? '')
        t.check(tabN === '3', `the Inbox tab counts "${tabN}" unread, want 3`)
        const strip = await page.eval(() => {
          const b = document.querySelector('.vl-strip-inbox')
          return b ? { n: b.querySelector('.vl-strip-inbox-n')?.textContent ?? '', alert: b.hasAttribute('data-alert'), label: b.getAttribute('aria-label') } : null
        })
        t.check(strip?.n === '3' && strip.alert && strip.label === 'Inbox: 3 unread, 1 alert', `the strip button reads ${JSON.stringify(strip)}`)
        const panels = await page.eval(() => [...document.querySelectorAll('.ib-board .ib-panel')].map((p) => `${p.querySelector('.vl-panel-label')?.textContent}:${p.querySelectorAll('.ib-row').length}:${p.querySelector('.vl-panel-value')?.textContent ?? ''}`))
        t.check(JSON.stringify(panels) === JSON.stringify(['Needs you:3:2new', 'Reports:1:1new']), `the panels read ${JSON.stringify(panels)}`)
        t.check(await page.eval(() => !!document.querySelector('.ib-need.ib-hot')), 'an unread alert did not turn the Needs you panel hot')
        t.check(await page.eval(() => document.querySelectorAll('.ib-row .ib-glyph svg').length === 4), 'a row is missing its source icon')
        t.check(await page.eval(() => !document.querySelector('.ib-chip')), 'the board shows the source filter')
        const times = await page.eval(() => [...document.querySelectorAll('.ib-row time')].map((e) => e.getAttribute('title') ?? ''))
        t.check(times.length === 4 && times.every((x) => / ET$/.test(x)), `row times are not labeled ET: ${JSON.stringify(times)}`)
        const clocks = await page.eval(() => [...document.querySelectorAll('.ib-row time')].map((e) => e.textContent))
        t.check(clocks.every((c) => c && !/,/.test(c)), `a row's time is not short: ${JSON.stringify(clocks)}`)
        if (device !== 'phone') {
          const cols = await page.eval(() => {
            const a = document.querySelector('.ib-need')?.getBoundingClientRect()
            const b = document.querySelector('.ib-reports')?.getBoundingClientRect()
            return a && b ? { stacked: b.top >= a.bottom, same: Math.abs(a.left - b.left) < 2 } : null
          })
          t.check(cols?.stacked && cols.same, `Reports does not sit under Needs you: ${JSON.stringify(cols)}`)
        }
        const txt = await page.eval(() => document.querySelector('.ib')?.innerText ?? '')
        t.check(!/—/.test(txt), 'an em dash on the inbox page')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'list')
      },
    })
  }

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `inbox:board:${device}`,
      group: 'inbox',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        const mail = (id, source, from, subject, over = {}) => item(id, { source, level: 'info', title: `${from}: ${subject}`, body: `Body of ${id}`, ...over })
        const read = { readAt: iso(Date.now() - 3600_000) }
        const st = inboxBackend(page, {
          extra: [
            mail(11, 'work-mail', 'Pat Example', 'Printer offline'),
            mail(12, 'work-mail', 'Pat Example', 'Re: Printer offline'),
            mail(13, 'personal-mail', 'Acme Store', 'Your order shipped'),
            ...[21, 22, 23, 24, 25, 26].map((id) => mail(id, 'work-mail', `Reader ${id}`, 'Old note', read)),
          ],
        })
        st.push['work-mail'] = 'auto'
        st.push['personal-mail'] = 'auto'
        await page.goto(ROUTE)
        await pageUp(page)
        await page.waitFor(() => !!document.querySelector('.ib-mail .ib-row'), { message: 'the Mail panel did not show' })
        const boxes = await page.eval(() => [...document.querySelectorAll('.ib-mail .ib-box')].map((b) => `${b.querySelector('.ib-box-head span')?.textContent}:${b.querySelectorAll('.ib-row').length}`))
        // work: Pat (unread) and four of the six read senders; personal: one
        t.check(JSON.stringify(boxes) === JSON.stringify(['Work:5', 'Personal:1']), `the mailboxes read ${JSON.stringify(boxes)}`)
        const pat = await page.eval(() => {
          const r = document.querySelector('.ib-mail .ib-row')
          return r ? { text: r.querySelector('.ib-text b')?.textContent, badge: r.querySelector('.ib-glyph')?.textContent, unread: r.hasAttribute('data-unread') } : null
        })
        t.check(pat?.text === 'Pat Example ×2' && pat.badge === 'PE' && pat.unread, `the sender's row reads ${JSON.stringify(pat)}`)
        if (device === 'desktop') {
          const side = await page.eval(() => {
            const a = document.querySelector('.ib-need')?.getBoundingClientRect()
            const b = document.querySelector('.ib-mail')?.getBoundingClientRect()
            return a && b ? b.left >= a.right && Math.abs(a.top - b.top) < 2 : false
          })
          t.check(side, 'Mail does not sit beside Needs you on the desktop')
        } else {
          const order = await page.eval(() => ['.ib-need', '.ib-mail', '.ib-reports'].map((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().top ?? -1)))
          t.check(order[0] < order[1] && order[1] < order[2], `the phone does not stack Needs you, Mail, Reports: ${JSON.stringify(order)}`)
        }
        await fits(t, page, `${ROUTE} board @${device}`)

        // read senders past the first four fold away
        await page.tap({ sel: '.ib-more', text: /Show 2 more read/ })
        await page.waitFor(() => document.querySelectorAll('.ib-mail .ib-box:first-of-type .ib-row').length === 7, { message: 'Show more did not show every sender' })

        // a sender's row opens to its items without reading them
        await page.tap({ sel: '.ib-row-main', text: /Pat Example/ })
        await page.waitFor(() => document.querySelectorAll('.ib-row[data-open] .ib-kid').length === 2, { message: 'the sender did not open to two items' })
        await sleep(300)
        t.check(page.writes.length === 0, `opening a sender wrote ${page.writes.length} time(s)`)
        await page.tap({ sel: '.ib-kid-main', text: /^Printer offline/ })
        let w = await waitW(page, 1)
        t.check(w.path === '/api/inbox/read' && JSON.stringify(w.json?.ids) === '[11]' && w.json?.read === true, `opening an item sent ${w.method} ${w.path} ${w.body}`)
        await page.waitFor(() => /Body of 11/.test(document.querySelector('.ib-kid[data-open] .ib-note')?.textContent ?? ''), { message: 'the item did not open to its text' })
        const sel = await page.eval(() => getComputedStyle(document.querySelector('.ib-kid[data-open] .ib-note')).userSelect)
        t.check(sel === 'text', `the open text cannot be selected (user-select: ${sel})`)
        await t.shot(page, 'open')
        await page.tap({ sel: '.ib-kid[data-open] .vl-link', text: /^Copy/ })
        await page.waitToast(/Copied|Could not copy/)

        await page.tap({ sel: '.ib-kids-acts .vl-link', text: /Archive all 2/ })
        w = await waitW(page, 2)
        t.check(w.path === '/api/inbox/archive' && w.json?.archived === true && JSON.stringify(w.json?.ids) === '[11,12]', `Archive all sent ${w.method} ${w.path} ${w.body}`)
        await page.waitFor(() => !/Pat Example/.test(document.querySelector('.ib-mail')?.innerText ?? ''), { message: 'the sender stayed after Archive all' })
        t.check(st.items.filter((i) => i.archivedAt && [11, 12].includes(i.id)).length === 2, 'the fake did not archive both')
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

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `inbox:mail-body:${device}`,
      group: 'inbox',
      device,
      timeout: 50_000,
      async run(t) {
        const page = await t.page()
        mailFake(page)
        await page.goto(ROUTE)
        await pageUp(page)
        await page.waitFor(() => !!document.querySelector('.ib-mail .ib-row'), { message: 'the Mail panel did not show' })

        // the help desk reply: the whole message in place, its marker and footer folded
        await page.tap({ sel: '.ib-mail .ib-row-main', text: /Example Help/ })
        const w = await waitW(page, 1)
        t.check(w.path === '/api/inbox/read' && JSON.stringify(w.json?.ids) === '[31]', `opening the mail sent ${w.method} ${w.path} ${w.body}`)
        await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .ib-mailtext'), { message: 'the open mail did not show its whole message' })
        t.check(page.api.some((r) => r.path === '/api/mail/item/31'), 'opening the mail never asked for its message')
        let text = await openText(page)
        t.check(/We've checked the tracking, and it still shows the package in transit\. We'll follow up with the carrier\./.test(text) && /Best regards,\nPat/.test(text),
          `the open mail is not the whole message: ${JSON.stringify(text.slice(0, 400))}`)
        t.check(/^Hi Alex,/.test(text), `the open mail does not start at the greeting: ${JSON.stringify(text.slice(0, 80))}`)
        t.check(!/reply above this line|AB12CD-EF34G|This email is a service/.test(text), `the help desk marker or footer shows before the toggle: ${JSON.stringify(text)}`)
        await page.tap({ sel: '.ib-row[data-open] .ib-quote-toggle', text: /Show quoted text/ })
        await page.waitFor(() => document.querySelectorAll('.ib-row[data-open] .ib-quoted').length === 2, { message: 'Show quoted text did not show the marker and the footer' })
        const quoted = await page.eval(() => [...document.querySelectorAll('.ib-row[data-open] .ib-quoted')].map((p) => p.textContent))
        t.check(/reply above this line/.test(quoted[0]) && /AB12CD-EF34G/.test(quoted[1]), `the quoted parts read ${JSON.stringify(quoted)}`)
        t.check(await page.eval(() => document.querySelector('.ib-row[data-open] .ib-quote-toggle')?.textContent === 'Hide quoted text'), 'the toggle does not turn to Hide quoted text')
        await page.tap({ sel: '.ib-row[data-open] .ib-quote-toggle', text: /Hide quoted text/ })
        await page.waitFor(() => !document.querySelector('.ib-row[data-open] .ib-quoted'), { message: 'Hide quoted text left the quoted text showing' })
        // no link of its own: no Open to nowhere, the mailbox's web mail instead, as a real link
        let links = await actLinks(page)
        t.check(links.length === 1 && links[0].text === 'Open iCloud' && links[0].href === ICLOUD_WEB && links[0].target === '_blank' && /noopener/.test(links[0].rel ?? ''),
          `a message with no link of its own offers ${JSON.stringify(links)}, want one Open iCloud link to the web mail`)
        t.check(await page.eval(() => getComputedStyle(document.querySelector('.ib-row[data-open] .ib-mailtext .ib-note')).userSelect) === 'text', 'the message cannot be selected')
        await fits(t, page, `${ROUTE} mail body @${device}`)
        await t.shot(page, 'mail-body')

        // the Outlook reply: what Sam wrote, the quoted message folded, Open is the message itself
        await page.tap({ sel: '.ib-mail .ib-row-main', text: /Sam Example/ })
        await page.waitFor(() => /Fixed it this morning/.test(document.querySelector('.ib-row[data-open] .ib-mailtext')?.innerText ?? ''), { message: 'the Outlook reply did not show its message' })
        text = await openText(page)
        t.check(!/third floor|wrote:/.test(text) && /\nSam\b/.test(text), `the quoted message shows before the toggle: ${JSON.stringify(text)}`)
        t.check(await page.eval(() => document.querySelector('.ib-row[data-open] .ib-mailtext .ib-link')?.getAttribute('href')) === 'https://example.com/printer-guide', 'the link in the message is not live')
        links = await actLinks(page)
        t.check(links.length === 1 && links[0].text === 'Open' && links[0].href === OUTLOOK_LINK && links[0].target === '_blank' && /noopener/.test(links[0].rel ?? ''),
          `the Outlook message's Open is ${JSON.stringify(links)}, want a link to the message`)

        // no mail behind the item (an older backend): its preview, and its own link as Open
        await page.tap({ sel: '.ib-mail .ib-row-main', text: /Lee Example/ })
        await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .ib-acts a'), { message: 'an item with no mail behind it has no Open' })
        t.check(await page.eval(() => /Are you free for lunch Friday\?/.test(document.querySelector('.ib-row[data-open] .ib-note')?.textContent ?? '') && !document.querySelector('.ib-row[data-open] .ib-mailtext')),
          'the item with no mail behind it does not show its preview')
        links = await actLinks(page)
        t.check(links.length === 1 && links[0].text === 'Open' && links[0].href === 'https://outlook.office365.com/owa/?ItemID=e2e-33', `its Open is ${JSON.stringify(links)}`)
      },
    })
  }

  tests.push({
    name: 'inbox:mail-open:tauri',
    group: 'inbox',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      // the desktop app: its webview opens no window by itself, so every outside link goes to open_external
      const page = await t.page({ scripts: [tauriStub()] })
      mailFake(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => !!document.querySelector('.ib-mail .ib-row'), { message: 'the Mail panel did not show' })
      const opened = async (from) => (await tauriCallsFull(page, from)).filter((c) => c.cmd === 'open_external').map((c) => c.args?.url)
      const asked = (n) => page.waitFor((k) => (window.__tauriCalls ?? []).filter((c) => c.cmd === 'open_external').length >= k, { args: [n], message: `the app was not asked to open browser link ${n}` })

      await page.tap({ sel: '.ib-mail .ib-row-main', text: /Sam Example/ })
      await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .ib-out'), { message: 'the Outlook message has no Open' })
      let from = (await tauriCallsFull(page)).length
      await page.tap({ sel: '.ib-row[data-open] .ib-out', text: /^\s*Open\s*$/ })
      await asked(1)
      let urls = await opened(from)
      t.check(urls.length === 1 && urls[0] === OUTLOOK_LINK, `Open asked for ${JSON.stringify(urls)}, want the message's link`)

      from = (await tauriCallsFull(page)).length
      await page.tap({ sel: '.ib-row[data-open] .ib-mailtext .ib-link' })
      await asked(2)
      urls = await opened(from)
      t.check(urls.length === 1 && urls[0] === 'https://example.com/printer-guide', `the link in the message asked for ${JSON.stringify(urls)}`)

      await page.tap({ sel: '.ib-mail .ib-row-main', text: /Example Help/ })
      await page.waitFor(() => !!document.querySelector('.ib-row[data-open] .ib-out'), { message: 'the iCloud message has no Open iCloud' })
      from = (await tauriCallsFull(page)).length
      await page.tap({ sel: '.ib-row[data-open] .ib-out', text: /Open iCloud/ })
      await asked(3)
      urls = await opened(from)
      t.check(urls.length === 1 && urls[0] === ICLOUD_WEB, `Open iCloud asked for ${JSON.stringify(urls)}`)
      t.check(await page.eval(() => location.pathname) === ROUTE, 'an outside link moved the app off the inbox')
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
      await page.tap({ sel: '.ib-bar-acts .vl-link', text: /Read all/ })
      let w = await waitW(page, 1)
      t.check(w.path === '/api/inbox/read' && w.json?.all === true && w.json?.read === true, `Read all sent ${w.method} ${w.path} ${w.body}`)
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
      await page.tap({ sel: '.ib-chip', text: /^RAID/ })
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
      t.check(set.includes('Trade:Off') && set.includes('Reminder:On') && set.includes('RAID:Auto'), `the settings read ${JSON.stringify(set)}`)
      await t.shot(page, 'sources')
      const raidRow = await page.eval(() => [...document.querySelectorAll('.ib-src')].findIndex((r) => r.querySelector('b')?.textContent === 'RAID'))
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
