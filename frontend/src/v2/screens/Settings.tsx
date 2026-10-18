import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Type } from 'lucide-react'
import { firstPaint, useShell } from '../kit/shell'
import { SCHEMES, accentOf, useAccent, useSetting } from '../kit/theme'
import { isReducedMotion, prefersReducedMotion, useReducedMotion, type MotionSetting } from '../kit/motion'
import { Glyph, Press, cx, toast } from '../kit/ui'
import { Icon, type IconName, type IconTone } from '../kit/icons'
import {
  ago, firstDataMs, firstLiveMs, useCalendar, useHosts, useLatencies, useLaunchTargets, useLive, useTick, useTracker,
  type Latency,
} from '../kit/data'
import { apiErrorText, fetchPlexLibrary, fetchPlexServer } from '../../lib/api'
import { clearToken, isTauri, setAuthSkipped } from '../../lib/auth'
import { useBuildUpdate } from '../../lib/buildCheck'
import { resolveProfile, setDeviceMode, useProfile, type DeviceMode } from '../../lib/deviceMode'
import {
  currentSubscriptionId, disablePush, enablePush, fetchPushStatus, forgetPushDevice, isStandalone, pushBlockedReason, sendPushTest,
} from '../../lib/push'
import { Hero, useHeroId, type HeroId } from '../kit/hero'
import './settings.css'

// Settings (/m/settings, the strip's gear): glass plates for Valkyrie's own
// settings, each led by a line icon under an uppercase tracked label. Appearance is Valkyrie's scheme picker
// (src/components/ThemePicker.tsx): its presets as a grid of plates, each with
// its color dot, plus a custom hex, stored under Valkyrie's 'valkyrie-accent'.
// Then font, motion, hero, density and this device's profile, the classic
// header menu's functions as rows (Notifications with this device on or off and
// the device list, Build with the version, the Plex link test, Classic, Slop,
// Sign out), then Speed: how fast real data reached the
// screen and what every Valkyrie source costs right now. Icons glow only when
// lit; the rest stay dim. SettingsScreen is the shell's full screen: the small
// hero sits in the gutter beside the two-cell plates, so Appearance morphs it in view.

type Vars = CSSProperties & Record<`--${string}`, string | number>

/** a plate cell: label, an icon when the choice is a thing, a font to draw the label in */
type Opt<T extends string> = { value: T; label: string; icon?: IconName; font?: string }

/** scheme grid columns (5 x 2 for the 10 schemes) */
const COLS = 5
/** '#00FFE5' or '00ffe5' -> '#00ffe5'; anything else null */
const normHex = (raw: string): string | null => {
  const m = /^#?([a-f\d]{6})$/i.exec(raw.trim())
  return m ? `#${m[1].toLowerCase()}` : null
}

type FontId = 'mono' | 'sans'
const FONTS: Opt<FontId>[] = [
  { value: 'mono', label: 'Mono', font: "'JetBrains Mono', ui-monospace, monospace" },
  { value: 'sans', label: 'Sans', font: "'Inter Tight', ui-sans-serif, system-ui, sans-serif" },
]
const FONT_VALUES = FONTS.map((f) => f.value)
const MOTION: Opt<MotionSetting>[] = [
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
]
// phone and tablet are models only: they do not report to /api/hosts yet
const HERO: Opt<HeroId>[] = [
  { value: 'thor', label: 'Thor', icon: 'thor' },
  { value: 'odin', label: 'Odin', icon: 'odin' },
  { value: 'phone', label: 'Phone', icon: 'phone' },
  { value: 'tablet', label: 'Tablet', icon: 'tablet' },
]
type Density = 'compact' | 'comfortable'
const DENSITY: Opt<Density>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
]
// Valkyrie's per-device profile (src/lib/deviceMode, the classic Settings' "this
// device"): which screen it opens on and how big the touch controls are.
const DEVICE: Opt<DeviceMode>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'desktop', label: 'Desktop', icon: 'thor' },
  { value: 'iphone', label: 'iPhone', icon: 'phone' },
  { value: 'ipad', label: 'iPad', icon: 'tablet' },
  { value: 'vr', label: 'VR', icon: 'frame' },
]
const DEVICE_NAME: Record<Exclude<DeviceMode, 'auto'>, string> = { desktop: 'Desktop', iphone: 'iPhone', ipad: 'iPad', vr: 'VR' }
// v2 is the UI on the desktop, the phone and the iPad; the headset keeps its VR workspace (lib/deviceMode)
const OPENS_ON: Record<Exclude<DeviceMode, 'auto'>, string> = {
  desktop: 'the dashboard', iphone: 'the dashboard', ipad: 'the dashboard', vr: 'the VR workspace, large controls',
}
// Settings > Classic: the classic UI's own home for this device
const CLASSIC_NOTE: Record<Exclude<DeviceMode, 'auto'>, string> = {
  desktop: 'The previous dashboard', iphone: 'The previous phone home', ipad: 'The previous iPad home', vr: 'The VR workspace',
}

function deviceNote(mode: DeviceMode): { long: string; short: string | null } {
  const p = resolveProfile(mode)
  const opens = `opens on ${OPENS_ON[p.resolved]}`
  // Auto is the lit cell beside it, so the note only names what it resolved to
  if (mode === 'auto') return { long: `${DEVICE_NAME[p.resolved]} · ${opens}`, short: `Auto: ${DEVICE_NAME[p.resolved]}` }
  return { long: opens[0].toUpperCase() + opens.slice(1), short: p.resolved === 'vr' ? 'VR workspace' : null }
}

// ---------- speed probes (module scope, so they see the boot before React does) ----------

const PREFIX = 'v2.q.'
type CacheMark = { key: string; at: number; bytes: number }
/** one finished request from Resource Timing, ms since navigation start */
type Net = { start: number; sent: number; end: number; ms: number; bytes: number; status: number }
type SpeedStore = {
  /** v2.q.* as it was when the page booted: what each source painted from */
  boot: Map<string, CacheMark>
  /** the first finished request per API path: the page load */
  first: Map<string, Net>
  /** the newest finished request per API path */
  last: Map<string, Net>
  version: number
  listeners: Set<() => void>
}

function readMarks(): CacheMark[] {
  const out: CacheMark[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(PREFIX)) continue
      const raw = localStorage.getItem(k) ?? ''
      // writeCache stores {"at":<ms>,"data":...}: read `at` without parsing the payload
      const m = /^\{"at":(\d+)/.exec(raw)
      let at = m ? Number(m[1]) : 0
      if (!m) { try { at = Number((JSON.parse(raw) as { at?: number }).at) || 0 } catch { /* not ours */ } }
      out.push({ key: k.slice(PREFIX.length), at, bytes: raw.length })
    }
  } catch { /* storage unavailable */ }
  return out
}

/** '/api/plex/recent?limit=30' -> '/plex/recent' (the same path kit/data's latency map uses) */
function apiPath(url: string): string | null {
  try {
    const u = new URL(url, window.location.href)
    if (u.origin !== window.location.origin || !u.pathname.startsWith('/api/')) return null
    return u.pathname.slice(4)
  } catch {
    return null
  }
}

