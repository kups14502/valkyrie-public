import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { CalendarEvent } from '../../lib/calendarApi'
import { DAY_MS, addDays, dateKey, hm, timeLabel } from '../../lib/calendarDates'

// The day / work week / week views: one column per day, an hour scale down the
// side, timed events placed by the minute, all-day events in a strip on top.
// Laid out like Outlook's because that is the calendar Brendon reads all day.

export type SlotSeed = { date: string; startTime?: string; endTime?: string; allDay?: boolean }

const HOUR_PX = 44
const SLOT_MIN = 30
const SLOT_PX = (HOUR_PX * SLOT_MIN) / 60
const SLOTS = (24 * 60) / SLOT_MIN
const GUTTER = '3rem'

/** All-day in this grid: flagged so, or timed but a whole day or longer. */
const spansDays = (ev: CalendarEvent) => ev.allDay || Date.parse(ev.end) - Date.parse(ev.start) >= DAY_MS

const overlapsDay = (ev: CalendarEvent, day: Date) =>
  Date.parse(ev.end) > day.getTime() && Date.parse(ev.start) < addDays(day, 1).getTime()

const tint = (color: string) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}26` : 'rgba(255,255,255,0.06)')

type Placed = { ev: CalendarEvent; top: number; height: number; col: number; cols: number }

/**
 * Place a day's timed events. Events that overlap, directly or through a chain,
 * form a cluster; each takes the first free column in it, and the whole cluster
 * shares its width by the column count.
 */
function layoutDay(events: CalendarEvent[], day: Date): Placed[] {
  const dayStart = day.getTime()
  const items = events
    .filter((ev) => !spansDays(ev) && overlapsDay(ev, day))
    .map((ev) => {
      const s = Math.max(0, (Date.parse(ev.start) - dayStart) / 60_000)
      const e = Math.min(24 * 60, (Date.parse(ev.end) - dayStart) / 60_000)
      return { ev, s, e: Math.max(e, s + 20) }
    })
    .sort((a, b) => a.s - b.s || b.e - a.e)

  const out: Placed[] = []
  let cluster: { item: (typeof items)[number]; col: number }[] = []
  let colEnds: number[] = []
  let clusterEnd = -1
  const flush = () => {
    for (const { item, col } of cluster) {
      out.push({
        ev: item.ev,
        top: (item.s / 60) * HOUR_PX,
        height: ((item.e - item.s) / 60) * HOUR_PX,
        col,
        cols: colEnds.length,
      })
    }
    cluster = []
    colEnds = []
  }
  for (const item of items) {
    if (item.s >= clusterEnd) { flush(); clusterEnd = -1 }
    let col = colEnds.findIndex((end) => end <= item.s)
    if (col === -1) { col = colEnds.length; colEnds.push(item.e) } else colEnds[col] = item.e
    cluster.push({ item, col })
    clusterEnd = Math.max(clusterEnd, item.e)
  }
  flush()
  return out
}

const slotAt = (e: PointerEvent<HTMLElement>) => {
  const rect = e.currentTarget.getBoundingClientRect()
  return Math.min(SLOTS - 1, Math.max(0, Math.floor((e.clientY - rect.top) / SLOT_PX)))
}

const hourText = (h: number) => (h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`)

