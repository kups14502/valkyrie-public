import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import {
  dateLabel, fetchTrackerWindow, logTrackerDay, parseDateKey, shiftDateKey, supplementDateKey,
  type TrackerDayEntry, type TrackerName, type TrackerWindow,
} from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// Daily tracker: Supplements, Exercise and SF in one card. Each box is a strip
// of three days. The middle one is today; the day either side of it is there
// so a 1am tick-off can land on the day that just ended, and so a day can be
// stepped in either direction.

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

/**
 * The day in the middle of a strip. null follows today, so a tab left open
 * overnight moves with the clock. Stepping pins a day and midnight leaves it
 * alone.
 */
function useCenter(today: string) {
  const [pinned, setPinned] = useState<string | null>(null)
  const center = pinned ?? today
  const step = (days: number) => {
    const next = shiftDateKey(center, days)
    setPinned(next === today ? null : next)
  }
  return { center, step, reset: () => setPinned(null) }
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

const STEP_BUTTON = 'flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'

/** One tracker's box: a heading, the day strip, and the way back to today. */
function TrackerBox({
  title, action, today, center, step, reset, children,
}: {
  title: string
  action?: ReactNode
  today: string
  center: string
  step: (days: number) => void
  reset: () => void
  children: ReactNode
}) {
  return (
    <div className="min-w-0 space-y-2 border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-accent)]">{title}</h3>
        {action}
      </div>
      <div className="flex items-stretch gap-1.5">
        <button type="button" onClick={() => step(-1)} aria-label={`${title}: earlier days`} className={STEP_BUTTON}>
          <ChevronLeft size={16} />
        </button>
        {children}
        <button type="button" onClick={() => step(1)} aria-label={`${title}: later days`} className={STEP_BUTTON}>
          <ChevronRight size={16} />
        </button>
      </div>
      {center !== today && (
        <div className="flex justify-end text-[10px] uppercase tracking-[0.14em]">
          <button type="button" onClick={reset} className="uppercase tracking-[0.14em] text-[var(--color-accent)]">
            back to today
          </button>
        </div>
      )}
    </div>
  )
}

function CheckDay({
  entry, today, center, size, onToggle,
}: {
  entry: TrackerDayEntry
  today: string
  center: string
  size: PanelSize
  onToggle: () => void
}) {
  const isCenter = entry.date === center
  const taken = entry.taken
  const color = taken ? 'var(--color-success)' : isCenter ? 'var(--color-accent)' : 'var(--color-border)'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={taken}
      aria-label={`${dateLabel(entry.date, today)}: ${taken ? 'done' : 'not done'}`}
      className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1.5 border px-1 ${size === 'pad' ? 'py-5' : 'py-4'}`}
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
      <span
        className={`flex items-center justify-center border ${size === 'pad' ? 'h-10 w-10' : 'h-8 w-8'}`}
        style={{
          borderColor: taken ? 'var(--color-success)' : 'var(--color-border)',
          color: taken ? 'var(--color-success)' : 'transparent',
          boxShadow: taken ? '0 0 10px var(--color-success)' : undefined,
        }}
        aria-hidden
      >
        <Check size={size === 'pad' ? 22 : 18} strokeWidth={3} />
      </span>
      <span className="h-3 truncate text-[9px] tabular-nums text-[var(--color-text-faint)]">
        {taken ? fmtTime(entry.takenAt) : ''}
      </span>
    </button>
  )
}

/** A one-checkbox-a-day tracker backed by the API, with its streak. */
function CheckTracker({ tracker, title, today, size }: { tracker: TrackerName; title: string; today: string; size: PanelSize }) {
  const qc = useQueryClient()
  const { center, step, reset } = useCenter(today)
  const key = [tracker, 'day', center, today]

  // Every screen reads the same rows, so a tick on the phone has to show up on
  // the desktop. The app turns refetchOnWindowFocus off globally, which left
  // two open dashboards disagreeing for minutes; this card turns it back on and
  // polls a minute at a time.
  const day = useQuery({
    queryKey: key,
    queryFn: () => fetchTrackerWindow(tracker, center, today),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: 'always',
  })

  // A backgrounded tab stops its interval; coming back to it must not show a
  // stale day. (visibilitychange, not focus: a second window on the same screen
  // never fires focus.)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: [tracker] })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [qc, tracker])

  const log = useMutation({
    mutationFn: ({ target, taken }: { target: string; taken: boolean }) =>
      logTrackerDay(tracker, target, taken, center, today),
    // Optimistic: the tap has to land instantly on the phone, where the round
    // trip is the slowest part of it.
    onMutate: async ({ target, taken }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<TrackerWindow>(key)
      if (prev) {
        const takenAt = taken ? new Date().toISOString() : null
        qc.setQueryData<TrackerWindow>(key, {
          ...prev,
          days: prev.days.map((d) => (d.date === target ? { ...d, taken, takenAt } : d)),
        })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev) },
    // The server owns the streak, so take its answer.
    onSuccess: (data) => qc.setQueryData(key, data),
  })

  const d = day.data

  return (
    <TrackerBox
      title={title}
      today={today}
      center={center}
      step={step}
      reset={reset}
      action={d && (
        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] ${d.streak > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-text-faint)]'}`}>
          {d.streak} day streak
        </span>
      )}
    >
      {day.isLoading && !d ? (
        <div className="flex flex-1 items-center justify-center py-4 text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : day.error ? (
        <div className="flex flex-1 items-center justify-center py-4 text-sm text-[var(--color-danger)]">{apiErrorText(day.error, `${title} log unavailable`)}</div>
      ) : d ? (
        d.days.map((entry) => (
          <CheckDay
            key={entry.date}
            entry={entry}
            today={today}
            center={center}
            size={size}
            onToggle={() => log.mutate({ target: entry.date, taken: !entry.taken })}
          />
        ))
      ) : null}
    </TrackerBox>
  )
}

