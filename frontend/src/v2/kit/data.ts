import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api, fetchAIUsage, fetchHosts, fetchLights, fetchMediaDownloads, fetchMediaRequests,
  fetchMusicRecent, fetchPlexRecent, fetchServices, fetchSessionList, fetchTradeBotStatus,
  fetchImgToken, imgAuthRev, imgTrusted, musicImg, plexImg, plexImgPath, subscribeImgAuth, type PlexItem,
} from '../../lib/api'
import { fetchCalendarEvents, type CalendarEvent } from '../../lib/calendarApi'
import { fetchInboxCount, type InboxCount } from '../../lib/inboxApi'
import { fetchTasks, type TasksPage } from '../../lib/tasksApi'
import type { HostStat, LaunchTarget, ServiceUnit, VehicleStat } from '../../lib/api'
import { lightColor, pctFromBrightness } from '../../lib/lights'
import { fetchProjList } from '../../lib/projectsApi'
import { shortName } from '../../lib/quickSessions'
import { fetchDailyStreak, fetchTrackerWindow, supplementDateKey } from '../../lib/supplementsApi'

// v2's data layer. Every hook here reads, and returns a small view model,
// never the raw payload, for two reasons:
//
//   1. Instant first paint. Each result is persisted to localStorage and fed
//      back as initialData, so a cold open shows the last real numbers in the
//      first frame and refreshes behind them. The session board is 390 KB and
//      takes ~3 s from odin; its view model is a few KB and paints at once.
//   2. Screens stay simple and agree on shapes.
//
// Polling pauses while the page is hidden. Writes go through src/lib (the
// screens and the dock call its hooks and API functions), never through here.

const PREFIX = 'v2.q.'

type Cached<T> = { at: number; data: T }

function readCache<T>(key: string): Cached<T> | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as Cached<T>) : undefined
  } catch {
    return undefined
  }
}

function writeCache<T>(key: string, data: T): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), data })) } catch { /* quota or private mode */ }
}

export type Live<T> = {
  data: T | undefined
  /** ms epoch of the data shown (cache time until the first fetch lands). */
  updatedAt: number
  /** true while the data on screen came from the persisted cache, not this session. */
  fromCache: boolean
  isFetching: boolean
  error: Error | null
  /**
   * The newest fetch failed. `data` (if any) is the last GOOD result, never an
   * empty stand-in: a failing backend must read as "unreachable, showing Xm
   * old", not as "nothing there". Failures are never written to the cache.
   */
  failed: boolean
}

export type LiveOptions<T> = {
  /**
   * Upgrades a cached view model written by an older build (a field added
   * since): return the fixed value, or undefined to ignore the cache.
   */
  revive?: (cached: unknown) => T | undefined
}

/** Persisted, visibility-aware query. `every` is the poll interval in ms. */
export function useLive<T>(key: string, fn: () => Promise<T>, every: number, opts?: LiveOptions<T>): Live<T> {
  const [cached] = useState(() => {
    const c = readCache<T>(key)
    if (!c || !opts?.revive) return c
    const data = opts.revive(c.data)
    return data === undefined ? undefined : { at: c.at, data }
  })
  const q = useQuery({
    queryKey: ['v2', key],
    queryFn: async () => {
      const data = await fn()
      writeCache(key, data)
      return data
    },
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.at,
    staleTime: 0,
    refetchOnMount: true,
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : every),
    refetchOnWindowFocus: true,
    retry: 1,
  })
  const fromCache = !!cached && q.dataUpdatedAt === cached.at
  const has = q.data !== undefined
  const live = has && !fromCache
  useEffect(() => {
    if (has) markDataPainted(live)
  }, [has, live])
  return { data: q.data, updatedAt: q.dataUpdatedAt, fromCache, isFetching: q.isFetching, error: q.error, failed: q.isError }
}

// ---------- first data on screen (Settings > Speed) ----------

let firstData: number | null = null
let firstLive: number | null = null

/** Stamps the frame after the commit that first showed data (any, then fetched this session). */
function markDataPainted(live: boolean): void {
  if (firstData != null && (!live || firstLive != null)) return
  requestAnimationFrame(() => {
    const t = Math.round(performance.now())
    if (firstData == null) firstData = t
    if (live && firstLive == null) firstLive = t
  })
}

/** Re-renders every `ms` so "ago" labels and clocks stay current. */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(false)
  useEffect(() => {
    // a new pace (a tab coming into view ticks faster) starts from the real time, not the last slow tick
    const kick = mounted.current ? setTimeout(() => setNow(Date.now()), 0) : 0
    mounted.current = true
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [ms])
  return now
}

export const ago = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// ---------- hosts ----------

export type HostVM = {
  id: string
  label: string
  online: boolean
  stale: boolean
  cpu: number | null
  mem: number | null
  /** the fullest disk, so one figure flags the disk that needs room */
  disk: number | null
  cores: number | null
  battery: { percent: number; charging: boolean } | null
  uptime: number | null
  /** GiB used / total, null when the host does not report it */
  memUsedGb: number | null
  memTotalGb: number | null
  diskUsedGb: number | null
  diskTotalGb: number | null
  /** every disk, the system disk first; empty when the host reports none */
  disks: DiskVM[]
  /** last hour, oldest first, 0-100 */
  history: { t: number; cpu: number | null; mem: number | null }[]
  /** true for the phone and tablet, which report a battery (and maybe storage) and nothing else */
  mobile: boolean
  /** the phone and tablet: when odin last heard from it (ms), null otherwise */
  seen: number | null
  /** the cars (host id car-<prefix>): range, charging and the rest; null for every other host */
  vehicle: VehicleVM | null
  /** ms, when the numbers were read (a sleeping car's are from when it fell asleep) */
  ts: number | null
}

/** One disk. name: "C:", "/", "ssdpool" (a mount point's last part); null where the host names none. */
export type DiskVM = { name: string | null; percent: number; usedGb: number; totalGb: number }

/** A car's facts, as /api/hosts gives them, re-checked and rounded for the page (model: HA's, e.g. "Model Y"). */
export type VehicleVM = VehicleStat

const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10

/** the host's disks; one unnamed disk for a host that reports only `disk` */
function diskVMs(h: HostStat): DiskVM[] {
  const vm = (name: string | null, d: { percent: number; used: number; total: number }): DiskVM =>
    ({ name, percent: Math.round(d.percent), usedGb: gib(d.used), totalGb: gib(d.total) })
  const short = (n: string) => (n.startsWith('/') && n !== '/' ? n.slice(n.lastIndexOf('/') + 1) : n)
  if (h.disks?.length) return h.disks.map((d) => vm(short(d.name), d))
  return h.disk ? [vm(null, h.disk)] : []
}

