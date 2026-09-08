import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Play, Plus, RotateCcw, Square, SquareTerminal, Undo2, X } from 'lucide-react'
import {
  fetchLaunchTargets, fetchSessionList, fetchTermSessions, killTermSession, launchSessionOnThor, localHostname,
  openSessionHere, openTermSession, setSessionDone, startSessionOnThor, stopSessionOnThor, termPath,
  type SessionActivity, type TermSession, type WorkSession,
} from '../lib/api'
import { isTauri } from '../lib/auth'

// I open sessions on thor and recover them from anywhere. That is the whole
// feature, so this is one row per session and one button to get back into it.
//
// It replaces a "thread" view that grouped sessions by folder. Grouping existed
// to tame 455 rows, but 92% of those were the Obsidian hook's summariser runs
// (2894 of 3159 transcripts). Filtered out, only 265 are real and 14 were
// touched in the last day, so there was never anything for grouping to solve.
// Worse, a folder had to guess which session it meant and guessed wrong,
// resuming a hook run and presenting its own JSON prompt as the conversation.
// A row that IS a session cannot guess.

const HOST = 'thor'
const HOST_IP = '100.118.7.57'
const SHOWN_BY_DEFAULT = 20

const TONE: Record<SessionActivity, string> = {
  working: 'var(--color-accent)',
  asking: 'var(--color-warning)',
  idle: 'var(--color-success)',
  closed: 'var(--color-border)',
}
const WORD: Record<SessionActivity, string> = {
  working: 'working',
  asking: 'waiting on you',
  idle: 'open, idle',
  closed: '',
}

