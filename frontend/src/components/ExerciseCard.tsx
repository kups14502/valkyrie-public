import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from './Card'
import { useToday } from './SupplementsCard'
import { dateLabel, parseDateKey, shiftDateKey } from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// Exercise: a fixed five-day rotation counted from the day it started, so every
// screen agrees on the day without a server. Same three-day strip as
// Supplements, which sits right above it.

const ROTATION = ['chest', 'back', 'shoulders', 'legs', 'rest'] as const
const ANCHOR = '2026-09-28' // chest

/** The workout for a date key. Rounded because a DST day is 23 or 25 hours. */
function workoutFor(key: string): (typeof ROTATION)[number] {
  const days = Math.round((parseDateKey(key).getTime() - parseDateKey(ANCHOR).getTime()) / 86_400_000)
  return ROTATION[((days % ROTATION.length) + ROTATION.length) % ROTATION.length]
}

function DayBox({ date, today, center, size }: { date: string; today: string; center: string; size: PanelSize }) {
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

export function ExerciseCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  // null follows today; stepping pins a day, as in Supplements.
  const [pinned, setPinned] = useState<string | null>(null)
  const center = pinned ?? today
  const step = (days: number) => {
    const next = shiftDateKey(center, days)
    setPinned(next === today ? null : next)
  }
  const days = [-1, 0, 1].map((n) => shiftDateKey(center, n))

  return (
    <Card title="Exercise" storageKey="exercise" collapsible>
      <div className="max-w-md space-y-2">
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="earlier days"
            className="flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <ChevronLeft size={16} />
          </button>
          {days.map((date) => (
            <DayBox key={date} date={date} today={today} center={center} size={size} />
          ))}
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="later days"
            className="flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        {center !== today && (
          <div className="flex justify-end text-[10px] uppercase tracking-[0.14em]">
            <button type="button" onClick={() => setPinned(null)} className="uppercase tracking-[0.14em] text-[var(--color-accent)]">
              back to today
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}
