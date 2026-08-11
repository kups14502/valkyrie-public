import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Activity as ActivityIcon, Cast, Clapperboard, Download, KeyRound, LayoutDashboard,
  Power, Server, TrendingUp,
} from 'lucide-react'
import {
  fetchImgToken, fetchMediaDownloads, fetchPlexRecent, fetchPlexServer, fetchSystem, onTailnet,
  plexHomeLink, plexImg, plexItemLink, plexWebHomeLink, type LightState,
} from '../lib/api'
import {
  PRESETS, brightnessFromPct, hexToRgb, pctFromBrightness, presetSwatchStyle, rgbToHex,
  useBrightnessThrottle, useLightsControl, useSliderSync, type LightPatch,
} from '../lib/lights'
import { isPadMode, setPadMode } from '../lib/padMode'

// iPad mode: a big-touch dashboard for the wall/coffee-table iPad. Everything
// is a large target, nothing depends on hover or the keyboard. Lights are
// controlled in full here (no drilling into the Lights page), and Plex hands
// off to the real Plex app so it can AirPlay to the TV.

const TILES = [
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/services', label: 'services', icon: Server },
  { to: '/vault', label: 'vault', icon: KeyRound },
  { to: '/activity', label: 'activity', icon: ActivityIcon },
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

// ---------- lights (full control, pad-sized) ----------

const PadPresetRow = ({ onPick, onCustom, customHex }: {
  onPick: (rgb: [number, number, number] | null, kelvin: number | null) => void
  onCustom: (rgb: [number, number, number]) => void
  customHex: string
}) => (
  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
    {PRESETS.map((p) => (
      <button
        key={p.label}
        type="button"
        onClick={() => onPick(p.rgb, p.kelvin)}
        className="flex min-h-14 items-center justify-center gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] text-sm text-[var(--color-text-dim)] active:border-[var(--color-accent)] active:text-[var(--color-text)]"
      >
        <span className="h-4 w-4 shrink-0 border border-[var(--color-border)]" style={{ backgroundColor: presetSwatchStyle(p) }} aria-hidden />
        {p.label}
      </button>
    ))}
    <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] text-sm uppercase tracking-[0.1em] text-[var(--color-text-dim)] active:border-[var(--color-accent)]">
      <span className="h-4 w-4 shrink-0 border border-[var(--color-border-strong)]" style={{ backgroundColor: customHex }} aria-hidden />
      custom
      <input
        type="color"
        value={customHex}
        onChange={(e) => { const rgb = hexToRgb(e.target.value); if (rgb) onCustom(rgb) }}
        className="sr-only"
      />
    </label>
  </div>
)

