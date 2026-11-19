// DESK: the Desk tab (/m/desk, src/v2/screens/Desk.tsx and kit/desk.ts): Claude sessions in tabs
// like Windows Terminal, one to three columns, over a FAKE pane list. Never a real pane: every
// /api/terminal/sessions read is answered in the browser with made-up vk-e2e... names, so a tab's
// terminal (the pop-out page in an iframe) never attaches (its socket is refused in the page),
// and every write (a new session, a stop) is answered in the browser too.
//
//   layout   per device (phone, both iPads, 1600x900, 2560x1440 at 1.2): the column count, tabs per
//            column by area (work areas first, the rest last), a mark per state (working the bolt,
//            asking the bubble, idle the pause circle, an ended pane faint, a shell none), the
//            title from the pane or the board, the tooltip with area, state and the question,
//            44 px tabs on a touch screen, nothing wider than the screen, no lights button
//   done     a hidden tab going working to idle, and another working to asking, lights its title;
//            opening it clears it; a whole run between two reads lights too; an empty list from
//            the API keeps the layout; the badge counts them (asking tone) on the Desk and from another
//            screen, survives a reload, and no terminal is mounted before the Desk is opened
//   keys     Ctrl+Tab, Ctrl+Shift+Tab, Alt+N, Alt+Left/Right, Ctrl+Alt+D, from the Desk and from
//            inside a tab's terminal (the framed page hands them up)
//   move     the tab menu's Move right (mouse) and Move left (touch), a drag to the other strip,
//            the place kept across a reload
//   close    the x and a middle click take a tab off the Desk, "+" puts it back from Running
//            sessions; Stop in the menu takes two presses and sends the kill
//   new      "+" starts Claude in a launch target in that column, the new tab active there
//   cols     the column control (1, 2, 3), kept across a reload
//   phone    one strip that scrolls sideways, the active tab kept in view

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { TARGETS, quietThor, termOpened } from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })
const iso = (ms) => new Date(ms).toISOString()

// made-up pane names in the real shape (vk- and 10 hex characters)
const P = {
  w1: 'vk-e2e00000a1', // work (board area), working
  w2: 'vk-e2e00000a2', // work (an everyday launch target), asking
  w3: 'vk-e2e00000a7', // work (board area), working
  p1: 'vk-e2e00000a3', // personal (board), idle
  s1: 'vk-e2e00000a4', // server (board), working
  d1: 'vk-e2e00000a5', // personal (board), ended
  sh: 'vk-e2e00000a6', // a shell in a target that names no area
}
const SID = {
  w1: '0e2e0000-0000-4000-8000-0000000000e1',
  w3: '0e2e0000-0000-4000-8000-0000000000e7',
  p1: '0e2e0000-0000-4000-8000-0000000000e3',
  s1: '0e2e0000-0000-4000-8000-0000000000e4',
  d1: '0e2e0000-0000-4000-8000-0000000000e5',
}
const ASK = 'Should I push the branch now?'

/** The fake pane list, the board that names their areas, and the writes the Desk makes. */
export function deskBackend(page) {
  const now = Date.now()
  const pane = (name, o) => ({
    name, label: o.label ?? 'e2e', mode: o.mode ?? 'new', host: 'thor', target: o.target ?? '', sessionId: o.sid ?? '',
    createdAt: now - o.age, activityAt: now - 30_000, outputAt: now - 30_000, clients: 0, dead: !!o.dead, deadStatus: o.dead ? 0 : null, deadText: '',
    size: '120x40', projectId: '', state: o.state, title: o.title ?? '', stateSince: now - (o.since ?? 120_000), ask: o.ask ?? '',
  })
  const st = {
    panes: [
      pane(P.w1, { sid: SID.w1, state: 'working', title: 'Fix the login page', age: 900_000 }),
      pane(P.w3, { sid: SID.w3, state: 'working', title: 'Printer queue report', age: 800_000 }),
      pane(P.w2, { target: 'alpha', label: 'Alpha', state: 'asking', ask: ASK, title: 'Mailbox move plan', age: 700_000, since: 600_000 }),
      pane(P.p1, { sid: SID.p1, state: 'idle', age: 600_000 }),
      pane(P.s1, { sid: SID.s1, state: 'working', title: 'Backup check', age: 500_000 }),
      pane(P.d1, { sid: SID.d1, state: 'dead', dead: true, title: 'Old notes', age: 400_000 }),
      pane(P.sh, { mode: 'shell', target: 'gamma', label: 'Gamma sh', state: 'shell', age: 300_000 }),
    ],
    kills: [],
    opens: [],
    // GET /api/terminal/sessions reads, and each pane's transcript reads (a tab's Chat view)
    reads: 0,
    tx: {},
  }
  const row = (sessionId, title, area) => ({
    sessionId, title, titleFromClaude: true, project: 'e2e-folder', area, launchGroup: null, host: 'thor', cwd: null,
    lastActivityUtc: iso(now - 60_000), bytes: 1000, live: true, onDesk: false, activity: 'idle', disposition: 'open', resumeCommand: null,
  })
  const board = {
    sessions: [
      row(SID.w1, 'Board title one', 'work'),
      row(SID.w3, 'Board title three', 'work'),
      row(SID.p1, 'Weekend trip plan', 'personal'),
      row(SID.s1, 'Board backup title', 'server'),
      row(SID.d1, 'Board old notes', 'personal'),
    ],
    hookRunsSkipped: 0,
  }
  quietThor(page)
  page.mock('/api/session-board', () => ok(board))
  page.mock('/api/hosts/thor/sessions', () => ok(board))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server', 'work'], mixable: ['personal', 'server'] }))
  page.mock('/api/terminal/sessions', () => {
    st.reads += 1
    if (st.emptyOnce) {
      st.emptyOnce = false
      return ok([])
    }
    return ok(st.empty ? [] : st.panes)
  })
  page.mock(/^\/api\/terminal\/sessions\/vk-[0-9a-z]{10}\/transcript$/, ({ path }) => {
    const name = path.split('/')[4]
    st.tx[name] = (st.tx[name] ?? 0) + 1
    return ok({ sessionId: '', entries: [], cursor: 'e2e', more: false })
  })
  page.mock('/api/terminal/status', () => ok({ ok: true, tmux: '3.8', ssh: true, remote: 'thor', serverUp: true, maxSessions: 30 }))
  page.onWrite((w) => {
    const kill = /^\/api\/terminal\/sessions\/(vk-[0-9a-f]{10})\/kill$/.exec(w.path)
    if (w.method === 'POST' && kill) {
      st.kills.push(kill[1])
      st.panes = st.panes.filter((p) => p.name !== kill[1])
      return ok({ killed: true })
    }
    if (w.method === 'POST' && w.path === '/api/terminal/sessions') {
      st.opens.push(w.json)
      const r = termOpened(w.json)
      st.panes = [...st.panes, { ...r.session, state: 'idle', title: '', stateSince: Date.now(), ask: '' }]
      return { status: 201, body: r }
    }
    return undefined
  })
  /** Changes one pane's state (and its question), as the backend would. */
  st.set = (name, state, ask = '') => {
    st.panes = st.panes.map((p) => (p.name === name ? { ...p, state, ask, stateSince: Date.now() } : p))
  }
  /**
   * A whole run between two reads: the pane printed (window activity, outputAt) and its state moved,
   * but it reads idle again. No key was typed, so the session's own activity (activityAt) stays.
   */
  st.ran = (name) => {
    const now = Date.now()
    st.panes = st.panes.map((p) => (p.name === name ? { ...p, state: 'idle', ask: '', stateSince: now, outputAt: now } : p))
  }
  /**
   * valkyrie-api restarted: every pane's stateSince is the first read's time, one value for all, and
   * the mounted terminals attached again (an attach moves the session's activity). One idle pane
   * printed on the way (a redraw at the new attach).
   */
  st.restart = (printed) => {
    const now = Date.now()
    st.panes = st.panes.map((p) => ({ ...p, stateSince: now, activityAt: now, ...(p.name === printed ? { outputAt: now } : {}) }))
  }
  /** The API answering an empty list (what it does when tmux is slow to reply): every read, or the next one only. */
  st.empty = false
  st.emptyOnce = false
  return st
}

