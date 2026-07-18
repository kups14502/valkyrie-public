import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '../components/Card'
import {
  fetchEmailSignals, fetchEmailIntake, linkIntakeItem, dismissIntakeItem, unlinkIntakeItem, sendEmailFeedback,
  type EmailSignalItem, type EmailCorrection, type IntakeItem,
} from '../lib/api'

// Feedback buttons train the classifier: corrections are stored and fed back
// into the next scans (spam senders are auto-filtered thereafter).
function useEmailFeedback(account: string, uid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (correction: EmailCorrection) => sendEmailFeedback(account, uid, correction),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['email-signals'] })
      void queryClient.invalidateQueries({ queryKey: ['email-intake'] })
    },
  })
}

function FeedbackButton({ label, title, onClick, disabled }: { label: string; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="border border-[var(--color-border)] px-2 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-40"
    >
      {label}
    </button>
  )
}

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
  const feedback = useEmailFeedback(item.account, item.uid)
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
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1.5">
              {isImportant && (
                <FeedbackButton label="not important" title="Train: downgrade this kind of email" disabled={feedback.isPending} onClick={() => feedback.mutate('not_important')} />
              )}
              <FeedbackButton label="spam" title="Spam: bury this one email only" disabled={feedback.isPending} onClick={() => feedback.mutate('spam_once')} />
              <FeedbackButton label="block sender" title="Spam with memory: never show this sender again" disabled={feedback.isPending} onClick={() => feedback.mutate('spam')} />
            </div>
            <span className="text-[9px] text-[var(--color-text-faint)]">{fmtDate(item.seen_at)}</span>
          </div>
          {feedback.error != null && (
            <div className="text-[10px] text-[var(--color-danger)]">feedback failed, try again</div>
          )}
        </div>
      )}
    </div>
  )
}

// One pending intake suggestion: connect the email to an Autotask ticket
// (work) or a gig (personal), or dismiss it.
function IntakeRow({ item }: { item: IntakeItem }) {
  const queryClient = useQueryClient()
  const [manualTicket, setManualTicket] = useState('')
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['email-intake'] })
    void queryClient.invalidateQueries({ queryKey: ['gigs'] })
  }
  const link = useMutation({
    mutationFn: (input: { kind: 'ticket' | 'gig' | 'new-gig'; ref?: string; title?: string }) =>
      linkIntakeItem(item.account, item.uid, input),
    onSettled: invalidate,
  })
  const dismiss = useMutation({
    mutationFn: () => dismissIntakeItem(item.account, item.uid),
    onSettled: invalidate,
  })
  const feedback = useEmailFeedback(item.account, item.uid)
  const busy = link.isPending || dismiss.isPending || feedback.isPending
  // No ticket candidates and no gig suggestion: nothing to connect to, so
  // this needs a decision (new gig, spam, block, or dismiss).
  const unknown = item.isWork
    ? item.ticketMatches.length === 0
    : !item.gigMatch && !item.suggestedGigTitle

  return (
    <div className="space-y-2 border border-[var(--color-border)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold text-[var(--color-text)]">{item.subject}</span>
            <span className={`text-[9px] font-bold uppercase tracking-[0.14em] ${item.isWork ? 'text-[var(--color-accent)]' : 'text-[#48e3ce]'}`}>
              [{item.isWork ? 'work' : 'personal'}]
            </span>
            {unknown && (
              <span className="border border-[var(--color-warning)]/60 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.14em] text-[var(--color-warning)]">
                unknown
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-dim)]">{item.summary}</div>
          <div className="mt-0.5 text-[10px] text-[var(--color-text-faint)]">{item.sender} · {item.account}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <FeedbackButton
            label={item.isWork ? '→ personal' : '→ work'}
            title="Train: this email belongs on the other side"
            disabled={busy}
            onClick={() => feedback.mutate('flip_side')}
          />
          <FeedbackButton label="spam" title="Spam: bury this one email only" disabled={busy} onClick={() => feedback.mutate('spam_once')} />
          <FeedbackButton label="block sender" title="Spam with memory: never show this sender again" disabled={busy} onClick={() => feedback.mutate('spam')} />
          <button
            type="button"
            disabled={busy}
            onClick={() => dismiss.mutate()}
            className="border border-[var(--color-border)] px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)] disabled:opacity-40"
          >
            dismiss
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {item.isWork ? (
          <>
            {item.ticketMatches.map((t) => (
              <button
                key={t.ticketNumber || String(t.id)}
                type="button"
                disabled={busy}
                onClick={() => link.mutate({ kind: 'ticket', ref: t.ticketNumber || String(t.id) })}
                title={t.title}
                className="border border-[var(--color-accent)]/50 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
              >
                → {t.ticketNumber || `#${t.id}`}{t.title ? ` · ${t.title.slice(0, 32)}` : ''}
              </button>
            ))}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const ref = manualTicket.trim()
                if (ref) link.mutate({ kind: 'ticket', ref })
              }}
            >
              <input
                value={manualTicket}
                onChange={(e) => setManualTicket(e.target.value)}
                placeholder={item.ticketMatches.length === 0 ? 'ticket # (no auto match)' : 'other ticket #'}
                className="w-40 border border-[var(--color-border)] bg-transparent px-2 py-1 text-[10px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
              />
              <button
                type="submit"
                disabled={busy || !manualTicket.trim()}
                className="border border-[var(--color-border)] px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
              >
                link
              </button>
            </form>
            {unknown && (
              <button
                type="button"
                disabled={busy}
                onClick={() => link.mutate({ kind: 'new-gig', title: item.subject.slice(0, 60) })}
                className="border border-[#48e3ce]/50 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[#48e3ce] transition hover:bg-[rgba(72,227,206,0.08)] disabled:opacity-40"
              >
                + new gig: {item.subject.slice(0, 32)}
              </button>
            )}
          </>
        ) : (
          <>
            {item.gigMatch && (
              <button
                type="button"
                disabled={busy}
                onClick={() => link.mutate({ kind: 'gig', ref: item.gigMatch!.id })}
                className="border border-[var(--color-accent)]/50 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
              >
                → gig: {item.gigMatch.title.slice(0, 40)}
              </button>
            )}
            {item.suggestedGigTitle && (
              <button
                type="button"
                disabled={busy}
                onClick={() => link.mutate({ kind: 'new-gig', title: item.suggestedGigTitle! })}
                className="border border-[#48e3ce]/50 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[#48e3ce] transition hover:bg-[rgba(72,227,206,0.08)] disabled:opacity-40"
              >
                + new gig: {item.suggestedGigTitle.slice(0, 40)}
              </button>
            )}
          </>
        )}
        {(link.error || dismiss.error) && (
          <span className="text-[10px] text-[var(--color-danger)]">
            {(() => {
              const e = (link.error || dismiss.error) as { detail?: string; message?: string }
              return e.detail || e.message || 'request failed'
            })()}
          </span>
        )}
      </div>
    </div>
  )
}

