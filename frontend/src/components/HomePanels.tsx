import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Download, Power } from 'lucide-react'
import {
  fetchImgToken, fetchMediaDownloads, fetchPlexRecent, fetchPlexServer, fetchSystem, onTailnet,
  openInApp, plexAppItemLink, plexImg, plexWatchLink, plexWebItemLink, shouldDeferAppClick,
} from '../lib/api'
import { pctFromBrightness, useLightsControl } from '../lib/lights'
import { AllLightsControl, LightControl } from './LightControl'

// Panels shared by the two home screens: the iPad's pad dashboard and the
// iPhone's. Sizing and column counts come from props so each screen can lay them
// out for its own hardware without a second copy of the logic.

export type PanelSize = 'normal' | 'pad'

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
        &gt; {children}
      </h2>
      {action}
    </div>
  )
}

export function Clock() {
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

// Phone variant: the iPad's clock is a full-height hero, which on a 390px screen
// would push everything useful below the fold.
export function PhoneClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="select-none">
      <div className="text-4xl font-bold tabular-nums tracking-tight text-[var(--color-text)]">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="cursor-blink text-[var(--color-accent)]">_</span>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-dim)]">
        {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
      </div>
    </div>
  )
}

export function SystemChips() {
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

const LIGHTS_OPEN_KEY = 'valkyrie-pad-lights-open'

export function LightsPanel({ size }: { size: PanelSize }) {
  const { lights, all, anyOn, availableTargets, updateOne, bulk, bulkBrightness, bulkPreset } = useLightsControl()
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(LIGHTS_OPEN_KEY) !== '0' } catch { return true }
  })
  const toggle = () => setOpen((v) => {
    const next = !v
    try { localStorage.setItem(LIGHTS_OPEN_KEY, next ? '1' : '0') } catch { /* ignore */ }
    return next
  })

  const avgPct = useMemo(() => {
    const on = all.filter((l) => !l.unavailable && l.on && l.brightness != null)
    if (!on.length) return null
    return Math.round(on.reduce((sum, l) => sum + pctFromBrightness(l.brightness), 0) / on.length)
  }, [all])

  const ordered = useMemo(
    () => [...all].sort((a, b) => Number(a.unavailable) - Number(b.unavailable)),
    [all],
  )

  if (lights.isLoading && !lights.data) return null
  if (lights.error) {
    return (
      <section>
        <SectionTitle>lights</SectionTitle>
        <div className="panel p-4 text-sm text-[var(--color-danger)]">Home Assistant unreachable</div>
      </section>
    )
  }
  if (!all.length) return null

  const onCount = all.filter((l) => l.on).length
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-h-11 items-center gap-2"
        >
          <ChevronDown
            size={15}
            className={`text-[var(--color-accent)] transition-transform ${open ? '' : '-rotate-90'}`}
            aria-hidden
          />
          <span className="text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
            &gt; lights
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
            {onCount} of {all.length} on
          </span>
        </button>
        {/* All on/off stays reachable with the section collapsed. */}
        {availableTargets.length > 0 && (
          <button
            type="button"
            onClick={() => bulk(anyOn ? 'off' : 'on')}
            className="flex min-h-11 items-center gap-2 border border-[var(--color-border)] px-5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] active:border-[var(--color-accent)] active:text-[var(--color-accent)]"
          >
            <Power size={15} /> all {anyOn ? 'off' : 'on'}
          </button>
        )}
      </div>

      {open && (availableTargets.length === 0 ? (
        <div className="panel p-4 text-sm text-[var(--color-warning)]">
          All lights unavailable. Home Assistant can't reach any bulb.
        </div>
      ) : (
        <div className="space-y-4">
          {availableTargets.length > 1 && (
            <AllLightsControl
              size={size}
              count={availableTargets.length}
              anyOn={anyOn}
              avgPct={avgPct}
              onToggleAll={bulk}
              onBrightness={bulkBrightness}
              onPreset={bulkPreset}
            />
          )}
          {/* compact: each bulb is one row until tapped, so all five are
              visible at once instead of two expanded cards filling the screen. */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {ordered.map((l) => (
              <LightControl key={l.entity_id} light={l} onUpdate={updateOne} size={size} compact />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function usePlexImagesReady() {
  const imgTok = useQuery({
    queryKey: ['plex-img-token'],
    queryFn: fetchImgToken,
    enabled: !onTailnet,
    refetchInterval: 6 * 3600_000,
    staleTime: Infinity,
    retry: 1,
  })
  return onTailnet || imgTok.isFetched
}

export function RecentStrip({ width = 'w-32' }: { width?: string } = {}) {
  const navigate = useNavigate()
  const imagesReady = usePlexImagesReady()
  const server = useQuery({ queryKey: ['plex-server'], queryFn: fetchPlexServer, staleTime: Infinity, retry: 1 })
  const recent = useQuery({
    queryKey: ['plex-recent-pad'],
    queryFn: () => fetchPlexRecent(12),
    refetchInterval: 120_000,
    retry: false,
    enabled: imagesReady,
  })
  if (!recent.data?.length) return null
  const machineId = server.data?.machineIdentifier

  return (
    <section>
      <SectionTitle>recently added{machineId ? ' · tap to play in plex' : ''}</SectionTitle>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {recent.data.map((item) => {
          const inner = (
            <>
              <div className="aspect-[2/3] w-full overflow-hidden bg-[var(--color-surface-2)]">
                {item.thumb && <img src={plexImg(item.thumb, 220)} alt={item.title} loading="lazy" className="h-full w-full object-cover" />}
              </div>
              <div className="truncate p-2 text-xs text-[var(--color-text)]">{item.title}</div>
            </>
          )
          const cls = `${width} shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)] text-left active:border-[var(--color-accent)]`
          // A plain link tap to watch.plex.tv: iOS matches it against Plex's
          // associated domain and opens the app on this title. Intercepting it
          // in JS would defeat that, so there is deliberately no onClick here.
          if (item.watchPath) {
            return (
              <a key={item.ratingKey} href={plexWatchLink(item.watchPath)} className={cls}>
                {inner}
              </a>
            )
          }
          if (!machineId) {
            return (
              <button key={item.ratingKey} type="button" onClick={() => navigate('/plex')} className={cls}>
                {inner}
              </button>
            )
          }
          // No catalog match (personal media): try the scheme, then Plex Web.
          return (
            <a
              key={item.ratingKey}
              href={plexWebItemLink(machineId, item.ratingKey)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (shouldDeferAppClick(e)) return
                e.preventDefault()
                openInApp(plexAppItemLink(machineId, item.ratingKey), plexWebItemLink(machineId, item.ratingKey))
              }}
              className={cls}
            >
              {inner}
            </a>
          )
        })}
      </div>
    </section>
  )
}

export function DownloadsPanel() {
  const downloads = useQuery({
    queryKey: ['media-downloads'],
    queryFn: fetchMediaDownloads,
    refetchInterval: 15_000,
    retry: false,
  })
  if (!downloads.data?.length) return null
  return (
    <section>
      <SectionTitle>
        <span className="inline-flex items-center gap-2"><Download size={13} /> downloading</span>
      </SectionTitle>
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

