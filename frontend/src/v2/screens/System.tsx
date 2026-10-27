import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useShell, type ScreenProps } from '../kit/shell'
import { Bar, Press, cx, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { ago, equityAge, tradeAllCash, useHosts, useLive, useTick, useTrade, type HostVM, type Live, type TradeVM } from '../kit/data'
import {
  fetchLauncher, fetchServices, fetchTradeBotPage, restartService,
  type LauncherEntry, type ListeningPort, type ServiceContainer, type ServicesStatus, type ServiceTimer, type ServiceUnit,
  type TradeBotArm, type TradeBotPage,
} from '../../lib/api'
import { HOST_POSE, Hero, MODEL_ONLY_IDS, MODEL_ONLY_LABEL, heroModel, hostModel, type HostModelId, type ModelOnlyId } from '../kit/hero'
import { TrackRibbon } from '../kit/three'
import { EquityChart } from '../kit/three/EquityChart'
import { usePalette, useSetting } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import './system.css'

// System: Hosts (one icon-led row per host; the selected one as its x-ray
// model, large, over its gauge plates, and its last hour as an honest chart
// under the list; on a desktop the page fills the window; the phone and
// tablet, which do not report yet, as model-only rows with no stats), Services (odin's containers and units, Down first, then
// timers, web apps, listening ports and compose files, one search across all
// of them) and Trades (the trade bot's equity, portfolio, positions, fills,
// decision feed against the confidence gate, arms, experiment and caps).
// AI usage lives on AI > Usage.
// Reads only, except Restart (two taps, Restart then Confirm: it restarts the
// real container or user unit on odin), on a down row or inside any running
// row opened with a tap. Icons glow only when lit (online, selected, live,
// down); everything else is dim. Wide screens get two or three columns, counted
// from the screen's own width (the desktop app's UI zoom hides from media queries).

type Sub = 'hosts' | 'services' | 'trades'
type Tone = 'fg' | 'hot' | 'acc2'
type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })
const HOUR = 3_600_000

/** camera pose per model; kit/hero still names thor's pose by its old alias 'track' (same camera as 'hosts') */
const poseFor = (m: HostModelId | null): string => {
  const p = m ? HOST_POSE[m] : 'hosts'
  return p === 'track' ? 'hosts' : p
}

// ---------- helpers ----------

const title = (s: string) => s.replace(/^./, (c) => c.toUpperCase())
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** the row's short form: "60d", "12h", "45m" (the hero shows the full one) */
function upShort(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const m = Math.floor(sec / 60)
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

function uptime(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const usd = (v: number, digits = 2) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
/** "+$12.34" / "-$12.34"; "--" when unknown */
const signedUsd = (v: number | null, digits = 2) => (v == null ? '--' : `${v < 0 ? '-' : '+'}${usd(v, digits)}`)
/** "+1.20%" / "-1.20%" */
const signedPct = (v: number | null, digits = 2) => (v == null ? '--' : `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(digits)}%`)
/** a config fraction (0.25) as a percent ("25%", "-3.0%") */
const fracPct = (v: number | null, signed = false) => {
  if (v == null) return '--'
  const p = v * 100
  const s = Number.isInteger(Math.round(p * 10) / 10) && Math.abs(p) >= 1 ? p.toFixed(0) : p.toFixed(1)
  return `${signed && p > 0 ? '+' : ''}${s}%`
}
const qty = (v: number | null) => (v == null ? '--' : v.toLocaleString('en-US', { maximumFractionDigits: 4 }))

// Valkyrie runs on New York time: format every clock time there, whatever the phone's zone is
const NY = 'America/New_York'
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' })
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' })
const fmtLongDate = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric', year: 'numeric' })
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
const fmtWall = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
/** minutes after midnight, New York time */
const nyMinutes = (ms: number) => {
  let h = 0, m = 0
  for (const p of fmtHM.formatToParts(ms)) { if (p.type === 'hour') h = Number(p.value) % 24; else if (p.type === 'minute') m = Number(p.value) }
  return h * 60 + m
}
/** "2:00 AM" on the same day, "Sun 9:00 AM" on another */
const when = (ms: number, now: number) => (fmtDayKey.format(ms) === fmtDayKey.format(now) ? fmtTime.format(ms) : `${fmtWeekday.format(ms)} ${fmtTime.format(ms)}`)
/** "Oct 15 9:50 AM" */
const stamp = (ms: number) => `${fmtDate.format(ms)} ${fmtTime.format(ms)}`

/** New York's UTC offset at an instant, in ms (negative: -4 h in summer) */
function nyOffset(utc: number): number {
  const p: Record<string, number> = {}
  for (const x of fmtWall.formatToParts(utc)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(utc / 1000) * 1000
}

/** An ISO time as ms epoch. The bot's log lines carry no zone: those are New York wall time. */
function msNY(iso: string | null | undefined): number | null {
  if (!iso) return null
  const s = iso.trim().replace(/(\.\d{3})\d+/, '$1')
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const guess = Date.parse(/T/.test(s) ? `${s}Z` : `${s}T12:00:00Z`)
  if (!Number.isFinite(guess)) return null
  return guess - nyOffset(guess)
}

/** amber from 80%, red from 90% (the dashboard's usageColor) */
const loadTone = (v: number | null): Tone => (v == null ? 'fg' : v >= 90 ? 'acc2' : v >= 80 ? 'hot' : 'fg')
const batteryTone = (v: number | null): Tone => (v != null && v < 20 ? 'acc2' : 'fg')

/** "25.4 / 31.1 GB" (GiB, as Windows and htop show memory) */
const memSizes = (h: HostVM) => (h.memUsedGb != null && h.memTotalGb != null ? `${h.memUsedGb.toFixed(1)} / ${h.memTotalGb.toFixed(1)} GB` : null)
/** "3.1 / 4.0 TB", "10 GB / 1.0 TB" (decimal, as drives are sold) */
const sizesGb = (usedGb: number | null, totalGb: number | null) => {
  if (usedGb == null || totalGb == null) return null
  const dec = (gib: number) => (gib * 1024 ** 3) / 1e9
  const one = (gb: number, unit: 'TB' | 'GB') => (unit === 'TB' ? (gb / 1000).toFixed(1) : gb >= 10 ? gb.toFixed(0) : gb.toFixed(1))
  const used = dec(usedGb), total = dec(totalGb)
  const tu = total >= 1000 ? 'TB' : 'GB'
  const uu = used >= 100 && tu === 'TB' ? 'TB' : 'GB'
  return uu === tu ? `${one(used, uu)} / ${one(total, tu)} ${tu}` : `${one(used, uu)} ${uu} / ${one(total, tu)} ${tu}`
}
const diskSizes = (h: HostVM) => sizesGb(h.diskUsedGb, h.diskTotalGb)
/** "C: 94% (3.7 / 4.0 TB)" a line per disk, for a row's tooltip */
const diskLines = (h: HostVM) => h.disks.map((d) => `${d.name ?? 'Disk'} ${d.percent}% (${sizesGb(d.usedGb, d.totalGb)})`).join('\n')

const hostState = (h: HostVM): 'on' | 'stale' | 'off' => (!h.online ? 'off' : h.stale ? 'stale' : 'on')

/** Height of the page (the shell's vertical scroller) this screen lives in. */
function usePageHeight(ref: RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    const page = ref.current?.closest('.vl-page') as HTMLElement | null
    if (!page) return
    const set = () => setH(page.clientHeight)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(page)
    return () => ro.disconnect()
  }, [ref])
  return h
}

/** the UI zoom the desktop app applies to <html> (1 in a browser that never set one) */
const uiZoom = () => {
  if (typeof document === 'undefined') return 1
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(z) && z > 0 ? z : 1
}

/**
 * Column count from the element's own width: 1 + the steps it reaches. The
 * desktop app zooms <html>, which media queries never see, so a 1920 px
 * monitor at zoom 1.2 has 1600 px of layout. A hidden element (width 0) keeps
 * its last count. `steps` must be a constant.
 */
function useCols(ref: RefObject<HTMLElement | null>, steps: readonly number[]): number {
  const count = (w: number) => 1 + steps.filter((s) => w >= s).length
  const [n, setN] = useState(() => (typeof window === 'undefined' ? 1 : count(window.innerWidth / uiZoom() - 40)))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const set = () => {
      const w = el.clientWidth
      if (w > 0) setN(1 + steps.filter((s) => w >= s).length)
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, steps])
  return n
}

/**
 * Each time `on` turns true: a new epoch (charts remount and draw in again)
 * and ~1.8 s of `drawing`, after which the chart freezes (no idle loop).
 */
function useOpening(on: boolean): { epoch: number; drawing: boolean } {
  const [st, setSt] = useState({ epoch: 0, drawing: false })
  useEffect(() => {
    if (!on) {
      setSt((s) => (s.drawing ? { ...s, drawing: false } : s))
      return
    }
    setSt((s) => ({ epoch: s.epoch + 1, drawing: true }))
    const t = setTimeout(() => setSt((s) => ({ ...s, drawing: false })), 1800)
    return () => clearTimeout(t)
  }, [on])
  return st
}

/** A leading icon: lit (bright, glowing) or dim. */
function Ico({ name, lit, tone, size = 14 }: { name: IconName; lit?: boolean; tone?: IconTone; size?: number }) {
  return <Icon name={name} size={size} tone={tone ?? (lit ? 'fg' : 'dim')} glow={lit} className="sys-ico" />
}

/** Quiet freshness: the data's age, or "unreachable, showing 5m old" when the newest fetch failed. */
function Fresh({ live, now }: { live: Live<unknown>; now: number }) {
  if (!live.updatedAt) return live.failed ? <span className="sys-age" data-bad>unreachable</span> : null
  if (live.failed) return <span className="sys-age" data-bad>unreachable, showing {ago(live.updatedAt, now)} old</span>
  return <span className="sys-age">{ago(live.updatedAt, now)}</span>
}

/**
 * A thin-line panel (kit .vl-panel look) whose header and rows build in, while
 * the frame itself only fades.
 */
function Block({ label, value, icon, i, className, dense, children }: {
  label?: ReactNode
  value?: ReactNode
  /** leads the header label */
  icon?: ReactNode
  i: number
  className?: string
  dense?: boolean
  children?: ReactNode
}) {
  return (
    <section className={cx('vl-panel sys-block', className)} data-dense={dense || undefined} style={iv(i)}>
      {(label != null || value != null) && (
        <header className="vl-panel-head sys-head vl-build" style={iv(i)}>
          <span className="sys-head-label">{icon}<span className="vl-panel-label">{label}</span></span>
          {value != null && <span className="vl-panel-value">{value}</span>}
        </header>
      )}
      <div className="vl-panel-body">{children}</div>
    </section>
  )
}

/** Caret-notch text tabs on a hairline; a count shows beside a tab when one is given (search matches). */
function TextTabs<T extends string>({ items, value, onChange, label, className }: {
  items: { id: T; label: string; count?: number | null }[]
  value: T
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  return (
    <div className={cx('sys-filter', className)} role="tablist" aria-label={label} data-no-swipe>
      {items.map((t) => (
        <Press key={t.id} role="tab" aria-selected={value === t.id} data-on={value === t.id || undefined} data-none={t.count === 0 || undefined} className="sys-filter-btn" onPress={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <small className="sys-filter-n">{t.count}</small>}
        </Press>
      ))}
    </div>
  )
}

/** A folded list's "Show all 50 scans" / "Show fewer" line. */
function Fold({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <Press className="sys-fold sys-fold-more" data-open={open || undefined} aria-expanded={open} onPress={onToggle}>
      <span>{open ? 'Show fewer' : label}</span>
      <i aria-hidden />
    </Press>
  )
}

// ---------- screen-local data (GET only) ----------

// Desktop plumbing that systemd lists among odin's user services (Plasma,
// PipeWire, D-Bus, the portals, autostart tray apps): real, but never what
// "is something down" means. Same rule as the desktop dashboard.
const DESKTOP_UNIT = /^(app-|at-spi|dbus|dconf|obex|pipewire|plasma-|wireplumber|xdg-)/

type Health = 'ok' | 'watch' | 'alert'
type SvcItem = {
  key: string
  kind: 'container' | 'service'
  /** a docker container, a systemd user unit, or a system unit */
  scope: 'container' | 'user' | 'system'
  name: string
  health: Health
  detail: string
  title: string
  /** the name odin restarts it by (the raw unit name, escapes and all) */
  unit: string
  /** containers and user units: the backend restarts with docker or systemctl --user, never a system unit */
  restartable: boolean
  /** a container's image, a unit's description */
  about: string
  /** docker's status line, or "active (running)" */
  state: string
  /** published ports, tidied ("8191/tcp", "8000 → 80/tcp local", "8192/tcp internal") */
  ports: string[]
  /** the compose project and file a container came from */
  project: string | null
  compose: string | null
  /** lowercase text the search matches */
  hay: string
}
type TimerItem = { name: string; service: string; next: number | null; last: number | null; left: string; passed: string; hay: string }
type Exposure = ListeningPort['exposure']
type PortItem = {
  key: string
  port: number | null
  proto: string
  /** where it listens, in words: "all interfaces", "localhost", "tailnet" (or the address) */
  binds: string[]
  /** the process that owns it, else the container that publishes it */
  owner: string | null
  ownerKind: 'process' | 'container' | null
  pid: number | null
  exposure: Exposure
  hay: string
}
type ComposeItem = { path: string; project: string; hay: string }
type SvcSysVM = {
  v: 2
  containers: SvcItem[]
  /** docker, sshd, tailscaled, smb, the GitHub runner */
  system: SvcItem[]
  /** odin's own long-running user services (valkyrie-api, cloudflared, raven...) */
  user: SvcItem[]
  /** KDE / PipeWire / portal plumbing, folded away */
  desktop: SvcItem[]
  /** one-shot units that ran and exited: done, not down */
  oneshots: string[]
  timers: TimerItem[]
  ports: PortItem[]
  compose: ComposeItem[]
}

/** systemd escapes ("\x2d") and the desktop's autostart wrapper ("app-...@autostart") */
const tidyName = (n: string) =>
  n.replace(/\.(service|timer)$/, '')
    .replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/^app-(.+)@autostart$/, '$1')
    // "actions.runner.<owner>-<repo>.<runner>" -> "actions.runner (<runner>)"
    .replace(/^actions\.runner\.[^.]+\.(.+)$/, 'actions.runner ($1)')

const HEALTH_ORDER: Record<Health, number> = { alert: 0, watch: 1, ok: 2 }
const byHealth = (a: SvcItem, b: SvcItem) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name)

/** "Up 5 days (healthy)" -> "up 5d · healthy" */
const dockerAge = (s: string) => s
  .replace(/About an? (hour|minute)/i, (_, u: string) => `1${u[0].toLowerCase()}`)
  .replace(/Less than a second/i, '1s')
  .replace(/(\d+)\s+(second|minute|hour|day|week|month)s?/gi, (_, n: string, u: string) => `${n}${u === 'month' ? 'mo' : u[0].toLowerCase()}`)

