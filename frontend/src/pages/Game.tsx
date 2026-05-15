export default function Game() {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Ops</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em]">Game Dev</h1>
      </div>
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-dim)]">
        $ space-gas-station --status<br />
        // pending wiring — will show build status, last commit, asset count, and design notes
      </div>
    </div>
  )
}
