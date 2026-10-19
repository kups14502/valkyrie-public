// WRITES: every real action in v2, both outcomes. The page runs against a
// fake backend for the state that matters (lights, Thor RGB, the tracker,
// launch targets, the session board, services, the request search); every
// write is caught in the browser by CDP Fetch interception and answered there,
// so nothing reaches odin. Each action checks the request (method, path, body
// shape), then (a) answers 200 and checks the success state, and (b) answers
// 500 or 403 and checks the rollback and the error toast.

import { sleep } from '../lib/cdp.mjs'
import {
  CLOSED_ID, LIVE_ID, ODIN_TARGETS, SEARCH, SESSION_HOSTS, TARGETS,
  applyLight, boardState, lightsState, rgbState, servicesState, termOpened, trackerState, trackerWindow,
} from '../lib/fixtures.mjs'

const REFUSED = 'e2e refused this write'
const TERM_NAME = 'vk-e2e0000a01'
/** the fixture pane's socket, which a v2 terminal opened on it tries (and the fence refuses) */
const NEW_PANE_WS = /\/ws\/terminal\?s=vk-e2e0000a01&/

/** The fake backend: GET mocks over one mutable state. */
function fakeBackend(page, st) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/lights', () => ok(st.lights))
  page.mock('/api/hosts/thor/rgb', () => ok(st.rgb))
  page.mock(/^\/api\/(supplements|exercise|sf)\/day$/, ({ path, query }) => ok(trackerWindow(st.tracker, path.split('/')[2], query.date, query.today)))
  page.mock('/api/daily/streak', ({ query }) => ok({ today: query.today, streak: st.tracker.streak }))
  page.mock(/^\/api\/(supplements|exercise|sf)\/skips$/, () => ok({ skips: [] }))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  page.mock('/api/session-hosts', () => ok(SESSION_HOSTS))
  page.mock('/api/terminal/odin-targets', () => ok(ODIN_TARGETS))
  page.mock('/api/session-board', () => ok(st.board))
  page.mock('/api/terminal/sessions', () => ok([]))
  page.mock('/api/services', () => ok(st.services))
  page.mock('/api/plex/request/search', () => ok(SEARCH))
}

function freshState(over = {}) {
  return { lights: lightsState(), rgb: rgbState('dark'), tracker: trackerState(), board: boardState(), services: servicesState(), ...over }
}

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

