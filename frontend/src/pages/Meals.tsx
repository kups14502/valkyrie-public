import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Camera, ChevronLeft, ChevronRight, Loader2, Plus, Sparkles, Trash2, X,
} from 'lucide-react'
import { apiErrorText } from '../lib/api'
import { Card } from '../components/Card'
import {
  createMeal, deleteMeal, estimateMealPhoto, fetchMealDay, fetchMealRange, mealPhotoUrl,
  prepareImage, saveMacroTargets, updateMeal,
  type EstimatedItem, type MacroTargets, type MacroTotals, type Meal,
} from '../lib/mealsApi'

const MACROS = [
  { key: 'calories', label: 'cal', unit: '' },
  { key: 'protein', label: 'protein', unit: 'g' },
  { key: 'carbs', label: 'carbs', unit: 'g' },
  { key: 'fat', label: 'fat', unit: 'g' },
  { key: 'fiber', label: 'fiber', unit: 'g' },
] as const

type MacroKey = typeof MACROS[number]['key']

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const

const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shiftDate = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + days))
}
const prettyDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (key === dateKey(new Date())) return `today · ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}
const round = (n: number) => Math.round(n * 10) / 10
const nowTime = () => new Date().toTimeString().slice(0, 5)

/** The slot a meal logged at this hour most likely belongs to. */
function slotForNow(): string {
  const h = new Date().getHours()
  if (h < 10.5) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

function MacroBar({ label, unit, value, target }: { label: string; unit: string; value: number; target: number | null }) {
  const pct = target ? Math.min(100, Math.round((value / target) * 100)) : 0
  const over = target != null && value > target
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">{label}</span>
        <span className="font-mono text-xs text-[var(--color-text-dim)]">
          <span className="text-sm text-[var(--color-text)]">{round(value)}</span>
          {target != null ? ` / ${round(target)}${unit}` : unit}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-[rgba(255,255,255,0.07)]">
        {target != null && (
          <div
            className="h-full transition-[width] duration-300"
            style={{
              width: `${pct}%`,
              backgroundColor: over ? 'var(--color-warning)' : 'var(--color-accent)',
              boxShadow: `0 0 8px ${over ? 'var(--color-warning)' : 'var(--color-accent)'}`,
            }}
          />
        )}
      </div>
    </div>
  )
}

const blankEntry = () => ({
  name: '', slot: slotForNow(), time: nowTime(), servings: '1',
  calories: '', protein: '', carbs: '', fat: '', fiber: '', note: '', photoId: '',
})

type EntryDraft = ReturnType<typeof blankEntry>

function EntryForm({
  date, draft, setDraft, onSaved, onCancel,
}: {
  date: string
  draft: EntryDraft
  setDraft: (d: EntryDraft) => void
  onSaved: () => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: () => createMeal({
      date,
      name: draft.name.trim(),
      slot: draft.slot,
      time: draft.time,
      servings: Number(draft.servings) || 1,
      calories: Number(draft.calories) || 0,
      protein: Number(draft.protein) || 0,
      carbs: Number(draft.carbs) || 0,
      fat: Number(draft.fat) || 0,
      fiber: Number(draft.fiber) || 0,
      note: draft.note,
      photoId: draft.photoId,
      source: draft.photoId ? 'photo' : 'manual',
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['meals'] }); onSaved() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not save that entry')),
  })

  const field = 'border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => { e.preventDefault(); if (draft.name.trim()) save.mutate() }}
    >
      <div className="flex flex-wrap gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="what you ate"
          className={`min-w-0 flex-1 ${field}`}
        />
        <select value={draft.slot} onChange={(e) => setDraft({ ...draft, slot: e.target.value })} className={field}>
          {SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} className={`w-28 ${field}`} />
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <label className="block">
          <span className="mb-1 block text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">servings</span>
          <input inputMode="decimal" value={draft.servings} onChange={(e) => setDraft({ ...draft, servings: e.target.value })} className={`w-full ${field}`} />
        </label>
        {MACROS.map((m) => (
          <label key={m.key} className="block">
            <span className="mb-1 block text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
              {m.label}{m.unit && ` (${m.unit})`}
            </span>
            <input
              inputMode="decimal"
              value={draft[m.key]}
              onChange={(e) => setDraft({ ...draft, [m.key]: e.target.value })}
              placeholder="0"
              className={`w-full ${field}`}
            />
          </label>
        ))}
      </div>
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending || !draft.name.trim()}
          className="inline-flex items-center gap-2 border border-[var(--color-accent)]/60 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] disabled:opacity-40"
        >
          <Plus size={12} /> {save.isPending ? 'saving' : 'log it'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
            cancel
          </button>
        )}
        <span className="text-[11px] text-[var(--color-text-faint)]">
          Macros are per serving. Servings multiplies them into the day's total.
        </span>
      </div>
    </form>
  )
}

function PhotoEstimator({ date, onLogged }: { date: string; onLogged: () => void }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const [items, setItems] = useState<EstimatedItem[] | null>(null)
  const [notes, setNotes] = useState('')
  const [photoId, setPhotoId] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ base64: string; mime: string } | null>(null)

  const reset = () => {
    setPreview(null); setItems(null); setNotes(''); setPhotoId(''); setError(''); setPending(null); setHint('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(''); setItems(null)
    try {
      const { base64, mime, previewUrl } = await prepareImage(file)
      setPreview(previewUrl)
      setPending({ base64, mime })
    } catch {
      setError('could not read that image')
    }
  }

  const estimate = useMutation({
    mutationFn: () => estimateMealPhoto({ imageBase64: pending!.base64, mime: pending!.mime, hint }),
    onSuccess: (data) => { setItems(data.items); setNotes(data.notes); setPhotoId(data.photoId); setError('') },
    onError: (e: unknown) => setError(apiErrorText(e, 'estimation failed')),
  })

  const logAll = useMutation({
    mutationFn: async () => {
      for (const it of items ?? []) {
        await createMeal({
          date,
          name: it.portion ? `${it.name} (${it.portion})` : it.name,
          slot: slotForNow(),
          time: nowTime(),
          servings: it.servings,
          calories: it.calories,
          protein: it.protein,
          carbs: it.carbs,
          fat: it.fat,
          fiber: it.fiber,
          note: it.confidence === 'high' ? '' : `Claude estimate, ${it.confidence} confidence`,
          photoId,
          source: 'photo',
        })
      }
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['meals'] }); reset(); onLogged() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not log those items')),
  })

  const patchItem = (i: number, patch: Partial<EstimatedItem>) =>
    setItems((prev) => (prev ? prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) : prev))

  const totals = useMemo(() => {
    const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
    for (const it of items ?? []) {
      for (const m of MACROS) t[m.key] += (Number(it[m.key]) || 0) * (Number(it.servings) || 1)
    }
    return t
  }, [items])

  const numField = 'w-16 border border-[var(--color-border)] bg-transparent px-1.5 py-1 text-right font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

  return (
    <Card
      title="estimate from a photo"
      action={preview && (
        <button type="button" onClick={reset} className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]" aria-label="Clear">
          <X size={14} />
        </button>
      )}
    >
      <div className="space-y-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />

        {!preview ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 border border-dashed border-[var(--color-border)] py-8 text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
          >
            <Camera size={20} />
            <span className="text-xs uppercase tracking-[0.2em]">take or pick a photo</span>
            <span className="text-[11px] text-[var(--color-text-faint)]">
              Claude reads the plate and returns per-serving macros you can correct before logging.
            </span>
          </button>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <img src={preview} alt="meal" className="max-h-48 w-full border border-[var(--color-border)] object-cover sm:w-56" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <input
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                placeholder="anything Claude can't see (cooked in butter, 8 oz, protein shake)"
                className="w-full border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => estimate.mutate()}
                disabled={estimate.isPending || !pending}
                className="inline-flex w-fit items-center gap-2 border border-[var(--color-accent)]/60 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] disabled:opacity-40"
              >
                {estimate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {estimate.isPending ? 'asking claude' : items ? 'estimate again' : 'estimate macros'}
              </button>
              {notes && <p className="text-[11px] leading-relaxed text-[var(--color-text-dim)]">{notes}</p>}
            </div>
          </div>
        )}

        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}

        {items && items.length > 0 && (
          <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead>
                  <tr className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
                    <th className="pb-2 font-normal">item</th>
                    <th className="pb-2 text-right font-normal">serv</th>
                    {MACROS.map((m) => <th key={m.key} className="pb-2 text-right font-normal">{m.label}</th>)}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5 pr-2">
                        <input
                          value={it.name}
                          onChange={(e) => patchItem(i, { name: e.target.value })}
                          className="w-full min-w-[8rem] border border-transparent bg-transparent px-1 py-0.5 text-sm text-[var(--color-text)] outline-none hover:border-[var(--color-border)] focus:border-[var(--color-accent)]"
                        />
                        <div className="px-1 text-[10px] text-[var(--color-text-faint)]">
                          {it.portion && `${it.portion} · `}{it.confidence} confidence
                        </div>
                      </td>
                      <td className="py-1.5 text-right">
                        <input
                          inputMode="decimal"
                          value={String(it.servings)}
                          onChange={(e) => patchItem(i, { servings: Number(e.target.value) || 0 })}
                          className={numField}
                        />
                      </td>
                      {MACROS.map((m) => (
                        <td key={m.key} className="py-1.5 text-right">
                          <input
                            inputMode="decimal"
                            value={String(it[m.key])}
                            onChange={(e) => patchItem(i, { [m.key]: Number(e.target.value) || 0 } as Partial<EstimatedItem>)}
                            className={numField}
                          />
                        </td>
                      ))}
                      <td className="py-1.5 pl-2 text-right">
                        <button
                          type="button"
                          onClick={() => setItems((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev))}
                          className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
                          aria-label="Drop this item"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-[var(--color-border)] font-mono text-[var(--color-text-dim)]">
                    <td className="py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">plate total</td>
                    <td />
                    {MACROS.map((m) => (
                      <td key={m.key} className="py-1.5 text-right text-[var(--color-text)]">{round(totals[m.key])}</td>
                    ))}
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={() => logAll.mutate()}
              disabled={logAll.isPending}
              className="inline-flex items-center gap-2 border border-[var(--color-accent)]/60 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] disabled:opacity-40"
            >
              {logAll.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              log {items.length} item{items.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}

// Keyed on the server's updatedAt by the caller, so a change made on another
// device remounts this with fresh boxes rather than being synced in an effect.
function TargetsCard({ targets }: { targets: MacroTargets }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<MacroKey, string>>(() => ({
    calories: targets.calories?.toString() ?? '',
    protein: targets.protein?.toString() ?? '',
    carbs: targets.carbs?.toString() ?? '',
    fat: targets.fat?.toString() ?? '',
    fiber: targets.fiber?.toString() ?? '',
  }))
  const save = useMutation({
    mutationFn: () => saveMacroTargets({
      calories: draft.calories === '' ? null : Number(draft.calories),
      protein: draft.protein === '' ? null : Number(draft.protein),
      carbs: draft.carbs === '' ? null : Number(draft.carbs),
      fat: draft.fat === '' ? null : Number(draft.fat),
      fiber: draft.fiber === '' ? null : Number(draft.fiber),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['meals'] }) },
  })

  const anySet = MACROS.some((m) => targets[m.key] != null)

  return (
    <Card title="daily targets" collapsible defaultCollapsed={anySet} storageKey="meal-targets">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {MACROS.map((m) => (
            <label key={m.key} className="block">
              <span className="mb-1 block text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
                {m.label}{m.unit && ` (${m.unit})`}
              </span>
              <input
                inputMode="decimal"
                value={draft[m.key]}
                onChange={(e) => setDraft({ ...draft, [m.key]: e.target.value })}
                placeholder="—"
                className="w-full border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="border border-[var(--color-accent)]/60 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-[var(--color-accent)] disabled:opacity-40"
          >
            {save.isPending ? 'saving' : 'save targets'}
          </button>
          <span className="text-[11px] text-[var(--color-text-faint)]">
            Leave a box empty to track that macro without a goal.
          </span>
        </div>
      </div>
    </Card>
  )
}

function MealRow({ meal }: { meal: Meal }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [servings, setServings] = useState(String(meal.servings))
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['meals'] }) }
  const remove = useMutation({ mutationFn: () => deleteMeal(meal.id), onSuccess: invalidate })
  const patch = useMutation({
    mutationFn: () => updateMeal(meal.id, { servings: Number(servings) || 1 }),
    onSuccess: () => { setEditing(false); invalidate() },
  })
  const factor = meal.servings || 1

  return (
    <li className="flex items-center gap-3 border-t border-[var(--color-border)] py-2 first:border-t-0">
      {meal.photoId
        ? <img src={mealPhotoUrl(meal.photoId)} alt="" className="h-10 w-10 shrink-0 border border-[var(--color-border)] object-cover" />
        : <span className="h-10 w-10 shrink-0 border border-[var(--color-border)]" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--color-text)]">{meal.name}</div>
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {[meal.slot, meal.time, meal.servings !== 1 ? `${meal.servings}×` : '', meal.source === 'photo' ? 'photo' : '']
            .filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="hidden shrink-0 gap-4 font-mono text-xs text-[var(--color-text-dim)] sm:flex">
        {MACROS.map((m) => (
          <span key={m.key} className="w-12 text-right">
            {round(meal[m.key] * factor)}<span className="text-[var(--color-text-faint)]">{m.unit}</span>
          </span>
        ))}
      </div>
      <div className="shrink-0 font-mono text-xs text-[var(--color-text)] sm:hidden">{round(meal.calories * factor)}</div>
      {editing ? (
        <div className="flex shrink-0 items-center gap-1">
          <input
            inputMode="decimal"
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            className="w-14 border border-[var(--color-border)] bg-transparent px-1.5 py-1 text-right font-mono text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <button type="button" onClick={() => patch.mutate()} className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">ok</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Change servings"
          className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
        >
          edit
        </button>
      )}
      <button
        type="button"
        onClick={() => remove.mutate()}
        className="shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
        aria-label="Delete entry"
      >
        <Trash2 size={13} />
      </button>
    </li>
  )
}

function WeekStrip({ from, to, targetCalories }: { from: string; to: string; targetCalories: number | null }) {
  const range = useQuery({ queryKey: ['meals', 'range', from, to], queryFn: () => fetchMealRange(from, to) })
  const days = range.data?.days ?? []
  if (days.length === 0) return null
  const peak = Math.max(targetCalories ?? 0, ...days.map((d) => d.totals.calories), 1)
  return (
    <Card title="last 14 days">
      <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
        {days.map((d) => {
          const pct = Math.max(2, Math.round((d.totals.calories / peak) * 100))
          const over = targetCalories != null && d.totals.calories > targetCalories
          return (
            <div key={d.date} className="flex w-8 shrink-0 flex-col items-center gap-1" title={`${d.date}: ${round(d.totals.calories)} cal, ${round(d.totals.protein)}g protein`}>
              <div className="flex h-20 w-full items-end bg-[rgba(255,255,255,0.05)]">
                <div
                  className="w-full"
                  style={{
                    height: `${pct}%`,
                    backgroundColor: over ? 'var(--color-warning)' : 'var(--color-accent)',
                    opacity: 0.85,
                  }}
                />
              </div>
              <span className="font-mono text-[9px] text-[var(--color-text-faint)]">{d.date.slice(8)}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

export default function Meals() {
  const [date, setDate] = useState(() => dateKey(new Date()))
  const [draft, setDraft] = useState<EntryDraft>(blankEntry)
  const day = useQuery({ queryKey: ['meals', 'day', date], queryFn: () => fetchMealDay(date) })

  const totals: MacroTotals = day.data?.totals ?? { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  const targets: MacroTargets = day.data?.targets ?? { calories: null, protein: null, carbs: null, fat: null, fiber: null, updatedAt: null }
  const meals = day.data?.meals ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// fuel</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            meals<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setDate((d) => shiftDate(d, -1))} className="p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label="Previous day">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[11rem] text-center text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">{prettyDate(date)}</span>
          <button type="button" onClick={() => setDate((d) => shiftDate(d, 1))} className="p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label="Next day">
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={() => setDate(dateKey(new Date()))}
            className="ml-1 border border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
          >
            today
          </button>
        </div>
      </div>

      <Card title="today's totals">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
          {MACROS.map((m) => (
            <MacroBar key={m.key} label={m.label} unit={m.unit} value={totals[m.key]} target={targets[m.key]} />
          ))}
        </div>
        {targets.calories == null && (
          <p className="mt-4 text-[11px] text-[var(--color-text-faint)]">
            No targets set, so the bars stay empty and the numbers just accumulate. Set them whenever you want.
          </p>
        )}
      </Card>

      <PhotoEstimator date={date} onLogged={() => setDraft(blankEntry())} />

      <Card title="add by hand">
        <EntryForm date={date} draft={draft} setDraft={setDraft} onSaved={() => setDraft(blankEntry())} />
      </Card>

      <Card title={`logged · ${meals.length} ${meals.length === 1 ? 'entry' : 'entries'}`}>
        {day.isLoading && !day.data ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        ) : day.error ? (
          <div className="text-sm text-[var(--color-danger)]">Meals API unreachable</div>
        ) : meals.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">Nothing logged for this day.</div>
        ) : (
          <ul>
            {meals.map((m) => <MealRow key={m.id} meal={m} />)}
          </ul>
        )}
      </Card>

      <TargetsCard key={targets.updatedAt ?? 'unset'} targets={targets} />

      <WeekStrip from={shiftDate(date, -13)} to={date} targetCalories={targets.calories} />
    </div>
  )
}
