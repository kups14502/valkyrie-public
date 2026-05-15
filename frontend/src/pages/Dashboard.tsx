import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchSystem, fetchSessions, fetchProjects, fetchAIUsage, fetchVault, fetchSystemHistory } from '../lib/api'

const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="mt-1.5 h-4" />
  const w = 100
  const h = 18
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (max - min < 1) {
    const mid = (min + max) / 2
    min = mid - 1
    max = mid + 1
  }
  const range = max - min
  const pad = range * 0.15
  min -= pad
  max += pad
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / (max - min)) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = values[values.length - 1]
  const lastY = h - ((last - min) / (max - min)) * h
  const lastX = w
  return (
    <svg className="mt-1.5 block w-full" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX - 1.5} cy={lastY} r={1.5} fill={color} />
    </svg>
  )
}

function UsageBar({ pct, label, sub, warn, claude, codex }: { pct: number; label: string; sub?: string; warn?: boolean; claude?: boolean; codex?: boolean }) {
  const clamped = Math.min(pct, 100)
  const color = claude
    ? (pct >= 85 ? 'var(--color-danger)' : '#D97757')
    : codex
    ? (pct >= 85 ? 'var(--color-danger)' : '#1E40AF')
    : (warn || pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-accent)')
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-[var(--color-text-dim)]">{label}</span>
        <span className="font-semibold text-[var(--color-text)]">{pct}% used</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-2)]">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </div>
      {sub && <div className="text-[11px] text-[var(--color-text-faint)]">{sub}</div>}
    </div>
  )
}

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

const hasSystemShape = (value: unknown): value is {
  cpu: { usage: number; cores: number; loadAvg: [number, number, number] }
  memory: { percent: number; used: number; total: number }
  disk: { percent: number; used: number; total: number }
  uptime: number
  hostname: string
} => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, any>
  return Boolean(
    v.cpu && typeof v.cpu.usage === 'number' && typeof v.cpu.cores === 'number' && Array.isArray(v.cpu.loadAvg) &&
    v.memory && typeof v.memory.percent === 'number' && typeof v.memory.used === 'number' && typeof v.memory.total === 'number' &&
    v.disk && typeof v.disk.percent === 'number' && typeof v.disk.used === 'number' && typeof v.disk.total === 'number' &&
    typeof v.uptime === 'number' && typeof v.hostname === 'string'
  )
}

type Tone = 'ok' | 'watch' | 'alert' | 'dim'

const toneDot: Record<Tone, string> = {
  ok: 'bg-[var(--color-success)]',
  watch: 'bg-[var(--color-warning)]',
  alert: 'bg-[var(--color-danger)]',
  dim: 'bg-[var(--color-text-faint)]',
}

const toneText: Record<Tone, string> = {
  ok: 'text-[var(--color-text)]',
  watch: 'text-[var(--color-warning)]',
  alert: 'text-[var(--color-danger)]',
  dim: 'text-[var(--color-text-dim)]',
}

