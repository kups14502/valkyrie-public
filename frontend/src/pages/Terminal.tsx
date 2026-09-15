import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronUp,
  CornerDownLeft, Keyboard, MoreHorizontal, Plus, RotateCw, Terminal as TerminalIcon, X,
} from 'lucide-react'
import {
  fetchLaunchTargets, fetchSessionList, fetchTermSessions, fetchTermStatus, killTermSession,
  openTermSession, type TermOpen, type TermSession,
} from '../lib/api'
import {
  TERM_FONT_FAMILY, errText, readTermTheme as readTheme, relIso, relative, termWsUrl as wsUrl, toCtrl,
} from '../lib/term'

// Claude Code on thor, from the phone. The session is Claude running on thor in
// one of Brendon's own directories (personal, work, work2), reached over
// SSH from a tmux session on odin, so this page is only a screen and a keyboard
// for it: closing the tab, locking the phone, or deploying the API all just
// detach, and coming back reattaches to the same running session. It lives
// under the Sessions tab at /sessions/terminal: the board is where a session is
// picked, this is where it is typed into.
//
// The whole layout exists to make one promise: the terminal DOES NOT MOVE.
// Nothing on this route scrolls, so a drag cannot shift it, and the software
// keyboard is handled by two separate channels that must not be confused:
//
//   SIZE  --vp-kb  how much of the visible bottom the keyboard is covering,
//                  paid as padding-bottom on the shell root. This is the only
//                  thing that can change the terminal's box, so it is written
//                  ONLY on a settled reading or a cached prediction: one write,
//                  one layout, one fit, one pty resize per transition.
//   PIN   --vp-pin  how far WebKit shifted the layout viewport to reveal the
//                  caret, undone with a compositor-only transform. The size
//                  formula has no offsetTop term, so writing this can never
//                  change a box, fire the ResizeObserver, or refit. That is
//                  what makes it safe to run at event rate.
//
// The first version of this page sized the terminal from
// getBoundingClientRect().top inside a scrolling <main> and re-measured on
// visualViewport scroll. Every drag and every keyboard frame therefore resized
// the grid, which resized the pty, which made the remote TUI repaint. Position
// must never feed size. It does not here: no width is ever written by JS, so
// cols is structurally immune to focus and keyboard events, and only rotation,
// a zoom change or a font change can reflow tmux history.

const FONT_KEY = 'valkyrie-term-font'
const FONT_MIN = 9
const FONT_MAX = 20

// Stable identity, so the auto-select effect stops re-running on every render
// while the query is still undefined.
const EMPTY: TermSession[] = []

// The observed software-keyboard inset, remembered per viewport geometry. Its
// presence IS the evidence that this device has a software keyboard at this
// size, which is why a hardware-keyboard-only device never pre-shrinks.
const KB_KEY = 'valkyrie-term-kb'
// A keyboard, not a URL bar or an accessory strip.
const KB_OPEN = 120
// No keyboard at all.
const KB_NONE = 40
// Below this the grid is unreadable and safeFit refuses to resize into it, so
// say so instead of leaving a stale clipped screen.
const CRAMPED_H = 72
const CRAMPED_W = 120

// wsUrl, readTheme, toCtrl, relative, relIso and errText live in lib/term.ts,
// shared with the VR workspace (pages/Vr.tsx).

function isEditableFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

const KEY = 'inline-flex min-h-10 items-center justify-center gap-1 border border-[var(--color-border)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.12)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

const BTN = 'inline-flex min-h-9 items-center justify-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

