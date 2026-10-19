// WINDOWS: projects and sessions in windows of their own (src/v2/kit/windows.ts
// openDetached), and the standalone pages those windows show.
//
//   browser   with a mouse, a project opens with window.open on
//             /m/w/project/<id> in a window named after it (a second press
//             focuses that window, never a second copy); "Open here" shows it in
//             the page; a session's New window and an open pane's pop-out open
//             /m/w/term/<name>. window.open is captured in the page; nothing opens.
//   phone     a touch screen opens the project in place, no window
//   tauri     in the desktop app a pop-out is an app window labeled by its
//             target (project-<id>, session-<name>), frameless and hidden until
//             it loads; asking again focuses it (the Tauri stand-in, lib/tauri.mjs)
//   pages     /m/w/project/<id> and /m/w/term/<name> render with no tab bar,
//             the strip as their title bar (window buttons in the app), and the
//             window titled after the project or session

import { sleep } from '../lib/cdp.mjs'
import { BOARD_IDS, PROJ_ID, fullBoardState, panesState, projList, projState, quietThor, termOpened } from '../lib/fixtures.mjs'
import { tauriCallsFull, tauriStub } from '../lib/tauri.mjs'

const ok = (body) => ({ status: 200, body })
const TERM_NAME = 'vk-e2e0000a01'

/** window.open recorded instead of opening anything: each call, and each focus of a window it handed out. */
const CAPTURE_OPEN = `(() => {
  const opens = window.__opens = []
  window.open = (url, name, features) => {
    const w = { closed: false, focus() { opens.push({ focus: name }) }, close() { this.closed = true } }
    opens.push({ url: String(url), name: String(name ?? ''), features: String(features ?? '') })
    return w
  }
})()`

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

function backend(page, { panes = [] } = {}) {
  quietThor(page)
  const board = fullBoardState()
  const proj = projState()
  page.mock('/api/session-board', () => ok(board))
  page.mock('/api/hosts/thor/sessions', () => ok(board))
  page.mock('/api/terminal/sessions', () => ok(panes))
  page.mock('/api/proj', () => ok(projList(proj)))
  page.mock(`/api/proj/${PROJ_ID}`, () => ok(proj.doc))
  page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
  return { board, proj }
}

const opens = (page) => page.eval(() => window.__opens ?? [])

async function projectsUp(page) {
  await shellUp(page)
  await page.waitFor(() => [...document.querySelectorAll('.vl-page[data-active] .vc-prow')].some((e) => /E2E Project/.test(e.textContent || '')), { timeout: 12_000, message: 'the fixture project is not on AI > Projects' })
  await sleep(500)
}

async function boardUp(page) {
  await shellUp(page)
  await page.waitFor(`!!document.querySelector('.vc-item[data-row="${BOARD_IDS.closed}"]')`, { timeout: 12_000, message: 'the fixture board did not render' })
  await sleep(500)
}