/** docker's mapping "0.0.0.0:8191->8191/tcp": [bind, host port, container port, protocol] */
const PORT_MAP = /^(.*):(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(\w+)$/
const isLocalBind = (a: string) => /^(127\.|\[::1\]|\[::ffff:127\.|localhost)/i.test(a)

/** docker's port list, tidied: a mapping and its [::] twin once, a local bind marked, an unpublished port marked internal */
function tidyPorts(list: string[]): string[] {
  const out = new Set<string>()
  for (const p of list) {
    const m = PORT_MAP.exec(p)
    if (m) out.add(`${m[2]}${m[2] !== m[3] ? ` → ${m[3]}` : ''}/${m[4]}${isLocalBind(m[1]) ? ' local' : ''}`)
    else out.add(`${p} internal`)
  }
  return [...out]
}

const containerItem = (c: ServiceContainer): SvcItem => {
  const health: Health = c.state !== 'running' ? 'alert' : /unhealthy|restarting/i.test(c.status) ? 'watch' : 'ok'
  const flag = /\((healthy|unhealthy|health: starting)\)/i.exec(c.status)?.[1]
  const age = dockerAge(c.status.replace(/\s*\([^)]*\)\s*$/, '')).replace(/^Up\s+/i, 'up ')
  const ports = tidyPorts(c.ports ?? [])
  return {
    key: `c:${c.name}`, kind: 'container', scope: 'container', name: c.name, health,
    detail: flag ? `${age} · ${flag.toLowerCase()}` : age, title: `${c.image} · ${c.status}`, unit: c.name, restartable: true,
    about: c.image, state: c.status, ports, project: c.project ?? null, compose: c.composeFile ?? null,
    hay: [c.name, c.image, c.status, c.project ?? '', c.composeFile ?? '', ...ports, 'container'].join(' ').toLowerCase(),
  }
}

const unitItem = (scope: 'user' | 'system') => (u: ServiceUnit): SvcItem => {
  const health: Health = u.active === 'failed' ? 'alert' : u.sub === 'auto-restart' ? 'watch' : 'ok'
  const desc = u.description && u.description !== u.name ? u.description : ''
  const name = tidyName(u.name)
  return {
    key: `${scope}:${u.name}`, kind: 'service', scope, name, health,
    detail: health === 'alert' ? `failed${desc ? ` · ${desc}` : ''}` : health === 'watch' ? `restarting${desc ? ` · ${desc}` : ''}` : desc,
    title: `${u.description} · ${u.active} (${u.sub})`,
    unit: u.name, restartable: scope === 'user',
    about: desc, state: `${u.active} (${u.sub})`, ports: [], project: null, compose: null,
    hay: [name, u.name, u.description, u.active, u.sub, scope, 'service unit'].join(' ').toLowerCase(),
  }
}

/** "Sat 2026-10-17 03:20:37 EDT" -> ms epoch; null when the zone is not one we know */
const parseSystemd = (s: string): number | null => {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?: (\w+))?/.exec(s)
  if (!m) return null
  const off = m[3] === 'EDT' ? '-04:00' : m[3] === 'EST' ? '-05:00' : m[3] === 'UTC' || m[3] === 'GMT' ? 'Z' : null
  if (!off) return null
  const t = Date.parse(`${m[1]}T${m[2]}${off}`)
  return Number.isFinite(t) ? t : null
}

const timerItem = (t: ServiceTimer): TimerItem => {
  const name = tidyName(t.name)
  return { name, service: tidyName(t.service ?? ''), next: parseSystemd(t.next), last: parseSystemd(t.last), left: t.left, passed: t.passed, hay: `${name} ${t.service ?? ''} timer`.toLowerCase() }
}

/** the listening address in words */
const bindWord = (local: string): string => {
  const a = local.replace(/:\d+$/, '').replace(/%\w+/, '')
  if (a === '0.0.0.0' || a === '[::]' || a === '*') return 'all interfaces'
  if (isLocalBind(a)) return 'localhost'
  // Tailscale hands out addresses from the CGNAT block (100.64/10)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 'tailnet'
  // a unique local IPv6 address (fc00::/7): private, whichever network gave it
  if (/^\[f[cd][0-9a-f]{2}:/i.test(a)) return 'private IPv6'
  return a
}

const EXPOSURE_ORDER: Exposure[] = ['public', 'tailscale', 'lan', 'docker', 'unknown', 'local']
const EXPOSURE_LABEL: Record<Exposure, string> = { public: 'Public', tailscale: 'Tailnet', lan: 'LAN', docker: 'Docker', unknown: 'Unknown', local: 'Local' }

/**
 * Listening sockets, one row per port and owner: the v4 and v6 twins merge.
 * The owner is the process when odin can see it, else the container that
 * publishes that host port. An "unknown" exposure on an address that is
 * plainly local, tailnet or all-interfaces takes that exposure.
 */
function toPorts(ports: ListeningPort[], containers: ServiceContainer[]): PortItem[] {
  const published = new Map<string, string>()
  for (const c of containers) {
    for (const p of c.ports ?? []) {
      const m = PORT_MAP.exec(p)
      if (m && /^\d+$/.test(m[2])) published.set(`${m[4]}:${m[2]}`, c.name)
    }
  }
  const rank = (e: Exposure) => EXPOSURE_ORDER.indexOf(e)
  const rows = new Map<string, PortItem>()
  for (const p of ports) {
    const word = bindWord(p.local)
    const exp: Exposure = p.exposure !== 'unknown' ? p.exposure : word === 'localhost' ? 'local' : word === 'tailnet' ? 'tailscale' : word === 'all interfaces' ? 'public' : 'unknown'
    const box = p.port != null ? published.get(`${p.protocol}:${p.port}`) : undefined
    const owner = p.process ?? box ?? null
    const ownerKind = p.process ? 'process' : box ? 'container' : null
    const key = `${p.protocol}:${p.port ?? p.local}:${owner ?? ''}`
    const row = rows.get(key)
    if (row) {
      if (!row.binds.includes(word)) row.binds.push(word)
      if (rank(exp) < rank(row.exposure)) row.exposure = exp
      continue
    }
    rows.set(key, { key, port: p.port, proto: p.protocol, binds: [word], owner, ownerKind, pid: p.pid, exposure: exp, hay: '' })
  }
  return [...rows.values()]
    .map((r) => ({ ...r, hay: [r.port ?? '', r.proto, r.owner ?? '', ...r.binds, EXPOSURE_LABEL[r.exposure], r.exposure, 'port'].join(' ').toLowerCase() }))
    .sort((a, b) => rank(a.exposure) - rank(b.exposure) || (a.port ?? 0) - (b.port ?? 0))
}

function toSvcVM(s: ServicesStatus): SvcSysVM {
  const keep = (u: ServiceUnit) => u.sub === 'running' || u.active === 'failed' || u.sub === 'auto-restart'
  const user = s.services ?? []
  const sys = s.systemServices ?? []
  return {
    v: 2,
    containers: s.containers.map(containerItem).sort(byHealth),
    system: sys.filter(keep).map(unitItem('system')).sort(byHealth),
    user: user.filter((u) => keep(u) && !DESKTOP_UNIT.test(u.name)).map(unitItem('user')).sort(byHealth),
    desktop: user.filter((u) => keep(u) && DESKTOP_UNIT.test(u.name)).map(unitItem('user')).sort(byHealth),
    oneshots: [...user, ...sys].filter((u) => !keep(u)).map((u) => tidyName(u.name)),
    timers: (s.timers ?? []).map(timerItem).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
    ports: toPorts(s.ports ?? [], s.containers),
    compose: (s.composeFiles ?? []).map((c) => ({ path: c.path, project: c.project, hay: `${c.project} ${c.path} compose`.toLowerCase() }))
      .sort((a, b) => a.project.localeCompare(b.project)),
  }
}

/** odin's services with the dashboard's rules (scope, health, plumbing folded) plus timers, ports and compose files. */
const useServicesSys = () => useLive('servicesSys', async () => toSvcVM(await fetchServices()), 30_000, {
  // a view model cached by an older build lacks ports, compose files and the search text: refetch instead
  revive: (d) => (d && typeof d === 'object' && (d as { v?: number }).v === 2 ? (d as SvcSysVM) : undefined),
})

// ---------- screen ----------

export default function System({ active, sub }: ScreenProps) {
  const view: Sub = sub === 'services' || sub === 'trades' ? sub : 'hosts'
  const { setPose, setCenter } = useShell()
  const [picked, setPicked] = useSetting<string>('sysHost', 'thor')
  const hosts = useHosts()
  const svc = useServicesSys()
  const trade = useTrade(active && view === 'trades')
  // Trades mounts the first time it opens (its page read and 3D chart cost nothing until then), then stays
  const [tradesSeen, setTradesSeen] = useState(view === 'trades')
  useEffect(() => { if (view === 'trades') setTradesSeen(true) }, [view])
  const list = hosts.data ?? []
  // a model-only device (phone, tablet) picked while it has no host on the API
  const device = modelOnly(picked, list)
  const selected = list.find((h) => h.id === picked) ?? list.find((h) => h.id === 'thor') ?? list[0] ?? null
  const pose = poseFor(device ?? (selected ? hostModel(selected.id, selected.vehicle?.model) : null))

  useEffect(() => {
    if (active) setPose(pose)
  }, [active, pose, setPose])

  // strip center text (wide screens): the one line that matters on this sub-tab
  const online = list.filter((h) => h.online).length
  const sv = svc.data
  const counted = sv ? [...sv.containers, ...sv.system, ...sv.user] : []
  const down = sv ? [...counted, ...sv.desktop].filter((s) => s.health === 'alert').length : 0
  const watch = counted.filter((s) => s.health === 'watch').length
  const t = trade.data
  const center =
    view === 'hosts' ? (hosts.data ? `${online}/${list.length} online${device ? ` · ${MODEL_ONLY_LABEL[device]} model`
      : selected?.vehicle && selected.battery ? ` · ${selected.label} ${selected.battery.percent}%${selected.vehicle.rangeMi != null ? ` · ${selected.vehicle.rangeMi} mi` : ''}`
        : selected?.online && selected.cpu != null ? ` · ${selected.label} ${selected.cpu}%` : ''}` : 'Hosts')
      : view === 'services' ? (sv ? `${counted.length - counted.filter((s) => s.health === 'alert').length} up · ${down} down${watch ? ` · ${watch} watch` : ''}` : 'Services')
        : t?.equity != null
          ? `${usd(t.equity)}${t.equitySource === 'day_open' ? ' day-open' : ''}${t.changePct != null ? ` · ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%` : ''}${t.liveTrips != null && t.targetTrips ? ` · ${t.liveTrips}/${t.targetTrips} trips` : ''}`
          : 'Trades'
  useEffect(() => {
    if (active) setCenter(center)
  }, [active, center, setCenter])

  return (
    <div className="vl-screen sys">
      <div className="sys-view" data-view="hosts" hidden={view !== 'hosts'}>
        <HostsView on={active && view === 'hosts'} selected={device ? null : selected} device={device} onPick={setPicked} />
      </div>
      <div hidden={view !== 'services'}>
        <ServicesView on={active && view === 'services'} svc={svc} />
      </div>
      <div hidden={view !== 'trades'}>
        {tradesSeen && <TradesView on={active && view === 'trades'} />}
      </div>
    </div>
  )
}

// ---------- Hosts ----------

/** The picked id when it is a model-only device (phone, tablet) that has no host on the API. */
function modelOnly(id: string, list: HostVM[]): ModelOnlyId | null {
  return (MODEL_ONLY_IDS as readonly string[]).includes(id) && !list.some((h) => h.id === id) ? (id as ModelOnlyId) : null
}

function HostsView({ on, selected, device, onPick }: { on: boolean; selected: HostVM | null; device: ModelOnlyId | null; onPick: (id: string) => void }) {
  const detailRef = useRef<HTMLElement>(null)
  const hosts = useHosts()
  const { scroller } = useShell()
  const reduced = useReducedMotion()
  const now = useTick(on ? 5000 : 60_000)
  const { epoch } = useOpening(on)
  const list = useMemo(() => [...(hosts.data ?? [])].sort((a, b) => Number(b.online) - Number(a.online)), [hosts.data])
  const online = list.filter((h) => h.online).length
  // devices with a model and no host yet: listed under the hosts, never counted as online or offline
  const devices = hosts.data ? MODEL_ONLY_IDS.filter((id) => !list.some((h) => h.id === id)) : []
  // the chart window ends at the newest sample any host reported (the server's clock, not the phone's)
  const t1 = useMemo(() => {
    let m = 0
    for (const h of hosts.data ?? []) { const p = h.history[h.history.length - 1]; if (p && p.t > m) m = p.t }
    return m || now
  }, [hosts.data, now])

  // phone: the detail sits under the list; bring it into view when a pick leaves it off screen
  const pick = (id: string) => {
    onPick(id)
    const el = detailRef.current, sc = scroller()
    if (!el || !sc || window.matchMedia('(min-width: 640px)').matches) return
    const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect()
    if (r.top > sr.bottom - 140 || r.bottom < sr.top + 60) {
      sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - 8, behavior: reduced ? 'auto' : 'smooth' })
    }
  }

  return (
    <div className="sys-hosts">
      <Block
        className="sys-hosts-panel"
        label="Hosts"
        icon={<Ico name="online" />}
        value={<>{hosts.data ? <>{online}<span className="vl-panel-unit">/{list.length} online</span></> : '--'}<Fresh live={hosts} now={now} /></>}
        i={1}
      >
        {list.length > 0 ? (
          <div className="sys-host-list">
            <div className="sys-host-grid sys-host-cols vl-build" style={iv(1)} aria-hidden>
              <span />
              <span />
              <span className="sys-cols-spark">Last hour</span>
              <span><Icon name="cpu" size={11} tone="hot" />CPU</span>
              <span><Icon name="mem" size={11} tone="dim" />Mem</span>
              <span><Icon name="disk" size={11} tone="dim" />Disk</span>
            </div>
            {list.map((h, k) => (h.vehicle
              ? <CarRow key={h.id} h={h} k={k} selected={h.id === selected?.id} onPick={pick} />
              : <HostRow key={h.id} h={h} k={k} t1={t1} selected={h.id === selected?.id} onPick={pick} />
            ))}
            {devices.map((id, k) => (
              <DeviceRow key={id} id={id} k={list.length + k} selected={id === device} onPick={pick} />
            ))}
          </div>
        ) : (
          <div className="sys-empty">{hosts.failed ? 'Hosts unreachable' : 'Loading hosts'}</div>
        )}
      </Block>
      {device ? <DeviceDetail ref={detailRef} id={device} on={on} i={2 + list.length + devices.length} />
        : selected?.vehicle ? <CarDetail key={selected.id} ref={detailRef} host={selected} car={selected.vehicle} on={on} now={now} i={2 + list.length + devices.length} />
          : selected && <HostDetail ref={detailRef} host={selected} on={on} epoch={epoch} t1={t1} i={2 + list.length + devices.length} />}
    </div>
  )
}

/**
 * A device with an x-ray model and no host on the API (phone, tablet): its
 * model in the row's tile, "Model only" where a host shows its uptime, and no
 * numbers, because nothing reports them.
 */
function DeviceRow({ id, k, selected, onPick }: { id: ModelOnlyId; k: number; selected: boolean; onPick: (id: string) => void }) {
  const label = MODEL_ONLY_LABEL[id]
  return (
    <Press
      className="sys-host sys-host-grid sys-device vl-build"
      style={iv(2 + k)}
      data-on={selected || undefined}
      data-model=""
      aria-pressed={selected}
      aria-label={`${label}: model only, not reporting. Show its model`}
      onPress={() => onPick(id)}
    >
      <span className="sys-host-tile" data-state="model">
        <Icon name={id} size={17} tone={selected ? 'fg' : 'dim'} glow={selected} />
      </span>
      <span className="sys-host-id">
        <span className="sys-host-name">{label}</span>
        <span className="sys-host-meta">Model only</span>
      </span>
      <span className="sys-host-offline">Not reporting</span>
    </Press>
  )
}

