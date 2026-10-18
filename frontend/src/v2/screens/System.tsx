import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useShell, type ScreenProps } from '../kit/shell'
import { Bar, Press, cx, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { ago, equityAge, useHosts, useLive, useTick, useTrade, type HostVM, type Live, type TradeVM } from '../kit/data'
import {
  fetchLauncher, fetchServices, restartService,
  type LauncherEntry, type ServiceContainer, type ServicesStatus, type ServiceTimer, type ServiceUnit,
} from '../../lib/api'
import { HOST_POSE, Hero, heroModel, hostModel, type HostModelId } from '../kit/hero'
import { TrackRibbon } from '../kit/three'
import { EquityChart } from '../kit/three/EquityChart'
import { usePalette, useSetting } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import './system.css'

// System: Hosts (one icon-led row per host; the selected one as gauge plates
// with its x-ray model as a small accent and its last hour as an honest
// chart), Services (odin's containers and units that matter, timers, web
// apps) and Trades (the trade bot's equity, experiment and health, read every
// 60 s while it is on screen). AI usage lives on AI > Usage.
// Reads only, except Restart on a down service (two taps: it restarts the real
// container or unit on odin). Icons glow only when lit (online, selected, live,
// down); everything else is dim.

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

// Valkyrie runs on New York time: format every clock time there, whatever the phone's zone is
const NY = 'America/New_York'
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' })
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' })
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
const fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
/** minutes after midnight, New York time */
const nyMinutes = (ms: number) => {
  let h = 0, m = 0
  for (const p of fmtHM.formatToParts(ms)) { if (p.type === 'hour') h = Number(p.value) % 24; else if (p.type === 'minute') m = Number(p.value) }
  return h * 60 + m
}
/** "2:00 AM" on the same day, "Sun 9:00 AM" on another */
const when = (ms: number, now: number) => (fmtDayKey.format(ms) === fmtDayKey.format(now) ? fmtTime.format(ms) : `${fmtWeekday.format(ms)} ${fmtTime.format(ms)}`)

/** amber from 80%, red from 90% (the dashboard's usageColor) */
const loadTone = (v: number | null): Tone => (v == null ? 'fg' : v >= 90 ? 'acc2' : v >= 80 ? 'hot' : 'fg')
const batteryTone = (v: number | null): Tone => (v != null && v < 20 ? 'acc2' : 'fg')

/** "25.4 / 31.1 GB" (GiB, as Windows and htop show memory) */
const memSizes = (h: HostVM) => (h.memUsedGb != null && h.memTotalGb != null ? `${h.memUsedGb.toFixed(1)} / ${h.memTotalGb.toFixed(1)} GB` : null)
/** "3.1 / 4.0 TB", "10 GB / 1.0 TB" (decimal, as drives are sold) */
const diskSizes = (h: HostVM) => {
  if (h.diskUsedGb == null || h.diskTotalGb == null) return null
  const dec = (gib: number) => (gib * 1024 ** 3) / 1e9
  const one = (gb: number, unit: 'TB' | 'GB') => (unit === 'TB' ? (gb / 1000).toFixed(1) : gb >= 10 ? gb.toFixed(0) : gb.toFixed(1))
  const used = dec(h.diskUsedGb), total = dec(h.diskTotalGb)
  const tu = total >= 1000 ? 'TB' : 'GB'
  const uu = used >= 100 && tu === 'TB' ? 'TB' : 'GB'
  return uu === tu ? `${one(used, uu)} / ${one(total, tu)} ${tu}` : `${one(used, uu)} ${uu} / ${one(total, tu)} ${tu}`
}

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

/** Caret-notch text tabs on a hairline. */
function TextTabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="sys-filter" role="tablist" aria-label={label}>
      {items.map((t) => (
        <Press key={t.id} role="tab" aria-selected={value === t.id} data-on={value === t.id || undefined} className="sys-filter-btn" onPress={() => onChange(t.id)}>
          {t.label}
        </Press>
      ))}
    </div>
  )
}

// ---------- screen-local data (GET only) ----------

