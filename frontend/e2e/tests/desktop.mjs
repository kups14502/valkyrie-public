// DESKTOP: v2 as the desktop UI. The desktop app's window chrome (a stand-in
// Tauri bridge plus Tauri's real drag script, lib/tauri.mjs): the strip is the
// title bar, the window buttons sit at its right end with nothing under them,
// an empty part drags and a double-click maximizes, the buttons and tabs stay
// buttons. The Ctrl+K palette, the zoom keys, Settings' version and Sign out,
// and where a tapped alert lands (public/push-sw.js, unit-tested in node, and
// the page side in main.tsx and /m/ai/open).

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from '../lib/cdp.mjs'
import { BOARD_IDS, PROJ_ID, fullBoardState, panesState, projList, projState, quietThor } from '../lib/fixtures.mjs'
import { TAURI_DRAG, tauriCalls, tauriStub } from '../lib/tauri.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ok = (body) => ({ status: 200, body })

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
  await sleep(400)
}

/** The window chrome, in viewport px: the strip, the window buttons, what else sits in the strip. */
function chromeReport() {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } }
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const strip = document.querySelector('.vl-strip')
  const ctl = document.querySelector('.vl-winctl')
  const buttons = [...document.querySelectorAll('.vl-winctl button')].map((b) => {
    const r = b.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { label: b.getAttribute('aria-label'), box: box(b), hit: at === b || b.contains(at) ? 'self' : at ? `${at.tagName.toLowerCase()}.${String(at.className).split(' ')[0]}` : 'nothing' }
  })
  const left = Math.min(...buttons.map((b) => b.box.l))
  const tag = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''}`
  // everything else drawn in the strip must end before the first window button
  const under = strip ? [...strip.querySelectorAll('*')].filter((el) => !el.closest('.vl-winctl') && shown(el) && el.getBoundingClientRect().right > left + 0.5).map(tag) : []
  const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1
  return {
    W: innerWidth, zoom,
    win: document.documentElement.dataset.v2win ?? null,
    tauriClass: document.documentElement.classList.contains('tauri'),
    strip: box(strip), stripDrag: strip?.getAttribute('data-tauri-drag-region') ?? null,
    navDrag: (document.querySelector('.vl-nav') || document.querySelector('.vl-setbar'))?.getAttribute('data-tauri-drag-region') ?? null,
    ctl: box(ctl), buttons, under: [...new Set(under)].slice(0, 6),
  }
}

/** A point on the strip that belongs to no button: the middle of the gap between its left and right groups. */
function emptyStripPoint() {
  const strip = document.querySelector('.vl-strip')
  const l = document.querySelector('.vl-strip-left')
  const r = document.querySelector('.vl-strip-right')
  if (!strip || !l || !r) return null
  const s = strip.getBoundingClientRect()
  const a = l.getBoundingClientRect().right
  const b = r.getBoundingClientRect().left
  const y = s.top + s.height / 2
  for (let x = (a + b) / 2; x < b; x += 13) {
    const el = document.elementFromPoint(x, y)
    if (el && strip.contains(el) && !el.closest('button, a, [role="button"], [tabindex]:not([tabindex="-1"])')) return { x, y }
  }
  return null
}

/** A point on the tab row that is not a tab. */
function emptyNavPoint() {
  const nav = document.querySelector('.vl-nav')
  if (!nav) return null
  const n = nav.getBoundingClientRect()
  const first = document.querySelector('.vl-nav .vl-tab-prim')?.getBoundingClientRect()
  const y = first ? first.top + first.height / 2 : n.top + 12
  for (let x = n.left + 8; x < (first ? first.left - 4 : n.left + 200); x += 11) {
    const el = document.elementFromPoint(x, y)
    if (el && nav.contains(el) && !el.closest('button, a, [role="button"], [tabindex]:not([tabindex="-1"])')) return { x, y }
  }
  return null
}

function chromeChecks(t, c, tag) {
  t.check(c.win === 'tauri' && c.tauriClass, `${tag}: html[data-v2win="tauri"] / html.tauri missing (${c.win}, ${c.tauriClass})`)
  t.check(c.stripDrag === 'deep', `${tag}: the strip is not a deep drag region (${c.stripDrag})`)
  t.check(c.navDrag === 'deep', `${tag}: the tab row or page bar is not a drag region (${c.navDrag})`)
  const labels = c.buttons.map((b) => b.label).join(',')
  t.check(labels === 'Minimize,Maximize,Close', `${tag}: the window buttons are ${labels || 'missing'}`)
  for (const b of c.buttons) {
    t.check(b.hit === 'self', `${tag}: ${b.label} is covered by ${b.hit}`)
    if (c.strip) t.check(b.box.t <= c.strip.t + 1 && b.box.b <= c.strip.b + 1 && b.box.b >= c.strip.b - 1, `${tag}: ${b.label} does not fill the strip's height (${Math.round(b.box.t)}..${Math.round(b.box.b)} vs ${Math.round(c.strip.t)}..${Math.round(c.strip.b)})`)
  }
  const close = c.buttons.find((b) => b.label === 'Close')
  if (close) t.check(Math.abs(close.box.r - c.W) <= 1, `${tag}: Close does not sit in the window corner (right ${Math.round(close.box.r)} of ${c.W})`)
  t.check(!c.under.length, `${tag}: ${c.under.join(', ')} reaches under the window buttons`)
  if (c.strip) t.check(c.strip.h / c.zoom >= 30, `${tag}: the title bar is ${Math.round(c.strip.h / c.zoom)} px tall, too thin to grab`)
}

