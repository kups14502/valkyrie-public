// CHAT: the session page's Chat view (src/v2/kit/chat, inside screens/Term.tsx):
// the conversation drawn from the pane's transcript, with the CLI still the
// engine underneath. Run at the phone and at 1920x1080 (zoom 1.2).
//
// The transcript route (GET /api/terminal/sessions/:name/transcript) is
// answered in the browser by a stand-in that keeps the real route's contract
// (backend/src/terminal/transcriptFeed.ts): no cursor answers the newest
// entries, a cursor answers what was appended since, and a cursor for another
// session id answers the newest entries with reset. The entries are the shape
// backend/src/terminal/transcript.ts writes, with generic text only.
//
// Three kinds of test:
//   - chat:view and chat:live on a made-up pane (vk-e2e00000b2, a Claude pane
//     on thor): its socket is refused by the fence, nothing reaches a pane.
//   - chat:server on the same made-up pane, answered with pages the backend's
//     own code made (lib/transcript-pages.mts): the live branch only, a rewind
//     that drops a turn the page holds, the task list whole on the first page
//     though its window starts after the tasks were made, the context meter
//     from the transcript's usage.
//   - chat:pane on a THROWAWAY odin shell pane the test makes and kills
//     (lib/odin.mjs, tests/terminal.mjs), shown as a Claude pane: the composer
//     typing into the real pane, the footer read off its screen, a permission
//     prompt drawn as plates over the conversation, Terminal one tap away.

import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from '../lib/cdp.mjs'
import { panesState, quietThor } from '../lib/fixtures.mjs'
import { PROMPT, attached, compose, fence, inputs, sentCount, waitScreen, withPane } from './terminal.mjs'
import { agent, chooser, fixtures } from './upload.mjs'

const ok = (body) => ({ status: 200, body })

const PANE = 'vk-e2e00000b2'
const SHELL = 'vk-e2e00000b1'
const SID_A = '0e2e0000-0000-4000-8000-0000000ca001'
const SID_B = '0e2e0000-0000-4000-8000-0000000cb001'
const SID_C = '0e2e0000-0000-4000-8000-0000000cc001'
const MODEL = 'claude-opus-5-5'
const TRANSCRIPT = /^\/api\/terminal\/sessions\/([^/]+)\/transcript$/
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend')
const PAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'transcript-pages.mts')

// ---------- the fixture conversation ----------

const READ_OUT = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(6)}\tconst line${i + 1} = ${i + 1}`).join('\n').trim()
const TEST_OUT = '> sample@1.0.0 test\n> vitest --run config\n\n PASS config.test.ts (4 tests)\n\n Test Files  1 passed (1)'
const OLD_SRC = 'const raw = read(path)\nconst again = read(path)\nreturn parse(again)'
const NEW_SRC = 'const raw = read(path)\nreturn parse(raw)'
const SUMMARY = [
  '## Summary',
  '',
  'The loader read the file **twice**. It reads it once now.',
  '',
  '- Removed the second `read(path)` call',
  '- Kept the error path as it was',
  '',
  '```ts',
  'return parse(raw)',
  '```',
  '',
  'See [the docs](https://example.com/docs) and [this](javascript:alert(1)).',
].join('\n')

/**
 * A conversation in the server's entry shape: a notice, a prompt, thinking,
 * Read, Edit, Bash (one ok, one failed), the todo list (TodoWrite and its todo
 * entry, as the parser emits both), a markdown answer, a second prompt and
 * five quiet steps in a row (Grep, Glob, Read, Read, Grep), and an answer.
 */
export function chatFixture(t0 = Date.now() - 12 * 60_000) {
  let n = 0
  const out = []
  const id = () => `0e2e0000-0000-4000-8000-0000000c${String(++n).padStart(4, '0')}`
  const at = () => t0 + n * 3000
  const push = (e) => { out.push(e); return e }
  const user = (text) => push({ id: id(), at: at(), kind: 'user', text })
  const said = (text) => push({ id: id(), at: at(), kind: 'assistant', text, model: MODEL })
  const tool = (name, input, toolId, result, isError = false) => {
    const call = push({ id: id(), at: at(), kind: 'tool', tool: { name, input, id: toolId }, model: MODEL })
    const rid = `${id()}:0`
    return { call, result: push({ id: rid, at: at(), kind: 'result', result: { toolId, text: result, isError, truncated: false } }) }
  }
  push({ id: id(), at: at(), kind: 'system', text: 'Background task completed: Sample build finished' })
  user('Tidy the config loader in the sample project. It reads the file twice.')
  push({ id: id(), at: at(), kind: 'thinking', text: 'The loader calls read() twice on the same path.\nRead it first, then fix the second call and run the tests.', model: MODEL })
  said('I will read the loader first.')
  tool('Read', { file_path: '/srv/sample/src/config.ts' }, 'toolu_e2e_read1', READ_OUT)
  tool('Edit', { file_path: '/srv/sample/src/config.ts', old_string: OLD_SRC, new_string: NEW_SRC }, 'toolu_e2e_edit1', 'The file /srv/sample/src/config.ts has been updated successfully.')
  tool('Bash', { command: 'npm test -- --run config', description: 'Run the config tests' }, 'toolu_e2e_bash1', TEST_OUT)
  tool('Bash', { command: 'cat missing.txt', description: 'Show a missing file' }, 'toolu_e2e_bash2', 'Exit code 1\ncat: missing.txt: No such file or directory', true)
  const todos = [
    { content: 'Read the loader', status: 'completed' },
    { content: 'Fix the double read', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
  ]
  const tw = push({ id: id(), at: at(), kind: 'tool', tool: { name: 'TodoWrite', input: { todos: todos.map((x) => ({ ...x, activeForm: x.content })) }, id: 'toolu_e2e_todo1' }, model: MODEL })
  push({ id: `${tw.id}:todo`, at: tw.at, kind: 'todo', todos })
  push({ id: `${id()}:0`, at: at(), kind: 'result', result: { toolId: 'toolu_e2e_todo1', text: 'Todos have been modified successfully.', isError: false, truncated: false } })
  said(SUMMARY)
  user('Now check the tests as well.')
  tool('Grep', { pattern: 'loadConfig', path: '/srv/sample' }, 'toolu_e2e_grep1', 'Found 3 files\n/srv/sample/src/config.ts\n/srv/sample/src/app.ts\n/srv/sample/src/config.test.ts')
  tool('Glob', { pattern: '**/*.test.ts' }, 'toolu_e2e_glob1', '/srv/sample/src/config.test.ts\n/srv/sample/src/load.test.ts')
  tool('Read', { file_path: '/srv/sample/src/config.test.ts' }, 'toolu_e2e_read2', READ_OUT)
  tool('Read', { file_path: '/srv/sample/src/load.test.ts' }, 'toolu_e2e_read3', READ_OUT)
  tool('Grep', { pattern: 'read\\(', path: '/srv/sample/src' }, 'toolu_e2e_grep2', 'Found 1 file\n/srv/sample/src/config.ts')
  said('All four config tests pass.')
  return out
}

/** Short prompt and answer pairs, so the conversation is taller than any screen. */
function filler(count, t0 = Date.now() - 40 * 60_000) {
  const out = []
  for (let i = 1; i <= count; i++) {
    out.push({ id: `0e2e0000-0000-4000-8000-0000000f${String(i).padStart(3, '0')}u`, at: t0 + i * 2000, kind: 'user', text: `Filler question ${i}: what does step ${i} do?` })
    out.push({ id: `0e2e0000-0000-4000-8000-0000000f${String(i).padStart(3, '0')}a`, at: t0 + i * 2000 + 1000, kind: 'assistant', model: MODEL, text: `Step ${i} checks the sample input.\n\nIt writes nothing and returns at once.` })
  }
  return out
}

let extra = 0
/** A new entry for the live tests (ids that never repeat). */
function more(kind, text) {
  extra += 1
  return { id: `0e2e0000-0000-4000-8000-0000000e${String(extra).padStart(4, '0')}`, at: Date.now(), kind, text, ...(kind === 'assistant' ? { model: MODEL } : {}) }
}

/**
 * The transcript route, answered in the page by the real route's rules. The
 * cursor is "<session id>:<count delivered>" here; the page treats it as
 * opaque either way. `st.log` records every read: { name, after, at }.
 */
function transcriptServer(page, entries, sid = SID_A) {
  const st = { sid, entries, log: [], delay: 0 }
  page.mock(TRANSCRIPT, async ({ path, query }) => {
    const name = TRANSCRIPT.exec(path)?.[1] ?? ''
    const after = typeof query.after === 'string' ? query.after : ''
    const rec = { name, after, at: Date.now(), n: 0, reset: false }
    st.log.push(rec)
    if (st.delay) await sleep(st.delay)
    const body = (list, reset) => ({
      sessionId: st.sid,
      file: `/home/e2e/.claude/projects/-srv-sample/${st.sid}.jsonl`,
      cursor: `${st.sid}:${st.entries.length}`,
      entries: list,
      more: false,
      reset,
    })
    const m = /^([0-9a-f-]{36}):(\d+)$/.exec(after)
    const page = m && m[1] === st.sid && Number(m[2]) <= st.entries.length
      ? body(st.entries.slice(Number(m[2])), false)
      : body(st.entries.slice(-200), after !== '')
    rec.n = page.entries.length
    rec.reset = page.reset
    rec.sid = st.sid
    return ok(page)
  })
  return st
}

/** The reads since `from`, short: "-" a first read, "R" a reset, then how many entries it answered. */
const readsSince = (st, from) => st.log.slice(from).map((x) => `${x.after ? (x.reset ? 'R' : x.after.slice(-4)) : '-'}:${x.n}@${x.at - st.log[0].at}`).join(' ')

/** The made-up panes (b1: an odin shell, b2: a Claude pane on thor) and the reads around them. */
function madeUp(t, page, entries) {
  t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b[12]&/)
  quietThor(page)
  page.mock('/api/terminal/sessions', () => ok(panesState()))
  return transcriptServer(page, entries)
}

