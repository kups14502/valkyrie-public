import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

const LABEL = 'truncate text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]'

// One dashboard section: a quiet label over a hairline, then the content. No
// box, no brackets: the page is one surface split by columns and rules, so the
// content is what reads first. The label opens the section's own page.
export function Section({ title, to, meta, children }: {
  title: string
  to?: string
  /** Right side of the label row: a count, a state, a small action. */
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="min-w-0">
      <header className="mb-1.5 flex min-w-0 items-baseline justify-between gap-3 border-b border-[var(--color-border)] pb-1">
        {to ? (
          <Link to={to} className="group flex min-w-0 items-baseline gap-1.5">
            <h2 className={LABEL}>{title}</h2>
            <span aria-hidden className="text-[11px] text-[var(--color-accent)] opacity-0 transition group-hover:opacity-100">→</span>
          </Link>
        ) : (
          <h2 className={LABEL}>{title}</h2>
        )}
        {meta != null && meta !== false && (
          <div className="flex min-w-0 shrink items-baseline justify-end gap-2 truncate text-[11px] text-[var(--color-text-faint)]">{meta}</div>
        )}
      </header>
      {children}
    </section>
  )
}

/** A one-line loading, empty or error state inside a section. */
export function Note({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'text-[var(--color-danger)]' : tone === 'warning' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-faint)]'
  return <div className={`py-1 text-[12px] ${color}`}>{children}</div>
}