function tauriTests() {
  const out = []
  for (const device of ['desktop', 'desk1080']) {
    out.push({
      name: `desk:tauri:${device}`,
      group: 'desktop',
      device,
      timeout: 70_000,
      async run(t) {
        const page = await t.page({ scripts: [tauriStub({ version: '0.3.999' }), TAURI_DRAG] })
        quietThor(page)
        // the app's start URL is "/": it must open v2
        await page.goto('/')
        await page.waitPath('/m/dashboard', 10_000)
        await shellUp(page)
        await sleep(600)
        const c = await page.eval(chromeReport)
        chromeChecks(t, c, `dashboard @${device}`)
        await t.shot(page, 'dash')

        await t.step('an empty part of the strip drags; a double-click maximizes', async () => {
          const at = await page.eval(emptyStripPoint)
          if (!at) throw new Error('no empty point on the strip')
          let from = (await tauriCalls(page)).length
          await page.mouse(at.x, at.y)
          await sleep(150)
          let calls = await tauriCalls(page, from)
          t.check(calls.includes('plugin:window|start_dragging'), `a press on the strip sent ${calls.join(', ') || 'nothing'}, want start_dragging`)
          await sleep(600)
          from = (await tauriCalls(page)).length
          await page.mouse(at.x, at.y, { count: 2 })
          await sleep(150)
          calls = await tauriCalls(page, from)
          t.check(calls.includes('plugin:window|internal_toggle_maximize'), `a double-click on the strip sent ${calls.join(', ') || 'nothing'}, want internal_toggle_maximize`)
        })
        await t.step('an empty part of the tab row drags', async () => {
          const at = await page.eval(emptyNavPoint)
          if (!at) throw new Error('no empty point on the tab row')
          const from = (await tauriCalls(page)).length
          await page.mouse(at.x, at.y)
          await sleep(150)
          const calls = await tauriCalls(page, from)
          t.check(calls.includes('plugin:window|start_dragging'), `a press beside the tabs sent ${calls.join(', ') || 'nothing'}`)
        })
        await t.step('the window buttons are buttons: Minimize, Maximize, Close', async () => {
          for (const [label, cmd] of [['Minimize', 'plugin:window|minimize'], ['Maximize', 'plugin:window|toggle_maximize'], ['Close', 'plugin:window|close']]) {
            await sleep(500)
            const from = (await tauriCalls(page)).length
            await page.tap(`.vl-winctl button[aria-label="${label}"]`)
            await sleep(150)
            const calls = await tauriCalls(page, from)
            t.check(calls.includes(cmd), `${label} sent ${calls.join(', ') || 'nothing'}, want ${cmd}`)
            t.check(!calls.some((x) => /start_dragging|internal_toggle_maximize/.test(x)), `${label} also dragged the window: ${calls.join(', ')}`)
          }
        })
        await t.step('a tab is a tab, not a drag', async () => {
          await sleep(500)
          const from = (await tauriCalls(page)).length
          await page.tap({ sel: '.vl-nav .vl-tab-prim', text: /^\s*AI\s*$/ })
          await page.waitPath(/^\/m\/ai\//)
          const calls = await tauriCalls(page, from)
          t.check(!calls.some((x) => /start_dragging|toggle_maximize/.test(x)), `the AI tab also moved the window: ${calls.join(', ')}`)
        })
        await t.step('the gear and the search are buttons too', async () => {
          await sleep(500)
          const from = (await tauriCalls(page)).length
          await page.tap('.vl-strip-gear')
          await page.waitPath('/m/settings')
          await shellUp(page)
          const calls = await tauriCalls(page, from)
          t.check(!calls.some((x) => /start_dragging|toggle_maximize/.test(x)), `the gear also moved the window: ${calls.join(', ')}`)
          chromeChecks(t, await page.eval(chromeReport), `settings @${device}`)
          // the installed app's own version, from Tauri
          await page.waitFor(() => /^v0\.3\.999\b/.test(document.querySelector('.vl-set .st-ver')?.textContent?.trim() ?? ''), { message: 'Settings > Build does not show the app version from Tauri (v0.3.999)' })
          await t.shot(page, 'settings')
        })
        for (const path of ['/m/calendar', '/m/ai/skin']) {
          await t.step(`${path}: the strip keeps the window buttons clear`, async () => {
            await page.goto(path)
            await page.waitFor(() => document.querySelector('.vl-winctl button'), { timeout: 12_000, message: `${path}: no window buttons` })
            await sleep(800)
            const c2 = await page.eval(chromeReport)
            // the terminal preview has no tab row or page bar of its own
            if (path === '/m/ai/skin') c2.navDrag = 'deep'
            chromeChecks(t, c2, `${path} @${device}`)
          })
        }
      },
    })
  }
  return out
}

// ---------- the palette ----------

const palRows = () => [...document.querySelectorAll('.vl-pal-row .vl-pal-label')].map((e) => e.textContent.trim())

function paletteTests() {
  const out = []
  for (const device of ['desktop', 'desk1080']) {
    out.push({
      name: `desk:palette:${device}`,
      group: 'desktop',
      device,
      timeout: 70_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        page.mock('/api/terminal/sessions', () => ok(panesState()))
        // the pane opened from the palette: its v2 terminal tries the made-up pane's socket, which the fence refuses
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b2&/)
        await page.goto('/m/ai/sessions')
        await shellUp(page)
        const open = () => page.waitFor(() => document.querySelector('.vl-pal .vl-pal-field input') === document.activeElement, { message: 'the palette did not open with its search focused' })
        const closed = () => page.waitFor(() => !document.querySelector('.vl-pal'), { message: 'the palette did not close' })

        await t.step('Ctrl+K opens it; a search and Enter go to AI > Usage', async () => {
          await page.key('k', { ctrl: true })
          await open()
          const groups = await page.eval(() => [...document.querySelectorAll('.vl-pal-head')].map((e) => e.textContent.trim()))
          t.check(['Go to', 'Sessions', 'Actions', 'Classic'].every((g) => groups.includes(g)), `the palette groups read ${groups.join(', ')}`)
          await page.type('usage')
          await page.waitFor(() => document.querySelector('.vl-pal-row[data-on] .vl-pal-label')?.textContent?.trim() === 'AI · Usage', { message: 'typing "usage" did not put AI · Usage first' })
          // the arrows belong to the list while it is open: the tabs behind it stay put
          await page.key('ArrowRight')
          await sleep(300)
          t.check((await page.path()) === '/m/ai/sessions', `ArrowRight in the palette paged the tabs to ${await page.path()}`)
          await page.key('Enter')
          await page.waitPath('/m/ai/usage')
          await closed()
        })
        await t.step('the strip\'s search button opens it; Escape closes it and gives the focus back', async () => {
          await page.tap('.vl-strip-search')
          await open()
          await page.key('Escape')
          await closed()
          const back = await page.eval(() => document.activeElement?.classList.contains('vl-strip-search') ?? false)
          t.check(back, 'the focus did not go back to the search button')
          t.check((await page.path()) === '/m/ai/usage', 'Escape left the page')
        })
        await t.step('Ctrl+K again closes it', async () => {
          await page.key('k', { ctrl: true })
          await open()
          await page.key('k', { ctrl: true })
          await closed()
        })
        await t.step('arrows pick a row: down to the second match, Enter runs it', async () => {
          await page.key('k', { ctrl: true })
          await open()
          await page.type('media')
          await page.waitFor(() => document.querySelectorAll('.vl-pal-row').length >= 2, { message: 'typing "media" matched fewer than two rows' })
          const rows = await page.eval(palRows)
          await page.key('ArrowDown')
          const second = await page.eval(() => document.querySelector('.vl-pal-row[data-on] .vl-pal-label')?.textContent?.trim())
          t.check(second === rows[1], `ArrowDown lit "${second}", want "${rows[1]}"`)
          await page.key('Enter')
          await closed()
          const want = { 'Media · Dashboard': '/m/media/dashboard', 'Media · Movies': '/m/media/movies', 'Media · Shows': '/m/media/shows', 'Media · Music': '/m/media/music', 'Media · Requests': '/m/media/requests' }[second]
          if (want) await page.waitPath(want)
        })
        await t.step('Calendar and Meals open their v2 pages', async () => {
          for (const [q, label, path] of [['calendar', 'Calendar', '/m/calendar'], ['meals', 'Meals', '/m/meals']]) {
            await page.goto('/m/dashboard')
            await shellUp(page)
            await page.key('k', { ctrl: true })
            await open()
            await page.type(q)
            await page.waitFor((l) => document.querySelector('.vl-pal-row[data-on] .vl-pal-label')?.textContent?.trim() === l, { args: [label], message: `typing "${q}" did not put ${label} first` })
            const hint = await page.eval(() => document.querySelector('.vl-pal-row[data-on] .vl-pal-hint')?.textContent?.trim() ?? '')
            t.check(hint !== 'classic', `${label} still opens the classic page`)
            await page.key('Enter')
            await page.waitPath(path)
          }
        })
        await t.step('a running terminal opens by its name', async () => {
          await page.goto('/m/dashboard')
          await shellUp(page)
          await page.key('k', { ctrl: true })
          await open()
          await page.waitFor(() => [...document.querySelectorAll('.vl-pal-group[aria-label="Sessions"] .vl-pal-label')].some((e) => e.textContent.trim() === 'E2E pane'), { message: 'the Sessions group does not list the open pane "E2E pane"' })
          await page.type('e2e pane')
          await page.waitFor(() => document.querySelector('.vl-pal-row[data-on] .vl-pal-label')?.textContent?.trim() === 'E2E pane', { message: 'typing "e2e pane" did not put the pane first' })
          await page.key('Enter')
          await page.waitPath('/m/ai/term/vk-e2e00000b2', 8000)
        })
        await t.step('with the palette closed, the arrows page the tabs', async () => {
          await page.goto('/m/lights')
          await shellUp(page)
          await page.key('ArrowRight')
          await page.waitPath(/^\/m\/media\//)
        })
        t.check(!page.writes.length, `the palette wrote something: ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
      },
    })
  }
  return out
}

// ---------- zoom ----------

function zoomTests() {
  return [{
    name: 'desk:zoom',
    group: 'desktop',
    device: 'desktop',
    timeout: 50_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      await page.goto('/m/ai/projects')
      await shellUp(page)
      const z = () => page.eval(() => ({ css: getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim(), stored: localStorage.getItem('valkyrie-zoom') }))
      const want = async (level, how) => {
        await page.waitFor((l) => Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) - l) < 0.001, { args: [level], timeout: 3000, message: `${how}: the zoom did not reach ${level}` })
        const s = await z()
        t.check(Math.abs(Number(s.stored) - level) < 0.001, `${how}: the stored zoom is ${s.stored}, want ${level}`)
      }
      /** The caret sits under the lit tab, the sub-tabs under the bar, and the shell fills the window. */
      const layout = async (how) => {
        await sleep(700)
        const r = await page.eval(() => {
          const c = (el) => { const b = el.getBoundingClientRect(); return b.left + b.width / 2 }
          const notch = document.querySelector('.vl-nav .vl-notch')
          const tab = document.querySelector('.vl-nav .vl-tab-prim[aria-current="page"]')
          const sub = document.querySelector('.vl-nav .vl-tab-sub[aria-current="page"]')
          const shell = document.querySelector('.vl-shell').getBoundingClientRect()
          const lamp = document.querySelector('.vl-lamp').getBoundingClientRect()
          const sb = sub ? sub.getBoundingClientRect() : null
          return { notch: notch ? c(notch) : null, tab: tab ? c(tab) : null, sub: sb ? { left: sb.left, right: sb.right } : null, shell: { w: shell.width, h: shell.height }, W: innerWidth, H: innerHeight, lampB: lamp.bottom, lampL: lamp.left }
        })
        if (r.notch != null && r.tab != null) t.check(Math.abs(r.notch - r.tab) <= 3, `${how}: the caret is ${Math.round(r.notch - r.tab)} px off the lit tab`)
        t.check(Math.abs(r.shell.w - r.W) <= 2 && Math.abs(r.shell.h - r.H) <= 2, `${how}: the shell is ${Math.round(r.shell.w)}x${Math.round(r.shell.h)} in a ${r.W}x${r.H} window`)
        t.check(r.sub && r.sub.right <= r.W + 0.5 && r.sub.left >= -0.5, `${how}: the lit sub-tab is off screen`)
        t.check(r.lampB <= r.H + 0.5 && r.lampB >= r.H - 48 && r.lampL <= 40, `${how}: the lights button left the bottom-left corner (bottom ${Math.round(r.lampB)} of ${r.H})`)
      }
      await want(1, 'at start')
      await page.key('=', { ctrl: true })
      await want(1.1, 'Ctrl+=')
      await page.key('=', { ctrl: true })
      await want(1.2, 'Ctrl+= twice')
      await layout('at 1.2')
      await t.shot(page, 'z12')
      await page.key('-', { ctrl: true })
      await want(1.1, 'Ctrl+-')
      await layout('at 1.1')
      await page.key('0', { ctrl: true })
      await want(1, 'Ctrl+0')
      await layout('at 1.0')
      // the zoom outlives a reload
      await page.key('=', { ctrl: true })
      await want(1.1, 'Ctrl+= before the reload')
      await page.goto('/m/ai/projects')
      await shellUp(page)
      await want(1.1, 'after a reload')
    },
  }]
}

// ---------- Settings: the version, Sign out ----------

function settingsTests() {
  return [{
    name: 'desk:settings:version-signout',
    group: 'desktop',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      // signed in through the migration skip (no token to send), so Sign out has something to end
      const page = await t.page({ scripts: ["try { sessionStorage.setItem('valkyrie.authSkip', '1') } catch (e) {}"] })
      quietThor(page)
      let signedOut = false
      // once signed out, the server no longer trusts this browser: the sign-in card must take over
      page.mock('/api/auth/status', () => ok(signedOut ? { configured: true, strict: true, trusted: false } : { configured: true, strict: true, trusted: true }))
      await page.goto('/m/settings')
      await shellUp(page)
      await t.step('Build shows the version', async () => {
        await page.waitFor(() => /^v\d+\.\d+\.\d+/.test(document.querySelector('.vl-set .st-ver')?.textContent?.trim() ?? ''), { message: 'Settings > Build shows no version' })
      })
      await t.step('Sign out takes two presses, the first one arms it and times out', async () => {
        const btn = '.vl-set .st-row-act[aria-label="Sign out"]'
        await page.tap(btn)
        await page.waitFor(() => document.querySelector('.vl-set .st-row-act[aria-label="Confirm: sign out"]'), { message: 'the first press did not arm Sign out' })
        t.check((await page.eval(() => sessionStorage.getItem('valkyrie.authSkip'))) === '1', 'the first press already signed out')
        await sleep(3400)
        t.check(await page.eval(() => !!document.querySelector('.vl-set .st-row-act[aria-label="Sign out"]')), 'Sign out stayed armed after 3 s')
        await t.shot(page, 'before')
        await page.tap(btn)
        signedOut = true
        await page.tap('.vl-set .st-row-act[aria-label="Confirm: sign out"]')
        await page.waitFor(() => /secure access/i.test(document.body.innerText) && document.querySelector('input[type="password"]'), { timeout: 8000, message: 'Sign out did not bring up the sign-in card' })
        const s = await page.eval(() => ({ skip: sessionStorage.getItem('valkyrie.authSkip'), token: localStorage.getItem('valkyrie.appToken'), v2: document.documentElement.hasAttribute('data-v2') }))
        t.check(s.skip === null && s.token === null, `Sign out left the sign-in behind (skip ${s.skip}, token ${s.token})`)
        t.check(!s.v2, 'v2 stayed mounted behind the sign-in card')
      })
      t.check(!page.writes.length, `Sign out sent ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
    },
  }]
}

// ---------- alert taps ----------

/** Runs public/push-sw.js against a stand-in worker and returns where each tap goes. */
export async function swTargets(cases, { client = false } = {}) {
  const src = readFileSync(resolve(HERE, '..', '..', 'public', 'push-sw.js'), 'utf8')
  const handlers = {}
  const opened = []
  const navigated = []
  const shown = []
  const self = {
    location: { origin: 'https://valkyrie.example' },
    addEventListener: (n, f) => { handlers[n] = f },
    clients: {
      matchAll: async () => (client ? [{ url: 'https://valkyrie.example/m/dashboard', focus: async function () { return this }, navigate: async (u) => { navigated.push(u) } }] : []),
      openWindow: async (u) => { opened.push(u) },
    },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }) } },
  }
  new Function('self', 'URL', src)(self, URL)
  const out = []
  for (const c of cases) {
    let waited
    handlers.notificationclick({ notification: { close() {}, data: c.url === undefined ? {} : { url: c.url }, tag: c.tag, body: c.body }, waitUntil: (p) => { waited = p } })
    await waited
    out.push(client ? navigated[navigated.length - 1] : opened[opened.length - 1])
  }
  let pushed
  handlers.push({ data: { json: () => ({ title: 'E2E', body: 'b', url: '/projects/e2e-proj', tag: 'proj-e2e' }) }, waitUntil: (p) => { pushed = p } })
  await pushed
  return { out, shown }
}

