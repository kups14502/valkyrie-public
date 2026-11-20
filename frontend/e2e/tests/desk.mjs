// DESK: the Desk tab (/m/desk, src/v2/screens/Desk.tsx and kit/desk.ts): Claude sessions in tabs
// like Windows Terminal, over a grid he builds by dragging, all over a FAKE pane list. Never a real
// pane: every /api/terminal/sessions read is answered in the browser with made-up vk-e2e... names,
// so a pane's terminal (the pop-out page in an iframe) never attaches (its socket is refused in the
// page), and every write (a new session, a stop, an upload) is answered in the browser too.
//
//   layout   per device (phone, both iPads, 1600x900, 2560x1440 at 1.2): one strip, the tabs sorted
//            by area (the client area first, then personal and server, then the unknown) and then
//            project, a quiet line where the area changes, a mark per state (working the bolt,
//            asking the bubble, idle the pause circle, an ended pane faint, a shell none), the
//            title from the pane or the board, the tooltip, 44 px tabs on a touch screen, one
//            session filling the stage, on a desktop under a title row (title and folder) and as
//            the bare terminal (no composer, keys, activity column or bar), on a touch screen with
//            the terminal page's own controls; nothing wider than the screen, no lights button
//   done     a hidden tab going working to idle, and another working to asking, lights its title;
//            opening it clears it; a whole run between two reads lights too; an API restart and
//            empty lists change nothing; the badge counts them (asking tone) from any screen
//   keys     Ctrl+Tab, Ctrl+Shift+Tab, Alt+N, Alt+Left/Right between panes, Ctrl+Alt+D, from the
//            Desk and from inside a terminal; inside a terminal Ctrl+V reaches the browser's paste
//            (xterm would send ^V), Ctrl+C without a selection stays ^C, a pasted screenshot uploads
//   grid     a tab dragged onto a pane's edge splits it, then 2 over 1, onto its middle takes its
//            place; a pane's title dragged to the strip leaves the grid; the menu's Open beside;
//            five panes make 3x3; the grid is kept across a reload
//   close    the x and a middle click take a tab off the Desk, its pane filled by the next tab;
//            "+" puts it back; Stop in the menu takes two presses and sends the kill
//   new      "+" starts Claude in a launch target, in the focused pane
//   list     "Sessions" lists every running pane by area, then project, and opens the one picked
//   touch    a tap on the focused tab opens its menu (no Open beside), 44 px rows, a press outside closes it
//   phone    one strip that scrolls sideways, the focused tab kept in view

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'
import { TARGETS, quietThor, termOpened } from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })
const iso = (ms) => new Date(ms).toISOString()

// made-up pane names in the real shape (vk- and 10 hex characters)
const P = {
  w1: 'vk-e2e00000a1', // work (board area), working
  w2: 'vk-e2e00000a2', // work (its launch target's group), asking
  w3: 'vk-e2e00000a7', // work (board area), working
  p1: 'vk-e2e00000a3', // personal (board), idle
  pj: 'vk-e2e00000a8', // personal, in a project, idle
  s1: 'vk-e2e00000a4', // server (board), working
  d1: 'vk-e2e00000a5', // personal (board), ended
  sh: 'vk-e2e00000a6', // a shell in a target that names no area
}
const SID = {
  w1: '0e2e0000-0000-4000-8000-0000000000e1',
  w3: '0e2e0000-0000-4000-8000-0000000000e7',
  p1: '0e2e0000-0000-4000-8000-0000000000e3',
  pj: '0e2e0000-0000-4000-8000-0000000000e8',
  s1: '0e2e0000-0000-4000-8000-0000000000e4',
  d1: '0e2e0000-0000-4000-8000-0000000000e5',
}
const ASK = 'Should I push the branch now?'
const PROJECT = 'Garden plan'
/** The tab order: the client area (work), personal (no project, then the project), server, then the area not known. */
const ORDER = [P.w1, P.w3, P.w2, P.p1, P.d1, P.pj, P.s1, P.sh]
const N = ORDER.length

