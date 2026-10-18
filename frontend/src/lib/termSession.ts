import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Terminal as XTerm, type ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  TERM_FONT_FAMILY, keepNativeSelection, readUiZoom, setTermZoom, termWsUrl, wheelScroll,
} from './term'

// What a full-screen terminal page needs to attach to one tmux session and
// keep it attached: the socket and its watchdog, the fit, the software-keyboard
// geometry, and swipe and wheel scrolling. Moved out of the classic phone
// terminal (pages/Terminal.tsx) so the v2 terminal (v2/screens/Term.tsx) runs
// the same code instead of a copy that drifts. Every comment that explains a
// fix came with it; the reasons have not changed.
//
// The whole layout exists to make one promise: the terminal DOES NOT MOVE.
// Nothing on a terminal route scrolls, so a drag cannot shift it, and the
// software keyboard is handled by two separate channels that must not be
// confused:
//
//   SIZE  --vp-kb  how much of the visible bottom the keyboard is covering,
//                  paid as padding-bottom on the page root. This is the only
//                  thing that can change the terminal's box, so it is written
//                  ONLY on a settled reading or a cached prediction: one write,
//                  one layout, one fit, one pty resize per transition.
//   PIN   --vp-pin  how far WebKit shifted the layout viewport to reveal the
//                  caret, undone with a compositor-only transform. The size
//                  formula has no offsetTop term, so writing this can never
//                  change a box, fire the ResizeObserver, or refit. That is
//                  what makes it safe to run at event rate.
//
// The first version of the phone terminal sized itself from
// getBoundingClientRect().top inside a scrolling <main> and re-measured on
// visualViewport scroll. Every drag and every keyboard frame therefore resized
// the grid, which resized the pty, which made the remote TUI repaint. Position
// must never feed size. It does not here: no width is ever written by JS, so
// cols is structurally immune to focus and keyboard events, and only rotation,
// a zoom change or a font change can reflow tmux history.

export const TERM_FONT_KEY = 'valkyrie-term-font'
export const TERM_FONT_MIN = 9
export const TERM_FONT_MAX = 20

export function readTermFont(dflt = 12): number {
  try {
    const v = Number(localStorage.getItem(TERM_FONT_KEY))
    return v >= TERM_FONT_MIN && v <= TERM_FONT_MAX ? v : dflt
  } catch {
    return dflt
  }
}

// The observed software-keyboard inset, remembered per viewport geometry. Its
// presence IS the evidence that this device has a software keyboard at this
// size, which is why a hardware-keyboard-only device never pre-shrinks.
const KB_KEY = 'valkyrie-term-kb'
// A keyboard, not a URL bar or an accessory strip.
const KB_OPEN = 120
// No keyboard at all.
const KB_NONE = 40
// Below this the grid is unreadable and safeFit refuses to resize into it, so
// a page says so instead of leaving a stale clipped screen.
const CRAMPED_H = 72
const CRAMPED_W = 120

export const isCramped = (host: HTMLElement): boolean => host.clientHeight < CRAMPED_H || host.clientWidth < CRAMPED_W

// Liveness. The server sends a readable heartbeat every 25s and answers a
// probe with one, so this much silence means the stream is broken however
// healthy readyState looks. A socket iOS suspended in the background comes back
// OPEN and delivers nothing at all: that is the frozen terminal that used to
// need a reload.
const SILENT_MS = 45_000
// How long a probe may go unanswered before the socket is treated as dead.
const PROBE_MS = 8_000

export function isEditableFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

// A mouse or trackpad drives the screen, not a finger.
export const hasMouse = (): boolean => window.matchMedia('(pointer: fine)').matches

/**
 * The geometry controller. A layout effect, so both properties are committed
 * and laid out before xterm is ever constructed (the socket hook builds it in a
 * passive effect, and every layout effect runs before every passive one):
 * returning to the route with the keyboard up paints once, already short.
 *
 * Owns html[data-term-pin], --vp-kb, --vp-pin and html[data-kb] for as long as
 * the page is mounted. Exactly one owner at a time: a terminal page, never a
 * pane inside another page (components/TermPane.tsx writes none of these).
 *
 * `onBox` runs once per frame in which the host's box changed. It is the only
 * fit trigger: it cannot see the keyboard on its own; it observes the box
 * change the size channel produces.
 */
