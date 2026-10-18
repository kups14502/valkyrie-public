import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode,
} from 'react'
import { useIsFetching, useQueryClient, type Mutation, type QueryClient } from '@tanstack/react-query'
import { playerActions, usePlayerNow, useShell, type ScreenProps } from '../kit/shell'
import { Bar, Glyph, Panel, Press, Segmented, cx, dismissToast, toast } from '../kit/ui'
import {
  ago, nyDayKey, tradeSession, useCalendar, useHosts, useLaunchTargets, useLights, useLive, useMediaQueue, usePlexRecentRich, useSessions, useTick,
  useTrade, useTracker, useUsage,
  type DownloadVM, type EventVM, type HostVM, type Live, type PlexRichVM, type SessionVM, type TargetVM, type TradeSession,
} from '../kit/data'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { useSetting } from '../kit/theme'
import { apiErrorText } from '../../lib/api'
import { fetchTrackerSkips, shiftDateKey } from '../../lib/supplementsApi'
import { useDailyTracker, useTrackerDays, workoutFor } from '../../lib/dailyTracker'
import { lightColor, useLightsControl } from '../../lib/lights'
import { useQuickSessions } from '../../lib/quickSessions'
import './dashboard.css'

// Dashboard: one page with everything Valkyrie does, in the order Brendon
// uses it. A trade ticker line on top (the newest session, bot online, 7 days),
// quick start, lights (a plate that switches them all), the daily tracker,
// the calendar (today first, then the next six days as compact rows), AI
// (live and asking sessions, usage meters), media (playing or newest added,
// downloads) and every host at the bottom (CPU / Mem / Disk, battery where
// the host has one). Phone: one column in that order. From 640 px: the
// ticker over two columns. Desktop: three (AI in the middle, media and the
// hosts on the right).

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

  const wide = useMedia('(min-width: 1200px)')

  // Phone: the column wrappers dissolve, so the blocks read top to bottom in
  // this order. From 640 px the first wrapper is the left column; desktop
  // splits the rest into a middle and a right column.
  return (
    <div className="hm">
      <div className="vl-screen hm-layout" data-cols={wide ? 3 : 2}>
        <TradeTicker active={active} i={0} />
        <div className="hm-col hm-a">
          <QuickStart />
          <LightsBlock i={3} />
          <Tracker />
          <Calendar />
        </div>
        {wide ? (
          <>
            <div className="hm-col hm-b">
              <AiBlock wide i={9} />
            </div>
            <div className="hm-col hm-c">
              <Panel className="hm-glance" i={10} dense><MediaGlance posters={8} /></Panel>
              <Systems i={11} />
            </div>
          </>
        ) : (
          <div className="hm-col hm-b">
            <AiBlock wide={false} i={9} />
            <Panel className="hm-glance" i={10} dense><MediaGlance posters={6} /></Panel>
            <Systems i={11} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- small pieces ----------

/** A header or row icon: lit = full color with the glow (on, live, asking); otherwise dim and flat. */
function HIcon({ name, lit, size = 14, tone, className }: { name: IconName; lit?: boolean; size?: number; tone?: IconTone; className?: string }) {
  return <Icon name={name} size={size} tone={tone ?? (lit ? 'fg' : 'dim')} glow={!!lit} className={cx('hm-ic', className)} />
}

/** Section title on the floor: icon and label left, value right, optional control between. */
function Head({ label, icon, lit, value, i, mid }: { label: string; icon: IconName; lit?: boolean; value?: ReactNode; i: number; mid?: ReactNode }) {
  return (
    <div className="hm-head vl-build" style={bi(i)} data-mid={mid ? '' : undefined}>
      <span className="hm-head-label" data-lit={lit || undefined}><HIcon name={icon} lit={lit} />{label}</span>
      {mid}
      {value !== undefined && <span className="hm-head-value">{value}</span>}
    </div>
  )
}

function Chevron() {
  return (
    <svg className="hm-chev" width="7" height="10" viewBox="0 0 7 10" aria-hidden>
      <path d="M1.5 1 5.5 5l-4 4" fill="none" stroke="currentColor" strokeWidth="1.2" />
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
 */
function TradeTicker({ active, i }: { active: boolean; i: number }) {
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
    if (wk != null) said.push(`${wkDays} day ${wk < 0 ? 'down' : 'up'} ${money(wk)}`)
    cells = (
      <>
        <span
          className="hm-tk-cell"
          data-dir={dir}
          data-flat={s?.flat || undefined}
          title={s?.flat ? 'Not live: the bot repeated its day-open figure all session' : s?.running ? 'Today so far, to the live equity read' : 'The newest trading session, close to close'}
        >
          {dir !== 'flat' && <Icon name={dir === 'up' ? 'trades' : 'down'} size={13} tone={dir === 'up' ? 'fg' : 'acc2'} className="hm-ic" />}
          <b className="hm-tk-v">{s ? signedMoney(s.flat ? 0 : s.change) : '--'}</b>
          {day && <span className="hm-tk-k">{day}</span>}
        </span>
        <span className="hm-tk-cell hm-tk-bot" data-on={(online && !age) || undefined} data-off={(!online && !age) || undefined} title={t.upDetail || undefined}>
          <i className="hm-tk-dot" aria-hidden />
          <span className="hm-tk-word">{age ? `${age} old` : online ? 'Online' : 'Offline'}</span>
        </span>
        <span className="hm-tk-cell" data-dir={wk == null || wk === 0 ? 'flat' : wk > 0 ? 'up' : 'down'} title={`Deposit-adjusted trading change over the last ${wkDays} days`}>
          <span className="hm-tk-k">{wkDays}D</span>
          <b className="hm-tk-v">{wk != null ? signedMoney(wk) : '--'}</b>
          {t.changePct != null && <span className="hm-tk-pct">{signed(t.changePct)}%</span>}
        </span>
      </>
    )
  }

  return (
    <Press
      className={cx('hm-tk vl-build', age && 'hm-old')}
      style={bi(i)}
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

// ---------- daily tracker ----------

const TRACK_IDS = [
  { id: 'supplements', label: 'Supplements' },
  { id: 'exercise', label: 'Exercise' },
  { id: 'sf', label: 'SF' },
] as const

type Day = 'yesterday' | 'today'
const DAY_OPTS: { value: Day; label: string }[] = [{ value: 'yesterday', label: 'Yesterday' }, { value: 'today', label: 'Today' }]
/** Before this hour a tick is usually for the day that just ended, so the tracker offers it first. */
const LATE_NIGHT_END = 4

type TrackId = (typeof TRACK_IDS)[number]['id']
type TickState = { taken: boolean; at: number; known: boolean }
/** the streak before a tick went out, and whether today was complete then */
type StreakHold = { base: number; allBefore: boolean; settled: boolean }

/** at: ms when ticked, -1 when ticked at an unknown time, 0 when not ticked */
function tickState(taken: boolean, takenAt: string | null): TickState {
  const at = taken && takenAt ? Date.parse(takenAt) : NaN
  return { taken, at: taken ? (Number.isNaN(at) ? -1 : at) : 0, known: true }
}

function Tracker() {
  const qc = useQueryClient()
  // The persisted view model paints the last known ticks in the first frame.
  // The real tracker hooks (the classic tracker's, same cache) take over once
  // their reads land, and own the writes: optimistic tick, rollback on failure.
  const tracker = useTracker()
  const { today: todayKey, streak: liveStreak } = useDailyTracker()
  const supplements = useTrackerDays('supplements', todayKey, todayKey)
  const exercise = useTrackerDays('exercise', todayKey, todayKey, true)
  const sf = useTrackerDays('sf', todayKey, todayKey)
  const lib: Record<TrackId, typeof sf> = { supplements, exercise, sf }
  const cachedSkips = useLive('exerciseSkips', async () => (await fetchTrackerSkips('exercise')).skips, 5 * 60_000)
  const streakFetching = useIsFetching({ queryKey: ['daily', 'streak'] })
  const now = useTick(30_000)
  const yKey = shiftDateKey(todayKey, -1)
  const t = tracker.data

  // What the server says for one tracker on one day: the real window (yesterday,
  // today, tomorrow) once it has landed, else the view model, which covers its
  // own "today" and the day before. A cache written before midnight covers our
  // yesterday only, so today reads as unknown until the fetch lands.
  const server = (id: TrackId, key: string): TickState | null => {
    const d = lib[id].days?.find((x) => x.date === key)
    if (d) return tickState(d.taken, d.takenAt)
    const it = t?.items.find((x) => x.id === id)
    if (!t || !it) return null
    if (t.today === key) return tickState(it.taken, it.takenAt)
    if (shiftDateKey(t.today, -1) === key) return { taken: it.yesterday, at: it.yesterday ? -1 : 0, known: true }
    return null
  }

  // A write on its way: shown at once (before the real window has landed the
  // hook has nothing to write into), and one per tracker until it settles.
  const [pending, setPending] = useState<Partial<Record<TrackId, { key: string; taken: boolean; at: number }>>>({})
  const inflight = useRef<Partial<Record<TrackId, Promise<boolean>>>>({})
  const state = (id: TrackId, key: string): TickState => {
    const p = pending[id]
    if (p?.key === key) return { taken: p.taken, at: p.at, known: true }
    return server(id, key) ?? { taken: false, at: 0, known: false }
  }

  // late at night with yesterday still open: Yesterday / Today, Yesterday first
  const lateNight = new Date(now).getHours() < LATE_NIGHT_END
  const yOpen = TRACK_IDS.some((d) => server(d.id, yKey)?.taken === false)
  const showPick = lateNight && yOpen
  const [pick, setPick] = useState<{ key: string; day: Day } | null>(null)
  const day: Day = showPick ? (pick?.key === todayKey ? pick.day : 'yesterday') : 'today'
  const key = day === 'yesterday' ? yKey : todayKey
  const otherKey = day === 'yesterday' ? todayKey : yKey

  const items = TRACK_IDS.map((d) => ({ ...d, ...state(d.id, key), other: state(d.id, otherKey) }))
  const allNow = TRACK_IDS.every((d) => state(d.id, todayKey).taken)
  const serverStreak = liveStreak ?? t?.streak ?? null
  const count = items.filter((x) => x.taken).length
  const age = oldAge(tracker, now)

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
  const latest = useRef({ lib, allNow, serverStreak, held })
  useEffect(() => {
    latest.current = { lib, allNow, serverStreak, held }
  })

  const flip = (id: TrackId, day: string, next: boolean, undo = false) => {
    if (inflight.current[id]) return
    const label = TRACK_IDS.find((d) => d.id === id)?.label ?? id
    const { allNow: before, serverStreak: base, held: h } = latest.current
    setHold(h ? { ...h, settled: false } : base == null ? null : { base, allBefore: before, settled: false })
    setPending((p) => ({ ...p, [id]: { key: day, taken: next, at: next ? Date.now() : 0 } }))
    const shown = undo ? 0 : toast(next ? `${label} done` : `${label} unticked`, {
      action: { label: 'Undo', run: () => void undoFlip(id, day, next) },
    })
    // the hook's toggle sends the opposite of the entry it is given
    const entry = { date: day, taken: !next, takenAt: null }
    const run = settled(qc, () => latest.current.lib[id].toggle(entry))
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

  const ex = lib.exercise
  const skips = !ex.loading && !ex.error ? ex.skips : cachedSkips.data
  const workout = (k: string) => (skips ? workoutFor(k, skips) : null)
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
  const otherLine = (o: TickState) => {
    const name = day === 'yesterday' ? 'Today' : 'Yesterday'
    if (!o.known) return `${name}: --`
    return `${name}: ${o.taken ? 'done' : day === 'yesterday' ? 'not yet' : 'open'}`
  }

  return (
    <section className="hm-sec">
      <Head
        label="Daily Tracker"
        icon="done"
        lit={count === items.length}
        i={4}
        mid={showPick ? (
          <Segmented
            className="hm-daypick"
            options={DAY_OPTS}
            value={day}
            onChange={(v) => setPick({ key: todayKey, day: v })}
          />
        ) : undefined}
        value={streak === null ? (tracker.failed ? 'not answering' : '--') : (
          <>
            <span className={cx('hm-streak', streak > 0 && 'hm-streak-on')}>{streak}</span> day streak
            <Old age={age} />
          </>
        )}
      />
      <div className="hm-ticks" role="group" aria-label={`Daily tracker, ${day}, ${count} of 3 done`}>
        {items.map((it, k) => (
          <Press
            key={it.id}
            className="hm-tick vl-build"
            style={bi(5 + k)}
            data-on={it.taken || undefined}
            data-busy={pending[it.id] ? '' : undefined}
            aria-pressed={it.taken}
            aria-busy={pending[it.id] ? true : undefined}
            aria-label={`${it.label}, ${day}: ${it.taken ? 'done' : 'not done'}`}
            disabled={!it.known || !!pending[it.id]}
            onPress={() => flip(it.id, key, !it.taken)}
          >
            <span className="hm-tick-top">
              <Icon name={it.id} size={15} tone={it.taken ? 'ink' : 'dim'} glow={it.taken} className="hm-tick-ic" />
              <span className="hm-tick-name">{it.label}</span>
            </span>
            <span className="hm-tick-state">{stateLine(it)}</span>
            <span className="hm-tick-other" data-open={(it.other.known && !it.other.taken) || undefined}>{otherLine(it.other)}</span>
          </Press>
        ))}
      </div>
    </section>
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

function NextEvent({ e, meta, when, live }: { e: EventVM; meta: ReactNode; when: ReactNode; live?: boolean }) {
  return (
    <div className="hm-next">
      <div className="min-w-0 flex-1">
        <div className="hm-next-title">{e.title || 'Busy'}</div>
        <div className="hm-next-meta vl-ellipsis">{meta}</div>
      </div>
      <div className={cx('hm-next-when', live && 'hm-live')}>{when}</div>
    </div>
  )
}

function Calendar() {
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

  return (
    <Panel
      className="hm-cal"
      icon="calendar"
      lit={isLive}
      label="Calendar"
      value={events ? (
        <>
          {left > 0 ? <>{left}<span className="vl-panel-unit">left today</span></> : null}
          <Old age={age} />
        </>
      ) : undefined}
      i={8}
    >
      {!events ? (
        <p className="hm-quiet">{cal.failed ? 'Calendar not answering' : 'Reading the calendar'}</p>
      ) : (
        <>
          {allDay.length > 0 && (
            <span className="hm-tags">
              {allDay.map((e) => <span key={e.id} className="hm-tag vl-ellipsis">{e.title}</span>)}
            </span>
          )}
          {featured ? (
            <NextEvent
              e={featured}
              live={isLive}
              meta={<>{clock(featured.start)} to {clock(featured.end)}{featured.location ? ` · ${featured.location}` : ''}</>}
              when={isLive ? <>Now<small>until {clock(featured.end)}</small></> : until(featured.start - now)}
            />
          ) : (
            <p className="hm-cal-note">{past.length || allDay.length ? 'Nothing else today' : 'Nothing today'}</p>
          )}
          {rest.length > 0 && (
            <span className="vl-rows hm-evrows">
              {rest.slice(0, 4).map((e) => (
                <span key={e.id} className="vl-row hm-evrow">
                  <span className="hm-evtime">{clock(e.start)}</span>
                  <span className="vl-ellipsis flex-1">{e.title || 'Busy'}</span>
                  {e.start <= now && <span className="hm-live-tag">Now</span>}
                </span>
              ))}
              {rest.length > 4 && <span className="vl-row hm-evrow hm-faint">+{rest.length - 4} more</span>}
            </span>
          )}
          {past.length > 0 && featured && <span className="hm-earlier">{past.length} earlier today</span>}
          <Ahead days={days} now={now} next={next} />
        </>
      )}
    </Panel>
  )
}

/** The coming days as compact rows: a day tag on its first event, time, title; free runs fold into one row. */
function Ahead({ days, now, next }: { days: DayRow[]; now: number; next: EventVM | null }) {
  const total = new Set(days.flatMap((d) => d.list.map((e) => e.id))).size
  return (
    <div className="hm-ahead">
      <div className="hm-ahead-head">
        <span className="vl-caps">Next {AHEAD} days</span>
        <span>{total ? plural(total, 'event') : 'Nothing planned'}</span>
      </div>
      {groupDays(days).map((g) => g.kind === 'free' ? (
        <div key={`f${g.a.i}`} className="hm-arow" data-free="">
          <span className="hm-aday">{dayTag(g.a.from)}</span>
          <span className="hm-atitle">{g.a === g.b ? 'Free' : `Free through ${dayTag(g.b.from)}`}</span>
        </div>
      ) : (
        <div key={g.d.i} className="hm-aday-group">
          {g.d.list.slice(0, PER_DAY).map((e, k) => (
            <div key={e.id} className="hm-arow">
              <span className="hm-aday">{k === 0 ? dayTag(g.d.from) : ''}</span>
              <span className="hm-atime" style={e.color ? { borderLeftColor: e.color } : undefined} title={e.source || undefined}>
                {e.allDay ? 'All day' : e.start < g.d.from ? 'Cont.' : clock(e.start)}
              </span>
              <span className="hm-atitle">{e.title || 'Busy'}</span>
              {e === next && <span className="hm-awhen">{until(e.start - now)}</span>}
            </div>
          ))}
          {g.d.list.length > PER_DAY && (
            <div className="hm-arow hm-faint">
              <span className="hm-aday" />
              <span className="hm-atitle">+{g.d.list.length - PER_DAY} more</span>
            </div>
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
 * ones) and the usage meters of the account being burned. The head and the rows
 * open AI > Sessions, the meters AI > Usage.
 */
function AiBlock({ wide, i }: { wide: boolean; i: number }) {
  const { go } = useShell()
  const usage = useUsage()
  const sessions = useSessions()
  const now = useTick(30_000)
  const hostLabel = useHostLabel()

  const u = usage.data
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
        {u?.label && <span className="hm-g-acct vl-ellipsis" title="The account the usage meters show">{u.label}</span>}
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
          <Meter label="5h" value={u?.five ?? null} note={resetLabel(u?.fiveResetsAt ?? null, now)} />
          <Meter label="Week" value={u?.week ?? null} note={resetLabel(u?.weekResetsAt ?? null, now)} ticks={7} />
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
  const rank = (id: string) => { const i = HOST_ORDER.indexOf(id); return i < 0 ? 99 : i }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label))
}

type HostCell = { key: string; icon: IconName; label: string; v: number | null; alert: boolean }

/** CPU, Mem, and Disk; a host with a battery shows the battery in place of the disk. */
function hostCells(h: HostVM): HostCell[] {
  const cells: HostCell[] = [
    { key: 'cpu', icon: 'cpu', label: 'CPU', v: h.cpu, alert: false },
    { key: 'mem', icon: 'mem', label: 'Mem', v: h.mem, alert: (h.mem ?? 0) >= 90 },
  ]
  if (h.battery) {
    const b = h.battery
    cells.push({ key: 'bat', icon: b.charging ? 'charging' : 'battery', label: b.charging ? 'Battery, charging' : 'Battery', v: b.percent, alert: !b.charging && b.percent <= 15 })
  } else {
    cells.push({ key: 'disk', icon: 'disk', label: 'Disk', v: h.disk, alert: (h.disk ?? 0) >= 90 })
  }
  return cells
}

function HostLine({ h, onPress }: { h: HostVM; onPress: () => void }) {
  const on = h.online && !h.stale
  const stale = h.online && h.stale
  const label = cap(h.label)
  const cells = hostCells(h)
  const said = on ? cells.map((c) => `${c.label} ${c.v != null ? `${c.v}%` : 'unknown'}`).join(', ') : stale ? 'stale' : 'offline'
  return (
    <Press className="hm-hrow" data-off={!on || undefined} data-stale={stale || undefined} onPress={onPress} aria-label={`${label}: ${said}. Open in System`}>
      <Icon name={hostIcon(h.id)} size={14} tone={on ? 'fg' : stale ? 'acc2' : 'faint'} glow={on} className="hm-ic" />
      <span className="hm-hrow-name vl-ellipsis">{label}</span>
      {on ? cells.map((c) => (
        <span key={c.key} className="hm-mini" data-alert={c.alert || undefined} title={c.label}>
          <Icon name={c.icon} size={11} tone={c.alert ? 'acc2' : 'dim'} className="hm-ic" />
          <span className="hm-mini-bar" style={{ '--v': c.v ?? 0 } as Vars} data-empty={c.v == null || undefined}><i /></span>
          <span className="hm-mini-v">{c.v != null ? <>{c.v}<small>%</small></> : '--'}</span>
        </span>
      )) : <span className="hm-hrow-off">{stale ? 'Stale' : 'Offline'}</span>}
      <Chevron />
    </Press>
  )
}

/** Every host from /api/hosts: icon, name, its load as mini bars. A row opens System > Hosts with that host picked. */
function Systems({ i }: { i: number }) {
  const { go } = useShell()
  const hosts = useHosts()
  // System > Hosts keeps its pick under this setting; writing it first lands on the tapped host
  const [, setSysHost] = useSetting<string>('sysHost', 'thor')
  const now = useTick(30_000)
  const list = sortHosts(hosts.data ?? [])
  const online = list.filter((h) => h.online && !h.stale).length
  const age = oldAge(hosts, now, 60_000)
  const open = (id?: string) => {
    if (id) setSysHost(id)
    go(SYSTEM, 'hosts')
  }

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

// ---------- lights ----------

/** more bulbs than this and the color pips are left out (the count says it) */
const MAX_PIPS = 10

/**
 * "Lights 2 of 5 on" (opens Lights) with a pip per bulb in its real color,
 * and one glass plate that switches them all.
 */
function LightsBlock({ i }: { i: number }) {
  const { go } = useShell()
  const qc = useQueryClient()
  // the persisted view model paints the first frame; the real control (shared
  // with the classic Lights page) is server truth with the commands still on
  // their way laid over it, so a switch shows at once and a failed one falls back
  const cached = useLights()
  const ctl = useLightsControl()
  const now = useTick(30_000)
  const real = ctl.lights.data ? ctl.all : null
  const list = real
    ? real.map((l) => ({ id: l.entity_id, name: l.name, on: l.on, unavailable: l.unavailable, color: lightColor(l) }))
    : cached.data ?? []
  const avail = list.filter((l) => !l.unavailable)
  const on = avail.filter((l) => l.on).length
  const offline = list.length - avail.length
  const age = real
    ? oldAge({ data: real, updatedAt: ctl.lights.dataUpdatedAt, fromCache: false, isFetching: ctl.lights.isFetching, error: ctl.lights.error, failed: ctl.lights.isError }, now)
    : oldAge(cached, now)

  // one switch at a time; the toast's Undo waits for the switch it undoes
  const [busy, setBusy] = useState(false)
  const inflight = useRef<Promise<boolean> | null>(null)
  const send = (fire: () => void, msg: string, undo?: () => void) => {
    if (inflight.current) return
    setBusy(true)
    const shown = toast(msg, undo ? { action: { label: 'Undo', run: undo } } : undefined)
    const run = settled(qc, fire)
      .then(() => true, (e: unknown) => {
        dismissToast(shown)
        toast(`Lights not switched: ${why(e)}`)
        return false
      })
      .finally(() => {
        inflight.current = null
        setBusy(false)
      })
    inflight.current = run
  }
  const toggle = () => {
    const next = on === 0
    const wasOn = avail.filter((l) => l.on).map((l) => l.id)
    send(() => ctl.bulk(next ? 'on' : 'off'), next ? 'All lights on' : 'All lights off', () => void undoToggle(next, wasOn))
  }
  // Undo of "all on" switches them all off; of "all off", only the bulbs that were on come back
  const undoToggle = async (didOn: boolean, wasOn: string[]) => {
    if ((await inflight.current) === false) return
    if (didOn) send(() => ctl.bulk('off'), 'All lights off')
    else if (wasOn.length) send(() => ctl.mutation.mutate({ entity_id: wasOn, state: 'on' }), `${wasOn.length} ${wasOn.length === 1 ? 'light' : 'lights'} back on`)
  }

  return (
    <Panel className="hm-glance hm-lights" i={i} dense lit={on > 0}>
      <div className="hm-g hm-g-split">
        <Press className="hm-g-main" onPress={() => go(LIGHTS)} aria-label="Lights, open Lights">
          <span className="hm-g-label" data-lit={on > 0 || undefined}><HIcon name={on > 0 ? 'bulb' : 'bulbOff'} lit={on > 0} />Lights</span>
          {list.length > 0 && list.length <= MAX_PIPS && (
            <span className="hm-pips" aria-hidden>
              {list.map((l) => (
                <i
                  key={l.id}
                  title={l.name}
                  data-on={(l.on && !l.unavailable) || undefined}
                  data-off={l.unavailable || undefined}
                  style={l.on && !l.unavailable ? ({ '--c': l.color } as Vars) : undefined}
                />
              ))}
            </span>
          )}
          <span className={cx('hm-g-value', age && 'hm-old')}>
            {real || cached.data ? <><b>{on}</b> of {avail.length} on</> : cached.failed || ctl.lights.isError ? 'not answering' : '--'}
            {offline > 0 && <span className="hm-faint"> · {offline} offline</span>}
            <Old age={age} />
          </span>
          <Chevron />
        </Press>
        <Press
          className="hm-plate"
          data-on={on > 0 || undefined}
          data-busy={busy || undefined}
          aria-pressed={on > 0}
          aria-busy={busy || undefined}
          aria-label={on > 0 ? 'Turn all lights off' : 'Turn all lights on'}
          // the switch needs the control's own read: it sends to the bulbs that read reachable
          disabled={!real || !avail.length || busy}
          onPress={toggle}
        >
          <span className="hm-plate-in">
            <Icon name="power" size={12} tone={on > 0 ? 'ink' : 'dim'} />
            {on > 0 ? 'On' : 'Off'}
          </span>
        </Press>
      </div>
    </Panel>
  )
}

// ---------- media glance ----------

const NEW_MS = 7 * 86_400_000

/** A poster that fades in when its image lands; a hairline frame while it waits or when it has none. */
function Poster({ item, onPress }: { item: PlexRichVM; onPress: () => void }) {
  const [state, setState] = useState<'wait' | 'ok' | 'err'>('wait')
  const ref = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    setState('wait')
    const img = ref.current
    if (img?.complete && img.naturalWidth > 0) setState('ok')
  }, [item.img])
  return (
    <Press className="hm-poster" data-state={item.img ? state : 'err'} onPress={onPress} title={`${item.title} · ${item.subtitle}`} aria-label={`${item.title}, open Media`}>
      {item.img && (
        <img ref={ref} src={item.img} alt="" loading="lazy" decoding="async" draggable={false} onLoad={() => setState('ok')} onError={() => setState('err')} />
      )}
      {(!item.img || state === 'err') && <span className="hm-poster-t">{item.title}</span>}
    </Press>
  )
}

const dlOrder = (a: DownloadVM, b: DownloadVM) => Number(b.stuck) - Number(a.stuck) || b.progress - a.progress

/**
 * Media at a glance: what plays in the page (with play / pause), the newest
 * additions as a poster strip, and every running download (only while one
 * runs). The head opens Media.
 */
function MediaGlance({ posters }: { posters: number }) {
  const { go } = useShell()
  const recent = usePlexRecentRich({ grouped: true })
  const queue = useMediaQueue()
  const p = usePlayerNow()
  const now = useTick(30_000)

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

  return (
    <div className="hm-g hm-media">
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

      {recent.data ? (
        items.length ? (
          <>
            <span className="hm-posters" style={{ '--n': posters } as Vars} data-old={rAge ? '' : undefined}>
              {items.slice(0, posters).map((x) => <Poster key={x.key} item={x} onPress={open} />)}
            </span>
            {newest && (
              <span className="hm-media-cap vl-ellipsis">
                <span className="hm-dim">Newest </span>{newest.title}<span className="hm-dim"> · {newest.subtitle}{newest.added ? ` · ${ago(newest.added, now)} ago` : ''}</span>
              </span>
            )}
          </>
        ) : <span className="hm-quiet hm-media-quiet">Nothing added lately</span>
      ) : recent.failed ? (
        <span className="hm-quiet hm-media-quiet">Plex not answering</span>
      ) : (
        <span className="hm-posters" style={{ '--n': posters } as Vars} aria-hidden>
          {Array.from({ length: posters }, (_, k) => <span key={k} className="hm-poster" data-state="wait" />)}
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
