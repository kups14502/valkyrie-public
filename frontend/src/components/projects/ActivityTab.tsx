import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Undo2 } from 'lucide-react'
import { apiErrorText, fetchSessionList } from '../../lib/api'
import { relIso } from '../../lib/term'
import {
  PROJ_KEYS, actorLabel, fetchProjEvents, revertProjActor, undoProjEvent, updateProj,
  type ProjectEvent, type ProjectTabProps,
} from '../../lib/projectsApi'
import { Card } from '../Card'
import { Dropdown } from '../Dropdown'
import { ArmButton } from './TabTools'
import { BTN_TEXT } from './Sheet'

const PAGE = 50

const ago = (iso: string): string => {
  const r = relIso(iso)
  return !r ? '' : r === 'now' ? 'just now' : `${r} ago`
}

const conflictError = (e: unknown): boolean => {
  const r = (e as { response?: { status?: number; data?: { error?: unknown } } } | null)?.response
  return r?.status === 409 && r.data?.error === 'changed since'
}

function EventRow({ projectId, ev, label }: { projectId: string; ev: ProjectEvent; label: string }) {
  const qc = useQueryClient()
  // A 409 'changed since' means something newer touched the same item. The
  // second press is the explicit choice to overwrite it.
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const undo = useMutation({
    mutationFn: (force: boolean) => undoProjEvent(projectId, ev.id, force),
    onSuccess: () => {
      setStale(false); setError('')
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => {
      if (conflictError(e)) { setStale(true); setError(''); return }
      setError(apiErrorText(e, 'could not undo it'))
    },
  })
  const undone = ev.undoneBy !== null

  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2${undone ? ' opacity-50' : ''}`}>
      <span className="w-16 shrink-0 pt-0.5 text-[10px] text-[var(--color-text-faint)]" title={new Date(ev.at).toLocaleString()}>
        {ago(ev.at)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-xs">
          <span className={ev.actor.startsWith('session:') ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}>{label}</span>
          <span className="text-[var(--color-text-dim)]"> {ev.summary}</span>
          {undone && <span className="text-[var(--color-text-faint)]"> [undone]</span>}
        </div>
        {stale && <div className="mt-0.5 text-[11px] text-[var(--color-warning)]">Changed since. Undo anyway overwrites the newer change.</div>}
        {error && <div className="mt-0.5 text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
      {ev.undoable && !undone && (
        <button
          type="button"
          disabled={undo.isPending}
          onClick={() => undo.mutate(stale)}
          className={stale
            ? 'inline-flex min-h-9 shrink-0 items-center gap-1.5 border border-[var(--color-warning)]/60 px-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-warning)] transition disabled:opacity-40'
            : `shrink-0 ${BTN_TEXT}`}
        >
          <Undo2 size={11} /> {undo.isPending ? 'undoing' : stale ? 'undo anyway' : 'undo'}
        </button>
      )}
    </li>
  )
}

function SessionEditsCard({ projectId, on }: { projectId: string; on: boolean }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateProj(projectId, { sessionEdits: next }),
    onSuccess: (doc) => {
      setError('')
      qc.setQueryData(PROJ_KEYS.doc(projectId), doc)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not change it')),
  })
  const shown = toggle.isPending ? toggle.variables : on

  return (
    <Card title="session edits">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!on)}
          className={`min-h-9 shrink-0 border px-3 text-[10px] uppercase tracking-[0.18em] transition disabled:opacity-60 ${shown
            ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]'
            : 'border-[var(--color-danger)]/60 text-[var(--color-danger)]'}`}
        >
          {shown ? 'on' : 'off'}
        </button>
        <span className="text-xs text-[var(--color-text-dim)]">
          {shown ? 'sessions can change this page' : 'sessions are blocked from changing this page'}
        </span>
      </div>
      {error && <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div>}
    </Card>
  )
}

export function ActivityTab({ projectId, doc }: ProjectTabProps) {
  const qc = useQueryClient()
  const [actor, setActor] = useState('')
  const [revertNote, setRevertNote] = useState('')
  const [revertError, setRevertError] = useState('')

  // The actor rides in the key under the contract's events key, so the live
  // loop's invalidation of PROJ_KEYS.events still reaches every filter.
  const events = useInfiniteQuery({
    queryKey: [...PROJ_KEYS.events(projectId), actor],
    queryFn: ({ pageParam }) => fetchProjEvents(projectId, { limit: PAGE, actor: actor || undefined, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : Math.min(...last.map((e) => e.id))),
    refetchInterval: false,
  })

  // Titles only, from the board's cache. Its own observers poll thor, so this
  // one never adds a request to the agent's single thread.
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, refetchInterval: false, staleTime: 60_000 })
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    if (board.data?.installed) for (const s of board.data.sessions) if (s.title) m.set(s.sessionId, s.title)
    return m
  }, [board.data])

  const rows = useMemo(() => {
    const seen = new Set<number>()
    const out: ProjectEvent[] = []
    for (const page of events.data?.pages ?? []) {
      for (const ev of page) {
        if (seen.has(ev.id)) continue
        seen.add(ev.id)
        out.push(ev)
      }
    }
    return out
  }, [events.data])

  const actorOptions = useMemo(() => {
    const ids = new Set(rows.map((e) => e.actor))
    if (actor) ids.add(actor)
    return [
      { value: '', label: 'all' },
      ...[...ids].map((a) => ({ value: a, label: actorLabel(a, titles) })),
    ]
  }, [rows, actor, titles])

  const revert = useMutation({
    mutationFn: (who: string) => revertProjActor(projectId, who),
    onSuccess: (r) => {
      setRevertError('')
      setRevertNote(`reverted ${r.reverted}, ${r.conflicts} changed since`)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => { setRevertNote(''); setRevertError(apiErrorText(e, 'could not revert that session')) },
  })

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Dropdown
            value={actor}
            options={actorOptions}
            onChange={(v) => { setActor(v); setRevertNote(''); setRevertError('') }}
            size="sm"
            className="w-56 max-w-full"
          />
          {actor.startsWith('session:') && (
            <ArmButton
              label="revert everything this session did"
              armedLabel="revert all of it?"
              disabled={revert.isPending}
              title="Undo every change this session made to the page. Items changed since are left alone."
              onConfirm={() => revert.mutate(actor)}
            />
          )}
        </div>
        {revertNote && <div className="mb-2 text-[11px] text-[var(--color-accent)]">{revertNote}</div>}
        {revertError && <div className="mb-2 text-[11px] text-[var(--color-danger)]">{revertError}</div>}

        {events.isLoading ? (
          <div className="py-2 text-xs text-[var(--color-text-dim)]">&gt; loading</div>
        ) : events.isError ? (
          <div className="py-2 text-xs text-[var(--color-danger)]">{apiErrorText(events.error, 'could not read the activity')}</div>
        ) : rows.length === 0 ? (
          <div className="py-2 text-[11px] text-[var(--color-text-faint)]">Nothing has happened here yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map((ev) => (
              <EventRow key={ev.id} projectId={projectId} ev={ev} label={actorLabel(ev.actor, titles)} />
            ))}
          </ul>
        )}

        {events.hasNextPage && (
          <button
            type="button"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
            className={`mt-2 ${BTN_TEXT}`}
          >
            {events.isFetchingNextPage ? 'loading' : 'load older'}
          </button>
        )}
      </div>

      <SessionEditsCard projectId={projectId} on={doc.project.sessionEdits} />
    </div>
  )
}