export function useTermViewport(
  hostRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLElement | null>,
  onBox: (host: HTMLElement) => void,
): void {
  const onBoxRef = useRef(onBox)
  useLayoutEffect(() => { onBoxRef.current = onBox })

  // Geometry lives in refs, never state: a viewport event must not re-render
  // the page around the terminal.
  const kbRef = useRef(0)
  const topRef = useRef(0)
  const rafRef = useRef(0)
  const roRafRef = useRef(0)
  const settleRef = useRef(0)
  const sampleRef = useRef(0)
  const growRef = useRef(0)

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.termPin = ''

    const geoKey = () => {
      const vv = window.visualViewport
      const probe = probeRef.current
      if (!vv || !probe) return ''
      return `${Math.round(vv.width)}x${probe.offsetHeight}`
    }

    const cachedKb = (): number | null => {
      try {
        const m = JSON.parse(localStorage.getItem(KB_KEY) || '{}') as Record<string, number>
        const v = m[geoKey()]
        return typeof v === 'number' && v >= KB_OPEN ? v : null
      } catch { return null }
    }

    const rememberKb = (kb: number) => {
      try {
        const m = JSON.parse(localStorage.getItem(KB_KEY) || '{}') as Record<string, number>
        const k = geoKey()
        if (!k) return
        if (kb >= KB_OPEN) m[k] = kb
        // A device that used to have a software keyboard here and now reports
        // none while something is focused has grown a hardware one. Unlearn,
        // or every focus would pre-shrink for nothing.
        else if (kb < KB_NONE && isEditableFocused()) delete m[k]
        else return
        localStorage.setItem(KB_KEY, JSON.stringify(m))
      } catch { /* private mode */ }
    }

    // The height reference comes from CSS, not from window.*, so it cannot
    // disagree with the calc() that consumes it. Reading it is a height read
    // and never a position read, so it cannot recreate the
    // position-feeds-size loop this rewrite exists to delete.
    const readGeom = (): { kb: number; top: number } | null => {
      const vv = window.visualViewport
      const probe = probeRef.current
      if (!vv || !probe) return null
      // Pinch-zoomed in either direction: write nothing at all.
      if (Math.abs((vv.scale ?? 1) - 1) > 0.01) return null
      const dvh = probe.offsetHeight
      if (!dvh) return null
      const kb = Math.max(0, Math.ceil(dvh - vv.height))
      // Clamped to what the size channel has already removed, so the pin can
      // never push the key bar past the visible bottom, and a stale offset
      // with no keyboard clamps to zero.
      const top = Math.max(0, Math.min(vv.offsetTop, kbRef.current))
      return { kb, top }
    }

    const commitPin = (top: number) => {
      if (Math.abs(top - topRef.current) < 0.5) return
      topRef.current = top
      // Removing the property leaves transform:none, which means no containing
      // block for fixed descendants and behaviour identical to every other
      // route whenever there is nothing to correct.
      if (top <= 0) root.style.removeProperty('--vp-pin')
      else root.style.setProperty('--vp-pin', `translate3d(0, calc(${top}px / var(--ui-zoom)), 0)`)
    }

    const commitSize = (kb: number) => {
      if (kb === kbRef.current) return
      kbRef.current = kb
      if (kb <= 0) root.style.removeProperty('--vp-kb')
      else root.style.setProperty('--vp-kb', `${kb}px`)
      if (kb >= KB_OPEN) root.dataset.kb = '1'
      else delete root.dataset.kb
      // Hold the clamp invariant when the size shrinks under a live pin.
      if (topRef.current > kb) commitPin(kb)
    }

    // Channel A: every event, transform only, one rAF.
    const pump = () => {
      rafRef.current = 0
      const g = readGeom()
      if (!g) return
      commitPin(g.top)
      scheduleSettle()
    }
    const onGeom = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(pump)
    }

    // Channel B: size, and therefore exactly one fit, on a settled reading.
    // Two samples because Safari coalesces visualViewport events and the final
    // correct value can arrive after the animation ends, so "the last event
    // received" is not "the final geometry".
    const scheduleSettle = () => {
      clearTimeout(settleRef.current)
      clearTimeout(sampleRef.current)
      settleRef.current = window.setTimeout(() => {
        const a = readGeom()
        if (!a) return
        sampleRef.current = window.setTimeout(() => {
          const b = readGeom()
          if (!b) return
          if (Math.abs(a.kb - b.kb) > 1) { scheduleSettle(); return }
          commitSize(b.kb)
          commitPin(b.top)
          rememberKb(b.kb)
        }, 120)
      }, 150)
    }

    // Predicting the keyboard from the cached inset is what keeps offsetTop at
    // zero on the warm path: shrink before it animates in and the caret is
    // already above it, so WebKit's reveal-focus pass has nothing to do.
    const onFocusIn = () => {
      clearTimeout(growRef.current)
      const g = readGeom()
      if (g && g.kb < KB_NONE) {
        const c = cachedKb()
        if (c) commitSize(c)
      }
      onGeom()
    }
    const onFocusOut = () => {
      clearTimeout(growRef.current)
      growRef.current = window.setTimeout(() => {
        // A soft-key tap blurs the textarea and the page refocuses it within
        // ~100ms. Growing on that would flash a full-height screen per keypress.
        if (isEditableFocused()) return
        commitSize(0)
        onGeom()
      }, 150)
    }

    const onWindowResize = () => { onGeom(); scheduleSettle() }

    const onOrientation = () => {
      // Commit the best known size immediately, so a rotation with the
      // keyboard up is right within a frame instead of after the settle.
      commitSize(isEditableFocused() ? (cachedKb() ?? 0) : 0)
      onGeom()
      window.setTimeout(onGeom, 400)
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') window.setTimeout(onGeom, 100)
    }
    const onPageShow = () => { window.setTimeout(onGeom, 100) }

    // WebKit's reveal-focus pass really does programmatically scroll an
    // overflow:hidden ancestor. Reset only the document and ancestors of the
    // host, so a scrollable a later author adds still scrolls.
    const onStrayScroll = (e: Event) => {
      const t = e.target
      if (t === document || t === root || t === document.body) {
        root.scrollTop = 0
        root.scrollLeft = 0
        document.body.scrollTop = 0
        document.body.scrollLeft = 0
        return
      }
      const host = hostRef.current
      if (!(t instanceof HTMLElement) || !host || !t.contains(host)) return
      if (t.scrollTop) t.scrollTop = 0
      if (t.scrollLeft) t.scrollLeft = 0
    }
    const onWindowScroll = () => {
      window.scrollTo(0, 0)
      onGeom()
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', onGeom)
    vv?.addEventListener('scroll', onGeom)
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('orientationchange', onOrientation)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('scroll', onStrayScroll, { capture: true, passive: true })
    window.addEventListener('scroll', onWindowScroll, { passive: true })

    const host = hostRef.current
    const ro = new ResizeObserver(() => {
      if (roRafRef.current) return
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = 0
        const h = hostRef.current
        if (!h) return
        onBoxRef.current(h)
      })
    })
    if (host) ro.observe(host)

    // First pass, synchronous, before paint.
    const g0 = readGeom()
    if (g0) {
      commitSize(g0.kb)
      commitPin(g0.top)
    }

    return () => {
      vv?.removeEventListener('resize', onGeom)
      vv?.removeEventListener('scroll', onGeom)
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('orientationchange', onOrientation)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('scroll', onStrayScroll, { capture: true })
      window.removeEventListener('scroll', onWindowScroll)
      ro.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (roRafRef.current) cancelAnimationFrame(roRafRef.current)
      rafRef.current = 0
      roRafRef.current = 0
      clearTimeout(settleRef.current)
      clearTimeout(sampleRef.current)
      clearTimeout(growRef.current)
      kbRef.current = 0
      topRef.current = 0
      // Unconditional and idempotent, so StrictMode's double mount is safe.
      root.style.removeProperty('--vp-kb')
      root.style.removeProperty('--vp-pin')
      delete root.dataset.kb
      delete root.dataset.termPin
    }
  }, [hostRef, probeRef])
}

