export default function TradeBot() {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Market Link</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em]">Trade Bot</h1>
      </div>
      <div className="rounded-2xl border border-[var(--color-border)] bg-[linear-gradient(180deg,rgba(14,19,29,0.96),rgba(9,12,18,0.96))] p-6 text-sm text-[var(--color-text-dim)] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        Bot status, P&amp;L, open positions, and recent trades.
      </div>
    </div>
  )
}
