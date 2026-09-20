import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import {
  dateLabel, fetchSupplementDay, logSupplementDay, parseDateKey, supplementDateKey,
  type SupplementDay, type SupplementDayEntry,
} from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// Supplements: one checkbox a day, not a checklist. The big button answers
// today; the strip under it is the last two weeks, and every square in it is
// its own checkbox, which is what makes a 1am "that was yesterday" tap work.

const HISTORY_DAYS = 14

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

function DayColumn({ entry, today, onToggle }: { entry: SupplementDayEntry; today: string; onToggle: () => void }) {
  const isToday = entry.date === today
  const letter = parseDateKey(entry.date).toLocaleDateString([], { weekday: 'narrow' })
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={entry.taken}
      title={`${dateLabel(entry.date, today)}${entry.taken ? ` · taken ${fmtTime(entry.takenAt)}` : ' · not logged'}`}
      className="flex min-w-0 flex-1 flex-col items-center gap-1 py-1"
    >
      <span className={`text-[9px] uppercase ${isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}>
        {letter}
      </span>
      <span
        className={`h-5 w-full border ${isToday ? 'outline outline-1 outline-offset-1 outline-[var(--color-accent)]' : ''}`}
        style={{
          borderColor: entry.taken ? 'var(--color-success)' : 'var(--color-border)',
          backgroundColor: entry.taken ? 'var(--color-success)' : 'transparent',
          boxShadow: entry.taken ? '0 0 8px var(--color-success)' : undefined,
        }}
      />
    </button>
  )
}

export function SupplementsCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  const qc = useQueryClient()
  const key = ['supplements', 'day', today]

  const day = useQuery({
    queryKey: key,
    queryFn: () => fetchSupplementDay(today, HISTORY_DAYS),
    refetchInterval: 5 * 60_000,
  })

  const log = useMutation({
    mutationFn: ({ date, taken }: { date: string; taken: boolean }) => logSupplementDay(date, taken, HISTORY_DAYS),
    // Optimistic: the tap has to land instantly on the phone, where the round
    // trip is the slowest part of it.
    onMutate: async ({ date, taken }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SupplementDay>(key)
      if (prev) {
        const at = taken ? new Date().toISOString() : null
        qc.setQueryData<SupplementDay>(key, {
          ...prev,
          taken: date === prev.date ? taken : prev.taken,
          takenAt: date === prev.date ? at : prev.takenAt,
          history: prev.history.map((h) => (h.date === date ? { ...h, taken, takenAt: at } : h)),
        })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev) },
    // The server owns the streak and the 30-day count, so take its answer.
    onSuccess: (data) => qc.setQueryData(key, data),
  })

  const d = day.data
  const taken = Boolean(d?.taken)
  const toggle = (date: string, next: boolean) => log.mutate({ date, taken: next })

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
      ) : (
        <div className="space-y-4">
          {/* Today, as one target big enough to hit without looking. */}
          <button
            type="button"
            onClick={() => toggle(today, !taken)}
            aria-pressed={taken}
            className={`flex w-full items-center gap-3 border px-4 text-left transition-colors ${size === 'pad' ? 'min-h-20' : 'min-h-16'} ${
              taken
                ? 'border-[var(--color-success)] bg-[color:rgba(255,255,255,0.03)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-accent)] active:border-[var(--color-accent)]'
            }`}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center border ${
                taken ? 'border-[var(--color-success)] text-[var(--color-success)]' : 'border-[var(--color-border)] text-transparent'
              }`}
              style={taken ? { boxShadow: '0 0 10px var(--color-success)' } : undefined}
              aria-hidden
            >
              <Check size={18} strokeWidth={3} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block text-sm font-bold uppercase tracking-[0.18em]"
                style={{ color: taken ? 'var(--color-success)' : 'var(--color-text)' }}
              >
                {taken ? 'took them today' : 'took them?'}
              </span>
              <span className="block text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                {taken ? `logged ${fmtTime(d?.takenAt ?? null)} · tap to undo` : 'tap when you take them'}
              </span>
            </span>
          </button>

          {/* Every square is its own checkbox, so a missed day is one tap away
              and so is last night's dose at 1am. */}
          {d && (
            <div>
              <div className="flex items-stretch gap-1">
                {d.history.map((entry) => (
                  <DayColumn
                    key={entry.date}
                    entry={entry}
                    today={today}
                    onToggle={() => toggle(entry.date, !entry.taken)}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                <span>{d.last30} of the last 30 days</span>
                <span>tap any day</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
