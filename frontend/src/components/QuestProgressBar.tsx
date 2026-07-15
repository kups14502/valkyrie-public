import type { QuestStatus } from '../lib/api'

// Objectives progress bar shared by the Quests page and the dashboard's
// tracked-quests HUD. Lives in components/ so the eagerly-loaded Dashboard
// doesn't drag the whole lazy Quests page into the initial bundle.
export function QuestProgressBar({ done, total, status }: { done: number; total: number; status: QuestStatus }) {
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  const color = status === 'completed' ? 'var(--color-success)' : status === 'failed' ? 'var(--color-danger)' : 'var(--color-accent)'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 bg-[var(--color-surface-2)]">
        <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-faint)]">{done}/{total}</span>
    </div>
  )
}