/**
 * Swipe and wheel scrolling, both turned into line deltas for tmux.
 *
 * Swipe: xterm's own touch handling scrolls its local buffer, which under tmux
 * holds about one screen, so a swipe appeared to do nothing whatsoever. This
 * converts the drag into a line delta for tmux instead. Registered on the host
 * rather than the xterm viewport so it survives xterm being rebuilt, and
 * non-passive because a real drag has to be swallowed rather than handed to the
 * browser.
 *
 * Wheel: only where a mouse drives the screen (the laptop, or a project's
 * session opened full screen); wheelScroll and keepNativeSelection in
 * lib/term.ts. A phone keeps its swipe.
 */
export function useTermScrollInput(
  hostRef: RefObject<HTMLElement | null>,
  termRef: RefObject<XTerm | null>,
  scrollBy: (lines: number) => void,
  leaveScroll: () => void,
): void {
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let id: number | null = null
    let startY = 0
    let lastY = 0
    let acc = 0
    let dragging = false

    // A row's height, taken from the box rather than xterm's private renderer
    // metrics, so a font change needs no invalidation.
    const rowPx = () => {
      const term = termRef.current
      const rows = term?.rows ?? 24
      return Math.max(6, host.clientHeight / rows)
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { id = null; return }
      const t = e.touches[0]
      id = t.identifier
      startY = lastY = t.clientY
      acc = 0
      dragging = false
    }

    const onMove = (e: TouchEvent) => {
      if (id === null) return
      // A second finger means a pinch, which belongs to the browser.
      if (e.touches.length !== 1) { id = null; return }
      const t = Array.from(e.touches).find((x) => x.identifier === id)
      if (!t) return
      // 10px of slop, so a tap that drifts still types instead of scrolling.
      if (!dragging && Math.abs(t.clientY - startY) < 10) return
      dragging = true
      e.preventDefault()
      acc += t.clientY - lastY
      lastY = t.clientY
      const h = rowPx()
      const lines = Math.trunc(acc / h)
      if (lines) {
        acc -= lines * h
        scrollBy(lines)
      }
    }

    // A tap, not a drag: the finger is asking to type, so the pane goes back to
    // following output. A real drag leaves copy-mode alone, because scrolling
    // back and being yanked to the bottom is worse than useless.
    const onEnd = () => {
      if (id !== null && !dragging) leaveScroll()
      id = null; dragging = false; acc = 0
    }

    host.addEventListener('touchstart', onStart, { passive: true })
    host.addEventListener('touchmove', onMove, { passive: false })
    host.addEventListener('touchend', onEnd, { passive: true })
    host.addEventListener('touchcancel', onEnd, { passive: true })
    const releaseWheel = hasMouse() ? wheelScroll(host, scrollBy) : null
    return () => {
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
      host.removeEventListener('touchcancel', onEnd)
      releaseWheel?.()
    }
  }, [hostRef, termRef, scrollBy, leaveScroll])
}

