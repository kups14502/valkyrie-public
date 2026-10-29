// TODAY: Dashboard > Today (src/v2/screens/Today.tsx, /m/dashboard/today) over fakes in the backend's
// shapes: the Capture line (routes/today.ts), the brief, tasks, the inbox, the calendar and the
// session board. Dates come from New York's today when the test runs. Writes are caught in the
// browser and change the fakes the way the backend would. Generic names only: this repo is public.
//
//   view       the sub-tab, the date head and its counts, the brief's lines, schedule rows, due tasks,
//              unread inbox (alerts first), asking and working sessions, no overflow (three sizes)
//   subtab     Overview is where the Dashboard opens; the Today sub-tab switches, Overview comes back
//   capture    Enter sends the line; it shows Filing, then where it went with Open and Undo; Undo
//              sends the undo and the row reads undone
//   brief      no brief yet: Write it now starts one, Writing shows, the lines arrive
//   tick       a due task's box ticks it (PATCH done) and it leaves the list
//   empty      nothing anywhere: every block says so in one line

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/dashboard/today'
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const today = () => NY.format(Date.now())
const plus = (key, n) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const iso = (ms) => new Date(ms).toISOString()

function fakes(page, { empty = false, brief = 'done' } = {}) {
  const t0 = today()
  const now = Date.now()
  const st = {
    captures: [],
    brief: brief === 'none' ? null : { day: t0, status: 'done', text: 'Send the invoice first, it is overdue.\nDentist at 2:00 PM\nOne alert in the inbox', error: null, createdAt: iso(now - 3600_000), updatedAt: iso(now - 3600_000) },
    tasks: empty ? [] : [
      { ref: { kind: 'project', projectId: 'proj-one', tabId: 'tab1', id: 'i1' }, text: 'Send the invoice', due: plus(t0, -1), done: false, doneAt: null, area: 'personal', project: { id: 'proj-one', name: 'Project one' }, list: 'open tasks', createdAt: null },
      { ref: { kind: 'loose', id: 'aaaaaaaaaaa1' }, text: 'Pick up the package', due: t0, done: false, doneAt: null, area: 'personal', project: null, list: null, createdAt: null },
      { ref: { kind: 'loose', id: 'aaaaaaaaaaa2' }, text: 'Renew the passport', due: plus(t0, 30), done: false, doneAt: null, area: 'personal', project: null, list: null, createdAt: null },
    ],
    inbox: empty ? [] : [
      { id: 1, source: 'backups', level: 'warn', title: 'Backup watchdog: 1 problem', body: '', url: null, tag: null, count: 1, firstAt: iso(now - 600_000), lastAt: iso(now - 600_000), readAt: null, archivedAt: null, pushedAt: null, pushDetail: null },
      { id: 2, source: 'raid', level: 'alert', title: '[odin RAID] Fail on /dev/md0', body: '', url: null, tag: null, count: 1, firstAt: iso(now - 3600_000), lastAt: iso(now - 3600_000), readAt: null, archivedAt: null, pushedAt: null, pushDetail: null },
      { id: 3, source: 'trade', level: 'info', title: 'Already read', body: '', url: null, tag: null, count: 1, firstAt: iso(now - 60_000), lastAt: iso(now - 60_000), readAt: iso(now), archivedAt: null, pushedAt: null, pushDetail: null },
    ],
  }
  page.mock('/api/capture', () => ok({ captures: st.captures }))
  page.mock('/api/brief', () => ok({ brief: st.brief }))
  page.mock('/api/tasks', () => ok({ view: 'open', today: t0, tasks: st.tasks.filter((t) => !t.done), projects: [], areas: ['personal'] }))
  page.mock('/api/inbox', () => ok({ view: 'open', items: st.inbox, sources: [], count: { unread: st.inbox.filter((i) => !i.readAt).length, alerts: 1, lastAt: null } }))
  page.mock('/api/inbox/count', () => ok({ unread: st.inbox.filter((i) => !i.readAt).length, alerts: empty ? 0 : 1, lastAt: null }))
  page.mock('/api/calendar/events', () => {
    // a timed event later today (or now, if it is late in the day) and one tomorrow
    const later = Math.min(now + 2 * 3600_000, Date.parse(`${t0}T23:00:00-04:00`))
    const events = empty ? [] : [
      { uid: 'e1', summary: 'Team sync', location: 'Room 4', description: '', organizer: '', status: '', start: iso(later), end: iso(later + 1800_000), allDay: false, recurring: false, sourceId: 's1', sourceLabel: 'Work', color: '#4af' },
      { uid: 'e2', summary: 'Dentist', location: '', description: '', organizer: '', status: '', start: iso(now + 26 * 3600_000), end: iso(now + 27 * 3600_000), allDay: false, recurring: false, sourceId: 's1', sourceLabel: 'Work', color: '#4af' },
    ]
    return ok({ events, tz: 'America/New_York', sources: [] })
  })
  const row = (sessionId, title, activity) => ({
    sessionId, title, titleFromClaude: true, project: 'e2e-folder', area: 'personal', launchGroup: null, host: 'thor', cwd: null,
    lastActivityUtc: iso(now - 30_000), bytes: 1000, live: true, onDesk: true, activity, disposition: 'open', resumeCommand: null,
  })
  page.mock('/api/session-board', () => ok({ sessions: empty ? [] : [row('0e2e0000-0000-4000-8000-0000000000a1', 'Working session', 'working'), row('0e2e0000-0000-4000-8000-0000000000a2', 'Asking session', 'asking')], hookRunsSkipped: 0 }))
  page.onWrite((w) => {
    if (w.method === 'POST' && w.path === '/api/capture') {
      const c = { id: `c${st.captures.length + 1}0000000000`.slice(0, 12), text: w.json.text, status: 'filing', kind: null, summary: 'Filing', url: null, undoable: false, error: null, createdAt: iso(Date.now()), filedAt: null }
      st.captures.unshift(c)
      // filed a moment later, the way the backend's Claude run lands
      setTimeout(() => Object.assign(c, { status: 'filed', kind: 'task', summary: 'Task · Project one · due Fri, Oct 30', url: '/m/tasks', undoable: true, filedAt: iso(Date.now()) }), 1200)
      return ok({ ok: true, capture: { ...c } })
    }
    const u = /^\/api\/capture\/([0-9a-z]+)\/undo$/.exec(w.path)
    if (w.method === 'POST' && u) {
      const c = st.captures.find((x) => x.id === u[1])
      Object.assign(c, { status: 'undone', summary: `Undone: ${c.summary}`, undoable: false })
      return ok({ ok: true, capture: { ...c } })
    }
    if (w.method === 'POST' && w.path === '/api/brief/refresh') {
      st.brief = { day: t0, status: 'writing', text: '', error: null, createdAt: iso(Date.now()), updatedAt: iso(Date.now()) }
      setTimeout(() => { st.brief = { ...st.brief, status: 'done', text: 'A light day.\nOne task due.', updatedAt: iso(Date.now()) } }, 1500)
      return ok({ ok: true, brief: st.brief })
    }
    if (w.method === 'PATCH' && w.path.startsWith('/api/tasks/')) {
      const t = st.tasks.find((x) => w.path.endsWith(`/${x.ref.id}`))
      if (!t) return undefined
      t.done = w.json.done
      return ok({ ok: true, task: t })
    }
    return undefined
  })
  return st
}

