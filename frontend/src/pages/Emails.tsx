import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchEmailSignals, type EmailSignalItem } from '../lib/api'

function fmtDate(d: string) {
  try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
  catch { return d }
}

function fmtRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function EmailSignalCard({ item }: { item: EmailSignalItem }) {
  const [expanded, setExpanded] = useState(false)
  const isImportant = item.classification === 'important'
  return (
    <div
      className={`cursor-pointer border px-3 py-2.5 transition hover:border-[var(--color-border-strong)] ${isImportant ? 'border-l-2 border-l-[var(--color-danger)] border-[var(--color-border)]' : 'border-[var(--color-border)]'}`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold text-[var(--color-text)]">{item.sender}</span>
            {isImportant && (
              <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--color-danger)]">[important]</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-dim)] truncate">{item.subject}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] text-[var(--color-text-faint)]">{fmtRelative(item.seen_at)}</div>
          <div className="text-[9px] text-[var(--color-text-faint)]">{item.account}</div>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2 space-y-1">
          {item.snippet && (
            <div className="text-[11px] text-[var(--color-text-dim)] leading-relaxed">
              {item.snippet}
            </div>
          )}
          <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            reason: {item.reason}
          </div>
          <div className="text-[9px] text-[var(--color-text-faint)]">{fmtDate(item.seen_at)}</div>
        </div>
      )}
    </div>
  )
}

export default function Emails() {
  const signals = useQuery({ queryKey: ['email-signals'], queryFn: fetchEmailSignals, refetchInterval: 60_000 })
  const d = signals.data

  const enabledAccounts = d?.accounts.filter((a) => a.enabled) ?? []
  const timerOk = d?.timer.active === 'active'
  const importantCount = d?.counts.important24h ?? 0
  const draftsCount = d?.drafts.length ?? 0

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// signals</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            email<span className="cursor-blink">_</span>
          </h1>
        </div>
      </div>

      <Card title="Service">
        {signals.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">timer</div>
                <div className={`mt-1 text-sm font-bold ${timerOk ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                  {d?.timer.active ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">last svc</div>
                <div className={`mt-1 text-sm font-bold ${d?.service.result === 'success' ? 'text-[var(--color-success)]' : d?.service.result ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-dim)]'}`}>
                  {d?.service.result ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">important 24h</div>
                <div className={`mt-1 text-2xl font-bold ${importantCount > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}>{importantCount}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">drafts waiting</div>
                <div className={`mt-1 text-2xl font-bold ${draftsCount > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-dim)]'}`}>{draftsCount}</div>
              </div>
            </div>
            <div className="border-t border-[var(--color-border)] pt-3">
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)] mb-2">accounts</div>
              <div className="flex flex-wrap gap-2">
                {d?.accounts.map((a) => (
                  <span key={a.id} className={`text-[10px] uppercase tracking-[0.12em] border px-2 py-0.5 ${a.enabled ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)]'}`}>
                    {a.enabled ? '' : '○ '}{a.address.split('@')[0]}
                  </span>
                ))}
              </div>
            </div>
            {d && (
              <div className="text-[10px] text-[var(--color-text-faint)]">
                {d.counts.ignoredTotal} ignored · {d.counts.total} total indexed
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title={`Action Inbox (${d?.items.length ?? 0})`}>
        {signals.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
        ) : (d?.items.length ?? 0) === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">&gt; no email needs attention.</div>
        ) : (
          <div className="space-y-1">
            {d!.items.map((item) => (
              <EmailSignalCard key={`${item.account}-${item.uid}`} item={item} />
            ))}
          </div>
        )}
      </Card>

      {(d?.drafts.length ?? 0) > 0 && (
        <Card title={`Draft Replies (${d!.drafts.length})`}>
          <div className="space-y-2">
            {d!.drafts.map((draft) => (
              <div key={draft.filename} className="border border-[var(--color-border)] px-3 py-2 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-[var(--color-text)]">{draft.filename}</span>
                  <span className="text-[10px] text-[var(--color-text-faint)]">{fmtRelative(draft.mtime)}</span>
                </div>
                {draft.preview && (
                  <div className="text-[11px] text-[var(--color-text-dim)] truncate">{draft.preview}</div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {(d?.recentErrors.length ?? 0) > 0 && (
        <Card title="Recent Errors">
          <div className="space-y-1">
            {d!.recentErrors.map((e, i) => (
              <div key={i} className="text-xs text-[var(--color-danger)]">{e}</div>
            ))}
          </div>
        </Card>
      )}

      {enabledAccounts.length === 0 && !signals.isLoading && (
        <div className="border border-[var(--color-warning)]/40 px-3 py-2 text-xs text-[var(--color-warning)]">
          No email accounts are enabled. Edit /home/brendon/email-assistant/config/accounts.json to enable accounts.
        </div>
      )}
    </div>
  )
}
