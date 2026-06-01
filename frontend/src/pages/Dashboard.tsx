import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { Sparkline } from '../components/Sparkline'
import { fetchSystem, fetchSessions, fetchProjects, fetchAIUsage, fetchVault, fetchSystemHistory, fetchActivity, fetchLauncher } from '../lib/api'

const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

const fmtAgo = (ms: number | null): string | null => {
  if (ms == null) return null
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const clampPct = (pct: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)))
const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)
const fmtCost = (n: number) => n > 0 ? `$${n.toFixed(n >= 10 ? 0 : 2)}` : '—'

function UsageBar({ pct, label, sub, warn, claude, codex }: { pct: number; label: string; sub?: string; warn?: boolean; claude?: boolean; codex?: boolean }) {
  const clamped = clampPct(pct)
  const color = claude
    ? (clamped >= 85 ? 'var(--color-danger)' : '#D97757')
    : codex
    ? (clamped >= 85 ? 'var(--color-danger)' : '#1E40AF')
    : (warn || clamped >= 90 ? 'var(--color-danger)' : clamped >= 70 ? 'var(--color-warning)' : 'var(--color-accent)')
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-[var(--color-text-dim)]">{label}</span>
        <span className="font-semibold text-[var(--color-text)]">{clamped}% used</span>
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

  const alertSegments = segments.filter((s) => s.tone === 'alert' || s.tone === 'watch')

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      {/* mobile: compact single line */}
      <div className="flex items-center justify-between gap-3 sm:hidden">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">// now</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {alertSegments.map((s) => (
            <span key={s.label} className={`inline-flex items-center gap-1 text-[10px] ${toneText[s.tone]}`}>
              <span className={`h-1.5 w-1.5 ${toneDot[s.tone]}`} aria-hidden />
              [{s.label}]
            </span>
          ))}
        </div>
        {!loading && (
          <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] ${toneText[verdictTone]}`}>
            &gt; {verdict}
          </span>
        )}
      </div>
      {/* desktop: full segments */}
      <div className="hidden sm:flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">// now</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          {loading ? (
            <span className="text-xs text-[var(--color-text-dim)]">syncing…</span>
          ) : segments.length === 0 ? (
            <span className="text-xs text-[var(--color-text-dim)]">no signal yet</span>
          ) : (
            segments.map((s) => (
              <span key={s.label} className={`inline-flex items-center gap-1.5 text-xs ${toneText[s.tone]}`}>
                <span className={`h-1.5 w-1.5 ${toneDot[s.tone]}`} aria-hidden />
                [{s.label}]
              </span>
            ))
          )}
        </div>
        {!loading && (
          <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${toneText[verdictTone]}`}>
            &gt; {verdict}
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
  const activity = useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 60_000 })
  const launcher = useQuery({ queryKey: ['launcher'], queryFn: fetchLauncher, refetchInterval: 60_000 })

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

      <div className="space-y-6">
        <Card title="AI Usage">
          {aiUsage.isLoading && !aiUsage.data ? (
            <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
          ) : aiUsage.error ? (
            <div className="text-sm text-[var(--color-danger)]">Usage data unavailable</div>
          ) : aiUsage.data ? (
            <div className="space-y-6">
              {(aiUsage.data.aiClients ?? [
                { id: 'claude-work', kind: 'claude' as const, label: 'user@example.com', subscription: 'Claude Pro', ...aiUsage.data.claude },
                { id: 'codex-work', kind: 'codex' as const, label: 'Codex user@example.com', subscription: 'Codex', ...aiUsage.data.codex },
              ]).map((client) => (
                <div key={client.id} className="space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">{client.kind === 'claude' ? 'Claude' : 'Codex'}</div>
                      <div className="mt-1 text-sm font-semibold text-[var(--color-text)]">{client.label}</div>
                    </div>
                    <div className="text-right text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">{client.subscription}</div>
                  </div>
                  {client.kind === 'claude' && client.quota ? (
                    <div className="space-y-2">
                      <UsageBar
                        claude
                        pct={client.quota.sessionPct}
                        label="Current session"
                        sub={client.quota.sessionResetsAt
                          ? `Resets in ${Math.max(0, Math.round((new Date(client.quota.sessionResetsAt).getTime() - Date.now()) / 60000))} min${client.quota.status ? ` · ${client.quota.status.replace(/_/g, ' ')}` : ''}`
                          : client.quota.status?.replace(/_/g, ' ')}
                      />
                      <UsageBar
                        claude
                        pct={client.quota.weeklyPct}
                        label="Subscription week"
                        sub={client.quota.weeklyResetsAt
                          ? `Resets ${new Date(client.quota.weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
                          : undefined}
                      />
                    </div>
                  ) : client.kind === 'claude' ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--color-text-faint)]">Subscription quota unavailable</div>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          ['Today', client.today],
                          ['7d', client.last7d],
                          ['30d', client.last30d],
                        ] as const).map(([label, bucket]) => (
                          <div key={label} className="rounded bg-[var(--color-surface)] px-2 py-1.5">
                            <div className="text-[10px] text-[var(--color-text-faint)]">{label}</div>
                            <div className="text-xs font-semibold text-[var(--color-text)]">{fmtTokens(bucket.tokens)}</div>
                            <div className="text-[10px] text-[var(--color-text-faint)]">{fmtCost(bucket.costUSD)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {client.kind === 'codex' && (client.rateLimits.session5h || client.rateLimits.weekly) ? (
                    <div className="space-y-2">
                      {client.rateLimits.session5h && (
                        <UsageBar
                          codex
                          pct={client.rateLimits.session5h.pct}
                          label="5h session"
                          sub={`Resets in ${Math.max(0, Math.round((client.rateLimits.session5h.resetsAt - Date.now() / 1000) / 60))} min`}
                        />
                      )}
                      {client.rateLimits.weekly && <UsageBar codex pct={client.rateLimits.weekly.pct} label="Subscription week" />}
                    </div>
                  ) : client.kind === 'codex' ? (
                    <div className="text-[11px] text-[var(--color-text-faint)]">Subscription usage unavailable</div>
                  ) : null}
                </div>
              ))}
              {aiUsage.data.dmBot && (aiUsage.data.dmBot.last30d.messages > 0) && (() => {
                const dm = aiUsage.data.dmBot!
                const topModel = Object.entries(dm.byModel).sort((a, b) => b[1].tokens - a[1].tokens)[0]?.[0] ?? null
                return (
                  <div className="space-y-3">
                    <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">DM Bot</div>
                    <div className="grid grid-cols-3 gap-3">
                      {(['today', 'last7d', 'last30d'] as const).map((period) => (
                        <div key={period} className="space-y-0.5">
                          <div className="text-[10px] text-[var(--color-text-faint)]">{period === 'today' ? 'today' : period === 'last7d' ? '7d' : '30d'}</div>
                          <div className="text-sm font-semibold text-[var(--color-text)]">{fmtTokens(dm[period].tokens)}</div>
                          <div className="text-[10px] text-[var(--color-text-faint)]">{dm[period].messages} turns</div>
                        </div>
                      ))}
                    </div>
                    {topModel && (
                      <div className="text-[11px] text-[var(--color-text-faint)]">model: {topModel}</div>
                    )}
                  </div>
                )
              })()}
            </div>
          ) : null}
        </Card>

        <Card title={`Sessions (${sessionsList.length})`} >
          {sessionsList.length > 0 ? (
            <div className="space-y-2">
              {sessionsList.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold">{s.model}</span>
                      {s.project && (
                        <span className="text-[var(--color-text-dim)]">· {s.project}</span>
                      )}
                      {s.gitBranch && s.gitBranch !== 'master' && s.gitBranch !== 'main' && (
                        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-accent)]">
                          [{s.gitBranch}]
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-dim)]">
                      pid:{s.pid}{s.gitBranch && (s.gitBranch === 'master' || s.gitBranch === 'main') ? ` · ${s.gitBranch}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-[var(--color-text-dim)]">
                    <div>{s.cpu.toFixed(2)}% cpu</div>
                    <div className="mt-0.5">
                      {fmtBytes(s.memory)}
                      {sys.data?.memory?.total
                        ? <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">({clampPct((s.memory / sys.data.memory.total) * 100)}%)</span>
                        : null}
                    </div>
                    {s.lastActivity != null && (
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-faint)]">
                        {fmtAgo(s.lastActivity)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-dim)]">{sessions.isLoading ? 'Loading…' : 'No active sessions'}</div>
          )}
        </Card>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">System Overview</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Dashboard</h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [live telemetry]
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

      <Card title="Launcher">
        {launcher.isLoading && !launcher.data ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : launcher.error ? (
          <div className="text-sm text-[var(--color-danger)]">Launcher unavailable</div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {(launcher.data ?? []).map((s) => {
              const dot = s.health === 'alive' ? 'bg-[var(--color-success)]' : s.health === 'down' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-faint)]'
              const tone = s.health === 'alive' ? 'text-[var(--color-text)]' : s.health === 'down' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text-faint)]'
              return (
                <a
                  key={s.id}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`flex items-center justify-between gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2 transition hover:border-[var(--color-accent)] ${tone}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 ${dot}`} aria-hidden />
                    <span className="truncate text-sm">{s.name}</span>
                  </span>
                  {s.latencyMs != null && (
                    <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">{s.latencyMs}ms</span>
                  )}
                </a>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Recent activity">
        {activity.isLoading && !activity.data ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : activity.error ? (
          <div className="text-sm text-[var(--color-danger)]">Activity feed unavailable</div>
        ) : (activity.data?.length ?? 0) === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">No recent activity</div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {(activity.data ?? []).map((a) => {
              const typeColor =
                a.type === 'commit' ? 'text-[var(--color-success)]' :
                a.type === 'trade' ? 'text-[var(--color-warning)]' :
                'text-[var(--color-text-faint)]'
              const typeLabel = a.type === 'commit' ? 'git' : a.type === 'trade' ? 'trd' : 'bak'
              return (
                <div key={a.id} className="flex items-baseline gap-3 py-2 text-sm">
                  <span className={`shrink-0 text-[10px] uppercase tracking-[0.12em] ${typeColor}`}>[{typeLabel}]</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[var(--color-text)]">{a.title}</div>
                    {a.subtitle && (
                      <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">{a.subtitle}</div>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-dim)]">{fmtAgo(a.timestamp)}</span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Projects / Feeds">
        {projectsList.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]">
            {projectsList.map((p) => (
              <div key={p.path} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-semibold">{p.name}</span>
                    {p.dirty && (
                      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-warning)]">
                        [●{p.dirtyCount} uncommitted]
                      </span>
                    )}
                    {p.commitsToday > 0 && (
                      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-success)]">
                        [{p.commitsToday} today]
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-text-dim)]">
                    {p.lastCommit ? (
                      <span><span className="text-[var(--color-text-faint)]">{p.lastCommit.sha}</span> {p.lastCommit.subject}</span>
                    ) : (
                      <span>{p.path}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`text-xs ${
                    p.status === 'active' ? 'text-[var(--color-success)]' :
                    p.status === 'paused' ? 'text-[var(--color-warning)]' :
                    'text-[var(--color-text-dim)]'
                  }`}>[{p.status}]</span>
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
