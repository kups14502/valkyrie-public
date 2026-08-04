import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Inbox, FileText, ListChecks, Link2, Activity, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchEmailSignals, fetchEmailIntake, linkIntakeItem, dismissIntakeItem, unlinkIntakeItem, createTicketFromIntake, sendEmailFeedback, skipEmailSignal,
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

// Skip just clears the email from the action inbox — no training signal.
function useSkipSignal(account: string, uid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => skipEmailSignal(account, uid),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['email-signals'] }),
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
  const skip = useSkipSignal(item.account, item.uid)
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
              <FeedbackButton label="skip" title="Clear from the inbox — no training, just mark handled" disabled={skip.isPending} onClick={() => skip.mutate()} />
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

// One pending intake suggestion: connect the email to an Autotask ticket,
// or dismiss it.
function IntakeRow({ item }: { item: IntakeItem }) {
  const queryClient = useQueryClient()
  const [manualTicket, setManualTicket] = useState('')
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['email-intake'] })
  }
  const link = useMutation({
    mutationFn: (input: { kind: 'ticket'; ref: string }) =>
      linkIntakeItem(item.account, item.uid, input),
    onSettled: invalidate,
  })
  const dismiss = useMutation({
    mutationFn: () => dismissIntakeItem(item.account, item.uid),
    onSettled: invalidate,
  })
  const createTicket = useMutation({
    mutationFn: () => createTicketFromIntake(item.account, item.uid),
    onSettled: invalidate,
  })
  const feedback = useEmailFeedback(item.account, item.uid)
  const busy = link.isPending || dismiss.isPending || feedback.isPending || createTicket.isPending
  // Only the Work client mailboxes hold real work email that can spawn tickets.
  const canCreateTicket = item.isWork && (item.account === 'work' || item.account === 'work-support')
  // A work email with no ticket candidate has nothing to connect to yet, so it
  // needs a decision (link a ticket by number, create one, spam, or dismiss).
  const unknown = item.isWork && item.ticketMatches.length === 0

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
            {canCreateTicket && (
              <button
                type="button"
                disabled={busy}
                onClick={() => createTicket.mutate()}
                title="Create a new Autotask ticket from this email, attributed to the sender's client"
                className="border border-[var(--color-accent)]/60 px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.1)] disabled:opacity-40"
              >
                {createTicket.isPending ? 'creating…' : '+ create ticket'}
              </button>
            )}
            {createTicket.error != null && (
              <span className="text-[10px] text-[var(--color-danger)]">
                {((createTicket.error as { detail?: string; message?: string }).detail || (createTicket.error as Error).message)}
              </span>
            )}
          </>
        ) : null}
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

// ── shared sub-page frame ────────────────────────────────────────────────────

function useSignals() {
  return useQuery({ queryKey: ['email-signals'], queryFn: fetchEmailSignals, refetchInterval: 60_000 })
}

function SubPage({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <Link to="/emails" className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]">
          <ChevronLeft size={13} /> email
        </Link>
        <div className="mt-1 flex items-baseline gap-3">
          <h1 className="text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            {title}<span className="cursor-blink">_</span>
          </h1>
          {sub && <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-dim)]">{sub}</span>}
        </div>
      </div>
      {children}
    </div>
  )
}

// ── sub-pages ────────────────────────────────────────────────────────────────

export function EmailInboxPage() {
  const signals = useSignals()
  const d = signals.data
  return (
    <SubPage title="action inbox" sub={`${d?.items.length ?? 0} to handle`}>
      {signals.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : (d?.items.length ?? 0) === 0 ? (
        <div className="text-sm text-[var(--color-text-dim)]">&gt; no email needs attention.</div>
      ) : (
        <div className="space-y-1.5">
          {d!.items.map((item) => (
            <EmailSignalCard key={`${item.account}-${item.uid}`} item={item} />
          ))}
        </div>
      )}
    </SubPage>
  )
}