export default function TerminalPage() {
  const qc = useQueryClient()

  const hostRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const ctrlRef = useRef(false)
  const fontRef = useRef(12)

  // Geometry lives in refs, never state: a viewport event must not re-render
  // the chip list, the resume list, or the fourteen buttons.
  const kbRef = useRef(0)
  const topRef = useRef(0)
  const rafRef = useRef(0)
  const roRafRef = useRef(0)
  const settleRef = useRef(0)
  const sampleRef = useRef(0)
  const growRef = useRef(0)

  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // ?s= is how the board hands a session over, and it is kept current so a
  // reload (or a home-screen relaunch) lands back on the same one.
  const [active, setActive] = useState<string | null>(() => {
    const s = params.get('s')
    return s && /^vk-[0-9a-f]{10}$/.test(s) ? s : null
  })
  const [gen, setGen] = useState(0)
  const [conn, setConn] = useState<'idle' | 'connecting' | 'live' | 'closed'>('idle')
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [font, setFont] = useState(() => {
    const v = Number(localStorage.getItem(FONT_KEY))
    return v >= FONT_MIN && v <= FONT_MAX ? v : 12
  })
  const [picker, setPicker] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cramped, setCramped] = useState(false)

  const sessions = useQuery({
    queryKey: ['term', 'sessions'],
    queryFn: fetchTermSessions,
  })
  const status = useQuery({
    queryKey: ['term', 'status'],
    queryFn: fetchTermStatus,
    refetchInterval: 60_000,
  })
  // thor's own list, under the same query key as the board's dropdown so the
  // two can never disagree. Only the targets thor flagged for the phone show.
  const targets = useQuery({ queryKey: ['launchTargets', 'thor'], queryFn: () => fetchLaunchTargets('thor'), staleTime: 60_000 })
  const phoneTargets = (targets.data ?? []).filter((t) => t.phone && t.exists)
  // The resume list IS the session board: one row per real conversation on
  // thor, hook runs already filtered out there. Live ones are left out because
  // a conversation open on thor's desk has to be stopped before it can move
  // here, and done ones because Brendon said he was finished with them.
  const recent = useQuery({
    queryKey: ['sessionList'],
    queryFn: fetchSessionList,
    enabled: picker,
    staleTime: 10_000,
  })
  const resumable = recent.data?.installed
    ? recent.data.sessions.filter((s) => !s.live && !s.done).slice(0, 40)
    : []

  const list = sessions.data ?? EMPTY

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
  }, [])

  // A. Layout effects run before passive effects in the same commit, so the
  //    session effect always builds xterm at the current size. Also safe under
  //    StrictMode's double render, which a render-phase write is not.
  useLayoutEffect(() => { fontRef.current = font }, [font])

  // B. The geometry controller. Declared before the session effect so both
  //    properties are committed and laid out before xterm is ever constructed:
  //    returning to the route with the keyboard up paints once, already short.
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
    // disagree with the calc() in index.css that consumes it. Reading it is a
    // height read and never a position read, so it cannot recreate the
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
        // A soft-key tap blurs the textarea and send() refocuses it within
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

    // The only fit trigger. It cannot see the keyboard on its own; it observes
    // the box change the size channel produces.
    const host = hostRef.current
    const ro = new ResizeObserver(() => {
      if (roRafRef.current) return
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = 0
        const h = hostRef.current
        if (!h) return
        setCramped(h.clientHeight < CRAMPED_H || h.clientWidth < CRAMPED_W)
        safeFit()
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
  }, [safeFit])

  const send = useCallback((d: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
    // Load-bearing: tapping a button blurs xterm's textarea, which drops the
    // iOS keyboard unless focus comes straight back.
    termRef.current?.focus()
  }, [])

  // Ask tmux to move its own view. Nothing here writes a size or a position,
  // so scrolling cannot move the terminal box: it is not capable of
  // re-entering the position-feeds-size loop this page was rewritten to
  // delete. Positive is toward older output.
  const scrollBy = useCallback((lines: number) => {
    const ws = wsRef.current
    if (!lines || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 's', lines }))
  }, [])

  const halfScreen = useCallback(() => Math.max(1, Math.floor((termRef.current?.rows ?? 24) / 2)), [])

  const focusTerm = useCallback(() => { termRef.current?.focus() }, [])

  const hideKeyboard = useCallback(() => { termRef.current?.textarea?.blur() }, [])

  const toggleKeyboard = useCallback(() => {
    const term = termRef.current
    const ta = term?.textarea
    if (!term || !ta) return
    if (document.activeElement === ta) ta.blur()
    else term.focus()
  }, [])

  // B2. Swipe to scroll. xterm's own touch handling scrolls its local buffer,
  //     which under tmux holds about one screen, so a swipe appeared to do
  //     nothing whatsoever. This converts the drag into a line delta for tmux
  //     instead. Registered on the host rather than the xterm viewport so it
  //     survives xterm being rebuilt, and non-passive because a real drag has
  //     to be swallowed rather than handed to the browser.
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

    const onEnd = () => { id = null; dragging = false; acc = 0 }

    host.addEventListener('touchstart', onStart, { passive: true })
    host.addEventListener('touchmove', onMove, { passive: false })
    host.addEventListener('touchend', onEnd, { passive: true })
    host.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
      host.removeEventListener('touchcancel', onEnd)
    }
  }, [scrollBy])

  // C. One terminal + one socket per selected session. `gen` is the reconnect
  //    handle: bumping it tears the pair down and builds them again.
  useEffect(() => {
    const host = hostRef.current
    if (!active || !host) return

    const term = new XTerm({
      fontSize: fontRef.current,
      fontFamily: TERM_FONT_FAMILY,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 2_000,
      theme: readTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

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
      ta.focus = (o?: FocusOptions) => orig({ preventScroll: true, ...o })
      ta.style.fontSize = '16px'
    }

    safeFit()

    setConn('connecting')
    const ws = new WebSocket(wsUrl(active, term.cols, term.rows))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const resize = (cols: number, rows: number) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols, rows }))
    }

    ws.onopen = () => {
      setConn('live')
      // Resizing straight after attach makes tmux repaint the pane in full.
      // Without it a reattach shows whatever the last client's geometry left
      // behind, which after a rotation is a half-drawn screen.
      resize(term.cols, term.rows)
      term.focus()
    }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data) as { t?: string; d?: string }
          if (m.t === 'detached') term.write('\r\n\x1b[2m-- session ended --\x1b[0m\r\n')
          else if (m.t === 'err') term.write(`\r\n\x1b[31m${m.d ?? 'error'}\x1b[0m\r\n`)
        } catch { /* not a control frame we know */ }
        return
      }
      term.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => setConn('closed')
    ws.onerror = () => setConn('closed')

    const onData = term.onData((d) => {
      let out = d
      if (ctrlRef.current) {
        out = toCtrl(d)
        ctrlRef.current = false
        setCtrlArmed(false)
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: out }))
    })
    const onResize = term.onResize(({ cols, rows }) => resize(cols, rows))

    // JetBrains Mono is a webfont, and cell metrics measured before it loads
    // are wrong by a fraction of a column.
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
      if (wsRef.current === ws) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
  }, [active, gen, safeFit])

  // D. A font change alters cell metrics without changing the host's box, so
  //    the ResizeObserver does not fire and this must fit for itself.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = font
    try { localStorage.setItem(FONT_KEY, String(font)) } catch { /* private mode */ }
    const id = requestAnimationFrame(() => safeFit())
    return () => cancelAnimationFrame(id)
  }, [font, safeFit])

  // E. iOS suspends a backgrounded socket. Coming back to a dead one should
  //    reattach rather than show a frozen screen. Debounced, because an iOS
  //    focus burst would otherwise double-bump gen and rebuild twice.
  useEffect(() => {
    let timer = 0
    const revive = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible') return
        const ws = wsRef.current
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          setGen((g) => g + 1)
        }
      }, 300)
    }
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('focus', revive)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('focus', revive)
    }
  }, [])

  // F. Land on whatever ran most recently, and re-land if the active session
  //    is killed out from under us.
  //
  //    Never off a list that is still loading. The board hands a session over
  //    through ?s= and this cache is shared with the board's own strip, so a
  //    refetch in flight means the named session may not be in `list` yet, and
  //    stomping `active` here would silently attach to the wrong pane.
  useEffect(() => {
    if (!list.length || sessions.isFetching) return
    if (!active || !list.some((s) => s.name === active)) setActive(list[0].name)
  }, [list, active, sessions.isFetching])

  // G. Keep ?s= in step with the selection. Replace, never push, so the back
  //    gesture leaves the terminal instead of stepping through sessions.
  useEffect(() => {
    if ((params.get('s') ?? '') === (active ?? '')) return
    setParams(active ? { s: active } : {}, { replace: true })
  }, [active, params, setParams])

  const guessGrid = () => {
    const host = hostRef.current
    const w = host?.clientWidth ?? 360
    const h = host?.clientHeight ?? 320
    return {
      cols: Math.max(24, Math.floor(w / (font * 0.6))),
      rows: Math.max(10, Math.floor(h / (font * 1.32))),
    }
  }

  const openSession = async (body: TermOpen) => {
    setBusy(true)
    setError(null)
    try {
      const term = termRef.current
      const grid = guessGrid()
      const data = await openTermSession({
        ...body,
        cols: term?.cols ?? grid.cols,
        rows: term?.rows ?? grid.rows,
      })
      await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
      setPicker(false)
      setActive(data.name)
      setGen((g) => g + 1)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const closeSession = async (name: string) => {
    setError(null)
    try {
      await killTermSession(name)
    } catch (e) {
      setError(errText(e))
    }
    if (active === name) setActive(null)
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    // Closing a Claude session here ends it on thor too, so the board's live
    // set just changed.
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  const dot = conn === 'live'
    ? 'var(--color-accent)'
    : conn === 'connecting'
      ? 'var(--color-accent-2)'
      : 'var(--color-text-faint)'

  const showBanners = Boolean(error) || Boolean(status.data && !status.data.ok)

  return (
    // absolute inset-0, not h-full: it resolves against main's padding box and
    // therefore skips whatever Suspense or ErrorBoundary renders in between.
    // z-0 makes this a stacking context, so the overlay z-indexes below stay
    // inside the page and under the header instead of competing with it.
    // touch-manipulation kills double-tap zoom and keeps the pan that xterm
    // scrollback needs; never touch-action:none.
    <div
      data-term-root
      className="absolute inset-0 z-0 flex touch-manipulation flex-col gap-2 p-2 sm:p-3"
    >
      {/* Open sessions. Horizontally scrollable so twelve of them still fit one
          row, and never hidden: 36px is worth less than a switcher that
          disappears when the keyboard opens. */}
      <div data-term-scroll className="flex shrink-0 items-center gap-2 overflow-x-auto pb-0.5">
        <button
          type="button"
          onClick={() => navigate('/sessions')}
          aria-label="Back to the session board"
          title="Back to the session board"
          className={`${BTN} shrink-0 px-2`}
        >
          <ChevronLeft size={13} />
        </button>
        {list.map((s) => {
          const on = s.name === active
          return (
            <div
              key={s.name}
              className={`flex shrink-0 items-center border ${
                on
                  ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.12)]'
                  : 'border-[var(--color-border)]'
              }`}
            >
              <button
                type="button"
                onClick={() => { setActive(s.name); setPicker(false) }}
                className="flex min-h-9 items-center gap-2 px-2.5 text-left"
              >
                <span
                  className={`text-[11px] uppercase tracking-[0.12em] ${
                    on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'
                  }`}
                >
                  {s.label}
                </span>
                <span className={`text-[9px] uppercase tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
                  {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                  {s.activityAt ? ` · ${relative(s.activityAt)}` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void closeSession(s.name)}
                aria-label={`Close ${s.label}`}
                className="min-h-9 px-1.5 text-[var(--color-text-faint)] active:text-[var(--color-danger)]"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}

        <button type="button" onClick={() => setPicker((v) => !v)} className={`${BTN} shrink-0`}>
          <Plus size={12} /> new
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">{conn}</span>
        </div>
      </div>

      {/* The stage is the only box on the page whose height varies, and
          everything inside it is absolutely positioned. So no page state can
          change the host's size: opening the launcher or showing a banner
          costs zero refits and zero tmux repaints. */}
      <div data-term-stage className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          data-term-host
          onClick={focusTerm}
          className="absolute inset-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-1"
        />

        {/* The height reference the geometry rule measures. Fixed, so it adds
            no scrollable overflow to an overflow:hidden ancestor (which is
            exactly the hazard WebKit's reveal-focus pass exploits), and
            invisible rather than display:none so offsetHeight still reports a
            used height. */}
        <div
          ref={probeRef}
          aria-hidden
          className="pointer-events-none invisible fixed left-0 top-0 w-0"
          style={{ height: '100dvh' }}
        />

        {!active && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center">
            <TerminalIcon size={20} className="text-[var(--color-text-faint)]" />
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
              {sessions.isLoading ? 'loading' : 'no session open'}
            </div>
            {!sessions.isLoading && (
              <div className="text-[10px] text-[var(--color-text-faint)]">tap NEW, or pick one on the board</div>
            )}
          </div>
        )}

        {showBanners && (
          <div className="absolute inset-x-0 top-0 z-20 space-y-1 p-1">
            {error && (
              <div
                onClick={() => setError(null)}
                title="dismiss"
                className="border border-[var(--color-danger)]/60 bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-danger)]"
              >
                {error}
              </div>
            )}
            {status.data && !status.data.ok && (
              <div className="border border-[var(--color-accent-2)]/60 bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-accent-2)]">
                {!status.data.tmux ? 'tmux is not installed on odin.' : 'ssh is not installed on odin.'}
              </div>
            )}
          </div>
        )}

        {picker && (
          <div data-term-scroll className="absolute inset-0 z-30 overflow-y-auto bg-black/90 p-1">
            <div className="panel space-y-4 p-3">
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; new claude session on thor in
                </div>
                <div className="flex flex-wrap gap-2">
                  {phoneTargets.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      disabled={busy}
                      onClick={() => void openSession({ mode: 'new', target: t.key, label: t.label })}
                      className={`${BTN} disabled:opacity-40`}
                    >
                      <Plus size={11} /> {t.label}
                    </button>
                  ))}
                  {targets.isSuccess && phoneTargets.length === 0 && (
                    <div className="text-[11px] text-[var(--color-text-faint)]">
                      thor offers no phone targets. Flag some with &quot;phone&quot;: true in launch-targets.json.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; plain powershell on thor in
                </div>
                <div className="flex flex-wrap gap-2">
                  {phoneTargets.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      disabled={busy}
                      onClick={() => void openSession({ mode: 'shell', target: t.key, label: `${t.label} sh` })}
                      className={`${BTN} disabled:opacity-40`}
                    >
                      <TerminalIcon size={11} /> {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; resume a conversation from thor
                </div>
                {recent.isLoading && (
                  <div className="text-[11px] text-[var(--color-text-faint)]">reading the board…</div>
                )}
                {recent.data && !recent.data.installed && (
                  <div className="text-[11px] text-[var(--color-accent-2)]">
                    the session board answered {recent.data.status}; thor may be asleep
                  </div>
                )}
                {/* No nested scroller: the overlay is already a bounded one,
                    and a scroller inside a scroller is the iOS chaining trap
                    this route exists to remove. */}
                <div className="space-y-1">
                  {resumable.map((r) => (
                    <button
                      key={r.sessionId}
                      type="button"
                      disabled={busy}
                      onClick={() => void openSession({ mode: 'resume', sessionId: r.sessionId, label: r.title })}
                      className="flex w-full items-start gap-2 border border-[var(--color-border)] px-2.5 py-2 text-left transition-colors active:border-[var(--color-accent)] hover:border-[var(--color-accent)]/50 disabled:opacity-40"
                    >
                      <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-accent)]">
                        {r.project}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]">
                        {r.title}
                      </span>
                      <span className="shrink-0 text-[9px] text-[var(--color-text-faint)]">
                        {relIso(r.lastActivityUtc)}
                      </span>
                    </button>
                  ))}
                  {recent.data?.installed && resumable.length === 0 && (
                    <div className="text-[11px] text-[var(--color-text-faint)]">
                      nothing on the board to resume. A session that is open on thor has to be stopped there first.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {cramped && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-black/85 p-3 text-center">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent-2)]">
              not enough room
            </div>
            <div className="text-[10px] text-[var(--color-text-faint)]">
              hide the keyboard, close the menu, or rotate
            </div>
            <button type="button" onClick={hideKeyboard} className={BTN}>
              <Keyboard size={12} /> hide keyboard
            </button>
          </div>
        )}
      </div>

      {/* Keys a software keyboard does not have.
          A keypad, not a strip. Fourteen equal buttons in a wrapping flex row
          reflowed differently at every width, ran the four arrows out
          horizontally where a thumb cannot aim at them, and left Enter buried
          in the middle of the sequence. The groups are fixed now and the
          arrows form the usual inverted T, so aiming is muscle memory and
          nothing moves when the keyboard opens. Everything that is not a key
          (paste, font size, reconnect) hides behind the last button, because
          it was competing for the same thumb as Enter.
          Still flexbox, so the row is reserved and there is no height to
          measure and no magic gap allowance. */}
      <div className="flex shrink-0 flex-col gap-1.5">
        {more && (
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] pb-1.5">
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.readText().then((t) => t && send(t)).catch(() => setError('clipboard blocked')) }}
              className={BTN}
            >
              paste
            </button>
            <button type="button" onClick={toggleKeyboard} className={BTN}>
              <Keyboard size={12} /> kbd
            </button>
            {/* Half a screen at a time, for reading back without a swipe. */}
            <button type="button" onClick={() => scrollBy(halfScreen())} className={BTN} aria-label="Page up">
              <ChevronUp size={14} />
            </button>
            <button type="button" onClick={() => scrollBy(-halfScreen())} className={BTN} aria-label="Page down">
              <ChevronDown size={14} />
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              <button type="button" onClick={() => setFont((f) => Math.max(FONT_MIN, f - 1))} className={BTN}>a-</button>
              <span className="min-w-6 text-center text-[10px] text-[var(--color-text-faint)]">{font}</span>
              <button type="button" onClick={() => setFont((f) => Math.min(FONT_MAX, f + 1))} className={BTN}>a+</button>
              <button type="button" onClick={() => setGen((g) => g + 1)} className={BTN} aria-label="Reconnect">
                <RotateCw size={12} />
              </button>
            </div>
          </div>
        )}

        <div className="flex items-stretch gap-1.5">
          {/* Modifiers, the two-by-two block under the left thumb. */}
          <div className="grid flex-1 grid-cols-2 gap-1.5">
            <button type="button" onClick={() => send('\x1b')} className={KEY}>esc</button>
            <button type="button" onClick={() => send('\t')} className={KEY}>tab</button>
            <button
              type="button"
              onClick={() => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); focusTerm() }}
              className={`${KEY} ${ctrlArmed ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''}`}
            >
              ctrl
            </button>
            {/* Shift+Tab cycles Claude Code's permission modes and a phone
                keyboard cannot produce it at all. */}
            <button type="button" onClick={() => send('\x1b[Z')} className={KEY} aria-label="Shift Tab">
              &#8679;tab
            </button>
          </div>

          {/* Arrows, the inverted T. The blanks are deliberate: they are what
              makes the shape readable without looking at it. */}
          <div className="grid flex-[1.4] grid-cols-3 gap-1.5">
            <span aria-hidden />
            <button type="button" onClick={() => send('\x1b[A')} className={KEY} aria-label="Up"><ArrowUp size={15} /></button>
            <span aria-hidden />
            <button type="button" onClick={() => send('\x1b[D')} className={KEY} aria-label="Left"><ArrowLeft size={15} /></button>
            <button type="button" onClick={() => send('\x1b[B')} className={KEY} aria-label="Down"><ArrowDown size={15} /></button>
            <button type="button" onClick={() => send('\x1b[C')} className={KEY} aria-label="Right"><ArrowRight size={15} /></button>
          </div>

          {/* Send. Enter is the most-pressed key on the page, so it is the
              biggest target and it sits at the right edge where the thumb
              already rests. Backslash-Enter is the newline Claude Code always
              accepts; Option and Shift+Enter are not reachable from a phone. */}
          <div className="grid flex-1 grid-cols-2 gap-1.5">
            <button type="button" onClick={() => send('\\\r')} className={KEY}>\&#9166;</button>
            <button
              type="button"
              onClick={() => send('\r')}
              aria-label="Enter"
              className={`${KEY} row-span-2 border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.10)] text-[var(--color-accent)]`}
            >
              <CornerDownLeft size={18} />
            </button>
            <button type="button" onClick={() => send('\x03')} className={KEY}>^c</button>
          </div>

          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-label="More keys"
            className={`${KEY} w-8 shrink-0 ${more ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''}`}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
