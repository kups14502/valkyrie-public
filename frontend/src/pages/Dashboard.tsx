import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchSystem, fetchSessions, fetchAIUsage, fetchProjects } from '../lib/api'

const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

export default function Dashboard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const ai = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <Card title="Server">
        {sys.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : sys.error ? (
          <div className="text-sm text-[var(--color-danger)]">Backend offline</div>
        ) : sys.data ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="CPU" value={`${sys.data.cpu.usage.toFixed(1)}%`} sub={`${sys.data.cpu.cores} cores · load ${sys.data.cpu.loadAvg[0].toFixed(2)}`} />
            <Stat label="Memory" value={`${sys.data.memory.percent.toFixed(0)}%`} sub={`${fmtBytes(sys.data.memory.used)} / ${fmtBytes(sys.data.memory.total)}`} />
            <Stat label="Disk" value={`${sys.data.disk.percent.toFixed(0)}%`} sub={`${fmtBytes(sys.data.disk.used)} / ${fmtBytes(sys.data.disk.total)}`} />
            <Stat label="Uptime" value={fmtUptime(sys.data.uptime)} sub={sys.data.hostname} />
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="AI Usage (24h)">
          {ai.data ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Cost" value={`$${ai.data.totalCostUSD.toFixed(2)}`} />
                <Stat label="Tokens" value={`${((ai.data.totalTokensInput + ai.data.totalTokensOutput) / 1000).toFixed(1)}k`} sub={`${(ai.data.totalTokensInput / 1000).toFixed(1)}k in / ${(ai.data.totalTokensOutput / 1000).toFixed(1)}k out`} />
              </div>
              <div className="mt-4 space-y-1 border-t border-[var(--color-border)] pt-3">
                {Object.entries(ai.data.byModel).map(([model, m]) => (
                  <div key={model} className="flex items-center justify-between text-sm">
                    <span className="text-[var(--color-text-dim)]">{model}</span>
                    <span>${m.costUSD.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-[var(--color-text-dim)]">{ai.isLoading ? 'Loading…' : 'No data'}</div>
          )}
        </Card>

        <Card title={`Sessions (${sessions.data?.length ?? 0})`}>
          {sessions.data && sessions.data.length > 0 ? (
            <div className="space-y-2">
              {sessions.data.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-md bg-[var(--color-surface-2)] px-3 py-2 text-sm">
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

      <Card title="Projects">
        {projects.data && projects.data.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]">
            {projects.data.map((p) => (
              <div key={p.path} className="flex items-center justify-between py-2 text-sm">
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
          <div className="text-sm text-[var(--color-text-dim)]">{projects.isLoading ? 'Loading…' : 'No projects tracked'}</div>
        )}
      </Card>
    </div>
  )
}
