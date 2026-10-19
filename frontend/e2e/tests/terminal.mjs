// TERMINAL: the v2 terminal (/m/ai/term/<name>, src/v2/screens/Term.tsx) on a
// real tmux pane, and the switch that sends /sessions/terminal?s=<name> to it.
//
// Every test here makes its OWN throwaway shell pane on odin (lib/odin.mjs),
// passes that exact name, and kills it in a finally block, pass or fail. The
// page is fenced to that one name (lib/cdp.mjs `term`): its socket is the only
// terminal socket allowed, the pane list it reads is cut down to that one pane
// (so even a page that picked a session on its own could only pick this one),
// and every write is still answered in the browser. The socket rides the
// probe's '/ws' proxy (vite.v2probe.config.ts), so a probe without it fails
// here at "attach".
//
// What reaches the pane is checked twice: the frames the page sent (a hook on
// the allowed socket) and what the shell printed back, read off the screen.

import { sleep } from '../lib/cdp.mjs'
import { TARGETS, rgbState } from '../lib/fixtures.mjs'
import { killPane, listPanes, openThrowawayPane } from '../lib/odin.mjs'
import { agent, chooser, fixtures } from './upload.mjs'

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } }
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }

// Shell lines. Octal escapes keep the typed line ASCII; only the output carries Claude Code's glyphs.
const RULE = '\\342\\224\\200'.repeat(12)
const TOOL_LINES = String.raw`printf '\342\227\217 Read(src/e2e/sample.ts)\n  \342\216\277  Read 12 lines\n\342\227\217 Bash(ls -la /tmp)\n  \342\216\277  (No content)\n'`
export const PROMPT = `printf '${RULE}\\n Bash command\\n   ls /tmp/e2e-sample\\n\\n Do you want to proceed?\\n \\342\\235\\257 1. Yes\\n   2. Yes, and do not ask again for ls here\\n   3. No, and tell Claude what to do differently (esc)\\n'`

// The quick keys in their row order, then Ctrl folding the next key: what each must send.
const KEY_BYTES = [
  ['esc', '\x1b'], ['tab', '\t'], ['stab', '\x1b[Z'], ['up', '\x1b[A'], ['down', '\x1b[B'], ['slash', '/'],
  ['y', 'y'], ['n', 'n'], ['1', '1'], ['2', '2'], ['3', '3'], ['left', '\x1b[D'], ['right', '\x1b[C'],
]
// what `cat -vT` prints for all of them, Ctrl+y, then Enter
const CAT_LINE = '^[^I^[[Z^[[A^[[B/yn123^[[D^[[C^Y'

/**
 * Reads the page makes, kept off thor and cut down to the one pane: the pane
 * list is odin's real one (a GET through the probe), filtered to `name`, with
 * its mode rewritten when `mode` is given (a shell pane shown as a Claude pane,
 * so the question plates can be driven from a shell).
 */
export function fence(page, base, name, mode) {
  const ok = (body) => ({ status: 200, body })
  page.mock('/api/session-board', () => ok({ sessions: [], hookRunsSkipped: 0 }))
  page.mock('/api/hosts/thor/sessions', () => ok({ sessions: [], hookRunsSkipped: 0 }))
  page.mock('/api/hosts/thor/launch-targets', () => ok(TARGETS))
  page.mock('/api/hosts/thor/rgb', () => ok(rgbState('lit')))
  page.mock('/api/terminal/sessions', async () => {
    const list = (await listPanes(base)).filter((s) => s.name === name)
    return ok(mode ? list.map((s) => ({ ...s, mode })) : list)
  })
}

/** The page is attached: its socket for `name` is open and the dot reads live. */
export async function attached(page, name, timeout = 15_000) {
  await page.waitFor(() => document.querySelector('.vtm-dot')?.getAttribute('data-conn') === 'live', { timeout, message: 'the terminal never read live (is the probe missing its /ws proxy?)' })
  const opened = await page.eval(() => window.__e2e.wsOpened.map((x) => x.url))
  if (!opened.length || !opened.every((u) => new URL(u).searchParams.get('s') === name)) throw new Error(`sockets opened: ${opened.join(', ')}`)
  await page.waitFor(() => window.__e2e.wsRx > 0, { timeout: 8000, message: 'the pane sent nothing back' })
  await sleep(600)
}