const relAge = (iso: string | null): string => {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const fmtSize = (b: number): string =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`

function Row({ s, remote, here, inPage, attachedTo, onOpen, onStop, onDone, onReattach, opening, stopping, busy }: {
  s: WorkSession
  remote: boolean
  here: string | null
  inPage: boolean
  // The in-page terminal already running this conversation, if there is one.
  attachedTo: string | null
  onOpen: (s: WorkSession) => void
  onStop: (s: WorkSession) => void
  onDone: (s: WorkSession) => void
  onReattach: (terminal: string) => void
  opening: boolean
  stopping: boolean
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!s.resumeCommand) return
    try {
      await navigator.clipboard.writeText(s.resumeCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="group flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] py-2.5 last:border-b-0">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full${s.activity === 'working' ? ' animate-pulse' : ''}`}
        style={{ background: TONE[s.activity] }}
        title={WORD[s.activity] || 'not running'}
      />

      {/* The title gets the whole first line on a phone. Four buttons on the
          same line as it left about twenty readable characters, which for a
          list whose entire job is telling one conversation from another is no
          list at all: the basis pushes them onto their own line below, and at
          sm and up the original single row comes back. */}
      <div className="min-w-0 flex-1 basis-[calc(100%-1.5rem)] sm:basis-auto">
        <div
          className={`text-sm ${s.done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'} line-clamp-2 sm:truncate`}
          title={s.cwd ?? undefined}
        >
          {s.title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
          {s.project} · {relAge(s.lastActivityUtc)} · {fmtSize(s.bytes)}
          {s.activity !== 'closed' && (
            <span style={{ color: TONE[s.activity] }}> · {WORD[s.activity]}</span>
          )}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Running in a terminal on this page: just go to it. Stopping a
            session to reopen it is what the old row forced, because a live row
            offered nothing but stop. tmux is built for exactly this, so the
            session never needed to end. */}
        {attachedTo && (
          <button
            type="button"
            onClick={() => onReattach(attachedTo)}
            title="Go to the terminal already running this session"
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.10)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-accent)] transition hover:border-[var(--color-accent)]"
          >
            <SquareTerminal size={11} /> reattach
          </button>
        )}
        {!s.done && !s.live && (
          <button
            type="button"
            disabled={opening || busy}
            onClick={() => onOpen(s)}
            title={inPage
              ? `Open it here in the page, running on ${HOST}`
              : remote ? `Open a terminal here on ${here}, resuming over SSH to ${HOST}` : `Open a terminal on ${HOST}`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30"
          >
            <Play size={11} /> {opening ? 'opening' : 'open'}
          </button>
        )}
        {s.live && (
          <button
            type="button"
            disabled={stopping || busy}
            onClick={() => onStop(s)}
            title={`Stop it on ${HOST}. The transcript is kept, so it reopens anywhere.`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
          >
            <Square size={11} /> {stopping ? 'stopping' : 'stop'}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          title={s.resumeCommand ?? 'no resume command'}
          disabled={!s.resumeCommand}
          className="inline-flex min-h-9 items-center border border-transparent px-2 text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-20"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(s)}
          title={s.done ? 'Put it back on the list' : 'Finished with this one. Hides it.'}
          className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30"
        >
          {s.done ? <><Undo2 size={12} /> undo</> : <><Check size={12} /> done</>}
        </button>
      </div>
    </div>
  )
}

// Start a session on thor without remoting in first. The list comes from thor
// and the click sends back only a key, so the page never names a directory.
//
// In a browser the session opens IN THE PAGE (Claude on thor, over SSH, see
// pages/Terminal.tsx), and only the targets thor flagged for the phone are
// offered: personal, work, work2. The desktop app keeps the full list and
// opens a Windows Terminal tab on thor's screen, as it always did.
function NewSession({ onStarted, inPage }: { onStarted: () => void; inPage: boolean }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const targets = useQuery({ queryKey: ['launchTargets'], queryFn: fetchLaunchTargets, staleTime: 60_000 })
  const list = (targets.data ?? []).filter((t) => t.exists && (!inPage || t.phone))

  // Click-away, so the menu does not sit open over the list.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (list.length === 0) return null

  const start = async (key: string, label: string) => {
    setBusy(key); setErr(null)
    try {
      if (inPage) {
        const r = await openTermSession({ mode: 'new', target: key, label })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
        return
      }
      const r = await startSessionOnThor(key)
      if (!r.ok) setErr(r.detail ?? 'could not start it')
      // Claude takes a moment to register, so give the list something to find.
      setTimeout(onStarted, 2_500)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null); setOpen(false)
    }
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
        title={`Start a new Claude session on ${HOST}`}
        className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border-strong)] px-3 text-[11px] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
      >
        <Plus size={12} /> {busy ? `starting ${busy}…` : 'new session'} <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-44 border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 shadow-lg">
          {list.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => void start(t.key, t.label)}
              className="block w-full px-3 py-2 text-left text-[11px] text-[var(--color-text-dim)] transition hover:bg-[rgba(var(--color-accent-rgb),0.1)] hover:text-[var(--color-accent)]"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {err && <div className="absolute right-0 mt-1 text-[11px] text-[var(--color-danger)]">{err}</div>}
    </div>
  )
}

// Put the session we just created into the terminal page's cache BEFORE
// navigating to it.
//
// Without this the handoff picks the wrong session. OpenTerminals below keeps
// ['term','sessions'] warm, so the terminal page mounts, renders that cached
// list synchronously (and, inside the 10s global staleTime, may not refetch at
// all), fails to find the brand-new name from ?s= in it, and falls back to the
// old list's first row: the phone ends up attached to the previous session
// while the one just launched sits unselected. POST /terminal/sessions already
// returns the row, so seeding is exact; if it somehow came back without one,
// invalidating makes the page refetch and its own guard covers the gap.
function seedTerminal(qc: QueryClient, r: { name: string; session: TermSession | null }): void {
  if (!r.session) {
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    return
  }
  const fresh = r.session
  qc.setQueryData<TermSession[]>(['term', 'sessions'], (old) => [fresh, ...(old ?? []).filter((s) => s.name !== fresh.name)])
}

