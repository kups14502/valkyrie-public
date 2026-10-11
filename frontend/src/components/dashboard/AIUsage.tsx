import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchAIUsage, type AIClientUsage } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { clampPct, fmtResetAt, fmtResetExact, fmtTokens } from './format'
import { Note, Section } from './Section'

// The sign-in address, one click to the clipboard. Truncated in a narrow
// column, but the click always copies the whole address.
function AccountEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={`Copy ${email}`}
      onClick={() => { void copyText(email).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }) }}
      className="group flex max-w-full items-center gap-1 text-left text-[11px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text-dim)]"
    >
      <span className="truncate">{email}</span>
      <span className={`shrink-0 ${copied ? 'text-[var(--color-success)]' : 'opacity-0 group-hover:opacity-100'}`}>
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

// Claude's usage colors: warm accent until it's close to a limit, then red.
const barColor = (p: number) => (clampPct(p) >= 85 ? 'var(--color-danger)' : '#D97757')

const GRID = 'grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-5 @xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)]'

// One limit: the bar and its figure, the reset countdown under it.
function Limit({ pct, resets }: { pct: number; resets: string | null }) {
  const p = clampPct(pct)
  return (
    <div className="min-w-0" title={fmtResetExact(resets)}>
      <div className="flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 rounded-full bg-[var(--color-surface-2)]">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${p}%`, backgroundColor: barColor(p) }} />
        </div>
        <span className={`w-9 shrink-0 text-right text-[12px] tabular-nums ${p >= 85 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'}`}>{p}%</span>
      </div>
      <div className="truncate text-[11px] tabular-nums text-[var(--color-text-faint)]">{fmtResetAt(resets) ?? 'reset unknown'}</div>
    </div>
  )
}

// One account per row: name and sign-in address, then the 5-hour and weekly
// limits side by side, so every account's bars line up under one heading.
// The plan is on the name's hover.
function AccountRow({ client }: { client: AIClientUsage }) {
  const q = client.quota
  const plan = client.subscription.replace(/ plan$/i, '')
  return (
    <div title={q ? undefined : client.authError || undefined} className={`${GRID} border-b border-[var(--color-border)]/40 py-1.5 last:border-b-0`}>
      <div className="min-w-0" title={plan}>
        <div className="truncate text-[13px] leading-tight text-[var(--color-text)]">{client.label}</div>
        {client.email && <AccountEmail email={client.email} />}
      </div>
      {q ? (
        <>
          <Limit pct={q.sessionPct} resets={q.sessionResetsAt} />
          <Limit pct={q.weeklyPct} resets={q.weeklyResetsAt} />
        </>
      ) : (
        // A dead sign-in has no quota to draw: the auth state and today's real
        // token spend instead.
        <div className="col-span-2 flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-warning)]">{client.authError || 'not signed in'}</span>
          <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">{fmtTokens(client.today.tokens)} today</span>
        </div>
      )}
    </div>
  )
}

// Every AI account's quota, hottest first, so the one closest to a limit leads.
export function AIUsage() {
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const clients: AIClientUsage[] = aiUsage.data?.aiClients ?? (aiUsage.data
    ? [{ id: 'claude-default', kind: 'claude' as const, label: 'Claude', subscription: 'Claude', ...aiUsage.data.claude }]
    : [])
  const hottest = (c: AIClientUsage) => Math.max(c.quota?.sessionPct ?? -1, c.quota?.weeklyPct ?? -1)
  const sorted = [...clients].sort((a, b) => hottest(b) - hottest(a))
  return (
    <Section title="ai usage">
      {aiUsage.isLoading && !aiUsage.data ? (
        <Note>loading…</Note>
      ) : aiUsage.error ? (
        <Note tone="danger">usage data unavailable</Note>
      ) : (
        <div className="@container">
          <div className={`${GRID} text-[11px] text-[var(--color-text-faint)]`}>
            <span />
            <span>5 hour</span>
            <span>week</span>
          </div>
          {sorted.map((client) => <AccountRow key={client.id} client={client} />)}
        </div>
      )}
    </Section>
  )
}
