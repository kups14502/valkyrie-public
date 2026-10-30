import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { useIsFetching, useQueryClient, type Mutation, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { playerActions, usePlayerNow, useShell, type ScreenProps } from '../kit/shell'
import { Bar, Glyph, Panel, Press, cx, dismissToast, toast } from '../kit/ui'
import {
  ago, equityAge, fullest, nyDayKey, onAccount, tradeSession, useCalendar, useHosts, useLaunchTargets, useLights, useLive, useMediaQueue, useOpenTasks, usePlexRecentRich, useSessions, useSwitchStatus, useTick,
  useTrade, useTracker, useUsage,
  type DownloadVM, type EventVM, type HostVM, type Live, type PlexRichVM, type SessionVM, type TargetVM, type TradeSession, type TradeVM,
} from '../kit/data'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { usePalette, useSetting } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import { HOST_POSE, Hero, MODEL_ONLY_IDS, MODEL_ONLY_LABEL, hostModel, useHeat, type HostModelId } from '../kit/hero'
import { thisDeviceId } from '../kit/thisDevice'
import { EquityChart } from '../kit/three/EquityChart'
import { apiErrorText, localHostname, type LightState, type LightUpdate } from '../../lib/api'
import { isTauri } from '../../lib/auth'
import { useProfile } from '../../lib/deviceMode'
import { dateLabel, fetchTrackerSkips, parseDateKey, shiftDateKey } from '../../lib/supplementsApi'
import { useDailyTracker, useTrackerDays, workoutFor } from '../../lib/dailyTracker'
import { PRESETS, brightnessFromPct, lightColor, pctFromBrightness, presetSwatchStyle, useLightsControl, type LightPatch } from '../../lib/lights'
import { useQuickSessions } from '../../lib/quickSessions'
import { UpIcon, UploadRows } from '../kit/upload'
import { UP_ICONS, addUploads, uploadProgress, useUploadPicker, useUploads } from '../kit/uploads'
import { clockOf, dueLabel, dueState } from '../../lib/taskDue'
import { taskKey } from '../../lib/tasksApi'
import { CalendarSheet, type CalendarOpen } from './Calendar'
import './dashboard.css'

// Dashboard: one page with everything Valkyrie does, in the order Brendon
// uses it. Phone (one column, in this order): the trade ticker line (the
// newest session, bot online, 7 days), quick start, upload (pictures to thor,
// for the session just started), lights (one bar for all of them, every bulb,
// a tap switches one, the presets, a plate that switches them all), the daily tracker (day stepping,
// the other day's line, hold Exercise to skip), the calendar (today first,
// then the next six days; a tap opens the calendar sheet), AI (live and asking
// sessions, usage meters), media (playing or newest added, downloads) and
// every host (CPU / Mem / Disk, battery where the host has one), led by this
// device: the 3D model of the phone or iPad in hand with its battery and storage.
// From 600 px: two columns, the ticker becomes the head of a Trade box (equity,
// the 3D equity chart) and the presets get their names.
// Desktop: three columns that reach the bottom of the page: [quick start,
// upload, tracker, media with the newest backdrop and a poster grid] [trade,
// AI, calendar] [lights, this device, hosts]. The equity chart, this device's
// model and the poster grid take the height that is left, so no box stretches empty.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const bi = (i: number): Vars => ({ '--i': i })

// the shell's screen ids (src/v2/App.tsx)
const AI = 'ai'
const LIGHTS = 'lights'
const MEDIA = 'media'
const SYSTEM = 'system'

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const sync = () => setM(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return m
}

/** the UI zoom the desktop app applies to <html> (1 in a browser that never set one) */
const uiZoom = () => {
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(z) && z > 0 ? z : 1
}

/**
 * The dashboard's own width in layout px. The desktop app zooms <html>, which
 * media queries never see (a 1920 px monitor at zoom 1.2 has 1600 px of
 * layout), so the column count comes from the element. A hidden page (width
 * 0) keeps its last width.
 */
function useBoxWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 390 : window.innerWidth / uiZoom() - 40))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const set = () => {
      const cw = el.clientWidth
      if (cw > 0) setW(cw)
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

// column steps in layout px: two columns from a small tablet or a landscape
// phone, three from an iPad in landscape or a desktop window; past XL the
// three columns grow (a 2560 px monitor), centered, never stretched to the edges
const TWO_COLS = 600
const THREE_COLS = 1140
const XL = 1800

/**
 * The height the desktop layout fills, in layout px: the page's scroll box
 * minus its own padding (the lights button's clearance). The layout is
 * border-box, so its own padding sits inside this. 0 while off or not
 * measured yet. Content taller than this scrolls as before: the elastic
 * parts only shrink to their minimum.
 */
function useFillHeight(ref: RefObject<HTMLElement | null>, on: boolean): number {
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    if (!on) return
    const el = ref.current
    const page = el?.closest('.vl-page') as HTMLElement | null
    if (!el || !page) return
    const px = (v: string) => parseFloat(v) || 0
    const set = () => {
      if (page.clientHeight <= 0) return
      const ps = getComputedStyle(page)
      const inner = page.clientHeight - px(ps.paddingTop) - px(ps.paddingBottom)
      setH((cur) => (Math.abs(cur - inner) < 1 ? cur : Math.max(0, Math.floor(inner))))
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(page)
    return () => ro.disconnect()
  }, [ref, on])
  return on ? h : 0
}

/**
 * Width and height of an element in layout px, from a ResizeObserver (null
 * until measured). Layout size, not getBoundingClientRect: the build-in tilt
 * and the app's UI zoom would skew that.
 */
function useSize(ref: RefObject<HTMLElement | null>, on = true): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const set = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0) return
      setSize((cur) => (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1 ? cur : { w, h }))
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, on])
  return size
}

/**
 * "5m" when the data on screen is not current: the newest fetch failed (data
 * is the last good result), or a cold paint from a cache older than `maxMs`
 * while the first fetch is still out. null when the data is current.
 */
function oldAge(l: Live<unknown>, now: number, maxMs = 120_000): string | null {
  if (l.data === undefined) return null
  // the tick clock can trail a fetch that just landed; a failure right after a good read is still current
  const t = Math.max(now, Date.now())
  const age = t - l.updatedAt
  if ((l.failed && age >= 60_000) || (l.fromCache && age > maxMs)) return ago(l.updatedAt, t)
  return null
}

export default function Dashboard({ active }: ScreenProps) {
  const { setPose } = useShell()
  useEffect(() => {
    if (active) setPose('home')
  }, [active, setPose])

  const box = useRef<HTMLDivElement>(null)
  const width = useBoxWidth(box)
  const cols = width >= THREE_COLS ? 3 : width >= TWO_COLS ? 2 : 1
  const wide = cols === 3
  const xl = wide && width >= XL
  const fillH = useFillHeight(box, wide)
  const fill = fillH > 0
  // the calendar sheet (src/v2/screens/Calendar.tsx): opened from the Calendar block, closed when the tab is left
  const [cal, setCal] = useState<CalendarOpen | null>(null)
  const calSeed = useCalendar(7).data
  useEffect(() => {
    if (!active) setCal(null)
  }, [active])
  const device = useThisDevice()

  // Phone: the column wrappers dissolve, so the blocks read top to bottom in
  // the order above (Upload right under Quick Start, Lights right under it).
  // Two columns: the doing column left; trade, AI, media and the hosts right.
  // Three: see the header; each column has one elastic part, so the three end
  // at the bottom of the page together.
  return (
    <div className="hm" ref={box}>
      <div
        className="vl-screen hm-layout"
        data-cols={cols}
        data-xl={xl || undefined}
        data-fill={fill || undefined}
        style={fill ? ({ '--hm-h': `${fillH}px` } as Vars) : undefined}
      >
        {cols === 1 ? (
          <>
            <TradeTicker active={active} i={0} />
            <div className="hm-col hm-a">
              <QuickStart />
              <UploadBlock wide={false} />
              <LightsBox i={3} variant="chips" />
              <Tracker />
              <Calendar onOpen={setCal} />
            </div>
            <div className="hm-col hm-b">
              <AiBlock wide={false} i={9} />
              <MediaBox i={10} />
              <Systems i={11} device={device} active={active} />
            </div>
          </>
        ) : cols === 2 ? (
          <>
            <div className="hm-col hm-a">
              <QuickStart />
              <UploadBlock wide={false} />
              <LightsBox i={3} variant="rows" />
              <Tracker />
              <Calendar onOpen={setCal} />
            </div>
            <div className="hm-col hm-b">
              <TradeBox active={active} i={1} />
              <AiBlock wide={false} i={9} />
              <MediaBox i={10} />
              <Systems i={11} device={device} active={active} />
            </div>
          </>
        ) : (
          <>
            <div className="hm-col hm-a">
              <QuickStart />
              <UploadBlock wide />
              <Tracker />
              <MediaBox i={10} banner fill={fill} />
            </div>
            <div className="hm-col hm-b">
              <TradeBox active={active} i={1} fill={fill} />
              <AiBlock wide i={8} />
              <Calendar onOpen={setCal} />
            </div>
            <div className="hm-col hm-c">
              <LightsBox i={3} variant="rows" />
              <ThisDevice id={device} active={active} i={4} fill={fill} />
              <Systems i={11} />
            </div>
          </>
        )}
      </div>
      <CalendarSheet open={cal} onClose={() => setCal(null)} seed={calSeed} />
    </div>
  )
}

// ---------- small pieces ----------

/** A header or row icon: lit = full color with the glow (on, live, asking); otherwise dim and flat. */
function HIcon({ name, lit, size = 14, tone, className }: { name: IconName; lit?: boolean; size?: number; tone?: IconTone; className?: string }) {
  return <Icon name={name} size={size} tone={tone ?? (lit ? 'fg' : 'dim')} glow={!!lit} className={cx('hm-ic', className)} />
}

/** Section title on the floor: icon and label left, value right, optional control between. */
function Head({ label, icon, lit, value, i, mid }: { label: ReactNode; icon: IconName; lit?: boolean; value?: ReactNode; i: number; mid?: ReactNode }) {
  return (
    <div className="hm-head vl-build" style={bi(i)} data-mid={mid ? '' : undefined}>
      <span className="hm-head-label" data-lit={lit || undefined}><HIcon name={icon} lit={lit} />{label}</span>
      {mid}
      {value !== undefined && <span className="hm-head-value">{value}</span>}
    </div>
  )
}

function Chevron({ dir = 'right' }: { dir?: 'left' | 'right' }) {
  return (
    <svg className="hm-chev" width="7" height="10" viewBox="0 0 7 10" aria-hidden>
      <path d={dir === 'left' ? 'M5.5 1 1.5 5l4 4' : 'M1.5 1 5.5 5l-4 4'} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** " · 5m old" in dim, or nothing when the data is current. */
function Old({ age }: { age: string | null }) {
  return age ? <span className="hm-old-tag"> · {age} old</span> : null
}

// ---------- time helpers ----------

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const addDays = (ms: number, n: number) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime() }
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const weekday = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })
/** "Sat 18" */
const dayTag = (ms: number) => `${weekday(ms)} ${new Date(ms).getDate()}`

function until(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h >= 24) return `in ${Math.round(m / 1440)}d`
  const r = m % 60
  return r && h < 6 ? `in ${h}h ${r}m` : `in ${h}h`
}

const touches = (e: EventVM, from: number, to: number) => e.start < to && e.end > from
const NBSP = String.fromCharCode(160)
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase())
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ---------- writes ----------

/** Why a write failed, in the server's words when it sent any. */
const why = (e: unknown) => apiErrorText(e, e instanceof Error && e.message ? e.message : 'no answer')

/**
 * Runs `fire`, which starts one react-query mutation through a src/lib hook
 * (its action returns nothing), and settles with that mutation: resolves on
 * success, rejects with its error. The hook keeps its own optimistic write and
 * rollback, which have run by the time this settles; the caller only learns
 * how it ended, for the toast and the pending state.
 */
function settled(qc: QueryClient, fire: () => void): Promise<void> {
  const cache = qc.getMutationCache()
  let found: Mutation | undefined
  // the cache announces a new mutation synchronously inside mutate()
  const stop = cache.subscribe((e) => { if (e.type === 'added' && !found) found = e.mutation })
  try { fire() } finally { stop() }
  const m = found
  if (!m) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (m.state.status === 'success') { unsub(); resolve() }
      else if (m.state.status === 'error') { unsub(); reject(m.state.error) }
    }
    const unsub = cache.subscribe((e) => { if (e.mutation === m) check() })
    check()
  })
}

// ---------- trade ticker: one line on top, three facts ----------

const NY = 'America/New_York'
const nyWeekday = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' })

/** "$12.34", "$123", "$1,234" (cents only under $100, so the line fits a 360 px phone) */
const money = (v: number) => {
  const a = Math.abs(v)
  return a >= 100 ? `$${Math.round(a).toLocaleString('en-US')}` : `$${a.toFixed(2)}`
}
const signedMoney = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${money(v)}`
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`

/** the session's day, said only when it is not today: "Fri", or "Oct 9" when it is over a week back */
function sessionDay(s: TradeSession, now: number): string | null {
  if (s.day === nyDayKey(now)) return null
  return now - s.at < 6 * 86_400_000 ? nyWeekday.format(s.at) : nyDate.format(s.at)
}

/**
 * The trade bot in one line: whether it is up or down money on the newest
 * trading session (arrow and amount; the day when it is not today), whether
 * the bot is online (up and not stale), and the 7-day change. A tap opens
 * System > Trades. Reads every 60 s while the dashboard is the visible tab.
 * `boxed`: the same line as the head of the Trade box (two columns and up).
 */
