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
//
// The one exception is a page opened with `term: <name>`, for the terminal
// tests: <name> is a throwaway odin shell pane the test created itself
// (lib/odin.mjs). That page may load /sessions/terminal?s=<name> and open
// /ws/terminal?s=<name>, and nothing else: any other terminal name is still
// refused, so even a page that picked a session on its own could never attach
// to one of Brendon's. Its socket's traffic is recorded in window.__e2e
// (wsOpened, wsSent, wsOut) for the test to read.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CDP = 'http://127.0.0.1:9333'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
// iPadOS Safari asks for desktop pages: it says Macintosh, and only touch tells it apart
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'

/**
 * The screens a test runs on. `zoom` is the app's own UI zoom (lib/zoom, stored
 * as valkyrie-zoom): Brendon runs the desktop at 1.2, so the two monitor sizes
 * carry it, and 1600x900 stays at 1.0.
 */
export const DEVICES = {
  phone: { w: 390, h: 844, dpr: 3, mobile: true, ua: IPHONE_UA, platform: 'iPhone' },
  landscape: { w: 844, h: 390, dpr: 3, mobile: true, ua: IPHONE_UA, platform: 'iPhone' },
  desktop: { w: 1600, h: 900, dpr: 1, mobile: false },
  desk1080: { w: 1920, h: 1080, dpr: 1, mobile: false, zoom: 1.2 },
  desk1440: { w: 2560, h: 1440, dpr: 1, mobile: false, zoom: 1.2 },
  ipad: { w: 820, h: 1180, dpr: 2, mobile: true, ua: IPAD_UA, platform: 'MacIntel' },
  ipadland: { w: 1180, h: 820, dpr: 2, mobile: true, ua: IPAD_UA, platform: 'MacIntel' },
}

/** A device's own localStorage (its zoom), under whatever a test stores itself. */
function deviceStorage(d, storage) {
  return d.zoom && !('valkyrie-zoom' in storage) ? { 'valkyrie-zoom': String(d.zoom), ...storage } : storage
}

/** odin's API on its tailnet address: the desktop app probes it (lib/api resolveApiBase). Never reached from a test. */
const isOdinDirect = (url) => url.port === '8420' || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url.hostname) || url.hostname === 'odin'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** How long one CDP command may go unanswered (a page load or a long evaluate stays far below it). */
const CMD_MS = 45_000

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

  /**
   * One CDP command. A command the browser never answers (a hung or crashed
   * renderer, a closed socket, which drops sends silently) fails after
   * `CMD_MS`: otherwise every test waiting on it hangs, the timers run out, and
   * Node leaves with exit code 0 and no table.
   */
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      if (this.ws.readyState !== 1) {
        rej(new Error(`${method}: the CDP socket is closed`))
        return
      }
      const id = ++this.seq
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rej(new Error(`${method}: no answer from the browser in ${CMD_MS / 1000} s`))
      }, CMD_MS)
      this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v) }, rej: (e) => { clearTimeout(timer); rej(e) }, method })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

// ---------- the in-page fence (runs before any app script) ----------