/** the fullest disk */
export const fullest = (disks: DiskVM[]): DiskVM | null => disks.reduce<DiskVM | null>((a, d) => (a == null || d.percent > a.percent ? d : a), null)
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r0 = (v: unknown): number | null => { const n = fin(v); return n == null ? null : Math.round(n) }
const r1 = (v: unknown): number | null => { const n = fin(v); return n == null ? null : Math.round(n * 10) / 10 }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const VEHICLE_STATE = ['awake', 'asleep', 'offline', 'unknown'] as const
const CHARGING = ['starting', 'charging', 'stopped', 'complete', 'disconnected', 'no_power'] as const

function vehicleVM(raw: VehicleStat | undefined): VehicleVM {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VehicleStat>
  return {
    model: typeof v.model === 'string' ? v.model : null,
    state: v.state && (VEHICLE_STATE as readonly string[]).includes(v.state) ? v.state : 'unknown',
    since: fin(v.since),
    rangeMi: r0(v.rangeMi),
    chargeLimit: r0(v.chargeLimit),
    charging: v.charging && (CHARGING as readonly string[]).includes(v.charging) ? v.charging : null,
    chargerKw: r1(v.chargerKw),
    chargeRateMph: r0(v.chargeRateMph),
    fullAt: fin(v.fullAt),
    cable: bool(v.cable),
    locked: bool(v.locked),
    home: bool(v.home),
    insideF: r0(v.insideF),
    outsideF: r0(v.outsideF),
    climateOn: bool(v.climateOn),
  }
}

const reviveHosts = (d: unknown): HostVM[] | undefined => Array.isArray(d)
  ? (d as Partial<HostVM>[]).map((h) => ({ memUsedGb: null, memTotalGb: null, diskUsedGb: null, diskTotalGb: null, disks: [], mobile: false, seen: null, vehicle: null, ts: null, ...h }) as HostVM)
  : undefined

export function useHosts(): Live<HostVM[]> {
  return useLive('hosts', async () => (await fetchHosts()).map((h): HostVM => {
    const disks = diskVMs(h)
    const worst = fullest(disks)
    return {
      id: h.host,
      label: h.label,
      online: h.online,
      stale: h.stale,
      cpu: h.cpu ? Math.round(h.cpu.usage) : null,
      mem: h.memory ? Math.round(h.memory.percent) : null,
      disk: worst?.percent ?? null,
      cores: h.cpu?.cores ?? null,
      battery: h.battery ? { percent: Math.round(h.battery.percent), charging: h.battery.status === 'charging' } : null,
      uptime: h.uptime,
      memUsedGb: h.memory ? gib(h.memory.used) : null,
      memTotalGb: h.memory ? gib(h.memory.total) : null,
      diskUsedGb: worst?.usedGb ?? null,
      diskTotalGb: worst?.totalGb ?? null,
      disks,
      history: (h.history ?? []).map((p) => ({ t: p.t, cpu: p.cpu, mem: p.mem })),
      mobile: h.os === 'ios',
      seen: h.seen ?? null,
      vehicle: h.os === 'vehicle' ? vehicleVM(h.vehicle) : null,
      ts: fin(h.ts),
    }
  }), 5_000, { revive: reviveHosts })
}

// ---------- AI usage ----------

export type UsageVM = {
  /** The account the headline numbers come from: the hottest live one, as on the desktop dashboard. */
  label: string | null
  /** 5-hour window %, 0-100, null when unknown */
  five: number | null
  week: number | null
  fiveResetsAt: string | null
  weekResetsAt: string | null
  todayCost: number
  todayTokens: number
  weekCost: number
  burnPerHour: number | null
  /** every account, hottest first (dead sign-ins last) */
  accounts: { id: string; label: string; email: string | null; five: number | null; week: number | null; dead: boolean; fiveResetsAt: string | null; weekResetsAt: string | null }[]
}

export function useUsage(): Live<UsageVM> {
  return useLive('usage', async (): Promise<UsageVM> => {
    const u = await fetchAIUsage()
    // claude.quota is only the default account (often an idle one at 0%), so
    // the headline follows the hottest signed-in account, which is the one
    // Brendon is actually burning. Same rule as the desktop AIUsage table.
    const live = (u.aiClients ?? []).filter((c) => c.quota && !c.authError)
    const heat = (c: (typeof live)[number]) => Math.max(c.quota?.sessionPct ?? -1, c.quota?.weeklyPct ?? -1)
    const hottest = live.length ? live.reduce((a, b) => (heat(b) > heat(a) ? b : a)) : null
    const q = hottest?.quota ?? u.claude.quota
    return {
      label: hottest?.label ?? null,
      five: q ? Math.round(q.sessionPct) : null,
      week: q ? Math.round(q.weeklyPct) : null,
      fiveResetsAt: q?.sessionResetsAt ?? null,
      weekResetsAt: q?.weeklyResetsAt ?? null,
      todayCost: u.claude.today.costUSD,
      todayTokens: u.claude.today.tokens,
      weekCost: u.claude.last7d.costUSD,
      burnPerHour: u.claude.session?.burnRate?.costPerHour ?? null,
      accounts: (u.aiClients ?? []).map((c) => ({
        id: c.id,
        label: c.label,
        email: c.email || null,
        five: c.quota ? Math.round(c.quota.sessionPct) : null,
        week: c.quota ? Math.round(c.quota.weeklyPct) : null,
        dead: !!c.authError,
        fiveResetsAt: c.quota?.sessionResetsAt ?? null,
        weekResetsAt: c.quota?.weeklyResetsAt ?? null,
      })).sort((a, b) => Number(a.dead) - Number(b.dead) || Math.max(b.five ?? -1, b.week ?? -1) - Math.max(a.five ?? -1, a.week ?? -1)),
    }
  }, 30_000)
}

// ---------- which account each host is on (the account switcher) ----------

// GET /api/account-switch, cut to what the headline needs: the account each
// host's terminals actually use now. The dashboard and the usage headline name
// THIS, not the hottest account, so "the account thor is on" is never a guess.
// 404 (the switcher is not deployed on odin) reads as "not installed".
export type SwitchStatusVM = {
  installed: boolean
  hosts: Record<'thor' | 'odin', { active: { id: string; label: string } | null; adopted: boolean } | null>
}

const NO_SWITCH: SwitchStatusVM = { installed: false, hosts: { thor: null, odin: null } }

export function useSwitchStatus(): Live<SwitchStatusVM> {
  return useLive<SwitchStatusVM>('switch-status', async () => {
    try {
      const d = (await api.get('/account-switch')).data as { hosts?: Array<{ host?: string; active?: { id?: string; label?: string } | null; adopted?: boolean }> }
      if (!Array.isArray(d?.hosts)) return NO_SWITCH
      const pick = (h: 'thor' | 'odin') => {
        const row = d.hosts!.find((x) => x.host === h)
        if (!row) return null
        const id = row.active?.id
        return { active: id ? { id, label: row.active?.label ?? id } : null, adopted: row.adopted === true }
      }
      return { installed: true, hosts: { thor: pick('thor'), odin: pick('odin') } }
    } catch (e) {
      if ((e as { response?: { status?: number } } | null)?.response?.status === 404) return NO_SWITCH
      throw e
    }
  }, 15_000, { revive: (c) => (c && typeof c === 'object' && 'hosts' in (c as object) ? (c as SwitchStatusVM) : undefined) })
}