/** The picked model-only device: its x-ray model, larger, and why there are no stats. */
function DeviceDetail({ id, on, i, ref }: { id: ModelOnlyId; on: boolean; i: number; ref: RefObject<HTMLElement | null> }) {
  const label = MODEL_ONLY_LABEL[id]
  const onHotspot = (spot: string) => {
    const name = heroModel(id).hotspots.find((s) => s.id === spot)?.label ?? title(spot)
    toast(`${name}: the ${label.toLowerCase()} does not report stats yet`)
  }
  return (
    <section ref={ref} className="vl-panel sys-block sys-detail sys-device-detail" style={iv(i)} data-state="model">
      <header className="vl-panel-head sys-head sys-detail-head vl-build" style={iv(i)}>
        <span className="sys-detail-id vl-caps">
          <Icon name={id} size={15} tone="fg" glow />
          <span>{label}</span>
          <span className="sys-detail-state" data-state="model">Model only</span>
        </span>
      </header>
      <div className="sys-device-body">
        <div className="sys-device-model">
          <Hero active={on} pose={poseFor(id)} host={id} fill={0.86} layoutKey={id} className="absolute inset-0" onHotspot={onHotspot} />
        </div>
        <div className="sys-device-note vl-build" style={iv(i + 1)}>
          <b><Icon name="offline" size={15} tone="dim" />Not reporting</b>
          <span>This {label.toLowerCase()} does not report to Valkyrie yet, so there are no numbers to show.</span>
        </div>
      </div>
    </section>
  )
}

/** spot: the model's hotspot the plate lights, when it is not the plate's id (each disk lights the one disk diamond) */
type Metric = { id: string; icon: IconName; label: string; value: number | null; tone: Tone; sizes: string | null; spot?: string; aria?: string }

/**
 * The selected host: its x-ray model, large, over one gauge plate per reading
 * (the lit plate is the part the model highlights), and its last hour as an
 * honest chart in a panel of its own (under the host list on a wide screen,
 * under this panel on the phone).
 */
function HostDetail({ host, on, epoch, t1, i, ref }: { host: HostVM; on: boolean; epoch: number; t1: number; i: number; ref: RefObject<HTMLElement | null> }) {
  // the chart draws in when the tab opens and again for each host picked, then holds still
  const [drawing, setDrawing] = useState(false)
  useEffect(() => {
    if (!on) return
    setDrawing(true)
    const t = setTimeout(() => setDrawing(false), 1800)
    return () => clearTimeout(t)
  }, [on, host.id])
  const palette = usePalette()
  const reduced = useReducedMotion()
  const model = hostModel(host.id)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => { setFocus(null) }, [host.id])
  const state = hostState(host)
  const spots = useMemo(() => new Map(model ? heroModel(model).hotspots.map((s) => [s.id, s.label] as const) : []), [model])

  // the phone and tablet report a battery and storage, never CPU or memory: no empty plates for those,
  // and the battery leads where the CPU would
  const noLoad = host.mobile || (host.cpu == null && host.mem == null && !!host.battery)
  // more than one disk: a plate each, named, in a row of their own under the others
  const disks: Metric[] = host.disks.length > 1
    ? host.disks.map((d, k) => ({
      id: `disk-${k}`, icon: 'disk', label: d.name ?? `Disk ${k + 1}`, aria: `Disk ${d.name ?? k + 1}`, value: d.percent, tone: loadTone(d.percent), sizes: sizesGb(d.usedGb, d.totalGb), spot: 'disk',
    } satisfies Metric))
    : []
  const metrics: Metric[] = [
    ...(noLoad ? [] : [
      { id: 'cpu', icon: 'cpu', label: 'CPU', value: host.cpu, tone: loadTone(host.cpu), sizes: host.cores ? `${host.cores} cores` : null } satisfies Metric,
      { id: 'mem', icon: 'mem', label: 'Memory', value: host.mem, tone: loadTone(host.mem), sizes: memSizes(host) } satisfies Metric,
    ]),
    ...(disks.length || (host.mobile && host.disk == null) ? [] : [
      { id: 'disk', icon: 'disk', label: spots.get('disk') ?? 'Disk', value: host.disk, tone: loadTone(host.disk), sizes: diskSizes(host) } satisfies Metric,
    ]),
  ]
  if (host.battery) {
    metrics.push({ id: 'battery', icon: host.battery.charging ? 'charging' : 'battery', label: 'Battery', value: host.battery.percent, tone: batteryTone(host.battery.percent), sizes: host.battery.charging ? 'charging' : null })
  }
  const plates = [...metrics, ...disks]
  const byId = new Map(plates.map((m) => [m.id, m] as const))
  // a hotspot lights the first plate that maps to it (the disk diamond: the system disk)
  const bySpot = new Map<string, string>()
  for (const m of plates) if (!bySpot.has(m.spot ?? m.id)) bySpot.set(m.spot ?? m.id, m.id)
  // hotspots without a reading (GPU, exhaust fans, lenses) keep the lit plate where it is
  const onHotspot = (id: string) => {
    const plate = bySpot.get(id)
    if (!plate || !host.online) {
      toast(`${spots.get(id) ?? title(id)}: ${host.online ? 'no reading from this host' : `${host.label} is offline`}`)
      return
    }
    setFocus((cur) => (cur && byId.get(cur)?.spot === id) || cur === plate ? null : plate)
  }
  const home = noLoad ? 'battery' : 'cpu'
  const lit = focus && byId.has(focus) ? focus : home
  const litSpot = focus && byId.has(focus) ? (byId.get(focus)!.spot ?? focus) : null
  const up = uptime(host.uptime)
  const gauge = (m: Metric, k: number) => (
    <Press
      key={m.id}
      className="sys-gauge vl-build"
      style={iv(i + 1 + k)}
      data-plate={m.id}
      data-lit={m.id === lit || undefined}
      aria-pressed={m.id === lit}
      aria-label={`${m.aria ?? m.label} ${m.value ?? 'unknown'}%: highlight on the model`}
      onPress={() => setFocus(m.id === home ? null : m.id === focus ? null : m.id)}
    >
      <span className="sys-gauge-head">
        <Icon name={m.icon} size={14} tone={m.id === lit ? 'fg' : m.tone === 'fg' ? 'dim' : m.tone} glow={m.id === lit} />
        <span className="sys-gauge-label">{m.label}</span>
        {m.sizes && <em className="vl-ellipsis">{m.sizes}</em>}
        <b data-tone={m.tone}>{m.value ?? '--'}<small>%</small></b>
      </span>
      <Bar value={m.value} tone={m.tone} ticks={4} />
    </Press>
  )

  // the last hour, x by clock: a host that restarted fills only the newest part
  const t0 = t1 - HOUR
  const hist = useMemo(() => host.history.filter((p) => p.t >= t0 - 30_000), [host.history, t0])
  const at = useMemo(() => hist.map((p) => clamp((p.t - t0) / HOUR, 0, 1)), [hist, t0])
  const cpu = useMemo(() => hist.map((p) => p.cpu), [hist])
  const mem = useMemo(() => hist.map((p) => p.mem), [hist])
  const hasMem = mem.some((v) => v != null)
  const peak = Math.max(host.cpu ?? 0, ...cpu.map((v) => v ?? 0))
  const chart = host.online && hist.length > 1

  return (
    <>
      <section ref={ref} className="vl-panel sys-block sys-detail" style={iv(i)} data-nomodel={!model || undefined} data-state={state}>
        <header className="vl-panel-head sys-head sys-detail-head vl-build" style={iv(i)}>
          <span className="sys-detail-id vl-caps">
            <Icon name={hostIcon(host.id)} size={15} tone={state === 'off' ? 'faint' : state === 'stale' ? 'hot' : 'fg'} glow={host.online} />
            <span>{host.label}</span>
            <span className="sys-detail-state" data-state={state}>{state === 'on' ? 'Online' : state === 'stale' ? 'Stale' : 'Offline'}</span>
          </span>
          {host.online && up && <span className="sys-detail-up"><Ico name="uptime" size={12} />up {up}</span>}
        </header>
        <div className="sys-detail-body">
          {model && (
            <div className="sys-detail-model">
              <Hero
                active={on}
                pose={poseFor(model)}
                host={model}
                fill={0.9}
                layoutKey={`${host.id}:${plates.length}`}
                className="absolute inset-0"
                activeHotspot={litSpot}
                onHotspot={onHotspot}
              />
            </div>
          )}
          {host.online && !plates.length ? (
            <div className="sys-detail-off vl-build" style={iv(i + 1)}>
              <b><Icon name="battery" size={16} tone="dim" />No battery report yet</b>
              <span>Open the Home Assistant app on this device (odin:8123)</span>
            </div>
          ) : host.online ? (
            <div className="sys-gauges" data-n={plates.length} data-disks={disks.length || undefined}>
              {metrics.map((m, k) => gauge(m, k))}
              {disks.length > 0 && <div className="sys-gauge-disks">{disks.map((m, k) => gauge(m, metrics.length + k))}</div>}
            </div>
          ) : (
            <div className="sys-detail-off vl-build" style={iv(i + 1)}>
              <b><Icon name="offline" size={16} tone="dim" />Offline</b>
              <span>{host.mobile && host.seen ? `Last seen ${when(host.seen, t1)} ET` : 'No stats published'}</span>
            </div>
          )}
        </div>
      </section>
      {chart && (
        <section className="vl-panel sys-block sys-chart" style={iv(i + 6)}>
          <header className="vl-panel-head sys-head sys-chart-head vl-build" style={iv(i + 6)}>
            <span className="sys-head-label"><Ico name="clock" size={13} /><span className="vl-panel-label">{host.label} · last hour</span></span>
            <span className="sys-chart-cap">
              <i className="sys-key" data-c="cpu" />CPU
              {hasMem && <><i className="sys-key" data-c="mem" />Memory</>}
              <span className="sys-chart-peak">peak {Math.round(peak)}%</span>
            </span>
          </header>
          <div className="sys-detail-ribbon">
            <TrackRibbon
              key={`${host.id}:${epoch}`}
              honest
              series={cpu}
              series2={hasMem ? mem : undefined}
              at={at}
              ticks={[{ v: 50, label: '50%' }, { v: 100, label: '100%' }]}
              xTicks={[{ at: 0, label: '60 min ago' }, { at: 0.5, label: '30 min' }, { at: 1, label: 'now' }]}
              palette={palette}
              paused={!drawing}
              motion={reduced ? 'reduced' : 'full'}
              style={{ height: '100%' }}
            />
          </div>
        </section>
      )}
    </>
  )
}