// ---------- reading the page ----------

/** What the Chat view shows, in one read. */
function chatReport() {
  const q = (s, r = document) => r.querySelector(s)
  const qa = (s, r = document) => [...r.querySelectorAll(s)]
  const txt = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
  }
  const shown = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const root = q('[data-term-root]')
  const scroll = q('.vch-scroll')
  const said = qa('.vch-said')
  const summary = said.find((e) => /Summary/.test(e.textContent || ''))
  const term = q('.vsk-term')
  return {
    view: root?.getAttribute('data-view') ?? null,
    chat: !!q('.vch'),
    tabs: qa('.vtm-views .vtm-view').map((e) => ({ t: txt(e), on: e.getAttribute('aria-selected') === 'true', bar: !!e.closest('.vsk-bar'), meta: !!e.closest('.vsk-meta'), shown: shown(e) })),
    termVis: term ? getComputedStyle(term).visibility : null,
    act: shown(q('.vsk-act')),
    users: qa('.vch-user').map(txt),
    said: said.map(txt),
    md: summary ? {
      h2: txt(q('h2', summary)),
      strong: qa('strong', summary).map(txt),
      li: qa('li', summary).map(txt),
      code: qa(':not(pre) > code', summary).map(txt),
      lang: txt(q('.vch-code-lang', summary)),
      pre: txt(q('.vch-code pre', summary)),
      copy: !!q('.vch-code-copy', summary),
      links: qa('a', summary).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), t: txt(a) })),
      nolink: qa('.vch-md-nolink', summary).map(txt),
    } : null,
    tools: qa('.vch-tool').map((e) => ({
      k: e.getAttribute('data-k'), s: e.getAttribute('data-s'),
      verb: txt(q('.vch-tool-verb', e)), main: txt(q('.vch-tool-main b', e)), sub: txt(q('.vch-tool-main i', e)), d: txt(q('.vch-tool-d', e)),
      open: e.hasAttribute('data-open'), body: txt(q('.vch-tool-body', e)), diff: qa('.vch-diff-l', e).map((l) => l.getAttribute('data-t')),
    })),
    think: qa('.vch-think').map((e) => ({ head: txt(q('.vch-think-t', e)), exp: q('.vch-think-head', e)?.getAttribute('aria-expanded'), body: txt(q('.vch-think-body', e)) })),
    folds: qa('.vch-fold').map((e) => ({ t: txt(e), open: e.getAttribute('aria-expanded') === 'true' })),
    sys: qa('.vch-sys').map(txt),
    times: qa('.vch-time').map(txt),
    strip: q('.vch-todos[data-v="strip"]') ? { head: txt(q('.vch-todos[data-v="strip"] .vch-todos-head')), rows: qa('.vch-todos[data-v="strip"] .vch-todo').map((e) => ({ t: txt(e), s: e.getAttribute('data-s') })), shown: shown(q('.vch-todos[data-v="strip"]')) } : null,
    side: q('.vsk-side .vch-todos[data-v="side"]') ? { head: txt(q('.vsk-side .vch-todos-head')), rows: qa('.vsk-side .vch-todo').map((e) => ({ t: txt(e), s: e.getAttribute('data-s') })), shown: shown(q('.vsk-side .vch-todos')) } : null,
    foot: { word: txt(q('.vch-foot-word')), p: q('.vch-foot')?.getAttribute('data-p') ?? null, d: txt(q('.vch-foot-d')), model: txt(q('.vch-foot-model')), meta: qa('.vch-foot-m').map((e) => ({ t: txt(e), hot: e.hasAttribute('data-hot') })) },
    empty: txt(q('.vch-empty')),
    chip: q('.vch-new') ? { t: txt(q('.vch-new')), n: q('.vch-new').hasAttribute('data-n') } : null,
    gap: scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : null,
    top: scroll ? Math.round(scroll.scrollTop) : null,
    scrollH: scroll ? Math.round(scroll.clientHeight) : null,
    overflowX: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
    docSW: document.documentElement.scrollWidth,
    W: document.documentElement.clientWidth,
    boxes: { vch: box(q('.vch')), foot: box(q('.vch-foot')), comp: box(q('.vsk-comp')), ask: box(q('.vch-ask')), scroll: box(scroll), meta: box(q('.vsk-meta')), term: box(term), stage: box(q('.vsk-termbox')) },
    asks: qa('.vsk-ask').length,
    placeholder: q('.vsk-input')?.getAttribute('placeholder') ?? '',
    draft: q('.vsk-input')?.value ?? '',
  }
}

