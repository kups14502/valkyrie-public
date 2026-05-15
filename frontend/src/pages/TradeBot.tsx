import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { fetchTrading, type TradingPosition, type TradingSignal, type PlannedTrade } from '../lib/api'

const fmtRelative = (iso: string | null): string => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return '—'
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const pnlColor = (pct: number): string =>
  pct > 0 ? 'text-[var(--color-success)]' : pct < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'

const regimeStyle = (r: string | null): string => {
  const v = (r ?? '').toLowerCase()
  if (v.includes('bull')) return 'bg-[var(--color-success)]/20 text-[var(--color-success)]'
  if (v.includes('bear')) return 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]'
  if (v.includes('neutral') || v.includes('chop')) return 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]'
  return 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)]'
}

const convictionStyle = (c: string): string => {
  const v = c.toLowerCase()
  if (v === 'high') return 'bg-[var(--color-success)]/20 text-[var(--color-success)]'
  if (v === 'medium') return 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]'
  return 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)]'
}

const directionStyle = (d: string): string => {
  const v = d.toLowerCase()
  if (v === 'long') return 'text-[var(--color-success)]'
  if (v === 'short') return 'text-[var(--color-danger)]'
  return 'text-[var(--color-text-dim)]'
}

function PositionRow({ pos }: { pos: TradingPosition }) {
  const value = pos.quantity * pos.currentPrice
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--color-text)]">{pos.symbol}</span>
          {pos.locked && (
            <span className="rounded-full bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--color-warning)]">locked</span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">
          {pos.quantity.toFixed(pos.quantity < 1 ? 6 : 2)} · avg {fmtUSD(pos.avgBuyPrice)} · @ {fmtUSD(pos.currentPrice)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-sm font-semibold ${pnlColor(pos.pnlPct)}`}>
          {pos.pnlPct > 0 ? '+' : ''}{pos.pnlPct.toFixed(2)}%
        </div>
        <div className="text-[11px] text-[var(--color-text-faint)]">{fmtUSD(value)}</div>
      </div>
    </div>
  )
}

function SignalRow({ signal }: { signal: TradingSignal }) {
  return (
    <div className="space-y-1.5 py-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-[var(--color-text)]">{signal.symbol}</span>
        <span className={`text-[11px] uppercase tracking-[0.18em] ${directionStyle(signal.direction)}`}>{signal.direction}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-[0.15em] ${convictionStyle(signal.conviction)}`}>
          {signal.conviction}
        </span>
        {signal.timeHorizon && (
          <span className="text-[11px] text-[var(--color-text-faint)]">· {signal.timeHorizon}</span>
        )}
        {signal.suggestedInstrument && (
          <span className="text-[11px] text-[var(--color-text-faint)]">· {signal.suggestedInstrument}</span>
        )}
      </div>
      <div className="text-xs leading-relaxed text-[var(--color-text-dim)]">{signal.reasoning}</div>
    </div>
  )
}

function PlannedTradeRow({ trade }: { trade: PlannedTrade }) {
  const sizeLabel = trade.dollarAmount != null
    ? fmtUSD(trade.dollarAmount)
    : trade.quantity != null
    ? `${trade.quantity} ${trade.assetType}`
    : '—'
  return (
    <div className="space-y-1 rounded-xl border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`text-[11px] uppercase tracking-[0.18em] ${trade.action === 'buy' ? 'text-[var(--color-success)]' : trade.action === 'sell' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}>
          {trade.action}
        </span>
        <span className="font-mono font-semibold text-[var(--color-text)]">{trade.symbol}</span>
        <span className="text-[var(--color-text-dim)]">· {sizeLabel}</span>
        <span className="text-[11px] text-[var(--color-text-faint)]">· {trade.assetType}</span>
        {trade.optionType && <span className="text-[11px] text-[var(--color-text-faint)]">· {trade.optionType} {trade.strikePrice ? fmtUSD(trade.strikePrice) : ''} {trade.expirationDate ?? ''}</span>}
      </div>
      {trade.notes && <div className="text-xs leading-relaxed text-[var(--color-text-dim)]">{trade.notes}</div>}
    </div>
  )
}

