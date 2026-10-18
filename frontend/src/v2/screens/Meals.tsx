import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Camera, Minus, Plus, Sparkles, Trash2, Utensils, type LucideIcon } from 'lucide-react'
import { Bar, Button, Glyph, Press, Section, Segmented, cx, toast } from '../kit/ui'
import { useTick } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import {
  createMeal, deleteMeal, estimateMealPhoto, fetchMealDay, fetchMealRange, mealPhotoUrl, prepareImage, saveMacroTargets, updateMeal,
  type EstimatedItem, type MacroTargets, type MacroTotals, type Meal, type NewMeal,
} from '../../lib/mealsApi'
import { PageFrame } from './Calendar'
import './meals.css'

// Meals in v2 (/m/meals), native: the day's log against the macro targets.
// The day bar steps days; the totals put calories first (the number that
// matters, readable in two seconds) and the four macros beside it; then the
// log, grouped by meal, where a row opens to change its servings or delete it
// (with Undo); logging food by hand or from a photo (Claude estimates the
// plate, every number editable before it is logged); the last 14 days as
// bars against the calorie target; and the targets themselves.
//
// Phone: one column, Log food opens the add panel. Desktop and iPad: the log
// on the left, the add panel always open on the right with the week and the
// targets under it. Data: lib/mealsApi through react-query under the classic
// page's keys, so either page sees the other's writes.

type MacroKey = keyof MacroTotals
const MACROS: { key: MacroKey; label: string; short: string; unit: string }[] = [
  { key: 'calories', label: 'Calories', short: 'Cal', unit: '' },
  { key: 'protein', label: 'Protein', short: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbs', short: 'Carbs', unit: 'g' },
  { key: 'fat', label: 'Fat', short: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', short: 'Fiber', unit: 'g' },
]
const GRAMS = MACROS.slice(1)

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const
const SLOT_OPTS = SLOTS.map((s) => ({ value: s as string, label: s[0].toUpperCase() + s.slice(1) }))
const slotLabel = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : 'Other')

const ZERO: MacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
const NO_TARGETS: MacroTargets = { calories: null, protein: null, carbs: null, fat: null, fiber: null, updatedAt: null }

// ---------- helpers ----------

const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const keyDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const shiftDate = (key: string, days: number) => {
  const d = keyDate(key)
  return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}
const isKey = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
/** 1,840 */
const kcal = (n: number) => Math.round(n).toLocaleString('en-US')
/** 32.5 -> "32.5", 30 -> "30" */
const grams = (n: number) => String(Math.round(n * 10) / 10)
const fmtMacro = (key: MacroKey, n: number) => (key === 'calories' ? kcal(n) : grams(n))
const nowTime = () => new Date().toTimeString().slice(0, 5)
/** "13:05" -> "1:05 PM" */
const clock = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** The meal a food logged at this hour most likely belongs to. */
function slotForNow(): string {
  const h = new Date().getHours() + new Date().getMinutes() / 60
  if (h < 10.5) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

/** Every meals read: this page's, the classic page's, and any v2 persisted copy (a Dashboard line). */
function invalidateMeals(qc: QueryClient) {
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'meals' || (q.queryKey[0] === 'v2' && String(q.queryKey[1]).startsWith('meals')),
  })
}

/** An element's width in its own CSS px (the UI zoom hides from media queries). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** A lucide icon in the kit's line style (the kit set has no food icons). */
const Lc = ({ C, size = 14, lit, tone }: { C: LucideIcon; size?: number; lit?: boolean; tone?: 'dim' | 'fg' | 'ink' }) => (
  <C
    size={size}
    strokeWidth={size <= 13 ? 1.6 : 1.4}
    className={cx('vl-icon', `vl-icon-${tone ?? (lit ? 'fg' : 'dim')}`, lit && 'vl-icon-glow')}
    aria-hidden
  />
)

