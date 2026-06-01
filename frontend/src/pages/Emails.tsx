import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchEmails, fetchEmailStatus, type EmailMessage } from '../lib/api'

const CLASS_COLORS: Record<string, string> = {
  important: 'text-[var(--color-danger)]',
  routine:   'text-[var(--color-warning)]',
  normal:    'text-[var(--color-text-dim)]',
  baseline:  'text-[var(--color-text-faint)]',
  spam:      'text-[var(--color-text-faint)]',
}

const CLASS_BORDER: Record<string, string> = {
  important: 'border-l-2 border-l-[var(--color-danger)]',
  routine:   'border-l-2 border-l-[var(--color-warning)]',
  normal:    '',
  baseline:  '',
  spam:      '',
}

function fmtDate(d: string) {
  try {
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch { return d }
}

function EmailRow({ msg }: { msg: EmailMessage }) {
  const [expanded, setExpanded] = useState(false)
  const tone = CLASS_COLORS[msg.classification] ?? 'text-[var(--color-text-dim)]'
  const border = CLASS_BORDER[msg.classification] ?? ''

  return (
    <div
      className={`border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 cursor-pointer hover:border-[var(--color-border-strong)] transition ${border}`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold text-[var(--color-text)] truncate max-w-[200px]">{msg.sender.replace(/<.*?>/, '').trim() || msg.sender}</span>
            <span className={`text-[9px] uppercase tracking-[0.14em] font-bold ${tone}`}>[{msg.classification}]</span>
            <span className="text-[10px] text-[var(--color-text-faint)]">{msg.account}</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-dim)] truncate">{msg.subject}</div>
        </div>
        <div className="shrink-0 text-[10px] text-[var(--color-text-faint)] whitespace-nowrap">{fmtDate(msg.seen_at)}</div>
      </div>
      {expanded && msg.snippet && (
        <div className="mt-2 text-[11px] text-[var(--color-text-dim)] leading-relaxed border-t border-[var(--color-border)] pt-2 whitespace-pre-wrap line-clamp-6">
          {msg.snippet.slice(0, 600)}{msg.snippet.length > 600 ? '…' : ''}
        </div>
      )}
      {expanded && msg.reason && (
        <div className="mt-1 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">reason: {msg.reason}</div>
      )}
    </div>
  )
}

export default function Emails() {
  const [account, setAccount] = useState('all')
  const [classification, setClassification] = useState('all')
  const [page, setPage] = useState(0)
  const PAGE = 50

  const emails = useQuery({
    queryKey: ['emails', account, classification, page],
    queryFn: () => fetchEmails({ account, classification, limit: PAGE, offset: page * PAGE }),
    refetchInterval: 60_000,
  })

  const status = useQuery({
    queryKey: ['email-status'],
    queryFn: fetchEmailStatus,
    refetchInterval: 30_000,
  })

  const data = emails.data
  const totalPages = data ? Math.ceil(data.total / PAGE) : 0

  const allClasses = ['all', ...((data?.byClassification ?? []).map((c) => c.classification).sort())]
  const allAccounts = ['all', ...((data?.accounts ?? []).map((a) => a.account))]

  const importantCount = data?.byClassification.find((c) => c.classification === 'important')?.count ?? 0

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// mail</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            emails<span className="cursor-blink">_</span>
          </h1>
        </div>
        {status.data && (
          <div className="text-right text-[10px] text-[var(--color-text-faint)] space-y-0.5">
            <div>{status.data.dbStats.total} messages indexed</div>
            {status.data.dbStats.lastSeen && (
              <div>last seen: {fmtDate(status.data.dbStats.lastSeen)}</div>
            )}
            <div>timer: {status.data.timer.ActiveState ?? '—'}</div>
          </div>
        )}
      </div>

      {importantCount > 0 && (
        <div
          className="border border-[var(--color-danger)] bg-[rgba(255,23,68,0.06)] px-3 py-2 text-xs text-[var(--color-danger)] cursor-pointer"
          onClick={() => { setClassification('important'); setPage(0) }}
        >
          &gt; {importantCount} important message{importantCount !== 1 ? 's' : ''} — click to filter
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">account</div>
          <div className="flex flex-wrap gap-1">
            {allAccounts.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => { setAccount(a); setPage(0) }}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] border transition ${
                  account === a
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)]'
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">classification</div>
          <div className="flex flex-wrap gap-1">
            {allClasses.map((cl) => (
              <button
                key={cl}
                type="button"
                onClick={() => { setClassification(cl); setPage(0) }}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] border transition ${
                  classification === cl
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)]'
                }`}
              >
                {cl}
                {cl !== 'all' && data && (
                  <span className="ml-1 opacity-60">
                    {data.byClassification.find((c) => c.classification === cl)?.count ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card title={`Messages (${data?.total ?? '…'})`}>
        {emails.isLoading && !data ? (
          <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
        ) : emails.error ? (
          <div className="text-sm text-[var(--color-danger)]">Failed to load emails</div>
        ) : (data?.messages.length ?? 0) === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">No messages</div>
        ) : (
          <div className="space-y-1">
            {data!.messages.map((msg) => (
              <EmailRow key={`${msg.account}-${msg.uid}`} msg={msg} />
            ))}
          </div>
        )}
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-[var(--color-text-dim)]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="border border-[var(--color-border)] px-3 py-1 uppercase tracking-[0.14em] transition hover:border-[var(--color-border-strong)] disabled:opacity-30"
          >
            &lt; prev
          </button>
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="border border-[var(--color-border)] px-3 py-1 uppercase tracking-[0.14em] transition hover:border-[var(--color-border-strong)] disabled:opacity-30"
          >
            next &gt;
          </button>
        </div>
      )}
    </div>
  )
}
