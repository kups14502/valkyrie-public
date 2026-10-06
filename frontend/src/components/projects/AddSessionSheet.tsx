import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { apiErrorText, fetchSessionList } from '../../lib/api'
import { relIso } from '../../lib/term'
import { MIXABLE_AREAS, PROJ_KEYS, isClientArea, linkProjSession, type ProjectDoc } from '../../lib/projectsApi'
import { Sheet } from './Sheet'

const SHOWN = 40

// A client area never mixes with another or with anything else. Server and
// personal do, and a session from a folder with no area is one of those two.
const MIXABLE = [...MIXABLE_AREAS, '']

const ago = (iso: string | null) => {
  const r = relIso(iso)
  return r === 'now' ? 'just now' : r ? `${r} ago` : ''
}

export function AddSessionSheet({ projectId, doc, onClose }: { projectId: string; doc: ProjectDoc; onClose: () => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })
  const area = doc.project.area

  const rows = useMemo(() => {
    const linked = new Set(doc.sessions.map((s) => s.sessionId))
    const needle = q.trim().toLowerCase()
    const all = board.data?.installed ? board.data.sessions : []
    return all
      // thor only: the scoped board lists thor rows, so a session linked from
      // another machine would be on the project and nowhere on its page.
      .filter((s) => s.host === 'thor' && !linked.has(s.sessionId))
      .filter((s) => (isClientArea(area) ? s.area === area : MIXABLE.includes(s.area)))
      .filter((s) => !needle || `${s.title} ${s.project} ${s.cwd ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastActivityUtc ?? '').localeCompare(a.lastActivityUtc ?? ''))
      .slice(0, SHOWN)
  }, [board.data, doc.sessions, q, area])

  const link = useMutation({
    mutationFn: (sessionId: string) => linkProjSession(projectId, sessionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      onClose()
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not link that session')),
  })

  return (
    <Sheet title="add an existing session" onClose={onClose}>
      <label className="mb-3 flex min-w-0 items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 focus-within:border-[var(--color-accent)]">
        <Search size={14} className="shrink-0 text-[var(--color-text-faint)]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search sessions…"
          className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] sm:text-sm"
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X size={14} />
          </button>
        )}
      </label>

      {error && <div className="mb-2 text-xs text-[var(--color-danger)]">{error}</div>}

      {board.isLoading ? (
        <div className="py-6 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-faint)]">
          {q ? 'No session matches.' : `No unlinked ${area} sessions on thor.`}
        </div>
      ) : (
        <ul>
          {rows.map((s) => (
            <li key={s.sessionId} className="border-b border-[var(--color-border)] last:border-b-0">
              <button
                type="button"
                disabled={link.isPending}
                onClick={() => link.mutate(s.sessionId)}
                className="block w-full min-w-0 py-2.5 text-left transition hover:text-[var(--color-accent)] disabled:opacity-40"
              >
                <div className="truncate text-sm text-[var(--color-text)]">{s.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
                  {[s.project, s.area, ago(s.lastActivityUtc), s.live ? 'running' : '']
                    .filter(Boolean).join(' · ')}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