/** The account a host's terminals use now, with its windows. Falls back to the hottest account (the
 *  one being burned) when the switcher is not installed or has not taken the host over, and says so. */
export type OnAccount = {
  label: string | null
  five: number | null
  week: number | null
  fiveResetsAt: string | null
  weekResetsAt: string | null
  /** 'host' = the account this host is on; 'hottest' = the fallback */
  source: 'host' | 'hottest'
  /** why the fallback is showing, null when source is 'host' */
  note: string | null
}

export function onAccount(u: UsageVM | undefined, sw: SwitchStatusVM | undefined, host: 'thor' | 'odin' = 'thor'): OnAccount {
  const hottest: OnAccount = {
    label: u?.label ?? null, five: u?.five ?? null, week: u?.week ?? null,
    fiveResetsAt: u?.fiveResetsAt ?? null, weekResetsAt: u?.weekResetsAt ?? null, source: 'hottest', note: null,
  }
  if (!sw?.installed) return hottest
  const h = sw.hosts[host]
  if (!h || !h.active) return { ...hottest, note: `${host} not on the switcher` }
  const acct = u?.accounts.find((a) => a.id === h.active!.id)
  return {
    label: h.active.label,
    five: acct?.five ?? null,
    week: acct?.week ?? null,
    fiveResetsAt: acct?.fiveResetsAt ?? null,
    weekResetsAt: acct?.weekResetsAt ?? null,
    source: 'host',
    note: null,
  }
}

// ---------- Claude sessions ----------

export type SessionVM = {
  id: string
  title: string
  project: string
  area: string
  host: string
  activity: 'working' | 'asking' | 'idle' | 'closed'
  live: boolean
  /** ms epoch, 0 when unknown */
  last: number
  /** the command that resumes it on its host (copy to clipboard), null when unknown */
  resume: string | null
  /** open in a terminal on its host's desk right now */
  onDesk: boolean
}

/** One session of the WHOLE board (done ones included), for looking sessions up by id. */
export type SessionBrief = SessionVM & { done: boolean }

export type SessionIndex = {
  /** every session on the board by id; empty until the first board fetch of this page load */
  byId: ReadonlyMap<string, SessionBrief>
  /** ms epoch of the fetch the index came from, 0 = not fetched yet */
  at: number
  /** true once the index holds a real fetch */
  ready: boolean
  isFetching: boolean
}

// The full board is ~390 KB, so only the 40-row view model persists. The index
// of every session lives in memory, filled by the same fetch useSessions makes.
let sessionIndex: { byId: ReadonlyMap<string, SessionBrief>; at: number } = { byId: new Map(), at: 0 }
const indexListeners = new Set<() => void>()
const subscribeIndex = (l: () => void) => {
  indexListeners.add(l)
  return () => { indexListeners.delete(l) }
}
const getIndex = () => sessionIndex

/** Open (not done) sessions, most recent first, capped at 40. */
export function useSessions(): Live<SessionVM[]> {
  return useLive('sessions', async () => {
    const r = await fetchSessionList()
    // fetchSessionList folds every 5xx into installed:false. Returning [] here
    // painted (and cached) "0 live, nothing open" while odin was failing.
    if (!r.installed) throw new Error(r.detail ?? `session board unavailable (${r.status})`)
    const all = r.sessions.map((s): SessionBrief => ({
      id: s.sessionId,
      title: s.title,
      project: s.project,
      area: s.area,
      host: s.host,
      activity: s.activity,
      live: s.live,
      last: s.lastActivityUtc ? Date.parse(s.lastActivityUtc) : 0,
      resume: s.resumeCommand,
      onDesk: s.onDesk,
      done: s.done,
    }))
    sessionIndex = { byId: new Map(all.map((b) => [b.id, b])), at: Date.now() }
    indexListeners.forEach((l) => l())
    return all
      .filter((s) => !s.done)
      .sort((a, b) => b.last - a.last)
      .slice(0, 40)
      .map(({ done: _done, ...vm }): SessionVM => vm)
  }, 15_000, { revive: (d) => (Array.isArray(d) ? (d as Partial<SessionVM>[]).map((x) => ({ resume: null, onDesk: false, ...x }) as SessionVM) : undefined) })
}

/**
 * Every session on the board by id (title, project, host, last, activity,
 * done), from the same fetch as useSessions: mounting it never adds a request.
 * Memory only, never persisted, so it is empty until the first fetch lands.
 */
export function useSessionIndex(): SessionIndex {
  const s = useSessions()
  const idx = useSyncExternalStore(subscribeIndex, getIndex, getIndex)
  const fetching = s.isFetching
  return useMemo(() => ({ byId: idx.byId, at: idx.at, ready: idx.at > 0, isFetching: fetching }), [idx, fetching])
}

// ---------- lights ----------

export type LightVM = {
  id: string
  name: string
  on: boolean
  unavailable: boolean
  /** 0-100, null when the bulb does not report it */
  pct: number | null
  /** CSS color of what the bulb is showing */
  color: string
}

export function useLights(): Live<LightVM[]> {
  return useLive('lights', async () => (await fetchLights()).map((l): LightVM => ({
    id: l.entity_id,
    name: l.name,
    on: l.on,
    unavailable: l.unavailable,
    pct: pctFromBrightness(l.brightness),
    color: lightColor(l),
  })), 10_000)
}

// ---------- services ----------

export type ServiceVM = {
  name: string
  kind: 'container' | 'unit'
  up: boolean
  detail: string
  /** where it runs: a docker container, a systemd user unit, or a system unit (docker, sshd, tailscaled...) */
  scope: 'container' | 'user' | 'system'
  description: string
}

export function useServices(): Live<ServiceVM[]> {
  return useLive('services', async () => {
    const s = await fetchServices()
    const containers = s.containers.map((c): ServiceVM => ({ name: c.name, kind: 'container', up: c.state === 'running', detail: c.status, scope: 'container', description: c.image }))
    const unit = (scope: 'user' | 'system') => (u: ServiceUnit): ServiceVM => ({
      name: u.name.replace(/\.service$/, ''), kind: 'unit', up: u.active === 'active', detail: u.sub, scope, description: u.description,
    })
    const units = [...s.services.map(unit('user')), ...(s.systemServices ?? []).map(unit('system'))]
    return [...containers, ...units].sort((a, b) => Number(a.up) - Number(b.up) || a.name.localeCompare(b.name))
  }, 30_000, { revive: (d) => (Array.isArray(d) ? (d as Partial<ServiceVM>[]).map((x) => ({ scope: x.kind === 'container' ? 'container' : 'user', description: '', ...x }) as ServiceVM) : undefined) })
}