// Exercise: a fixed five-day rotation counted from the day it started, so every
// screen agrees on the day without a server.
const ROTATION = ['chest', 'back', 'shoulders', 'legs', 'rest'] as const
const ROTATION_START = '2026-09-28' // chest

/** The workout for a date key. Rounded because a DST day is 23 or 25 hours. */
function workoutFor(key: string): (typeof ROTATION)[number] {
  const days = Math.round((parseDateKey(key).getTime() - parseDateKey(ROTATION_START).getTime()) / 86_400_000)
  return ROTATION[((days % ROTATION.length) + ROTATION.length) % ROTATION.length]
}

function WorkoutDay({ date, today, center, size }: { date: string; today: string; center: string; size: PanelSize }) {
  const isCenter = date === center
  const workout = workoutFor(date)
  const rest = workout === 'rest'
  return (
    <div
      className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1.5 border px-1 ${size === 'pad' ? 'py-5' : 'py-4'}`}
      style={{
        borderColor: isCenter ? 'var(--color-accent)' : 'var(--color-border)',
        opacity: isCenter ? 1 : 0.75,
      }}
    >
      <span
        className="truncate text-[10px] font-bold uppercase tracking-[0.14em]"
        style={{ color: isCenter ? 'var(--color-accent)' : 'var(--color-text-faint)' }}
      >
        {dateLabel(date, today)}
      </span>
      <span
        className={`truncate font-bold uppercase tracking-[0.14em] ${size === 'pad' ? 'text-base' : 'text-sm'}`}
        style={{
          color: rest ? 'var(--color-text-faint)' : isCenter ? 'var(--color-text)' : 'var(--color-text-dim)',
          textShadow: isCenter && !rest ? '0 0 8px var(--color-accent)' : undefined,
        }}
      >
        {workout}
      </span>
    </div>
  )
}

function ExerciseTracker({ today, size }: { today: string; size: PanelSize }) {
  const { center, step, reset } = useCenter(today)
  return (
    <TrackerBox title="Exercise" today={today} center={center} step={step} reset={reset}>
      {[-1, 0, 1].map((n) => {
        const date = shiftDateKey(center, n)
        return <WorkoutDay key={date} date={date} today={today} center={center} size={size} />
      })}
    </TrackerBox>
  )
}

export function DailyTrackerCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  return (
    <Card title="Daily tracker" storageKey="daily-tracker" collapsible>
      {/* Side by side when there is room, stacked on the phone. Each box is
          capped: on a 1440px dashboard a full-width strip would be a billboard. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),28rem))]">
        <CheckTracker tracker="supplements" title="Supplements" today={today} size={size} />
        <ExerciseTracker today={today} size={size} />
        <CheckTracker tracker="sf" title="SF" today={today} size={size} />
      </div>
    </Card>
  )
}