export type TermConnState = 'idle' | 'connecting' | 'live' | 'closed'

export type TermSocketOptions = {
  hostRef: RefObject<HTMLDivElement | null>
  /** The tmux session to attach, or null for none. Never guessed here. */
  name: string | null
  /** False keeps the terminal detached (a session known to be gone). Default true. */
  enabled?: boolean
  /** The font Brendon chose; xterm is told this times the UI zoom. */
  font: number
  /** Extra xterm options, read once per build (the theme, a cursor style). */
  options?: () => ITerminalOptions
  /** Every keystroke and paste from xterm passes through here (the ctrl key). */
  mapInput?: (d: string) => string
  /** Runs once xterm is open, before the socket; may return a cleanup. */
  setup?: (term: XTerm) => (() => void) | void
  /** Runs on attach, after the repaint resize (the classic page focuses here). */
  onOpened?: (term: XTerm) => void
  /** Runs after each chunk of output has landed in xterm's buffer. */
  onWrite?: () => void
}

export type TermSocket = {
  termRef: RefObject<XTerm | null>
  fitRef: RefObject<FitAddon | null>
  wsRef: RefObject<WebSocket | null>
  conn: TermConnState
  safeFit: () => void
  /** Input for the pane. Dropped while the socket is down: a key is only meant for now. */
  send: (d: string) => void
  /** Input that must land: sent now, or held for this session's next attach. True if sent now. */
  hold: (text: string) => boolean
  isOpen: () => boolean
  scrollBy: (lines: number) => void
  leaveScroll: () => void
  /** Tear the terminal and socket down and build them again. */
  rebuild: () => void
}

