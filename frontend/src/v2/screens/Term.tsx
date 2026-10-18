import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import '@xterm/xterm/css/xterm.css'
import { ArrowUp, Camera, ChevronDown, CornerDownLeft, ImageUp, Keyboard, MoreHorizontal, X } from 'lucide-react'
import {
  PROJECT_BACK_RE, fetchLaunchTargets, fetchSessionList, fetchTermSessions, fetchTermStatus, killTermSession,
  openTermSession, termLabel, type TermOpen, type TermOpenResult, type TermSession,
} from '../../lib/api'
import { TERM_NAME_RE, errText, relIso, relative, toCtrl, v2TermPath } from '../../lib/term'
import {
  TERM_FONT_MAX, TERM_FONT_MIN, isCramped, readTermFont, useTermScrollInput, useTermSocket, useTermViewport,
} from '../../lib/termSession'
import { readText as readClipboard } from '../../lib/clipboard'
import { seedTerminal } from '../../lib/sessionLaunch'
import { uploadLine, useThorUpload } from '../../lib/useThorUpload'
import { BASE, StatusStrip } from '../kit/shell'
import { Button, Glyph, IconButton, Press, ToastHost, cx, toast } from '../kit/ui'
import { Icon, hostIcon } from '../kit/icons'
import { applyPalette, useFont, usePalette, useStoredMode } from '../kit/theme'
import { ActivityStrip, Choices, StateGlyph } from '../kit/termskin'
import {
  ActivityLog, NO_SCREEN, PHASE, sameScreen, scanTerm, termFont, termTheme, useCliGlyphs, useMedia,
  type Act, type CliMode, type Phase, type ScreenState, type TodoSnap,
} from '../kit/termscreen'
import './skin.css'
import './term.css'

// AI > Sessions > a session (/m/ai/term/<name>): the real tmux pane, in the
// Valkyrie skin Brendon approved as a preview (/m/ai/skin, Skin.tsx). The CLI
// stays the engine and this page is a screen and a keyboard for it, exactly as
// the classic phone terminal (pages/Terminal.tsx) is: the socket, the watchdog,
// the fit, the keyboard geometry and swipe scrolling are the same code
// (lib/termSession.ts). On top of it: the composer types a whole message and
// submits it, the quick keys send the CLI's keys, a permission question on the
// screen becomes plates, and the tool lines on the screen become the activity
// strip.
//
// This page attaches to the session named in its URL and to nothing else. It
// never picks "the latest session": a name that is not open shows a panel, and
// the only way to another session is a tap on it. Attaching resizes the pane
// to this screen, so landing on the wrong one would repaint a Claude session
// someone is typing into elsewhere.

const EMPTY: TermSession[] = []

// Claude Code reads input that arrives in one burst as a paste, so an Enter in
// the same burst as the text becomes a newline in the prompt instead of a
// submit. The text goes as a paste (bracketed whenever the pane asked for it)
// and the Enter follows on its own a moment later.
const ENTER_DELAY_MS = 120

const SLASH = ['/clear', '/compact', '/context', '/cost', '/model', '/resume', '/review']

type KeyId = 'esc' | 'ctrlc' | 'tab' | 'stab' | 'up' | 'down' | 'slash' | 'y' | 'n' | '1' | '2' | '3' | 'left' | 'right' | 'ctrl' | 'kbd'
// The approved row first (Esc ^C Tab shift-Tab up down / y n 1 2 3), then the
// keys the classic key pad had that a phone keyboard lacks.
const KEYS: { id: KeyId; label: string; aria: string; seq?: string; sub?: string }[] = [
  { id: 'esc', label: 'Esc', aria: 'Escape', seq: '\x1b' },
  { id: 'ctrlc', label: '^C', aria: 'Control C', seq: '\x03' },
  { id: 'tab', label: 'Tab', aria: 'Tab', seq: '\t' },
  { id: 'stab', label: '⇧Tab', aria: 'Shift Tab, change mode', seq: '\x1b[Z', sub: 'mode' },
  { id: 'up', label: '↑', aria: 'Up', seq: '\x1b[A' },
  { id: 'down', label: '↓', aria: 'Down', seq: '\x1b[B' },
  { id: 'slash', label: '/', aria: 'Slash', seq: '/' },
  { id: 'y', label: 'y', aria: 'y', seq: 'y' },
  { id: 'n', label: 'n', aria: 'n', seq: 'n' },
  { id: '1', label: '1', aria: '1', seq: '1' },
  { id: '2', label: '2', aria: '2', seq: '2' },
  { id: '3', label: '3', aria: '3', seq: '3' },
  { id: 'left', label: '←', aria: 'Left', seq: '\x1b[D' },
  { id: 'right', label: '→', aria: 'Right', seq: '\x1b[C' },
  { id: 'ctrl', label: 'Ctrl', aria: 'Control: folds the next key into its control code' },
  { id: 'kbd', label: '', aria: 'Type straight into the terminal' },
]
const ANSWER_KEYS = new Set<KeyId>(['esc', 'y', 'n', '1', '2', '3'])