function browserTests() {
  return [
    {
      name: 'win:browser:project',
      group: 'windows',
      device: 'desktop',
      timeout: 45_000,
      async run(t) {
        const page = await t.page({ scripts: [CAPTURE_OPEN] })
        backend(page)
        await page.goto('/m/ai/projects')
        await projectsUp(page)
        const title = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .vc-prow')].find((e) => /E2E Project/.test(e.textContent || ''))?.getAttribute('title'))
        t.check(title === 'Open E2E Project in its own window', `the project row's title reads "${title}"`)
        await page.tap({ sel: '.vl-page[data-active] .vc-prow', text: /E2E Project/ })
        await sleep(300)
        let o = await opens(page)
        const first = o.find((x) => x.url)
        t.check(first?.url === `/m/w/project/${PROJ_ID}` && first.name === `valkyrie-project-${PROJ_ID}`, `the project opened ${JSON.stringify(first)}, want /m/w/project/${PROJ_ID} in a window named after it`)
        t.check(/(^|,)popup(,|$)/.test(first?.features ?? '') && /width=1180/.test(first?.features ?? '') && /height=820/.test(first?.features ?? ''), `the window features are "${first?.features}"`)
        t.check((await page.path()) === '/m/ai/projects', `the page itself moved to ${await page.path()}`)
        await page.tap({ sel: '.vl-page[data-active] .vc-prow', text: /E2E Project/ })
        await sleep(300)
        o = await opens(page)
        t.check(o.filter((x) => x.url).length === 1 && o.some((x) => x.focus === `valkyrie-project-${PROJ_ID}`), `a second press opened another window instead of focusing it: ${JSON.stringify(o)}`)
        await t.step('Open here shows it in the page', async () => {
          await page.tap({ sel: '.vl-page[data-active] .vc-phere', text: /Open here/ })
          await page.waitFor(() => /E2E Project/.test(document.querySelector('.vl-page[data-active] .vc-detail .vc-detail-name')?.textContent ?? ''), { message: 'Open here did not show the project in the column' })
          t.check((await opens(page)).filter((x) => x.url).length === 1, 'Open here opened a window')
        })
        t.check(!page.writes.length, 'opening a project wrote something')
      },
    },
    {
      name: 'win:browser:session',
      group: 'windows',
      device: 'desktop',
      timeout: 45_000,
      async run(t) {
        const page = await t.page({ scripts: [CAPTURE_OPEN] })
        backend(page, { panes: panesState() })
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/terminal/sessions' ? { status: 201, body: termOpened(w.json) } : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const row = `.vc-item[data-row="${BOARD_IDS.closed}"]`
        await page.tap(`${row} .vc-front`)
        await page.waitFor(`!!document.querySelector('${row} .vc-strip')`, { message: 'the row did not open its strip' })
        await page.tap({ sel: `${row} .vc-strip .vc-sact`, text: /^\s*New window/ })
        const w = await waitW(page, 1)
        t.check(w.path === '/api/terminal/sessions' && w.json?.mode === 'resume' && w.json?.sessionId === BOARD_IDS.closed, `New window sent ${w.method} ${w.path} ${w.body}`)
        await page.waitFor(() => (window.__opens ?? []).some((x) => x.url), { message: 'New window did not open a window' })
        let o = (await opens(page)).filter((x) => x.url)
        t.check(o[0]?.url === `/m/w/term/${TERM_NAME}` && o[0].name === `valkyrie-session-${TERM_NAME}` && /width=1100/.test(o[0].features), `the session opened ${JSON.stringify(o[0])}`)
        t.check((await page.path()) === '/m/ai/sessions', `the page itself moved to ${await page.path()}`)
        await t.step('an open pane pops out by its own name', async () => {
          await page.tap('.vl-page[data-active] .vc-term-pop[aria-label="Open E2E shell in a new window"]')
          await sleep(300)
          o = (await opens(page)).filter((x) => x.url)
          t.check(o[1]?.url === '/m/w/term/vk-e2e00000b1' && o[1].name === 'valkyrie-session-vk-e2e00000b1', `the pane opened ${JSON.stringify(o[1])}`)
        })
        t.check(page.writes.length === 1, `${page.writes.length} write(s), want 1`)
      },
    },
    {
      name: 'win:phone:project',
      group: 'windows',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const page = await t.page({ scripts: [CAPTURE_OPEN] })
        backend(page)
        await page.goto('/m/ai/projects')
        await projectsUp(page)
        t.check(!(await page.eval(() => !!document.querySelector('.vl-page[data-active] .vc-phere'))), 'the phone offers "Open here" (there is no other window to open)')
        await page.tap({ sel: '.vl-page[data-active] .vc-prow', text: /E2E Project/ })
        await page.waitFor(() => document.querySelector('.vc-sheet-root[data-shown]') && /E2E Project/.test(document.querySelector('.vc-sheet-root[data-shown]')?.textContent ?? ''), { message: 'the project did not open in place on the phone' })
        t.check(!(await opens(page)).length, 'the phone called window.open')
      },
    },
  ]
}

