// GAPS: one test per feature added in the gap pass, each against a fake
// backend for the state it needs (every write answered in the browser; any
// write a test did not expect is a 418 and a failure).
//
//   AI > Sessions   the done fold and Undo per row, select mode (long press,
//                   Mark done, Undo), open terminals (reattach, two-tap close),
//                   Stop all (panes first, then sessions, one at a time),
//                   search over title, project and folder, resume on thor's screen
//   AI > Projects   a project's detail: tick and add tasks, cancel and add
//                   reminders, edit the next action
//   Dashboard       the tracker's day stepping and the other-day line, hold to
//                   skip Exercise, the calendar sheet
//   Settings        Hero picks the gutter model, the classic Slop row
//   System > Hosts  a model-only device (the tablet) shows its x-ray model
//   Lights          Custom color for one bulb and for the room (one command per pick)
//   Media           Open Plex and Spotify at the top of the Media dashboard
//
// The terminal and the uploads have their own files (terminal.mjs, upload.mjs).

import { sleep } from '../lib/cdp.mjs'
import { hostsDoc } from './hosts.mjs'
import {
  BOARD_IDS, ODIN_TARGETS, PROJ_ID, SESSION_HOSTS, TARGETS,
  applyLight, fullBoardState, lightsState, panesState, projList, projState, quietThor, rgbState,
  shiftKey, trackerState, trackerWindow,
} from '../lib/fixtures.mjs'

const ok = (body) => ({ status: 200, body })

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

/** Waits (Node side) until the page has sent `n` writes; returns the n-th. */
async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

/** A finger held still on an element for `ms` (a long press). */
async function hold(page, target, ms = 700) {
  const at = await page.locate(target)
  if (at.error) throw new Error(at.error)
  const pt = [{ x: at.x, y: at.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt })
  await sleep(ms)
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(150)
}

/** Sets an input's value the way typing would (React sees an input event). */
function setValue(sel, v, events = ['input']) {
  const el = document.querySelector(sel)
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  for (const e of events) el.dispatchEvent(new Event(e, { bubbles: true }))
  return true
}

const row = (id) => `.vc-item[data-row="${id}"]`

// ---------- AI > Sessions ----------

/** The board, the panes and the projects glance from one mutable state. */
function sessionsBackend(page, st) {
  quietThor(page)
  page.mock('/api/session-board', () => ok(st.board))
  page.mock('/api/hosts/thor/sessions', () => ok(st.board))
  page.mock('/api/terminal/sessions', () => ok(st.panes))
  page.mock('/api/terminal/odin-targets', () => ok(ODIN_TARGETS))
  page.mock('/api/session-hosts', () => ok(SESSION_HOSTS))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  page.mock('/api/proj', () => ok(st.proj ? projList(st.proj) : []))
  page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
}

function sessionsState() {
  return { board: fullBoardState(), panes: panesState(), proj: null }
}

/** Applies a disposition write to the board, the way thor's agent would. */
function applyDispo(st, w) {
  for (const s of st.board.sessions) if (w.json.sessionIds.includes(s.sessionId)) s.disposition = w.json.disposition === 'done' ? 'done' : 'open'
  return ok({ ok: true, count: w.json.sessionIds.length })
}

async function boardUp(page) {
  await shellUp(page)
  await page.waitFor(`!!document.querySelector('${row(BOARD_IDS.closed)}')`, { timeout: 12_000, message: 'the fixture board did not render' })
  await sleep(500)
}

