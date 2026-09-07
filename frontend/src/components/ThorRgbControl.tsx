import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Moon, Zap } from 'lucide-react'
import { fetchThorRgb, setThorRgb, type ThorRgbMode } from '../lib/api'

// thor's desk lighting, next to the room's bulbs because that is how Brendon
// thinks about it: the desk is part of the room. These are the same two actions
// as the "Relight Thor" and "Dark Thor" buttons on thor's desktop, which is the
// point of putting them here: the phone reaches them from the couch.
//
// The press does not wait for the work. A relight runs two full OpenRGB cycles
// and takes about 45 seconds, so the button fires the task and the panel polls
// until thor agrees.

type Size = 'normal' | 'pad'

const SZ = {
  normal: { card: 'p-4', name: 'text-base', button: 'min-h-11 px-5 text-xs', icon: 14 },
  pad: { card: 'p-5', name: 'text-lg', button: 'min-h-14 px-6 text-sm', icon: 16 },
} as const

// Worst case for a relight, after which the panel stops claiming to be busy
// even if the storm never came up. The status line then tells the truth.
const SETTLE_MS = 90_000

// How long a press stays visible even when thor already reports the state that
// was asked for. A relight pressed while the desk is ALREADY lit is satisfied
// the instant it is sent, and that press is the common one: it is how a wedged
// keyboard gets unstuck. Without a floor it would give no feedback at all.
const MIN_BUSY_MS = 6_000

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function ThorRgbControl({ size = 'normal' }: { size?: Size }) {
  const s = SZ[size]
  const qc = useQueryClient()
  const [pending, setPending] = useState<{ mode: ThorRgbMode; at: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['thorRgb'],
    queryFn: fetchThorRgb,
    refetchInterval: pending ? 3_000 : 20_000,
  })

  const rgb = q.data
  const state = rgb?.state ?? 'unknown'
  const reachable = rgb?.installed === true
  const lit = state === 'lit'

  // Stop waiting once thor reports the state that was asked for, or when the
  // relight's worst case has passed. Always on a timer, never a bare setState
  // in the effect body: that cascades renders.
  useEffect(() => {
    if (!pending) return
    const satisfied = pending.mode === 'relight' ? state === 'lit' : state === 'dark'
    const held = Date.now() - pending.at
    const wait = Math.max(0, (satisfied ? MIN_BUSY_MS : SETTLE_MS) - held)
    const timer = setTimeout(() => setPending(null), wait)
    return () => clearTimeout(timer)
  }, [pending, state])

  const press = useMutation({
    mutationFn: (mode: ThorRgbMode) => setThorRgb(mode),
    onSuccess: (r) => {
      if (r && r.ok === false) {
        setErr(r.detail ?? 'thor refused it')
        setPending(null)
        return
      }
      void qc.invalidateQueries({ queryKey: ['thorRgb'] })
    },
    onError: (e) => {
      setErr((e as Error).message)
      setPending(null)
    },
  })

  const fire = (mode: ThorRgbMode) => {
    setErr(null)
    setPending({ mode, at: Date.now() })
    press.mutate(mode)
  }

  const status = (() => {
    if (q.isLoading && !rgb) return 'checking…'
    if (!reachable) return 'thor is not answering'
    if (pending?.mode === 'relight') return 'relighting · up to 45s'
    if (pending?.mode === 'dark') return 'going dark…'
    if (lit) return `lit · storm streaming · relit ${relTime(rgb?.tasks.relight.lastRun ?? null)}`
    if (state === 'dark') return `dark · blanked ${relTime(rgb?.tasks.dark.lastRun ?? null)}`
    // Relight was the last press and nothing is streaming, so it failed. Say
    // which half is up, because "OpenRGB is running" narrows it a long way.
    return rgb?.openrgb ? 'storm is not running · OpenRGB is up' : 'storm and OpenRGB are both down'
  })()

  const disabled = !reachable || pending !== null

  return (
    <div
      className={`panel ${s.card}`}
      style={{ boxShadow: lit ? '0 0 24px -10px rgba(var(--color-accent-rgb),0.5)' : undefined }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Zap
            size={size === 'pad' ? 26 : 22}
            className={`shrink-0 ${lit ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}
            style={lit ? { filter: 'drop-shadow(0 0 6px var(--color-accent))' } : undefined}
          />
          <div className="min-w-0">
            <div className={`${s.name} truncate leading-tight text-[var(--color-text)]`}>thor desk rgb</div>
            <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              {status}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => fire('relight')}
            aria-label="Relight thor"
            className={`${s.button} flex items-center gap-2 border font-semibold uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] disabled:opacity-40 ${
              lit
                ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.1)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
            }`}
          >
            <Zap size={s.icon} />
            relight
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => fire('dark')}
            aria-label="Take thor dark"
            className={`${s.button} flex items-center gap-2 border font-semibold uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] disabled:opacity-40 ${
              state === 'dark'
                ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.1)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
            }`}
          >
            <Moon size={s.icon} />
            dark
          </button>
        </div>
      </div>

      {err && (
        <div className="mt-3 border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {err}
        </div>
      )}
    </div>
  )
}
