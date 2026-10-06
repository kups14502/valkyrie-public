import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

// A column beside the project's tabs on a desktop, a section above or below
// them on a phone. Collapsed, the desktop column shrinks to a thin rail with
// its icon and count, so the tabs get the room. The choice is kept per panel
// on this device.

const read = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

export function SidePanel({ id, title, count, icon, width, actions, defaultOpen = true, children }: {
  id: string
  title: string
  count?: number
  icon: ReactNode
  // The open width on a desktop, as a Tailwind class (lg:w-72).
  width: string
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const key = `valkyrie-proj-panel-${id}`
  const [open, setOpen] = useState(() => read(key, defaultOpen))
  const toggle = () => {
    setOpen((v) => {
      try { localStorage.setItem(key, v ? '0' : '1') } catch { /* private mode */ }
      return !v
    })
  }

  return (
    <aside
      className={`min-w-0 lg:sticky lg:top-0 lg:shrink-0 ${open
        ? `${width} lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto`
        : 'lg:w-9'}`}
    >
      {!open && (
        <button
          type="button"
          onClick={toggle}
          title={`Show ${title}`}
          className="hidden w-9 flex-col items-center gap-3 border border-[var(--color-border)] py-3 text-[var(--color-text-faint)] transition hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)] lg:flex"
        >
          {icon}
          <span className="text-[10px] uppercase tracking-[0.18em] [writing-mode:vertical-rl]">{title}</span>
          {count ? <span className="text-[10px]">{count}</span> : null}
        </button>
      )}
      <div className={`flex min-h-9 items-center gap-2 border-b border-[var(--color-border)] ${open ? '' : 'lg:hidden'}`}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={open ? `Hide ${title}` : `Show ${title}`}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 text-left text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{title}</span>
          {count ? <span className="text-[var(--color-text-faint)]">{count}</span> : null}
        </button>
        {open && actions}
      </div>
      {open && <div className="pt-1">{children}</div>}
    </aside>
  )
}