function NowBanner() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, refetchInterval: 30_000 })
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const vault = useQuery({ queryKey: ['vault'], queryFn: fetchVault, refetchInterval: 60_000 })

  const segments: { label: string; tone: Tone }[] = []
  let alerts = 0
  let watches = 0
  const note = (label: string, tone: Tone) => {
    segments.push({ label, tone })
    if (tone === 'alert') alerts++
    else if (tone === 'watch') watches++
  }

  const sessionsList = Array.isArray(sessions.data) ? sessions.data : []
  if (sessionsList.length > 0) note(`${sessionsList.length} session${sessionsList.length === 1 ? '' : 's'}`, 'ok')
  else note('no sessions', 'dim')

  const projectsList = Array.isArray(projects.data) ? projects.data : []
  const activeProject = projectsList.find((p) => p.status === 'active')
  if (activeProject) note(`${activeProject.name} active`, 'ok')

  const claudeWeekly = aiUsage.data?.claude.quota?.weeklyPct
  if (typeof claudeWeekly === 'number') {
    const tone: Tone = claudeWeekly >= 85 ? 'alert' : claudeWeekly >= 70 ? 'watch' : 'ok'
    note(`Claude ${claudeWeekly}% wk`, tone)
  }

  const claudeSessionPct = aiUsage.data?.claude.quota?.sessionPct
  if (typeof claudeSessionPct === 'number' && claudeSessionPct >= 70) {
    const tone: Tone = claudeSessionPct >= 85 ? 'alert' : 'watch'
    note(`Claude ${claudeSessionPct}% 5h`, tone)
  }

  const codex5h = aiUsage.data?.codex.rateLimits.session5h?.pct
  if (typeof codex5h === 'number' && codex5h > 0) {
    const tone: Tone = codex5h >= 85 ? 'alert' : codex5h >= 70 ? 'watch' : 'ok'
    note(`Codex ${codex5h}% 5h`, tone)
  }

  if (vault.data) {
    const v = vault.data
    if (!v.container.running) note('vault down', 'alert')
    else if (v.container.healthy === false) note('vault unhealthy', 'alert')
    else if (v.backups.stale) note('backups stale', 'alert')
    else note('vault ok', 'ok')
  }

  if (sys.data) {
    if (sys.data.disk.percent >= 90) note(`disk ${Math.round(sys.data.disk.percent)}%`, 'alert')
    else if (sys.data.disk.percent >= 80) note(`disk ${Math.round(sys.data.disk.percent)}%`, 'watch')

    const loadRatio = sys.data.cpu.loadAvg[0] / Math.max(sys.data.cpu.cores, 1)
    if (loadRatio >= 0.9) note(`load ${loadRatio.toFixed(1)}`, 'alert')
    else if (loadRatio >= 0.7) note(`load ${loadRatio.toFixed(1)}`, 'watch')

    if (sys.data.memory.percent >= 90) note(`mem ${Math.round(sys.data.memory.percent)}%`, 'alert')
    else if (sys.data.memory.percent >= 80) note(`mem ${Math.round(sys.data.memory.percent)}%`, 'watch')
  }

  const verdict = alerts > 0
    ? `${alerts} need${alerts === 1 ? 's' : ''} attention`
    : watches > 0
    ? `watching ${watches}`
    : 'all systems steady'
  const verdictTone: Tone = alerts > 0 ? 'alert' : watches > 0 ? 'watch' : 'ok'

  const loading = sys.isLoading && sessions.isLoading && aiUsage.isLoading && vault.isLoading

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[linear-gradient(180deg,rgba(14,19,29,0.96),rgba(9,12,18,0.96))] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.32em] text-[var(--color-text-faint)]">Now</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          {loading ? (
            <span className="text-xs text-[var(--color-text-dim)]">syncing…</span>
          ) : segments.length === 0 ? (
            <span className="text-xs text-[var(--color-text-dim)]">no signal yet</span>
          ) : (
            segments.map((s) => (
              <span key={s.label} className={`inline-flex items-center gap-1.5 text-xs ${toneText[s.tone]}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${toneDot[s.tone]}`} aria-hidden />
                {s.label}
              </span>
            ))
          )}
        </div>
        {!loading && (
          <span className={`text-[11px] font-medium uppercase tracking-[0.22em] ${toneText[verdictTone]}`}>
            {verdict}
          </span>
        )}
      </div>
    </section>
  )
}