function TradeTicker({ active, i, boxed }: { active: boolean; i?: number; boxed?: boolean }) {
  const { go } = useShell()
  const trade = useTrade(active)
  const now = useTick(30_000)
  const t = trade.data
  // the data on screen is the last good read, not current: dim, and the online word gives way to its age
  const age = oldAge(trade, now, 10 * 60_000)
  const s = t ? tradeSession(t, now) : null
  const online = !!t && t.up && !t.stale
  const said: string[] = []

  let cells: ReactNode = <span className="hm-tk-d">{trade.failed ? 'Trade bot not answering' : 'Reading the trade bot'}</span>
  if (t) {
    const day = s ? sessionDay(s, now) : null
    const dir = !s || s.flat || s.change === 0 ? 'flat' : s.change > 0 ? 'up' : 'down'
    if (s) said.push(`${day ?? 'today'} ${dir === 'flat' ? 'flat' : `${dir} ${money(s.change)}`}${s.flat ? ', not live' : ''}`)
    else said.push('no session yet')
    said.push(age ? `bot last read ${age} ago, ${online ? 'online' : 'offline'} then` : `bot ${online ? 'online' : 'offline'}`)
    const wk = t.changeUsd
    const wkDays = t.windowDays ?? 7
    const wkDir = wk == null || wk === 0 ? 'flat' : wk > 0 ? 'up' : 'down'
    if (wk != null) said.push(`${wkDays} day ${wk < 0 ? 'down' : 'up'} ${money(wk)}`)
    cells = (
      <>
        <span
          className="hm-tk-cell"
          data-dir={dir}
          data-flat={s?.flat || undefined}
          title={s?.flat ? 'Not live: the bot repeated its day-open figure all session' : s?.running ? 'Today so far, to the live equity read' : 'The newest trading session, close to close'}
        >
          {/* a loss is --loss, never the yellow (dashboard.css): the arrow and the minus carry the direction */}
          {dir !== 'flat' && <Icon name={dir === 'up' ? 'trades' : 'down'} size={13} tone={dir === 'up' ? 'fg' : 'acc2'} className={cx('hm-ic', dir === 'down' && 'hm-loss')} />}
          <b className="hm-tk-v">{s ? signedMoney(s.flat ? 0 : s.change) : '--'}</b>
          {day && <span className="hm-tk-k">{day}</span>}
        </span>
        <span className="hm-tk-cell hm-tk-bot" data-on={(online && !age) || undefined} data-off={(!online && !age) || undefined} title={t.upDetail || undefined}>
          <i className="hm-tk-dot" aria-hidden />
          <span className="hm-tk-word">{age ? `${age} old` : online ? 'Online' : 'Offline'}</span>
        </span>
        <span className="hm-tk-cell" data-dir={wkDir} title={`Deposit-adjusted trading change over the last ${wkDays} days`}>
          <span className="hm-tk-k">{wkDays}D</span>
          {/* the arrow carries the direction, as on the day; a four-figure week needs its room on a phone */}
          {wkDir !== 'flat' && Math.abs(wk ?? 0) < 1000 && <Icon name={wkDir === 'up' ? 'trades' : 'down'} size={13} tone={wkDir === 'up' ? 'fg' : 'acc2'} className={cx('hm-ic hm-tk-wkic', wkDir === 'down' && 'hm-loss')} />}
          <b className="hm-tk-v">{wk != null ? signedMoney(wk) : '--'}</b>
          {t.changePct != null && <span className="hm-tk-pct">{signed(t.changePct)}%</span>}
        </span>
      </>
    )
  }

  return (
    <Press
      className={cx('hm-tk', boxed ? 'hm-tk-boxed' : 'vl-build', age && 'hm-old')}
      style={!boxed && i !== undefined ? bi(i) : undefined}
      onPress={() => go(SYSTEM, 'trades')}
      aria-label={`Trade bot${t ? `: ${said.join(', ')}` : trade.failed ? ', not answering' : ''}. Open Trades`}
    >
      <span className="hm-tk-label">
        <HIcon name="trades" lit={online && !age} tone={t && !online ? 'acc2' : undefined} />
        <span className="hm-tk-name">Trade</span>
      </span>
      <span className="hm-tk-cells" aria-hidden>{cells}</span>
      <Chevron />
    </Press>
  )
}

// ---------- trade box: the ticker as its head, the equity, the 3D chart ----------

const NY_HM = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
/** minutes since midnight, New York */
const nyMinutes = (ms: number) => {
  const p = NY_HM.formatToParts(ms)
  const n = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0)
  return (n('hour') % 24) * 60 + n('minute')
}
/** "$7,554.15" */
const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type EquityChartVM = {
  points: { x: number; v: number }[]
  days: { x0: number; x1: number; label: string; long: string }[]
  ticks: { v: number; label: string }[]
  lo: number
  hi: number
  last: number
  /** the index the trailing run of one repeated figure starts at, null when the line moves to the end */
  flatFrom: number | null
  aria: string
}

/**
 * The equity history as System > Trades draws it: one equal slot per trading
 * day (market hours only, no nights or weekends), the live read as the newest
 * point while the market is open and the read is newer than the history, the
 * value range at least 2% of equity tall (a small move draws small), and the
 * trailing run of one repeated figure (the bot repeating its day-open total).
 */
function useEquityChart(t: TradeVM | undefined, fetchedAt: number): EquityChartVM | null {
  return useMemo(() => {
    if (!t) return null
    let pts = t.points
    if (t.marketOpen && t.equity != null) {
      const age = equityAge(t, fetchedAt)
      const last = pts[pts.length - 1]
      if (age.kind === 'live' && age.at != null && (!last || age.at > last.t)) pts = [...pts, { t: age.at, v: t.equity }]
    }
    if (pts.length < 2) return null
    let flatFrom: number | null = null
    if (pts.length >= 3) {
      const lastV = pts[pts.length - 1].v
      let k = pts.length - 1
      while (k > 0 && pts[k - 1].v === lastV) k--
      flatFrom = k <= pts.length - 2 ? k : null
    }
    const vals = pts.map((x) => x.v)
    const min = Math.min(...vals), max = Math.max(...vals)
    const mid = (min + max) / 2
    const half = Math.max(((max - min) / 2) * 1.15, Math.abs(t.equity ?? mid) * 0.01, 0.5)
    const ticks = max > min ? [{ v: max, label: usd(max) }, { v: min, label: usd(min) }] : [{ v: max, label: usd(max) }]
    const keys = pts.map((x) => nyDayKey(x.t))
    const mins = pts.map((x) => nyMinutes(x.t))
    const open = Math.floor(Math.min(9.5 * 60, ...mins) / 30) * 30
    const close = Math.ceil(Math.max(16 * 60, ...mins) / 30) * 30
    const order = new Map<string, number>()
    keys.forEach((k) => { if (!order.has(k)) order.set(k, order.size) })
    const nd = order.size
    const points = pts.map((x, k) => ({ x: (order.get(keys[k])! + Math.max(0, Math.min(1, (mins[k] - open) / (close - open)))) / nd, v: x.v }))
    const days = [...order.keys()].map((key, d) => {
      const at = pts[keys.indexOf(key)].t
      return { x0: d / nd, x1: (d + 1) / nd, label: nyWeekday.format(at), long: `${nyWeekday.format(at)} ${nyDate.format(at)}` }
    })
    const last = vals[vals.length - 1]
    return {
      points, days, ticks, lo: mid - half, hi: mid + half, last, flatFrom,
      aria: `Equity from ${usd(vals[0])} to ${usd(last)}, high ${usd(max)}, low ${usd(min)}, over ${nd} trading day${nd === 1 ? '' : 's'}`,
    }
  }, [t, fetchedAt])
}

/**
 * The trade bot's own box: the ticker line as its head (the day's move,
 * online, 7 days; opens Trades), the equity big with what it really is (a live
 * broker read and its age, an older read, or the day-open figure, never
 * dressed up as live), the market and the last trade, and the 3D equity chart
 * (drag turns it). `fill`: the chart takes the height the column has left.
 */
function TradeBox({ active, i, fill }: { active: boolean; i: number; fill?: boolean }) {
  const trade = useTrade(active)
  const palette = usePalette()
  const reduced = useReducedMotion()
  const now = useTick(30_000)
  const t = trade.data
  const chart = useEquityChart(t, trade.updatedAt)
  const readAge = oldAge(trade, now, 10 * 60_000)
  const online = !!t && t.up && !t.stale
  const age = t ? equityAge(t, now) : null
  const kind = age?.kind ?? 'unknown'
  const eq = t?.equity
  const dollars = eq != null ? `${eq < 0 ? '-' : ''}$${Math.trunc(Math.abs(eq)).toLocaleString('en-US')}` : null
  const cents = eq != null ? (Math.abs(eq) % 1).toFixed(2).slice(1) : ''
  const dayOpen = t?.equitySource === 'day_open'
  const flatNote = dayOpen && chart?.flatFrom != null
  const lastTrade = t?.lastTrade ? (/^(buy|sell)\s+(\S+)/i.exec(t.lastTrade)?.slice(1, 3).join(' ') ?? t.lastTrade) : null

  const what: ReactNode = kind === 'live'
    ? <><b>Live</b> · {age?.at != null ? `${ago(age.at, now)} ago` : 'just now'}</>
    : kind === 'read' ? <>Last read{age?.at != null ? ` ${ago(age.at, now)} ago` : ' at the broker'}</>
      : kind === 'day_open' ? <><HIcon name="alert" size={12} />Day-open figure, not live</>
        : 'Equity'

  return (
    <Panel className={cx('hm-glance hm-trade', fill && 'hm-grow')} i={i} dense lit={online && !readAge}>
      <TradeTicker active={active} boxed />
      <div className="hm-trade-top">
        <div className="hm-trade-main">
          <span className={cx('hm-trade-eq', (readAge || kind === 'day_open') && 'hm-old')}>
            {dollars != null ? <>{dollars}<small>{cents}</small></> : '--'}
          </span>
          <span className="hm-trade-what" data-kind={kind}>
            {what}
            {readAge && <span className="hm-old-tag"> · bot not answering, {readAge} old</span>}
          </span>
        </div>
        {t && (
          <span className="hm-trade-kv">
            <span className="hm-trade-k" data-on={t.marketOpen || undefined}>
              <HIcon name="clock" size={12} lit={t.marketOpen} />
              <span className="vl-ellipsis">{t.marketOpen ? 'Market open' : `Market closed${t.marketReason ? `, ${t.marketReason}` : ''}`}</span>
            </span>
            {lastTrade && (
              <span className="hm-trade-k" title={t.lastTrade ?? undefined}>
                <HIcon name="trades" size={12} />
                <span className="vl-ellipsis">{cap(lastTrade)}{t.lastTradeAt != null ? ` · ${nyWeekday.format(t.lastTradeAt)} ${nyDate.format(t.lastTradeAt)}` : ''}</span>
              </span>
            )}
          </span>
        )}
      </div>
      {chart ? (
        <div className="hm-trade-chart">
          <EquityChart
            points={chart.points}
            lo={chart.lo}
            hi={chart.hi}
            ticks={chart.ticks}
            days={chart.days}
            tailFrom={flatNote ? chart.flatFrom ?? undefined : undefined}
            lastLabel={usd(chart.last)}
            lastNote={flatNote ? 'not live' : undefined}
            ariaLabel={chart.aria}
            palette={palette}
            paused={!active}
            motion={reduced ? 'reduced' : 'full'}
            style={{ position: 'absolute', inset: 0 }}
          />
        </div>
      ) : (
        <p className="hm-quiet hm-g-quiet">{!t ? (trade.failed ? 'Trade bot not answering' : 'Reading the trade bot') : 'No equity history yet'}</p>
      )}
    </Panel>
  )
}

// ---------- daily tracker ----------

const TRACK_IDS = [
  { id: 'supplements', label: 'Supplements' },
  { id: 'exercise', label: 'Exercise' },
  { id: 'sf', label: 'SF' },
] as const

/** Before this hour a tick is usually for the day that just ended, so the tracker opens on it while it is open. */
const LATE_NIGHT_END = 4
/** How long a press on Exercise is held to skip the day. */
const HOLD_MS = 520

type TrackId = (typeof TRACK_IDS)[number]['id']
type TickState = { taken: boolean; at: number; known: boolean }
/** the streak before a tick went out, and whether today was complete then */
type StreakHold = { base: number; allBefore: boolean; settled: boolean }
type TrackerLib = Record<TrackId, ReturnType<typeof useTrackerDays>>

/** at: ms when ticked, -1 when ticked at an unknown time, 0 when not ticked */
function tickState(taken: boolean, takenAt: string | null): TickState {
  const at = taken && takenAt ? Date.parse(takenAt) : NaN
  return { taken, at: taken ? (Number.isNaN(at) ? -1 : at) : 0, known: true }
}

/**
 * A press held for HOLD_MS (touch or pen), or a right click (mouse): calls
 * `onHold`. `consume()` tells the tap that follows a hold to do nothing.
 */
function useHold(onHold: () => void, enabled: boolean) {
  const fire = useRef(onHold)
  fire.current = onHold
  const held = useRef(false)
  const [holding, setHolding] = useState(false)
  const lastPointer = useRef<string>('')
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    lastPointer.current = e.pointerType
    held.current = false
    if (!enabled || e.pointerType === 'mouse' || e.currentTarget.disabled) return
    const id = e.pointerId, x0 = e.clientX, y0 = e.clientY
    setHolding(true)
    const timer = window.setTimeout(() => {
      held.current = true
      stop()
      try { navigator.vibrate?.(12) } catch { /* no vibration */ }
      fire.current()
    }, HOLD_MS)
    const move = (ev: PointerEvent) => { if (ev.pointerId === id && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) stop() }
    const end = (ev: PointerEvent) => { if (ev.pointerId === id) stop() }
    function stop() {
      window.clearTimeout(timer)
      setHolding(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }
  const onContextMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    // the phone's own long-press menu never shows; a mouse's right click (or the menu key) is the hold
    e.preventDefault()
    if (enabled && (lastPointer.current === 'mouse' || lastPointer.current === '')) {
      held.current = false
      fire.current()
    }
  }
  /** true once, right after a hold fired: the tap that ends the hold is not a tick */
  const consume = () => {
    const was = held.current
    held.current = false
    return was
  }
  return { holding, consume, props: enabled ? { onPointerDown, onContextMenu } : { onContextMenu: (e: ReactMouseEvent) => e.preventDefault() } }
}

/** "Today", "Yesterday", "Tomorrow", "Fri 16" */
const dayName = (key: string, today: string) => cap(dateLabel(key, today))

/**
 * Supplements, Exercise and SF for one day under one streak. The head steps
 * the day (chevrons both ways; Back to today when away from it). Late at night,
 * while yesterday is still open, it opens on yesterday. A plate ticks the day
 * shown; the line under it ticks the other day (yesterday, or today when the
 * day shown is not today) without stepping. Holding Exercise skips its day
 * (the rotation waits a day); holding it again takes the skip back.
 */
