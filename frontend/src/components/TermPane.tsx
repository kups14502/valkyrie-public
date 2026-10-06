import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TERM_FONT_FAMILY, readTermTheme, readUiZoom, setTermZoom, termWsUrl } from '../lib/term'

// One tmux session as a pane inside another page: the project page puts it
// beside its tabs on a desktop. Built from the VR workspace's pane (Vr.tsx)
// plus what the phone terminal (Terminal.tsx) learned since, so it can sit
// next to the rest of the app without owning the viewport the way that route
// does. It never writes html[data-term-pin], --vp-kb or --vp-pin and never
// scrolls the page: those belong to /sessions/terminal alone, and a second
// writer would fight its geometry pin.
//
// Mount one per tmux name per page. tmux sizes a window to its latest client,
// so a second pane on the same session clips the first.

export type TermPaneApi = {
  send: (text: string) => void
  scroll: (lines: number) => void
  rows: () => number
  reconnect: () => void
  focus: () => void
}

export type TermConn = 'connecting' | 'live' | 'closed'

// Same liveness numbers as the phone terminal: the server heartbeats every
// 25s and answers a probe with one.
const SILENT_MS = 45_000
const PROBE_MS = 8_000

// One tmux line per this many pixels of wheel travel.
const WHEEL_LINE_PX = 40