const report = (page) => page.eval(chatReport)

/** Waits until the Chat view shows `text` somewhere in the conversation. */
async function waitChat(page, text, timeout = 8000) {
  await page.waitFor((s) => (document.querySelector('.vch-list')?.textContent ?? '').includes(s), { args: [text], timeout, message: `the Chat view never showed "${text}"` })
}
async function waitGone(page, text, timeout = 8000) {
  await page.waitFor((s) => !!document.querySelector('.vch-list') && !(document.querySelector('.vch-list').textContent ?? '').includes(s), { args: [text], timeout, message: `the Chat view still shows "${text}"` })
}
const atBottom = (page) => page.waitFor(() => {
  const el = document.querySelector('.vch-scroll')
  return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 4
}, { timeout: 4000, message: 'the conversation is not scrolled to the bottom' })

const ET_TIME = /^\d{1,2}:\d{2}\s?[AP]M ET$/

// ---------- the tests ----------

const DEVICES = ['phone', 'desk1080']

function viewTest(device) {
  const wide = device !== 'phone'
  return {
    name: `chat:view:${device}`,
    group: 'chat',
    device,
    timeout: 70_000,
    async run(t) {
      const page = await t.page()
      const st = madeUp(t, page, chatFixture())
      await page.goto(`/m/ai/term/${PANE}`)
      await page.waitFor(() => document.querySelector('[data-term-root]'), { timeout: 12_000, message: 'the session page did not render' })

      await t.step('Chat is the default view and draws the transcript', async () => {
        await waitChat(page, 'All four config tests pass.', 10_000)
        await sleep(600)
        const r = await report(page)
        t.check(r.view === 'chat' && r.chat, `the page opened in ${r.view}, want chat`)
        t.check(r.termVis === 'hidden', `the terminal under Chat is ${r.termVis}, want hidden (kept attached and sized, not painted)`)
        t.check(r.tabs.map((x) => `${x.t}${x.on ? '*' : ''}`).join(',') === 'Chat*,Terminal', `the view tabs read ${JSON.stringify(r.tabs)}`)
        t.check(r.tabs.every((x) => x.shown && (wide ? x.bar : x.meta)), `the view tabs are not ${wide ? 'in the bar' : 'in the meta row'}: ${JSON.stringify(r.tabs)}`)
        t.check(!r.act, 'the activity strip shows in Chat (Chat lists every step itself)')
        t.check(st.log.length > 0 && st.log[0].name === PANE && st.log[0].after === '', `the first transcript read was ${JSON.stringify(st.log[0])}, want no cursor for ${PANE}`)
        // the user prompts, right and in order
        t.check(r.users.length === 2 && /^Tidy the config loader/.test(r.users[0]) && r.users[1] === 'Now check the tests as well.', `the prompts read ${JSON.stringify(r.users)}`)
        // the notice and the time line
        t.check(r.sys.includes('Background task completed: Sample build finished'), `the system lines read ${JSON.stringify(r.sys)}`)
        t.check(r.times.length >= 1 && ET_TIME.test(r.times[0]), `the time line reads ${JSON.stringify(r.times)}, want a New York time labeled ET`)
        // the answers, markdown drawn
        t.check(r.said.length === 3 && r.said[0] === 'I will read the loader first.' && r.said[2] === 'All four config tests pass.', `the answers read ${JSON.stringify(r.said)}`)
        const md = r.md
        t.check(!!md, 'the markdown answer is missing')
        if (md) {
          t.check(md.h2 === 'Summary', `the heading reads "${md.h2}"`)
          t.check(md.strong.includes('twice'), `bold text: ${JSON.stringify(md.strong)}`)
          t.check(md.li.length === 2 && /Removed the second read\(path\) call/.test(md.li[0]), `list items: ${JSON.stringify(md.li)}`)
          t.check(md.code.includes('read(path)'), `inline code: ${JSON.stringify(md.code)}`)
          t.check(md.lang === 'ts' && md.pre === 'return parse(raw)' && md.copy, `the code block: lang "${md.lang}", "${md.pre}", copy ${md.copy}`)
          t.check(md.links.length === 1 && md.links[0].href === 'https://example.com/docs' && md.links[0].target === '_blank', `links: ${JSON.stringify(md.links)}`)
          t.check(md.nolink.includes('this'), `the javascript: link was not dropped to text: ${JSON.stringify(md.nolink)}`)
        }
        // thinking, folded to one line
        t.check(r.think.length === 1 && r.think[0].head === 'The loader calls read() twice on the same path.' && r.think[0].exp === 'false' && !r.think[0].body, `thinking: ${JSON.stringify(r.think)}`)
        // the steps of the first turn, each a line; the five quiet steps of the second fold into one
        const tools = r.tools
        const by = (k, i = 0) => tools.filter((x) => x.k === k)[i]
        t.check(tools.map((x) => x.k).join(',') === 'read,edit,run,run,todo', `the step lines are ${tools.map((x) => x.k).join(',')}, want read,edit,run,run,todo (the second turn folded)`)
        const read = by('read')
        t.check(read && read.verb === 'Read' && read.main === 'config.ts' && read.sub === '/srv/sample/src' && read.d === '12 lines' && !read.body, `the Read line: ${JSON.stringify(read)}`)
        const edit = by('edit')
        t.check(edit && edit.verb === 'Edit' && edit.main === 'config.ts' && edit.d === '+1−2', `the Edit line: ${JSON.stringify(edit)}`)
        t.check(edit && edit.diff.join(',') === 'ctx,del,del,add', `the Edit's inline diff rows: ${edit?.diff.join(',')}`)
        const run = by('run')
        t.check(run && run.verb === 'Run' && run.main === 'npm test -- --run config' && run.sub === 'Run the config tests' && run.d === '6 lines' && run.s === 'ok' && !run.body, `the Bash line: ${JSON.stringify(run)}`)
        const bad = by('run', 1)
        t.check(bad && bad.s === 'err' && bad.d === 'exit 1' && bad.main === 'cat missing.txt', `the failed Bash line: ${JSON.stringify(bad)}`)
        const todo = by('todo')
        t.check(todo && todo.verb === 'Todos' && /^1\/3 done/.test(todo.main) && todo.sub === 'Fix the double read', `the todo line: ${JSON.stringify(todo)}`)
        t.check(r.folds.length === 1 && r.folds[0].t === '3 searches · 2 reads' && !r.folds[0].open, `the folded steps read ${JSON.stringify(r.folds)}`)
        // the live todo list: a strip on the phone, the side column on a monitor
        if (wide) {
          t.check(!r.strip, 'a monitor shows the todo strip over the conversation (its side column has the list)')
          t.check(r.side?.shown && /Todos\s*1\/3/.test(r.side.head) && r.side.rows.map((x) => x.s).join(',') === 'completed,in_progress,pending', `the side todo list: ${JSON.stringify(r.side)}`)
        } else {
          t.check(r.strip?.shown && /Todos\s*1\/3\s*Fix the double read/.test(r.strip.head) && !r.strip.rows.length, `the todo strip: ${JSON.stringify(r.strip)}`)
          t.check(!r.side, 'the phone shows a side todo list')
        }
        // the footer: the model from the transcript; this pane has no socket, so the state reads Offline
        t.check(r.foot.model === 'Opus 5.5', `the footer model reads "${r.foot.model}"`)
        t.check(!r.foot.meta.some((m) => m.t.startsWith('ctx')), `a context meter shows with no usage in the transcript and no screen: ${JSON.stringify(r.foot.meta)}`)
        t.check(r.overflowX <= 1 && r.docSW <= r.W + 1, `the conversation is wider than the screen (${r.overflowX} px, page ${r.docSW} > ${r.W})`)
        const b = r.boxes
        if (wide) t.check(b.vch && b.stage && Math.abs(b.vch.t - b.stage.t) <= 2 && Math.abs(b.vch.b - b.stage.b) <= 2, `the conversation does not fill the stage: ${JSON.stringify({ vch: b.vch, stage: b.stage })}`)
        else t.check(b.vch && b.meta && Math.abs(b.vch.t - b.meta.b) <= 1 && Math.abs(b.vch.b - b.stage.b) <= 2, `the conversation does not run from the meta row to the composer: ${JSON.stringify({ vch: b.vch, meta: b.meta, stage: b.stage })}`)
        await t.shot(page, 'chat')
      })

      await t.step('folds open: thinking, a result, the quiet steps, the todo list', async () => {
        await page.tap('.vch-think-head')
        await page.waitFor(() => /run the tests/.test(document.querySelector('.vch-think-body')?.textContent ?? ''), { timeout: 3000, message: 'the thinking did not open to its whole text' })
        await page.tap({ sel: '.vch-tool[data-k="run"] .vch-tool-head', text: 'npm test' })
        await page.waitFor(() => /Test Files\s+1 passed \(1\)/.test([...document.querySelectorAll('.vch-tool[data-k="run"] .vch-tool-body pre')].map((e) => e.textContent).join('\n')), { timeout: 3000, message: 'the Bash result did not open under its line' })
        await page.tap({ sel: '.vch-tool[data-k="read"] .vch-tool-head', text: 'config.ts' })
        await page.waitFor(() => /const line12 = 12/.test(document.querySelector('.vch-tool[data-k="read"] .vch-tool-body pre')?.textContent ?? ''), { timeout: 3000, message: 'the Read result did not open under its line' })
        await page.tap('.vch-fold')
        await page.waitFor(() => document.querySelectorAll('.vch-tool').length === 10, { timeout: 3000, message: 'the folded steps did not open to five lines' })
        const r = await report(page)
        const second = r.tools.slice(5)
        t.check(second.map((x) => `${x.verb}:${x.main}:${x.d}`).join(' | ') === 'Grep:loadConfig:3 files | Glob:**/*.test.ts:2 lines | Read:config.test.ts:12 lines | Read:load.test.ts:12 lines | Grep:read\\(:1 file', `the opened steps: ${second.map((x) => `${x.verb}:${x.main}:${x.d}`).join(' | ')}`)
        t.check(r.folds[0]?.open, 'the fold line does not say it is open')
        if (!wide) {
          await page.tap('.vch-todos[data-v="strip"] .vch-todos-head')
          await page.waitFor(() => document.querySelectorAll('.vch-todos[data-v="strip"] .vch-todo').length === 3, { timeout: 3000, message: 'the todo strip did not open to the whole list' })
        }
        await t.shot(page, 'chat-open')
      })

      await t.step('Terminal is one tap away, and back', async () => {
        const inChat = (await report(page)).boxes.term
        await page.tap({ sel: '.vtm-view', text: 'Terminal' })
        await page.waitFor(() => document.querySelector('[data-term-root]')?.getAttribute('data-view') === 'term', { timeout: 3000, message: 'the Terminal tab did not switch the view' })
        await sleep(300)
        let r = await report(page)
        const inTerm = r.boxes.term
        t.check(inChat && inTerm && Math.abs(inChat.w - inTerm.w) < 0.5 && Math.abs(inChat.h - inTerm.h) < 0.5, `the terminal's box changed with the view (Chat ${JSON.stringify(inChat)}, Terminal ${JSON.stringify(inTerm)}): the pane would be resized`)
        t.check(!r.chat && r.termVis === 'visible' && r.act, `Terminal view: chat ${r.chat}, terminal ${r.termVis}, activity strip ${r.act}`)
        t.check(r.tabs.map((x) => `${x.t}${x.on ? '*' : ''}`).join(',') === 'Chat,Terminal*', `the tabs in Terminal read ${JSON.stringify(r.tabs)}`)
        t.check((await page.eval(() => localStorage.getItem('v2.termView'))) === 'term', 'the pick is not kept on this device')
        // the transcript is not read while it is not on screen
        await sleep(400)
        const n = st.log.length
        await sleep(2600)
        t.check(st.log.length === n, `the transcript was read ${st.log.length - n} time(s) while the Terminal view was up`)
        // a reload keeps the pick
        await page.goto(`/m/ai/term/${PANE}`)
        await page.waitFor(() => document.querySelector('[data-term-root]'), { timeout: 12_000, message: 'the session page did not render after the reload' })
        await sleep(1500)
        r = await report(page)
        t.check(r.view === 'term' && !r.chat, `after a reload the page shows ${r.view}, want the kept pick (term)`)
        t.check(st.log.length === n, 'the transcript was read on a reload into the Terminal view')
        await page.tap({ sel: '.vtm-view', text: 'Chat' })
        await waitChat(page, 'All four config tests pass.')
        r = await report(page)
        t.check(r.view === 'chat' && r.termVis === 'hidden' && !r.act, `back in Chat: view ${r.view}, terminal ${r.termVis}, activity strip ${r.act}`)
        t.check(st.log.length > n && st.log[n].after === '', `back in Chat the first read was ${JSON.stringify(st.log[n])}, want a fresh read with no cursor`)
        t.check((await page.eval(() => localStorage.getItem('v2.termView'))) === 'chat', 'the Chat pick is not kept')
      })

      await t.step('a shell pane has no Chat', async () => {
        const n = st.log.length
        await page.goto(`/m/ai/term/${SHELL}`)
        await page.waitFor(() => document.querySelector('[data-term-root]') && document.querySelector('.vsk-input')?.getAttribute('placeholder') === 'Command', { timeout: 12_000, message: 'the shell pane page did not render' })
        await sleep(1500)
        const r = await report(page)
        t.check(r.view === 'term' && !r.chat && !r.tabs.length && r.act, `a shell pane shows view ${r.view}, chat ${r.chat}, tabs ${r.tabs.length}, activity ${r.act}`)
        t.check(st.log.slice(n).every((x) => x.name !== SHELL), 'the shell pane\'s transcript was read')
      })
    },
  }
}