function IntakeCard() {
  const intake = useQuery({ queryKey: ['email-intake'], queryFn: () => fetchEmailIntake('pending'), refetchInterval: 60_000 })
  const d = intake.data
  return (
    <Card
      title={`Intake Queue (${d?.counts.pending ?? 0})`}
      action={
        d && (
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            {d.counts.linked} connected · {d.counts.dismissed} dismissed
          </span>
        )
      }
    >
      {intake.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : intake.error ? (
        <div className="text-sm text-[var(--color-danger)]">intake queue unavailable</div>
      ) : (d?.items.length ?? 0) === 0 ? (
        <div className="text-sm text-[var(--color-text-dim)]">&gt; nothing waiting for intake.</div>
      ) : (
        <div className="space-y-2">
          {d!.items.map((item) => <IntakeRow key={`${item.account}-${item.uid}`} item={item} />)}
        </div>
      )}
    </Card>
  )
}

// Feed of what the scanner connected on its own (exact ticket-number matches).
// Every entry has an undo that returns it to the pending queue.
function AutoLinkedFeed() {
  const queryClient = useQueryClient()
  const linked = useQuery({ queryKey: ['email-intake-linked'], queryFn: () => fetchEmailIntake('linked'), refetchInterval: 60_000 })
  const undo = useMutation({
    mutationFn: (item: IntakeItem) => unlinkIntakeItem(item.account, item.uid),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['email-intake'] })
      void queryClient.invalidateQueries({ queryKey: ['email-intake-linked'] })
    },
  })
  const items = (linked.data?.items ?? []).filter((i) => i.linkedBy === 'auto').slice(0, 12)
  if (items.length === 0) return null
  return (
    <Card title={`Auto-Linked (${items.length})`}>
      <div className="space-y-1.5">
        {items.map((i) => (
          <div key={`${i.account}-${i.uid}`} className="group flex items-center gap-2 text-[11px]">
            <span className="shrink-0 font-bold text-[var(--color-accent)]">→ {i.linkedRef}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]" title={i.subject}>{i.subject}</span>
            <span className="hidden shrink-0 text-[9px] text-[var(--color-text-faint)] sm:inline">{fmtDate(i.processedAt)}</span>
            <button
              type="button"
              disabled={undo.isPending}
              onClick={() => undo.mutate(i)}
              className="shrink-0 border border-[var(--color-border)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] opacity-0 transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
            >
              undo
            </button>
          </div>
        ))}
      </div>
      {undo.error != null && (
        <div className="mt-2 text-[10px] text-[var(--color-danger)]">undo failed, try again</div>
      )}
    </Card>
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

      {/* Important email leads the page — no scrolling past the queue to find
          what actually needs you. */}
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

      <IntakeCard />
      <AutoLinkedFeed />

      {/* Service health + account status: reference, so it lives at the bottom. */}
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