/** Every strip of the active Desk: its column, focus, its tab row's scroll, and its tabs. */
function strips() {
  return [...document.querySelectorAll('.vl-page[data-active] .dk-strip')].map((s) => {
    const row = s.querySelector('.dk-tabs')
    const add = s.querySelector('.dk-add')?.getBoundingClientRect()
    return {
      col: Number(s.getAttribute('data-col')),
      focus: s.hasAttribute('data-focus'),
      sw: row.scrollWidth,
      cw: row.clientWidth,
      left: row.scrollLeft,
      // "+" stays in view whatever the row holds
      addIn: !!add && add.right <= s.getBoundingClientRect().right + 1 && add.width > 0,
      tabs: [...s.querySelectorAll('.dk-tab')].map((t) => {
        const r = t.getBoundingClientRect()
        const sr = row.getBoundingClientRect()
        return {
          name: t.getAttribute('data-name'),
          on: t.hasAttribute('data-on'),
          lit: t.hasAttribute('data-lit'),
          state: t.getAttribute('data-state'),
          mark: t.querySelector('.vl-sicon')?.getAttribute('data-a') ?? null,
          title: t.querySelector('.dk-tab-t')?.textContent ?? '',
          tip: t.getAttribute('title') ?? '',
          h: r.height,
          inView: r.left >= sr.left - 1 && r.right <= sr.right + 1,
        }
      }),
    }
  })
}

const names = (cols) => cols.map((c) => c.tabs.map((t) => t.name))
const activeIn = (cols, c) => cols[c]?.tabs.find((t) => t.on)?.name ?? null
const tabOf = (cols, name) => cols.flatMap((c) => c.tabs).find((t) => t.name === name) ?? null

async function deskUp(page, n = 7) {
  await page.waitFor((k) => document.querySelectorAll('.vl-page[data-active] .dk-tab').length >= k, { args: [n], timeout: 30_000, message: `the Desk did not show ${n} tabs` })
  // the board and the launch targets place the tabs by area as they land, and a late webfont widens
  // them: wait until nothing moves
  const shape = () => page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .dk-strip')]
    .map((s) => [...s.querySelectorAll('.dk-tab')].map((x) => `${x.getAttribute('data-name')}${x.hasAttribute('data-on') ? '*' : ''}@${Math.round(x.getBoundingClientRect().right)}`).join(',')).join('|'))
  const t0 = Date.now()
  let last = await shape()
  for (;;) {
    await sleep(1200)
    const now = await shape()
    if (now === last || Date.now() - t0 > 15_000) break
    last = now
  }
}

const badge = (page) => page.eval(() => {
  const b = document.querySelector('.vl-nav .vl-tab-prim .dk-badge')
  return b ? { n: b.getAttribute('data-n'), tone: b.getAttribute('data-tone') } : null
})

async function until(page, fn, message, args = [], timeout = 8000) {
  await page.waitFor(fn, { args, timeout, message })
}

/** A tap that waits longer for the target to hold still (odin is shared, and a loaded one lays out late). */
const tap = (page, target, opts = {}) => page.tap(target, { wait: 12_000, ...opts })

/** The Desk opens on a screen in its device's column count, tabs placed by area. */
const LAYOUTS = {
  phone: 1,
  ipad: 1,
  ipadland: 2,
  desktop: 2,
  desk1440: 2,
}

