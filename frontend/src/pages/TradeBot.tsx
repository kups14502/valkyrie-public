import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import {
  fetchTradeBotPage,
  type TradeBotArm,
  type TradeBotCaps,
  type TradeBotDecision,
  type TradeBotDoc,
  type TradeBotFill,
  type TradeBotPage,
  type TradeBotSnapshot,
} from '../lib/api'

// Trade bot v2 page. Every figure comes from the v2 pipeline via
// /api/tradebot/page: status.json (the 5-minute generator), broker_snapshot.json
// (equity_sampler's read-only export) and the parsed decision feed.
//
// Two honesty rules this page exists to keep:
//  1. Total-value change is NOT performance. history.change_usd is the
//     deposit-adjusted trading P&L; net_flows_usd is transfers and is shown
//     separately. A $N deposit is never dressed up as a gain.
//  2. Nothing is invented. Zero positions and zero v2 trades render as an
//     explicit empty state, never as a placeholder row or an approximation.
//
// Colour, and it is a contract:
//  * --color-danger is ONLY for something that is actually wrong and wants a
//    human. In practice that is exactly three things: the page endpoint failing
//    to load, a stale (fallback) equity figure, and rules_ok false. A missing
//    broker snapshot degrades to a neutral empty state instead, because the rest
//    of the page is still true and unknown-positions is not an alarm.
//    Routine operation never gets red. In
//    particular the confidence gate refusing a trade is this bot's own risk
//    control doing its job, so it reads in the neutral palette, not in red.
//  * --color-accent is EMPHASIS, never "good" — the user's hue picker recolours
//    it at runtime, so "green = good" is not available and is not implied. It
//    marks the rare event worth a human's eye: a scan that cleared the gate, or
//    one that actually reached the broker.
//  * everything else is --color-text / -dim / -faint / --color-border.
// Every coloured mark is still paired with a bracketed word, so colour is never
// the sole encoding.

// ---------- formatting ----------

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const usd = (v: unknown, digits = 2): string => {
  const n = num(v)
  return n == null
    ? '—'
    : n.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
}

