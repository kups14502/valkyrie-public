import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchSystem, fetchSessions, fetchProjects, fetchAIUsage } from '../lib/api'

const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

function UsageBar({ pct, label, sub, warn }: { pct: number; label: string; sub?: string; warn?: boolean }) {
  const clamped = Math.min(pct, 100)
  const color = warn || pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-accent)'
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

export default function Dashboard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })

  const sysError = sys.error as { isUnauthorized?: boolean; isBackendUnavailable?: boolean; detail?: string; message?: string } | null
  const sysUnauthorized = Boolean(sysError?.isUnauthorized)
  const sysBackendUnavailable = Boolean(sysError?.isBackendUnavailable)
  const sysValid = hasSystemShape(sys.data)
  const sessionsList = Array.isArray(sessions.data) ? sessions.data : []
  const projectsList = Array.isArray(projects.data) ? projects.data : []

  return (
    <div className="space-y-8">
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
            <Stat label="CPU" value={`${sys.data.cpu.usage.toFixed(1)}%`} sub={`${sys.data.cpu.cores} cores · load ${sys.data.cpu.loadAvg[0].toFixed(2)}`} />
            <Stat label="Memory" value={`${sys.data.memory.percent.toFixed(0)}%`} sub={`${fmtBytes(sys.data.memory.used)} / ${fmtBytes(sys.data.memory.total)}`} />
            <Stat label="Disk" value={`${sys.data.disk.percent.toFixed(0)}%`} sub={`${fmtBytes(sys.data.disk.used)} / ${fmtBytes(sys.data.disk.total)}`} />
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
                      pct={aiUsage.data.claude.quota.sessionPct}
                      label="Current session"
                      sub={aiUsage.data.claude.quota.sessionResetsAt
                        ? `Resets in ${Math.max(0, Math.round((new Date(aiUsage.data.claude.quota.sessionResetsAt).getTime() - Date.now()) / 60000))} min`
                        : undefined}
                    />
                    <UsageBar
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
                      pct={aiUsage.data.codex.rateLimits.session5h.pct}
                      label="5h session"
                      sub={`Resets in ${Math.max(0, Math.round((aiUsage.data.codex.rateLimits.session5h.resetsAt - Date.now() / 1000) / 60))} min`}
                    />
                  )}
                  {aiUsage.data.codex.rateLimits.weekly && (
                    <UsageBar
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
                <div key={s.id} className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-3 text-sm">
                  <div>
                    <div className="font-medium">{s.model}</div>
                    <div className="text-xs text-[var(--color-text-dim)]">PID {s.pid} · {fmtBytes(s.memory)}</div>
                  </div>
                  <div className="text-xs text-[var(--color-text-dim)]">{s.cpu.toFixed(1)}% CPU</div>
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
              <div key={p.path} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-[var(--color-text-dim)]">{p.path}</div>
                </div>
                <div className="flex items-center gap-3">
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