function tauriTests() {
  return [
    {
      name: 'win:tauri:project-and-session',
      group: 'windows',
      device: 'desktop',
      timeout: 60_000,
      async run(t) {
        const page = await t.page({ scripts: [tauriStub()] })
        backend(page)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/terminal/sessions' ? { status: 201, body: termOpened(w.json) } : undefined))
        await page.goto('/m/ai/projects')
        await projectsUp(page)
        await page.tap({ sel: '.vl-page[data-active] .vc-prow', text: /E2E Project/ })
        await page.waitFor(() => (window.__tauriWindows?.created ?? []).length >= 1, { message: 'pressing a project made no app window' })
        let wins = await page.eval(() => window.__tauriWindows)
        const c = wins.created[0]
        t.check(c.label === `project-${PROJ_ID}` && c.url === `/m/w/project/${PROJ_ID}`, `the project window is ${JSON.stringify(c)}, want label project-${PROJ_ID} on /m/w/project/${PROJ_ID}`)
        t.check(c.decorations === false && c.visible === false && c.width === 1180 && c.height === 820, `the project window is not frameless, hidden until it loads, 1180x820: ${JSON.stringify(c)}`)
        t.check(!(await page.eval(() => (window.__opens ?? []).length)), 'the desktop app also used window.open')
        await sleep(400)
        const from = (await tauriCallsFull(page)).length
        await page.tap({ sel: '.vl-page[data-active] .vc-prow', text: /E2E Project/ })
        await sleep(600)
        wins = await page.eval(() => window.__tauriWindows)
        const again = (await tauriCallsFull(page, from)).filter((x) => x.cmd === 'plugin:window|set_focus')
        t.check(wins.created.length === 1, `a second press made ${wins.created.length} windows, want the one already open focused`)
        t.check(again.some((x) => x.args?.label === `project-${PROJ_ID}`), `a second press did not focus project-${PROJ_ID}: ${JSON.stringify(again)}`)

        await t.step('a session gets a window labeled by its pane', async () => {
          await page.tap({ sel: '.vl-nav .vl-tab-sub', text: 'Sessions' })
          await boardUp(page)
          const row = `.vc-item[data-row="${BOARD_IDS.closed}"]`
          await page.tap(`${row} .vc-front`)
          await page.waitFor(`!!document.querySelector('${row} .vc-strip')`, { message: 'the row did not open its strip' })
          await page.tap({ sel: `${row} .vc-strip .vc-sact`, text: /^\s*New window/ })
          await waitW(page, 1)
          await page.waitFor(() => (window.__tauriWindows?.created ?? []).length >= 2, { message: 'New window made no app window' })
          const s = (await page.eval(() => window.__tauriWindows)).created[1]
          t.check(s.label === `session-${TERM_NAME}` && s.url === `/m/w/term/${TERM_NAME}` && s.title === 'E2E closed session · Valkyrie', `the session window is ${JSON.stringify(s)}`)
        })
      },
    },
  ]
}

/** The standalone page's chrome: no tab bar, the strip on top, the app's window buttons. */
function standaloneReport() {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { t: r.top, b: r.bottom, w: r.width, h: r.height } }
  return {
    nav: !!document.querySelector('.vl-nav'),
    tabs: document.querySelectorAll('.vl-tab-prim').length,
    strip: box(document.querySelector('.vl-strip')),
    stripDrag: document.querySelector('.vl-strip')?.getAttribute('data-tauri-drag-region') ?? null,
    buttons: [...document.querySelectorAll('.vl-winctl button')].map((b) => b.getAttribute('aria-label')),
    gear: !!document.querySelector('.vl-strip-gear'),
    title: document.title,
    W: document.documentElement.clientWidth,
    SW: document.documentElement.scrollWidth,
    crash: /render failed|VALKYRIE CRASH/i.test(document.body.innerText || ''),
  }
}

