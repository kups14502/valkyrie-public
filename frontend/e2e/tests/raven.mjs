// RAVEN: the Raven tab, the one conversation with Raven (src/v2/screens/Messages.tsx, /m/raven),
// the quick sheet and the corner button (src/v2/kit/raven.tsx), over a fake /api/raven in the
// contract's shapes (backend routes/raven.ts). Every write (send, read, upload, stop, a proposal's
// approve or decline) is answered in the browser and changes the fake the way the backend would.
// Generic names only: this repo is public.
//
//   thread     the thread: rows for him, Raven (meta line: model · effort · ET time), relays labeled
//              by source (an agent, a session with its Open link, a feed, the morning brief), files
//              (a thumbnail with the image token, a name chip), a proposal card, day headings, the
//              newest line in view, read when the bottom shows, the tab's badge, the Connected
//              column (wide) or its toggle (narrow), selectable text, no corner button here,
//              nothing wider than the screen (phone, ipad, ipadland, desktop, desk1440)
//   send       a line sent (phone: the button; desktop: Enter, Shift+Enter a new line), Raven's
//              live status and Stop, the reply arriving through the long-poll, Stop sending
//   attach     a picture and a PDF picked, uploaded raw with X-File-Name, chips with their
//              state, one removed, the ids sent with the line (phone, desktop)
//   proposal   the draft edited then Send; Save to drafts; Decline with a reason; Approve on a
//              ticket note (desktop)
//   older      scrolling to the top reads the page before the oldest line and keeps the view
//   links      ?compose=1 focuses the box; an old ?c=<channel> push lands on the conversation; the old
//              /m/messages address (and its ?compose=1) lands on /m/raven with the box focused
//   quick      the corner button opens the sheet with its box focused, a send shows the line,
//              the status and the reply with Open conversation, Escape or a tap outside closes
//              (phone, ipad, desktop); Ctrl+Shift+Space and the palette open it on the desktop
//   corner     the corner button on every tab and page (but Raven and Dashboard > Overview, whose Raven
//              block takes its place), never over content at the bottom of a scrolled page (phone)
//   down       /api/raven not answering: one plain line, no crash

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { fixtures } from './upload.mjs'
import { quietThor } from '../lib/fixtures.mjs'

const ok = (body, status = 200) => ({ status, body })
const ROUTE = '/m/raven'
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#0a3"/><circle cx="80" cy="60" r="30" fill="#fd0"/></svg>'

const PROPOSAL_MAIL = {
  id: 7, kind: 'mail_reply', title: 'Reply to Pat Example', status: 'pending', result: null, decidedAt: null,
  payload: { to: 'pat@example.com', toName: 'Pat Example', subject: 'Printer offline', body: 'Hi Pat,\n\nThe printer is back online.' },
}
const PROPOSAL_NOTE = {
  id: 8, kind: 'ticket_note', title: 'Note on T20261119.0002', status: 'pending', result: null, decidedAt: null,
  payload: { title: 'Checked the backup', text: 'The nightly job ran clean.' },
}