const signedUsd = (v: unknown, digits = 2): string => {
  const n = num(v)
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}${usd(Math.abs(n), digits)}`
}

const signedPct = (v: unknown, digits = 2): string => {
  const n = num(v)
  return n == null ? '—' : `${n < 0 ? '' : '+'}${n.toFixed(digits)}%`
}

/** A config fraction (0.25) as a signed percent string (+25.0%). */
const capPct = (v: unknown, digits = 1): string => {
  const n = num(v)
  return n == null ? '—' : `${n < 0 ? '' : '+'}${(n * 100).toFixed(digits)}%`
}

const unsignedCapPct = (v: unknown, digits = 1): string => capPct(v, digits).replace('+', '')

const ageMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Date.now() - t : null
}

/** Real elapsed time against the wall clock, never a value baked into a file. */
const fmtAge = (iso: string | null | undefined): string => {
  const ms = ageMs(iso)
  if (ms == null) return '—'
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtClock = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

const fmtDay = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const qty = (v: unknown): string => {
  const n = num(v)
  return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

// ---------- shared bits ----------

const DIM = 'text-[var(--color-text-dim)]'
const FAINT = 'text-[var(--color-text-faint)]'
/** Reserved. See the colour contract at the top of the file: real faults only. */
const BAD = 'text-[var(--color-danger)]'
const LABEL = `text-[10px] uppercase tracking-[0.14em] sm:tracking-[0.28em] ${FAINT}`

/** `bad` is for a real fault (down, failing, tampered). Accent is emphasis. */
function Tag({ children, bad, faint }: { children: string; bad?: boolean; faint?: boolean }) {
  const tone = bad ? BAD : faint ? FAINT : 'text-[var(--color-accent)]'
  return (
    <span className={`shrink-0 text-[10px] uppercase tracking-[0.18em] ${tone}`}>[{children}]</span>
  )
}

/**
 * A figure. Deliberately has no "bad" tone: a number being negative is a market
 * outcome, not a fault, and red here would compete with the marks that mean
 * something is broken. The sign is already in the value (-$12.34 / -1.20%).
 */
function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <div className="mt-1.5 truncate text-xl font-semibold tracking-tight text-[var(--color-text)]">{value}</div>
      {sub && <div className={`mt-1 text-[11px] leading-snug ${DIM}`}>{sub}</div>}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className={`border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-xs ${DIM}`}>
      {children}
    </div>
  )
}

// ---------- 2. equity chart ----------

/**
 * Total account value over the status window. Deliberately labelled "total
 * value", not performance: the series includes transfers, and the $N -> $N
 * step in it is a deposit. The trading P&L figure beside it is the honest one.
 *
 * Non-uniform SVG scaling is used for the polyline only (with a non-scaling
 * stroke); the markers are HTML so they stay round at any container width.
 */
function EquityChart({ points }: { points: { ts: string; total: number }[] }) {
  const rows = points.filter((p) => num(p.total) != null)
  if (rows.length < 2) {
    return (
      <div className={`mt-3 text-[11px] ${FAINT}`}>
        [{rows.length === 1 ? 'one sample only' : 'no samples'}] — the chart needs two
      </div>
    )
  }
  const values = rows.map((p) => p.total)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (max - min < Math.max(0.01, Math.abs(max) * 0.0001)) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.12
  const lo = min - pad
  const hi = max + pad
  const at = (v: number) => ((v - lo) / (hi - lo)) * 100
  const xs = values.map((_, i) => (i / (values.length - 1)) * 100)

  return (
    <div className="mt-3">
      <div className="relative" style={{ height: 64 }}>
        {/* hairline solid rules; never dashed — dashes read as a threshold */}
        <div className="absolute inset-x-0 top-0 h-px bg-[var(--color-border)]" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-[var(--color-border)]" />
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline
            points={values.map((v, i) => `${xs[i].toFixed(2)},${(100 - at(v)).toFixed(2)}`).join(' ')}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {values.map((v, i) => (
          <div
            key={`${rows[i].ts}-${i}`}
            title={`${fmtDay(rows[i].ts)} ${fmtClock(rows[i].ts)} · ${usd(v)} total value`}
            className="absolute hidden sm:block h-2 w-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-[var(--color-accent)]"
            style={{ left: `${xs[i]}%`, bottom: `${at(v)}%`, boxShadow: '0 0 0 2px var(--color-surface)' }}
          />
        ))}
      </div>
      <div className={`mt-1.5 flex items-baseline justify-between gap-2 text-[10px] tabular-nums ${FAINT}`}>
        <span>{fmtDay(rows[0].ts)}</span>
        <span className="truncate">
          {usd(min, 0)} – {usd(max, 0)} total value (incl. transfers)
        </span>
        <span>{fmtDay(rows[rows.length - 1].ts)}</span>
      </div>
    </div>
  )
}

// ---------- 3. decision feed ----------

/**
 * Per-row confidence bar with the gate threshold marked in place. The gate mark
 * is a neutral reference tick — it is a number out of config, and landing under
 * it is the ordinary outcome, not a fault. Only a bar that reached the gate
 * takes the accent, so the rare row is the one that lights up. The tick is taller
 * than the bar, so it stays readable even where a cleared fill runs past it.
 */
function ConfMeter({
  confidence,
  threshold,
  emphasis,
}: {
  confidence: number | null
  threshold: number | null
  emphasis: boolean
}) {
  const c = num(confidence)
  if (c == null) return null
  const t = num(threshold)
  return (
    <div className="relative h-1.5 w-full min-w-[56px] bg-[var(--color-border)]">
      <div
        className={`absolute inset-y-0 left-0 ${emphasis ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-dim)]'}`}
        style={{ width: `${Math.max(0, Math.min(1, c)) * 100}%` }}
      />
      {t != null && (
        <div
          className="absolute -inset-y-1 w-0.5 bg-[var(--color-text)]"
          style={{ left: `${Math.max(0, Math.min(1, t)) * 100}%` }}
        />
      )}
    </div>
  )
}

/**
 * One judged scan.
 *
 * The gate refusing a trade is the risk control Brendon wrote doing exactly its
 * job, so a held row is drawn in the neutral palette — no red, no alarm. The
 * emphasis goes on the rare row instead: a scan that reached
 * min_confidence_to_trade (or one that actually reached the broker) takes the
 * accent border and an accent tag, because that is the row worth reading.
 */
