import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export function Card({
  title, children, action, collapsible, defaultCollapsed, storageKey, dense,
}: {
  title?: string
  children: ReactNode
  action?: ReactNode
  collapsible?: boolean
  defaultCollapsed?: boolean
  // Persist the collapsed state across sessions when set.
  storageKey?: string
  // A dashboard tile: tighter padding and a shorter header, so several fit on one screen.
  dense?: boolean
}) {
  const [collapsed, setCollapsed] = useState(() => {
    if (storageKey) {
      const v = localStorage.getItem(`valkyrie-card-${storageKey}`)
      if (v != null) return v === '1'
    }
    return Boolean(defaultCollapsed)
  })
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      if (storageKey) localStorage.setItem(`valkyrie-card-${storageKey}`, next ? '1' : '0')
      return next
    })
  }

  const heading = title && (
    <h2
      className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.22em]"
      style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}
    >
      &gt; {title}
    </h2>
  )

  return (
    <section className={`panel max-w-full overflow-visible ${dense ? 'p-3' : 'p-4 sm:p-5'}`}>
      {(title || action) && (
        <div className={`flex min-w-0 items-center justify-between gap-3 border-b border-[var(--color-border)] ${dense ? 'pb-1.5' : 'pb-2'} ${collapsed ? '' : dense ? 'mb-2.5' : 'mb-4'}`}>
          {collapsible ? (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="shrink-0 text-[var(--color-accent)]">
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </span>
              {heading}
            </button>
          ) : (
            heading
          )}
          {action}
        </div>
      )}
      {!collapsed && children}
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