function seed(now) {
  const t = (min) => iso(now - min * MIN)
  return [
    { id: 100, author: 'raven', text: 'Two meetings today and one ticket that needs you.', createdAt: iso(now - 26 * 60 * MIN), refs: [], meta: { relay: { kind: 'system', from: 'brief', label: 'Morning brief' } }, proposal: null },
    { id: 101, author: 'brendon', text: 'What is on my plate today?', createdAt: t(50), refs: [], meta: { source: 'siri' }, proposal: null },
    { id: 102, author: 'raven', text: 'Three things:\n\n- the printer ticket\n- a reply to Pat\n- the backup check', createdAt: t(49), refs: [], meta: { tier: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', why: 'a normal task', replyTo: 101 }, proposal: null },
    {
      id: 103, author: 'triage', text: 'Drafted a reply to Pat about the printer.', createdAt: t(40),
      refs: [{ type: 'ticket', franchise: 'area1', id: 5, number: 'T20261119.0001', title: 'Printer offline', url: 'https://example.com/t/5' }],
      meta: { relay: { kind: 'agent', from: 'triage', label: 'Triage agent', sourceMessageId: 9 } }, proposal: PROPOSAL_MAIL,
    },
    {
      id: 104, author: 'raven', text: 'The personal session finished the refactor and is waiting.', createdAt: t(30),
      refs: [{ type: 'link', url: '/m/ai/term/vk-e2e00000a1', label: 'Open' }],
      meta: { relay: { kind: 'session', from: 'vk-e2e00000a1', label: 'Personal (main)', sessionId: 'sess-1' } }, proposal: null,
    },
    { id: 105, author: 'raven', text: 'Sync stalled for 2 hours.', createdAt: t(20), refs: [], meta: { relay: { kind: 'feature', from: 'watcher', label: 'Watcher' } }, proposal: null },
    {
      id: 106, author: 'brendon', text: 'Here are the photo and the notes', createdAt: t(10), refs: [], proposal: null,
      meta: { source: 'app', files: [{ id: 'f1', name: 'photo.png', mime: 'image/png', size: 20480, createdAt: t(10) }, { id: 'f2', name: 'notes.pdf', mime: 'application/pdf', size: 120000, createdAt: t(10) }] },
    },
    { id: 107, author: 'raven', text: 'Got both. The photo shows the jammed tray.', createdAt: t(9), refs: [], meta: { tier: 'opus', model: 'claude-opus-5-5', effort: 'high', replyTo: 106 }, proposal: null },
    { id: 108, author: 'raven', text: 'Proposed a note for the backup ticket.', createdAt: t(5), refs: [], meta: { relay: { kind: 'agent', from: 'triage', label: 'Triage agent' } }, proposal: PROPOSAL_NOTE },
  ]
}

const header = (h, name) => {
  const k = Object.keys(h ?? {}).find((x) => x.toLowerCase() === name.toLowerCase())
  return k ? h[k] : undefined
}

/** The fake Raven: the GET mocks and the write handler. Returns its state. */
export function ravenBackend(page, { filler = 0, replyMs = 400, down = false, unread = 2, quiet = true } = {}) {
  // thor's reads (the 390 KB board and the rest) stand in, so the browser's connections stay free for these
  if (quiet) quietThor(page)
  const now = Date.now()
  const fill = []
  for (let i = 1; i <= filler; i++) {
    fill.push({ id: i, author: i % 2 ? 'brendon' : 'raven', text: `Older line ${i}`, createdAt: iso(now - (4 * 24 * 60 - i) * MIN), refs: [], meta: i % 2 ? {} : { model: 'claude-haiku-4-5-20251001', effort: 'low' }, proposal: null })
  }
  const st = {
    seq: 10, status: 'idle', statusNote: '', tier: null, model: null, effort: null, unread, paused: false,
    mains: [
      { target: 'personal', label: 'Personal', pane: 'vk-e2e00000a1', state: 'idle' },
      { target: 'area1', label: 'Work area one', pane: 'vk-e2e00000b2', state: 'working' },
      { target: 'area2', label: 'Work area two', pane: null, state: 'closed' },
    ],
    watching: [
      { pane: 'vk-e2e00000b2', label: 'Work area one (main)', sessionId: 'sess-2', since: iso(now - 25 * MIN) },
      // a session in a window on thor: Raven reads it, but there is no pane here to open
      { pane: '', label: 'Area two (window)', sessionId: 'sess-3', since: iso(now - 5 * MIN) },
    ],
    agents: [
      { id: 'triage', name: 'Triage agent', area: 'area1', status: 'idle', pending: 2 },
      { id: 'shopper', name: 'Shopping agent', area: 'personal', status: 'working', pending: 0 },
    ],
    messages: [...fill, ...seed(now)],
    nextId: 200, files: new Map(), replyMs, stopped: false,
    sent: [], reads: [], uploads: [], stops: 0, decisions: [], olderGets: [], fileGets: [],
  }
  const bump = () => { st.seq++ }
  const body = () => ({
    seq: st.seq, status: st.status, statusNote: st.statusNote, tier: st.tier, model: st.model, effort: st.effort, unread: st.unread,
    mains: st.mains, watching: st.watching, agents: st.agents, paused: st.paused, messages: st.messages.slice(-60),
  })
  page.mock('/api/raven', () => (down ? { status: 503, body: { error: 'Raven is restarting' } } : ok(body())))
  page.mock('/api/raven/messages', ({ query }) => {
    st.olderGets.push({ ...query })
    const before = Number(query.before)
    const limit = Number(query.limit) || 40
    return ok({ messages: st.messages.filter((m) => m.id < before).slice(-limit) })
  })
  page.mock('/api/msg/changes', async ({ query }) => {
    const since = Number(query.since)
    const t0 = Date.now()
    while (st.seq <= since && Date.now() - t0 < 6000) await sleep(80)
    return ok({ seq: st.seq })
  })
  page.mock('/api/msg/count', () => ok({ unread: st.unread, notify: 0, pending: 0 }))
  page.mock('/api/plex/img-token', () => ok({ token: 'e2e-img', expiresAt: Date.now() + 12 * 3600_000 }))
  page.mock(/^\/api\/raven\/files\/[^/]+$/, ({ path, query }) => {
    st.fileGets.push({ path, token: query.token ?? null })
    return { status: 200, body: SVG, type: 'image/svg+xml' }
  })

  const reply = (to, text) => {
    setTimeout(() => {
      if (st.replyMs < 0) return
      st.status = 'working'
      st.statusNote = 'Thinking · Sonnet 5.5 · high'
      st.tier = 'sonnet'
      st.model = 'claude-sonnet-5-5'
      st.effort = 'high'
      bump()
      setTimeout(() => {
        if (st.stopped) return
        st.messages.push({ id: st.nextId++, author: 'raven', text: `Done: ${text}`, createdAt: iso(Date.now()), refs: [], meta: { tier: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high', replyTo: to }, proposal: null })
        st.status = 'idle'
        st.statusNote = ''
        st.unread++
        bump()
      }, st.replyMs)
    }, 200)
  }

  page.onWrite((w) => {
    const j = w.json ?? {}
    if (w.method === 'POST' && w.path === '/api/raven/messages') {
      st.sent.push(j)
      const files = (j.files ?? []).map((id) => st.files.get(id)).filter(Boolean)
      const m = { id: st.nextId++, author: 'brendon', text: j.text ?? '', createdAt: iso(Date.now()), refs: [], meta: { source: j.source, ...(files.length ? { files } : {}) }, proposal: null }
      st.messages.push(m)
      bump()
      reply(m.id, j.text ?? '')
      return ok({ message: m })
    }
    if (w.method === 'POST' && w.path === '/api/raven/read') {
      st.reads.push(j.upTo ?? null)
      st.unread = 0
      bump()
      return ok({ ok: true })
    }
    if (w.method === 'POST' && w.path === '/api/raven/files') {
      const rawName = header(w.headers, 'X-File-Name') ?? 'file'
      let name = rawName
      try { name = decodeURIComponent(rawName) } catch { /* sent as is */ }
      const f = { id: `u${st.files.size + 1}`, name, mime: header(w.headers, 'Content-Type') ?? '', size: 1000 + st.files.size, createdAt: iso(Date.now()) }
      st.files.set(f.id, f)
      st.uploads.push({ name: rawName, type: f.mime, bytes: w.body.length })
      return ok(f)
    }
    if (w.method === 'POST' && w.path === '/api/raven/stop') {
      st.stops++
      st.stopped = true
      st.status = 'idle'
      st.statusNote = ''
      st.messages.push({ id: st.nextId++, author: 'raven', text: 'Stopped.', createdAt: iso(Date.now()), refs: [], meta: { error: 'stopped' }, proposal: null })
      bump()
      return ok({ ok: true })
    }
    const pm = /^\/api\/msg\/proposals\/(\d+)\/(approve|decline)$/.exec(w.path)
    if (w.method === 'POST' && pm) {
      const id = Number(pm[1])
      st.decisions.push({ id, act: pm[2], ...j })
      const msg = st.messages.find((m) => m.proposal?.id === id)
      if (!msg) return { status: 404, body: { error: 'no such proposal' } }
      msg.proposal = { ...msg.proposal, status: pm[2] === 'decline' ? 'declined' : 'running', decidedAt: iso(Date.now()) }
      bump()
      return ok({ ok: true, proposal: msg.proposal })
    }
    return undefined
  })
  return st
}

// ---------- helpers ----------
// Every shell tab is mounted at once (and their 3D scenes), so on a busy odin one evaluate can take
// seconds: each test reads the page in as few calls as it can, and waits long.

const UP_MS = 120_000

const threadUp = (page) => page.waitFor(() => document.querySelectorAll('.rv .rv-msg').length > 0, { timeout: UP_MS, interval: 400, message: 'the Raven thread did not come up' })

async function waitFor(fn, timeout = 15_000, what = 'the fake') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = fn()
    if (v) return v
    await sleep(60)
  }
  throw new Error(`waited ${timeout} ms for ${what}`)
}

/** Waits in the page with a long timeout: on a busy host one read takes seconds. */
const until = (page, fn, message, args = [], timeout = 60_000) => page.waitFor(fn, { args, timeout, interval: 250, message })

async function fits(t, page, tag) {
  const r = await page.eval(layoutReport)
  t.check(!r.crash, `${tag}: the crash screen is showing`)
  t.check(r.docSW <= r.W + 1, `${tag}: the page is wider than the viewport (${r.docSW} > ${r.W})${r.wide?.length ? `: ${r.wide.join(', ')}` : ''}`)
}

/** Focus a box in the page, then insert the text the way a keyboard does. */
async function typeIn(page, sel, text) {
  await page.eval((s) => { const el = document.querySelector(s); el?.focus(); return !!el }, sel)
  await page.type(text)
}

/** upload.mjs's chooser with a longer wait: the next file picker that opens gets `paths`; resolves with its mode. */
async function slowChooser(page, timeout = 30_000) {
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true })
  const queue = []
  page.on((m) => {
    if (m.method !== 'Page.fileChooserOpened') return
    const next = queue.shift()
    if (next) next(m.params)
  })
  return (paths) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no file chooser opened')), timeout)
    queue.push(async (p) => {
      clearTimeout(timer)
      await page.send('DOM.setFileInputFiles', { files: paths, backendNodeId: p.backendNodeId })
      resolve(p.mode)
    })
  })
}

