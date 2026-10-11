import { type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import { dateLabel, type TrackerDayEntry, type TrackerName } from '../lib/supplementsApi'
import { fmtTime, useDailyTracker, useTapOrDoubleTap, useTrackerDays, workoutFor } from '../lib/dailyTracker'
import type { PanelSize } from './HomePanels'

// Daily tracker: Supplements, Exercise and SF in one box under one streak.
// Each row is a strip of three days that step together. The middle one is
// today; the day either side of it is there so a 1am tick-off can land on the
// day that just ended, and so a day can be stepped in either direction.
// The data side lives in lib/dailyTracker, shared with the desktop dashboard.

const STEP_BUTTON = 'flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'

/** One row of the tracker: its label and the day strip. */
function Strip({ title, step, children }: { title: string; step: (days: number) => void; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-dim)]">{title}</h3>
      <div className="flex min-w-0 flex-1 items-stretch gap-1.5">
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
  const onClick = useTapOrDoubleTap(onToggle, onSkip)

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
      className={`flex min-w-0 flex-1 flex-col items-center justify-center border px-1 ${size === 'pad' ? 'gap-1 py-2' : 'gap-1 py-1.5'}${onSkip ? ' touch-manipulation select-none' : ''}`}
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
  const t = useTrackerDays(tracker, center, today, skippable)

  return (
    <Strip title={title} step={step}>
      {t.loading ? (
        <div className="flex flex-1 items-center justify-center py-2 text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : t.error ? (
        <div className="flex flex-1 items-center justify-center py-2 text-sm text-[var(--color-danger)]">{apiErrorText(t.error, `${title} log unavailable`)}</div>
      ) : t.days ? (
        t.days.map((entry) => (
          <CheckDay
            key={entry.date}
            entry={entry}
            today={today}
            center={center}
            size={size}
            detail={detail?.(entry.date, entry.date === center, t.skips)}
            skipped={t.skips.includes(entry.date)}
            onToggle={() => t.toggle(entry)}
            onSkip={t.skip ? () => t.skip?.(entry.date) : undefined}
          />
        ))
      ) : null}
    </Strip>
  )
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
  const { today, center, step, backToToday, streak: n } = useDailyTracker()

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
            <button type="button" onClick={backToToday} className="uppercase tracking-[0.14em] text-[var(--color-accent)]">
              back to today
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}