const MODE_LABEL: Record<CliMode, string> = { default: '', accept: '⏵⏵ accept edits', plan: '⏸ plan mode', bypass: 'bypass on' }
const CONN_WORD = { idle: 'idle', connecting: 'connecting', live: 'live', closed: 'offline' } as const

/** /m/ai/term/:name. One page per session: a switch remounts it, so nothing read off one pane lingers on the next. */
export default function TermScreen() {
  const { name = '' } = useParams()
  if (!TERM_NAME_RE.test(name)) return <Navigate to={`${BASE}/ai/sessions`} replace />
  return <Term key={name} name={name} />
}

function Term({ name }: { name: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  // A project hands the phone over with ?back=; its sessions go back to the projects list.
  const backParam = params.get('back')
  const fromProject = !!backParam && PROJECT_BACK_RE.test(backParam)
  const backTo = fromProject ? `${BASE}/ai/projects` : `${BASE}/ai/sessions`
  const backWord = fromProject ? 'Projects' : 'Sessions'

  // no shell here: follow the stored scheme and font the way it does
  const palette = usePalette()
  const stored = useStoredMode()
  useLayoutEffect(() => { applyPalette(stored) }, [stored])
  useFont()
  useCliGlyphs()

  const wide = useMedia('(min-width: 760px)')
  const short = useMedia('(max-height: 480px)')
  const md = useMedia('(min-width: 640px)')
  const lg = useMedia('(min-width: 1200px)')
  const coarse = useMedia('(pointer: coarse)')

  const hostRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const ctrlRef = useRef(false)
  // The terminal takes focus (and on a phone, the keyboard) only when asked:
  // there the composer types, and a tap on the screen is a tap, not a keyboard.
  const directRef = useRef(false)
  const coarseRef = useRef(coarse)
  const focusBack = useRef<HTMLElement | null>(null)

  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [direct, setDirect] = useState(false)
  const [font, setFont] = useState(() => readTermFont(termFont(window.innerWidth).size))
  const [sheet, setSheet] = useState(false)
  const [picker, setPicker] = useState(false)
  const [more, setMore] = useState(false)
  const [closeArmed, setCloseArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cramped, setCramped] = useState(false)
  const [draft, setDraft] = useState('')
  const history = useRef<string[]>([])
  const histAt = useRef(-1)

  const [screen, setScreen] = useState<ScreenState>(NO_SCREEN)
  const [acts, setActs] = useState<Act[]>([])
  const [todos, setTodos] = useState<TodoSnap | null>(null)
  const [actPick, setActPick] = useState<boolean | null>(null)
  const actOpen = actPick ?? (wide && !short)

  // Always a fresh list on arrival: a name that is not in it is a session that
  // ended, and that call must not be made off a cached list from before this
  // session was opened.
  const sessions = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchOnMount: 'always' })
  const status = useQuery({ queryKey: ['term', 'status'], queryFn: fetchTermStatus, refetchInterval: 60_000 })
  const targets = useQuery({ queryKey: ['launchTargets', 'thor'], queryFn: () => fetchLaunchTargets('thor'), staleTime: 60_000 })
  const phoneTargets = (targets.data ?? []).filter((t) => t.phone && t.exists)
  const recent = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, staleTime: 10_000, refetchInterval: 30_000 })
  const boardRows = useMemo(() => (recent.data?.installed ? recent.data.sessions : []), [recent.data])
  const resumable = boardRows.filter((s) => !s.live && !s.done).slice(0, 40)
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of boardRows) if (s.title) m.set(s.sessionId, s.title)
    return m
  }, [boardRows])

  const list = sessions.data ?? EMPTY
  // Oldest first: the server's order moves a session to the front each time it prints.
  const ordered = useMemo(() => [...list].sort((a, b) => a.createdAt - b.createdAt), [list])
  const live = list.find((s) => s.name === name) ?? null
  // The last row seen for this name, so an ended session keeps its title, host
  // and kind on screen next to the panel that says it ended. The query shares
  // structure, so a refetch with nothing new hands back the same row.
  const [known, setKnown] = useState<TermSession | null>(null)
  if (live && live !== known) setKnown(live)
  const session = live
  const shown = live ?? known
  // Missing from a fresh list means ended, and an ended name never comes back
  // (tmux names are minted per session), so it stays ended for this page and
  // the socket is never tried again: no reconnect into a 404 on every refetch.
  const [goneSeen, setGoneSeen] = useState(false)
  const gone = goneSeen || (sessions.isSuccess && !sessions.isFetching && !session)
  if (gone && !goneSeen) setGoneSeen(true)
  const shell = shown?.mode === 'shell'
  const askRef = useRef(!shell)
  useLayoutEffect(() => { askRef.current = !shell }, [shell])
  useLayoutEffect(() => { coarseRef.current = coarse }, [coarse])

  const theme = useMemo(() => termTheme(palette), [palette.fg]) // eslint-disable-line react-hooks/exhaustive-deps
  const themeRef = useRef(theme)
  useLayoutEffect(() => { themeRef.current = theme }, [theme])
  const line = (lg ? termFont(1600) : md ? termFont(800) : termFont(390)).line
  const lineRef = useRef(line)
  useLayoutEffect(() => { lineRef.current = line }, [line])

  // One read of the screen per frame that brought output: the question, the
  // spinner, the mode, and the tool lines for the activity strip.
  const logRef = useRef<ActivityLog | null>(null)
  const scanRaf = useRef(0)
  const scanRef = useRef<() => void>(() => {})

  const sock = useTermSocket({
    hostRef,
    name,
    enabled: !gone,
    font,
    options: () => ({
      theme: themeRef.current,
      lineHeight: lineRef.current,
      fontWeight: 400,
      fontWeightBold: 700,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'bar',
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
    }),
    mapInput: (d) => {
      if (!ctrlRef.current) return d
      ctrlRef.current = false
      setCtrlArmed(false)
      return toCtrl(d)
    },
    // On a touch screen the grid only takes the keyboard in direct mode. Its
    // helper textarea is read-only until then (no keyboard on a tap), and its
    // focus refuses, so a stray focus cannot make the geometry predict a
    // keyboard that never comes.
    setup: (term) => {
      const ta = term.textarea
      if (!ta || !coarseRef.current) return
      ta.readOnly = true
      const orig = ta.focus.bind(ta)
      ta.focus = (f?: FocusOptions) => { if (directRef.current) orig(f) }
    },
    onOpened: (term) => {
      if (coarseRef.current) return
      const ae = document.activeElement as HTMLElement | null
      const typing = !!ae && ae !== term.textarea && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))
      if (!typing && document.hasFocus()) term.focus()
    },
    onWrite: () => {
      if (!scanRaf.current) scanRaf.current = requestAnimationFrame(() => scanRef.current())
    },
  })
  const { termRef, conn, safeFit, scrollBy, leaveScroll } = sock

  useLayoutEffect(() => {
    scanRef.current = () => {
      scanRaf.current = 0
      const term = termRef.current
      if (!term) return
      const r = scanTerm(term, askRef.current)
      setScreen((cur) => (sameScreen(cur, r.screen) ? cur : r.screen))
      const log = (logRef.current ??= new ActivityLog())
      if (log.merge(r.acts)) setActs([...log.acts])
      if (r.todos) {
        const t = r.todos
        setTodos((cur) => (cur && cur.done === t.done && cur.total === t.total && cur.current === t.current ? cur : t))
      }
    }
  })
  useEffect(() => () => cancelAnimationFrame(scanRaf.current), [])

  useTermViewport(hostRef, probeRef, (h) => {
    setCramped(isCramped(h))
    safeFit()
  })
  useTermScrollInput(hostRef, termRef, scrollBy, leaveScroll)

  // the scheme and the line height follow without a rebuild
  useEffect(() => {
    const t = termRef.current
    if (t) t.options.theme = theme
  }, [theme, termRef])
  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.options.lineHeight = line
    const raf = requestAnimationFrame(() => safeFit())
    return () => cancelAnimationFrame(raf)
  }, [line, safeFit, termRef])

  // A pane that ended under us (killed elsewhere, or its program exited) shows
  // as a closed socket: read the list again so the page can say so instead of
  // reconnecting into a 404.
  useEffect(() => {
    if (conn === 'closed') void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
  }, [conn, qc])

  // The composer grows to five lines, upward over the terminal, so the
  // terminal's box never changes while typing (no refit, no tmux repaint).
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 124)}px`
  }, [draft])

  // ---------- sending ----------

  const disarmCtrl = useCallback(() => {
    ctrlRef.current = false
    setCtrlArmed(false)
  }, [])

  const sendRaw = sock.send
  /** A key for the pane, with the armed ctrl folded into a single character. */
  const sendKey = useCallback((seq: string) => {
    let out = seq
    if (ctrlRef.current && seq.length === 1) {
      out = toCtrl(seq)
      disarmCtrl()
    }
    sendRaw(out)
  }, [sendRaw, disarmCtrl])

  // A tap on a key must not take the caret from the composer (or the grid):
  // that would drop the phone keyboard and resize the terminal twice per key.
  // The press keeps focus where it is; a browser that moves it anyway gets it
  // back on the click.
  const keepFocus = useCallback((e: ReactPointerEvent) => {
    e.preventDefault()
    const a = document.activeElement
    focusBack.current = a instanceof HTMLElement && (a === taRef.current || a === termRef.current?.textarea) ? a : null
  }, [termRef])
  const restoreFocus = useCallback(() => {
    const el = focusBack.current
    focusBack.current = null
    if (el && el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true })
  }, [])

  const toggleDirect = useCallback(() => {
    const term = termRef.current
    const ta = term?.textarea
    if (!term || !ta) return
    if (!coarseRef.current) {
      if (document.activeElement === ta) ta.blur()
      else term.focus()
      return
    }
    const on = !directRef.current
    directRef.current = on
    setDirect(on)
    ta.toggleAttribute('readonly', !on)
    if (on) term.focus()
    else ta.blur()
  }, [termRef])

  const onKey = (k: KeyId) => {
    if (k === 'ctrl') {
      ctrlRef.current = !ctrlRef.current
      setCtrlArmed(ctrlRef.current)
      return
    }
    // 'kbd' runs from the click (toggleDirect): iOS opens a keyboard only for a focus made inside one
    if (k === 'kbd') return
    const seq = KEYS.find((x) => x.id === k)?.seq
    if (seq) sendKey(seq)
  }

  const send = () => {
    const term = termRef.current
    if (!sock.isOpen() || !term) {
      toast(gone ? 'This session is not open' : 'Not connected yet. Your message is still here.')
      return
    }
    const text = draft.replace(/\s+$/, '')
    if (!text) {
      sendKey('\r')
      return
    }
    term.paste(text)
    window.setTimeout(() => { if (termRef.current === term) sendRaw('\r') }, ENTER_DELAY_MS)
    if (history.current[history.current.length - 1] !== text) history.current.push(text)
    histAt.current = -1
    setDraft('')
  }

  const recall = (dir: -1 | 1) => {
    const h = history.current
    if (!h.length) return
    let i = histAt.current
    if (dir < 0) i = i < 0 ? h.length - 1 : Math.max(0, i - 1)
    else {
      if (i < 0) return
      i += 1
      if (i >= h.length) {
        histAt.current = -1
        setDraft('')
        return
      }
    }
    histAt.current = i
    setDraft(h[i])
  }

  const slash = draft.startsWith('/') && !draft.includes(' ') ? SLASH.filter((c) => c.startsWith(draft) && c !== draft) : []

  const onTaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      sendKey('\x1b')
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      sendKey('\x1b[Z')
    } else if (e.key === 'Tab' && slash.length) {
      e.preventDefault()
      setDraft(`${slash[0]} `)
    } else if (e.key === 'Tab' && !draft) {
      e.preventDefault()
      sendKey('\t')
    } else if (e.key === 'ArrowUp' && !draft.includes('\n') && e.currentTarget.selectionStart === 0) {
      e.preventDefault()
      recall(-1)
    } else if (e.key === 'ArrowDown' && !draft.includes('\n') && histAt.current >= 0) {
      e.preventDefault()
      recall(1)
    }
  }

  // Paste. On the tailnet the page is plain http, where navigator.clipboard
  // does not exist; there the composer is the paste field the OS fills
  // (long-press, Paste), and this says so.
  const doPaste = async () => {
    setMore(false)
    const t = await readClipboard()
    if (t) {
      termRef.current?.paste(t)
      return
    }
    taRef.current?.focus()
    toast('Long-press the message box and choose Paste')
  }

  // ---------- the question and the state ----------

  const q = shell ? null : screen.q
  const phase: Phase = q ? 'asking' : screen.spinning ? 'working' : 'idle'
  const answer = (n: number) => sendKey(String(n))

  // a keyboard outside the composer and the grid: Esc, and 1/2/3/y/n while Claude asks
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useLayoutEffect(() => {
    keyRef.current = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.key === 'Escape') {
        e.preventDefault()
        sendKey('\x1b')
      } else if (q && /^[123yn]$/.test(e.key)) {
        e.preventDefault()
        sendKey(e.key)
      }
    }
  })
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [])

  // ---------- uploads into the prompt ----------

  // Photos and videos to C:\Thor\uploads, each saved path typed into the prompt
  // with no Enter: the message about it is still Brendon's to write. Only into
  // the session the picker was opened from (a switch remounts this page, and a
  // path for the old one is dropped with it); a closed socket holds the path
  // for the reconnect.
  const hold = sock.hold
  const up = useThorUpload<string>({
    clearAfterMs: 8_000,
    onDone: (done, tag) => {
      if (tag !== name) return
      hold(done.map((d) => d.path).join(' ') + ' ')
    },
  })

  // ---------- sessions ----------

  const go = useCallback((n: string) => {
    navigate(v2TermPath(n, fromProject ? backParam : null), { replace: true })
  }, [navigate, fromProject, backParam])

  const back = () => {
    const st = window.history.state as { idx?: number } | null
    if (st?.idx) navigate(-1)
    else navigate(backTo, { replace: true })
  }

  const guessGrid = () => {
    const host = hostRef.current
    const w = host?.clientWidth ?? 360
    const h = host?.clientHeight ?? 320
    return {
      cols: Math.max(24, Math.floor(w / (font * 0.6))),
      rows: Math.max(10, Math.floor(h / (font * 1.32))),
    }
  }

  // fallback is tried once on a 404, the answer for a project archived since
  // its pane opened, so a reopen does not end with no pane at all.
  const openSession = async (body: TermOpen, fallback?: TermOpen) => {
    setBusy(true)
    setError(null)
    try {
      const term = termRef.current
      const grid = guessGrid()
      const size = { cols: term?.cols ?? grid.cols, rows: term?.rows ?? grid.rows }
      let data: TermOpenResult
      try {
        data = await openTermSession({ ...body, ...size })
      } catch (e) {
        if (!fallback || (e as { response?: { status?: number } } | null)?.response?.status !== 404) throw e
        data = await openTermSession({ ...fallback, ...size })
      }
      seedTerminal(qc, data)
      setPicker(false)
      setSheet(false)
      if (data.name) go(data.name)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const closeSession = async (n: string) => {
    setError(null)
    try {
      await killTermSession(n)
    } catch (e) {
      setError(errText(e))
    }
    await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    // Closing a Claude session here ends it on thor too, so the board's live set just changed.
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    if (n === name) navigate(backTo, { replace: true })
  }

  // Open the same thing again in place of a dead pane, the classic page's rules:
  // the dead one is killed first; a new session whose conversation reached the
  // board resumes it; a project pane reopens for its project.
  const reopenSession = async (s: TermSession) => {
    const label = termLabel(s, titles)
    const known = s.sessionId && boardRows.some((r) => r.sessionId === s.sessionId)
    const body: TermOpen | null = s.mode === 'resume'
      ? (s.target ? { mode: 'resume', sessionId: s.target, label } : null)
      : s.mode === 'new' && known
        ? { mode: 'resume', sessionId: s.sessionId, label }
        : s.target ? { mode: s.mode, target: s.target, label, ...(s.host === 'odin' ? { host: 'odin' as const } : {}) } : null
    if (!body) return
    await killTermSession(s.name).catch(() => {})
    if (s.projectId) await openSession({ ...body, project: s.projectId }, body)
    else await openSession(body)
  }

  // Close from the More panel: two presses, because it ends Claude on thor.
  useEffect(() => {
    if (!closeArmed) return
    const t = setTimeout(() => setCloseArmed(false), 3500)
    return () => clearTimeout(t)
  }, [closeArmed])

  const halfScreen = () => Math.max(1, Math.floor((termRef.current?.rows ?? 24) / 2))

  const title = shown ? termLabel(shown, titles) : sessions.isLoading ? 'Opening' : 'Not open'
  const pos = session ? ordered.findIndex((s) => s.name === name) + 1 : 0
  const host = shown?.host ?? 'thor'
  const modeLabel = MODE_LABEL[screen.mode]
  const showBanners = Boolean(error) || Boolean(status.data && !status.data.ok) || up.items.length > 0

  const choices = q && <Choices q={q} onPick={answer} />

  return (
    <div className="vsk vtm" data-term-root data-phase={phase} data-direct={direct || undefined}>
      {up.inputs}
      <header className="vsk-head">
        <StatusStrip onSettings={() => navigate(`${BASE}/settings`)} />
        <div className="vsk-bar">
          <Press className="vsk-back" aria-label={`Back to ${backWord}`} onPress={back}>
            <Glyph name="left" size={11} />
            <span>{backWord}</span>
          </Press>
          <Press
            className="vsk-title vtm-switch"
            aria-expanded={sheet}
            aria-label={`${title}. Open the session list`}
            onPress={() => { setSheet((v) => !v); setPicker(false); setMore(false) }}
          >
            <StateGlyph phase={phase} />
            <h1 className="vl-ellipsis">{title}</h1>
            {ordered.length > 0 && <span className="vtm-count">{pos > 0 ? `${pos}/${ordered.length}` : ordered.length}</span>}
            <ChevronDown size={13} strokeWidth={1.6} className="vl-icon vl-icon-dim vtm-chev" aria-hidden />
          </Press>
          <IconButton
            className="vtm-bar-btn"
            icon={<Camera size={16} strokeWidth={1.6} className={cx('vl-icon', up.busy ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />}
            label="Take a photo or video for thor"
            onPress={() => up.openCamera(name)}
          />
          <IconButton
            className="vtm-bar-btn"
            icon={<ImageUp size={16} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />}
            label="Send photos or videos to thor"
            onPress={() => up.openFiles(name)}
          />
          <span className="vtm-dot" data-conn={conn} title={CONN_WORD[conn]} aria-label={`Connection: ${CONN_WORD[conn]}`} role="img" />
        </div>
        <div className="vl-nav-line vsk-line" />
      </header>

      <div className="vsk-body">
        {/* The stage: the only box whose size varies, and everything over the
            terminal is absolute inside it, so opening a sheet or a question
            costs no refit and no tmux repaint. */}
        <div className="vsk-termbox" data-term-stage>
          <div
            ref={hostRef}
            className="vsk-term"
            data-term-host
            onClick={() => { if (!coarse || directRef.current) termRef.current?.focus() }}
          />
          {/* The height reference the geometry measures: fixed, invisible, 100dvh. */}
          <div ref={probeRef} aria-hidden className="vtm-probe" />

          {gone && (
            <div className="vtm-panel-wrap">
              <section className="vtm-panel">
                <header className="vtm-panel-k">Not open</header>
                <p>This session is not running any more. It ended, or it was closed somewhere else.</p>
                <div className="vtm-panel-acts">
                  <Button kind="line" onPress={() => navigate(backTo, { replace: true })}>{backWord}</Button>
                  <Button kind="line" onPress={() => setSheet(true)}>Open sessions</Button>
                </div>
              </section>
            </div>
          )}

          {session?.dead && (
            <div className="vtm-panel-wrap">
              <section className="vtm-panel" data-tone="alert">
                <header className="vtm-panel-k">Session ended</header>
                <p>
                  {session.deadStatus === 255
                    ? `The SSH connection to ${session.host} failed, so this session is not running.`
                    : session.deadStatus !== null
                      ? `The session on ${session.host} exited with status ${session.deadStatus}.`
                      : `The session on ${session.host} exited.`}
                </p>
                {session.deadText && <pre className="vtm-panel-pre">{session.deadText}</pre>}
                <div className="vtm-panel-acts">
                  <Button kind="line" icon="refresh" disabled={busy} onPress={() => void reopenSession(session)}>Reopen</Button>
                  <Button kind="line" icon="stop" onPress={() => void closeSession(session.name)}>Close</Button>
                </div>
              </section>
            </div>
          )}

          {showBanners && (
            <div className="vtm-banners">
              {error && <Press className="vtm-banner" data-tone="alert" title="Dismiss" onPress={() => setError(null)}>{error}</Press>}
              {status.data && !status.data.ok && (
                <div className="vtm-banner" data-tone="alert">{!status.data.tmux ? 'tmux is not installed on odin.' : 'ssh is not installed on odin.'}</div>
              )}
              {up.items.map((i) => (
                <Press key={i.key} className="vtm-banner" data-tone={i.state === 'err' ? 'alert' : i.state === 'done' ? 'ok' : undefined} title="Dismiss" onPress={() => up.dismiss(i.key)}>
                  {i.state === 'done' ? `On thor: ${i.path}` : `To thor ${uploadLine(i)}`}
                </Press>
              ))}
            </div>
          )}

          {/* the question, as plates over the bottom of the screen where the CLI draws it (phone) */}
          {!wide && choices && <div className="vtm-askdock">{choices}</div>}

          {sheet && (
            <div className="vtm-sheet" data-term-scroll role="dialog" aria-label="Open sessions">
              <div className="vtm-sheet-head">
                <span>Open sessions</span>
                <IconButton icon={<X size={16} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />} label="Close the list" onPress={() => setSheet(false)} />
              </div>
              {ordered.length === 0 && <p className="vtm-empty">Nothing open. Start one below.</p>}
              <ul className="vtm-rows">
                {ordered.map((s) => {
                  const on = s.name === name
                  const label = termLabel(s, titles)
                  return (
                    <li key={s.name} className="vtm-row" data-on={on || undefined}>
                      <Press className="vtm-row-main" onPress={() => { setSheet(false); if (!on) go(s.name) }}>
                        <Icon name={hostIcon(s.host)} size={13} tone={on ? 'fg' : 'dim'} glow={on} />
                        <span className="vtm-row-t vl-ellipsis">{label}</span>
                        <span className="vtm-row-s" data-dead={s.dead || undefined}>
                          {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                          {s.activityAt ? ` · ${relative(s.activityAt)}` : ''}
                          {on ? ' · here' : ''}
                        </span>
                      </Press>
                      <Press className="vtm-row-x" aria-label={`Close ${label}`} onPress={() => void closeSession(s.name)}>
                        <Glyph name="close" size={11} />
                      </Press>
                    </li>
                  )
                })}
              </ul>
              <Button kind="line" icon="add" className="vtm-sheet-new" onPress={() => { setSheet(false); setPicker(true) }}>New session</Button>
            </div>
          )}

          {picker && (
            <div className="vtm-sheet" data-term-scroll role="dialog" aria-label="New session">
              <div className="vtm-sheet-head">
                <span>New session</span>
                <IconButton icon={<X size={16} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />} label="Close" onPress={() => setPicker(false)} />
              </div>
              <div className="vtm-pick">
                <div className="vtm-pick-k">Claude on thor in</div>
                <div className="vtm-pick-row">
                  {phoneTargets.map((t) => (
                    <Button key={t.key} kind="line" icon="newSession" disabled={busy} onPress={() => void openSession({ mode: 'new', target: t.key, label: t.label })}>{t.label}</Button>
                  ))}
                  {targets.isSuccess && phoneTargets.length === 0 && <p className="vtm-empty">thor offers no phone targets.</p>}
                </div>
                <div className="vtm-pick-k">PowerShell on thor in</div>
                <div className="vtm-pick-row">
                  {phoneTargets.map((t) => (
                    <Button key={t.key} kind="line" icon="ai" disabled={busy} onPress={() => void openSession({ mode: 'shell', target: t.key, label: `${t.label} sh` })}>{t.label}</Button>
                  ))}
                </div>
                <div className="vtm-pick-k">Resume a conversation from thor</div>
                {recent.isLoading && <p className="vtm-empty">Reading the board</p>}
                {recent.data && !recent.data.installed && <p className="vtm-empty">The session board answered {recent.data.status}; thor may be asleep.</p>}
                <ul className="vtm-rows">
                  {resumable.map((r) => (
                    <li key={r.sessionId} className="vtm-row">
                      <Press className="vtm-row-main" disabled={busy} onPress={() => void openSession({ mode: 'resume', sessionId: r.sessionId, label: r.title })}>
                        <span className="vtm-row-p">{r.project}</span>
                        <span className="vtm-row-t vl-ellipsis">{r.title}</span>
                        <span className="vtm-row-s">{relIso(r.lastActivityUtc)}</span>
                      </Press>
                    </li>
                  ))}
                </ul>
                {recent.data?.installed && resumable.length === 0 && (
                  <p className="vtm-empty">Nothing on the board to resume. A session open on thor has to be stopped there first.</p>
                )}
              </div>
            </div>
          )}

          {more && (
            <div className="vtm-more" role="dialog" aria-label="More">
              <div className="vtm-more-row">
                <Button kind="line" onPress={() => void doPaste()}>Paste</Button>
                <Button kind="line" onPress={() => sendKey('\\\r')}>\⏎ New line</Button>
                <Button kind="line" onPress={() => scrollBy(halfScreen())}>Page up</Button>
                <Button kind="line" onPress={() => scrollBy(-halfScreen())}>Page down</Button>
              </div>
              <div className="vtm-more-row">
                <span className="vtm-more-k">Text</span>
                <Button kind="line" aria-label="Smaller text" onPress={() => setFont((f) => Math.max(TERM_FONT_MIN, Math.round(f) - 1))}>A−</Button>
                <b className="vtm-more-v">{font}</b>
                <Button kind="line" aria-label="Larger text" onPress={() => setFont((f) => Math.min(TERM_FONT_MAX, Math.round(f) + 1))}>A+</Button>
                <Button kind="line" icon="refresh" onPress={() => { setMore(false); sock.rebuild() }}>Reconnect</Button>
              </div>
              <div className="vtm-more-row">
                <Button
                  kind="line"
                  icon="stop"
                  lit={closeArmed}
                  disabled={!session}
                  onPress={() => {
                    if (!closeArmed) { setCloseArmed(true); return }
                    setCloseArmed(false)
                    setMore(false)
                    void closeSession(name)
                  }}
                >
                  {closeArmed ? 'Press again to close' : 'Close session'}
                </Button>
                <Button kind="link" onPress={() => navigate(`/sessions/terminal?s=${encodeURIComponent(name)}&classic=1`)}>Classic terminal</Button>
              </div>
            </div>
          )}

          {cramped && (
            <div className="vtm-panel-wrap" data-solid>
              <section className="vtm-panel">
                <header className="vtm-panel-k">Not enough room</header>
                <p>Hide the keyboard, close the panel, or rotate.</p>
                <div className="vtm-panel-acts">
                  <Button kind="line" onPress={() => { (document.activeElement as HTMLElement | null)?.blur?.() }}>Hide keyboard</Button>
                </div>
              </section>
            </div>
          )}
        </div>

        <div className="vsk-comp">
          {slash.length > 0 && (
            <div className="vtm-chips">
              {slash.map((c) => (
                <Press key={c} className="vsk-chip" onPointerDown={keepFocus} onPress={() => setDraft(`${c} `)} onClick={restoreFocus}>{c}</Press>
              ))}
            </div>
          )}
          <div className="vsk-comp-row">
            <textarea
              ref={taRef}
              className="vsk-input"
              rows={1}
              value={draft}
              placeholder={q ? 'Or tell Claude instead' : shell ? 'Command' : 'Message Claude'}
              aria-label={shell ? 'Command for the shell' : 'Message Claude'}
              enterKeyHint={coarse ? 'enter' : 'send'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value
                // An armed ctrl takes the next character typed here, as it does on the grid.
                if (ctrlRef.current && v.length === draft.length + 1 && v.startsWith(draft)) {
                  disarmCtrl()
                  sendRaw(toCtrl(v.slice(-1)))
                  return
                }
                histAt.current = -1
                setDraft(v)
              }}
              onKeyDown={onTaKey}
            />
            <Press
              className="vl-btn vsk-send"
              aria-label={draft.trim() ? 'Send' : 'Enter'}
              onPointerDown={keepFocus}
              onPress={send}
              onClick={restoreFocus}
            >
              {draft.trim()
                ? <ArrowUp size={18} strokeWidth={2} className="vl-icon vl-icon-ink" aria-hidden />
                : <CornerDownLeft size={17} strokeWidth={2} className="vl-icon vl-icon-ink" aria-hidden />}
            </Press>
          </div>
        </div>

        {/* the side column on wide screens; on the phone its parts take their own rows */}
        <aside className="vsk-side">
          <div className="vsk-meta">
            <span className="vsk-m vsk-m-host" title={`Runs on ${host}`}>
              <Icon name={hostIcon(host)} size={12} tone="fg" glow={conn === 'live'} />
              <b>{host}</b>
            </span>
            <span className="vsk-m">{shell ? 'shell' : shown?.mode === 'resume' ? 'resumed' : 'claude'}</span>
            {modeLabel && <span className="vsk-m vtm-mode" data-m={screen.mode}>{modeLabel}</span>}
            {todos && todos.total > 0 && (
              <span className="vsk-m" title={todos.current ? `Next: ${todos.current}` : 'All done'}>
                <Icon name="done" size={12} tone={todos.done === todos.total ? 'fg' : 'dim'} />
                <b>{todos.done}/{todos.total}</b>
              </span>
            )}
            <span className="vsk-m vsk-m-word" data-p={phase}>{PHASE[phase].word}</span>
            <span className="vsk-m vtm-conn" data-conn={conn}>{CONN_WORD[conn]}</span>
            <IconButton
              className="vsk-replay"
              lit={more}
              icon={<MoreHorizontal size={16} strokeWidth={1.6} className={cx('vl-icon', more ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />}
              label="More: paste, page up and down, text size, reconnect, close"
              aria-expanded={more}
              onPress={() => { setMore((v) => !v); setSheet(false); setPicker(false) }}
            />
          </div>

          {wide && choices}

          <ActivityStrip acts={acts} open={actOpen} onToggle={() => setActPick(!actOpen)} />

          <div className="vsk-keys" role="toolbar" aria-label="Keys">
            {KEYS.map((k) => {
              const lit = q && ANSWER_KEYS.has(k.id) ? 'ask'
                : (k.id === 'stab' && screen.mode !== 'default') || (k.id === 'esc' && phase === 'working')
                  || (k.id === 'ctrl' && ctrlArmed) || (k.id === 'kbd' && direct) ? 'on' : undefined
              return (
                <Press
                  key={k.id}
                  className="vsk-key"
                  data-k={k.id}
                  data-lit={lit}
                  aria-label={k.aria}
                  aria-pressed={k.id === 'ctrl' ? ctrlArmed : k.id === 'kbd' ? direct : undefined}
                  onPointerDown={k.id === 'kbd' ? undefined : keepFocus}
                  onPress={() => { if (k.id !== 'kbd') onKey(k.id) }}
                  onClick={k.id === 'kbd' ? toggleDirect : restoreFocus}
                >
                  {k.id === 'kbd' ? <Keyboard size={17} strokeWidth={1.6} aria-hidden /> : <span>{k.label}</span>}
                  {k.sub && <small>{k.sub}</small>}
                </Press>
              )
            })}
          </div>
        </aside>
      </div>

      <ToastHost className="vsk-toasts" />
    </div>
  )
}