/** The last hour as a flat 2D sparkline: fixed 0-100, x by clock, CPU in hot, memory in fg. */
function Spark({ h, t1 }: { h: HostVM; t1: number }) {
  const W = 120, H = 26
  const t0 = t1 - HOUR
  const path = (k: 'cpu' | 'mem') => {
    let d = ''
    let prev = -Infinity
    for (const p of h.history) {
      const v = p[k]
      // a gap of more than 3 minutes breaks the line instead of bridging it
      if (v == null || p.t < t0 - 30_000) { prev = -Infinity; continue }
      const x = clamp((p.t - t0) / HOUR, 0, 1) * W
      const y = H - 1 - (clamp(v, 0, 100) / 100) * (H - 2)
      d += `${p.t - prev > 180_000 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      prev = p.t
    }
    return d
  }
  return (
    <svg className="sys-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <line className="sys-spark-mid" x1={0} x2={W} y1={H / 2} y2={H / 2} />
      <line className="sys-spark-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
      <path className="sys-spark-mem" d={path('mem')} />
      <path className="sys-spark-cpu" d={path('cpu')} />
    </svg>
  )
}

function Cell({ value, tone, sizes, c }: { value: number | null; tone: Tone; sizes?: string | null; c?: string }) {
  return (
    <span className="sys-cell" data-c={c}>
      <b data-tone={tone}>{value ?? '--'}<small>%</small></b>
      {sizes && <em>{sizes}</em>}
      <Bar value={value} tone={tone} ticks={4} />
    </span>
  )
}

/**
 * The Disk column. One disk: a Cell. More than one: a line per disk (name, bar,
 * percent) on a wide screen, and the fullest disk's figure where the column is
 * too narrow for names.
 */
function DiskCell({ h }: { h: HostVM }) {
  if (h.disks.length < 2) return <Cell value={h.disk} tone={loadTone(h.disk)} sizes={diskSizes(h)} />
  const tone = loadTone(h.disk)
  return (
    <span className="sys-cell sys-disks" title={diskLines(h)}>
      <b data-tone={tone}>{h.disk ?? '--'}<small>%</small></b>
      <Bar value={h.disk} tone={tone} ticks={4} />
      <span className="sys-disk-list">
        {h.disks.map((d, k) => (
          <span key={k} className="sys-disk">
            <i className="vl-ellipsis">{d.name ?? k + 1}</i>
            <Bar value={d.percent} tone={loadTone(d.percent)} ticks={1} />
            <b data-tone={loadTone(d.percent)}>{d.percent}<small>%</small></b>
          </span>
        ))}
      </span>
    </span>
  )
}

function HostRow({ h, k, t1, selected, onPick }: { h: HostVM; k: number; t1: number; selected: boolean; onPick: (id: string) => void }) {
  const state = hostState(h)
  const up = upShort(h.uptime)
  const bat = h.battery
  return (
    <Press
      className="sys-host sys-host-grid vl-build"
      style={iv(2 + k)}
      data-on={selected || undefined}
      data-off={!h.online || undefined}
      aria-pressed={selected}
      aria-label={`${title(h.label)}: show its details`}
      onPress={() => onPick(h.id)}
    >
      <span className="sys-host-tile" data-state={state}>
        <Icon name={hostIcon(h.id)} size={17} tone={state === 'off' ? 'faint' : state === 'stale' ? 'hot' : 'fg'} glow={h.online} />
      </span>
      <span className="sys-host-id">
        <span className="sys-host-name">{title(h.label)}</span>
        <span className="sys-host-meta">
          {!h.online ? 'Offline' : (
            <>
              {state === 'stale' && <span data-tone="hot">Stale · </span>}
              {up ? `up ${up}` : 'Online'}
              {bat && (
                <span className="sys-host-bat" data-tone={batteryTone(bat.percent)}>
                  <Icon name={bat.charging ? 'charging' : 'battery'} size={12} tone={bat.percent < 20 ? 'acc2' : 'dim'} title={bat.charging ? 'Battery, charging' : 'Battery'} />
                  {bat.percent}%
                </span>
              )}
            </>
          )}
        </span>
      </span>
      {h.mobile ? (
        <span className="sys-host-offline">
          {!h.online && h.seen ? `Last seen ${when(h.seen, t1)} ET` : h.battery ? (h.disk != null ? `Storage ${h.disk}%` : 'Battery only') : 'No battery report yet'}
        </span>
      ) : h.online ? (
        <>
          <Spark h={h} t1={t1} />
          <Cell value={h.cpu} tone={loadTone(h.cpu)} c="cpu" />
          <Cell value={h.mem} tone={loadTone(h.mem)} sizes={memSizes(h)} />
          <DiskCell h={h} />
        </>
      ) : (
        <span className="sys-host-offline">No stats published</span>
      )}
    </Press>
  )
}

// ---------- cars ----------

type Car = NonNullable<HostVM['vehicle']>
type CarFocus = 'battery' | 'range' | 'limit' | 'charge' | 'cabin'
/** the model's diamond each plate lights, and the plate each diamond lights */
const CAR_SPOT: Record<CarFocus, string> = { battery: 'battery', range: 'battery', limit: 'battery', charge: 'charge', cabin: 'cabin' }
const SPOT_PLATE: Record<string, CarFocus> = { battery: 'battery', charge: 'charge', cabin: 'cabin' }

/** asleep is still there (its numbers are from when it fell asleep); unknown means no status sensor */
const CAR_STATE: Record<Car['state'], string> = { awake: 'Awake', asleep: 'Asleep', offline: 'Offline', unknown: 'Online' }
const CHARGE_WORD: Record<NonNullable<Car['charging']>, string> = {
  starting: 'Starting to charge', charging: 'Charging', stopped: 'Charging stopped', complete: 'Charge complete', disconnected: 'Unplugged', no_power: 'No power at the charger',
}
const isCharging = (v: Car) => v.charging === 'charging' || v.charging === 'starting'
const isPlugged = (v: Car) => v.cable === true || (v.charging != null && v.charging !== 'disconnected')
/** on (awake), sleep, stale or off: a sleeping car is not offline */
const carState = (h: HostVM): 'on' | 'sleep' | 'stale' | 'off' => (!h.online ? 'off' : h.stale ? 'stale' : h.vehicle?.state === 'asleep' ? 'sleep' : 'on')
/** the row's charging line: "Charging 11.5 kW", "Charge complete", "Not plugged in" */
const chargeLine = (v: Car) => (isCharging(v) ? `Charging${v.chargerKw ? ` ${v.chargerKw} kW` : ''}`
  : isPlugged(v) ? (v.charging && v.charging !== 'disconnected' ? CHARGE_WORD[v.charging] : 'Plugged in') : 'Not plugged in')

/** A car: battery and state under its name, its range and charging where a host shows its load. */
function CarRow({ h, k, selected, onPick }: { h: HostVM; k: number; selected: boolean; onPick: (id: string) => void }) {
  const v = h.vehicle!
  const state = carState(h)
  const bat = h.battery
  const charging = isCharging(v)
  return (
    <Press
      className="sys-host sys-host-grid sys-car vl-build"
      style={iv(2 + k)}
      data-on={selected || undefined}
      data-off={!h.online || undefined}
      data-sleep={state === 'sleep' || undefined}
      aria-pressed={selected}
      aria-label={`${title(h.label)}: show its details`}
      onPress={() => onPick(h.id)}
    >
      <span className="sys-host-tile" data-state={state}>
        <Icon name="car" size={17} tone={state === 'off' ? 'faint' : state === 'stale' ? 'hot' : 'fg'} glow={state === 'on'} />
      </span>
      <span className="sys-host-id">
        <span className="sys-host-name">{title(h.label)}</span>
        <span className="sys-host-meta">
          {state === 'stale' && <span data-tone="hot">Stale · </span>}
          {CAR_STATE[v.state]}
          {bat && (
            <span className="sys-host-bat" data-tone={batteryTone(bat.percent)}>
              <Icon name={bat.charging ? 'charging' : 'battery'} size={12} tone={bat.percent < 20 ? 'acc2' : 'dim'} title={bat.charging ? 'Battery, charging' : 'Battery'} />
              {bat.percent}%
            </span>
          )}
        </span>
      </span>
      <span className="sys-car-facts">
        <b className="sys-car-range">{v.rangeMi ?? '--'}<small>mi</small></b>
        <em className="sys-car-charge" data-on={charging || undefined}>
          <Icon name={charging || isPlugged(v) ? 'plugged' : 'plug'} size={11} tone={charging ? 'fg' : 'dim'} glow={charging} />
          {chargeLine(v)}
        </em>
      </span>
    </Press>
  )
}

type CarPlate = { id: CarFocus; icon: IconName; label: string; value: number | string | null; unit: string; sub: string | null; bar: number | null; tone: Tone; say: string }

/**
 * The picked car: its x-ray model, large, over its plates (Battery with the
 * charging state, Range, Charge limit, and Charging power or Not plugged in),
 * then the lock, home or away and the cabin as small facts. Each plate lights
 * its part on the model (the pack, the charge port, the cabin) and each
 * diamond lights its plate. Read only: nothing here wakes the car.
 */
function CarDetail({ host, car: v, on, now, i, ref }: { host: HostVM; car: Car; on: boolean; now: number; i: number; ref: RefObject<HTMLElement | null> }) {
  const model = hostModel(host.id, v.model)
  const { go } = useShell()
  const [, setCarPick] = useSetting<string>('carPick', '')
  // keyed by the car (HostsView), so another car starts with nothing picked
  const [focus, setFocus] = useState<CarFocus | null>(null)
  const state = carState(host)
  const pct = host.battery?.percent ?? null
  const charging = isCharging(v)
  const plugged = isPlugged(v)
  const fullRange = pct != null && pct >= 5 && v.rangeMi != null ? Math.round((v.rangeMi / pct) * 100) : null
  const toLimit = pct != null && v.chargeLimit != null ? v.chargeLimit - pct : null
  const plates: CarPlate[] = [
    { id: 'battery', icon: charging ? 'charging' : 'battery', label: 'Battery', value: pct, unit: '%', sub: v.charging ? CHARGE_WORD[v.charging] : null, bar: pct, tone: batteryTone(pct), say: `Battery ${pct ?? 'unknown'}%` },
    { id: 'range', icon: 'range', label: 'Range', value: v.rangeMi, unit: 'mi', sub: fullRange != null ? `${fullRange} mi at 100%` : null, bar: pct, tone: 'fg', say: `Range ${v.rangeMi ?? 'unknown'} mi` },
    { id: 'limit', icon: 'gauge', label: 'Charge limit', value: v.chargeLimit, unit: '%', sub: toLimit == null ? null : toLimit > 0 ? `${toLimit}% to go` : 'Reached', bar: v.chargeLimit, tone: 'fg', say: `Charge limit ${v.chargeLimit ?? 'unknown'}%` },
    charging
      ? {
        id: 'charge', icon: 'plugged', label: 'Charging', value: v.chargerKw, unit: 'kW',
        sub: [v.chargeRateMph ? `+${v.chargeRateMph} mi/h` : null, v.fullAt ? `full ${when(v.fullAt, now)} ET` : null].filter(Boolean).join(' · ') || null,
        bar: pct != null && v.chargeLimit ? Math.min(100, (pct / v.chargeLimit) * 100) : null, tone: 'fg', say: `Charging ${v.chargerKw ?? 'unknown'} kW`,
      }
      : {
        id: 'charge', icon: plugged ? 'plugged' : 'plug', label: 'Charging', value: plugged ? 'Plugged in' : 'Not plugged in', unit: '',
        sub: plugged && v.charging && v.charging !== 'disconnected' ? CHARGE_WORD[v.charging] : null, bar: null, tone: 'fg', say: `Charging: ${plugged ? 'plugged in' : 'not plugged in'}`,
      },
  ]
  const lit: CarFocus = focus ?? 'battery'
  const onHotspot = (spot: string) => {
    const plate = SPOT_PLATE[spot]
    if (!plate) return
    setFocus((cur) => (cur === plate ? null : plate))
  }
  const read = host.ts
  const when1 = v.state === 'asleep' && v.since ? `asleep since ${when(v.since, now)} ET`
    : !host.online && read ? `last read ${when(read, now)} ET`
      : read ? `read ${ago(read, now)} ago` : null
  const temps = [v.insideF != null ? `${v.insideF}°F inside` : null, v.outsideF != null ? `${v.outsideF}°F out` : null].filter(Boolean).join(' · ')

  return (
    <section ref={ref} className="vl-panel sys-block sys-detail sys-car-detail" style={iv(i)} data-nomodel={!model || undefined} data-state={state}>
      <header className="vl-panel-head sys-head sys-detail-head vl-build" style={iv(i)}>
        <span className="sys-detail-id vl-caps">
          <Icon name="car" size={15} tone={state === 'off' ? 'faint' : state === 'stale' ? 'hot' : 'fg'} glow={state === 'on'} />
          <span>{host.label}</span>
          <span className="sys-detail-state" data-state={state}>{state === 'stale' ? 'Stale' : CAR_STATE[v.state]}</span>
        </span>
        {when1 && <span className="sys-detail-up"><Ico name="clock" size={12} />{when1}</span>}
      </header>
      <div className="sys-detail-body">
        {model && (
          <div className="sys-detail-model">
            <Hero
              active={on}
              pose={poseFor(model)}
              host={model}
              hostId={host.id}
              fill={0.94}
              layoutKey={`${host.id}:car`}
              className="absolute inset-0"
              activeHotspot={focus ? CAR_SPOT[focus] : null}
              onHotspot={onHotspot}
            />
          </div>
        )}
        <div className="sys-gauges" data-n={plates.length}>
          {plates.map((m, k) => (
            <Press
              key={m.id}
              className="sys-gauge vl-build"
              style={iv(i + 1 + k)}
              data-lit={m.id === lit || undefined}
              data-plate={m.id}
              aria-pressed={m.id === lit}
              aria-label={`${m.say}: highlight on the model`}
              onPress={() => setFocus(m.id === focus ? null : m.id)}
            >
              <span className="sys-gauge-head">
                <Icon name={m.icon} size={14} tone={m.id === lit ? 'fg' : m.tone === 'fg' ? 'dim' : m.tone} glow={m.id === lit} />
                <span className="sys-gauge-label">{m.label}</span>
                {m.sub && <em className="vl-ellipsis">{m.sub}</em>}
                <b data-tone={m.tone} data-text={typeof m.value === 'string' || undefined}>{m.value ?? '--'}{m.unit && <small>{m.unit}</small>}</b>
              </span>
              {typeof m.value !== 'string' && <Bar value={m.bar} tone={m.tone} ticks={4} />}
            </Press>
          ))}
        </div>
        <div className="sys-car-more vl-build" style={iv(i + 6)}>
          {v.locked != null && (
            <span className="sys-car-fact" data-fact="lock"><Icon name={v.locked ? 'locked' : 'unlocked'} size={13} tone={v.locked ? 'dim' : 'hot'} />{v.locked ? 'Locked' : 'Unlocked'}</span>
          )}
          {v.home != null && (
            <span className="sys-car-fact" data-fact="home"><Icon name={v.home ? 'home' : 'away'} size={13} tone="dim" />{v.home ? 'Home' : 'Away'}</span>
          )}
          {temps && (
            <Press
              className="sys-car-fact"
              data-fact="cabin"
              data-lit={lit === 'cabin' || undefined}
              aria-pressed={lit === 'cabin'}
              aria-label={`Cabin ${temps}: highlight on the model`}
              onPress={() => setFocus(focus === 'cabin' ? null : 'cabin')}
            >
              <Icon name="temp" size={13} tone={lit === 'cabin' ? 'fg' : 'dim'} glow={lit === 'cabin'} />{temps}
              {v.climateOn && <span className="sys-car-climate">Climate on</span>}
            </Press>
          )}
          {/* the controls live on the Car tab: this car, picked there */}
          <Press className="sys-car-open vl-link" aria-label={`Open Car: ${host.label}'s controls`} onPress={() => { setCarPick(host.id); go('car') }}>
            <Icon name="car" size={13} tone="dim" />Open Car<Icon name="go" size={12} tone="dim" />
          </Press>
        </div>
      </div>
    </section>
  )
}

// ---------- Services ----------

const SVC_TAB_IDS = ['services', 'timers', 'apps', 'ports', 'compose'] as const
type SvcTab = (typeof SVC_TAB_IDS)[number]
const SVC_TAB_LABEL: Record<SvcTab, string> = { services: 'Services', timers: 'Timers', apps: 'Apps', ports: 'Ports', compose: 'Compose' }
/** Services columns: two from 600 px of screen, three from 1380 px */
const SVC_COLS = [600, 1380] as const

const appHay = (a: LauncherEntry) => `${a.name} ${a.category} ${a.owner ?? ''} ${a.url} app`.toLowerCase()

/**
 * Mounted once the Apps tab (or a search) wants the web apps: the launcher
 * read checks every app's health, so it never runs before anyone looks.
 */
function AppsSource({ onData }: { onData: (l: Live<LauncherEntry[]>) => void }) {
  const apps = useLive('launcherSys', fetchLauncher, 60_000)
  useEffect(() => { onData(apps) }, [apps.data, apps.updatedAt, apps.failed]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function ServicesView({ on, svc }: { on: boolean; svc: Live<SvcSysVM> }) {
  const now = useTick(on ? 5000 : 60_000)
  const rootRef = useRef<HTMLDivElement>(null)
  const cols = useCols(rootRef, SVC_COLS)
  const [tab, setTab] = useSetting<SvcTab>('sysSvcTab', 'services', SVC_TAB_IDS)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const toggle = useCallback((k: string) => setOpenKey((cur) => (cur === k ? null : k)), [])
  const searchRef = useRef<HTMLInputElement>(null)
  const appsWanted = tab === 'apps' || q !== ''
  const [appsSeen, setAppsSeen] = useState(appsWanted)
  useEffect(() => { if (appsWanted) setAppsSeen(true) }, [appsWanted])
  const [apps, setApps] = useState<Live<LauncherEntry[]> | null>(null)

  // "/" puts the cursor in the search on a desktop keyboard
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])

  const d = svc.data
  const counted = d ? [...d.containers, ...d.system, ...d.user] : []
  const down = d ? [...counted, ...d.desktop].filter((s) => s.health === 'alert') : []
  const watch = counted.filter((s) => s.health === 'watch').length
  const upCount = counted.filter((s) => s.health !== 'alert').length

  // one search across every tab; the tabs show where the matches are
  const f = useMemo(() => {
    const m = <T extends { hay: string }>(l: T[]) => (q ? l.filter((x) => x.hay.includes(q)) : l)
    return d ? {
      containers: m(d.containers), system: m(d.system), user: m(d.user), desktop: m(d.desktop),
      timers: m(d.timers), ports: m(d.ports),
      compose: q ? d.compose.filter((c) => c.hay.includes(q) || d.containers.some((x) => x.project === c.project && x.hay.includes(q))) : d.compose,
    } : null
  }, [d, q])
  const appList = useMemo(() => {
    const l = apps?.data ?? []
    return q ? l.filter((a) => appHay(a).includes(q)) : l
  }, [apps?.data, q])
  const counts: Record<SvcTab, number | null> | null = q && f ? {
    services: f.containers.length + f.system.length + f.user.length + f.desktop.length,
    timers: f.timers.length,
    apps: apps?.data ? appList.length : null,
    ports: f.ports.length,
    compose: f.compose.length,
  } : null
  const tabs = SVC_TAB_IDS.map((id) => ({ id, label: SVC_TAB_LABEL[id], count: counts?.[id] }))
  const nothing = q !== '' && counts != null && counts[tab] === 0

  return (
    <div ref={rootRef} className="sys-svc" data-cols={cols}>
      {appsSeen && <AppsSource onData={setApps} />}
      <div className="sys-svc-top vl-build" style={iv(0)}>
        <div className="sys-svc-big" data-bad={down.length > 0 || undefined}>
          {d && <Icon name={down.length ? 'alert' : 'service'} size={28} tone={down.length ? 'acc2' : 'fg'} glow />}
          {!d ? '--' : down.length ? <>{down.length}<small> down</small></> : <>All up</>}
        </div>
        <div className="sys-svc-sub">
          <span><Ico name="done" size={13} /><b>{d ? upCount : '--'}</b> up</span>
          {watch > 0 && <span data-watch><Ico name="refresh" size={13} lit tone="hot" /><b>{watch}</b> watch</span>}
          <span data-bad={down.length > 0 || undefined}><Ico name="alert" size={13} lit={down.length > 0} tone={down.length > 0 ? 'acc2' : 'dim'} /><b>{d ? down.length : '--'}</b> down</span>
          <Fresh live={svc} now={now} />
        </div>
        <SearchField value={query} onChange={setQuery} inputRef={searchRef} />
        <TextTabs label="Services view" items={tabs} value={tab} onChange={setTab} />
      </div>

      {down.length > 0 && (
        <Block label="Down" icon={<Ico name="alert" lit tone="acc2" />} value={down.length} i={1} className="sys-svc-down">
          <div className="sys-svc-rows">
            {down.map((s, k) => <SvcRow key={s.key} s={s} k={k + 2} restart open={openKey === `down:${s.key}`} onToggle={() => toggle(`down:${s.key}`)} />)}
          </div>
        </Block>
      )}

      {!d && (
        <div className="sys-quiet vl-build" style={iv(1)}>
          {svc.failed ? <><Ico name="offline" size={13} lit tone="hot" />odin is not answering.</> : 'Loading services'}
        </div>
      )}

      {nothing && <div className="sys-quiet">Nothing in {SVC_TAB_LABEL[tab]} matches “{query.trim()}”.</div>}

      {f && d && tab === 'services' && (() => {
        const groups = {
          containers: <SvcGroup key="c" label="Containers" icon="container" list={f.containers} i={2} openKey={openKey} onToggle={toggle} />,
          system: <SvcGroup key="s" label="System" icon="service" list={f.system} i={3} openKey={openKey} onToggle={toggle} />,
          user: (
            <SvcGroup
              key="u" label="User services" icon="service" list={f.user} i={4} openKey={openKey} onToggle={toggle}
              note={!q && d.oneshots.length ? `Not counted: ${d.oneshots.length} one-shot unit${d.oneshots.length > 1 ? 's' : ''} that ran and exited (${d.oneshots.join(', ')})` : undefined}
            />
          ),
          desktop: <DesktopGroup key="d" list={f.desktop} i={5} forced={q !== ''} openKey={openKey} onToggle={toggle} />,
        }
        const layout = cols >= 3 ? [[groups.containers], [groups.user], [groups.system, groups.desktop]]
          : cols === 2 ? [[groups.containers], [groups.system, groups.user, groups.desktop]]
            : [[groups.containers, groups.system, groups.user, groups.desktop]]
        return (
          <div className="sys-svc-cols">
            {layout.map((col, k) => <div key={k} className="sys-svc-stack">{col}</div>)}
          </div>
        )
      })()}

      {f && tab === 'timers' && !nothing && <TimersList timers={f.timers} now={now} />}

      {tab === 'apps' && !nothing && <AppsList apps={apps} list={appList} now={now} />}

      {f && d && tab === 'ports' && !nothing && <PortsList ports={f.ports} total={d.ports.length} />}

      {f && d && tab === 'compose' && !nothing && <ComposeList items={f.compose} containers={d.containers} />}
    </div>
  )
}

/** One hairline search line for every Services tab. Escape clears it. */
function SearchField({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <div className="sys-search" data-no-swipe data-on={value ? '' : undefined}>
      <Icon name="search" size={14} tone={value ? 'fg' : 'dim'} glow={!!value} />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Search services, ports, apps"
        aria-label="Search services, timers, apps, ports and compose files"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { onChange(''); e.currentTarget.blur() }
        }}
      />
      {value && (
        <Press className="sys-search-x vl-hit" aria-label="Clear the search" onPress={() => { onChange(''); inputRef.current?.focus() }}>
          <Icon name="stop" size={13} tone="dim" />
        </Press>
      )}
    </div>
  )
}