function BrightnessRow({ label, pct, syncTo, onDrag, onCommit }: {
  label: string
  pct: number | null
  // Authoritative value to push into the thumb; null while a drag owns it.
  syncTo: number | null
  onDrag: (pct: number) => void
  onCommit: (pct: number) => void
}) {
  const inputRef = useSliderSync(syncTo)
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className="uppercase tracking-[0.14em] text-[var(--color-text-dim)]">{label}</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{pct != null ? `${pct}%` : '—'}</span>
      </div>
      <input
        ref={inputRef}
        type="range"
        min={1}
        max={100}
        defaultValue={pct ?? 100}
        onInput={(e) => onDrag(Number((e.target as HTMLInputElement).value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        className="brightness-slider"
      />
    </div>
  )
}

function PadLightCard({ light, onUpdate }: { light: LightState; onUpdate: (id: string, u: LightPatch) => void }) {
  const [pendingPct, setPendingPct] = useState<number | null>(null)
  const externalPct = pctFromBrightness(light.brightness)
  const displayPct = pendingPct ?? externalPct
  const swatch = light.rgb_color ? `rgb(${light.rgb_color.join(',')})` : light.on ? '#ffd9a0' : '#1a1f2b'

  const { push, commit } = useBrightnessThrottle(
    (pct) => onUpdate(light.entity_id, { state: 'on', brightness: brightnessFromPct(pct) }),
    150,
  )

  // Safety net for changes that never fire pointerup/touchend (arrow keys):
  // once the light reports the value we're holding, stop overriding it.
  useEffect(() => {
    if (pendingPct !== null && externalPct === pendingPct) setPendingPct(null)
  }, [externalPct, pendingPct])

  return (
    <div className={`panel p-4 ${light.on ? 'border-[var(--color-warning)]' : ''} ${light.unavailable ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-block h-8 w-8 shrink-0 border border-[var(--color-border-strong)]" style={{ backgroundColor: swatch }} aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-lg text-[var(--color-text)]">{light.name}</div>
            <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
              {light.unavailable ? 'unavailable' : light.on ? 'on' : 'off'}
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={light.unavailable}
          onClick={() => onUpdate(light.entity_id, { state: light.on ? 'off' : 'on' })}
          className={`min-h-14 shrink-0 border px-6 text-sm font-semibold uppercase tracking-[0.16em] active:border-[var(--color-accent)] disabled:opacity-40 ${
            light.on
              ? 'border-[var(--color-warning)] bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
          }`}
        >
          {light.on ? 'on' : 'off'}
        </button>
      </div>

      {light.on && !light.unavailable && (
        <div className="mt-4 space-y-4">
          {/* pendingPct drives the % label mid-drag and suppresses the thumb
              sync; it clears on release, and the effect above covers inputs
              that never fire pointerup (arrow keys). */}
          <BrightnessRow
            label="brightness"
            pct={displayPct}
            syncTo={pendingPct === null ? externalPct : null}
            onDrag={(pct) => { setPendingPct(pct); push(pct) }}
            onCommit={(pct) => { commit(pct); setPendingPct(null) }}
          />
          <PadPresetRow
            customHex={rgbToHex(light.rgb_color)}
            onPick={(rgb, kelvin) => onUpdate(light.entity_id, {
              state: 'on',
              ...(rgb ? { rgb_color: rgb } : {}),
              ...(kelvin ? { color_temp_kelvin: kelvin } : {}),
            })}
            onCustom={(rgb) => onUpdate(light.entity_id, { state: 'on', rgb_color: rgb })}
          />
        </div>
      )}
    </div>
  )
}

function LightsPanel() {
  const { lights, all, anyOn, availableTargets, updateOne, bulk, bulkBrightness, bulkPreset } = useLightsControl()
  const [bulkPct, setBulkPct] = useState<number | null>(null)
  const [bulkHex, setBulkHex] = useState('#ffb87a')
  const { push: bulkPush, commit: bulkCommit } = useBrightnessThrottle(bulkBrightness, 200)

  const bulkDisplayPct = useMemo(() => {
    if (bulkPct !== null) return bulkPct
    const on = all.filter((l) => !l.unavailable && l.on && l.brightness != null)
    if (!on.length) return null
    return Math.round(on.reduce((sum, l) => sum + pctFromBrightness(l.brightness), 0) / on.length)
  }, [bulkPct, all])

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

  return (
    <section>
      <SectionTitle
        action={
          <button
            type="button"
            disabled={!availableTargets.length}
            onClick={() => bulk(anyOn ? 'off' : 'on')}
            className="flex min-h-14 items-center gap-2 border border-[var(--color-border)] px-6 text-sm uppercase tracking-[0.14em] text-[var(--color-text-dim)] active:border-[var(--color-accent)] active:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Power size={18} /> all {anyOn ? 'off' : 'on'}
          </button>
        }
      >
        lights
      </SectionTitle>

      {availableTargets.length === 0 ? (
        <div className="panel p-4 text-sm text-[var(--color-warning)]">
          All lights unavailable. Home Assistant can't reach any bulb.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Bulk row first: on the pad, "set the whole room" is the common move. */}
          <div className="panel p-4">
            <div className="mb-3 text-xs uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              all {availableTargets.length} lights
            </div>
            <div className="space-y-4">
              <BrightnessRow
                label="brightness"
                pct={bulkDisplayPct}
                syncTo={bulkPct === null ? bulkDisplayPct : null}
                onDrag={(pct) => { setBulkPct(pct); bulkPush(pct) }}
                onCommit={(pct) => { bulkCommit(pct); setBulkPct(null) }}
              />
              <PadPresetRow
                customHex={bulkHex}
                onPick={bulkPreset}
                onCustom={(rgb) => { setBulkHex(rgbToHex(rgb)); bulkPreset(rgb, null) }}
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {[...all]
              .sort((a, b) => Number(a.unavailable) - Number(b.unavailable))
              .map((l) => <PadLightCard key={l.entity_id} light={l} onUpdate={updateOne} />)}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- plex ----------

function usePlexImgToken() {
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
  const imagesReady = usePlexImgToken()
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
      <SectionTitle>recently added{machineId ? ' · tap to open in plex' : ''}</SectionTitle>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {recent.data.map((item) => {
          const href = machineId ? plexItemLink(machineId, item.ratingKey) : undefined
          const Inner = (
            <>
              <div className="aspect-[2/3] w-full overflow-hidden bg-[var(--color-surface-2)]">
                {item.thumb && <img src={plexImg(item.thumb, 220)} alt={item.title} loading="lazy" className="h-full w-full object-cover" />}
              </div>
              <div className="truncate p-2 text-xs text-[var(--color-text)]">{item.title}</div>
            </>
          )
          const cls = 'w-32 shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)] text-left active:border-[var(--color-accent)]'
          // With a known server, go straight to Plex (that's the AirPlay path).
          // No target=_blank: a plex:// scheme link must navigate in place, or
          // iOS opens a blank tab behind the app.
          // Otherwise fall back to browsing inside Valkyrie.
          return href ? (
            <a key={item.ratingKey} href={href} className={cls}>{Inner}</a>
          ) : (
            <PadBrowseFallback key={item.ratingKey} className={cls}>{Inner}</PadBrowseFallback>
          )
        })}
      </div>
    </section>
  )
}

function PadBrowseFallback({ className, children }: { className: string; children: React.ReactNode }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate('/plex')} className={className}>{children}</button>
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

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Clock />
        <SystemChips />
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* Watch on the TV: hands off to the Plex app, which can AirPlay.
            Valkyrie itself can't cast, so this is the honest route. */}
        <a
          href={plexHomeLink()}
          className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.06)] active:bg-[rgba(var(--color-accent-rgb),0.14)]"
        >
          <Cast size={34} className="text-[var(--color-accent)]" style={{ filter: 'drop-shadow(0 0 8px var(--color-accent))' }} />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">watch on tv</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">opens plex · airplay</span>
        </a>
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] active:border-[var(--color-accent)]"
        >
          <LayoutDashboard size={34} className="text-[var(--color-text-dim)]" />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text-dim)]">full dashboard</span>
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

      {/* A plex:// link silently does nothing when the app isn't installed, so
          always leave a working way through to Plex Web. */}
      <p className="-mt-4 text-center text-xs text-[var(--color-text-faint)]">
        watch on tv opens the Plex app, then AirPlay from its player ·{' '}
        <a href={plexWebHomeLink()} target="_blank" rel="noreferrer" className="underline hover:text-[var(--color-text-dim)]">
          plex web
        </a>
      </p>

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
