// CALL: AI > Call (src/v2/screens/Call.tsx) and its pop-out (/m/w/call) over a
// fake call service in the backend's shapes (routes/callAssist.ts, which passes
// thor's call-assist service through). GET /api/call/state is a long poll: the
// fake answers at once when the page's rev is behind and holds a moment when
// it is current, the way thor does. Every write (start, ask, dismiss, stop) is
// caught in the browser and changes the fake the way thor would. Generic names
// only: this repo is public.
//
//   idle       what it does, the areas, the last call in ET, Start listening
//              sending the picked area and Recording on, then the live page: REC,
//              cards newest first, the transcript and the sentence still being
//              said (phone, desktop)
//   record-off the Recording switch off: Start sends record false, no REC, and the
//              choice is kept across a reload
//   actions    the ask box (Enter sends), dismiss, End then Save and end, and the
//              idle page saying the transcript was saved and where the video went
//   working    a card being written and a lookup running: the draft card and
//              "Looking up ..." in the status
//   window     the pop-out button opens /m/w/call in a window named after it;
//              the page itself renders with the strip and no tab bar
//   down       thor not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/ai/call'
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const CALL_ID = '00000000-0000-4000-8000-0000000000c1'
const card = (k, over = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${k}`,
  at: iso(Date.now() - (4 - k) * MIN),
  title: `Card ${k}`,
  body: `Line one of card ${k}`,
  ask: null,
  sources: [],
  ms: 2100 + k * 100,
  ...over,
})

function liveCall(over = {}) {
  const now = Date.now()
  return {
    id: CALL_ID,
    area: { id: 'one', label: 'Area one' },
    startedAt: iso(now - 6 * MIN),
    hearing: 'on',
    devices: { caller: 'Speakers (Example)', me: 'Microphone (Example)' },
    recording: 'on',
    brain: 'ready',
    activity: null,
    draft: null,
    partial: 'and the second floor is the',
    lineCount: 6,
    lines: [
      ...[1, 2, 3, 4, 5].map((n) => ({ n, at: iso(now - (6 - n) * MIN), who: 'caller', text: `Caller line ${n}.` })),
      { n: 6, at: iso(now - 30_000), who: 'me', text: 'Let me check that for you.' },
    ],
    cards: [
      card(1, { title: 'Check the printer queue', body: '- Open `printmanagement.msc`\n- Clear the stuck job\nThen **restart** the spooler.', sources: ['Docs: Example Co'] }),
      card(2, { title: 'Printer model', body: 'Example 5850 at the front desk', ask: 'what printer do they have?', sources: ['KB: printer'] }),
      card(3, { title: 'Licenses renew in March', body: 'Ask them to confirm the user count.' }),
    ],
    queued: 0,
    error: null,
    ...over,
  }
}

/** The fake: state, the GET mock and the write handler. */
function callBackend(page, { live = false, callOver = {} } = {}) {
  const now = Date.now()
  const st = {
    rev: 7,
    status: live ? 'live' : 'idle',
    areas: [{ id: 'one', label: 'Area one' }, { id: 'two', label: 'Area two' }, { id: 'three', label: 'Area three' }],
    last: { area: 'Area two', startedAt: iso(now - 3 * 3600_000), endedAt: iso(now - 2.5 * 3600_000), lines: 40, cards: 6, saved: null },
    call: live ? liveCall(callOver) : null,
  }
  const bump = () => { st.rev++ }
  page.mock('/api/call/state', async ({ query }) => {
    if (Number(query.rev) === st.rev && Number(query.wait) > 0) await sleep(700)
    return ok(st)
  })
  page.onWrite((w) => {
    if (w.method !== 'POST') return undefined
    if (w.path === '/api/call/start') {
      st.status = 'live'
      st.call = liveCall({ area: st.areas.find((a) => a.id === w.json?.area) ?? st.areas[0], recording: w.json?.record ? 'on' : null })
      bump()
      return ok(st)
    }
    if (w.path === '/api/call/ask') { bump(); return ok({ ok: true }) }
    if (w.path === '/api/call/dismiss') {
      if (st.call) st.call.cards = st.call.cards.filter((c) => c.id !== w.json?.id)
      bump()
      return ok({ ok: true })
    }
    if (w.path === '/api/call/stop') {
      const c = st.call
      const video = w.json?.save && c?.recording ? '\\\\odin\\bifrost\\call-recordings\\Area one\\Example Co\\2026-10-28 1432 call.mp4' : null
      st.last = {
        area: c?.area.label ?? 'Area one', startedAt: c?.startedAt ?? iso(Date.now()), endedAt: iso(Date.now()), lines: 5, cards: 3,
        saved: w.json?.save ? 'C:\\notes\\call.md' : null, client: video ? 'Example Co' : null, video, saving: false, videoMb: video ? 12.5 : undefined,
      }
      st.status = 'idle'
      st.call = null
      bump()
      return ok({ ok: true, last: st.last })
    }
    return undefined
  })
  return st
}

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vk-callw'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

const live = (page) => page.waitFor(() => !!document.querySelector('.vk-call-on'), { timeout: 8000, message: 'the live call page did not show' })
const titles = (page) => page.eval(() => [...document.querySelectorAll('.vk-call-cards .vk-call-card:not(.vk-call-draft) h3')].map((h) => h.textContent))

async function fits(t, page, tag) {
  const r = await page.eval(layoutReport)
  t.check(!r.crash, `${tag}: the crash screen is showing`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (${r.docSW} > ${r.W})${r.wide?.length ? `: ${r.wide.join(', ')}` : ''}`)
}