export default function TradeBot() {
  const trading = useQuery({ queryKey: ['trading'], queryFn: fetchTrading, refetchInterval: 60_000 })
  const data = trading.data

  const allPositions = data?.portfolio
    ? [...data.portfolio.stockPositions, ...data.portfolio.cryptoPositions, ...data.portfolio.optionsPositions]
    : []
  const totalValue = allPositions.reduce((acc, p) => acc + p.quantity * p.currentPrice, 0)
  const totalCost = allPositions.reduce((acc, p) => acc + p.quantity * p.avgBuyPrice, 0)
  const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Market Link</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Trade Bot</h1>
        </div>
        <div className="flex items-center gap-2">
          {data?.marketRegime && (
            <span className={`rounded-full px-2.5 py-0.5 text-xs uppercase tracking-[0.18em] ${regimeStyle(data.marketRegime)}`}>
              {data.marketRegime}
            </span>
          )}
          <span className="rounded-full border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-1 text-xs uppercase tracking-[0.22em] text-[var(--color-text-dim)]">
            updated {fmtRelative(data?.lastUpdated ?? null)}
          </span>
        </div>
      </div>

      {trading.isLoading && !data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      ) : trading.error || !data ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Trade bot status unavailable</div></Card>
      ) : (
        <>
          {data.portfolio && (
            <Card title="Portfolio">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Stat label="Equity" value={fmtUSD(data.portfolio.equity)} sub="total account" />
                <Stat label="Buying power" value={fmtUSD(data.portfolio.buyingPower)} sub="deployable" />
                <Stat label="Positions" value={allPositions.length} sub={`${data.portfolio.stockPositions.length}S · ${data.portfolio.cryptoPositions.length}C · ${data.portfolio.optionsPositions.length}O`} />
                <Stat
                  label="Unrealized P&L"
                  value={`${totalPnlPct > 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%`}
                  sub={`${fmtUSD(totalValue - totalCost)} on ${fmtUSD(totalCost)}`}
                />
              </div>
            </Card>
          )}

          {data.portfolio && allPositions.length > 0 && (
            <div className="grid gap-6 xl:grid-cols-3">
              {data.portfolio.stockPositions.length > 0 && (
                <Card title="Stocks">
                  <div className="divide-y divide-[var(--color-border)]">
                    {data.portfolio.stockPositions.map((p) => <PositionRow key={p.symbol} pos={p} />)}
                  </div>
                </Card>
              )}
              {data.portfolio.cryptoPositions.length > 0 && (
                <Card title="Crypto">
                  <div className="divide-y divide-[var(--color-border)]">
                    {data.portfolio.cryptoPositions.map((p) => <PositionRow key={p.symbol} pos={p} />)}
                  </div>
                </Card>
              )}
              {data.portfolio.optionsPositions.length > 0 && (
                <Card title="Options">
                  <div className="divide-y divide-[var(--color-border)]">
                    {data.portfolio.optionsPositions.map((p) => <PositionRow key={p.symbol} pos={p} />)}
                  </div>
                </Card>
              )}
            </div>
          )}

          {data.latestRun?.plan && (
            <Card title={`Latest plan · ${fmtRelative(data.latestRun.timestamp)} · ${data.runsToday} run${data.runsToday === 1 ? '' : 's'} today`}>
              <div className="space-y-4">
                {data.latestRun.plan.trades.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">Planned trades</div>
                    {data.latestRun.plan.trades.map((t, i) => <PlannedTradeRow key={i} trade={t} />)}
                  </div>
                )}
                {data.latestRun.plan.reasoning && (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">Reasoning</div>
                    <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">{data.latestRun.plan.reasoning}</p>
                  </div>
                )}
                {data.latestRun.plan.riskAssessment && (
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">Risk</div>
                    <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">{data.latestRun.plan.riskAssessment}</p>
                  </div>
                )}
              </div>
            </Card>
          )}

          {data.marketSummary && (
            <Card title="Market read">
              <p className="text-sm leading-relaxed text-[var(--color-text-dim)]">{data.marketSummary}</p>
            </Card>
          )}

          {data.signals.length > 0 && (
            <Card title="Signals">
              <div className="divide-y divide-[var(--color-border)]">
                {data.signals.map((s) => <SignalRow key={s.symbol} signal={s} />)}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
