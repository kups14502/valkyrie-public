import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import {
  dateLabel, fetchDailyStreak, fetchTrackerSkips, fetchTrackerWindow, logTrackerDay, parseDateKey, shiftDateKey,
  skipTrackerDay, supplementDateKey, type TrackerDayEntry, type TrackerName, type TrackerSkips, type TrackerWindow,
} from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// Daily tracker: Supplements, Exercise and SF in one box under one streak.
// Each row is a strip of three days that step together. The middle one is
// today; the day either side of it is there so a 1am tick-off can land on the
// day that just ended, and so a day can be stepped in either direction.

/** Today's key, re-checked every minute so a tab left open rolls over at midnight. */
function useToday(): string {
  const [date, setDate] = useState(() => supplementDateKey())
  useEffect(() => {
    const t = setInterval(() => setDate((d) => {
      const now = supplementDateKey()
      return now === d ? d : now
    }), 60_000)
    return () => clearInterval(t)
  }, [])
  return date
}

// Every screen reads the same rows, so a tick on the phone has to show up on
// the desktop. The app turns refetchOnWindowFocus off globally, which left two
// open dashboards disagreeing for minutes; this card turns it back on and polls
// a minute at a time.
const LIVE = {
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  refetchOnMount: 'always',
} as const

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

const STEP_BUTTON = 'flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'