function layoutTests() {
  return Object.entries(LAYOUTS).map(([device, n]) => ({
    name: `desk:layout:${device}`,
    group: 'desk',
    device,
    timeout: 180_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page()
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      const cols = await page.eval(strips)
      t.check(cols.length === n, `${cols.length} column(s), want ${n} on ${device}`)
      const work = [P.w1, P.w3, P.w2]
      const rest = [P.p1, P.s1, P.d1, P.sh]
      if (n === 1) t.check(JSON.stringify(names(cols)[0]) === JSON.stringify([...work, ...rest]), `the one strip reads ${JSON.stringify(names(cols)[0])}, want every tab oldest first`)
      else {
        t.check(JSON.stringify(names(cols)[0]) === JSON.stringify(work), `column 1 holds ${JSON.stringify(names(cols)[0])}, want the work sessions ${JSON.stringify(work)}`)
        t.check(JSON.stringify(names(cols)[n - 1]) === JSON.stringify(rest), `the last column holds ${JSON.stringify(names(cols)[n - 1])}, want ${JSON.stringify(rest)}`)
      }
      const marks = Object.fromEntries(cols.flatMap((c) => c.tabs).map((x) => [x.name, x.mark]))
      t.check(marks[P.w1] === 'working' && marks[P.w2] === 'asking' && marks[P.p1] === 'idle' && marks[P.d1] === 'closed' && marks[P.sh] === null,
        `the marks read ${JSON.stringify(marks)}: want working, asking, idle, an ended pane's faint mark, and no mark on a shell`)
      const icons = await page.eval((w1, w2, p1) => {
        const of = (n) => {
          const svg = document.querySelector(`.dk-tab[data-name="${n}"] .vl-sicon svg`)
          return svg ? { cls: String(svg.getAttribute('class')), lucide: [...svg.classList].find((c) => c.startsWith('lucide-')) ?? '' } : null
        }
        return { w: of(w1), a: of(w2), i: of(p1) }
      }, P.w1, P.w2, P.p1)
      t.check(/vl-icon-fg/.test(icons.w?.cls) && /vl-icon-glow/.test(icons.w?.cls) && /zap/.test(icons.w?.lucide), `working is not the lit bolt: ${JSON.stringify(icons.w)}`)
      t.check(/vl-icon-acc2/.test(icons.a?.cls) && /vl-icon-glow/.test(icons.a?.cls) && /message-circle-question/.test(icons.a?.lucide), `asking is not the lit bubble in the second accent: ${JSON.stringify(icons.a)}`)
      t.check(/vl-icon-dim/.test(icons.i?.cls) && !/vl-icon-glow/.test(icons.i?.cls) && /circle-pause/.test(icons.i?.lucide), `idle is not the dim pause circle: ${JSON.stringify(icons.i)}`)
      const titles = Object.fromEntries(cols.flatMap((c) => c.tabs).map((x) => [x.name, x.title]))
      t.check(titles[P.w1] === 'Fix the login page', `a pane's own title should name its tab, got "${titles[P.w1]}"`)
      t.check(titles[P.p1] === 'Weekend trip plan', `a pane with no title should take the board's, got "${titles[P.p1]}"`)
      t.check(titles[P.sh] === 'Gamma sh', `a shell should keep its label, got "${titles[P.sh]}"`)
      const tip = tabOf(cols, P.w2)?.tip ?? ''
      t.check(tip.includes('Mailbox move plan') && /asking for \d+m/.test(tip) && tip.includes(ASK), `the asking tab's tooltip reads ${JSON.stringify(tip)}: want its title, "asking for Nm" and the question`)
      t.check(/Work · working for/.test(tabOf(cols, P.w1)?.tip ?? ''), `the work tab's tooltip reads ${JSON.stringify(tabOf(cols, P.w1)?.tip)}: want its area and how long it has worked`)
      t.check(/ended/.test(tabOf(cols, P.d1)?.tip ?? ''), `the ended tab's tooltip reads ${JSON.stringify(tabOf(cols, P.d1)?.tip)}`)
      if (device !== 'desktop' && device !== 'desk1440') {
        const short = cols.flatMap((c) => c.tabs).filter((x) => x.h < 43.5)
        t.check(!short.length, `tabs under 44 px on a touch screen: ${short.map((x) => `${x.name} ${x.h}`).join(', ')}`)
      }
      t.check(cols.every((c) => c.addIn), `"+" is scrolled out of a strip: ${JSON.stringify(cols.map((c) => c.addIn))}`)
      if (device === 'phone') {
        const thin = (await page.eval(() => [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((b) => b.getBoundingClientRect().width))).filter((w) => w < 40)
        t.check(!thin.length, `phone tab icons narrower than 40 px: ${thin.join(', ')}`)
      }
      // one terminal per column, the active tab's, filling the rest of the screen
      const frames = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .dk-frame')].map((f) => {
        const r = f.getBoundingClientRect()
        return { name: f.getAttribute('data-name'), on: f.hasAttribute('data-on'), src: f.getAttribute('src'), w: r.width, h: r.height, b: r.bottom }
      }))
      const shown = frames.filter((f) => f.on)
      t.check(shown.length === n, `${shown.length} terminal(s) on screen, want ${n}`)
      t.check(shown.every((f) => f.src === `/m/w/term/${f.name}` && f.h > 300), `the terminals are ${JSON.stringify(shown)}`)
      const r = await page.eval(layoutReport)
      t.check(r.docSW <= r.W + 1, `the page is wider than the screen (${r.docSW} > ${r.W})${r.wide.length ? `: ${r.wide.join(', ')}` : ''}`)
      t.check(r.areaSW <= r.areaCW + 1, `the Desk is wider than its screen (${r.areaSW} > ${r.areaCW})`)
      const foot = await page.eval(() => ({ lamp: !!document.querySelector('.vl-lamp') && getComputedStyle(document.querySelector('.vl-foot')).display !== 'none', H: innerHeight }))
      t.check(!foot.lamp, 'the lights button shows over the Desk')
      t.check(shown.every((f) => f.b <= foot.H + 1 && f.b >= foot.H - 60), `the terminals do not reach the bottom of the screen: ${JSON.stringify(shown.map((f) => f.b))} of ${foot.H}`)
      const tabs = await page.eval(() => [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((b) => ({ label: b.querySelector('.vl-tab-label')?.textContent?.trim(), r: b.getBoundingClientRect().right })))
      const labels = tabs.map((x) => x.label)
      // right after the conversation with Raven (its tab reads Messages until it is renamed Raven)
      t.check(labels.indexOf('Desk') === 2 && /^(Messages|Raven)$/.test(labels[1] ?? ''), `the Desk tab is not third, after Dashboard and Raven: ${labels.join(', ')}`)
      t.check(tabs.every((x) => x.r <= r.W + 1), `a tab in the nav runs off the screen: ${JSON.stringify(tabs)}`)
      // each shown terminal is the pop-out page, framed: no status strip of its own
      await t.step('the terminals render in their tabs', async () => {
        await page.waitFor(() => {
          const on = [...document.querySelectorAll('.vl-page[data-active] .dk-frame[data-on]')]
          try { return on.length > 0 && on.every((f) => !!f.contentDocument?.querySelector('[data-term-root][data-standalone]')) } catch { return false }
        }, { timeout: 90_000, message: 'a tab\'s terminal page never rendered in its frame' })
        await sleep(1500)
        const strips = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .dk-frame[data-on]')].map((f) => !!f.contentDocument?.querySelector('.vl-strip')))
        t.check(strips.every((x) => !x), 'a framed terminal draws its own status strip')
      })
      await t.shot(page)
    },
  }))
}