/** The fake pane list, the board that names their areas, and the writes the Desk makes. */
export function deskBackend(page) {
  const now = Date.now()
  const pane = (name, o) => ({
    name, label: o.label ?? 'e2e', mode: o.mode ?? 'new', host: 'thor', target: o.target ?? '', sessionId: o.sid ?? '',
    createdAt: now - o.age, activityAt: now - 30_000, outputAt: now - 30_000, clients: 0, dead: !!o.dead, deadStatus: o.dead ? 0 : null, deadText: '',
    size: '120x40', projectId: o.project ?? '', state: o.state, title: o.title ?? '', stateSince: now - (o.since ?? 120_000), ask: o.ask ?? '',
  })
  const st = {
    panes: [
      pane(P.pj, { sid: SID.pj, state: 'idle', title: 'Seed order', project: 'e2e-garden', age: 1_000_000 }),
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
    uploads: 0,
    // GET /api/terminal/sessions reads
    reads: 0,
  }
  const row = (sessionId, title, area, cwd = null) => ({
    sessionId, title, titleFromClaude: true, project: 'e2e-folder', area, launchGroup: null, host: 'thor', cwd,
    lastActivityUtc: iso(now - 60_000), bytes: 1000, live: true, onDesk: false, activity: 'idle', disposition: 'open', resumeCommand: null,
  })
  const board = {
    sessions: [
      row(SID.w1, 'Board title one', 'work', 'C:\\Users\\e2e\\Clients\\Acme Corporation'),
      row(SID.w3, 'Board title three', 'work'),
      row(SID.p1, 'Weekend trip plan', 'personal', 'C:\\Home'),
      row(SID.pj, 'Board seed order', 'personal'),
      row(SID.s1, 'Board backup title', 'server'),
      row(SID.d1, 'Board old notes', 'personal'),
    ],
    hookRunsSkipped: 0,
  }
  const proj = {
    id: 'e2e-garden', name: PROJECT, area: 'personal', status: 'active', summary: '', nextAction: '', targetKey: 'alpha', exposure: 'private',
    sessionIds: [SID.pj], nextReminderAt: null, updatedAt: iso(now), rev: 1, lastEvent: null,
  }
  quietThor(page)
  page.mock('/api/session-board', () => ok(board))
  page.mock('/api/hosts/thor/sessions', () => ok(board))
  // the first everyday target belongs to the work area by its group
  page.mock('/api/hosts/thor/launch-targets', () => ok({ targets: TARGETS.targets.map((t) => (t.key === 'alpha' ? { ...t, group: 'work' } : t)) }))
  page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server', 'work'], mixable: ['personal', 'server'] }))
  page.mock('/api/proj', () => ok([proj]))
  page.mock('/api/terminal/sessions', () => {
    st.reads += 1
    if (st.emptyOnce) {
      st.emptyOnce = false
      return ok([])
    }
    return ok(st.empty ? [] : st.panes)
  })
  page.mock(/^\/api\/terminal\/sessions\/vk-[0-9a-z]{10}\/transcript$/, () => ok({ sessionId: '', entries: [], cursor: 'e2e', more: false }))
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
    if (w.method === 'POST' && w.path.startsWith('/api/hosts/thor/upload')) {
      st.uploads += 1
      return ok({ done: true, received: 1, name: 'image.png', path: 'C:\\Thor\\uploads\\image.png', size: 1 })
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
  /** valkyrie-api restarted: every pane's stateSince is the first read's time, and one idle pane printed (a redraw). */
  st.restart = (printed) => {
    const now = Date.now()
    st.panes = st.panes.map((p) => ({ ...p, stateSince: now, activityAt: now, ...(p.name === printed ? { outputAt: now } : {}) }))
  }
  /** The API answering an empty list (what it does when tmux is slow to reply): every read, or the next one only. */
  st.empty = false
  st.emptyOnce = false
  return st
}

/** The active Desk: its tabs, the panes in the grid (frame and title row), the strip's scroll. */
function desk() {
  const root = document.querySelector('.vl-page[data-active] .dk')
  const row = root?.querySelector('.dk-tabs')
  const sr = row?.getBoundingClientRect()
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }
  }
  return {
    sw: row?.scrollWidth ?? 0,
    cw: row?.clientWidth ?? 0,
    left: row?.scrollLeft ?? 0,
    tabs: [...(root?.querySelectorAll('.dk-tab') ?? [])].map((t) => {
      const r = t.getBoundingClientRect()
      return {
        name: t.getAttribute('data-name'),
        on: t.hasAttribute('data-on'),
        focus: t.hasAttribute('data-focus'),
        split: t.hasAttribute('data-split'),
        lit: t.hasAttribute('data-lit'),
        state: t.getAttribute('data-state'),
        mark: t.querySelector('.vl-sicon')?.getAttribute('data-a') ?? null,
        title: t.querySelector('.dk-tab-t')?.textContent ?? '',
        tip: t.getAttribute('title') ?? '',
        h: r.height,
        inView: !!sr && r.left >= sr.left - 1 && r.right <= sr.right + 1,
      }
    }),
    // the terminals in view, in the grid's reading order
    frames: [...(root?.querySelectorAll('.dk-frame[data-on]') ?? [])].map((f) => ({ name: f.getAttribute('data-name'), src: f.getAttribute('src'), ...box(f) }))
      .sort((a, b) => a.y - b.y || a.x - b.x),
    mounted: root?.querySelectorAll('.dk-frame').length ?? 0,
    heads: [...(root?.querySelectorAll('.dk-pane') ?? [])].map((p) => ({
      title: p.querySelector('.dk-head-t')?.textContent ?? '',
      folder: p.querySelector('.dk-head-f')?.textContent ?? '',
      focus: p.hasAttribute('data-focus'),
      ...box(p),
    })).sort((a, b) => a.y - b.y || a.x - b.x),
  }
}

const tabNames = (d) => d.tabs.map((t) => t.name)
const viewNames = (d) => d.frames.map((f) => f.name)
const tabOf = (d, name) => d.tabs.find((t) => t.name === name) ?? null
const focusOf = (d) => d.tabs.find((t) => t.focus)?.name ?? null

async function deskUp(page, n = N) {
  await page.waitFor((k) => document.querySelectorAll('.vl-page[data-active] .dk-tab').length >= k, { args: [n], timeout: 30_000, message: `the Desk did not show ${n} tabs` })
  // the board, the projects and the launch targets sort the tabs as they land, and a late webfont widens
  // them: wait until nothing moves
  const shape = () => page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .dk-tab')]
    .map((x) => `${x.getAttribute('data-name')}${x.hasAttribute('data-on') ? '*' : ''}@${Math.round(x.getBoundingClientRect().right)}`).join(','))
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

const inView = (page, names) => until(page, (want) => {
  const got = [...document.querySelectorAll('.vl-page[data-active] .dk-frame[data-on]')]
    .map((f) => ({ n: f.getAttribute('data-name'), r: f.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left).map((x) => x.n)
  return got.join() === want.join()
}, `the grid never showed ${names.join(', ')}`, [names])

/**
 * Drags tab `name` onto pane `target` at (fx, fy) of its box, the way the browser does it: dragstart
 * on the tab, then dragover and drop on the target the Desk puts over that pane once the drag is on.
 */
async function dragOnto(page, name, target, fx, fy) {
  await page.eval((n) => {
    window.__e2eDT = new DataTransfer()
    document.querySelector(`.vl-page[data-active] .dk-tab[data-name="${n}"]`)
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDT }))
  }, name)
  await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-drop').length > 0, 'the drop targets never came up over the panes')
  // the drop target covers the pane's whole box (its title row and the terminal under it), as the pane's frame does
  const at = (type) => page.eval((tgt, x, y, ty) => {
    const pane = document.querySelector(`.vl-page[data-active] .dk-pane[data-name="${tgt}"]`)
    if (!pane) return `no pane ${tgt}`
    const pr = pane.getBoundingClientRect()
    const drop = [...document.querySelectorAll('.vl-page[data-active] .dk-drop')].find((d) => {
      const r = d.getBoundingClientRect()
      return Math.abs(r.left - pr.left) < 2 && Math.abs(r.top - pr.top) < 2
    })
    if (!drop) return `no drop target over ${tgt}`
    const r = drop.getBoundingClientRect()
    drop.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: window.__e2eDT, clientX: r.left + r.width * x, clientY: r.top + r.height * y }))
    return 'ok'
  }, target, fx, fy, type)
  for (const type of ['dragover', 'drop']) {
    const r = await at(type)
    if (r !== 'ok') throw new Error(r)
    await sleep(150)
  }
  await page.eval((n) => document.querySelector(`.vl-page[data-active] .dk-tab[data-name="${n}"]`)
    ?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__e2eDT })), name)
}

