import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchLauncher, fetchServices, restartService, type LauncherEntry, type ServiceContainer, type ServiceUnit } from '../lib/api'

function containerToneColor(state: string): string {
  if (state === 'running') return 'text-[var(--color-success)]'
  if (state === 'exited' || state === 'dead') return 'text-[var(--color-text-faint)]'
  if (state === 'created' || state === 'paused') return 'text-[var(--color-warning)]'
  return 'text-[var(--color-danger)]'
}

function serviceToneColor(active: string, sub: string): string {
  if (active === 'failed') return 'text-[var(--color-danger)]'
  if (sub === 'running') return 'text-[var(--color-success)]'
  if (sub === 'exited') return 'text-[var(--color-text-faint)]'
  if (active === 'activating' || active === 'deactivating') return 'text-[var(--color-warning)]'
  return 'text-[var(--color-text-dim)]'
}

function ContainerRow({ c, onRestart, pending }: { c: ServiceContainer; onRestart: () => void; pending: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[var(--color-text)]">{c.name}</span>
          <span className={`text-[10px] uppercase tracking-[0.12em] ${containerToneColor(c.state)}`}>
            [{c.state}]
          </span>
          {c.project && (
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">[{c.project}]</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
          {c.image} · {c.status}
          {c.ports.length > 0 && <span> · {c.ports.join(', ')}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onRestart}
        disabled={pending}
        className="shrink-0 border border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-40"
      >
        restart
      </button>
    </div>
  )
}

function AppTile({ app }: { app: LauncherEntry }) {
  const dot = app.health === 'alive' ? 'bg-[var(--color-success)]' : app.health === 'down' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-faint)]'
  const tone = app.health === 'alive' ? 'text-[var(--color-text)]' : app.health === 'down' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text-faint)]'
  return (
    <a
      href={app.url}
      target="_blank"
      rel="noreferrer"
      className={`block border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] p-3 transition hover:border-[var(--color-accent)] ${tone}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 ${dot}`} aria-hidden />
          <span className="truncate text-sm font-semibold">{app.name}</span>
        </span>
        {app.latencyMs != null && <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">{app.latencyMs}ms</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
        <span>[{app.category}]</span>
        {app.owner && <span>[{app.owner}]</span>}
      </div>
    </a>
  )
}

function ServiceRow({ s, onRestart, pending }: { s: ServiceUnit; onRestart: () => void; pending: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[var(--color-text)]">{s.name.replace(/\.service$/, '')}</span>
          <span className={`text-[10px] uppercase tracking-[0.12em] ${serviceToneColor(s.active, s.sub)}`}>
            [{s.active}/{s.sub}]
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">{s.description}</div>
      </div>
      <button
        type="button"
        onClick={onRestart}
        disabled={pending}
        className="shrink-0 border border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-40"
      >
        restart
      </button>
    </div>
  )
}

export default function Services() {
  const qc = useQueryClient()
  const services = useQuery({ queryKey: ['services'], queryFn: fetchServices, refetchInterval: 15_000 })
  const launcher = useQuery({ queryKey: ['launcher'], queryFn: fetchLauncher, refetchInterval: 60_000 })
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const restart = useMutation({
    mutationFn: ({ kind, name }: { kind: 'container' | 'service'; name: string }) => restartService(kind, name),
    onMutate: ({ name }) => {
      setPendingName(name)
      setError(null)
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['services'] }) },
    onError: (err) => setError((err as Error).message),
    onSettled: () => setPendingName(null),
  })

  const containers = services.data?.containers ?? []
  const units = services.data?.services ?? []
  const apps = launcher.data ?? []
  const runningContainers = containers.filter((c) => c.state === 'running').length
  const failedServices = units.filter((s) => s.active === 'failed').length

  const handleRestart = (kind: 'container' | 'service', name: string) => {
    if (!confirm(`Restart ${kind} "${name}"?`)) return
    restart.mutate({ kind, name })
  }

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Homelab</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Services</h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [{apps.length} apps · {runningContainers}/{containers.length} containers · {units.length} units{failedServices > 0 ? ` · ${failedServices} failed` : ''}]
        </div>
      </div>

      {error && (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <Card title={`Web apps · ${apps.length}`}>
        {launcher.isLoading && !launcher.data ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : launcher.error ? (
          <div className="text-sm text-[var(--color-danger)]">App launcher unavailable</div>
        ) : apps.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">No registered apps</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => <AppTile key={app.id} app={app} />)}
          </div>
        )}
      </Card>

      {services.isLoading && !services.data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      ) : services.error ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Services unavailable</div></Card>
      ) : (
        <>
          <Card title={`Containers · ${containers.length}`}>
            {containers.length === 0 ? (
              <div className="text-sm text-[var(--color-text-dim)]">No containers</div>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {containers.map((c) => (
                  <ContainerRow
                    key={c.id}
                    c={c}
                    onRestart={() => handleRestart('container', c.name)}
                    pending={pendingName === c.name}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card title={`Systemd user units · ${units.length}`}>
            {units.length === 0 ? (
              <div className="text-sm text-[var(--color-text-dim)]">No active units</div>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {units.map((s) => (
                  <ServiceRow
                    key={s.name}
                    s={s}
                    onRestart={() => handleRestart('service', s.name)}
                    pending={pendingName === s.name}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
