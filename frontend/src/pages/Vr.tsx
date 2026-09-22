import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronUp,
  Columns2, Columns3, CornerDownLeft, Eye, EyeOff, Glasses, LayoutGrid, Maximize, Minimize, Minus,
  Plus, Power, Replace, RotateCw, Square, Terminal as TerminalIcon, X,
} from 'lucide-react'
import {
  fetchLaunchTargets, fetchSessionList, fetchTermSessions, killTermSession, openTermSession,
  type TermOpen, type TermSession,
} from '../lib/api'
import {
  TERM_FONT_FAMILY, TERM_NAME_RE, errText, readTermTheme, readUiZoom, relIso, relative, setTermZoom,
  termWsUrl, toCtrl,
} from '../lib/term'
import { readText as readClipboard } from '../lib/clipboard'
import { PasteSheet } from '../components/PasteSheet'
import { isEmbedded } from '../lib/embed'

// The VR workspace, at /vr. Built for the Steam Frame, which runs SteamOS and
// shows a browser as a flat window floating in the headset, so this page IS
// the headset app: nothing is streamed from a PC and nothing is installed.
// The Frame draws one window; this page divides it into screens, each a Claude
// session on thor (the same tmux-over-SSH bridge the phone terminal uses, see
// Terminal.tsx and backend/src/terminal/tmux.ts) or a Valkyrie page in an
// iframe. So "two monitors" is two panes here, not two browser windows.
//
// What is different from the phone terminal, and why:
//   - Several terminals at once. One socket per pane, each its own xterm.
//   - A laser pointer, not a thumb. Hit targets are 40px+, nothing depends on
//     hover, and the text is a size up from the rest of the app because the
//     virtual screen sits a couple of meters away.
//   - No software-keyboard geometry. SteamOS's keyboard is a separate overlay
//     that does not resize the page, so none of Terminal.tsx's viewport
//     pinning is needed. A Bluetooth keyboard is the expected input; the key
//     strip at the bottom covers what the SteamOS keyboard lacks (Ctrl, Esc,
//     Tab, arrows) and sends to whichever pane was last touched.
//   - Wheel scrolling is left to xterm. tmux has `mouse on`, so the wheel
//     reaches tmux as mouse reports and it scrolls its own history; the page-up
//     and page-down keys use the socket's scroll message instead, which the
//     backend tracks so the next keystroke leaves copy mode.
//
// Layout is a CSS grid of equal cells: 1, 2, or 3 columns by choice, or auto
// (1, 2, 3, then 2x2, then 3 wide). The set of screens is kept in localStorage
// so the headset lands back on the same desk after a reload.

const PANES_KEY = 'valkyrie-vr-panes'
const COLS_KEY = 'valkyrie-vr-cols'
const FONT_KEY = 'valkyrie-vr-font'
const FONT_MIN = 12
const FONT_MAX = 32
const FONT_DEFAULT = 18
const MAX_PANES = 6

type TermPane = { id: string; kind: 'term'; name: string }
type PagePane = { id: string; kind: 'page'; path: string }
type Pane = TermPane | PagePane
// 0 is auto.
type Cols = 0 | 1 | 2 | 3

type PaneApi = {
  send: (d: string) => void
  scroll: (lines: number) => void
  rows: () => number
  reconnect: () => void
  focus: () => void
}

// Pages worth a screen of their own in the headset. The terminal and the
// workspace itself are left out: one is a pane already, the other would nest.
const PAGES: { path: string; label: string }[] = [
  { path: '/sessions', label: 'session board' },
  { path: '/dashboard', label: 'dashboard' },
  { path: '/calendar', label: 'calendar' },
  { path: '/meals', label: 'meals' },
  { path: '/lights', label: 'lights' },
  { path: '/plex', label: 'plex' },
  { path: '/trade', label: 'trades' },
  { path: '/slop', label: 'slop' },
  { path: '/activity', label: 'activity' },
  { path: '/services', label: 'services' },
]

const EMPTY: TermSession[] = []

const uid = () => Math.random().toString(36).slice(2, 10)

