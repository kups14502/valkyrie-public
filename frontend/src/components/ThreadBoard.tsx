import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Pencil, Play, RotateCcw, Undo2 } from 'lucide-react'
import {
  fetchThreads, launchSessionOnThor, setThreadDisposition, setThreadLabel,
  type ThreadDisposition, type WorkThread,
} from '../lib/api'

// What am I working on, get me back into it, and let me say when it's finished.
// Those three things are the whole page. Everything else (455 sessions, host
// health, filters) is detail that belongs below the fold, because it never once
// answered the question actually being asked.

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

function ThreadRow({ t, onOpen, onDone, onLabel, opening, busy }: {
  t: WorkThread
  onOpen: (t: WorkThread) => void
  onDone: (t: WorkThread, d: ThreadDisposition) => void
  onLabel: (id: string, label: string) => void
  opening: boolean
  busy: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(t.label)
  const [copied, setCopied] = useState(false)
  const done = t.disposition === 'done'

  const copyResume = async () => {
    if (!t.latestSessionId) return
    try {
      await navigator.clipboard.writeText(`claude -r ${t.latestSessionId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked; the button just does nothing */ }
  }

  return (
    <div className="group flex items-center gap-3 border-b border-[var(--color-border)] py-3 last:border-b-0">
      {/* A live thread is already open. Saying so up front stops the main
          button from promising something it will refuse to do. */}
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: t.live ? 'var(--color-success)' : 'var(--color-border)' }}
        title={t.live ? 'running now' : 'not running'}
      />

      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            onSubmit={(e) => { e.preventDefault(); onLabel(t.threadId, draft.trim()); setEditing(false) }}
            className="flex items-center gap-2"
          >
            <input
              autoFocus
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              className="min-w-0 flex-1 border-b border-[var(--color-accent)] bg-transparent pb-0.5 text-sm text-[var(--color-text)] outline-none"
            />
          </form>
        ) : (
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate text-sm ${done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}
              title={t.label}
            >
              {t.label}
            </span>
            <button
              type="button"
              onClick={() => { setDraft(t.userLabelled ? t.label : ''); setEditing(true) }}
              title="Rename"
              className="shrink-0 text-[var(--color-text-faint)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-accent)]"
            >
              <Pencil size={11} />
            </button>
          </div>
        )}
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
          {t.path}{t.lastActivityUtc ? ` · ${relAge(t.lastActivityUtc)}` : ''}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!done && (
          <button
            type="button"
            disabled={opening || busy || t.live || !t.latestSessionId}
            onClick={() => onOpen(t)}
            title={t.live ? 'Already running on thor' : 'Reopen the newest session of this thread on thor'}
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border)] px-3 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:border-[var(--color-border)] disabled:hover:text-[var(--color-text-dim)]"
          >
            <Play size={11} /> {t.live ? 'running' : opening ? 'opening…' : 'open'}
          </button>
        )}
        <button
          type="button"
          onClick={copyResume}
          title="Copy the resume command"
          className="inline-flex min-h-9 items-center border border-transparent px-2 text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(t, done ? 'active' : 'done')}
          title={done ? 'Put it back on the board' : 'Finished. Hides it, and restore will not reopen it.'}
          className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30"
        >
          {done ? <><Undo2 size={12} /> undo</> : <><Check size={12} /> done</>}
        </button>
      </div>
    </div>
  )
}

export function ThreadBoard() {
  const qc = useQueryClient()
  const [showDone, setShowDone] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  // Poll. Whether a thread is running changes the moment a terminal closes, and
  // this list froze at page load: a stale live=true kept saying "running" and
  // left the open button disabled, so a session you had just closed could not
  // be reopened. Cheap to ask, and thor answers in about a second.
  const q = useQuery({
    queryKey: ['threads'],
    queryFn: fetchThreads,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['threads'] })
    void qc.invalidateQueries({ queryKey: ['workspaces'] })
  }

  const disposition = useMutation({
    mutationFn: ({ id, d }: { id: string; d: ThreadDisposition }) => setThreadDisposition(id, d),
    onSuccess: refresh,
  })
  const label = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => setThreadLabel(id, text),
    onSuccess: refresh,
  })
  const open = useMutation({
    mutationFn: (t: WorkThread) => launchSessionOnThor(t.latestSessionId!, ''),
    onSettled: () => { setOpeningId(null); refresh() },
  })

  const { active, done } = useMemo(() => {
    const all = q.data?.installed ? q.data.threads : []
    const byAge = (a: WorkThread, b: WorkThread) =>
      Date.parse(b.lastActivityUtc ?? '0') - Date.parse(a.lastActivityUtc ?? '0')
    // Parked is folded in with active: the distinction earns its keep in the
    // data (restore skips parked) but not in a list of four rows.
    return {
      active: all.filter((t) => t.disposition !== 'done').sort(byAge),
      done: all.filter((t) => t.disposition === 'done').sort(byAge),
    }
  }, [q.data])

  if (q.isLoading) return <div className="py-2 text-[11px] text-[var(--color-text-faint)]">loading…</div>

  if (q.data && !q.data.installed) {
    return (
      <div className="py-2 text-[11px] text-[var(--color-warning)]">
        Threads unavailable ({q.data.status}). {q.data.detail ?? ''}
      </div>
    )
  }
  if (q.isError) {
    return <div className="py-2 text-[11px] text-[var(--color-danger)]">{(q.error as Error)?.message}</div>
  }

  const busy = disposition.isPending || label.isPending
  const closable = active.filter((t) => !t.live && t.latestSessionId)

  const onOpen = (t: WorkThread) => { setOpeningId(t.threadId); open.mutate(t) }
  const openAll = async () => {
    for (const t of closable) {
      setOpeningId(t.threadId)
      try { await launchSessionOnThor(t.latestSessionId!, '') } catch { /* keep going */ }
    }
    setOpeningId(null)
    refresh()
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {active.length === 0 ? 'nothing open' : `${active.length} open · ${active.filter((t) => t.live).length} running`}
        </div>
        {closable.length > 0 && (
          <button
            type="button"
            disabled={openingId !== null}
            onClick={() => void openAll()}
            className="inline-flex min-h-9 items-center gap-2 border border-[var(--color-accent)] px-3 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
          >
            <RotateCcw size={12} /> reopen {closable.length}
          </button>
        )}
      </div>

      {active.length === 0 && (
        <div className="py-3 text-[11px] text-[var(--color-text-faint)]">
          Everything is marked done. Undo one below to bring it back.
        </div>
      )}

      {active.map((t) => (
        <ThreadRow
          key={t.threadId} t={t} onOpen={onOpen} opening={openingId === t.threadId} busy={busy}
          onDone={(th, d) => disposition.mutate({ id: th.threadId, d })}
          onLabel={(id, text) => { if (text) label.mutate({ id, text }) }}
        />
      ))}

      {done.length > 0 && (
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className="mt-3 text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
        >
          {showDone ? 'hide' : 'show'} {done.length} done
        </button>
      )}
      {showDone && (
        <div className="mt-1 opacity-60">
          {done.map((t) => (
            <ThreadRow
              key={t.threadId} t={t} onOpen={onOpen} opening={openingId === t.threadId} busy={busy}
              onDone={(th, d) => disposition.mutate({ id: th.threadId, d })}
              onLabel={(id, text) => { if (text) label.mutate({ id, text }) }}
            />
          ))}
        </div>
      )}

      {(disposition.isError || label.isError || open.isError) && (
        <div className="mt-2 text-[11px] text-[var(--color-danger)]">
          {((disposition.error ?? label.error ?? open.error) as Error)?.message}
        </div>
      )}
    </div>
  )
}