/** Drags pane `name`'s title row onto the tab strip (it leaves the grid). */
async function dragHeadToStrip(page, name) {
  await page.eval((n) => {
    window.__e2eDT = new DataTransfer()
    document.querySelector(`.vl-page[data-active] .dk-pane[data-name="${n}"] .dk-head`)
      .dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDT }))
  }, name)
  await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-drop').length > 0, 'the drag of a title row never started')
  await page.eval((n) => {
    const bar = document.querySelector('.vl-page[data-active] .dk-bar')
    const r = bar.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDT, ...at }))
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__e2eDT, ...at }))
    const head = document.querySelector(`.vl-page[data-active] .dk-pane[data-name="${n}"] .dk-head`)
    head?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__e2eDT }))
  }, name)
}

/** Opens tab `name`'s menu with a right-click and presses `item`. */
async function menuItem(page, name, item) {
  const at = await page.locate(`.vl-page[data-active] .dk-tab[data-name="${name}"] .dk-tab-main`)
  await page.mouse(at.x, at.y, { button: 'right' })
  await until(page, () => !!document.querySelector('.dk-menu'), 'a right-click did not open the tab menu')
  await tap(page, { sel: '.dk-menu .dk-mi', text: item })
}

/** The devices the layout runs on, and whether each builds a grid (a mouse) or shows one session with its own keys. */
const LAYOUTS = { phone: false, ipad: false, ipadland: false, desktop: true, desk1440: true }

