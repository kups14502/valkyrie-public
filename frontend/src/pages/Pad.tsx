import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Cast, Clapperboard, Download, Film, Music,
  Power, Server, TrendingUp, ChevronDown,
} from 'lucide-react'
import {
  fetchImgToken, fetchMediaDownloads, fetchPlexRecent, fetchPlexServer, fetchSystem, onTailnet,
  openInApp, plexAppHomeLink, plexAppItemLink, plexImg, plexWebHomeLink, plexWebItemLink,
  shouldDeferAppClick, spotifyAppLink, spotifyWebLink,
} from '../lib/api'
import { pctFromBrightness, useLightsControl } from '../lib/lights'
import { AllLightsControl, LightControl } from '../components/LightControl'
import { isPadMode, setPadMode } from '../lib/padMode'

// iPad mode: a big-touch dashboard for the wall/coffee-table iPad. Everything is
// a large target, nothing depends on hover or a keyboard. Lights are controlled
// in full here, and Plex hands off to the Plex app so it can AirPlay to the TV.

// Six tiles in a three-wide grid: two even rows. Two open native apps (below),
// these four navigate. Everything else stays in the nav menu.
const TILES = [
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/services', label: 'services', icon: Server },
  { to: '/slop', label: 'slop', icon: Film },
]

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xs font-bold uppercase tracking-[0.24em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
        &gt; {children}
      </h2>
      {action}
    </div>
  )
}

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

const LIGHTS_OPEN_KEY = 'valkyrie-pad-lights-open'

function LightsPanel() {
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
              size="pad"
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
              <LightControl key={l.entity_id} light={l} onUpdate={updateOne} size="pad" compact />
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

function RecentStrip() {
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
          const cls = 'w-32 shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)] text-left active:border-[var(--color-accent)]'
          if (!machineId) {
            return (
              <button key={item.ratingKey} type="button" onClick={() => navigate('/plex')} className={cls}>
                {inner}
              </button>
            )
          }
          // href is the web player so a long-press/no-JS still goes somewhere
          // real; the click prefers the Plex app.
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

export default function Pad() {
  const navigate = useNavigate()
  const [padMode, setPadModeState] = useState(isPadMode)

  const toggleMode = () => {
    const next = !padMode
    setPadMode(next)
    setPadModeState(next)
  }

  const tileCls = 'flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.08)]'

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Clock />
        <SystemChips />
      </div>

      <section className="grid grid-cols-3 gap-3">
        {/* Watch on the TV: hands off to the Plex app, which can AirPlay.
            Valkyrie itself can't cast, so this is the honest route. */}
        <a
          href={plexWebHomeLink()}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (shouldDeferAppClick(e)) return
            e.preventDefault()
            openInApp(plexAppHomeLink(), plexWebHomeLink())
          }}
          className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.06)] transition-colors active:bg-[rgba(var(--color-accent-rgb),0.14)]"
        >
          <Cast size={34} className="text-[var(--color-accent)]" style={{ filter: 'drop-shadow(0 0 8px var(--color-accent))' }} />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">watch on tv</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">opens plex</span>
        </a>
        <a
          href={spotifyWebLink()}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (shouldDeferAppClick(e)) return
            e.preventDefault()
            openInApp(spotifyAppLink(), spotifyWebLink())
          }}
          className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.06)] transition-colors active:bg-[rgba(var(--color-accent-rgb),0.14)]"
        >
          <Music size={34} className="text-[var(--color-accent)]" style={{ filter: 'drop-shadow(0 0 8px var(--color-accent))' }} />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">music</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">opens spotify</span>
        </a>
        {TILES.map(({ to, label, icon: Icon }) => (
          <button key={to} type="button" onClick={() => navigate(to)} className={tileCls}>
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
          onClick={toggleMode}
          className={`min-h-14 border px-6 text-sm uppercase tracking-[0.16em] ${
            padMode
              ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
          }`}
        >
          {padMode ? '✓ ipad mode on — this is your dashboard' : 'turn on ipad mode for this device'}
        </button>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-[var(--color-text-faint)]">
          {padMode
            ? 'Valkyrie opens here and the home button up top returns here. Only this device.'
            : 'Makes this the screen Valkyrie opens on, and points the home button here. Only this device.'}
        </p>
      </div>
    </div>
  )
}
