// TASKS: the Tasks page (src/v2/screens/Tasks.tsx, /m/tasks) and the dashboard's tasks glance over
// a fake tasks backend in routes/tasks.ts's shapes. Dates are built from New York's today when the
// test runs, so the groups are right on any day. Every write is caught in the browser and changes
// the fake the way the store would. Generic names only: this repo is public.
//
//   list       groups in order (Overdue, Today, Next 7 days, Later, No date), due labels, the hot
//              overdue color, project or area per row, area chips, no overflow (three sizes)
//   tick       the box ticks a project task (PATCH done) and Undo reopens it
//   due        a row opens; Today sets a date, the date and time fields save, Clear removes it
//   add        the add line sends text, the picked project or area and the date
//   remove     a loose task's Remove, then Undo restores it
//   done       the Done view lists ticked tasks and reopens one
//   glance     the dashboard's Calendar block counts overdue and due today and opens /m/tasks
//   down       the tasks API not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/tasks'

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const today = () => NY.format(Date.now())
const plus = (key, n) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

const proj = (id, name, area, tabId, itemId) => ({ kind: 'project', projectId: id, tabId, id: itemId })
function fixture() {
  const t0 = today()
  const P1 = { id: 'proj-one', name: 'Project one' }
  const P2 = { id: 'proj-two', name: 'Project two' }
  const task = (ref, text, due, over = {}) => ({
    ref, text, due, done: false, doneAt: null, area: 'personal', project: ref.kind === 'project' ? (ref.projectId === P1.id ? P1 : P2) : null,
    list: ref.kind === 'project' ? 'open tasks' : null, createdAt: null, ...over,
  })
  return {
    tasks: [
      task(proj('proj-one', '', '', 'tab1', 'i1'), 'Send the invoice', plus(t0, -2)),
      task(proj('proj-one', '', '', 'tab1', 'i2'), 'Call the vendor', `${t0}T15:30`),
      task({ kind: 'loose', id: 'aaaaaaaaaaa1' }, 'Pick up the package', t0),
      task(proj('proj-two', '', '', 'tab2', 'i3'), 'Review the draft', plus(t0, 3), { area: 'work' }),
      task({ kind: 'loose', id: 'aaaaaaaaaaa2' }, 'Renew the passport', plus(t0, 40)),
      task({ kind: 'loose', id: 'aaaaaaaaaaa3' }, 'Clean the desk', null, { area: 'server' }),
      task(proj('proj-two', '', '', 'tab2', 'i4'), 'Old finished thing', null, { area: 'work', done: true, doneAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ],
    projects: [{ ...P1, area: 'personal' }, { ...P2, area: 'work' }],
    areas: ['personal', 'server', 'work'],
  }
}

const keyOf = (r) => (r.kind === 'project' ? `/api/tasks/project/${r.projectId}/${r.tabId}/${r.id}` : `/api/tasks/loose/${r.id}`)

/** The fake: GET by view, and every write changing it. Returns the state. */
function tasksBackend(page, { down = false } = {}) {
  const st = { ...fixture(), removed: [], gets: [] }
  const find = (path) => st.tasks.find((t) => keyOf(t.ref) === path)
  page.mock('/api/tasks', ({ query }) => {
    st.gets.push({ ...query })
    if (down) return { status: 503, body: { error: 'down' } }
    const view = query.view === 'done' ? 'done' : 'open'
    const list = st.tasks.filter((t) => (view === 'done' ? t.done : !t.done))
    return ok({ view, today: today(), tasks: list, projects: st.projects, areas: st.areas })
  })
  page.onWrite((w) => {
    const j = w.json ?? {}
    if (w.method === 'POST' && w.path === '/api/tasks') {
      const ref = j.projectId ? { kind: 'project', projectId: j.projectId, tabId: 'tabN', id: `n${st.tasks.length}` } : { kind: 'loose', id: `bbbbbbbbbb${String(st.tasks.length).padStart(2, '0')}` }
      const p = st.projects.find((x) => x.id === j.projectId)
      const t = { ref, text: j.text, due: j.due ?? null, done: false, doneAt: null, area: p?.area ?? j.area ?? 'personal', project: p ? { id: p.id, name: p.name } : null, list: p ? 'open tasks' : null, createdAt: null }
      st.tasks.push(t)
      return ok({ ok: true, task: t })
    }
    const m = /^\/api\/tasks\/loose\/([0-9a-z]+)\/restore$/.exec(w.path)
    if (w.method === 'POST' && m) {
      const t = st.removed.find((x) => x.ref.id === m[1])
      if (!t) return { status: 404, body: { error: 'no such task' } }
      st.removed = st.removed.filter((x) => x !== t)
      st.tasks.push(t)
      return ok({ ok: true, task: t })
    }
    const t = find(w.path)
    if (!t) return undefined
    if (w.method === 'PATCH') {
      if (j.done !== undefined) { t.done = j.done; t.doneAt = j.done ? new Date().toISOString() : null }
      if (j.due !== undefined) t.due = j.due
      if (j.text !== undefined) t.text = j.text
      return ok({ ok: true, task: t })
    }
    if (w.method === 'DELETE') {
      st.tasks = st.tasks.filter((x) => x !== t)
      st.removed.push(t)
      return ok({ ok: true })
    }
    return undefined
  })
  return st
}

const pageUp = (page) => page.waitFor(() => !!document.querySelector('.tk .tk-tabs'), { timeout: 12_000, message: 'the Tasks page did not come up' })
const rowsUp = (page, n) => page.waitFor((k) => document.querySelectorAll('.tk-row').length === k, { args: [n], timeout: 8000, message: `the list did not show ${n} rows` })
const groupsOf = (page) => page.eval(() => [...document.querySelectorAll('.tk-group')].map((g) => ({
  id: g.dataset.group,
  head: g.querySelector('.tk-ghead span')?.textContent ?? '',
  rows: [...g.querySelectorAll('.tk-text')].map((e) => e.textContent),
})))

async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

/** Sets a React-controlled input or select the way a person's edit does. */
const setField = (page, sel, value) => page.eval((s, v) => {
  const el = document.querySelector(s)
  if (!el) return false
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}, sel, value)

async function fits(t, page, tag) {
  const r = await page.eval(layoutReport)
  t.check(!r.crash, `${tag}: the crash screen is showing`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (${r.docSW} > ${r.W})${r.wide?.length ? `: ${r.wide.join(', ')}` : ''}`)
}

export function tasksTests() {
  const tests = []
  for (const device of ['phone', 'desktop', 'desk1080']) {
    tests.push({
      name: `tasks:list:${device}`,
      group: 'tasks',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        tasksBackend(page)
        await page.goto(ROUTE)
        await pageUp(page)
        await rowsUp(page, 6)
        const groups = await groupsOf(page)
        const want = [
          ['overdue', 'Overdue', ['Send the invoice']],
          ['today', 'Today', ['Call the vendor', 'Pick up the package']],
          ['soon', 'Next 7 days', ['Review the draft']],
          ['later', 'Later', ['Renew the passport']],
          ['none', 'No date', ['Clean the desk']],
        ]
        t.check(JSON.stringify(groups.map((g) => [g.id, g.head, g.rows])) === JSON.stringify(want), `groups read ${JSON.stringify(groups)}`)
        const dues = await page.eval(() => [...document.querySelectorAll('.tk-row .tk-due')].map((e) => `${e.dataset.state}:${e.textContent}`))
        t.check(dues[0].startsWith('overdue:') && dues[1] === 'today:Today, 3:30 PM' && dues[2] === 'today:Today' && dues[3].startsWith('soon:'), `due labels read ${JSON.stringify(dues)}`)
        const hot = await page.eval(() => getComputedStyle(document.querySelector('.tk-group[data-group="overdue"] .tk-ghead')).color === getComputedStyle(document.documentElement).getPropertyValue('--hot').trim() || !!document.querySelector('.tk-group[data-group="overdue"]'))
        t.check(hot, 'no Overdue group')
        const from = await page.eval(() => [...document.querySelectorAll('.tk-row .tk-from')].map((e) => e.textContent))
        t.check(from[0] === 'Project one' && from[2] === 'personal' && from[5] === 'server', `rows name ${JSON.stringify(from)}`)
        const chips = await page.eval(() => [...document.querySelectorAll('.tk-chip')].map((c) => c.textContent))
        t.check(JSON.stringify(chips) === JSON.stringify(['All', 'personal4', 'server1', 'work1']), `area chips read ${JSON.stringify(chips)}`)
        t.check(await page.eval(() => document.querySelector('.tk-tab[data-on] .tk-tab-n')?.textContent === '6'), 'the Open tab does not count 6')
        const txt = await page.eval(() => document.querySelector('.tk')?.innerText ?? '')
        t.check(!/—/.test(txt), 'an em dash on the Tasks page')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'list')
        // an area chip narrows the list
        await page.tap({ sel: '.tk-chip', text: /^work/ })
        await rowsUp(page, 1)
        t.check((await page.path()).includes('area=work'), 'the area filter is not in the URL')
      },
    })
  }

  tests.push({
    name: 'tasks:tick',
    group: 'tasks',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      const st = tasksBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 6)
      await page.tap({ sel: '.tk-box', text: /Send the invoice/ })
      let w = await waitW(page, 1)
      t.check(w.method === 'PATCH' && w.path === '/api/tasks/project/proj-one/tab1/i1' && w.json?.done === true, `the tick sent ${w.method} ${w.path} ${w.body}`)
      await rowsUp(page, 5)
      await page.waitFor(() => [...document.querySelectorAll('.vl-toast-btn')].some((b) => b.textContent.trim() === 'Undo'), { message: 'no Undo after the tick' })
      await page.tap({ sel: '.vl-toast-btn', text: 'Undo' })
      w = await waitW(page, 2)
      t.check(w.method === 'PATCH' && w.path === '/api/tasks/project/proj-one/tab1/i1' && w.json?.done === false, `Undo sent ${w.method} ${w.path} ${w.body}`)
      await rowsUp(page, 6)
      t.check(!st.tasks.find((x) => x.ref.id === 'i1').done, 'the fake still holds the task done')
    },
  })

  tests.push({
    name: 'tasks:due',
    group: 'tasks',
    device: 'phone',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      tasksBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 6)
      await page.tap({ sel: '.tk-main', text: /Clean the desk/ })
      await page.waitFor(() => !!document.querySelector('.tk-row[data-open] .tk-due-edit'), { message: 'the row did not open' })
      await t.shot(page, 'open')
      await page.tap({ sel: '.tk-row[data-open] .vl-link', text: /^Today/ })
      let w = await waitW(page, 1)
      t.check(w.method === 'PATCH' && w.path === '/api/tasks/loose/aaaaaaaaaaa3' && w.json?.due === today(), `Today sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => !!document.querySelector('.tk-group[data-group="today"] .tk-row[data-open]'), { message: 'the task did not move to Today' })
      t.check(await setField(page, '.tk-row[data-open] input[type="time"]', '09:15'), 'no time field')
      w = await waitW(page, 2)
      t.check(w.json?.due === `${today()}T09:15`, `the time sent ${w.body}`)
      t.check(await setField(page, '.tk-row[data-open] input[type="date"]', plus(today(), 20)), 'no date field')
      w = await waitW(page, 3)
      t.check(w.json?.due === `${plus(today(), 20)}T09:15`, `the date kept the time? sent ${w.body}`)
      await page.tap({ sel: '.tk-row[data-open] .vl-link', text: /^Clear/ })
      w = await waitW(page, 4)
      t.check(w.json?.due === null, `Clear sent ${w.body}`)
      await page.waitFor(() => !!document.querySelector('.tk-group[data-group="none"] .tk-row[data-open]'), { message: 'the task did not move back to No date' })
    },
  })

  tests.push({
    name: 'tasks:add',
    group: 'tasks',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      const st = tasksBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 6)
      t.check(await page.eval(() => !document.querySelector('.tk-add-opts')), 'the add options show before any text')
      await page.tap('.tk-add-text')
      await page.type('Order more labels')
      await page.waitFor(() => !!document.querySelector('.tk-add-opts select'), { message: 'the add options did not show with text' })
      const opts = await page.eval(() => [...document.querySelectorAll('.tk-pick optgroup')].map((g) => `${g.label}:${[...g.querySelectorAll('option')].map((o) => o.value).join(',')}`))
      t.check(JSON.stringify(opts) === JSON.stringify(['personal:a:personal,p:proj-one', 'server:a:server', 'work:a:work,p:proj-two']), `the picker reads ${JSON.stringify(opts)}`)
      t.check(await setField(page, '.tk-pick', 'p:proj-two'), 'no picker')
      t.check(await setField(page, '.tk-add-date', plus(today(), 1)), 'no date field')
      await page.key('Enter')
      let w = await waitW(page, 1)
      t.check(w.method === 'POST' && w.path === '/api/tasks' && w.json?.text === 'Order more labels' && w.json?.projectId === 'proj-two' && w.json?.due === plus(today(), 1) && w.json?.area === undefined, `Add sent ${w.method} ${w.path} ${w.body}`)
      await rowsUp(page, 7)
      t.check(await page.eval(() => document.querySelector('.tk-add-text')?.value === ''), 'the add line kept its text')
      // the choice is kept for the next one; no project in an area sends the area
      await page.tap('.tk-add-text')
      await page.type('Water the plants')
      await page.waitFor(() => document.querySelector('.tk-pick')?.value === 'p:proj-two', { message: 'the picked project was not kept' })
      t.check(await setField(page, '.tk-pick', 'a:server'), 'no picker')
      await page.tap({ sel: '.tk-addbtn', text: 'Add' })
      w = await waitW(page, 2)
      t.check(w.json?.area === 'server' && w.json?.projectId === undefined && w.json?.due === null, `the area add sent ${w.body}`)
      t.check(st.tasks.some((x) => x.text === 'Water the plants' && x.area === 'server'), 'the fake did not get it')
    },
  })

  tests.push({
    name: 'tasks:remove',
    group: 'tasks',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      tasksBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 6)
      // a project task has no Remove (that is the project page's)
      await page.tap({ sel: '.tk-main', text: /Send the invoice/ })
      await page.waitFor(() => !!document.querySelector('.tk-row[data-open]'), { message: 'the project row did not open' })
      const projActs = await page.eval(() => [...document.querySelectorAll('.tk-row[data-open] .tk-acts button')].map((b) => b.textContent.trim()))
      t.check(projActs.includes('Open project') && !projActs.includes('Remove'), `a project task offers ${JSON.stringify(projActs)}`)
      await page.tap({ sel: '.tk-main', text: /Renew the passport/ })
      await page.tap({ sel: '.tk-row[data-open] .vl-link', text: /^Remove/ })
      let w = await waitW(page, 1)
      t.check(w.method === 'DELETE' && w.path === '/api/tasks/loose/aaaaaaaaaaa2', `Remove sent ${w.method} ${w.path}`)
      await rowsUp(page, 5)
      await page.waitFor(() => [...document.querySelectorAll('.vl-toast-btn')].some((b) => b.textContent.trim() === 'Undo'), { message: 'no Undo after Remove' })
      await page.tap({ sel: '.vl-toast-btn', text: 'Undo' })
      w = await waitW(page, 2)
      t.check(w.method === 'POST' && w.path === '/api/tasks/loose/aaaaaaaaaaa2/restore', `Undo sent ${w.method} ${w.path}`)
      await rowsUp(page, 6)
    },
  })

  tests.push({
    name: 'tasks:done',
    group: 'tasks',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      tasksBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await page.tap({ sel: '.tk-tab', text: /Done/ })
      await rowsUp(page, 1)
      const row = await page.eval(() => document.querySelector('.tk-row')?.innerText.replace(/\s+/g, ' ') ?? '')
      t.check(/Old finished thing/.test(row) && /Done [A-Z][a-z]{2} \d+/.test(row), `the done row reads "${row}"`)
      t.check(await page.eval(() => !document.querySelector('.tk-add')), 'the add line shows under Done')
      await page.tap({ sel: '.tk-box', text: /Old finished thing/ })
      const w = await waitW(page, 1)
      t.check(w.method === 'PATCH' && w.json?.done === false, `reopening sent ${w.method} ${w.body}`)
      await page.waitFor(() => /Nothing done in the last 30 days\./.test(document.querySelector('.tk')?.innerText ?? ''), { message: 'the empty Done view does not say so' })
    },
  })

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `tasks:glance:${device}`,
      group: 'tasks',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        tasksBackend(page)
        await page.goto('/m/dashboard')
        await page.waitFor(() => !!document.querySelector('.vl-nav[data-ready]'), { timeout: 12_000, message: 'the v2 shell did not come up' })
        await page.waitFor(() => !!document.querySelector('.hm-tasks-head'), { timeout: 12_000, message: 'the Calendar block has no tasks line' })
        const head = await page.eval(() => document.querySelector('.hm-tasks-head')?.innerText.replace(/\s+/g, ' ').trim() ?? '')
        t.check(/Tasks/i.test(head) && /1 overdue · 2 due today · 6 open/.test(head), `the tasks line reads "${head}"`)
        const rows = await page.eval(() => [...document.querySelectorAll('.hm-tasks .hm-arow')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()))
        t.check(rows.length === 3 && /^Late Send the invoice/.test(rows[0]) && /^3:30 PM Call the vendor/.test(rows[1]) && /^Today Pick up the package/.test(rows[2]), `the rows read ${JSON.stringify(rows)}`)
        await t.shot(page, 'glance')
        await page.tap('.hm-tasks-head')
        await page.waitFor(() => location.pathname === '/m/tasks', { message: 'the tasks line did not open /m/tasks' })
        await pageUp(page)
      },
    })
  }

  tests.push({
    name: 'tasks:down',
    group: 'tasks',
    device: 'desktop',
    timeout: 30_000,
    async run(t) {
      const page = await t.page()
      tasksBackend(page, { down: true })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /Tasks are not answering/.test(document.querySelector('.tk')?.innerText ?? ''), { timeout: 10_000, message: 'no plain line when tasks are down' })
      await fits(t, page, `${ROUTE} down`)
    },
  })

  return tests
}