function liveTest(device) {
  return {
    name: `chat:live:${device}`,
    group: 'chat',
    device,
    timeout: 90_000,
    async run(t) {
      const page = await t.page()
      const st = madeUp(t, page, [...filler(14), ...chatFixture()])
      await page.goto(`/m/ai/term/${PANE}`)
      await page.waitFor(() => document.querySelector('[data-term-root]'), { timeout: 12_000, message: 'the session page did not render' })
      await waitChat(page, 'All four config tests pass.', 10_000)

      await t.step('opens at the bottom of a long conversation', async () => {
        await sleep(500)
        const r = await report(page)
        t.check(r.gap !== null && r.gap < 4, `the conversation opened ${r.gap} px above its end`)
        t.check(r.top > 200, `the conversation is not taller than the screen (scrollTop ${r.top}), the scroll checks below prove nothing`)
        t.check(!r.chip, `the new messages chip shows at the bottom: ${JSON.stringify(r.chip)}`)
      })

      await t.step('new entries at the bottom scroll into view', async () => {
        st.entries.push(more('user', 'Live prompt one'), more('assistant', 'Live answer one, with a second line.\n\nAnd a third paragraph so the list grows.'))
        await waitChat(page, 'And a third paragraph so the list grows.')
        await atBottom(page)
        const r = await report(page)
        t.check(!r.chip, `the chip showed while following the bottom: ${JSON.stringify(r.chip)}`)
      })

      await t.step('scrolled up: new entries wait behind the "new" chip', async () => {
        const from = st.log.length
        await page.eval(() => { document.querySelector('.vch-scroll').scrollTop = 0 })
        await page.waitFor(() => /Latest/.test(document.querySelector('.vch-new')?.textContent ?? ''), { timeout: 3000, message: 'no Latest chip once scrolled away from the bottom' })
        st.entries.push(more('assistant', 'Live answer two.'), more('user', 'Live prompt three'), more('assistant', 'Live answer three.'))
        await waitChat(page, 'Live answer three.')
        await page.waitFor(() => document.querySelector('.vch-new')?.hasAttribute('data-n'), { timeout: 3000, message: 'the chip did not count the new entries' })
          .catch((e) => { throw new Error(`${e.message} (reads: ${readsSince(st, from)})`) })
        let r = await report(page)
        t.check(r.chip?.t === '3 new' && r.chip.n, `the chip reads ${JSON.stringify(r.chip)}, want "3 new"`)
        t.check(r.top < 40, `new entries moved the conversation while scrolled up (scrollTop ${r.top})`)
        await t.shot(page, 'chip')
        await page.tap('.vch-new')
        await atBottom(page)
        await page.waitFor(() => !document.querySelector('.vch-new'), { timeout: 3000, message: 'the chip stayed after it brought the conversation to the end' })
        st.entries.push(more('assistant', 'Live answer four.'))
        await waitChat(page, 'Live answer four.')
        await atBottom(page)
        r = await report(page)
        t.check(!r.chip, 'after the chip, new entries did not follow at the bottom again')
      })

      await t.step('reset (another transcript): the old conversation clears and the new one loads', async () => {
        await page.eval(() => { document.querySelector('.vch-scroll').scrollTop = 0 })
        await page.waitFor(() => !!document.querySelector('.vch-new'), { timeout: 3000, message: 'no chip once scrolled away' })
        const n = st.log.length
        st.sid = SID_B
        st.entries = [more('user', 'Fresh conversation after a clear'), more('assistant', 'Ready for the next task.')]
        await waitChat(page, 'Ready for the next task.')
        await waitGone(page, 'Tidy the config loader')
        await sleep(1300)
        const r = await report(page)
        t.check(!/Filler question|Live answer/.test(r.users.join(' ') + r.said.join(' ')), 'entries of the old transcript are still on screen')
        t.check(r.users.join('|') === 'Fresh conversation after a clear' && r.said.join('|') === 'Ready for the next task.', `after the reset: ${JSON.stringify({ users: r.users, said: r.said, empty: r.empty, view: r.view, list: await page.eval(() => (document.querySelector('.vch-list')?.textContent ?? '').slice(0, 300)), reads: st.log.slice(n).map((x) => x.after) })}`)
        t.check(!r.chip, `the chip stayed across the reset: ${JSON.stringify(r.chip)}`)
        t.check(!r.strip && !r.side, 'the old todo list stayed across the reset')
        const reads = st.log.slice(n)
        const hit = reads.findIndex((x) => x.after.startsWith(`${SID_B}:`))
        t.check(reads.length > 0 && reads[0].after.startsWith(`${SID_A}:`), `the read that got the reset carried ${JSON.stringify(reads[0]?.after)}, want the old cursor`)
        t.check(hit > 0, `no read after the reset carried the new transcript's cursor (${JSON.stringify(reads.map((x) => x.after))})`)
      })

      await t.step('reset to an empty transcript, then its first entry', async () => {
        st.sid = SID_C
        st.entries = []
        await page.waitFor(() => /Nothing in this conversation yet/.test(document.querySelector('.vch-empty')?.textContent ?? ''), { timeout: 6000, message: 'an empty transcript does not say so' })
        st.entries.push(more('user', 'First prompt of the empty one'))
        await waitChat(page, 'First prompt of the empty one')
        st.entries.push(more('assistant', 'First answer of the empty one.'))
        await waitChat(page, 'First answer of the empty one.')
      })

      await t.step('a reload paints the conversation from the cache before the first read answers', async () => {
        await sleep(3600)
        st.delay = 4000
        const n = st.log.length
        const t0 = Date.now()
        await page.goto(`/m/ai/term/${PANE}`)
        await page.waitFor(() => (document.querySelector('.vch-list')?.textContent ?? '').includes('First answer of the empty one.'), { timeout: 3000, message: 'the reload did not paint the cached conversation at once' })
        const painted = Date.now() - t0
        // the read goes out once the pane list says the pane is live, and is held 4 s
        for (let i = 0; i < 30 && st.log.length === n; i++) await sleep(100)
        const answered = st.log.slice(n)
        t.check(answered.length >= 1 && answered[0].after === '', `the first read after the reload carried ${JSON.stringify(answered[0]?.after)}, want none`)
        t.note(`cached conversation painted ${painted} ms after the reload, the read answers after 4 s`)
        st.delay = 0
        await sleep(4500)
        const r = await report(page)
        t.check(r.users.join('|') === 'First prompt of the empty one' && r.said.join('|') === 'First answer of the empty one.', `after the read: ${JSON.stringify({ users: r.users, said: r.said, view: r.view, empty: r.empty })} (reads: ${readsSince(st, n)})`)
      })
    },
  }
}