function layoutTests() {
  return Object.entries(LAYOUTS).map(([device, grid]) => ({
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
      const d = await page.eval(desk)
      t.check(JSON.stringify(tabNames(d)) === JSON.stringify(ORDER), `the tabs read ${JSON.stringify(tabNames(d))}, want by area then project ${JSON.stringify(ORDER)}`)
      const splits = d.tabs.filter((x) => x.split).map((x) => x.name)
      t.check(splits.join() === [P.p1, P.s1, P.sh].join(), `the area lines sit before ${JSON.stringify(splits)}, want personal, server and the unknown`)
      const marks = Object.fromEntries(d.tabs.map((x) => [x.name, x.mark]))
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
      const titles = Object.fromEntries(d.tabs.map((x) => [x.name, x.title]))
      t.check(titles[P.w1] === 'Fix the login page', `a pane's own title should name its tab, got "${titles[P.w1]}"`)
      t.check(titles[P.p1] === 'Weekend trip plan', `a pane with no title should take the board's, got "${titles[P.p1]}"`)
      t.check(titles[P.sh] === 'Gamma sh', `a shell should keep its label, got "${titles[P.sh]}"`)
      const tip = tabOf(d, P.w2)?.tip ?? ''
      t.check(tip.includes('Mailbox move plan') && /asking for \d+m/.test(tip) && tip.includes(ASK), `the asking tab's tooltip reads ${JSON.stringify(tip)}: want its title, "asking for Nm" and the question`)
      t.check(/Work · working for/.test(tabOf(d, P.w1)?.tip ?? '') && (tabOf(d, P.w1)?.tip ?? '').includes('Acme Corporation'), `the work tab's tooltip reads ${JSON.stringify(tabOf(d, P.w1)?.tip)}: want its area, how long it has worked and its folder`)
      t.check(new RegExp(`Personal · ${PROJECT}`).test(tabOf(d, P.pj)?.tip ?? ''), `the project tab's tooltip reads ${JSON.stringify(tabOf(d, P.pj)?.tip)}`)
      t.check(/ended/.test(tabOf(d, P.d1)?.tip ?? ''), `the ended tab's tooltip reads ${JSON.stringify(tabOf(d, P.d1)?.tip)}`)
      if (!grid) {
        const short = d.tabs.filter((x) => x.h < 43.5)
        t.check(!short.length, `tabs under 44 px on a touch screen: ${short.map((x) => `${x.name} ${x.h}`).join(', ')}`)
      }
      t.check(await page.eval(() => {
        const a = document.querySelector('.vl-page[data-active] .dk-add')?.getBoundingClientRect()
        const bar = document.querySelector('.vl-page[data-active] .dk-bar')?.getBoundingClientRect()
        return !!a && !!bar && a.width > 0 && a.right <= bar.right + 1
      }), '"+" is scrolled out of the strip')
      t.check(await page.eval(() => !!document.querySelector('.vl-page[data-active] .dk-list-btn')), 'no "Sessions" button at the start of the strip')
      if (device === 'phone') {
        const thin = (await page.eval(() => [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((b) => b.getBoundingClientRect().width))).filter((w) => w < 40)
        t.check(!thin.length, `phone tab icons narrower than 40 px: ${thin.join(', ')}`)
      }
      // one session fills the Desk: the first tab, focused
      t.check(viewNames(d).join() === P.w1 && focusOf(d) === P.w1, `the Desk opened on ${JSON.stringify(viewNames(d))} (focus ${focusOf(d)}), want the first tab alone`)
      const f = d.frames[0]
      t.check(f?.src === `/m/w/term/${P.w1}` && f.h > 300, `the terminal is ${JSON.stringify(f)}`)
      if (grid) {
        t.check(d.heads.length === 1 && d.heads[0].title === 'Fix the login page' && d.heads[0].folder === 'Acme Corporation',
          `the pane's title row reads ${JSON.stringify(d.heads)}, want its title and its folder`)
        t.check(!!f && d.heads[0] && f.y >= d.heads[0].y + 20, 'the terminal is not under the title row')
      } else t.check(!d.heads.length, `a touch screen draws the Desk's title rows: ${JSON.stringify(d.heads)}`)
      const r = await page.eval(layoutReport)
      t.check(r.docSW <= r.W + 1, `the page is wider than the screen (${r.docSW} > ${r.W})${r.wide.length ? `: ${r.wide.join(', ')}` : ''}`)
      t.check(r.areaSW <= r.areaCW + 1, `the Desk is wider than its screen (${r.areaSW} > ${r.areaCW})`)
      const foot = await page.eval(() => ({ lamp: !!document.querySelector('.vl-lamp') && getComputedStyle(document.querySelector('.vl-foot')).display !== 'none', H: innerHeight }))
      t.check(!foot.lamp, 'the lights button shows over the Desk')
      t.check(!!f && f.b <= foot.H + 1 && f.b >= foot.H - 60, `the terminal does not reach the bottom of the screen: ${f?.b} of ${foot.H}`)
      const navTabs = await page.eval(() => [...document.querySelectorAll('.vl-nav .vl-tab-prim')].map((b) => ({ label: b.querySelector('.vl-tab-label')?.textContent?.trim(), r: b.getBoundingClientRect().right })))
      const labels = navTabs.map((x) => x.label)
      t.check(labels.indexOf('Desk') === 2 && labels[1] === 'Raven', `the Desk tab is not third, after Dashboard and Raven: ${labels.join(', ')}`)
      t.check(navTabs.every((x) => x.r <= r.W + 1), `a tab in the nav runs off the screen: ${JSON.stringify(navTabs)}`)
      // the terminal is the pop-out page, framed: no status strip; on a desktop the bare terminal alone
      await t.step('the terminal renders in its pane', async () => {
        await page.waitFor(() => {
          const on = [...document.querySelectorAll('.vl-page[data-active] .dk-frame[data-on]')]
          try { return on.length > 0 && on.every((x) => !!x.contentDocument?.querySelector('[data-term-root][data-standalone]')) } catch { return false }
        }, { timeout: 90_000, message: 'the terminal page never rendered in its pane' })
        await sleep(1500)
        const inside = await page.eval(() => {
          const doc = document.querySelector('.vl-page[data-active] .dk-frame[data-on]')?.contentDocument
          const root = doc?.querySelector('[data-term-root]')
          return {
            strip: !!doc?.querySelector('.vl-strip'),
            bare: root?.hasAttribute('data-bare') ?? null,
            bar: !!doc?.querySelector('.vsk-head'),
            comp: !!doc?.querySelector('.vsk-comp'),
            keys: !!doc?.querySelector('.vsk-keys'),
            side: !!doc?.querySelector('.vsk-side'),
            chat: root?.getAttribute('data-view') ?? null,
            term: !!doc?.querySelector('.vsk-term .xterm'),
          }
        })
        t.check(!inside.strip, 'a framed terminal draws its own status strip')
        t.check(inside.term, 'no terminal in the pane')
        if (grid) {
          t.check(inside.bare && !inside.bar && !inside.comp && !inside.keys && !inside.side && inside.chat === 'term',
            `a desktop pane is not the bare terminal: ${JSON.stringify(inside)}`)
        } else {
          t.check(!inside.bare && inside.comp && inside.keys, `a touch screen lost the terminal page's own controls: ${JSON.stringify(inside)}`)
        }
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
      let d = await page.eval(desk)
      t.check(viewNames(d).join() === P.w1, `the grid shows ${JSON.stringify(viewNames(d))}`)
      t.check(!d.tabs.some((x) => x.lit), 'a tab is lit before anything finished')
      await t.step('working to idle and working to asking on hidden tabs light them', async () => {
        st.set(P.s1, 'idle')
        st.set(P.w3, 'asking', 'Which printer is the default?')
        await until(page, (a, b) => !!document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`) && !!document.querySelector(`.dk-tab[data-name="${b}"][data-lit]`), 'the two finished tabs never lit (the Desk polls every 2 s)', [P.s1, P.w3], 9000)
        d = await page.eval(desk)
        t.check(tabOf(d, P.s1)?.mark === 'idle' && tabOf(d, P.w3)?.mark === 'asking', `their marks read ${tabOf(d, P.s1)?.mark} and ${tabOf(d, P.w3)?.mark}`)
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
        d = await page.eval(desk)
        t.check(tabOf(d, P.w3)?.mark === 'asking', 'the asking tab lost its bubble once opened')
        t.check(viewNames(d).join() === P.w3, `a tab opened from the strip did not take the one pane: ${JSON.stringify(viewNames(d))}`)
      })
      await t.step('the session in view finishing does not light', async () => {
        st.set(P.w1, 'working')
        await sleep(2600)
        await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-main`)
        await sleep(400)
        st.set(P.w1, 'idle')
        await until(page, (a) => document.querySelector(`.dk-tab[data-name="${a}"]`)?.getAttribute('data-state') === 'idle', 'the tab in view never read idle', [P.w1], 8000)
        await sleep(300)
        d = await page.eval(desk)
        t.check(!tabOf(d, P.w1)?.lit, 'the tab in view lit when it finished')
      })
      await t.step('a whole run between two reads lights a hidden tab', async () => {
        d = await page.eval(desk)
        t.check(!viewNames(d).includes(P.p1), 'the personal tab is in view, the step needs it hidden')
        st.ran(P.p1)
        await until(page, (a) => !!document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'a run that started and finished between two reads never lit', [P.p1], 9000)
        await tap(page, `.dk-tab[data-name="${P.p1}"] .dk-tab-main`)
        await until(page, (a) => !document.querySelector(`.dk-tab[data-name="${a}"][data-lit]`), 'the opened tab is still lit', [P.p1])
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
      })
      await t.step('an API restart (every stateSince moves, the terminals attach again) lights nothing', async () => {
        await sleep(2600)
        d = await page.eval(desk)
        t.check(!d.tabs.some((x) => x.lit), `a tab is lit before the restart: ${JSON.stringify(d.tabs.filter((x) => x.lit).map((x) => x.name))}`)
        t.check(!viewNames(d).includes(P.p1), 'the personal tab is in view, the step needs it hidden')
        st.restart(P.p1)
        await sleep(5000)
        d = await page.eval(desk)
        const lit = d.tabs.filter((x) => x.lit).map((x) => x.name)
        t.check(!lit.length, `an API restart lit ${JSON.stringify(lit)}`)
        t.check(!(await badge(page)), 'the badge shows after an API restart')
      })
      await t.step('one empty read keeps every tab and its mounted terminal', async () => {
        const before = await page.eval(() => {
          const fs = [...document.querySelectorAll('.vl-page[data-active] .dk-frame')]
          fs.forEach((f) => { f.dataset.e2eKeep = '1' })
          return { frames: fs.length, tabs: document.querySelectorAll('.vl-page[data-active] .dk-tab').length }
        })
        t.check(before.frames >= 2, `${before.frames} terminal(s) mounted, the step needs the ones opened above kept`)
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
      await t.step('an empty list from the API keeps the tabs and the grid', async () => {
        // a middle click takes it off the Desk (desk:close drives the real mouse)
        await page.eval((n) => document.querySelector(`.dk-tab[data-name="${n}"]`)?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })), P.d1)
        await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the ended tab did not leave the Desk', [P.d1])
        const before = JSON.stringify(tabNames(await page.eval(desk)))
        const saved = await page.eval(() => localStorage.getItem('v2.desk.grid'))
        st.empty = true
        await sleep(5000)
        const during = await page.eval(() => localStorage.getItem('v2.desk.grid'))
        st.empty = false
        await deskUp(page, N - 1)
        const after = JSON.stringify(tabNames(await page.eval(desk)))
        t.check(during === saved, `an empty list rewrote the saved grid: ${during}`)
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
      const focused = async () => focusOf(await page.eval(desk))
      const framed = (name) => page.waitFor((n) => {
        const f = document.querySelector(`.dk-frame[data-name="${n}"]`)
        try { return !!f?.contentDocument?.querySelector('[data-term-root] .xterm-helper-textarea') } catch { return false }
      }, { args: [name], timeout: 90_000, message: `the terminal page in ${name}'s pane never rendered` })
      const isFocused = (n) => until(page, (x) => !!document.querySelector(`.dk-tab[data-name="${x}"][data-focus]`), `${n} did not take the focused pane`, [n])
      await t.step('Ctrl+Tab and Ctrl+Shift+Tab from the Desk', async () => {
        await page.key('Tab', { ctrl: true })
        await isFocused(P.w3)
      })
      await t.step('Ctrl+Tab from inside a terminal (handed up by the framed page)', async () => {
        await framed(P.w3)
        await sleep(400)
        const inFrame = await page.eval((n) => document.activeElement === document.querySelector(`.dk-frame[data-name="${n}"]`), P.w3)
        t.check(inFrame, 'the opened tab did not take the keyboard (the focus is not in its terminal)')
        await page.key('Tab', { ctrl: true })
        await isFocused(P.w2)
        await framed(P.w2)
        // a pane mounted by that key loaded after it was focused: on a loaded odin, put the focus back in its terminal
        await page.eval((n) => document.querySelector(`.dk-frame[data-name="${n}"]`)?.contentWindow?.focus(), P.w2)
        await sleep(300)
        await page.key('Tab', { ctrl: true, shift: true })
        await isFocused(P.w3)
      })
      await t.step('inside a terminal Ctrl+V reaches the paste, Ctrl+C with nothing selected stays ^C, a screenshot uploads', async () => {
        const keys = await page.eval((n) => {
          const w = document.querySelector(`.dk-frame[data-name="${n}"]`)?.contentWindow
          const ta = w?.document.querySelector('.xterm-helper-textarea')
          if (!w || !ta) return null
          ta.focus()
          const send = (o) => {
            const e = new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...o })
            ta.dispatchEvent(e)
            return e.defaultPrevented
          }
          return {
            ctrlV: send({ key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true }),
            ctrlShiftV: send({ key: 'V', code: 'KeyV', keyCode: 86, ctrlKey: true, shiftKey: true }),
            shiftIns: send({ key: 'Insert', code: 'Insert', keyCode: 45, shiftKey: true }),
            ctrlC: send({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true }),
          }
        }, P.w3)
        t.check(keys && !keys.ctrlV && !keys.ctrlShiftV && !keys.shiftIns, `a paste key was swallowed by the terminal (true = held back): ${JSON.stringify(keys)}`)
        t.check(keys?.ctrlC === true, `Ctrl+C with nothing selected did not go to the session as ^C: ${JSON.stringify(keys)}`)
        const u0 = st.uploads
        await page.eval((n) => {
          const w = document.querySelector(`.dk-frame[data-name="${n}"]`)?.contentWindow
          const ta = w?.document.querySelector('.xterm-helper-textarea')
          const dt = new w.DataTransfer()
          dt.items.add(new w.File([new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])], 'image.png', { type: 'image/png' }))
          ta.dispatchEvent(new w.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
        }, P.w3)
        for (let i = 0; i < 20 && st.uploads === u0; i++) await sleep(250)
        t.check(st.uploads > u0, 'a pasted screenshot was not sent to thor')
      })
      // the rest from the Desk itself: a pane whose terminal is still loading would take the key (on a loaded odin
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
        await isFocused(P.w1)
        await host()
        await page.key('Tab', { ctrl: true, shift: true })
        await isFocused(P.sh)
      })
      await t.step('Alt+N opens tab N', async () => {
        await host()
        await page.key('1', { alt: true })
        await isFocused(P.w1)
        await host()
        await page.key('3', { alt: true })
        await isFocused(P.w2)
        await host()
        await page.key('9', { alt: true })
        await sleep(400)
        t.check((await focused()) === P.w2, 'Alt+9 with eight tabs changed the tab')
      })
      await t.step('Alt+Right and Alt+Left move between the panes of the grid', async () => {
        await menuItem(page, P.s1, 'Open beside')
        await inView(page, [P.w2, P.s1])
        await host()
        await page.key('ArrowLeft', { alt: true })
        await isFocused(P.w2)
        await host()
        await page.key('ArrowRight', { alt: true })
        await isFocused(P.s1)
        t.check(viewNames(await page.eval(desk)).join() === [P.w2, P.s1].join(), 'moving between panes changed the grid')
      })
      await t.step('Ctrl+Alt+D opens the session waiting longest, then the next', async () => {
        // the personal tab finishes while hidden; the asking one has waited longer
        st.set(P.p1, 'working')
        await sleep(2600)
        st.set(P.p1, 'idle')
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-lit]`), 'the hidden personal tab never lit', [P.p1], 9000)
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
        await host()
        await page.key('d', { ctrl: true, alt: true })
        await isFocused(P.w2)
        await host()
        await page.key('d', { ctrl: true, alt: true })
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`) && !document.querySelector(`.dk-tab[data-name="${n}"][data-lit]`), 'Ctrl+Alt+D did not go on to the finished session', [P.p1])
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
          }
        }, P.w1)
        t.check(typed && !typed.altShift1, `the framed page held back a plain key: ${JSON.stringify(typed)}`)
        await sleep(300)
        t.check((await focused()) === P.w1, 'a plain key changed the tab')
      })
      t.check(!st.kills.length && !st.opens.length, 'a key wrote something')
    },
  }]
}

