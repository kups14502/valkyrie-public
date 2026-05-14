import type { ReactNode } from 'react'

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[linear-gradient(180deg,rgba(14,19,29,0.96),rgba(9,12,18,0.96))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02),0_0_0_1px_rgba(72,227,206,0.02)]">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[11px] font-medium uppercase tracking-[0.28em] text-[var(--color-text-faint)]">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub, chart }: { label: string; value: string | number; sub?: string; chart?: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">{value}</div>
      {chart}
      {sub && <div className="mt-1 text-xs text-[var(--color-text-dim)]">{sub}</div>}
    </div>
  )
}
