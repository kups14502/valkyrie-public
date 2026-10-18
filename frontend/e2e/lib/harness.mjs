// The test context and the runner: a pool of tests, each in its own browser
// context, with a time limit per test and a failure list that a thrown error,
// a failed check or a console error in the page all land in.

import { Page, sleep } from './cdp.mjs'

export class Ctx {
  constructor(test, env) {
    this.test = test
    this.name = test.name
    this.env = env
    this.fails = []
    this.notes = []
    this.shots = []
    this.pages = []
    /** console errors the test expects (the page's own error path), matched by RegExp */
    this.allowProblems = []
    /**
     * Terminal sockets the test expects the fence to refuse, matched by RegExp on the URL: a
     * page that heads for a made-up pane (a fixture's vk-e2e... name) tries to attach to it.
     * Still refused in the page; only not counted as a failure.
     */
    this.allowSockets = []
  }

  /** A page in a fresh browser context (its own storage, like a new device). */
  async page(opts = {}) {
    const p = await Page.open(this.env.browser, { base: this.env.base, device: this.test.device ?? 'phone', name: this.name, ...opts })
    this.pages.push(p)
    return p
  }

  check(cond, msg) {
    if (!cond) this.fails.push(msg)
    return !!cond
  }

  note(msg) {
    this.notes.push(msg)
  }

  /** Runs one step; a throw becomes a failure named after the step, and the test goes on. */
  async step(label, fn) {
    try {
      return await fn()
    } catch (e) {
      this.fails.push(`${label}: ${e.message}`)
      return undefined
    }
  }

  async shot(page, name) {
    if (!this.env.shots) return null
    const file = `${this.env.shots}/${this.name.replace(/[^a-z0-9._-]+/gi, '_')}${name ? `-${name}` : ''}.jpg`
    try {
      await page.screenshot(file)
      this.shots.push(file)
    } catch (e) {
      this.notes.push(`screenshot failed: ${e.message}`)
    }
    return file
  }

  async finish() {
    for (const p of this.pages) {
      for (const pr of p.problems) {
        if (this.allowProblems.some((re) => re.test(pr))) continue
        this.fails.push(`page: ${pr}`)
      }
      for (const n of p.notes) this.notes.push(n)
      if (p.terminalLoads.length) this.fails.push(`the terminal page was requested: ${p.terminalLoads.join(', ')}`)
      const ws = ((await p.eval(() => (window.__e2e ? window.__e2e.blockedWs : [])).catch(() => [])) ?? [])
        .filter((u) => !this.allowSockets.some((re) => re.test(u)))
      if (ws.length) this.fails.push(`a socket to ${ws.join(', ')} was opened (blocked in the page)`)
    }
    await Promise.all(this.pages.map((p) => p.close()))
  }
}

/**
 * Runs `tests` `concurrency` at a time; a test marked `background` (long and
 * mostly idle, like the 130 s freshness watch) runs beside the pool instead of
 * holding a slot. Each result: { name, group, device, status: 'pass' | 'fail',
 * ms, fails, notes, shots }.
 */
export async function runAll(tests, env, { concurrency = 3, onDone, gate } = {}) {
  const queue = tests.filter((t) => !t.background)
  const side = tests.filter((t) => t.background)
  const results = []
  const one = async (test) => {
    if (gate) await gate(test)
    const t = new Ctx(test, env)
    const t0 = Date.now()
    const limit = test.timeout ?? 60_000
    let timer
    try {
      await Promise.race([
        test.run(t),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(limit / 1000)} s`)), limit) }),
      ])
    } catch (e) {
      t.fails.push(e.message)
    } finally {
      clearTimeout(timer)
    }
    await t.finish().catch((e) => t.fails.push(`cleanup: ${e.message}`))
    const r = {
      name: test.name, group: test.group, device: test.device ?? 'phone',
      status: t.fails.length ? 'fail' : 'pass', ms: Date.now() - t0,
      fails: [...new Set(t.fails)], notes: [...new Set(t.notes)].slice(0, 25), shots: t.shots,
    }
    results.push(r)
    onDone?.(r)
  }
  const worker = async () => {
    for (let test = queue.shift(); test; test = queue.shift()) {
      await one(test)
      // a breath between tests, so a closing context's work does not land on the next one
      await sleep(150)
    }
  }
  await Promise.all([...side.map(one), ...Array.from({ length: Math.max(1, concurrency) }, worker)])
  const order = new Map(tests.map((t, i) => [t.name, i]))
  return results.sort((a, b) => order.get(a.name) - order.get(b.name))
}
