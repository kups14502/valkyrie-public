// SESSIONS: AI > Sessions after round 5, against a fake board (every write
// answered in the browser).
//
//   grouped      Recent is the whole list, grouped by area in the classic
//                board's order (work, the host-defined areas by name, server,
//                personal, no area last), each group folding and the fold kept
//                across a reload; a row inside a group does not repeat its area;
//                the Sessions tab carries no projects at all (no glance, no
//                third column), on the phone and on a monitor
//   sheet        the desktop app's New session offers inside Valkyrie first and
//                by default (thor's screen beside it, and this screen when the
//                app runs off thor), every target on a wide screen, and a plate
//                opens the in-page terminal; this screen goes through the app's
//                own SSH command, never an HTTP write
//   open         a row's Open in the desktop app resumes inside Valkyrie, with
//                New window and thor's screen as the second ways in

import { sleep } from '../lib/cdp.mjs'
import { ODIN_TARGETS, PROJ_ID, SESSION_HOSTS, TARGETS, projList, projState, quietThor, termOpened } from '../lib/fixtures.mjs'
import { tauriCallsFull, tauriStub } from '../lib/tauri.mjs'

const ok = (body) => ({ status: 200, body })
const iso = (ms) => new Date(ms).toISOString()
const TERM_NAME = 'vk-e2e0000a01'
const NEW_PANE_WS = /\/ws\/terminal\?s=vk-e2e0000a01&/

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

/** A session id the e2e suite owns: 0e2e... with a running number. */
const sid = (n) => `0e2e0000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`

/**
 * A board spread over every kind of area: work 2, a host-defined area 2,
 * server 1, personal 12 (more than the old 8-row Recent showed), one with no
 * area, one live session and one done.
 */
function areaBoard() {
  const now = Date.now()
  let n = 0
  const row = (area, title, { live = false, done = false, ago = 3_600_000 } = {}) => ({
    sessionId: sid(++n), title, titleFromClaude: true, project: `e2e-${area || 'none'}`, area, launchGroup: null, host: 'thor', cwd: null,
    lastActivityUtc: iso(now - ago - n * 60_000), bytes: 1000, live, onDesk: live, activity: live ? 'working' : 'closed',
    disposition: done ? 'done' : 'open', resumeCommand: `claude --resume ${sid(n)}`,
  })
  const sessions = [
    row('personal', 'E2E live one', { live: true, ago: 10_000 }),
    row('work', 'E2E work one'), row('work', 'E2E work two'),
    row('e2e-client', 'E2E client one'), row('e2e-client', 'E2E client two'),
    row('server', 'E2E server one'),
    ...Array.from({ length: 12 }, (_, k) => row('personal', `E2E personal ${k + 1}`)),
    row('', 'E2E no area'),
    row('personal', 'E2E done one', { done: true }),
  ]
  return { sessions, hookRunsSkipped: 0 }
}

function boardBackend(page, board, { proj = true } = {}) {
  quietThor(page)
  page.mock('/api/session-board', () => ok(board))
  page.mock('/api/hosts/thor/sessions', () => ok(board))
  page.mock('/api/terminal/sessions', () => ok([]))
  page.mock('/api/terminal/odin-targets', () => ok(ODIN_TARGETS))
  page.mock('/api/session-hosts', () => ok(SESSION_HOSTS))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  const st = projState()
  page.mock('/api/proj', () => ok(proj ? projList(st) : []))
  page.mock(`/api/proj/${PROJ_ID}`, () => ok(st.doc))
  page.mock('/api/proj-areas', () => ok({ areas: ['personal', 'server'], mixable: ['personal', 'server'] }))
}

async function boardUp(page) {
  await shellUp(page)
  await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] section.vc-group[data-g="recent"]').length >= 5, { timeout: 15_000, message: 'the fake board\'s area groups did not render' })
  await sleep(700)
}

function groupsRead() {
  const root = document.querySelector('.vl-page[data-active]')
  return {
    caption: (root.querySelector('.vc-sec')?.textContent || '').replace(/\s+/g, ' ').trim(),
    groups: [...root.querySelectorAll('section.vc-group[data-g="recent"]')].map((s) => ({
      area: s.getAttribute('data-area'),
      folded: s.hasAttribute('data-folded'),
      rows: s.querySelectorAll('.vc-item').length,
      more: !!s.querySelector('.vc-showmore'),
      chips: s.querySelectorAll('.vc-item .vc-area').length,
      head: (s.querySelector('.vc-ghead')?.textContent || '').replace(/\s+/g, ' ').trim(),
    })),
    live: root.querySelectorAll('section.vc-group[data-g="live"] .vc-item').length,
    glance: !!root.querySelector('.vc-glance'),
    detail: !!root.querySelector('.vc-detail') || !!root.querySelector('.vc[data-detail]'),
    projText: /E2E Project/.test(root.innerText || ''),
  }
}

