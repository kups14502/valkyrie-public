import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Card } from './Card'
import { apiErrorText } from '../lib/api'
import {
  createSupplement, dateLabel, daysLabel, deleteSupplement, fetchSupplementDay, logSupplement,
  logSupplementSlot, shiftDateKey, supplementDateKey, updateSupplement, DAY_LETTERS, SUPPLEMENT_SLOTS,
  type SupplementDay, type SupplementDose, type SupplementSlot,
} from '../lib/supplementsApi'
import type { PanelSize } from './HomePanels'

// The supplement tracker. One tap per dose, grouped by time of day, with a
// two-week strip underneath so a missed day is visible without opening
// anything. The stack itself is edited in place (the pencil), so there is no
// second page to keep in sync.
//
// The day is steppable because doses get ticked off at 1am for the day that
// just ended. Arrows walk back and forward; a square in the history strip jumps
// straight to that day.

const SLOT_LABEL: Record<SupplementSlot, string> = {
  morning: 'morning',
  midday: 'midday',
  evening: 'evening',
  night: 'night',
}

/** Which slot a tap right now most likely belongs to, for a new entry. */
function slotForNow(): SupplementSlot {
  const h = new Date().getHours()
  if (h < 11) return 'morning'
  if (h < 16) return 'midday'
  if (h < 21) return 'evening'
  return 'night'
}

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

const fmtTakenAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