// ---------- trade bot ----------

export type TradeVM = {
  up: boolean
  marketOpen: boolean
  equity: number | null
  changeUsd: number | null
  changePct: number | null
  spendToday: number
  /** equity history, oldest first */
  points: { t: number; v: number }[]
  stale: boolean
  /** ms epoch the bot wrote its status (status.json generated_at), null when unknown */
  generatedAt: number | null
  /** 'sample' = a real broker read; 'day_open' = the 09:40 fallback, NOT live; null = unknown */
  equitySource: string | null
  /** minutes since the equity figure was taken, when known */
  equityAgeMin: number | null
  /** the health line the bot writes, e.g. "all arms healthy" */
  upDetail: string
  /** live round trips so far / the target (null live = not knowable yet) */
  liveTrips: number | null
  targetTrips: number
  /** false = the rules hash drifted from the pre-registration */
  rulesOk: boolean | null
  spendTotal: number
  /** the history window the change figures cover, in days */
  windowDays: number | null
  /**
   * ms epoch of the newest equity sample (portfolio.live_equity_sampled_at),
   * null when the backend does not send it yet: equitySampleTime() then falls
   * back to generatedAt minus equityAgeMin.
   */
  equitySampledAt: number | null
  /** why the market is closed ("weekend"), '' when open or unknown */
  marketReason: string
  callsTotal: number
  callsToday: number
  /** the bot's own line for its last trade ("sell HPE at the broker on ..."), null when none */
  lastTrade: string | null
  lastTradeAt: number | null
  /** cash in the account, from the same read as `equity` (null when unknown) */
  cash: number | null
  /**
   * ms epoch of the newest broker read on file, whatever its age
   * (portfolio.newest_sample_at), null when there is none: the day-open
   * fallback says when the broker was last read
   */
  lastReadAt: number | null
}

const reviveTrade = (d: unknown): TradeVM | undefined => {
  if (!d || typeof d !== 'object') return undefined
  const t = d as Partial<TradeVM>
  return {
    equitySource: null, equityAgeMin: null, upDetail: '', liveTrips: null, targetTrips: 0, rulesOk: null, spendTotal: 0, windowDays: null,
    equitySampledAt: null, marketReason: '', callsTotal: 0, callsToday: 0, lastTrade: null, lastTradeAt: null, cash: null, lastReadAt: null,
    ...t,
    generatedAt: t.generatedAt ?? null,
  } as TradeVM
}

const msOf = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** fields of /api/tradebot/status that src/lib's TradeBotDoc does not type (yet) */
type TradeExtras = {
  portfolio: { live_equity_sampled_at?: string | null; newest_sample_at?: string | null }
  productivity?: { last_trade_detail?: string | null; last_trade_at?: string | null }
}

/** how often the trade status is read while the ticker or Trades is on screen, and otherwise */
const TRADE_LIVE_MS = 60_000
const TRADE_IDLE_MS = 5 * 60_000

/**
 * The trade bot's status. `on` = the Dashboard ticker or System > Trades is
 * the visible tab: then it is read every 60 s (and at once when it comes into
 * view with a read older than that); otherwise every 5 minutes. Every caller
 * shares one query, so the fastest caller sets the pace.
 */
export function useTrade(on = false): Live<TradeVM> {
  const qc = useQueryClient()
  const live = useLive('trade', async (): Promise<TradeVM> => {
    const t = await fetchTradeBotStatus()
    const x = t as typeof t & TradeExtras
    return {
      up: t.up,
      marketOpen: t.market.is_open,
      equity: t.portfolio.live_equity,
      changeUsd: t.history?.change_usd ?? null,
      changePct: t.history?.change_pct ?? null,
      spendToday: t.spend.today_usd,
      points: (t.history?.points ?? []).map((p) => ({ t: Date.parse(p.ts), v: p.total })),
      stale: t.stale,
      generatedAt: Number.isFinite(Date.parse(t.generated_at)) ? Date.parse(t.generated_at) : null,
      equitySource: t.portfolio.live_equity_source ?? null,
      equityAgeMin: t.portfolio.live_equity_age_min ?? null,
      upDetail: t.up_detail,
      liveTrips: t.experiment.live_trips,
      targetTrips: t.experiment.target_trips,
      rulesOk: t.experiment.rules_ok,
      spendTotal: t.spend.total_usd,
      windowDays: t.history?.window_days ?? null,
      equitySampledAt: msOf(x.portfolio.live_equity_sampled_at),
      marketReason: t.market.reason ?? '',
      callsTotal: t.spend.calls_total,
      callsToday: t.spend.calls_today,
      lastTrade: x.productivity?.last_trade_detail || null,
      lastTradeAt: msOf(x.productivity?.last_trade_at),
      cash: t.portfolio.live_cash ?? null,
      lastReadAt: msOf(x.portfolio.newest_sample_at),
    }
  }, on ? TRADE_LIVE_MS : TRADE_IDLE_MS, { revive: reviveTrade })
  const { updatedAt } = live
  useEffect(() => {
    if (on && Date.now() - updatedAt > TRADE_LIVE_MS) void qc.refetchQueries({ queryKey: ['v2', 'trade'], type: 'active' })
    // only when it comes into view; the interval keeps it fresh after that
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, qc])
  return live
}

// New York calendar day ("2026-10-16"): trading days are New York days, whatever the phone's zone
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
export const nyDayKey = (ms: number): string => NY_DAY.format(ms)

/**
 * ms epoch the equity figure was read at the broker: the backend's sample
 * time when it sends one, else generatedAt minus equityAgeMin, else null.
 */
export function equitySampleTime(t: TradeVM): number | null {
  if (t.equitySampledAt != null) return t.equitySampledAt
  if (t.equityAgeMin != null && t.generatedAt != null) return t.generatedAt - t.equityAgeMin * 60_000
  return null
}

/**
 * a broker read younger than this is "live". The sampler reads every minute in
 * the weekday session and every 10 minutes otherwise, so 15 minutes keeps an
 * on-time read live at any hour and lets one missed read show its age.
 */
export const EQUITY_LIVE_MS = 15 * 60_000

/** the equity is a broker read whose cash equals its total: no open positions */
export function tradeAllCash(t: TradeVM): boolean {
  return t.equitySource === 'sample' && t.cash != null && t.equity != null && t.equity > 0 && Math.abs(t.cash - t.equity) < 0.01
}

