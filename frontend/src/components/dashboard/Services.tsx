import { useQuery } from '@tanstack/react-query'
import { fetchServices, type ServiceContainer, type ServiceUnit } from '../../lib/api'
import { toneDot } from './format'
import { Note, Section } from './Section'

// Desktop plumbing that systemd lists among odin's user services (Plasma,
// PipeWire, D-Bus, the portals). Real, but never what "is something down"
// means here, so the section leaves them to the Services page.
const DESKTOP_UNIT = /^(app-|at-spi|dbus|dconf|obex|pipewire|plasma-|wireplumber|xdg-)/

type Health = 'ok' | 'watch' | 'alert'
type Chip = { name: string; health: Health; title: string }

const containerHealth = (c: ServiceContainer): Health =>
  c.state !== 'running' ? 'alert' : /unhealthy|restarting/i.test(c.status) ? 'watch' : 'ok'
const unitHealth = (u: ServiceUnit): Health => (u.active === 'failed' ? 'alert' : 'ok')
const HEALTH_ORDER: Record<Health, number> = { alert: 0, watch: 1, ok: 2 }
// Anything wrong sorts to the top, so it is the first thing read.
const byHealth = (a: Chip, b: Chip) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name)

// One group as a line of names that wraps: denser than a grid, which left
// every column as wide as its longest name.
function ChipGroup({ label, chips }: { label: string; chips: Chip[] }) {
  if (chips.length === 0) return null
  return (
    <div className="flex min-w-0 gap-3">
      <span className="w-20 shrink-0 text-[11px] leading-5 text-[var(--color-text-faint)]">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-3.5">
        {chips.map((c) => (
          <span key={c.name} title={c.title} className="flex min-w-0 max-w-[12rem] items-center gap-1.5 text-[12px] leading-5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[c.health]}`} aria-hidden />
            <span className={`truncate ${c.health === 'ok' ? 'text-[var(--color-text-dim)]' : c.health === 'watch' ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]'}`}>{c.name}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// odin's containers and the services that matter, one dot each. The Services
// page owns restarts, logs and ports; this answers "is anything down".
export function Services() {
  // Same key as the Services page, so the two share one cache entry.
  const q = useQuery({ queryKey: ['services'], queryFn: fetchServices, refetchInterval: 30_000 })
  const containers: Chip[] = (q.data?.containers ?? [])
    .map((c) => ({ name: c.name, health: containerHealth(c), title: `${c.image} · ${c.status}` }))
    .sort(byHealth)
  const units: Chip[] = [...(q.data?.services ?? []), ...(q.data?.systemServices ?? [])]
    // Long-running services, plus anything that failed. A one-shot is left out
    // whatever its state: one that exited is done, and one a timer fires every
    // minute (lilkups-reminders) was caught mid-run and flagged as down.
    .filter((u) => !DESKTOP_UNIT.test(u.name) && (u.sub === 'running' || u.active === 'failed'))
    .map((u) => ({ name: u.name.replace(/\.service$/, ''), health: unitHealth(u), title: `${u.description} · ${u.active} (${u.sub})` }))
    .sort(byHealth)
  const total = containers.length + units.length
  const wrong = [...containers, ...units].filter((c) => c.health !== 'ok').length

  return (
    <Section
      title="services"
      to="/services"
      meta={q.data && (wrong > 0 ? <span className="text-[var(--color-danger)]">{wrong} need a look</span> : `${total} up`)}
    >
      {q.isLoading && !q.data ? (
        <Note>loading…</Note>
      ) : q.error ? (
        <Note tone="danger">service status unavailable</Note>
      ) : (
        <div className="space-y-1">
          <ChipGroup label="containers" chips={containers} />
          <ChipGroup label="services" chips={units} />
        </div>
      )}
    </Section>
  )
}