function DoseRow({ dose, size, onToggle }: { dose: SupplementDose; size: PanelSize; onToggle: () => void }) {
  const taken = dose.taken
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={taken}
      className={`flex w-full items-center gap-3 border px-3 text-left transition-colors ${size === 'pad' ? 'min-h-14' : 'min-h-11'} ${
        taken
          ? 'border-[var(--color-success)]/50 bg-[color:rgba(255,255,255,0.02)]'
          : 'border-[var(--color-border)] active:border-[var(--color-accent)] hover:border-[var(--color-accent)]/60'
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center border ${
          taken ? 'border-[var(--color-success)] text-[var(--color-success)]' : 'border-[var(--color-border)] text-transparent'
        }`}
        style={taken ? { boxShadow: '0 0 8px var(--color-success)' } : undefined}
        aria-hidden
      >
        <Check size={13} strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm ${taken ? 'text-[var(--color-text-dim)] line-through decoration-[var(--color-text-faint)]' : 'text-[var(--color-text)]'}`}>
          {dose.name}
        </span>
        {(dose.dose || dose.days) && (
          <span className="block truncate text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
            {[dose.dose, dose.days ? daysLabel(dose.days) : ''].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-faint)]">
        {fmtTakenAt(dose.takenAt)}
      </span>
    </button>
  )
}

function HistoryStrip({
  history, streak, selected, onPick,
}: {
  history: SupplementDay['history']
  streak: number
  selected: string
  onPick: (date: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
      <div className="flex min-w-0 flex-wrap gap-1">
        {history.map((d) => {
          const complete = d.due > 0 && d.taken >= d.due
          const partial = d.taken > 0 && !complete
          const title = d.due === 0 ? `${d.date}: nothing scheduled` : `${d.date}: ${d.taken}/${d.due}`
          return (
            <button
              key={d.date}
              type="button"
              title={title}
              aria-label={title}
              onClick={() => onPick(d.date)}
              className={`h-3.5 w-3.5 border ${d.date === selected ? 'outline outline-1 outline-offset-1 outline-[var(--color-accent)]' : ''}`}
              style={{
                borderColor: complete ? 'var(--color-success)' : partial ? 'var(--color-warning)' : 'var(--color-border)',
                backgroundColor: complete ? 'var(--color-success)' : partial ? 'var(--color-warning)' : 'transparent',
                opacity: d.due === 0 ? 0.3 : 1,
              }}
            />
          )
        })}
      </div>
      <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
        {streak} day streak
      </span>
    </div>
  )
}

const field = 'border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

function DayPicker({ days, onChange }: { days: string; onChange: (days: string) => void }) {
  const set = new Set(days ? days.split(',') : ['0', '1', '2', '3', '4', '5', '6'])
  const toggle = (n: number) => {
    const next = new Set(set)
    if (next.has(String(n))) next.delete(String(n))
    else next.add(String(n))
    onChange(next.size === 7 || next.size === 0 ? '' : [...next].sort().join(','))
  }
  return (
    <div className="flex gap-1">
      {DAY_LETTERS.map((letter, n) => (
        <button
          key={n}
          type="button"
          onClick={() => toggle(n)}
          aria-pressed={set.has(String(n))}
          className={`h-7 w-7 border text-[10px] uppercase ${
            set.has(String(n))
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
          }`}
        >
          {letter}
        </button>
      ))}
    </div>
  )
}

function EditRow({ dose, onDone }: { dose: SupplementDose; onDone: () => void }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState({ name: dose.name, dose: dose.dose, slot: dose.slot, days: dose.days })
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['supplements'] }) }
  const save = useMutation({
    mutationFn: () => updateSupplement(dose.id, { ...draft, name: draft.name.trim() }),
    onSuccess: () => { invalidate(); onDone() },
  })
  const remove = useMutation({
    mutationFn: () => deleteSupplement(dose.id),
    onSuccess: () => { invalidate(); onDone() },
  })
  return (
    <div className="space-y-2 border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap gap-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="name" className={`min-w-0 flex-1 ${field}`} />
        <input value={draft.dose} onChange={(e) => setDraft({ ...draft, dose: e.target.value })} placeholder="dose" className={`w-28 ${field}`} />
        <select value={draft.slot} onChange={(e) => setDraft({ ...draft, slot: e.target.value as SupplementSlot })} className={field}>
          {SUPPLEMENT_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DayPicker days={draft.days} onChange={(days) => setDraft({ ...draft, days })} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => remove.mutate()}
            className="inline-flex min-h-9 items-center gap-1 border border-[var(--color-border)] px-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={12} /> delete
          </button>
          <button type="button" onClick={onDone} className="min-h-9 px-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-dim)]">cancel</button>
          <button
            type="button"
            disabled={!draft.name.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="inline-flex min-h-9 items-center gap-1 border border-[var(--color-accent)]/60 px-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent)] disabled:opacity-40"
          >
            save
          </button>
        </div>
      </div>
    </div>
  )
}

function AddRow({ onAdded }: { onAdded: () => void }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState({ name: '', dose: '', slot: slotForNow() as SupplementSlot, days: '' })
  const [error, setError] = useState('')
  const add = useMutation({
    mutationFn: () => createSupplement({ ...draft, name: draft.name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['supplements'] })
      setDraft({ name: '', dose: '', slot: slotForNow(), days: '' })
      setError('')
      onAdded()
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not add that')),
  })
  return (
    <form
      className="space-y-2 border border-dashed border-[var(--color-border)] p-3"
      onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) add.mutate() }}
    >
      <div className="flex flex-wrap gap-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="vitamin D3" className={`min-w-0 flex-1 ${field}`} />
        <input value={draft.dose} onChange={(e) => setDraft({ ...draft, dose: e.target.value })} placeholder="5000 IU" className={`w-28 ${field}`} />
        <select value={draft.slot} onChange={(e) => setDraft({ ...draft, slot: e.target.value as SupplementSlot })} className={field}>
          {SUPPLEMENT_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DayPicker days={draft.days} onChange={(days) => setDraft({ ...draft, days })} />
        <button
          type="submit"
          disabled={!draft.name.trim() || add.isPending}
          className="inline-flex min-h-9 items-center gap-1 border border-[var(--color-accent)]/60 px-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent)] disabled:opacity-40"
        >
          <Plus size={12} /> add
        </button>
      </div>
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
    </form>
  )
}

export function SupplementsCard({ size = 'normal' }: { size?: PanelSize } = {}) {
  const today = useToday()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  // null means "follow today", so a tab left open overnight moves with the
  // clock. Stepping back pins an explicit date instead, and midnight leaves it
  // alone: at 1am you are still ticking off yesterday.
  const [pinned, setPinned] = useState<string | null>(null)
  const date = pinned ?? today
  const isToday = date === today
  const pick = (next: string) => setPinned(next === today ? null : next)
  const key = useMemo(() => ['supplements', 'day', date], [date])

  const day = useQuery({ queryKey: key, queryFn: () => fetchSupplementDay(date), refetchInterval: 5 * 60_000 })

  const toggle = useMutation({
    mutationFn: (dose: SupplementDose) => logSupplement(date, dose.id, !dose.taken),
    // Optimistic: the tap has to land instantly on the phone, where the round
    // trip over the tailnet is the slowest part of it.
    onMutate: async (dose) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SupplementDay>(key)
      if (prev) {
        const items = prev.items.map((i) => i.id === dose.id
          ? { ...i, taken: !dose.taken, takenAt: !dose.taken ? new Date().toISOString() : null }
          : i)
        qc.setQueryData<SupplementDay>(key, { ...prev, items, taken: items.filter((i) => i.taken).length })
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev) },
    onSuccess: (data) => qc.setQueryData(key, data),
  })

  const takeAll = useMutation({
    mutationFn: (slot?: SupplementSlot) => logSupplementSlot(date, slot),
    onSuccess: (data) => qc.setQueryData(key, data),
  })

  const d = day.data
  const bySlot = useMemo(() => {
    const groups = new Map<SupplementSlot, SupplementDose[]>()
    for (const item of d?.items ?? []) {
      const list = groups.get(item.slot) ?? []
      list.push(item)
      groups.set(item.slot, list)
    }
    return SUPPLEMENT_SLOTS.map((slot) => ({ slot, items: groups.get(slot) ?? [] })).filter((g) => g.items.length > 0)
  }, [d])

  const pct = d && d.due > 0 ? Math.round((d.taken / d.due) * 100) : 0
  const allDone = Boolean(d && d.due > 0 && d.taken === d.due)

  return (
    <Card
      title="Supplements"
      storageKey="supplements"
      collapsible
      action={(
        <div className="flex shrink-0 items-center gap-2">
          {/* Day stepper. Forward stops at today: there is nothing to tick off
              in advance. */}
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => pick(shiftDateKey(date, -1))}
              aria-label="previous day"
              className="flex h-8 w-7 items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => setPinned(null)}
              disabled={isToday}
              title={date}
              className={`min-w-[72px] text-center text-[10px] uppercase tracking-[0.14em] ${isToday ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-accent)]'}`}
            >
              {dateLabel(date, today)}
            </button>
            <button
              type="button"
              onClick={() => pick(shiftDateKey(date, 1))}
              disabled={isToday}
              aria-label="next day"
              className="flex h-8 w-7 items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-25 disabled:hover:text-[var(--color-text-dim)]"
            >
              <ChevronRight size={15} />
            </button>
          </div>
          {d && d.due > 0 && (
            <span className={`text-[11px] font-bold uppercase tracking-[0.14em] ${allDone ? 'text-[var(--color-success)]' : 'text-[var(--color-text-dim)]'}`}>
              {d.taken}/{d.due}
            </span>
          )}
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); setEditId(null) }}
            aria-label={editing ? 'done editing' : 'edit supplements'}
            className="flex h-8 w-8 items-center justify-center border border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {editing ? <X size={13} /> : <Pencil size={13} />}
          </button>
        </div>
      )}
    >
      {day.isLoading && !d ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : day.error ? (
        <div className="text-sm text-[var(--color-danger)]">{apiErrorText(day.error, 'supplement log unavailable')}</div>
      ) : (
        <div className="space-y-4">
          {d && d.due > 0 && (
            <div className="h-1.5 w-full bg-[rgba(255,255,255,0.07)]">
              <div
                className="h-full transition-[width] duration-300"
                style={{
                  width: `${pct}%`,
                  backgroundColor: allDone ? 'var(--color-success)' : 'var(--color-accent)',
                  boxShadow: `0 0 8px ${allDone ? 'var(--color-success)' : 'var(--color-accent)'}`,
                }}
              />
            </div>
          )}

          {d && d.due === 0 && !editing && (
            <div className="text-sm text-[var(--color-text-dim)]">
              Nothing scheduled {isToday ? 'today' : `on ${dateLabel(date, today)}`}. Tap the pencil to add what you take.
            </div>
          )}

          {bySlot.map(({ slot, items }) => {
            const remaining = items.filter((i) => !i.taken)
            return (
              <div key={slot} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">{SLOT_LABEL[slot]}</span>
                  {remaining.length > 1 && !editing && (
                    <button
                      type="button"
                      onClick={() => takeAll.mutate(slot)}
                      className="min-h-8 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
                    >
                      take all {remaining.length}
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {items.map((item) => (
                    editing && editId === item.id
                      ? <EditRow key={item.id} dose={item} onDone={() => setEditId(null)} />
                      : editing
                        ? (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setEditId(item.id)}
                            className="flex w-full items-center gap-3 border border-[var(--color-border)] px-3 py-2 text-left hover:border-[var(--color-accent)]"
                          >
                            <Pencil size={12} className="shrink-0 text-[var(--color-text-faint)]" />
                            <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{item.name}</span>
                            <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                              {[item.dose, daysLabel(item.days)].filter(Boolean).join(' · ')}
                            </span>
                          </button>
                        )
                        : <DoseRow key={item.id} dose={item} size={size} onToggle={() => toggle.mutate(item)} />
                  ))}
                </div>
              </div>
            )
          })}

          {editing && <AddRow onAdded={() => { /* list refreshes itself */ }} />}

          {d && d.history.length > 0 && !editing && (
            <HistoryStrip history={d.history} streak={d.streak} selected={date} onPick={pick} />
          )}
        </div>
      )}
    </Card>
  )
}
