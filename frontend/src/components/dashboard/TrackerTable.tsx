import { Check, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { dateLabel, shiftDateKey, type TrackerDayEntry, type TrackerName } from '../../lib/supplementsApi'
import { fmtTime, useDailyTracker, useTapOrDoubleTap, useTrackerDays, workoutFor } from '../../lib/dailyTracker'
import { Section } from './Section'

// The daily tracker as one small table: a row per tracker, a column per day,
// today in the middle. Same data and actions as the phone's strips (a double
// tap skips an exercise day), a third of the height.

const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,4.25rem))] items-center gap-x-1.5'

function Cell({ entry, center, today, workout, skipped, onToggle, onSkip }: {
  entry: TrackerDayEntry
  center: string
  today: string
  workout?: string
  skipped: boolean
  onToggle: () => void
  onSkip?: () => void
}) {
  const onClick = useTapOrDoubleTap(onToggle, onSkip)
  const taken = entry.taken
  const isCenter = entry.date === center
  const tone = taken
    ? 'border-[var(--color-success)]/60 bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] text-[var(--color-success)]'
    : skipped
    ? 'border-[var(--color-warning)]/50 text-[var(--color-warning)]'
    : isCenter
    ? 'border-[var(--color-accent)]/55 text-[var(--color-text-dim)]'
    : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
  const label = `${dateLabel(entry.date, today)}${workout ? ` · ${workout}` : ''}`
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={taken}
      aria-label={`${label}: ${taken ? 'done' : skipped ? 'skipped' : 'not done'}`}
      title={taken ? `${label} · done ${fmtTime(entry.takenAt)}` : label}
      className={`flex h-7 min-w-0 items-center justify-center gap-1 border px-1 text-[11px] transition hover:border-[var(--color-accent)]${onSkip ? ' touch-manipulation select-none' : ''} ${tone}`}
    >
      {taken && <Check size={12} strokeWidth={3} className="shrink-0" />}
      {skipped && !taken && <SkipForward size={11} strokeWidth={2.5} className="shrink-0" />}
      {workout && workout !== 'skipped' && <span className="truncate">{workout}</span>}
    </button>
  )
}

function Row({ tracker, title, center, today, skippable = false }: {
  tracker: TrackerName
  title: string
  center: string
  today: string
  skippable?: boolean
}) {
  const t = useTrackerDays(tracker, center, today, skippable)
  return (
    <div className={`${GRID} py-[3px]`}>
      <span className="truncate text-[13px] text-[var(--color-text)]">{title}</span>
      {t.loading ? (
        <span className="col-span-3 text-center text-[11px] text-[var(--color-text-faint)]">…</span>
      ) : t.error ? (
        <span className="col-span-3 truncate text-[11px] text-[var(--color-danger)]">{apiErrorText(t.error, 'unavailable')}</span>
      ) : (t.days ?? []).map((entry) => (
        <Cell
          key={entry.date}
          entry={entry}
          center={center}
          today={today}
          workout={tracker === 'exercise' ? workoutFor(entry.date, t.skips) : undefined}
          skipped={t.skips.includes(entry.date)}
          onToggle={() => t.toggle(entry)}
          onSkip={t.skip ? () => t.skip?.(entry.date) : undefined}
        />
      ))}
    </div>
  )
}

const STEP = 'flex h-5 w-5 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]'

export function TrackerTable() {
  const { today, center, step, backToToday, streak } = useDailyTracker()
  const days = [-1, 0, 1].map((n) => shiftDateKey(center, n))

  return (
    <Section
      title="daily tracker"
      meta={center !== today ? (
        <button type="button" onClick={backToToday} className="text-[11px] text-[var(--color-accent)]">back to today</button>
      ) : streak != null && (
        <span className={streak > 0 ? 'text-[var(--color-success)]' : undefined}>{streak} day streak</span>
      )}
    >
      <div className={`${GRID} pb-0.5`}>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => step(-1)} aria-label="earlier days" className={STEP}><ChevronLeft size={14} /></button>
          <button type="button" onClick={() => step(1)} aria-label="later days" className={STEP}><ChevronRight size={14} /></button>
        </div>
        {days.map((d) => (
          <span key={d} className={`truncate text-center text-[11px] ${d === center ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}>
            {dateLabel(d, today)}
          </span>
        ))}
      </div>
      <Row tracker="supplements" title="supplements" center={center} today={today} />
      <Row tracker="exercise" title="exercise" center={center} today={today} skippable />
      <Row tracker="sf" title="SF" center={center} today={today} />
    </Section>
  )
}