export default function Dashboard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, refetchInterval: 30_000 })
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const history = useQuery({ queryKey: ['system-history'], queryFn: fetchSystemHistory, refetchInterval: 30_000 })

  const samples = history.data?.samples ?? []
  const cpuSeries = samples.map((s) => s.cpu)
  const memSeries = samples.map((s) => s.mem)
  const diskSeries = samples.map((s) => s.disk)

  const sysError = sys.error as { isUnauthorized?: boolean; isBackendUnavailable?: boolean; detail?: string; message?: string } | null
  const sysUnauthorized = Boolean(sysError?.isUnauthorized)
  const sysBackendUnavailable = Boolean(sysError?.isBackendUnavailable)
  const sysValid = hasSystemShape(sys.data)
  const sessionsList = Array.isArray(sessions.data) ? sessions.data : []
  const projectsList = Array.isArray(projects.data) ? projects.data : []

  return (
    <div className="space-y-8">
      <NowBanner />
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">System Overview</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Dashboard</h1>
        </div>
        <div className="rounded-full border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-1 text-xs uppercase tracking-[0.22em] text-[var(--color-text-dim)]">
          live telemetry
        </div>
      </div>

      <Card title="Server">
        {sys.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : sysUnauthorized ? (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--color-warning)]">Access handshake required</div>
            <div className="text-[var(--color-text-dim)]">API is online, but this session is not passing auth yet.</div>
          </div>
        ) : sysBackendUnavailable ? (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--color-danger)]">API route unavailable</div>
            <div className="text-[var(--color-text-dim)]">The frontend cannot currently reach the telemetry API from this host.</div>
          </div>
        ) : sys.error ? (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--color-danger)]">Telemetry unavailable</div>
            {sysError?.detail || sysError?.message ? <div className="text-[var(--color-text-dim)]">{sysError.detail || sysError.message}</div> : null}
          </div>
        ) : sys.data && sysValid ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat
              label="CPU"
              value={`${sys.data.cpu.usage.toFixed(1)}%`}
              sub={`${sys.data.cpu.cores} cores · load ${sys.data.cpu.loadAvg[0].toFixed(2)}`}
              chart={<Sparkline values={cpuSeries} color="var(--color-accent)" />}
            />
            <Stat
              label="Memory"
              value={`${sys.data.memory.percent.toFixed(0)}%`}
              sub={`${fmtBytes(sys.data.memory.used)} / ${fmtBytes(sys.data.memory.total)}`}
              chart={<Sparkline values={memSeries} color="#7a5cff" />}
            />
            <Stat
              label="Disk"
              value={`${sys.data.disk.percent.toFixed(0)}%`}
              sub={`${fmtBytes(sys.data.disk.used)} / ${fmtBytes(sys.data.disk.total)}`}
              chart={<Sparkline values={diskSeries} color="#48e3ce" />}
            />
            <Stat label="Uptime" value={fmtUptime(sys.data.uptime)} sub={sys.data.hostname} />
          </div>
        ) : sys.data ? (
          <div className="text-sm text-[var(--color-warning)]">System data shape was invalid.</div>
        ) : null}
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
        <Card title="AI Clients">
          {aiUsage.isLoading && !aiUsage.data ? (
            <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
          ) : aiUsage.error ? (
            <div className="text-sm text-[var(--color-danger)]">Usage data unavailable</div>
          ) : aiUsage.data ? (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">Claude</div>
                {aiUsage.data.claude.quota ? (
                  <>
                    <UsageBar
                      claude
                      pct={aiUsage.data.claude.quota.sessionPct}
                      label="Current session"
                      sub={aiUsage.data.claude.quota.sessionResetsAt
                        ? `Resets in ${Math.max(0, Math.round((new Date(aiUsage.data.claude.quota.sessionResetsAt).getTime() - Date.now()) / 60000))} min`
                        : undefined}
                    />
                    <UsageBar
                      claude
                      pct={aiUsage.data.claude.quota.weeklyPct}
                      label="This week"
                      sub={aiUsage.data.claude.quota.weeklyResetsAt
                        ? `Resets ${new Date(aiUsage.data.claude.quota.weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
                        : undefined}
                    />
                  </>
                ) : aiUsage.data.claude.session ? (
                  <div className="text-xs text-[var(--color-text-dim)]">Session active · quota unavailable</div>
                ) : (
                  <div className="text-xs text-[var(--color-text-dim)]">No active session</div>
                )}
              </div>
              {aiUsage.data.codex.rateLimits.session5h || aiUsage.data.codex.rateLimits.weekly ? (
                <div className="space-y-3">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">Codex</div>
                  {aiUsage.data.codex.rateLimits.session5h && (
                    <UsageBar
                      codex
                      pct={aiUsage.data.codex.rateLimits.session5h.pct}
                      label="5h session"
                      sub={`Resets in ${Math.max(0, Math.round((aiUsage.data.codex.rateLimits.session5h.resetsAt - Date.now() / 1000) / 60))} min`}
                    />
                  )}
                  {aiUsage.data.codex.rateLimits.weekly && (
                    <UsageBar
                      codex
                      pct={aiUsage.data.codex.rateLimits.weekly.pct}
                      label="Weekly"
                    />
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card title={`Sessions (${sessionsList.length})`}>
          {sessionsList.length > 0 ? (
            <div className="space-y-2">
              {sessionsList.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{s.model}</span>
                      {s.project && (
                        <span className="text-[var(--color-text-dim)]">· {s.project}</span>
                      )}
                      {s.gitBranch && s.gitBranch !== 'master' && s.gitBranch !== 'main' && (
                        <span className="rounded-full bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--color-accent)]">
                          {s.gitBranch}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-dim)]">
                      PID {s.pid} · {fmtBytes(s.memory)}{s.gitBranch && (s.gitBranch === 'master' || s.gitBranch === 'main') ? ` · ${s.gitBranch}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-[var(--color-text-dim)]">{s.cpu.toFixed(1)}% CPU</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-dim)]">{sessions.isLoading ? 'Loading…' : 'No active sessions'}</div>
          )}
        </Card>
      </div>

      <Card title="Projects / Feeds">
        {projectsList.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]">
            {projectsList.map((p) => (
              <div key={p.path} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.dirty && (
                      <span className="rounded-full bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--color-warning)]">
                        ●{p.dirtyCount} uncommitted
                      </span>
                    )}
                    {p.commitsToday > 0 && (
                      <span className="rounded-full bg-[var(--color-success)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--color-success)]">
                        {p.commitsToday} today
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-text-dim)]">
                    {p.lastCommit ? (
                      <span><span className="font-mono text-[var(--color-text-faint)]">{p.lastCommit.sha}</span> {p.lastCommit.subject}</span>
                    ) : (
                      <span>{p.path}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    p.status === 'active' ? 'bg-[var(--color-success)]/20 text-[var(--color-success)]' :
                    p.status === 'paused' ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' :
                    'bg-[var(--color-surface-2)] text-[var(--color-text-dim)]'
                  }`}>{p.status}</span>
                  <span className="text-xs text-[var(--color-text-dim)]">{p.lastTouched}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text-dim)]">{projects.isLoading ? 'Loading…' : projects.data ? 'Project data shape was invalid.' : 'No projects tracked'}</div>
        )}
      </Card>
    </div>
  )
}