const num = (s: string) => {
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// ---------- the page ----------

/** /m/meals?date=2026-10-18: the day's food log and macros. */
export default function MealsPage() {
  return (
    <PageFrame id="meals" title="Meals" icon={<Lc C={Utensils} lit />} scroll>
      <MealsScreen />
    </PageFrame>
  )
}

function MealsScreen() {
  const [params, setParams] = useSearchParams()
  const now = useTick(60_000)
  const today = dateKey(new Date(now))
  const asked = params.get('date')
  const date = isKey(asked) ? asked : today
  const setDate = (d: string) => {
    setParams(d === today ? {} : { date: d }, { replace: true, state: window.history.state?.usr })
    setOpenId(null)
  }
  const day = useQuery({ queryKey: ['meals', 'day', date], queryFn: () => fetchMealDay(date) })
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useWidth(rootRef)
  const wide = width >= 880
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const totals = day.data?.totals ?? ZERO
  const targets = day.data?.targets ?? NO_TARGETS
  const meals = useMemo(() => day.data?.meals ?? [], [day.data])
  const status = day.isError && !day.data ? 'Meals are not answering' : !day.data ? 'Reading meals' : null

  const log = (
    <LogList
      meals={meals}
      status={status}
      wide={wide}
      openId={openId}
      onToggle={(id) => setOpenId((cur) => (cur === id ? null : id))}
    />
  )
  const add = <AddPanel date={date} onClose={wide ? undefined : () => setAdding(false)} />
  const week = <WeekStrip date={date} today={today} target={targets.calories} onPick={setDate} />
  const tgt = <Targets key={targets.updatedAt ?? 'unset'} targets={targets} ready={!!day.data} />

  return (
    <div className="ml" ref={rootRef} data-wide={wide || undefined}>
      <DayBar
        date={date}
        today={today}
        wide={wide}
        onStep={(n) => setDate(shiftDate(date, n))}
        onToday={() => setDate(today)}
        action={!wide && (
          <Button icon="add" className="ml-logbtn" lit={adding} onPress={() => setAdding((v) => !v)}>Log food</Button>
        )}
      />
      <Totals totals={totals} targets={targets} entries={meals.length} ready={!!day.data} />
      {wide ? (
        <div className="ml-cols">
          <div className="ml-col">{log}</div>
          <div className="ml-col ml-side">{add}{week}{tgt}</div>
        </div>
      ) : (
        <>
          {adding && add}
          {log}
          {week}
          {tgt}
        </>
      )}
    </div>
  )
}

// ---------- the day bar ----------

function DayBar({ date, today, wide, onStep, onToday, action }: {
  date: string
  today: string
  wide: boolean
  onStep: (n: number) => void
  onToday: () => void
  action?: ReactNode
}) {
  const d = keyDate(date)
  const rel = date === today ? 'Today' : date === shiftDate(today, -1) ? 'Yesterday' : date === shiftDate(today, 1) ? 'Tomorrow' : null
  const long = d.toLocaleDateString('en-US', wide ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' })
  return (
    <div className="ml-bar">
      <Press className="ml-step vl-hit" aria-label="The day before" onPress={() => onStep(-1)}><Glyph name="left" size={12} /></Press>
      <Press className="ml-step vl-hit" aria-label="The next day" onPress={() => onStep(1)}><Glyph name="right" size={12} /></Press>
      <h2 className="ml-day" aria-live="polite">
        {rel && <span className="ml-rel" data-today={date === today || undefined}>{rel}</span>}
        <span className="ml-date">{long}</span>
      </h2>
      {date !== today && <Press className="vl-link vl-hit ml-today" onPress={onToday}>Today</Press>}
      {action && <span className="ml-bar-act">{action}</span>}
    </div>
  )
}

// ---------- totals against the targets ----------

function Totals({ totals, targets, entries, ready }: { totals: MacroTotals; targets: MacroTargets; entries: number; ready: boolean }) {
  const t = targets.calories
  const left = t != null ? t - totals.calories : null
  const pct = (v: number, target: number | null) => (target ? Math.min(100, (v / target) * 100) : null)
  const anyTarget = MACROS.some((m) => targets[m.key] != null)
  return (
    <section className="ml-totals" aria-label="The day's totals" data-ready={ready || undefined}>
      <div className="ml-cal">
        <span className="ml-k">Calories</span>
        <span className="ml-cal-v">
          <b className="ml-big">{kcal(totals.calories)}</b>
          {t != null && <span className="ml-of">of {kcal(t)}</span>}
        </span>
        <span className="ml-left" data-over={left != null && left < 0 ? '' : undefined}>
          {left == null ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : left >= 0 ? `${kcal(left)} left` : `${kcal(-left)} over`}
        </span>
        <Bar value={pct(totals.calories, t)} ticks={4} tone={left != null && left < 0 ? 'hot' : 'fg'} className="ml-calbar" />
      </div>
      <div className="ml-macros">
        {GRAMS.map((m) => {
          const target = targets[m.key]
          const v = totals[m.key]
          const over = target != null && v > target
          return (
            <div key={m.key} className="ml-mac">
              <span className="ml-k">{m.label}</span>
              <span className="ml-mac-v">
                <b data-over={over || undefined}>{grams(v)}</b>
                <span className="ml-of">{target != null ? ` / ${grams(target)} g` : ' g'}</span>
              </span>
              <Bar value={pct(v, target)} ticks={2} tone={over ? 'hot' : 'fg'} />
            </div>
          )
        })}
      </div>
      {ready && !anyTarget && <p className="ml-hint ml-totals-hint">No targets yet: the numbers add up without bars. Set them under Targets.</p>}
    </section>
  )
}

// ---------- the log ----------

function LogList({ meals, status, wide, openId, onToggle }: {
  meals: Meal[]
  status: string | null
  wide: boolean
  openId: string | null
  onToggle: (id: string) => void
}) {
  const groups = useMemo(() => {
    const order = [...SLOTS] as string[]
    const by = new Map<string, Meal[]>()
    for (const m of [...meals].sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.createdAt.localeCompare(b.createdAt))) {
      const k = order.includes(m.slot) ? m.slot : ''
      by.set(k, [...(by.get(k) ?? []), m])
    }
    return [...order, ''].filter((k) => by.has(k)).map((k) => {
      const list = by.get(k) ?? []
      return { slot: k, list, cal: list.reduce((s, m) => s + m.calories * (m.servings || 1), 0) }
    })
  }, [meals])
  return (
    <section className="ml-log" aria-label="Logged food">
      <Section icon={<Lc C={Utensils} size={14} lit />} action={<span className="ml-count">{meals.length} {meals.length === 1 ? 'entry' : 'entries'}</span>}>
        Logged
      </Section>
      {wide && !status && meals.length > 0 && (
        <div className="ml-colheads" aria-hidden>
          <span />
          {GRAMS.slice(0, 3).map((m) => <span key={m.key}>{m.short}</span>)}
          <span>Cal</span>
        </div>
      )}
      {status ? <p className="ml-quiet">{status}</p> : meals.length === 0 ? (
        <p className="ml-quiet">Nothing logged for this day.</p>
      ) : groups.map((g) => (
        <div key={g.slot || 'other'} className="ml-group">
          <div className="ml-ghead">
            <span>{slotLabel(g.slot)}</span>
            <span className="ml-gcal">{kcal(g.cal)} cal</span>
          </div>
          <div className="ml-rows">
            {g.list.map((m) => <MealRow key={m.id} meal={m} wide={wide} open={openId === m.id} onToggle={() => onToggle(m.id)} />)}
          </div>
        </div>
      ))}
    </section>
  )
}

function MealRow({ meal, wide, open, onToggle }: { meal: Meal; wide: boolean; open: boolean; onToggle: () => void }) {
  const f = meal.servings || 1
  const meta = [
    meal.time ? clock(meal.time) : '',
    meal.servings !== 1 ? `${grams(meal.servings)} servings` : '',
    meal.source === 'photo' ? 'from a photo' : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="ml-row" data-open={open || undefined}>
      <Press className="ml-row-main" aria-expanded={open} onPress={onToggle}>
        <span className="ml-row-name">
          {meal.photoId && <img className="ml-thumb" src={mealPhotoUrl(meal.photoId)} alt="" loading="lazy" draggable={false} />}
          <span className="ml-row-text">
            <b>{meal.name}</b>
            {meta && <span>{meta}</span>}
          </span>
        </span>
        {wide && GRAMS.slice(0, 3).map((m) => <span key={m.key} className="ml-row-g">{grams(meal[m.key] * f)}<i>g</i></span>)}
        <span className="ml-row-cal"><b>{kcal(meal.calories * f)}</b>{!wide && <i> cal</i>}</span>
      </Press>
      {open && <MealEdit meal={meal} onDone={onToggle} />}
    </div>
  )
}

const mealCopy = (m: Meal): NewMeal => ({
  date: m.date, name: m.name, slot: m.slot, time: m.time, servings: m.servings, calories: m.calories, protein: m.protein,
  carbs: m.carbs, fat: m.fat, fiber: m.fiber, note: m.note, source: m.source, photoId: m.photoId,
})

function MealEdit({ meal, onDone }: { meal: Meal; onDone: () => void }) {
  const qc = useQueryClient()
  const [servings, setServings] = useState(String(meal.servings))
  const [error, setError] = useState('')
  const changed = num(servings) > 0 && num(servings) !== meal.servings
  const patch = useMutation({
    mutationFn: () => updateMeal(meal.id, { servings: num(servings) }),
    onSuccess: () => { invalidateMeals(qc); toast(`${meal.name}: ${grams(num(servings))} servings`); onDone() },
    onError: (e: unknown) => setError(apiErrorText(e, 'Could not change the servings')),
  })
  const remove = useMutation({
    mutationFn: () => deleteMeal(meal.id),
    onSuccess: () => {
      invalidateMeals(qc)
      const copy = mealCopy(meal)
      toast(`Deleted ${meal.name}`, {
        ms: 6000,
        action: {
          label: 'Undo',
          run: () => {
            createMeal(copy).then(() => { invalidateMeals(qc); toast(`${meal.name} is back`) }, (e: unknown) => toast(`Undo failed: ${apiErrorText(e, 'no answer')}`))
          },
        },
      })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'Could not delete that entry')),
  })
  const stepBy = (d: number) => setServings((s) => String(Math.max(0.25, Math.round((num(s) + d) * 4) / 4)))
  return (
    <div className="ml-edit">
      <p className="ml-per">
        Per serving: {kcal(meal.calories)} cal
        {GRAMS.map((m) => ` · ${grams(meal[m.key])} g ${m.label.toLowerCase()}`).join('')}
      </p>
      {meal.note && <p className="ml-note">{meal.note}</p>}
      <div className="ml-edit-row">
        <span className="ml-k">Servings</span>
        <span className="ml-stepper">
          <Press className="ml-sbtn" aria-label="Half a serving less" onPress={() => stepBy(-0.5)}><Lc C={Minus} size={13} /></Press>
          <input
            className="ml-field ml-sfield"
            inputMode="decimal"
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && changed) patch.mutate() }}
            aria-label="Servings"
          />
          <Press className="ml-sbtn" aria-label="Half a serving more" onPress={() => stepBy(0.5)}><Lc C={Plus} size={13} /></Press>
        </span>
        {changed && (
          <Button kind="line" className="ml-save" disabled={patch.isPending} onPress={() => patch.mutate()}>{patch.isPending ? 'Saving' : 'Save'}</Button>
        )}
        <Press className="vl-link vl-hit ml-del" disabled={remove.isPending} onPress={() => { setError(''); remove.mutate() }}>
          <Lc C={Trash2} size={13} />{remove.isPending ? 'Deleting' : 'Delete'}
        </Press>
      </div>
      {error && <p className="ml-err">{error}</p>}
    </div>
  )
}