// What a busy Claude Code prints at the bottom (octal escapes keep the typed line ASCII):
// "✻ Cogitating… (23s · ↓ 1.2k tokens · esc to interrupt)", the context warning, the status line's meters.
const BUSY = String.raw`printf '\342\234\273 Cogitating\342\200\246 (23s \302\267 \342\206\223 1.2k tokens \302\267 esc to interrupt)\n\nContext left until auto-compact: 12%%\n  5h 23%% \302\267 wk 41%%\n'`

function paneTest(device) {
  return {
    name: `chat:pane:${device}`,
    group: 'chat',
    device,
    timeout: 200_000,
    async run(t) {
      await withPane(t, async (name) => {
        const page = await t.page({ term: name })
        // the throwaway shell, shown as a Claude pane: the page opens in Chat
        fence(page, t.env.base, name, 'new')
        const st = transcriptServer(page, chatFixture())
        const upLog = []
        agent(page, () => 'ok', upLog)
        const pick = await chooser(page)
        await page.goto(`/m/ai/term/${name}`)

        await t.step('attach in Chat', async () => {
          await attached(page, name)
          await waitChat(page, 'All four config tests pass.')
          const r = await report(page)
          t.check(r.view === 'chat' && r.termVis === 'hidden', `the Claude pane opened in ${r.view} (terminal ${r.termVis})`)
          t.check(r.placeholder === 'Message Claude', `the composer says "${r.placeholder}"`)
          t.check(st.log.every((x) => x.name === name), `the transcript was read for ${[...new Set(st.log.map((x) => x.name))].join(', ')}`)
          t.check(r.foot.word === 'Ready' && r.foot.p === 'idle', `the footer reads "${r.foot.word}" (${r.foot.p}) on a quiet pane`)
        })
        if (t.fails.length) return

        await t.step('composer: the text, then a lone Enter, reach the pane', async () => {
          const from = await sentCount(page)
          await compose(page, 'echo chat-$((6*7))-ok')
          await page.waitFor(() => /(^|\n)chat-42-ok\r?\n/.test(window.__e2e.wsOut), { timeout: 8000, message: 'the shell never printed chat-42-ok' })
          const frames = await inputs(page, from)
          const i = frames.findIndex((f) => f.d.includes('echo chat-$((6*7))-ok'))
          t.check(i >= 0, `the line was never sent (frames: ${JSON.stringify(frames.map((f) => f.d))})`)
          t.check(i >= 0 && !frames[i].d.includes('\r'), 'the Enter rode in the same frame as the text')
          t.check(frames[i + 1]?.d === '\r' && frames[i + 1].at - frames[i].at >= 100, `the frame after the text is ${JSON.stringify(frames[i + 1])}, want a lone Enter about 120 ms later`)
          const r = await report(page)
          t.check(r.view === 'chat', 'sending left the Chat view')
        })

        await t.step('footer: working, context and usage, read off the screen', async () => {
          await compose(page, BUSY)
          await page.waitFor(() => document.querySelector('.vch-foot')?.getAttribute('data-p') === 'working', { timeout: 8000, message: 'the footer never read working off the spinner line' })
          await page.waitFor(() => /5h/.test(document.querySelector('.vch-foot-meta')?.textContent ?? ''), { timeout: 4000, message: 'the footer never showed the usage meters' })
          const r = await report(page)
          const meta = Object.fromEntries(r.foot.meta.map((m) => [m.t.split(' ')[0], m]))
          t.check(r.foot.word === 'Cogitating…', `the footer word is "${r.foot.word}"`)
          t.check(r.foot.d === '23s · ↓ 1.2k tok', `the footer detail is "${r.foot.d}"`)
          // the fixture carries no usage, so the meter falls back to the screen's warning: 12% left is 88% used
          t.check(meta.ctx?.t === 'ctx 88% used' && meta.ctx.hot, `the context meter: ${JSON.stringify(meta.ctx)}`)
          t.check(meta['5h']?.t === '5h 23%' && !meta['5h'].hot && meta.wk?.t === 'wk 41%', `the usage meters: ${JSON.stringify(r.foot.meta)}`)
          t.check((await page.eval(() => document.querySelector('[data-term-root]')?.getAttribute('data-phase'))) === 'working', 'the page phase is not working')
          await t.shot(page, 'working')
          await compose(page, 'clear')
          await page.waitFor(() => document.querySelector('.vch-foot')?.getAttribute('data-p') === 'idle', { timeout: 6000, message: 'the footer stayed on working after the screen cleared' })
        })

        await t.step('a permission prompt: plates over the conversation, above the composer', async () => {
          await compose(page, PROMPT)
          await page.waitFor(() => document.querySelector('.vch .vch-ask .vsk-ask'), { timeout: 8000, message: 'no question plates in the Chat view' })
          await sleep(500)
          const r = await report(page)
          const b = r.boxes
          t.check(r.asks === 1, `${r.asks} question plates are drawn, want one set`)
          t.check(b.ask && b.foot && b.ask.b <= b.foot.t + 1, `the plates (bottom ${b.ask?.b}) are not above the footer (top ${b.foot?.t})`)
          t.check(b.ask && b.comp && b.ask.b <= b.comp.t + 1, `the plates (bottom ${b.ask?.b}) are not above the composer (top ${b.comp?.t})`)
          t.check(b.scroll && b.scroll.h >= 60 && r.said.length === 3, `the conversation is pushed off screen by the plates (its box ${b.scroll?.h} px, ${r.said.length} answers)`)
          t.check(r.foot.word === 'Waiting for your answer' && r.foot.p === 'asking', `the footer reads "${r.foot.word}" (${r.foot.p})`)
          t.check(r.placeholder === 'Or tell Claude instead', `the composer says "${r.placeholder}" while Claude asks`)
          const q = await page.eval(() => ({
            text: document.querySelector('.vch-ask .vsk-ask-q')?.textContent ?? '',
            opts: [...document.querySelectorAll('.vch-ask .vsk-opt')].map((o) => o.getAttribute('aria-label')),
          }))
          t.check(q.text === 'Do you want to proceed?' && q.opts.length === 3, `the plates ask "${q.text}" with ${JSON.stringify(q.opts)}`)
          await t.shot(page, 'plates')
          const from = await sentCount(page)
          await page.tap({ sel: '.vch-ask .vsk-opt', text: '2. Yes, and do not ask' })
          t.check((await inputs(page, from)).map((f) => f.d).join('') === '2', 'plate 2 did not send "2"')
          await page.tap('.vsk-key[data-k="ctrlc"]')
          await page.waitFor(() => !document.querySelector('.vsk-ask'), { timeout: 6000, message: 'the plates stayed after the prompt left the screen' })
          await compose(page, 'clear')
        })

        await t.step('Terminal shows the same live pane, and back to Chat', async () => {
          // the switch itself: no new socket and no resize (the composer's keyboard on a phone may refit, so it is counted apart)
          const grab = () => page.eval(() => ({ opened: window.__e2e.wsOpened.length, resizes: window.__e2e.wsSent.filter((x) => /"t":"r"/.test(x.d)).length }))
          await page.eval(() => document.activeElement?.blur?.())
          await sleep(800)
          const before = await grab()
          await page.tap({ sel: '.vtm-view', text: 'Terminal' })
          await page.waitFor(() => document.querySelector('[data-term-root]')?.getAttribute('data-view') === 'term', { timeout: 3000, message: 'the Terminal tab did not switch the view' })
          await sleep(800)
          const mid = await grab()
          t.check(mid.opened === before.opened && mid.resizes === before.resizes, `the switch to Terminal opened ${mid.opened - before.opened} socket(s) and sent ${mid.resizes - before.resizes} resize(s)`)
          await compose(page, 'echo term-$((40+2))')
          await waitScreen(page, /^term-42\s*$/m)
          await page.eval(() => document.activeElement?.blur?.())
          await sleep(800)
          const mid2 = await grab()
          await page.tap({ sel: '.vtm-view', text: 'Chat' })
          await waitChat(page, 'All four config tests pass.')
          await sleep(800)
          const after = await grab()
          t.check(after.opened === mid2.opened && after.resizes === mid2.resizes, `the switch back to Chat opened ${after.opened - mid2.opened} socket(s) and sent ${after.resizes - mid2.resizes} resize(s)`)
        })

        await t.step('upload in Chat: the saved path goes into the composer, nothing to the pane', async () => {
          const fx = fixtures()
          const from = await sentCount(page)
          const chosen = pick([fx.sunset])
          await page.tap({ sel: '.vtm-bar-btn', text: 'Send photos or videos to thor' })
          t.check((await chosen) === 'selectMultiple', 'the upload button did not open a multi-file picker')
          const path = 'C:\\Thor\\uploads\\20261018-141500-sunset.png'
          await page.waitFor((p) => document.querySelector('.vsk-input')?.value === `${p} `, { args: [path], timeout: 10_000, message: 'the saved path never reached the composer' })
          await sleep(400)
          const frames = (await inputs(page, from)).map((f) => f.d)
          t.check(!frames.some((d) => d.includes('sunset')), `the path was typed into the pane: ${JSON.stringify(frames)}`)
          t.check(upLog.length === 1 && upLog[0].name === 'sunset.png', `upload chunks: ${JSON.stringify(upLog.map((l) => l.name))}`)
        })
      })
    },
  }
}