// Desktop plumbing that systemd lists among odin's user services (Plasma,
// PipeWire, D-Bus, the portals, autostart tray apps): real, but never what
// "is something down" means. Same rule as the desktop dashboard.
const DESKTOP_UNIT = /^(app-|at-spi|dbus|dconf|obex|pipewire|plasma-|wireplumber|xdg-)/

type Health = 'ok' | 'watch' | 'alert'
type SvcItem = {
  key: string; kind: 'container' | 'service'; name: string; health: Health; detail: string; title: string
  /** the name odin restarts it by (the raw unit name, escapes and all) */
  unit: string
  /** containers and user units: the backend restarts with docker or systemctl --user, never a system unit */
  restartable: boolean
}
type TimerItem = { name: string; next: number | null; last: number | null; left: string; passed: string }
type SvcSysVM = {
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

const containerItem = (c: ServiceContainer): SvcItem => {
  const health: Health = c.state !== 'running' ? 'alert' : /unhealthy|restarting/i.test(c.status) ? 'watch' : 'ok'
  const flag = /\((healthy|unhealthy|health: starting)\)/i.exec(c.status)?.[1]
  const age = dockerAge(c.status.replace(/\s*\([^)]*\)\s*$/, '')).replace(/^Up\s+/i, 'up ')
  return { key: `c:${c.name}`, kind: 'container', name: c.name, health, detail: flag ? `${age} · ${flag.toLowerCase()}` : age, title: `${c.image} · ${c.status}`, unit: c.name, restartable: true }
}

const unitItem = (scope: 'user' | 'system') => (u: ServiceUnit): SvcItem => {
  const health: Health = u.active === 'failed' ? 'alert' : u.sub === 'auto-restart' ? 'watch' : 'ok'
  const desc = u.description && u.description !== u.name ? u.description : ''
  return {
    key: `${scope}:${u.name}`, kind: 'service', name: tidyName(u.name), health,
    detail: health === 'alert' ? `failed${desc ? ` · ${desc}` : ''}` : health === 'watch' ? `restarting${desc ? ` · ${desc}` : ''}` : desc,
    title: `${u.description} · ${u.active} (${u.sub})`,
    unit: u.name, restartable: scope === 'user',
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

const timerItem = (t: ServiceTimer): TimerItem => ({ name: tidyName(t.name), next: parseSystemd(t.next), last: parseSystemd(t.last), left: t.left, passed: t.passed })

function toSvcVM(s: ServicesStatus): SvcSysVM {
  const keep = (u: ServiceUnit) => u.sub === 'running' || u.active === 'failed' || u.sub === 'auto-restart'
  const user = s.services ?? []
  const sys = s.systemServices ?? []
  return {
    containers: s.containers.map(containerItem).sort(byHealth),
    system: sys.filter(keep).map(unitItem('system')).sort(byHealth),
    user: user.filter((u) => keep(u) && !DESKTOP_UNIT.test(u.name)).map(unitItem('user')).sort(byHealth),
    desktop: user.filter((u) => keep(u) && DESKTOP_UNIT.test(u.name)).map(unitItem('user')).sort(byHealth),
    oneshots: [...user, ...sys].filter((u) => !keep(u)).map((u) => tidyName(u.name)),
    timers: (s.timers ?? []).map(timerItem).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity)),
  }
}

/** odin's services with the dashboard's rules (scope, health, plumbing folded) plus timers. */
const useServicesSys = () => useLive('servicesSys', async () => toSvcVM(await fetchServices()), 30_000)

// ---------- screen ----------