export type EquityAge = {
  /** live = a broker read under 15 minutes old; read = an older broker read; day_open = the 09:40 fallback */
  kind: 'live' | 'read' | 'day_open' | 'unknown'
  /** ms epoch of the read, null when unknown */
  at: number | null
}

/** How old the equity figure really is, by its source and sample time. */
export function equityAge(t: TradeVM, now: number): EquityAge {
  if (t.equitySource === 'day_open') return { kind: 'day_open', at: equitySampleTime(t) }
  const at = equitySampleTime(t)
  if (t.equitySource !== 'sample') return { kind: 'unknown', at }
  if (at == null) return { kind: 'read', at: null }
  return { kind: now - at <= EQUITY_LIVE_MS ? 'live' : 'read', at }
}

export type TradeSession = {
  /** New York day key of the session */
  day: string
  /** ms epoch of the figure the change runs to */
  at: number
  /** equity at the end of the session (or now, while it runs) minus the close before it */
  change: number
  /** the session is today and still running: the change runs to a live broker read */
  running: boolean
  /**
   * every reading of the session repeats the close before it while the equity
   * is the day-open fallback: the bot was repeating one figure, so the change
   * is not a real measurement
   */
  flat: boolean
}

/**
 * The newest trading session's change: from the last reading of the trading
 * day before it to its last reading. While the market is open and the equity
 * is a live read from today, the session runs to that read. History points are
 * market-hours samples, so on a weekend or a holiday the newest day in them is
 * the last session. A window holding one day only measures from that day's
 * first reading. Raw totals: a deposit on that day would count as a gain.
 */
export function tradeSession(t: TradeVM, now: number): TradeSession | null {
  const pts = t.points
  const last = pts[pts.length - 1]
  const today = nyDayKey(now)
  const age = equityAge(t, now)
  let close: number, at: number, running = false
  if (t.marketOpen && t.equity != null && age.kind === 'live' && age.at != null && nyDayKey(age.at) === today && (!last || age.at >= last.t)) {
    close = t.equity
    at = age.at
    running = true
  } else if (last) {
    close = last.v
    at = last.t
  } else {
    return null
  }
  const day = nyDayKey(at)
  let base: number | null = null
  for (let i = pts.length - 1; i >= 0; i--) {
    if (nyDayKey(pts[i].t) < day) { base = pts[i].v; break }
  }
  if (base == null) base = pts.find((p) => nyDayKey(p.t) === day)?.v ?? null
  if (base == null) return null
  const b = base
  const flat = !running && t.equitySource === 'day_open' && pts.every((p) => nyDayKey(p.t) !== day || p.v === b)
  return { day, at, change: Math.round((close - b) * 100) / 100, running, flat }
}

// ---------- media ----------
//
// No image URL is ever cached here. A URL carries the API base in use when it
// was built and, off the tailnet, a 12-hour token. The desktop app moves the
// base to odin's tailnet address after the bundle loads, so URLs persisted by
// a fetch (or built before the token came in) pointed at the wrong host or
// carried no live token: empty posters on the desktop Dashboard while Movies
// and Shows, which build at render time, were fine. The caches keep the Plex
// path; the hooks build URLs at render time through lib/api's plexImg and
// musicImg, keyed on useImgKey.

/**
 * Image readiness as one memo key: -1 while image URLs cannot load yet (the
 * image token is still on its way), else a revision that changes whenever a
 * URL built now would differ (the token arrived or renewed). Fetches the
 * short-lived image token when the API base needs one; an address the backend
 * trusts (the tailnet) needs none and is ready at once.
 */
export function useImgKey(): number {
  const need = !imgTrusted()
  const tok = useQuery({
    queryKey: ['plex-img-token'],
    queryFn: fetchImgToken,
    enabled: need,
    // the token lives 12 h: renew well inside that, and on focus after a long sleep
    staleTime: 5 * 3600_000,
    refetchInterval: 5 * 3600_000,
    retry: 1,
  })
  const rev = useSyncExternalStore(subscribeImgAuth, imgAuthRev, imgAuthRev)
  return !need || tok.isFetched ? rev : -1
}

/** An image URL for a Plex path, built now; null while the key says images cannot load yet. */
export const plexArtUrl = (key: number, path: string | null, w: number, h?: number): string | null =>
  key < 0 || !path ? null : plexImg(path, w, h ? { h } : {})
/** The same off the music server (square). */
export const musicArtUrl = (key: number, path: string | null, w: number): string | null =>
  key < 0 || !path ? null : musicImg(path, w)

type Obj = Record<string, unknown>
const isObj = (o: unknown): o is Obj => !!o && typeof o === 'object'
/** Cached rows from a build that stored image URLs: `fix` turns each one into a row with paths. */
const reviveRows = <R>(c: unknown, fix: (o: Obj) => R): R[] | undefined =>
  Array.isArray(c) && c.every(isObj) ? c.map(fix) : undefined

export type MediaVM = { key: string; title: string; subtitle: string; img: string | null }
/** A MediaVM as the cache keeps it: the Plex image path, not a URL. */
type MediaRow = Omit<MediaVM, 'img'> & { thumb: string | null }

const toMediaRow = (o: Obj): MediaRow => {
  if ('thumb' in o) return o as MediaRow
  const { img, ...rest } = o
  return { ...(rest as Omit<MediaRow, 'thumb'>), thumb: plexImgPath(img) }
}

/** Recently added on the main Plex server (movies and shows). */
export function usePlexRecent(): Live<MediaVM[]> {
  const q = useLive('plexRecent', async () => (await fetchPlexRecent(18)).map((i): MediaRow => ({
    key: i.ratingKey,
    title: i.title,
    subtitle: i.year ? String(i.year) : i.type,
    thumb: i.thumb,
  })), 120_000, { revive: (c) => reviveRows(c, toMediaRow) })
  const imgKey = useImgKey()
  const data = useMemo(() => q.data?.map((r): MediaVM => ({ ...r, img: plexArtUrl(imgKey, r.thumb, 300) })), [q.data, imgKey])
  return { ...q, data }
}

/** A Plex recently-added item with everything a poster row or detail needs. */
export type PlexRichVM = MediaVM & {
  kind: 'movie' | 'show' | 'season' | 'episode' | 'other'
  year: number | null
  /** ms epoch the item reached Plex, 0 when unknown */
  added: number
  /** plain text, em and en dashes replaced */
  summary: string
  /** backdrop image, 640x360, null when Plex has none */
  art: string | null
  /** "R", "PG-13"; null when unknown or "Not Rated" */
  contentRating: string | null
  /** runtime in ms (movies), null otherwise */
  duration: number | null
  /** episodes in the show or season; in the grouped list, the sum over the folded seasons */
  episodes: number | null
  /** the show's name for a season, else null */
  show: string | null
  /** a season's number ([3]); in the grouped list every folded season, sorted; [] otherwise */
  seasons: number[]
  /** ratingKeys behind this item: [key], or every folded season in the grouped list */
  keys: string[]
  /** the Plex paths behind img and art: build another size with plexArtUrl */
  thumb: string | null
  artPath: string | null
}
/** A PlexRichVM as the cache keeps it: paths, no URLs. */
type PlexRichRow = Omit<PlexRichVM, 'img' | 'art'>

