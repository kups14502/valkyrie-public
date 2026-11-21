import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { useIsFetching, useMutation, useQueryClient, type Mutation, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { playerActions, useIntent, usePlayerNow, useShell, type ScreenProps } from '../kit/shell'
import { Bar, Button, Glyph, Panel, Press, cx, dismissToast, toast } from '../kit/ui'
import {
  ago, equityAge, fullest, nyDayKey, onAccount, resetWhen, tradeSession, useCalendar, useHosts, useLaunchTargets, useLights, useLive, useMediaQueue, useOpenTasks, usePlexRecentRich, useSessions, useSwitchStatus, useTick,
  useTrade, useTracker, useUsage,
  type DownloadVM, type EventVM, type HostVM, type Live, type PlexRichVM, type SessionVM, type TargetVM, type TradeSession, type TradeVM,
} from '../kit/data'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { usePalette, useSetting } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import { HOST_POSE, Hero, MODEL_ONLY_IDS, MODEL_ONLY_LABEL, heroModel, hostModel, hotspotSides, useHeat, type HostModelId } from '../kit/hero'
import { diskKey, diskSpot, hasDriveSpots } from '../kit/drives'
import type { HotspotPoint } from '../kit/three'
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
import { taskKey, type Task } from '../../lib/tasksApi'
import { CalendarSheet, type CalendarOpen } from './Calendar'
import { RAVEN_KEY, addToThread, refreshRavenUnread, useRaven, useRavenDraft, type DraftSnap } from '../kit/ravenStore'
import { markRavenRead, ravenBusy, ravenStatusText, sendRaven, type RavenMsg } from '../../lib/ravenApi'
import './dashboard.css'

// Dashboard: one page with everything Valkyrie does, around the device it is
// open on. The stage (DeviceStage) is the 3D model of that device (thor's tower,
// mimir's laptop, the phone, the iPad, the headset), the largest thing on the
// page on every screen, its live numbers tied to its parts by leader lines.
// Phone (one column, in this order): the trade ticker line (the newest session,
// bot online, 7 days), the stage, Raven (its status, the last exchange, a box
// to write it), quick start, upload (pictures to thor, for
// the session just started), lights (one bar for all of them, every bulb, a tap
// switches one, the presets, a plate that switches them all), the daily tracker
// (day stepping, the other day's line, hold Exercise to skip), the calendar
// (the week by day, the next event first; a tap opens the calendar sheet), AI
// (live and asking sessions, usage meters), media (playing or newest added,
// downloads) and every host (CPU / Mem / Disk, battery where the host has one).
// From 600 px: the stage across the top, Raven across under it, two columns under that, the ticker
// becomes the head of a Trade box (equity, the 3D equity chart) and the presets
// get their names.
// Desktop: three columns that reach the bottom of the page, the middle one
// wider: [quick start, Raven, upload, tracker, calendar] [the stage, then AI and the
// hosts side by side] [lights, trade, media]. The trade box keeps its own
// short height; the stage and the poster grid take the height that is left,
// and the calendar lists as many days as its column has room for, so no box
// stretches empty. A 2560 px monitor has the newest addition as a banner over
// the posters.
// iPad (the iPad profile, portrait and landscape): the desktop's three columns,
// whatever its width. Under 1140 px they run tight (a smaller gap, a narrower
// stage column), and a middle column too narrow for AI and the hosts side by
// side stacks them, AI first.

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

// column steps in layout px: two columns from a landscape phone or a narrow
// window, three from a desktop window (and on the iPad from TWO_COLS); past XL
// the three columns grow (a 2560 px monitor), centered, never stretched to the edges
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
  // the iPad gets the desktop's three columns in either orientation, tight under THREE_COLS
  const tablet = useProfile().resolved === 'ipad'
  const cols = width >= THREE_COLS || (tablet && width >= TWO_COLS) ? 3 : width >= TWO_COLS ? 2 : 1
  const wide = cols === 3
  const tight = wide && width < THREE_COLS
  const xl = wide && width >= XL
  const fillH = useFillHeight(box, wide)
  const fill = fillH > 0
  // the calendar sheet (src/v2/screens/Calendar.tsx): opened from the Calendar block, closed when the tab is left
  const [cal, setCal] = useState<CalendarOpen | null>(null)
  const calSeed = useCalendar(7).data
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setCal(null)
  }
  const device = useThisDevice()

  // Phone: the column wrappers dissolve, so the blocks read top to bottom in
  // the order above (the stage, Upload, Quick Start right under it, then Lights).
  // Two columns: the stage across both; the doing column left; trade, AI, media
  // and the hosts right. Three: see the header; each column has one elastic
  // part, so the three end at the bottom of the page together.
  return (
    <div className="hm" ref={box}>
      <div
        className="vl-screen hm-layout"
        data-cols={cols}
        data-xl={xl || undefined}
        data-fill={fill || undefined}
        data-tight={tight || undefined}
        style={fill ? ({ '--hm-h': `${fillH}px` } as Vars) : undefined}
      >
        {cols === 1 ? (
          <>
            <TradeTicker active={active} i={0} />
            <DeviceStage id={device} active={active} i={1} compact />
            <RavenBlock active={active} i={2} />
            <div className="hm-col hm-a">
              <UploadBlock wide={false} />
              <QuickStart />
              <LightsBox i={3} variant="chips" />
              <Tracker />
              <Calendar onOpen={setCal} />
            </div>
            <div className="hm-col hm-b">
              <AiBlock wide={false} i={9} />
              <MediaBox i={10} />
              <Systems i={11} />
            </div>
          </>
        ) : cols === 2 ? (
          <>
            <DeviceStage id={device} active={active} i={0} compact />
            <RavenBlock active={active} i={1} />
            <div className="hm-col hm-a">
              <UploadBlock wide={false} />
              <QuickStart />
              <LightsBox i={3} variant="rows" />
              <Tracker />
              <Calendar onOpen={setCal} />
            </div>
            <div className="hm-col hm-b">
              <TradeBox active={active} i={1} />
              <AiBlock wide={false} i={9} />
              <MediaBox i={10} />
              <Systems i={11} />
            </div>
          </>
        ) : (
          <>
            {/* left: Raven on top with its last few exchanges, then Upload, Quick Start, the tracker,
                and the calendar down to the bottom of the page */}
            <div className="hm-col hm-a">
              <RavenBlock active={active} i={1} turns={3} />
              <UploadBlock wide />
              <QuickStart />
              <Tracker />
              <Calendar onOpen={setCal} fit={fill} />
            </div>
            <div className="hm-col hm-b">
              <DeviceStage id={device} active={active} i={0} fill={fill} />
              {/* under the stage, side by side: what runs (AI) and every other machine */}
              <div className="hm-pair">
                <AiBlock wide i={6} max={xl ? 6 : 4} />
                <Systems i={7} />
              </div>
            </div>
            <div className="hm-col hm-c">
              <LightsBox i={3} variant="rows" />
              <TradeBox active={active} i={5} />
              <MediaBox i={10} banner={xl} fill={fill} />
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

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

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
 * (drag turns it). The box keeps its own short height on every screen: the
 * chart is 120 to 170 px tall with the box's width (dashboard.css), never
 * stretched to fill a column.
 */
function TradeBox({ active, i }: { active: boolean; i: number }) {
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
    <Panel className="hm-glance hm-trade" i={i} dense lit={online && !readAge}>
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
  useLayoutEffect(() => { fire.current = onHold })
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
        label={<><span className="hm-tr-daily">Daily </span><span className="hm-tr-word">Tracker</span></>}
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

// ---------- calendar: the week by day, the next event first, every time in New York time ----------

const NY_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' })
const NY_DAYHEAD = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', month: 'short', day: 'numeric' })
/** "9:30 AM", New York time */
const etClock = (ms: number) => NY_CLOCK.format(ms)
const NY_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
/** "3:00 AM", or "Fri 3:00 AM" when it falls on another New York day than `from` (an end at midnight stays on its day) */
const etEnd = (b: number, from: number) => (nyDayKey(b - 1) === nyDayKey(from) ? etClock(b) : `${NY_WEEKDAY.format(b)} ${etClock(b)}`)
/** "9:30 to 10:00 AM ET", "11:30 AM to 12:15 PM ET", "11:00 PM to Fri 3:00 AM ET" */
function etRange(a: number, b: number): string {
  const x = etClock(a), y = etEnd(b, a)
  const ax = x.slice(-2), by = y.slice(-2)
  return `${ax === by && y === etClock(b) ? x.slice(0, -3) : x} to ${y} ET`
}

/** "2026-11-21" two days after "2026-11-19" */
const keyPlus = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** the instant New York's day `key` starts: 05:00 UTC in winter, 04:00 UTC in summer */
function nyStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d, 5)
  return nyDayKey(t - 3_600_000) === key ? t - 3_600_000 : t
}
/** the day the calendar screen opens on: local midnight of the same date */
const localDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** "in 25 min", "in 1 h 5 min", "in 16 h", "in 2 days" */
function startsIn(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  if (h >= 24) return `in ${plural(Math.round(m / 1440), 'day')}`
  const r = m % 60
  return r && h < 6 ? `in ${h} h ${r} min` : `in ${h} h`
}

/** where an event is, said plainly: no bare link, no "Microsoft Teams Meeting" next to its own Join */
function placeOf(e: EventVM): string {
  const loc = e.location.trim()
  if (/^https?:\/\//i.test(loc)) return ''
  if (e.join && /^(microsoft teams( meeting)?|teams meeting|zoom( meeting)?|google meet|webex( meeting)?)$/i.test(loc)) return ''
  return loc
}

const DAYS = 7

type CalDay = {
  key: string
  /** "Today", "Tomorrow", "Sat, Nov 22" */
  name: string
  /** the date after Today and Tomorrow, else null */
  date: string | null
  allDay: EventVM[]
  /** today: only what has not ended */
  timed: EventVM[]
  /** today: how many timed events are over */
  past: number
}
/** one line of the block: a day's all-day events together, or one timed event */
type CalLine = { day: CalDay; e: EventVM | null }

/** `nextLine`: the line that leads, so an event over midnight leads once, not on each of its days */
type CalView = { days: CalDay[]; lines: CalLine[]; next: EventVM | null; nextLine: CalLine | null; today: CalDay; left: number }

function calendarView(events: EventVM[], now: number): CalView {
  const t0 = nyDayKey(now)
  const days: CalDay[] = Array.from({ length: DAYS }, (_, k) => {
    const key = keyPlus(t0, k)
    const from = nyStart(key)
    const to = nyStart(keyPlus(key, 1))
    const on = events.filter((e) => e.start < to && e.end > from)
    const timed = on.filter((e) => !e.allDay).sort((a, b) => a.start - b.start)
    const mid = from + 12 * 3_600_000
    return {
      key,
      name: k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : NY_DAYHEAD.format(mid),
      date: k < 2 ? NY_DAYHEAD.format(mid) : null,
      allDay: on.filter((e) => e.allDay),
      timed: k === 0 ? timed.filter((e) => e.end > now) : timed,
      past: k === 0 ? timed.filter((e) => e.end <= now).length : 0,
    }
  })
  const lines: CalLine[] = []
  for (const d of days) {
    if (d.allDay.length) lines.push({ day: d, e: null })
    for (const e of d.timed) lines.push({ day: d, e })
  }
  // the event on now, else the next to start: the first timed one that has not ended
  const nextLine = lines.find((l) => l.e && l.e.end > now) ?? null
  return { days, lines, next: nextLine?.e ?? null, nextLine, today: days[0], left: days[0].timed.length }
}

type Fit = { total: number; lo: number; hi: number; n: number }
/** a new search for the most lines that fit: all of them first, the usual case */
const fitAll = (total: number): Fit => ({ total, lo: 0, hi: total, n: total })

/**
 * One step of the search, after `f.n` lines drew and did or did not fit: `lo`
 * is the most known to fit (0 at worst), `hi` the most that still might. Halving
 * the range settles a week of 80 lines in 8 renders; one line per render ran
 * past React's 50 nested updates and crashed the Dashboard.
 */
function fitStep(f: Fit, fits: boolean): Fit {
  if (f.lo === f.hi && f.n === f.lo) {
    // settled: the content grew since (a title wrapped, a task came in): search below
    return fits || f.n === 0 ? f : { ...f, lo: 0, hi: f.n - 1, n: Math.ceil((f.n - 1) / 2) }
  }
  const lo = fits ? f.n : f.lo
  const hi = Math.max(lo, fits ? f.hi : f.n - 1)
  return { ...f, lo, hi, n: lo === hi ? lo : Math.ceil((lo + hi) / 2) }
}

/**
 * How many lines fit: in a fill layout the block sits in a slot that takes
 * the height its column has left (the slot's own size ignores its content).
 * After each draw (before paint) the box is held against the slot and the
 * count searched down until the box fits, so the box keeps its natural height
 * and never runs past the page. A slot that changes size starts over.
 * `content`: changes when the lines' content does (a settled count is checked
 * again). Off: every line.
 */
function useFitLines(slot: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, total: number, on: boolean, content: unknown): number {
  const [fit, setFit] = useState(() => fitAll(total))
  if (fit.total !== total) setFit(fitAll(total))
  const n = fit.total === total ? fit.n : total
  // after each step and each new content: does this count fit? (a settled fit that still fits sets nothing)
  useLayoutEffect(() => {
    const s = slot.current, b = box.current
    if (!on || !s || !b || s.clientHeight <= 0) return
    const check = () => {
      const fits = b.offsetHeight <= s.clientHeight + 1
      setFit((f) => (f.total === total ? fitStep(f, fits) : f))
    }
    check()
  }, [slot, box, on, total, fit, content])
  // the slot resized (the window, the blocks above it): search again from all of them
  useLayoutEffect(() => {
    const s = slot.current
    if (!on || !s) return
    let last = s.clientHeight
    const ro = new ResizeObserver(() => {
      const h = s.clientHeight
      if (Math.abs(h - last) <= 1) return
      last = h
      setFit((f) => fitAll(f.total))
    })
    ro.observe(s)
    return () => ro.disconnect()
  }, [slot, on])
  return on ? Math.min(n, total) : total
}

/** A meeting's Join link: opens the meeting, never the row. */
function Join({ href, title }: { href: string; title: string }) {
  return (
    <a className="hm-join" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Join ${title}`}>Join</a>
  )
}

/** task rows the block lists at most (the head counts the rest) */
const TASK_ROWS = 3

/**
 * What to keep when the block has room for only `n` of its lines, most useful
 * first: the event on now or next, the first due task, the rest of today, the
 * other due tasks, then the coming days in order. Returns the lines kept (shown
 * in their own order) and how many task rows.
 */
function keepLines(view: CalView, tasks: number, n: number): { kept: Set<CalLine>; taskRows: number } {
  const order: (CalLine | 'task')[] = []
  const first = view.nextLine
  if (first) order.push(first)
  if (tasks > 0) order.push('task')
  for (const l of view.lines) if (l !== first && l.day === view.today) order.push(l)
  for (let k = 1; k < tasks; k++) order.push('task')
  for (const l of view.lines) if (l !== first && l.day !== view.today) order.push(l)
  const kept = new Set<CalLine>()
  let taskRows = 0
  for (const x of order.slice(0, n)) {
    if (x === 'task') taskRows++
    else kept.add(x)
  }
  return { kept, taskRows }
}

/**
 * The calendar block: the coming seven days under day headings (Today,
 * Tomorrow, then the weekday and date), empty days left out. A day's all-day
 * events share one line; a timed event is one row: its New York time, its
 * title, where it is or a Join link when it is a meeting. The event on now or
 * the next to start leads its day, larger, with "Now" or "in 25 min". Today's
 * due tasks follow today. A day heading opens the calendar on that day; an
 * event opens it there with its details. `fit` (three columns: a monitor or
 * the iPad): as many lines as the column has room for (keepLines picks which),
 * then "+N more"; the box reaches the bottom of its column.
 * Otherwise up to `max` events.
 */
function Calendar({ onOpen, fit, max = 10 }: { onOpen: (o: CalendarOpen) => void; fit?: boolean; max?: number }) {
  const cal = useCalendar(DAYS)
  const now = useTick(30_000)
  const due = useDueTasks(now)
  const events = cal.data
  const view = useMemo(() => (events ? calendarView(events, now) : null), [events, now])
  const slot = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const taskMax = Math.min(TASK_ROWS, due?.due.length ?? 0)
  const total = view?.lines.length ?? 0
  const room = useFitLines(slot, box, total + taskMax, !!fit && !!view, view)
  const keep = view ? (fit ? keepLines(view, taskMax, room) : { kept: keepLines(view, 0, max).kept, taskRows: taskMax }) : null
  const taskRows = keep?.taskRows ?? taskMax
  const age = cal.failed ? oldAge(cal, now) : null
  const open = (key: string, focus?: string) => onOpen({ day: localDay(key), focus: focus ?? null })
  const todayKey = nyDayKey(now)
  const next = view?.next ?? null
  const isLive = !!next && next.start <= now
  const firstUp = view && isLive ? view.lines.find((l) => l.e && l.e !== next && l.e.start > now)?.e ?? null : null

  const lines = view?.lines ?? []
  const hidden = lines.filter((l) => !keep?.kept.has(l))
  const byDay = new Map<string, CalLine[]>()
  for (const l of lines) if (keep?.kept.has(l)) byDay.set(l.day.key, [...(byDay.get(l.day.key) ?? []), l])
  const today = view?.today

  const value = !view ? null
    : view.left > 0 ? <><b>{view.left}</b> left today</>
      : today && (today.past > 0 || today.allDay.length) ? 'Nothing left today' : 'Nothing today'

  const row = (l: CalLine) => {
    const d = l.day
    if (!l.e) {
      const titles = d.allDay.map((e) => e.title || 'Busy')
      return (
        <div key={`${d.key}-all`} className="hm-crow" data-allday="">
          <Press className="hm-crow-main" onPress={() => open(d.key, d.allDay.length === 1 ? d.allDay[0].id : undefined)} aria-label={`${d.name}, all day: ${titles.join(', ')}. Open the day`}>
            <span className="hm-ctime">All day</span>
            <span className="hm-ctitle">{titles.join(' · ')}</span>
          </Press>
        </div>
      )
    }
    const e = l.e
    const title = e.title || 'Busy'
    const place = placeOf(e)
    const live = e.start <= now && e.end > now
    if (l === view?.nextLine) {
      return (
        <div key={e.id} className="hm-cnext" data-live={live || undefined} data-join={e.join ? '' : undefined}>
          <Press className="hm-cnext-main" onPress={() => open(d.key, e.id)} aria-label={`${title}, ${live ? `on now until ${etEnd(e.end, now)} ET` : `${startsIn(e.start - now)}, ${etRange(e.start, e.end)}`}. Open its details`}>
            <span className="hm-cnext-top">
              <span className="hm-cnext-title">{title}</span>
              <span className="hm-cnext-when">{live ? 'Now' : startsIn(e.start - now)}</span>
            </span>
            <span className="hm-cnext-meta">
              {live ? `Until ${etEnd(e.end, now)} ET` : etRange(e.start, e.end)}
              {place && <span className="hm-cplace"> · {place}</span>}
            </span>
          </Press>
          {e.join && <Join href={e.join} title={title} />}
        </div>
      )
    }
    return (
      <div key={e.id} className="hm-crow">
        <Press className="hm-crow-main" onPress={() => open(d.key, e.id)} aria-label={`${title}, ${d.name} ${e.start < nyStart(d.key) ? 'continued' : `at ${etClock(e.start)} ET`}${place ? `, ${place}` : ''}. Open its details`}>
          <span className="hm-ctime" style={e.color ? { borderLeftColor: e.color } : undefined} title={e.source || undefined}>
            {e.start < nyStart(d.key) ? 'Cont.' : etClock(e.start)}
          </span>
          <span className="hm-ctitle">{title}</span>
          {place && <span className="hm-cplace">{place}</span>}
          {live ? <span className="hm-cnow">Now</span> : e === firstUp ? <span className="hm-csoon">{startsIn(e.start - now)}</span> : null}
        </Press>
        {e.join && <Join href={e.join} title={title} />}
      </div>
    )
  }

  const dayGroup = (d: CalDay) => {
    const lines = byDay.get(d.key)
    if (!lines) return null
    return (
      <div key={d.key} className="hm-cday">
        <Press className="hm-cday-head" onPress={() => open(d.key)} aria-label={`${d.name}${d.date ? `, ${d.date}` : ''}. Open the day`}>
          <span className="hm-cday-name">{d.name}</span>
          {d.date && <span className="hm-cday-date">{d.date}</span>}
        </Press>
        {lines.map(row)}
        {d.key === todayKey && d.past > 0 && !hidden.length && (
          <Press className="hm-cearlier" onPress={() => open(d.key)}>{d.past} earlier today</Press>
        )}
      </div>
    )
  }

  const body = (
    <Panel className="hm-glance hm-cal" lit={isLive} i={8} dense>
      <Press className="hm-g-head hm-g-press" onPress={() => open(todayKey)} aria-label="Calendar, open today's day view. Times are New York time">
        <span className="hm-g-label" data-lit={isLive || undefined}><HIcon name="calendar" lit={isLive} />Calendar<span className="hm-cal-tz">ET</span></span>
        <span className="hm-g-value">{value}<Old age={age} /></span>
        <Chevron />
      </Press>
      <div className="hm-cal-body">
        {!view ? (
          <p className="hm-quiet">{cal.failed ? 'Calendar not answering' : 'Reading the calendar'}</p>
        ) : (
          <>
            {today && dayGroup(today)}
            {/* its own source: today's tasks right under today */}
            {due && <TasksGlance due={due} rows={taskRows} now={now} />}
            {view.days.slice(1).map(dayGroup)}
            {hidden.length > 0 && (
              <Press className="hm-cmore" onPress={() => open(hidden[0].day.key)} aria-label={`${hidden.length} more this week, open ${hidden[0].day.name}`}>
                +{hidden.length} more this week
              </Press>
            )}
            {!total && (
              <Press className="hm-cempty" onPress={() => open(todayKey)}>Nothing in the next {DAYS} days</Press>
            )}
          </>
        )}
        {!view && due && <TasksGlance due={due} rows={taskRows} now={now} />}
      </div>
    </Panel>
  )

  if (!fit) return body
  return (
    <div className="hm-cal-slot" ref={slot}>
      <div className="hm-cal-box" ref={box}>{body}</div>
    </div>
  )
}

type DueTasks = { open: number; due: Task[]; late: number }

/** The open tasks (screens/Tasks.tsx) that are overdue or due today; null until the list has loaded once. */
function useDueTasks(now: number): DueTasks | null {
  const list = useOpenTasks().data?.tasks
  if (!list) return null
  const due = list.filter((t) => t.due && dueState(t.due, now) !== 'soon' && dueState(t.due, now) !== 'later')
  return { open: list.length, due, late: due.filter((t) => dueState(t.due!, now) === 'overdue').length }
}

/**
 * The Calendar block's tasks: a line with what is overdue, what is due today and how many are
 * open, then up to `rows` of the overdue or due-today tasks. All of it opens /m/tasks.
 */
function TasksGlance({ due: d, rows, now }: { due: DueTasks; rows: number; now: number }) {
  const navigate = useNavigate()
  const { due, late } = d
  const go = () => navigate('/m/tasks', { state: { v2Back: true } })
  const parts = [
    late ? { text: `${late} overdue`, late: true } : null,
    due.length - late ? { text: `${due.length - late} due today`, late: false } : null,
    { text: `${d.open} open`, late: false },
  ].filter((x): x is { text: string; late: boolean } => x !== null)
  return (
    <div className="hm-tasks">
      <Press className="hm-ahead-head hm-tasks-head" onPress={go} aria-label={`Tasks: ${parts.map((x) => x.text).join(', ')}. Open the list`}>
        <span className="vl-caps">Tasks</span>
        <span>
          {parts.map((x, k) => <span key={x.text} data-late={x.late || undefined}>{k ? ' · ' : ''}{x.text}</span>)}
        </span>
      </Press>
      {due.slice(0, rows).map((t) => {
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

// ---------- Raven: his assistant's status, the last exchange, a box to write it ----------

const RAVEN = 'raven'
const LIST_MARK = /^([-*+]|\d+[.)])\s+/

/**
 * A message as one plain run of text for the block: Markdown marks out. A list item, or a new paragraph,
 * after text that ends without a stop joins with " · ", so two thoughts never run together as one sentence.
 */
function ravenPlain(m: RavenMsg): string {
  let out = ''
  let gap = false
  for (const raw of m.text.replace(/```[\s\S]*?```/g, ' ').split('\n')) {
    const item = LIST_MARK.test(raw.trim())
    const line = raw.trim().replace(LIST_MARK, '').replace(/^(#+|>)\s*/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*+|`+|~~|__/g, '').trim()
    if (!line) {
      gap = true
      continue
    }
    out = out ? `${out}${(item || gap) && !/[.!?:]$/.test(out) ? ' · ' : ' '}${line}` : line
    gap = false
  }
  const n = m.meta.files?.length ?? 0
  return out || (n ? `${n} ${n === 1 ? 'file' : 'files'}` : '')
}

/** the Raven block's exchange window: data-more (a faded top edge) while it is scrolled past its first line */
const moreAbove = (el: HTMLElement) => el.toggleAttribute('data-more', el.scrollTop > 1)

/** the height a monitor's left column keeps for the calendar under Raven: its head, Today with the next event, the tasks line, "+N more" */
const CAL_ROOM = 200

/**
 * A monitor: the most px the Raven block's exchange window can take so the left
 * column still ends at the bottom of the page with CAL_ROOM left for the
 * calendar. The column is the fill height (--hm-h on the layout, less its
 * padding); the blocks beside Raven and Raven's own head and box are measured,
 * none of which depend on the window, so this never feeds back. null when the
 * layout does not fill.
 */
function useLogRoom(sec: RefObject<HTMLElement | null>, log: RefObject<HTMLElement | null>, on: boolean): number | null {
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = sec.current
    const win = log.current
    const col = el?.parentElement
    const lay = col?.parentElement
    if (!on || !el || !win || !col || !lay) return
    const px = (v: string) => parseFloat(v) || 0
    const measure = () => {
      const fillH = px(lay.style.getPropertyValue('--hm-h'))
      let r: number | null = null
      if (fillH > 0) {
        const kids = [...col.children] as HTMLElement[]
        const others = kids.reduce((s, k) => (k === el || k.classList.contains('hm-cal-slot') ? s : s + k.offsetHeight), 0)
        const gaps = px(getComputedStyle(col).rowGap) * (kids.length - 1)
        const ls = getComputedStyle(lay)
        r = Math.floor(fillH - px(ls.paddingTop) - px(ls.paddingBottom) - others - gaps - (el.offsetHeight - win.offsetHeight) - CAL_ROOM)
      }
      setRoom((cur) => (cur === r ? cur : r))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(lay)
    for (const k of col.children) ro.observe(k)
    return () => ro.disconnect()
  }, [sec, log, on])
  return on ? room : null
}

type Turn = { me: RavenMsg | null; reply: RavenMsg | null }

/**
 * His last `n` lines, oldest first, each with Raven's newest own reply before his next line (relays are
 * not part of an exchange). No line from him yet: Raven's newest own line alone.
 */
function lastTurns(messages: RavenMsg[], n: number): Turn[] {
  const mine = messages.filter((m) => m.author === 'brendon').slice(-n)
  const own = messages.filter((m) => m.author === 'raven' && !m.meta.relay)
  if (!mine.length) {
    const reply = own.at(-1)
    return reply ? [{ me: null, reply }] : []
  }
  return mine.map((me, k) => {
    const until = mine[k + 1]?.id ?? Infinity
    return { me, reply: own.findLast((m) => m.id > me.id && m.id < until) ?? null }
  })
}

/**
 * Raven on the Dashboard, where the corner button would be (kit/raven.tsx
 * hides it here): the heading with Raven's live status (the Raven screen's
 * words), his last `turns` lines each with Raven's reply (each clipped), and
 * the box. One exchange and a one-line box on the phone and in two columns;
 * three columns (a monitor, the iPad) show the last few in a window that scrolls (newest at the bottom)
 * over a two-line box. A send goes the Raven screen's way (source app) and the
 * reply shows here when it lands. The heading opens the conversation;
 * Ctrl+Shift+Space and the palette's "Message Raven" focus the box.
 */
function RavenBlock({ active, i, turns = 1 }: { active: boolean; i: number; turns?: number }) {
  const { go } = useShell()
  const qc = useQueryClient()
  // the long-poll only while a reply is due (below); otherwise the slow re-read and the app coming back to the front
  const [live, setLive] = useState(false)
  const q = useRaven(active, live)
  const page = q.data
  // the thread's draft, the same text as the Raven tab's box and kept on the device; this box sends text only,
  // so files attached on the Raven tab stay there for its own send
  const draft = useRavenDraft()
  const text = draft.text
  const [sentId, setSentId] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const sec = useRef<HTMLElement>(null)
  const log = useRef<HTMLDivElement>(null)
  useIntent('raven:compose', () => box.current?.focus(), active)

  const send = useMutation({
    mutationFn: (snap: DraftSnap) => sendRaven({ text: snap.text.trim(), source: 'app' }),
    onSuccess: (m, snap) => {
      draft.markSent(snap)
      setSentId(m.id)
      addToThread(qc, { messages: [m] })
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    },
    onError: (e) => toast(apiErrorText(e, 'Raven did not answer'), { ms: 4000 }),
  })
  const line = text.trim()
  const submit = () => {
    if (line && !send.isPending) send.mutate({ text, ids: [] })
  }

  const busy = ravenBusy(page)
  const failed = q.isError && !page
  const status = failed ? 'not answering' : page ? ravenStatusText(page) : '--'
  const list = useMemo(() => lastTurns(page?.messages ?? [], turns), [page?.messages, turns])
  const { me, reply } = list.at(-1) ?? { me: null, reply: null }
  // a reply is due: a line sent from here has none yet, or Raven is at work
  const due = busy || (!!sentId && me?.id === sentId && !reply)
  if (due !== live) setLive(due)
  // the window opens on the newest line, and comes back to it when a line lands or Raven starts or stops;
  // data-more fades its top edge while there is more above
  const shown = list.map((x) => `${x.me?.id ?? 0}.${x.reply?.id ?? 0}`).join()
  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    moreAbove(el)
  }, [shown, busy])
  // and when the window itself changes size (on a monitor it gives way to the blocks under it)
  const hasLog = !!page && list.length > 0
  useLayoutEffect(() => {
    const el = log.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight
      moreAbove(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasLog])
  const room = useLogRoom(sec, log, turns > 1 && hasLog)

  // a reply to a line sent from here is read once it shows (the quick sheet's rule), so the tab's badge does not count it
  const replyId = sentId && me?.id === sentId ? reply?.id ?? 0 : 0
  const unread = page?.unread ?? 0
  useEffect(() => {
    if (!active || !replyId || !unread) return
    void markRavenRead(replyId).then(() => refreshRavenUnread(qc), () => { /* the badge stays until the next read */ })
  }, [active, replyId, unread, qc])

  return (
    // a boxed panel like Calendar, so the chat reads apart from the plain sections around it (his ask, 11-19)
    <section ref={sec} className="vl-panel hm-sec hm-rv" data-dense="" data-lit={busy || undefined} data-turns={turns > 1 || undefined} aria-label="Raven">
      <Press className="hm-head hm-rv-head vl-build" style={bi(i)} onPress={() => go(RAVEN)} aria-label={`Raven${page || failed ? `, ${status}` : ''}, open the conversation`}>
        <span className="hm-head-label" data-lit={busy || undefined}><HIcon name="raven" lit={busy} />Raven</span>
        <span className="hm-head-value hm-rv-status" data-busy={busy || undefined} data-state={failed ? 'error' : page?.status} title={status}>
          <span className="vl-ellipsis">{status}</span>
          <Chevron />
        </span>
      </Press>
      {hasLog ? (
        // the scroller wraps the grid: a grid with a height cap would squeeze its rows instead of scrolling
        <div
          className="hm-rv-log vl-build"
          style={{ ...bi(i + 1), ...(room !== null ? { '--rv-room': `${room}px` } : null) } as Vars}
          ref={log}
          onScroll={(e) => moreAbove(e.currentTarget)}
        >
          <div className="hm-rv-x">
            {list.map((x, k) => (
              <Fragment key={x.me?.id ?? x.reply?.id}>
                {k > 0 && <i className="hm-rv-sep" aria-hidden />}
                {x.me && (
                  <>
                    <span className="hm-rv-who">You</span>
                    <p className="hm-rv-text" data-who="me">{ravenPlain(x.me)}</p>
                  </>
                )}
                {x.reply ? (
                  <>
                    <span className="hm-rv-who">Raven</span>
                    <p className="hm-rv-text" data-who="raven" data-error={x.reply.meta.error ? '' : undefined}>{ravenPlain(x.reply)}</p>
                  </>
                ) : k === list.length - 1 && (
                  <>
                    <span className="hm-rv-who">Raven</span>
                    {busy ? <p className="hm-rv-text hm-rv-wait" data-who="raven"><span className="hm-rv-pulse" aria-hidden />{status}</p>
                      : <p className="hm-rv-text hm-dim" data-who="raven">No reply yet</p>}
                  </>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      ) : (
        <p className="hm-quiet vl-build" style={bi(i + 1)}>{failed ? `Raven is not answering: ${apiErrorText(q.error, 'no reply from Valkyrie')}` : page ? 'Nothing yet. Ask Raven anything.' : 'Reading Raven'}</p>
      )}
      <form className="hm-rv-form vl-build" style={bi(i + 1)} onSubmit={(e) => { e.preventDefault(); submit() }}>
        <textarea
          ref={box}
          className="hm-rv-box"
          rows={turns > 1 ? 2 : 1}
          value={text}
          onChange={(e) => draft.setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            submit()
          }}
          placeholder="Message Raven"
          aria-label="Message Raven"
          enterKeyHint="send"
          autoComplete="off"
        />
        <Button kind="line" lit={!!line} type="button" className="hm-rv-send" disabled={!line || send.isPending} onPress={submit}>Send</Button>
      </form>
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
  const at = resetWhen(iso, now)
  return at ? `Resets ${at}` : ''
}

/**
 * AI: the live sessions (asking first, then working; desktop adds the idle
 * ones) and the usage meters of the account thor runs on now (the hottest
 * account is the fallback, tagged "busiest"). The head and the rows open
 * AI > Sessions, the meters AI > Usage.
 */
function AiBlock({ wide, i, max }: { wide: boolean; i: number; max?: number }) {
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
  const shown = list.slice(0, max ?? (wide ? 8 : 3))
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
 * System > Hosts with that host picked.
 */
function Systems({ i }: { i: number }) {
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
 * either has reported). On a model with a slot per drive (thor's tower) each
 * drive gets its own number, keyed by its hotspot (disk.C), so each line ends
 * on that drive's own M.2.
 */
function deviceCells(h: HostVM, model?: HostModelId | null): HostCell[] {
  const b = h.battery
  const bat: HostCell[] = b
    ? [{ key: 'bat', icon: b.charging ? 'charging' : 'battery', label: b.charging ? 'Battery, charging' : 'Battery', v: b.percent, alert: !b.charging && b.percent <= 15 }]
    : []
  const disk = (label: string): HostCell => ({ key: 'disk', icon: 'disk', label, v: h.disk, alert: (h.disk ?? 0) >= 90 })
  if (reportsBatteryOnly(h)) return [...bat, ...(b || h.disk != null ? [disk('Storage')] : [])]
  const drives = model && h.disks.length > 1 && hasDriveSpots(heroModel(model))
    ? h.disks.map((d, k): HostCell => ({ key: diskKey(d.name ?? `#${k + 1}`), icon: 'disk', label: d.name ? `Disk ${d.name}` : `Disk ${k + 1}`, v: d.percent, alert: d.percent >= 90 }))
    : [disk(diskWord(h))]
  return [
    { key: 'cpu', icon: 'cpu', label: 'CPU', v: h.cpu, alert: false },
    { key: 'mem', icon: 'mem', label: 'Memory', v: h.mem, alert: (h.mem ?? 0) >= 90 },
    ...drives,
    ...bat,
  ]
}

/** "25.4 / 31.1 GB" (GiB, as Windows and htop show memory; System > Hosts words it the same) */
const memSizes = (h: HostVM) => (h.memUsedGb != null && h.memTotalGb != null ? `${h.memUsedGb.toFixed(1)} / ${h.memTotalGb.toFixed(1)} GB` : null)

/** "3.1 / 4.0 TB", "101 / 256 GB" (decimal, as drives are sold; as System > Hosts words it): the fullest disk's */
const diskSizes = (h: HostVM): string | null => gbSizes(h.diskUsedGb, h.diskTotalGb)

/** used / total GiB as diskSizes words them */
function gbSizes(usedGb: number | null, totalGb: number | null): string | null {
  if (usedGb == null || totalGb == null) return null
  const dec = (gib: number) => (gib * 1024 ** 3) / 1e9
  const one = (gb: number, unit: 'TB' | 'GB') => (unit === 'TB' ? (gb / 1000).toFixed(1) : gb >= 10 ? gb.toFixed(0) : gb.toFixed(1))
  const used = dec(usedGb), total = dec(totalGb)
  const tu = total >= 1000 ? 'TB' : 'GB'
  const uu = used >= 100 && tu === 'TB' ? 'TB' : 'GB'
  return uu === tu ? `${one(used, uu)} / ${one(total, tu)} ${tu}` : `${one(used, uu)} ${uu} / ${one(total, tu)} ${tu}`
}

/** what a number is out of: the cores, used / total, charging */
function cellSizes(h: HostVM, key: string): string | null {
  if (key === 'cpu') return h.cores ? `${h.cores} cores` : null
  if (key === 'mem') return memSizes(h)
  if (key === 'disk') return diskSizes(h)
  if (key.startsWith('disk.')) {
    const d = h.disks.find((x, k) => diskKey(x.name ?? `#${k + 1}`) === key)
    return d ? gbSizes(d.usedGb, d.totalGb) : null
  }
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

/** a stage from this height (layout px) sets its name and numbers larger and gives the last hour more room */
const DEV_TALL = 520

/** the hotspot of the model (kit/three/models) each number sits on */
const SPOT_OF: Record<string, string> = { cpu: 'cpu', mem: 'mem', disk: 'disk', bat: 'battery' }

type ReadSlots = { order: string[]; slot: Record<string, { side: 'l' | 'r'; spot: number }> }
/** one layout per set of numbers, model and pose, so the same set always gets the same object */
const slotCache = new Map<string, ReadSlots>()

/**
 * Where each number goes around the model. The numbers stand left and right
 * of it, each tied to its part by a leader line, so a number goes to the side
 * its part is on (as the model stands in `pose`) and each side reads top to
 * bottom in the parts' order: the lines never cross. `order` is the left side
 * top to bottom, then the right. spot: the part's index in the model's
 * hotspots, -1 for a number with no part. `keyList`: the numbers' keys, comma
 * separated.
 */
function readSlots(keyList: string, model: HostModelId | null, pose: string): ReadSlots {
  const id = `${keyList}|${model ?? ''}|${pose}`
  const hit = slotCache.get(id)
  if (hit) return hit
  const keys = keyList ? keyList.split(',') : []
  const at = model ? hotspotSides(model, pose) : {}
  const spots = model ? heroModel(model).hotspots : []
  const all = keys.map((key, k) => {
    // the one disk number: the model's disk, or on thor's tower its system drive's slot
    const id = key === 'disk' && model ? diskSpot(heroModel(model), null) ?? key : SPOT_OF[key] ?? key
    return { key, spot: spots.findIndex((s) => s.id === id), x: at[id]?.x ?? (k + 0.5) / keys.length, y: at[id]?.y ?? k }
  })
  const byX = [...all].sort((a, b) => a.x - b.x)
  const nl = Math.ceil(all.length / 2)
  const out: ReadSlots = { order: [], slot: {} }
  for (const [side, list] of [['l', byX.slice(0, nl)], ['r', byX.slice(nl)]] as const) {
    for (const c of [...list].sort((a, b) => a.y - b.y)) {
      out.order.push(c.key)
      out.slot[c.key] = { side, spot: c.spot }
    }
  }
  slotCache.set(id, out)
  return out
}

/**
 * This device: the Dashboard's stage. The x-ray model of the machine the page
 * runs on, as large as its place allows, glowing by the live load (Hero, as on
 * System > Hosts), with its name, state and uptime in the corner and its live
 * numbers standing around it, each tied by a leader line to the part it reads
 * (CPU, memory, disk, battery) and following that part as the model turns.
 * A drag on the model turns it (on a touch screen sideways only: up and down
 * scroll the page), and it eases back. A tap anywhere on the stage opens System >
 * Hosts with this device picked.
 * Monitor (`fill`): the middle column's elastic part, the last hour of CPU and
 * memory along its foot. The iPad: the same.
 * Phone and two columns (`compact`): a band across the top of the page.
 * The phone and tablet report two numbers at most: the tablet's stand in the
 * stage's lower corners (`foot`), so the wide slab keeps the whole width.
 */
function DeviceStage({ id, active, i, compact, fill }: { id: HostModelId | null; active: boolean; i: number; compact?: boolean; fill?: boolean }) {
  const hosts = useHosts()
  const open = useOpenHost()
  const now = useTick(30_000)
  const anchor = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  // The hero fits the model from client rects, which the build-in tilt skews
  // while it plays; each time the build-in ends (or is cut short: the page
  // drops data-building), it measures again.
  const [built, setBuilt] = useState(0)
  useEffect(() => {
    const el = inRef.current?.closest('.vl-build')
    if (!el) return
    const done = (e: Event) => { if (e.target === el) setBuilt((n) => n + 1) }
    el.addEventListener('animationend', done)
    el.addEventListener('animationcancel', done)
    return () => {
      el.removeEventListener('animationend', done)
      el.removeEventListener('animationcancel', done)
    }
  }, [])
  // the same online test the model glows by
  const { online } = useHeat(id ?? '')
  const h = id ? hosts.data?.find((x) => x.id === id) ?? null : null
  const model = id ? hostModel(id) : null
  const label = h ? cap(h.label) : id ? DEVICE_LABEL[id] : 'This device'
  const stale = !!h && h.online && h.stale
  const cells = h && online ? deviceCells(h, model) : []
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
  const old = oldAge(hosts, now, 60_000)
  // the last hour of CPU and memory (System > Hosts' sparkline), x by the server's clock up to its newest sample
  const histOn = !compact && !!h && online && h.history.length > 1
  const t1 = histOn ? h.history[h.history.length - 1].t : now
  const hour = histOn ? h.history.filter((p) => p.t >= t1 - HOUR - 30_000) : []
  const hasMem = hour.some((p) => p.mem != null)
  const peak = hour.length > 1 ? Math.round(Math.max(h?.cpu ?? 0, ...hour.map((p) => p.cpu ?? 0))) : null
  const size = useSize(inRef)
  const tall = !!size && size.h >= DEV_TALL

  // the numbers around the model, and the line from each to its part
  const keys = cells.map((c) => c.key).join(',')
  const pose = model ? devicePose(model) : 'device'
  const slots = readSlots(keys, model, pose)
  const reads = slots.order.map((k) => cells.find((c) => c.key === k)).filter((c): c is HostCell => !!c)
  // two numbers at most beside a wide slab: they stand in the lower corners
  const foot = cells.length > 0 && cells.length <= 2 && model !== 'phone'
  const [hot, setHot] = useState<string | null>(null)
  const slotsRef = useRef(slots)
  const lineEls = useRef<Record<string, SVGGElement | null>>({})
  const barEls = useRef<Record<string, HTMLElement | null>>({})
  /** where each number's line starts (the inner end of its bar), in the scene's own px */
  const ends = useRef<Record<string, { x: number; y: number; dir: 1 | -1 }>>({})
  const drawn = useRef<Record<string, string>>({})

  useLayoutEffect(() => {
    slotsRef.current = slots
    const root = inRef.current
    if (!root) return
    // Layout offsets, not client rects: the scene draws in the stage's own layout px, which
    // neither the UI zoom nor the build-in tilt changes (a rect read mid-tilt put the lines off their bars).
    const measure = () => {
      const next: typeof ends.current = {}
      for (const key of slots.order) {
        const bar = barEls.current[key]
        if (!bar || bar.offsetWidth <= 0) continue
        let x = 0, y = 0
        for (let el: HTMLElement | null = bar; el && el !== root; el = el.offsetParent as HTMLElement | null) {
          x += el.offsetLeft
          y += el.offsetTop
        }
        const left = slots.slot[key].side === 'l'
        next[key] = { x: left ? x + bar.offsetWidth + 4 : x - 4, y: y + bar.offsetHeight / 2, dir: left ? 1 : -1 }
      }
      ends.current = next
      drawn.current = {}
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [slots, built, tall, foot, histOn])

  // every drawn frame: each line from its number to its part, written straight to the SVG (no render)
  const place = useCallback((pts: readonly HotspotPoint[]) => {
    const sl = slotsRef.current
    for (const key of sl.order) {
      const g = lineEls.current[key]
      if (!g) continue
      const p = pts[sl.slot[key].spot]
      const e = ends.current[key]
      const sig = p?.ok && e ? `${e.x.toFixed(1)} ${e.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.o}` : ''
      if (drawn.current[key] === sig) continue
      drawn.current[key] = sig
      if (!sig || !p || !e) { g.style.opacity = '0'; continue }
      const mid = e.x + e.dir * Math.min(18, Math.abs(p.x - e.x) * 0.4)
      g.firstElementChild?.setAttribute('d', `M${e.x.toFixed(1)} ${e.y.toFixed(1)}H${mid.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      g.lastElementChild?.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(45)`)
      // a part on the far side of the model: its line a step back
      g.style.opacity = p.o < 1 ? '0.45' : '1'
    }
  }, [])

  // a tap (not a drag that turned the model, not the head's own press) opens System > Hosts
  const downAt = useRef<{ x: number; y: number; t: number } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    downAt.current = e.pointerType === 'mouse' && e.button !== 0 ? null : { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = downAt.current
    downAt.current = null
    if (!d || !id || (e.target as Element).closest('button')) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || e.timeStamp - d.t > 700) return
    open(id)
  }

  const row = (c: HostCell) => {
    const sz = h ? cellSizes(h, c.key) : null
    const spot = slots.slot[c.key]?.spot ?? -1
    return (
      <span
        key={c.key}
        className="hm-dev-row"
        data-k={c.key}
        data-spot={model && spot >= 0 ? heroModel(model).hotspots[spot]?.id : undefined}
        data-alert={c.alert || undefined}
        data-hot={hot === c.key || undefined}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHot(c.key) }}
        onPointerLeave={() => setHot((cur) => (cur === c.key ? null : cur))}
      >
        <span className="hm-dev-k"><Icon name={c.icon} size={tall ? 13 : 12} tone={c.alert ? 'acc2' : 'dim'} className="hm-ic" />{c.key === 'bat' ? 'Battery' : c.label}</span>
        <span className="hm-mini-v">{c.v != null ? <>{c.v}<small>%</small></> : '--'}</span>
        <span ref={(el) => { barEls.current[c.key] = el }} className="hm-mini-bar" style={{ '--v': c.v ?? 0 } as Vars} data-empty={c.v == null || undefined}><i /></span>
        <span className="hm-dev-sz vl-ellipsis">{sz}</span>
      </span>
    )
  }

  return (
    <section className={cx('hm-stage vl-build', fill && 'hm-grow')} style={bi(i)}>
      <div
        ref={inRef}
        className="hm-dev-in"
        data-reads={foot ? 'foot' : 'side'}
        data-model={model ?? undefined}
        data-compact={compact || undefined}
        data-tall={tall || undefined}
        data-bare={!reads.length || undefined}
        data-state={online ? 'on' : stale ? 'stale' : 'off'}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => { downAt.current = null }}
      >
        {model && <div ref={anchor} className="hm-dev-anchor" aria-hidden />}
        {model && (
          <div className="hm-dev-scene" aria-hidden>
            <Hero
              active={active}
              pose={pose}
              host={model}
              anchor={anchor}
              fill={0.94}
              scrim={0}
              orbitTouch="pan-y"
              showHotspots={false}
              onPlace={place}
              idleFps={24}
              layoutKey={`${model}:${compact ? 'c' : 'f'}:${foot ? 'foot' : 'side'}:${reads.length}:${tall ? 't' : 's'}:${histOn ? 'h' : ''}:${built}`}
              className="absolute inset-0"
            >
              <svg className="hm-dev-lines" aria-hidden>
                {reads.filter((c) => slots.slot[c.key].spot >= 0).map((c) => (
                  <g key={c.key} ref={(el) => { lineEls.current[c.key] = el }} data-k={c.key} data-alert={c.alert || undefined} data-hot={hot === c.key || undefined}>
                    <path />
                    <rect x={-3.5} y={-3.5} width={7} height={7} />
                  </g>
                ))}
              </svg>
            </Hero>
          </div>
        )}
        <Press className="hm-dev-press" disabled={!id} onPress={() => { if (id) open(id) }} aria-label={`This device, ${label}: ${said}. Open in System`}>
          <span className="hm-dev-top">
            <span className="hm-dev-cap" data-lit={online || undefined}>
              <HIcon name={hostIcon(id ?? 'thor')} lit={online} size={compact ? 12 : 14} />This device
            </span>
            <Chevron />
          </span>
          <span className="hm-dev-name vl-ellipsis">{label}</span>
          <span className="hm-dev-state" data-state={online ? 'on' : stale ? 'stale' : 'off'}>
            <span>{state}</span>{detail && <span className="hm-dim"> · {detail}</span>}
          </span>
          {noBattery && <span className="hm-dev-hint"><Icon name="battery" size={12} tone="dim" className="hm-ic" />No battery reading yet</span>}
          {!compact && !cells.length && !noBattery && h && <span className="hm-dev-off">No stats published</span>}
        </Press>
        {(['l', 'r'] as const).map((side) => {
          const list = reads.filter((c) => slots.slot[c.key].side === side)
          return list.length ? (
            <span key={side} className="hm-dev-rows" data-side={side} data-old={old ? '' : undefined}>
              {list.map(row)}
            </span>
          ) : null
        })}
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
      </div>
    </section>
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
 * cover crops the rest), at least four across (three when four never fit). Of those, the one whose rows
 * the posters on hand fill completely, then the one nearest POSTER_W wide, so
 * the box never ends in an empty row. `count`: the posters on hand.
 */
function posterGrid(w: number, h: number, count: number, minN = 4): { n: number; rows: number; ph: number } | null {
  let best: { n: number; rows: number; ph: number; score: number } | null = null
  for (let rows = 1; rows <= 6; rows++) {
    const ph = (h - (rows - 1) * POSTER_GAP) / rows
    const pw = ph / 1.5
    if (pw < 40) break
    const n = Math.round((w + POSTER_GAP) / (pw + POSTER_GAP))
    if (n < minN) continue
    const cw = (w - (n - 1) * POSTER_GAP) / n
    const empty = Math.max(0, n * rows - count)
    const score = empty * 50 + Math.abs(cw - POSTER_W) + Math.abs(cw / pw - 1) * 100
    if (!best || score < best.score) best = { n, rows, ph, score }
  }
  // a narrow, tall box (the iPad mini's column) where no row of four fits: rows of three
  return best ?? (minN > 3 ? posterGrid(w, h, count, 3) : null)
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