/**
 * A real mouse drag, the browser deciding whether it starts: the mouse goes down on the source and
 * moves; Chrome hands the drag it started to the test (Input.setInterceptDrags), which carries it to
 * `to` with the browser's own drag events. null when no drag started.
 */
async function realDrag(page, from, to) {
  await page.send('Input.setInterceptDrags', { enabled: true })
  let data = null
  const off = page.on((m) => { if (m.method === 'Input.dragIntercepted') data = m.params.data })
  try {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 10 && !data; i++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 4 * i, y: from.y + 4 * i, button: 'left', buttons: 1 })
      await sleep(80)
    }
    if (!data) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', clickCount: 1 })
      return null
    }
    // the drop targets go up over the terminals once the drag is on
    await sleep(300)
    for (const type of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
    await sleep(200)
    await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data })
    await sleep(200)
    await page.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    return data
  } finally {
    off()
    await page.send('Input.setInterceptDrags', { enabled: false }).catch(() => {})
  }
}

function realDragTests() {
  return [{
    name: 'desk:realdrag:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 120_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      const box = (sel) => page.eval((s) => {
        const r = document.querySelector(s)?.getBoundingClientRect()
        return r ? { l: r.left, t: r.top, w: r.width, h: r.height } : null
      }, sel)
      await t.step('a mouse drags a tab by its title onto the pane\'s right edge: the Desk splits', async () => {
        const tab = await box(`.vl-page[data-active] .dk-tab[data-name="${P.p1}"] .dk-tab-t`)
        const pane = await box(`.vl-page[data-active] .dk-pane[data-name="${P.w1}"]`)
        const data = await realDrag(page, { x: tab.l + tab.w / 2, y: tab.t + tab.h / 2 }, { x: pane.l + pane.w * 0.93, y: pane.t + pane.h / 2 })
        t.check(!!data, 'the browser started no drag from the tab')
        await inView(page, [P.w1, P.p1])
      })
      await t.step('a pane\'s title row dragged onto the other pane\'s middle swaps them', async () => {
        const head = await box(`.vl-page[data-active] .dk-pane[data-name="${P.p1}"] .dk-head-t`)
        const pane = await box(`.vl-page[data-active] .dk-pane[data-name="${P.w1}"]`)
        const data = await realDrag(page, { x: head.l + head.w / 2, y: head.t + head.h / 2 }, { x: pane.l + pane.w / 2, y: pane.t + pane.h / 2 })
        t.check(!!data, 'the browser started no drag from the title row')
        await inView(page, [P.p1, P.w1])
      })
    },
  }]
}