// ---------- the contract: the server's own parser, drawn by the page ----------

const PARSE = [
  "import fs from 'node:fs'",
  "import { parseLines, splitLines } from './src/terminal/transcript.ts'",
  "const lines = splitLines(fs.readFileSync('scripts/fixtures/transcript-generic.jsonl', 'utf8'))",
  'process.stdout.write(JSON.stringify(parseLines(lines)))',
].join('\n')

/** backend/src/terminal/transcript.ts run on the backend's generic fixture (tsx from backend/node_modules). */
function serverEntries() {
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PARSE], { cwd: BACKEND, windowsHide: true, timeout: 30_000, maxBuffer: 8 << 20, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) return rej(new Error(`the backend parser did not run (${(errOut || err.message).trim().slice(0, 300)})`))
      try { res(JSON.parse(out)) } catch (e) { rej(new Error(`the backend parser printed no JSON: ${e.message}`)) }
    })
  })
}

/** The fields lib/api.ts parseTranscriptEntry keeps; anything else it would drop or misread. */
function contractProblems(entries) {
  const kinds = new Set(['user', 'assistant', 'thinking', 'tool', 'result', 'todo', 'system'])
  const bad = []
  const ids = new Set()
  for (const e of entries) {
    const why = []
    if (typeof e.id !== 'string' || !e.id) why.push('id')
    if (ids.has(e.id)) why.push('duplicate id')
    ids.add(e.id)
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) why.push('at')
    if (!kinds.has(e.kind)) why.push(`kind ${e.kind}`)
    if ('text' in e && typeof e.text !== 'string') why.push('text')
    if ('model' in e && typeof e.model !== 'string') why.push('model')
    if (e.kind === 'tool' && !(e.tool && typeof e.tool.name === 'string' && typeof e.tool.id === 'string' && 'input' in e.tool)) why.push('tool')
    if (e.kind === 'result' && !(e.result && typeof e.result.toolId === 'string' && typeof e.result.text === 'string' && typeof e.result.isError === 'boolean' && typeof e.result.truncated === 'boolean')) why.push('result')
    if (e.kind === 'todo' && !(Array.isArray(e.todos) && e.todos.every((x) => typeof x.content === 'string' && typeof x.status === 'string'))) why.push('todos')
    if ('usage' in e && !(e.usage && Number.isFinite(e.usage.tokens) && e.usage.tokens >= 0 && Number.isFinite(e.usage.window) && e.usage.window > 0)) why.push('usage')
    if ((e.kind === 'user' || e.kind === 'assistant' || e.kind === 'system' || e.kind === 'thinking') && typeof e.text !== 'string') why.push('no text')
    if (why.length) bad.push(`${e.id}: ${why.join(', ')}`)
  }
  return bad
}

