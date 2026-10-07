import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

// The class strings every project sheet and tab shares, copied from the pages
// they have to sit next to (Meals, Calendar, Sessions) so the workspace reads as
// the same app rather than a new one.
export const BTN_ACCENT = 'inline-flex min-h-9 items-center justify-center gap-1.5 border border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.10)] px-3 text-[11px] uppercase tracking-[0.14em] sm:min-h-8 text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.18)] disabled:opacity-40'
export const BTN_GHOST = 'inline-flex min-h-9 items-center justify-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[10px] uppercase tracking-[0.14em] sm:min-h-8 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] disabled:opacity-40'
export const BTN_TEXT = 'inline-flex min-h-9 items-center gap-1.5 px-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-40'
// text-base below sm: iOS zooms the page into any focused field under 16px.
export const FIELD = 'w-full min-w-0 border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] sm:text-sm'
export const LABEL = 'mb-1 block text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]'

export function Sheet({ title, onClose, children, footer }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  // A click is dispatched to the nearest common ancestor of press and release,
  // so selecting text in a field and letting go past the panel edge "clicks"
  // the backdrop and throws the draft away. Only a press that began on the
  // backdrop may close the sheet.
  const pressedBackdrop = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose() }}
    >
      {/* The scroller is an inner box: .panel's corner brackets sit 1px outside
          it, and on the panel itself they made it scroll 1px both ways, which
          showed two scrollbars on every sheet. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel flex max-h-[85dvh] w-full max-w-xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 overflow-y-auto p-5">
          <div className="mb-4 flex min-w-0 items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2">
            <h2
              className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.22em]"
              style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}
            >
              &gt; {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-2 shrink-0 p-2 text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
            >
              <X size={15} />
            </button>
          </div>
          {children}
          {footer && (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