function gridTests() {
  return [{
    name: 'desk:grid:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 200_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      const st = deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      const stageW = await page.eval(() => document.querySelector('.vl-page[data-active] .dk-stage').getBoundingClientRect().width)
      await t.step('a tab dropped on a pane\'s right edge splits the Desk', async () => {
        await dragOnto(page, P.p1, P.w1, 0.92, 0.5)
        await inView(page, [P.w1, P.p1])
        const d = await page.eval(desk)
        const [a, b] = d.frames
        t.check(Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 2 && a.w < stageW * 0.55 && a.w > stageW * 0.45, `the split is not side by side, half each: ${JSON.stringify(d.frames)}`)
        t.check(focusOf(d) === P.p1 && d.heads.length === 2, `after the split the focus is ${focusOf(d)} with ${d.heads.length} title rows`)
        t.check(d.heads.find((h) => h.focus)?.title === 'Weekend trip plan', 'the dropped pane is not the lit one')
        await t.shot(page, 'split')
      })
      await t.step('one dropped on a pane\'s bottom edge makes two over one', async () => {
        await dragOnto(page, P.s1, P.p1, 0.5, 0.95)
        await inView(page, [P.w1, P.p1, P.s1])
        const d = await page.eval(desk)
        const [a, b, c] = d.frames
        t.check(Math.abs(a.y - b.y) <= 1 && c.y > a.b && c.w > stageW * 0.95, `three panes are not two over one full row: ${JSON.stringify(d.frames)}`)
      })
      await t.step('a tab dropped on a pane\'s middle takes its place', async () => {
        await dragOnto(page, P.w3, P.w1, 0.5, 0.5)
        await inView(page, [P.w3, P.p1, P.s1])
        const d = await page.eval(desk)
        t.check(tabNames(d).includes(P.w1) && !tabOf(d, P.w1)?.on, 'the replaced session is not a tab out of the grid')
      })
      await t.step('a pane\'s title dragged to the strip leaves the grid, the tab stays', async () => {
        await dragHeadToStrip(page, P.s1)
        await inView(page, [P.w3, P.p1])
        t.check(tabNames(await page.eval(desk)).includes(P.s1), 'the session left the strip too')
      })
      await t.step('the menu opens a tab beside the focused pane; four make 2x2, five make 3x3', async () => {
        await tap(page, `.dk-tab[data-name="${P.p1}"] .dk-tab-main`)
        await menuItem(page, P.w2, 'Open beside')
        await inView(page, [P.w3, P.p1, P.w2])
        await menuItem(page, P.pj, 'Open beside')
        let d = await page.eval(desk)
        t.check(d.frames.length === 4 && new Set(d.frames.map((f) => f.w)).size <= 2 && d.frames[0].w < stageW * 0.55, `four panes are not 2x2: ${JSON.stringify(d.frames)}`)
        await menuItem(page, P.s1, 'Open beside')
        await until(page, () => document.querySelectorAll('.vl-page[data-active] .dk-frame[data-on]').length === 5, 'the fifth pane did not open')
        d = await page.eval(desk)
        const top = d.frames.filter((f) => Math.abs(f.y - d.frames[0].y) <= 1)
        t.check(top.length === 3 && top.every((f) => f.w < stageW * 0.36), `five panes do not start a 3x3 grid: ${JSON.stringify(d.frames)}`)
        await t.shot(page, 'five')
      })
      await t.step('the grid is kept across a reload', async () => {
        const before = viewNames(await page.eval(desk))
        await sleep(300)
        await page.goto('/m/desk')
        await deskUp(page)
        await inView(page, before)
      })
      t.check(!st.kills.length && !st.opens.length, 'a layout change wrote something')
    },
  }]
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
        await t.step('the x takes the tab off the Desk, the next tab fills its pane, the session keeps running', async () => {
          await tap(page, `.dk-tab[data-name="${P.w1}"] .dk-tab-x`)
          await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the closed tab is still on the Desk', [P.w1])
          await inView(page, [P.w3])
          t.check(!st.kills.length, `closing a tab stopped its session: ${st.kills.join(', ')}`)
        })
        await t.step('a middle click closes a tab', async () => {
          const at = await page.locate(`.dk-tab[data-name="${P.sh}"] .dk-tab-main`)
          await page.mouse(at.x, at.y, { button: 'middle' })
          await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'a middle click did not close the tab', [P.sh])
        })
        await t.step('"+" puts a running session back', async () => {
          await tap(page, '.vl-page[data-active] .dk-add')
          await until(page, () => !!document.querySelector('.vl-page[data-active] .dk-pick'), '"+" did not open the new session sheet')
          const rows = await page.eval(() => [...document.querySelectorAll('.dk-pick .dk-row .dk-row-t')].map((e) => e.textContent))
          t.check(rows.join('|') === 'Fix the login page|Gamma sh', `Off the Desk lists ${JSON.stringify(rows)}, want the two closed tabs`)
          const chips = await page.eval(() => [...document.querySelectorAll('.dk-pick .dk-chip')].map((e) => e.textContent.trim()))
          t.check(chips.join('|') === 'Alpha|Beta|Gamma', `the launch targets offered are ${JSON.stringify(chips)}`)
          await t.shot(page, 'plus')
          await tap(page, { sel: '.dk-pick .dk-row', text: /Fix the login page/ })
          await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`), 'the session did not come back in the focused pane', [P.w1])
          await inView(page, [P.w1])
          t.check(!(await page.eval(() => !!document.querySelector('.dk-pick'))), 'the sheet stayed open')
        })
        await t.step('Stop in the tab menu takes two presses and ends the session', async () => {
          await menuItem(page, P.s1, 'Stop session')
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
        await tap(page, '.vl-page[data-active] .dk-add')
        await until(page, () => !!document.querySelector('.vl-page[data-active] .dk-pick'), '"+" did not open the new session sheet')
        // the chips carry the targets' short names (lib/quickSessions shortName), as AI > Sessions does
        await tap(page, { sel: '.dk-pick .dk-chip', text: /^\s*Beta\s*$/ })
        await until(page, () => !!document.querySelector('.dk-tab[data-name="vk-e2e0000a01"][data-focus]'), 'the new session did not take the focused pane')
        await inView(page, ['vk-e2e0000a01'])
        const body = st.opens[0]
        t.check(body?.mode === 'new' && body.target === 'beta' && body.label === 'Beta' && body.cols >= 40 && body.rows >= 12, `the start sent ${JSON.stringify(body)}`)
        t.check(st.opens.length === 1 && !st.kills.length, `writes: ${st.opens.length} start(s), ${st.kills.length} kill(s)`)
      },
    },
  ]
}

function listTests() {
  return [{
    name: 'desk:list:desktop',
    group: 'desk',
    device: 'desktop',
    timeout: 120_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      // one off the Desk: the list still names it
      await page.eval((n) => document.querySelector(`.dk-tab[data-name="${n}"]`)?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })), P.d1)
      await until(page, (n) => !document.querySelector(`.dk-tab[data-name="${n}"]`), 'the ended tab did not leave the Desk', [P.d1])
      await tap(page, '.vl-page[data-active] .dk-list-btn')
      await until(page, () => !!document.querySelector('.vl-page[data-active] .dk-list'), '"Sessions" did not open the list')
      const shape = await page.eval(() => [...document.querySelectorAll('.dk-list .dk-lg')].map((g) => ({
        area: g.querySelector('.dk-k')?.textContent ?? '',
        parts: [...g.querySelectorAll('.dk-lp')].map((p) => ({
          project: p.querySelector('.dk-tsec-k')?.textContent ?? '',
          rows: [...p.querySelectorAll('.dk-row')].map((r) => `${r.querySelector('.dk-row-t')?.textContent}|${r.querySelector('.dk-row-s')?.textContent}`),
        })),
      })))
      t.check(shape.map((g) => g.area).join() === 'Work,Personal,Server,Other', `the list's areas read ${JSON.stringify(shape.map((g) => g.area))}`)
      const personal = shape.find((g) => g.area === 'Personal')
      t.check(personal?.parts.length === 2 && personal.parts[0].project === '' && personal.parts[1].project === PROJECT && personal.parts[1].rows[0]?.startsWith('Seed order'),
        `Personal reads ${JSON.stringify(personal)}: want its sessions, then the project's under its name`)
      t.check(personal?.parts[0].rows.some((r) => r === 'Old notes|off the desk'), `the session off the Desk is not marked so: ${JSON.stringify(personal?.parts[0].rows)}`)
      t.check(shape[0]?.parts[0].rows[0] === 'Fix the login page|here', `the session in view is not marked: ${JSON.stringify(shape[0]?.parts[0].rows)}`)
      await t.shot(page, 'list')
      await tap(page, { sel: '.dk-list .dk-row', text: /Backup check/ })
      await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`), 'a pick from the list did not open it', [P.s1])
      t.check(!(await page.eval(() => !!document.querySelector('.dk-list'))), 'the list stayed open')
      await tap(page, '.vl-page[data-active] .dk-list-btn')
      await tap(page, { sel: '.dk-list .dk-row', text: /Old notes/ })
      await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`), 'a session off the Desk did not come back from the list', [P.d1])
    },
  }]
}