function pushTests() {
  const v2q = (v) => `v2=${encodeURIComponent(v)}`
  const CASES = [
    { url: '/sessions', tag: 'session-0e2e0001', body: 'E2E live session', want: `/sessions?${v2q('/m/ai/open?label=E2E%20live%20session')}` },
    { url: '/sessions', tag: 'session-0e2e0002', body: '', want: '/sessions' },
    { url: '/dashboard', tag: 'claude-quota', body: 'Resets at 4:40 PM ET', want: `/dashboard?${v2q('/m/ai/usage')}` },
    { url: '/dashboard', tag: 'claude-signin-acct2', body: 'Signed out', want: `/dashboard?${v2q('/m/ai/usage')}` },
    { url: '/services', tag: 'disk', body: 'odin is running out of space', want: `/services?${v2q('/m/system/hosts')}` },
    { url: '/projects/e2e-proj', tag: 'proj-e2e-proj', body: 'Reminder', want: `/projects/e2e-proj?${v2q('/m/ai/projects?p=e2e-proj')}` },
    { url: '/projects/e2e-proj?tab=notes', tag: 'proj-e2e-proj', body: 'Note', want: `/projects/e2e-proj?tab=notes&${v2q('/m/ai/projects?p=e2e-proj')}` },
    { url: '/projects/Not_An_Id', tag: 'proj-x', body: 'x', want: '/projects/Not_An_Id' },
    { url: '/vault', tag: 'vault-e2e', body: 'A container is down', want: '/vault' },
    { url: undefined, tag: 'valkyrie', body: 'Test', want: '/sessions' },
  ]
  return [
    {
      name: 'push:sw-map',
      group: 'desktop',
      device: 'phone',
      timeout: 15_000,
      async run(t) {
        const { out, shown } = await swTargets(CASES)
        CASES.forEach((c, k) => t.check(out[k] === c.want, `${c.tag} on ${c.url ?? '(no url)'} opens ${out[k]}, want ${c.want}`))
        const viaClient = await swTargets([CASES[2]], { client: true })
        t.check(viaClient.out[0] === CASES[2].want, `an open window navigated to ${viaClient.out[0]}, want ${CASES[2].want}`)
        const n = shown[0]
        t.check(n && n.title === 'E2E' && n.options.tag === 'proj-e2e' && n.options.data.url === '/projects/e2e-proj', `the push showed ${JSON.stringify(n)}`)
        // the page takes each hint as a v2 path (lib/deviceMode safeV2Path's rules)
        for (const w of out) {
          const v = new URL(w, 'https://valkyrie.example').searchParams.get('v2')
          if (v) t.check(v.startsWith('/m/') && !v.startsWith('//') && !/[\s\\]/.test(v), `the hint ${v} is not a v2 path the page accepts`)
        }
      },
    },
    {
      name: 'push:entry',
      group: 'desktop',
      device: 'phone',
      timeout: 70_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        const board = fullBoardState()
        const panes = [...panesState(), { ...panesState()[1], name: 'vk-e2e00000b3', label: 'resumed', mode: 'resume', target: BOARD_IDS.closed }]
        page.mock('/api/session-board', () => ok(board))
        page.mock('/api/hosts/thor/sessions', () => ok(board))
        page.mock('/api/terminal/sessions', () => ok(panes))
        const proj = projState()
        page.mock('/api/proj', () => ok(projList(proj)))
        page.mock(`/api/proj/${PROJ_ID}`, () => ok(proj.doc))
        page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
        // the panes the alerts open: their v2 terminals try the made-up panes' sockets, which the fence refuses
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b[23]&/)
        for (const [from, to] of [
          [`/dashboard?${v2q('/m/ai/usage')}`, '/m/ai/usage'],
          [`/services?${v2q('/m/system/hosts')}`, '/m/system/hosts'],
          [`/projects/e2e-proj?${v2q('/m/ai/projects?p=e2e-proj')}`, '/m/ai/projects'],
          // a hint that is not a v2 path is ignored; the classic URL's own v2 screen opens
          [`/dashboard?${v2q('//evil.example/m/x')}`, '/m/dashboard'],
          [`/sessions?${v2q('https://evil.example/')}`, '/m/ai/sessions'],
        ]) {
          await t.step(`${decodeURIComponent(from)} -> ${to}`, async () => {
            await page.goto(from)
            await page.waitPath(to, 8000)
            t.check(!/[?&]v2=/.test(await page.path()), `the hint stayed in the address: ${await page.path()}`)
          })
        }
        await t.step('a classic tab drops the hint and stays classic', async () => {
          const p2 = await t.page()
          quietThor(p2)
          await p2.goto(`/dashboard?classic=1&${v2q('/m/ai/usage')}`)
          await p2.waitFor(() => document.querySelector('[data-shell]'), { timeout: 10_000, message: 'the classic dashboard did not render' })
          const s = await p2.eval(() => ({ path: location.pathname + location.search, v2: document.documentElement.hasAttribute('data-v2') }))
          t.check(s.path === '/dashboard?classic=1' && !s.v2, `a classic tab went to ${s.path}${s.v2 ? ' with v2' : ''}`)
        })
        await t.step('a session alert opens the pane labeled with its name', async () => {
          await page.goto(`/sessions?${v2q('/m/ai/open?label=E2E%20pane')}`)
          await page.waitPath('/m/ai/term/vk-e2e00000b2', 10_000)
        })
        await t.step('a session alert finds the pane running that board session', async () => {
          await page.goto(`/m/ai/open?label=${encodeURIComponent('E2E closed session')}`)
          await page.waitPath('/m/ai/term/vk-e2e00000b3', 10_000)
        })
        await t.step('a session with no pane lands on AI > Sessions with a line saying so', async () => {
          const since = Date.now()
          await page.goto(`/m/ai/open?label=${encodeURIComponent('E2E nowhere')}`)
          await page.waitPath('/m/ai/sessions', 10_000)
          await page.waitToast(/E2E nowhere: not open in a terminal/, { since })
        })
        t.check(!page.writes.length, `an alert tap wrote something: ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
      },
    },
  ]
}

export function desktopTests() {
  return [...tauriTests(), ...paletteTests(), ...zoomTests(), ...settingsTests(), ...pushTests()]
}