function groupedTests() {
  const out = []
  for (const device of ['phone', 'desk1080']) {
    out.push({
      name: `sess:grouped:${device}`,
      group: 'sessions',
      device,
      timeout: 60_000,
      async run(t) {
        const page = await t.page()
        boardBackend(page, areaBoard())
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        let r = await page.eval(groupsRead)
        t.check(/^Recent\s*18(?!\d)/.test(r.caption), `the Recent caption reads "${r.caption}", want Recent 18`)
        t.check(JSON.stringify(r.groups.map((g) => g.area)) === JSON.stringify(['work', 'e2e-client', 'server', 'personal', 'other']),
          `Recent's groups run ${JSON.stringify(r.groups.map((g) => g.area))}, want the classic order work, the host-defined area, server, personal, then no area`)
        const personal = r.groups.find((g) => g.area === 'personal')
        t.check(personal?.rows === 12 && !personal.more, `personal shows ${personal?.rows} of its 12 rows${personal?.more ? ' behind "Show more"' : ''}: the list is the page now`)
        t.check(r.groups.every((g) => g.chips === 0), `rows inside an area group repeat its area: ${r.groups.filter((g) => g.chips).map((g) => g.area).join(', ')}`)
        t.check(r.live === 1, `${r.live} row(s) under Live, want the live session`)
        t.check(!r.glance && !r.detail && !r.projText, `the Sessions tab still carries projects (glance ${r.glance}, third column ${r.detail}, a project name ${r.projText})`)
        await t.shot(page, 'groups')

        await t.step('a group folds, and stays folded after a reload', async () => {
          await page.tap('.vl-page[data-active] section.vc-group[data-area="personal"] .vc-ghead-fold')
          await page.waitFor(() => {
            const s = document.querySelector('.vl-page[data-active] section.vc-group[data-area="personal"]')
            return s?.hasAttribute('data-folded') && !s.querySelector('.vc-item')
          }, { message: 'the personal group did not fold' })
          const kept = await page.eval(() => localStorage.getItem('v2.claude.folded'))
          t.check(/area:personal/.test(kept ?? ''), `the fold was not remembered (${kept})`)
          await page.goto('/m/ai/sessions')
          await boardUp(page)
          r = await page.eval(groupsRead)
          const p = r.groups.find((g) => g.area === 'personal')
          t.check(p?.folded && p.rows === 0, 'personal came back unfolded after a reload')
          t.check(r.groups.filter((g) => g.area !== 'personal').every((g) => !g.folded && g.rows > 0), 'another group folded with it')
          await page.tap('.vl-page[data-active] section.vc-group[data-area="personal"] .vc-ghead-fold')
          await page.waitFor(() => document.querySelectorAll('.vl-page[data-active] section.vc-group[data-area="personal"] .vc-item').length === 12, { message: 'personal did not unfold to its 12 rows' })
        })
        t.check(!page.writes.length, `AI > Sessions wrote ${page.writes.length} time(s)`)
      },
    })
  }
  return out
}

// ---------- the desktop app's New session sheet ----------

async function openPicker(page) {
  await page.waitFor(() => !!(document.querySelector('.vl-page[data-active] .vc-fab') || document.querySelector('.vl-page[data-active] .vc-new')), { timeout: 12_000, message: 'no New session button' })
  const sel = await page.eval(() => (document.querySelector('.vl-page[data-active] .vc-new') ? '.vl-page[data-active] .vc-new' : '.vl-page[data-active] .vc-fab'))
  await page.tap(sel)
  await page.waitFor(() => [...document.querySelectorAll('.vc-sheet .vc-plate')].some((e) => /^\s*Alpha\s*$/.test(e.textContent || '') && !e.disabled), { timeout: 10_000, message: 'the picker has no Alpha plate' })
  await sleep(450)
}

function thorSection() {
  const host = [...document.querySelectorAll('.vc-sheet .vc-host')].find((h) => /thor/i.test(h.querySelector('.vc-host-name')?.textContent || ''))
  if (!host) return null
  return {
    how: (host.querySelector('.vc-host-how')?.textContent || '').trim(),
    ways: [...host.querySelectorAll('.vc-way [role="radio"]')].map((r) => ({ label: (r.textContent || '').trim(), on: r.getAttribute('aria-checked') === 'true' })),
    plates: [...host.querySelectorAll('.vc-plate')].map((p) => (p.textContent || '').trim()),
  }
}

