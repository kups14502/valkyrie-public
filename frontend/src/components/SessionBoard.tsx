import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Play, Plus, RotateCcw, Square, Undo2 } from 'lucide-react'
import {
  fetchLaunchTargets, fetchSessionList, launchSessionOnThor, localHostname, openSessionHere,
  setSessionDone, startSessionOnThor, stopSessionOnThor,
  type SessionActivity, type WorkSession,
} from '../lib/api'

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

function Row({ s, remote, here, onOpen, onStop, onDone, opening, stopping, busy }: {
  s: WorkSession
  remote: boolean
  here: string | null
  onOpen: (s: WorkSession) => void
  onStop: (s: WorkSession) => void
  onDone: (s: WorkSession) => void
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
    <div className="group flex items-center gap-3 border-b border-[var(--color-border)] py-2.5 last:border-b-0">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full${s.activity === 'working' ? ' animate-pulse' : ''}`}
        style={{ background: TONE[s.activity] }}
        title={WORD[s.activity] || 'not running'}
      />

      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-sm ${s.done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}
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

      <div className="flex shrink-0 items-center gap-1">
        {!s.done && !s.live && (
          <button
            type="button"
            disabled={opening || busy}
            onClick={() => onOpen(s)}
            title={remote ? `Open a terminal here on ${here}, resuming over SSH to ${HOST}` : `Open a terminal on ${HOST}`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border)] px-3 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30"
          >
            <Play size={11} /> {opening ? 'opening…' : 'open'}
          </button>
        )}
        {s.live && (
          <button
            type="button"
            disabled={stopping || busy}
            onClick={() => onStop(s)}
            title={`Stop it on ${HOST}. The transcript is kept, so it reopens anywhere.`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
          >
            <Square size={11} /> {stopping ? 'stopping…' : 'stop'}
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
          className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30"
        >
          {s.done ? <><Undo2 size={12} /> undo</> : <><Check size={12} /> done</>}
        </button>
      </div>
    </div>
  )
}

// Start a session on thor without remoting in first. The list comes from thor
// and the click sends back only a key, so the page never names a directory.
function NewSession({ onStarted }: { onStarted: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const targets = useQuery({ queryKey: ['launchTargets'], queryFn: fetchLaunchTargets, staleTime: 60_000 })
  const list = (targets.data ?? []).filter((t) => t.exists)

  // Click-away, so the menu does not sit open over the list.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (list.length === 0) return null

  const start = async (key: string) => {
    setBusy(key); setErr(null)
    try {
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
              onClick={() => void start(t.key)}
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

export function SessionBoard() {
  const qc = useQueryClient()
  const [here, setHere] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [recovering, setRecovering] = useState(false)
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

  const open = useMutation({
    mutationFn: (s: WorkSession) =>
      remote ? openSessionHere(s.sessionId, HOST_IP) : launchSessionOnThor(s.sessionId, '').then(() => undefined),
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
      // The desk is what was open on thor recently, so recovering it after a
      // reboot is one action rather than a click per row. Already-running and
      // finished sessions are excluded, so pressing it twice does nothing.
      desk: all.filter((s) => s.onDesk && !s.live && !s.done),
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
    for (const s of desk) {
      setOpeningId(s.sessionId)
      try {
        if (remote) await openSessionHere(s.sessionId, HOST_IP)
        else await launchSessionOnThor(s.sessionId, '')
      } catch { /* one failure must not abandon the rest */ }
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
    remote, here, busy,
    onOpen: (s: WorkSession) => { setOpeningId(s.sessionId); open.mutate(s) },
    onStop: (s: WorkSession) => { setStoppingId(s.sessionId); stop.mutate(s) },
    onDone: (s: WorkSession) => done.mutate(s),
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {live.length > 0 ? `${live.length} running · ` : ''}{rest.length} recent
          {remote && here ? ` · opening on ${here}` : ''}
        </div>
        <div className="flex items-center gap-2">
        <NewSession onStarted={refresh} />
        {desk.length > 0 && (
          <button
            type="button"
            disabled={recovering || openingId !== null}
            onClick={() => void recoverDesk()}
            title={`Reopen the ${desk.length} session(s) that were open on ${HOST} and are not running now`}
            className="inline-flex min-h-9 items-center gap-2 border border-[var(--color-accent)] px-3 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
          >
            <RotateCcw size={12} /> {recovering ? 'recovering…' : `recover my desk (${desk.length})`}
          </button>
        )}
        </div>
      </div>

      {live.map((s) => (
        <Row key={s.sessionId} s={s} {...rowProps}
          opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
      ))}
      {live.length > 0 && rest.length > 0 && <div className="h-3" />}
      {shown.map((s) => (
        <Row key={s.sessionId} s={s} {...rowProps}
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
            <Row key={s.sessionId} s={s} {...rowProps}
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
