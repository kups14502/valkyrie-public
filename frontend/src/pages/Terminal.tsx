import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Camera, ChevronDown, ChevronLeft, ChevronUp,
  CornerDownLeft, ImageUp, Keyboard, MoreHorizontal, Plus, RotateCw, Terminal as TerminalIcon, X,
} from 'lucide-react'
import {
  PROJECT_BACK_RE, fetchLaunchTargets, fetchSessionList, fetchTermSessions, fetchTermStatus,
  killTermSession, openTermSession, termLabel, type TermOpen, type TermOpenResult, type TermSession,
} from '../lib/api'
import { errText, readTermTheme as readTheme, relIso, relative, toCtrl } from '../lib/term'
import {
  TERM_FONT_MAX, TERM_FONT_MIN, isCramped, readTermFont, useTermScrollInput, useTermSocket, useTermViewport,
} from '../lib/termSession'
import { readText as readClipboard } from '../lib/clipboard'
import { useProfile } from '../lib/deviceMode'
import { PasteSheet } from '../components/PasteSheet'
import { uploadLine, useThorUpload } from '../lib/useThorUpload'

// Claude Code on thor, from the phone. The session is Claude running on thor in
// one of Brendon's own directories (personal and work), reached over
// SSH from a tmux session on odin, so this page is only a screen and a keyboard
// for it: closing the tab, locking the phone, or deploying the API all just
// detach, and coming back reattaches to the same running session. It lives
// under the Sessions tab at /sessions/terminal: the board is where a session is
// picked, this is where it is typed into.
//
// The socket, the watchdog, the fit, the keyboard geometry and swipe scrolling
// live in lib/termSession.ts, shared with the v2 terminal (v2/screens/Term.tsx).
// That file carries the reasons behind each of them; the one promise they all
// keep is that the terminal DOES NOT MOVE.

// Stable identity, so the auto-select effect stops re-running on every render
// while the query is still undefined.
const EMPTY: TermSession[] = []

// wsUrl, readTheme, toCtrl, relative, relIso and errText live in lib/term.ts,
// shared with the VR workspace (pages/Vr.tsx).

const KEY = 'inline-flex min-h-10 items-center justify-center gap-1 border border-[var(--color-border)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.12)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

const BTN = 'inline-flex min-h-9 items-center justify-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

