import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchDailyStreak, fetchTrackerSkips, fetchTrackerWindow, logTrackerDay, parseDateKey, shiftDateKey,
  skipTrackerDay, supplementDateKey, type TrackerDayEntry, type TrackerName, type TrackerSkips, type TrackerWindow,
} from './supplementsApi'

// The daily tracker's data side, shared by the phone and pad strips
// (components/DailyTrackerCard) and the desktop dashboard's table.

/** Today's key, re-checked every minute so a tab left open rolls over at midnight. */
export function useToday(): string {
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

export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

/**
 * The day the tracker is centred on, the streak, and stepping. null follows
 * today, so a tab left open overnight moves with the clock; stepping pins a
 * day and midnight leaves it alone. Every row shares it.
 */
export function useDailyTracker() {
  const today = useToday()
  const qc = useQueryClient()
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

  return { today, center, step, backToToday: () => setPinned(null), streak: streak.data?.streak }
}

/** One tracker's three days around `center`, with its tick and skip actions. */
export function useTrackerDays(tracker: TrackerName, center: string, today: string, skippable = false) {
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

  const skipList = skips.data?.skips ?? []
  return {
    days: day.data?.days,
    skips: skipList,
    loading: (day.isLoading && !day.data) || skips.isLoading,
    error: day.error ?? skips.error,
    toggle: (entry: TrackerDayEntry) => log.mutate({ target: entry.date, taken: !entry.taken }),
    skip: skippable ? (date: string) => skip.mutate({ target: date, skipped: !skipList.includes(date) }) : undefined,
  }
}

/** Two taps inside this window are a double tap. */
const DOUBLE_TAP_MS = 250

/**
 * A click handler that tells a tap from a double tap. With no onDouble the
 * tap fires at once; with one, each tap is held until the double-tap window
 * closes, so a double tap never ticks the day on its way to skipping it.
 * Counted by hand: a phone does not fire dblclick reliably.
 */
export function useTapOrDoubleTap(onTap: () => void, onDouble?: () => void) {
  const pendingTap = useRef<number | null>(null)
  return () => {
    if (!onDouble) return onTap()
    if (pendingTap.current != null) {
      clearTimeout(pendingTap.current)
      pendingTap.current = null
      onDouble()
      return
    }
    pendingTap.current = window.setTimeout(() => {
      pendingTap.current = null
      onTap()
    }, DOUBLE_TAP_MS)
  }
}

// Exercise: a fixed five-day rotation counted from the day it started. A
// skipped day holds the rotation back, so the workout it missed moves to the
// next day and everything after it slides one day later. The skips live on
// the server, so every screen agrees on the day.
const ROTATION = ['chest', 'back', 'shoulders', 'legs', 'rest'] as const
const ROTATION_START = '2026-09-27' // chest, so 2026-09-28 is back

/** The workout for a date key. Rounded because a DST day is 23 or 25 hours. */
export function workoutFor(key: string, skips: readonly string[]): (typeof ROTATION)[number] | 'skipped' {
  if (skips.includes(key)) return 'skipped'
  // Date keys sort as strings.
  const held = skips.filter((s) => s >= ROTATION_START && s < key).length
  const days = Math.round((parseDateKey(key).getTime() - parseDateKey(ROTATION_START).getTime()) / 86_400_000) - held
  return ROTATION[((days % ROTATION.length) + ROTATION.length) % ROTATION.length]
}