function touchTests() {
  return [{
    name: 'desk:menu:ipadland',
    group: 'desk',
    device: 'ipadland',
    timeout: 150_000,
    async run(t) {
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e/)
      const page = await t.page({ stubFrames: true })
      deskBackend(page)
      await page.goto('/m/desk')
      await deskUp(page)
      await t.step('a tap opens a tab; a tap on the focused tab opens its menu', async () => {
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`), 'a tap did not open the tab', [P.s1])
        await inView(page, [P.s1])
        await sleep(300)
        t.check(!(await page.eval(() => !!document.querySelector('.dk-menu'))), 'the first tap opened the menu instead of the tab')
        await tap(page, `.dk-tab[data-name="${P.s1}"] .dk-tab-main`)
        await until(page, () => !!document.querySelector('.dk-menu'), 'a tap on the focused tab did not open its menu')
        const items = await page.eval(() => [...document.querySelectorAll('.dk-menu .dk-mi')].map((b) => ({ t: b.textContent.trim(), h: b.getBoundingClientRect().height })))
        t.check(items.map((x) => x.t).join('|') === 'Close tab|Stop session', `the menu offers ${items.map((x) => x.t).join(', ')}`)
        t.check(items.every((x) => x.h >= 44), `menu rows under 44 px: ${JSON.stringify(items)}`)
        await t.shot(page, 'menu')
      })
      await t.step('a press outside closes the menu', async () => {
        const box = await page.eval(() => {
          const r = document.querySelector('.vl-page[data-active] .dk-stage').getBoundingClientRect()
          return { x: r.left + r.width * 0.7, y: r.top + r.height * 0.6 }
        })
        await page.mouse(box.x, box.y)
        await until(page, () => !document.querySelector('.dk-menu'), 'a press outside did not close the menu')
      })
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
      let d = await page.eval(desk)
      t.check(d.sw > d.cw + 20, `the strip does not scroll sideways (${d.sw} of ${d.cw})`)
      t.check(!(await page.eval(() => !!document.querySelector('.dk-list-btn span'))), 'the phone spells out "Sessions" in the strip')
      await t.step('a swipe scrolls the strip, not the page', async () => {
        const r = await page.eval(() => {
          const b = document.querySelector('.vl-page[data-active] .dk-tabs').getBoundingClientRect()
          return { y: b.top + b.height / 2, l: b.left, r: b.right }
        })
        await page.swipe(r.r - 30, r.y, r.l + 40, r.y)
        await sleep(500)
        d = await page.eval(desk)
        t.check(d.left > 20, `a swipe left the strip at scrollLeft ${d.left}`)
        t.check((await page.path()) === '/m/desk', `the swipe moved the page to ${await page.path()}`)
      })
      await t.step('the focused tab is kept in view', async () => {
        await tap(page, `.dk-tab[data-name="${P.sh}"] .dk-tab-main`)
        await until(page, (n) => !!document.querySelector(`.dk-tab[data-name="${n}"][data-focus]`), 'the last tab did not open', [P.sh])
        await page.eval(() => { document.querySelector('.vl-page[data-active] .dk-tabs').scrollLeft = 0 })
        await page.goto('/m/desk')
        await deskUp(page)
        await sleep(400)
        d = await page.eval(desk)
        const tab = d.tabs.find((x) => x.name === P.sh)
        t.check(tab?.focus && tab.inView, `after a reload the focused last tab is not in view (scrollLeft ${d.left}, ${JSON.stringify(tab)})`)
        t.check(viewNames(d).join() === P.sh, `the phone shows ${JSON.stringify(viewNames(d))}, want the one tab`)
        await t.shot(page)
      })
      const r = await page.eval(layoutReport)
      t.check(r.docSW <= r.W + 1, `the page is wider than the phone (${r.docSW} > ${r.W})`)
    },
  }]
}

export function deskTests() {
  return [...layoutTests(), ...doneTests(), ...keyTests(), ...gridTests(), ...realDragTests(), ...closeTests(), ...listTests(), ...touchTests(), ...phoneTests()]
}
