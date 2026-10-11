import { Plus } from 'lucide-react'
import { shortName, useQuickSessions } from '../lib/quickSessions'

// One tap to a new Claude session of each kind, on the phone home. The logic
// lives in lib/quickSessions, shared with the desktop dashboard.

export function QuickSessions() {
  const { kinds, loading, empty, busy, note, start } = useQuickSessions()
  if (empty) return null

  // vk-compact: lets the small text sizes on these buttons apply (index.css).
  return (
    <section className="vk-compact border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-full text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)] sm:w-auto">// new claude</span>
        <div className="grid flex-1 grid-cols-3 gap-2 sm:flex sm:flex-none sm:flex-wrap">
          {loading ? (
            <span className="col-span-3 text-[11px] text-[var(--color-text-faint)]">reading thor…</span>
          ) : kinds.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={busy !== null}
              onClick={() => void start(t)}
              title={`Start a new Claude session in ${t.label}`}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 border border-[var(--color-border-strong)] px-3 text-[12px] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:border-[var(--color-accent)] active:text-[var(--color-accent)] disabled:opacity-40 sm:min-h-8 sm:text-[11px]"
            >
              {/* A third of a phone has no room for it: the longest name crushed it. */}
              <Plus size={12} className="hidden shrink-0 sm:block" /> {busy === t.key ? 'starting…' : shortName(t)}
            </button>
          ))}
        </div>
        {note && (
          <span className={`text-[11px] ${note.error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>{note.text}</span>
        )}
      </div>
    </section>
  )
}
