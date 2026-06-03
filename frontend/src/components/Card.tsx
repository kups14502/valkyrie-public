import type { ReactNode } from 'react'

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel max-w-full overflow-hidden p-4 sm:p-5">
      {(title || action) && (
        <div className="mb-4 flex min-w-0 items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2">
          {title && (
            <h2
              className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.22em]"
              style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}
            >
              &gt; {title}
            </h2>
          )}
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
