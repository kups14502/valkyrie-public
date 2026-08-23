import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pause, Pencil, Play } from 'lucide-react'
import {
  fetchThreads, setThreadDisposition, setThreadLabel,
  type ThreadDisposition, type WorkThread,
} from '../lib/api'

// A thread is the folder plus every session that ran in it. The session list
// answers "what exists"; this answers the three questions it cannot:
//
//   what was I working on   -> threads by last activity
//   what is still open      -> active, whether or not a process is running
//   what is done            -> done, hidden, and never reopened
//
// The distinction the session list can never make is that "closed" is a fact
// about a process while "done" is a decision. Only Brendon can supply the
// second, so disposition is stored rather than inferred.

const relAge = (iso: string | null): string => {
  if (!iso) return '?'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '?'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

const DISP_TONE: Record<ThreadDisposition, string> = {
  active: 'var(--color-success)',
  parked: 'var(--color-warning)',
  done: 'var(--color-text-faint)',
}

function DispositionButton({
  current, target, icon, label, onPick, busy,
}: {
  current: ThreadDisposition
  target: ThreadDisposition
  icon: React.ReactNode
  label: string
  onPick: (d: ThreadDisposition) => void
  busy: boolean
}) {
  const on = current === target
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onPick(target)}
      title={label}
      className="inline-flex min-h-9 items-center gap-1.5 border px-2.5 text-[10px] uppercase tracking-[0.14em] transition disabled:opacity-40"
      style={{
        borderColor: on ? DISP_TONE[target] : 'var(--color-border)',
        color: on ? DISP_TONE[target] : 'var(--color-text-faint)',
      }}
    >
      {icon} {target}
    </button>
  )
}

function ThreadRow({ t, busy, onDisposition, onLabel }: {
  t: WorkThread
  busy: boolean
  onDisposition: (id: string, d: ThreadDisposition) => void
  onLabel: (id: string, label: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(t.label)

  return (
    <div
      className="border border-dashed p-3"
      style={{ borderColor: t.disposition === 'done' ? 'var(--color-border)' : DISP_TONE[t.disposition] + '55' }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
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
                className="min-w-0 border border-[var(--color-accent)] bg-transparent px-2 py-1 text-sm text-[var(--color-text)] outline-none"
              />
              <button type="submit" className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">save</button>
            </form>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--color-text)]">{t.label}</span>
              <button
                type="button"
                onClick={() => { setDraft(t.userLabelled ? t.label : ''); setEditing(true) }}
                title="Rename this thread"
                className="text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
              >
                <Pencil size={11} />
              </button>
              {t.redacted && !t.userLabelled && (
                <span
                  className="border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
                  style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
                  title="Client work. Only the business root is published, so name it yourself if you want it recognizable here."
                >
                  unnamed client
                </span>
              )}
            </div>
          )}
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            {t.threadId} · {t.sessions} {t.sessions === 1 ? 'session' : 'sessions'} · {relAge(t.lastActivityUtc)} ago
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <DispositionButton current={t.disposition} target="active" icon={<Play size={10} />} label="Work in progress. Restore reopens it." onPick={(d) => onDisposition(t.threadId, d)} busy={busy} />
          <DispositionButton current={t.disposition} target="parked" icon={<Pause size={10} />} label="Stopped on purpose, coming back. Restore skips it." onPick={(d) => onDisposition(t.threadId, d)} busy={busy} />
          <DispositionButton current={t.disposition} target="done" icon={<Check size={10} />} label="Finished. Hidden, never reopened." onPick={(d) => onDisposition(t.threadId, d)} busy={busy} />
        </div>
      </div>
    </div>
  )
}

export function ThreadBoard() {
  const qc = useQueryClient()
  const [showDone, setShowDone] = useState(false)
  const q = useQuery({ queryKey: ['threads'], queryFn: fetchThreads })

  const disposition = useMutation({
    mutationFn: ({ id, d }: { id: string; d: ThreadDisposition }) => setThreadDisposition(id, d),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['threads'] }),
  })
  const label = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => setThreadLabel(id, text),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['threads'] }),
  })

  const groups = useMemo(() => {
    const threads = q.data?.installed ? q.data.threads : []
    const by = (d: ThreadDisposition) =>
      threads.filter((t) => t.disposition === d)
        .sort((a, b) => Date.parse(b.lastActivityUtc ?? '0') - Date.parse(a.lastActivityUtc ?? '0'))
    return { active: by('active'), parked: by('parked'), done: by('done') }
  }, [q.data])

  if (q.isLoading) {
    return <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">reading threads…</div>
  }
  if (q.data && !q.data.installed) {
    return (
      <div className="border border-dashed border-[var(--color-warning)]/60 p-3 text-[11px] text-[var(--color-warning)]">
        Threads unavailable: /api/hosts/thor/threads answered {q.data.status}.
        {q.data.detail ? ` ${q.data.detail}` : ''}
      </div>
    )
  }
  if (q.isError) {
    return (
      <div className="border border-dashed border-[var(--color-danger)]/60 p-3 text-[11px] text-[var(--color-danger)]">
        Could not read threads. {(q.error as Error)?.message}
      </div>
    )
  }

  const busy = disposition.isPending || label.isPending
  const onDisp = (id: string, d: ThreadDisposition) => disposition.mutate({ id, d })
  const onLabel = (id: string, text: string) => { if (text) label.mutate({ id, text }) }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-dim)]">
          {groups.active.length} active · {groups.parked.length} parked · {groups.done.length} done
        </div>
        <button
          type="button"
          onClick={() => setShowDone((v) => !v)}
          className="inline-flex min-h-9 items-center border border-[var(--color-border)] px-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {showDone ? 'hide done' : `show done (${groups.done.length})`}
        </button>
      </div>

      {groups.active.length === 0 && groups.parked.length === 0 && (
        <div className="border border-dashed border-[var(--color-border)] p-3 text-[11px] text-[var(--color-text-faint)]">
          Nothing active. Every thread is done, which is either a clean desk or a reset that went too far.
        </div>
      )}

      {groups.active.map((t) => <ThreadRow key={t.threadId} t={t} busy={busy} onDisposition={onDisp} onLabel={onLabel} />)}

      {groups.parked.length > 0 && (
        <div className="pt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">parked</div>
      )}
      {groups.parked.map((t) => <ThreadRow key={t.threadId} t={t} busy={busy} onDisposition={onDisp} onLabel={onLabel} />)}

      {showDone && (
        <>
          <div className="pt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">done</div>
          {groups.done.map((t) => <ThreadRow key={t.threadId} t={t} busy={busy} onDisposition={onDisp} onLabel={onLabel} />)}
        </>
      )}

      {(disposition.isError || label.isError) && (
        <div className="text-[11px] text-[var(--color-danger)]">
          That change did not stick. {((disposition.error ?? label.error) as Error)?.message}
        </div>
      )}
    </div>
  )
}
