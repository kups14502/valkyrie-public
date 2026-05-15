import type { ReactNode } from 'react'

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-accent)]">// {title}</h2>}
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
