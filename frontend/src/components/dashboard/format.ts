// Formatting shared by the dashboard sections.

export const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

export const fmtAgo = (ms: number | null): string | null => {
  if (ms == null) return null
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export const clampPct = (pct: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)))
export const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)

export const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

export const fmtUSD = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// "resets in 42m" / "resets in 3h 10m" / "resets Mon 4 PM": the granularity
// that reads best for the distance, short enough to sit beside a bar.
export function fmtResetAt(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'resets now'
  if (mins < 100) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `resets ${new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}`
}

// The exact wall-clock reset, for the hover on the countdown.
export function fmtResetExact(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  return `resets ${new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

export type Tone = 'ok' | 'watch' | 'alert' | 'dim'

export const toneDot: Record<Tone, string> = {
  ok: 'bg-[var(--color-success)]',
  watch: 'bg-[var(--color-warning)]',
  alert: 'bg-[var(--color-danger)]',
  dim: 'bg-[var(--color-text-faint)]',
}

export const toneText: Record<Tone, string> = {
  ok: 'text-[var(--color-text-dim)]',
  watch: 'text-[var(--color-warning)]',
  alert: 'text-[var(--color-danger)]',
  dim: 'text-[var(--color-text-faint)]',
}

// Usage color shared by every meter: calm accent, amber past 80, red past 90.
export const usageColor = (p: number) =>
  clampPct(p) >= 90 ? 'var(--color-danger)' : clampPct(p) >= 80 ? 'var(--color-warning)' : 'var(--color-accent)'