function SvcGroup({ label, icon, list, i, note, openKey, onToggle }: {
  label: string; icon: IconName; list: SvcItem[]; i: number; note?: string
  openKey: string | null; onToggle: (key: string) => void
}) {
  if (!list.length) return null
  const shown = list.filter((s) => s.health !== 'alert')
  if (!shown.length) return null
  return (
    <Block label={label} icon={<Ico name={icon} />} value={<>{shown.length}<span className="vl-panel-unit">/{list.length} up</span></>} i={i}>
      <div className="sys-svc-rows">
        {shown.map((s, k) => <SvcRow key={s.key} s={s} k={k + i + 1} open={openKey === s.key} onToggle={() => onToggle(s.key)} />)}
      </div>
      {note && <div className="sys-svc-note">{note}</div>}
    </Block>
  )
}

/** KDE, PipeWire and portal units: one folded line, open on tap (and open while a search matches some). */
function DesktopGroup({ list, i, forced, openKey, onToggle }: { list: SvcItem[]; i: number; forced: boolean; openKey: string | null; onToggle: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!list.length) return null
  const shown = list.filter((s) => s.health !== 'alert')
  const isOpen = open || forced
  return (
    <Block label="Desktop plumbing" icon={<Ico name="settings" />} value={<>{shown.length}<span className="vl-panel-unit">/{list.length} up</span></>} i={i} className="sys-svc-desk">
      {!forced && (
        <Press className="sys-fold" data-open={open || undefined} aria-expanded={open} onPress={() => setOpen((o) => !o)}>
          <span>{open ? 'Hide' : 'Show'} {list.length} KDE, PipeWire and portal units</span>
          <i aria-hidden />
        </Press>
      )}
      {isOpen && (
        <div className="sys-svc-rows vl-build-on">
          {shown.map((s, k) => <SvcRow key={s.key} s={s} k={k} open={openKey === s.key} onToggle={() => onToggle(s.key)} />)}
        </div>
      )}
    </Block>
  )
}

/** Up / Watch / Down as an icon and a word: only a problem glows. */
function SvcState({ health, label }: { health: Health; label?: string }) {
  return (
    <span className="sys-svc-state">
      {health === 'alert' ? <Ico name="alert" size={13} lit tone="acc2" />
        : health === 'watch' ? <Ico name="refresh" size={13} lit tone="hot" />
          : <Ico name="done" size={13} tone="fg" />}
      {label ?? (health === 'alert' ? 'Down' : health === 'watch' ? 'Watch' : 'Up')}
    </span>
  )
}

/** Why a restart failed, short enough for a two-line toast: the backend's own word, else its status. */
function why(e: unknown): string {
  const x = (e ?? {}) as { response?: { status?: number; data?: { error?: unknown } }; detail?: unknown; message?: unknown }
  const msg = [x.response?.data?.error, x.detail, x.message].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const status = x.response?.status
  const text = msg ? (msg.length > 72 ? `${msg.slice(0, 71)}…` : msg) : 'no answer'
  return status ? `${status} ${text}` : text
}

/** how long Restart stays armed for its Confirm tap */
const ARM_MS = 4000
/** restarts in flight, by service key: never a second one while the first runs */
const restarting = new Set<string>()

type Restart = { phase: 'idle' | 'armed' | 'sending'; press: () => void }

/**
 * A restart is real (docker restart, or systemctl --user restart, on odin), so
 * it takes two taps: Restart arms it, Confirm sends it, and an armed button
 * that is left alone goes back after ARM_MS. Not optimistic, as the classic
 * Services page is not: the row keeps its state until odin's next read says otherwise.
 */
function useRestart(s: SvcItem): Restart {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<'idle' | 'armed' | 'sending'>('idle')
  useEffect(() => {
    if (phase !== 'armed') return
    const t = setTimeout(() => setPhase('idle'), ARM_MS)
    return () => clearTimeout(t)
  }, [phase])
  const press = () => {
    if (!s.restartable || phase === 'sending' || restarting.has(s.key)) return
    if (phase === 'idle') { setPhase('armed'); return }
    restarting.add(s.key)
    setPhase('sending')
    restartService(s.kind, s.unit)
      .then(() => {
        toast(`Restarted ${s.name}`)
        void qc.invalidateQueries({ queryKey: ['v2', 'servicesSys'] })
        void qc.invalidateQueries({ queryKey: ['v2', 'services'] })
      })
      .catch((e: unknown) => { toast(`Could not restart ${s.name}: ${why(e)}`) })
      .finally(() => {
        restarting.delete(s.key)
        setPhase('idle')
      })
  }
  return { phase, press }
}

/**
 * One service: a row that opens on tap to show what it is (image, ports,
 * compose file; unit, description) and, for a container or user unit, a
 * Restart. A down row carries its Restart in the row itself.
 */
function SvcRow({ s, k, restart, open, onToggle }: { s: SvcItem; k: number; restart?: boolean; open: boolean; onToggle: () => void }) {
  const r = useRestart(s)
  const inRow = !!restart && s.restartable
  return (
    <div className="sys-svc-item vl-build" style={iv(Math.min(k, 14))} data-health={s.health} data-open={open || undefined}>
      <div className="sys-svc-row" data-act={inRow || undefined}>
        <Press className="sys-svc-main" aria-expanded={open} title={s.title} onPress={onToggle}>
          <SvcName s={s} />
          <span className="sys-svc-detail vl-ellipsis" data-armed={r.phase === 'armed' || undefined}>
            {/* short: the phone's detail column holds about 20 characters */}
            {r.phase === 'armed' ? 'Restart it?' : r.phase === 'sending' ? 'Restarting on odin' : s.detail}
          </span>
          {!inRow && <SvcState health={s.health} />}
          <i className="sys-svc-caret" aria-hidden />
        </Press>
        {inRow && <RestartButton s={s} r={r} />}
      </div>
      {open && <SvcMore s={s} r={inRow ? null : r} />}
    </div>
  )
}

function SvcName({ s }: { s: SvcItem }) {
  return (
    <span className="sys-svc-name">
      <Ico name={s.kind === 'container' ? 'container' : 'service'} size={14} tone={s.health === 'alert' ? 'acc2' : s.health === 'watch' ? 'hot' : 'dim'} />
      <span className="vl-ellipsis">{s.name}</span>
    </span>
  )
}

/** Restart / Confirm / Restarting. `line`: the outlined form inside an opened row. */
function RestartButton({ s, r, line }: { s: SvcItem; r: Restart; line?: boolean }) {
  const { phase, press } = r
  return (
    <Press
      className="sys-svc-act vl-hit"
      data-line={line || undefined}
      data-armed={phase === 'armed' || undefined}
      data-sending={phase === 'sending' || undefined}
      aria-busy={phase === 'sending' || undefined}
      aria-label={phase === 'armed' ? `Confirm: restart ${s.name}` : phase === 'sending' ? `Restarting ${s.name}` : `Restart ${s.name}`}
      disabled={phase === 'sending'}
      onPress={press}
    >
      <Ico name={phase === 'armed' ? 'alert' : 'refresh'} size={13} tone={phase === 'armed' ? 'ink' : line ? 'fg' : 'acc2'} />
      {phase === 'armed' ? 'Confirm' : phase === 'sending' ? 'Restarting' : 'Restart'}
    </Press>
  )
}

/** An opened row: what the service is, and its Restart (two taps) when odin can restart it. */
function SvcMore({ s, r }: { s: SvcItem; r: Restart | null }) {
  return (
    <div className="sys-svc-more vl-build-on">
      <dl className="sys-more-kv">
        {s.kind === 'container' ? (
          <>
            <dt>Image</dt><dd>{s.about}</dd>
            <dt>Status</dt><dd>{s.state}</dd>
            <dt>Ports</dt><dd>{s.ports.length ? s.ports.join(', ') : <em>none published</em>}</dd>
            {(s.project || s.compose) && <><dt>Compose</dt><dd>{s.project}{s.compose && <em className="sys-path">{s.compose}</em>}</dd></>}
          </>
        ) : (
          <>
            <dt>Unit</dt><dd className="sys-path">{s.unit}</dd>
            {s.about && <><dt>About</dt><dd>{s.about}</dd></>}
            <dt>State</dt><dd>{s.state}<em> · {s.scope === 'system' ? 'system unit' : 'user unit'}</em></dd>
          </>
        )}
      </dl>
      {r && s.restartable && (
        <div className="sys-more-act">
          <RestartButton s={s} r={r} line />
          <em>{r.phase === 'armed' ? `Confirm restarts ${s.name} on odin now` : s.kind === 'container' ? 'docker restart on odin' : 'systemctl --user restart on odin'}</em>
        </div>
      )}
      {!s.restartable && <div className="sys-more-note">System unit: Valkyrie restarts containers and user units only.</div>}
    </div>
  )
}

/** "2h 9min" -> "2h 9m", "1 day 3h" -> "1d 3h" */
const shortLeft = (s: string) => s.replace(/(\d+)\s*days?/g, '$1d').replace(/min\b/g, 'm').replace(/\s+ago$/, '')

function TimersList({ timers, now }: { timers: TimerItem[]; now: number }) {
  if (!timers.length) return <div className="sys-quiet">odin reports no timers.</div>
  // the next timer to fire is the live one
  const soonest = timers.reduce<TimerItem | null>((a, t) => (t.next != null && (a?.next == null || t.next < a.next) ? t : a), null)?.name ?? null
  return (
    <Block label="Timers" icon={<Ico name="timer" />} value={<span className="sys-dimval">next run · last run</span>} i={2} className="sys-timers">
      <div className="sys-svc-rows sys-flow">
        {timers.map((t, k) => (
          <div key={t.name} className="sys-svc-row sys-timer vl-build" style={iv(Math.min(k + 3, 16))} data-next={t.name === soonest || undefined} title={t.service ? `runs ${t.service}` : undefined}>
            <span className="sys-svc-name">
              <Ico name="timer" size={14} lit={t.name === soonest} />
              <span className="vl-ellipsis">{t.name}</span>
            </span>
            <span className="sys-timer-next">
              {t.next != null ? <><b>{when(t.next, now)}</b><em>in {shortLeft(t.left)}</em></> : <em>{t.left || 'not scheduled'}</em>}
            </span>
            <span className="sys-timer-last">{t.last != null ? `${ago(t.last, now)} ago` : t.passed && t.passed !== 'n/a' ? shortLeft(t.passed) : 'never'}</span>
          </div>
        ))}
      </div>
    </Block>
  )
}