function DecisionRow({ d, threshold }: { d: TradeBotDecision; threshold: number | null }) {
  const executed = d.gate === 'executed'
  // "held", not "blocked by gate": nothing failed, a rule declined to trade. The
  // wording must not imply an error, and must not imply a trade happened either.
  const held = d.gate != null && !executed
  const conf = num(d.confidence)
  const t = num(threshold)
  // Cleared on confidence. Reported even when a later rule still held the trade,
  // since clearing the gate is the notable half. A scan that proposed nothing is
  // not credited with clearing anything — the gate was never the operative check.
  const cleared = conf != null && t != null && conf >= t
  const notable = executed || (held && cleared)
  const wanted = num(d.trades_proposed) ?? 0
  return (
    <div
      className={`border-l-2 py-2.5 pl-3 ${
        notable ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className={`shrink-0 text-[11px] tabular-nums ${FAINT}`}>
          {fmtDate(d.ts)} {fmtClock(d.ts)}
        </span>
        {/* one arm exists, so the label is a constant: it stays out of the way
            rather than spending the accent on every row */}
        <Tag faint>{d.arm}</Tag>
        <span className={`shrink-0 text-[11px] uppercase tracking-[0.14em] ${DIM}`}>
          {d.regime ?? 'regime unknown'}
        </span>
        <div className="flex min-w-[100px] flex-1 items-center gap-2">
          <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-text)]">
            {num(d.confidence) != null ? (d.confidence as number).toFixed(2) : '—'}
          </span>
          <ConfMeter confidence={d.confidence} threshold={threshold} emphasis={notable} />
        </div>
        {executed ? (
          <Tag>executed</Tag>
        ) : !held ? (
          <Tag faint>no trade wanted</Tag>
        ) : cleared ? (
          <>
            <Tag>cleared gate</Tag>
            <Tag faint>held</Tag>
          </>
        ) : conf != null && t != null ? (
          <Tag faint>below gate</Tag>
        ) : (
          <Tag faint>held</Tag>
        )}
      </div>
      <div className={`mt-1 flex flex-wrap items-baseline gap-x-3 text-[11px] tabular-nums ${FAINT}`}>
        <span>
          wanted {wanted} trade{wanted === 1 ? '' : 's'}
        </span>
        <span>trade_needed={String(d.trade_needed ?? 'null')}</span>
        {num(d.cost_usd) != null && <span>judge {usd(d.cost_usd, 4)}</span>}
      </div>
      {d.summary && <div className={`mt-1 text-xs leading-relaxed ${DIM}`}>{d.summary}</div>}
      {/* the reason, verbatim from the log — a fact, printed quietly */}
      {/* Routine, so not danger-coloured - but this is the operative fact of
          the row, so DIM rather than FAINT: quieter than the headline,
          still plainly readable. */}
      {held && <div className={`mt-1 text-[11px] leading-snug ${DIM}`}>{d.gate}</div>}
    </div>
  )
}

// ---------- 4. confidence vs gate ----------

/**
 * Confidence per scan against min_confidence_to_trade. One series: the reading is
 * positional (above or below the rule) so nothing depends on colour, and the rule
 * is directly labelled. Colour only sets emphasis — a scan that reached the rule
 * takes the accent, the ordinary ones stay dim — and the rule itself is a dashed
 * neutral reference, not a warning line. The decision feed is this chart's table
 * view — every plotted value is also printed there.
 */
function ConfidenceChart({
  decisions,
  threshold,
}: {
  decisions: TradeBotDecision[]
  threshold: number | null
}) {
  // Oldest -> newest so time reads left to right.
  const pts = decisions.filter((d) => num(d.confidence) != null).slice().reverse()
  if (pts.length === 0) {
    return <Empty>NO SCORED SCANS YET — the judge has not returned a confidence value.</Empty>
  }
  const t = num(threshold)
  const confs = pts.map((d) => d.confidence as number)
  const cleared = t == null ? 0 : confs.filter((c) => c >= t).length
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((v) => t == null || Math.abs(v - t) > 0.02)

  return (
    <div>
      <div className="relative" style={{ height: 132 }}>
        {ticks.map((v) => (
          <div
            key={v}
            className="absolute inset-x-0 h-px bg-[var(--color-border)]"
            style={{ bottom: `${v * 100}%` }}
          />
        ))}
        {t != null && (
          <>
            {/* the band under the rule is where a scan does not get to trade.
                That is a reference region and the normal one, so it is a neutral
                wash rather than a red zone. */}
            <div
              className="absolute inset-x-0 bottom-0 bg-[var(--color-text-faint)] opacity-[0.10]"
              style={{ height: `${t * 100}%` }}
            />
            {/* dashed reads as "threshold" in this app's chart language — which is
                why the equity chart deliberately keeps its own rules solid */}
            <div
              className="absolute inset-x-0 border-t border-dashed border-[var(--color-text-dim)]"
              style={{ bottom: `${t * 100}%` }}
            />
            <div
              className={`absolute right-0 bg-[var(--color-surface)] px-1 text-[9px] uppercase tracking-[0.18em] ${DIM}`}
              style={{ bottom: `calc(${t * 100}% + 5px)` }}
            >
              gate {t.toFixed(2)}
            </div>
          </>
        )}
        {pts.map((d, i) => {
          const c = d.confidence as number
          const x = pts.length === 1 ? 50 : (i / (pts.length - 1)) * 94 + 3
          const y = Math.max(0, Math.min(1, c)) * 100
          const below = t != null && c < t
          return (
            <div
              key={`${d.arm}-${d.ts}`}
              className="absolute bottom-0 h-full"
              style={{ left: `${x}%` }}
              title={`${fmtDate(d.ts)} ${fmtClock(d.ts)} · ${d.arm} · confidence ${c.toFixed(2)} · ${below ? 'below the gate, held' : 'cleared the gate'}`}
            >
              {/* stem: makes a dense run read as a distribution, not a scribble */}
              <div
                className="absolute bottom-0 w-px -translate-x-1/2 bg-[var(--color-border)]"
                style={{ height: `${y}%` }}
              />
              {/* same size for every scan — only the accent moves, and it moves
                  to the scan that reached the rule */}
              <div
                className={`absolute h-2.5 w-2.5 -translate-x-1/2 translate-y-1/2 rounded-full ${
                  below ? 'bg-[var(--color-text-dim)]' : 'bg-[var(--color-accent)]'
                }`}
                style={{ bottom: `${y}%`, boxShadow: '0 0 0 2px var(--color-surface)' }}
              />
            </div>
          )
        })}
      </div>
      <div className={`mt-2 flex items-baseline justify-between gap-2 text-[10px] tabular-nums ${FAINT}`}>
        <span>{fmtDate(pts[0].ts)}</span>
        <span className="truncate">oldest → newest · {pts.length} scored scans</span>
        <span>{fmtDate(pts[pts.length - 1].ts)}</span>
      </div>
      <div className={`mt-3 border-t border-[var(--color-border)] pt-2 text-[11px] leading-relaxed ${DIM}`}>
        {t == null ? (
          'min_confidence_to_trade is not readable from config_v2.json.'
        ) : cleared === 0 ? (
          <>
            <span className="text-[var(--color-text)]">[NEVER CLEARED]</span> all {pts.length} scored scans sit below
            the {t.toFixed(2)} gate (range {Math.min(...confs).toFixed(2)}–{Math.max(...confs).toFixed(2)}). That is
            why the bot has not traded.
          </>
        ) : (
          <>
            {cleared} of {pts.length} scans reached the {t.toFixed(2)} gate (range{' '}
            {Math.min(...confs).toFixed(2)}–{Math.max(...confs).toFixed(2)}).
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 5. arms ----------

function ArmRow({ name, arm }: { name: string; arm: TradeBotArm | undefined }) {
  if (!arm) {
    return (
      <div className="flex items-center justify-between gap-3 py-2">
        <span className={`text-xs uppercase tracking-[0.14em] ${DIM}`}>{name}</span>
        <Tag faint>no data</Tag>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-xs uppercase tracking-[0.14em] text-[var(--color-text)]">{name}</span>
        {arm.ok ? <Tag>ok</Tag> : <Tag bad>fail</Tag>}
      </div>
      <div className={`text-[11px] tabular-nums ${arm.ok ? FAINT : BAD}`}>
        {arm.detail || fmtAge(arm.last_run)} · {fmtClock(arm.last_run)}
      </div>
    </div>
  )
}

// ---------- 6. experiment ----------

function Progress({
  label,
  value,
  target,
  note,
}: {
  label: string
  value: number
  target: number
  note?: string
}) {
  const pct = target > 0 ? Math.max(0, Math.min(1, value / target)) * 100 : 0
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] uppercase tracking-[0.14em] ${DIM}`}>{label}</span>
        <span className="text-xs tabular-nums text-[var(--color-text)]">
          {value} / {target}
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 w-full bg-[var(--color-border)]">
        <div className="absolute inset-y-0 left-0 bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
      </div>
      {note && <div className={`mt-1 text-[10px] leading-snug ${FAINT}`}>{note}</div>}
    </div>
  )
}