// ---------- logging food ----------

type AddMode = 'photo' | 'hand'
const MODE_KEY = 'v2.meals.add'
const storedMode = (): AddMode => {
  try { return localStorage.getItem(MODE_KEY) === 'hand' ? 'hand' : 'photo' } catch { return 'photo' }
}

function AddPanel({ date, onClose }: { date: string; onClose?: () => void }) {
  const [mode, setModeState] = useState<AddMode>(storedMode)
  const setMode = (m: AddMode) => {
    setModeState(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* storage unavailable */ }
  }
  return (
    <section className="ml-add" aria-label="Log food">
      <div className="ml-add-head">
        <Section icon="add">Log food</Section>
        <Segmented
          className="ml-mode"
          options={[{ value: 'photo', label: 'Photo', icon: <Lc C={Camera} size={13} tone={mode === 'photo' ? 'ink' : 'dim'} /> }, { value: 'hand', label: 'By hand' }]}
          value={mode}
          onChange={setMode}
        />
        {onClose && <Press className="ml-x vl-hit" aria-label="Close" onPress={onClose}><Glyph name="close" size={11} /></Press>}
      </div>
      {mode === 'photo' ? <PhotoEstimate date={date} /> : <HandForm date={date} />}
    </section>
  )
}

const blankHand = () => ({ name: '', time: nowTime(), servings: '1', calories: '', protein: '', carbs: '', fat: '', fiber: '', note: '' })