/** The fence. `term` is the one throwaway pane name this page may attach to ('' for none). */
const guardScript = (term = '') => `(() => {
  if (window.__e2e) return
  const TERM = ${JSON.stringify(term)}
  const e2e = window.__e2e = { blockedNav: [], blockedWs: [], toasts: [], seen: new WeakSet(), wsOpened: [], wsSent: [], wsOut: '', wsRx: 0 }
  const termPath = (u) => {
    try {
      const p = new URL(String(u), location.href).pathname.replace(/\\/+$/, '')
      return p === '/sessions/terminal' || p.startsWith('/sessions/terminal/') || p === '/terminal'
    } catch { return false }
  }
  // only the throwaway pane, by its exact name
  const allowedTerm = (u) => {
    if (!TERM) return false
    try { return new URL(String(u), location.href).searchParams.get('s') === TERM } catch { return false }
  }
  for (const k of ['pushState', 'replaceState']) {
    const orig = History.prototype[k]
    History.prototype[k] = function (state, title, url) {
      if (url != null && termPath(url) && !allowedTerm(url)) { e2e.blockedNav.push({ how: k, url: String(url), at: Date.now() }); return }
      return orig.call(this, state, title, url)
    }
  }
  const WS = window.WebSocket
  window.WebSocket = new Proxy(WS, {
    construct(target, args) {
      let p = ''
      try { p = new URL(String(args[0]), location.href).pathname } catch { /* keep '' */ }
      if (TERM && p === '/ws/terminal' && allowedTerm(args[0])) {
        const ws = Reflect.construct(target, args)
        e2e.wsOpened.push({ url: String(args[0]), at: Date.now() })
        const send = ws.send.bind(ws)
        ws.send = (d) => {
          e2e.wsSent.push({ d: typeof d === 'string' ? d : '[binary]', at: Date.now() })
          return send(d)
        }
        const dec = new TextDecoder()
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string') return
          e2e.wsRx += 1
          e2e.wsOut += dec.decode(new Uint8Array(ev.data), { stream: true })
          if (e2e.wsOut.length > 600000) e2e.wsOut = e2e.wsOut.slice(-300000)
        })
        return ws
      }
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

  constructor(browser, { base, device = 'phone', storage = {}, name = '', term = '', scripts = [] }) {
    this.b = browser
    /** the throwaway pane this page may attach to ('' = none: every terminal is refused) */
    this.term = term
    this.base = base.replace(/\/+$/, '')
    this.device = device
    this.dev = DEVICES[device]
    if (!this.dev) throw new Error(`no device ${device}`)
    this.storage = deviceStorage(this.dev, storage)
    /** more scripts to run before any app script, after the fence (a Tauri stub) */
    this.scripts = scripts
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
    await s('Inspector.enable').catch(() => {})
    await s('Runtime.enable')
    await s('Log.enable')
    await s('Network.enable').catch(() => {})
    await s('Page.bringToFront').catch(() => {})
    await s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    const d = this.dev
    await s('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile })
    if (d.mobile) {
      await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await s('Emulation.setUserAgentOverride', { userAgent: d.ua ?? IPHONE_UA, platform: d.platform ?? 'iPhone' })
    }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: guardScript(this.term) })
    const keys = Object.entries(this.storage)
    if (keys.length) {
      const sets = keys.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')
      await s('Page.addScriptToEvaluateOnNewDocument', { source: `try{${sets}}catch(e){}` })
    }
    for (const source of this.scripts) await s('Page.addScriptToEvaluateOnNewDocument', { source })
    await s('Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/*', requestStage: 'Request' },
        { urlPattern: '*/sessions/terminal*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*/terminal', resourceType: 'Document', requestStage: 'Request' },
        // odin's API straight over the tailnet (the desktop app's healthz probe): answered here, never sent
        { urlPattern: '*:8420/*', requestStage: 'Request' },
        { urlPattern: 'http://odin/*', requestStage: 'Request' },
        { urlPattern: 'http://100.*', requestStage: 'Request' },
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
      case 'Page.javascriptDialogOpening': {
        // an alert, confirm or "leave site?" left open blocks the renderer, and every page sharing it
        this.problems.push(`a ${p.type} dialog opened: ${String(p.message).slice(0, 200)}`)
        void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
        break
      }
      case 'Inspector.targetCrashed':
        this.problems.push('the page crashed (renderer gone)')
        break
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
      if (isOdinDirect(url) && url.origin !== new URL(this.base).origin) {
        // a read with no proxy and no read-only guard between it and odin: refused, so the app falls back to the probe
        this.notes.push(`refused a direct request to odin: ${request.method} ${url.origin}${path}`)
        this.direct = (this.direct ?? 0) + 1
        await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
        return
      }
      if (resourceType === 'Document' && !path.startsWith('/api/')) {
        // the throwaway pane's own address, by its exact name, is the one terminal page that loads
        if (this.term && url.searchParams.get('s') === this.term) {
          await this.send('Fetch.continueRequest', { requestId }).catch(() => {})
          return
        }
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
   * element still building in (hidden, covered, disabled, or still moving: v2's
   * build-in slides rows in, and Press drops a release that lands more than
   * 12 px from where the button now is) is waited for, up to `wait` ms, then
   * the tap fails with why.
   */
  async tap(target, { allowCovered = false, wait = 4000 } = {}) {
    let x, y
    if (typeof target === 'object' && 'x' in target && 'y' in target && !('sel' in target)) {
      ({ x, y } = target)
    } else {
      const t0 = Date.now()
      let why = ''
      let last = null
      for (;;) {
        await sleep(60)
        const at = await this.locate(target)
        why = at.error ?? (at.covered && !allowCovered ? `${JSON.stringify(target)} is covered by ${at.covered}` : at.disabled ? `${JSON.stringify(target)} is disabled` : '')
        // the same spot on two reads in a row: it has stopped moving
        const still = !why && last && Math.abs(last.x - at.x) < 1 && Math.abs(last.y - at.y) < 1
        if (!why && !still) why = `${JSON.stringify(target)} is still moving`
        last = at.error ? null : at
        if (still) {
          ;({ x, y } = at)
          why = ''
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

  /**
   * One key press. `mods`: { ctrl, shift, alt, meta } for a chord (Ctrl+K, Ctrl+=);
   * a chord never types its character.
   */
  async key(key, mods = {}) {
    const named = {
      Escape: ['Escape', 27], Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
      ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
      PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], '=': ['Equal', 187], '+': ['Equal', 187], '-': ['Minus', 189], '/': ['Slash', 191],
    }
    let code, vk
    if (named[key]) [code, vk] = named[key]
    else if (/^[a-z]$/i.test(key)) { code = `Key${key.toUpperCase()}`; vk = key.toUpperCase().charCodeAt(0) }
    else if (/^\d$/.test(key)) { code = `Digit${key}`; vk = key.charCodeAt(0) }
    else { code = key; vk = 0 }
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** A mouse press at a point: `count` 2 is the second press of a double-click (event.detail 2). */
  async mouse(x, y, { count = 1, button = 'left' } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let c = 1; c <= count; c++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: c })
      await sleep(20)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: c })
      await sleep(40)
    }
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

  /**
   * A screenshot: JPEG for a .jpg file, else PNG. Keep big screens on JPEG: a PNG
   * of a poster-heavy page at iPad size runs past 4 MB, and a CDP message that
   * large closes the socket (Node's WebSocket), taking every test after it down.
   */
  async screenshot(file, clip) {
    const jpeg = /\.jpe?g$/i.test(file)
    const shot = await this.send('Page.captureScreenshot', { format: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 85 } : {}), ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
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

