import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity as ActivityIcon, Clapperboard, Download, KeyRound, LayoutDashboard, Lightbulb,
  Power, Server, TrendingUp,
} from 'lucide-react'
import {
  fetchImgToken, fetchLights, fetchMediaDownloads, fetchPlexRecent, fetchSystem, onTailnet,
  plexImg, setLight, type LightState,
} from '../lib/api'

// Pad mode: a big-button, glanceable launcher built for the iPad on the wall /
// coffee table. Everything is a large touch target; no hover, no keyboard.
// "make default" pins it as the screen the app opens on (per device).

const PAD_KEY = 'valkyrie-pad'
export const isPadDefault = () => {
  try { return localStorage.getItem(PAD_KEY) === '1' } catch { return false }
}

const TILES = [
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/lights', label: 'lights', icon: Lightbulb },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/services', label: 'services', icon: Server },
  { to: '/vault', label: 'vault', icon: KeyRound },
  { to: '/activity', label: 'activity', icon: ActivityIcon },
]

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="select-none">
      <div className="text-6xl font-bold tabular-nums tracking-tight text-[var(--color-text)] sm:text-7xl">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="cursor-blink text-[var(--color-accent)]">_</span>
      </div>
      <div className="mt-1 text-sm uppercase tracking-[0.3em] text-[var(--color-text-dim)]">
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  )
}

function SystemChips() {
  const system = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const s = system.data
  if (!s) return null
  const chip = (label: string, value: string, warn: boolean) => (
    <div className={`border px-4 py-3 text-center ${warn ? 'border-[var(--color-warning)] text-[var(--color-warning)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] opacity-80">{label}</div>
    </div>
  )
  return (
    <div className="flex gap-2">
      {chip('cpu', `${Math.round(s.cpu.usage)}%`, s.cpu.usage > 85)}
      {chip('mem', `${Math.round(s.memory.percent)}%`, s.memory.percent > 90)}
      {chip('disk', `${Math.round(s.disk.percent)}%`, s.disk.percent > 90)}
    </div>
  )
}

function LightsPanel() {
  const queryClient = useQueryClient()
  const lights = useQuery({ queryKey: ['lights'], queryFn: fetchLights })
  const mutate = useMutation({
    mutationFn: setLight,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['lights'] }),
  })
  const available = useMemo(() => (lights.data ?? []).filter((l: LightState) => !l.unavailable), [lights.data])
  if (available.length === 0) return null
  const allIds = available.map((l) => l.entity_id)
  const anyOn = available.some((l) => l.on)

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>&gt; lights</h2>
        <button
          type="button"
          onClick={() => mutate.mutate({ entity_id: allIds, state: anyOn ? 'off' : 'on' })}
          className="flex min-h-14 items-center gap-2 border border-[var(--color-border)] px-5 text-sm uppercase tracking-[0.14em] text-[var(--color-text-dim)] active:border-[var(--color-accent)] active:text-[var(--color-accent)]"
        >
          <Power size={18} /> all {anyOn ? 'off' : 'on'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {available.map((l) => (
          <button
            key={l.entity_id}
            type="button"
            onClick={() => mutate.mutate({ entity_id: l.entity_id, state: l.on ? 'off' : 'on' })}
            className={`flex min-h-20 items-center gap-3 border px-4 text-left transition-colors ${
              l.on
                ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.1)]'
                : 'border-[var(--color-border)] active:border-[var(--color-accent)]/50'
            }`}
          >
            <Lightbulb
              size={26}
              className={l.on ? 'shrink-0 text-[var(--color-accent)]' : 'shrink-0 text-[var(--color-text-faint)]'}
              style={l.on ? { filter: 'drop-shadow(0 0 6px var(--color-accent))' } : undefined}
            />
            <span className="min-w-0">
              <span className="block truncate text-base text-[var(--color-text)]">{l.name}</span>
              <span className="block text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">{l.on ? 'on' : 'off'}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function RecentStrip() {
  const navigate = useNavigate()
  // Posters need the image-scoped token unless we're on the tailnet (where the
  // backend trusts us by socket address).
  const imgTok = useQuery({
    queryKey: ['plex-img-token'],
    queryFn: fetchImgToken,
    enabled: !onTailnet,
    refetchInterval: 6 * 3600_000,
    staleTime: Infinity,
    retry: 1,
  })
  const recent = useQuery({
    queryKey: ['plex-recent-pad'],
    queryFn: () => fetchPlexRecent(12),
    refetchInterval: 120_000,
    retry: false,
    enabled: onTailnet || imgTok.isFetched,
  })
  if (!recent.data?.length) return null
  return (
    <section>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>&gt; recently added</h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {recent.data.map((item) => (
          <button
            key={item.ratingKey}
            type="button"
            onClick={() => navigate('/plex')}
            className="w-28 shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)] text-left active:border-[var(--color-accent)]/60"
          >
            <div className="aspect-[2/3] w-full overflow-hidden bg-[var(--color-surface-2)]">
              {item.thumb && <img src={plexImg(item.thumb, 200)} alt={item.title} loading="lazy" className="h-full w-full object-cover" />}
            </div>
            <div className="truncate p-1.5 text-[11px] text-[var(--color-text)]">{item.title}</div>
          </button>
        ))}
      </div>
    </section>
  )
}

function DownloadsPanel() {
  const downloads = useQuery({
    queryKey: ['media-downloads'],
    queryFn: fetchMediaDownloads,
    refetchInterval: 15_000,
    retry: false,
  })
  if (!downloads.data?.length) return null
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
        <Download size={13} /> &gt; downloading
      </h2>
      <ul className="space-y-3">
        {downloads.data.map((d, i) => (
          <li key={`${d.title}-${i}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-[var(--color-text)]">{d.title}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-faint)]">{d.progress}%</span>
            </div>
            <div className="mt-1 h-2 w-full bg-[var(--color-surface-2)]">
              <div className="h-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]" style={{ width: `${d.progress}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function Pad() {
  const navigate = useNavigate()
  const [padDefault, setPadDefault] = useState(isPadDefault)
  const toggleDefault = () => {
    const next = !padDefault
    try { next ? localStorage.setItem(PAD_KEY, '1') : localStorage.removeItem(PAD_KEY) } catch { /* ignore */ }
    setPadDefault(next)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Clock />
        <SystemChips />
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] active:border-[var(--color-accent)]"
        >
          <LayoutDashboard size={34} className="text-[var(--color-text-dim)]" />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text-dim)]">dashboard</span>
        </button>
        {TILES.map(({ to, label, icon: Icon }) => (
          <button
            key={to}
            type="button"
            onClick={() => navigate(to)}
            className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.08)]"
          >
            <Icon size={34} className="text-[var(--color-accent)]" style={{ filter: 'drop-shadow(0 0 8px var(--color-accent))' }} />
            <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">{label}</span>
          </button>
        ))}
      </section>

      <LightsPanel />
      <DownloadsPanel />
      <RecentStrip />

      <div className="border-t border-[var(--color-border)] pt-4 text-center">
        <button
          type="button"
          onClick={toggleDefault}
          className={`min-h-12 border px-6 text-xs uppercase tracking-[0.16em] ${
            padDefault
              ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
          }`}
        >
          {padDefault ? '✓ opens in pad mode — tap to unpin' : 'make pad mode the start screen'}
        </button>
      </div>
    </div>
  )
}