function loadPanes(): Pane[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    const out: Pane[] = []
    for (const r of raw) {
      const p = (r ?? {}) as Record<string, unknown>
      if (p.kind === 'term' && typeof p.name === 'string' && TERM_NAME_RE.test(p.name)) {
        out.push({ id: uid(), kind: 'term', name: p.name })
      } else if (p.kind === 'page' && typeof p.path === 'string' && PAGES.some((x) => x.path === p.path)) {
        out.push({ id: uid(), kind: 'page', path: p.path })
      }
      if (out.length >= MAX_PANES) break
    }
    return out
  } catch {
    return []
  }
}

function loadCols(): Cols {
  const v = Number(localStorage.getItem(COLS_KEY))
  return v === 1 || v === 2 || v === 3 ? v : 0
}

function loadFont(): number {
  const v = Number(localStorage.getItem(FONT_KEY))
  return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT
}

const autoCols = (n: number) => (n <= 1 ? 1 : n <= 3 ? n : n === 4 ? 2 : 3)

const BTN = 'inline-flex min-h-10 items-center justify-center gap-1.5 border border-[var(--color-border)] px-3 text-[12px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)] active:border-[var(--color-accent)] active:text-[var(--color-accent)] disabled:opacity-40'
const ICON = 'inline-flex h-10 w-10 shrink-0 items-center justify-center border border-transparent text-[var(--color-text-faint)] transition-colors hover:border-[var(--color-border)] hover:text-[var(--color-text)] active:text-[var(--color-accent)]'
const KEY = 'inline-flex min-h-11 min-w-12 items-center justify-center gap-1 border border-[var(--color-border)] px-3 text-[13px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)]/50 active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.12)] active:text-[var(--color-accent)]'
const ON = 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.10)] text-[var(--color-accent)]'
const HEAD = 'flex h-11 shrink-0 select-none items-center gap-2 border-b border-[var(--color-border)] pl-3 pr-1'

// ------------------------------------------------------------ terminal pane --