function AppsList({ apps, list, now }: { apps: Live<LauncherEntry[]> | null; list: LauncherEntry[]; now: number }) {
  const sorted = useMemo(() => {
    const rank = (a: LauncherEntry) => (a.health === 'down' ? 0 : a.health === 'unknown' ? 1 : 2)
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [list])
  if (!apps?.data) return <div className="sys-quiet">{apps?.failed ? 'The app list is unreachable.' : 'Loading apps'}</div>
  const alive = sorted.filter((a) => a.health === 'alive').length
  return (
    <Block label="Web apps" icon={<Ico name="online" />} value={<>{alive}<span className="vl-panel-unit">/{sorted.length} alive</span><Fresh live={apps} now={now} /></>} i={2} className="sys-apps">
      <div className="sys-svc-rows sys-flow">
        {sorted.map((a, k) => (
          <a key={a.id} className="sys-svc-row sys-app vl-build" style={iv(Math.min(k + 3, 16))} href={a.url} target="_blank" rel="noopener noreferrer" data-health={a.health === 'down' ? 'alert' : 'ok'}>
            <span className="sys-svc-name">
              <Ico name={a.health === 'alive' ? 'online' : 'offline'} size={14} tone={a.health === 'alive' ? 'dim' : a.health === 'down' ? 'acc2' : 'faint'} />
              <span className="vl-ellipsis">{a.name}</span>
            </span>
            <span className="sys-svc-detail vl-ellipsis">{a.category}{a.owner ? ` · ${a.owner}` : ''}</span>
            {a.health === 'down' ? <SvcState health="alert" />
              : <span className="sys-svc-state">{a.latencyMs != null ? `${a.latencyMs} ms` : '--'}</span>}
          </a>
        ))}
      </div>
    </Block>
  )
}

/** odin's listening ports, grouped by how far they reach (Public first), one row per port and owner. */
function PortsList({ ports, total }: { ports: PortItem[]; total: number }) {
  if (!total) return <div className="sys-quiet">odin reports no listening ports.</div>
  const groups = EXPOSURE_ORDER.map((e) => ({ e, list: ports.filter((p) => p.exposure === e) })).filter((g) => g.list.length)
  const pub = ports.filter((p) => p.exposure === 'public').length
  return (
    <Block
      label="Listening ports"
      icon={<Ico name="online" />}
      value={<>{ports.length}<span className="vl-panel-unit">{ports.length < total ? ` of ${total}` : ''} ports{pub ? ` · ${pub} public` : ''}</span></>}
      i={2}
      className="sys-ports"
    >
      <div className="sys-svc-rows sys-flow">
        {groups.map((g, gk) => (
          <Fragment key={g.e}>
            <div className="sys-group-head vl-build" style={iv(Math.min(3 + gk, 16))} data-exp={g.e}>
              {EXPOSURE_LABEL[g.e]}<b>{g.list.length}</b>
            </div>
            {g.list.map((p, k) => (
              <div key={p.key} className="sys-svc-row sys-port vl-build" style={iv(Math.min(4 + gk + k, 16))} data-exp={p.exposure} title={p.pid ? `pid ${p.pid}` : undefined}>
                <span className="sys-port-n"><b>{p.port ?? '?'}</b><em>{p.proto}</em></span>
                <span className="sys-port-who">
                  {p.owner ? (
                    <span className="sys-svc-name">
                      <Ico name={p.ownerKind === 'container' ? 'container' : 'service'} size={13} />
                      <span className="vl-ellipsis">{p.owner}</span>
                    </span>
                  ) : <span className="sys-port-anon">process not visible</span>}
                  <em className="vl-ellipsis">{p.binds.join(', ')}</em>
                </span>
                <span className="sys-port-exp">{EXPOSURE_LABEL[p.exposure]}</span>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </Block>
  )
}

/** Compose files with the containers each one runs, a down one first and lit. */
function ComposeList({ items, containers }: { items: ComposeItem[]; containers: SvcItem[] }) {
  if (!items.length) return <div className="sys-quiet">odin reports no compose files.</div>
  return (
    <Block label="Compose files" icon={<Ico name="projects" />} value={<>{items.length}<span className="vl-panel-unit"> files</span></>} i={2} className="sys-compose">
      <div className="sys-svc-rows">
        {items.map((c, k) => {
          const mine = containers.filter((x) => x.project === c.project || (x.compose != null && x.compose === c.path))
          const bad = mine.filter((x) => x.health === 'alert').length
          return (
            <div key={c.path} className="sys-comp vl-build" style={iv(Math.min(k + 3, 16))} data-health={bad ? 'alert' : 'ok'}>
              <span className="sys-svc-name sys-comp-name">
                <Ico name="projects" size={14} tone={bad ? 'acc2' : 'dim'} />
                <span className="vl-ellipsis">{c.project}</span>
              </span>
              <span className="sys-comp-path sys-path vl-ellipsis" title={c.path}>{c.path}</span>
              <span className="sys-comp-boxes">
                {mine.length ? mine.map((x) => (
                  <span key={x.key} data-health={x.health}>
                    <Ico name={x.health === 'alert' ? 'alert' : 'container'} size={12} lit={x.health === 'alert'} tone={x.health === 'alert' ? 'acc2' : x.health === 'watch' ? 'hot' : 'dim'} />
                    {x.name}
                  </span>
                )) : <em>no containers running from it</em>}
              </span>
              <SvcState health={bad ? 'alert' : 'ok'} label={bad ? `${bad} down` : mine.length ? `${mine.length} up` : 'Idle'} />
            </div>
          )
        })}
      </div>
    </Block>
  )
}

// ---------- Trades ----------

// Two honesty rules from the classic Trade bot page, kept here:
//  1. The total-value change is not performance: the trading change has
//     transfers removed, and transfers show on their own line.
//  2. Nothing is invented: no positions, no fills, no scans each read as a
//     plain empty line, never a placeholder. A figure that is not a live read
//     says so.
// Color: the scheme accent marks what is live or notable (a scan that reached
// the gate, an executed trade); the loss tone marks a loss or a real fault
// (bot down, stale, rules changed). Never the yellow: inside .sys-trade the
// alert color is the loss tone (system.css). The gate holding a trade is the
// bot's own risk control working, so it reads in the neutral tones.

type PickVM = { s: string; chg: number | null; rvol: number | null }
type DecisionVM = {
  key: string
  t: number | null
  regime: string | null
  conf: number | null
  needed: boolean | null
  proposed: number
  summary: string
  /** null = nothing proposed, "executed" = orders placed, otherwise why not */
  gate: string | null
  cost: number | null
  picks: PickVM[]
}
type FillVM = { key: string; t: number | null; side: string; symbol: string; qty: number; price: number | null; notional: number; state: string | null; agent: string | null; legs: number }
type PositionVM = { symbol: string; qty: number | null; sellable: number | null; avg: number | null }
type ArmVM = { id: string; label: string; ok: boolean; at: number | null; detail: string; failures: number }
type TierVM = { tier: string; min: number; size: number | null }
type TradePageVM = {
  v: 1
  /** ms epoch the backend assembled the payload */
  at: number | null
  statusAt: number | null
  stale: boolean
  cash: number | null
  windowDays: number | null
  firstTotal: number | null
  lastTotal: number | null
  changeUsd: number | null
  changePct: number | null
  flows: number | null
  flowsDetected: number | null
  /** the sampled cash equals the total: the account is provably all cash */
  allCash: boolean
  broker: { at: number | null; positions: PositionVM[]; fills: FillVM[]; orders: number; realized: number | null; trips: number | null } | null
  brokerError: string | null
  decisions: DecisionVM[]
  truncated: number
  unverified: number
  arms: ArmVM[]
  exp: { target: number; live: number | null; liveNote: string; prereg: number | null; rulesOk: boolean | null; pace: string | null }
  spend: { total: number | null; today: number | null; calls: number; callsToday: number; since: number | null }
  caps: {
    /** the line below which nothing trades: the lowest tier, else min_confidence_to_trade */
    gate: number | null
    tiers: TierVM[]
    model: string | null
    maxSingle: number | null
    maxPos: number | null
    perDay: number | null
    dailyLoss: number | null
    stopLoss: number | null
    gainTrim: number | null
    gainTrimPart: number | null
    universe: string
    universeNote: string
    watchlist: string[]
  }
}

/** status fields the page carries that src/lib's TradeBotDoc does not type */
type PageExtras = {
  productivity?: { target?: { trips_per_session?: number | null; projected_sessions_to_target?: number | null; sessions_elapsed?: number | null } }
}

/** the newest fills kept (merged by order), so the cached view model stays small */
const FILLS_KEPT = 60

function toPageVM(p: TradeBotPage): TradePageVM {
  const s = p.status
  const h = s.history
  const b = p.broker
  const caps = p.config
  const tiers = (caps.tiers ?? []).map((t): TierVM => ({ tier: t.tier, min: t.min_confidence, size: num(t.max_single_trade_pct) }))
  const gate = tiers.length ? tiers[tiers.length - 1].min : num(caps.min_confidence_to_trade)

  // fills: one row per order (its legs summed), newest first
  let fills: FillVM[] = []
  if (b) {
    const byOrder = new Map<string, FillVM>()
    b.fills.forEach((f, k) => {
      const q = num(f.quantity) ?? 0
      const pr = num(f.price)
      const id = f.order_id ? `${f.order_id}:${f.side}:${f.symbol}` : `x${k}`
      const row = byOrder.get(id)
      if (row) {
        row.qty += q
        row.notional += q * (pr ?? 0)
        row.legs += 1
        row.price = row.qty > 0 ? row.notional / row.qty : row.price
        return
      }
      byOrder.set(id, { key: id, t: msNY(f.ts), side: f.side, symbol: f.symbol, qty: q, price: pr, notional: q * (pr ?? 0), state: f.state, agent: f.placed_agent, legs: 1 })
    })
    fills = [...byOrder.values()].sort((a, c) => (c.t ?? 0) - (a.t ?? 0))
  }

  // live round trips: status.py's count; else closing sell orders since the pre-registration, counted here
  const e = s.experiment
  const prereg = msNY(e?.preregistered)
  const lifetime = num(b?.realized?.round_trips)
  let live = num(e?.live_trips)
  let liveNote: string
  if (live != null) {
    liveNote = 'Closing sells since pre-registration'
  } else if (b && prereg != null) {
    live = new Set(b.fills.filter((f) => f.side === 'sell' && f.order_id && (msNY(f.ts) ?? 0) > prereg).map((f) => f.order_id)).size
    liveNote = `Counted here from the newest ${b.fills.length} fills, not by the bot`
  } else {
    liveNote = 'Not knowable yet: no broker snapshot'
  }
  const tgt = (s as typeof s & PageExtras).productivity?.target
  const perSession = num(tgt?.trips_per_session)
  const toGo = num(tgt?.projected_sessions_to_target)
  const pace = perSession != null && toGo != null ? `${perSession.toFixed(2)} per session, about ${Math.round(toGo)} more sessions at this pace` : null

  const arm = (id: string, label: string, a: TradeBotArm | undefined): ArmVM | null => {
    if (!a) return null
    const x = a as TradeBotArm & { failures_today?: number }
    return { id, label, ok: a.ok, at: msNY(a.last_run), detail: a.detail ?? '', failures: num(x.failures_today) ?? 0 }
  }
  const sc = caps.screener
  const universe = sc?.enabled
    ? `Whole market, top ${sc.shortlist_size ?? '?'} movers${sc.min_abs_change_pct != null ? ` past ±${sc.min_abs_change_pct}%` : ''}`
    : 'Pinned names only (screen off)'
  const universeNote = sc?.enabled
    ? [sc.min_market_cap != null ? `over $${(sc.min_market_cap / 1e9).toFixed(0)}B cap` : '', sc.min_relative_volume != null ? `relative volume over ${sc.min_relative_volume}` : ''].filter(Boolean).join(', ')
    : ''
  const cash = num(s.portfolio?.live_cash)
  const total = num(s.portfolio?.live_equity)

  return {
    v: 1,
    at: msNY(p.generated_at),
    statusAt: msNY(s.generated_at),
    stale: p.stale === true,
    cash,
    windowDays: num(h?.window_days),
    firstTotal: num(h?.first_total),
    lastTotal: num(h?.last_total),
    changeUsd: num(h?.change_usd),
    changePct: num(h?.change_pct),
    flows: num(h?.net_flows_usd),
    flowsDetected: num(h?.flows_detected),
    allCash: cash != null && total != null && total > 0 && Math.abs(cash - total) < 0.01,
    broker: b ? {
      at: msNY(b.generated_at),
      positions: b.positions.map((x) => ({ symbol: x.symbol, qty: num(x.quantity), sellable: num(x.shares_available_for_sells), avg: num(x.average_buy_price) })),
      fills: fills.slice(0, FILLS_KEPT),
      orders: fills.length,
      realized: num(b.realized?.pnl_usd),
      trips: lifetime,
    } : null,
    brokerError: p.broker_error,
    decisions: p.decisions.map((d, k): DecisionVM => ({
      key: `${d.arm}-${d.ts}-${k}`,
      t: msNY(d.ts),
      regime: d.regime,
      conf: num(d.confidence),
      needed: d.trade_needed,
      proposed: num(d.trades_proposed) ?? 0,
      summary: d.summary ?? '',
      gate: d.gate,
      cost: num(d.cost_usd),
      picks: (d.shortlist ?? []).map((x) => ({ s: x.symbol, chg: num(x.change_pct), rvol: num(x.rvol) })),
    })),
    truncated: num(p.decisions_truncated) ?? 0,
    unverified: num(p.decisions_unverified) ?? 0,
    arms: [arm('live_scan', 'Live scan', s.arms?.live_scan), arm('guard', 'Guard', s.arms?.guard)].filter((a): a is ArmVM => a != null),
    exp: { target: num(e?.target_trips) ?? 100, live, liveNote, prereg, rulesOk: e?.rules_ok ?? null, pace },
    spend: {
      total: num(s.spend?.total_usd), today: num(s.spend?.today_usd),
      calls: num(s.spend?.calls_total) ?? 0, callsToday: num(s.spend?.calls_today) ?? 0, since: msNY(s.spend?.since),
    },
    caps: {
      gate, tiers, model: caps.model,
      maxSingle: num(caps.max_single_trade_pct), maxPos: num(caps.max_position_pct), perDay: num(caps.max_trades_per_day),
      dailyLoss: num(caps.daily_loss_limit_pct), stopLoss: num(caps.stop_loss_pct), gainTrim: num(caps.gain_trim_pct), gainTrimPart: num(caps.gain_trim_partial_pct),
      universe, universeNote, watchlist: caps.watchlist ?? [],
    },
  }
}

/**
 * The trade bot's full page (/api/tradebot/page): portfolio, broker snapshot,
 * decision feed and config. Read every 60 s while Trades is on screen, every
 * 10 minutes otherwise; mounted only once Trades has opened.
 */
const useTradePage = (on: boolean) => useLive('tradePage', async () => toPageVM(await fetchTradeBotPage()), on ? 60_000 : 600_000, {
  revive: (d) => (d && typeof d === 'object' && (d as { v?: number }).v === 1 ? (d as TradePageVM) : undefined),
})

const TRADE_TAB_IDS = ['overview', 'decisions', 'fills', 'bot'] as const
type TradeTab = (typeof TRADE_TAB_IDS)[number]
const TRADE_TABS: { id: TradeTab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'decisions', label: 'Decisions' }, { id: 'fills', label: 'Fills' }, { id: 'bot', label: 'Bot' }]
/** Trades columns: two from 900 px of screen, three from 1380 px */
const TRADE_COLS = [900, 1380] as const

/** what the equity figure is, by its real age: "Live, 40s ago", "Last read 2h ago", "Day-open equity" */
function EquityWhat({ t, now }: { t: TradeVM | undefined; now: number }) {
  const age = t ? equityAge(t, now) : null
  const kind = age?.kind ?? 'unknown'
  return (
    <div className="sys-trade-what" data-kind={kind}>
      {kind === 'day_open' ? 'Day-open equity'
        : kind === 'live' ? <>Live<em>, {age?.at != null ? `${ago(age.at, now)} ago` : 'just now'}</em></>
          : kind === 'read' ? <>Last read<em>{age?.at != null ? ` ${ago(age.at, now)} ago` : ' at the broker'}</em></>
            : 'Equity'}
    </div>
  )
}

/** A key / value row: icon and label on the left, the value right-aligned. */
function Kv({ icon, label, lit, tone, i, children, className }: { icon: IconName; label: string; lit?: boolean; tone?: IconTone; i: number; children: ReactNode; className?: string }) {
  return (
    <div className={cx('sys-kv vl-build', className)} style={iv(i)}>
      <span><Ico name={icon} lit={lit} tone={tone} />{label}</span>
      {children}
    </div>
  )
}

/** A page section that waits on the page read: loading, unreachable, or its content. */
function PageGate({ page, children }: { page: Live<TradePageVM>; children: (p: TradePageVM) => ReactNode }) {
  if (page.data) return <>{children(page.data)}</>
  return <div className="sys-quiet">{page.failed ? 'The trade bot page is unreachable (status.json may not be written yet).' : 'Loading the trade bot page'}</div>
}

function TradesView({ on }: { on: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageH = usePageHeight(rootRef)
  const cols = useCols(rootRef, TRADE_COLS)
  const trade = useTrade(on)
  const page = useTradePage(on)
  const palette = usePalette()
  const reduced = useReducedMotion()
  const now = useTick(on ? 10_000 : 120_000)
  const { epoch } = useOpening(on)
  const [tab, setTab] = useSetting<TradeTab>('sysTradeTab', 'overview', TRADE_TAB_IDS)
  const t = trade.data
  const p = page.data
  // the history, plus the live read as its newest point while the market is
  // open and the read is newer (the history is sampled less often than that)
  const fetchedAt = trade.updatedAt
  const pts = useMemo(() => {
    const base = t?.points ?? []
    if (!t || !t.marketOpen || t.equity == null) return base
    const age = equityAge(t, fetchedAt)
    const last = base[base.length - 1]
    return age.kind === 'live' && age.at != null && (!last || age.at > last.t) ? [...base, { t: age.at, v: t.equity }] : base
  }, [t, fetchedAt])
  const dayOpen = t?.equitySource === 'day_open'
  // a flat line from an all-cash account is a run of real reads, not a repeated figure
  const allCash = !!t && tradeAllCash(t)

  const chart = useMemo(() => {
    if (pts.length < 2) return null
    const vals = pts.map((x) => x.v)
    const min = Math.min(...vals), max = Math.max(...vals)
    const mid = (min + max) / 2
    // at least 2% of equity tall, so a small move draws small
    const half = Math.max(((max - min) / 2) * 1.15, Math.abs(t?.equity ?? mid) * 0.01, 0.5)
    const ticks = max > min ? [{ v: max, label: usd(max) }, { v: min, label: usd(min) }] : [{ v: max, label: usd(max) }]
    // x by trading time: one equal slot per trading day, the market session
    // across it, no nights or weekends (every point is a market-hours sample)
    const keys = pts.map((x) => fmtDayKey.format(x.t))
    const mins = pts.map((x) => nyMinutes(x.t))
    const open = Math.floor(Math.min(9.5 * 60, ...mins) / 30) * 30
    const close = Math.ceil(Math.max(16 * 60, ...mins) / 30) * 30
    const order = new Map<string, number>()
    keys.forEach((k) => { if (!order.has(k)) order.set(k, order.size) })
    const nd = order.size
    const points = pts.map((x, k) => ({ x: (order.get(keys[k])! + clamp((mins[k] - open) / (close - open), 0, 1)) / nd, v: x.v }))
    const days = [...order.keys()].map((key, d) => {
      const at = pts[keys.indexOf(key)].t
      return { x0: d / nd, x1: (d + 1) / nd, label: fmtWeekday.format(at), long: `${fmtWeekday.format(at)} ${fmtDate.format(at)}` }
    })
    const first = vals[0], last = vals[vals.length - 1]
    return {
      points, days, ticks, lo: mid - half, hi: mid + half, last,
      rangePct: min > 0 ? ((max - min) / min) * 100 : 0,
      aria: `Equity from ${usd(first)} to ${usd(last)}, high ${usd(max)}, low ${usd(min)}, over ${nd} trading day${nd === 1 ? '' : 's'}`,
    }
  }, [pts, t?.equity])

  const neg = (t?.changeUsd ?? 0) < 0
  const sign = neg ? '-' : '+'
  const range = pts.length > 1 ? `${fmtDate.format(pts[0].t)} to ${fmtDate.format(pts[pts.length - 1].t)}` : null
  const eq = t?.equity
  const dollars = eq != null ? Math.trunc(eq).toLocaleString('en-US') : null
  const cents = eq != null ? (Math.abs(eq) % 1).toFixed(2).slice(1) : ''
  const windowLabel = t?.windowDays ? `${t.windowDays}-day trading change` : pts.length > 1 ? `since ${fmtDate.format(pts[0].t)}` : 'change'
  const lastTrade = t?.lastTrade ? (/^(buy|sell)\s+(\S+)/i.exec(t.lastTrade)?.slice(1, 3).join(' ') ?? t.lastTrade) : null
  // the chart: a phone's width; on desktop about 42% of the page, never taller than 420 px
  const chartH = cols === 1 ? Math.max(180, Math.min(260, (pageH || 600) - 150)) : clamp(Math.round((pageH || 800) * 0.42), 240, 420)
  const vars: Vars = { '--trade-h': `${chartH}px` }

  const hero = (
    <div key="hero" className="sys-trade-top vl-build" style={iv(0)}>
      <div className="sys-read-caps vl-caps">
        <Icon name="trades" size={15} tone={!t ? 'faint' : t.up ? 'fg' : 'acc2'} glow={!!t} />
        <span>Trade bot</span>
        <span className="sys-read-state" data-state={t?.up ? 'on' : 'off'} data-bad={(t && !t.up) || undefined}>{!t ? 'No data' : t.up ? 'Up' : 'Down'}</span>
      </div>
      <EquityWhat t={t} now={now} />
      <div className="sys-trade-eq">
        {dollars != null ? <>${dollars}<small>{cents}</small></> : '--'}
      </div>
      <div className="sys-trade-chg" data-neg={neg || undefined} title={t?.windowDays ? `Trading change over the last ${t.windowDays} days, transfers removed` : undefined}>
        {/* a loss is --loss, never the yellow (system.css): the arrow and the minus carry the direction */}
        {t?.changeUsd != null && <Icon name={neg ? 'down' : 'trades'} size={17} tone={neg ? 'acc2' : 'fg'} className={neg ? 'sys-loss' : undefined} />}
        <span>{t?.changeUsd != null ? `${sign}${usd(t.changeUsd)}` : '--'}</span>
        {t?.changePct != null && <span>{sign}{Math.abs(t.changePct).toFixed(2)}%</span>}
        <em>{windowLabel}</em>
      </div>
      {dayOpen ? (
        <div className="sys-trade-warn">
          <Icon name="alert" size={15} tone="dim" />
          {t?.lastReadAt != null
            ? `Not a live reading. Last broker read ${fmtWeekday.format(t.lastReadAt)} ${fmtTime.format(t.lastReadAt)}; this is the bot's day-open total.`
            : 'Not a live reading. This is the bot\'s day-open total.'}
        </div>
      ) : allCash && (
        <div className="sys-trade-warn">
          <Icon name="done" size={15} tone="dim" />
          All cash, no open positions
        </div>
      )}
    </div>
  )

  const status = (
    <Block key="status" i={1} dense className="sys-trade-kv">
      <Kv i={2} icon={t && !t.up ? 'alert' : 'service'} label="Health" lit={!!t && !t.up} tone={t && !t.up ? 'acc2' : undefined}>
        <b data-bad={(t && !t.up) || undefined}>{t ? t.upDetail || (t.up ? 'Up' : 'Down') : '--'}</b>
      </Kv>
      <Kv i={3} icon="clock" label="Market" lit={!!t?.marketOpen}>
        <b data-open={t?.marketOpen || undefined}>{t ? (t.marketOpen ? 'Open' : 'Closed') : '--'}{t && !t.marketOpen && t.marketReason && <em> · {t.marketReason}</em>}</b>
      </Kv>
      {cols === 1 && (
        <Kv i={4} icon="refresh" label="Live round trips" className="sys-kv-trips">
          <b>{t?.liveTrips != null ? <>{t.liveTrips}<em> / {t.targetTrips}</em></> : <em>not known yet</em>}</b>
          {t?.liveTrips != null && t.targetTrips > 0 && <Bar value={(t.liveTrips / t.targetTrips) * 100} tone="fg" ticks={10} />}
        </Kv>
      )}
      {lastTrade && (
        <Kv i={5} icon="trades" label="Last trade">
          <b>{lastTrade}{t?.lastTradeAt != null && <em> · {fmtWeekday.format(t.lastTradeAt)} {fmtDate.format(t.lastTradeAt)}</em>}</b>
        </Kv>
      )}
      <Kv i={6} icon={trade.failed || t?.stale ? 'offline' : 'online'} label="Status" lit={!!(trade.failed || t?.stale)} tone={trade.failed || t?.stale ? 'acc2' : undefined}>
        <b className="sys-kv-dim" data-stale={t?.stale || trade.failed || undefined}>
          {trade.failed ? `unreachable, showing ${ago(trade.updatedAt, now)} old` : t?.stale ? 'Stale: the bot has not reported lately' : t?.generatedAt ? `written ${ago(t.generatedAt, now)} ago` : '--'}
        </b>
      </Kv>
    </Block>
  )

  const chartBlock = (
    <Block
      key="chart"
      className="sys-trade-chart"
      label="Equity"
      icon={<Ico name={neg ? 'down' : 'trades'} />}
      value={chart || range ? <span className="sys-dimval">{range}{range && chart ? ' · ' : ''}{chart ? `range ${chart.rangePct.toFixed(2)}%` : ''}</span> : undefined}
      i={7}
    >
      {chart ? (
        <>
          <div className="sys-trade-ribbon">
            <EquityChart
              key={epoch}
              points={chart.points}
              lo={chart.lo}
              hi={chart.hi}
              ticks={chart.ticks}
              days={chart.days}
              lastLabel={usd(chart.last)}
              ariaLabel={chart.aria}
              palette={palette}
              paused={!on}
              motion={reduced ? 'reduced' : 'full'}
              style={{ height: '100%' }}
            />
          </div>
          <div className="sys-chart-cap sys-trade-legend">
            <span><i className="sys-key" data-c="eq" />Total value, trading days only (includes transfers)</span>
          </div>
        </>
      ) : (
        <div className="sys-quiet">{trade.failed ? 'The trade bot is unreachable.' : 'No equity history yet'}</div>
      )}
    </Block>
  )

  const portfolio = <PortfolioBlock key="portfolio" page={page} now={now} />
  const positions = p?.broker && p.broker.positions.length > 0 ? <PositionsBlock key="positions" p={p} now={now} /> : null
  const decisions = <DecisionsBlock key="decisions" page={page} cols={cols} />
  const fills = <FillsBlock key="fills" page={page} now={now} />
  const experiment = <ExperimentBlock key="experiment" page={page} />
  const arms = <ArmsBlock key="arms" page={page} now={now} />
  const judge = <JudgeBlock key="judge" page={page} />
  const notes = <TradeNotes key="notes" page={page} now={now} />

  const layout: ReactNode[][] =
    cols >= 3 ? [[hero, status, portfolio, experiment, arms], [chartBlock, decisions], [positions, fills, judge, notes]]
      : cols === 2 ? [[hero, status, portfolio, experiment, arms, judge, notes], [chartBlock, positions, decisions, fills]]
        : [tab === 'overview' ? [chartBlock, status, portfolio, positions]
          : tab === 'decisions' ? [decisions]
            : tab === 'fills' ? [fills]
              : [experiment, arms, judge, notes]]

  return (
    <div ref={rootRef} className="sys-trade" data-cols={cols} style={vars}>
      {cols === 1 && (
        <div className="sys-trade-head">
          {hero}
          <TextTabs label="Trades view" items={TRADE_TABS} value={tab} onChange={setTab} className="sys-trade-tabs" />
        </div>
      )}
      {layout.map((col, k) => <div key={`${cols}-${k}`} className="sys-trade-col">{col}</div>)}
    </div>
  )
}

/** Cash, positions, the trading change, transfers (never performance) and lifetime realized. */
function PortfolioBlock({ page, now }: { page: Live<TradePageVM>; now: number }) {
  const p = page.data
  return (
    <Block label="Portfolio" icon={<Ico name="trades" />} i={8} dense className="sys-trade-kv sys-port-block" value={p?.broker?.at != null ? <span className="sys-dimval">snapshot {ago(p.broker.at, now)} ago</span> : undefined}>
      <PageGate page={page}>
        {(p) => {
          const b = p.broker
          const n = b?.positions.length ?? null
          return (
            <>
              <Kv i={9} icon="gauge" label="Cash">
                <b>{p.cash != null ? usd(p.cash) : '--'}<em>{p.cash != null ? ' settled' : ' not in this read'}</em></b>
              </Kv>
              <Kv i={10} icon="container" label="Positions">
                <b>
                  {!b ? <em>{p.brokerError ? 'snapshot unavailable' : 'not known'}</em>
                    : n === 0 ? <>None<em>{p.allCash ? ', all cash' : ', equity only'}</em></>
                      : <>{n}<em> open</em></>}
                </b>
              </Kv>
              <Kv i={11} icon={(p.changeUsd ?? 0) < 0 ? 'down' : 'trades'} label={`Trading P&L${p.windowDays ? `, ${p.windowDays}d` : ''}`}>
                <b><span className="sys-nw">{signedUsd(p.changeUsd)}</span>{p.changePct != null && <em> · <span className="sys-nw">{signedPct(p.changePct)}</span></em>}</b>
              </Kv>
              <Kv i={12} icon="refresh" label="Transfers">
                <b>
                  {p.flows == null ? <em>no history yet</em>
                    : p.flows === 0 ? <>None<em> in the window</em></>
                      : <>{signedUsd(p.flows)}<em> · {p.flowsDetected ?? 0} detected, not performance</em></>}
                </b>
              </Kv>
              <Kv i={13} icon="done" label="Lifetime realized">
                <b>{b?.realized != null ? <><span className="sys-nw">{signedUsd(b.realized)}</span><em> · </em><span className="sys-nw"><em>{b.trips ?? 0} round trips</em></span></> : <em>{p.brokerError ?? 'not in the snapshot'}</em>}</b>
              </Kv>
              {p.firstTotal != null && p.lastTotal != null && (
                <Kv i={14} icon="clock" label="Total value">
                  <b>{usd(p.firstTotal)}<em> to </em>{usd(p.lastTotal)}</b>
                </Kv>
              )}
            </>
          )
        }}
      </PageGate>
    </Block>
  )
}

/** Open positions; rendered only when there are some (Portfolio says "None" otherwise). */
function PositionsBlock({ p, now }: { p: TradePageVM; now: number }) {
  const b = p.broker!
  return (
    <Block label="Positions" icon={<Ico name="container" lit />} value={<>{b.positions.length}<span className="vl-panel-unit"> open{b.at != null ? ` · ${ago(b.at, now)} ago` : ''}</span></>} i={15} className="sys-positions">
      <div className="sys-pos sys-pos-head" aria-hidden>
        <span>Symbol</span><span>Qty</span><span>Sellable</span><span>Avg buy</span>
      </div>
      <div className="sys-svc-rows">
        {b.positions.map((x, k) => (
          <div key={x.symbol} className="sys-pos vl-build" style={iv(16 + Math.min(k, 10))}>
            <b>{x.symbol}</b>
            <span>{qty(x.qty)}</span>
            <span>{qty(x.sellable)}</span>
            <span>{x.avg != null ? usd(x.avg, 2) : '--'}</span>
          </div>
        ))}
      </div>
    </Block>
  )
}

/** the gate words for a scan: what the gate did, and whether the row is the notable kind */
function outcome(d: DecisionVM, gate: number | null): { word: string; notable: boolean; held: boolean } {
  const executed = d.gate === 'executed'
  const held = d.gate != null && !executed
  // cleared on confidence; a scan that proposed nothing is never credited with clearing anything
  const cleared = d.conf != null && gate != null && d.conf >= gate
  if (executed) return { word: 'Executed', notable: true, held }
  if (!held) return { word: 'No trade wanted', notable: false, held }
  if (cleared) return { word: 'Cleared gate, held', notable: true, held }
  return { word: d.conf != null && gate != null ? 'Below gate' : 'Held', notable: false, held }
}

const regimeWord = (r: string | null) => (r ? r.replace(/_/g, ' ') : 'regime unknown')

/** how many scans the feed shows before "Show all" */
const FEED_FOLD = 12

/** Confidence against the gate (the scans plotted), then every judged scan, newest first. */
function DecisionsBlock({ page, cols }: { page: Live<TradePageVM>; cols: number }) {
  const [all, setAll] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const p = page.data
  const shown = p?.decisions.length ?? 0
  return (
    <Block
      label="Decisions"
      icon={<Ico name="gauge" />}
      value={p ? <>{shown}<span className="vl-panel-unit">{p.truncated > 0 ? ` of ${shown + p.truncated}` : ''} scans</span></> : undefined}
      i={17}
      className="sys-decisions"
    >
      <PageGate page={page}>
        {(p) => {
          const gate = p.caps.gate
          if (!p.decisions.length) return <div className="sys-quiet">No judged scans in the log window yet.</div>
          const list = all ? p.decisions : p.decisions.slice(0, FEED_FOLD)
          // a small day label above the first scan of each New York day
          const days = list.map((d, k) => {
            const key = d.t != null ? fmtDayKey.format(d.t) : ''
            const prev = k > 0 ? list[k - 1].t : undefined
            return k === 0 || key !== (prev != null ? fmtDayKey.format(prev) : '') ? key : null
          })
          return (
            <>
              <ConfChart list={p.decisions} gate={gate} truncated={p.truncated} tall={cols > 1} />
              {p.unverified > 0 && (
                <div className="sys-trade-note">{p.unverified} log entr{p.unverified === 1 ? 'y' : 'ies'} withheld: no recorded judge call, so they are selftest output, not real scans.</div>
              )}
              <div className="sys-feed">
                {list.map((d, k) => {
                  return (
                    <Fragment key={d.key}>
                      {days[k] != null && <div className="sys-feed-day">{d.t != null ? `${fmtWeekday.format(d.t)} ${fmtDate.format(d.t)}` : 'Undated'}</div>}
                      <DecisionRow d={d} gate={gate} open={openKey === d.key} onToggle={() => setOpenKey((c) => (c === d.key ? null : d.key))} />
                    </Fragment>
                  )
                })}
              </div>
              {p.decisions.length > FEED_FOLD && <Fold open={all} onToggle={() => setAll((a) => !a)} label={`Show all ${p.decisions.length} scans`} />}
            </>
          )
        }}
      </PageGate>
    </Block>
  )
}

/**
 * Confidence per scan against the gate, oldest to newest. Position carries the
 * reading (above or below the dashed gate line); a scan at or over the gate
 * takes the accent, the rest stay dim. The band under the gate is a neutral
 * wash: holding there is the normal outcome, not a fault.
 */
function ConfChart({ list, gate, truncated, tall }: { list: DecisionVM[]; gate: number | null; truncated: number; tall: boolean }) {
  const pts = useMemo(() => list.filter((d) => d.conf != null).slice().reverse(), [list])
  if (!pts.length) return <div className="sys-quiet">No scored scans yet: the judge has not returned a confidence.</div>
  const confs = pts.map((d) => d.conf as number)
  const lo = Math.min(...confs), hi = Math.max(...confs)
  const reached = gate == null ? 0 : confs.filter((c) => c >= gate).length
  const first = pts[0].t, last = pts[pts.length - 1].t
  return (
    <div className="sys-conf" data-tall={tall || undefined}>
      <div
        className="sys-conf-plot"
        role="img"
        aria-label={`Confidence of ${pts.length} scans${gate != null ? ` against the ${gate.toFixed(2)} gate: ${reached} reached it` : ''}, range ${lo.toFixed(2)} to ${hi.toFixed(2)}`}
      >
        {[0, 0.5, 1].map((v) => <i key={v} className="sys-conf-grid" style={{ bottom: `${v * 100}%` }} data-v={v === 0.5 ? '.5' : String(v)} />)}
        {gate != null && (
          <>
            <i className="sys-conf-band" style={{ height: `${clamp(gate, 0, 1) * 100}%` }} />
            <i className="sys-conf-gate" style={{ bottom: `${clamp(gate, 0, 1) * 100}%` }} />
            <span className="sys-conf-gate-label" style={{ bottom: `${clamp(gate, 0, 1) * 100}%` }}>gate {gate.toFixed(2)}</span>
          </>
        )}
        <div className="sys-conf-pts">
          {pts.map((d, k) => {
            const c = clamp(d.conf as number, 0, 1)
            const up = gate != null && (d.conf as number) >= gate
            const x = pts.length === 1 ? 50 : (k / (pts.length - 1)) * 100
            const style: Vars = { left: `${x}%`, '--y': `${c * 100}%` }
            return (
              <span
                key={d.key}
                className="sys-conf-pt"
                data-up={up || undefined}
                data-exec={d.gate === 'executed' || undefined}
                style={style}
                title={`${d.t != null ? stamp(d.t) : 'undated'} · confidence ${c.toFixed(2)} · ${outcome(d, gate).word.toLowerCase()}`}
              />
            )
          })}
        </div>
      </div>
      <div className="sys-chart-cap sys-conf-cap">
        <span>{first != null ? fmtDate.format(first) : ''}</span>
        <span>oldest to newest · {pts.length} scored scans</span>
        <span>{last != null ? fmtDate.format(last) : ''}</span>
      </div>
      <div className="sys-trade-note">
        {gate == null ? 'The gate (min_confidence_to_trade) is not readable from the config.'
          : reached === 0 ? <><b>None reached</b> the {gate.toFixed(2)} gate in these {pts.length} scans (range {lo.toFixed(2)} to {hi.toFixed(2)}), so none of them traded.</>
            : <><b>{reached} of {pts.length}</b> reached the {gate.toFixed(2)} gate (range {lo.toFixed(2)} to {hi.toFixed(2)}).</>}
        {truncated > 0 && <> {truncated} older scan{truncated === 1 ? ' is' : 's are'} outside the feed and not counted.</>}
      </div>
    </div>
  )
}

/** One judged scan: time, regime, confidence against the gate, what the gate did; tap for the rest. */
function DecisionRow({ d, gate, open, onToggle }: { d: DecisionVM; gate: number | null; open: boolean; onToggle: () => void }) {
  const o = outcome(d, gate)
  const c = d.conf != null ? clamp(d.conf, 0, 1) : null
  const meter: Vars = { '--c': `${(c ?? 0) * 100}%`, '--g': `${clamp(gate ?? 0, 0, 1) * 100}%` }
  return (
    <div className="sys-dec" data-notable={o.notable || undefined} data-open={open || undefined}>
      <Press className="sys-dec-main" aria-expanded={open} onPress={onToggle}>
        <span className="sys-dec-top">
          <span className="sys-dec-when">{d.t != null ? fmtTime.format(d.t) : '--'}</span>
          <span className="sys-dec-regime vl-ellipsis">{regimeWord(d.regime)}</span>
          <span className="sys-dec-conf">
            <b>{c != null ? c.toFixed(2) : '--'}</b>
            {c != null && <span className="sys-meter" data-up={o.notable || (gate != null && c >= gate) || undefined} data-gate={gate != null || undefined} style={meter} aria-hidden />}
          </span>
          <span className="sys-dec-out" data-on={o.notable || undefined}>{o.word}</span>
        </span>
        {d.picks.length > 0 && (
          <span className="sys-dec-picks">
            {d.picks.map((x) => (
              <span key={x.s} title={`${x.s} · ${signedPct(x.chg, 1)} on the day · relative volume ${x.rvol != null ? x.rvol.toFixed(2) : 'unknown'}`}>
                {x.s}<em>{signedPct(x.chg, 1)}</em>
              </span>
            ))}
          </span>
        )}
        {d.summary && <span className="sys-dec-sum">{d.summary}</span>}
      </Press>
      {open && (
        <div className="sys-dec-more vl-build-on">
          {o.held && <div className="sys-dec-gate">{d.gate}</div>}
          <div>
            Wanted {d.proposed} trade{d.proposed === 1 ? '' : 's'} · trade needed {d.needed == null ? 'unknown' : d.needed ? 'yes' : 'no'}
            {d.cost != null && <> · judge {usd(d.cost, 4)}</>}
          </div>
          {d.picks.some((x) => x.rvol != null) && (
            <div>Screened: {d.picks.map((x) => `${x.s} ${signedPct(x.chg, 1)}${x.rvol != null ? ` rvol ${x.rvol.toFixed(2)}` : ''}`).join(' · ')}</div>
          )}
          {d.t != null && <div>{fmtWeekday.format(d.t)} {fmtLongDate.format(d.t)} {fmtTime.format(d.t)} ET</div>}
        </div>
      )}
    </div>
  )
}

/** how many orders the fills list shows before "Show all" */
const FILLS_FOLD = 10

/** Broker fills, one row per order (legs summed), newest first. */
function FillsBlock({ page, now }: { page: Live<TradePageVM>; now: number }) {
  const [all, setAll] = useState(false)
  const p = page.data
  const b = p?.broker
  const newest = b?.fills[0]?.t ?? null
  return (
    <Block
      label="Recent fills"
      icon={<Ico name="done" />}
      value={b ? <span className="sys-dimval">{b.orders} order{b.orders === 1 ? '' : 's'}{newest != null ? ` · newest ${ago(newest, now)} ago` : ''}</span> : undefined}
      i={20}
      className="sys-fills"
    >
      <PageGate page={page}>
        {(p) => {
          if (!p.broker) return <div className="sys-quiet">Broker snapshot unavailable{p.brokerError ? `: ${p.brokerError}` : '.'}</div>
          const list = p.broker.fills
          if (!list.length) return <div className="sys-quiet">No fills on record: no order on this account has filled.</div>
          const rows = all ? list : list.slice(0, FILLS_FOLD)
          return (
            <>
              <div className="sys-svc-rows">
                {rows.map((f, k) => (
                  <div key={f.key} className="sys-fill vl-build" style={iv(21 + Math.min(k, 12))} data-side={f.side} title={`${f.state ?? ''}${f.agent ? ` · placed by ${f.agent}` : ''}${f.legs > 1 ? ` · ${f.legs} legs` : ''}`}>
                    <span className="sys-fill-when">{f.t != null ? stamp(f.t) : '--'}</span>
                    <span className="sys-fill-what">
                      <i>{f.side}</i><b>{f.symbol}</b>
                      <em className="vl-ellipsis">{qty(f.qty)} @ {f.price != null ? usd(f.price, 2) : '--'}</em>
                    </span>
                    <span className="sys-fill-usd">{usd(f.notional)}</span>
                  </div>
                ))}
              </div>
              {list.length > FILLS_FOLD && <Fold open={all} onToggle={() => setAll((a) => !a)} label={p.broker.orders > list.length ? `Show the newest ${list.length} of ${p.broker.orders} orders` : `Show all ${list.length} orders`} />}
            </>
          )
        }}
      </PageGate>
    </Block>
  )
}

/** Live round trips against the target, the pre-registration and the rules hash. */
function ExperimentBlock({ page }: { page: Live<TradePageVM> }) {
  const bad = page.data?.exp.rulesOk === false
  return (
    <Block label="Experiment" icon={<Ico name={bad ? 'alert' : 'gauge'} lit={bad} tone={bad ? 'acc2' : undefined} />} i={34} dense className="sys-trade-kv">
      <PageGate page={page}>
        {(p) => {
          const e = p.exp
          return (
            <>
              {bad && <div className="sys-trade-alert">Rules changed: the live rule files no longer hash to the pre-registered value, so results before and after are not the same experiment.</div>}
              <Kv i={35} icon="refresh" label="Live round trips" className="sys-kv-trips">
                <b>{e.live != null ? <>{e.live}<em> / {e.target}</em></> : <em>not known yet</em>}</b>
                {e.live != null && e.target > 0 && <Bar value={(e.live / e.target) * 100} tone="fg" ticks={10} />}
                <small className="sys-kv-note">{e.liveNote}{e.pace ? `. ${e.pace}` : ''}</small>
              </Kv>
              <Kv i={36} icon="calendar" label="Pre-registered">
                <b>{e.prereg != null ? fmtLongDate.format(e.prereg) : '--'}</b>
              </Kv>
              <Kv i={37} icon={bad ? 'alert' : 'done'} label="Rules hash" lit={bad} tone={bad ? 'acc2' : undefined}>
                <b data-bad={bad || undefined}>{e.rulesOk === true ? 'Matches' : bad ? 'Changed' : <em>unknown</em>}</b>
              </Kv>
            </>
          )
        }}
      </PageGate>
    </Block>
  )
}

/** The live scan and the guard: ok or failing, and when each last ran (by the clock, not the file). */
function ArmsBlock({ page, now }: { page: Live<TradePageVM>; now: number }) {
  return (
    <Block label="Arms" icon={<Ico name="service" />} i={38} dense className="sys-trade-kv">
      <PageGate page={page}>
        {(p) => (
          <>
            {p.arms.map((a, k) => (
              <Kv key={a.id} i={39 + k} icon={a.ok ? 'done' : 'alert'} label={a.label} lit={!a.ok} tone={a.ok ? undefined : 'acc2'}>
                <b data-bad={!a.ok || undefined}>
                  {a.ok ? 'OK' : 'Failing'}
                  <em> · {a.at != null ? `ran ${ago(a.at, now)} ago, ${when(a.at, now)}` : a.detail || 'never ran'}</em>
                  {!a.ok && a.detail && <em> · {a.detail}</em>}
                  {a.failures > 0 && <em> · {a.failures} failure{a.failures === 1 ? '' : 's'} today</em>}
                </b>
              </Kv>
            ))}
            <Kv i={41} icon="alert" label="Guard rules">
              <b className="sys-kv-dim"><span className="sys-nw">stop-loss {fracPct(p.caps.stopLoss, true)} full exit</span> · <span className="sys-nw">gain-trim {fracPct(p.caps.gainTrim, true)} sells {fracPct(p.caps.gainTrimPart)}</span></b>
            </Kv>
          </>
        )}
      </PageGate>
    </Block>
  )
}

/** The judge (model, spend) and the caps the rules hold it to. */
function JudgeBlock({ page }: { page: Live<TradePageVM> }) {
  return (
    <Block label="Judge and caps" icon={<Ico name="ai" />} i={42} dense className="sys-trade-kv">
      <PageGate page={page}>
        {(p) => {
          const c = p.caps
          const sp = p.spend
          const perCall = sp.total != null && sp.calls > 0 ? sp.total / sp.calls : null
          return (
            <>
              <Kv i={43} icon="ai" label="Model"><b className="vl-ellipsis">{c.model ?? '--'}</b></Kv>
              <Kv i={44} icon="gauge" label="Spend">
                <b>
                  <span className="sys-nw">{sp.total != null ? usd(sp.total) : '--'}<em>{sp.since != null ? ` since ${fmtDate.format(sp.since)}` : ' total'}</em></span>
                  <em> · </em>
                  <span className="sys-nw">{sp.today != null ? usd(sp.today) : '--'}<em> today ({sp.callsToday} calls)</em></span>
                </b>
              </Kv>
              <Kv i={45} icon="refresh" label="Calls">
                <b>{sp.calls}{perCall != null && <em> · {usd(perCall, 4)} each</em>}</b>
              </Kv>
              <Kv i={46} icon="trades" label={c.tiers.length ? 'Gate (floor)' : 'Gate'}>
                <b>{c.gate != null ? c.gate.toFixed(2) : '--'}<em> min confidence</em></b>
              </Kv>
              {c.tiers.length > 0 && (
                <Kv i={47} icon="gauge" label="Tiers">
                  <b>
                    {c.tiers.map((t, k) => (
                      <span key={t.tier} className="sys-nw">{k > 0 && <em> · </em>}{t.tier} {t.min.toFixed(2)}+<em> {fracPct(t.size)}</em></span>
                    ))}
                  </b>
                </Kv>
              )}
              <Kv i={48} icon="container" label="Size caps">
                <b><span className="sys-nw">{fracPct(c.maxSingle)}<em> a trade</em></span><em> · </em><span className="sys-nw">{fracPct(c.maxPos)}<em> a position</em></span></b>
              </Kv>
              <Kv i={49} icon="clock" label="Daily limits">
                <b><span className="sys-nw">{c.perDay ?? '--'}<em> trades</em></span><em> · </em><span className="sys-nw">halt at {fracPct(c.dailyLoss, true)}</span></b>
              </Kv>
              <Kv i={50} icon="search" label="Universe">
                <b>{c.universe}{c.universeNote && <em> · {c.universeNote}</em>}</b>
              </Kv>
              {c.watchlist.length > 0 && (
                <Kv i={51} icon="trades" label="Always shown">
                  <b className="sys-chips">{c.watchlist.map((w) => <span key={w}>{w}</span>)}</b>
                </Kv>
              )}
            </>
          )
        }}
      </PageGate>
    </Block>
  )
}

/** Where the numbers come from, and the transfers rule in one sentence. */
function TradeNotes({ page, now }: { page: Live<TradePageVM>; now: number }) {
  const p = page.data
  if (!p) return null
  return (
    <div className="sys-trade-notes vl-build" style={iv(52)}>
      <p>
        status.json {p.statusAt != null ? `written ${ago(p.statusAt, now)} ago` : 'age unknown'}
        {' · '}broker snapshot {p.broker?.at != null ? `${ago(p.broker.at, now)} old` : 'unavailable'}
        {p.stale && <b> · stale</b>}. Read from the bot's files on odin; Valkyrie never calls the broker.
      </p>
      {p.changeUsd != null && p.firstTotal != null && p.lastTotal != null && (
        <p>
          Trading P&amp;L is the {p.windowDays ?? '?'}-day change with transfers removed. Total value moved {usd(p.firstTotal)} to {usd(p.lastTotal)},
          {' '}of which {signedUsd(p.flows ?? 0)} was transferred in or out and is not performance.
        </p>
      )}
    </div>
  )
}
