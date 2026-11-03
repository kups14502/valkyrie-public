// JOBS: the Jobs tab (src/v2/screens/Jobs.tsx, /m/jobs/<applied|held|skipped>) and its block on Dashboard > Today,
// over a fake /api/jobs in routes/jobs.ts's shapes. Times are built from now, so Today and
// Yesterday group right on any day. Every write is caught in the browser. Generic names only:
// this repo is public.
//
//   list       the Jobs tab in the tab bar, its sub-tabs, the summary line, Applied grouped Today /
//              Yesterday, region chips, no overflow (three sizes)
//   outcome    a row opens; Interview sends the outcome and shows on the row; Undo clears it
//   held       the Held tab shows the reason; Skip sends the skip and drops the row
//   today      the Today block counts today against the cap and opens the Jobs tab
//   down       the jobs API not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/jobs'
const HOUR = 3_600_000

function fixture() {
  const now = Date.now()
  const job = (id, company, title, location, region, status, at, over = {}) => ({
    jobId: id, company, title, location, region, ats: 'greenhouse', status, at, detail: '', form: `https://example.com/apply/${id}`,
    posting: `https://example.com/jobs/${id}`, resume: 'Base', outcome: null, outcomeAt: null, answers: [], ...over,
  })
  return [
    job('a1', 'Company A', 'Software Engineer', 'Austin, TX', 'TX/FL', 'applied', now - 60_000, {
      answers: [{ q: 'Why this role?', a: 'A written answer long enough to show under the question, about the work the posting describes.' }],
    }),
    job('a2', 'Company B', 'Systems Administrator', 'Raleigh, NC', 'NC/PA', 'applied', now - 2 * 60_000, { resume: 'Systems Admin' }),
    job('a3', 'Company C', 'Platform Engineer', 'Remote - US', 'Remote', 'applied', now - 26 * HOUR),
    job('h1', 'Company D', 'IT Engineer', 'Tampa, FL', 'TX/FL', 'needs-review', now - 3 * HOUR, { detail: "unknown on 'My Information': Address Line 1" }),
    job('s1', 'Company E', 'Staff Engineer', 'Remote', 'Remote', 'skipped', now - 4 * HOUR, { detail: 'fit: senior role' }),
  ]
}

function jobsBackend(page, { down = false } = {}) {
  const st = { jobs: fixture(), gets: [] }
  const viewOf = (s) => (s === 'applied' ? 'applied' : s === 'needs-review' ? 'held' : 'skipped')
  page.mock('/api/jobs', ({ query }) => {
    st.gets.push({ ...query })
    if (down) return { status: 503, body: { error: 'down' } }
    const view = query.view === 'held' || query.view === 'skipped' ? query.view : 'applied'
    const counts = { applied: 0, held: 0, skipped: 0, today: 0, replies: 0 }
    for (const j of st.jobs) {
      counts[viewOf(j.status)] += 1
      if (j.status === 'applied' && Date.now() - j.at < 12 * HOUR) counts.today += 1
      if (j.outcome) counts.replies += 1
    }
    return ok({ view, cap: 40, runs: '7:00 AM', counts, items: st.jobs.filter((j) => viewOf(j.status) === view) })
  })
  page.onWrite((w) => {
    const m = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/(outcome|skip)$/.exec(w.path)
    if (w.method !== 'POST' || !m) return undefined
    const j = st.jobs.find((x) => x.jobId === m[1])
    if (!j) return { status: 404, body: { error: 'no such job' } }
    if (m[2] === 'outcome') j.outcome = w.json?.outcome ?? null
    else j.status = 'skipped'
    return ok({ ok: true })
  })
  return st
}

const pageUp = (page) => page.waitFor(() => !!document.querySelector('.jb .jb-sum, .jb .jb-quiet'), { timeout: 12_000, message: 'the Jobs tab did not come up' })
const rowsUp = (page, n) => page.waitFor((k) => document.querySelectorAll('.jb-row').length === k, { args: [n], timeout: 8000, message: `the list did not show ${n} rows` })

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