function sessionTests() {
  return [
    {
      name: 'gap:sessions:done-fold',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/hosts/thor/sessions/disposition' ? applyDispo(st, w) : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const fold = await page.eval(() => document.querySelector('.vl-page[data-active] .vc-fold')?.textContent?.trim() ?? '')
        t.check(/Show 2 done/.test(fold), `the done fold reads "${fold}"`)
        t.check(!(await page.eval(`!!document.querySelector('${row(BOARD_IDS.done1)}')`)), 'a done row shows before the fold opens')
        await page.tap('.vl-page[data-active] .vc-fold')
        await page.waitFor(() => document.querySelectorAll('section[data-g="done"] .vc-item').length === 2, { message: 'the fold did not open the two done rows' })
        await page.tap(`${row(BOARD_IDS.done1)} .vc-front`)
        await page.waitFor(`!!document.querySelector('${row(BOARD_IDS.done1)} .vc-strip .vc-sact[aria-label="Undo done"]')`, { message: 'the done row has no Undo in its strip' })
        await t.shot(page, 'strip')
        await page.tap(`${row(BOARD_IDS.done1)} .vc-strip .vc-sact[aria-label="Undo done"]`)
        const w = await waitW(page, 1)
        t.check(sameSet(w.json?.sessionIds, [BOARD_IDS.done1]) && w.json?.disposition === 'open', `Undo sent ${w.body}`)
        await page.waitFor(`!!document.querySelector('section[data-g="recent"] ${row(BOARD_IDS.done1)}')`, { message: 'the row did not move back to Recent' })
        t.check((await page.eval(() => document.querySelectorAll('section[data-g="done"] .vc-item').length)) === 1, 'the done group still holds two rows')
        await page.tap({ sel: 'section[data-g="done"] .vc-ghead-act', text: 'Hide done' })
        await page.waitFor(() => /Show 1 done/.test(document.querySelector('.vl-page[data-active] .vc-fold')?.textContent ?? ''), { message: 'Hide done did not fold the list back' })
      },
    },
    {
      name: 'gap:sessions:select',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/hosts/thor/sessions/disposition' ? applyDispo(st, w) : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        await page.tap('.vl-page[data-active] .vc-fold')
        await page.waitFor(`!!document.querySelector('${row(BOARD_IDS.done2)}')`, { message: 'the done fold did not open' })
        const bar = () => page.eval(() => (document.querySelector('.vc-selbar')?.textContent ?? '').replace(/\s+/g, ' ').trim())
        await hold(page, `${row(BOARD_IDS.closed)} .vc-front`)
        await page.waitFor(() => document.querySelector('.vc-selbar'), { message: 'a long press did not start picking' })
        t.check(/1 picked/.test(await bar()), `the pick bar reads "${await bar()}"`)
        t.check((await page.eval(() => document.querySelectorAll('.vc-check').length)) >= 4, 'the rows did not turn into check boxes')
        t.check(!page.writes.length, 'a long press sent something')
        await page.tap(`${row(BOARD_IDS.zeta)} .vc-front`)
        await page.waitFor(() => /2 picked/.test(document.querySelector('.vc-selbar')?.textContent ?? ''), { message: 'a tap did not add the second row' })
        await page.tap(`${row(BOARD_IDS.done2)} .vc-front`)
        await page.waitFor(() => /Undo 1/.test(document.querySelector('.vc-selbar')?.textContent ?? '') && /Mark 2 done/.test(document.querySelector('.vc-selbar')?.textContent ?? ''), { message: 'a done row in the pick did not offer Undo beside Mark done' })
        await t.shot(page, 'mixed')
        await page.tap('.vc-selbar-btn[data-main]')
        const w = await waitW(page, 1)
        t.check(sameSet(w.json?.sessionIds, [BOARD_IDS.closed, BOARD_IDS.zeta]) && w.json?.disposition === 'done', `Mark done sent ${w.body}, want the two open rows in one call`)
        await page.waitFor(() => !document.querySelector('.vc-selbar') && /Done: 2 sessions/.test(document.querySelector('.vc-undo')?.textContent ?? ''), { message: 'no Undo bar for the two marked rows' })
        await sleep(400)
        t.check(page.writes.length === 1, `Mark done sent ${page.writes.length} writes`)
      },
    },
    {
      name: 'gap:sessions:terminals',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        // the pane reattached at the end: the v2 terminal tries its socket, which the fence refuses
        t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b2&/)
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite((w) => {
          const m = /^\/api\/terminal\/sessions\/(vk-[0-9a-f]{10})\/kill$/.exec(w.path)
          if (w.method !== 'POST' || !m) return undefined
          st.panes = st.panes.filter((p) => p.name !== m[1])
          return ok({ killed: true })
        })
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const terms = await page.eval(() => [...document.querySelectorAll('section[data-g="terms"] .vc-term .vc-row-title')].map((e) => e.textContent))
        t.check(terms.join(',') === 'E2E shell,E2E pane', `Open terminals lists ${terms.join(', ')}, want both panes oldest first`)
        await page.tap('.vc-term-x[aria-label="Close E2E shell"]')
        await page.waitFor(() => /Close\?/.test(document.querySelector('.vc-term-x[data-armed]')?.textContent ?? ''), { message: 'the first tap did not arm Close' })
        t.check(!page.writes.length, 'the first tap on Close already closed the pane')
        await sleep(4400)
        t.check(await page.eval(() => !document.querySelector('.vc-term-x[data-armed]')), 'Close stayed armed after 4 s')
        await page.tap('.vc-term-x[aria-label="Close E2E shell"]')
        await page.tap('.vc-term-x[aria-label="Close E2E shell now"]')
        const w = await waitW(page, 1)
        t.check(w.path === '/api/terminal/sessions/vk-e2e00000b1/kill', `Close sent ${w.method} ${w.path}`)
        await page.waitToast(/Closed "E2E shell"/)
        await page.waitFor(() => document.querySelectorAll('section[data-g="terms"] .vc-term').length === 1, { message: 'the closed pane stayed listed' })
        await page.tap({ sel: '.vc-term-main', text: 'E2E pane' })
        await page.waitPath('/m/ai/term/vk-e2e00000b2', 8000)
        t.check(!(await page.blockedNav()).length, 'reattach headed for the classic terminal')
      },
    },
    {
      name: 'gap:sessions:stop-all',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite(async (w) => {
          if (w.method !== 'POST') return undefined
          await sleep(250)
          const m = /^\/api\/terminal\/sessions\/(vk-[0-9a-f]{10})\/kill$/.exec(w.path)
          if (m) {
            st.panes = st.panes.filter((p) => p.name !== m[1])
            return ok({ killed: true })
          }
          if (w.path === '/api/hosts/thor/stop') {
            for (const s of st.board.sessions) if (s.sessionId === w.json?.sessionId) { s.live = false; s.activity = 'closed'; s.onDesk = false }
            return ok({ ok: true })
          }
          return undefined
        })
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const btn = 'section[data-g="live"] .vc-ghead-act[data-tone="acc2"]'
        await page.waitFor(`/Stop all 3/.test(document.querySelector('${btn}')?.textContent ?? '')`, { message: 'no "Stop all 3" on Live (one live session and two panes)' })
        await page.tap(btn)
        await page.waitFor(`/Stop all 3\\?/.test(document.querySelector('${btn}')?.textContent ?? '')`, { message: 'the first tap did not arm Stop all' })
        await sleep(300)
        t.check(!page.writes.length, 'the first tap on Stop all already stopped something')
        await t.shot(page, 'armed')
        await page.tap(btn)
        await waitW(page, 3, 8000)
        await page.waitToast(/Stopped 3/)
        const order = page.writes.map((w) => w.path)
        t.check(JSON.stringify(order) === JSON.stringify(['/api/terminal/sessions/vk-e2e00000b1/kill', '/api/terminal/sessions/vk-e2e00000b2/kill', '/api/hosts/thor/stop']), `the sweep went ${order.join(', ')}, want the panes first, then the session`)
        t.check(page.writes[2]?.json?.sessionId === BOARD_IDS.live, `Stop sent ${page.writes[2]?.body}`)
        const gaps = page.writes.slice(1).map((w, i) => w.at - page.writes[i].at)
        t.check(gaps.every((g) => g >= 230), `a stop went out before the one before it was answered (gaps ${gaps.join(', ')} ms)`)
      },
    },
    {
      name: 'gap:sessions:search',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        await page.tap('.vl-page[data-active] .vc-find')
        await page.waitFor(() => document.activeElement?.getAttribute('aria-label') === 'Search sessions', { message: 'the search plate did not open a focused search line' })
        const titles = () => page.eval(() => [...document.querySelectorAll('section[data-g="results"] .vc-row-title')].map((e) => e.textContent))
        // by folder: only the full board carries it
        await page.type('zeta')
        await page.waitFor(() => /E2E notes cleanup/.test(document.querySelector('section[data-g="results"]')?.textContent ?? ''), { message: 'searching a folder name found nothing' })
        t.check((await titles()).join(',') === 'E2E notes cleanup', `"zeta" found ${(await titles()).join(', ')}`)
        // by title, every word must match, done rows included
        await page.eval(setValue, '.vc-search input', 'done two')
        await page.waitFor(() => /E2E done two/.test(document.querySelector('section[data-g="results"]')?.textContent ?? ''), { message: 'search does not cover the done list' })
        t.check((await titles()).join(',') === 'E2E done two', `"done two" found ${(await titles()).join(', ')} (every word must match)`)
        await t.shot(page, 'results')
        await page.key('Escape')
        await page.waitFor(() => !document.querySelector('.vc-search') && document.querySelector('.vc-findrow') && !document.querySelector('section[data-g="results"]'), { message: 'Escape did not close the search back to the plates' })
      },
    },
    {
      name: 'gap:sessions:on-screen',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/hosts/thor/launch' ? ok({ ok: true }) : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        await page.tap(`${row(BOARD_IDS.closed)} .vc-front`)
        await page.waitFor(`[...document.querySelectorAll('${row(BOARD_IDS.closed)} .vc-strip .vc-sact')].some((b) => /On screen/.test(b.textContent))`, { message: 'the recent row has no On screen beside Open' })
        await page.tap({ sel: `${row(BOARD_IDS.closed)} .vc-strip .vc-sact`, text: 'On screen' })
        const w = await waitW(page, 1)
        t.check(w.json?.sessionId === BOARD_IDS.closed && w.json?.cwd === '', `On screen sent ${w.body}, want the session to resume on thor`)
        await page.waitToast(/Opened "E2E closed session" on .+'s screen/)
        t.check((await page.path()) === '/m/ai/sessions' && !(await page.blockedNav()).length, 'On screen headed for the in-page terminal')
      },
    },
    {
      name: 'gap:sessions:on-screen-hover',
      group: 'gaps',
      device: 'desktop',
      timeout: 45_000,
      async run(t) {
        const st = sessionsState()
        const page = await t.page()
        sessionsBackend(page, st)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/hosts/thor/launch' ? ok({ ok: true }) : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const acts = await page.eval((sel) => [...document.querySelectorAll(`${sel} .vc-hover-acts .vc-hact`)].map((b) => b.textContent.trim()), row(BOARD_IDS.closed))
        t.check(acts.includes('On screen'), `the recent row's hover actions are ${JSON.stringify(acts)}, want On screen without opening the row`)
        // the hover bar takes the pointer only under hover, so the point reads as the row until the mouse is there
        await page.tap({ sel: `${row(BOARD_IDS.closed)} .vc-hover-acts .vc-hact`, text: 'On screen' }, { allowCovered: true })
        const w = await waitW(page, 1)
        t.check(w.json?.sessionId === BOARD_IDS.closed && w.json?.cwd === '', `hover On screen sent ${w.body}, want the session to resume on thor`)
        await page.waitToast(/Opened "E2E closed session" on .+'s screen/)
        t.check((await page.path()) === '/m/ai/sessions' && !(await page.blockedNav()).length, 'hover On screen headed for the in-page terminal')
      },
    },
  ]
}