const noDash = (s: string, sep = ' · ') => s.replace(/\s*[\u2014\u2013]\s*/g, sep)
const PLEX_SEASON = /^(.*?)\s+[\u2014\u2013-]\s+Season\s+(\d+)$/i

/** "Season 2", "Seasons 1-5", "Seasons 1, 3" */
export const seasonLabel = (nums: number[]): string => {
  const s = [...new Set(nums)].sort((a, b) => a - b)
  if (!s.length) return 'Show'
  if (s.length === 1) return `Season ${s[0]}`
  const run = s.every((n, k) => k === 0 || n === s[k - 1] + 1)
  return run ? `Seasons ${s[0]}-${s[s.length - 1]}` : `Seasons ${s.join(', ')}`
}

const toPlexRow = (i: PlexItem): PlexRichRow => {
  const season = i.type === 'season' ? PLEX_SEASON.exec(i.title) : null
  const kind: PlexRichVM['kind'] = i.type === 'movie' || i.type === 'show' || i.type === 'season' || i.type === 'episode' ? i.type : 'other'
  const show = season ? noDash(season[1]) : null
  const num = season ? Number(season[2]) : null
  return {
    key: i.ratingKey,
    title: show ?? noDash(i.title),
    subtitle: num != null ? `Season ${num}` : i.year ? String(i.year) : kind === 'movie' ? 'Movie' : kind === 'episode' ? 'Episode' : 'Show',
    thumb: i.thumb,
    kind,
    year: i.year,
    added: (i.addedAt ?? 0) * 1000,
    summary: noDash(i.summary ?? '', ', ').trim(),
    artPath: i.art,
    contentRating: i.contentRating && i.contentRating !== 'Not Rated' ? i.contentRating : null,
    duration: kind === 'movie' ? i.duration : null,
    episodes: i.leafCount,
    show,
    seasons: num != null ? [num] : [],
    keys: [i.ratingKey],
  }
}

const toPlexRichRow = (o: Obj): PlexRichRow => {
  if ('thumb' in o) return o as PlexRichRow
  const { img, art, ...rest } = o
  return { ...(rest as Omit<PlexRichRow, 'thumb' | 'artPath'>), thumb: plexImgPath(img), artPath: plexImgPath(art) }
}

const withPlexImgs = (r: PlexRichRow, imgKey: number): PlexRichVM => ({
  ...r,
  img: plexArtUrl(imgKey, r.thumb, 300),
  art: plexArtUrl(imgKey, r.artPath, 640, 360),
})

/** Folds seasons of the same show into one item at the most recent season's place. */
export function groupPlexSeasons(items: PlexRichVM[]): PlexRichVM[] {
  const out: PlexRichVM[] = []
  const shows = new Map<string, PlexRichVM>()
  for (const it of items) {
    if (it.kind !== 'season' || !it.show) {
      out.push(it)
      continue
    }
    const g = shows.get(it.show)
    if (!g) {
      const first: PlexRichVM = { ...it, seasons: [...it.seasons], keys: [...it.keys] }
      shows.set(it.show, first)
      out.push(first)
      continue
    }
    g.seasons.push(...it.seasons)
    g.keys.push(...it.keys)
    g.episodes = (g.episodes ?? 0) + (it.episodes ?? 0) || null
    g.added = Math.max(g.added, it.added)
    if (!g.summary && it.summary) g.summary = it.summary
    if (!g.thumb && it.thumb) {
      g.thumb = it.thumb
      g.img = it.img
    }
    if (!g.artPath && it.artPath) {
      g.artPath = it.artPath
      g.art = it.art
    }
  }
  for (const g of shows.values()) {
    g.seasons.sort((a, b) => a - b)
    g.subtitle = seasonLabel(g.seasons)
    if (g.keys.length > 1) g.kind = 'show'
  }
  return out
}

/**
 * Recently added on the main Plex server, 30 items, newest first, with kind,
 * added, summary and art. `grouped` folds the seasons of one show into a
 * single item ("Seasons 1-5"); both lists come from one fetch and one cache.
 */
export function usePlexRecentRich(opts?: { grouped?: boolean }): Live<PlexRichVM[]> {
  const q = useLive('plexRich', async () => (await fetchPlexRecent(30)).map(toPlexRow), 120_000, {
    revive: (c) => reviveRows(c, toPlexRichRow),
  })
  const imgKey = useImgKey()
  const grouped = !!opts?.grouped
  const data = useMemo(() => {
    if (!q.data) return undefined
    const vms = q.data.map((r) => withPlexImgs(r, imgKey))
    return grouped ? groupPlexSeasons(vms) : vms
  }, [grouped, q.data, imgKey])
  return { ...q, data }
}

/** Music: artists played lately and albums added lately. */
export function useMusicRecent(): Live<{ played: MediaVM[]; added: MediaVM[] }> {
  const q = useLive('musicRecent', async () => {
    const r = await fetchMusicRecent()
    return {
      played: r.played.map((a): MediaRow => ({ key: a.ratingKey, title: a.title, subtitle: a.genres[0] ?? 'artist', thumb: a.thumb })),
      added: r.added.map((a): MediaRow => ({ key: a.ratingKey, title: a.title, subtitle: a.artist, thumb: a.thumb })),
    }
  }, 120_000, {
    revive: (c) => {
      if (!isObj(c)) return undefined
      const played = reviveRows(c.played, toMediaRow)
      const added = reviveRows(c.added, toMediaRow)
      return played && added ? { played, added } : undefined
    },
  })
  const imgKey = useImgKey()
  const data = useMemo(() => {
    if (!q.data) return undefined
    const vm = (r: MediaRow): MediaVM => ({ ...r, img: musicArtUrl(imgKey, r.thumb, 300) })
    return { played: q.data.played.map(vm), added: q.data.added.map(vm) }
  }, [q.data, imgKey])
  return { ...q, data }
}

// ---------- daily tracker ----------

export type TrackerVM = {
  today: string
  streak: number
  items: { id: 'supplements' | 'exercise' | 'sf'; label: string; taken: boolean; takenAt: string | null; yesterday: boolean }[]
}

const TRACKERS = [
  { id: 'supplements', label: 'Supplements' },
  { id: 'exercise', label: 'Exercise' },
  { id: 'sf', label: 'SF' },
] as const