export default function System({ active, sub }: ScreenProps) {
  const view: Sub = sub === 'services' || sub === 'trades' ? sub : 'hosts'
  const { setPose, setCenter } = useShell()
  const [picked, setPicked] = useSetting<string>('sysHost', 'thor')
  const hosts = useHosts()
  const svc = useServicesSys()
  const trade = useTrade(active && view === 'trades')
  const list = hosts.data ?? []
  const selected = list.find((h) => h.id === picked) ?? list.find((h) => h.id === 'thor') ?? list[0] ?? null
  const pose = poseFor(selected ? hostModel(selected.id) : null)

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
    view === 'hosts' ? (hosts.data ? `${online}/${list.length} online${selected?.online && selected.cpu != null ? ` · ${selected.label} ${selected.cpu}%` : ''}` : 'Hosts')
      : view === 'services' ? (sv ? `${counted.length - counted.filter((s) => s.health === 'alert').length} up · ${down} down${watch ? ` · ${watch} watch` : ''}` : 'Services')
        : t?.equity != null
          ? `${usd(t.equity)}${t.equitySource === 'day_open' ? ' day-open' : ''}${t.changePct != null ? ` · ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%` : ''}${t.liveTrips != null && t.targetTrips ? ` · ${t.liveTrips}/${t.targetTrips} trips` : ''}`
          : 'Trades'
  useEffect(() => {
    if (active) setCenter(center)
  }, [active, center, setCenter])

  return (
    <div className="vl-screen sys">
      <div hidden={view !== 'hosts'}>
        <HostsView on={active && view === 'hosts'} selected={selected} onPick={setPicked} />
      </div>
      <div hidden={view !== 'services'}>
        <ServicesView on={active && view === 'services'} svc={svc} />
      </div>
      <div hidden={view !== 'trades'}>
        <TradesView on={active && view === 'trades'} />
      </div>
    </div>
  )
}

// ---------- Hosts ----------

function HostsView({ on, selected, onPick }: { on: boolean; selected: HostVM | null; onPick: (id: string) => void }) {
  const detailRef = useRef<HTMLElement>(null)
  const hosts = useHosts()
  const { scroller } = useShell()
  const reduced = useReducedMotion()
  const now = useTick(on ? 5000 : 60_000)
  const { epoch } = useOpening(on)
  const list = useMemo(() => [...(hosts.data ?? [])].sort((a, b) => Number(b.online) - Number(a.online)), [hosts.data])
  const online = list.filter((h) => h.online).length
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
            {list.map((h, k) => (
              <HostRow key={h.id} h={h} k={k} t1={t1} selected={h.id === selected?.id} onPick={pick} />
            ))}
          </div>
        ) : (
          <div className="sys-empty">{hosts.failed ? 'Hosts unreachable' : 'Loading hosts'}</div>
        )}
      </Block>
      {selected && <HostDetail ref={detailRef} host={selected} on={on} epoch={epoch} t1={t1} i={2 + list.length} />}
    </div>
  )
}

type Metric = { id: string; icon: IconName; label: string; value: number | null; tone: Tone; sizes: string | null }