/** The terminal's visible rows as text. */
const screenOf = (sel) => (document.querySelector(sel)?.innerText ?? '').replace(/\u00a0/g, ' ')

/** Waits for `re` on the screen; `flat` reads it with the rows run together (a line the grid wrapped). */
export async function waitScreen(page, re, { sel = '.vsk-term .xterm-rows', timeout = 8000, flat = false } = {}) {
  const spec = { re: re.source, flags: re.flags, flat }
  try {
    await page.waitFor((s, q) => {
      const txt = (document.querySelector(s)?.innerText ?? '').replace(/\u00a0/g, ' ')
      return new RegExp(q.re, q.flags).test(q.flat ? txt.replace(/\n/g, '') : txt)
    }, { args: [sel, spec], timeout })
  } catch {
    const tail = (await page.eval(screenOf, sel)).split('\n').filter((l) => l.trim()).slice(-6).join(' | ')
    throw new Error(`the screen never showed ${re} (bottom rows: ${tail})`)
  }
}

/** Input frames ({t:'i'}) the page sent after frame `from`, as { d, at }. */
export async function inputs(page, from = 0) {
  const sent = await page.eval(() => window.__e2e.wsSent)
  return sent.slice(from).map((x) => {
    try { return { ...JSON.parse(x.d), at: x.at } } catch { return { t: '?', at: x.at } }
  }).filter((m) => m.t === 'i')
}
export const sentCount = (page) => page.eval(() => window.__e2e.wsSent.length)

/** Types a line in the composer and presses Send. */
export async function compose(page, text) {
  await page.tap('.vsk-input')
  await page.eval(() => document.querySelector('.vsk-input')?.focus())
  await page.type(text)
  await page.waitFor((v) => document.querySelector('.vsk-input')?.value === v, { args: [text], timeout: 3000, message: 'the composer did not take the text' })
  await page.tap('.vsk-send')
  await page.waitFor(() => document.querySelector('.vsk-input')?.value === '', { timeout: 3000, message: 'Send did not empty the composer' })
  // the Enter follows the text 120 ms later, on its own
  await sleep(350)
}

/** The last resize frame the page sent. */
async function lastResize(page) {
  const sent = await page.eval(() => window.__e2e.wsSent)
  for (let i = sent.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(sent[i].d)
      if (m.t === 'r') return { cols: m.cols, rows: m.rows, n: sent.filter((x) => /"t":"r"/.test(x.d)).length }
    } catch { /* not JSON */ }
  }
  return null
}

/** Makes a throwaway pane, runs body(name), and kills the pane whatever happened. */
export async function withPane(t, body) {
  let name = null
  try {
    name = await openThrowawayPane()
    t.note(`throwaway pane ${name}`)
    await body(name)
  } finally {
    if (name) {
      try {
        const said = await killPane(name)
        t.note(`killed ${name}: ${said}`)
        const still = (await listPanes(t.env.base)).some((s) => s.name === name)
        t.check(!still, `the throwaway pane ${name} is still listed after the kill`)
      } catch (e) {
        t.fails.push(`could not kill the throwaway pane ${name}: ${e.message}`)
      }
    }
  }
}