function Tracker() {
  const qc = useQueryClient()
  // The persisted view model paints the last known ticks in the first frame.
  // The real tracker hooks (the classic tracker's, same cache) take over once
  // their reads land, and own the writes: optimistic tick, rollback on failure.
  const tracker = useTracker()
  const { today: todayKey, streak: liveStreak } = useDailyTracker()
  const yKey = shiftDateKey(todayKey, -1)
  const tmKey = shiftDateKey(todayKey, 1)
  // today's window (yesterday, today, tomorrow): every day near today reads and writes through it
  const near: TrackerLib = {
    supplements: useTrackerDays('supplements', todayKey, todayKey),
    exercise: useTrackerDays('exercise', todayKey, todayKey, true),
    sf: useTrackerDays('sf', todayKey, todayKey),
  }
  const cachedSkips = useLive('exerciseSkips', async () => (await fetchTrackerSkips('exercise')).skips, 5 * 60_000)
  const streakFetching = useIsFetching({ queryKey: ['daily', 'streak'] })
  const now = useTick(30_000)
  const t = tracker.data

  // What the server says for one tracker on one day: the window that holds the
  // day once it has landed, else the view model, which covers its own "today"
  // and the day before. A cache written before midnight covers our yesterday
  // only, so today reads as unknown until the fetch lands.
  const isNear = (key: string) => key === todayKey || key === yKey || key === tmKey
  const fromLib = (lib: TrackerLib, id: TrackId, key: string): TickState | null => {
    const d = lib[id].days?.find((x) => x.date === key)
    if (d) return tickState(d.taken, d.takenAt)
    const it = t?.items.find((x) => x.id === id)
    if (!t || !it) return null
    if (t.today === key) return tickState(it.taken, it.takenAt)
    if (shiftDateKey(t.today, -1) === key) return { taken: it.yesterday, at: it.yesterday ? -1 : 0, known: true }
    return null
  }

  // the day shown: the one stepped to, else today (yesterday late at night while it is open)
  const lateNight = new Date(now).getHours() < LATE_NIGHT_END
  const yOpen = TRACK_IDS.some((d) => fromLib(near, d.id, yKey)?.taken === false)
  const auto = lateNight && yOpen ? yKey : todayKey
  const [pinned, setPinned] = useState<string | null>(null)
  const key = pinned ?? auto
  const step = (n: number) => {
    const next = shiftDateKey(key, n)
    setPinned(next === auto ? null : next)
  }
  const backToToday = () => setPinned(auto === todayKey ? null : todayKey)
  // the shown day's own window, for a day away from today (the same query as `near` when it is today)
  const view: TrackerLib = {
    supplements: useTrackerDays('supplements', key, todayKey),
    exercise: useTrackerDays('exercise', key, todayKey, true),
    sf: useTrackerDays('sf', key, todayKey),
  }
  /** the hooks that read and write `day`: always the same ones for the same day, so a write and its read agree */
  const libFor = (day: string): TrackerLib => (isNear(day) ? near : view)
  const server = (id: TrackId, day: string) => fromLib(libFor(day), id, day)

  // A write on its way: shown at once (before the real window has landed the
  // hook has nothing to write into), and one per tracker until it settles.
  const [pending, setPending] = useState<Partial<Record<TrackId, { key: string; taken: boolean; at: number }>>>({})
  const inflight = useRef<Partial<Record<TrackId, Promise<boolean>>>>({})
  const state = (id: TrackId, day: string): TickState => {
    const p = pending[id]
    if (p?.key === day) return { taken: p.taken, at: p.at, known: true }
    return server(id, day) ?? { taken: false, at: 0, known: false }
  }

  // the line under each plate: yesterday while today is shown, else today
  const otherKey = key === todayKey ? yKey : todayKey
  const items = TRACK_IDS.map((d) => ({ ...d, ...state(d.id, key), other: state(d.id, otherKey) }))
  const allNow = TRACK_IDS.every((d) => state(d.id, todayKey).taken)
  const serverStreak = liveStreak ?? t?.streak ?? null
  const count = items.filter((x) => x.taken).length
  const age = oldAge(tracker, now)
  const shownName = dayName(key, todayKey)
  const otherName = dayName(otherKey, todayKey)

  // The server owns the streak and is asked again after each tick lands. Until
  // that answer is in, the streak follows today's ticks on screen: completing
  // the day adds one, undoing a complete day takes one away.
  const [hold, setHold] = useState<StreakHold | null>(null)
  const idle = !Object.keys(pending).length && streakFetching === 0
  const held = hold && !(hold.settled && idle) ? hold : null
  const streak = held
    ? Math.max(0, held.base + (allNow && !held.allBefore ? 1 : 0) - (!allNow && held.allBefore ? 1 : 0))
    : serverStreak

  // the toast's Undo runs after later renders: it reads the newest values from here
  const latest = useRef({ libFor, allNow, serverStreak, held, todayKey })
  useEffect(() => {
    latest.current = { libFor, allNow, serverStreak, held, todayKey }
  })

  /** " for yesterday", " for Fri 16"; nothing for today */
  const forDay = (day: string) => (day === latest.current.todayKey ? '' : ` for ${dateLabel(day, latest.current.todayKey)}`)

  const flip = (id: TrackId, day: string, next: boolean, undo = false) => {
    if (inflight.current[id]) return
    const label = TRACK_IDS.find((d) => d.id === id)?.label ?? id
    const { allNow: before, serverStreak: base, held: h } = latest.current
    setHold(h ? { ...h, settled: false } : base == null ? null : { base, allBefore: before, settled: false })
    setPending((p) => ({ ...p, [id]: { key: day, taken: next, at: next ? Date.now() : 0 } }))
    const shown = undo ? 0 : toast(`${label} ${next ? 'done' : 'unticked'}${forDay(day)}`, {
      action: { label: 'Undo', run: () => void undoFlip(id, day, next) },
    })
    // the hook's toggle sends the opposite of the entry it is given
    const entry = { date: day, taken: !next, takenAt: null }
    const run = settled(qc, () => latest.current.libFor(day)[id].toggle(entry))
      .then(() => true, (e: unknown) => {
        if (shown) dismissToast(shown)
        toast(`${label} not saved: ${why(e)}`)
        return false
      })
      .finally(() => {
        delete inflight.current[id]
        setPending((p) => {
          const n = { ...p }
          delete n[id]
          return n
        })
        setHold((h) => (h ? { ...h, settled: true } : h))
      })
    inflight.current[id] = run
  }
  // Undo waits for the tick it undoes; a tick that failed has nothing to undo
  const undoFlip = async (id: TrackId, day: string, did: boolean) => {
    if ((await inflight.current[id]) === false) return
    flip(id, day, !did, true)
  }

  const ex = near.exercise
  const skips = !ex.loading && !ex.error ? ex.skips : cachedSkips.data
  const workout = (k: string) => (skips ? workoutFor(k, skips) : null)

  // Skip (Exercise only): a held press skips the day shown, or takes its skip back.
  // Skipping clears that day's tick, so Undo of a skip ticks it again when it was ticked.
  const [skipping, setSkipping] = useState(false)
  const skipRun = useRef<Promise<boolean> | null>(null)
  const skip = (day: string, undo?: { retick: boolean }) => {
    if (skipRun.current || inflight.current.exercise) return
    const lib = latest.current.libFor(day).exercise
    if (!lib.skip) return
    const wasSkipped = !!skips?.includes(day)
    const wasTicked = state('exercise', day).taken
    setSkipping(true)
    const shown = undo ? 0 : toast(wasSkipped ? `Exercise skip taken back${forDay(day)}` : `Exercise skipped${forDay(day)}`, {
      action: { label: 'Undo', run: () => void undoSkip(day, wasTicked && !wasSkipped) },
    })
    const run = settled(qc, () => lib.skip?.(day))
      .then(() => true, (e: unknown) => {
        if (shown) dismissToast(shown)
        toast(`Exercise skip not saved: ${why(e)}`)
        return false
      })
      .finally(() => {
        skipRun.current = null
        setSkipping(false)
        if (undo?.retick) flip('exercise', day, true, true)
      })
    skipRun.current = run
  }
  const undoSkip = async (day: string, retick: boolean) => {
    if ((await skipRun.current) === false) return
    skip(day, { retick })
  }
  const exHold = useHold(() => skip(key), !!near.exercise.skip)

  const stateLine = (it: (typeof items)[number]): ReactNode => {
    if (!it.known) return !t ? (tracker.failed ? 'Not answering' : 'Loading') : 'Checking'
    // no-break spaces: when the state wraps (mono is wide), it breaks after the workout, never inside "not yet" or "9:12 AM"
    const when = (it.taken ? (it.at > 0 ? clock(it.at) : 'done') : 'not yet').replace(/ /g, NBSP)
    if (it.id === 'exercise') {
      const w = workout(key)
      if (w === 'skipped') return <span className="hm-tick-rest">Skipped</span>
      if (w === 'rest') return <><span className="hm-tick-rest">Rest</span> · {when}</>
      if (w) return `${cap(w)} · ${when}`
    }
    return it.taken ? (it.at > 0 ? `Done ${clock(it.at)}` : 'Done') : 'Not yet'
  }
  const otherWord = (o: TickState) => (!o.known ? '--' : o.taken ? 'done' : otherKey < todayKey ? 'open' : 'not yet')

  return (
    <section className="hm-sec hm-tracker">
      <Head
        label={<><span className="hm-tr-daily">Daily </span>Tracker</>}
        icon="done"
        lit={count === items.length}
        i={4}
        mid={(
          <span className="hm-step" role="group" aria-label="Day">
            <Press className="hm-step-btn" aria-label={`The day before ${shownName.toLowerCase()}`} onPress={() => step(-1)}>
              <Chevron dir="left" />
            </Press>
            <span className="hm-step-day" data-today={key === todayKey || undefined} aria-live="polite">{shownName}</span>
            <Press className="hm-step-btn" aria-label={`The day after ${shownName.toLowerCase()}`} onPress={() => step(1)}>
              <Chevron />
            </Press>
          </span>
        )}
        value={streak === null ? (tracker.failed ? 'not answering' : '--') : (
          <>
            <span className={cx('hm-streak', streak > 0 && 'hm-streak-on')}>{streak}</span><span className="hm-streak-w"> day</span> streak
            <Old age={age} />
          </>
        )}
      />
      <div className="hm-ticks" role="group" aria-label={`Daily tracker, ${shownName}, ${count} of 3 done`}>
        {items.map((it, k) => {
          const isEx = it.id === 'exercise'
          const busy = !!pending[it.id] && pending[it.id]?.key === key
          const altBusy = !!pending[it.id] && pending[it.id]?.key === otherKey
          return (
            <div key={it.id} className="hm-tickw vl-build" style={bi(5 + k)}>
              <Press
                className="hm-tick"
                data-on={it.taken || undefined}
                data-busy={busy || (isEx && skipping) ? '' : undefined}
                data-holding={(isEx && exHold.holding) || undefined}
                aria-pressed={it.taken}
                aria-busy={busy || undefined}
                aria-label={`${it.label}, ${shownName.toLowerCase()}: ${it.taken ? 'done' : 'not done'}${isEx ? '. Hold to skip the day' : ''}`}
                title={isEx ? 'Hold to skip this day (the rotation waits a day)' : undefined}
                disabled={!it.known || !!pending[it.id] || (isEx && skipping)}
                {...(isEx ? exHold.props : {})}
                onPress={() => {
                  if (isEx && exHold.consume()) return
                  flip(it.id, key, !it.taken)
                }}
              >
                <span className="hm-tick-top">
                  <Icon name={it.id} size={15} tone={it.taken ? 'ink' : 'dim'} glow={it.taken} className="hm-tick-ic" />
                  <span className="hm-tick-name">{it.label}</span>
                </span>
                <span className="hm-tick-state">{stateLine(it)}</span>
              </Press>
              <Press
                className="hm-tick-alt"
                data-on={(it.other.known && it.other.taken) || undefined}
                data-open={(it.other.known && !it.other.taken) || undefined}
                data-busy={altBusy || undefined}
                aria-pressed={it.other.taken}
                aria-label={`${it.label}, ${otherName.toLowerCase()}: ${it.other.taken ? 'done' : 'not done'}`}
                disabled={!it.other.known || !!pending[it.id]}
                onPress={() => flip(it.id, otherKey, !it.other.taken)}
              >
                <i className="hm-tick-box" aria-hidden>{it.other.taken && <Check />}</i>
                <span className="vl-ellipsis">{otherName}: {otherWord(it.other)}</span>
              </Press>
            </div>
          )
        })}
      </div>
      {key !== todayKey && (
        <div className="hm-tr-away vl-build" style={bi(8)}>
          <span className="hm-tr-away-k">Showing {fullDayLabel(key)}</span>
          <Press className="vl-link vl-hit hm-tr-back" onPress={backToToday}>Back to today</Press>
        </div>
      )}
    </section>
  )
}

/** "Friday, Oct 16" for a tracker date key */
const fullDayLabel = (key: string) => parseDateKey(key).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

function Check() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
      <path d="M1.5 5.2 4 7.6 8.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

// ---------- calendar: today first, then the next six days ----------

const AHEAD = 6
/** events listed per coming day before "+N more" */
const PER_DAY = 3

type DayRow = { i: number; from: number; list: EventVM[] }
type DayGroup = { kind: 'day'; d: DayRow } | { kind: 'free'; a: DayRow; b: DayRow }

function useDays(events: EventVM[] | undefined, now: number, first: number, count: number): DayRow[] {
  const day0 = startOfDay(now)
  return useMemo(() => Array.from({ length: count }, (_, k) => {
    const i = first + k
    const from = addDays(day0, i)
    const to = addDays(day0, i + 1)
    const list = (events ?? []).filter((e) => touches(e, from, to))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
    return { i, from, list }
  }), [events, day0, first, count])
}

/** Days with events stay; a run of free days folds into one row. */
function groupDays(days: DayRow[]): DayGroup[] {
  const out: DayGroup[] = []
  for (const d of days) {
    const last = out[out.length - 1]
    if (d.list.length) out.push({ kind: 'day', d })
    else if (last?.kind === 'free') last.b = d
    else out.push({ kind: 'free', a: d, b: d })
  }
  return out
}

function NextEvent({ e, meta, when, live, onPress }: { e: EventVM; meta: ReactNode; when: ReactNode; live?: boolean; onPress: () => void }) {
  return (
    <Press className="hm-next" onPress={onPress} aria-label={`${e.title || 'Busy'}, open its details`}>
      <span className="min-w-0 flex-1">
        <span className="hm-next-title">{e.title || 'Busy'}</span>
        <span className="hm-next-meta vl-ellipsis">{meta}</span>
      </span>
      <span className={cx('hm-next-when', live && 'hm-live')}>{when}</span>
    </Press>
  )
}