// Network time per request from Resource Timing (request sent to last byte),
// which leaves out time the page's main thread was busy. A PerformanceObserver
// keeps receiving entries after the browser's 250-entry timeline buffer is
// full, so a Settings tab left open for an hour still measures. Failures and
// requests in flight come from kit/data's useLatencies.
function createStore(): SpeedStore {
  const s: SpeedStore = { boot: new Map(readMarks().map((m) => [m.key, m])), first: new Map(), last: new Map(), version: 0, listeners: new Set() }
  const take = (list: PerformanceEntryList) => {
    let changed = false
    for (const raw of list) {
      const e = raw as PerformanceResourceTiming & { responseStatus?: number }
      if (e.initiatorType !== 'xmlhttprequest' && e.initiatorType !== 'fetch') continue
      const path = apiPath(e.name)
      if (!path || !(e.responseEnd > 0)) continue
      const sent = e.requestStart || e.startTime
      const net: Net = { start: e.startTime, sent, end: e.responseEnd, ms: e.responseEnd - sent, bytes: e.decodedBodySize || e.encodedBodySize || 0, status: e.responseStatus ?? 0 }
      const first = s.first.get(path)
      if (!first || net.start < first.start) s.first.set(path, net)
      const last = s.last.get(path)
      if (!last || net.start >= last.start) s.last.set(path, net)
      changed = true
    }
    if (changed) {
      s.version++
      s.listeners.forEach((l) => l())
    }
  }
  try {
    new PerformanceObserver((l) => take(l.getEntries())).observe({ type: 'resource', buffered: true })
  } catch {
    take(performance.getEntriesByType('resource'))
  }
  return s
}

// kept in the hot-reload data so a hot reload of this file keeps the boot
// snapshot and does not add a second observer
const speed: SpeedStore = (import.meta.hot?.data.speed as SpeedStore | undefined) ?? createStore()
if (import.meta.hot) import.meta.hot.data.speed = speed

const subscribeSpeed = (l: () => void) => {
  speed.listeners.add(l)
  return () => { speed.listeners.delete(l) }
}
const subscribeNone = () => () => {}
/** re-render on every finished request, only while the screen is visible */
const useSpeedVersion = (on: boolean) => useSyncExternalStore(on ? subscribeSpeed : subscribeNone, () => speed.version, () => 0)

// ---------- sources: one row per Valkyrie view model, its API paths and cache keys ----------