export default function TermPane({ name, font = 13, focused = true, onConn, register, className }: {
  name: string
  font?: number
  focused?: boolean
  onConn?: (c: TermConn) => void
  register?: (api: TermPaneApi | null) => void
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fontRef = useRef(font)
  const focusedRef = useRef(focused)
  const nameRef = useRef(name)
  const onConnRef = useRef(onConn)
  // The UI zoom this pane has to cancel for itself, see readUiZoom in lib/term.ts.
  const zoomRef = useRef(1)
  // When the socket last delivered anything, when an unanswered probe went
  // out, and whether this server heartbeats at all.
  const rxRef = useRef(0)
  const probeSentRef = useRef(0)
  const beatsRef = useRef(false)
  // Text sent while the socket was down, for the session it was meant for.
  // A switch drops it: typed into the wrong conversation is worse than lost.
  const pendingRef = useRef<{ name: string; text: string } | null>(null)
  const [uiZoom, setUiZoom] = useState(readUiZoom)
  const [gen, setGen] = useState(0)
  const [conn, setConn] = useState<TermConn>('connecting')

  useLayoutEffect(() => { fontRef.current = font }, [font])
  useLayoutEffect(() => { focusedRef.current = focused }, [focused])
  useLayoutEffect(() => { nameRef.current = name }, [name])
  useLayoutEffect(() => { onConnRef.current = onConn }, [onConn])

  // A ref, so a parent passing a fresh callback each render is told about a
  // change once rather than once per render.
  useEffect(() => { onConnRef.current?.(conn) }, [conn])

  // The phone terminal's fit (Terminal.tsx safeFit): never a hidden or
  // squeezed box, never a one-row grid for tmux, and a reader who scrolled
  // back is left where they were.
  const safeFit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host || !host.isConnected) return
    if (host.clientWidth < 40 || host.clientHeight < 40) return
    let d: { cols: number; rows: number } | undefined
    try { d = fit.proposeDimensions() } catch { return }
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return
    if (d.rows < 2 || d.cols < 20) return
    if (d.cols === term.cols && d.rows === term.rows) return
    const buf = term.buffer.active
    const atBottom = buf.viewportY >= buf.baseY
    try { fit.fit() } catch { return }
    if (atBottom) term.scrollToBottom()
  }, [])

  // The box changes with the page around it (a sidebar, a window resize), so
  // one fit per frame and the pty follows through term.onResize below.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; safeFit() })
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [safeFit])

  // One terminal + one socket per session. gen is the reconnect handle.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    zoomRef.current = readUiZoom()
    setTermZoom(host, zoomRef.current)

    const term = new XTerm({
      fontSize: fontRef.current * zoomRef.current,
      fontFamily: TERM_FONT_FAMILY,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 2_000,
      theme: readTermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const ta = term.textarea
    if (ta) {
      // The phone terminal's two iOS fixes: a focus must not scroll anything
      // into view, and a focused control under 16px makes iOS zoom the page.
      // Cell metrics come from options.fontSize, so the 16px is invisible.
      const orig = ta.focus.bind(ta)
      ta.focus = (o?: FocusOptions) => orig({ preventScroll: true, ...o })
      ta.style.fontSize = '16px'
    }

    safeFit()

    setConn('connecting')
    const ws = new WebSocket(termWsUrl(name, term.cols, term.rows))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const resize = (cols: number, rows: number) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols, rows }))
    }

    ws.onopen = () => {
      setConn('live')
      rxRef.current = Date.now()
      // Proves the socket end to end and finds out whether this API
      // heartbeats; one that never answers leaves the watchdog's probe off.
      probeSentRef.current = Date.now()
      try { ws.send(JSON.stringify({ t: 'p' })) } catch { /* the watchdog has it */ }
      // Makes tmux repaint the pane in full at this pane's geometry.
      resize(term.cols, term.rows)
      const held = pendingRef.current
      pendingRef.current = null
      if (held && held.name === name) ws.send(JSON.stringify({ t: 'i', d: held.text }))
      // Only the pane the page says is focused, and never out of a field
      // elsewhere on the page: a reconnect lands at any moment, and the rest of
      // a note typed into the terminal is a prompt, Enter included. The old
      // xterm's textarea went with term.dispose(), so a pane that had the caret
      // leaves body focused and takes it back here. A background window gets
      // nothing staged in it; a click on the pane focuses it.
      const ae = document.activeElement as HTMLElement | null
      const typingElsewhere = !!ae && !hostRef.current?.contains(ae)
        && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))
      if (focusedRef.current && !typingElsewhere && document.hasFocus()) term.focus()
    }
    ws.onmessage = (e) => {
      // Any traffic answers an outstanding probe.
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
      term.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => setConn('closed')
    ws.onerror = () => setConn('closed')

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
    })
    const onResize = term.onResize(({ cols, rows }) => resize(cols, rows))

    // Cell metrics measured before the webfont lands are a fraction off.
    void document.fonts?.ready.then(() => safeFit())

    return () => {
      onData.dispose()
      onResize.dispose()
      // Null these BEFORE close() so a dying generation cannot stamp
      // conn:'closed' over the generation replacing it.
      ws.onclose = null
      ws.onerror = null
      ws.close()
      term.dispose()
      setTermZoom(host, 1)
      if (wsRef.current === ws) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
  }, [name, gen, safeFit])

  // A font or zoom change alters cell metrics without changing the box, so the
  // ResizeObserver does not fire and this fits for itself.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    zoomRef.current = uiZoom
    setTermZoom(hostRef.current, uiZoom)
    term.options.fontSize = font * uiZoom
    const raf = requestAnimationFrame(() => safeFit())
    return () => cancelAnimationFrame(raf)
  }, [font, uiZoom, safeFit])

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

  // The phone terminal's watchdog (Terminal.tsx effect E). A backgrounded or
  // sleeping socket can come back half-open: OPEN, no close event, and no
  // data, which on screen is a session that stopped. A closed socket
  // reconnects; an open one is probed, and the probe is trusted only once
  // this server has been seen to heartbeat.
  useEffect(() => {
    let timer = 0

    const reconnect = () => {
      probeSentRef.current = 0
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
        if (beatsRef.current && now - sent > PROBE_MS) reconnect()
        return
      }
      if (now - rxRef.current < SILENT_MS) return
      probeSentRef.current = now
      try { ws.send(JSON.stringify({ t: 'p' })) } catch { reconnect() }
    }

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

  // The wheel scrolls tmux's history through the socket, not xterm's buffer
  // (about one screen under tmux) and not tmux's own mouse handling, which
  // leaves the pane in a copy-mode the backend does not know about, so the next
  // keys read as copy-mode commands. The backend tracks the socket's scroll
  // message and leaves copy-mode before the next keystroke. Captured on the
  // host so xterm never sees the event.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      e.stopPropagation()
      // A trackpad pinch arrives as a ctrl+wheel. It is a zoom, not a scroll,
      // so the browser keeps it.
      if (e.ctrlKey || e.metaKey) return
      e.preventDefault()
      // Firefox can report a notch in lines (deltaMode 1) rather than pixels.
      const px = e.deltaMode === 1
        ? e.deltaY * WHEEL_LINE_PX
        : e.deltaMode === 2 ? e.deltaY * host.clientHeight : e.deltaY
      acc += px
      const steps = Math.trunc(acc / WHEEL_LINE_PX)
      if (!steps) return
      acc -= steps * WHEEL_LINE_PX
      const ws = wsRef.current
      // Wheel up is a negative deltaY and positive lines are older output.
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 's', lines: -steps }))
    }
    host.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => host.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  useEffect(() => { if (focused) termRef.current?.focus() }, [focused])

  // Built once from refs, so a parent that stores it never sees a new
  // identity and re-renders for nothing.
  const api = useMemo<TermPaneApi>(() => ({
    send: (text) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: text }))
      else {
        const held = pendingRef.current
        pendingRef.current = held && held.name === nameRef.current
          ? { name: held.name, text: held.text + text }
          : { name: nameRef.current, text }
      }
      termRef.current?.focus()
    },
    scroll: (lines) => {
      const ws = wsRef.current
      if (lines && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 's', lines }))
    },
    rows: () => termRef.current?.rows ?? 24,
    reconnect: () => {
      probeSentRef.current = 0
      setGen((g) => g + 1)
    },
    focus: () => termRef.current?.focus(),
  }), [])

  useEffect(() => {
    if (!register) return
    register(api)
    return () => register(null)
  }, [register, api])

  return (
    <div className={className} style={{ position: 'relative' }}>
      <div ref={hostRef} onClick={() => termRef.current?.focus()} className="absolute inset-0 overflow-hidden px-1 py-1" />
    </div>
  )
}
