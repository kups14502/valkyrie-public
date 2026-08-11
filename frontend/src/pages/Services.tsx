import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchLauncher, fetchServices, restartService, type LauncherEntry, type ListeningPort, type ServiceContainer, type ServiceTimer, type ServiceUnit } from '../lib/api'

type Tab = 'apps' | 'containers' | 'units' | 'timers' | 'ports' | 'compose'

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

function exposureTone(exposure: ListeningPort['exposure']): string {
  if (exposure === 'public') return 'text-[var(--color-warning)]'
  if (exposure === 'tailscale') return 'text-[var(--color-accent)]'
  if (exposure === 'local') return 'text-[var(--color-success)]'
  if (exposure === 'lan' || exposure === 'docker') return 'text-[var(--color-text-dim)]'
  return 'text-[var(--color-text-faint)]'
}

function AppTile({ app }: { app: LauncherEntry }) {
  const dot = app.health === 'alive' ? 'bg-[var(--color-success)]' : app.health === 'down' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-faint)]'
  const tone = app.health === 'alive' ? 'text-[var(--color-text)]' : app.health === 'down' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text-faint)]'
  return (
    <a href={app.url} target="_blank" rel="noreferrer" className={`block border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] p-3 transition hover:border-[var(--color-accent)] ${tone}`}>
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

function ContainerRow({ c, onRestart, pending }: { c: ServiceContainer; onRestart: () => void; pending: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[var(--color-text)]">{c.name}</span>
          <span className={`text-[10px] uppercase tracking-[0.12em] ${containerToneColor(c.state)}`}>[{c.state}]</span>
          {c.project && <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">[{c.project}]</span>}
        </div>
        <div className="mt-0.5 text-[11px] break-all sm:truncate text-[var(--color-text-faint)]">
          {c.image} · {c.status}{c.ports.length > 0 && <span> · {c.ports.join(', ')}</span>}
        </div>
        {c.composeFile && <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-faint)]">{c.composeFile}</div>}
      </div>
      <button type="button" onClick={onRestart} disabled={pending} className="shrink-0 border border-[var(--color-border)] min-h-10 px-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] active:border-[var(--color-accent)] disabled:opacity-40">restart</button>
    </div>
  )
}

function ServiceRow({ s, onRestart, pending, canRestart = true }: { s: ServiceUnit; onRestart?: () => void; pending?: boolean; canRestart?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[var(--color-text)]">{s.name.replace(/\.service$/, '')}</span>
          <span className={`text-[10px] uppercase tracking-[0.12em] ${serviceToneColor(s.active, s.sub)}`}>[{s.active}/{s.sub}]</span>
          {s.scope && <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">[{s.scope}]</span>}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">{s.description}</div>
      </div>
      {canRestart && onRestart && <button type="button" onClick={onRestart} disabled={pending} className="shrink-0 border border-[var(--color-border)] min-h-10 px-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] active:border-[var(--color-accent)] disabled:opacity-40">restart</button>}
    </div>
  )
}

function TimerRow({ t }: { t: ServiceTimer }) {
  return (
    <div className="grid gap-1 py-2 text-sm md:grid-cols-[1fr_1fr_1fr] md:gap-4">
      <div className="min-w-0">
        <div className="font-semibold text-[var(--color-text)]">{t.name.replace(/\.timer$/, '')}</div>
        <div className="truncate text-[11px] text-[var(--color-text-faint)]">{t.service}</div>
      </div>
      <div className="text-[11px] text-[var(--color-text-dim)]">next: {t.next} <span className="text-[var(--color-text-faint)]">({t.left})</span></div>
      <div className="text-[11px] text-[var(--color-text-dim)]">last: {t.last} <span className="text-[var(--color-text-faint)]">({t.passed})</span></div>
    </div>
  )
}

function PortRow({ p }: { p: ListeningPort }) {
  return (
    <div className="grid gap-1 py-2 text-sm md:grid-cols-[90px_1fr_1fr_100px] md:gap-4">
      <div className="font-mono text-[11px] uppercase text-[var(--color-text-faint)]">{p.protocol}</div>
      <div className="font-mono text-[var(--color-text)]">{p.local}</div>
      <div className="truncate text-[var(--color-text-dim)]">{p.process ?? 'unknown'}{p.pid ? ` · pid ${p.pid}` : ''}</div>
      <div className={`text-[10px] uppercase tracking-[0.14em] ${exposureTone(p.exposure)}`}>[{p.exposure}]</div>
    </div>
  )
}

function TabButton({ id, active, label, count, onClick }: { id: Tab; active: Tab; label: string; count: number; onClick: (id: Tab) => void }) {
  const selected = id === active
  return (
    <button type="button" onClick={() => onClick(id)} className={`border min-h-10 px-3 py-2 text-xs uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] ${selected ? 'border-[var(--color-accent)] bg-[color:rgba(45,212,191,0.08)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'}`}>
      {label} <span className="text-[var(--color-text-faint)]">{count}</span>
    </button>
  )
}

export default function Services() {
  const qc = useQueryClient()
  const services = useQuery({ queryKey: ['services'], queryFn: fetchServices, refetchInterval: 15_000 })
  const launcher = useQuery({ queryKey: ['launcher'], queryFn: fetchLauncher, refetchInterval: 60_000 })
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('apps')
  const [query, setQuery] = useState('')

  const restart = useMutation({
    mutationFn: ({ kind, name }: { kind: 'container' | 'service'; name: string }) => restartService(kind, name),
    onMutate: ({ name }) => { setPendingName(name); setError(null) },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['services'] }) },
    onError: (err) => setError((err as Error).message),
    onSettled: () => setPendingName(null),
  })

  const apps = launcher.data ?? []
  const containers = services.data?.containers ?? []
  const units = services.data?.services ?? []
  const systemUnits = services.data?.systemServices ?? []
  const timers = services.data?.timers ?? []
  const ports = services.data?.ports ?? []
  const composeFiles = services.data?.composeFiles ?? []
  const allUnits = [...units, ...systemUnits]
  const runningContainers = containers.filter((c) => c.state === 'running').length
  const failedServices = allUnits.filter((s) => s.active === 'failed').length
  const publicPorts = ports.filter((p) => p.exposure === 'public').length

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => ({
    apps: q ? apps.filter((a) => `${a.name} ${a.category} ${a.owner ?? ''} ${a.url}`.toLowerCase().includes(q)) : apps,
    containers: q ? containers.filter((c) => `${c.name} ${c.image} ${c.project ?? ''} ${c.status} ${c.ports.join(' ')}`.toLowerCase().includes(q)) : containers,
    units: q ? allUnits.filter((u) => `${u.name} ${u.description} ${u.active} ${u.sub} ${u.scope ?? ''}`.toLowerCase().includes(q)) : allUnits,
    timers: q ? timers.filter((t) => `${t.name} ${t.service} ${t.next} ${t.last}`.toLowerCase().includes(q)) : timers,
    ports: q ? ports.filter((p) => `${p.protocol} ${p.local} ${p.process ?? ''} ${p.exposure}`.toLowerCase().includes(q)) : ports,
    compose: q ? composeFiles.filter((c) => `${c.project} ${c.path}`.toLowerCase().includes(q)) : composeFiles,
  }), [q, apps, containers, allUnits, timers, ports, composeFiles])

  const handleRestart = (kind: 'container' | 'service', name: string) => {
    if (!confirm(`Restart ${kind} "${name}"?`)) return
    restart.mutate({ kind, name })
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// inventory</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>services<span className="cursor-blink">_</span></h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [{apps.length} apps · {runningContainers}/{containers.length} containers · {allUnits.length} units · {ports.length} ports{publicPorts > 0 ? ` · ${publicPorts} public` : ''}{failedServices > 0 ? ` · ${failedServices} failed` : ''}]
        </div>
      </div>

      {error && <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <TabButton id="apps" active={tab} label="Apps" count={filtered.apps.length} onClick={setTab} />
        <TabButton id="containers" active={tab} label="Containers" count={filtered.containers.length} onClick={setTab} />
        <TabButton id="units" active={tab} label="Units" count={filtered.units.length} onClick={setTab} />
        <TabButton id="timers" active={tab} label="Timers" count={filtered.timers.length} onClick={setTab} />
        <TabButton id="ports" active={tab} label="Ports" count={filtered.ports.length} onClick={setTab} />
        <TabButton id="compose" active={tab} label="Compose" count={filtered.compose.length} onClick={setTab} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search everything…" className="min-w-52 flex-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]" />
      </div>

      {tab === 'apps' && <Card title={`Web apps · ${filtered.apps.length}`}>
        {launcher.isLoading && !launcher.data ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : launcher.error ? <div className="text-sm text-[var(--color-danger)]">App launcher unavailable</div> : filtered.apps.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No apps match</div> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{filtered.apps.map((app) => <AppTile key={app.id} app={app} />)}</div>}
      </Card>}

      {tab === 'containers' && <Card title={`Docker containers · ${filtered.containers.length}`}>
        {services.isLoading && !services.data ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : services.error ? <div className="text-sm text-[var(--color-danger)]">Services unavailable</div> : filtered.containers.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No containers match</div> : <div className="divide-y divide-[var(--color-border)]">{filtered.containers.map((c) => <ContainerRow key={c.id} c={c} onRestart={() => handleRestart('container', c.name)} pending={pendingName === c.name} />)}</div>}
      </Card>}

      {tab === 'units' && <Card title={`Systemd units · ${filtered.units.length}`}>
        {services.isLoading && !services.data ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : services.error ? <div className="text-sm text-[var(--color-danger)]">Services unavailable</div> : filtered.units.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No units match</div> : <div className="divide-y divide-[var(--color-border)]">{filtered.units.map((s) => <ServiceRow key={`${s.scope}-${s.name}`} s={s} onRestart={() => handleRestart('service', s.name)} pending={pendingName === s.name} canRestart={s.scope !== 'system'} />)}</div>}
      </Card>}

      {tab === 'timers' && <Card title={`Timers · ${filtered.timers.length}`}>
        {services.isLoading && !services.data ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : filtered.timers.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No timers match</div> : <div className="divide-y divide-[var(--color-border)]">{filtered.timers.map((t) => <TimerRow key={t.name} t={t} />)}</div>}
      </Card>}

      {tab === 'ports' && <Card title={`Listening ports · ${filtered.ports.length}`}>
        {services.isLoading && !services.data ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : filtered.ports.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No ports match</div> : <div className="divide-y divide-[var(--color-border)]">{filtered.ports.map((p, i) => <PortRow key={`${p.protocol}-${p.local}-${p.pid ?? 'x'}-${i}`} p={p} />)}</div>}
      </Card>}

      {tab === 'compose' && <Card title={`Compose files · ${filtered.compose.length}`}>
        {filtered.compose.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No compose files match</div> : <div className="divide-y divide-[var(--color-border)]">{filtered.compose.map((c) => <div key={c.path} className="py-2 text-sm"><div className="font-semibold text-[var(--color-text)]">{c.project}</div><div className="font-mono text-[11px] text-[var(--color-text-faint)]">{c.path}</div></div>)}</div>}
      </Card>}
    </div>
  )
}