// ---------- 8. fills ----------

function FillRow({ f }: { f: TradeBotFill }) {
  const notional = (num(f.quantity) ?? 0) * (num(f.price) ?? 0)
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1.5 text-[11px] tabular-nums">
      <span className={`shrink-0 ${FAINT}`}>
        {fmtDay(f.ts)} {fmtClock(f.ts)}
      </span>
      <span className={`w-9 shrink-0 uppercase tracking-[0.12em] ${DIM}`}>{f.side}</span>
      <span className="w-12 shrink-0 font-semibold text-[var(--color-text)]">{f.symbol}</span>
      <span className={`shrink-0 ${DIM}`}>
        {qty(f.quantity)} @ {usd(f.price, 4)}
      </span>
      <span className={`sm:ml-auto shrink-0 ${FAINT}`}>
        {usd(notional)} · {f.state ?? '?'}
        {f.placed_agent ? ` · ${f.placed_agent}` : ''}
      </span>
    </div>
  )
}

// ---------- page ----------

export default function TradeBot() {
  const q = useQuery({ queryKey: ['tradebot-page'], queryFn: fetchTradeBotPage, refetchInterval: 30_000 })
  const page = q.data

  return (
    <div className="space-y-4">
      <Header page={page} loading={q.isLoading} error={Boolean(q.error)} />
      {q.isLoading && !page ? (
        <Card>
          <div className={`text-sm ${DIM}`}>Loading trade bot…</div>
        </Card>
      ) : q.error || !page ? (
        <Card>
          <div className={`text-sm ${BAD}`}>
            [UNAVAILABLE] {(q.error as Error | undefined)?.message || 'the trade bot page could not be loaded'}
          </div>
          <div className={`mt-2 text-xs ${DIM}`}>
            /api/tradebot/page returns 503 while logs/status.json is missing — the 5-minute generator may not have
            run yet.
          </div>
        </Card>
      ) : (
        // Refetch holds the previous render at reduced opacity instead of
        // flashing a skeleton, so nothing on the page jumps every 30s.
        <div className={`space-y-4 transition-opacity ${q.isFetching ? 'opacity-90' : ''}`}>
          <Body page={page} />
        </div>
      )}
    </div>
  )
}