/** Waits (Node side) until the page has sent `n` writes. */
async function waitWrites(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * One action, two tests: `write:<id>:ok` and `write:<id>:fail<status>`.
 *   want(w, t, n): checks the n-th write (method, path, body); return false when it is not the write expected
 *   respond(w, st, n): the 200 answer, applied to the state like the real backend
 *   act(t, page): the taps
 *   okThen / failThen(t, page, st): what the screen must show after
 */
function writeTest(def) {
  const out = []
  const outcomes = [{ kind: 'ok', status: 200 }, ...(def.fail ?? [500]).map((s) => ({ kind: 'fail', status: s }))]
  for (const o of outcomes) {
    out.push({
      name: `write:${def.id}:${o.kind === 'ok' ? 'ok' : `fail${o.status}`}`,
      group: 'writes',
      device: def.device ?? 'phone',
      timeout: def.timeout ?? 50_000,
      async run(t) {
        const st = freshState(def.state?.() ?? {})
        if (def.allowSockets) t.allowSockets.push(...def.allowSockets)
        const page = await t.page({ storage: def.storage ?? {} })
        fakeBackend(page, st)
        let n = 0
        page.onWrite((w) => {
          n++
          const fit = def.want(w, t, n)
          if (fit === false) return undefined
          if (o.kind === 'ok') return def.respond(w, st, n)
          return { status: o.status, body: { error: REFUSED } }
        })
        // the error path logs nothing by design; any console error still fails the test
        await page.goto(def.route)
        await shellUp(page)
        await t.step('ready', () => def.ready(page))
        if (t.fails.length) return
        const since = Date.now()
        await def.act(t, page, o)
        await waitWrites(page, 1)
        if (o.kind === 'ok') await t.step('success', () => def.okThen(t, page, st, since))
        else await t.step(`refused with ${o.status}`, () => def.failThen(t, page, st, since, o.status))
        await sleep(400)
        const want = o.kind === 'ok' ? def.okWrites ?? 1 : 1
        t.check(page.writes.length === want, `${page.writes.length} write(s) sent, want ${want}: ${page.writes.map((w) => `${w.method} ${w.path} ${w.body}`).join(' | ')}`)
        await t.shot(page, o.kind)
      },
    })
  }
  return out
}

const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`

export function writeTests() {
  return [
    // ---- the lights button (bottom-left, every tab) ----
    ...writeTest({
      id: 'lamp',
      route: '/m/dashboard',
      fail: [500, 403],
      ready: (page) => page.waitFor(() => document.querySelector('.vl-lamp')?.getAttribute('aria-pressed') === 'true', { timeout: 10_000, message: 'the lights button never read the lit bulb' }),
      act: (t, page) => page.tap('.vl-lamp'),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/lights/turn') return false
        t.check(w.json?.state === 'off', `lights button sent state ${w.json?.state}, want off`)
        t.check(sameSet(w.json?.entity_id, ['light.e2e_desk', 'light.e2e_lamp']), `lights button sent entity_id ${JSON.stringify(w.json?.entity_id)}, want the two reachable bulbs`)
      },
      respond: (w, st) => { applyLight(st.lights, w.json); return { status: 200, body: { ok: true } } },
      okThen: async (t, page, st, since) => {
        await page.waitToast(/All lights off/, { since })
        await page.waitFor(() => document.querySelector('.vl-lamp')?.getAttribute('aria-pressed') === 'false', { message: 'the lights button did not go dark' })
        await sleep(2500)
        const lit = await page.eval(() => document.querySelector('.vl-lamp')?.getAttribute('aria-pressed'))
        t.check(lit === 'false', 'the lights button lit again after the write landed')
        const bad = (await page.toasts(since)).filter((x) => /not switched/i.test(x))
        t.check(!bad.length, `an error toast showed on success: ${bad.join(', ')}`)
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(new RegExp(`Lights not switched: ${status}`), { since })
        await page.waitFor(() => document.querySelector('.vl-lamp')?.getAttribute('aria-pressed') === 'true', { timeout: 4000, message: 'the lights button did not fall back to lit' })
      },
    }),

    // ---- a bulb on Lights ----
    ...writeTest({
      id: 'bulb',
      route: '/m/lights',
      fail: [403],
      ready: (page) => page.waitFor(() => !!document.querySelector('.lt-tg[aria-label="Turn Lamp on"]'), { timeout: 10_000, message: 'no Lamp row (off) on Lights' }),
      act: (t, page) => page.tap('.lt-tg[aria-label="Turn Lamp on"]'),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/lights/turn') return false
        t.check(w.json?.entity_id === 'light.e2e_lamp' && w.json?.state === 'on', `bulb toggle sent ${w.body}`)
      },
      respond: (w, st) => { applyLight(st.lights, w.json); return { status: 200, body: { ok: true } } },
      okThen: async (t, page, st, since) => {
        await page.waitFor(() => !!document.querySelector('.lt-tg[aria-label="Turn Lamp off"]'), { message: 'Lamp did not show on' })
        await sleep(2500)
        t.check(await page.eval(() => !!document.querySelector('.lt-tg[aria-label="Turn Lamp off"]')), 'Lamp went back off after the write landed')
        const bad = (await page.toasts(since)).filter((x) => /could not/i.test(x))
        t.check(!bad.length, `an error toast showed on success: ${bad.join(', ')}`)
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(new RegExp(`Could not turn Lamp on: ${status}`), { since })
        await page.waitFor(() => !!document.querySelector('.lt-tg[aria-label="Turn Lamp on"]'), { timeout: 4000, message: 'Lamp did not fall back to off' })
      },
    }),

    // ---- a preset on Lights ----
    ...writeTest({
      id: 'preset',
      route: '/m/lights',
      ready: (page) => page.waitFor(() => {
        const red = [...document.querySelectorAll('.lt-pre')].find((e) => /\bRed\b/.test(e.textContent || ''))
        return red && !red.disabled && !document.querySelector('.lt-pres[data-idle]')
      }, { timeout: 10_000, message: 'the presets never became usable' }),
      act: (t, page) => page.tap({ sel: '.lt-pre', text: /\bRed\b/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/lights/turn') return false
        const b = w.json ?? {}
        t.check(sameSet(b.entity_id, ['light.e2e_desk']), `preset sent entity_id ${JSON.stringify(b.entity_id)}, want only the lit bulb`)
        t.check(b.state === 'on' && JSON.stringify(b.rgb_color) === '[255,0,0]', `preset sent ${w.body}, want state on and rgb_color [255,0,0]`)
        t.check(b.brightness === undefined && b.color_temp_kelvin === undefined, `preset carried brightness or kelvin: ${w.body}`)
      },
      respond: (w, st) => { applyLight(st.lights, w.json); return { status: 200, body: { ok: true } } },
      okThen: async (t, page) => {
        await page.waitFor(() => [...document.querySelectorAll('.lt-pre')].find((e) => /\bRed\b/.test(e.textContent || ''))?.getAttribute('aria-checked') === 'true', { message: 'the Red preset did not light' })
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(new RegExp(`Could not apply Red: ${status}`), { since })
        await sleep(1200)
        const on = await page.eval(() => [...document.querySelectorAll('.lt-pre')].find((e) => /\bRed\b/.test(e.textContent || ''))?.getAttribute('aria-checked'))
        t.check(on !== 'true', 'the Red preset stayed lit after the refusal')
      },
    }),

    // ---- Thor RGB: Relight from dark, Dark from lit ----
    ...['relight', 'dark'].flatMap((mode) => writeTest({
      id: `rgb-${mode}`,
      route: '/m/lights',
      fail: [mode === 'dark' ? 403 : 500],
      state: () => ({ rgb: rgbState(mode === 'relight' ? 'dark' : 'lit') }),
      ready: (page) => page.waitFor(() => {
        const c = document.querySelector('.lt-rgb-ctl')
        return c && !c.hasAttribute('data-locked') && !c.hasAttribute('inert')
      }, { timeout: 12_000, message: 'the Thor RGB plates never unlocked' }),
      act: (t, page) => page.tap({ sel: '.lt-rgb-ctl [role="radio"]', text: mode === 'relight' ? /Relight/ : /Dark/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/hosts/thor/rgb') return false
        t.check(w.json?.mode === mode, `Thor RGB sent ${w.body}, want mode ${mode}`)
      },
      respond: () => ({ status: 200, body: { ok: true, mode } }),
      okThen: async (t, page) => {
        await page.waitFor((m) => document.querySelector('.lt-rgb-ctl')?.getAttribute('data-pending') === m, { args: [mode], message: 'the pressed plate is not marked pending' })
        const s = await page.eval(() => document.querySelector('.lt-rgb-state')?.textContent ?? '')
        t.check(mode === 'relight' ? /Relighting/.test(s) : /Going dark/.test(s), `the status line says "${s}"`)
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(new RegExp(`Thor RGB ${mode === 'dark' ? 'Dark' : 'Relight'} failed: ${status}`), { since })
        await page.waitFor(() => !document.querySelector('.lt-rgb-ctl')?.hasAttribute('data-pending'), { message: 'the plate stayed pending after the refusal' })
        const s = await page.eval(() => document.querySelector('.lt-rgb-state')?.textContent ?? '')
        t.check(mode === 'relight' ? /^Dark/.test(s.trim()) : /^Lit/.test(s.trim()), `the status line did not go back to the real state: "${s}"`)
      },
    })),

    // ---- the daily tracker on the Dashboard, and its Undo ----
    ...writeTest({
      id: 'tick',
      route: '/m/dashboard',
      fail: [403],
      okWrites: 2,
      ready: (page) => page.waitFor(() => {
        const el = [...document.querySelectorAll('.hm-tick')].find((e) => /Supplements/.test(e.getAttribute('aria-label') || ''))
        return el && !el.disabled && /today: not done/.test(el.getAttribute('aria-label') || '')
      }, { timeout: 12_000, message: 'the Supplements tick never read "today: not done"' }),
      act: (t, page) => page.tap({ sel: '.hm-tick', text: /Supplements/ }),
      want: (w, t, n) => {
        if (w.method !== 'POST' || w.path !== '/api/supplements/log') return false
        const d = today()
        const b = w.json ?? {}
        t.check(b.target === d && b.today === d && b.date === d, `tick ${n} sent ${w.body}, want target, date and today ${d}`)
        t.check(b.taken === (n === 1), `tick ${n} sent taken ${b.taken}, want ${n === 1}`)
      },
      respond: (w, st) => {
        const b = w.json
        if (b.taken) st.tracker.taken.supplements[b.target] = new Date().toISOString()
        else delete st.tracker.taken.supplements[b.target]
        return { status: 200, body: trackerWindow(st.tracker, 'supplements', b.date, b.today) }
      },
      okThen: async (t, page, st, since) => {
        const tick = () => [...document.querySelectorAll('.hm-tick')].find((e) => /Supplements/.test(e.getAttribute('aria-label') || ''))?.getAttribute('aria-pressed')
        await page.waitFor(`(${tick})() === 'true'`, { message: 'the tick did not show done' })
        await page.waitToast(/Supplements done/, { since })
        await sleep(500)
        await page.tap({ sel: '.vl-toast-btn', text: /Undo/ })
        await waitWrites(page, 2)
        await page.waitFor(`(${tick})() === 'false'`, { message: 'Undo did not untick' })
        await sleep(1500)
        t.check(await page.eval(`(${tick})() === 'false'`), 'the tick came back after Undo landed')
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(/Supplements not saved: /, { since })
        await page.waitFor(() => [...document.querySelectorAll('.hm-tick')].find((e) => /Supplements/.test(e.getAttribute('aria-label') || ''))?.getAttribute('aria-pressed') === 'false', { timeout: 4000, message: `the tick did not roll back after ${status}` })
      },
    }),

    // ---- Quick Start on the Dashboard: in the page, so the app heads for the terminal (stopped) ----
    ...writeTest({
      id: 'quickstart',
      route: '/m/dashboard',
      ready: (page) => page.waitFor(() => [...document.querySelectorAll('.hm-start')].some((e) => /Alpha/.test(e.textContent || '') && !e.disabled), { timeout: 12_000, message: 'no Alpha quick start' }),
      act: (t, page) => page.tap({ sel: '.hm-start', text: /Alpha/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/terminal/sessions') return false
        const b = w.json ?? {}
        t.check(b.mode === 'new' && b.target === 'alpha', `quick start sent ${w.body}, want mode new, target alpha`)
        t.check(b.host === undefined || b.host === 'thor', `quick start sent host ${b.host}`)
      },
      respond: (w) => ({ status: 201, body: termOpened(w.json) }),
      okThen: async (t, page) => {
        await page.waitFor(() => window.__e2e.blockedNav.length > 0, { message: 'the app did not head for the terminal' })
        const nav = await page.blockedNav()
        t.check(nav.some((x) => x.url.includes(`/sessions/terminal?s=${TERM_NAME}`)), `it headed for ${nav.map((x) => x.url).join(', ')}, want the new pane`)
        t.check((await page.path()) === '/m/dashboard', 'the page left the Dashboard')
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Alpha not started: e2e refused/i, { since })
        await page.waitFor(() => [...document.querySelectorAll('.hm-start')].some((e) => /Alpha/.test(e.textContent || '') && !e.disabled), { message: 'the Alpha plate stayed busy' })
        t.check(!(await page.blockedNav()).length, 'a refused start still headed for the terminal')
      },
    }),

    // ---- AI > Sessions > New session: thor in the page, thor on its screen, odin ----
    ...writeTest({
      id: 'ai-thor-page',
      route: '/m/ai/sessions',
      ready: (page) => openPicker(page, /^\s*Alpha\s*$/),
      act: (t, page) => page.tap({ sel: '.vc-sheet .vc-plate', text: /^\s*Alpha\s*$/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/terminal/sessions') return false
        const b = w.json ?? {}
        t.check(b.mode === 'new' && b.target === 'alpha' && (b.host === undefined || b.host === 'thor'), `thor in page sent ${w.body}`)
      },
      respond: (w) => ({ status: 201, body: termOpened(w.json) }),
      // the v2 terminal for the new pane: it tries that pane's socket, which the fence refuses
      allowSockets: [NEW_PANE_WS],
      okThen: async (t, page) => {
        await page.waitPath(`/m/ai/term/${TERM_NAME}`, 8000)
        t.check(!(await page.blockedNav()).length, `it headed for the classic terminal: ${(await page.blockedNav()).map((x) => x.url).join(', ')}`)
        await page.waitFor(() => !document.querySelector('.vc-sheet-root[data-shown]'), { message: 'the picker stayed open' })
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not start Alpha on .+: e2e refused/i, { since })
        const err = await page.eval(() => document.querySelector('.vc-sheet .vc-act-err')?.textContent ?? '')
        t.check(/e2e refused/i.test(err), `the picker does not show the refusal ("${err}")`)
        t.check(!(await page.blockedNav()).length, 'a refused start still headed for the terminal')
        t.check((await page.path()) === '/m/ai/sessions', `a refused start left AI > Sessions for ${await page.path()}`)
      },
    }),
    ...writeTest({
      id: 'ai-thor-screen',
      route: '/m/ai/sessions',
      fail: [403],
      ready: async (page) => {
        await openPicker(page, /^\s*Alpha\s*$/)
        // the picker's ways read "In Valkyrie" and "On <thor>'s screen" since round 5
        await page.tap({ sel: '.vc-sheet .vc-way [role="radio"]', text: /^\s*On .+'s screen\s*$/ })
        await page.waitFor(() => [...document.querySelectorAll('.vc-sheet .vc-plate')].some((e) => /^\s*Gamma\s*$/.test(e.textContent || '')), { message: 'On screen did not list every thor target' })
      },
      act: (t, page) => page.tap({ sel: '.vc-sheet .vc-plate', text: /^\s*Alpha\s*$/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/hosts/thor/launch-new') return false
        t.check(w.json?.target === 'alpha' && Object.keys(w.json).length === 1, `thor on screen sent ${w.body}, want { target: alpha }`)
      },
      respond: () => ({ status: 200, body: { ok: true } }),
      okThen: async (t, page, st, since) => {
        await page.waitToast(/Alpha opened on .+'s screen/, { since })
        await page.waitFor(() => !document.querySelector('.vc-sheet-root[data-shown]'), { message: 'the picker stayed open' })
        t.check(!(await page.blockedNav()).length, 'on screen should not head for the in-page terminal')
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not open Alpha on .+screen: e2e refused/i, { since })
        t.check(await page.eval(() => !!document.querySelector('.vc-sheet-root[data-shown]')), 'the picker closed on a refusal')
      },
    }),
    ...writeTest({
      id: 'ai-odin',
      route: '/m/ai/sessions',
      ready: (page) => openPicker(page, /^\s*Odin home\s*$/),
      act: (t, page) => page.tap({ sel: '.vc-sheet .vc-plate', text: /^\s*Odin home\s*$/ }),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/terminal/sessions') return false
        const b = w.json ?? {}
        t.check(b.mode === 'new' && b.host === 'odin' && b.target === 'home', `odin sent ${w.body}, want mode new, host odin, target home`)
        t.check(Number.isInteger(b.cols) && Number.isInteger(b.rows), `odin sent no grid: ${w.body}`)
        t.check(b.project === undefined && b.sessionId === undefined, `odin carried a project or a resume: ${w.body}`)
      },
      respond: (w) => ({ status: 201, body: termOpened(w.json) }),
      allowSockets: [NEW_PANE_WS],
      okThen: async (t, page) => {
        await page.waitPath(`/m/ai/term/${TERM_NAME}`, 8000)
        t.check(!(await page.blockedNav()).length, `it headed for the classic terminal: ${(await page.blockedNav()).map((x) => x.url).join(', ')}`)
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not start Odin home on .+: e2e refused/i, { since })
        t.check(!(await page.blockedNav()).length, 'a refused start still headed for the terminal')
        t.check((await page.path()) === '/m/ai/sessions', `a refused start left AI > Sessions for ${await page.path()}`)
      },
    }),

    // ---- a session: Done (and Undo), Stop ----
    ...writeTest({
      id: 'session-done',
      route: '/m/ai/sessions',
      okWrites: 2,
      ready: async (page) => {
        await page.waitFor(`!!document.querySelector('.vc-item[data-row="${CLOSED_ID}"]')`, { timeout: 12_000, message: 'the closed fixture session is not on the board' })
        await page.tap(`.vc-item[data-row="${CLOSED_ID}"] .vc-front`)
        await page.waitFor(visible(`.vc-item[data-row="${CLOSED_ID}"] .vc-strip`), { message: 'the row did not open its strip' })
      },
      act: (t, page) => page.tap(`.vc-item[data-row="${CLOSED_ID}"] .vc-strip .vc-sact[aria-label="Done"]`),
      want: (w, t, n) => {
        if (w.method !== 'POST' || w.path !== '/api/hosts/thor/sessions/disposition') return false
        const b = w.json ?? {}
        t.check(sameSet(b.sessionIds, [CLOSED_ID]), `Done ${n} sent sessionIds ${JSON.stringify(b.sessionIds)}`)
        t.check(b.disposition === (n === 1 ? 'done' : 'open'), `Done ${n} sent disposition ${b.disposition}`)
      },
      respond: (w, st) => {
        for (const s of st.board.sessions) if (w.json.sessionIds.includes(s.sessionId)) s.disposition = w.json.disposition === 'done' ? 'done' : 'open'
        return { status: 200, body: { ok: true, count: w.json.sessionIds.length } }
      },
      okThen: async (t, page) => {
        await page.waitFor(`!document.querySelector('.vc-item[data-row="${CLOSED_ID}"]')`, { message: 'the row did not leave the board' })
        await page.waitFor(() => /E2E closed session/.test(document.querySelector('.vc-undo')?.textContent ?? '') && !document.querySelector('.vc-undo-btn')?.disabled, { message: 'no Undo bar for the done session' })
        await page.tap('.vc-undo-btn')
        await waitWrites(page, 2)
        await page.waitFor(`!!document.querySelector('.vc-item[data-row="${CLOSED_ID}"]')`, { message: 'Undo did not bring the row back' })
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not mark "E2E closed session" done: e2e refused/i, { since })
        await page.waitFor(`!!document.querySelector('.vc-item[data-row="${CLOSED_ID}"]')`, { message: 'the row did not come back after the refusal' })
      },
    }),
    ...writeTest({
      id: 'session-stop',
      route: '/m/ai/sessions',
      fail: [403],
      ready: async (page) => {
        await page.waitFor(`!!document.querySelector('.vc-item[data-row="${LIVE_ID}"]')`, { timeout: 12_000, message: 'the live fixture session is not on the board' })
        await page.tap(`.vc-item[data-row="${LIVE_ID}"] .vc-front`)
        await page.waitFor(visible(`.vc-item[data-row="${LIVE_ID}"] .vc-strip .vc-sact[aria-label="Stop"]`), { message: 'the live row has no Stop' })
      },
      act: (t, page) => page.tap(`.vc-item[data-row="${LIVE_ID}"] .vc-strip .vc-sact[aria-label="Stop"]`),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/hosts/thor/stop') return false
        t.check(w.json?.sessionId === LIVE_ID && Object.keys(w.json).length === 1, `Stop sent ${w.body}, want { sessionId }`)
      },
      respond: (w, st) => {
        for (const s of st.board.sessions) if (s.sessionId === w.json.sessionId) { s.live = false; s.activity = 'closed'; s.onDesk = false }
        return { status: 200, body: { ok: true } }
      },
      okThen: async (t, page, st, since) => {
        await page.waitToast(/Stopped "E2E live session"/, { since })
        await sleep(1500)
        const a = await page.eval(`document.querySelector('.vc-item[data-row="${LIVE_ID}"] .vc-state')?.getAttribute('data-a') ?? 'none'`)
        t.check(a !== 'working', `the stopped row still reads ${a}`)
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not stop "E2E live session": e2e refused/i, { since })
        await page.waitFor(`document.querySelector('.vc-item[data-row="${LIVE_ID}"] .vc-state')?.getAttribute('data-a') === 'working'`, { message: 'the row did not go back to working' })
      },
    }),

    // ---- Media > Requests: search, then Request ----
    ...writeTest({
      id: 'media-request',
      route: '/m/media/requests',
      ready: async (page) => {
        await page.waitFor(() => !!document.querySelector('input[aria-label="Request a movie, show, or album"]'), { timeout: 12_000, message: 'no request search box' })
        await page.tap('input[aria-label="Request a movie, show, or album"]')
        await page.eval(() => document.querySelector('input[aria-label="Request a movie, show, or album"]')?.focus())
        await page.type('e2e film')
        await page.waitFor(() => !!document.querySelector('[aria-label="Request E2E Sample Film"]'), { message: 'the search result did not show' })
      },
      act: (t, page) => page.tap('[aria-label="Request E2E Sample Film"]'),
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/plex/request/add') return false
        const b = w.json ?? {}
        t.check(b.kind === 'movie' && b.tmdbId === 990001, `request sent ${w.body}, want kind movie, tmdbId 990001`)
        t.check(b.tvdbId === undefined && b.foreignAlbumId === undefined, `request carried empty ids: ${w.body}`)
      },
      respond: () => ({ status: 200, body: { ok: true, detail: '' } }),
      okThen: async (t, page, st, since) => {
        await page.waitToast(/Requested E2E Sample Film \(2001\)/, { since })
        await page.waitFor(() => /Requested/.test(document.querySelector('.vm-res .vm-res-st')?.textContent ?? ''), { message: 'the result does not say Requested' })
      },
      failThen: async (t, page, st, since) => {
        await page.waitToast(/Could not request E2E Sample Film \(2001\): e2e refused/i, { since })
        await page.waitFor(() => { const b = document.querySelector('[aria-label="Request E2E Sample Film"]'); return b && !b.disabled }, { message: 'the Request button did not come back' })
      },
    }),

    // ---- System > Services: Restart, then Confirm ----
    ...writeTest({
      id: 'restart',
      route: '/m/system/services',
      ready: (page) => page.waitFor(() => !!document.querySelector('.sys-svc-act[aria-label="Restart e2e-sample"]'), { timeout: 12_000, message: 'no Restart on the down fixture container' }),
      act: async (t, page) => {
        await page.tap('.sys-svc-act[aria-label="Restart e2e-sample"]')
        await page.waitFor(() => !!document.querySelector('.sys-svc-act[aria-label="Confirm: restart e2e-sample"]'), { message: 'Restart did not ask to confirm' })
        await sleep(500)
        t.check(page.writes.length === 0, 'the first tap sent the restart without a confirm')
        await page.tap('.sys-svc-act[aria-label="Confirm: restart e2e-sample"]')
      },
      want: (w, t) => {
        if (w.method !== 'POST' || w.path !== '/api/services/restart') return false
        t.check(w.json?.kind === 'container' && w.json?.name === 'e2e-sample', `restart sent ${w.body}, want kind container, name e2e-sample`)
      },
      respond: () => ({ status: 200, body: { ok: true } }),
      okThen: async (t, page, st, since) => {
        await page.waitToast(/Restarted e2e-sample/, { since })
      },
      failThen: async (t, page, st, since, status) => {
        await page.waitToast(new RegExp(`Could not restart e2e-sample: ${status}`), { since })
        await page.waitFor(() => !!document.querySelector('.sys-svc-act[aria-label="Restart e2e-sample"]'), { message: 'the button did not go back to Restart' })
      },
    }),
  ]
}

/** AI > Sessions: open New session and wait for a plate. */
async function openPicker(page, plate) {
  await page.waitFor(() => !!(document.querySelector('.vl-page[data-active] .vc-fab') || document.querySelector('.vl-page[data-active] .vc-new')), { timeout: 12_000, message: 'no New session button' })
  const fab = await page.eval(() => {
    const el = document.querySelector('.vl-page[data-active] .vc-fab') || document.querySelector('.vl-page[data-active] .vc-new')
    return el ? (el.classList.contains('vc-fab') ? '.vl-page[data-active] .vc-fab' : '.vl-page[data-active] .vc-new') : null
  })
  await page.tap(fab)
  const spec = { re: plate.source, flags: plate.flags }
  await page.waitFor((s) => [...document.querySelectorAll('.vc-sheet .vc-plate')].some((e) => new RegExp(s.re, s.flags).test(e.textContent || '') && !e.disabled), { args: [spec], timeout: 10_000, message: `the picker has no ${plate} plate` })
  await sleep(450)
}