/**
 * Today first (the event on now or next, then the rest of today), then the
 * next six days as compact rows. The head opens the calendar sheet on today's
 * day view; an event opens it on its day with its details; a free row or
 * "+N more" opens that day.
 */
function Calendar({ onOpen }: { onOpen: (o: CalendarOpen) => void }) {
  const cal = useCalendar(7)
  const now = useTick(30_000)
  const events = cal.data
  const day0 = startOfDay(now)
  const day1 = addDays(day0, 1)
  const days = useDays(events, now, 1, AHEAD)

  const view = useMemo(() => {
    const todays = (events ?? []).filter((e) => touches(e, day0, day1))
    const allDay = todays.filter((e) => e.allDay)
    const timed = todays.filter((e) => !e.allDay)
    const live = timed.filter((e) => e.start <= now && e.end > now)
    const upcoming = timed.filter((e) => e.start > now)
    const past = timed.filter((e) => e.end <= now)
    const featured = live[0] ?? upcoming[0] ?? null
    const rest = [...live, ...upcoming].filter((e) => e !== featured)
    return { allDay, featured, rest, past, left: live.length + upcoming.length }
  }, [events, now, day0, day1])

  const { allDay, featured, rest, past, left } = view
  const isLive = !!featured && featured.start <= now
  // nothing left today: the first timed event of the coming days carries the countdown
  const next = featured ? null : days.flatMap((d) => d.list).find((e) => !e.allDay && e.start > now) ?? null
  const age = cal.failed ? oldAge(cal, now) : null
  const open = (dayMs: number, focus?: string) => onOpen({ day: dayMs, focus: focus ?? null })

  return (
    <Panel className="hm-glance hm-cal" lit={isLive} i={8} dense>
      <Press className="hm-g-head hm-g-press" onPress={() => open(day0)} aria-label="Calendar, open today's day view">
        <span className="hm-g-label" data-lit={isLive || undefined}><HIcon name="calendar" lit={isLive} />Calendar</span>
        <span className="hm-g-value">
          {events && left > 0 ? <><b>{left}</b> left today</> : null}
          <Old age={age} />
        </span>
        <Chevron />
      </Press>
      <div className="hm-cal-body">
        {!events ? (
          <p className="hm-quiet">{cal.failed ? 'Calendar not answering' : 'Reading the calendar'}</p>
        ) : (
          <>
            {allDay.length > 0 && (
              <span className="hm-tags">
                {allDay.map((e) => (
                  <Press key={e.id} className="hm-tag vl-ellipsis" onPress={() => open(day0, e.id)} aria-label={`${e.title || 'Busy'}, all day, open its details`}>{e.title}</Press>
                ))}
              </span>
            )}
            {featured ? (
              <NextEvent
                e={featured}
                live={isLive}
                meta={<>{clock(featured.start)} to {clock(featured.end)}{featured.location ? ` · ${featured.location}` : ''}</>}
                when={isLive ? <>Now<small>until {clock(featured.end)}</small></> : until(featured.start - now)}
                onPress={() => open(day0, featured.id)}
              />
            ) : (
              <Press className="hm-cal-note" onPress={() => open(day0)}>{past.length || allDay.length ? 'Nothing else today' : 'Nothing today'}</Press>
            )}
            {rest.length > 0 && (
              <span className="vl-rows hm-evrows">
                {rest.slice(0, 4).map((e) => (
                  <Press key={e.id} className="vl-row hm-evrow" onPress={() => open(day0, e.id)} aria-label={`${e.title || 'Busy'} at ${clock(e.start)}, open its details`}>
                    <span className="hm-evtime">{clock(e.start)}</span>
                    <span className="vl-ellipsis flex-1">{e.title || 'Busy'}</span>
                    {e.start <= now && <span className="hm-live-tag">Now</span>}
                  </Press>
                ))}
                {rest.length > 4 && <Press className="vl-row hm-evrow hm-faint" onPress={() => open(day0)}>+{rest.length - 4} more</Press>}
              </span>
            )}
            {past.length > 0 && featured && <Press className="hm-earlier" onPress={() => open(day0)}>{past.length} earlier today</Press>}
          </>
        )}
        {/* its own source: due tasks show while the calendar is still loading or not answering */}
        <TasksGlance now={now} />
        {events && <Ahead days={days} now={now} next={next} onOpen={open} />}
      </div>
    </Panel>
  )
}

/**
 * The Calendar block's tasks (screens/Tasks.tsx): a line with what is overdue, what is due today
 * and how many are open, then up to three overdue or due-today tasks. All of it opens /m/tasks.
 * Nothing at all until the list has loaded once.
 */
function TasksGlance({ now }: { now: number }) {
  const tasks = useOpenTasks()
  const navigate = useNavigate()
  const list = tasks.data?.tasks
  if (!list) return null
  const due = list.filter((t) => t.due && dueState(t.due, now) !== 'soon' && dueState(t.due, now) !== 'later')
  const late = due.filter((t) => dueState(t.due!, now) === 'overdue').length
  const go = () => navigate('/m/tasks', { state: { v2Back: true } })
  const parts = [
    late ? { text: `${late} overdue`, late: true } : null,
    due.length - late ? { text: `${due.length - late} due today`, late: false } : null,
    { text: `${list.length} open`, late: false },
  ].filter((x): x is { text: string; late: boolean } => x !== null)
  return (
    <div className="hm-ahead hm-tasks">
      <Press className="hm-ahead-head hm-tasks-head" onPress={go} aria-label={`Tasks: ${parts.map((x) => x.text).join(', ')}. Open the list`}>
        <span className="vl-caps">Tasks</span>
        <span>
          {parts.map((x, k) => <span key={x.text} data-late={x.late || undefined}>{k ? ' · ' : ''}{x.text}</span>)}
        </span>
      </Press>
      {due.slice(0, 3).map((t) => {
        const isLate = dueState(t.due!, now) === 'overdue'
        return (
          <Press key={taskKey(t.ref)} className="hm-arow" onPress={go} aria-label={`${t.text}, due ${dueLabel(t.due!, now)}, open Tasks`}>
            <span className="hm-aday" data-late={isLate || undefined}>{isLate ? 'Late' : t.due!.length > 10 ? clockOf(t.due!.slice(11, 16)) : 'Today'}</span>
            <span className="hm-atitle">{t.text}</span>
          </Press>
        )
      })}
    </div>
  )
}

