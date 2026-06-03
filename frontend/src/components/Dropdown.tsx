import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type DropdownOption = { value: string; label: string }

// Master Control styled dropdown — replaces native <select> so the picker
// looks the same on mobile and desktop instead of the OS-branded control.
export function Dropdown({ value, options, onChange, className = '', size = 'md' }: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  className?: string
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const pad = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'

  return (
    <div ref={ref} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center justify-between gap-2 border border-[var(--color-border)] bg-[var(--color-bg)] ${pad} text-left text-[var(--color-text-dim)] outline-none transition hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] ${open ? 'border-[var(--color-accent)]' : ''}`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown size={14} className={`shrink-0 transition ${open ? 'rotate-180 text-[var(--color-accent)]' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-auto border border-[var(--color-accent)] bg-[var(--color-bg)] shadow-[0_0_24px_rgba(0,255,65,0.15)]">
          {options.map((o) => {
            const sel = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition ${sel ? 'bg-[rgba(0,255,65,0.08)] text-[var(--color-accent)]' : 'text-[var(--color-text-dim)] hover:bg-[rgba(0,255,65,0.05)] hover:text-[var(--color-text)]'}`}
              >
                <span className="truncate">{o.label}</span>
                {sel && <Check size={13} className="shrink-0 text-[var(--color-accent)]" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