export function EmailDraftsPage() {
  const signals = useSignals()
  const drafts = signals.data?.drafts ?? []
  return (
    <SubPage title="draft replies" sub={`${drafts.length} waiting`}>
      {signals.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : drafts.length === 0 ? (
        <div className="text-sm text-[var(--color-text-dim)]">&gt; no drafts waiting.</div>
      ) : (
        <div className="space-y-2">
          {drafts.map((draft) => (
            <div key={draft.filename} className="border border-[var(--color-border)] px-4 py-3 space-y-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-[var(--color-text)]">{draft.filename}</span>
                <span className="text-[10px] text-[var(--color-text-faint)]">{fmtRelative(draft.mtime)}</span>
              </div>
              {draft.preview && <div className="text-xs text-[var(--color-text-dim)]">{draft.preview}</div>}
            </div>
          ))}
        </div>
      )}
    </SubPage>
  )
}

export function EmailIntakePage() {
  const intake = useQuery({ queryKey: ['email-intake'], queryFn: () => fetchEmailIntake('pending'), refetchInterval: 60_000 })
  const d = intake.data
  return (
    <SubPage title="intake queue" sub={d ? `${d.counts.pending} pending · ${d.counts.linked} connected` : undefined}>
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
    </SubPage>
  )
}

export function EmailAutoLinkedPage() {
  const queryClient = useQueryClient()
  const linked = useQuery({ queryKey: ['email-intake-linked'], queryFn: () => fetchEmailIntake('linked'), refetchInterval: 60_000 })
  const undo = useMutation({
    mutationFn: (item: IntakeItem) => unlinkIntakeItem(item.account, item.uid),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['email-intake'] })
      void queryClient.invalidateQueries({ queryKey: ['email-intake-linked'] })
    },
  })
  const items = (linked.data?.items ?? []).filter((i) => i.linkedBy === 'auto')
  return (
    <SubPage title="auto-linked" sub={`${items.length} auto-connected`}>
      {items.length === 0 ? (
        <div className="text-sm text-[var(--color-text-dim)]">&gt; nothing auto-linked yet.</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((i) => (
            <div key={`${i.account}-${i.uid}`} className="group flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs">
              <span className="shrink-0 font-bold text-[var(--color-accent)]">→ {i.linkedRef}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]" title={i.subject}>{i.subject}</span>
              <span className="hidden shrink-0 text-[9px] text-[var(--color-text-faint)] sm:inline">{fmtDate(i.processedAt)}</span>
              <button
                type="button"
                disabled={undo.isPending}
                onClick={() => undo.mutate(i)}
                className="shrink-0 border border-[var(--color-border)] px-2 py-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-40"
              >
                undo
              </button>
            </div>
          ))}
        </div>
      )}
      {undo.error != null && <div className="text-[10px] text-[var(--color-danger)]">undo failed, try again</div>}
    </SubPage>
  )
}