function doneTests() {
  return [{
    name: 'desk:done:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 280_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      const st = deskBackend(page)
      await t.step('no terminal is mounted before the Desk opens', async () => {
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-nav[data-ready]'), { timeout: 40_000, message: 'the shell did not come up' })
        await sleep(2500)
        const n = await page.eval(() => document.querySelectorAll('.dk-frame').length)
        t.check(n === 0, `${n} terminal(s) mounted on the Dashboard before the Desk was ever opened`)
      })
      await tap(page, { sel: '.vl-nav .vl-tab-prim', text: /^\s*Desk\s*$/ })
      await deskUp(page)
      let cols = await page.eval(strips)
      t.check(activeIn(cols, 0) === P.w1 && activeIn(cols, 1) === P.p1, `the active tabs are ${activeIn(cols, 0)} and ${activeIn(cols, 1)}`)
      t.check(!cols.flatMap((c) => c.tabs).some((x) => x.lit), 'a tab is lit before anything finished')
      await t.step('working to idle and working to asking on hidden tabs light them', async () => {
        st.set(P.s1, 'idle')
        st.set(P.w3, 'asking', 'Which printer is the default?')
        await until(page, (a, b) => !!document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`) && !!document.querySelector(`.dk-tab[data-name="${b}"][data-lit]`), 'the two finished tabs never lit (the Desk polls every 2 s)', [P.s1, P.w3], 9000)
        cols = await page.eval(strips)
        t.check(tabOf(cols, P.s1)?.mark === 'idle' && tabOf(cols, P.w3)?.mark === 'asking', `their marks read ${tabOf(cols, P.s1)?.mark} and ${tabOf(cols, P.w3)?.mark}`)
        const style = await page.eval((a, b) => {
          const w = (n) => getComputedStyle(document.querySelector(`.dk-tab[data-name="${n}"] .dk-tab-main`)).fontWeight
          return { lit: w(a), plain: w(b) }
        }, P.s1, P.p1)
        t.check(Number(style.lit) >= 700 && Number(style.plain) < 700, `a lit title is not bold: ${JSON.stringify(style)}`)
        const b = await badge(page)
        t.check(b?.n === '2' && b.tone === 'ask', `the Desk badge reads ${JSON.stringify(b)}, want 2 in the asking tone`)
        await t.shot(page, 'lit')
      })
      await t.step('opening a lit tab clears it', async () => {
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
        await until(page, (a) => !document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'the opened tab is still lit', [P.s1])
        let b = await badge(page)
        t.check(b?.n === '1' && b.tone === 'ask', `the badge reads ${JSON.stringify(b)}, want 1 asking`)
        await tap(page, `.dk-tab[data-name="${P.w3}"] .dk-tab-main`)
        await until(page, (a) => !document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'the opened asking tab is still lit', [P.w3])
        b = await badge(page)
        t.check(!b, `the badge still reads ${JSON.stringify(b)} with nothing unseen`)
        cols = await page.eval(strips)
        t.check(tabOf(cols, P.w3)?.mark === 'asking', 'the asking tab lost its bubble once opened')
      })
      await t.step('the active tab finishing in view does not light', async () => {
        st.set(P.w1, 'working')
        await sleep(2600)
        await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-main`)
        await sleep(400)
        st.set(P.w1, 'idle')
        await until(page, (a) => document.querySelector(`.dk-tab[data-name="${a}"]`)?.getAttribute('data-state') === 'idle', 'the active tab never read idle', [P.w1], 8000)
        await sleep(300)
        cols = await page.eval(strips)
        t.check(!tabOf(cols, P.w1)?.lit, 'the tab in view lit when it finished')
      })
      await t.step('a whole run between two reads lights a hidden tab', async () => {
        cols = await page.eval(strips)
        t.check(activeIn(cols, 1) !== P.p1, `the personal tab is in view (${activeIn(cols, 1)}), the step needs it hidden`)
        st.ran(P.p1)
        await until(page, (a) => !!document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'a run that started and finished between two reads never lit', [P.p1], 9000)
        await tap(page, `.dk-tab[data-name="${P.p1}"] .dk-tab-main`)
        await until(page, (a) => !document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'the opened tab is still lit', [P.p1])
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
      })
      await t.step('an API restart (every stateSince moves, the terminals attach again) lights nothing', async () => {
        await sleep(2600)
        cols = await page.eval(strips)
        t.check(!cols.flatMap((c) => c.tabs).some((x) => x.lit), `a tab is lit before the restart: ${JSON.stringify(cols.flatMap((c) => c.tabs).filter((x) => x.lit).map((x) => x.name))}`)
        t.check(activeIn(cols, 1) !== P.p1, 'the personal tab is in view, the step needs it hidden')
        st.restart(P.p1)
        await sleep(5000)
        cols = await page.eval(strips)
        const lit = cols.flatMap((c) => c.tabs).filter((x) => x.lit).map((x) => x.name)
        t.check(!lit.length, `an API restart lit ${JSON.stringify(lit)}`)
        const b = await badge(page)
        t.check(!b, `the badge reads ${JSON.stringify(b)} after an API restart`)
      })
      await t.step('one empty read keeps every tab and its mounted terminal', async () => {
        const before = await page.eval(() => {
          const fs = [...document.querySelectorAll('.vl-page[data-active] .dk-frame')]
          fs.forEach((f) => { f.dataset.e2eKeep = '1' })
          return { frames: fs.length, tabs: document.querySelectorAll('.vl-page[data-active] .dk-tab').length }
        })
        t.check(before.frames >= 2, `${before.frames} terminal(s) mounted, the step needs the two active tabs`)
        st.emptyOnce = true
        const r0 = st.reads
        for (let i = 0; i < 20 && st.reads < r0 + 3; i++) await sleep(500)
        const after = await page.eval(() => ({
          frames: document.querySelectorAll('.vl-page[data-active] .dk-frame').length,
          kept: document.querySelectorAll('.vl-page[data-active] .dk-frame[data-e2e-keep]').length,
          tabs: document.querySelectorAll('.vl-page[data-active] .dk-tab').length,
        }))
        t.check(st.reads >= r0 + 2, `the list was read ${st.reads - r0} time(s) in 10 s`)
        t.check(after.tabs === before.tabs, `one empty read changed the tabs: ${before.tabs} -> ${after.tabs}`)
        t.check(after.kept === before.frames, `one empty read reloaded the terminals: ${after.kept} of ${before.frames} kept (${after.frames} mounted)`)
      })
      await t.step('an empty list from the API keeps the tabs where he put them', async () => {
        // a middle click takes it off the Desk (desk:close drives the real mouse)
        await page.eval((n) => document.querySelector(`.dk-tab[data-name="${n}"]`)?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })), P.d1)
        await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the ended tab did not leave the Desk', [P.d1])
        const before = JSON.stringify(names(await page.eval(strips)))
        const saved = await page.eval(() => localStorage.getItem('v2.desk.layout'))
        st.empty = true
        await sleep(5000)
        const during = await page.eval(() => localStorage.getItem('v2.desk.layout'))
        st.empty = false
        await deskUp(page, 6)
        const after = JSON.stringify(names(await page.eval(strips)))
        t.check(during === saved, `an empty list rewrote the saved layout: ${during}`)
        t.check(after === before, `the tabs came back as ${after}, want ${before} (the closed tab off the Desk)`)
      })
      await t.step('the badge counts from another screen, and keeps its count across a reload', async () => {
        st.set(P.p1, 'working')
        await sleep(2600)
        await tap(page, { sel: '.vl-nav .vl-tab-prim', text: /^\s*AI\s*$/ })
        await page.waitPath(/^\/m\/ai/)
        await sleep(500)
        st.set(P.p1, 'idle')
        // off the Desk the list is read every 15 s
        await until(page, () => document.querySelector('.vl-nav .dk-badge')?.getAttribute('data-n') === '1', 'the badge never showed 1 from AI', [], 20_000)
        t.check((await badge(page))?.tone == null, 'an idle finish shows the asking tone')
        await page.goto('/m/ai/sessions')
        await until(page, () => document.querySelector('.vl-nav .dk-badge')?.getAttribute('data-n') === '1', 'the badge lost its count across a reload', [], 40_000)
        await t.shot(page, 'badge')
      })
    },
  }]
}