// ---------- AI > Projects: a project's detail ----------

function projectTests() {
  return [{
    name: 'gap:projects:detail',
    group: 'gaps',
    device: 'phone',
    timeout: 60_000,
    async run(t) {
      const st = { ...sessionsState(), proj: projState() }
      const doc = st.proj.doc
      const page = await t.page()
      sessionsBackend(page, st)
      page.mock(`/api/proj/${PROJ_ID}`, () => ok(doc))
      const base = `/api/proj/${PROJ_ID}`
      page.onWrite((w) => {
        const b = w.json ?? {}
        if (w.method === 'POST' && w.path === `${base}/tabs/tab-e2e1/items`) {
          const tab = doc.tabs[0]
          if (b.op === 'set') { const it = tab.items.find((x) => x.id === b.itemId); if (it) { it.done = b.done; it.doneAt = b.done ? new Date().toISOString() : null } }
          if (b.op === 'add') tab.items.push({ id: `it-e2e${tab.items.length + 1}`, text: b.text, done: false, doneAt: null })
          return ok(tab)
        }
        if (w.method === 'DELETE' && w.path === `${base}/reminders/rem-e2e1`) {
          doc.reminders[0].state = 'canceled'
          return ok({ ok: true })
        }
        if (w.method === 'POST' && w.path === `${base}/reminders`) {
          const r = { id: 'rem-e2e2', at: b.at, message: b.message, state: 'pending', createdBy: 'ui', createdAt: new Date().toISOString(), canceledAt: null }
          doc.reminders.push(r)
          return ok(r)
        }
        if (w.method === 'PATCH' && w.path === base) {
          Object.assign(doc.project, b)
          return ok(doc)
        }
        return undefined
      })
      await page.goto(`/m/ai/projects?p=${PROJ_ID}`)
      await shellUp(page)
      const root = '.vc-sheet'
      await page.waitFor((r) => document.querySelectorAll(`${r} .vc-task`).length === 2, { args: [root], timeout: 12_000, message: '?p= did not open the project with its two tasks' })
      t.check((await page.path()) === '/m/ai/projects', `?p= stayed in the address: ${await page.path()}`)
      await sleep(400)

      await t.step('tick a task', async () => {
        await page.tap({ sel: `${root} .vc-task`, text: 'First e2e task' })
        const w = await waitW(page, 1)
        t.check(w.path === `${base}/tabs/tab-e2e1/items` && w.json?.op === 'set' && w.json?.itemId === 'it-e2e1' && w.json?.done === true, `tick sent ${w.method} ${w.path} ${w.body}`)
        await page.waitFor((r) => document.querySelector(`${r} .vc-task[aria-checked="true"]`)?.textContent?.includes('First e2e task'), { args: [root], message: 'the ticked task did not show ticked' })
      })
      await t.step('add a task', async () => {
        await page.tap(`${root} .vc-addline input`)
        await page.type('Third e2e task')
        await page.tap({ sel: `${root} .vc-addline .vc-sact`, text: 'Add' })
        const w = await waitW(page, 2)
        t.check(w.json?.op === 'add' && w.json?.text === 'Third e2e task', `add sent ${w.body}`)
        await page.waitFor((r) => document.querySelector(`${r} .vc-addline input`)?.value === '' && [...document.querySelectorAll(`${r} .vc-task`)].some((e) => /Third e2e task/.test(e.textContent)), { args: [root], message: 'the new task did not show, or the line kept its text' })
      })
      await t.step('cancel a reminder: two taps', async () => {
        await page.tap(`${root} .vc-remrow .vc-term-x`)
        await page.waitFor((r) => /Cancel\?/.test(document.querySelector(`${r} .vc-remrow .vc-term-x`)?.textContent ?? ''), { args: [root], message: 'the first tap did not arm Cancel' })
        t.check(page.writes.length === 2, 'the first tap on Cancel already canceled')
        await page.tap(`${root} .vc-remrow .vc-term-x`)
        const w = await waitW(page, 3)
        t.check(w.method === 'DELETE' && w.path === `${base}/reminders/rem-e2e1`, `cancel sent ${w.method} ${w.path}`)
        await page.waitFor((r) => !document.querySelector(`${r} .vc-remrow`), { args: [root], message: 'the canceled reminder stayed' })
      })
      await t.step('add a reminder', async () => {
        await page.tap({ sel: `${root} .vc-ghead-act`, text: 'Add reminder' })
        await page.waitFor((r) => document.activeElement === document.querySelector(`${r} .vc-remform input[aria-label="Reminder text"]`), { args: [root], message: 'the form did not open with its text field focused' })
        await page.type('E2E new reminder')
        const d = new Date(Date.now() + 86_400_000)
        const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:30`
        await page.eval(setValue, `${root} .vc-field-when`, local)
        await page.tap(`${root} .vc-remform .vc-sact[data-main]`)
        const w = await waitW(page, 4)
        t.check(w.path === `${base}/reminders` && w.json?.message === 'E2E new reminder', `add reminder sent ${w.path} ${w.body}`)
        t.check(w.json?.at === new Date(local).toISOString(), `the reminder time went as ${w.json?.at}, want ${new Date(local).toISOString()} (9:30 local tomorrow)`)
        await page.waitToast(/Reminder set for/)
      })
      await t.step('edit the next action: only what changed is sent', async () => {
        await page.tap({ sel: `${root} .vc-pd-links .vl-link`, text: 'Edit' })
        await page.waitFor((r) => document.querySelector(`${r} .vc-edit`), { args: [root], message: 'Edit did not open the form' })
        await page.eval(setValue, `${root} .vc-edit .vc-flabel:nth-child(2) input`, 'Write the e2e test now')
        await page.tap(`${root} .vc-edit-save`)
        const w = await waitW(page, 5)
        t.check(w.method === 'PATCH' && w.path === base && JSON.stringify(w.json) === JSON.stringify({ nextAction: 'Write the e2e test now' }), `edit sent ${w.method} ${w.path} ${w.body}`)
        await page.waitToast(/Saved E2E Project/)
        await page.waitFor((r) => !document.querySelector(`${r} .vc-edit`), { args: [root], message: 'the form stayed open after Save' })
      })
      await t.shot(page, 'detail')
      t.check(page.writes.length === 5, `${page.writes.length} writes, want 5`)
    },
  }]
}

// ---------- Dashboard: the tracker and the calendar ----------

function trackerBackend(page, st) {
  quietThor(page)
  page.mock(/^\/api\/(supplements|exercise|sf)\/day$/, ({ path, query }) => ok(trackerWindow(st.tracker, path.split('/')[2], query.date, query.today)))
  page.mock('/api/daily/streak', ({ query }) => ok({ today: query.today, streak: st.tracker.streak }))
  page.mock(/^\/api\/(supplements|exercise|sf)\/skips$/, () => ok({ skips: st.skips }))
  page.onWrite((w) => {
    const b = w.json ?? {}
    const m = /^\/api\/(supplements|exercise|sf)\/(log|skip)$/.exec(w.path)
    if (!m) return undefined
    const [, tr, kind] = m
    if (kind === 'log') {
      st.tracker.taken[tr][b.target] = b.taken ? new Date().toISOString() : ''
      return ok(trackerWindow(st.tracker, tr, b.date, b.today))
    }
    st.skips = b.skipped ? [...new Set([...st.skips, b.target])].sort() : st.skips.filter((s) => s !== b.target)
    if (b.skipped) st.tracker.taken[tr][b.target] = ''
    return ok({ skips: st.skips })
  })
}

const tile = (name) => `(() => [...document.querySelectorAll('.vl-page[data-active] .hm-tick')].find((e) => /${name}/.test(e.getAttribute('aria-label') || '')))()`
const label = (name) => `(${tile(name)}?.getAttribute('aria-label') ?? '')`

function dashboardTests() {
  return [
    {
      name: 'gap:tracker:step-days',
      group: 'gaps',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const st = { tracker: trackerState(), skips: [] }
        const page = await t.page()
        trackerBackend(page, st)
        await page.goto('/m/dashboard')
        const d = today()
        const y = shiftKey(d, -1)
        const y2 = shiftKey(d, -2)
        await page.waitFor(`/today: not done/.test(${label('Supplements')}) && !${tile('Supplements')}.disabled`, { timeout: 15_000, message: 'the tracker never read today' })
        // one day back
        await page.tap({ sel: '.vl-page[data-active] .hm-step-btn', index: 0 })
        await page.waitFor(`/yesterday: done/.test(${label('Supplements')})`, { message: 'stepping back did not show yesterday' })
        t.check(/Yesterday/i.test(await page.eval(() => document.querySelector('.vl-page[data-active] .hm-step-day')?.textContent ?? '')), 'the day label is not Yesterday')
        t.check(await page.eval(() => !!document.querySelector('.vl-page[data-active] .hm-tr-back')), 'no way back to today')
        const alt = await page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .hm-tick-alt')].map((e) => e.textContent).join(' | '))
        t.check(/Today: not yet/.test(alt), `the other-day line reads "${alt}", want today's state`)
        // untick yesterday: through today's window
        await page.tap({ sel: '.vl-page[data-active] .hm-tick', text: /Supplements/ })
        const w1 = await waitW(page, 1)
        t.check(w1.path === '/api/supplements/log' && w1.json.target === y && w1.json.taken === false && w1.json.date === d && w1.json.today === d, `untick yesterday sent ${w1.path} ${w1.body}`)
        await page.waitFor(`/yesterday: not done/.test(${label('Supplements')})`, { message: 'the untick did not show' })
        await page.waitToast(/Supplements unticked for yesterday/)
        // two days back reads its own window
        await page.tap({ sel: '.vl-page[data-active] .hm-step-btn', index: 0 })
        await page.waitFor(`/(Fri|Sat|Sun|Mon|Tue|Wed|Thu) \\d+: not done/i.test(${label('Supplements')}) && !${tile('Supplements')}.disabled`, { timeout: 8000, message: 'two days back never showed' })
        t.check(page.api.some((r) => r.path === '/api/supplements/day' && r.url.includes(`date=${y2}`)), 'no read of the window two days back')
        await page.tap({ sel: '.vl-page[data-active] .hm-tick', text: /Supplements/ })
        const w2 = await waitW(page, 2)
        t.check(w2.json.target === y2 && w2.json.taken === true && w2.json.date === y2 && w2.json.today === d, `tick two days back sent ${w2.body}`)
        await page.waitFor(`/: done/.test(${label('Supplements')})`, { message: 'the tick two days back did not show' })
        await sleep(400)
        t.check(/: done/.test(await page.eval(label('Supplements'))), 'the tick two days back did not hold after it landed')
        await t.shot(page, 'away')
        // back to today; the other-day line ticks yesterday without stepping
        await page.tap({ sel: '.vl-page[data-active] .hm-tr-back' })
        await page.waitFor(`/today: not done/.test(${label('Supplements')})`, { message: 'Back to today did not' })
        t.check(await page.eval(() => !document.querySelector('.vl-page[data-active] .hm-tr-back')), 'Back to today still shows on today')
        await page.tap({ sel: '.vl-page[data-active] .hm-tick-alt', text: /Supplements/ })
        const w3 = await waitW(page, 3)
        t.check(w3.json.target === y && w3.json.taken === true && w3.json.date === d, `the other-day line sent ${w3.body}`)
        await page.waitFor(() => /Yesterday: done/.test([...document.querySelectorAll('.vl-page[data-active] .hm-tick-alt')][0]?.textContent ?? ''), { message: 'the other-day line did not show done' })
        await page.waitToast(/Supplements done for yesterday/)
        t.check(page.writes.length === 3, `${page.writes.length} writes, want 3`)
      },
    },
    {
      name: 'gap:tracker:hold-skip',
      group: 'gaps',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const st = { tracker: trackerState(), skips: [] }
        const page = await t.page()
        trackerBackend(page, st)
        await page.goto('/m/dashboard')
        const d = today()
        await page.waitFor(`/today: not done/.test(${label('Exercise')}) && !${tile('Exercise')}.disabled`, { timeout: 15_000, message: 'Exercise never read today' })
        await hold(page, { sel: '.vl-page[data-active] .hm-tick', text: /Exercise/ }, 800)
        const w1 = await waitW(page, 1)
        t.check(w1.path === '/api/exercise/skip' && w1.json.target === d && w1.json.skipped === true, `the hold sent ${w1.path} ${w1.body}`)
        await sleep(600)
        t.check(page.writes.length === 1, `the hold also sent ${page.writes.slice(1).map((w) => `${w.path} ${w.body}`).join(', ')}`)
        const state = () => page.eval(() => [...document.querySelectorAll('.vl-page[data-active] .hm-tick')].find((e) => /Exercise/.test(e.getAttribute('aria-label') || ''))?.textContent ?? '')
        await page.waitFor(`/Skipped/.test((${tile('Exercise')})?.textContent ?? '')`, { message: 'Exercise never read Skipped' })
        await page.waitToast(/Exercise skipped/)
        await t.shot(page, 'skipped')
        await page.tap({ sel: '.vl-toast-btn', text: /Undo/ })
        const w2 = await waitW(page, 2)
        t.check(w2.path === '/api/exercise/skip' && w2.json.skipped === false, `Undo sent ${w2.body}`)
        await page.waitFor(`!/Skipped/.test((${tile('Exercise')})?.textContent ?? '')`, { message: `Undo did not take the skip back (${await state()})` })
        // a plain tap still ticks at once
        await page.tap({ sel: '.vl-page[data-active] .hm-tick', text: /Exercise/ })
        const w3 = await waitW(page, 3)
        t.check(w3.path === '/api/exercise/log' && w3.json.taken === true, `a tap sent ${w3.path} ${w3.body}`)
      },
    },
    {
      name: 'gap:calendar:sheet',
      group: 'gaps',
      device: 'phone',
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        await page.goto('/m/dashboard')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .hm-cal .hm-g-press'), { timeout: 12_000, message: 'no Calendar block on the Dashboard' })
        await page.tap({ sel: '.vl-page[data-active] .hm-cal .hm-g-press' })
        await page.waitFor(() => document.querySelector('.cal-root[data-shown] .cal-ui[data-layout="sheet"] .cal-g[data-cols="1"]'), { timeout: 12_000, message: 'the Calendar block did not open the day view' })
        await sleep(500)
        const date = () => page.eval(() => document.querySelector('.cal-root .cal-bar-date')?.textContent)
        const d0 = await date()
        await page.tap({ sel: '.cal-root .cal-bar .cal-step', index: 1 })
        await sleep(400)
        const d1 = await date()
        t.check(d0 !== d1, `the next-day step did not change the date (${d0})`)
        t.check(await page.eval(() => /Tomorrow/i.test(document.querySelector('.cal-root .cal-bar-rel')?.textContent ?? '')), 'the next day does not read Tomorrow')
        await page.swipe(300, 600, 60, 610)
        await sleep(500)
        t.check((await date()) !== d1, 'a swipe on the day did not step it')
        t.check((await page.path()) === '/m/dashboard', 'the swipe paged the tab instead of the day')
        await page.tap({ sel: '.cal-root .cal-bar .cal-today' })
        await page.waitFor((d) => document.querySelector('.cal-root .cal-bar-date')?.textContent === d, { args: [d0], message: 'Today did not come back to today' })
        await page.tap({ sel: '.cal-root .cal-tabs .cal-tab', text: /Agenda/ })
        await page.waitFor(() => document.querySelector('.cal-root .cal-agenda'), { timeout: 10_000, message: 'no agenda view' })
        await t.shot(page, 'agenda')
        await page.tap({ sel: '.cal-head .cal-close' })
        await page.waitFor(() => !document.querySelector('.cal-root'), { timeout: 3000, message: 'the sheet did not close' })
        t.check(!page.writes.length, 'the calendar wrote something')
      },
    },
  ]
}