export default function TerminalPage() {
  const qc = useQueryClient()

  const hostRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const ctrlRef = useRef(false)

  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // ?s= is how the board hands a session over, and it is kept current so a
  // reload (or a home-screen relaunch) lands back on the same one.
  const [active, setActive] = useState<string | null>(() => {
    const s = params.get('s')
    return s && /^vk-[0-9a-f]{10}$/.test(s) ? s : null
  })
  // Where the back buttons lead. A project hands the phone over with ?back= so
  // its sessions return to it; read once, because effect G rewrites the query.
  const [back] = useState(() => {
    const b = params.get('back')
    return b && PROJECT_BACK_RE.test(b) ? b : '/sessions'
  })
  const backLabel = back === '/sessions' ? 'Back to the session board' : 'Back to the project'
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [font, setFont] = useState(() => readTermFont())
  const [picker, setPicker] = useState(false)
  // The phone's session list. It is a sheet rather than a row because a row
  // cannot hold it: measured at 375px, one chip carrying a real conversation
  // title is 362px wide and the strip has 257px left after the back and new
  // buttons, so even ONE session overflowed and every switch became a
  // sideways drag on a 36px-tall scroller.
  const [sheet, setSheet] = useState(false)
  const [paste, setPaste] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cramped, setCramped] = useState(false)

  // The key row replaces keys a software keyboard does not have. A desktop
  // already has them all, so there it is only clutter and stolen height: hide
  // it and give the rows to the terminal. The pad and VR profiles keep it,
  // because a finger and a laser pointer have the same problem a thumb does.
  const showKeys = useProfile().resolved !== 'desktop'

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
  // Also the source of the chip titles below, which is why it is no longer
  // gated on the picker being open.
  const recent = useQuery({
    queryKey: ['sessionList'],
    queryFn: fetchSessionList,
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
  const boardRows = useMemo(() => (recent.data?.installed ? recent.data.sessions : []), [recent.data])
  const resumable = boardRows.filter((s) => !s.live && !s.done).slice(0, 40)
  // What the board calls each conversation. A chip opened on a target was
  // labelled with the target key for the life of the terminal, so a session
  // only ever showed its real title after being closed and reopened.
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of boardRows) if (s.title) m.set(s.sessionId, s.title)
    return m
  }, [boardRows])

  const list = sessions.data ?? EMPTY

  // What the switcher, the sheet and the chips are drawn from. The server sorts
  // by last activity (backend/src/terminal/tmux.ts), which is right for landing
  // on the newest session and wrong for a list you pick from: a terminal that
  // printed a line jumps to the front, so the row under your thumb is not the
  // one you meant and "2/5" changes while you are reading it. Oldest first is
  // stable for as long as a session exists. `list` keeps the server's order,
  // because effect F lands on list[0] and that must stay the most recent one.
  const ordered = useMemo(() => [...list].sort((a, b) => a.createdAt - b.createdAt), [list])

  // One terminal + one socket per selected session (lib/termSession.ts). The
  // armed ctrl key folds the next keystroke down into its control code.
  const sock = useTermSocket({
    hostRef,
    name: active,
    font,
    options: () => ({ theme: readTheme() }),
    mapInput: (d) => {
      if (!ctrlRef.current) return d
      ctrlRef.current = false
      setCtrlArmed(false)
      return toCtrl(d)
    },
    onOpened: (term) => term.focus(),
  })
  const { termRef, conn, safeFit, scrollBy, leaveScroll } = sock

  // The geometry controller and the only fit trigger, then swipe and wheel.
  useTermViewport(hostRef, probeRef, (h) => {
    setCramped(isCramped(h))
    safeFit()
  })
  useTermScrollInput(hostRef, termRef, scrollBy, leaveScroll)

  const sockSend = sock.send
  const send = useCallback((d: string) => {
    sockSend(d)
    // Load-bearing: tapping a button blurs xterm's textarea, which drops the
    // iOS keyboard unless focus comes straight back.
    termRef.current?.focus()
  }, [sockSend, termRef])

  // Paste. On the tailnet the page is plain http, where navigator.clipboard
  // does not exist, so the old one-liner called .then() on undefined: the
  // button threw inside its own handler and did nothing at all, with no banner
  // to say so. Read the clipboard where the browser allows it, and otherwise
  // put a field on screen and let the OS paste menu fill it.
  const doPaste = useCallback(async () => {
    const t = await readClipboard()
    if (t) { send(t); return }
    setPaste(true)
  }, [send])

  // Photos and videos to C:\Thor\uploads, then each saved path typed into the
  // prompt with no Enter, so the message about it is still Brendon's to write.
  // Only into the session the picker was opened from: the camera can take
  // longer than a switch, and a path landing in the wrong conversation is
  // worse than one that did not land. The picker can also outlast the socket
  // (iOS suspends it behind the camera), so a path that finds it closed waits
  // for the reconnect instead of being dropped.
  const activeRef = useRef(active)
  useLayoutEffect(() => { activeRef.current = active }, [active])
  const hold = sock.hold
  const up = useThorUpload<string | null>({
    clearAfterMs: 8_000,
    onDone: (done, session) => {
      if (!session || session !== activeRef.current) return
      const text = done.map((d) => d.path).join(' ') + ' '
      if (hold(text)) termRef.current?.focus()
    },
  })

  const halfScreen = useCallback(() => Math.max(1, Math.floor((termRef.current?.rows ?? 24) / 2)), [termRef])

  const focusTerm = useCallback(() => { termRef.current?.focus() }, [termRef])

  const hideKeyboard = useCallback(() => { termRef.current?.textarea?.blur() }, [termRef])

  const toggleKeyboard = useCallback(() => {
    const term = termRef.current
    const ta = term?.textarea
    if (!term || !ta) return
    if (document.activeElement === ta) ta.blur()
    else term.focus()
  }, [termRef])

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
  //    gesture leaves the terminal instead of stepping through sessions. ?back=
  //    rides along, or the first switch would strip it and a reload would
  //    return to the board instead of the project.
  useEffect(() => {
    if ((params.get('s') ?? '') === (active ?? '')) return
    setParams({ ...(active ? { s: active } : {}), ...(back !== '/sessions' ? { back } : {}) }, { replace: true })
  }, [active, back, params, setParams])

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
      await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
      setPicker(false)
      setActive(data.name)
      sock.rebuild()
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

  // Open the same thing again in place of a dead pane. The dead one is killed
  // FIRST: closeSession would clear `active` after the new one had taken it. A
  // new session whose conversation reached the board resumes that conversation;
  // one that died before Claude ever ran (a refused login) just opens again.
  // A project pane reopens for its project: without it the new pane has no
  // MCP server, and a new one is never linked to the project page.
  const reopenSession = async (s: TermSession) => {
    const label = termLabel(s, titles)
    const known = s.sessionId && boardRows.some((r) => r.sessionId === s.sessionId)
    const body: TermOpen | null = s.mode === 'resume'
      ? (s.target ? { mode: 'resume', sessionId: s.target, label } : null)
      : s.mode === 'new' && known
        ? { mode: 'resume', sessionId: s.sessionId, label }
        : s.target ? { mode: s.mode, target: s.target, label } : null
    if (!body) return
    await killTermSession(s.name).catch(() => {})
    if (s.projectId) await openSession({ ...body, project: s.projectId }, body)
    else await openSession(body)
  }

  // Which session the phone's one-line switcher is naming, and where it sits in
  // the list it is counting against. Both come off `ordered`, so the position
  // is the one the sheet shows, and a session killed from another device simply
  // stops being found and the bar falls back to "no session open".
  const activeSession = ordered.find((s) => s.name === active) ?? null
  const activeIndex = active ? ordered.findIndex((s) => s.name === active) + 1 : 0

  const dot = conn === 'live'
    ? 'var(--color-accent)'
    : conn === 'connecting'
      ? 'var(--color-accent-2)'
      : 'var(--color-text-faint)'

  const showBanners = Boolean(error) || Boolean(status.data && !status.data.ok) || up.items.length > 0

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
      {/* display:none, so they take no part in the flex layout. */}
      {up.inputs}
      {/* PHONE: one row that cannot overflow, because only one child may grow.
          The back button, the session it is showing (title, position in the
          list, and the chevron that opens the sheet), and the connection dot.
          The list itself is in the sheet below, which is drawn inside the stage
          and therefore costs the terminal no height at all. */}
      <div className="flex h-9 shrink-0 items-stretch gap-2 sm:hidden">
        <button
          type="button"
          onClick={() => navigate(back)}
          aria-label={backLabel}
          title={backLabel}
          className={`${BTN} shrink-0 px-2`}
        >
          <ChevronLeft size={13} />
        </button>
        <button
          type="button"
          onClick={() => { setSheet((v) => !v); setPicker(false) }}
          aria-expanded={sheet}
          aria-label="Open the session list"
          className={`flex min-w-0 flex-1 items-center gap-2 border px-2.5 text-left ${
            activeSession
              ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.12)]'
              : 'border-[var(--color-border)]'
          }`}
        >
          {sheet ? <ChevronUp size={12} className="shrink-0 text-[var(--color-text-faint)]" /> : <ChevronDown size={12} className="shrink-0 text-[var(--color-text-faint)]" />}
          {/* min-w-0 is load-bearing twice over: a flex item defaults to
              min-width:auto, so without it neither this span nor the button
              around it can shrink, truncate never engages, and the row pushes
              past the screen exactly the way the old strip did. */}
          <span className={`min-w-0 flex-1 truncate text-[12px] ${
            activeSession ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'
          }`}>
            {activeSession ? termLabel(activeSession, titles) : 'no session open'}
          </span>
          {ordered.length > 0 && (
            <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
              {activeIndex > 0 ? `${activeIndex}/${ordered.length}` : `${ordered.length}`}
            </span>
          )}
        </button>
        {/* Fixed width, so the session title above stays the one child that
            grows and truncates. */}
        <button
          type="button"
          onClick={() => up.openCamera(active)}
          aria-label="Take a photo or video for thor"
          title="camera to thor"
          className={`${BTN} shrink-0 px-2 ${up.busy ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]' : ''}`}
        >
          <Camera size={13} />
        </button>
        <button
          type="button"
          onClick={() => up.openFiles(active)}
          aria-label="Send photos or videos to thor"
          title="upload to thor"
          className={`${BTN} shrink-0 px-2`}
        >
          <ImageUp size={13} />
        </button>
        <div className="flex shrink-0 items-center gap-1.5 pl-0.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
        </div>
      </div>

      {/* DESKTOP: the chips, which fit here, with the label capped so one long
          title cannot push the rest off the row. */}
      <div data-term-scroll className="hidden shrink-0 items-center gap-2 overflow-x-auto pb-0.5 sm:flex">
        <button
          type="button"
          onClick={() => navigate(back)}
          aria-label={backLabel}
          title={backLabel}
          className={`${BTN} shrink-0 px-2`}
        >
          <ChevronLeft size={13} />
        </button>
        {ordered.map((s) => {
          const on = s.name === active
          const label = termLabel(s, titles)
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
                title={label}
                className="flex min-h-9 min-w-0 items-center gap-2 px-2.5 text-left"
              >
                <span
                  className={`max-w-[14rem] truncate text-[11px] ${
                    on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'
                  }`}
                >
                  {label}
                </span>
                <span className={`text-[9px] uppercase tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
                  {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                  {s.activityAt ? ` · ${relative(s.activityAt)}` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void closeSession(s.name)}
                aria-label={`Close ${label}`}
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
          {showKeys && (
            <button type="button" onClick={() => up.openCamera(active)} aria-label="Take a photo or video for thor" title="camera to thor" className={`${BTN} px-2`}>
              <Camera size={13} />
            </button>
          )}
          <button type="button" onClick={() => up.openFiles(active)} aria-label="Send photos or videos to thor" title="upload to thor" className={`${BTN} px-2`}>
            <ImageUp size={13} />
          </button>
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
              <div className="text-[10px] text-[var(--color-text-faint)]">tap the session bar above, or pick one on the board</div>
            )}
          </div>
        )}

        {/* A dead pane, said in words. All tmux leaves on screen is one raw
            "Pane is dead (status 255, <date>)" line, cut off at a phone's
            width in the middle of an empty terminal, which reads as a broken
            page rather than as a session that ended. Absolute, like everything
            else in the stage, so it costs no refit. */}
        {activeSession?.dead && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/85 p-3">
            <div className="panel w-full max-w-md space-y-2 p-3">
              <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-danger)]">
                &gt; session ended
              </div>
              <div className="text-[12px] text-[var(--color-text)]">
                {activeSession.deadStatus === 255
                  ? 'The SSH connection to thor failed, so this session is not running.'
                  : activeSession.deadStatus !== null
                    ? `The session on thor exited with status ${activeSession.deadStatus}.`
                    : 'The session on thor exited.'}
              </div>
              {activeSession.deadText && (
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-text-dim)]">
                  {activeSession.deadText}
                </pre>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reopenSession(activeSession)}
                  className={`${BTN} flex-1 disabled:opacity-40`}
                >
                  <RotateCw size={12} /> reopen
                </button>
                <button
                  type="button"
                  onClick={() => void closeSession(activeSession.name)}
                  className={`${BTN} flex-1`}
                >
                  <X size={12} /> close
                </button>
              </div>
            </div>
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
            {/* Uploads, over the terminal rather than beside it: this box is
                absolute, so a row coming and going costs no refit. Tap one to
                dismiss it; a saved one leaves by itself. */}
            {up.items.map((i) => (
              <div
                key={i.key}
                onClick={() => up.dismiss(i.key)}
                title="dismiss"
                className={`truncate border bg-[var(--color-bg)] px-3 py-2 text-[11px] ${
                  i.state === 'err'
                    ? 'border-[var(--color-danger)]/60 text-[var(--color-danger)]'
                    : i.state === 'done'
                      ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
                }`}
              >
                {i.state === 'done' ? `on thor: ${i.path}` : `to thor ${uploadLine(i)}`}
              </div>
            ))}
          </div>
        )}

        {/* The phone's session list. An absolutely positioned child of the
            stage, which is the one place on this page where something can open
            without changing a single box: no refit, no pty resize, no tmux
            repaint. Rows are 44px so a thumb cannot miss, and the close button
            is separated from the row it closes by a border rather than by
            hoping nobody fat-fingers it. */}
        {sheet && (
          <div data-term-scroll className="absolute inset-0 z-30 overflow-y-auto bg-black/90 p-1 sm:hidden">
            <div className="panel p-2">
              <div className="mb-1 flex items-baseline justify-between px-1">
                <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
                  &gt; open sessions
                </span>
                <button
                  type="button"
                  onClick={() => setSheet(false)}
                  aria-label="Close the session list"
                  className="min-h-9 px-2 text-[var(--color-text-faint)] active:text-[var(--color-accent)]"
                >
                  <X size={13} />
                </button>
              </div>

              {ordered.length === 0 && (
                <div className="px-1 py-3 text-[11px] text-[var(--color-text-faint)]">
                  nothing open. start one below.
                </div>
              )}

              {ordered.map((s) => {
                const on = s.name === active
                const label = termLabel(s, titles)
                return (
                  <div
                    key={s.name}
                    className={`flex items-stretch border-b border-[var(--color-border)] last:border-b-0 ${
                      on ? 'bg-[rgba(var(--color-accent-rgb),0.1)]' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => { setActive(s.name); setSheet(false) }}
                      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 py-1.5 text-left"
                    >
                      <span className={`truncate text-[12px] ${on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                        {label}
                      </span>
                      <span className={`text-[9px] uppercase tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
                        {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                        {s.activityAt ? ` \u00b7 ${relative(s.activityAt)}` : ''}
                        {on ? ' \u00b7 open here' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void closeSession(s.name)}
                      aria-label={`Close ${label}`}
                      className="flex min-h-11 w-11 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-faint)] active:text-[var(--color-danger)]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              })}

              <button
                type="button"
                onClick={() => { setSheet(false); setPicker(true) }}
                className={`${BTN} mt-2 w-full`}
              >
                <Plus size={12} /> new session
              </button>
            </div>
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

        {paste && (
          <PasteSheet
            onSend={(t) => send(t)}
            onClose={() => { setPaste(false); focusTerm() }}
          />
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
      {showKeys && (
      <div className="flex shrink-0 flex-col gap-1.5">
        {more && (
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] pb-1.5">
            <button
              type="button"
              onClick={() => { void doPaste() }}
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
              <button type="button" onClick={() => setFont((f) => Math.max(TERM_FONT_MIN, f - 1))} className={BTN}>a-</button>
              <span className="min-w-6 text-center text-[10px] text-[var(--color-text-faint)]">{font}</span>
              <button type="button" onClick={() => setFont((f) => Math.min(TERM_FONT_MAX, f + 1))} className={BTN}>a+</button>
              <button type="button" onClick={sock.rebuild} className={BTN} aria-label="Reconnect">
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
      )}
    </div>
  )
}