export function terminalTests() {
  return [
    {
      name: 'term:v2:pane',
      group: 'terminal',
      device: 'phone',
      timeout: 200_000,
      async run(t) {
        await withPane(t, async (name) => {
          const base = t.env.base
          const page = await t.page({ term: name })
          fence(page, base, name)
          // the upload into the session: every chunk is answered here, like thor's agent would
          const upLog = []
          agent(page, () => 'ok', upLog)
          const pick = await chooser(page)
          await page.goto(`/m/ai/term/${name}`)

          await t.step('attach', async () => {
            await attached(page, name)
            const head = await page.eval(() => ({
              title: document.querySelector('.vsk-title h1')?.textContent ?? '',
              host: document.querySelector('.vsk-m-host b')?.textContent ?? '',
              kind: [...document.querySelectorAll('.vsk-meta .vsk-m')].map((e) => e.textContent).join('|'),
              placeholder: document.querySelector('.vsk-input')?.getAttribute('placeholder') ?? '',
              keys: [...document.querySelectorAll('.vsk-key')].map((e) => e.getAttribute('data-k')).join(','),
              path: location.pathname,
            }))
            t.check(head.title === 'v2 test', `the title reads "${head.title}", want the pane's label "v2 test"`)
            t.check(head.host === 'odin' && /\bshell\b/.test(head.kind), `the meta row reads host "${head.host}", "${head.kind}"`)
            t.check(head.placeholder === 'Command', `a shell pane's composer says "${head.placeholder}"`)
            t.check(head.keys === 'esc,ctrlc,tab,stab,up,down,slash,y,n,1,2,3,left,right,ctrl,kbd', `the quick keys run ${head.keys}`)
            t.check(head.path === `/m/ai/term/${name}`, `the address moved to ${head.path}`)
            await t.shot(page, 'attached')
          })
          if (t.fails.length) return

          await t.step('composer: a line reaches the shell and its output comes back', async () => {
            const from = await sentCount(page)
            await compose(page, 'echo e2e-$((6*7))-ok')
            await waitScreen(page, /^e2e-42-ok\s*$/m)
            const frames = await inputs(page, from)
            const text = frames.findIndex((f) => f.d.includes('echo e2e-$((6*7))-ok'))
            t.check(text >= 0, `the line was never sent (frames: ${JSON.stringify(frames.map((f) => f.d))})`)
            const enter = frames[text + 1]
            t.check(enter?.d === '\r', `the frame after the text is ${JSON.stringify(enter?.d)}, want a lone Enter`)
            if (enter) t.check(enter.at - frames[text].at >= 100, `Enter followed the text after ${enter.at - frames[text].at} ms, want the paste and the Enter apart (120 ms)`)
            t.check(!frames[text].d.includes('\r'), 'the Enter rode in the same frame as the text (Claude Code would read it as a newline)')
          })

          await t.step('quick keys: each sends its bytes, Ctrl folds the next key', async () => {
            await compose(page, 'cat -vT')
            await sleep(700)
            const from = await sentCount(page)
            for (const [k] of KEY_BYTES) {
              await page.tap(`.vsk-key[data-k="${k}"]`)
              await sleep(110)
            }
            await page.tap('.vsk-key[data-k="ctrl"]')
            t.check((await page.eval(() => document.querySelector('.vsk-key[data-k="ctrl"]')?.getAttribute('aria-pressed'))) === 'true', 'Ctrl did not arm')
            await page.tap('.vsk-key[data-k="y"]')
            t.check((await page.eval(() => document.querySelector('.vsk-key[data-k="ctrl"]')?.getAttribute('aria-pressed'))) === 'false', 'Ctrl stayed armed after the key it folded')
            await page.tap('.vsk-send')
            const want = [...KEY_BYTES.map(([, b]) => b), '\x19', '\r']
            const got = (await inputs(page, from)).map((f) => f.d)
            t.check(JSON.stringify(got) === JSON.stringify(want), `the keys sent ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
            const focus = await page.eval(() => document.activeElement?.className ?? '')
            t.check(/vsk-input/.test(focus), `a key press took the focus from the composer (now on "${focus}")`)
            await waitScreen(page, new RegExp(`^${CAT_LINE.replace(/[\^[\]/]/g, '\\$&')}\\s*$`, 'm'))
            const from2 = await sentCount(page)
            await page.tap('.vsk-key[data-k="ctrlc"]')
            t.check((await inputs(page, from2)).map((f) => f.d).join('') === '\x03', '^C did not send 0x03')
            await sleep(400)
            await compose(page, 'echo after-$((40+2))')
            await waitScreen(page, /^after-42\s*$/m)
            await t.shot(page, 'keys')
          })

          await t.step('activity strip: tool lines on the screen become rows', async () => {
            await compose(page, 'clear')
            await sleep(400)
            await compose(page, TOOL_LINES)
            await page.waitFor(() => /1 read/.test(document.querySelector('.vsk-act-n')?.textContent ?? '') && /1 run/.test(document.querySelector('.vsk-act-n')?.textContent ?? ''), {
              timeout: 6000, message: 'the activity strip did not count one read and one run',
            }).catch(async (e) => { throw new Error(`${e.message} (it says "${await page.eval(() => document.querySelector('.vsk-act-n')?.textContent)}")`) })
          })

          await t.step('a shell pane never shows question plates', async () => {
            await compose(page, PROMPT)
            await waitScreen(page, /Do you want to proceed\?/)
            await sleep(900)
            const s = await page.eval(() => ({ ask: !!document.querySelector('.vsk-ask'), phase: document.querySelector('[data-term-root]')?.getAttribute('data-phase') }))
            t.check(!s.ask && s.phase !== 'asking', `a shell pane drew plates (phase ${s.phase})`)
            await compose(page, 'clear')
          })

          await t.step('upload into the session: the saved path is typed, no Enter', async () => {
            const fx = fixtures()
            const from = await sentCount(page)
            const chosen = pick([fx.sunset])
            await page.tap({ sel: '.vtm-bar-btn', text: 'Send photos or videos to thor' })
            t.check((await chosen) === 'selectMultiple', 'the upload button did not open a multi-file picker')
            const path = 'C:\\Thor\\uploads\\20261018-141500-sunset.png'
            await page.waitFor((p) => window.__e2e.wsSent.some((x) => x.d.includes(JSON.stringify(p + ' ').slice(1, -1))), { args: [path], timeout: 10_000, message: 'the saved path never reached the pane' })
            const frames = (await inputs(page, from)).map((f) => f.d)
            t.check(frames.includes(`${path} `), `the path went as ${JSON.stringify(frames)}`)
            t.check(!frames.some((d) => d.includes('\r')), 'the upload pressed Enter after the path')
            t.check(upLog.length === 1 && upLog[0].name === 'sunset.png', `upload chunks: ${JSON.stringify(upLog.map((l) => l.name))}`)
            await waitScreen(page, /20261018-141500-sunset\.png/, { flat: true })
            await page.tap('.vsk-key[data-k="ctrlc"]')
            await sleep(300)
          })

          await t.step('rotate: the grid refits and the pty follows', async () => {
            const before = await lastResize(page)
            if (!before) throw new Error('no resize frame was ever sent (attach sends one)')
            await page.send('Emulation.setDeviceMetricsOverride', LANDSCAPE)
            await page.waitFor((n) => window.__e2e.wsSent.filter((x) => /"t":"r"/.test(x.d)).length > n, { args: [before.n], timeout: 6000, message: 'no resize frame after the rotation' })
            await sleep(700)
            const after = await lastResize(page)
            t.check(after.cols > before.cols && after.rows < before.rows, `rotation went from ${before.cols}x${before.rows} to ${after.cols}x${after.rows}`)
            await compose(page, 'stty size')
            await waitScreen(page, new RegExp(`^${after.rows} ${after.cols}\\s*$`, 'm'))
            await t.shot(page, 'landscape')
            await page.send('Emulation.setDeviceMetricsOverride', PHONE)
            await page.waitFor((c) => window.__e2e.wsSent.filter((x) => /"t":"r"/.test(x.d)).length > c, { args: [after.n], timeout: 6000, message: 'no resize frame after rotating back' })
          })

          // the same pane shown as a Claude pane: a permission prompt on the screen becomes plates
          const ask = await t.page({ term: name })
          fence(ask, base, name, 'new')
          await ask.goto(`/m/ai/term/${name}`)
          await t.step('question plates on a Claude pane', async () => {
            await attached(ask, name)
            t.check((await ask.eval(() => document.querySelector('.vsk-input')?.getAttribute('placeholder'))) === 'Message Claude', 'the Claude pane composer does not say Message Claude')
            await compose(ask, 'clear')
            await sleep(400)
            await compose(ask, PROMPT)
            await ask.waitFor(() => document.querySelector('.vtm-askdock .vsk-ask'), { timeout: 8000, message: 'no question plates over the screen' })
            const q = await ask.eval(() => ({
              kind: document.querySelector('.vsk-ask-head span')?.textContent ?? '',
              file: document.querySelector('.vsk-ask-head b')?.textContent ?? '',
              text: document.querySelector('.vsk-ask-q')?.textContent ?? '',
              opts: [...document.querySelectorAll('.vsk-opt')].map((o) => ({ label: o.getAttribute('aria-label'), hint: o.querySelector('.vsk-opt-k')?.textContent ?? '', sel: o.hasAttribute('data-sel') })),
              phase: document.querySelector('[data-term-root]')?.getAttribute('data-phase'),
              lit: [...document.querySelectorAll('.vsk-key[data-lit="ask"]')].map((k) => k.getAttribute('data-k')).join(','),
            }))
            t.check(q.text === 'Do you want to proceed?', `the plates ask "${q.text}"`)
            t.check(q.kind === 'Bash command' && q.file === 'e2e-sample', `the plate head reads "${q.kind}" / "${q.file}"`)
            t.check(q.opts.map((o) => o.label).join(' | ') === '1. Yes | 2. Yes, and do not ask again for ls here | 3. No, and tell Claude what to do differently', `options: ${q.opts.map((o) => o.label).join(' | ')}`)
            t.check(q.opts[0]?.sel && q.opts[2]?.hint === 'esc', `the picked option or the esc hint is lost: ${JSON.stringify(q.opts)}`)
            t.check(q.phase === 'asking', `the page phase is ${q.phase}, want asking`)
            t.check(q.lit === 'esc,y,n,1,2,3', `the answer keys lit: ${q.lit}`)
            await t.shot(ask, 'plates')
            const from = await sentCount(ask)
            await ask.tap({ sel: '.vsk-opt', text: '2. Yes, and do not ask' })
            t.check((await inputs(ask, from)).map((f) => f.d).join('') === '2', 'plate 2 did not send "2"')
            await ask.tap('.vsk-key[data-k="ctrlc"]')
            await ask.waitFor(() => !document.querySelector('.vsk-ask'), { timeout: 6000, message: 'the plates stayed after the prompt left the bottom of the screen' })
          })

          await t.step('the pane ends: Not open, and no reconnect', async () => {
            await killPane(name)
            for (const p of [page, ask]) {
              await p.waitFor(() => /Not open/.test(document.querySelector('.vtm-panel-k')?.textContent ?? ''), { timeout: 10_000, message: 'the page did not say Not open after the pane was killed' })
            }
            const n = await Promise.all([page, ask].map((p) => p.eval(() => window.__e2e.wsOpened.length)))
            await sleep(11_000)
            const m = await Promise.all([page, ask].map((p) => p.eval(() => window.__e2e.wsOpened.length)))
            t.check(m[0] === n[0] && m[1] === n[1], `a page opened the dead pane's socket again (${n} -> ${m})`)
            const dots = await Promise.all([page, ask].map((p) => p.eval(() => document.querySelector('.vtm-dot')?.getAttribute('data-conn'))))
            t.check(dots.every((d) => d === 'closed'), `the dots read ${dots.join(', ')}`)
            await t.shot(ask, 'gone')
          })
        })
      },
    },

    {
      // /sessions/terminal?s=<name>: the iPhone and the desktop land on the v2 terminal; ?classic=1 keeps the classic page
      name: 'term:switch',
      group: 'terminal',
      device: 'phone',
      timeout: 120_000,
      async run(t) {
        await withPane(t, async (name) => {
          const base = t.env.base
          await t.step('iPhone profile: /sessions/terminal?s= lands on /m/ai/term/<name>', async () => {
            const page = await t.page({ term: name, storage: { 'valkyrie-device-mode': 'iphone' } })
            fence(page, base, name)
            await page.goto(`/sessions/terminal?s=${name}`)
            await page.waitPath(`/m/ai/term/${name}`, 10_000)
            await attached(page, name)
            t.check(await page.eval(() => document.documentElement.hasAttribute('data-v2') && !!document.querySelector('[data-term-root]')), 'the v2 terminal is not on screen')

            // More > Classic terminal: the same pane on the classic page
            await page.tap('.vsk-replay')
            await page.tap({ sel: '.vtm-more button', text: 'Classic terminal' })
            await page.waitPath(/^\/sessions\/terminal\?s=vk-[0-9a-f]{10}/, 8000)
            await page.waitFor(() => !document.documentElement.hasAttribute('data-v2') && document.querySelector('[data-shell] .xterm'), { timeout: 10_000, message: 'the classic terminal did not render' })
            await page.waitFor((n) => window.__e2e.wsOpened.length >= 2 && window.__e2e.wsOpened.every((x) => new URL(x.url).searchParams.get('s') === n), { args: [name], timeout: 8000, message: 'the classic page did not attach to the same pane' })
            const p = await page.path()
            t.check(p.startsWith(`/sessions/terminal?s=${name}`), `the classic page sits at ${p}`)
            t.check((await page.eval(() => sessionStorage.getItem('valkyrie-ui'))) === 'classic', 'the tab is not marked classic after More > Classic terminal')
          })
          await t.step('desktop: /sessions/terminal?s= lands on the v2 terminal', async () => {
            const page = await t.page({ term: name, device: 'desk1080' })
            fence(page, base, name)
            await page.goto(`/sessions/terminal?s=${name}`)
            await page.waitPath(`/m/ai/term/${name}`, 10_000)
            await attached(page, name)
            t.check(await page.eval(() => document.documentElement.hasAttribute('data-v2') && !!document.querySelector('[data-term-root]')), 'the v2 terminal is not on screen on the desktop')
            await t.shot(page, 'v2-desktop')
          })
          await t.step('desktop: ?classic=1 keeps the classic page, and it types', async () => {
            const page = await t.page({ term: name, device: 'desktop' })
            fence(page, base, name)
            await page.goto(`/sessions/terminal?s=${name}&classic=1`)
            await page.waitFor(() => document.querySelector('[data-shell] .xterm'), { timeout: 10_000, message: 'the classic terminal did not render on the desktop' })
            await page.waitFor(() => window.__e2e.wsOpened.length > 0 && window.__e2e.wsRx > 0, { timeout: 10_000, message: 'the classic page never attached' })
            const s = await page.eval(() => ({ path: location.pathname + location.search, v2: document.documentElement.hasAttribute('data-v2'), urls: window.__e2e.wsOpened.map((x) => x.url) }))
            t.check(s.path.startsWith(`/sessions/terminal?s=${name}`), `the classic page moved to ${s.path}`)
            t.check(!s.v2, '?classic=1 got the v2 terminal')
            t.check(s.urls.every((u) => new URL(u).searchParams.get('s') === name), `the desktop attached to ${s.urls.join(', ')}`)
            await sleep(800)
            await page.eval(() => document.querySelector('[data-shell] .xterm-helper-textarea')?.focus())
            await page.type('echo classic-$((2*21))')
            await page.key('Enter')
            await waitScreen(page, /^classic-42\s*$/m, { sel: '[data-shell] .xterm-rows' })
            await t.shot(page, 'classic-desktop')
          })
        })
      },
    },

    {
      // the v2 terminal never opens without a name, so it can never pick one
      name: 'term:no-name',
      group: 'terminal',
      device: 'phone',
      timeout: 40_000,
      async run(t) {
        const page = await t.page()
        for (const from of ['/m/ai/term', '/m/ai/term/', '/m/ai/term/not-a-pane', '/m/ai/term/vk-XYZ']) {
          await t.step(`${from} goes to AI > Sessions`, async () => {
            await page.goto(from)
            await page.waitPath('/m/ai/sessions', 8000)
          })
        }
        const opened = await page.eval(() => window.__e2e.blockedWs.length + window.__e2e.wsOpened.length)
        t.check(opened === 0, 'a terminal socket was tried with no pane named')
      },
    },
  ]
}