// ---------- Settings and System ----------

function settingsTests() {
  return [
    {
      name: 'gap:settings:hero-slop',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        await page.goto('/m/settings')
        await page.waitFor(() => document.querySelector('.vl-set .st-plate'), { timeout: 12_000, message: 'Settings did not render' })
        await page.tap('.vl-set .vl-seg-cell[aria-label="Phone"]')
        await sleep(400)
        t.check((await page.eval(() => localStorage.getItem('v2.hero'))) === 'phone', 'Hero > Phone was not stored')
        t.check(await page.eval(() => document.querySelector('.st-hero-slot [data-hero]')?.getAttribute('data-hero') === 'phone'), 'the gutter hero is not the phone')
        await t.shot(page, 'hero')
        await page.tap({ sel: '.vl-set .st-row-act', text: /Open classic Slop/ })
        await page.waitPath('/slop')
        t.check(!page.writes.length, 'Settings wrote something')
      },
    },
    {
      name: 'gap:hosts:model-only',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const page = await t.page()
        quietThor(page)
        // odin's hosts without the phone and tablet: once they report (routes/devices.ts) they are hosts, not model-only rows
        const doc = await hostsDoc(t.env.base, false)
        page.mock('/api/hosts', () => ({ status: 200, body: doc }))
        await page.goto('/m/system/hosts')
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .sys-device'), { timeout: 12_000, message: 'no model-only device rows on System > Hosts' })
        await page.tap({ sel: '.vl-page[data-active] .sys-device', text: /Tablet/ })
        await page.waitFor(() => document.querySelector('.vl-page[data-active] .sys-device-detail [data-hero="tablet"]'), { message: 'the tablet row did not show its model' })
        const txt = await page.eval(() => document.querySelector('.vl-page[data-active] .sys-device-detail')?.textContent ?? '')
        t.check(!/\d+%/.test(txt), `a device that reports nothing shows a number: ${txt}`)
        await t.shot(page, 'tablet')
        t.check(!page.writes.length, 'System > Hosts wrote something')
      },
    },
  ]
}