const CAPTURE_OPEN = `(() => {
  const opens = window.__opens = []
  window.open = (url, name, features) => {
    opens.push({ url: String(url), name: String(name ?? ''), features: String(features ?? '') })
    return { closed: false, focus() {}, close() { this.closed = true } }
  }
})()`

export function callTests() {
  const tests = []
  for (const device of ['phone', 'desktop', 'desk1080']) {
    tests.push({
      name: `call:idle:${device}`,
      group: 'call',
      device,
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        callBackend(page)
        await page.goto(ROUTE)
        await shellUp(page)
        await page.waitFor(() => /Start listening/.test(document.querySelector('.vl-page[data-active]')?.innerText ?? ''), { message: 'Start listening did not show' })
        const txt = await page.eval(() => document.querySelector('.vl-page[data-active]')?.innerText ?? '')
        t.check(/Whisper/.test(txt) && /Teams, Zoom or Discord/.test(txt), 'the idle page does not say how it hears the call')
        t.check(/Last call: Area two, .+ ET, 40 lines, 6 cards\. Not saved\./.test(txt.replace(/\s+/g, ' ')), `the last call line reads "${(/Last call[^\n]*/.exec(txt) ?? [''])[0]}"`)
        t.check(!/\u2014/.test(txt), 'an em dash on the Call page')
        await fits(t, page, `${ROUTE} idle @${device}`)
        await t.shot(page, 'idle')
        await page.tap({ sel: '.vk-call-areas .vl-seg-cell', text: 'Area two' })
        await page.tap({ sel: '.vk-call-idle .vl-btn', text: /Start listening/ })
        t.check(/records all your screens/.test(txt) && /Recording on/.test(txt), 'the idle page does not offer the recording')
        const w = await waitW(page, 1)
        t.check(w.path === '/api/call/start' && w.json?.area === 'two' && w.json?.record === true, `Start sent ${w.method} ${w.path} ${w.body}`)
        await live(page)
        await page.waitFor(() => document.querySelectorAll('.vk-call-cards .vk-call-card').length === 3, { message: 'the three cards did not show' })
        t.check(JSON.stringify(await titles(page)) === JSON.stringify(['Licenses renew in March', 'Printer model', 'Check the printer queue']), `cards are not newest first: ${JSON.stringify(await titles(page))}`)
        const lines = await page.eval(() => [...document.querySelectorAll('.vk-call-lines p:not(.vk-call-partial)')].map((p) => ({ me: p.hasAttribute('data-me'), text: p.textContent })))
        t.check(lines.length === 6 && /Caller line 5\./.test(lines[4].text) && !lines[4].me, `the transcript shows ${JSON.stringify(lines)}`)
        t.check(lines[5]?.me && /[AP]MYou Let me check/.test(lines[5].text), `Brendon's line is not marked as his: ${JSON.stringify(lines[5])}`)
        const hears = await page.eval(() => document.querySelector('.vk-call-status')?.getAttribute('title') ?? '')
        t.check(hears === 'Hearing Speakers (Example) and Microphone (Example)', `the status does not name what it hears: "${hears}"`)
        t.check(await page.eval(() => /second floor/.test(document.querySelector('.vk-call-partial')?.textContent ?? '')), 'the sentence still being said is missing')
        const bar = await page.eval(() => document.querySelector('.vk-call-bar')?.innerText.replace(/\s+/g, ' ') ?? '')
        t.check(/Live\s*\d+:\d\d/i.test(bar) && /Area two/.test(bar) && /Listening/.test(bar), `the bar reads "${bar}"`)
        t.check(await page.eval(() => !!document.querySelector('.vk-call-rec[data-on]')), 'no REC on a recorded call')
        t.check(await page.eval(() => [...document.querySelectorAll('.vk-call-code')].some((c) => c.textContent === 'printmanagement.msc')), 'the command is not a copy chip')
        t.check(await page.eval(() => /You asked: what printer/.test(document.querySelector('.vk-call-card[data-ask]')?.innerText ?? '')), 'the answered question is not on its card')
        t.check(!(await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .vc-fab')].some((b) => b.getBoundingClientRect().width > 0))), 'New session floats over the call')
        await fits(t, page, `${ROUTE} live @${device}`)
        await t.shot(page, 'live')
      },
    })
  }

  tests.push({
    name: 'call:actions',
    group: 'call',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      callBackend(page, { live: true })
      await page.goto(ROUTE)
      await shellUp(page)
      await live(page)
      await page.tap('.vk-call-ask input')
      await page.type('is their backup running?')
      await page.key('Enter')
      let w = await waitW(page, 1)
      t.check(w.path === '/api/call/ask' && w.json?.text === 'is their backup running?', `Ask sent ${w.method} ${w.path} ${w.body}`)
      t.check(await page.eval(() => document.querySelector('.vk-call-ask input')?.value === ''), 'the ask box kept its text after sending')

      await page.tap({ sel: '.vk-call-card .vk-call-x', index: 0 })
      w = await waitW(page, 2)
      t.check(w.path === '/api/call/dismiss' && w.json?.id === card(3).id, `Dismiss sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => document.querySelectorAll('.vk-call-cards .vk-call-card').length === 2, { message: 'the dismissed card stayed' })

      await page.tap({ sel: '.vk-call-bar .vl-btn-line', text: /^\s*End\s*$/ })
      t.check(page.writes.length === 2, 'the first End press already ended the call')
      await page.tap({ sel: '.vk-call-end .vl-btn-line', text: /Save and end/ })
      w = await waitW(page, 3)
      t.check(w.path === '/api/call/stop' && w.json?.save === true, `Save and end sent ${w.method} ${w.path} ${w.body}`)
      await page.waitFor(() => /Saved to your notes/.test(document.querySelector('.vl-page[data-active]')?.innerText ?? ''), { message: 'the idle page does not say the transcript was saved' })
      const lastLine = await page.eval(() => document.querySelector('.vk-call-last')?.textContent ?? '')
      t.check(lastLine.includes('Video: call-recordings\\Area one\\Example Co\\2026-10-28 1432 call.mp4 (12.5 MB).'), `the last call does not say where the video went: "${lastLine}"`)
      await t.shot(page, 'ended')
    },
  })

  tests.push({
    name: 'call:record-off',
    group: 'call',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      callBackend(page)
      await page.goto(ROUTE)
      await shellUp(page)
      await page.tap({ sel: '.vk-call-recbtn', text: /Recording on/ })
      await page.waitFor(() => /Recording off/.test(document.querySelector('.vk-call-recbtn')?.textContent ?? ''), { message: 'the switch did not turn off' })
      await page.goto(ROUTE)
      await shellUp(page)
      await page.waitFor(() => /Recording off/.test(document.querySelector('.vk-call-recbtn')?.textContent ?? ''), { message: 'Recording off was not kept across a reload' })
      await page.tap({ sel: '.vk-call-idle .vl-btn', text: /Start listening/ })
      const w = await waitW(page, 1)
      t.check(w.json?.record === false, `Start sent record ${w.json?.record}`)
      await live(page)
      t.check(await page.eval(() => !document.querySelector('.vk-call-rec')), 'REC shows on a call that is not recorded')
    },
  })

  tests.push({
    name: 'call:working',
    group: 'call',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      callBackend(page, { live: true, callOver: { activity: 'Docs: Example Co', draft: 'Reset the spooler\n- Run `net stop spooler`' } })
      await page.goto(ROUTE)
      await shellUp(page)
      await live(page)
      await page.waitFor(() => !!document.querySelector('.vk-call-draft'), { message: 'the card being written did not show' })
      const first = await page.eval(() => document.querySelector('.vk-call-cards > .vk-call-card')?.classList.contains('vk-call-draft'))
      t.check(first, 'the card being written is not first')
      const status = await page.eval(() => document.querySelector('.vk-call-status')?.textContent ?? '')
      t.check(/Looking up Docs: Example Co/.test(status), `the status reads "${status}"`)
      await fits(t, page, `${ROUTE} working @phone`)
      await t.shot(page, 'working')
    },
  })

  tests.push({
    name: 'call:window',
    group: 'call',
    device: 'desktop',
    timeout: 40_000,
    async run(t) {
      const page = await t.page({ scripts: [CAPTURE_OPEN] })
      callBackend(page)
      await page.goto(ROUTE)
      await shellUp(page)
      await page.tap({ sel: '.vk-call-pop' })
      await page.waitFor(() => (window.__opens ?? []).length > 0, { message: 'the pop-out button opened nothing' })
      const o = (await page.eval(() => window.__opens))[0]
      t.check(o.url === '/m/w/call' && o.name === 'valkyrie-call' && /width=480/.test(o.features), `the pop-out opened ${JSON.stringify(o)}`)

      const win = await t.page()
      callBackend(win, { live: true })
      await win.goto('/m/w/call')
      await win.waitFor(() => !!document.querySelector('.vk-callw .vk-call-on'), { timeout: 10_000, message: 'the pop-out page did not show the call' })
      t.check(!(await win.eval(() => !!document.querySelector('.vl-nav'))), 'the pop-out page has the tab bar')
      t.check(await win.eval(() => !!document.querySelector('.vk-callw-head .vl-strip, .vk-callw-head [class*="strip"]')), 'the pop-out page has no status strip')
      t.check(await win.eval(() => !document.querySelector('.vk-callw .vk-call-bar [aria-label="Open in its own window"]')), 'the pop-out offers to pop out again')
      t.check((await win.eval(() => document.title)) === 'Call · Valkyrie', `the pop-out is titled "${await win.eval(() => document.title)}"`)
      await fits(t, win, '/m/w/call @desktop')
      await t.shot(win, 'window')
    },
  })

  tests.push({
    name: 'call:down',
    group: 'call',
    device: 'phone',
    timeout: 30_000,
    async run(t) {
      const page = await t.page()
      page.mock('/api/call/state', () => ok({ error: "thor's call service is not answering (timed out)" }, 502))
      await page.goto(ROUTE)
      await shellUp(page)
      await page.waitFor(() => /did not answer/.test(document.querySelector('.vl-page[data-active]')?.innerText ?? ''), { message: 'no line saying thor did not answer' })
      await fits(t, page, `${ROUTE} down @phone`)
    },
  })
  return tests
}