// Terminals already open in the page: tmux sessions on odin, each an SSH client
// running Claude (or a shell) on thor. A tap reattaches; the X closes it, which
// ends the Claude process on thor and leaves the conversation resumable. Hidden
// when there are none, so a desk with no phone terminals never sees the row.
function OpenTerminals() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [killing, setKilling] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: 15_000 })
  const list = q.data ?? []
  if (list.length === 0) return null

  const kill = async (s: TermSession) => {
    setKilling(s.name)
    try { await killTermSession(s.name) } catch { /* the refresh below shows whether it went */ }
    setKilling(null)
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  return (
    <div className="mb-2 flex items-center gap-2 overflow-x-auto border-b border-[var(--color-border)] pb-2">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">in page</span>
      {list.map((s) => (
        <div
          key={s.name}
          className={`flex shrink-0 items-center border ${s.dead ? 'border-[var(--color-danger)]/50' : 'border-[var(--color-border)]'}`}
        >
          <button
            type="button"
            onClick={() => navigate(termPath(s.name))}
            title={`Reattach to ${s.label} on ${s.host}`}
            className="flex min-h-9 items-center gap-1.5 px-2.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
          >
            <SquareTerminal size={11} />
            {s.label}
            <span className={`text-[9px] uppercase tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
              {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
              {s.activityAt > 0 ? ` · ${relAge(new Date(s.activityAt).toISOString())}` : ''}
            </span>
          </button>
          <button
            type="button"
            disabled={killing === s.name}
            onClick={() => void kill(s)}
            aria-label={`Close ${s.label}`}
            title="Close this terminal. A Claude session ends on thor; the conversation stays resumable."
            className="min-h-9 px-1.5 text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function SessionBoard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [here, setHere] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [recoverDone, setRecoverDone] = useState(0)
  const [showDone, setShowDone] = useState(false)

  useEffect(() => { void localHostname().then(setHere) }, [])

  // Poll: whether a session is running changes the moment a terminal closes,
  // and a list frozen at page load once left a closed session reading "running"
  // with its open button disabled.
  const q = useQuery({
    queryKey: ['sessionList'],
    queryFn: fetchSessionList,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    void qc.invalidateQueries({ queryKey: ['workspaces'] })
  }

  // The SSH hop is only for reaching a DIFFERENT machine. Gating on "am I in
  // the app" made thor SSH to its own address and sit at a password prompt.
  const remote = here !== null && here !== HOST
  // A browser (the phone, above all) cannot open a local terminal and has no
  // use for a tab on thor's screen, so there "open" means the in-page terminal:
  // Claude resumes on thor over SSH and the phone is its screen.
  const inPage = !isTauri()

  const open = useMutation({
    mutationFn: async (s: WorkSession) => {
      if (inPage) {
        const r = await openTermSession({ mode: 'resume', sessionId: s.sessionId, label: s.title })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
        return
      }
      if (remote) return openSessionHere(s.sessionId, HOST_IP)
      await launchSessionOnThor(s.sessionId, '')
    },
    onSettled: () => { setOpeningId(null); refresh() },
  })
  const stop = useMutation({
    mutationFn: (s: WorkSession) => stopSessionOnThor(s.sessionId),
    onSettled: () => { setStoppingId(null); refresh() },
  })
  const done = useMutation({
    mutationFn: (s: WorkSession) => setSessionDone(s.sessionId, !s.done),
    onSuccess: refresh,
  })

  // Which conversations are already open in an in-page terminal. A resumed
  // terminal records the conversation id it was opened with, so this is an
  // exact match rather than a guess about folders. Same query key as
  // OpenTerminals, so it is one fetch shared through the cache.
  const terms = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: 15_000 })
  const attachedTerminals = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of terms.data ?? []) {
      if (t.mode === 'resume' && t.target && !t.dead) m.set(t.target, t.name)
    }
    return m
  }, [terms.data])

  const { live, rest, doneList, desk } = useMemo(() => {
    const all = q.data?.installed ? q.data.sessions : []
    return {
      live: all.filter((s) => s.live),
      // "recent" means recent AND still open. Done rows arrive in the payload
      // (undo needs them) but live in their own collapsed section: after the
      // fresh start everything finished is done, so this is what keeps the
      // default view at "what am I working on" instead of "what happened".
      rest: all.filter((s) => !s.live && !s.done),
      doneList: all.filter((s) => !s.live && s.done),
      // Everything still open and not running: reopening is one action rather
      // than a click per row. Already-running and finished sessions are
      // excluded, so pressing it twice does nothing.
      //
      // This used to also require onDesk, and that quietly crippled it. The
      // desk is a 72-hour union of what was LIVE, so with 21 sessions open the
      // button offered 4 and silently ignored the rest. Time is not what
      // decides whether Brendon still wants a session: done is. Same mistake as
      // the age window that once hid 11 sessions from the board itself.
      desk: all.filter((s) => !s.live && !s.done),
    }
  }, [q.data])

  if (q.isLoading) return <div className="py-2 text-[11px] text-[var(--color-text-faint)]">reading sessions…</div>
  if (q.data && !q.data.installed) {
    return (
      <div className="py-2 text-[11px] text-[var(--color-warning)]">
        Sessions unavailable ({q.data.status}). {q.data.detail ?? ''}
      </div>
    )
  }
  if (q.isError) return <div className="py-2 text-[11px] text-[var(--color-danger)]">{(q.error as Error)?.message}</div>

  // Serial, with the same pause the launcher uses: Windows Terminal drops tabs
  // when several arrive at once.
  const recoverDesk = async () => {
    setRecovering(true)
    setRecoverDone(0)
    // 21 sessions is a long silence with no counter, and the earlier version
    // gave none: it just sat on "recovering…" for half a minute.
    for (const s of desk) {
      setOpeningId(s.sessionId)
      try {
        if (remote) await openSessionHere(s.sessionId, HOST_IP)
        else await launchSessionOnThor(s.sessionId, '')
      } catch { /* one failure must not abandon the rest */ }
      setRecoverDone((n) => n + 1)
      await new Promise((r) => setTimeout(r, 700))
    }
    setOpeningId(null)
    setRecovering(false)
    refresh()
  }

  const busy = done.isPending
  const shown = showAll ? rest : rest.slice(0, SHOWN_BY_DEFAULT)
  const hidden = rest.length - shown.length
  const rowProps = {
    remote, here, inPage, busy,
    onReattach: (terminal: string) => navigate(termPath(terminal)),
    onOpen: (s: WorkSession) => { setOpeningId(s.sessionId); open.mutate(s) },
    onStop: (s: WorkSession) => { setStoppingId(s.sessionId); stop.mutate(s) },
    onDone: (s: WorkSession) => done.mutate(s),
  }

  return (
    <div>
      <OpenTerminals />
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {live.length > 0 ? `${live.length} running · ` : ''}{rest.length} recent
          {inPage ? ' · opens in the page' : remote && here ? ` · opening on ${here}` : ''}
        </div>
        <div className="flex items-center gap-2">
        <NewSession onStarted={refresh} inPage={inPage} />
        {desk.length > 0 && (
          <button
            type="button"
            disabled={recovering || openingId !== null}
            onClick={() => void recoverDesk()}
            title={`Reopen the ${desk.length} session(s) still open and not running. Marking one done is what takes it off this list.`}
            className="inline-flex min-h-9 items-center gap-2 border border-[var(--color-accent)] px-3 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
          >
            <RotateCcw size={12} /> {recovering ? `recovering ${recoverDone}/${desk.length}…` : `recover my desk (${desk.length})`}
          </button>
        )}
        </div>
      </div>

      {live.map((s) => (
        <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
          opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
      ))}
      {live.length > 0 && rest.length > 0 && <div className="h-3" />}
      {shown.map((s) => (
        <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
          opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
      ))}

      {live.length === 0 && rest.length === 0 && (
        <div className="py-3 text-[11px] text-[var(--color-text-faint)]">
          Nothing open. Finished sessions are under done, and a new one appears here the moment you start it.
        </div>
      )}

      <div className="mt-3 flex items-center gap-4">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
          >
            show {hidden} older
          </button>
        )}
        {doneList.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
          >
            {showDone ? 'hide done' : `show ${doneList.length} done`}
          </button>
        )}
      </div>
      {showDone && (
        <div className="mt-1 opacity-60">
          {doneList.map((s) => (
            <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
              opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
          ))}
        </div>
      )}

      {(open.isError || stop.isError || done.isError) && (
        <div className="mt-2 text-[11px] text-[var(--color-danger)]">
          {((open.error ?? stop.error ?? done.error) as Error)?.message}
        </div>
      )}
    </div>
  )
}