// ---------- Lights: Custom color ----------

/** One color pick in the browser's picker: previews while it moves, then a burst of change events. */
function pickColor(sel, values) {
  const el = document.querySelector(sel)
  if (!el) return Promise.resolve({ error: `no ${sel}` })
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    set.call(el, values[0])
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(80)
    const preview = el.closest('[data-pick]') !== null
    for (const v of values) {
      set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(120)
    }
    return { preview }
  })()
}

function lightsTests() {
  return [
    {
      name: 'gap:lights:custom-color',
      group: 'gaps',
      device: 'phone',
      timeout: 45_000,
      async run(t) {
        const st = { lights: lightsState() }
        const page = await t.page()
        quietThor(page)
        page.mock('/api/lights', () => ok(st.lights))
        page.mock('/api/hosts/thor/rgb', () => ok(rgbState('dark')))
        page.onWrite((w) => {
          if (w.method !== 'POST' || w.path !== '/api/lights/turn') return undefined
          applyLight(st.lights, w.json)
          return ok({ ok: true })
        })
        await page.goto('/m/lights')
        await shellUp(page)
        await t.step('one bulb: the strip\'s Custom swatch sends once per pick', async () => {
          await page.waitFor(() => document.querySelector('.lt-bulb-id[aria-label="Desk color"]'), { timeout: 12_000, message: 'no lit Desk row' })
          await page.tap('.lt-bulb-id[aria-label="Desk color"]')
          await page.waitFor(() => document.querySelector('.lt-strip .lt-sw-custom .lt-cin'), { message: 'the Desk strip has no Custom swatch' })
          const r = await page.eval(pickColor, '.lt-strip .lt-sw-custom .lt-cin', ['#203040', '#406080', '#1e90ff'])
          t.check(r.preview, 'the swatch did not preview the color while the picker moved')
          t.check(page.writes.length === 0, `the picker sent ${page.writes.length} command(s) while it was still moving`)
          const w = await waitW(page, 1, 3000)
          t.check(w.json?.entity_id === 'light.e2e_desk' && w.json?.state === 'on' && w.json?.brightness === 128 && JSON.stringify(w.json?.rgb_color) === '[30,144,255]', `the pick sent ${w.body}, want the last color at the bulb's own level`)
          await sleep(900)
          t.check(page.writes.length === 1, `one pick sent ${page.writes.length} commands`)
          await page.waitFor(() => document.querySelector('.lt-strip .lt-sw-custom[data-on]') && !document.querySelector('.lt-strip .lt-sw-custom[data-pick]'), { message: 'the Custom swatch is not the lit one after the pick landed' })
          await t.shot(page, 'bulb')
        })
        await t.step('the room: the Custom plate colors every lit bulb, no brightness', async () => {
          const r = await page.eval(pickColor, '.lt-pre-custom .lt-cin', ['#c040ff', '#ff2080'])
          t.check(r.preview, 'the Custom plate did not preview the color')
          const w = await waitW(page, 2, 3000)
          t.check(JSON.stringify(w.json?.entity_id) === '["light.e2e_desk"]' && w.json?.state === 'on' && JSON.stringify(w.json?.rgb_color) === '[255,32,128]' && w.json?.brightness === undefined, `the room pick sent ${w.body}`)
          await page.waitFor(() => document.querySelector('.lt-pre-custom[data-on]'), { message: 'the Custom plate did not light for a color no preset matches' })
          await sleep(700)
          t.check(page.writes.length === 2, `${page.writes.length} commands for two picks`)
        })
        await t.step('nothing lit: Custom says why, sends nothing', async () => {
          const p2 = await t.page()
          quietThor(p2)
          const dark = lightsState().map((l) => ({ ...l, on: false, brightness: null, rgb_color: null, color_mode: null }))
          p2.mock('/api/lights', () => ok(dark))
          p2.mock('/api/hosts/thor/rgb', () => ok(rgbState('dark')))
          await p2.goto('/m/lights')
          await shellUp(p2)
          await p2.waitFor(() => document.querySelector('.lt-pres[data-idle] .lt-pre-custom'), { timeout: 12_000, message: 'the presets did not go idle with every light off' })
          const since = Date.now()
          await p2.tap('.lt-pre-custom')
          await p2.waitToast(/Turn a light on first/, { since })
          t.check(!p2.writes.length, 'an idle Custom plate sent something')
        })
      },
    },
  ]
}