function Header({
  page,
  loading,
  error,
}: {
  page: TradeBotPage | undefined
  loading: boolean
  error: boolean
}) {
  const s = page?.status
  const stale = page?.stale === true
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <div className={`text-[9px] uppercase tracking-[0.35em] ${FAINT}`}>// trade-bot v2</div>
        <h1
          className="mt-1 text-2xl font-bold tracking-[0.12em]"
          style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}
        >
          trade bot<span className="cursor-blink">_</span>
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {s ? (
          <>
            {s.up ? <Tag>up</Tag> : <Tag bad>down</Tag>}
            <span className={`text-[11px] ${s.up ? DIM : BAD}`}>{s.up_detail}</span>
            <Tag faint={!s.market?.is_open}>
              {s.market?.is_open ? 'market open' : `market closed · ${s.market?.reason ?? 'unknown'}`}
            </Tag>
            <span className={`text-xs uppercase tracking-[0.18em] ${stale ? BAD : DIM}`}>
              [status {fmtAge(s.generated_at)}
              {stale ? ' · stale' : ''}]
            </span>
          </>
        ) : (
          <span className={`text-xs uppercase tracking-[0.18em] ${error ? BAD : FAINT}`}>
            [{loading ? 'loading' : 'unavailable'}]
          </span>
        )}
      </div>
    </div>
  )
}

function Body({ page }: { page: TradeBotPage }) {
  const s: TradeBotDoc = page.status
  const broker: TradeBotSnapshot | null = page.broker
  const caps: TradeBotCaps = page.config
  const threshold = num(caps.min_confidence_to_trade)
  const history = s.history

  return (
    <>
      <PortfolioPanel status={s} broker={broker} brokerError={page.broker_error} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Card title={`Decision feed · ${page.decisions.length} scan${page.decisions.length === 1 ? '' : 's'}`}>
          {(page.decisions_unverified ?? 0) > 0 && (
            <div className={`mb-3 border-l-2 border-[var(--color-border)] pl-2 text-[10px] leading-relaxed ${FAINT}`}>
              {page.decisions_unverified} log entr{page.decisions_unverified === 1 ? 'y' : 'ies'} withheld:
              no recorded judge call, so they are selftest output rather than real scans.
              Only scans the bot recorded paying for are shown.
            </div>
          )}
          <div className={`mb-3 text-[11px] leading-relaxed ${DIM}`}>
            Every judged scan: the regime it read, its confidence, whether it wanted to trade and what the gate did
            about it.
          </div>
          {page.decisions.length === 0 ? (
            <Empty>
              NO JUDGED SCANS IN THE LOG WINDOW — scan_v2 has not produced a verdict yet, or the log was rotated.
            </Empty>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {page.decisions.map((d) => (
                <DecisionRow key={`${d.arm}-${d.ts}`} d={d} threshold={threshold} />
              ))}
            </div>
          )}
        </Card>

        <div className="min-w-0 space-y-4">
          <Card title="Confidence vs gate">
            <ConfidenceChart decisions={page.decisions} threshold={threshold} />
          </Card>

          <Card title="Arms">
            <div className="divide-y divide-[var(--color-border)]">
              <ArmRow name="live scan" arm={s.arms?.live_scan} />
              <ArmRow name="guard" arm={s.arms?.guard} />
            </div>
            <div className={`mt-3 border-t border-[var(--color-border)] pt-2`}>
              <div className={LABEL}>guard thresholds</div>
              <div className={`mt-1 text-[11px] leading-relaxed tabular-nums ${DIM}`}>
                stop-loss {capPct(caps.stop_loss_pct)} full exit · gain-trim {capPct(caps.gain_trim_pct)} sells{' '}
                {unsignedCapPct(caps.gain_trim_partial_pct)} of the position
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ExperimentPanel status={s} broker={broker} />
        <SpendPanel status={s} />
        <JudgePanel caps={caps} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <PositionsPanel broker={broker} brokerError={page.broker_error} status={page.status} />
        <FillsPanel broker={broker} brokerError={page.broker_error} />
      </div>

      <div className={`space-y-1 text-[10px] leading-relaxed ${FAINT}`}>
        <div>
          status.json {fmtAge(s.generated_at)} · broker snapshot {fmtAge(broker?.generated_at)} · payload assembled{' '}
          {fmtAge(page.generated_at)}. Read from files under /home/brendon/trade-bot; this page never calls the
          broker.
        </div>
        {history && num(history.change_usd) != null && (
          <div>
            Trading P&amp;L is the {history.window_days}-day change with transfers removed. Total value moved{' '}
            {usd(history.first_total)} → {usd(history.last_total)}, of which {signedUsd(history.net_flows_usd)} was
            transferred in or out and is not performance.
          </div>
        )}
      </div>
    </>
  )
}