function sheetTests() {
  return [
    {
      name: 'sess:sheet:tauri-thor',
      group: 'sessions',
      device: 'desktop',
      timeout: 60_000,
      async run(t) {
        t.allowSockets.push(NEW_PANE_WS)
        const page = await t.page({ scripts: [tauriStub({ hostname: 'thor' })] })
        boardBackend(page, areaBoard())
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/terminal/sessions' ? { status: 201, body: termOpened(w.json) } : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        await openPicker(page)
        const s = await page.eval(thorSection)
        if (!t.check(s, 'the picker has no thor section')) return
        t.check(s.how === 'opens inside Valkyrie', `thor's section says "${s.how}", want "opens inside Valkyrie" (the desktop app offered only thor's screen)`)
        t.check(s.ways.length === 2 && s.ways[0].label === 'In Valkyrie' && s.ways[0].on && /^On .+'s screen$/.test(s.ways[1].label) && !s.ways[1].on,
          `thor's ways read ${JSON.stringify(s.ways)}, want In Valkyrie (picked) and thor's screen`)
        t.check(s.plates.includes('Gamma'), `a wide screen offers only the phone's short list inside Valkyrie (${JSON.stringify(s.plates)})`)
        await t.shot(page, 'sheet')
        await page.tap({ sel: '.vc-sheet .vc-plate', text: /^\s*Alpha\s*$/ })
        const w = await waitW(page, 1)
        t.check(w.path === '/api/terminal/sessions' && w.json?.mode === 'new' && w.json?.target === 'alpha' && (w.json?.host === undefined || w.json?.host === 'thor'), `Alpha inside Valkyrie sent ${w.method} ${w.path} ${w.body}`)
        await page.waitPath(`/m/ai/term/${TERM_NAME}`, 8000)
        const calls = (await tauriCallsFull(page)).map((c) => c.cmd)
        t.check(!calls.includes('open_new_ssh'), 'inside Valkyrie also opened a terminal over SSH')
      },
    },
    {
      name: 'sess:sheet:tauri-remote',
      group: 'sessions',
      device: 'desktop',
      timeout: 60_000,
      async run(t) {
        const page = await t.page({ scripts: [tauriStub({ hostname: 'mimir' })] })
        boardBackend(page, areaBoard())
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        await openPicker(page)
        const s = await page.eval(thorSection)
        if (!t.check(s, 'the picker has no thor section')) return
        t.check(JSON.stringify(s.ways.map((x) => x.label.replace(/^On .+'s screen$/, "On thor's screen"))) === JSON.stringify(['In Valkyrie', "On thor's screen", 'On this screen']) && s.ways[0].on,
          `off thor the ways read ${JSON.stringify(s.ways)}, want In Valkyrie (picked), thor's screen and this screen`)
        await page.tap({ sel: '.vc-sheet .vc-way [role="radio"]', text: /On this screen/ })
        await page.waitFor(() => /opens on this screen/.test([...document.querySelectorAll('.vc-sheet .vc-host-how')].map((e) => e.textContent).join('|')), { message: 'On this screen did not change the section line' })
        const from = (await tauriCallsFull(page)).length
        const since = Date.now()
        await page.tap({ sel: '.vc-sheet .vc-plate', text: /^\s*Alpha\s*$/ })
        await page.waitToast(/Alpha opened on this screen/, { since })
        const calls = (await tauriCallsFull(page, from)).filter((c) => c.cmd === 'open_new_ssh')
        t.check(calls.length === 1 && calls[0].args?.target === 'alpha', `On this screen invoked ${JSON.stringify(calls)}, want one open_new_ssh for alpha`)
        await sleep(400)
        t.check(!page.writes.length, `On this screen sent an HTTP write: ${page.writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
      },
    },
    {
      name: 'sess:open:tauri',
      group: 'sessions',
      device: 'desktop',
      timeout: 60_000,
      async run(t) {
        t.allowSockets.push(NEW_PANE_WS)
        const board = areaBoard()
        const target = board.sessions.find((s) => s.title === 'E2E work one')
        const page = await t.page({ scripts: [tauriStub({ hostname: 'mimir' })] })
        boardBackend(page, board)
        page.onWrite((w) => (w.method === 'POST' && w.path === '/api/terminal/sessions' ? { status: 201, body: termOpened(w.json) } : undefined))
        await page.goto('/m/ai/sessions')
        await boardUp(page)
        const row = `.vc-item[data-row="${target.sessionId}"]`
        await page.tap(`${row} .vc-front`)
        await page.waitFor(`!!document.querySelector('${row} .vc-strip')`, { message: 'the row did not open its strip' })
        const acts = await page.eval((r) => [...document.querySelectorAll(`${r} .vc-strip .vc-sact`)].map((b) => (b.querySelector('.vc-iact-l')?.textContent || b.textContent || '').trim()), row)
        t.check(acts[0] === 'Open', `the strip leads with "${acts[0]}", want Open (inside Valkyrie)`)
        t.check(acts.includes('New window') && acts.some((a) => /^On .+'s screen$/.test(a)) && acts.includes('On this screen'), `the strip's ways in are ${JSON.stringify(acts)}, want New window, thor's screen and this screen beside Open`)
        await page.tap(`${row} .vc-strip .vc-sact[data-main]`)
        const w = await waitW(page, 1)
        t.check(w.path === '/api/terminal/sessions' && w.json?.mode === 'resume' && w.json?.sessionId === target.sessionId, `Open sent ${w.method} ${w.path} ${w.body}, want a resume inside Valkyrie`)
        await page.waitPath(`/m/ai/term/${TERM_NAME}`, 8000)
        const calls = (await tauriCallsFull(page)).map((c) => c.cmd)
        t.check(!calls.includes('open_session_ssh'), 'Open also opened a terminal over SSH')
      },
    },
  ]
}

export function sessionTests() {
  return [...groupedTests(), ...sheetTests()]
}
