import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchActivity, type Activity as ActivityItem } from '../lib/api'

const fmtAgo = (ms: number | null): string | null => {
  if (ms == null) return null
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const GROUPS: { type: ActivityItem['type']; title: string; label: string; color: string }[] = [
  { type: 'commit', title: 'Git Changes', label: 'git', color: 'text-[var(--color-success)]' },
  { type: 'trade', title: 'Trades', label: 'trd', color: 'text-[var(--color-warning)]' },
  { type: 'backup', title: 'Backups', label: 'bak', color: 'text-[var(--color-text-faint)]' },
]

function ActivityRow({ a, color, label }: { a: ActivityItem; color: string; label: string }) {
  return (
    <div className="flex items-baseline gap-3 py-2 text-sm">
      <span className={`shrink-0 text-[10px] uppercase tracking-[0.12em] ${color}`}>[{label}]</span>
      <div className="min-w-0 flex-1">
        <div className="max-sm:line-clamp-2 sm:truncate text-[var(--color-text)]">{a.title}</div>
        {a.subtitle && (
          <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">{a.subtitle}</div>
        )}
      </div>
      <span className="shrink-0 text-[11px] text-[var(--color-text-dim)]">{fmtAgo(a.timestamp)}</span>
    </div>
  )
}

export default function Activity() {
  const activity = useQuery({ queryKey: ['activity'], queryFn: fetchActivity, refetchInterval: 60_000 })
  const items = activity.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// log</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            activity<span className="cursor-blink">_</span>
          </h1>
        </div>
      </div>

      {activity.isLoading && !activity.data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">loading…</div></Card>
      ) : activity.error ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Activity feed unavailable</div></Card>
      ) : items.length === 0 ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">No recent activity</div></Card>
      ) : (
        GROUPS.map((g) => {
          const groupItems = items.filter((a) => a.type === g.type)
          if (groupItems.length === 0) return null
          return (
            <Card key={g.type} title={`${g.title} (${groupItems.length})`}>
              <div className="divide-y divide-[var(--color-border)]">
                {groupItems.map((a) => (
                  <ActivityRow key={a.id} a={a} color={g.color} label={g.label} />
                ))}
              </div>
            </Card>
          )
        })
      )}

      {items.length > 0 && items.some((a) => !GROUPS.find((g) => g.type === a.type)) && (
        <Card title="Other">
          <div className="divide-y divide-[var(--color-border)]">
            {items.filter((a) => !GROUPS.find((g) => g.type === a.type)).map((a) => (
              <ActivityRow key={a.id} a={a} color="text-[var(--color-text-faint)]" label="•" />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