/**
 * One terminal + one socket per selected session, the fit, the font and zoom,
 * and the liveness watchdog.
 */
export function useTermSocket(o: TermSocketOptions): TermSocket {
  const { hostRef, name, enabled = true, font } = o
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fontRef = useRef(font)
  const nameRef = useRef(name)
  const enabledRef = useRef(enabled)
  const optsRef = useRef(o)
  // When the socket last delivered anything, when an unanswered probe went out,
  // and whether this server heartbeats at all (an older API does not, and a
  // watchdog that fires on its silence would reconnect on a loop).
  const rxRef = useRef(0)
  const probeSentRef = useRef(0)
  const beatsRef = useRef(false)
  // The UI zoom, which the terminal has to cancel for itself. See readUiZoom in
  // lib/term.ts for what it breaks. The ref is what the build-the-terminal
  // effect reads, so a zoom change cannot rebuild the terminal and drop the
  // socket; the state is what the font effect watches.
  const zoomRef = useRef(1)
  // Text that has to land in this session (an upload's path) and found the
  // socket down. A different session drops it: typed into the wrong
  // conversation is worse than lost.
  const pendingRef = useRef<{ name: string; text: string } | null>(null)
  const [uiZoom, setUiZoom] = useState(readUiZoom)
  const [gen, setGen] = useState(0)
  const [conn, setConn] = useState<TermConnState>('idle')

  // Layout effects run before passive effects in the same commit, so the
  // session effect always builds xterm at the current size. Also safe under
  // StrictMode's double render, which a render-phase write is not.
  useLayoutEffect(() => { fontRef.current = font }, [font])
  useLayoutEffect(() => { nameRef.current = name }, [name])
  useLayoutEffect(() => { enabledRef.current = enabled }, [enabled])
  useLayoutEffect(() => { optsRef.current = o })

  // The single fit entry point, and the only pty resize in the app. Every
  // guard here is a case where fitting would make things worse than not
  // fitting: a hidden route, a squeezed box, or a grid that has not changed.
  const safeFit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host || !host.isConnected) return
    if (host.clientWidth < 40 || host.clientHeight < 40) return
    let d: { cols: number; rows: number } | undefined
    try { d = fit.proposeDimensions() } catch { return }
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return
    // FitAddon clamps rows at 1, and handing rows=1 to tmux makes the TUI
    // redraw catastrophically.
    if (d.rows < 2 || d.cols < 20) return
    // The common case. Two forced layout reads saved, and no repaint asked of
    // the far side.
    if (d.cols === term.cols && d.rows === term.rows) return
    const buf = term.buffer.active
    const atBottom = buf.viewportY >= buf.baseY
    try { fit.fit() } catch { return }
    // Keep the prompt visible after a keyboard open without yanking a user who
    // deliberately scrolled back.
    if (atBottom) term.scrollToBottom()
  }, [hostRef])

  useEffect(() => {
    const host = hostRef.current
    if (!name || !enabled || !host) return

    // Before the first paint, so the terminal is never measured at a scale it
    // will not keep.
    zoomRef.current = readUiZoom()
    setTermZoom(host, zoomRef.current)

    const term = new XTerm({
      fontSize: fontRef.current * zoomRef.current,
      fontFamily: TERM_FONT_FAMILY,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 2_000,
      ...optsRef.current.options?.(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    const releaseMouse = hasMouse() ? keepNativeSelection(term) : null

    const ta = term.textarea
    if (ta) {
      // Two independent iOS problems. A focus that scrolls the caret into view
      // is how the layout viewport gets shifted in the first place, and one
      // legacy xterm path still calls bare focus(). And iOS pinch-zooms the
      // whole layout whenever a focused control is under 16px, which the
      // helper textarea is, because it inherits the terminal font size. Cell
      // metrics come from canvas measureText at options.fontSize, so pinning
      // this to 16px changes nothing visible.
      const orig = ta.focus.bind(ta)
      ta.focus = (f?: FocusOptions) => orig({ preventScroll: true, ...f })
      ta.style.fontSize = '16px'
    }
    const releaseSetup = optsRef.current.setup?.(term) ?? null

    safeFit()

    setConn('connecting')
    let alive = true
    let ws: WebSocket | null = null
    try {
      ws = new WebSocket(termWsUrl(name, term.cols, term.rows))
    } catch {
      // A refused construction (a sandboxed test page) is a closed socket, and
      // nothing reconnects it: the watchdog only acts on a socket it can see.
      queueMicrotask(() => { if (alive) setConn('closed') })
    }
    const sock = ws
    if (sock) {
      sock.binaryType = 'arraybuffer'
      wsRef.current = sock
    }

    const resize = (cols: number, rows: number) => {
      if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'r', cols, rows }))
    }

    if (sock) {
      sock.onopen = () => {
        setConn('live')
        rxRef.current = Date.now()
        // One probe up front, both to prove the socket end to end and to find out
        // whether this API heartbeats at all. A server that never answers simply
        // turns the watchdog off (see the effect below).
        probeSentRef.current = Date.now()
        try { sock.send(JSON.stringify({ t: 'p' })) } catch { /* the watchdog has it */ }
        // Resizing straight after attach makes tmux repaint the pane in full.
        // Without it a reattach shows whatever the last client's geometry left
        // behind, which after a rotation is a half-drawn screen.
        resize(term.cols, term.rows)
        optsRef.current.onOpened?.(term)
        // Text that had to land and found the socket down.
        const held = pendingRef.current
        if (held && held.name === name) {
          pendingRef.current = null
          sock.send(JSON.stringify({ t: 'i', d: held.text }))
        }
      }
      sock.onmessage = (e) => {
        // Anything at all answers an outstanding probe: the point is traffic, not
        // which frame it was.
        rxRef.current = Date.now()
        probeSentRef.current = 0
        if (typeof e.data === 'string') {
          try {
            const m = JSON.parse(e.data) as { t?: string; d?: string }
            if (m.t === 'hb') beatsRef.current = true
            else if (m.t === 'detached') term.write('\r\n\x1b[2m-- session ended --\x1b[0m\r\n')
            else if (m.t === 'err') term.write(`\r\n\x1b[31m${m.d ?? 'error'}\x1b[0m\r\n`)
          } catch { /* not a control frame we know */ }
          return
        }
        const after = optsRef.current.onWrite
        if (after) term.write(new Uint8Array(e.data as ArrayBuffer), after)
        else term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onclose = () => setConn('closed')
      sock.onerror = () => setConn('closed')
    }

    const onData = term.onData((d) => {
      const map = optsRef.current.mapInput
      const out = map ? map(d) : d
      if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'i', d: out }))
    })
    const onResize = term.onResize(({ cols, rows }) => resize(cols, rows))

    // JetBrains Mono is a webfont, and cell metrics measured before it loads
    // are wrong by a fraction of a column.
    void document.fonts?.ready.then(() => safeFit())

    return () => {
      alive = false
      onData.dispose()
      onResize.dispose()
      releaseMouse?.()
      releaseSetup?.()
      if (sock) {
        // Null these BEFORE close() so a dying generation cannot stamp
        // conn:'closed' over the generation replacing it.
        sock.onclose = null
        sock.onerror = null
        sock.close()
      }
      term.dispose()
      setTermZoom(host, 1)
      if (wsRef.current === sock) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
  }, [hostRef, name, enabled, gen, safeFit])

  // A font change alters cell metrics without changing the host's box, so the
  // ResizeObserver does not fire and this must fit for itself. A zoom change is
  // the same kind of event, and is handled here for the same reason: the stored
  // font is what Brendon chose, and what xterm is told is that times the zoom
  // it is no longer being painted at.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    zoomRef.current = uiZoom
    setTermZoom(hostRef.current, uiZoom)
    term.options.fontSize = font * uiZoom
    try { localStorage.setItem(TERM_FONT_KEY, String(font)) } catch { /* private mode */ }
    const id = requestAnimationFrame(() => safeFit())
    return () => cancelAnimationFrame(id)
  }, [hostRef, font, uiZoom, safeFit])

  // applyZoom dispatches a resize event precisely so measuring listeners can
  // catch it: `zoom` fires nothing of its own.
  useEffect(() => {
    const onZoom = () => setUiZoom((z) => {
      const next = readUiZoom()
      return next === z ? z : next
    })
    window.addEventListener('resize', onZoom)
    return () => window.removeEventListener('resize', onZoom)
  }, [])

  // iOS suspends a backgrounded socket, and what comes back is worse than a
  // closed one: a half-open socket reads OPEN, fires no close event, and
  // delivers nothing, which on screen is a session that simply stopped. A
  // closed socket was already handled here; silence was not, and that is the
  // freeze that used to need a reload.
  //
  // So: a closed socket reconnects, and an open one is asked to prove itself.
  // The probe is only trusted once this server has been seen to heartbeat, so
  // an older API is never reconnected on a loop for a frame it does not send.
  // A session the page knows is gone is never reconnected at all.
  useEffect(() => {
    let timer = 0

    const reconnect = () => {
      probeSentRef.current = 0
      if (!enabledRef.current) return
      setGen((g) => g + 1)
    }

    const check = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws) return
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return reconnect()
      if (ws.readyState !== WebSocket.OPEN) return

      const now = Date.now()
      const sent = probeSentRef.current
      if (sent) {
        // Unanswered long enough to count as gone, but only where a reply was
        // ever coming.
        if (beatsRef.current && now - sent > PROBE_MS) reconnect()
        return
      }
      if (now - rxRef.current < SILENT_MS) return
      probeSentRef.current = now
      try { ws.send(JSON.stringify({ t: 'p' })) } catch { reconnect() }
    }

    // Coming back from the background is the moment this matters, and it is
    // debounced because an iOS focus burst would otherwise probe several times.
    const wake = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible') return
        const ws = wsRef.current
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return reconnect()
        if (ws.readyState !== WebSocket.OPEN) return
        probeSentRef.current = probeSentRef.current || Date.now()
        try { ws.send(JSON.stringify({ t: 'p' })) } catch { reconnect() }
      }, 300)
    }

    const beat = window.setInterval(check, 5_000)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('pageshow', wake)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(beat)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('pageshow', wake)
    }
  }, [])

  const send = useCallback((d: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
  }, [])

  const hold = useCallback((text: string): boolean => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'i', d: text }))
      return true
    }
    const n = nameRef.current
    if (n) pendingRef.current = { name: n, text }
    return false
  }, [])

  const isOpen = useCallback(() => wsRef.current?.readyState === WebSocket.OPEN, [])

  // Ask tmux to move its own view. Nothing here writes a size or a position,
  // so scrolling cannot move the terminal box: it is not capable of
  // re-entering the position-feeds-size loop. Positive is toward older output.
  const scrollBy = useCallback((lines: number) => {
    const ws = wsRef.current
    if (!lines || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 's', lines }))
  }, [])

  // Back to the live bottom of the pane. A swipe puts tmux in copy-mode, where
  // the view stops following output: the session looks paused, and stays that
  // way until something makes it leave. Typing did that; tapping did not, which
  // is why it sometimes came back on a click and sometimes did not.
  const leaveScroll = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'se' }))
  }, [])

  const rebuild = useCallback(() => setGen((g) => g + 1), [])

  return { termRef, fitRef, wsRef, conn, safeFit, send, hold, isOpen, scrollBy, leaveScroll, rebuild }
}
