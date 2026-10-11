import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { fetchAIUsage, fetchProjects, fetchSessionList, fetchSystem, fetchVault } from '../../lib/api'
import { shortName, useQuickSessions } from '../../lib/quickSessions'
import { useNow } from '../../lib/todayEvents'
import { toneDot, toneText, type Tone } from './format'

// The top line: the day and time, one verdict, what is behind it, and the
// new-session buttons. Everything that is fine reads dim; only what needs a
// look takes a color.
function useStatus() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, refetchInterval: 30_000 })
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const vault = useQuery({ queryKey: ['vault'], queryFn: fetchVault, refetchInterval: 60_000 })

  const segments: { label: string; tone: Tone }[] = []
  const note = (label: string, tone: Tone) => segments.push({ label, tone })

  // Claude runs on thor, so ask thor's session list, not odin's process list.
  const live = sessions.data?.installed ? sessions.data.sessions.filter((x) => x.live) : []
  const asking = live.filter((x) => x.activity === 'asking').length
  if (asking > 0) note(`${asking} waiting on you`, 'watch')
  if (live.length > 0) note(`${live.length} session${live.length === 1 ? '' : 's'} running`, 'ok')
  else note('no sessions running', 'dim')

  const activeProject = (Array.isArray(projects.data) ? projects.data : []).find((p) => p.status === 'active')
  if (activeProject) note(`${activeProject.name} active`, 'ok')

  const q = aiUsage.data?.claude.quota
  if (typeof q?.weeklyPct === 'number') note(`Claude ${q.weeklyPct}% wk`, q.weeklyPct >= 85 ? 'alert' : q.weeklyPct >= 70 ? 'watch' : 'ok')
  if (typeof q?.sessionPct === 'number' && q.sessionPct >= 70) note(`Claude ${q.sessionPct}% 5h`, q.sessionPct >= 85 ? 'alert' : 'watch')

  if (vault.data) {
    const v = vault.data
    if (!v.container.running) note('vault down', 'alert')
    else if (v.container.healthy === false) note('vault unhealthy', 'alert')
    else if (v.backups.stale) note('backups stale', 'alert')
    else note('vault ok', 'ok')
  }

  if (sys.data) {
    const disk = Math.round(sys.data.disk.percent)
    const mem = Math.round(sys.data.memory.percent)
    const load = sys.data.cpu.loadAvg[0] / Math.max(sys.data.cpu.cores, 1)
    if (disk >= 80) note(`disk ${disk}%`, disk >= 90 ? 'alert' : 'watch')
    if (load >= 0.7) note(`load ${load.toFixed(1)}`, load >= 0.9 ? 'alert' : 'watch')
    if (mem >= 80) note(`mem ${mem}%`, mem >= 90 ? 'alert' : 'watch')
  }

  const alerts = segments.filter((s) => s.tone === 'alert').length
  const watches = segments.filter((s) => s.tone === 'watch').length
  const verdict = alerts > 0 ? `${alerts} need${alerts === 1 ? 's' : ''} attention` : watches > 0 ? `watching ${watches}` : 'all steady'
  const verdictTone: Tone = alerts > 0 ? 'alert' : watches > 0 ? 'watch' : 'ok'
  const loading = sys.isLoading && sessions.isLoading && aiUsage.isLoading && vault.isLoading
  return { segments, verdict, verdictTone, loading }
}

export function StatusLine() {
  const now = new Date(useNow())
  const { segments, verdict, verdictTone, loading } = useStatus()
  const quick = useQuickSessions()

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 py-2.5">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">
          {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="text-[12px] text-[var(--color-text-dim)]">
          {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {loading ? (
          <span className="text-[var(--color-text-faint)]">syncing…</span>
        ) : (
          <>
            <span className={`flex shrink-0 items-center gap-1.5 font-semibold ${verdictTone === 'ok' ? 'text-[var(--color-text)]' : toneText[verdictTone]}`}>
              <span className={`h-2 w-2 rounded-full ${toneDot[verdictTone]}`} aria-hidden />
              {verdict}
            </span>
            {segments.map((s) => (
              <span key={s.label} className={`flex shrink-0 items-center gap-1.5 ${toneText[s.tone]}`}>
                <span className="text-[var(--color-text-faint)]" aria-hidden>·</span>
                {s.label}
              </span>
            ))}
          </>
        )}
      </div>

      {!quick.empty && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-faint)]">new claude</span>
          {quick.loading ? (
            <span className="text-[11px] text-[var(--color-text-faint)]">reading thor…</span>
          ) : quick.kinds.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={quick.busy !== null}
              onClick={() => void quick.start(t)}
              title={`Start a new Claude session in ${t.label}`}
              className="inline-flex h-7 items-center gap-1 border border-[var(--color-border-strong)] px-2.5 text-[12px] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
            >
              <Plus size={12} className="shrink-0" />
              {quick.busy === t.key ? 'starting…' : shortName(t)}
            </button>
          ))}
          {quick.note && (
            <span className={`text-[11px] ${quick.note.error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>{quick.note.text}</span>
          )}
        </div>
      )}
    </div>
  )
}