// ---------- Media: the apps ----------

function mediaTests() {
  return [{
    name: 'gap:media:apps',
    group: 'gaps',
    device: 'phone',
    timeout: 40_000,
    async run(t) {
      const page = await t.page()
      quietThor(page)
      await page.goto('/m/media/dashboard')
      await shellUp(page)
      await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] .vm-dhead .vm-app').length === 2, { timeout: 12_000, message: 'no Open Plex and Spotify at the top of the Media dashboard' })
      const apps = await page.eval(() => {
        const head = document.querySelector('.vl-page[data-active] .vm-dhead')
        return {
          first: head?.parentElement?.firstElementChild === head,
          top: head?.getBoundingClientRect().top ?? 9999,
          hero: document.querySelector('.vl-page[data-active] .vm-side')?.getBoundingClientRect().top ?? 0,
          links: [...head.querySelectorAll('.vm-app')].map((a) => ({ label: a.textContent.trim(), href: a.getAttribute('href'), target: a.target, rel: a.rel })),
        }
      })
      t.check(apps.first && apps.top <= apps.hero, 'the app links are not the first thing on the Media dashboard')
      t.check(JSON.stringify(apps.links.map((l) => l.label)) === '["Open Plex","Spotify"]', `the links read ${apps.links.map((l) => l.label).join(', ')}`)
      t.check(apps.links[0]?.href === 'https://app.plex.tv/desktop' && apps.links[1]?.href === 'https://open.spotify.com', `the web fallbacks are ${apps.links.map((l) => l.href).join(', ')}`)
      t.check(apps.links.every((l) => l.target === '_blank' && /noreferrer/.test(l.rel)), 'a link opens in place or leaks the referrer')
      await t.shot(page, 'apps')
    },
  }]
}

export function gapTests() {
  return [...sessionTests(), ...projectTests(), ...dashboardTests(), ...settingsTests(), ...lightsTests(), ...mediaTests()]
}