function pageTests() {
  const out = []
  for (const device of ['desktop', 'desk1080']) {
    out.push({
      name: `win:page:project:${device}`,
      group: 'windows',
      device,
      timeout: 45_000,
      async run(t) {
        const page = await t.page({ scripts: [tauriStub({ label: `project-${PROJ_ID}` })] })
        backend(page)
        await page.goto(`/m/w/project/${PROJ_ID}`)
        await page.waitFor(() => /E2E Project/.test(document.querySelector('.vpw-name')?.textContent ?? ''), { timeout: 12_000, message: 'the project window never showed the project' })
        await sleep(800)
        const r = await page.eval(standaloneReport)
        t.check(!r.crash, 'the project window shows the crash screen')
        t.check(!r.nav && r.tabs === 0, 'the project window has the tab bar')
        t.check(r.strip && r.strip.t <= 1, 'the strip is not the top of the project window')
        t.check(r.stripDrag === 'deep', `the strip is not the window's drag region (${r.stripDrag})`)
        t.check(r.buttons.join(',') === 'Minimize,Maximize,Close', `the window buttons are ${r.buttons.join(',') || 'missing'}`)
        t.check(r.title === 'E2E Project · Valkyrie', `the window title is "${r.title}"`)
        t.check(r.SW <= r.W + 1, `the project window is wider than the window (${r.SW} > ${r.W})`)
        const set = (await tauriCallsFull(page)).filter((c) => c.cmd === 'plugin:window|set_title').map((c) => c.args?.value)
        t.check(set.includes('E2E Project · Valkyrie'), `the app window's title was set to ${JSON.stringify(set)}`)
        const txt = await page.eval(() => document.body.innerText)
        t.check(/First e2e task/.test(txt) && /Write the e2e test/.test(txt), 'the project window does not show its tasks and next action')
        await t.shot(page)
        t.check(!page.writes.length, 'the project window wrote something on its own')
      },
    })
  }
  out.push({
    name: 'win:page:project:bad-id',
    group: 'windows',
    device: 'desktop',
    timeout: 30_000,
    async run(t) {
      const page = await t.page()
      backend(page)
      await page.goto('/m/w/project/Not_An_Id')
      await page.waitFor(() => /Not a project/.test(document.querySelector('.vpw-name')?.textContent ?? ''), { timeout: 10_000, message: 'a bad project id did not say "Not a project"' })
      t.check(!page.api.some((a) => a.path.startsWith('/api/proj/Not')), 'a bad project id was read from the API')
    },
  })
  out.push({
    name: 'win:page:term',
    group: 'windows',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      // the pane is made up: the page tries its socket, which the fence refuses
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b2/)
      const page = await t.page({ scripts: [tauriStub({ label: 'session-vk-e2e00000b2' })] })
      backend(page, { panes: panesState() })
      await page.goto('/m/w/term/vk-e2e00000b2')
      await page.waitFor(() => document.querySelector('[data-term-root][data-standalone]'), { timeout: 12_000, message: 'the session window did not render the standalone terminal' })
      await sleep(1200)
      const r = await page.eval(standaloneReport)
      const bar = await page.eval(() => ({
        back: !!document.querySelector('.vsk-back'),
        drag: document.querySelector('.vsk-bar')?.getAttribute('data-tauri-drag-region') ?? null,
      }))
      t.check(!r.crash, 'the session window shows the crash screen')
      t.check(!r.nav && r.tabs === 0, 'the session window has the tab bar')
      t.check(!bar.back, 'the session window has a Back button (it shows one session for its whole life)')
      t.check(!r.gear, 'the session window has the Settings gear')
      t.check(r.buttons.join(',') === 'Minimize,Maximize,Close', `the window buttons are ${r.buttons.join(',') || 'missing'}`)
      t.check(bar.drag === 'deep', `the session bar is not a drag region (${bar.drag})`)
      t.check(/· Valkyrie$/.test(r.title) && /E2E pane/.test(r.title), `the window title is "${r.title}"`)
      t.check(r.SW <= r.W + 1, `the session window is wider than the window (${r.SW} > ${r.W})`)
      await t.shot(page)
    },
  })
  return out
}

export function windowTests() {
  return [...browserTests(), ...tauriTests(), ...pageTests()]
}