export function EmailServicePage() {
  const signals = useSignals()
  const d = signals.data
  const timerOk = d?.timer.active === 'active'
  return (
    <SubPage title="service">
      {signals.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">timer</div>
              <div className={`mt-1 text-sm font-bold ${timerOk ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>{d?.timer.active ?? '—'}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">last svc</div>
              <div className={`mt-1 text-sm font-bold ${d?.service.result === 'success' ? 'text-[var(--color-success)]' : d?.service.result ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-dim)]'}`}>{d?.service.result ?? '—'}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">important 24h</div>
              <div className={`mt-1 text-2xl font-bold ${(d?.counts.important24h ?? 0) > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}>{d?.counts.important24h ?? 0}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">drafts waiting</div>
              <div className={`mt-1 text-2xl font-bold ${(d?.drafts.length ?? 0) > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-dim)]'}`}>{d?.drafts.length ?? 0}</div>
            </div>
          </div>
          <div className="border-t border-[var(--color-border)] pt-3">
            <div className="mb-2 text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">accounts</div>
            <div className="flex flex-wrap gap-2">
              {d?.accounts.map((a) => (
                <span key={a.id} className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${a.enabled ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)]'}`}>
                  {a.enabled ? '' : '○ '}{a.address.split('@')[0]}
                </span>
              ))}
            </div>
          </div>
          {d && <div className="text-[10px] text-[var(--color-text-faint)]">{d.counts.ignoredTotal} ignored · {d.counts.total} total indexed</div>}
          {(d?.recentErrors.length ?? 0) > 0 && (
            <div className="border-t border-[var(--color-border)] pt-3">
              <div className="mb-2 text-[9px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">recent errors</div>
              <div className="space-y-1">
                {d!.recentErrors.map((e, i) => <div key={i} className="text-xs text-[var(--color-danger)]">{e}</div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </SubPage>
  )
}

// ── hub: large buttons, each opening its own page ────────────────────────────

function HubButton({ to, icon, label, count, tone, sub }: {
  to: string; icon: React.ReactNode; label: string; count?: number; tone?: 'alert' | 'accent' | 'dim'; sub?: string
}) {
  const countColor = tone === 'alert' ? 'text-[var(--color-danger)]' : tone === 'dim' ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-accent)]'
  return (
    <Link
      to={to}
      className="group flex items-center gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-5 transition hover:border-[var(--color-accent)]/60 hover:bg-[rgba(var(--color-accent-rgb),0.04)]"
    >
      <span className="shrink-0 text-[var(--color-text-dim)] transition group-hover:text-[var(--color-accent)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-base font-bold uppercase tracking-[0.14em] text-[var(--color-text)] transition group-hover:text-[var(--color-accent)]">{label}</div>
        {sub && <div className="mt-0.5 text-[11px] text-[var(--color-text-faint)]">{sub}</div>}
      </div>
      {count != null && <span className={`shrink-0 text-2xl font-bold ${countColor}`}>{count}</span>}
      <ChevronRight size={18} className="shrink-0 text-[var(--color-text-faint)] transition group-hover:text-[var(--color-accent)]" />
    </Link>
  )
}

export default function Emails() {
  const signals = useSignals()
  const intake = useQuery({ queryKey: ['email-intake'], queryFn: () => fetchEmailIntake('pending'), refetchInterval: 60_000 })
  const d = signals.data
  const linked = useQuery({ queryKey: ['email-intake-linked'], queryFn: () => fetchEmailIntake('linked'), refetchInterval: 120_000 })
  const autoCount = (linked.data?.items ?? []).filter((i) => i.linkedBy === 'auto').length
  const enabledAccounts = d?.accounts.filter((a) => a.enabled) ?? []

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// signals</div>
        <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
          email<span className="cursor-blink">_</span>
        </h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <HubButton to="/emails/inbox" icon={<Inbox size={22} />} label="action inbox"
          sub="important email that needs you" count={d?.items.length ?? 0}
          tone={(d?.items.length ?? 0) > 0 ? 'alert' : 'dim'} />
        <HubButton to="/emails/intake" icon={<ListChecks size={22} />} label="intake queue"
          sub="connect email to tickets" count={intake.data?.counts.pending ?? 0}
          tone={(intake.data?.counts.pending ?? 0) > 0 ? 'accent' : 'dim'} />
        <HubButton to="/emails/drafts" icon={<FileText size={22} />} label="draft replies"
          sub="ready-to-send drafts" count={d?.drafts.length ?? 0}
          tone={(d?.drafts.length ?? 0) > 0 ? 'accent' : 'dim'} />
        <HubButton to="/emails/auto-linked" icon={<Link2 size={22} />} label="auto-linked"
          sub="what the scanner connected" count={autoCount} tone="dim" />
        <HubButton to="/emails/service" icon={<Activity size={22} />} label="service"
          sub="scanner health & accounts" />
      </div>

      {enabledAccounts.length === 0 && !signals.isLoading && (
        <div className="border border-[var(--color-warning)]/40 px-3 py-2 text-xs text-[var(--color-warning)]">
          No email accounts are enabled. Edit /home/brendon/email-assistant/config/accounts.json to enable accounts.
        </div>
      )}
    </div>
  )
}