const ctrlShiftSpace = async (page) => {
  const base = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 2 | 8 }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** Everything the thread test checks, in one read. */
function threadSnap() {
  const q = (s, r = document) => r.querySelector(s)
  const qa = (s, r = document) => [...r.querySelectorAll(s)]
  const list = q('.rv-msgs')
  const img = q('.rv-msgs .rv-thumb img')
  const file = q('.rv-msgs .rv-file')
  const side = q('.rv-side')?.getBoundingClientRect()
  const conv = q('.rv-conv')?.getBoundingClientRect()
  const crow = (re) => qa('.rv-conn .rv-crow').find((r) => re.test(r.textContent))
  return {
    name: q('.rv-head h2')?.textContent,
    status: q('.rv-status')?.textContent,
    stop: !!q('.rv-stop'),
    kinds: qa('.rv .rv-msg').map((m) => m.dataset.kind + (m.dataset.relay ? `:${m.dataset.relay}` : '')),
    labels: qa('.rv .rv-msg-head b').map((b) => b.textContent),
    siri: /via Siri/.test(q('.rv .rv-msg[data-kind="me"]')?.innerText ?? ''),
    metas: qa('.rv .rv-msg[data-kind="raven"] .rv-meta').map((p) => p.textContent),
    li: !!q('.rv .rv-msg[data-kind="raven"] .rv-md li'),
    open: qa('.rv-msgs .rv-open').map((a) => a.getAttribute('href')),
    days: qa('.rv .rv-day').map((d) => d.textContent),
    img: img ? { src: img.getAttribute('src'), w: img.naturalWidth } : null,
    file: file ? { text: file.innerText.replace(/\s+/g, ' '), href: file.getAttribute('href') } : null,
    props: qa('.rv-prop').map((p) => `${p.querySelector('.rv-prop-head b')?.textContent}|${[...p.querySelectorAll('.rv-prop-acts button')].map((b) => b.textContent).join(',')}`),
    gap: list ? list.scrollHeight - list.scrollTop - list.clientHeight : -1,
    select: list ? getComputedStyle(list).userSelect : '',
    fab: !!q('.vl-shell > .rv-fab'),
    wide: !!q('.rv[data-wide]'),
    side: side && conv ? { right: side.left >= conv.right - 1, w: Math.round(side.width) } : null,
    toggle: !!q('.rv-conn-toggle'),
    conn: qa('.rv-conn .rv-group').map((g) => `${g.querySelector('h3')?.textContent}:${g.querySelectorAll('.rv-crow').length}`),
    watchOpen: qa('.rv-conn .rv-group').filter((g) => /Watching/.test(g.querySelector('h3')?.textContent ?? '')).flatMap((g) => [...g.querySelectorAll('.rv-open')].map((a) => a.getAttribute('href'))),
    triage: crow(/Triage agent/)?.querySelector('.rv-n')?.textContent ?? null,
    feed: crow(/Watcher/)?.innerText.replace(/\s+/g, ' ') ?? null,
    dash: /—/.test(q('.rv')?.innerText ?? ''),
  }
}

/** The quick sheet in one read. */
function sheetSnap() {
  const q = document.querySelector('.rv-q')
  const s = document.querySelector('.rv-q-sheet')?.getBoundingClientRect()
  return {
    open: !!q && !q.hidden && getComputedStyle(q).display !== 'none',
    focused: document.activeElement === document.querySelector('.rv-q textarea'),
    box: s ? { l: s.left, r: s.right, b: s.bottom, w: s.width, W: document.documentElement.clientWidth, H: window.innerHeight } : null,
    me: document.querySelector('.rv-q-me')?.textContent ?? '',
    wait: document.querySelector('.rv-q-wait')?.textContent ?? '',
    reply: document.querySelector('.rv-q-reply .rv-md')?.innerText ?? '',
    meta: document.querySelector('.rv-q-reply .rv-meta')?.textContent ?? '',
  }
}