/** Today's three ticks and the all-three streak, for the first paint. Home ticks through src/lib's useDailyTracker. */
export function useTracker(): Live<TrackerVM> {
  return useLive('tracker', async (): Promise<TrackerVM> => {
    const today = supplementDateKey()
    const [windows, streak] = await Promise.all([
      Promise.all(TRACKERS.map((t) => fetchTrackerWindow(t.id, today, today))),
      fetchDailyStreak(today),
    ])
    return {
      today,
      streak: streak.streak,
      items: TRACKERS.map((t, i) => {
        const days = windows[i].days
        const day = days.find((d) => d.date === today)
        return { id: t.id, label: t.label, taken: !!day?.taken, takenAt: day?.takenAt ?? null, yesterday: !!days[0]?.taken }
      }),
    }
  }, 60_000)
}

// ---------- tasks (the dashboard's glance; the page itself is Tasks.tsx's own query) ----------

/** Every open task with its project and due date (lib/tasksApi.ts). */
export function useOpenTasks(): Live<TasksPage> {
  return useLive('tasks-open', () => fetchTasks('open'), 60_000)
}

// ---------- inbox (the strip's count; the list itself is Inbox.tsx's own query) ----------

/** Unread items, and how many of them are alerts. Only counts, so it is safe in the persisted cache. */
export function useInboxCount(): Live<InboxCount> {
  return useLive('inbox-count', fetchInboxCount, 20_000)
}

// ---------- calendar ----------

export type EventVM = { id: string; title: string; start: number; end: number; allDay: boolean; location: string; color: string; source: string }

const toEvent = (e: CalendarEvent): EventVM => ({
  id: e.uid + e.start,
  title: e.summary,
  start: Date.parse(e.start),
  end: Date.parse(e.end),
  allDay: e.allDay,
  location: e.location,
  color: e.color,
  source: e.sourceLabel,
})

const calHidden = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem('valkyrie-cal-hidden') || '[]') as string[]) } catch { return new Set() }
}

/** Events from today 00:00 for `days` days, by start. The API takes ~2.5 s, so the cache matters. */
export function useCalendar(days = 7): Live<EventVM[]> {
  return useLive(`calendar${days}`, async () => {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    const to = new Date(from)
    to.setDate(to.getDate() + days)
    const hidden = calHidden()
    const r = await fetchCalendarEvents(from.getTime(), to.getTime())
    return r.events
      .filter((e) => !hidden.has(e.sourceId))
      .map(toEvent)
      .sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay))
  }, 5 * 60_000)
}

// ---------- projects ----------

export type ProjectVM = { id: string; name: string; area: string; status: string; summary: string; nextAction: string; sessions: number; updated: number }

export function useProjects(): Live<ProjectVM[]> {
  return useLive('projects', async () => (await fetchProjList()).map((p): ProjectVM => ({
    id: p.id,
    name: p.name,
    area: String(p.area),
    status: String(p.status),
    summary: p.summary,
    nextAction: p.nextAction,
    sessions: p.sessionIds.length,
    updated: Date.parse(p.updatedAt),
  })).sort((a, b) => b.updated - a.updated), 60_000)
}

// ---------- launch targets (quick start) ----------

export type TargetVM = { key: string; label: string; phone: boolean; project: boolean; group: string | null }

// src/lib's fetchLaunchTargets turns every failure into [], which painted (and
// cached) "no quick start" whenever thor was slow. Read the route directly so a
// failure stays a failure and the last good list stays on screen.
export function useLaunchTargets(): Live<TargetVM[]> {
  return useLive('targets', async () => {
    const d = (await api.get<{ targets?: unknown }>('/hosts/thor/launch-targets')).data
    if (!Array.isArray(d.targets)) throw new Error('launch targets: bad response')
    return (d.targets as Record<string, unknown>[])
      .filter((t) => typeof t.key === 'string' && t.exists !== false)
      .map((t): TargetVM => {
        const key = String(t.key)
        const label = typeof t.label === 'string' ? t.label : key
        return { key, label: shortName({ key, label } as LaunchTarget), phone: t.phone === true, project: t.project === true, group: typeof t.group === 'string' ? t.group : null }
      })
  }, 5 * 60_000, { revive: (d) => (Array.isArray(d) ? (d as Partial<TargetVM>[]).map((x) => ({ group: null, ...x }) as TargetVM) : undefined) })
}

// ---------- Thor RGB ----------

export type RgbVM = {
  /** false only when the backend has no RGB route at all (404/501) */
  installed: boolean
  state: 'lit' | 'dark' | 'unknown'
  /** OpenRGB server up / the storm effect streaming */
  openrgb: boolean
  storm: boolean
  /** ms epoch of the last Relight / Dark run, and whether it succeeded (exit 0) */
  relightAt: number | null
  relightOk: boolean | null
  darkAt: number | null
  darkOk: boolean | null
}

const RGB_NONE: RgbVM = { installed: false, state: 'unknown', openrgb: false, storm: false, relightAt: null, relightOk: null, darkAt: null, darkOk: null }

// src/lib's fetchThorRgb maps a 502 (thor asleep or not answering) to "not
// installed". Here only 404/501 mean that; anything else throws, so the screen
// can say "thor is not answering" over the last good state.
export function useThorRgb(): Live<RgbVM> {
  return useLive('thorRgb', async (): Promise<RgbVM> => {
    let p: Record<string, unknown>
    try {
      p = ((await api.get<unknown>('/hosts/thor/rgb')).data ?? {}) as Record<string, unknown>
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status
      if (status === 404 || status === 501) return RGB_NONE
      throw e
    }
    const task = (k: 'relight' | 'dark') => ((p.tasks as Record<string, Record<string, unknown>> | undefined)?.[k] ?? {})
    const at = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)
    const ok = (v: unknown) => (typeof v === 'number' ? v === 0 : null)
    return {
      installed: true,
      state: p.state === 'lit' || p.state === 'dark' ? p.state : 'unknown',
      openrgb: p.openrgb === true,
      storm: p.storm === true,
      relightAt: at(task('relight').lastRun),
      relightOk: ok(task('relight').lastResult),
      darkAt: at(task('dark').lastRun),
      darkOk: ok(task('dark').lastResult),
    }
  }, 30_000, {
    // an old cache said "not installed" whenever thor timed out: drop it
    revive: (d) => (d && typeof d === 'object' && (d as RgbVM).installed !== false ? ({ ...RGB_NONE, installed: true, ...(d as Partial<RgbVM>) }) as RgbVM : undefined),
  })
}

// ---------- media requests and downloads ----------

export type RequestVM = {
  at: number; kind: string; title: string; status: string; tone: 'done' | 'active' | 'stuck' | 'waiting' | null; progress: number | null
  /** release year from the request, null when it has none */
  year: number | null
}
export type DownloadVM = { kind: string; title: string; status: string; progress: number; timeleft: string | null; stuck: boolean }

