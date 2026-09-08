import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Keyboard,
  Plus, RotateCw, Terminal as TerminalIcon, X,
} from 'lucide-react'
import { api } from '../lib/api'
import { getToken } from '../lib/auth'

// Claude Code from the phone. The session lives in tmux on odin, so this page
// is only a screen and a keyboard for it: closing the tab, locking the phone,
// or deploying the API all just detach, and coming back reattaches to the same
// running session.

type TermSession = {
  name: string
  label: string
  mode: string
  cwd: string
  createdAt: number
  activityAt: number
  clients: number
  command: string
  size: string
}

type Target = { key: string; label: string; path: string }

type RecentSession = {
  sessionId: string
  cwd: string
  project: string
  title: string
  lastActivity: number
  bytes: number
}

type TermStatus = {
  ok: boolean
  tmux: string | null
  claude: string | null
  serverUp: boolean
  maxSessions: number
}

const FONT_KEY = 'valkyrie-term-font'
const FONT_MIN = 9
const FONT_MAX = 20

// The app token rides the query string because a browser cannot set headers on
// a websocket handshake. It is the same trade the existing upgrade path makes;
// on the tailnet no token is sent at all, since the backend trusts the socket.
function wsUrl(name: string, cols: number, rows: number): string {
  const base = api.defaults.baseURL || '/api'
  const abs = base.startsWith('http') ? base : `${window.location.origin}${base}`
  const u = new URL(abs)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws/terminal'
  u.search = ''
  u.searchParams.set('s', name)
  u.searchParams.set('cols', String(cols))
  u.searchParams.set('rows', String(rows))
  const token = getToken()
  if (token) u.searchParams.set('token', token)
  return u.toString()
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d
  const accent = v('--color-accent', '#00ff41')
  const bg = v('--color-bg', '#000000')
  const fg = v('--color-text', '#b8ffca')
  const warn = v('--color-accent-2', '#ffe500')
  const danger = v('--color-danger', '#ff1744')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: 'rgba(255,255,255,0.22)',
    black: bg,
    brightBlack: v('--color-text-faint', '#4a8055'),
    green: accent,
    brightGreen: accent,
    yellow: warn,
    brightYellow: warn,
    red: danger,
    brightRed: danger,
    white: fg,
    brightWhite: '#ffffff',
  }
}

// Ctrl is a modifier no soft keyboard offers, so the bar arms it and the next
// real keystroke gets folded down into its control code.
function toCtrl(d: string): string {
  if (d.length !== 1) return d
  const c = d.toLowerCase()
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96)
  if (d === '[') return '\x1b'
  if (d === ' ') return '\x00'
  return d
}