function keyTests() {
  return [{
    name: 'desk:keys:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 240_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page()
      const st = deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      const act = async (c) => activeIn(await page.eval(strips), c)
      const framed = (name) => page.waitFor((n) => {
        const f = document.querySelector(`.dk-frame[data-name="${n}"]`)
        try { return !!f?.contentDocument?.querySelector('[data-term-root]') } catch { return false }
      }, { args: [name], timeout: 90_000, message: `the terminal page in ${name}'s tab never rendered` })
      await t.step('Ctrl+Tab and Ctrl+Shift+Tab from the Desk', async () => {
        await page.key('Tab', { ctrl: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Tab did not open the next tab', [P.w3])
      })
      await t.step('Ctrl+Tab from inside a terminal (handed up by the framed page)', async () => {
        await framed(P.w3)
        await sleep(400)
        const inFrame = await page.eval((n) => document.activeElement === document.querySelector(`.dk-frame[data-name="${n}"]`), P.w3)
        t.check(inFrame, 'the opened tab did not take the keyboard (the focus is not in its terminal)')
        await page.key('Tab', { ctrl: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Tab inside a terminal did not reach the Desk', [P.w2])
        await framed(P.w2)
        // a tab mounted by that key loaded after it was focused: on a loaded odin, put the focus back in its terminal
        await page.eval((n) => document.querySelector(`.dk-frame[data-name="${n}"]`)?.contentWindow?.focus(), P.w2)
        await sleep(300)
        await page.key('Tab', { ctrl: true, shift: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Shift+Tab inside a terminal did not go back', [P.w3])
      })
      // the rest from the Desk itself: a tab whose terminal is still loading would take the key (on a loaded odin
      // that takes long), so the focus goes back to the Desk before each one
      const host = async () => {
        await sleep(250)
        await page.eval(() => {
          const b = document.querySelector('.vl-page[data-active] .dk-add')
          b?.focus()
          b?.blur()
        })
      }
      await t.step('Ctrl+Shift+Tab wraps to the last tab', async () => {
        await host()
        await page.key('Tab', { ctrl: true, shift: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Shift+Tab did not go back to the first tab', [P.w1])
        await host()
        await page.key('Tab', { ctrl: true, shift: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Shift+Tab did not wrap to the last tab', [P.w2])
      })
      await t.step('Alt+N opens tab N of the column', async () => {
        await host()
        await page.key('1', { alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Alt+1 did not open the first tab', [P.w1])
        await host()
        await page.key('3', { alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Alt+3 did not open the third tab', [P.w2])
        await host()
        await page.key('9', { alt: true })
        await sleep(400)
        t.check((await act(0)) === P.w2, 'Alt+9 with three tabs changed the tab')
      })
      await t.step('Alt+Right and Alt+Left move between the columns', async () => {
        await host()
        await page.key('ArrowRight', { alt: true })
        await until(page, () => !!document.querySelector('.dk-strip[data-col="1"][data-focus]'), 'Alt+Right did not focus the right column')
        await host()
        await page.key('2', { alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="1"] .dk-tab[data-name="${n}"][data-on]`), 'Alt+2 in the right column did not open its second tab', [P.s1])
        await host()
        await page.key('ArrowLeft', { alt: true })
        await until(page, () => !!document.querySelector('.dk-strip[data-col="0"][data-focus]'), 'Alt+Left did not focus the left column')
        t.check((await act(0)) === P.w2 && (await act(1)) === P.s1, 'moving between columns changed a tab')
      })
      await t.step('Ctrl+Alt+D opens the session waiting longest, then the next', async () => {
        // the server tab finishes while hidden; the asking one has waited longer
        await tap(page, `.dk-tab[data-name="${P.p1}"] .dk-tab-main`)
        await sleep(300)
        st.set(P.s1, 'idle')
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-lit]`), 'the hidden server tab never lit', [P.s1], 9000)
        await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-main`)
        await host()
        await page.key('d', { ctrl: true, alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Ctrl+Alt+D did not open the asking session first', [P.w2])
        await host()
        await page.key('d', { ctrl: true, alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="1"] .dk-tab[data-name="${n}"][data-on]`) && !document.querySelector(`.dk-tab[data-name="${n}"][data-lit]`), 'Ctrl+Alt+D did not go on to the finished session', [P.s1])
        t.check(await page.eval(() => !!document.querySelector('.dk-strip[data-col="1"][data-focus]')), 'Ctrl+Alt+D did not focus the column it opened')
      })
      await t.step('normal typing inside a terminal stays in the session', async () => {
        await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-main`)
        await framed(P.w1)
        const typed = await page.eval((n) => {
          const w = document.querySelector(`.dk-frame[data-name="${n}"]`)?.contentWindow
          if (!w) return null
          const send = (o) => {
            const e = new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o })
            ;(w.document.activeElement ?? w.document.body).dispatchEvent(e)
            return e.defaultPrevented
          }
          return {
            a: send({ key: 'a', code: 'KeyA' }),
            altShift1: send({ key: '!', code: 'Digit1', altKey: true, shiftKey: true }),
            ctrlD: send({ key: 'd', code: 'KeyD', ctrlKey: true }),
          }
        }, P.w1)
        t.check(typed && !typed.a && !typed.altShift1 && !typed.ctrlD, `the framed page held back plain keys: ${JSON.stringify(typed)}`)
        await sleep(300)
        t.check((await act(0)) === P.w1, 'a plain key changed the tab')
      })
      await t.step("a hidden tab's terminal page stops its quick reads, and reads again when opened", async () => {
        // w3 was opened above, so it is mounted; w1 is in view
        await framed(P.w3)
        await sleep(2500)
        const t0 = { ...st.tx }
        await sleep(10_000)
        const hidden = (st.tx[P.w3] ?? 0) - (t0[P.w3] ?? 0)
        const shown = (st.tx[P.w1] ?? 0) - (t0[P.w1] ?? 0)
        t.note(`transcript reads in 10 s: in view ${shown}, hidden ${hidden}`)
        t.check(shown >= 2, `the tab in view read its transcript ${shown} time(s) in 10 s (the step needs Chat polling to show)`)
        t.check(hidden <= 1, `the hidden tab read its transcript ${hidden} time(s) in 10 s, want at most 1 (it polls every 20 s while hidden)`)
        const t1 = st.tx[P.w3] ?? 0
        await tap(page, `.dk-tab[data-name="${P.w3}"] .dk-tab-main`)
        for (let i = 0; i < 10 && (st.tx[P.w3] ?? 0) === t1; i++) await sleep(300)
        t.check((st.tx[P.w3] ?? 0) > t1, 'the tab did not read its transcript within 3 s of being opened')
      })
      t.check(!st.kills.length && !st.opens.length, 'a key wrote something')
    },
  }]
}

function moveTests() {
  return [
    {
      name: 'desk:move:desktop',
      group: 'desk',
      device: 'desktop',
      timeout: 150_000,
      async run(t) {
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
        const page = await t.page({ stubFrames: true })
        deskBackend(page)
        await page.goto('/m/desk')
        await deskUp(page)
        await t.step('the tab menu moves a tab right (right-click)', async () => {
          const at = await page.locate(`.dk-tab[data-name="${P.w3}"] .dk-tab-main`)
          await page.mouse(at.x, at.y, { button: 'right' })
          await until(page, () => !!document.querySelector('.dk-menu'), 'a right-click did not open the tab menu')
          const items = await page.eval(() => [...document.querySelectorAll('.dk-menu .dk-mi')].map((b) => b.textContent.trim()))
          t.check(items.join('|') === 'Move right|Close tab|Stop session', `the menu of a left-column tab offers ${items.join(', ')}`)
          await tap(page, { sel: '.dk-menu .dk-mi', text: 'Move right' })
          await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="1"] .dk-tab[data-name="${n}"][data-on]`), 'Move right did not put the tab, active, in the right column', [P.w3])
          const cols = await page.eval(strips)
          t.check(names(cols)[1].at(-1) === P.w3, `the moved tab is not at the end of its new column: ${JSON.stringify(names(cols)[1])}`)
          t.check(activeIn(cols, 0) === P.w1, `the left column's active tab is ${activeIn(cols, 0)}`)
        })
        await t.step('a drag puts a tab in the other strip', async () => {
          await page.eval((n) => {
            const dt = new DataTransfer()
            const tab = document.querySelector(`.dk-tab[data-name="${n}"]`)
            const strip = document.querySelector('.dk-strip[data-col="0"]')
            const ev = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
            ev('dragstart', tab)
            ev('dragover', strip)
            ev('drop', strip)
            ev('dragend', tab)
          }, P.p1)
          await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'the dragged tab is not in the left strip', [P.p1])
          const draggable = await page.eval((n) => document.querySelector(`.dk-tab[data-name="${n}"]`)?.getAttribute('draggable'), P.w1)
          t.check(draggable === 'true', `a tab is not draggable with a mouse (${draggable})`)
        })
        await t.step('the places are kept across a reload', async () => {
          await sleep(300)
          await page.goto('/m/desk')
          await deskUp(page)
          const cols = await page.eval(strips)
          t.check(names(cols)[0].includes(P.p1) && names(cols)[1].includes(P.w3), `after a reload the columns read ${JSON.stringify(names(cols))}`)
          t.check(activeIn(cols, 0) === P.p1 && activeIn(cols, 1) === P.w3, `after a reload the active tabs are ${activeIn(cols, 0)} and ${activeIn(cols, 1)}`)
        })
      },
    },
    {
      name: 'desk:move:ipadland',
      group: 'desk',
      device: 'ipadland',
      timeout: 150_000,
      async run(t) {
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
        const page = await t.page({ stubFrames: true })
        deskBackend(page)
        await page.goto('/m/desk')
        await deskUp(page)
        await t.step('a tap on the active tab opens its menu; Move left', async () => {
          await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
          await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-on]`), 'a tap did not open the tab', [P.s1])
          await sleep(300)
          t.check(!(await page.eval(() => !!document.querySelector('.dk-menu'))), 'the first tap opened the menu instead of the tab')
          await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
          await until(page, () => !!document.querySelector('.dk-menu'), 'a tap on the active tab did not open its menu')
          const items = await page.eval(() => [...document.querySelectorAll('.dk-menu .dk-mi')].map((b) => ({ t: b.textContent.trim(), h: b.getBoundingClientRect().height })))
          t.check(items.map((x) => x.t).join('|') === 'Move left|Close tab|Stop session', `the menu offers ${items.map((x) => x.t).join(', ')}`)
          t.check(items.every((x) => x.h >= 44), `menu rows under 44 px: ${JSON.stringify(items)}`)
          await t.shot(page, 'menu')
          await tap(page, { sel: '.dk-menu .dk-mi', text: 'Move left' })
          await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="0"] .dk-tab[data-name="${n}"][data-on]`), 'Move left did not put the tab in the left column', [P.s1])
        })
        await t.step('a press outside closes the menu', async () => {
          await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
          await until(page, () => !!document.querySelector('.dk-menu'), 'the menu did not open again')
          await tap(page, '.dk-cell[data-col="0"] .dk-scrim', { allowCovered: true })
          await until(page, () => !document.querySelector('.dk-menu'), 'a press outside did not close the menu')
        })
      },
    },
  ]
}

function closeTests() {
  return [
    {
      name: 'desk:close:desktop',
      group: 'desk',
      device: 'desktop',
      timeout: 150_000,
      async run(t) {
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
        const page = await t.page({ stubFrames: true })
        const st = deskBackend(page)
        await page.goto('/m/desk')
        await deskUp(page)
        await t.step('the x takes the active tab off the Desk, the session keeps running', async () => {
          await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-x`)
          await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the closed tab is still on the Desk', [P.w1])
          const cols = await page.eval(strips)
          t.check(activeIn(cols, 0) === P.w3, `after the close the left column shows ${activeIn(cols, 0)}, want its next tab`)
          t.check(!st.kills.length, `closing a tab stopped its session: ${st.kills.join(', ')}`)
        })
        await t.step('a middle click closes a tab', async () => {
          const at = await page.locate(`.dk-tab[data-name="${P.sh}"] .dk-tab-main`)
          await page.mouse(at.x, at.y, { button: 'middle' })
          await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'a middle click did not close the tab', [P.sh])
        })
        await t.step('"+" puts a running session back in its column', async () => {
          await tap(page, '.dk-strip[data-col="1"] .dk-add')
          await until(page, () => !!document.querySelector('.dk-cell[data-col="1"] .dk-pick'), '"+" did not open the new tab sheet')
          const rows = await page.eval(() => [...document.querySelectorAll('.dk-pick .dk-row .dk-row-t')].map((e) => e.textContent))
          t.check(rows.join('|') === 'Fix the login page|Gamma sh', `Running sessions lists ${JSON.stringify(rows)}, want the two closed tabs`)
          const chips = await page.eval(() => [...document.querySelectorAll('.dk-pick .dk-chip')].map((e) => e.textContent.trim()))
          t.check(chips.join('|') === 'Alpha|Beta|Gamma', `the launch targets offered are ${JSON.stringify(chips)}`)
          await t.shot(page, 'plus')
          await tap(page, { sel: '.dk-pick .dk-row', text: /Fix the login page/ })
          await until(page, (n) => !!document.querySelector(`.dk-strip[data-col="1"] .dk-tab[data-name="${n}"][data-on]`), 'the session did not come back, active, in the column whose "+" was pressed', [P.w1])
          t.check(!(await page.eval(() => !!document.querySelector('.dk-pick'))), 'the sheet stayed open')
        })
        await t.step('Stop in the tab menu takes two presses and ends the session', async () => {
          const at = await page.locate(`.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
          await page.mouse(at.x, at.y, { button: 'right' })
          await until(page, () => !!document.querySelector('.dk-menu'), 'no tab menu')
          await tap(page, { sel: '.dk-menu .dk-mi', text: 'Stop session' })
          await until(page, () => /Press again/.test(document.querySelector('.dk-menu .dk-mi[data-tone="hot"]')?.textContent ?? ''), 'Stop did not ask for a second press')
          t.check(!st.kills.length, 'the first press stopped the session')
          // the second press right away, where the armed row is: it disarms after 3.5 s
          const armed = await page.locate({ sel: '.dk-menu .dk-mi', text: /Press again/ })
          if (armed.error) throw new Error(armed.error)
          await page.mouse(armed.x, armed.y)
          await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the stopped session is still on the Desk', [P.s1], 8000)
          t.check(st.kills.join(',') === P.s1, `the kill went to ${st.kills.join(',')}`)
        })
      },
    },
    {
      name: 'desk:new:desktop',
      group: 'desk',
      device: 'desktop',
      timeout: 120_000,
      async run(t) {
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
        const page = await t.page({ stubFrames: true })
        const st = deskBackend(page)
        await page.goto('/m/desk')
        await deskUp(page)
        await tap(page, '.dk-strip[data-col="0"] .dk-add')
        await until(page, () => !!document.querySelector('.dk-cell[data-col="0"] .dk-pick'), '"+" did not open the new tab sheet')
        // the chips carry the targets' short names (lib/quickSessions shortName), as AI > Sessions does
        await tap(page, { sel: '.dk-pick .dk-chip', text: /^\s*Beta\s*$/ })
        await until(page, () => !!document.querySelector('.dk-strip[data-col="0"] .dk-tab[data-name="vk-e2e0000a01"][data-on]'), 'the new session is not the active tab of the column whose "+" was pressed')
        const body = st.opens[0]
        t.check(body?.mode === 'new' && body.target === 'beta' && body.label === 'Beta' && body.cols >= 40 && body.rows >= 12, `the start sent ${JSON.stringify(body)}`)
        const cols = await page.eval(strips)
        t.check(names(cols)[0].at(-1) === 'vk-e2e0000a01', `the new tab is not at the end of its column: ${JSON.stringify(names(cols)[0])}`)
        t.check(st.opens.length === 1 && !st.kills.length, `writes: ${st.opens.length} start(s), ${st.kills.length} kill(s)`)
      },
    },
  ]
}

function colsTests() {
  return [{
    name: 'desk:cols:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 120_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      const count = async () => (await page.eval(strips)).length
      t.check(await page.eval(() => document.querySelector('.dk-ncol[data-on]')?.textContent) === '2', 'the column control does not show 2 lit at 1600 px')
      await tap(page, '.dk-ncol[aria-label="1 column"]')
      await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-strip').length === 1, 'picking 1 did not leave one column')
      await tap(page, '.dk-ncol[aria-label="3 columns"]')
      await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-strip').length === 3, 'picking 3 did not make three columns')
      let cols = await page.eval(strips)
      t.check(names(cols)[0].join() === [P.w1, P.w3, P.w2].join() && names(cols)[1].length === 0 && names(cols)[2].length === 4, `three columns read ${JSON.stringify(names(cols))}: want the work tabs left and the rest right`)
      const quiet = await page.eval(() => document.querySelector('.dk-cell[data-col="1"] .dk-quiet')?.textContent ?? '')
      t.check(/No tabs here/.test(quiet), `the empty middle column says "${quiet}"`)
      const frames = await page.eval(() => [...document.querySelectorAll('.dk-frame[data-on]')].map((f) => Math.round(f.getBoundingClientRect().width)))
      t.check(frames.length === 2 && frames.every((w) => Math.abs(w - frames[0]) <= 1), `the two terminals are ${JSON.stringify(frames)} wide, want a third of the Desk each`)
      await t.shot(page, 'three')
      await page.goto('/m/desk')
      await deskUp(page)
      t.check((await count()) === 3, 'the column count was not kept across a reload')
      await tap(page, '.dk-ncol[aria-label="2 columns"]')
      await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-strip').length === 2, 'picking 2 did not make two columns')
      cols = await page.eval(strips)
      t.check(names(cols)[1].length === 4, `back at two columns the right one reads ${JSON.stringify(names(cols)[1])}`)
    },
  }]
}

function phoneTests() {
  return [{
    name: 'desk:phone',
    group: 'desk',
    device: 'phone',
    timeout: 150_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      let s = (await page.eval(strips))[0]
      t.check(s.sw > s.cw + 20, `the strip does not scroll sideways (${s.sw} of ${s.cw})`)
      t.check(!(await page.eval(() => !!document.querySelector('.dk-ncols'))), 'the phone shows the column control')
      await t.step('a swipe scrolls the strip, not the page', async () => {
        const r = await page.eval(() => {
          const b = document.querySelector('.vl-page[data-active] .dk-tabs').getBoundingClientRect()
          return { y: b.top + b.height / 2, l: b.left, r: b.right }
        })
        await page.swipe(r.r - 30, r.y, r.l + 40, r.y)
        await sleep(500)
        s = (await page.eval(strips))[0]
        t.check(s.left > 20, `a swipe left the strip at scrollLeft ${s.left}`)
        t.check((await page.path()) === '/m/desk', `the swipe moved the page to ${await page.path()}`)
      })
      await t.step('the active tab is kept in view', async () => {
        await tap(page, `.dk-tab[data-name="${P.sh}"] .dk-tab-main`)
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-on]`), 'the last tab did not open', [P.sh])
        await page.eval(() => { document.querySelector('.vl-page[data-active] .dk-tabs').scrollLeft = 0 })
        await page.goto('/m/desk')
        await deskUp(page)
        await sleep(400)
        s = (await page.eval(strips))[0]
        const tab = s.tabs.find((x) => x.name === P.sh)
        t.check(tab?.on && tab.inView, `after a reload the active last tab is not in view (scrollLeft ${s.left}, ${JSON.stringify(tab)})`)
        await t.shot(page)
      })
      const r = await page.eval(layoutReport)
      t.check(r.docSW <= r.W + 1, `the page is wider than the phone (${r.docSW} > ${r.W})`)
    },
  }]
}

export function deskTests() {
  return [...layoutTests(), ...doneTests(), ...keyTests(), ...moveTests(), ...closeTests(), ...colsTests(), ...phoneTests()]
}