function HandForm({ date }: { date: string }) {
  const qc = useQueryClient()
  const [d, setD] = useState(blankHand)
  const [slot, setSlot] = useState(slotForNow)
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: () => createMeal({
      date,
      name: d.name.trim(),
      slot,
      time: d.time,
      servings: num(d.servings) || 1,
      calories: num(d.calories),
      protein: num(d.protein),
      carbs: num(d.carbs),
      fat: num(d.fat),
      fiber: num(d.fiber),
      note: d.note.trim(),
      source: 'manual',
    }),
    onSuccess: (m) => { invalidateMeals(qc); toast(`Logged ${m.name}`); setD(blankHand()); setError('') },
    onError: (e: unknown) => setError(apiErrorText(e, 'Could not log that')),
  })
  const can = !!d.name.trim() && !save.isPending
  return (
    <form className="ml-form" onSubmit={(e) => { e.preventDefault(); if (can) save.mutate() }}>
      <input className="ml-field ml-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="What you ate" aria-label="What you ate" />
      <Segmented className="ml-slots" options={SLOT_OPTS} value={slot} onChange={setSlot} />
      <div className="ml-grid">
        <label className="ml-flabel ml-ftime">
          <span>Time</span>
          <input className="ml-field" type="time" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} />
        </label>
        <label className="ml-flabel">
          <span>Servings</span>
          <input className="ml-field" inputMode="decimal" value={d.servings} onChange={(e) => setD({ ...d, servings: e.target.value })} />
        </label>
        {MACROS.map((m) => (
          <label key={m.key} className="ml-flabel">
            <span>{m.label}{m.unit && ` (${m.unit})`}</span>
            <input className="ml-field" inputMode="decimal" value={d[m.key]} placeholder="0" onChange={(e) => setD({ ...d, [m.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <input className="ml-field" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="Note (optional)" aria-label="Note" />
      <div className="ml-acts">
        <Button icon="add" disabled={!can} onPress={() => { if (can) save.mutate() }}>{save.isPending ? 'Logging' : 'Log it'}</Button>
        <span className="ml-hint">Macros are per serving.</span>
      </div>
      {error && <p className="ml-err">{error}</p>}
      <button type="submit" hidden />
    </form>
  )
}

function PhotoEstimate({ date }: { date: string }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [pending, setPending] = useState<{ base64: string; mime: string } | null>(null)
  const [hint, setHint] = useState('')
  const [items, setItems] = useState<EstimatedItem[] | null>(null)
  const [notes, setNotes] = useState('')
  const [photoId, setPhotoId] = useState('')
  const [slot, setSlot] = useState(slotForNow)
  const [error, setError] = useState('')
  const [over, setOver] = useState(false)

  const reset = () => {
    setPreview(null); setPending(null); setHint(''); setItems(null); setNotes(''); setPhotoId(''); setError('')
    if (fileRef.current) fileRef.current.value = ''
  }
  const pick = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('That is not a picture'); return }
    setError(''); setItems(null); setNotes(''); setPhotoId('')
    try {
      const { base64, mime, previewUrl } = await prepareImage(file)
      setPreview(previewUrl)
      setPending({ base64, mime })
    } catch {
      setError('Could not read that picture')
    }
  }
  const estimate = useMutation({
    mutationFn: () => estimateMealPhoto({ imageBase64: pending!.base64, mime: pending!.mime, hint: hint.trim() || undefined }),
    onSuccess: (r) => { setItems(r.items); setNotes(r.notes); setPhotoId(r.photoId); setError(r.items.length ? '' : 'Claude found no food in that picture') },
    onError: (e: unknown) => setError(apiErrorText(e, 'The estimate failed')),
  })
  const logAll = useMutation({
    mutationFn: async () => {
      const time = nowTime()
      for (const it of items ?? []) {
        await createMeal({
          date,
          name: it.portion ? `${it.name} (${it.portion})` : it.name,
          slot,
          time,
          servings: it.servings || 1,
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
    onSuccess: () => { invalidateMeals(qc); toast(`Logged ${items?.length ?? 0} ${items?.length === 1 ? 'item' : 'items'}`); reset() },
    onError: (e: unknown) => { invalidateMeals(qc); setError(apiErrorText(e, 'Could not log those items')) },
  })
  const patchItem = (i: number, p: Partial<EstimatedItem>) => setItems((prev) => (prev ? prev.map((it, k) => (k === i ? { ...it, ...p } : it)) : prev))
  const plate = useMemo(() => {
    const t = { ...ZERO }
    for (const it of items ?? []) for (const m of MACROS) t[m.key] += (Number(it[m.key]) || 0) * (Number(it.servings) || 1)
    return t
  }, [items])

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setOver(false)
    void pick(e.dataTransfer.files?.[0])
  }

  return (
    <div className="ml-photo">
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      {!preview ? (
        <Press
          className="ml-drop"
          data-over={over || undefined}
          onPress={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Lc C={Camera} size={20} lit={over} />
          <b>Take or pick a photo</b>
          <span>Claude reads the plate and returns per-serving macros you can correct before logging.</span>
        </Press>
      ) : (
        <div className="ml-shot">
          <img src={preview} alt="The meal" draggable={false} />
          <div className="ml-shot-side">
            <input
              className="ml-field"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Anything Claude can't see (cooked in butter, 8 oz)"
              aria-label="A hint for the estimate"
            />
            <div className="ml-acts">
              <Button
                icon={<Lc C={Sparkles} size={14} tone={items ? 'dim' : 'ink'} />}
                kind={items ? 'line' : 'plate'}
                disabled={estimate.isPending || !pending}
                onPress={() => estimate.mutate()}
              >
                {estimate.isPending ? 'Asking Claude' : items ? 'Estimate again' : 'Estimate macros'}
              </Button>
              <Press className="vl-link vl-hit" onPress={reset}>Clear</Press>
            </div>
            {notes && <p className="ml-hint">{notes}</p>}
          </div>
        </div>
      )}
      {error && <p className="ml-err">{error}</p>}
      {items && items.length > 0 && (
        <div className="ml-items">
          {items.map((it, i) => (
            <div key={i} className="ml-item">
              <div className="ml-item-head">
                <input className="ml-field ml-item-name" value={it.name} onChange={(e) => patchItem(i, { name: e.target.value })} aria-label="Item" />
                <Press className="ml-x vl-hit" aria-label={`Drop ${it.name}`} onPress={() => setItems((prev) => (prev ? prev.filter((_, k) => k !== i) : prev))}>
                  <Lc C={Trash2} size={13} />
                </Press>
              </div>
              <span className="ml-item-sub" data-conf={it.confidence}>{it.portion ? `${it.portion} · ` : ''}{it.confidence} confidence</span>
              <div className="ml-item-nums">
                <label className="ml-flabel">
                  <span>Servings</span>
                  <input className="ml-field" inputMode="decimal" value={String(it.servings)} onChange={(e) => patchItem(i, { servings: num(e.target.value) })} />
                </label>
                {MACROS.map((m) => (
                  <label key={m.key} className="ml-flabel">
                    <span>{m.short}</span>
                    <input className="ml-field" inputMode="decimal" value={String(it[m.key])} onChange={(e) => patchItem(i, { [m.key]: num(e.target.value) } as Partial<EstimatedItem>)} />
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="ml-plate">
            <span className="ml-k">Plate total</span>
            <span>{MACROS.map((m) => `${fmtMacro(m.key, plate[m.key])}${m.unit ? ` g ${m.label.toLowerCase()}` : ' cal'}`).join(' · ')}</span>
          </div>
          <Segmented className="ml-slots" options={SLOT_OPTS} value={slot} onChange={setSlot} />
          <div className="ml-acts">
            <Button icon="add" disabled={logAll.isPending} onPress={() => logAll.mutate()}>
              {logAll.isPending ? 'Logging' : `Log ${items.length} ${items.length === 1 ? 'item' : 'items'}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- the last 14 days ----------

function WeekStrip({ date, today, target, onPick }: { date: string; today: string; target: number | null; onPick: (d: string) => void }) {
  // ends today while the day shown is in the last two weeks, else on the day shown
  const end = date > today || date < shiftDate(today, -13) ? date : today
  const from = shiftDate(end, -13)
  const range = useQuery({ queryKey: ['meals', 'range', from, end], queryFn: () => fetchMealRange(from, end) })
  const days = useMemo(() => {
    const got = new Map((range.data?.days ?? []).map((d) => [d.date, d]))
    return Array.from({ length: 14 }, (_, k) => {
      const key = shiftDate(from, k)
      const d = got.get(key)
      return { date: key, cal: d?.totals.calories ?? 0, protein: d?.totals.protein ?? 0, entries: d?.entries ?? 0 }
    })
  }, [range.data, from])
  if (!range.data) return null
  const logged = days.filter((d) => d.entries > 0)
  const avg = logged.length ? logged.reduce((s, d) => s + d.cal, 0) / logged.length : 0
  const peak = Math.max(target ?? 0, ...days.map((d) => d.cal), 1)
  return (
    <section className="ml-week" aria-label="The last 14 days">
      <Section icon="trades" action={logged.length ? <span className="ml-count">avg {kcal(avg)} cal</span> : undefined}>Last 14 days</Section>
      <div className="ml-bars" style={{ '--t': target ? `${(target / peak) * 100}%` : undefined } as CSSProperties} data-target={target ? '' : undefined}>
        {days.map((d) => {
          const k = keyDate(d.date)
          const overT = target != null && d.cal > target
          return (
            <Press
              key={d.date}
              className="ml-bcol"
              data-on={d.date === date || undefined}
              data-today={d.date === today || undefined}
              aria-label={`${k.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}: ${kcal(d.cal)} cal, ${grams(d.protein)} g protein`}
              title={`${kcal(d.cal)} cal · ${grams(d.protein)} g protein`}
              onPress={() => onPick(d.date)}
            >
              <span className="ml-bbox">
                <i data-over={overT || undefined} style={{ height: `${Math.max(d.cal ? 3 : 0, (d.cal / peak) * 100)}%` }} />
              </span>
              <span className="ml-bday">{k.toLocaleDateString('en-US', { weekday: 'narrow' })}</span>
              <span className="ml-bnum">{k.getDate()}</span>
            </Press>
          )
        })}
      </div>
    </section>
  )
}

// ---------- daily targets ----------

function Targets({ targets, ready }: { targets: MacroTargets; ready: boolean }) {
  const qc = useQueryClient()
  const anySet = MACROS.some((m) => targets[m.key] != null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<MacroKey, string>>(() => ({
    calories: targets.calories?.toString() ?? '',
    protein: targets.protein?.toString() ?? '',
    carbs: targets.carbs?.toString() ?? '',
    fat: targets.fat?.toString() ?? '',
    fiber: targets.fiber?.toString() ?? '',
  }))
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: () => saveMacroTargets(Object.fromEntries(MACROS.map((m) => [m.key, draft[m.key].trim() === '' ? null : num(draft[m.key])])) as Partial<MacroTargets>),
    onSuccess: () => { invalidateMeals(qc); toast('Targets saved'); setEditing(false) },
    onError: (e: unknown) => setError(apiErrorText(e, 'Could not save the targets')),
  })
  if (!ready) return null
  const open = editing || !anySet
  return (
    <section className="ml-targets" aria-label="Daily targets">
      <Section icon="gauge" action={!open ? <Press className="vl-link vl-hit" onPress={() => setEditing(true)}>Edit</Press> : undefined}>Targets</Section>
      {!open ? (
        <p className="ml-tline">
          {MACROS.filter((m) => targets[m.key] != null).map((m) => (
            <span key={m.key}><b>{fmtMacro(m.key, targets[m.key] ?? 0)}</b>{m.unit ? ` g ${m.label.toLowerCase()}` : ' cal'}</span>
          ))}
        </p>
      ) : (
        <form className="ml-form" onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate() }}>
          <div className="ml-grid ml-tgrid">
            {MACROS.map((m) => (
              <label key={m.key} className="ml-flabel">
                <span>{m.label}{m.unit && ` (${m.unit})`}</span>
                <input className="ml-field" inputMode="decimal" value={draft[m.key]} placeholder="None" onChange={(e) => setDraft({ ...draft, [m.key]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="ml-acts">
            <Button kind="line" disabled={save.isPending} onPress={() => save.mutate()}>{save.isPending ? 'Saving' : 'Save targets'}</Button>
            {anySet && <Press className="vl-link vl-hit" onPress={() => setEditing(false)}>Cancel</Press>}
            <span className="ml-hint">Leave a box empty to track that macro without a goal.</span>
          </div>
          {error && <p className="ml-err">{error}</p>}
          <button type="submit" hidden />
        </form>
      )}
    </section>
  )
}