function contractTest() {
  return {
    name: 'chat:contract:phone',
    group: 'chat',
    device: 'phone',
    timeout: 60_000,
    async run(t) {
      const entries = await serverEntries()
      const bad = contractProblems(entries)
      t.check(entries.length > 30 && !bad.length, `the server's entries break the page's contract: ${bad.slice(0, 6).join(' | ') || `only ${entries.length} entries`}`)
      const page = await t.page()
      madeUp(t, page, entries).sid = '0e2e0000-0000-4000-8000-00000000a001'
      await page.goto(`/m/ai/term/${PANE}`)
      await waitChat(page, 'Done. Two files listed.', 12_000)
      await sleep(500)
      const r = await report(page)
      const extra = await page.eval(() => ({
        cmds: [...document.querySelectorAll('.vch-user-cmd code')].map((e) => e.textContent),
        alerts: [...document.querySelectorAll('.vch-sys[data-tone="alert"]')].map((e) => (e.textContent ?? '').trim()),
      }))
      t.check(r.users.includes('Please list the files in the demo folder and make a plan.') && r.users.includes('also check c.txt'), `the typed and queued prompts: ${JSON.stringify(r.users)}`)
      t.check(extra.cmds.includes('/model sonnet') && extra.cmds.includes('! git status'), `the slash command and the ! line: ${JSON.stringify(extra.cmds)}`)
      t.check(extra.alerts.includes('Interrupted') && extra.alerts.some((a) => a.startsWith('API Error:')), `the alert lines: ${JSON.stringify(extra.alerts)}`)
      for (const want of ['Set model to sonnet', 'On branch main', 'Conversation compacted', 'Earlier conversation compacted.', 'Background task completed: Background build finished']) {
        t.check(r.sys.some((x) => x.startsWith(want)), `no system line starting "${want}" (${JSON.stringify(r.sys)})`)
      }
      t.check(r.think.length === 1 && r.think[0].head === 'The user wants a listing first.', `thinking: ${JSON.stringify(r.think)}`)
      const line = (k, main) => r.tools.find((x) => x.k === k && x.main === main)
      t.check(line('run', 'ls')?.d === '2 lines', `the ls line: ${JSON.stringify(line('run', 'ls'))}`)
      t.check(line('run', 'cat missing.txt')?.d === 'exit 1', `the failed cat line: ${JSON.stringify(line('run', 'cat missing.txt'))}`)
      t.check(line('read', 'picture.png')?.d === 'image', `the image Read line: ${JSON.stringify(line('read', 'picture.png'))}`)
      t.check(line('ask', 'Which file first?')?.d === 'rejected', `the AskUserQuestion line: ${JSON.stringify(line('ask', 'Which file first?'))}`)
      t.check(!r.tools.some((x) => x.main.startsWith('Task ')), 'a TaskCreate or TaskUpdate call drew its own line beside the todo list')
      t.check(r.strip?.shown && /Todos\s*0\/1\s*Read a\.txt/.test(r.strip.head), `the todo strip after TaskCreate, TaskUpdate and delete: ${JSON.stringify(r.strip)}`)
      t.check(r.foot.model === 'Test 1', `the footer model reads "${r.foot.model}"`)
      await t.shot(page, 'contract')
    },
  }
}