type SourceDef = { id: string; name: string; icon: IconName; keys: RegExp; paths: RegExp; count?: boolean }
const NONE = /$^/
const SOURCES: SourceDef[] = [
  { id: 'sessions', name: 'Sessions', icon: 'claude', keys: /^sessions$/, paths: /^\/session-board$/ },
  { id: 'calendar', name: 'Calendar', icon: 'calendar', keys: /^calendar\d+$/, paths: /^\/calendar\// },
  { id: 'tracker', name: 'Tracker', icon: 'supplements', keys: /^tracker$|^[a-z]+Skips$/, paths: /^\/(supplements|exercise|sf)\/(day|skips)$|^\/daily\/streak$/ },
  { id: 'targets', name: 'Quick start', icon: 'start', keys: /^targets$|^claude\.targets\./, paths: /^\/hosts\/[^/]+\/launch-targets$/ },
  { id: 'sessionHosts', name: 'Session hosts', icon: 'thor', keys: /^claude\.sessionHosts$/, paths: /^\/session-hosts$/ },
  { id: 'hosts', name: 'Hosts', icon: 'system', keys: /^hosts$/, paths: /^\/hosts$/ },
  { id: 'usage', name: 'AI usage', icon: 'gauge', keys: /^usage$/, paths: /^\/ai-usage$/ },
  { id: 'projects', name: 'Projects', icon: 'projects', keys: /^(projects|claude\.projects)$/, paths: /^\/proj$/ },
  { id: 'projdoc', name: 'Project detail', icon: 'projects', keys: /^projdoc\./, paths: /^\/proj\/[^/]+$/, count: true },
  { id: 'lights', name: 'Lights', icon: 'lights', keys: /^lights$/, paths: /^\/lights$/ },
  { id: 'thorRgb', name: 'Thor RGB', icon: 'lights', keys: /^thorRgb$/, paths: /^\/hosts\/[^/]+\/rgb$/ },
  { id: 'services', name: 'Services', icon: 'service', keys: /^services(Sys)?$/, paths: /^\/services$/ },
  { id: 'launcher', name: 'Launcher', icon: 'start', keys: /^launcher(Sys)?$/, paths: /^\/launcher$/ },
  { id: 'trade', name: 'Trade bot', icon: 'trades', keys: /^trade(Sys)?$/, paths: /^\/tradebot\// },
  { id: 'plex', name: 'Plex added', icon: 'watch', keys: /^(plexRecent|plexRich|mediaWatch)$/, paths: /^\/plex\/recent$/ },
  { id: 'plexSections', name: 'Plex libraries', icon: 'movie', keys: /^plexSections$/, paths: /^\/plex\/sections$/ },
  { id: 'music', name: 'Music', icon: 'music', keys: /^(musicRecent|mediaMusic)$/, paths: /^\/plex\/music\/recent$/ },
  { id: 'requests', name: 'Requests', icon: 'download', keys: /^mediaQueue$/, paths: /^\/plex\/(requests|downloads)$/ },
  { id: 'push', name: 'Notifications', icon: 'alert', keys: /^push$/, paths: /^\/push\/status$/ },
]
/** a source nobody listed: a generic network icon */
const OTHER_ICON: IconName = 'online'
const humanize = (key: string) => {
  const s = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}
// A source no one listed here still gets one row: an unknown cache key joins the
// unknown path with the same letters ('fooBar' and '/foo/bar'), else its own row.
const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const sourceForPath = (path: string): SourceDef =>
  SOURCES.find((s) => s.paths.test(path)) ?? { id: `x:${letters(path)}`, name: path.replace(/^\//, ''), icon: OTHER_ICON, keys: NONE, paths: NONE }
const sourceForKey = (key: string): SourceDef => {
  const fam = key.split('.')[0]
  return SOURCES.find((s) => s.keys.test(key)) ?? { id: `x:${letters(fam)}`, name: humanize(fam), icon: OTHER_ICON, keys: NONE, paths: NONE }
}

type Phase = 'pending' | 'done' | 'failed'
/** the source's share of the page load, ms since navigation start; end null while still waiting */
type Lane = { start: number; sent: number; end: number | null; failed: boolean }
type PathVM = { path: string; phase: Phase; ms: number | null; bytes: number; status: number; flight: number | null }
type SourceRow = {
  id: string
  name: string
  icon: IconName
  paths: PathVM[]
  /** pending = no answer yet this page load; idle = cached but not asked this visit */
  state: 'pending' | 'failed' | 'done' | 'idle'
  /** newest network ms (the slowest of its paths) */
  ms: number | null
  /** ms the request now in flight has been waiting */
  flight: number | null
  status: number
  bytes: number
  /** ms epoch of the newest measurement (blinks the dot) */
  measuredAt: number
  lane: Lane | null
  /** age of the cache this source painted from at boot; null = nothing cached */
  atPaint: number | null
  /** ms epoch of the newest good copy in the cache now */
  cacheAt: number | null
  cacheBytes: number
  cacheKeys: number
}

function buildRows(lat: Latency[], current: Map<string, CacheMark>, paintEpoch: number, bootCut: number, nowEpoch: number): SourceRow[] {
  const origin = performance.timeOrigin
  const rows = new Map<string, SourceRow>()
  const row = (def: SourceDef): SourceRow => {
    let r = rows.get(def.id)
    if (!r) {
      r = { id: def.id, name: def.name, icon: def.icon, paths: [], state: 'idle', ms: null, flight: null, status: 0, bytes: 0, measuredAt: 0, lane: null, atPaint: null, cacheAt: null, cacheBytes: 0, cacheKeys: 0 }
      rows.set(def.id, r)
    }
    return r
  }
  const lane = (r: SourceRow, start: number, sent: number, end: number | null, failed: boolean) => {
    if (!r.lane) { r.lane = { start, sent, end, failed }; return }
    const l = r.lane
    l.end = l.end === null || end === null ? null : Math.max(l.end, end)
    l.start = Math.min(l.start, start)
    l.sent = Math.min(l.sent, sent)
    l.failed ||= failed
  }

  const latBy = new Map(lat.map((l) => [l.path, l]))
  for (const path of new Set([...latBy.keys(), ...speed.first.keys()])) {
    const r = row(sourceForPath(path))
    const l = latBy.get(path)
    const last = speed.last.get(path)
    const first = speed.first.get(path)
    const phase: Phase = l?.phase ?? (last && last.status >= 400 ? 'failed' : 'done')
    const ms = phase === 'pending' ? null : phase === 'failed' ? (l?.ms ?? last?.ms ?? null) : (last?.ms ?? l?.ms ?? null)
    const bytes = (phase === 'done' ? last?.bytes || l?.bytes : l?.bytes) || 0
    const flight = l?.inflightSince ? Math.max(0, nowEpoch - l.inflightSince) : null
    const status = l?.status ?? last?.status ?? 0
    r.paths.push({ path, phase, ms, bytes, status, flight })
    if (phase === 'done' && ms != null) r.ms = Math.max(r.ms ?? 0, ms)
    if (phase === 'failed') r.status = status
    r.bytes += bytes
    r.measuredAt = Math.max(r.measuredAt, phase === 'pending' ? 0 : l?.at ?? 0)
    if (flight != null) r.flight = Math.max(r.flight ?? 0, flight)
    if (first && first.start < bootCut) lane(r, first.start, first.sent, first.end, first.status >= 400)
    else if (phase === 'pending' && l?.inflightSince && l.inflightSince - origin < bootCut) {
      lane(r, l.inflightSince - origin, l.inflightSince - origin, null, false)
    }
  }
  for (const key of new Set([...speed.boot.keys(), ...current.keys()])) {
    const r = row(sourceForKey(key))
    const b = speed.boot.get(key)
    const c = current.get(key)
    if (b && b.at > 0) r.atPaint = Math.max(r.atPaint ?? 0, Math.max(0, paintEpoch - b.at))
    if (c && c.at > 0) r.cacheAt = Math.max(r.cacheAt ?? 0, c.at)
    r.cacheBytes += c?.bytes ?? 0
    r.cacheKeys++
  }
  for (const r of rows.values()) {
    const has = (p: Phase) => r.paths.some((x) => x.phase === p)
    r.state = has('pending') ? 'pending' : has('failed') ? 'failed' : has('done') ? 'done' : 'idle'
    if (r.cacheKeys > 1 && SOURCES.find((s) => s.id === r.id)?.count) r.name = `${r.name} · ${r.cacheKeys}`
  }
  return [...rows.values()]
}

// ---------- formatting ----------

const fmtMs = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return '--'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}
const fmtSize = (b: number): string => {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  const kb = b / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`
}
/** latency tone: the slow sources (session board, thor) stand out, fast ones recede */
const msTone = (ms: number): 'acc2' | 'fg' | 'dim' => (ms >= 1500 ? 'acc2' : ms >= 400 ? 'fg' : 'dim')
const shortPath = (p: string) => p.replace(/^\//, '')

// ---------- notifications (src/lib/push: the status, this device on or off, the device list, the test send) ----------

type PushDevice = {
  /** the server's short handle for the subscription; '' in a cache from an older build (no Forget until a fetch lands) */
  id: string
  label: string
  /** ms epoch, null when unknown */
  added: number | null
  lastOk: number | null
  failCount: number
  lastError: string | null
  failing: boolean
}
type PushVM = { configured: boolean; devices: PushDevice[] }

const ms = (iso: string | null | undefined): number | null => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null)

function usePush() {
  return useLive<PushVM>('push', async () => {
    const d = await fetchPushStatus()
    if (!d || typeof d !== 'object' || !Array.isArray(d.subscriptions)) throw new Error('push status: bad response')
    return {
      configured: d.configured === true,
      devices: d.subscriptions.map((s) => ({
        id: typeof s.id === 'string' ? s.id : '',
        label: s.label || s.service || 'Device',
        added: ms(s.createdAt),
        lastOk: ms(s.lastOkAt),
        failCount: s.failCount ?? 0,
        lastError: s.lastError || null,
        failing: (s.failCount ?? 0) > 0 || !!s.lastError,
      })),
    }
  }, 120_000, {
    // a cache from before the device list carried ids and dates
    revive: (c) => {
      const v = c as { configured?: boolean; devices?: Partial<PushDevice>[] } | null
      if (!v || !Array.isArray(v.devices)) return undefined
      return {
        configured: v.configured === true,
        devices: v.devices.map((x): PushDevice => ({
          id: x.id ?? '',
          label: x.label ?? 'Device',
          added: x.added ?? null,
          lastOk: x.lastOk ?? null,
          failCount: x.failCount ?? 0,
          lastError: x.lastError ?? null,
          failing: x.failing ?? false,
        })),
      }
    },
  })
}

/** Why a write failed: the server's error or detail when it sent one. */
const why = (e: unknown): string => {
  const detail = (e as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail
  return apiErrorText(e, typeof detail === 'string' && detail ? detail : e instanceof Error && e.message ? e.message : 'no answer')
}

/** "iPhone", "iPhone ×2, iPad" */
const deviceList = (labels: string[]) => {
  const n = new Map<string, number>()
  labels.forEach((l) => n.set(l, (n.get(l) ?? 0) + 1))
  return [...n].map(([l, k]) => (k > 1 ? `${l} ×${k}` : l)).join(', ')
}

// ---------- the screen ----------

const WIDE_PX = 700

/** the icon for what a device profile resolves to */
const DEVICE_ICON: Record<Exclude<DeviceMode, 'auto'>, IconName> = { desktop: 'thor', iphone: 'phone', ipad: 'tablet', vr: 'frame' }

/** a dim section icon: leads a plate, a row or a section title */
const Lead = ({ name, size = 14 }: { name: IconName; size?: number }) => <Icon name={name} size={size} tone="dim" className="st-lead" />

/** Density has no icon in the kit set: a table of rows drawn in the same line style */
function RowsGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size <= 14 ? 1.6 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" className="vl-icon vl-icon-dim st-lead" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18" />
    </svg>
  )
}

/** Font has no icon in the kit set: lucide's Type in the same dim line style */
const FontGlyph = ({ size = 14 }: { size?: number }) => (
  <Type size={size} strokeWidth={size <= 14 ? 1.6 : 1.4} className="vl-icon vl-icon-dim st-lead" aria-hidden />
)

/** The shell's Settings screen: Settings with its own small hero in the gutter beside the plates. */
export function SettingsScreen({ active = true }: { active?: boolean }) {
  return (
    <Settings
      active={active}
      gutterAlways
      between={<div className="st-hero-slot"><Hero active={active} pose="display" fill={0.9} className="st-hero" /></div>}
    />
  )
}

export default function Settings({ active = true, between, gutterAlways = false }: {
  active?: boolean
  /**
   * Hero slot: rendered in the gutter right of the two-cell plates (Font,
   * Motion, Hero, Density), about 1/3 of the width and as tall as those
   * plates. Pass an element that fills its box.
   */
  between?: ReactNode
  /** show `between` in the two-column layout too (default: one column only) */
  gutterAlways?: boolean
}) {
  const { motion, setMotion } = useShell()
  const [hero, setHero] = useHeroId()
  // the kit applies it to html[data-font]; Settings only stores the pick
  const [font, setFont] = useSetting<FontId>('font', 'mono', FONT_VALUES)
  const [density, setDensity] = useSetting<Density>('density', 'compact', ['compact', 'comfortable'])
  // the real profile: the classic pages, the start URL and the header's home button read the same key
  const device = useProfile().mode
  useReducedMotion() // re-render when the OS setting flips, for the Motion note
  const osReduced = prefersReducedMotion()
  const hosts = useHosts()
  const heroHost = hosts.data?.find((h) => h.id === hero)

  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  const rootRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // content box, the same width the container query in settings.css sees
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= WIDE_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the hero host's live state, led by its icon: CPU when it answers, else why not.
  // phone and tablet have no host on the API yet: their model shows with no stats
  const modelOnly = !heroHost && (hero === 'phone' || hero === 'tablet')
  const heroLive = !!heroHost && !hosts.failed && heroHost.online && !heroHost.stale
  const heroNote = modelOnly ? 'Model only' : !heroHost ? null
    : hosts.failed ? `Unreachable, ${ago(hosts.updatedAt)} old`
      : heroLive ? (heroHost.cpu != null ? `CPU ${heroHost.cpu}%` : 'Online') : 'Offline'
  const heroNoteIcon = modelOnly || !heroHost ? null
    : hosts.failed ? <Icon name="alert" size={12} tone="acc2" className="st-note-icon" />
      : <Icon name={heroLive ? 'cpu' : 'offline'} size={12} tone="dim" className="st-note-icon" />
  const dev = deviceNote(device)
  const devIcon = DEVICE_ICON[resolveProfile(device).resolved]

  return (
    <div ref={rootRef} className="vl-screen st">
      <div className="st-grid">
        <div className="st-controls">
          <Schemes i={0} />
          <div className="st-pair">
            <div className="st-plates">
              <Plate label="Font" icon={<FontGlyph />} options={FONTS} value={font} onChange={setFont} i={2} />
              <Plate label="Motion" icon={<Lead name="play" />} options={MOTION} value={motion} onChange={setMotion} i={3}
                note={osReduced && motion === 'full' ? 'System asks for reduced' : null} short={osReduced && motion === 'full' ? 'OS: reduced' : null} />
              <Plate label="Hero" icon={<Lead name="system" />} options={HERO} value={hero} onChange={setHero} i={4}
                note={heroNote} short={heroNote} noteIcon={heroNoteIcon} stack />
              <Plate label="Density" icon={<RowsGlyph />} options={DENSITY} value={density} onChange={setDensity} i={5} />
            </div>
            {(!wide || gutterAlways) && between != null && <div className="st-gutter">{between}</div>}
          </div>
          <Plate label="Device" icon={<Lead name={devIcon} />} options={DEVICE} value={device} onChange={setDeviceMode} i={6}
            note={dev.long} short={dev.short} stack />
        </div>
        <DeviceRows i={7} />
        <Speed active={active} wide={wide} base={8} />
      </div>
    </div>
  )
}

/**
 * Appearance: Valkyrie's scheme picker as glass plates. Each scheme is a plate
 * with its color dot; the lit plate slides to the pick and the whole UI morphs
 * to it (kit/theme useAccent stores it under 'valkyrie-accent' and paints it at
 * once). Under the grid: Custom, lit when no preset matches the stored accent,
 * with a swatch (the system color picker) and a hex field that applies on Enter
 * or blur.
 */
function Schemes({ i }: { i: number }) {
  const [stored, setAccent] = useAccent()
  const accent = accentOf(stored)
  const k = SCHEMES.findIndex((s) => s.accent === accent)
  const custom = k < 0
  // the plate keeps its last preset spot while Custom is lit, so it slides from there on the next pick
  const lastK = useRef(Math.max(0, k))
  if (k >= 0) lastK.current = k
  // the last custom color, so the Custom plate brings it back after a preset
  const [lastCustom, setLastCustom] = useSetting<string>('customAccent', '')
  const saved = normHex(lastCustom)

  const [draft, setDraft] = useState(accent)
  const [bad, setBad] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const escaping = useRef(false)
  useEffect(() => {
    setDraft(accent)
    setBad(false)
  }, [accent])

  const pick = (hex: string) => {
    setDraft(hex)
    setBad(false)
    if (!SCHEMES.some((s) => s.accent === hex)) setLastCustom(hex)
    if (hex !== accent) setAccent(hex)
  }
  const commit = (raw: string) => {
    const hex = normHex(raw)
    if (hex) pick(hex)
    else setBad(true)
  }
  const onCustom = () => {
    if (saved && !custom) pick(saved)
    else { field.current?.focus(); field.current?.select() }
  }

  const vars: Vars = { '--col': lastK.current % COLS, '--row': Math.floor(lastK.current / COLS) }
  const customDot = custom ? accent : saved
  return (
    <div className="st-plate st-appear vl-build" style={{ '--i': i } as Vars}>
      <div className="st-plate-head">
        <span className="st-plate-label"><Lead name="color" /><span>Appearance</span></span>
      </div>
      <div className="st-pick" role="radiogroup" aria-label="Color scheme">
        <div className="st-schemes" data-custom={custom || undefined} style={vars}>
          <div className="st-lit st-scheme-plate" aria-hidden />
          {SCHEMES.map((s) => {
            const on = s.accent === accent
            return (
              <Press key={s.id} role="radio" aria-checked={on} aria-label={s.label} title={`${s.label} ${s.accent}`}
                data-on={on || undefined} className="st-scheme" style={{ '--c': s.accent } as Vars} onPress={() => pick(s.accent)}>
                <span className="st-dot" aria-hidden />
                <span className="st-scheme-name">{s.label}</span>
              </Press>
            )
          })}
        </div>
        <div className="st-custom">
          <Press role="radio" aria-checked={custom} aria-label={customDot ? `Custom ${customDot}` : 'Custom'}
            title={customDot ? `Custom ${customDot}` : 'Type a color below'} data-on={custom || undefined}
            className="st-scheme st-custom-cell" style={customDot ? ({ '--c': customDot } as Vars) : undefined} onPress={onCustom}>
            <span className="st-lit st-custom-lit" aria-hidden />
            <span className="st-dot" data-empty={customDot ? undefined : ''} aria-hidden />
            <span className="st-scheme-name">Custom</span>
          </Press>
          <div className="st-hex" data-bad={bad || undefined} data-no-swipe>
            <input type="color" className="st-swatch" value={accent} aria-label="Pick a color" title="Pick a color"
              style={{ '--c': accent } as Vars} onChange={(e) => commit(e.target.value)} />
            <input
              ref={field}
              type="text"
              className="st-hex-input"
              value={draft}
              aria-label="Custom color, #rrggbb"
              aria-invalid={bad || undefined}
              placeholder="#00ffe5"
              maxLength={7}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => {
                setDraft(e.target.value)
                if (bad && normHex(e.target.value)) setBad(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (normHex(draft)) e.currentTarget.blur()
                  else setBad(true)
                } else if (e.key === 'Escape') {
                  escaping.current = true
                  setDraft(accent)
                  setBad(false)
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => {
                if (escaping.current) { escaping.current = false; return }
                if (draft.trim().toLowerCase() !== accent) commit(draft)
              }}
            />
            {bad && <span className="st-hex-err">Use #rrggbb</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Plate<T extends string>({ label, icon, options, value, onChange, i, note, noteIcon, short, stack }: {
  label: string
  /** the plate's lead icon, dim */
  icon: ReactNode
  options: Opt<T>[]
  value: T
  onChange: (v: T) => void
  i: number
  note?: ReactNode
  /** a small icon in front of the note (a stat's icon) */
  noteIcon?: ReactNode
  /** shorter note for the one-row landscape layout */
  short?: ReactNode
  /** cells with icons put the icon over the label (five-cell Device plate) */
  stack?: boolean
}) {
  return (
    <div className="st-plate vl-build" data-cells={options.length} data-stack={stack || undefined} style={{ '--i': i } as Vars}>
      <div className="st-plate-head">
        <span className="st-plate-label">{icon}<span>{label}</span></span>
        {note != null && (
          <span className="st-plate-note" title={typeof note === 'string' ? note : undefined}>
            {noteIcon}
            <span className="st-long vl-ellipsis">{note}</span>
            {short != null && <span className="st-short vl-ellipsis">{short}</span>}
          </span>
        )}
      </div>
      <Seg label={label} options={options} value={value} onChange={onChange} />
    </div>
  )
}

/**
 * The kit's glass segmented plate (same classes, so the shared plate CSS
 * applies) with an icon per cell where the option is a thing. The selected
 * cell's icon is lit: plate ink with the glow; the others stay dim.
 */
function Seg<T extends string>({ label, options, value, onChange }: {
  label: string
  options: Opt<T>[]
  value: T
  onChange: (v: T) => void
}) {
  const k = Math.max(0, options.findIndex((o) => o.value === value))
  const vars: Vars = { '--n': options.length, '--k': k }
  return (
    <div className="vl-seg st-seg" role="radiogroup" aria-label={label} style={vars}>
      <div className="vl-seg-plate" aria-hidden />
      {options.map((o) => {
        const on = o.value === value
        return (
          <Press
            key={o.value}
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            data-on={on || undefined}
            data-icon={o.icon ? '' : undefined}
            className="vl-seg-cell"
            onPress={() => onChange(o.value)}
          >
            <span className="st-cell">
              {o.icon && <Icon name={o.icon} size={16} tone={on ? 'ink' : 'dim'} glow={on} className="st-cell-icon" />}
              <span className="st-cell-label" style={o.font ? { fontFamily: o.font } : undefined}>{o.label}</span>
            </span>
          </Press>
        )
      })}
    </div>
  )
}

// the deploy check: the release baked in at build time plus the short build id
// (web), or the installed app's own version (desktop app, auto-updated)
const BUILD_ID = (import.meta.env.VITE_BUILD_ID as string | undefined) || 'dev'
function useAppVersion(): { version: string; build: string } {
  const build = !isTauri() && BUILD_ID !== 'dev' ? BUILD_ID.slice(0, 7) : ''
  const [version, setVersion] = useState(isTauri() ? '' : `v${__APP_VERSION__}`)
  useEffect(() => {
    if (!isTauri()) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion(`v${__APP_VERSION__}`))
  }, [])
  return { version, build }
}

/** A destructive row action: the first press arms it ("Confirm"), a second within 3 s runs it. */
function useArm(): [string | null, (key: string, run: () => void) => void] {
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 3000)
    return () => clearTimeout(t)
  }, [armed])
  const press = (key: string, run: () => void) => {
    if (armed === key) { setArmed(null); run() } else setArmed(key)
  }
  return [armed, press]
}

/**
 * The classic header menu's functions, natively: notifications on this device
 * (on, off, the device list with Forget, the reasons it cannot), the version
 * and build id with Reload, the Plex link test, the classic UI, the classic
 * Slop page, and Sign out.
 */
function DeviceRows({ i }: { i: number }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const push = usePush()
  // a deploy that landed since this page loaded (index.html names a new bundle); no-op in the desktop app
  const newBuild = useBuildUpdate()
  const { version, build } = useAppVersion()
  const profile = useProfile()
  const [armed, arm] = useArm()
  const [plexOpen, setPlexOpen] = useState(false)
  useTick(30_000)

  // this device's subscription: the browser, not the server, knows whether it holds one
  const [mine, setMine] = useState<string | null>(null)
  const [busy, setBusy] = useState<'' | 'on' | 'off'>('')
  const [pushError, setPushError] = useState<string | null>(null)
  const refreshMine = () => { void currentSubscriptionId().then(setMine) }
  useEffect(refreshMine, [])
  const blocked = pushBlockedReason()
  const refreshPush = () => {
    refreshMine()
    void qc.invalidateQueries({ queryKey: ['v2', 'push'] })
  }
  // Notification.requestPermission needs a user gesture (Safari): this runs from a plain click
  const turn = async (on: boolean) => {
    if (busy) return
    setBusy(on ? 'on' : 'off')
    setPushError(null)
    try {
      if (on) await enablePush()
      else await disablePush()
      toast(on ? 'Notifications on for this device' : 'Notifications off for this device')
    } catch (e) {
      setPushError(e instanceof Error && e.message ? e.message : why(e))
    } finally {
      setBusy('')
      refreshPush()
    }
  }
  const forget = async (d: PushDevice) => {
    try {
      await forgetPushDevice(d.id)
      toast(`Forgot ${d.label}`)
    } catch (e) {
      toast(`${d.label} not forgotten: ${why(e)}`, { ms: 5000 })
    } finally {
      refreshPush()
    }
  }

  // one test at a time; the status is read again after it, for "last sent"
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const sendTest = async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      const r = await sendPushTest()
      if (!r.ok) throw new Error(r.detail || 'nothing delivered')
      // the server's detail reads "sent to 2" or "sent to 1, 1 failed"
      toast(r.detail ? `Test ${r.detail}` : 'Test sent')
      void qc.invalidateQueries({ queryKey: ['v2', 'push'] })
    } catch (e) {
      toast(`Test not sent: ${why(e)}`)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const now = Date.now()
  const p = push.data
  const lastOk = p ? Math.max(0, ...p.devices.map((d) => d.lastOk ?? 0)) : 0
  const failing = p ? p.devices.filter((d) => d.failing).length : 0
  let value: ReactNode
  let sub: ReactNode = null
  if (!p) value = <span style={{ color: push.failed ? 'var(--acc2)' : 'var(--dim)' }}>{push.failed ? 'Unreachable' : 'Checking'}</span>
  else if (!p.configured) value = 'Not set up on the server'
  else if (!p.devices.length) value = 'Off on every device'
  else {
    value = `On for ${deviceList(p.devices.map((d) => d.label))}`
    sub = push.failed ? null : lastOk ? `last sent ${ago(lastOk, now)} ago` : 'nothing sent yet'
  }
  // the alerts icon: lit while alerts reach a device, warning color when they fail, dim when off
  const pushOn = !!p && p.configured && p.devices.length > 0
  const pushBad = push.failed || failing > 0
  const pushTone: IconTone = pushBad ? 'acc2' : pushOn ? 'fg' : 'dim'
  const here = !!mine && !!p?.devices.some((d) => d.id === mine)
  const hereValue = blocked ? 'Not available here' : busy === 'on' ? 'Turning on' : busy === 'off' ? 'Turning off' : here ? 'On' : 'Off'
  const classicNote = CLASSIC_NOTE[profile.resolved]
  const signOut = () => { setAuthSkipped(false); clearToken() }
  return (
    <div className="st-rows vl-rows vl-build" style={{ '--i': i } as Vars}>
      <div className="st-row">
        <Icon name="alert" size={15} tone={pushTone} glow={pushBad || pushOn} className="st-row-icon" />
        <span className="st-row-label">Notifications</span>
        <span className="st-row-value vl-ellipsis" title={push.failed && p ? `Unreachable, showing ${ago(push.updatedAt, now)} old` : undefined}>
          {value}
          {sub && <span className="st-row-sub"> · {sub}</span>}
          {failing > 0 && <span style={{ color: 'var(--acc2)' }}> · {failing} failing</span>}
          {push.failed && p && <span style={{ color: 'var(--acc2)' }}> · unreachable, {ago(push.updatedAt, now)} old</span>}
        </span>
        <Press className="vl-link vl-hit st-row-act" disabled={sending || !pushOn} aria-busy={sending || undefined}
          title={pushOn ? 'Send a test notification to every device' : 'No device has notifications on'} onPress={() => void sendTest()}>
          {sending ? 'Sending' : 'Send test'}
        </Press>
      </div>
      {/* this device on or off; a plain button, so the permission prompt runs inside the click */}
      <div className="st-row st-row-in">
        <Icon name={DEVICE_ICON[profile.resolved]} size={15} tone={here ? 'fg' : 'dim'} glow={here} className="st-row-icon" />
        <span className="st-row-label">This device</span>
        <span className="st-row-value vl-ellipsis" title={blocked ?? undefined}>{hereValue}</span>
        {!blocked && (
          <button
            type="button"
            className="vl-press vl-link vl-hit st-row-act"
            data-lit={!here || undefined}
            disabled={busy !== '' || !p?.configured}
            title={!p?.configured ? 'The server has no VAPID keys yet' : here ? 'Stop alerts on this device' : 'Get alerts on this device'}
            onClick={() => void turn(!here)}
          >
            {here ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      {(blocked || pushError || (p && !p.configured) || (!blocked && !isStandalone())) && (
        <div className="st-warns">
          {p && !p.configured && <p className="st-warn" data-tone="hot">The server has no VAPID keys set, so nothing can be delivered yet.</p>}
          {blocked && <p className="st-warn">{blocked}</p>}
          {pushError && <p className="st-warn" data-tone="acc2" role="alert">{pushError}</p>}
          {!blocked && !isStandalone() && (
            <p className="st-warn">Running in a browser tab. Install Valkyrie (Add to Home Screen on the phone) and turn it on there too, or alerts stop when the tab closes.</p>
          )}
        </div>
      )}
      {p && p.devices.length > 0 && (
        <ul className="st-devs" aria-label="Devices with notifications on">
          {p.devices.map((d, k) => {
            const key = `forget:${d.id || k}`
            return (
              <li key={d.id || `${d.label}-${k}`} className="st-dev">
                <span className="st-dev-main">
                  <span className="st-dev-name">
                    {d.label}
                    {d.id && d.id === mine && <span className="st-tag">This device</span>}
                  </span>
                  <span className="st-dev-meta">
                    {d.added ? `added ${ago(d.added, now)} ago` : 'added --'}
                    {`, last delivered ${d.lastOk ? `${ago(d.lastOk, now)} ago` : 'never'}`}
                    {d.failCount > 0 && <span style={{ color: 'var(--acc2)' }}>{`, ${d.failCount} failed`}</span>}
                  </span>
                  {d.lastError && <span className="st-dev-err vl-ellipsis" title={d.lastError}>{d.lastError}</span>}
                </span>
                <Press
                  className="vl-link vl-hit st-row-act st-danger"
                  data-armed={armed === key || undefined}
                  disabled={!d.id}
                  aria-label={armed === key ? `Confirm: forget ${d.label}` : `Forget ${d.label}`}
                  title={d.id ? 'Stop sending alerts to this device' : 'Reading the device list'}
                  onPress={() => arm(key, () => void forget(d))}
                >
                  {armed === key ? 'Confirm' : 'Forget'}
                </Press>
              </li>
            )
          })}
        </ul>
      )}
      <div className="st-row">
        <Icon name="clock" size={15} tone={newBuild ? 'fg' : 'dim'} glow={newBuild} className="st-row-icon" />
        <span className="st-row-label">Build</span>
        <span className="st-row-value vl-ellipsis" title={version ? `Valkyrie ${version}${build ? ` · ${build}` : ''}` : undefined}>
          {version && <span className="st-ver">{version}{build ? ` · ${build}` : ''}</span>}
          {newBuild ? <span style={{ color: 'var(--fg)' }}> · new build ready</span> : <span className="st-row-sub"> · loaded {ago(performance.timeOrigin, now)} ago</span>}
        </span>
        {/* index.html is served no-cache and the assets are hashed, so a reload is the update */}
        <Press className="vl-link vl-hit st-row-act" data-lit={newBuild || undefined} onPress={() => window.location.reload()}>
          {newBuild ? 'Update' : 'Reload'}
        </Press>
      </div>
      {/* temporary, like the classic Settings' section: which link shape opens an item on our Plex server */}
      <div className="st-row">
        <Icon name="watch" size={15} tone={plexOpen ? 'fg' : 'dim'} glow={plexOpen} className="st-row-icon" />
        <span className="st-row-label">Plex link</span>
        <span className="st-row-value vl-ellipsis">Which link opens our server</span>
        <Press className="vl-link vl-hit st-row-act" aria-expanded={plexOpen} onPress={() => setPlexOpen((v) => !v)}>
          {plexOpen ? 'Hide' : 'Test'}
        </Press>
      </div>
      {plexOpen && <PlexLinkTest />}
      <div className="st-row">
        <Icon name={DEVICE_ICON[profile.resolved]} size={15} tone="dim" className="st-row-icon" />
        <span className="st-row-label">Classic</span>
        <span className="st-row-value vl-ellipsis">{classicNote}</span>
        {/* ?classic=1 keeps this tab in the classic UI until its menu's "new ui" */}
        <Press className="vl-link vl-hit st-row-act" onPress={() => navigate(`${profile.classicHome}?classic=1`)}>Open</Press>
      </div>
      {/* the slop factory's publisher was retired 2026-09-25; its classic page stays for the curator's moments */}
      <div className="st-row">
        <Icon name="movie" size={15} tone="dim" className="st-row-icon" />
        <span className="st-row-label">Slop</span>
        <span className="st-row-value vl-ellipsis">Classic page</span>
        <Press className="vl-link vl-hit st-row-act" aria-label="Open classic Slop" onPress={() => navigate('/slop')}>Open</Press>
      </div>
      {/* the classic menu's sign out: forget this device's app token; the sign-in screen takes over */}
      <div className="st-row">
        <span className="st-row-icon st-row-glyph" aria-hidden><Glyph name="exit" size={13} /></span>
        <span className="st-row-label">Sign out</span>
        <span className="st-row-value vl-ellipsis">Ends this sign-in</span>
        <Press
          className="vl-link vl-hit st-row-act st-danger"
          data-armed={armed === 'signout' || undefined}
          aria-label={armed === 'signout' ? 'Confirm: sign out' : 'Sign out'}
          onPress={() => arm('signout', signOut)}
        >
          {armed === 'signout' ? 'Confirm' : 'Sign out'}
        </Press>
      </div>
    </div>
  )
}

/**
 * Plex link test (the classic Settings' section, still open): which link shape
 * lands on the item's page on OUR server (with the Watch button) rather than
 * Plex's catalog page. Each row is a candidate; tapping tells more than any
 * amount of reading. Reads Plex only while open.
 */
function PlexLinkTest() {
  const server = useQuery({ queryKey: ['plex-server'], queryFn: fetchPlexServer, staleTime: Infinity, retry: 1 })
  const movies = useQuery({
    queryKey: ['plex-lib', '1', '', 'added'],
    queryFn: () => fetchPlexLibrary('1', 0, { sort: 'added' }),
    staleTime: 300_000,
    retry: 1,
  })
  const mid = server.data?.machineIdentifier
  const item = movies.data?.items?.[0]
  if (!mid || !item) {
    const failed = server.isError || movies.isError
    return <p className="st-warn st-plex-note">{failed ? 'Plex did not answer.' : server.isLoading || movies.isLoading ? 'Reading Plex' : 'No movie to test with.'}</p>
  }
  const key = `/library/metadata/${item.ratingKey}`
  const enc = encodeURIComponent(key)
  const watch = item.watchPath ? `https://watch.plex.tv${item.watchPath}` : null
  const candidates: { id: string; note: string; url: string }[] = [
    { id: 'A', note: 'raw key + metadataType', url: `plex://preplay/?metadataKey=${key}&metadataType=1&server=${mid}` },
    { id: 'B', note: 'server first, raw key', url: `plex://preplay/?server=${mid}&metadataKey=${key}` },
    { id: 'C', note: 'encoded key + metadataType', url: `plex://preplay/?metadataKey=${enc}&metadataType=1&server=${mid}` },
    { id: 'D', note: 'play verb (starts playback)', url: `plex://play/?metadataKey=${key}&server=${mid}` },
    { id: 'E', note: 'android-style server route', url: `plex://server://${mid}/com.plexapp.plugins.library${key}` },
    { id: 'F', note: 'no slash after verb', url: `plex://preplay?metadataKey=${enc}&server=${mid}` },
    ...(watch ? [
      { id: 'G', note: 'watch link + ?source=', url: `${watch}?source=${mid}` },
      { id: 'H', note: 'watch link + ?server=', url: `${watch}?server=${mid}` },
    ] : []),
  ]
  return (
    <div className="st-plex">
      <p className="st-warn st-plex-note">
        Testing with <b>{item.title}</b>. Open each and note which lands on the page with the Watch button (our server), then say the letter.
      </p>
      <ul className="st-plex-list">
        {candidates.map((c) => (
          <li key={c.id}>
            <a href={c.url} className="st-plex-link">
              <span className="st-plex-id">{c.id}</span>
              <span className="st-plex-main">
                <span>{c.note}</span>
                <span className="st-plex-url vl-ellipsis">{c.url}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- Speed ----------

/** rows shown before "Show all": one-column layout, two-column layout */
const ROWS = [6, 16] as const

function Speed({ active, wide, base }: { active: boolean; wide: boolean; base: number }) {
  // every Valkyrie source gets measured whichever URL opened the page: the
  // Dashboard's hooks are not mounted on a direct open of /m/settings
  useCalendar(7)
  useTracker()
  useLaunchTargets()

  // build-in stagger index for each row, capped so long lists do not trail
  let n = base
  const next = () => Math.min(n++, 18)
  const now = useTick(active ? 1000 : 60_000)
  useSpeedVersion(active)
  const lat = useLatencies({ pending: true })
  const [marksV, setMarksV] = useState(0)
  const [all, setAll] = useState(false)
  const [sel, setSel] = useState<string | null>(null)

  const firstData = firstDataMs()
  // the shell and the first data can land in the same frame: the app's first frame is never after its first data
  const shellAt = firstPaint()
  const boot = shellAt != null && firstData != null ? Math.min(shellAt, firstData) : shellAt
  const firstLive = firstLiveMs()
  const origin = performance.timeOrigin
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const current = useMemo(() => new Map(readMarks().map((m) => [m.key, m])), [now, marksV])
  const paintEpoch = origin + (boot ?? firstData ?? 0)
  // the page load: requests that started within 2.5 s of the first frame
  const bootCut = (boot ?? 300) + 2500
  const rows = buildRows(lat, current, paintEpoch, bootCut, Date.now())

  // ---- summary ----
  const bootRows = rows.filter((r) => r.lane)
  const waitingBoot = bootRows.filter((r) => r.lane?.end == null)
  const failedNow = rows.filter((r) => r.state === 'failed')
  const allLive = bootRows.length && !waitingBoot.length ? Math.max(...bootRows.map((r) => r.lane?.end ?? 0)) : null
  const showLive = firstLive != null && firstData != null && firstLive - firstData > 15
  const cachedN = bootRows.filter((r) => r.atPaint != null).length
  const waited = bootRows.filter((r) => r.atPaint == null)
    .sort((a, b) => (b.lane?.end ?? Infinity) - (a.lane?.end ?? Infinity))
  const waitText = (r: SourceRow) => (r.lane?.end == null ? `${r.name} still waiting`
    : r.lane.failed ? `${r.name} failed at ${fmtMs(r.lane.end)}` : `${r.name} waited ${fmtMs(r.lane.end)}`)
  const oldest = Math.max(0, ...bootRows.map((r) => r.atPaint ?? 0))
  const paintNote = !bootRows.length ? 'Waiting for the first request'
    : cachedN === bootRows.length ? `All ${cachedN} sources painted from cache, oldest ${ago(0, oldest)}`
      : cachedN === 0 ? `Nothing cached: all ${bootRows.length} waited for the API · ${waitText(waited[0])}`
        : `${cachedN} of ${bootRows.length} from cache · ${waited.slice(0, 2).map(waitText).join(', ')}${waited.length > 2 ? ` +${waited.length - 2}` : ''}`

  // ---- order: never-answered and failed on top, the rest by their page-load bar, longest first.
  // A landed bar never changes, so rows hold still while polls update the Time column.
  const stateRank = { pending: 0, failed: 1, done: 2, idle: 3 }
  const sortKey = (r: SourceRow) => (r.lane && r.lane.end != null ? r.lane.end - r.lane.sent : r.ms ?? -1)
  rows.sort((a, b) => stateRank[a.state] - stateRank[b.state] || sortKey(b) - sortKey(a) || a.name.localeCompare(b.name))

  // ---- the shared axis: navigation start to max(3 s, slowest landed) ----
  const landed = bootRows.flatMap((r) => (r.lane?.end != null ? [r.lane.end] : []))
  const endMax = Math.max(3000, ...landed)
  const step = endMax <= 6000 ? 1000 : endMax <= 12_000 ? 2000 : 5000
  const span = Math.ceil(endMax / step) * step

  const slow = rows.filter((r) => r.state === 'done' && (r.ms ?? 0) >= 1500).length
  const max = ROWS[wide ? 1 : 0]
  const shown = all ? rows : rows.slice(0, max)
  const perfNow = performance.now()

  const clear = () => {
    const keys: string[] = []
    try {
      for (let k = 0; k < localStorage.length; k++) {
        const key = localStorage.key(k)
        if (key?.startsWith(PREFIX)) keys.push(key)
      }
      keys.forEach((k) => localStorage.removeItem(k))
    } catch { /* storage unavailable */ }
    setMarksV((v) => v + 1)
    if (keys.length) toast(`Cleared ${keys.length} cached source${keys.length === 1 ? '' : 's'}`, { action: { label: 'Reload', run: () => window.location.reload() } })
    else toast('Cache is already empty')
  }

  return (
    <section className="st-speed" aria-label="Speed">
      <div className="st-speed-head vl-build flex items-center gap-3" style={{ '--i': next() } as Vars}>
        <span className="st-speed-title">
          <Lead name="timer" />
          <span className="st-section">Speed</span>
        </span>
        <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
        <Press className="vl-link vl-hit" onPress={clear}>Clear cache</Press>
      </div>

      {/* the one number: navigation start to the first frame with real numbers on screen, cache or live */}
      <div className="st-sum-panel vl-panel vl-build" style={{ '--i': next() } as Vars}>
        <div className="st-sum">
          <div className="flex min-w-0 flex-col" title="Navigation start to the first frame that showed real numbers, from the cache or the API">
            <span className="st-sum-label">First data</span>
            <span className="st-sum-num">
              {firstData == null ? '--' : Math.round(firstData)}
              <small>ms</small>
            </span>
          </div>
          <dl className="st-sum-dl">
            <dt title="Navigation start to the app's first frame">Boot</dt>
            <dd>{fmtMs(boot)}</dd>
            {showLive && (
              <>
                <dt title="First frame with data fetched in this page load">Live</dt>
                <dd>{fmtMs(firstLive)}</dd>
              </>
            )}
            <dt title="Every source the page asked for at load has answered">All live</dt>
            <dd style={{ color: waitingBoot.length || failedNow.length || (allLive != null && allLive >= 2500) ? 'var(--acc2)' : undefined }}>
              {waitingBoot.length ? 'waiting' : allLive == null ? '--' : fmtMs(allLive)}
            </dd>
          </dl>
        </div>
        <div className="st-note">{paintNote}</div>
      </div>

      <div className="st-head vl-build" style={{ '--i': next() } as Vars}>
        <span className="st-head-title">
          Sources
          <span className="st-head-sub">{rows.length ? 'by page load' : 'measuring'}</span>
          {(slow > 0 || failedNow.length > 0) && (
            <span className="st-head-alert">{[slow ? `${slow} slow` : '', failedNow.length ? `${failedNow.length} failed` : ''].filter(Boolean).join(' · ')}</span>
          )}
        </span>
        <span className="st-col st-col-time">Time</span>
        <span className="st-col st-col-cache">At paint</span>
      </div>
      <Axis span={span} step={step} i={next()} />
      <div className="vl-rows st-srcs">
        {shown.map((r) => (
          <SourceRowView key={r.id} r={r} span={span} perfNow={perfNow} now={now} open={sel === r.id}
            onPress={() => setSel((cur) => (cur === r.id ? null : r.id))} i={next()} />
        ))}
        {!rows.length && <div className="st-empty">No requests yet</div>}
      </div>
      {rows.length > max && (
        <div className="vl-build flex" style={{ '--i': next() } as Vars}>
          <Press className="vl-link vl-hit" onPress={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</Press>
        </div>
      )}
    </section>
  )
}

function Axis({ span, step, i }: { span: number; step: number; i: number }) {
  const ticks = Array.from({ length: span / step + 1 }, (_, k) => k * step)
  return (
    <div className="st-axis vl-build" style={{ '--i': i } as Vars} aria-hidden>
      {ticks.map((t) => (
        <span key={t} className="st-tick" style={{ left: `${(t / span) * 100}%` }} data-edge={t === 0 ? 'start' : t === span ? 'end' : undefined}>
          {t === 0 ? '0' : `${t / 1000} s`}
        </span>
      ))}
    </div>
  )
}

function SourceRowView({ r, span, perfNow, now, open, onPress, i }: {
  r: SourceRow; span: number; perfNow: number; now: number; open: boolean; onPress: () => void; i: number
}) {
  const inFlight = r.flight != null && r.flight >= 800
  const tone = r.state === 'failed' ? 'acc2'
    : r.state === 'pending' ? msTone(r.flight ?? 0)
      : r.state === 'idle' ? 'faint'
        : msTone(Math.max(r.ms ?? 0, inFlight ? r.flight ?? 0 : 0))
  const color = `var(--${tone})`
  // the source's icon is lit while a request is out (live) and when it failed
  const lit = r.state === 'failed' || r.state === 'pending' || inFlight
  const dot = useRef<HTMLElement>(null)
  // a fresh measurement flashes the row's icon
  useEffect(() => {
    if (r.state !== 'done' || !r.measuredAt || isReducedMotion()) return
    dot.current?.animate([{ opacity: 0.3, transform: 'scale(1.3)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 700, easing: 'ease-out' })
  }, [r.measuredAt, r.state])

  const time = r.state === 'failed' ? 'failed'
    : r.state === 'pending' ? fmtMs(r.flight)
      : r.state === 'idle' ? '--'
        : inFlight ? fmtMs(r.flight) : fmtMs(r.ms)
  const paths = r.paths.length ? r.paths.map((p) => shortPath(p.path)).join(', ') : 'cache only'
  const size = fmtSize(r.bytes || r.cacheBytes)
  const failedPath = r.paths.find((p) => p.phase === 'failed')
  const sub = r.state === 'failed'
    ? `${r.status ? `HTTP ${r.status}` : 'no reply'}${failedPath?.ms ? ` after ${fmtMs(failedPath.ms)}` : ''}${r.cacheAt ? ` · showing ${ago(r.cacheAt, now)} old` : ' · nothing cached'}`
    : r.state === 'pending' ? `${paths} · no answer yet`
      : r.state === 'idle' ? 'cached, not asked this visit'
        : `${paths}${size ? ` · ${size}` : ''}`

  // the lane on the shared axis: queued (waiting for a connection) faint, the network part solid
  const L = r.lane
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / span) * 100)).toFixed(3)}%`
  // a lane still waiting runs off the right edge: clamp it there
  const laneEnd = L ? Math.min(L.end ?? perfNow, span) : 0
  const laneTone = !L ? tone : L.failed ? 'acc2' : L.end == null ? msTone(perfNow - L.start) : msTone(L.end - L.sent)
  const laneColor = `var(--${laneTone})`

  return (
    <div className="st-src-wrap vl-build" style={{ '--i': i } as Vars}>
      <Press className="st-src" data-state={r.state} data-open={open || undefined} aria-expanded={open} onPress={onPress}
        title={r.state === 'done' && r.measuredAt ? `${r.name} · measured ${ago(r.measuredAt, now)} ago` : r.name}>
        <span ref={dot} className={cx('st-src-ico', (inFlight || r.state === 'pending') && 'vl-pulse')}>
          <Icon name={r.icon} size={15} tone={tone} glow={lit} />
        </span>
        <span className="st-src-main">
          <span className="st-src-name" style={{ color: r.state === 'idle' ? 'var(--dim)' : undefined }}>{r.name}</span>
          <span className="st-src-sub" style={{ color: r.state === 'failed' ? 'var(--acc2)' : undefined }}>{sub}</span>
        </span>
        <span className="st-src-time" style={{ color }}>{time}</span>
        <span className="st-src-cache" style={{ color: r.atPaint == null ? 'var(--faint)' : r.atPaint >= 3_600_000 ? 'var(--hot)' : 'var(--fg)' }}>
          {r.atPaint == null ? 'none' : ago(0, r.atPaint)}
        </span>
        {L && (L.end == null || L.failed || laneEnd - L.sent >= span * 0.01) && (
          <span className="st-lane" aria-hidden>
            {L.sent - L.start > span * 0.01 && (
              <i style={{ left: pct(L.start), width: pct(L.sent - L.start), background: laneColor, opacity: 0.3 }} />
            )}
            <i
              style={{
                left: pct(L.sent),
                width: `max(2px, ${pct(laneEnd - L.sent)})`,
                background: L.end == null ? `repeating-linear-gradient(90deg, ${laneColor} 0 5px, transparent 5px 8px)` : laneColor,
                opacity: laneTone === 'dim' ? 0.75 : 1,
                boxShadow: laneTone === 'acc2' && L.end != null ? `0 0 5px ${laneColor}` : undefined,
              }}
            />
          </span>
        )}
      </Press>
      {open && <SourceDetail r={r} now={now} />}
    </div>
  )
}

function SourceDetail({ r, now }: { r: SourceRow; now: number }) {
  const L = r.lane
  return (
    <div className="st-detail">
      {L && (
        <div>
          Page load: asked at {fmtMs(L.start)}
          {L.sent - L.start >= 5 ? `, sent at ${fmtMs(L.sent)}` : ''}
          {L.end == null ? ', no answer yet' : `, answered at ${fmtMs(L.end)}`}
        </div>
      )}
      {r.paths.map((p) => (
        <div key={p.path} className="st-detail-path">
          <span className="vl-ellipsis">{shortPath(p.path)}</span>
          <span style={{ color: p.phase === 'failed' ? 'var(--acc2)' : undefined }}>
            {p.phase === 'pending' ? `waiting ${fmtMs(p.flight)}` : p.phase === 'failed' ? `failed ${p.status || 'no reply'}` : fmtMs(p.ms)}
          </span>
          <span>{fmtSize(p.bytes) || '--'}</span>
        </div>
      ))}
      <div>
        {r.atPaint == null ? 'Nothing cached at load' : `Painted from a ${ago(0, r.atPaint)} old copy`}
        {r.cacheAt ? ` · cache now ${ago(r.cacheAt, now)} old` : ''}
      </div>
    </div>
  )
}
