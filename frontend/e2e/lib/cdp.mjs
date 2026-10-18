// The e2e suite's browser layer: CDP over Node's global WebSocket, no
// dependencies. One connection to the shared headless Edge on 127.0.0.1:9333
// (started on a private desktop by e2e/browser.ps1, never a visible window),
// and one fresh browser context per test (its own localStorage, cookies and
// cache, like a new device).
//
// Every page this opens is fenced in, whatever the test does:
//   - every /api request pauses in the browser (CDP Fetch). A GET either gets a
//     test's mock or goes on to the server; a write (anything not GET or HEAD)
//     is ALWAYS answered here, by the test's handler or with a 418, so no write
//     can ever leave the browser, even if --base points at a live backend.
//   - a document load of /sessions/terminal is answered with a stub page and
//     counted as a failure, and a client-side navigation there (pushState or
//     replaceState) is refused in the page, so the in-page terminal never
//     mounts and never opens its socket.
//   - a WebSocket to /api or to a terminal path is refused in the page.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CDP = 'http://127.0.0.1:9333'

export const DEVICES = {
  phone: { w: 390, h: 844, dpr: 3, mobile: true },
  landscape: { w: 844, h: 390, dpr: 3, mobile: true },
  desktop: { w: 1600, h: 900, dpr: 1, mobile: false },
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpVersion() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

/**
 * The shared headless Edge. When it is down, e2e/browser.ps1 starts it on its
 * private desktop (hidden PowerShell, no console window). Never launches Edge
 * any other way: a fresh profile costs a bad Windows logon each time.
 */
export async function ensureBrowser(log = console.log) {
  let v = await cdpVersion()
  if (v) return v
  log('headless Edge is not on :9333, starting it with e2e/browser.ps1 (private desktop)')
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(HERE, '..', 'browser.ps1')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  ps.stdout.on('data', (d) => { out += d })
  ps.stderr.on('data', (d) => { out += d })
  await new Promise((r) => ps.on('close', r))
  for (let i = 0; i < 40 && !v; i++) {
    v = await cdpVersion()
    if (!v) await sleep(250)
  }
  if (!v) throw new Error(`headless Edge did not come up on :9333. browser.ps1 said: ${out.trim().slice(0, 400)}`)
  return v
}

export class Browser {
  static async connect(log) {
    const v = await ensureBrowser(log)
    const b = new Browser()
    b.ws = new WebSocket(v.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      b.ws.onopen = res
      b.ws.onerror = () => rej(new Error('could not open the CDP socket'))
    })
    b.ws.onmessage = (ev) => b.dispatch(JSON.parse(ev.data))
    b.ws.onclose = () => {
      for (const { rej } of b.pending.values()) rej(new Error('CDP socket closed'))
      b.pending.clear()
    }
    b.version = v.Browser
    return b
  }

  seq = 0
  pending = new Map()
  /** sessionId -> handler(msg) */
  sessions = new Map()

  dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej, method } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`))
      else res(msg.result)
      return
    }
    if (msg.method && msg.sessionId) this.sessions.get(msg.sessionId)?.(msg)
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.seq
      this.pending.set(id, { res, rej, method })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

// ---------- the in-page fence (runs before any app script) ----------

const GUARD = `(() => {
  if (window.__e2e) return
  const e2e = window.__e2e = { blockedNav: [], blockedWs: [], toasts: [], seen: new WeakSet() }
  const termPath = (u) => {
    try {
      const p = new URL(String(u), location.href).pathname.replace(/\\/+$/, '')
      return p === '/sessions/terminal' || p.startsWith('/sessions/terminal/') || p === '/terminal'
    } catch { return false }
  }
  for (const k of ['pushState', 'replaceState']) {
    const orig = History.prototype[k]
    History.prototype[k] = function (state, title, url) {
      if (url != null && termPath(url)) { e2e.blockedNav.push({ how: k, url: String(url), at: Date.now() }); return }
      return orig.call(this, state, title, url)
    }
  }
  const WS = window.WebSocket
  window.WebSocket = new Proxy(WS, {
    construct(target, args) {
      let p = ''
      try { p = new URL(String(args[0]), location.href).pathname } catch { /* keep '' */ }
      if (p.startsWith('/api') || /terminal/.test(p)) {
        e2e.blockedWs.push(String(args[0]))
        throw new DOMException('WebSocket blocked by the e2e suite', 'SecurityError')
      }
      return Reflect.construct(target, args)
    },
  })
  // every toast that ever shows, with when (they leave after 2 to 5 s)
  const scan = () => {
    for (const el of document.querySelectorAll('.vl-toast-msg')) {
      const t = (el.textContent || '').trim()
      if (t && !e2e.seen.has(el)) { e2e.seen.add(el); e2e.toasts.push({ text: t, at: Date.now() }) }
    }
  }
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, characterData: true })
})()`

// ---------- a page in its own context ----------

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

function postBody(req) {
  if (typeof req.postData === 'string') return req.postData
  if (Array.isArray(req.postDataEntries)) {
    return req.postDataEntries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : '')).join('')
  }
  return ''
}

export class Page {
  /**
   * @param {Browser} browser
   * @param {{ base: string, device?: keyof DEVICES, storage?: Record<string,string>, name?: string }} opts
   */
  static async open(browser, opts) {
    const p = new Page(browser, opts)
    await p.init()
    return p
  }

  constructor(browser, { base, device = 'phone', storage = {}, name = '' }) {
    this.b = browser
    this.base = base.replace(/\/+$/, '')
    this.device = device
    this.dev = DEVICES[device]
    this.storage = storage
    this.name = name
    /** console errors, exceptions, same-origin load failures: each fails the test */
    this.problems = []
    /** console warnings, API errors the server gave: shown, never a failure */
    this.notes = []
    /** every /api request: { method, path, url, at, mocked } */
    this.api = []
    /** every write: { method, path, url, body, json, at } */
    this.writes = []
    /** document loads of the terminal: each is a failure */
    this.terminalLoads = []
    /** /api timing by request id: { path, start, end, status } (end null while waiting) */
    this.net = new Map()
    this.mocks = []
    this.writeHandler = null
    /** statuses we answered on purpose, so their console lines are not problems */
    this.expectedFail = new Set()
    this.listeners = []
  }

  async init() {
    const { browserContextId } = await this.b.send('Target.createBrowserContext', { disposeOnDetach: true })
    this.ctxId = browserContextId
    const { targetId } = await this.b.send('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true })
    this.targetId = targetId
    const { sessionId } = await this.b.send('Target.attachToTarget', { targetId, flatten: true })
    this.sid = sessionId
    this.b.sessions.set(sessionId, (m) => this.onEvent(m))
    const s = (m, p) => this.send(m, p)
    await s('Page.enable')
    await s('Runtime.enable')
    await s('Log.enable')
    await s('Network.enable').catch(() => {})
    await s('Page.bringToFront').catch(() => {})
    await s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    const d = this.dev
    await s('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile })
    if (d.mobile) {
      await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await s('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' })
    }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: GUARD })
    const keys = Object.entries(this.storage)
    if (keys.length) {
      const sets = keys.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')
      await s('Page.addScriptToEvaluateOnNewDocument', { source: `try{${sets}}catch(e){}` })
    }
    await s('Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/*', requestStage: 'Request' },
        { urlPattern: '*/sessions/terminal*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*/terminal', resourceType: 'Document', requestStage: 'Request' },
      ],
    })
  }

  send(method, params = {}) {
    return this.b.send(method, params, this.sid)
  }

  on(fn) {
    this.listeners.push(fn)
    return () => { this.listeners = this.listeners.filter((x) => x !== fn) }
  }

  onEvent(msg) {
    for (const l of this.listeners) {
      try { l(msg) } catch { /* a listener's own bug */ }
    }
    const p = msg.params
    switch (msg.method) {
      case 'Fetch.requestPaused':
        void this.onPaused(p)
        break
      case 'Network.requestWillBeSent': {
        let path = ''
        try { path = new URL(p.request.url).pathname } catch { /* not a URL */ }
        if (path.startsWith('/api/')) this.net.set(p.requestId, { path, start: Date.now(), end: null, status: 0 })
        break
      }
      case 'Network.responseReceived': {
        const r = this.net.get(p.requestId)
        if (r) r.status = p.response.status
        break
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const r = this.net.get(p.requestId)
        if (r) r.end = Date.now()
        break
      }
      case 'Runtime.consoleAPICalled': {
        const text = p.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 500)
        if (p.type === 'error' || p.type === 'assert') this.problems.push(`console.${p.type}: ${text}`)
        else if (p.type === 'warning') this.notes.push(`console.warn: ${text}`)
        break
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails
        this.problems.push(`exception: ${(d.exception?.description ?? d.text ?? '').slice(0, 700)}`)
        break
      }
      case 'Log.entryAdded': {
        const e = p.entry
        if (e.level !== 'error') break
        const url = e.url ?? ''
        const status = /status of (\d{3})/.exec(e.text)?.[1]
        if (e.source === 'network') {
          let same = false
          try { same = new URL(url).origin === new URL(this.base).origin } catch { /* not a URL */ }
          if (!same) this.notes.push(`external load failed: ${url}`.slice(0, 300))
          else if (/\/api\//.test(url)) {
            if (!(status && this.expectedFail.has(Number(status)))) this.notes.push(`api ${status ?? 'error'}: ${url.replace(this.base, '')}`.slice(0, 300))
          } else this.problems.push(`load failed: ${e.text} ${url}`.slice(0, 300))
        } else {
          this.problems.push(`log.${e.source}: ${e.text} ${url}`.slice(0, 400))
        }
        break
      }
      default:
    }
  }

  /** Mock a GET: `match` is a path string (exact, query ignored), a RegExp on the path, or fn(path, url). */
  mock(match, handler) {
    this.mocks.unshift({ match, handler })
  }

  /** The handler every write goes to: (req) => { status, body } | undefined (undefined = 418, a failure). */
  onWrite(handler) {
    this.writeHandler = handler
  }

  async onPaused(p) {
    const { requestId, request, resourceType } = p
    const url = new URL(request.url)
    const path = url.pathname
    const fulfill = (status, body, type = 'application/json') => this.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: [{ name: 'content-type', value: type }, { name: 'cache-control', value: 'no-store' }],
      body: b64(typeof body === 'string' ? body : JSON.stringify(body ?? null)),
    }).catch(() => {})
    try {
      if (resourceType === 'Document' && !path.startsWith('/api/')) {
        this.terminalLoads.push(request.url)
        await fulfill(200, '<!doctype html><title>blocked</title><p>The e2e suite never loads the terminal page.</p>', 'text/html')
        return
      }
      const method = request.method.toUpperCase()
      const rec = { method, path, url: request.url, at: Date.now(), mocked: false }
      this.api.push(rec)
      if (method !== 'GET' && method !== 'HEAD') {
        const body = postBody(request)
        let parsed
        try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
        const w = { method, path, url: request.url, body, json: parsed, at: Date.now() }
        this.writes.push(w)
        rec.mocked = true
        const out = this.writeHandler ? await this.writeHandler(w) : undefined
        if (!out) {
          this.problems.push(`unexpected write ${method} ${path} ${body.slice(0, 200)} (answered 418 in the browser)`)
          this.expectedFail.add(418)
          await fulfill(418, { error: 'the e2e suite answered this write in the browser' })
          return
        }
        if (out.status >= 400) this.expectedFail.add(out.status)
        await fulfill(out.status, out.body)
        return
      }
      for (const m of this.mocks) {
        const hit = typeof m.match === 'string' ? m.match === path : m.match instanceof RegExp ? m.match.test(path) : m.match(path, url)
        if (!hit) continue
        const out = await m.handler({ path, url, query: Object.fromEntries(url.searchParams) })
        if (!out) continue
        rec.mocked = true
        if (out.status >= 400) this.expectedFail.add(out.status)
        await fulfill(out.status, out.body)
        return
      }
      await this.send('Fetch.continueRequest', { requestId }).catch(() => {})
    } catch (e) {
      this.problems.push(`interceptor error on ${request.method} ${path}: ${e.message}`)
      await fulfill(599, { error: 'e2e interceptor error' })
    }
  }

  // ---------- navigation and evaluation ----------

  async goto(path, { timeout = 20000 } = {}) {
    const url = /^https?:/.test(path) ? path : this.base + path
    const loaded = new Promise((r) => {
      const off = this.on((m) => { if (m.method === 'Page.loadEventFired') { off(); r() } })
      setTimeout(() => { off(); r() }, timeout)
    })
    const r = await this.send('Page.navigate', { url })
    if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`)
    await loaded
  }

  /** Run fn(...args) in the page and return its (JSON) value. A string is evaluated as an expression. */
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) {
      throw new Error(`in page: ${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '').split('\n')[0]}`)
    }
    return r.result?.value
  }

  /** Poll fn in the page until it returns something truthy; throws `message` (or a timeout) after `timeout` ms. */
  async waitFor(fn, { timeout = 8000, interval = 120, args = [], message } = {}) {
    const t0 = Date.now()
    // an element comes back from the page as nothing: count it as found
    const call = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : `(${fn})`
    const expr = `Promise.resolve(${call}).then((v) => (typeof Node !== 'undefined' && v instanceof Node) ? true : v)`
    let last
    for (;;) {
      try {
        last = await this.eval(expr)
        if (last) return last
      } catch (e) {
        last = e.message
      }
      if (Date.now() - t0 > timeout) throw new Error(message ? `${message} (waited ${timeout} ms)` : `timed out after ${timeout} ms: ${String(fn).slice(0, 160)}`)
      await sleep(interval)
    }
  }

  async path() {
    return this.eval(() => location.pathname + location.search)
  }

  async waitPath(want, timeout = 6000) {
    const re = want instanceof RegExp ? want : null
    const t0 = Date.now()
    let p = ''
    while (Date.now() - t0 < timeout) {
      p = await this.path()
      if (re ? re.test(p) : p === want || p.split('?')[0] === want) return p
      await sleep(100)
    }
    throw new Error(`expected the address ${want}, still ${p} after ${timeout} ms`)
  }

  // ---------- input ----------

  /**
   * Where to touch an element: { sel, text?, within?, index? }. `text` matches the
   * element's text or aria-label (a string to contain, or a RegExp). Scrolls it
   * into view, then checks nothing covers its center.
   */
  async locate(target) {
    const t = typeof target === 'string' ? { sel: target } : target
    const spec = { sel: t.sel, within: t.within ?? null, index: t.index ?? 0, text: t.text instanceof RegExp ? { re: t.text.source, flags: t.text.flags } : t.text ?? null }
    return this.eval((s) => {
      const root = s.within ? document.querySelector(s.within) : document
      if (!root) return { error: `no ${s.within}` }
      const match = (el) => {
        if (!s.text) return true
        const hay = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
        if (typeof s.text === 'string') return hay.includes(s.text)
        return new RegExp(s.text.re, s.text.flags).test(hay)
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return false
        if (el.closest('[inert],[hidden]')) return false
        const cs = getComputedStyle(el)
        return cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const all = [...root.querySelectorAll(s.sel)].filter((el) => match(el) && visible(el))
      const el = all[s.index]
      if (!el) return { error: `nothing visible matches ${s.sel}${s.text ? ` with ${JSON.stringify(s.text)}` : ''} (${all.length} found)` }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const at = document.elementFromPoint(x, y)
      const covered = at && at !== el && !el.contains(at)
        ? (at.className && typeof at.className === 'string' ? `${at.tagName}.${at.className.split(' ').slice(0, 2).join('.')}` : at.tagName)
        : null
      return { x, y, w: r.width, h: r.height, covered, disabled: !!el.disabled }
    }, spec)
  }

  /**
   * Tap (touch on a phone, click on the desktop) an element or a point. An
   * element still building in (hidden, covered, disabled) is waited for, up to
   * `wait` ms, then the tap fails with why.
   */
  async tap(target, { allowCovered = false, wait = 4000 } = {}) {
    let x, y
    if (typeof target === 'object' && 'x' in target && 'y' in target && !('sel' in target)) {
      ({ x, y } = target)
    } else {
      const t0 = Date.now()
      let why = ''
      for (;;) {
        await sleep(60)
        const at = await this.locate(target)
        why = at.error ?? (at.covered && !allowCovered ? `${JSON.stringify(target)} is covered by ${at.covered}` : at.disabled ? `${JSON.stringify(target)} is disabled` : '')
        if (!why) {
          ;({ x, y } = at)
          break
        }
        if (Date.now() - t0 > wait) throw new Error(why)
        await sleep(120)
      }
    }
    if (this.dev.mobile) {
      const pt = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt })
      await sleep(50)
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(30)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }
    await sleep(80)
  }

  /** A finger (or mouse) drag from (x1, y1) to (x2, y2) over about `ms`. */
  async swipe(x1, y1, x2, y2, { steps = 12, ms = 240 } = {}) {
    const dt = ms / steps
    if (this.dev.mobile) {
      const pt = (x, y) => [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x1, y1) })
      for (let k = 1; k <= steps; k++) {
        await sleep(dt)
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps) })
      }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
      for (let k = 1; k <= steps; k++) {
        await sleep(dt)
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * k) / steps, y: y1 + ((y2 - y1) * k) / steps, button: 'left', buttons: 1 })
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
    }
    await sleep(120)
  }

  async type(text) {
    await this.send('Input.insertText', { text })
  }

  async key(key) {
    const codes = { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowRight: 39 }
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] ?? 0 }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  // ---------- helpers for assertions ----------

  /** Toasts seen since the page loaded (or since `since`), text only. */
  async toasts(since = 0) {
    const list = await this.eval(() => (window.__e2e ? window.__e2e.toasts : []))
    return (list ?? []).filter((t) => t.at >= since).map((t) => t.text)
  }

  async waitToast(re, { timeout = 6000, since = 0 } = {}) {
    const t0 = Date.now()
    let seen = []
    while (Date.now() - t0 < timeout) {
      seen = await this.toasts(since)
      const hit = seen.find((t) => re.test(t))
      if (hit) return hit
      await sleep(100)
    }
    throw new Error(`no toast matching ${re} (saw: ${seen.length ? seen.map((s) => JSON.stringify(s)).join(', ') : 'none'})`)
  }

  /** /api reads still waiting, slower than `ms`, or answered with an error: "path 12.3 s (502)". */
  slowApi(ms = 5000) {
    const now = Date.now()
    return [...this.net.values()]
      .filter((r) => (r.end ?? now) - r.start > ms || (r.end && (r.status === 0 || r.status >= 400)))
      .map((r) => `${r.path} ${(((r.end ?? now) - r.start) / 1000).toFixed(1)} s${r.end ? ` (${r.status || 'failed'})` : ' (still waiting)'}`)
  }

  async blockedNav() {
    return (await this.eval(() => (window.__e2e ? window.__e2e.blockedNav : []))) ?? []
  }

  async screenshot(file, clip) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  async close() {
    this.b.sessions.delete(this.sid)
    await this.b.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
    await this.b.send('Target.disposeBrowserContext', { browserContextId: this.ctxId }).catch(() => {})
  }
}