export function useMediaQueue(): Live<{ requests: RequestVM[]; downloads: DownloadVM[] }> {
  return useLive('mediaQueue', async () => {
    const [requests, downloads] = await Promise.all([fetchMediaRequests(), fetchMediaDownloads()])
    return {
      requests: requests
        .filter((r) => r.kind !== 'message')
        .map((r): RequestVM => ({
          at: Date.parse(r.at),
          kind: r.kind,
          title: r.title ? (r.artist ? `${r.artist} · ${r.title}` : r.title) : '',
          status: r.status ?? r.journalStatus ?? '',
          tone: r.tone ?? null,
          progress: r.progress ?? null,
          year: r.year ?? null,
        }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 30),
      downloads: downloads.map((d): DownloadVM => ({ kind: d.kind, title: d.title, status: d.status, progress: d.progress, timeleft: d.timeleft, stuck: !!d.stuck })),
    }
  }, 30_000, { revive: reviveQueue })
}

const reviveQueue = (d: unknown): { requests: RequestVM[]; downloads: DownloadVM[] } | undefined => {
  const q = d as { requests?: (Omit<RequestVM, 'year'> & { year?: number | null })[]; downloads?: DownloadVM[] } | null
  if (!q || !Array.isArray(q.requests) || !Array.isArray(q.downloads)) return undefined
  return { requests: q.requests.map((r) => ({ ...r, year: r.year ?? null })), downloads: q.downloads }
}

// ---------- API latency (for the Settings speed readout) ----------

export type Latency = {
  path: string
  /** ms of the last finished request (success or failure); 0 while the first one is pending */
  ms: number
  bytes: number
  /** ms epoch the last request finished (or, while pending, started) */
  at: number
  /** 'pending' = the first request for this path has not finished; 'failed' = the last one failed */
  phase?: 'pending' | 'done' | 'failed'
  /** HTTP status of the last finished request; 0 = no reply (network error, timeout) */
  status?: number
  /** ms epoch the request now in flight started; absent when none is in flight */
  inflightSince?: number
}
const latencies = new Map<string, Latency>()
const inflight = new Map<string, number>()
const LAT_EVENT = 'v2-latency'
const emitLatency = () => window.dispatchEvent(new Event(LAT_EVENT))

// Every request is timed here: the axios instance is shared, so one
// interceptor pair sees every call any hook makes, failures included. A hot
// reload of this file ejects the pair (see the end of this block) instead of
// stacking a second one.
type Timed = { _t0?: number; url?: string }
const pathOf = (c?: Timed) => String(c?.url ?? '').split('?')[0]
const leaveInflight = (path: string): number => {
  const left = Math.max(0, (inflight.get(path) ?? 1) - 1)
  if (left) inflight.set(path, left)
  else inflight.delete(path)
  return left
}
// The interceptor's own clock includes time the request and its response
// handler waited on a busy main thread (3-10x the real cost for fast paths on
// a cold boot). Resource Timing has the browser's network-side numbers, so use
// its newest entry for this URL when there is one.
const networkMs = (c: Timed, t0: number): number => {
  const fallback = Math.round(performance.now() - t0)
  try {
    const url = new URL(api.getUri(c as Parameters<typeof api.getUri>[0]), window.location.href).href
    const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[]
    const e = entries[entries.length - 1]
    if (e && e.startTime >= t0 - 50 && e.responseEnd > 0) return Math.round(e.responseEnd - (e.requestStart || e.startTime))
  } catch { /* no timing entry: keep the fallback */ }
  return fallback
}

const settleLatency = (c: Timed | undefined, status: number, bytes: number, ok: boolean) => {
  const t0 = c?._t0
  if (t0 == null || !c) return
  const path = pathOf(c)
  const left = leaveInflight(path)
  const prev = latencies.get(path)
  latencies.set(path, {
    path,
    ms: networkMs(c, t0),
    bytes: ok ? bytes : prev?.bytes ?? 0,
    at: Date.now(),
    phase: ok ? 'done' : 'failed',
    status,
    inflightSince: left ? prev?.inflightSince : undefined,
  })
  emitLatency()
}
const latencyIds = [
  api.interceptors.request.use((config) => {
    const c = config as Timed
    c._t0 = performance.now()
    const path = pathOf(c)
    inflight.set(path, (inflight.get(path) ?? 0) + 1)
    const prev = latencies.get(path)
    const now = Date.now()
    latencies.set(path, prev
      ? { ...prev, inflightSince: prev.inflightSince ?? now }
      : { path, ms: 0, bytes: 0, at: now, phase: 'pending', inflightSince: now })
    emitLatency()
    return config
  }),
  api.interceptors.response.use(
    (res) => {
      const bytes = Number(res.headers?.['content-length'] ?? 0) || JSON.stringify(res.data ?? '').length
      settleLatency(res.config as Timed, res.status, bytes, true)
      return res
    },
    (err: { config?: Timed; response?: { status?: number }; code?: string }) => {
      if (err?.code === 'ERR_CANCELED') {
        // a canceled request is not a failure: it just stops counting
        const path = pathOf(err.config)
        if (!leaveInflight(path)) {
          const prev = latencies.get(path)
          if (prev?.phase === 'pending') latencies.delete(path)
          else if (prev) latencies.set(path, { ...prev, inflightSince: undefined })
        }
        emitLatency()
      } else {
        settleLatency(err?.config, err?.response?.status ?? 0, 0, false)
      }
      return Promise.reject(err)
    },
  ),
] as const
import.meta.hot?.dispose(() => {
  api.interceptors.request.eject(latencyIds[0])
  api.interceptors.response.eject(latencyIds[1])
})

const latRank = (l: Latency) => (l.phase === 'pending' ? 0 : l.phase === 'failed' ? 1 : 2)

/**
 * Last measured latency per API path: failed first, then slowest first.
 * `pending: true` also lists paths whose first request has not finished (at
 * the top, ms 0, phase 'pending'); by default only finished paths show.
 */
export function useLatencies(opts?: { pending?: boolean }): Latency[] {
  const withPending = !!opts?.pending
  const read = () => [...latencies.values()]
    .filter((l) => withPending || l.phase !== 'pending')
    .sort((a, b) => latRank(a) - latRank(b) || b.ms - a.ms)
  const [list, setList] = useState<Latency[]>(read)
  useEffect(() => {
    const sync = () => setList(read())
    window.addEventListener(LAT_EVENT, sync)
    sync()
    return () => window.removeEventListener(LAT_EVENT, sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withPending])
  return list
}

/** Marks first data now if nothing has yet (useLive marks it itself; use this for data from elsewhere). */
export function markFirstData(): void {
  if (firstData == null) firstData = Math.round(performance.now())
}
/** ms from navigation start to the first frame that showed real data (cached or fetched). */
export const firstDataMs = (): number | null => firstData
/** ms from navigation start to the first frame that showed data fetched in this page load. */
export const firstLiveMs = (): number | null => firstLive
