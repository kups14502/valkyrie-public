import { useQuery } from '@tanstack/react-query'
import { fetchTradeBotStatus } from '../../lib/api'
import { fmtAgo, fmtUSD } from './format'
import { Note, Section } from './Section'

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[15px] font-semibold tabular-nums leading-tight text-[var(--color-text)]">{value}</div>
      <div className="truncate text-[11px] text-[var(--color-text-faint)]">{label}{sub ? ` · ${sub}` : ''}</div>
    </div>
  )
}

// The v2 bot (~/trade-bot), from the status.json its status.py writes. LIVE
// round trips only: the paper arm was retired 2026-08-04. A null trip count
// means status.py could not count them yet, so the bar reads empty rather
// than claiming a confident zero.
export function TradeBot() {
  const status = useQuery({ queryKey: ['tradebot-status'], queryFn: fetchTradeBotStatus, refetchInterval: 60_000 })
  const s = status.data
  const state = s ? (s.stale ? { label: 'stale', color: 'var(--color-warning)' } : s.up ? { label: 'up', color: 'var(--color-success)' } : { label: 'down', color: 'var(--color-danger)' }) : null
  const trips = s?.experiment.live_trips ?? null
  const target = s?.experiment.target_trips ?? 100
  const tripPct = trips != null && target > 0 ? Math.min(100, Math.round((trips / target) * 100)) : 0
  const err = status.error as { detail?: string; message?: string } | null

  return (
    <Section
      title="trade bot"
      to="/trade"
      meta={state && s && (
        <>
          <span className="flex items-center gap-1.5" style={{ color: state.color }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: state.color }} aria-hidden />
            {state.label}
          </span>
          <span>market {s.market.is_open ? 'open' : 'closed'}</span>
          {s.experiment.rules_ok === false && <span className="text-[var(--color-danger)]">rules drift</span>}
        </>
      )}
    >
      {status.isLoading && !s ? (
        <Note>loading…</Note>
      ) : status.error || !s ? (
        <Note tone="danger">trade bot status unavailable{err?.detail || err?.message ? ` · ${err.detail || err.message}` : ''}</Note>
      ) : (
        <div className="space-y-2 pt-0.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Figure label="live equity" value={fmtUSD(s.portfolio.live_equity)} />
            <Figure label="live cash" value={fmtUSD(s.portfolio.live_cash)} />
            <Figure label="spent" value={fmtUSD(s.spend.total_usd)} sub={`${s.spend.calls_total} calls`} />
            <Figure label="today" value={fmtUSD(s.spend.today_usd)} sub={`${s.spend.calls_today} calls`} />
          </div>
          <div className="flex items-center gap-2.5" title={s.up_detail}>
            <div className="h-1 min-w-0 flex-1 bg-[var(--color-surface-2)]">
              <div className="h-full bg-[var(--color-accent)] transition-all duration-300" style={{ width: `${tripPct}%` }} />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">{trips ?? '—'}/{target} live trips</span>
          </div>
          <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]">{s.up_detail}</span>
            <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{fmtAgo(new Date(s.generated_at).getTime())}</span>
          </div>
        </div>
      )}
    </Section>
  )
}