// ---------- the server's own pages: rewinds, the task list, the context meter ----------

/** lib/transcript-pages.mts run on the backend's code: { first, rewound, quiet }. */
function serverPages() {
  return new Promise((res, rej) => {
    execFile(process.execPath, ['--import', 'tsx', PAGES], { cwd: BACKEND, windowsHide: true, timeout: 60_000, maxBuffer: 32 << 20, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) return rej(new Error(`the backend pages did not build (${(errOut || err.message).trim().slice(0, 300)})`))
      try { res(JSON.parse(out)) } catch (e) { rej(new Error(`the backend pages printed no JSON: ${e.message}`)) }
    })
  })
}

const TASKS = [['Write the outline', 'completed'], ['Draft section one', 'in_progress'], ['Check the numbers', 'pending']]

function serverTest(device) {
  const wide = device !== 'phone'
  return {
    name: `chat:server:${device}`,
    group: 'chat',
    device,
    timeout: 90_000,
    async run(t) {
      const pages = await serverPages()
      const bad = [...contractProblems(pages.first.entries), ...contractProblems(pages.rewound.entries)]
      t.check(!bad.length, `the server's pages break the page's contract: ${bad.slice(0, 6).join(' | ')}`)
      t.check(pages.first.cursor.split(':').length === 3 && !pages.first.reset && pages.rewound.reset, `the server's pages: cursor ${pages.first.cursor}, reset ${pages.first.reset}/${pages.rewound.reset}`)
      const page = await t.page()
      t.allowSockets.push(/\/ws\/terminal\?s=vk-e2e00000b[12]&/)
      quietThor(page)
      page.mock('/api/terminal/sessions', () => ok(panesState()))
      // first read: the first page; its cursor: nothing new until the rewind, then the rewound page
      const st = { log: [], rewind: false }
      page.mock(TRANSCRIPT, ({ query }) => {
        const after = typeof query.after === 'string' ? query.after : ''
        st.log.push(after)
        if (!after) return ok(pages.first)
        if (after === pages.first.cursor) return ok(st.rewind ? pages.rewound : { ...pages.quiet, cursor: pages.first.cursor })
        return ok(pages.quiet)
      })
      await page.goto(`/m/ai/term/${PANE}`)
      await page.waitFor(() => document.querySelector('[data-term-root]'), { timeout: 12_000, message: 'the session page did not render' })

      const todoRows = async () => {
        if (wide) return (await report(page)).side
        const open = await page.eval(() => document.querySelector('.vch-todos[data-v="strip"]')?.hasAttribute('data-open'))
        if (!open) {
          await page.tap('.vch-todos[data-v="strip"] .vch-todos-head')
          await page.waitFor(() => document.querySelectorAll('.vch-todos[data-v="strip"] .vch-todo').length > 0, { timeout: 3000, message: 'the todo strip did not open' })
        }
        return (await report(page)).strip
      }
      const checkTodos = async (when) => {
        const list = await todoRows()
        const rows = (list?.rows ?? []).map((x) => [x.t, x.s])
        t.check(list?.shown && /Todos\s*1\/3/.test(list.head) && JSON.stringify(rows) === JSON.stringify(TASKS), `${when}: the todo list reads ${JSON.stringify(list)}, want every task by name: ${JSON.stringify(TASKS)}`)
        t.check(!rows.some(([x]) => /^Task \d+$/.test(x)), `${when}: a task shows by number only`)
      }
      const ctxMeter = (r) => r.foot.meta.find((m) => m.t.startsWith('ctx'))

      await t.step('first page: the live branch, every task by name, the context from usage', async () => {
        await waitChat(page, 'Abandoned summary of the files.', 12_000)
        await sleep(600)
        const r = await report(page)
        t.check(r.users.includes('Read both sample files.') && r.users.includes('Summarize them in one line'), `the prompts: ${JSON.stringify(r.users.slice(-3))}`)
        t.check(!r.users.includes('Summarize them, sent too soon'), 'the send that was canceled and sent again still shows')
        const reads = r.tools.filter((x) => x.k === 'read')
        t.check(reads.map((x) => `${x.main}:${x.s}:${x.d}`).join(',') === 'a.txt:ok:1 line,b.txt:ok:1 line', `the two parallel reads and their results: ${JSON.stringify(reads)}`)
        const ctx = ctxMeter(r)
        t.check(ctx?.t === 'ctx 17% used' && !ctx.hot, `the context meter reads ${JSON.stringify(ctx)}, want "ctx 17% used" (170k of the 1M window the model attachment before the window names)`)
        t.check(r.foot.model === 'Test 1', `the footer model reads "${r.foot.model}"`)
        t.check(st.log[0] === '' && st.log.slice(1).every((x) => x === pages.first.cursor), `the reads after the first did not hand the cursor back as it came: ${JSON.stringify([...new Set(st.log)])}`)
        await checkTodos('first page')
        await t.shot(page, 'server')
      })

      await t.step('a rewind: the dropped turn leaves, the new branch shows', async () => {
        st.rewind = true
        await waitChat(page, 'Compared on the new branch.')
        await waitGone(page, 'Abandoned summary of the files.')
        await sleep(600)
        const r = await report(page)
        t.check(!r.users.includes('Summarize them in one line') && r.users.includes('Compare them instead'), `after the rewind the prompts read ${JSON.stringify(r.users.slice(-3))}`)
        t.check(r.said.includes('Both sample files are read.'), 'the turn before the rewind point left with the dropped one')
        const ctx = ctxMeter(r)
        t.check(ctx?.t === 'ctx 9% used', `after the rewind the context meter reads ${JSON.stringify(ctx)}, want "ctx 9% used"`)
        // the page polls once a second: the read after the rewound page carries its cursor
        for (let i = 0; i < 40 && !st.log.includes(pages.rewound.cursor); i++) await sleep(100)
        t.check(st.log.includes(pages.rewound.cursor), `no read carried the cursor the rewound page gave (reads: ${JSON.stringify([...new Set(st.log.map((x) => x.slice(-12)))])})`)
        await atBottom(page)
        await checkTodos('after the rewind')
        await t.shot(page, 'server-rewound')
      })
    },
  }
}

export function chatTests() {
  return [...DEVICES.flatMap((d) => [viewTest(d), liveTest(d), paneTest(d), serverTest(d)]), contractTest()]
}