function PortfolioPanel({
  status,
  broker,
  brokerError,
}: {
  status: TradeBotDoc
  broker: TradeBotSnapshot | null
  brokerError: string | null
}) {
  const p = status.portfolio
  const h = status.history
  // "day_open" is the 09:40 fallback, not a live read. It is never presented as
  // the current equity without saying so.
  const isFallback = p?.live_equity_source === 'day_open'
  const equityAge = num(p?.live_equity_age_min)
  const flows = num(h?.net_flows_usd)
  const realized = num(broker?.realized?.pnl_usd)
  const trips = num(broker?.realized?.round_trips)
  const change = num(h?.change_usd)

  return (
    <Card title="Portfolio">
      <div className="grid gap-6 xl:grid-cols-[minmax(260px,1fr)_minmax(0,2.1fr)]">
        <div className="min-w-0">
          <div className={LABEL}>{isFallback ? 'equity · day-open fallback' : 'live equity'}</div>
          <div className="mt-1.5 text-4xl font-semibold tracking-tight text-[var(--color-text)]">
            {usd(p?.live_equity)}
          </div>
          {isFallback ? (
            <div className={`mt-1.5 text-[11px] leading-snug ${BAD}`}>
              [STALE] no live sample — this is the 09:40 day-open total
              {equityAge != null ? `, ${Math.round(equityAge)}m old` : ''}. Cash moved since then is not in it.
            </div>
          ) : (
            <div className={`mt-1.5 text-[11px] ${FAINT}`}>
              broker sample{equityAge != null ? ` · ${equityAge.toFixed(0)}m old` : ''}
              {p?.live_equity_source ? ` · source ${p.live_equity_source}` : ''}
            </div>
          )}
          {h?.points && h.points.length > 0 ? (
            <EquityChart points={h.points} />
          ) : (
            <div className={`mt-3 text-[11px] ${FAINT}`}>[no equity history]</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-3">
          <Field label="Buying power" value={usd(p?.live_cash)} sub="settled cash, T+1 account" />
          <Field
            label="Positions"
            value={broker ? String(broker.positions.length) : '—'}
            sub={
              broker
                ? broker.positions.length === 0
                  ? 'account is all cash'
                  : 'open equity positions'
                : 'snapshot unavailable'
            }
          />
          <Field
            label={`Trading P&L · ${h?.window_days ?? '?'}d`}
            value={change != null ? signedUsd(change) : '—'}
            sub={change == null ? 'no history yet' : `${signedPct(h?.change_pct)} · transfers excluded`}
          />
          <Field
            label="Transfers"
            value={flows == null ? '—' : signedUsd(flows)}
            sub={
              flows == null
                ? 'no history yet'
                : flows === 0
                  ? 'none in the window'
                  : `${h?.flows_detected ?? 0} detected · NOT performance`
            }
          />
          <Field
            label="Lifetime realized"
            value={realized != null ? signedUsd(realized) : '—'}
            sub={
              realized != null
                ? `${trips ?? 0} round trips · broker fills, FIFO`
                : (brokerError ?? (broker ? 'not in the snapshot' : 'snapshot unavailable'))
            }
          />
        </div>
      </div>
    </Card>
  )
}

function ExperimentPanel({ status, broker }: { status: TradeBotDoc; broker: TradeBotSnapshot | null }) {
  const e = status.experiment
  const target = num(e?.target_trips) ?? 100
  const lifetime = num(broker?.realized?.round_trips)
  const preregAt = e?.preregistered ? Date.parse(e.preregistered) : NaN

  // LIVE round trips are the whole experiment now: the paper arm was retired
  // 2026-08-04. Progress is counted from the pre-registration instant, not
  // lifetime, because the broker's round trips include the v1 era, which is not
  // this experiment. A round trip is one closing SELL order, so distinct sell
  // order ids after that instant is the same L2 count, date-restricted.
  //
  // status.py counts this from logs/broker_snapshot.json and is the source of
  // truth. The client-side count below is only a fallback for a status.json
  // written before that landed; it applies the same rule to the same data.
  let live = num(e?.live_trips)
  let note: string
  if (live != null) {
    note =
      lifetime != null
        ? `closing sells since pre-registration · ${lifetime} lifetime round trips predate it`
        : 'closing sells since pre-registration'
  } else if (broker && Number.isFinite(preregAt)) {
    const ids = new Set(
      broker.fills
        .filter((f) => f.side === 'sell' && Number.isFinite(Date.parse(f.ts)) && Date.parse(f.ts) > preregAt)
        // A fill with no order_id cannot be proven to be a distinct round trip;
        // counting '' once would overstate pre-registered progress.
        .map((f) => f.order_id)
        .filter((id): id is string => Boolean(id)),
    )
    live = ids.size
    note = `counted here from the newest ${broker.fills.length} fills, not from status.json`
  } else {
    live = 0
    note = 'snapshot unavailable — shown as zero, not estimated'
  }

  const rulesOk = e?.rules_ok
  return (
    <Card title="Experiment">
      {rulesOk === false && (
        <div className={`mb-3 border border-[var(--color-danger)] px-3 py-2 text-[11px] leading-relaxed ${BAD}`}>
          [RULES CHANGED] the live rule files no longer hash to the pre-registered value. The frozen trading path
          was modified, so results before and after this point are not the same experiment.
        </div>
      )}
      <div className="space-y-3">
        <Progress label="live round trips" value={live} target={target} note={note} />
      </div>
      <div className={`mt-3 space-y-1 border-t border-[var(--color-border)] pt-2 text-[11px] ${DIM}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span>pre-registered</span>
          <span className="tabular-nums text-[var(--color-text)]">{fmtDay(e?.preregistered)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span>rules hash</span>
          {rulesOk === true ? <Tag>match</Tag> : rulesOk === false ? <Tag bad>tamper</Tag> : <Tag faint>unknown</Tag>}
        </div>
      </div>
    </Card>
  )
}

// Both figures come from the same equity sample, so equality is a real check
// rather than two unrelated reads that happen to agree.
function allCashProvable(status: TradeBotDoc | null | undefined): boolean {
  const cash = num(status?.portfolio?.live_cash)
  const total = num(status?.portfolio?.live_equity)
  if (cash == null || total == null || total <= 0) return false
  return Math.abs(cash - total) < 0.01
}

function SpendPanel({ status }: { status: TradeBotDoc }) {
  const sp = status.spend
  const calls = num(sp?.calls_total) ?? 0
  const total = num(sp?.total_usd)
  const perCall = total != null && calls > 0 ? total / calls : null
  // Every judge call is priced into logs/cost_v2.jsonl by the bot itself, so
  // there is nothing modelled left to caveat. The old footnote about paper-arm
  // cost being derived from token counts went with the paper arm.
  return (
    <Card title="Judge spend">
      <div className="grid grid-cols-2 gap-x-5 gap-y-4">
        <Field label="Total" value={usd(total, 4)} sub={`since ${fmtDay(sp?.since)}`} />
        <Field label="Today" value={usd(sp?.today_usd, 4)} sub={`${num(sp?.calls_today) ?? 0} calls today`} />
        <Field label="Calls" value={String(calls)} sub="judge invocations" />
        <Field label="Per call" value={perCall != null ? usd(perCall, 4) : '—'} sub="mean cost" />
      </div>
      <div className={`mt-3 border-t border-[var(--color-border)] pt-2 text-[10px] leading-relaxed ${FAINT}`}>
        every cent is recorded by the bot in logs/cost_v2.jsonl — nothing here is estimated from token counts
      </div>
    </Card>
  )
}

function JudgePanel({ caps }: { caps: TradeBotCaps }) {
  const rows: [string, string][] = [
    ['min confidence', num(caps.min_confidence_to_trade)?.toFixed(2) ?? '—'],
    ['max single trade', unsignedCapPct(caps.max_single_trade_pct)],
    ['max position', unsignedCapPct(caps.max_position_pct)],
    ['max trades / day', num(caps.max_trades_per_day) != null ? String(caps.max_trades_per_day) : '—'],
    ['daily loss halt', capPct(caps.daily_loss_limit_pct)],
  ]
  return (
    <Card title="Judge & caps">
      <div className={LABEL}>model</div>
      <div className="mt-1 truncate text-sm text-[var(--color-text)]">{caps.model ?? '—'}</div>
      <div className={`mt-3 ${LABEL}`}>universe</div>
      <div className="mt-1 text-[11px] text-[var(--color-text)]">
        {caps.screener?.enabled ? (
          <>
            whole market, top {caps.screener.shortlist_size ?? '—'} movers
            {caps.screener.min_abs_change_pct != null
              ? ` past ±${caps.screener.min_abs_change_pct}%`
              : ''}
          </>
        ) : (
          <span className={FAINT}>pinned names only (screen off)</span>
        )}
      </div>
      {caps.screener?.enabled && (
        <div className={`mt-0.5 text-[10px] ${DIM}`}>
          {caps.screener.min_market_cap != null
            ? `over $${(caps.screener.min_market_cap / 1e9).toFixed(0)}B cap`
            : ''}
          {caps.screener.min_relative_volume != null
            ? `, rel vol over ${caps.screener.min_relative_volume}`
            : ''}
        </div>
      )}
      <div className={`mt-2 ${LABEL}`}>always shown</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {caps.watchlist.length === 0 ? (
          <span className={`text-xs ${FAINT}`}>—</span>
        ) : (
          caps.watchlist.map((sym) => (
            <span
              key={sym}
              className="border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)]"
            >
              {sym}
            </span>
          ))
        )}
      </div>
      <div className="mt-3 space-y-1 border-t border-[var(--color-border)] pt-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className={DIM}>{k}</span>
            <span className="tabular-nums text-[var(--color-text)]">{v}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function PositionsPanel({
  broker,
  brokerError,
  status,
}: {
  broker: TradeBotSnapshot | null
  brokerError: string | null
  status: TradeBotDoc | null | undefined
}) {
  return (
    <Card title={`Positions · ${broker ? broker.positions.length : '—'}`}>
      {!broker ? (
        <Empty>[SNAPSHOT UNAVAILABLE] {brokerError ?? 'broker_snapshot.json could not be read'}</Empty>
      ) : broker.positions.length === 0 ? (
        <Empty>
          NO OPEN EQUITY POSITIONS as of {fmtClock(broker.generated_at)} ({fmtAge(broker.generated_at)})
          {allCashProvable(status)
            ? ' — sampled cash equals total account value, so the account is all cash'
            : ' — this snapshot covers equity only; non-equity value is not shown'}
          .
        </Empty>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          <div className={`flex gap-3 pb-1.5 text-[10px] uppercase tracking-[0.18em] ${FAINT}`}>
            <span className="w-14">symbol</span>
            <span className="flex-1 text-right">qty</span>
            <span className="flex-1 text-right">sellable</span>
            <span className="flex-1 text-right">avg buy</span>
          </div>
          {broker.positions.map((pos) => (
            <div key={pos.symbol} className="flex gap-3 py-2 text-xs tabular-nums">
              <span className="w-14 font-semibold text-[var(--color-text)]">{pos.symbol}</span>
              <span className={`flex-1 truncate text-right ${DIM}`}>{qty(pos.quantity)}</span>
              <span className={`flex-1 truncate text-right ${DIM}`}>{qty(pos.shares_available_for_sells)}</span>
              <span className={`flex-1 truncate text-right ${DIM}`}>{usd(pos.average_buy_price, 4)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function FillsPanel({ broker, brokerError }: { broker: TradeBotSnapshot | null; brokerError: string | null }) {
  const fills = broker?.fills ?? []
  const newest = fills[0]?.ts
  return (
    <Card title={`Recent fills · ${broker ? fills.length : '—'}`}>
      {!broker ? (
        <Empty>[SNAPSHOT UNAVAILABLE] {brokerError ?? 'broker_snapshot.json could not be read'}</Empty>
      ) : fills.length === 0 ? (
        <Empty>NO FILLS ON RECORD — no order on this account has ever filled.</Empty>
      ) : (
        <>
          <div className={`mb-2 text-[11px] ${FAINT}`}>
            newest fill {fmtDay(newest)} ({fmtAge(newest)}) · broker order legs, newest first
          </div>
          <div className="max-h-none sm:max-h-[320px] divide-y divide-[var(--color-border)] overflow-y-auto">
            {fills.map((f, i) => (
              <FillRow key={`${f.order_id ?? 'x'}-${f.ts}-${i}`} f={f} />
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