/** One row of the tracker: its label and the day strip. */
function Strip({ title, step, children }: { title: string; step: (days: number) => void; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">{title}</h3>
      <div className="flex flex-1 items-stretch gap-1.5">
        <button type="button" onClick={() => step(-1)} aria-label="earlier days" className={STEP_BUTTON}>
          <ChevronLeft size={16} />
        </button>
        {children}
        <button type="button" onClick={() => step(1)} aria-label="later days" className={STEP_BUTTON}>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

/** Two taps inside this window are a double tap. */
const DOUBLE_TAP_MS = 250

function CheckDay({
  entry, today, center, size, detail, skipped = false, onToggle, onSkip,
}: {
  entry: TrackerDayEntry
  today: string
  center: string
  size: PanelSize
  /** A line under the date, e.g. the day's workout. */
  detail?: ReactNode
  skipped?: boolean
  onToggle: () => void
  /** Called on a double tap. Without it the box ticks on the first tap. */
  onSkip?: () => void
}) {
  // A box that can be skipped holds each tap until the double-tap window
  // closes, so a double tap never ticks the day on its way to skipping it.
  // Counted by hand: a phone does not fire dblclick reliably.
  const pendingTap = useRef<number | null>(null)
  const onClick = () => {
    if (!onSkip) return onToggle()
    if (pendingTap.current != null) {
      clearTimeout(pendingTap.current)
      pendingTap.current = null
      onSkip()
      return
    }
    pendingTap.current = window.setTimeout(() => {
      pendingTap.current = null
      onToggle()
    }, DOUBLE_TAP_MS)
  }

  const isCenter = entry.date === center
  const taken = entry.taken
  const mark = taken ? 'var(--color-success)' : skipped ? 'var(--color-warning)' : undefined
  const color = mark ?? (isCenter ? 'var(--color-accent)' : 'var(--color-border)')
  const icon = size === 'pad' ? 16 : 14
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={taken}
      aria-label={`${dateLabel(entry.date, today)}: ${taken ? 'done' : skipped ? 'skipped' : 'not done'}`}
      // The tick time lives in the tooltip, not a line of its own, to keep the box short.
      title={taken ? fmtTime(entry.takenAt) : undefined}
      // touch-manipulation stops the phone zooming on the double tap.
      className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 border px-1 ${size === 'pad' ? 'py-2' : 'py-1.5'}${onSkip ? ' touch-manipulation select-none' : ''}`}
      style={{
        borderColor: color,
        backgroundColor: taken ? 'color-mix(in srgb, var(--color-success) 8%, transparent)' : 'transparent',
        opacity: isCenter || taken ? 1 : 0.75,
      }}
    >
      <span
        className="truncate text-[10px] font-bold uppercase tracking-[0.14em]"
        style={{ color: isCenter ? 'var(--color-accent)' : 'var(--color-text-faint)' }}
      >
        {dateLabel(entry.date, today)}
      </span>
      {detail}
      <span
        className={`flex items-center justify-center border ${size === 'pad' ? 'h-7 w-7' : 'h-6 w-6'}`}
        style={{
          borderColor: mark ?? 'var(--color-border)',
          color: mark ?? 'transparent',
          boxShadow: taken ? '0 0 10px var(--color-success)' : undefined,
        }}
        aria-hidden
      >
        {skipped && !taken
          ? <SkipForward size={icon - 2} strokeWidth={2.5} />
          : <Check size={icon} strokeWidth={3} />}
      </span>
    </button>
  )
}

/** A one-checkbox-a-day row backed by the API. */
function CheckStrip({
  tracker, title, center, today, size, step, detail, skippable = false,
}: {
  tracker: TrackerName
  title: string
  center: string
  today: string
  size: PanelSize
  step: (days: number) => void
  detail?: (date: string, isCenter: boolean, skips: readonly string[]) => ReactNode
  /** A double tap skips a day. Only exercise has skips. */
  skippable?: boolean
}) {
  const qc = useQueryClient()
  const key = ['daily', tracker, center, today]
  const skipsKey = ['daily', tracker, 'skips']

  const day = useQuery({ queryKey: key, queryFn: () => fetchTrackerWindow(tracker, center, today), ...LIVE })
  const skips = useQuery({ queryKey: skipsKey, queryFn: () => fetchTrackerSkips(tracker), enabled: skippable, ...LIVE })

  const log = useMutation({
    mutationFn: ({ target, taken }: { target: string; taken: boolean }) =>
      logTrackerDay(tracker, target, taken, center, today),
    // Optimistic: the tap has to land instantly on the phone, where the round
    // trip is the slowest part of it.
    onMutate: async ({ target, taken }) => {
      await Promise.all([qc.cancelQueries({ queryKey: key }), qc.cancelQueries({ queryKey: skipsKey })])
      const prev = qc.getQueryData<TrackerWindow>(key)
      const prevSkips = qc.getQueryData<TrackerSkips>(skipsKey)
      if (prev) {
        const takenAt = taken ? new Date().toISOString() : null
        qc.setQueryData<TrackerWindow>(key, {
          ...prev,
          days: prev.days.map((d) => (d.date === target ? { ...d, taken, takenAt } : d)),
        })
      }
      // Ticking a skipped day un-skips it, on the server too.
      if (taken && prevSkips?.skips.includes(target)) {
        qc.setQueryData<TrackerSkips>(skipsKey, { skips: prevSkips.skips.filter((s) => s !== target) })
      }
      return { prev, prevSkips }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
      if (ctx?.prevSkips) qc.setQueryData(skipsKey, ctx.prevSkips)
    },
    // The server owns the streak, so ask it again once the tick has landed.
    onSuccess: (data) => {
      qc.setQueryData(key, data)
      void qc.invalidateQueries({ queryKey: ['daily', 'streak'] })
      if (skippable) void qc.invalidateQueries({ queryKey: skipsKey })
    },
  })

  const skip = useMutation({
    mutationFn: ({ target, skipped }: { target: string; skipped: boolean }) => skipTrackerDay(tracker, target, skipped),
    onMutate: async ({ target, skipped }) => {
      await Promise.all([qc.cancelQueries({ queryKey: key }), qc.cancelQueries({ queryKey: skipsKey })])
      const prev = qc.getQueryData<TrackerWindow>(key)
      const prevSkips = qc.getQueryData<TrackerSkips>(skipsKey)
      if (prevSkips) {
        const rest = prevSkips.skips.filter((s) => s !== target)
        qc.setQueryData<TrackerSkips>(skipsKey, { skips: skipped ? [...rest, target].sort() : rest })
      }
      // Skipping a day clears its tick.
      if (skipped && prev) {
        qc.setQueryData<TrackerWindow>(key, {
          ...prev,
          days: prev.days.map((d) => (d.date === target ? { ...d, taken: false, takenAt: null } : d)),
        })
      }
      return { prev, prevSkips }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
      if (ctx?.prevSkips) qc.setQueryData(skipsKey, ctx.prevSkips)
    },
    // A cleared tick changes the window and the streak.
    onSuccess: (data) => {
      qc.setQueryData(skipsKey, data)
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: ['daily', 'streak'] })
    },
  })

  const d = day.data
  const skipList = skips.data?.skips ?? []
  const error = day.error ?? skips.error

  return (
    <Strip title={title} step={step}>
      {(day.isLoading && !d) || skips.isLoading ? (
        <div className="flex flex-1 items-center justify-center py-2 text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center py-2 text-sm text-[var(--color-danger)]">{apiErrorText(error, `${title} log unavailable`)}</div>
      ) : d ? (
        d.days.map((entry) => (
          <CheckDay
            key={entry.date}
            entry={entry}
            today={today}
            center={center}
            size={size}
            detail={detail?.(entry.date, entry.date === center, skipList)}
            skipped={skipList.includes(entry.date)}
            onToggle={() => log.mutate({ target: entry.date, taken: !entry.taken })}
            onSkip={skippable ? () => skip.mutate({ target: entry.date, skipped: !skipList.includes(entry.date) }) : undefined}
          />
        ))
      ) : null}
    </Strip>
  )
}

// Exercise: a fixed five-day rotation counted from the day it started. A
// skipped day holds the rotation back, so the workout it missed moves to the
// next day and everything after it slides one day later. The skips live on
// the server, so every screen agrees on the day.
const ROTATION = ['chest', 'back', 'shoulders', 'legs', 'rest'] as const
const ROTATION_START = '2026-09-27' // chest, so 2026-09-28 is back

/** The workout for a date key. Rounded because a DST day is 23 or 25 hours. */
function workoutFor(key: string, skips: readonly string[]): (typeof ROTATION)[number] | 'skipped' {
  if (skips.includes(key)) return 'skipped'
  // Date keys sort as strings.
  const held = skips.filter((s) => s >= ROTATION_START && s < key).length
  const days = Math.round((parseDateKey(key).getTime() - parseDateKey(ROTATION_START).getTime()) / 86_400_000) - held
  return ROTATION[((days % ROTATION.length) + ROTATION.length) % ROTATION.length]
}

/** The workout name inside an exercise day box. A rest day is ticked like any other. */
function workoutLabel(date: string, isCenter: boolean, size: PanelSize, skips: readonly string[]) {
  const workout = workoutFor(date, skips)
  const rest = workout === 'rest' || workout === 'skipped'
  return (
    <span
      // A phone box is about 70px inside, which "shoulders" at text-sm overruns.
      className={`max-w-full truncate font-bold uppercase ${size === 'pad' ? 'text-base tracking-[0.14em]' : 'text-[11px] tracking-[0.06em] sm:text-sm sm:tracking-[0.14em]'}`}
      style={{
        color: rest ? 'var(--color-text-faint)' : isCenter ? 'var(--color-text)' : 'var(--color-text-dim)',
        textShadow: isCenter && !rest ? '0 0 8px var(--color-accent)' : undefined,
      }}
    >
      {workout}
    </span>
  )
}

export function DailyTrackerCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  const qc = useQueryClient()
  // null follows today, so a tab left open overnight moves with the clock.
  // Stepping pins a day and midnight leaves it alone. All three rows share it.
  const [pinned, setPinned] = useState<string | null>(null)
  const center = pinned ?? today
  const step = (days: number) => {
    const next = shiftDateKey(center, days)
    setPinned(next === today ? null : next)
  }

  const streak = useQuery({ queryKey: ['daily', 'streak', today], queryFn: () => fetchDailyStreak(today), ...LIVE })

  // A backgrounded tab stops its interval; coming back to it must not show a
  // stale day. (visibilitychange, not focus: a second window on the same screen
  // never fires focus.)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['daily'] })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [qc])

  const n = streak.data?.streak

  return (
    <Card
      title="Daily tracker"
      storageKey="daily-tracker"
      collapsible
      action={n != null && (
        <span className={`shrink-0 text-[11px] font-bold uppercase tracking-[0.14em] ${n > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-text-faint)]'}`}>
          {n} day streak
        </span>
      )}
    >
      <div className="space-y-2">
        {/* Three across when there is room, stacked on the phone. Capped so an
            ultrawide does not stretch each strip into a billboard. */}
        <div className="grid max-w-7xl gap-x-5 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
          <CheckStrip tracker="supplements" title="Supplements" center={center} today={today} size={size} step={step} />
          <CheckStrip
            tracker="exercise"
            title="Exercise"
            center={center}
            today={today}
            size={size}
            step={step}
            skippable
            detail={(date, isCenter, skips) => workoutLabel(date, isCenter, size, skips)}
          />
          <CheckStrip tracker="sf" title="SF" center={center} today={today} size={size} step={step} />
        </div>
        {center !== today && (
          <div className="flex max-w-7xl justify-end text-[10px] uppercase tracking-[0.14em]">
            <button type="button" onClick={() => setPinned(null)} className="uppercase tracking-[0.14em] text-[var(--color-accent)]">
              back to today
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}