export function TimeGrid({ days, events, onOpen, onCreate, onDay }: {
  days: Date[]
  events: CalendarEvent[]
  onOpen: (e: CalendarEvent) => void
  onCreate: (seed: SlotSeed) => void
  /** A day header was clicked: show that day on its own. */
  onDay: (key: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const touch = useRef<{ key: string; slot: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ key: string; a: number; b: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const todayKey = dateKey(new Date(now))
  const keys = days.map(dateKey)
  const placed = useMemo(() => days.map((d) => layoutDay(events, d)), [days, events])
  const allDay = useMemo(
    () => days.map((d) => events.filter((ev) => spansDays(ev) && overlapsDay(ev, d))),
    [days, events],
  )
  const allDayCap = days.length === 1 ? 99 : 3

  // Open on the working part of the day: an hour and a half before now when
  // today is shown, else 7am. Only when the range changes, never on a refetch.
  const rangeKey = `${keys[0]}:${keys.length}`
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const d = new Date()
    const minutes = keys.includes(dateKey(d)) ? d.getHours() * 60 + d.getMinutes() - 90 : 7 * 60
    el.scrollTop = Math.max(0, (minutes / 60) * HOUR_PX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey])

  const cols = { gridTemplateColumns: `${GUTTER} repeat(${days.length}, minmax(0, 1fr))` }
  const weekday = days.length > 1 ? 'short' : 'long'

  return (
    <div
      ref={scrollRef}
      className="max-h-[72dvh] min-h-[24rem] overflow-y-auto border border-[var(--color-border)] sm:max-h-[calc(100dvh-15rem)]"
    >
      <div className="sticky top-0 z-20 bg-[var(--color-bg)]">
        <div className="grid border-b border-[var(--color-border)]" style={cols}>
          <div />
          {days.map((d, i) => {
            const isToday = keys[i] === todayKey
            return (
              <button
                key={keys[i]}
                type="button"
                onClick={() => onDay(keys[i])}
                title="Show this day"
                className={`flex min-w-0 items-baseline gap-1.5 border-l border-t-2 border-l-[var(--color-border)] px-1.5 pb-1 pt-1 text-left sm:px-2 ${
                  isToday ? 'border-t-[var(--color-accent)]' : 'border-t-transparent'
                }`}
              >
                <span className={`font-mono text-base sm:text-lg ${isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                  {d.getDate()}
                </span>
                <span className="truncate text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] sm:text-[10px]">
                  {/* A phone week column is ~45px: one letter fits, "WED" does not. */}
                  <span className={days.length > 1 ? 'sm:hidden' : 'hidden'}>{d.toLocaleDateString([], { weekday: 'narrow' })}</span>
                  <span className={days.length > 1 ? 'hidden sm:inline' : ''}>{d.toLocaleDateString([], { weekday })}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="grid border-b border-[var(--color-border)]" style={cols}>
          <div className="self-center pr-1.5 text-right text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">all day</div>
          {days.map((_, i) => (
            <div
              key={keys[i]}
              role="button"
              tabIndex={-1}
              onClick={() => onCreate({ date: keys[i], allDay: true })}
              title="New all-day event"
              className="min-h-7 min-w-0 cursor-pointer space-y-0.5 border-l border-[var(--color-border)] p-0.5 hover:bg-[rgba(255,255,255,0.03)]"
            >
              {allDay[i].slice(0, allDayCap).map((ev, j) => (
                <button
                  key={`${ev.uid}-${ev.start}-${j}`}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpen(ev) }}
                  title={ev.summary}
                  className="block w-full truncate border-l-2 px-1 py-px text-left text-[11px] leading-snug text-[var(--color-text)]"
                  style={{ borderLeftColor: ev.color, background: tint(ev.color) }}
                >
                  {ev.summary}
                </button>
              ))}
              {allDay[i].length > allDayCap && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDay(keys[i]) }}
                  className="block pl-1 text-[10px] text-[var(--color-text-faint)] hover:text-[var(--color-accent)]"
                >
                  +{allDay[i].length - allDayCap} more
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid" style={{ ...cols, height: 24 * HOUR_PX }}>
        <div className="relative">
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <div
              key={h}
              className="absolute right-1.5 -translate-y-1/2 font-mono text-[10px] text-[var(--color-text-faint)]"
              style={{ top: h * HOUR_PX }}
            >
              {hourText(h)}
            </div>
          ))}
        </div>
        {days.map((d, i) => {
          const key = keys[i]
          const nowTop = key === todayKey ? ((now - d.getTime()) / 3_600_000) * HOUR_PX : null
          const sel = drag?.key === key ? { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) } : null
          return (
            <div
              key={key}
              className="relative cursor-pointer touch-pan-y border-l border-[var(--color-border)]"
              style={{
                backgroundImage: 'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
                backgroundSize: `100% ${HOUR_PX}px, 100% ${HOUR_PX}px`,
                backgroundPosition: `0 0, 0 ${SLOT_PX}px`,
              }}
              // Mouse: press and drag down the column to pick a span. Touch: a
              // tap picks the half hour; a swipe is left alone so it scrolls.
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return
                const slot = slotAt(e)
                if (e.pointerType === 'mouse') {
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDrag({ key, a: slot, b: slot })
                } else {
                  touch.current = { key, slot, y: e.clientY }
                }
              }}
              onPointerMove={(e) => {
                if (drag?.key !== key) return
                const slot = slotAt(e)
                if (slot !== drag.b) setDrag({ ...drag, b: slot })
              }}
              onPointerUp={(e) => {
                if (drag?.key === key) {
                  const lo = Math.min(drag.a, drag.b)
                  const hi = Math.max(drag.a, drag.b)
                  const end = hi === lo ? lo + 2 : hi + 1
                  setDrag(null)
                  onCreate({ date: key, startTime: hm(lo * SLOT_MIN), endTime: hm(Math.min(end, SLOTS) * SLOT_MIN) })
                  return
                }
                const t = touch.current
                touch.current = null
                if (t?.key === key && Math.abs(e.clientY - t.y) < 8) {
                  onCreate({ date: key, startTime: hm(t.slot * SLOT_MIN), endTime: hm(Math.min(t.slot + 2, SLOTS) * SLOT_MIN) })
                }
              }}
              onPointerCancel={() => { setDrag(null); touch.current = null }}
            >
              {sel && (
                <div
                  className="pointer-events-none absolute inset-x-0.5 z-10 border border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.14)] px-1 text-[10px] text-[var(--color-accent)]"
                  style={{ top: sel.lo * SLOT_PX, height: (sel.hi - sel.lo + 1) * SLOT_PX }}
                >
                  {hm(sel.lo * SLOT_MIN)} – {hm(((sel.hi + 1) * SLOT_MIN) % (24 * 60))}
                </div>
              )}
              {placed[i].map((p, j) => (
                <button
                  key={`${p.ev.uid}-${p.ev.start}-${j}`}
                  type="button"
                  onClick={() => onOpen(p.ev)}
                  title={`${p.ev.summary}\n${timeLabel(p.ev.start)} – ${timeLabel(p.ev.end)}`}
                  className="absolute z-[5] flex flex-col justify-start overflow-hidden border-l-2 px-1 py-0.5 text-left leading-tight transition-[filter] hover:brightness-150 sm:px-1.5"
                  style={{
                    top: p.top + 1,
                    height: Math.max(16, p.height - 2),
                    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                    width: `calc(${100 / p.cols}% - 4px)`,
                    borderLeftColor: p.ev.color,
                    background: tint(p.ev.color),
                  }}
                >
                  <span className="block truncate text-[11px] text-[var(--color-text)]">{p.ev.summary}</span>
                  {p.height >= 34 && (
                    <span className="block truncate text-[10px] text-[var(--color-text-dim)]">
                      {timeLabel(p.ev.start)} – {timeLabel(p.ev.end)}
                    </span>
                  )}
                  {p.height >= 56 && p.ev.location && (
                    <span className="block truncate text-[10px] text-[var(--color-text-faint)]">{p.ev.location}</span>
                  )}
                </button>
              ))}
              {nowTop != null && nowTop >= 0 && nowTop <= 24 * HOUR_PX && (
                <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-[var(--color-accent)]" style={{ top: nowTop }}>
                  <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-[var(--color-accent)]" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