/**
 * The selected host: one gauge plate per reading (the lit plate is the part
 * the model highlights), its x-ray model as a small accent beside them, and its
 * last hour as an honest chart.
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

  const metrics: Metric[] = [
    { id: 'cpu', icon: 'cpu', label: 'CPU', value: host.cpu, tone: loadTone(host.cpu), sizes: host.cores ? `${host.cores} cores` : null },
    { id: 'mem', icon: 'mem', label: 'Memory', value: host.mem, tone: loadTone(host.mem), sizes: memSizes(host) },
    { id: 'disk', icon: 'disk', label: spots.get('disk') ?? 'Disk', value: host.disk, tone: loadTone(host.disk), sizes: diskSizes(host) },
  ]
  if (host.battery) {
    metrics.push({ id: 'battery', icon: host.battery.charging ? 'charging' : 'battery', label: 'Battery', value: host.battery.percent, tone: batteryTone(host.battery.percent), sizes: host.battery.charging ? 'charging' : null })
  }
  const byId = new Map(metrics.map((m) => [m.id, m] as const))
  // hotspots without a reading (GPU, exhaust fans, lenses) keep the lit plate where it is
  const onHotspot = (id: string) => {
    if (!byId.has(id) || !host.online) {
      toast(`${spots.get(id) ?? title(id)}: ${host.online ? 'no reading from this host' : `${host.label} is offline`}`)
      return
    }
    setFocus((cur) => (cur === id ? null : id))
  }
  const lit = focus && byId.has(focus) ? focus : 'cpu'
  const up = uptime(host.uptime)

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
        {host.online ? (
          <div className="sys-gauges">
            {metrics.map((m, k) => (
              <Press
                key={m.id}
                className="sys-gauge vl-build"
                style={iv(i + 1 + k)}
                data-lit={m.id === lit || undefined}
                aria-pressed={m.id === lit}
                aria-label={`${m.label} ${m.value ?? 'unknown'}%: highlight on the model`}
                onPress={() => setFocus(m.id === 'cpu' ? null : m.id === focus ? null : m.id)}
              >
                <span className="sys-gauge-head">
                  <Icon name={m.icon} size={14} tone={m.id === lit ? 'fg' : m.tone === 'fg' ? 'dim' : m.tone} glow={m.id === lit} />
                  <span className="sys-gauge-label">{m.label}</span>
                  {m.sizes && <em className="vl-ellipsis">{m.sizes}</em>}
                  <b data-tone={m.tone}>{m.value ?? '--'}<small>%</small></b>
                </span>
                <Bar value={m.value} tone={m.tone} ticks={4} />
              </Press>
            ))}
          </div>
        ) : (
          <div className="sys-detail-off vl-build" style={iv(i + 1)}>
            <b><Icon name="offline" size={16} tone="dim" />Offline</b>
            <span>No stats published</span>
          </div>
        )}
        {model && (
          <div className="sys-detail-model">
            <Hero
              active={on}
              pose={poseFor(model)}
              host={model}
              fill={0.9}
              layoutKey={`${host.id}:${metrics.length}`}
              className="absolute inset-0"
              activeHotspot={focus}
              onHotspot={onHotspot}
            />
          </div>
        )}
      </div>
      {chart && (
        <div className="sys-detail-chart">
          <div className="sys-chart-cap vl-build" style={iv(i + 6)}>
            <span><Ico name="clock" size={12} />Last hour</span>
            <span>
              <i className="sys-key" data-c="cpu" />CPU
              {hasMem && <><i className="sys-key" data-c="mem" />Memory</>}
              <span className="sys-chart-peak">peak {Math.round(peak)}%</span>
            </span>
          </div>
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
        </div>
      )}
    </section>
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
      {h.online ? (
        <>
          <Spark h={h} t1={t1} />
          <Cell value={h.cpu} tone={loadTone(h.cpu)} c="cpu" />
          <Cell value={h.mem} tone={loadTone(h.mem)} sizes={memSizes(h)} />
          <Cell value={h.disk} tone={loadTone(h.disk)} sizes={diskSizes(h)} />
        </>
      ) : (
        <span className="sys-host-offline">No stats published</span>
      )}
    </Press>
  )
}

// ---------- Services ----------

type SvcTab = 'services' | 'timers' | 'apps'
const SVC_TABS: { id: SvcTab; label: string }[] = [{ id: 'services', label: 'Services' }, { id: 'timers', label: 'Timers' }, { id: 'apps', label: 'Apps' }]

function ServicesView({ on, svc }: { on: boolean; svc: Live<SvcSysVM> }) {
  const now = useTick(on ? 5000 : 60_000)
  const [tab, setTab] = useSetting<SvcTab>('sysSvcTab', 'services', ['services', 'timers', 'apps'])
  const [appsSeen, setAppsSeen] = useState(tab === 'apps')
  useEffect(() => { if (tab === 'apps') setAppsSeen(true) }, [tab])
  const d = svc.data
  const counted = d ? [...d.containers, ...d.system, ...d.user] : []
  const down = d ? [...counted, ...d.desktop].filter((s) => s.health === 'alert') : []
  const watch = counted.filter((s) => s.health === 'watch').length
  const upCount = counted.filter((s) => s.health !== 'alert').length

  return (
    <div className="sys-svc">
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
        <TextTabs label="Services view" items={SVC_TABS} value={tab} onChange={setTab} />
      </div>

      {down.length > 0 && (
        <Block label="Down" icon={<Ico name="alert" lit tone="acc2" />} value={down.length} i={1} className="sys-svc-down">
          <div className="sys-svc-rows">
            {down.map((s, k) => <SvcRow key={s.key} s={s} k={k + 2} restart />)}
          </div>
        </Block>
      )}

      {!d && (
        <div className="sys-quiet vl-build" style={iv(1)}>
          {svc.failed ? <><Ico name="offline" size={13} lit tone="hot" />odin is not answering.</> : 'Loading services'}
        </div>
      )}

      {d && tab === 'services' && (
        <div className="sys-svc-cols">
          <SvcGroup label="Containers" icon="container" list={d.containers} i={2} />
          <div className="sys-svc-stack">
            <SvcGroup label="System" icon="service" list={d.system} i={3} />
            <SvcGroup label="User services" icon="service" list={d.user} i={4} note={d.oneshots.length ? `Not counted: ${d.oneshots.length} one-shot unit${d.oneshots.length > 1 ? 's' : ''} that ran and exited (${d.oneshots.join(', ')})` : undefined} />
            <DesktopGroup list={d.desktop} i={5} />
          </div>
        </div>
      )}

      {d && tab === 'timers' && <TimersList timers={d.timers} now={now} />}

      {appsSeen && <div hidden={tab !== 'apps'}><AppsList on={on && tab === 'apps'} /></div>}
    </div>
  )
}

function SvcGroup({ label, icon, list, i, note }: { label: string; icon: IconName; list: SvcItem[]; i: number; note?: string }) {
  if (!list.length) return null
  const shown = list.filter((s) => s.health !== 'alert')
  const ok = shown.length
  return (
    <Block label={label} icon={<Ico name={icon} />} value={<>{ok}<span className="vl-panel-unit">/{list.length} up</span></>} i={i}>
      <div className="sys-svc-rows">
        {shown.map((s, k) => <SvcRow key={s.key} s={s} k={k + i + 1} />)}
      </div>
      {note && <div className="sys-svc-note">{note}</div>}
    </Block>
  )
}

/** KDE, PipeWire and portal units: one folded line, open on tap. */
function DesktopGroup({ list, i }: { list: SvcItem[]; i: number }) {
  const [open, setOpen] = useState(false)
  if (!list.length) return null
  const shown = list.filter((s) => s.health !== 'alert')
  return (
    <Block label="Desktop plumbing" icon={<Ico name="settings" />} value={<>{shown.length}<span className="vl-panel-unit">/{list.length} up</span></>} i={i} className="sys-svc-desk">
      <Press className="sys-fold" data-open={open || undefined} aria-expanded={open} onPress={() => setOpen((o) => !o)}>
        <span>{open ? 'Hide' : 'Show'} {list.length} KDE, PipeWire and portal units</span>
        <i aria-hidden />
      </Press>
      {open && (
        <div className="sys-svc-rows vl-build-on">
          {shown.map((s, k) => <SvcRow key={s.key} s={s} k={k} />)}
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

/**
 * A restart is real (docker restart, or systemctl --user restart, on odin), so
 * it takes two taps: Restart arms it, Confirm sends it, and an armed button
 * that is left alone goes back after ARM_MS. Not optimistic, as the classic
 * Services page is not: the row stays Down until odin's next read says otherwise.
 */
function useRestart(s: SvcItem) {
  const qc = useQueryClient()
  const [phase, setPhase] = useState<'idle' | 'armed' | 'sending'>('idle')
  useEffect(() => {
    if (phase !== 'armed') return
    const t = setTimeout(() => setPhase('idle'), ARM_MS)
    return () => clearTimeout(t)
  }, [phase])
  const press = () => {
    if (phase === 'sending' || restarting.has(s.key)) return
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

function SvcRow({ s, k, restart }: { s: SvcItem; k: number; restart?: boolean }) {
  return (
    <div className="sys-svc-row vl-build" style={iv(Math.min(k, 14))} data-health={s.health} title={s.title}>
      {restart && s.restartable ? <RestartCells s={s} /> : (
        <>
          <SvcName s={s} />
          <span className="sys-svc-detail vl-ellipsis">{s.detail}</span>
          <SvcState health={s.health} />
        </>
      )}
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

/** A down service's row cells with its Restart / Confirm / Restarting button. */
function RestartCells({ s }: { s: SvcItem }) {
  const { phase, press } = useRestart(s)
  return (
    <>
      <SvcName s={s} />
      <span className="sys-svc-detail vl-ellipsis" data-armed={phase === 'armed' || undefined}>
        {/* short: the phone's detail column holds about 20 characters */}
        {phase === 'armed' ? 'Restart it?' : phase === 'sending' ? 'Restarting on odin' : s.detail}
      </span>
      <Press
        className="sys-svc-act vl-hit"
        data-armed={phase === 'armed' || undefined}
        data-sending={phase === 'sending' || undefined}
        aria-busy={phase === 'sending' || undefined}
        aria-label={phase === 'armed' ? `Confirm: restart ${s.name}` : phase === 'sending' ? `Restarting ${s.name}` : `Restart ${s.name}`}
        disabled={phase === 'sending'}
        onPress={press}
      >
        <Ico name={phase === 'armed' ? 'alert' : 'refresh'} size={13} tone={phase === 'armed' ? 'ink' : 'acc2'} />
        {phase === 'armed' ? 'Confirm' : phase === 'sending' ? 'Restarting' : 'Restart'}
      </Press>
    </>
  )
}

/** "2h 9min" -> "2h 9m", "1 day 3h" -> "1d 3h" */
const shortLeft = (s: string) => s.replace(/(\d+)\s*days?/g, '$1d').replace(/min\b/g, 'm').replace(/\s+ago$/, '')

function TimersList({ timers, now }: { timers: TimerItem[]; now: number }) {
  if (!timers.length) return <div className="sys-quiet">odin reports no timers.</div>
  // the next timer to fire is the live one
  const soonest = timers[0]?.next != null ? timers[0].name : null
  return (
    <Block label="Timers" icon={<Ico name="timer" />} value={<span className="sys-dimval">next run · last run</span>} i={2} className="sys-timers">
      <div className="sys-svc-rows">
        {timers.map((t, k) => (
          <div key={t.name} className="sys-svc-row sys-timer vl-build" style={iv(Math.min(k + 3, 16))} data-next={t.name === soonest || undefined}>
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

function AppsList({ on }: { on: boolean }) {
  const apps = useLive('launcherSys', fetchLauncher, 60_000)
  const now = useTick(on ? 10_000 : 120_000)
  const list = useMemo(() => {
    const rank = (a: LauncherEntry) => (a.health === 'down' ? 0 : a.health === 'unknown' ? 1 : 2)
    return [...(apps.data ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [apps.data])
  if (!apps.data) return <div className="sys-quiet">{apps.failed ? 'The app list is unreachable.' : 'Loading apps'}</div>
  const alive = list.filter((a) => a.health === 'alive').length
  return (
    <Block label="Web apps" icon={<Ico name="online" />} value={<>{alive}<span className="vl-panel-unit">/{list.length} alive</span><Fresh live={apps} now={now} /></>} i={2} className="sys-apps">
      <div className="sys-svc-rows">
        {list.map((a, k) => (
          <a key={a.id} className="sys-svc-row sys-app vl-build" style={iv(Math.min(k + 3, 16))} href={a.url} target="_blank" rel="noopener noreferrer" data-health={a.health === 'down' ? 'alert' : 'ok'}>
            <span className="sys-svc-name">
              <Ico name={a.health === 'alive' ? 'online' : 'offline'} size={14} tone={a.health === 'alive' ? 'dim' : a.health === 'down' ? 'acc2' : 'faint'} />
              <span className="vl-ellipsis">{a.name}</span>
            </span>
            <span className="sys-svc-detail vl-ellipsis">{a.category}</span>
            {a.health === 'down' ? <SvcState health="alert" />
              : <span className="sys-svc-state">{a.latencyMs != null ? `${a.latencyMs} ms` : '--'}</span>}
          </a>
        ))}
      </div>
    </Block>
  )
}

// ---------- Trades ----------

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

function TradesView({ on }: { on: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageH = usePageHeight(rootRef)
  const trade = useTrade(on)
  const palette = usePalette()
  const reduced = useReducedMotion()
  const now = useTick(on ? 10_000 : 120_000)
  const { epoch } = useOpening(on)
  const t = trade.data
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

  // the trailing run of identical totals: the bot repeating one figure, not new readings
  const flatFrom = useMemo(() => {
    if (pts.length < 3) return null
    const last = pts[pts.length - 1].v
    let i = pts.length - 1
    while (i > 0 && pts[i - 1].v === last) i--
    return i <= pts.length - 2 ? i : null
  }, [pts])

  const chart = useMemo(() => {
    if (pts.length < 2) return null
    const vals = pts.map((p) => p.v)
    const min = Math.min(...vals), max = Math.max(...vals)
    const mid = (min + max) / 2
    // at least 2% of equity tall, so a small move draws small
    const half = Math.max(((max - min) / 2) * 1.15, Math.abs(t?.equity ?? mid) * 0.01, 0.5)
    const ticks = max > min ? [{ v: max, label: usd(max) }, { v: min, label: usd(min) }] : [{ v: max, label: usd(max) }]
    // x by trading time: one equal slot per trading day, the market session
    // across it, no nights or weekends (every point is a market-hours sample)
    const keys = pts.map((p) => fmtDayKey.format(p.t))
    const mins = pts.map((p) => nyMinutes(p.t))
    const open = Math.floor(Math.min(9.5 * 60, ...mins) / 30) * 30
    const close = Math.ceil(Math.max(16 * 60, ...mins) / 30) * 30
    const order = new Map<string, number>()
    keys.forEach((k) => { if (!order.has(k)) order.set(k, order.size) })
    const nd = order.size
    const points = pts.map((p, k) => ({ x: (order.get(keys[k])! + clamp((mins[k] - open) / (close - open), 0, 1)) / nd, v: p.v }))
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
  const windowLabel = t?.windowDays ? `${t.windowDays}-day change` : pts.length > 1 ? `since ${fmtDate.format(pts[0].t)}` : 'change'
  const trips = t?.liveTrips
  const tripPct = trips != null && t?.targetTrips ? (trips / t.targetTrips) * 100 : null
  const lastTrade = t?.lastTrade ? (/^(buy|sell)\s+(\S+)/i.exec(t.lastTrade)?.slice(1, 3).join(' ') ?? t.lastTrade) : null
  const vars: Vars = { '--trade-h': `${Math.max(180, (pageH || 600) - 110)}px` }

  return (
    <div ref={rootRef} className="sys-trade" style={vars}>
      <div className="sys-trade-main">
        <div className="sys-trade-top vl-build" style={iv(0)}>
          <div className="sys-read-caps vl-caps">
            <Icon name="trades" size={15} tone={!t ? 'faint' : t.up ? 'fg' : 'acc2'} glow={!!t} />
            <span>Trade bot</span>
            <span className="sys-read-state" data-state={t?.up ? 'on' : 'off'} data-bad={(t && !t.up) || undefined}>{!t ? 'No data' : t.up ? 'Up' : 'Down'}</span>
          </div>
          <EquityWhat t={t} now={now} />
          <div className="sys-trade-eq">
            {dollars != null ? <>${dollars}<small>{cents}</small></> : '--'}
          </div>
          <div className="sys-trade-chg" data-neg={neg || undefined} title={t?.windowDays ? `Deposit-adjusted trading change over the last ${t.windowDays} days` : undefined}>
            {t?.changeUsd != null && <Icon name={neg ? 'down' : 'trades'} size={17} tone={neg ? 'acc2' : 'fg'} />}
            <span>{t?.changeUsd != null ? `${sign}${usd(t.changeUsd)}` : '--'}</span>
            {t?.changePct != null && <span>{sign}{Math.abs(t.changePct).toFixed(2)}%</span>}
            <em>{windowLabel}</em>
          </div>
          {dayOpen && (
            <div className="sys-trade-warn">
              <Icon name="alert" size={15} tone="dim" />
              Not a live reading.{flatFrom != null ? ` Unchanged since ${fmtWeekday.format(pts[flatFrom].t)} ${fmtTime.format(pts[flatFrom].t)}.` : ' The bot shows its 9:40 AM day-open total.'}
            </div>
          )}
        </div>
        <Block i={1} dense className="sys-trade-kv">
          <div className="sys-kv vl-build" style={iv(2)}>
            <span><Ico name={t && !t.up ? 'alert' : 'service'} lit={!!t && !t.up} tone={t && !t.up ? 'acc2' : undefined} />Health</span>
            <b data-bad={(t && !t.up) || undefined}>{t ? t.upDetail || (t.up ? 'Up' : 'Down') : '--'}</b>
          </div>
          <div className="sys-kv vl-build" style={iv(3)}>
            <span><Ico name="clock" lit={!!t?.marketOpen} />Market</span>
            <b data-open={t?.marketOpen || undefined}>{t ? (t.marketOpen ? 'Open' : 'Closed') : '--'}{t && !t.marketOpen && t.marketReason && <em> · {t.marketReason}</em>}</b>
          </div>
          <div className="sys-kv sys-kv-trips vl-build" style={iv(4)}>
            <span><Ico name="refresh" />Live round trips</span>
            <b>{trips != null ? <>{trips}<em> / {t?.targetTrips}</em></> : <em>not known yet</em>}</b>
            {tripPct != null && <Bar value={tripPct} tone="fg" ticks={10} />}
          </div>
          <div className="sys-kv vl-build" style={iv(5)}>
            <span><Ico name={t?.rulesOk === false ? 'alert' : 'done'} lit={t?.rulesOk === false} tone={t?.rulesOk === false ? 'acc2' : undefined} />Rules</span>
            <b data-bad={t?.rulesOk === false || undefined}>{t?.rulesOk === false ? 'Changed since pre-registration' : t?.rulesOk ? 'Match pre-registration' : <em>unknown</em>}</b>
          </div>
          <div className="sys-kv vl-build" style={iv(6)}>
            <span><Ico name="gauge" />Judge spend</span>
            <b>{t ? <><span className="sys-nw">{usd(t.spendToday)}<em> today</em></span><em> · </em><span className="sys-nw">{usd(t.spendTotal)}<em> total ({t.callsTotal} calls)</em></span></> : '--'}</b>
          </div>
          {lastTrade && (
            <div className="sys-kv vl-build" style={iv(7)}>
              <span><Ico name="trades" />Last trade</span>
              <b>{lastTrade}{t?.lastTradeAt != null && <em> · {fmtWeekday.format(t.lastTradeAt)} {fmtDate.format(t.lastTradeAt)}</em>}</b>
            </div>
          )}
          <div className="sys-kv vl-build" style={iv(8)}>
            <span><Ico name={trade.failed || t?.stale ? 'offline' : 'online'} lit={!!(trade.failed || t?.stale)} tone={trade.failed || t?.stale ? 'acc2' : undefined} />Status</span>
            <b className="sys-kv-dim" data-stale={t?.stale || trade.failed || undefined}>
              {trade.failed ? `unreachable, showing ${ago(trade.updatedAt, now)} old` : t?.stale ? 'Stale: the bot has not reported lately' : t?.generatedAt ? `written ${ago(t.generatedAt, now)} ago` : '--'}
            </b>
          </div>
        </Block>
      </div>
      <Block
        className="sys-trade-chart"
        label="Equity"
        icon={<Ico name={neg ? 'down' : 'trades'} />}
        value={chart || range ? <span className="sys-dimval">{range}{range && chart ? ' · ' : ''}{chart ? `range ${chart.rangePct.toFixed(2)}%` : ''}</span> : undefined}
        i={9}
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
                tailFrom={dayOpen && flatFrom != null ? flatFrom : undefined}
                lastLabel={usd(chart.last)}
                lastNote={dayOpen && flatFrom != null ? 'not live' : undefined}
                ariaLabel={chart.aria}
                palette={palette}
                paused={!on}
                motion={reduced ? 'reduced' : 'full'}
                style={{ height: '100%' }}
              />
            </div>
            <div className="sys-chart-cap sys-trade-legend">
              <span><i className="sys-key" data-c="eq" />Equity, trading days only</span>
              {dayOpen && flatFrom != null && <span><i className="sys-key" data-c="dash" />repeated figure, not live</span>}
            </div>
          </>
        ) : (
          <div className="sys-quiet">{trade.failed ? 'The trade bot is unreachable.' : 'No equity history yet'}</div>
        )}
      </Block>
    </div>
  )
}