export function ravenTests() {
  const tests = []

  for (const device of ['phone', 'ipad', 'ipadland', 'desktop', 'desk1440']) {
    tests.push({
      name: `raven:thread:${device}`,
      group: 'raven',
      device,
      timeout: 300_000,
      async run(t) {
        const page = await t.page()
        const st = ravenBackend(page)
        await page.goto(ROUTE)
        await threadUp(page)
        await until(page, () => document.querySelectorAll('.rv .rv-msg').length === 9 && document.querySelector('.rv-msgs .rv-thumb img')?.complete, 'the nine lines and the thumbnail did not show')
        await waitFor(() => st.reads.length, 60_000, 'POST /api/raven/read').catch((e) => t.check(false, e.message))
        t.check(st.reads[0] === 108, `the read went up to ${st.reads[0]}, want 108`)
        const s = await page.eval(threadSnap)
        t.check(s.name === 'Raven' && s.status === 'idle' && !s.stop, `the header reads ${JSON.stringify([s.name, s.status, s.stop])}`)
        t.check(JSON.stringify(s.kinds) === JSON.stringify(['relay:system', 'me', 'raven', 'relay:agent', 'relay:session', 'relay:feature', 'me', 'raven', 'relay:agent']), `the rows are ${JSON.stringify(s.kinds)}`)
        for (const want of ['Morning brief', 'You', 'Raven', 'Triage agent', 'Personal (main)', 'Watcher']) t.check(s.labels.includes(want), `no row is labeled ${want}: ${JSON.stringify(s.labels)}`)
        t.check(s.siri, 'the line from Siri does not say so')
        t.check(s.metas.length === 2 && /^Sonnet 5\.5 · medium · \d{1,2}:\d{2} [AP]M ET$/.test(s.metas[0]) && /^Opus 5\.5 · high · \d{1,2}:\d{2} [AP]M ET$/.test(s.metas[1]), `Raven's meta lines read ${JSON.stringify(s.metas)}`)
        t.check(s.li, 'the reply\'s Markdown list did not render')
        t.check(JSON.stringify(s.open) === JSON.stringify(['/m/ai/term/vk-e2e00000a1']), `the session relay's Open links are ${JSON.stringify(s.open)}`)
        t.check(s.days.length >= 2 && s.days[s.days.length - 1] === 'Today', `the day headings read ${JSON.stringify(s.days)}`)
        // files: the picture as a thumbnail through the image token, the PDF as a name chip
        t.check(/\/api\/raven\/files\/f1\?token=e2e-img$/.test(s.img?.src ?? '') && s.img.w > 0, `the thumbnail is ${JSON.stringify(s.img)}`)
        t.check(/notes\.pdf/.test(s.file?.text ?? '') && /\/api\/raven\/files\/f2/.test(s.file?.href ?? ''), `the file chip is ${JSON.stringify(s.file)}`)
        t.check(JSON.stringify(s.props) === JSON.stringify(['Reply to Pat Example|Send,Save to Outlook drafts,Decline', 'Note on T20261119.0002|Approve,Decline']), `the proposal cards read ${JSON.stringify(s.props)}`)
        t.check(s.gap > -1 && s.gap < 4, `the thread did not open at its end (${s.gap} px left below)`)
        t.check(s.select === 'text', `the thread's text cannot be selected (user-select ${s.select})`)
        t.check(!s.fab, 'the corner button shows on Raven')
        t.check(!s.dash, 'an em dash on Raven')
        // Connected: a column on a wide screen, a toggle on a narrow one
        const wantWide = ['ipadland', 'desktop', 'desk1440'].includes(device)
        t.check(s.wide === wantWide, `wide is ${s.wide} on ${device}`)
        let conn = s
        if (!wantWide) {
          t.check(s.toggle && !s.conn.length, `narrow: the toggle ${s.toggle}, the list before it ${JSON.stringify(s.conn)}`)
          await page.tap({ sel: '.rv-conn-toggle' }, { wait: 40_000 })
          await until(page, () => !!document.querySelector('.rv-conn-drop .rv-crow'), 'the Connected toggle did not open the list')
          conn = await page.eval(threadSnap)
        } else {
          t.check(s.side?.right && s.side.w < 360 && !s.toggle, `the Connected column is not a narrow column on the right: ${JSON.stringify(s.side)}`)
        }
        t.check(JSON.stringify(conn.conn) === JSON.stringify(['Main terminals:3', 'Watching:2', 'Agents:2', 'Feeds:1']), `Connected reads ${JSON.stringify(conn.conn)}`)
        t.check(JSON.stringify(conn.watchOpen) === JSON.stringify(['/m/ai/term/vk-e2e00000b2']), `Watching's Open links are ${JSON.stringify(conn.watchOpen)} (a window on thor has none)`)
        t.check(conn.triage === '2', `the triage agent's pending count reads ${conn.triage}`)
        t.check(/Sync stalled/.test(conn.feed ?? ''), `the feed line reads ${conn.feed}`)
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'thread')
      },
    })
  }

  // the badge counts Raven's unread on every screen; the tab's text stays its name
  tests.push({
    name: 'raven:badge:phone',
    group: 'raven',
    device: 'phone',
    timeout: 240_000,
    async run(t) {
      const page = await t.page()
      ravenBackend(page, { unread: 4 })
      // Settings swaps the tabs for its own bar, so a tab screen
      await page.goto('/m/system/services')
      await until(page, () => document.querySelector('.vl-nav .vl-tab-prim .rv-badge')?.getAttribute('data-n') === '4', 'the Raven tab shows no badge of 4', [], UP_MS)
      const r = await page.eval(() => {
        const b = [...document.querySelectorAll('.vl-nav .vl-tab-prim')].find((x) => x.querySelector('.rv-badge'))
        return { text: b?.textContent.trim(), label: b?.querySelector('.vl-tab-label')?.textContent, fab: document.querySelector('.vl-shell > .rv-fab')?.getAttribute('aria-label') }
      })
      t.check(r.text === 'Raven' && r.label === 'Raven', `the badge sits on ${JSON.stringify(r)} (the tab's text must stay its name)`)
      t.check(r.fab === 'Message Raven (4 unread)', `the corner button reads ${r.fab}`)
      await t.shot(page, 'badge')
    },
  })

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `raven:send:${device}`,
      group: 'raven',
      device,
      timeout: 360_000,
      async run(t) {
        const page = await t.page()
        const st = ravenBackend(page, { replyMs: 15_000 })
        await page.goto(ROUTE)
        await threadUp(page)
        t.check(await page.eval(() => document.querySelector('.rv .rv-send')?.disabled), 'Send is on with nothing to send')
        let want
        if (device === 'desktop') {
          want = 'first line\nsecond line'
          await typeIn(page, '.rv .rv-compose textarea', 'first line')
          // Shift+Enter is the browser's own new line (a key event alone types nothing here, so the text follows)
          await page.key('Enter', { shift: true })
          await sleep(600)
          t.check(st.sent.length === 0, 'Shift+Enter sent the line')
          await page.type('\nsecond line')
          await page.key('Enter')
        } else {
          want = 'Start a work session and check the printer'
          // under 16 px the phone's browser zooms the whole page into the box when it takes the focus
          const px = await page.eval(() => parseFloat(getComputedStyle(document.querySelector('.rv .rv-compose textarea')).fontSize))
          t.check(px >= 16, `the message box is ${px} px on the phone, so iOS zooms into it`)
          await page.tap({ sel: '.rv .rv-compose textarea' }, { wait: 40_000 })
          await page.type(want)
          await page.tap({ sel: '.rv .rv-send' }, { wait: 40_000 })
        }
        await waitFor(() => st.sent.length, 60_000, 'POST /api/raven/messages').catch((e) => t.check(false, e.message))
        t.check(st.sent[0]?.text === want && st.sent[0]?.source === 'app' && !st.sent[0]?.files, `the send carried ${JSON.stringify(st.sent[0])}`)
        // Raven at work: the line in the thread, the box cleared, the header, the live line, Stop
        const state = () => page.eval(() => JSON.stringify({
          box: document.querySelector('.rv .rv-compose textarea')?.value,
          mine: [...document.querySelectorAll('.rv .rv-msg[data-kind="me"] .rv-md')].map((m) => m.innerText).slice(-2),
          status: document.querySelector('.rv-status')?.textContent,
          live: !!document.querySelector('.rv-working'),
          stop: !!document.querySelector('.rv-stop'),
        }))
        await until(page, (w) => document.querySelector('.rv .rv-compose textarea')?.value === ''
          && [...document.querySelectorAll('.rv .rv-msg[data-kind="me"] .rv-md')].some((m) => m.innerText.includes(w)), 'the sent line or the cleared box did not show', [want.split('\n')[0]])
          .catch(async (e) => t.check(false, `${e.message}: ${await state()}`))
        // the header: the whole status on a wide screen, its first word on the phone; the live line has it all
        await until(page, (head) => document.querySelector('.rv-status')?.textContent === head
          && document.querySelector('.rv-working')?.textContent === 'thinking · Sonnet 5.5 · high' && !!document.querySelector('.rv-stop'), 'Raven working (header, live line, Stop) did not show', [device === 'phone' ? 'thinking' : 'thinking · Sonnet 5.5 · high'])
          .catch(async (e) => t.check(false, `${e.message}: ${await state()}`))
        await t.shot(page, 'working')
        await until(page, (w) => [...document.querySelectorAll('.rv .rv-msg[data-kind="raven"] .rv-md')].some((m) => m.innerText.startsWith(`Done: ${w}`))
          && document.querySelector('.rv-status')?.textContent === 'idle' && !document.querySelector('.rv-stop'), 'the reply did not arrive through the long-poll (or the header stayed busy)', [want.split('\n')[0]], 40_000)
        const gap = await page.eval(() => { const el = document.querySelector('.rv-msgs'); return el.scrollHeight - el.scrollTop - el.clientHeight })
        t.check(gap < 4, `the reply is not in view (${gap} px below)`)
        // a second line, stopped while Raven works (its reply never comes on its own)
        st.replyMs = 10 * 60_000
        await typeIn(page, '.rv .rv-compose textarea', 'something long')
        await page.tap({ sel: '.rv .rv-send' }, { wait: 40_000 })
        await until(page, () => !!document.querySelector('.rv-stop'), 'Stop did not show for the second line')
        await page.tap({ sel: '.rv-stop' }, { wait: 40_000 })
        await waitFor(() => st.stops, 60_000, 'POST /api/raven/stop').catch((e) => t.check(false, e.message))
        await until(page, () => [...document.querySelectorAll('.rv .rv-msg[data-error] .rv-md')].some((m) => m.innerText === 'Stopped.'), 'no "Stopped." line')
        await fits(t, page, `${ROUTE} @${device}`)
        await t.shot(page, 'sent')
      },
    })
  }

  for (const device of ['phone', 'desktop']) {
    tests.push({
      name: `raven:attach:${device}`,
      group: 'raven',
      device,
      timeout: 300_000,
      async run(t) {
        const page = await t.page()
        const st = ravenBackend(page, { replyMs: -1 })
        const fx = fixtures()
        const pick = await slowChooser(page)
        await page.goto(ROUTE)
        await threadUp(page)
        await until(page, () => !!document.querySelector('.rv .rv-attach'), 'no attach button')
        const chosen = pick([fx.sunset, fx.doc]).catch((e) => e)
        await page.tap({ sel: '.rv .rv-attach' }, { wait: 40_000 })
        const got = await chosen
        const mode = got instanceof Error ? (t.check(false, got.message), null) : got
        t.check(mode === 'selectMultiple', `the picker opened for ${mode}, want several files`)
        await waitFor(() => st.uploads.length === 2, 60_000, 'two POST /api/raven/files').catch((e) => t.check(false, e.message))
        const ups = st.uploads.map((u) => `${u.name}|${u.type}`).sort()
        t.check(JSON.stringify(ups) === JSON.stringify(['notes.pdf|application/pdf', 'sunset.png|image/png']), `the uploads went as ${JSON.stringify(ups)}`)
        if (!st.uploads.every((u) => u.bytes > 0)) t.note(`upload bodies as CDP saw them: ${st.uploads.map((u) => u.bytes).join(', ')} bytes`)
        await until(page, () => [...document.querySelectorAll('.rv .rv-chip')].filter((c) => c.dataset.state === 'done').length === 2, 'the chips did not both land')
        const r = await page.eval(() => ({
          accept: document.querySelector('.rv .rv-pick')?.getAttribute('accept'),
          chips: [...document.querySelectorAll('.rv .rv-chip')].map((c) => `${c.querySelector('.rv-chip-name')?.textContent}|${c.querySelector('img') ? 'img' : 'icon'}`),
        }))
        t.check(r.accept === 'image/*,video/*,application/pdf,text/*,*/*', `the picker accepts ${r.accept}`)
        t.check(JSON.stringify(r.chips) === JSON.stringify(['sunset.png|img', 'notes.pdf|icon']), `the chips read ${JSON.stringify(r.chips)}`)
        await fits(t, page, `${ROUTE} attach @${device}`)
        await t.shot(page, 'chips')
        // remove the PDF, send the picture alone (no text)
        await page.tap({ sel: '.rv .rv-chip-x', text: 'notes.pdf' }, { wait: 40_000 })
        await until(page, () => document.querySelectorAll('.rv .rv-chip').length === 1 && !document.querySelector('.rv .rv-send')?.disabled, 'the PDF chip did not go, or Send is off with a picture attached')
        await page.tap({ sel: '.rv .rv-send' }, { wait: 40_000 })
        await waitFor(() => st.sent.length, 60_000, 'POST /api/raven/messages').catch((e) => t.check(false, e.message))
        const sentFiles = st.sent[0]?.files ?? []
        t.check(sentFiles.length === 1 && st.files.get(sentFiles[0])?.name === 'sunset.png' && (st.sent[0]?.text ?? '') === '', `the send carried ${JSON.stringify(st.sent[0])}`)
        await until(page, () => !document.querySelector('.rv .rv-chip') && !![...document.querySelectorAll('.rv-msgs .rv-msg[data-kind="me"]')].pop()?.querySelector('.rv-thumb img'), 'the chip stayed after the send, or the sent picture is not in the thread')
        await t.shot(page, 'sent')
        if (device === 'desktop') {
          // a file dropped on the box attaches once (the drop bubbles to the screen, which takes drops too)
          const before = st.uploads.length
          await page.eval(() => {
            const dt = new DataTransfer()
            dt.items.add(new File(['dropped text'], 'dropped.txt', { type: 'text/plain' }))
            document.querySelector('.rv .rv-compose textarea').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
          })
          await until(page, () => [...document.querySelectorAll('.rv .rv-chip')].some((c) => c.dataset.state === 'done'), 'the dropped file did not land')
          await sleep(1500)
          const n = await page.eval(() => document.querySelectorAll('.rv .rv-chip').length)
          t.check(n === 1 && st.uploads.length === before + 1, `one dropped file made ${n} chips and ${st.uploads.length - before} uploads`)
        }
      },
    })
  }

  tests.push({
    name: 'raven:proposal:desktop',
    group: 'raven',
    device: 'desktop',
    timeout: 300_000,
    async run(t) {
      const page = await t.page()
      const st = ravenBackend(page, { replyMs: -1 })
      await page.goto(ROUTE)
      await threadUp(page)
      await until(page, () => !!document.querySelector('.rv-prop-edit'), 'the mail draft is not editable')
      await page.eval(() => {
        const ta = document.querySelector('.rv-prop-edit')
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      })
      await page.type('\n\nIt needed a new tray.')
      await page.tap({ sel: '.rv-prop[data-status="pending"] .vl-btn-line', text: 'Send' }, { wait: 40_000 })
      await waitFor(() => st.decisions.length, 60_000, 'the approve').catch((e) => t.check(false, e.message))
      const d0 = st.decisions[0]
      t.check(d0?.id === 7 && d0.act === 'approve' && d0.how === 'send' && d0.body === 'Hi Pat,\n\nThe printer is back online.\n\nIt needed a new tray.', `the approve carried ${JSON.stringify(d0)}`)
      await until(page, () => [...document.querySelectorAll('.rv-prop')].some((p) => p.dataset.status === 'running' && /with thor/i.test(p.innerText)), 'the mail card did not show it went to thor')
      // the ticket note: Decline with a reason
      await page.tap({ sel: '.rv-prop[data-status="pending"] .vl-link', text: 'Decline' }, { wait: 40_000 })
      await until(page, () => document.activeElement === document.querySelector('.rv-prop-decline input'), 'the reason box did not open with focus')
      await page.type('Not this week')
      await page.tap({ sel: '.rv-prop-decline .vl-link', text: 'Decline' }, { wait: 40_000 })
      await waitFor(() => st.decisions.length === 2, 60_000, 'the decline').catch((e) => t.check(false, e.message))
      t.check(st.decisions[1]?.id === 8 && st.decisions[1].act === 'decline' && st.decisions[1].reason === 'Not this week', `the decline carried ${JSON.stringify(st.decisions[1])}`)
      await until(page, () => [...document.querySelectorAll('.rv-prop')].some((p) => p.dataset.status === 'declined'), 'the note card did not show declined')
      await t.shot(page, 'decided')
    },
  })

  tests.push({
    name: 'raven:proposal-draft:phone',
    group: 'raven',
    device: 'phone',
    timeout: 300_000,
    async run(t) {
      const page = await t.page()
      const st = ravenBackend(page, { replyMs: -1 })
      await page.goto(ROUTE)
      await threadUp(page)
      await page.tap({ sel: '.rv-prop .vl-link', text: 'Save to Outlook drafts' }, { wait: 40_000 })
      await waitFor(() => st.decisions.length, 60_000, 'the approve').catch((e) => t.check(false, e.message))
      t.check(st.decisions[0]?.how === 'draft' && st.decisions[0].body === 'Hi Pat,\n\nThe printer is back online.', `Save to drafts carried ${JSON.stringify(st.decisions[0])}`)
      await page.waitToast(/Saving to Outlook drafts/, { timeout: 60_000 }).catch((e) => t.check(false, e.message))
      await until(page, () => document.querySelectorAll('.rv-prop[data-status="pending"]').length === 1, 'the mail card is still pending after Save to drafts')
      await page.tap({ sel: '.rv-prop[data-status="pending"] .vl-btn-line', text: 'Approve' }, { wait: 40_000 })
      await waitFor(() => st.decisions.length === 2, 60_000, 'the second approve').catch((e) => t.check(false, e.message))
      t.check(st.decisions[1]?.id === 8 && st.decisions[1].act === 'approve' && !('body' in st.decisions[1]), `Approve on the note carried ${JSON.stringify(st.decisions[1])}`)
      await fits(t, page, `${ROUTE} proposals @phone`)
    },
  })

  tests.push({
    name: 'raven:older:desktop',
    group: 'raven',
    device: 'desktop',
    timeout: 300_000,
    async run(t) {
      const page = await t.page()
      const st = ravenBackend(page, { filler: 70, replyMs: -1 })
      await page.goto(ROUTE)
      await threadUp(page)
      await until(page, () => document.querySelectorAll('.rv .rv-msg').length === 60, 'the first read did not show 60 lines')
      const first = await page.eval(() => document.querySelector('.rv-msgs .rv-msg .rv-md')?.innerText)
      await page.eval(() => { document.querySelector('.rv-msgs').scrollTop = 0 })
      await waitFor(() => st.olderGets.length, 60_000, 'GET /api/raven/messages').catch((e) => t.check(false, e.message))
      t.check(st.olderGets[0]?.before === '20' && st.olderGets[0]?.limit === '40', `the older read asked ${JSON.stringify(st.olderGets[0])}`)
      await until(page, () => document.querySelectorAll('.rv .rv-msg').length === 79, 'the older page did not go in above')
      const after = await page.eval((txt) => {
        const m = [...document.querySelectorAll('.rv-msgs .rv-msg .rv-md')].find((x) => x.innerText === txt)
        const list = document.querySelector('.rv-msgs')
        return { found: !!m, scrollTop: list.scrollTop }
      }, first)
      t.check(after.found && after.scrollTop > 100, `the view jumped to the top after the older page (${JSON.stringify(after)})`)
      await page.eval(() => { document.querySelector('.rv-msgs').scrollTop = 0 })
      await until(page, () => /The start of the conversation/.test(document.querySelector('.rv-msgs')?.innerText ?? ''), 'the start of the conversation is not marked')
      await sleep(800)
      t.check(st.olderGets.length === 1, `an older read went out after the start (${st.olderGets.length} reads)`)
      // five new lines push five out of the newest 60: they stay on screen, no gap opens
      for (let i = 0; i < 5; i++) st.messages.push({ id: st.nextId++, author: 'raven', text: `New line ${i}`, createdAt: new Date().toISOString(), refs: [], meta: {}, proposal: null })
      st.seq++
      await until(page, () => document.querySelectorAll('.rv .rv-msg').length === 84, 'the five new lines did not all go in, or older ones fell out', [], 90_000)
        .catch(async (e) => t.check(false, `${e.message} (${await page.eval(() => document.querySelectorAll('.rv .rv-msg').length)} lines)`))
    },
  })

  tests.push({
    name: 'raven:links:phone',
    group: 'raven',
    device: 'phone',
    timeout: 300_000,
    async run(t) {
      const page = await t.page()
      ravenBackend(page, { replyMs: -1 })
      await page.goto(`${ROUTE}?c=team`)
      await threadUp(page)
      await page.waitPath(new RegExp(`^${ROUTE}$`), 60_000).catch((e) => t.check(false, `an old ?c= link: ${e.message}`))
      await page.goto(`${ROUTE}?compose=1`)
      await threadUp(page)
      await until(page, () => document.activeElement === document.querySelector('.rv .rv-compose textarea'), '?compose=1 did not focus the box')
      await page.waitPath(new RegExp(`^${ROUTE}$`), 60_000).catch((e) => t.check(false, `?compose=1: ${e.message}`))
      // the tab's old address (old pushes, the old Siri and hotkey links): Raven, with the box focused
      await page.goto('/m/messages?compose=1')
      await threadUp(page)
      await until(page, () => document.activeElement === document.querySelector('.rv .rv-compose textarea'), '/m/messages?compose=1 did not focus the box')
      await page.waitPath(new RegExp(`^${ROUTE}$`), 60_000).catch((e) => t.check(false, `/m/messages?compose=1: ${e.message}`))
      // and it stays there: the old address's rewrite and the box's own clean-up never race each other back to ?compose=1
      await sleep(2500)
      const end = await page.eval(() => ({ path: location.pathname + location.search, tab: document.querySelector('.vl-nav .vl-tab-prim[aria-current="page"]')?.textContent?.trim() }))
      t.check(end.path === ROUTE && end.tab === 'Raven', `/m/messages?compose=1 ended at ${JSON.stringify(end)}, want ${ROUTE} with the Raven tab lit`)
    },
  })

  for (const device of ['phone', 'ipad', 'desktop']) {
    tests.push({
      name: `raven:quick:${device}`,
      group: 'raven',
      device,
      timeout: 400_000,
      async run(t) {
        const page = await t.page()
        const st = ravenBackend(page, { replyMs: 25_000 })
        await page.goto('/m/settings')
        await until(page, () => !!document.querySelector('.vl-shell > .rv-fab'), 'no corner button on Settings', [], UP_MS)
        const place = await page.eval(() => {
          const f = document.querySelector('.vl-shell > .rv-fab').getBoundingClientRect()
          const W = document.documentElement.clientWidth
          const H = window.innerHeight
          return { right: W - f.right, bottom: H - f.bottom, w: f.width, h: f.height, lamp: !!document.querySelector('.vl-lamp'), open: !document.querySelector('.rv-q')?.hidden }
        })
        t.check(place.right >= 6 && place.right <= 24 && place.bottom >= 4 && place.bottom <= 44 && place.w >= 40 && place.w <= 60 && Math.abs(place.w - place.h) < 1, `the corner button is not a round button in the bottom-right: ${JSON.stringify(place)}`)
        t.check(!place.lamp, 'a lights button shows beside the corner button')
        t.check(!place.open, 'the sheet is open before the tap')
        await page.tap({ sel: '.vl-shell > .rv-fab' }, { wait: 40_000 })
        await until(page, () => !document.querySelector('.rv-q')?.hidden, 'the tap did not open the sheet')
        const s = await page.eval(sheetSnap)
        t.check(s.focused, 'the sheet\'s box is not focused after the tap')
        if (device === 'phone') t.check(s.box.l <= 1 && s.box.r >= s.box.W - 1 && s.box.b >= s.box.H - 1, `the phone sheet is not along the bottom: ${JSON.stringify(s.box)}`)
        else t.check(s.box.r > s.box.W - 40 && s.box.w <= 460, `the sheet is not a small popover in the corner: ${JSON.stringify(s.box)}`)
        await t.shot(page, 'open')
        await page.type('Note: buy printer paper')
        await page.tap({ sel: '.rv-q .rv-send' }, { wait: 40_000 })
        await waitFor(() => st.sent.length, 60_000, 'POST /api/raven/messages').catch((e) => t.check(false, e.message))
        t.check(st.sent[0]?.text === 'Note: buy printer paper' && st.sent[0]?.source === 'quick', `the quick send carried ${JSON.stringify(st.sent[0])}`)
        await until(page, () => /buy printer paper/.test(document.querySelector('.rv-q-me')?.textContent ?? ''), 'the sheet does not show the sent line')
          .catch(async (e) => t.check(false, `${e.message}: ${JSON.stringify(await page.eval(sheetSnap))}`))
        await until(page, () => /thinking · Sonnet 5.5 · high/.test(document.querySelector('.rv-q-wait')?.textContent ?? ''), 'the sheet does not show Raven working')
          .catch(async (e) => t.check(false, `${e.message}: ${JSON.stringify(await page.eval(sheetSnap))}`))
        await t.shot(page, 'working')
        await until(page, () => /^Done: Note: buy printer paper/.test(document.querySelector('.rv-q-reply .rv-md')?.innerText ?? ''), 'the reply did not reach the sheet', [], 90_000)
        const r = await page.eval(sheetSnap)
        t.check(/^Sonnet 5\.5 · high · \d{1,2}:\d{2} [AP]M ET$/.test(r.meta), `the reply's meta line reads "${r.meta}"`)
        await waitFor(() => st.reads.length, 60_000, 'the read of the reply').catch((e) => t.check(false, e.message))
        await fits(t, page, `quick sheet @${device}`)
        await t.shot(page, 'reply')
        // closing: Escape on a keyboard, a tap outside on a touch screen (the strip's wordmark: nothing there takes the tap)
        if (device === 'desktop') await page.key('Escape')
        else await page.tap({ x: 40, y: 14 })
        await until(page, () => document.querySelector('.rv-q')?.hidden, 'the sheet did not close')
        // Open conversation goes to the Raven tab and closes the sheet
        await page.tap({ sel: '.vl-shell > .rv-fab' }, { wait: 40_000 })
        await until(page, () => !document.querySelector('.rv-q')?.hidden, 'the sheet did not open again')
        t.check(await page.eval(() => !document.querySelector('.rv-q-me') && !document.querySelector('.rv-q-reply')), 'the sheet opened again still showing the answered line')
        await page.tap({ sel: '.rv-q-open' }, { wait: 40_000 })
        await page.waitPath(ROUTE, 60_000).catch((e) => t.check(false, e.message))
        await until(page, () => document.querySelector('.rv-q')?.hidden, 'the sheet stayed open on Raven')
      },
    })
  }

  tests.push({
    name: 'raven:keys:desktop',
    group: 'raven',
    device: 'desktop',
    timeout: 360_000,
    async run(t) {
      const page = await t.page()
      ravenBackend(page, { replyMs: -1 })
      await page.goto('/m/settings')
      await until(page, () => !!document.querySelector('.vl-shell > .rv-fab'), 'no corner button on Settings', [], UP_MS)
      await ctrlShiftSpace(page)
      await until(page, () => !document.querySelector('.rv-q')?.hidden && document.activeElement === document.querySelector('.rv-q textarea'), 'Ctrl+Shift+Space did not open the sheet with its box focused')
      await page.key('Escape')
      await until(page, () => document.querySelector('.rv-q')?.hidden, 'Escape did not close the sheet')
      // the palette's Message Raven
      await page.key('k', { ctrl: true })
      await until(page, () => !!document.querySelector('.vl-pal input'), 'Ctrl+K did not open the palette')
      await page.type('message raven')
      await until(page, () => /Message Raven/.test(document.querySelector('.vl-pal-row[data-on]')?.textContent ?? ''), 'the palette does not offer Message Raven first')
      await page.key('Enter')
      await until(page, () => !document.querySelector('.rv-q')?.hidden && document.activeElement === document.querySelector('.rv-q textarea'), 'the palette did not open the sheet with its box focused')
      await page.key('Escape')
      await until(page, () => document.querySelector('.rv-q')?.hidden, 'Escape did not close the sheet the palette opened')
      // on the Raven tab the chord focuses the conversation's own box
      await page.goto(ROUTE)
      await threadUp(page)
      await page.eval(() => document.activeElement?.blur())
      await ctrlShiftSpace(page)
      await until(page, () => document.activeElement === document.querySelector('.rv .rv-compose textarea'), 'on Raven the chord did not focus the box')
      t.check(await page.eval(() => document.querySelector('.rv-q')?.hidden), 'on Raven the chord opened the sheet')
    },
  })

  // every tab and page with the corner button: nothing on the page sits under it at the bottom (the phone, the
  // landscape iPad and a 1600x900 window, whose pages lay out differently)
  for (const device of ['phone', 'ipadland', 'desktop']) {
    tests.push({
      name: `raven:corner:${device}`,
      group: 'raven',
      device,
      timeout: 1_500_000,
      async run(t) {
        const page = await t.page()
        ravenBackend(page, { replyMs: -1, quiet: false })
        const routes = ['/m/dashboard/today', '/m/ai/sessions', '/m/ai/projects', '/m/ai/usage', '/m/lights', '/m/media/dashboard', '/m/media/movies', '/m/media/requests', '/m/system/hosts', '/m/system/services', '/m/system/trades', '/m/settings', '/m/inbox', '/m/tasks', '/m/meals']
        // RAVEN_CORNER=/m/media/movies,... runs only those (a recheck after a fix)
        const only = (process.env.RAVEN_CORNER ?? '').split(',').filter(Boolean)
        for (const path of only.length ? routes.filter((r) => only.includes(r)) : routes) {
          await t.step(path, async () => {
            await page.goto(path)
            await until(page, () => !!document.querySelector('.rv-fab'), `no corner button on ${path}`, [], UP_MS)
            await sleep(6000)
            // the page and every scroller in it to its end (Media's grids scroll on their own), then a moment for rows that render
            // late; twice, since a section that loads late above the end (Today's mail on a busy host) pushes the end down again
            const toEnd = () => page.eval(() => {
              const area = document.querySelector('.vl-page[data-active]') || document.querySelector('.vl-set') || document.querySelector('.vpg-main[data-scroll]') || document.querySelector('.vpg-main')
              if (!area) return -1
              let n = 0
              for (const el of [area, ...area.querySelectorAll('*')]) {
                const oy = getComputedStyle(el).overflowY
                if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2) { el.scrollTop = el.scrollHeight; n++ }
              }
              return n
            })
            if ((await toEnd()) < 0) throw new Error('no page area')
            await sleep(2500)
            await toEnd()
            await sleep(1000)
            const r = await page.eval(() => {
              const fab = document.querySelector('.rv-fab')
              const f = fab.getBoundingClientRect()
              const area = document.querySelector('.vl-page[data-active]') || document.querySelector('.vl-set') || document.querySelector('.vpg-main[data-scroll]') || document.querySelector('.vpg-main')
              const W = window.innerWidth
              const H = window.innerHeight
              // what of an element shows: nothing when an ancestor hides it (opacity, inert, aria-hidden), else its box cut by every clipping ancestor
              const shownBox = (el) => {
                const r0 = el.getBoundingClientRect()
                let box = { l: r0.left, t: r0.top, r: r0.right, b: r0.bottom }
                for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
                  const cs = getComputedStyle(a)
                  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null
                  if (a.hasAttribute('inert') || a.getAttribute('aria-hidden') === 'true') return null
                  if (a !== el && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')) {
                    const c = a.getBoundingClientRect()
                    box = { l: Math.max(box.l, c.left), t: Math.max(box.t, c.top), r: Math.min(box.r, c.right), b: Math.min(box.b, c.bottom) }
                    if (box.r <= box.l || box.b <= box.t) return null
                  }
                }
                return box
              }
              const hits = []
              for (const el of area.querySelectorAll('*')) {
                if (fab.contains(el)) continue
                if (el instanceof SVGElement && el.tagName !== 'svg') continue
                if (el.tagName === 'CANVAS' || el.type === 'file' || el.type === 'hidden') continue
                const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
                const control = /^(BUTTON|INPUT|TEXTAREA|SELECT|IMG|A|svg)$/i.test(el.tagName)
                if (!own && !control) continue
                const b0 = el.getBoundingClientRect()
                if (b0.width < 1 || b0.height < 1 || b0.width * b0.height > 0.4 * W * H) continue
                const b = shownBox(el)
                if (b && b.r > f.left + 2 && b.l < f.right - 2 && b.b > f.top + 2 && b.t < f.bottom - 2) {
                  hits.push(`${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ')[0]} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`)
                }
              }
              return { hits: hits.slice(0, 6) }
            })
            if (r.error) throw new Error(r.error)
            t.check(!r.hits.length, `${path}: under the corner button at the bottom of the page: ${r.hits.join(', ')}`)
            await sleep(400)
            await t.shot(page, path.replace(/^\/m\//, '').replace(/\//g, '-'))
          })
        }
      },
    })
  }

  tests.push({
    name: 'raven:down:phone',
    group: 'raven',
    device: 'phone',
    timeout: 240_000,
    async run(t) {
      const page = await t.page()
      ravenBackend(page, { down: true })
      t.allowProblems.push(/503|Service Unavailable/)
      await page.goto(ROUTE)
      await until(page, () => /Raven is not answering: Raven is restarting/.test(document.querySelector('.rv-msgs')?.innerText ?? '') && document.querySelector('.rv-status')?.textContent === 'not answering', 'no plain line (and header) for a Raven that does not answer', [], UP_MS)
      await fits(t, page, `${ROUTE} down @phone`)
    },
  })

  return tests
}