function VrTermPane({
  id, name, session, missing, font, focused, ctrlRef, onCtrlUsed, onFocus, onHide, onEnd, onSwap, register,
}: {
  id: string
  name: string
  session: TermSession | undefined
  missing: boolean
  font: number
  focused: boolean
  ctrlRef: RefObject<boolean>
  onCtrlUsed: () => void
  onFocus: (id: string) => void
  onHide: (id: string) => void
  onEnd: (name: string) => void
  onSwap: (id: string) => void
  register: (id: string, api: PaneApi | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fontRef = useRef(font)
  const focusedRef = useRef(focused)
  const missingRef = useRef(missing)
  // The UI zoom this pane has to cancel for itself, see readUiZoom in lib/term.ts.
  const zoomRef = useRef(1)
  const [uiZoom, setUiZoom] = useState(readUiZoom)
  const [gen, setGen] = useState(0)
  const [conn, setConn] = useState<'connecting' | 'live' | 'closed'>('connecting')
  const [confirmEnd, setConfirmEnd] = useState(false)

  useLayoutEffect(() => { fontRef.current = font }, [font])
  useLayoutEffect(() => { focusedRef.current = focused }, [focused])
  useLayoutEffect(() => { missingRef.current = missing }, [missing])

  // Same guards as the phone terminal: never fit a hidden or squeezed box, and
  // never hand tmux a one-row grid.
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
    try { fit.fit() } catch { return }
    term.scrollToBottom()
  }, [])

  // The pane's box changes whenever a neighbor opens or closes, the column
  // count changes, zen toggles, or the headset resizes its window. One fit per
  // frame, and the pty follows through term.onResize below.
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

  // One terminal + one socket per pane. gen is the reconnect handle.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // Cancel the UI zoom for the terminal's own subtree and pay it back in the
    // font size. Without it xterm maps a pointer with zoomed pixels and a cell
    // with unzoomed ones, so a click lands rows below the line it was on. See
    // readUiZoom in lib/term.ts.
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
      // Makes tmux repaint the pane in full at this pane's geometry.
      resize(term.cols, term.rows)
      if (focusedRef.current) term.focus()
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
        onCtrlUsed()
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: out }))
    })
    const onResize = term.onResize(({ cols, rows }) => resize(cols, rows))

    // Cell metrics measured before the webfont lands are a fraction off.
    void document.fonts?.ready.then(() => safeFit())

    return () => {
      onData.dispose()
      onResize.dispose()
      ws.onclose = null
      ws.onerror = null
      ws.close()
      term.dispose()
      if (wsRef.current === ws) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
      setTermZoom(host, 1)
    }
  }, [name, gen, safeFit, ctrlRef, onCtrlUsed])

  // A font change alters cell metrics without changing the box, so the
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

  // A headset that took the browser off screen can drop the socket. Coming
  // back should reattach, not show a frozen screen. Not for a session that is
  // gone: that would 404 on every focus.
  useEffect(() => {
    let timer = 0
    const revive = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible' || missingRef.current) return
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

  useEffect(() => { if (focused) termRef.current?.focus() }, [focused])

  useEffect(() => {
    register(id, {
      send: (d) => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
        termRef.current?.focus()
      },
      scroll: (lines) => {
        const ws = wsRef.current
        if (lines && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 's', lines }))
      },
      rows: () => termRef.current?.rows ?? 24,
      reconnect: () => setGen((g) => g + 1),
      focus: () => termRef.current?.focus(),
    })
    return () => register(id, null)
  }, [id, register])

  // "end" needs a second press, and the offer expires on its own.
  useEffect(() => {
    if (!confirmEnd) return
    const t = window.setTimeout(() => setConfirmEnd(false), 3000)
    return () => window.clearTimeout(t)
  }, [confirmEnd])

  const label = session?.label ?? name
  const tag = missing ? 'gone' : session?.dead ? 'ended' : session?.mode === 'shell' ? 'sh' : 'claude'
  const bad = missing || Boolean(session?.dead)
  const dot = conn === 'live'
    ? 'var(--color-accent)'
    : conn === 'connecting'
      ? 'var(--color-accent-2)'
      : 'var(--color-text-faint)'

  return (
    <div
      onPointerDownCapture={() => onFocus(id)}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden border bg-[var(--color-bg)] ${
        focused ? 'border-[var(--color-accent)]/80' : 'border-[var(--color-border)]'
      }`}
    >
      <div className={HEAD}>
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
        <TerminalIcon size={14} className="shrink-0 text-[var(--color-text-faint)]" />
        <span className={`truncate text-[13px] uppercase tracking-[0.12em] ${focused ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'}`}>
          {label}
        </span>
        <span className={`shrink-0 text-[11px] uppercase tracking-[0.14em] ${bad ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
          {tag}{session?.activityAt ? ` · ${relative(session.activityAt)}` : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          <button type="button" onClick={() => setGen((g) => g + 1)} className={ICON} aria-label="Reconnect" title="Reconnect">
            <RotateCw size={15} />
          </button>
          <button type="button" onClick={() => onSwap(id)} className={ICON} aria-label="Show something else here" title="Show something else here">
            <Replace size={15} />
          </button>
          <button type="button" onClick={() => onHide(id)} className={ICON} aria-label="Hide this screen" title="Hide this screen. The session keeps running.">
            <Minus size={15} />
          </button>
          {confirmEnd ? (
            <button
              type="button"
              onClick={() => onEnd(name)}
              className={`${BTN} min-h-9 border-[var(--color-danger)] text-[var(--color-danger)]`}
            >
              end?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className={`${ICON} hover:text-[var(--color-danger)]`}
              aria-label="End this session"
              title="End this session on thor"
            >
              <Power size={15} />
            </button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} onClick={() => termRef.current?.focus()} className="absolute inset-0 overflow-hidden px-1 py-1" />
        {missing && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 text-center">
            <div className="text-[12px] uppercase tracking-[0.18em] text-[var(--color-danger)]">this session is gone</div>
            <button type="button" onClick={() => onHide(id)} className={BTN}>hide</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- page pane --

// A Valkyrie page as a screen. The iframe asks for "/" with ?go= and lets the
// app route from there (see RootRedirect in App.tsx); the embedded copy draws
// no header of its own.
function VrPagePane({ id, path, focused, onFocus, onHide, onSwap }: {
  id: string
  path: string
  focused: boolean
  onFocus: (id: string) => void
  onHide: (id: string) => void
  onSwap: (id: string) => void
}) {
  const [gen, setGen] = useState(0)
  const label = PAGES.find((p) => p.path === path)?.label ?? path
  return (
    <div
      onPointerDownCapture={() => onFocus(id)}
      className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden border bg-[var(--color-bg)] ${
        focused ? 'border-[var(--color-accent)]/80' : 'border-[var(--color-border)]'
      }`}
    >
      <div className={HEAD}>
        <AppWindow size={14} className="shrink-0 text-[var(--color-text-faint)]" />
        <span className={`truncate text-[13px] uppercase tracking-[0.12em] ${focused ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'}`}>
          {label}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          <button type="button" onClick={() => setGen((g) => g + 1)} className={ICON} aria-label="Reload" title="Reload">
            <RotateCw size={15} />
          </button>
          <button type="button" onClick={() => onSwap(id)} className={ICON} aria-label="Show something else here" title="Show something else here">
            <Replace size={15} />
          </button>
          <button type="button" onClick={() => onHide(id)} className={ICON} aria-label="Hide this screen" title="Hide this screen">
            <Minus size={15} />
          </button>
        </div>
      </div>
      <iframe
        key={gen}
        title={label}
        src={`/?go=${encodeURIComponent(path)}`}
        className="min-h-0 w-full flex-1 border-0 bg-[var(--color-bg)]"
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">&gt; {title}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- the page --

// A page screen is this app in an iframe, and nothing stops a link inside it
// from arriving here. The workspace inside one of its own screens would attach
// a second, smaller client to every session (tmux then sizes them all down and
// fills the big panes with dots), so an embedded copy shows a note instead.
export default function VrPage() {
  if (!isEmbedded) return <Workspace />
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
      <Glasses size={22} className="text-[var(--color-text-faint)]" />
      <div className="text-[12px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">already in the workspace</div>
      <div className="max-w-sm text-[12px] text-[var(--color-text-faint)]">
        This screen is inside the VR desk. Use the frame's own bar to add or change screens.
      </div>
    </div>
  )
}

function Workspace() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const stageRef = useRef<HTMLDivElement>(null)
  const apisRef = useRef(new Map<string, PaneApi>())
  const ctrlRef = useRef(false)

  // The board can hand a session over the same way it does to the terminal
  // page: /vr?s=vk-... adds it as a screen. Read at mount, which is when the
  // handoff arrives (the board is another route, so it always mounts this
  // one); the effect below only strips the parameter afterward.
  const [panes, setPanes] = useState<Pane[]>(() => {
    const saved = loadPanes()
    const s = new URLSearchParams(window.location.search).get('s') ?? ''
    if (TERM_NAME_RE.test(s) && !saved.some((p) => p.kind === 'term' && p.name === s) && saved.length < MAX_PANES) {
      saved.push({ id: uid(), kind: 'term', name: s })
    }
    return saved
  })
  const [cols, setCols] = useState<Cols>(loadCols)
  const [font, setFont] = useState(loadFont)
  const [focus, setFocus] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ replace: string | null } | null>(null)
  const [zen, setZen] = useState(false)
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [paste, setPaste] = useState(false)

  // Same query keys as the phone terminal and the board, so the three never
  // disagree about what is running.
  const sessions = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions })
  const targets = useQuery({
    queryKey: ['launchTargets', 'thor'],
    queryFn: () => fetchLaunchTargets('thor'),
    staleTime: 60_000,
  })
  const recent = useQuery({
    queryKey: ['sessionList'],
    queryFn: fetchSessionList,
    enabled: picker !== null,
    staleTime: 10_000,
  })
  const list = sessions.data ?? EMPTY
  // Every target thor knows, not only the phone's three: the headset is a
  // desk, and Remote-Session.ps1 resolves any key in launch-targets.json. The
  // phone's favorites lead.
  const launchTargets = [...(targets.data ?? [])]
    .filter((t) => t.exists)
    .sort((a, b) => Number(b.phone) - Number(a.phone))
  const resumable = recent.data?.installed
    ? recent.data.sessions.filter((s) => !s.live && !s.done).slice(0, 40)
    : []

  useEffect(() => {
    try {
      const bare = panes.map((p) => (p.kind === 'term' ? { kind: 'term', name: p.name } : { kind: 'page', path: p.path }))
      localStorage.setItem(PANES_KEY, JSON.stringify(bare))
    } catch { /* private mode */ }
  }, [panes])
  useEffect(() => { try { localStorage.setItem(COLS_KEY, String(cols)) } catch { /* private mode */ } }, [cols])
  useEffect(() => { try { localStorage.setItem(FONT_KEY, String(font)) } catch { /* private mode */ } }, [font])

  // Replace, never push, so back leaves the workspace rather than re-adding.
  useEffect(() => {
    if (params.has('s')) setParams({}, { replace: true })
  }, [params, setParams])

  // Zen hides the app header too (index.css keys off this attribute), so the
  // headset's window is nothing but screens.
  useEffect(() => {
    const root = document.documentElement
    if (zen) root.dataset.vrZen = ''
    else delete root.dataset.vrZen
    return () => { delete root.dataset.vrZen }
  }, [zen])

  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  useEffect(() => {
    if (!picker) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicker(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picker])

  const register = useCallback((id: string, api: PaneApi | null) => {
    if (api) apisRef.current.set(id, api)
    else apisRef.current.delete(id)
  }, [])
  const onCtrlUsed = useCallback(() => setCtrlArmed(false), [])

  // The key strip types into the last-touched terminal, or the first one when
  // nothing has been touched yet.
  const termIds = panes.filter((p) => p.kind === 'term').map((p) => p.id)
  const target = focus && termIds.includes(focus) ? focus : (termIds[0] ?? null)
  const send = (d: string) => {
    if (!target) return
    apisRef.current.get(target)?.send(d)
    if (target !== focus) setFocus(target)
  }
  // The headset browser serves this page over plain http like the phone does,
  // so navigator.clipboard is absent there too and reading it is impossible.
  // Same answer: a field the OS can paste into. See components/PasteSheet.
  const doPaste = async () => {
    const t = await readClipboard()
    if (t) { send(t); return }
    setPaste(true)
  }
  const scroll = (lines: number) => { if (target) apisRef.current.get(target)?.scroll(lines) }
  const half = () => Math.max(1, Math.floor((target ? apisRef.current.get(target)?.rows() ?? 24 : 24) / 2))
  const armCtrl = () => {
    ctrlRef.current = !ctrlRef.current
    setCtrlArmed(ctrlRef.current)
    if (target) apisRef.current.get(target)?.focus()
  }

  const toggleFull = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
      return
    }
    const el = document.documentElement
    if (!el.requestFullscreen) {
      setError('this browser has no fullscreen API')
      return
    }
    el.requestFullscreen().catch(() => setError('the browser refused fullscreen'))
  }

  const commit = (pane: Pane, replace: string | null) => {
    if (replace) setPanes(panes.map((x) => (x.id === replace ? pane : x)))
    else if (panes.length >= MAX_PANES) { setError(`${MAX_PANES} screens is the cap. Hide one first.`); return }
    else setPanes([...panes, pane])
    setFocus(pane.id)
    setPicker(null)
  }

  const placeTerm = (name: string, replace: string | null) => {
    const dup = panes.find((x) => x.kind === 'term' && x.name === name)
    if (dup && dup.id !== replace) { setFocus(dup.id); setPicker(null); return }
    commit({ id: uid(), kind: 'term', name }, replace)
  }

  const placePage = (path: string, replace: string | null) => {
    const dup = panes.find((x) => x.kind === 'page' && x.path === path)
    if (dup && dup.id !== replace) { setFocus(dup.id); setPicker(null); return }
    commit({ id: uid(), kind: 'page', path }, replace)
  }

  const hide = (id: string) => {
    setPanes((prev) => prev.filter((x) => x.id !== id))
    if (focus === id) setFocus(null)
  }

  const end = async (name: string) => {
    setError(null)
    try {
      await killTermSession(name)
    } catch (e) {
      setError(errText(e))
    }
    setPanes((prev) => prev.filter((x) => !(x.kind === 'term' && x.name === name)))
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    // Ending a Claude session here ends it on thor too, so the board changed.
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  // The grid the session is created at. Close is enough: the pane's socket
  // sends the exact size the moment it attaches.
  const guessGrid = (replace: string | null) => {
    const n = Math.max(1, panes.length + (replace ? 0 : 1))
    const c = cols || autoCols(n)
    const r = Math.ceil(n / c)
    const w = (stageRef.current?.clientWidth ?? 1600) / c
    const h = (stageRef.current?.clientHeight ?? 900) / r
    return {
      cols: Math.max(40, Math.floor((w - 16) / (font * 0.6))),
      rows: Math.max(12, Math.floor((h - 60) / (font * 1.32))),
    }
  }

  const open = async (body: TermOpen, replace: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const data = await openTermSession({ ...body, ...guessGrid(replace) })
      await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
      placeTerm(data.name, replace)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const n = panes.length
  const c = cols || autoCols(n)
  const byName = new Map(list.map((s) => [s.name, s]))
  const shown = new Set(panes.filter((p): p is TermPane => p.kind === 'term').map((p) => p.name))
  const available = list.filter((s) => !shown.has(s.name))
  // Never off a list that is still loading, or a reload would flash every
  // pane as gone.
  const settled = sessions.isSuccess && !sessions.isFetching

  const colBtn = (v: Cols, icon: ReactNode, title: string) => (
    <button type="button" onClick={() => setCols(v)} className={`${ICON} ${cols === v ? ON : ''}`} title={title} aria-label={title}>
      {icon}
    </button>
  )

  return (
    // absolute inset-0 against main, like the terminal page: whatever Suspense
    // or ErrorBoundary renders in between is skipped.
    <div data-vr-root className="absolute inset-0 z-0 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      {!zen && (
        <div className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-[var(--color-border)] px-2">
          <button type="button" onClick={() => navigate('/sessions')} className={ICON} title="Session board" aria-label="Session board">
            <ChevronLeft size={16} />
          </button>
          <div
            className="flex items-center gap-2 pr-2 text-[13px] font-bold tracking-[0.18em]"
            style={{ color: 'var(--color-accent)', textShadow: '0 0 10px var(--color-accent)' }}
          >
            <Glasses size={16} /> VR<span className="opacity-40">//</span>DESK
          </div>
          <button type="button" onClick={() => setPicker({ replace: null })} className={BTN}>
            <Plus size={14} /> screen
          </button>
          <div className="ml-auto flex items-center gap-1">
            {colBtn(0, <LayoutGrid size={15} />, 'Columns: auto')}
            {colBtn(1, <Square size={15} />, 'One column')}
            {colBtn(2, <Columns2 size={15} />, 'Two columns')}
            {colBtn(3, <Columns3 size={15} />, 'Three columns')}
            <span className="mx-1 h-6 w-px bg-[var(--color-border)]" />
            <button type="button" onClick={() => setFont((f) => Math.max(FONT_MIN, f - 1))} className={`${ICON} text-[12px]`} title="Smaller terminal text">a-</button>
            <span className="min-w-7 text-center text-[12px] text-[var(--color-text-faint)]">{font}</span>
            <button type="button" onClick={() => setFont((f) => Math.min(FONT_MAX, f + 1))} className={`${ICON} text-[12px]`} title="Larger terminal text">a+</button>
            <span className="mx-1 h-6 w-px bg-[var(--color-border)]" />
            <button type="button" onClick={toggleFull} className={`${ICON} ${full ? ON : ''}`} title={full ? 'Leave fullscreen' : 'Fullscreen'} aria-label="Fullscreen">
              {full ? <Minimize size={15} /> : <Maximize size={15} />}
            </button>
            <button type="button" onClick={() => setZen(true)} className={ICON} title="Zen: screens only" aria-label="Zen">
              <EyeOff size={15} />
            </button>
          </div>
        </div>
      )}

      <div ref={stageRef} className="relative min-h-0 flex-1 p-2">
        {n === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Glasses size={28} className="text-[var(--color-text-faint)]" />
            <div className="text-[13px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">no screens yet</div>
            <div className="max-w-md text-[13px] leading-relaxed text-[var(--color-text-faint)]">
              A screen is a Claude session on thor or a Valkyrie page. They sit side by side on
              this one surface, so the headset only has to show a single window.
            </div>
            <button type="button" onClick={() => setPicker({ replace: null })} className={`${BTN} min-h-12 px-5 text-[13px]`}>
              <Plus size={16} /> add a screen
            </button>
          </div>
        ) : (
          <div
            className="grid h-full w-full gap-2"
            style={{ gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}
          >
            {panes.map((p) => (p.kind === 'term' ? (
              <VrTermPane
                key={p.id}
                id={p.id}
                name={p.name}
                session={byName.get(p.name)}
                missing={settled && !byName.has(p.name)}
                font={font}
                focused={focus === p.id}
                ctrlRef={ctrlRef}
                onCtrlUsed={onCtrlUsed}
                onFocus={setFocus}
                onHide={hide}
                onEnd={(name) => void end(name)}
                onSwap={(id) => setPicker({ replace: id })}
                register={register}
              />
            ) : (
              <VrPagePane
                key={p.id}
                id={p.id}
                path={p.path}
                focused={focus === p.id}
                onFocus={setFocus}
                onHide={hide}
                onSwap={(id) => setPicker({ replace: id })}
              />
            )))}
          </div>
        )}

        {error && (
          <div
            onClick={() => setError(null)}
            title="dismiss"
            className="absolute inset-x-2 top-2 z-20 cursor-pointer border border-[var(--color-danger)]/60 bg-[var(--color-bg)] px-4 py-3 text-[13px] text-[var(--color-danger)]"
          >
            {error}
          </div>
        )}

        {paste && (
          <PasteSheet onSend={(t) => send(t)} onClose={() => setPaste(false)} />
        )}

        {picker && (
          <div className="absolute inset-0 z-30 overflow-y-auto bg-black/90 p-3">
            <div className="panel mx-auto max-w-4xl space-y-5 p-4">
              <div className="flex items-center">
                <div className="text-[12px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; {picker.replace ? 'show here instead' : 'add a screen'}
                </div>
                <button type="button" onClick={() => setPicker(null)} className={`${ICON} ml-auto`} aria-label="Close">
                  <X size={16} />
                </button>
              </div>

              <Section title="already running">
                {available.map((s) => (
                  <button key={s.name} type="button" onClick={() => placeTerm(s.name, picker.replace)} className={BTN}>
                    <TerminalIcon size={13} /> {s.label}
                    <span className={`text-[10px] tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
                      {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                      {s.activityAt ? ` · ${relative(s.activityAt)}` : ''}
                    </span>
                  </button>
                ))}
                {sessions.isSuccess && available.length === 0 && (
                  <div className="text-[12px] text-[var(--color-text-faint)]">
                    {list.length ? 'everything running is already on a screen' : 'nothing is running'}
                  </div>
                )}
              </Section>

              <Section title="new claude session on thor in">
                {launchTargets.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    disabled={busy}
                    onClick={() => void open({ mode: 'new', target: t.key, label: t.label }, picker.replace)}
                    className={BTN}
                  >
                    <Plus size={13} /> {t.label}
                  </button>
                ))}
                {targets.isSuccess && launchTargets.length === 0 && (
                  <div className="text-[12px] text-[var(--color-text-faint)]">thor offers no launch targets; it may be asleep.</div>
                )}
              </Section>

              <Section title="plain powershell on thor in">
                {launchTargets.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    disabled={busy}
                    onClick={() => void open({ mode: 'shell', target: t.key, label: `${t.label} sh` }, picker.replace)}
                    className={BTN}
                  >
                    <TerminalIcon size={13} /> {t.label}
                  </button>
                ))}
              </Section>

              <div>
                <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; resume a conversation from thor
                </div>
                {recent.isLoading && (
                  <div className="text-[12px] text-[var(--color-text-faint)]">reading the board…</div>
                )}
                {recent.data && !recent.data.installed && (
                  <div className="text-[12px] text-[var(--color-accent-2)]">
                    the session board answered {recent.data.status}; thor may be asleep
                  </div>
                )}
                <div className="space-y-1">
                  {resumable.map((r) => (
                    <button
                      key={r.sessionId}
                      type="button"
                      disabled={busy}
                      onClick={() => void open({ mode: 'resume', sessionId: r.sessionId, label: r.title }, picker.replace)}
                      className="flex min-h-11 w-full items-center gap-3 border border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]/50 active:border-[var(--color-accent)] disabled:opacity-40"
                    >
                      <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">{r.project}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-dim)]">{r.title}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">{relIso(r.lastActivityUtc)}</span>
                    </button>
                  ))}
                  {recent.data?.installed && resumable.length === 0 && (
                    <div className="text-[12px] text-[var(--color-text-faint)]">
                      nothing on the board to resume. A session that is open on thor has to be stopped there first.
                    </div>
                  )}
                </div>
              </div>

              <Section title="valkyrie page">
                {PAGES.map((p) => (
                  <button key={p.path} type="button" onClick={() => placePage(p.path, picker.replace)} className={BTN}>
                    <AppWindow size={13} /> {p.label}
                  </button>
                ))}
              </Section>
            </div>
          </div>
        )}
      </div>

      {/* Keys the SteamOS keyboard does not have, one row, largest targets on
          the right where Enter is. Sends to the last-touched terminal. */}
      {!zen && termIds.length > 0 && (
        <div className="flex shrink-0 select-none flex-wrap items-stretch gap-1.5 border-t border-[var(--color-border)] p-2">
          <button type="button" onClick={() => send('\x1b')} className={KEY}>esc</button>
          <button type="button" onClick={() => send('\t')} className={KEY}>tab</button>
          <button type="button" onClick={armCtrl} className={`${KEY} ${ctrlArmed ? ON : ''}`}>ctrl</button>
          {/* Shift+Tab cycles Claude Code's permission modes. */}
          <button type="button" onClick={() => send('\x1b[Z')} className={KEY} aria-label="Shift Tab">&#8679;tab</button>
          <button type="button" onClick={() => send('\x03')} className={KEY}>^c</button>
          <span className="w-2" aria-hidden />
          <button type="button" onClick={() => send('\x1b[D')} className={KEY} aria-label="Left"><ArrowLeft size={16} /></button>
          <button type="button" onClick={() => send('\x1b[B')} className={KEY} aria-label="Down"><ArrowDown size={16} /></button>
          <button type="button" onClick={() => send('\x1b[A')} className={KEY} aria-label="Up"><ArrowUp size={16} /></button>
          <button type="button" onClick={() => send('\x1b[C')} className={KEY} aria-label="Right"><ArrowRight size={16} /></button>
          <span className="w-2" aria-hidden />
          <button type="button" onClick={() => scroll(half())} className={KEY} aria-label="Page up"><ChevronUp size={16} /></button>
          <button type="button" onClick={() => scroll(-half())} className={KEY} aria-label="Page down"><ChevronDown size={16} /></button>
          <span className="w-2" aria-hidden />
          <button
            type="button"
            onClick={() => { void doPaste() }}
            className={KEY}
          >
            paste
          </button>
          <div className="ml-auto flex items-stretch gap-1.5">
            {/* Backslash-Enter is the newline Claude Code always accepts. */}
            <button type="button" onClick={() => send('\\\r')} className={KEY} aria-label="Newline">\&#9166;</button>
            <button type="button" onClick={() => send('\r')} className={`${KEY} min-w-20 ${ON}`} aria-label="Enter">
              <CornerDownLeft size={18} />
            </button>
          </div>
        </div>
      )}

      {zen && (
        <button
          type="button"
          onClick={() => setZen(false)}
          className="absolute bottom-3 right-3 z-40 inline-flex h-11 w-11 items-center justify-center border border-[var(--color-border)] bg-[var(--color-bg)]/80 text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-accent)]"
          title="Leave zen"
          aria-label="Leave zen"
        >
          <Eye size={16} />
        </button>
      )}
    </div>
  )
}
