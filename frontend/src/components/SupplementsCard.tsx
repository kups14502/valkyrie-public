import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import {
  dateLabel, fetchSupplementWindow, logSupplementDay, shiftDateKey, supplementDateKey,
  type SupplementDayEntry, type SupplementWindow,
} from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// Supplements: one checkbox a day, three days on screen. The middle one is
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

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

function DayBox({
  entry, today, center, size, onToggle,
}: {
  entry: SupplementDayEntry
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
      aria-label={`${dateLabel(entry.date, today)}: ${taken ? 'taken' : 'not taken'}`}
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

export function SupplementsCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  const qc = useQueryClient()
  // null follows today, so a tab left open overnight moves with the clock.
  // Stepping pins a day and midnight leaves it alone.
  const [pinned, setPinned] = useState<string | null>(null)
  const center = pinned ?? today
  const step = (days: number) => {
    const next = shiftDateKey(center, days)
    setPinned(next === today ? null : next)
  }
  const key = ['supplements', 'day', center, today]

  const day = useQuery({
    queryKey: key,
    queryFn: () => fetchSupplementWindow(center, today),
    refetchInterval: 5 * 60_000,
  })

  const log = useMutation({
    mutationFn: ({ target, taken }: { target: string; taken: boolean }) =>
      logSupplementDay(target, taken, center, today),
    // Optimistic: the tap has to land instantly on the phone, where the round
    // trip is the slowest part of it.
    onMutate: async ({ target, taken }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SupplementWindow>(key)
      if (prev) {
        const takenAt = taken ? new Date().toISOString() : null
        qc.setQueryData<SupplementWindow>(key, {
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
    <Card
      title="Supplements"
      storageKey="supplements"
      collapsible
      action={d && (
        <span className={`shrink-0 text-[11px] font-bold uppercase tracking-[0.14em] ${d.streak > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-text-faint)]'}`}>
          {d.streak} day streak
        </span>
      )}
    >
      {day.isLoading && !d ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : day.error ? (
        <div className="text-sm text-[var(--color-danger)]">{apiErrorText(day.error, 'supplement log unavailable')}</div>
      ) : d ? (
        <div className="space-y-2">
          <div className="flex items-stretch gap-1.5">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="earlier days"
              className="flex w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <ChevronLeft size={16} />
            </button>
            {d.days.map((entry) => (
              <DayBox
                key={entry.date}
                entry={entry}
                today={today}
                center={center}
                size={size}
                onToggle={() => log.mutate({ target: entry.date, taken: !entry.taken })}
              />
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
          <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
            <span>tap the day you took them</span>
            {center !== today && (
              <button type="button" onClick={() => setPinned(null)} className="uppercase tracking-[0.14em] text-[var(--color-accent)]">
                back to today
              </button>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  )
}