const relative = (ms: number) => {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

const errText = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error
  || (e as Error)?.message
  || 'failed'

const BTN = 'inline-flex min-h-9 items-center justify-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

export default function TerminalPage() {
  const qc = useQueryClient()

  const hostRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const ctrlRef = useRef(false)
  const fontRef = useRef(12)

  const [active, setActive] = useState<string | null>(null)
  const [gen, setGen] = useState(0)
  const [conn, setConn] = useState<'idle' | 'connecting' | 'live' | 'closed'>('idle')
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [font, setFont] = useState(() => {
    const v = Number(localStorage.getItem(FONT_KEY))
    return v >= FONT_MIN && v <= FONT_MAX ? v : 12
  })
  const [height, setHeight] = useState(320)
  const [picker, setPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  fontRef.current = font

  const sessions = useQuery({
    queryKey: ['term', 'sessions'],
    queryFn: async () => (await api.get<TermSession[]>('/terminal/sessions')).data,
  })
  const status = useQuery({
    queryKey: ['term', 'status'],
    queryFn: async () => (await api.get<TermStatus>('/terminal/status')).data,
    refetchInterval: 60_000,
  })
  const targets = useQuery({
    queryKey: ['term', 'targets'],
    queryFn: async () => (await api.get<Target[]>('/terminal/targets')).data,
    refetchInterval: false,
    staleTime: 600_000,
  })
  const recent = useQuery({
    queryKey: ['term', 'recent'],
    queryFn: async () => (await api.get<RecentSession[]>('/terminal/recent')).data,
    enabled: picker,
    refetchInterval: false,
    staleTime: 60_000,
  })

  const list = sessions.data ?? []

  // Land on whatever ran most recently. Opening the page and being asked to
  // choose before you can see anything is the wrong default on a phone.
  useEffect(() => {
    if (active || !list.length) return
    if (!list.some((s) => s.name === active)) setActive(list[0].name)
  }, [list, active])

  // The terminal is sized in px against the *visible* viewport, not a
  // percentage: it sits inside a scrolling <main>, and on iOS the software
  // keyboard shrinks visualViewport without touching the layout viewport, so
  // anything height-based in CSS ends up under the keyboard.
  const measure = useCallback(() => {
    const el = hostRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const vv = window.visualViewport
    const avail = vv ? vv.height + vv.offsetTop : window.innerHeight
    const keys = keysRef.current?.offsetHeight ?? 0
    setHeight(Math.max(180, Math.floor(avail - top - keys - 18)))
  }, [])

  useEffect(() => {
    measure()
    const vv = window.visualViewport
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
    }
  }, [measure])

  // The strip and the launcher panel change how much room is left.
  useEffect(() => {
    const t = setTimeout(measure, 60)
    return () => clearTimeout(t)
  }, [measure, picker, list.length, error])

  const send = useCallback((d: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }))
    termRef.current?.focus()
  }, [])

  // One terminal + one socket per selected session. `gen` is the reconnect
  // handle: bumping it tears the pair down and builds them again.
  useEffect(() => {
    const host = hostRef.current
    if (!active || !host) return

    const term = new XTerm({
      fontSize: fontRef.current,
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
    try { fit.fit() } catch { /* not laid out yet */ }

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
      // behind, which after a phone rotation is a half-drawn screen.
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
    }
  }, [active, gen])

  // Font and height both change the grid, and refitting is the only thing that
  // tells the far side about it.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontSize = font
    try { localStorage.setItem(FONT_KEY, String(font)) } catch { /* private mode */ }
    const id = requestAnimationFrame(() => { try { fit.fit() } catch { /* detached */ } })
    return () => cancelAnimationFrame(id)
  }, [font, height])

  // iOS suspends a backgrounded socket. Coming back to a dead one should just
  // reattach rather than showing a frozen screen.
  useEffect(() => {
    const revive = () => {
      if (document.visibilityState !== 'visible') return
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        setGen((g) => g + 1)
      }
    }
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('focus', revive)
    return () => {
      document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('focus', revive)
    }
  }, [])

  const guessGrid = () => {
    const w = hostRef.current?.clientWidth ?? 360
    return {
      cols: Math.max(24, Math.floor(w / (font * 0.6))),
      rows: Math.max(10, Math.floor(height / (font * 1.32))),
    }
  }

  const openSession = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const term = termRef.current
      const grid = guessGrid()
      const { data } = await api.post<{ name: string }>('/terminal/sessions', {
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
      await api.post(`/terminal/sessions/${name}/kill`)
    } catch (e) {
      setError(errText(e))
    }
    if (active === name) setActive(null)
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
  }

  const dot = conn === 'live'
    ? 'var(--color-accent)'
    : conn === 'connecting'
      ? 'var(--color-accent-2)'
      : 'var(--color-text-faint)'

  return (
    <div className="space-y-2.5">
      {/* Open sessions. Horizontally scrollable so twelve of them still fit one row. */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
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
                <span className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                  {s.mode === 'shell' ? 'sh' : s.command || s.mode}
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

        <button
          type="button"
          onClick={() => setPicker((v) => !v)}
          className={`${BTN} shrink-0`}
        >
          <Plus size={12} /> new
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">{conn}</span>
        </div>
      </div>

      {error && (
        <div className="border border-[var(--color-danger)]/60 px-3 py-2 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {status.data && !status.data.ok && (
        <div className="border border-[var(--color-accent-2)]/60 px-3 py-2 text-[11px] text-[var(--color-accent-2)]">
          {!status.data.tmux ? 'tmux is not installed on odin.' : 'claude is not installed on odin.'}
        </div>
      )}

      {picker && (
        <div className="panel space-y-4 p-3">
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
              &gt; new session in
            </div>
            <div className="flex flex-wrap gap-2">
              {(targets.data ?? []).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  disabled={busy}
                  onClick={() => void openSession({ mode: 'new', target: t.key })}
                  className={`${BTN} disabled:opacity-40`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
              &gt; pick up the last session in
            </div>
            <div className="flex flex-wrap gap-2">
              {(targets.data ?? []).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  disabled={busy}
                  onClick={() => void openSession({ mode: 'continue', target: t.key })}
                  className={`${BTN} disabled:opacity-40`}
                >
                  <RotateCw size={11} /> {t.label}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => void openSession({ mode: 'shell', target: 'home' })}
                className={`${BTN} disabled:opacity-40`}
              >
                <TerminalIcon size={11} /> plain shell
              </button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
              &gt; resume by conversation
            </div>
            {recent.isLoading && (
              <div className="text-[11px] text-[var(--color-text-faint)]">reading transcripts…</div>
            )}
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {(recent.data ?? []).map((r) => (
                <button
                  key={r.sessionId}
                  type="button"
                  disabled={busy}
                  onClick={() => void openSession({ mode: 'resume', sessionId: r.sessionId })}
                  className="flex w-full items-start gap-2 border border-[var(--color-border)] px-2.5 py-2 text-left transition-colors active:border-[var(--color-accent)] hover:border-[var(--color-accent)]/50 disabled:opacity-40"
                >
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-accent)]">
                    {r.project}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]">
                    {r.title}
                  </span>
                  <span className="shrink-0 text-[9px] text-[var(--color-text-faint)]">
                    {relative(r.lastActivity)}
                  </span>
                </button>
              ))}
              {recent.data?.length === 0 && (
                <div className="text-[11px] text-[var(--color-text-faint)]">no transcripts on odin yet</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The screen. Tapping it focuses xterm's textarea, which is what raises
          the software keyboard on iOS. */}
      <div className="relative">
        <div
          ref={hostRef}
          onClick={() => termRef.current?.focus()}
          style={{ height }}
          className="w-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-1"
        />
        {!active && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <TerminalIcon size={20} className="text-[var(--color-text-faint)]" />
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
              {sessions.isLoading ? 'loading' : 'no session open'}
            </div>
            {!sessions.isLoading && (
              <div className="text-[10px] text-[var(--color-text-faint)]">tap NEW to start one</div>
            )}
          </div>
        )}
      </div>

      {/* Keys a software keyboard does not have. Two rows on a phone, one on
          anything wider. */}
      <div ref={keysRef} className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => send('\x1b')} className={BTN}>esc</button>
        <button type="button" onClick={() => send('\t')} className={BTN}>tab</button>
        <button
          type="button"
          onClick={() => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); termRef.current?.focus() }}
          className={`${BTN} ${ctrlArmed ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''}`}
        >
          ctrl
        </button>
        <button type="button" onClick={() => send('\x03')} className={BTN}>^c</button>
        <button type="button" onClick={() => send('\x1b[A')} className={BTN} aria-label="Up"><ArrowUp size={12} /></button>
        <button type="button" onClick={() => send('\x1b[B')} className={BTN} aria-label="Down"><ArrowDown size={12} /></button>
        <button type="button" onClick={() => send('\x1b[D')} className={BTN} aria-label="Left"><ArrowLeft size={12} /></button>
        <button type="button" onClick={() => send('\x1b[C')} className={BTN} aria-label="Right"><ArrowRight size={12} /></button>
        <button type="button" onClick={() => send('\r')} className={BTN} aria-label="Enter"><CornerDownLeft size={12} /></button>
        {/* Backslash-Enter is the newline Claude Code always accepts; Option and
            Shift+Enter are not reachable from a phone keyboard. */}
        <button type="button" onClick={() => send('\\\r')} className={BTN}>\⏎</button>
        <button
          type="button"
          onClick={() => { void navigator.clipboard?.readText().then((t) => t && send(t)).catch(() => setError('clipboard blocked')) }}
          className={BTN}
        >
          paste
        </button>
        <button type="button" onClick={() => termRef.current?.focus()} className={BTN} aria-label="Keyboard">
          <Keyboard size={12} />
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFont((f) => Math.max(FONT_MIN, f - 1))}
            className={BTN}
          >
            a-
          </button>
          <button
            type="button"
            onClick={() => setFont((f) => Math.min(FONT_MAX, f + 1))}
            className={BTN}
          >
            a+
          </button>
          <button type="button" onClick={() => setGen((g) => g + 1)} className={BTN} aria-label="Reconnect">
            <RotateCw size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