/** The coming days as compact rows: a day tag on its first event, time, title; free runs fold into one row. Each row opens its day. */
function Ahead({ days, now, next, onOpen }: { days: DayRow[]; now: number; next: EventVM | null; onOpen: (day: number, focus?: string) => void }) {
  const total = new Set(days.flatMap((d) => d.list.map((e) => e.id))).size
  return (
    <div className="hm-ahead">
      <div className="hm-ahead-head">
        <span className="vl-caps">Next {AHEAD} days</span>
        <span>{total ? plural(total, 'event') : 'Nothing planned'}</span>
      </div>
      {groupDays(days).map((g) => g.kind === 'free' ? (
        <Press key={`f${g.a.i}`} className="hm-arow" data-free="" onPress={() => onOpen(g.a.from)} aria-label={`${dayTag(g.a.from)} free, open the day`}>
          <span className="hm-aday">{dayTag(g.a.from)}</span>
          <span className="hm-atitle">{g.a === g.b ? 'Free' : `Free through ${dayTag(g.b.from)}`}</span>
        </Press>
      ) : (
        <div key={g.d.i} className="hm-aday-group">
          {g.d.list.slice(0, PER_DAY).map((e, k) => (
            <Press key={e.id} className="hm-arow" onPress={() => onOpen(g.d.from, e.id)} aria-label={`${dayTag(g.d.from)}, ${e.title || 'Busy'}, open its details`}>
              <span className="hm-aday">{k === 0 ? dayTag(g.d.from) : ''}</span>
              <span className="hm-atime" style={e.color ? { borderLeftColor: e.color } : undefined} title={e.source || undefined}>
                {e.allDay ? 'All day' : e.start < g.d.from ? 'Cont.' : clock(e.start)}
              </span>
              <span className="hm-atitle">{e.title || 'Busy'}</span>
              {e === next && <span className="hm-awhen">{until(e.start - now)}</span>}
            </Press>
          ))}
          {g.d.list.length > PER_DAY && (
            <Press className="hm-arow hm-faint" onPress={() => onOpen(g.d.from)}>
              <span className="hm-aday" />
              <span className="hm-atitle">+{g.d.list.length - PER_DAY} more</span>
            </Press>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------- quick start ----------

function QuickStart() {
  const targets = useLaunchTargets()
  // The classic quick start's action: in a browser and on the phone it opens
  // the in-page terminal and goes to it; the desktop app follows the board's
  // "in page / on screen" choice. Only its start, busy and note are used here.
  const quick = useQuickSessions()
  const now = useTick(30_000)
  // The phone kinds, as on the real phone home: project targets start from their project (AI > Projects).
  const kinds = (targets.data ?? []).filter((t) => t.phone && !t.project)
  const down = targets.failed
  const age = down ? oldAge(targets, now) : null
  const ghosts = !targets.data || (down && !kinds.length)

  const label = useRef('')
  // the hook's busy is state, so a second tap in the same frame would still see null
  const starting = useRef(false)
  const start = (t: TargetVM) => {
    if (starting.current || quick.busy !== null) return
    starting.current = true
    label.current = cap(t.label)
    void quick.start({ key: t.key, label: t.label, group: t.group, exists: true, phone: t.phone, project: t.project })
      .finally(() => { starting.current = false })
  }
  // the hook reports how a start ended in its note: "X opened on thor", or the error
  const { note } = quick
  useEffect(() => {
    if (note) toast(note.error ? `${label.current} not started: ${note.text}` : note.text)
  }, [note])

  return (
    <section className="hm-sec">
      <Head
        label="Quick Start"
        icon="start"
        i={1}
        value={down
          ? <span className="hm-dim">thor not answering<Old age={age} /></span>
          : !targets.data ? <span className="hm-dim">Reading thor</span>
          : <span className="hm-dim">New AI session on thor</span>}
      />
      {ghosts ? (
        <div className="hm-starts vl-build" style={{ ...bi(2), '--n': 3 } as Vars} aria-hidden>
          {[0, 1, 2].map((k) => <span key={k} className="hm-start" data-ghost="" />)}
        </div>
      ) : kinds.length ? (
        <div className="hm-starts vl-build" style={{ ...bi(2), '--n': Math.min(3, kinds.length) } as Vars} data-down={down || undefined}>
          {kinds.map((t) => {
            const busy = quick.busy === t.key
            return (
              <Press
                key={t.key}
                className="hm-start"
                data-busy={busy || undefined}
                aria-busy={busy || undefined}
                disabled={quick.busy !== null}
                onPress={() => start(t)}
                title={`Start a new AI session in ${cap(t.label)}`}
              >
                <Icon name="start" size={14} tone={busy ? 'ink' : 'dim'} glow={busy} className={cx('hm-start-ic', busy && 'vl-pulse')} />
                <span className="vl-ellipsis">{busy ? 'Starting' : cap(t.label)}</span>
              </Press>
            )
          })}
        </div>
      ) : (
        <p className="hm-quiet hm-starts-empty vl-build" style={bi(2)}>No phone targets on thor</p>
      )}
    </section>
  )
}

// ---------- upload: pictures and videos to thor ----------

/**
 * Pictures and videos from the phone to C:\Thor\uploads on thor, under Quick
 * Start: pick them (the camera, or any number from Photos and Files), watch
 * each one go, then copy the path a session on thor needs. A failed file has
 * Retry. On the desktop the block takes a drop. The queue, the transfer and
 * the rows are kit/upload.tsx (shared with the AI > Sessions button).
 */
function UploadBlock({ wide }: { wide: boolean }) {
  const pick = useUploadPicker('dashboard')
  const list = useUploads()
  // the camera plate only where there is a camera to open: touch screens
  const touch = useMedia('(pointer: coarse)')
  const [drop, setDrop] = useState(false)
  const depth = useRef(0)
  const { left, pct, failed } = uploadProgress(list)
  const busy = left > 0

  const files = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const endDrag = () => { depth.current = 0; setDrop(false) }
  const plate = (key: string, icon: typeof UP_ICONS[keyof typeof UP_ICONS], label: string, open: () => void, title: string) => (
    <Press key={key} className="hm-start" data-upload-open={key} onPress={() => {}} onClick={open} title={title}>
      <UpIcon C={icon} size={14} tone="dim" className="hm-start-ic" />
      <span className="vl-ellipsis">{label}</span>
    </Press>
  )

  return (
    <section
      className="hm-sec hm-up"
      data-drop={drop || undefined}
      aria-label="Upload to thor"
      onDragEnter={(e) => { if (!files(e)) return; e.preventDefault(); depth.current++; setDrop(true) }}
      onDragOver={(e) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={() => { if (--depth.current <= 0) endDrag() }}
      onDrop={(e) => {
        if (!files(e)) return
        e.preventDefault()
        endDrag()
        const dropped = Array.from(e.dataTransfer.files)
        if (dropped.length) addUploads(dropped, 'dashboard')
      }}
    >
      {pick.inputs}
      <div className="hm-head vl-build" style={bi(2)}>
        <span className="hm-head-label" data-lit={busy || undefined}>
          <UpIcon C={UP_ICONS.upload} size={14} tone={busy ? 'fg' : 'dim'} glow={busy} className={cx('hm-ic', busy && 'vl-pulse')} />
          Upload
        </span>
        <span className="hm-head-value">
          {busy
            ? <><b className="hm-up-n">{left}</b> to go · {pct}%</>
            : failed
              ? <span className="hm-alert">{plural(failed, 'file')} failed</span>
              : <span className="hm-dim">To {'C:\\Thor\\uploads'}</span>}
        </span>
      </div>
      <div className="hm-starts vl-build" style={{ ...bi(3), '--n': touch ? 2 : 1 } as Vars}>
        {touch
          ? [
            plate('camera', UP_ICONS.camera, 'Camera', pick.openCamera, 'Take a picture or a video and send it to thor'),
            plate('files', UP_ICONS.image, 'Photos & files', pick.openFiles, 'Send pictures and videos to thor'),
          ]
          : plate('files', UP_ICONS.image, drop ? 'Drop to send' : 'Choose or drop pictures', pick.openFiles, 'Send pictures and videos to thor')}
      </div>
      <UploadRows limit={wide ? 5 : 3} />
    </section>
  )
}

// ---------- AI: live sessions and usage ----------

const ACT_RANK: Record<SessionVM['activity'], number> = { asking: 0, working: 1, idle: 2, closed: 3 }

function liveSessions(list: SessionVM[] | undefined, withIdle: boolean): SessionVM[] {
  return (list ?? [])
    .filter((s) => s.live && (withIdle || s.activity === 'asking' || s.activity === 'working'))
    .sort((a, b) => ACT_RANK[a.activity] - ACT_RANK[b.activity] || b.last - a.last)
}

function useHostLabel(): (id: string) => string {
  const hosts = useHosts()
  return (id: string) => cap(hosts.data?.find((h) => h.id === id)?.label ?? id)
}

/** "2 live · 1 asking", dimmed with its age when the board is not answering; never a confident 0. */
function SessionCount({ s, now }: { s: Live<SessionVM[]>; now: number }) {
  if (!s.data) return <span className="hm-dim">{s.failed ? 'board not answering' : '--'}</span>
  const live = s.data.filter((x) => x.live)
  const asking = live.filter((x) => x.activity === 'asking').length
  const age = oldAge(s, now)
  return (
    <span className={cx(age && 'hm-old')} title={age ? `Session board not answering, showing data from ${age} ago` : undefined}>
      <b>{live.length}</b> live
      {asking > 0 && <span className="hm-asking"> · {asking} asking</span>}
      <Old age={age} />
    </span>
  )
}

/** The state icon of a session: working = hot bolt, pulsing; asking = alert bubble, blinking; idle dim; closed faint. */
function StateIcon({ a }: { a: SessionVM['activity'] }) {
  const icon = a === 'working'
    ? <Icon name="working" size={14} tone="hot" glow />
    : a === 'asking' ? <Icon name="asking" size={14} tone="acc2" glow />
    : <Icon name="idle" size={14} tone={a === 'idle' ? 'dim' : 'faint'} />
  return (
    <span className={cx('hm-state', a === 'working' && 'vl-pulse', a === 'asking' && 'vl-blink')} role="img" aria-label={a} title={a}>
      {icon}
    </span>
  )
}

/** The AI header icon: lit while a live session works or asks. */
function aiLit(s: Live<SessionVM[]>): boolean {
  return !!s.data?.some((x) => x.live && (x.activity === 'working' || x.activity === 'asking'))
}

function SessionLine({ s, host, now }: { s: SessionVM; host: string; now: number }) {
  return (
    <>
      <StateIcon a={s.activity} />
      <span className="hm-srow-title vl-ellipsis">{s.title || s.project || 'Untitled session'}</span>
      <span className="hm-srow-meta">{host} · {s.last ? ago(s.last, now) : '--'}</span>
    </>
  )
}

function resetLabel(iso: string | null, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!t || t < now) return ''
  return t - now < 20 * 3_600_000 ? `Resets ${clock(t)}` : `Resets ${weekday(t)} ${clock(t)}`
}

/**
 * AI: the live sessions (asking first, then working; desktop adds the idle
 * ones) and the usage meters of the account thor runs on now (the hottest
 * account is the fallback, tagged "busiest"). The head and the rows open
 * AI > Sessions, the meters AI > Usage.
 */
function AiBlock({ wide, i }: { wide: boolean; i: number }) {
  const { go } = useShell()
  const usage = useUsage()
  const sw = useSwitchStatus()
  const sessions = useSessions()
  const now = useTick(30_000)
  const hostLabel = useHostLabel()

  const u = usage.data
  // the account thor's terminals use now, not the hottest one; hottest is the fallback
  const on = onAccount(u, sw.data, 'thor')
  const uAge = oldAge(usage, now)
  const dead = u?.accounts.filter((a) => a.dead).length ?? 0
  const list = liveSessions(sessions.data, wide)
  const shown = list.slice(0, wide ? 8 : 3)
  const lit = aiLit(sessions)
  const open = () => go(AI, 'sessions')

  return (
    <Panel className="hm-glance hm-ai" i={i} dense lit={lit}>
      <Press className="hm-g-head hm-g-press" onPress={open} aria-label="AI sessions and usage, open AI">
        <span className="hm-g-label" data-lit={lit || undefined}><HIcon name="claude" lit={lit} />AI</span>
        {on.label && <span className="hm-g-acct vl-ellipsis" title={on.source === 'host' ? 'The account thor runs on now' : `The hottest account (${on.note ?? 'switcher off'})`}>{on.label}{on.source === 'hottest' && <i className="hm-g-acct-hot"> busiest</i>}</span>}
        <span className="hm-g-value"><SessionCount s={sessions} now={now} /></span>
        <Chevron />
      </Press>
      {shown.length > 0 ? (
        <div className="hm-g-sessions" data-old={sessions.failed || undefined}>
          {shown.map((s) => (
            <Press key={s.id} className="hm-srow" onPress={open} aria-label={`${s.title || s.project || 'Untitled session'}, ${s.activity}, open AI`}>
              <SessionLine s={s} host={hostLabel(s.host)} now={now} />
            </Press>
          ))}
          {list.length > shown.length && (
            <Press className="hm-srow hm-faint" onPress={open}>+{list.length - shown.length} more {wide ? 'live' : 'busy'}</Press>
          )}
        </div>
      ) : wide && sessions.data ? (
        <div className="hm-g-sessions">
          <Press className="hm-srow hm-dim" onPress={open}>Nothing live. Open the board</Press>
        </div>
      ) : null}
      <Press className="hm-g-meters" onPress={() => go(AI, 'usage')} aria-label="Usage meters, open AI usage">
        <span className="hm-meters" data-old={uAge ? '' : undefined}>
          <Meter label="5h" value={on.five} note={resetLabel(on.fiveResetsAt, now)} />
          <Meter label="Week" value={on.week} note={resetLabel(on.weekResetsAt, now)} ticks={7} />
        </span>
        {(dead > 0 || uAge || (!u && usage.failed)) && (
          <span className="hm-g-foot">
            <span className="vl-ellipsis">{!u ? 'Usage not answering' : uAge ? `Usage ${uAge} old` : ''}</span>
            {dead > 0 && <span className="hm-alert">{dead} sign-in{dead > 1 ? 's' : ''} expired</span>}
          </span>
        )}
      </Press>
    </Panel>
  )
}

function Meter({ label, value, note, ticks }: { label: string; value: number | null; note: string; ticks?: number }) {
  const high = value !== null && value >= 85
  return (
    <span className="hm-meter">
      <span className="hm-meter-head">
        <span className="hm-meter-label"><HIcon name="gauge" size={13} lit={high} tone={high ? 'acc2' : undefined} />{label}</span>
        <span className={cx('hm-meter-val', high && 'hm-alert')}>{value ?? '--'}<small>%</small></span>
      </span>
      <Bar value={value} ticks={ticks} tone={high ? 'acc2' : 'fg'} />
      <span className="hm-meter-note">{note || ' '}</span>
    </span>
  )
}

// ---------- systems: every host, one row each ----------

// the order the hosts read in (unknown ids go last, by label); labels always come from the data
const HOST_ORDER = ['thor', 'odin', 'frame', 'mimir']

function sortHosts(list: HostVM[]): HostVM[] {
  // the machines in their order, then the phone and tablet, then the cars
  const rank = (h: HostVM) => { const i = HOST_ORDER.indexOf(h.id); return i >= 0 ? i : h.vehicle ? 100 : 99 }
  return [...list].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

/** unit: what the number is in (default %); bar: false for a number with no 0-100 scale (a car's range) */
type HostCell = { key: string; icon: IconName; label: string; v: number | null; alert: boolean; unit?: string; bar?: boolean }

/** A car: its battery (the bolt while it charges) and its range. */
function carCells(h: HostVM): HostCell[] {
  const v = h.vehicle!
  const b = h.battery
  const charging = v.charging === 'charging' || v.charging === 'starting'
  return [
    { key: 'bat', icon: charging ? 'charging' : 'battery', label: charging ? 'Battery, charging' : 'Battery', v: b?.percent ?? null, alert: !charging && (b?.percent ?? 100) <= 15 },
    { key: 'range', icon: 'range', label: 'Range', v: v.rangeMi, alert: false, unit: 'mi', bar: false },
  ]
}

/** CPU, Mem, and Disk; a host with a battery shows the battery in place of the disk. The phone and tablet: battery and storage only. A car: battery and range. */
function hostCells(h: HostVM): HostCell[] {
  if (h.vehicle) return carCells(h)
  if (reportsBatteryOnly(h)) return deviceCells(h)
  const cells: HostCell[] = [
    { key: 'cpu', icon: 'cpu', label: 'CPU', v: h.cpu, alert: false },
    { key: 'mem', icon: 'mem', label: 'Mem', v: h.mem, alert: (h.mem ?? 0) >= 90 },
  ]
  if (h.battery) {
    const b = h.battery
    cells.push({ key: 'bat', icon: b.charging ? 'charging' : 'battery', label: b.charging ? 'Battery, charging' : 'Battery', v: b.percent, alert: !b.charging && b.percent <= 15 })
  } else {
    cells.push({ key: 'disk', icon: 'disk', label: diskWord(h), v: h.disk, alert: (h.disk ?? 0) >= 90 })
  }
  return cells
}

/** "Disk", or "Disk C:" on a host with several disks: the figure is its fullest disk's, so name that one */
function diskWord(h: HostVM): string {
  const d = h.disks.length > 1 ? fullest(h.disks) : null
  return d?.name ? `Disk ${d.name}` : 'Disk'
}

function HostLine({ h, onPress }: { h: HostVM; onPress: () => void }) {
  const on = h.online && !h.stale
  const stale = h.online && h.stale
  const label = cap(h.label)
  const cells = hostCells(h)
  const said = on ? cells.map((c) => `${c.label} ${c.v != null ? `${c.v}${c.unit ? ` ${c.unit}` : '%'}` : 'unknown'}`).join(', ') : stale ? 'stale' : 'offline'
  // a sleeping car is there (its numbers stand), only not glowing
  const asleep = h.vehicle?.state === 'asleep'
  return (
    <Press className="hm-hrow" data-off={!on || undefined} data-stale={stale || undefined} data-car={h.vehicle ? '' : undefined} onPress={onPress} aria-label={`${label}: ${asleep ? 'asleep, ' : ''}${said}. Open in System`}>
      <Icon name={hostIcon(h.id)} size={14} tone={on ? 'fg' : stale ? 'acc2' : 'faint'} glow={on && !asleep} className="hm-ic" />
      <span className="hm-hrow-name vl-ellipsis">{label}</span>
      {on ? cells.map((c) => (
        <span key={c.key} className="hm-mini" data-alert={c.alert || undefined} data-k={c.key} title={c.label}>
          <Icon name={c.icon} size={11} tone={c.alert ? 'acc2' : 'dim'} className="hm-ic" />
          {c.bar !== false && <span className="hm-mini-bar" style={{ '--v': c.v ?? 0 } as Vars} data-empty={c.v == null || undefined}><i /></span>}
          <span className="hm-mini-v">{c.v != null ? <>{c.v}<small>{c.unit ?? '%'}</small></> : '--'}</span>
        </span>
      )) : null}
      {on && !cells.length && <span className="hm-hrow-off">No battery reading yet</span>}
      {!on && <span className="hm-hrow-off">{stale ? 'Stale' : 'Offline'}</span>}
      <Chevron />
    </Press>
  )
}

/** System > Hosts keeps its pick under 'sysHost'; writing it first lands on the tapped host. */
function useOpenHost(): (id?: string) => void {
  const { go } = useShell()
  const [, setSysHost] = useSetting<string>('sysHost', 'thor')
  return (id?: string) => {
    if (id) setSysHost(id)
    go(SYSTEM, 'hosts')
  }
}

/**
 * Every host from /api/hosts: icon, name, its load as mini bars. A row opens
 * System > Hosts with that host picked. `device` (phone, iPad): this device's
 * compact block leads the list.
 */
function Systems({ i, device, active = false }: { i: number; device?: HostModelId | null; active?: boolean }) {
  const hosts = useHosts()
  const open = useOpenHost()
  const now = useTick(30_000)
  const list = sortHosts(hosts.data ?? [])
  const online = list.filter((h) => h.online && !h.stale).length
  const age = oldAge(hosts, now, 60_000)

  return (
    <Panel className="hm-glance hm-sys" i={i} dense>
      <Press className="hm-g-head hm-g-press" onPress={() => open()} aria-label="Hosts, open System">
        <span className="hm-g-label"><HIcon name="system" />Systems</span>
        <span className={cx('hm-g-value', age && 'hm-old')}>
          {hosts.data ? <><b>{online}</b>/{list.length} online<Old age={age} /></> : hosts.failed ? 'not answering' : '--'}
        </span>
        <Chevron />
      </Press>
      {device && <ThisDevice id={device} active={active} compact />}
      {list.length ? (
        <div className="hm-hrows" data-old={age ? '' : undefined}>
          {list.map((h) => <HostLine key={h.id} h={h} onPress={() => open(h.id)} />)}
        </div>
      ) : (
        <p className="hm-quiet hm-g-quiet">{!hosts.data ? (hosts.failed ? 'Hosts not answering' : 'Reading hosts') : 'No hosts reporting'}</p>
      )}
    </Panel>
  )
}

// ---------- this device: the machine in front of Brendon, as its x-ray model ----------

/**
 * The host id of the device the page runs on (kit/thisDevice). The desktop app
 * asks its own machine name first, so it stays null until that answers: thor's
 * tower never flashes up on mimir. A browser has no name to ask.
 */
function useThisDevice(): HostModelId | null {
  const { resolved } = useProfile()
  const [name, setName] = useState<string | null | undefined>(() => (isTauri() ? undefined : null))
  useEffect(() => {
    if (name !== undefined) return
    let live = true
    void localHostname().then((n) => { if (live) setName(n) })
    return () => { live = false }
  }, [name])
  return name === undefined ? null : thisDeviceId(name, resolved)
}

/** a device's name until /api/hosts lists it (from then on the label comes from the data) */
const DEVICE_LABEL: Record<HostModelId, string> = {
  thor: 'Thor', odin: 'Odin', frame: 'Loki', mimir: 'Mimir', phone: MODEL_ONLY_LABEL.phone, tablet: MODEL_ONLY_LABEL.tablet, modelY: 'Car',
}

/** camera pose per model, as System > Hosts picks it (HOST_POSE still names thor's by its old alias 'track') */
const devicePose = (m: HostModelId): string => (HOST_POSE[m] === 'track' ? 'hosts' : HOST_POSE[m])

/** "45m", "12h 5m", "3d 4h" */
function upFor(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** the phone and tablet report a battery and storage, never CPU or memory */
const reportsBatteryOnly = (h: HostVM) => h.mobile || (h.cpu == null && h.mem == null && !!h.battery)

/**
 * This device's numbers: CPU, memory and disk, plus the battery where it has
 * one (Loki); the phone and tablet their battery and storage (storage once
 * either has reported).
 */
function deviceCells(h: HostVM): HostCell[] {
  const b = h.battery
  const bat: HostCell[] = b
    ? [{ key: 'bat', icon: b.charging ? 'charging' : 'battery', label: b.charging ? 'Battery, charging' : 'Battery', v: b.percent, alert: !b.charging && b.percent <= 15 }]
    : []
  const disk = (label: string): HostCell => ({ key: 'disk', icon: 'disk', label, v: h.disk, alert: (h.disk ?? 0) >= 90 })
  if (reportsBatteryOnly(h)) return [...bat, ...(b || h.disk != null ? [disk('Storage')] : [])]
  return [
    { key: 'cpu', icon: 'cpu', label: 'CPU', v: h.cpu, alert: false },
    { key: 'mem', icon: 'mem', label: 'Memory', v: h.mem, alert: (h.mem ?? 0) >= 90 },
    disk(diskWord(h)),
    ...bat,
  ]
}

/** "25.4 / 31.1 GB" (GiB, as Windows and htop show memory; System > Hosts words it the same) */
const memSizes = (h: HostVM) => (h.memUsedGb != null && h.memTotalGb != null ? `${h.memUsedGb.toFixed(1)} / ${h.memTotalGb.toFixed(1)} GB` : null)

/** "3.1 / 4.0 TB", "101 / 256 GB" (decimal, as drives are sold; as System > Hosts words it) */
function diskSizes(h: HostVM): string | null {
  if (h.diskUsedGb == null || h.diskTotalGb == null) return null
  const dec = (gib: number) => (gib * 1024 ** 3) / 1e9
  const one = (gb: number, unit: 'TB' | 'GB') => (unit === 'TB' ? (gb / 1000).toFixed(1) : gb >= 10 ? gb.toFixed(0) : gb.toFixed(1))
  const used = dec(h.diskUsedGb), total = dec(h.diskTotalGb)
  const tu = total >= 1000 ? 'TB' : 'GB'
  const uu = used >= 100 && tu === 'TB' ? 'TB' : 'GB'
  return uu === tu ? `${one(used, uu)} / ${one(total, tu)} ${tu}` : `${one(used, uu)} ${uu} / ${one(total, tu)} ${tu}`
}

/** what a number is out of: the cores, used / total, charging */
function cellSizes(h: HostVM, key: string): string | null {
  if (key === 'cpu') return h.cores ? `${h.cores} cores` : null
  if (key === 'mem') return memSizes(h)
  if (key === 'disk') return diskSizes(h)
  if (key === 'bat') return h.battery?.charging ? 'charging' : null
  return null
}

const HOUR = 3_600_000

/** The last hour as System > Hosts draws it: a flat line pair, fixed 0-100, x by clock, CPU in hot, memory in fg. */
function DevSpark({ h, t1 }: { h: HostVM; t1: number }) {
  const W = 120, H = 40
  const t0 = t1 - HOUR
  const path = (k: 'cpu' | 'mem') => {
    let d = ''
    let prev = -Infinity
    for (const p of h.history) {
      const v = p[k]
      // a gap of more than 3 minutes breaks the line instead of bridging it
      if (v == null || p.t < t0 - 30_000) { prev = -Infinity; continue }
      const x = Math.max(0, Math.min(1, (p.t - t0) / HOUR)) * W
      const y = H - 1 - (Math.max(0, Math.min(100, v)) / 100) * (H - 2)
      d += `${p.t - prev > 180_000 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      prev = p.t
    }
    return d
  }
  return (
    <svg className="hm-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <line className="hm-spark-mid" x1={0} x2={W} y1={H / 2} y2={H / 2} />
      <line className="hm-spark-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
      <path className="hm-spark-mem" d={path('mem')} />
      <path className="hm-spark-cpu" d={path('cpu')} />
    </svg>
  )
}

/** a This device box from this height (layout px) sets its numbers larger and gives the last hour more room */
const DEV_TALL = 400

/**
 * This device: the x-ray model of the machine the page runs on, its heat and
 * glow from the live load (Hero, as on System > Hosts), its name, online state
 * and uptime, and its live numbers with what each is out of (cores, used /
 * total). The whole block is one press that opens System > Hosts with it
 * picked; the model sits under it, so it neither turns nor takes a swipe here.
 * Desktop: its own box in the right column and the column's elastic part: the
 * model takes the right side at the box's full height, the facts and the last
 * hour (CPU and memory, as System > Hosts draws it) the left. `compact` (phone,
 * iPad): a short block that leads the Systems box, as tall as its text.
 */
function ThisDevice({ id, active, i, compact, fill }: { id: HostModelId | null; active: boolean; i?: number; compact?: boolean; fill?: boolean }) {
  const hosts = useHosts()
  const open = useOpenHost()
  const now = useTick(30_000)
  const anchor = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  // The hero fits the model from client rects, which the panel's build-in tilt
  // skews while it plays; each time the build-in ends, it measures again.
  const [built, setBuilt] = useState(0)
  useEffect(() => {
    const el = inRef.current?.closest('.vl-build')
    if (!el) return
    const done = (e: Event) => { if (e.target === el) setBuilt((n) => n + 1) }
    el.addEventListener('animationend', done)
    return () => el.removeEventListener('animationend', done)
  }, [])
  // the same online test the model glows by
  const { online } = useHeat(id ?? '')
  const h = id ? hosts.data?.find((x) => x.id === id) ?? null : null
  const model = id ? hostModel(id) : null
  const label = h ? cap(h.label) : id ? DEVICE_LABEL[id] : 'This device'
  const stale = !!h && h.online && h.stale
  const cells = h && online ? deviceCells(h) : []
  // the phone or tablet is up and its first battery reading has not come in
  const noBattery = !!h && online && reportsBatteryOnly(h) && !h.battery
  const modelOnly = !!id && !!hosts.data && !h && (MODEL_ONLY_IDS as readonly string[]).includes(id)
  const state = !id || !hosts.data ? (hosts.failed ? 'Not answering' : '--')
    : !h ? (modelOnly ? 'Not reporting' : 'Not listed')
    : online ? 'Online' : stale ? 'Stale' : 'Offline'
  const up = online && h ? upFor(h.uptime) : null
  const seen = h && !h.online && h.seen ? `seen ${ago(h.seen, now)} ago` : null
  const detail = up ? `up ${up}` : seen
  const said = [
    state === '--' ? 'reading' : state.toLowerCase(),
    detail,
    ...cells.map((c) => `${c.label} ${c.v != null ? `${c.v}%` : 'unknown'}`),
    noBattery ? 'no battery reading yet' : null,
  ].filter(Boolean).join(', ')
  const stateLine = (
    <span className="hm-dev-state vl-ellipsis" data-state={online ? 'on' : stale ? 'stale' : 'off'}>
      {state}{detail && <span className="hm-dim"> · {detail}</span>}
    </span>
  )
  const old = oldAge(hosts, now, 60_000)
  // desktop: the last hour of CPU and memory (System > Hosts' sparkline), x by the server's clock up to its newest sample
  const histOn = !compact && !!h && online && h.history.length > 1
  const t1 = histOn ? h.history[h.history.length - 1].t : now
  const hour = histOn ? h.history.filter((p) => p.t >= t1 - HOUR - 30_000) : []
  const hasMem = hour.some((p) => p.mem != null)
  const peak = hour.length > 1 ? Math.round(Math.max(h?.cpu ?? 0, ...hour.map((p) => p.cpu ?? 0))) : null
  const size = useSize(inRef, !compact)
  const tall = !compact && !!size && size.h >= DEV_TALL
  // compact with nothing under the name (offline, not listed): the block hugs its text
  const bare = !!compact && !cells.length && !noBattery

  const inner = (
    <div ref={inRef} className="hm-dev-in" data-compact={compact || undefined} data-tall={tall || undefined} data-bare={bare || undefined}>
      {model && <div ref={anchor} className="hm-dev-anchor" aria-hidden />}
      {model && (
        <div className="hm-dev-scene" aria-hidden>
          <Hero
            active={active}
            pose={devicePose(model)}
            host={model}
            anchor={anchor}
            fill={compact ? 0.9 : 0.96}
            scrim={0.6}
            layoutKey={`${model}:${compact ? 'c' : 'f'}:${tall ? 't' : 's'}:${built}`}
            className="absolute inset-0"
          />
        </div>
      )}
      <Press className="hm-dev-press" disabled={!id} onPress={() => { if (id) open(id) }} aria-label={`This device, ${label}: ${said}. Open in System`}>
        <span className="hm-dev-top">
          <span className={compact ? 'hm-dev-cap' : 'hm-g-label'} data-lit={online || undefined}>
            <HIcon name={hostIcon(id ?? 'thor')} lit={online} size={compact ? 12 : 14} />This device
          </span>
          {!compact && <Chevron />}
        </span>
        <span className="hm-dev-id">
          <span className="hm-dev-name vl-ellipsis">{label}</span>
          {stateLine}
        </span>
        {(cells.length > 0 || noBattery) && (
          <span className="hm-dev-rows" data-old={old ? '' : undefined}>
            {noBattery && (
              <span className="hm-dev-hint vl-ellipsis"><Icon name="battery" size={12} tone="dim" className="hm-ic" />No battery reading yet</span>
            )}
            {cells.map((c) => {
              const sz = h ? cellSizes(h, c.key) : null
              return (
                <span key={c.key} className="hm-dev-row" data-alert={c.alert || undefined}>
                  <Icon name={c.icon} size={tall ? 13 : 12} tone={c.alert ? 'acc2' : 'dim'} className="hm-ic" />
                  <span className="hm-dev-k">{c.key === 'bat' ? 'Battery' : c.label}</span>
                  <span className="hm-dev-sz vl-ellipsis">{sz}</span>
                  <span className="hm-mini-v">{c.v != null ? <>{c.v}<small>%</small></> : '--'}</span>
                  <span className="hm-mini-bar" style={{ '--v': c.v ?? 0 } as Vars} data-empty={c.v == null || undefined}><i /></span>
                </span>
              )
            })}
          </span>
        )}
        {!compact && !cells.length && !noBattery && h && <span className="hm-dev-off">No stats published</span>}
        {histOn && hour.length > 1 && (
          <span className="hm-dev-hist" data-old={old ? '' : undefined}>
            <span className="hm-dev-hist-cap">
              <span className="hm-dev-hist-k">Last hour</span>
              <i className="hm-key" data-c="cpu" />CPU
              {hasMem && <><i className="hm-key" data-c="mem" />Mem</>}
              {peak != null && <span className="hm-dev-peak">peak {peak}%</span>}
            </span>
            <span className="hm-dev-spark"><DevSpark h={h} t1={t1} /></span>
          </span>
        )}
      </Press>
    </div>
  )

  if (compact) return inner
  return (
    <Panel className={cx('hm-glance hm-dev', fill && 'hm-grow')} i={i} dense>
      {inner}
    </Panel>
  )
}

// ---------- lights: every bulb, the presets, all on / off ----------

type BulbV = {
  id: string
  name: string
  on: boolean
  unavailable: boolean
  /** 0-100, null when the bulb does not report it */
  pct: number | null
  /** CSS color of what the bulb shows */
  color: string
  /** a command for this bulb is on its way or waiting its turn */
  busy: boolean
}

type LightCmd = { update: LightUpdate; fail: string; onFail?: () => void }

const targetsOf = (u: LightUpdate): string[] => (Array.isArray(u.entity_id) ? u.entity_id : [u.entity_id])

function patchOf(u: LightUpdate): LightPatch {
  const p: LightPatch = { state: u.state }
  if (u.brightness !== undefined) p.brightness = u.brightness
  if (u.rgb_color !== undefined) p.rgb_color = u.rgb_color
  if (u.color_temp_kelvin !== undefined) p.color_temp_kelvin = u.color_temp_kelvin
  return p
}

/** A bulb's read with a waiting command laid over (src/lib/lights.ts lays the one on its way over it). */
function overlayRow(row: LightState, p: LightPatch): LightState {
  if (p.state === 'off') return { ...row, on: false }
  const toCt = p.color_temp_kelvin != null
  const toRgb = !!p.rgb_color
  return {
    ...row,
    on: true,
    brightness: p.brightness ?? row.brightness,
    rgb_color: toRgb ? p.rgb_color! : toCt ? null : row.rgb_color,
    color_temp_kelvin: toCt ? p.color_temp_kelvin! : toRgb ? null : row.color_temp_kelvin,
    color_mode: toRgb ? 'rgb' : toCt ? 'color_temp' : row.color_mode,
  }
}

/**
 * Light commands in the order they were asked, the newest one winning. A
 * command waits while one for any of its bulbs is still on its way (two calls
 * for one bulb in flight at once can land in either order, which is how fast
 * switching ended up somewhere it was never set), and a newer command in the
 * same lane (one bulb, or the room) replaces the one still waiting: on, off,
 * on in a second sends on, then on, never a stray off at the end. A waiting
 * command shows at once (`queued`, laid over the read; the one on its way is
 * src/lib/lights.ts's desire). A failed call says why in a toast, and the
 * bulb falls back to its real state.
 */
function useLightQueue(send: (u: LightUpdate) => Promise<unknown>, landed: () => void) {
  const flying = useRef(new Map<string, number>())
  const waiting = useRef(new Map<string, LightCmd>())
  const [queued, setQueued] = useState<Record<string, LightPatch>>({})
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const fns = useRef({ send, landed })
  useLayoutEffect(() => {
    fns.current = { send, landed }
  })

  const sync = () => {
    const q: Record<string, LightPatch> = {}
    const b = new Set(flying.current.keys())
    for (const c of waiting.current.values()) {
      for (const id of targetsOf(c.update)) {
        q[id] = patchOf(c.update)
        b.add(id)
      }
    }
    setQueued(q)
    setBusyIds(b)
  }
  const fire = (c: LightCmd) => {
    const ids = targetsOf(c.update)
    for (const id of ids) flying.current.set(id, (flying.current.get(id) ?? 0) + 1)
    fns.current.send(c.update)
      .then(() => fns.current.landed())
      .catch((e: unknown) => {
        c.onFail?.()
        toast(`${c.fail}: ${why(e)}`)
      })
      .finally(() => {
        for (const id of ids) {
          const n = (flying.current.get(id) ?? 1) - 1
          if (n > 0) flying.current.set(id, n)
          else flying.current.delete(id)
        }
        pump()
      })
  }
  // in order: a command also waits while an earlier waiting one shares a bulb with it
  function pump() {
    const blocked = new Set(flying.current.keys())
    for (const [lane, c] of waiting.current) {
      const ids = targetsOf(c.update)
      const free = !ids.some((id) => blocked.has(id))
      ids.forEach((id) => blocked.add(id))
      if (!free) continue
      waiting.current.delete(lane)
      fire(c)
    }
    sync()
  }
  /** lane: 'room' for the presets and all on / off, 'level' for the all-lights bar, the bulb's id for its own switch */
  const run = (lane: string, c: LightCmd) => {
    if (!targetsOf(c.update).length) return
    // a newer command in a lane replaces the waiting one and takes its turn at the back
    waiting.current.delete(lane)
    waiting.current.set(lane, c)
    pump()
  }
  return { run, queued, busyIds }
}

const SWATCHES = PRESETS.map((p) => ({ ...p, swatch: presetSwatchStyle(p) }))
type Swatch = (typeof SWATCHES)[number]
/** a preset as the color half of a light command: rgb, or a white by kelvin, never both */
const colorOf = (p: Swatch): Pick<LightUpdate, 'rgb_color' | 'color_temp_kelvin'> =>
  p.rgb ? { rgb_color: p.rgb } : p.kelvin ? { color_temp_kelvin: p.kelvin } : {}

/**
 * The preset a lit bulb is showing, by its mode and its real figures, else
 * null. Bulbs quantize and some report a red of 224 for 255, so a color is
 * compared at full scale (its strongest channel taken to 255), loosely.
 */
function presetOf(l: LightState): string | null {
  const c = l.rgb_color
  const top = c ? Math.max(c[0], c[1], c[2], 1) : 1
  const full = c ? c.map((v) => (v * 255) / top) : null
  for (const p of PRESETS) {
    if (p.rgb) {
      if (l.color_mode !== 'color_temp' && full && p.rgb.every((v, k) => Math.abs(v - full[k]) <= 20)) return p.label
    } else if (p.kelvin != null && l.color_mode === 'color_temp' && l.color_temp_kelvin != null && Math.abs(l.color_temp_kelvin - p.kelvin) <= 200) {
      return p.label
    }
  }
  return null
}

/**
 * Lights: the count (the head opens Lights), the plate that switches them all
 * (with Undo), the presets (they color the bulbs that are on, each keeps its
 * own level), one all-lights brightness bar (the room's level, as the head
 * reads it; a drag sets every bulb that is on, sent once on release), and a
 * chip per bulb in its real color (a tap switches it). `rows` (two columns and
 * up): presets with their names, the bar, the chips. `chips` (phone): the bar,
 * the chips, the presets as diamonds. Per-bulb levels and colors live on the
 * Lights tab, and so does the apartment model; on the desktop its old place in
 * this column holds this device's model. Every write goes through
 * useLightsControl's mutation, in order (useLightQueue).
 */
function LightsBox({ i, variant }: { i: number; variant: 'chips' | 'rows' }) {
  const { go } = useShell()
  const qc = useQueryClient()
  // the persisted view model paints the first frame; the real control (shared
  // with the Lights tab and the lights button) is server truth with the
  // commands on their way laid over it, and owns every write
  const cached = useLights()
  const ctl = useLightsControl()
  const now = useTick(30_000)
  const q = useLightQueue(ctl.mutation.mutateAsync, () => { void qc.invalidateQueries({ queryKey: ['v2', 'lights'] }) })
  const server = ctl.lights.data
  const { queued } = q
  const rows = useMemo(() => (server ? ctl.all.map((l) => (queued[l.entity_id] ? overlayRow(l, queued[l.entity_id]) : l)) : null), [server, ctl.all, queued])
  const bulbs: BulbV[] = rows
    ? rows.map((l) => ({ id: l.entity_id, name: l.name, on: l.on, unavailable: l.unavailable, pct: pctFromBrightness(l.brightness), color: lightColor(l), busy: q.busyIds.has(l.entity_id) }))
    : (cached.data ?? []).map((l) => ({ ...l, busy: false }))
  const avail = bulbs.filter((b) => !b.unavailable)
  const lit = avail.filter((b) => b.on)
  const anyOn = lit.length > 0
  const offline = bulbs.length - avail.length
  const ordered = [...avail, ...bulbs.filter((b) => b.unavailable)]
  // one bulb of unknown brightness makes the room's reading unknown, never an invented average
  const avg = anyOn && lit.every((b) => b.pct != null) ? Math.round(lit.reduce((a, b) => a + (b.pct as number), 0) / lit.length) : null
  const litRows = (rows ?? []).filter((l) => l.on && !l.unavailable)
  const preset = litRows.length && litRows.every((l) => presetOf(l) === presetOf(litRows[0])) ? presetOf(litRows[0]) : null
  const age = rows
    ? oldAge({ data: rows, updatedAt: ctl.lights.dataUpdatedAt, fromCache: false, isFetching: ctl.lights.isFetching, error: ctl.lights.error, failed: ctl.lights.isError }, now)
    : oldAge(cached, now)
  const ready = !!server
  const roomBusy = avail.length > 0 && avail.some((b) => b.busy)

  const need = () => {
    if (ready) return true
    toast('Lights: still reading Home Assistant')
    return false
  }
  const toggle = (b: BulbV) => {
    if (!need()) return
    q.run(b.id, { update: { entity_id: b.id, state: b.on ? 'off' : 'on' }, fail: `Could not turn ${b.name} ${b.on ? 'off' : 'on'}` })
  }
  // the all-lights bar sets every bulb that is on, never a dark one; its own lane, so a waiting preset or switch is never dropped for it
  const setLevel = (v: number) => {
    if (!need()) return
    if (!lit.length) { toast('Turn a light on first'); return }
    const ids = lit.map((b) => b.id)
    q.run('level', {
      update: v <= 0 ? { entity_id: ids, state: 'off' } : { entity_id: ids, state: 'on', brightness: brightnessFromPct(v) },
      fail: v <= 0 ? 'Could not turn the lights off' : `Could not set the lights to ${v}%`,
    })
  }
  // the bar in the lit bulbs' colors: one color, or a run through each when they differ
  const litColors = [...new Set(lit.map((b) => b.color))]
  // presets color the bulbs that are on, never a dark one, and carry no brightness (the backend pins each bulb's own)
  const applyPreset = (p: Swatch) => {
    if (!need()) return
    if (!lit.length) { toast('Turn a light on first'); return }
    q.run('room', { update: { entity_id: lit.map((b) => b.id), state: 'on', ...colorOf(p) }, fail: `Could not apply ${p.label}` })
  }
  const allIds = avail.map((b) => b.id)
  // Undo of "all on" switches them all off; of "all off", only the bulbs that were on come back
  const switchAll = () => {
    if (!need() || !allIds.length) return
    const next = anyOn ? 'off' : 'on'
    const wasOn = lit.map((b) => b.id)
    const undo = () => {
      if (next === 'on') q.run('room', { update: { entity_id: allIds, state: 'off' }, fail: 'Could not turn the lights off' })
      else if (wasOn.length) q.run('room', { update: { entity_id: wasOn, state: 'on' }, fail: 'Could not turn the lights back on' })
    }
    const shown = toast(next === 'on' ? 'All lights on' : 'All lights off', { action: { label: 'Undo', run: undo } })
    q.run('room', { update: { entity_id: allIds, state: next }, fail: `Could not turn the lights ${next}`, onFail: () => dismissToast(shown) })
  }

  const empty = !rows && !cached.data
    ? (cached.failed || ctl.lights.isError ? 'Lights not answering' : 'Reading the lights')
    : !bulbs.length ? 'No bulbs reported' : null

  return (
    <Panel className={cx('hm-glance hm-lights', `hm-lights-${variant}`)} i={i} dense lit={anyOn}>
      <div className="hm-g hm-g-split">
        <Press className="hm-g-main" onPress={() => go(LIGHTS)} aria-label="Lights, open Lights">
          <span className="hm-g-label" data-lit={anyOn || undefined}><HIcon name={anyOn ? 'bulb' : 'bulbOff'} lit={anyOn} />Lights</span>
          <span className={cx('hm-g-value', age && 'hm-old')}>
            {rows || cached.data ? <><b>{lit.length}</b> of {avail.length} on{avg != null && <span className="hm-dim"> · {avg}%</span>}</> : cached.failed || ctl.lights.isError ? 'not answering' : '--'}
            {offline > 0 && <span className="hm-faint"> · {offline} offline</span>}
            <Old age={age} />
          </span>
          <Chevron />
        </Press>
        <Press
          className="hm-plate"
          data-on={anyOn || undefined}
          data-busy={roomBusy || undefined}
          aria-pressed={anyOn}
          aria-label={anyOn ? 'Turn all lights off' : 'Turn all lights on'}
          // the switch needs the control's own read: it sends to the bulbs that read reachable
          disabled={!ready || !allIds.length}
          onPress={switchAll}
        >
          <span className="hm-plate-in">
            <Icon name="power" size={12} tone={anyOn ? 'ink' : 'dim'} />
            {anyOn ? 'On' : 'Off'}
          </span>
        </Press>
      </div>
      {empty ? (
        <p className="hm-quiet hm-g-quiet">{empty}</p>
      ) : (
        <>
          {variant === 'rows' && <Presets active={preset} idle={!anyOn} names onPick={applyPreset} />}
          <RoomBar
            value={avg}
            on={anyOn}
            color={litColors[0] ?? 'var(--fg)'}
            mix={litColors.length > 1 ? `linear-gradient(90deg, ${litColors.join(', ')})` : null}
            busy={roomBusy}
            onCommit={setLevel}
          />
          <div
            className="hm-chips"
            role="group"
            aria-label="Bulbs"
            data-wide={variant === 'rows' || undefined}
            data-per={variant === 'rows' ? (ordered.length === 4 ? 2 : ordered.length >= 7 ? 4 : 3) : undefined}
          >
            {ordered.map((b) => <BulbChip key={b.id} b={b} onToggle={() => toggle(b)} />)}
          </div>
          {variant === 'chips' && <Presets active={preset} idle={!anyOn} onPick={applyPreset} />}
        </>
      )}
    </Panel>
  )
}

/** The presets as glass plates, each with its swatch; the one every lit bulb shows is lit. `names`: the label beside the swatch. */
function Presets({ active, idle, names, onPick }: { active: string | null; idle: boolean; names?: boolean; onPick: (p: Swatch) => void }) {
  return (
    <div className="hm-pres" role="group" aria-label="Presets for the lights that are on" data-idle={idle || undefined} data-names={names || undefined}>
      {SWATCHES.map((p) => {
        const on = active === p.label
        return (
          <Press
            key={p.label}
            className="hm-pre"
            data-on={on || undefined}
            style={{ '--sw': p.swatch } as Vars}
            aria-pressed={on}
            aria-label={`${p.label}, for the lights that are on`}
            title={p.label}
            onPress={() => onPick(p)}
          >
            <i className="hm-pre-sw" aria-hidden />
            {names && <span className="hm-pre-name">{p.label}</span>}
          </Press>
        )
      })}
    </div>
  )
}

/**
 * The all-lights bar: the room's level as the head reads it (the lit bulbs'
 * average, unknown when one of them does not report it), filled in the lit
 * bulbs' colors (`mix`: a run through each when they differ), a hairline while
 * every bulb is off. A drag sets every bulb that is on, sent once on release
 * (BulbSlider).
 */
function RoomBar({ value, on, color, mix, busy, onCommit }: {
  value: number | null
  on: boolean
  color: string
  mix: string | null
  busy: boolean
  onCommit: (v: number) => void
}) {
  // the value under the pointer while the bar moves (the bulbs are told on release)
  const [preview, setPreview] = useState<number | null>(null)
  const lit = preview !== null ? preview > 0 : on
  const shown = preview !== null ? (preview > 0 ? preview : null) : on ? value : null
  return (
    <div
      className="hm-allbar"
      data-on={lit || undefined}
      data-busy={busy || undefined}
      data-mix={mix ? '' : undefined}
      style={{ '--c': color, ...(mix ? { '--mix': mix } : {}) } as Vars}
    >
      <span className="hm-allbar-id">
        <Icon name={lit ? 'bulb' : 'bulbOff'} size={15} tone={lit ? 'fg' : 'dim'} glow={lit} className="hm-allbar-ic" />
        <span className="hm-allbar-name">All lights</span>
      </span>
      <BulbSlider value={on ? value : 0} on={lit} label="All lights brightness" onPreview={setPreview} onCommit={onCommit} />
      <span className="hm-allbar-pct">{shown != null ? <>{shown}<small>%</small></> : on && preview === null ? '--' : 'Off'}</span>
    </div>
  )
}

/** One bulb as a chip: its icon in its real color, the name, its level or Off. A tap switches it. */
function BulbChip({ b, onToggle }: { b: BulbV; onToggle: () => void }) {
  const lit = b.on && !b.unavailable
  return (
    <Press
      className="hm-chip"
      data-on={lit || undefined}
      data-na={b.unavailable || undefined}
      data-busy={b.busy || undefined}
      style={{ '--c': b.color } as Vars}
      disabled={b.unavailable}
      aria-pressed={b.on}
      aria-label={b.unavailable ? `${b.name}, unavailable` : b.on ? `Turn ${b.name} off` : `Turn ${b.name} on`}
      onPress={onToggle}
    >
      <Icon name={lit ? 'bulb' : 'bulbOff'} size={14} tone={lit ? 'fg' : b.unavailable ? 'faint' : 'dim'} glow={lit} className="hm-chip-ic" />
      <span className="hm-chip-name vl-ellipsis" title={b.name}>{b.name}</span>
      <span className="hm-chip-v">{b.unavailable ? 'n/a' : lit ? (b.pct != null ? `${b.pct}%` : 'On') : 'Off'}</span>
    </Press>
  )
}

/** how long a released bar keeps its value while the bulb has not reported it yet */
const SL_HOLD_MS = 4_000

/**
 * A brightness bar (the all-lights bar), filled in its --c color. A mouse sets the value
 * at once and drags it; a finger sets it on a sideways drag or on lift (a
 * vertical move hands the gesture back to the page scroll). It commits ONCE
 * per gesture (release, tap, or key up after the arrows): a command per move
 * sent a cloud integration values the pointer had already left. The value
 * owns the bar from the first move until the bulb reports it, or SL_HOLD_MS
 * for one that never does, so the bar never jumps back mid-change.
 */
function BulbSlider({ value, on, label, onCommit, onPreview }: {
  value: number | null
  on: boolean
  label: string
  onCommit: (v: number) => void
  onPreview?: (v: number | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef({ onCommit, onPreview })
  useLayoutEffect(() => {
    cb.current = { onCommit, onPreview }
  })
  const [drag, setDrag] = useState(false)
  const [held, setHeld] = useState<number | null>(null)
  const last = useRef(0)
  const keying = useRef(false)
  const ceiling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = held ?? value
  const unknown = shown === null
  const v = unknown ? 0 : Math.max(0, Math.min(100, Math.round(shown)))

  const clearCeiling = () => {
    if (ceiling.current !== null) { clearTimeout(ceiling.current); ceiling.current = null }
  }
  useEffect(() => clearCeiling, [])
  // the bulb agreed (bulbs round, so within a point): it drives the bar again
  useEffect(() => {
    if (drag || keying.current || held === null || value === null || Math.abs(value - held) > 1) return
    clearCeiling()
    setHeld(null)
  }, [value, held, drag])

  const hold = (n: number) => {
    last.current = n
    setHeld(n)
    cb.current.onPreview?.(n)
  }
  const commit = () => {
    cb.current.onPreview?.(null)
    clearCeiling()
    ceiling.current = setTimeout(() => { ceiling.current = null; setHeld(null) }, SL_HOLD_MS)
    cb.current.onCommit(last.current)
  }
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(100, Math.round(((clientX - r.left) / Math.max(1, r.width)) * 100)))
  }

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = ref.current
    if (!el) return
    const id = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let mode: 'wait' | 'drag' = 'wait'
    el.dataset.pressed = ''
    const begin = (x: number) => {
      mode = 'drag'
      clearCeiling()
      setDrag(true)
      try { el.setPointerCapture(id) } catch { /* pointer gone */ }
      hold(at(x))
    }
    if (e.pointerType === 'mouse') begin(x0)
    const end = () => {
      delete el.dataset.pressed
      setDrag(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      if (mode === 'wait') {
        const dx = Math.abs(ev.clientX - x0)
        const dy = Math.abs(ev.clientY - y0)
        if (dy > 8 && dy > dx) { end(); return }
        if (dx > 5 && dx >= dy) begin(ev.clientX)
        return
      }
      hold(at(ev.clientX))
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      if (mode === 'wait') clearCeiling()
      hold(at(ev.clientX))
      end()
      commit()
    }
    // the OS took a drag away: keep what the pointer chose; a scroll takeover sends nothing
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      end()
      if (mode === 'drag') commit()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }
  // arrows move the held value; the key up sends it, so a held key is one command
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0
    if (!step) return
    e.preventDefault()
    if (!keying.current) {
      keying.current = true
      clearCeiling()
    }
    hold(Math.max(0, Math.min(100, (unknown ? 50 : v) + step)))
  }
  const keyUp = () => {
    if (!keying.current) return
    keying.current = false
    commit()
  }

  return (
    <div
      ref={ref}
      className="hm-sl"
      data-on={on || undefined}
      data-unknown={unknown || undefined}
      data-drag={drag || undefined}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unknown ? undefined : v}
      aria-valuetext={unknown ? 'brightness unknown' : undefined}
      style={{ '--v': v } as Vars}
      onPointerDown={down}
      onKeyDown={key}
      onKeyUp={keyUp}
      onBlur={keyUp}
    >
      <i className="hm-sl-track" aria-hidden />
      <i className="hm-sl-fill" aria-hidden />
      <i className="hm-sl-head" aria-hidden />
    </div>
  )
}

// ---------- media: the newest backdrop, the posters, downloads ----------

const NEW_MS = 7 * 86_400_000
/** posters in the strip (phone, two columns) */
const STRIP = 6
/** gap between posters, layout px (dashboard.css .hm-posters) */
const POSTER_GAP = 6
/** the poster width the desktop grid aims for, layout px */
const POSTER_W = 84

type ImgState = 'wait' | 'ok' | 'err'

/** An image's load state, per source: 'wait' until it loads, 'ok' once it did, 'err' when it failed or there is none. */
function useImg(src: string | null): [ImgState, (s: ImgState) => void] {
  const [st, setSt] = useState<{ src: string | null; state: ImgState }>({ src, state: 'wait' })
  const state: ImgState = !src ? 'err' : st.src === src ? st.state : 'wait'
  return [state, (next: ImgState) => setSt({ src, state: next })]
}

/** A poster that fades in when its image lands; a hairline frame with the title while it waits or when it has none. */
function Poster({ item, onPress }: { item: PlexRichVM; onPress: () => void }) {
  const [state, setState] = useImg(item.img)
  return (
    <Press className="hm-poster" data-state={state} onPress={onPress} title={`${item.title} · ${item.subtitle}`} aria-label={`${item.title}, open Media`}>
      {item.img && (
        <img src={item.img} alt="" loading="lazy" decoding="async" draggable={false} onLoad={() => setState('ok')} onError={() => setState('err')} />
      )}
      {state !== 'ok' && <span className="hm-poster-t">{item.title}</span>}
    </Press>
  )
}

const kindWord = (k: PlexRichVM['kind']) => (k === 'movie' ? 'movie' : k === 'other' ? 'addition' : 'show')

/**
 * The newest addition as a wide banner: its backdrop (the poster, blurred,
 * when Plex has no backdrop), then what it is, its title, its season or year,
 * episodes, rating and when it came, and two lines of its summary. Opens Media.
 */
function Banner({ item, now, onPress }: { item: PlexRichVM; now: number; onPress: () => void }) {
  const bg = item.art ?? item.img
  const [state, setState] = useImg(bg)
  const meta = [
    item.subtitle,
    item.episodes && item.kind !== 'movie' ? plural(item.episodes, 'episode') : null,
    item.contentRating,
    item.added ? `added ${ago(item.added, now)} ago` : null,
  ].filter(Boolean).join(' · ')
  return (
    <Press className="hm-ban" data-state={state} data-blur={!item.art || undefined} onPress={onPress} aria-label={`Newest ${kindWord(item.kind)}: ${item.title}, ${meta}. Open Media`}>
      {bg && <img className="hm-ban-bg" src={bg} alt="" decoding="async" draggable={false} onLoad={() => setState('ok')} onError={() => setState('err')} />}
      {!item.art && item.img && <img className="hm-ban-poster" src={item.img} alt="" decoding="async" draggable={false} />}
      <span className="hm-ban-text">
        <span className="hm-ban-k">Newest {kindWord(item.kind)}</span>
        <span className="hm-ban-t">{item.title}</span>
        <span className="hm-ban-m">{meta}</span>
        {item.summary && <span className="hm-ban-s">{item.summary}</span>}
      </span>
    </Press>
  )
}

/**
 * How the desktop poster grid fills its box exactly: rows as tall as the box
 * allows, as many across as keep each poster within a few percent of 2:3 (the
 * cover crops the rest), at least four across. Of those, the one whose rows
 * the posters on hand fill completely, then the one nearest POSTER_W wide, so
 * the box never ends in an empty row. `count`: the posters on hand.
 */
function posterGrid(w: number, h: number, count: number): { n: number; rows: number; ph: number } | null {
  let best: { n: number; rows: number; ph: number; score: number } | null = null
  for (let rows = 1; rows <= 6; rows++) {
    const ph = (h - (rows - 1) * POSTER_GAP) / rows
    const pw = ph / 1.5
    if (pw < 40) break
    const n = Math.round((w + POSTER_GAP) / (pw + POSTER_GAP))
    if (n < 4) continue
    const cw = (w - (n - 1) * POSTER_GAP) / n
    const empty = Math.max(0, n * rows - count)
    const score = empty * 50 + Math.abs(cw - POSTER_W) + Math.abs(cw / pw - 1) * 100
    if (!best || score < best.score) best = { n, rows, ph, score }
  }
  return best
}

const dlOrder = (a: DownloadVM, b: DownloadVM) => Number(b.stuck) - Number(a.stuck) || b.progress - a.progress

/** Media in its panel. `banner` (desktop): the newest as a backdrop banner; `fill`: the poster grid takes the height left. */
function MediaBox({ i, banner, fill }: { i: number; banner?: boolean; fill?: boolean }) {
  return (
    <Panel className={cx('hm-glance hm-mediabox', fill && 'hm-grow')} i={i} dense>
      <MediaGlance banner={banner} fill={fill} />
    </Panel>
  )
}

/**
 * Media at a glance: what plays in the page (with play / pause), the newest
 * additions (a strip of posters with the newest named under it; on the
 * desktop the newest as a backdrop banner over a grid of the rest), and every
 * running download (only while one runs). The head opens Media.
 */
function MediaGlance({ banner, fill }: { banner?: boolean; fill?: boolean }) {
  const { go } = useShell()
  const recent = usePlexRecentRich({ grouped: true })
  const queue = useMediaQueue()
  const p = usePlayerNow()
  const now = useTick(30_000)
  const area = useRef<HTMLDivElement>(null)
  const size = useSize(area, !!fill)

  const items = recent.data ?? []
  const newest = items[0] ?? null
  const fresh = items.filter((x) => x.added && now - x.added < NEW_MS).length
  const rAge = oldAge(recent, now, 10 * 60_000)
  const downloads = [...(queue.data?.downloads ?? [])].sort(dlOrder)
  const moving = downloads.filter((d) => !d.stuck).length
  const qAge = oldAge(queue, now)
  const shownDl = downloads.slice(0, 2)
  const open = () => go(MEDIA, 'dashboard')

  const value = downloads.length
    ? <><b>{downloads.length}</b> downloading{downloads.length > moving ? <span className="hm-alert"> · {downloads.length - moving} stuck</span> : null}<Old age={qAge} /></>
    : recent.data
      ? <span className={cx(rAge && 'hm-old')}>{fresh ? <><b>{fresh >= items.length ? `${fresh}+` : fresh}</b> new this week</> : 'Recently added'}<Old age={rAge} /></span>
      : recent.failed ? 'Plex not answering' : '--'

  // the desktop grid: sized from its box once measured, else the strip
  const rest = banner ? items.slice(1) : items
  const grid = fill && size && size.h > 40 ? posterGrid(size.w, size.h, recent.data ? rest.length : 99) : null
  const count = grid ? Math.min(rest.length, grid.n * grid.rows) : STRIP
  const gridStyle: Vars = grid ? { '--n': grid.n, gridAutoRows: `${grid.ph.toFixed(2)}px` } : { '--n': STRIP }

  const posters = recent.data ? (
    items.length ? (
      <span className="hm-posters" data-grid={grid ? '' : undefined} style={gridStyle} data-old={rAge ? '' : undefined}>
        {rest.slice(0, count).map((x) => <Poster key={x.key} item={x} onPress={open} />)}
      </span>
    ) : <span className="hm-quiet hm-media-quiet">Nothing added lately</span>
  ) : recent.failed ? (
    <span className="hm-quiet hm-media-quiet">Plex not answering</span>
  ) : (
    <span className="hm-posters" style={gridStyle} aria-hidden>
      {Array.from({ length: grid ? grid.n * grid.rows : STRIP }, (_, k) => <span key={k} className="hm-poster" data-state="wait" />)}
    </span>
  )

  return (
    <div className="hm-g hm-media" data-banner={banner || undefined}>
      <Press className="hm-g-head hm-media-head" onPress={open} aria-label="Media, open Media">
        <span className="hm-g-label"><HIcon name="media" lit={p.playing || moving > 0} />Media</span>
        <span className="hm-g-value">{value}</span>
        <Chevron />
      </Press>

      {p.item && (
        <div className="hm-now">
          <Press className="hm-now-main" onPress={() => go(MEDIA, 'music')} aria-label={`${p.item.title}, open Music`}>
            <HIcon name="music" lit={p.playing} size={13} />
            <span className="hm-now-text vl-ellipsis">
              <span className="hm-now-t">{p.item.title}</span>
              {p.error ? <span className="hm-alert"> · {cap(p.error)}</span> : p.item.subtitle ? <span className="hm-dim"> · {p.item.subtitle}</span> : null}
            </span>
          </Press>
          <Press className="hm-plate" data-on={p.playing || undefined} aria-pressed={p.playing} aria-label={p.playing ? 'Pause' : 'Play'} onPress={playerActions.toggle}>
            <span className="hm-plate-in"><Glyph name={p.playing ? 'pause' : 'play'} size={10} />{p.playing ? 'Pause' : 'Play'}</span>
          </Press>
        </div>
      )}

      {banner && newest && <Banner item={newest} now={now} onPress={open} />}

      {fill ? <div ref={area} className="hm-mp-area">{posters}</div> : posters}

      {!banner && newest && (
        <span className="hm-media-cap vl-ellipsis">
          <span className="hm-dim">Newest </span>{newest.title}<span className="hm-dim"> · {newest.subtitle}{newest.added ? ` · ${ago(newest.added, now)} ago` : ''}</span>
        </span>
      )}

      {shownDl.map((d, k) => (
        <Press key={`${d.title}-${k}`} className="hm-dl" data-old={qAge ? '' : undefined} onPress={() => go(MEDIA, 'requests')} aria-label={`${d.title}, open Requests`}>
          <span className="hm-dl-head">
            <HIcon name="download" lit={!d.stuck && !qAge} tone={d.stuck ? 'acc2' : undefined} size={13} />
            <span className="hm-dl-title vl-ellipsis">{d.title}</span>
            <span className="hm-dl-val">
              {d.stuck ? <span className="hm-alert">stuck</span> : <><b>{Math.round(d.progress)}</b>%</>}
              {d.timeleft && !d.stuck ? ` · ${d.timeleft}` : ''}
            </span>
          </span>
          <Bar className="hm-dl-bar" value={d.progress} tone={d.stuck ? 'acc2' : 'fg'} />
        </Press>
      ))}
      {downloads.length > shownDl.length && (
        <Press className="hm-dl hm-dl-more" onPress={() => go(MEDIA, 'requests')}>+{downloads.length - shownDl.length} more downloading</Press>
      )}
    </div>
  )
}
