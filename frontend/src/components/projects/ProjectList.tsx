import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bell, Plus } from 'lucide-react'
import { apiErrorText, fetchSessionList, type WorkSession } from '../../lib/api'
import { BASE_AREAS, PROJ_KEYS, fetchProjList, projAreasQuery, type ProjectSummary } from '../../lib/projectsApi'
import { NewProjectSheet } from './NewProjectSheet'
import { NewProjectAiSheet } from './NewProjectAiSheet'
import { BTN_ACCENT, BTN_GHOST } from './Sheet'

const untilIso = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms < 60_000) return 'now'
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`
  return `in ${Math.round(ms / 86_400_000)}d`
}

type Counted = ProjectSummary & { live: number; asking: number }

function count(p: ProjectSummary, byId: Map<string, WorkSession>): Counted {
  let live = 0
  let asking = 0
  for (const id of p.sessionIds) {
    const s = byId.get(id)
    if (!s) continue
    if (s.live) live += 1
    if (s.activity === 'asking') asking += 1
  }
  return { ...p, live, asking }
}

// A session waiting on Brendon outranks one that is merely running, and both
// outrank a project nobody is in.
const rank = (p: Counted) => (p.asking > 0 ? 2 : p.live > 0 ? 1 : 0)
const byUrgency = (a: Counted, b: Counted) =>
  rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)

// One line per project: name, what is next, and whether anyone is in it. A box
// per project spent most of the screen on borders.
function ProjectRow({ p, onOpen }: { p: Counted; onOpen: () => void }) {
  const line = p.nextAction || p.summary
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 py-2.5 text-left transition hover:bg-[rgba(var(--color-accent-rgb),0.04)] sm:flex-nowrap"
    >
      <span className="min-w-0 shrink-0 truncate text-sm text-[var(--color-text)] sm:w-64">
        {p.name}
        {p.status !== 'active' && <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{p.status}</span>}
      </span>
      <span className="order-3 min-w-0 basis-full truncate text-xs text-[var(--color-text-dim)] sm:order-none sm:basis-auto sm:flex-1">{line}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px] text-[var(--color-text-faint)]">
        {p.asking > 0 && <span className="text-[var(--color-warning)]">{p.asking} asking</span>}
        {p.live > 0 && <span className="text-[var(--color-accent)]">{p.live} live</span>}
        {p.nextReminderAt && (
          <span className="inline-flex items-center gap-1">
            <Bell size={10} /> {untilIso(p.nextReminderAt)}
          </span>
        )}
      </span>
    </button>
  )
}

export function ProjectList() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [manual, setManual] = useState(false)
  // The way back from an archive: the list leaves archived projects out, and
  // an archived page is otherwise reachable only by typing its URL.
  const [showArchived, setShowArchived] = useState(false)
  // Under the list key, so every invalidation of the list reaches this too.
  const list = useQuery({
    queryKey: showArchived ? [...PROJ_KEYS.list, 'archived'] : PROJ_KEYS.list,
    queryFn: () => fetchProjList(showArchived),
    refetchInterval: 30_000,
  })
  // The board's own cache entry: no new poller against thor's agent.
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })
  const areas = useQuery(projAreasQuery).data ?? BASE_AREAS

  const { sections, total, asking } = useMemo(() => {
    const byId = new Map<string, WorkSession>()
    for (const s of (board.data?.installed ? board.data.sessions : [])) byId.set(s.sessionId, s)
    const counted = (list.data ?? []).map((p) => count(p, byId))
    const askingIds = new Set<string>()
    for (const p of counted) {
      for (const id of p.sessionIds) if (byId.get(id)?.activity === 'asking') askingIds.add(id)
    }
    return {
      // An area dropped from odin's list still has its projects: shown last.
      sections: [...areas, ...new Set(counted.map((p) => p.area).filter((a) => !areas.includes(a)))]
        .map((area) => ({ area, rows: counted.filter((p) => p.area === area).sort(byUrgency) }))
        .filter((g) => g.rows.length > 0),
      total: counted.length,
      asking: askingIds.size,
    }
  }, [list.data, board.data, areas])

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// claude desk</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            projects<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            [{total} project{total === 1 ? '' : 's'} · <span className={asking > 0 ? 'text-[var(--color-warning)]' : ''}>{asking} asking</span>]
          </div>
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className={BTN_GHOST}
          >
            {showArchived ? 'hide archived' : 'show archived'}
          </button>
          {total > 0 && (
            <button type="button" onClick={() => setCreating(true)} className={BTN_GHOST}>
              <Plus size={12} /> new project
            </button>
          )}
        </div>
      </div>

      {list.isLoading ? (
        <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
      ) : list.isError ? (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {apiErrorText(list.error, 'projects unavailable')}
        </div>
      ) : total === 0 ? (
        <div className="panel mx-auto max-w-md space-y-4 p-6 text-center">
          <div className="text-sm text-[var(--color-text-dim)]">
            A project keeps its sessions, notes, files and reminders on one page.
          </div>
          <button type="button" onClick={() => setCreating(true)} className={BTN_ACCENT}>
            <Plus size={13} /> new project
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map((g) => (
            <section key={g.area}>
              <div className="mb-1 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
                {g.area}
                <span className="text-[var(--color-border-strong)]">{g.rows.length}</span>
              </div>
              <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {g.rows.map((p) => (
                  <ProjectRow key={p.id} p={p} onOpen={() => navigate(`/projects/${p.id}`)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {creating && <NewProjectAiSheet onClose={() => setCreating(false)} onManual={() => { setCreating(false); setManual(true) }} />}
      {manual && <NewProjectSheet onClose={() => setManual(false)} />}
    </div>
  )
}