export function jobsTests() {
  const tests = []
  for (const device of ['phone', 'desktop', 'desk1080']) {
    tests.push({
      name: `jobs:list:${device}`,
      group: 'jobs',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        jobsBackend(page)
        await page.goto(ROUTE)
        await pageUp(page)
        await rowsUp(page, 3)
        const sum = await page.eval(() => document.querySelector('.jb-sum')?.innerText.replace(/\s+/g, ' ').trim() ?? '')
        t.check(/3 applied/.test(sum) && /2 of 40 today/.test(sum) && /1 held/.test(sum) && /1 skipped/.test(sum) && /Next run 7:00 AM/.test(sum), `the summary reads "${sum}"`)
        const heads = await page.eval(() => [...document.querySelectorAll('.jb-ghead span:first-child')].map((e) => e.textContent))
        t.check(JSON.stringify(heads) === JSON.stringify(['Today', 'Yesterday']), `groups read ${JSON.stringify(heads)}`)
        const tabs = await page.eval(() => [...document.querySelectorAll('.vl-tab-sub')].map((e) => e.textContent.trim()))
        t.check(JSON.stringify(tabs) === JSON.stringify(['Applied', 'Held', 'Skipped']), `sub-tabs read ${JSON.stringify(tabs)}`)
        const main = await page.eval(() => [...document.querySelectorAll('.vl-tab')].map((e) => e.textContent.trim()))
        t.check(main.includes('Jobs'), `no Jobs tab in ${JSON.stringify(main)}`)
        const chips = await page.eval(() => [...document.querySelectorAll('.jb-chip')].map((c) => c.textContent))
        t.check(JSON.stringify(chips) === JSON.stringify(['All', 'TX/FL1', 'NC/PA1', 'Remote1']), `region chips read ${JSON.stringify(chips)}`)
        const txt = await page.eval(() => document.querySelector('.jb')?.innerText ?? '')
        t.check(!/—/.test(txt), 'an em dash on the Jobs page')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'list')
        await page.tap({ sel: '.jb-chip', text: /^TX\/FL/ })
        await rowsUp(page, 1)
        t.check((await page.path()).includes('region=TX'), 'the region filter is not in the URL')
      },
    })
  }

  tests.push({
    name: 'jobs:outcome',
    group: 'jobs',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      const st = jobsBackend(page)
      await page.goto(ROUTE)
      await pageUp(page)
      await rowsUp(page, 3)
      await page.tap({ sel: '.jb-main', text: /Company A/ })
      await page.waitFor(() => !!document.querySelector('.jb-row[data-open] .jb-outs'), { message: 'the row did not open' })
      t.check(await page.eval(() => /Why this role\?/.test(document.querySelector('.jb-row[data-open] .jb-answers')?.innerText ?? '')), 'the written answer is not under its question')
      await t.shot(page, 'open')
      await page.tap({ sel: '.jb-row[data-open] .jb-pick', text: /^Interview/ })
      let w = await waitW(page, 1)
      t.check(w.method === 'POST' && w.path === '/api/jobs/a1/outcome' && w.json?.outcome === 'interview', `Interview sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => document.querySelector('.jb-row[data-open] .jb-out')?.textContent === 'Interview', { message: 'the row does not show Interview' })
      await page.waitFor(() => [...document.querySelectorAll('.vl-toast-btn')].some((b) => b.textContent.trim() === 'Undo'), { message: 'no Undo after marking' })
      await page.tap({ sel: '.vl-toast-btn', text: 'Undo' })
      w = await waitW(page, 2)
      t.check(w.path === '/api/jobs/a1/outcome' && w.json?.outcome === null, `Undo sent ${w.body}`)
      await page.waitFor(() => !document.querySelector('.jb-row .jb-out'), { message: 'the outcome is still on the row after Undo' })
      t.check(st.jobs.find((j) => j.jobId === 'a1').outcome === null, 'the fake still holds an outcome')
    },
  })

  tests.push({
    name: 'jobs:held',
    group: 'jobs',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      jobsBackend(page)
      await page.goto(`${ROUTE}/held`)
      await pageUp(page)
      await rowsUp(page, 1)
      const why = await page.eval(() => document.querySelector('.jb-row .jb-why')?.textContent ?? '')
      t.check(why === 'Address Line 1', `the reason reads "${why}"`)
      await page.tap({ sel: '.jb-main', text: /Company D/ })
      await page.waitFor(() => !!document.querySelector('.jb-row[data-open] .jb-acts'), { message: 'the held row did not open' })
      await t.shot(page, 'held')
      await page.tap({ sel: '.jb-row[data-open] .vl-link', text: /^Skip/ })
      const w = await waitW(page, 1)
      t.check(w.method === 'POST' && w.path === '/api/jobs/h1/skip', `Skip sent ${w.method} ${w.path}`)
      await rowsUp(page, 0)
    },
  })

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `jobs:today:${device}`,
      group: 'jobs',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        jobsBackend(page)
        await page.goto('/m/dashboard/today')
        await page.waitFor(() => !!document.querySelector('[aria-label="Job applications"]'), { timeout: 15_000, message: 'Today has no Jobs block' })
        const head = await page.eval(() => document.querySelector('[aria-label="Job applications"]')?.innerText.replace(/\s+/g, ' ').trim() ?? '')
        t.check(/2 of 40 today/i.test(head) && /1 held/i.test(head) && /Company A/.test(head), `the block reads "${head}"`)
        await page.eval(() => document.querySelector('[aria-label="Job applications"]')?.scrollIntoView({ block: 'center' }))
        await t.shot(page, 'today')
        await page.tap({ sel: '[aria-label="Job applications"] .vl-link', text: /All applications/ })
        // the check runs in the page, where ROUTE does not exist
        await page.waitFor(() => location.pathname.startsWith('/m/jobs'), { message: 'the block did not open the Jobs tab' })
        await pageUp(page)
      },
    })
  }

  tests.push({
    name: 'jobs:down',
    group: 'jobs',
    device: 'desktop',
    timeout: 30_000,
    async run(t) {
      const page = await t.page()
      jobsBackend(page, { down: true })
      await page.goto(ROUTE)
      await pageUp(page)
      await page.waitFor(() => /Applications are not answering/.test(document.querySelector('.jb')?.innerText ?? ''), { timeout: 10_000, message: 'no plain line when jobs are down' })
      await fits(t, page, `${ROUTE} down`)
    },
  })

  return tests
}