const pageUp = (page) => page.waitFor(() => !!document.querySelector('.td .td-head h2'), { timeout: 12_000, message: 'Today did not come up' })
const text = (page, sel) => page.eval((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() ?? '', sel)
const sectionRows = (page, label) => page.eval((l) => {
  const sec = [...document.querySelectorAll('.td-sec')].find((s) => s.getAttribute('aria-label') === l)
  return sec ? [...sec.querySelectorAll('.td-rows > .td-row, .td-rows > .td-task')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()) : null
}, label)

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

export function todayTests() {
  const tests = []
  for (const device of ['phone', 'desktop', 'desk1080']) {
    tests.push({
      name: `today:view:${device}`,
      group: 'today',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        fakes(page)
        await page.goto(ROUTE)
        await pageUp(page)
        await page.waitFor(() => document.querySelectorAll('.td-rows .td-row, .td-rows .td-task').length >= 6, { timeout: 12_000, message: 'the blocks did not fill' })
        const sub = await page.eval(() => document.querySelector('.vl-tab-sub[data-on]')?.textContent?.trim())
        t.check(sub === 'Today', `the lit sub-tab is "${sub}"`)
        const head = await text(page, '.td-head')
        t.check(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d+/.test(head) && /1 event left · 2 due · 2 unread/.test(head), `the head reads "${head}"`)
        const brief = await page.eval(() => [...document.querySelectorAll('.td-brief-text p')].map((p) => `${p.hasAttribute('data-first') ? '*' : ''}${p.textContent}`))
        t.check(JSON.stringify(brief) === JSON.stringify(['*Send the invoice first, it is overdue.', 'Dentist at 2:00 PM', 'One alert in the inbox']), `the brief reads ${JSON.stringify(brief)}`)
        const sched = await sectionRows(page, 'Schedule')
        t.check(sched?.length === 2 && /Team sync/.test(sched[0]) && /^Next Dentist/.test(sched[1]), `the schedule reads ${JSON.stringify(sched)}`)
        const due = await sectionRows(page, 'Due today')
        t.check(due?.length === 2 && /Send the invoice/.test(due[0]) && /Yesterday/.test(due[0]) && /Pick up the package/.test(due[1]), `due reads ${JSON.stringify(due)}`)
        t.check(/1 overdue/i.test(await text(page, '.td-sec[aria-label="Due today"] .vl-section')), 'the Due label does not count the overdue one')
        const inbox = await sectionRows(page, 'Inbox')
        t.check(inbox?.length === 2 && /RAID/.test(inbox[0]) && /Backup watchdog/.test(inbox[1]), `the inbox reads ${JSON.stringify(inbox)} (alert first, read ones left out)`)
        const sess = await sectionRows(page, 'Sessions')
        t.check(sess?.length === 2 && /^Asking Asking session/.test(sess[0]) && /^Working Working session/.test(sess[1]), `sessions read ${JSON.stringify(sess)}`)
        const txt = await text(page, '.td')
        t.check(!/—/.test(txt), 'an em dash on Today')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'view')
      },
    })
  }

  tests.push({
    name: 'today:subtab',
    group: 'today',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page)
      await page.goto('/m/dashboard')
      await page.waitFor(() => !!document.querySelector('.vl-nav[data-ready]'), { timeout: 12_000, message: 'the v2 shell did not come up' })
      await page.waitFor(() => document.querySelector('.vl-tab-sub[data-on]')?.textContent?.trim() === 'Overview', { message: 'the Dashboard does not open on Overview' })
      t.check(await page.eval(() => !document.querySelector('.td')), 'Today shows on Overview')
      await page.tap({ sel: '.vl-tab-sub', text: 'Today' })
      await page.waitFor(() => location.pathname === '/m/dashboard/today', { message: 'the Today sub-tab did not switch' })
      await pageUp(page)
      await page.tap({ sel: '.vl-tab-sub', text: 'Overview' })
      await page.waitFor(() => location.pathname === '/m/dashboard/overview' || location.pathname === '/m/dashboard', { message: 'Overview did not come back' })
      await page.waitFor(() => !!document.querySelector('.hm-layout'), { message: 'the Overview did not draw' })
    },
  })

  tests.push({
    name: 'today:capture',
    group: 'today',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page)
      await page.goto(ROUTE)
      await pageUp(page)
      // the screen's own entrance settles first
      await page.waitFor(() => document.querySelectorAll('.td-rows > .td-row, .td-rows > .td-task').length >= 6, { timeout: 12_000, message: 'the blocks did not fill' })
      await page.tap('.td-cap-line input')
      await page.type('buy filters friday')
      await page.key('Enter')
      let w = await waitW(page, 1)
      t.check(w.method === 'POST' && w.path === '/api/capture' && w.json?.text === 'buy filters friday', `Capture sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => document.querySelector('.td-cap[data-status="filing"] .td-cap-where')?.textContent === 'Filing', { message: 'no Filing row' })
      t.check(await page.eval(() => document.querySelector('.td-cap-line input')?.value === ''), 'the capture line kept its text')
      await page.waitFor(() => document.querySelector('.td-cap[data-status="filed"] .td-cap-where')?.textContent === 'Task · Project one · due Fri, Oct 30', { timeout: 8000, message: 'the filed row never showed where it went' })
      const acts = await page.eval(() => [...document.querySelectorAll('.td-cap .td-cap-acts button')].map((b) => b.textContent.trim()))
      t.check(JSON.stringify(acts) === JSON.stringify(['Open', 'Undo']), `the filed row offers ${JSON.stringify(acts)}`)
      await t.shot(page, 'filed')
      await page.tap({ sel: '.td-cap .vl-link', text: 'Undo' })
      w = await waitW(page, 2)
      t.check(w.method === 'POST' && /^\/api\/capture\/[0-9a-z]+\/undo$/.test(w.path), `Undo sent ${w.method} ${w.path}`)
      await page.waitFor(() => !!document.querySelector('.td-cap[data-status="undone"]'), { timeout: 8000, message: 'the row did not read undone' })
    },
  })

  tests.push({
    name: 'today:brief',
    group: 'today',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page, { brief: 'none' })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /written at 7:30 AM/.test(document.querySelector('.td-brief')?.innerText ?? ''), { message: 'no line saying when the brief is written' })
      await page.tap({ sel: '.td-brief .vl-link', text: 'Write it now' })
      const w = await waitW(page, 1)
      t.check(w.method === 'POST' && w.path === '/api/brief/refresh', `Write it now sent ${w.method} ${w.path}`)
      await page.waitFor(() => /Writing/.test(document.querySelector('.td-brief')?.innerText ?? ''), { message: 'no Writing while it is written' })
      await page.waitFor(() => document.querySelector('.td-brief-text p[data-first]')?.textContent === 'A light day.', { timeout: 10_000, message: 'the written brief never arrived' })
    },
  })

  tests.push({
    name: 'today:tick',
    group: 'today',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => document.querySelectorAll('.td-task').length === 2, { timeout: 10_000, message: 'the two due tasks did not show' })
      await page.tap({ sel: '.td-box', text: /Pick up the package/ })
      const w = await waitW(page, 1)
      t.check(w.method === 'PATCH' && w.path === '/api/tasks/loose/aaaaaaaaaaa1' && w.json?.done === true, `the tick sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => document.querySelectorAll('.td-task').length === 1, { message: 'the ticked task stayed' })
    },
  })

  tests.push({
    name: 'today:empty',
    group: 'today',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      fakes(page, { empty: true })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => document.querySelectorAll('.td-quiet').length >= 4, { timeout: 10_000, message: 'the empty blocks did not say so' })
      const quiet = await page.eval(() => [...document.querySelectorAll('.td-quiet')].map((p) => p.textContent))
      t.check(['Nothing today.', 'Nothing due today.', 'Nothing unread.', 'No session is working or asking.'].every((q) => quiet.includes(q)), `the empty lines read ${JSON.stringify(quiet)}`)
      await fits(t, page, `${ROUTE} empty`)
    },
  })

  return tests
}
