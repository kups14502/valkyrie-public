import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { ThorRgbControl } from '../components/ThorRgbControl'
import { LightsPanel } from '../components/HomePanels'
import { SupplementsCard } from '../components/SupplementsCard'
import { useProfile } from '../lib/deviceMode'
import { copyText } from '../lib/clipboard'
import { fetchSystem, fetchSessionList, fetchProjects, fetchAIUsage, fetchVault, fetchTradeBotStatus, fetchHosts, type AIClientUsage, type HostStat } from '../lib/api'

const fmtBytes = (b: number) => {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

const fmtAgo = (ms: number | null): string | null => {
  if (ms == null) return null
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const clampPct = (pct: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)))
const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

type Tone = 'ok' | 'watch' | 'alert' | 'dim'

const toneDot: Record<Tone, string> = {
  ok: 'bg-[var(--color-success)]',
  watch: 'bg-[var(--color-warning)]',
  alert: 'bg-[var(--color-danger)]',
  dim: 'bg-[var(--color-text-faint)]',
}

const toneText: Record<Tone, string> = {
  ok: 'text-[var(--color-text)]',
  watch: 'text-[var(--color-warning)]',
  alert: 'text-[var(--color-danger)]',
  dim: 'text-[var(--color-text-dim)]',
}

function NowBanner() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects, refetchInterval: 30_000 })
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const vault = useQuery({ queryKey: ['vault'], queryFn: fetchVault, refetchInterval: 60_000 })

  const segments: { label: string; tone: Tone }[] = []
  let alerts = 0
  let watches = 0
  const note = (label: string, tone: Tone) => {
    segments.push({ label, tone })
    if (tone === 'alert') alerts++
    else if (tone === 'watch') watches++
  }

  // Claude runs on thor, so ask thor. This used to call /api/sessions, which
  // greps odin's own process list for `claude --resume` and therefore always
  // answered zero: the banner and the Sessions page disagreed because they were
  // describing different machines.
  const live = sessions.data?.installed ? sessions.data.sessions.filter((x) => x.live) : []
  const asking = live.filter((x) => x.activity === 'asking').length
  if (asking > 0) note(`${asking} waiting on you`, 'watch')
  if (live.length > 0) note(`${live.length} session${live.length === 1 ? '' : 's'} running`, 'ok')
  else note('no sessions running', 'dim')

  const projectsList = Array.isArray(projects.data) ? projects.data : []
  const activeProject = projectsList.find((p) => p.status === 'active')
  if (activeProject) note(`${activeProject.name} active`, 'ok')

  const claudeWeekly = aiUsage.data?.claude.quota?.weeklyPct
  if (typeof claudeWeekly === 'number') {
    const tone: Tone = claudeWeekly >= 85 ? 'alert' : claudeWeekly >= 70 ? 'watch' : 'ok'
    note(`Claude ${claudeWeekly}% wk`, tone)
  }

  const claudeSessionPct = aiUsage.data?.claude.quota?.sessionPct
  if (typeof claudeSessionPct === 'number' && claudeSessionPct >= 70) {
    const tone: Tone = claudeSessionPct >= 85 ? 'alert' : 'watch'
    note(`Claude ${claudeSessionPct}% 5h`, tone)
  }

  if (vault.data) {
    const v = vault.data
    if (!v.container.running) note('vault down', 'alert')
    else if (v.container.healthy === false) note('vault unhealthy', 'alert')
    else if (v.backups.stale) note('backups stale', 'alert')
    else note('vault ok', 'ok')
  }

  if (sys.data) {
    if (sys.data.disk.percent >= 90) note(`disk ${Math.round(sys.data.disk.percent)}%`, 'alert')
    else if (sys.data.disk.percent >= 80) note(`disk ${Math.round(sys.data.disk.percent)}%`, 'watch')

    const loadRatio = sys.data.cpu.loadAvg[0] / Math.max(sys.data.cpu.cores, 1)
    if (loadRatio >= 0.9) note(`load ${loadRatio.toFixed(1)}`, 'alert')
    else if (loadRatio >= 0.7) note(`load ${loadRatio.toFixed(1)}`, 'watch')

    if (sys.data.memory.percent >= 90) note(`mem ${Math.round(sys.data.memory.percent)}%`, 'alert')
    else if (sys.data.memory.percent >= 80) note(`mem ${Math.round(sys.data.memory.percent)}%`, 'watch')
  }

  const verdict = alerts > 0
    ? `${alerts} need${alerts === 1 ? 's' : ''} attention`
    : watches > 0
    ? `watching ${watches}`
    : 'all systems steady'
  const verdictTone: Tone = alerts > 0 ? 'alert' : watches > 0 ? 'watch' : 'ok'

  const loading = sys.isLoading && sessions.isLoading && aiUsage.isLoading && vault.isLoading

  const alertSegments = segments.filter((s) => s.tone === 'alert' || s.tone === 'watch')

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      {/* mobile: compact single line */}
      <div className="flex items-center justify-between gap-3 sm:hidden">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">// now</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {alertSegments.map((s) => (
            <span key={s.label} className={`inline-flex items-center gap-1 text-[10px] ${toneText[s.tone]}`}>
              <span className={`h-1.5 w-1.5 ${toneDot[s.tone]}`} aria-hidden />
              [{s.label}]
            </span>
          ))}
        </div>
        {!loading && (
          <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] ${toneText[verdictTone]}`}>
            &gt; {verdict}
          </span>
        )}
      </div>
      {/* desktop: full segments */}
      <div className="hidden sm:flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">// now</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          {loading ? (
            <span className="text-xs text-[var(--color-text-dim)]">syncing…</span>
          ) : segments.length === 0 ? (
            <span className="text-xs text-[var(--color-text-dim)]">no signal yet</span>
          ) : (
            segments.map((s) => (
              <span key={s.label} className={`inline-flex items-center gap-1.5 text-xs ${toneText[s.tone]}`}>
                <span className={`h-1.5 w-1.5 ${toneDot[s.tone]}`} aria-hidden />
                [{s.label}]
              </span>
            ))
          )}
        </div>
        {!loading && (
          <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${toneText[verdictTone]}`}>
            &gt; {verdict}
          </span>
        )}
      </div>
    </section>
  )
}

// "resets in 42m" / "resets in 3h 10m" / "resets Mon 4 PM" — pick the
// granularity that reads best for the distance. Drawn on the row itself, so it
// stays short enough to sit beside the bar.
function fmtResetAt(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'resets now'
  if (mins < 100) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `resets ${new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}`
}

// The exact wall-clock reset, for the hover on the countdown.
function fmtResetExact(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  return `resets ${new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

// The sign-in address, one click to the clipboard. Truncated on narrow screens,
// but the click always copies the whole address.
function AccountEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={`Copy ${email}`}
      onClick={() => { void copyText(email).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }) }}
      className="group mt-0.5 flex max-w-full items-center gap-1 text-left font-normal text-[11px] text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text-dim)]"
    >
      <span className="truncate">{email}</span>
      <span className={`shrink-0 uppercase tracking-[0.1em] ${copied ? 'text-[var(--color-success)]' : 'opacity-0 group-hover:opacity-100'}`}>
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}

// Claude's usage colors: warm accent until it's close to a limit, then red.
const claudeBarColor = (p: number) => (clampPct(p) >= 85 ? 'var(--color-danger)' : '#D97757')
const claudePctText = (p: number) => (clampPct(p) >= 85 ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]')

// One account per row: name, sign-in address, plan, and a bar for each limit,
// 5-hour above weekly. Each bar carries its own reset countdown, and the email
// copies on click, so nothing needed for signing in hides behind a hover.
function AIClientRow({ client }: { client: AIClientUsage }) {
  const q = client.quota
  const plan = client.subscription.replace(/ plan$/i, '')
  return (
    <div
      title={q ? undefined : client.authError || undefined}
      className="flex items-center gap-3 border-b border-[var(--color-border)]/50 py-3 text-sm last:border-b-0 sm:gap-4"
    >
      <div className="w-32 shrink-0 sm:w-60">
        <div className="truncate font-semibold text-[var(--color-text)] sm:text-base">{client.label}</div>
        {client.email && <AccountEmail email={client.email} />}
      </div>
      <div className="hidden w-28 shrink-0 truncate text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-faint)] sm:block">
        {plan}
      </div>
      {q ? (
        // Both limits get a bar. Only the weekly one was drawn, so the 5-hour
        // number, which is the one that actually stops you mid-session, was a
        // bare percentage with nothing to read it against at a glance.
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {([
            { label: '5h', pct: q.sessionPct, resets: q.sessionResetsAt },
            { label: 'wk', pct: q.weeklyPct, resets: q.weeklyResetsAt },
          ] as const).map((row) => (
            // Each bar carries its own reset countdown: one shared tooltip for
            // two bars left you guessing which window it described.
            <div key={row.label} className="flex items-center gap-3">
              <div className="h-2.5 min-w-0 flex-1 rounded-full bg-[var(--color-surface-2)]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${clampPct(row.pct)}%`, backgroundColor: claudeBarColor(row.pct) }}
                />
              </div>
              <div className={`w-16 shrink-0 text-right font-semibold tabular-nums sm:w-20 sm:text-base ${claudePctText(row.pct)}`}>
                {clampPct(row.pct)}% <span className="text-[10px] font-normal text-[var(--color-text-faint)] sm:text-[11px]">{row.label}</span>
              </div>
              <div
                title={fmtResetExact(row.resets)}
                className="w-[92px] shrink-0 truncate text-right text-[10px] tabular-nums text-[var(--color-text-faint)] sm:w-[124px] sm:text-[11px]"
              >
                {fmtResetAt(row.resets) ?? 'reset unknown'}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Dead sign-in: no quota to draw, so the line reports the auth state and
        // today's real token spend instead of a bar. One line, same height.
        <>
          <div className="min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-warning)]">
            {client.authError || 'not signed in'}
          </div>
          <div className="shrink-0 text-right text-xs text-[var(--color-text-dim)]">
            {fmtTokens(client.today.tokens)} today
          </div>
        </>
      )}
    </div>
  )
}

// The primary thing on the dashboard: every AI account's quota at a glance,
// full width, sorted hottest-first so the account closest to a limit leads.
function AIUsageHero() {
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const clients: AIClientUsage[] = aiUsage.data?.aiClients ?? (aiUsage.data
    ? [{ id: 'claude-default', kind: 'claude' as const, label: 'Claude', subscription: 'Claude', ...aiUsage.data.claude }]
    : [])
  const hottest = (c: AIClientUsage) => Math.max(c.quota?.sessionPct ?? -1, c.quota?.weeklyPct ?? -1)
  const sorted = [...clients].sort((a, b) => hottest(b) - hottest(a))
  return (
    <Card title="AI Usage">
      {aiUsage.isLoading && !aiUsage.data ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : aiUsage.error ? (
        <div className="text-sm text-[var(--color-danger)]">Usage data unavailable</div>
      ) : (
        <div className="flex flex-col">
          {sorted.map((client) => <AIClientRow key={client.id} client={client} />)}
        </div>
      )}
    </Card>
  )
}

// The one trade-bot card on the dashboard: the v2 bot (~/trade-bot), reading the
// status.json its status.py generator writes, surfaced through
// /api/tradebot/status. The old v1 "Trading" card that sat under this one was
// removed 2026-08-04: it read the dead /api/trading route (last written
// 2026-07-31) and contradicted this card's broker truth with stale figures.
function TradeBotCard() {
  const status = useQuery({ queryKey: ['tradebot-status'], queryFn: fetchTradeBotStatus, refetchInterval: 60_000 })
  const s = status.data
  const fmtUSD = (n: number | null | undefined) =>
    n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const pill = s
    ? s.stale
      ? { label: 'stale', color: 'var(--color-warning)' }
      : s.up
      ? { label: 'up', color: 'var(--color-success)' }
      : { label: 'down', color: 'var(--color-danger)' }
    : null
  const err = status.error as { detail?: string; message?: string } | null
  // LIVE round trips since pre-registration: the paper arm was retired
  // 2026-08-04 and the funded account is the whole experiment now. null means
  // status.py could not count them yet, so the bar reads empty rather than
  // claiming a confident zero.
  const trips = s?.experiment.live_trips ?? null
  const target = s?.experiment.target_trips ?? 100
  const tripPct = trips != null && target > 0 ? Math.min(100, Math.round((trips / target) * 100)) : 0
  const generatedAgo = s ? fmtAgo(new Date(s.generated_at).getTime()) : null
  return (
    <Card
      title="Trade Bot v2"
      action={pill && (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{ color: pill.color, borderColor: pill.color, textShadow: `0 0 6px ${pill.color}` }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: pill.color, boxShadow: `0 0 6px ${pill.color}` }} aria-hidden />
          {pill.label}
        </span>
      )}
    >
      {status.isLoading && !s ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : status.error || !s ? (
        <div className="space-y-1 text-sm">
          <div className="text-[var(--color-danger)]">Trade bot status unavailable</div>
          {(err?.detail || err?.message) && <div className="text-xs text-[var(--color-text-dim)]">{err.detail || err.message}</div>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-[var(--color-text-dim)]">&gt; {s.up_detail}</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">Live Equity</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-text)]">{fmtUSD(s.portfolio.live_equity)}</div>
            </div>
            {/* Took the slot the retired paper arm used to occupy. Cash against
                equity says whether the bot is deployed or sitting flat. */}
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">Live Cash</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-text)]">{fmtUSD(s.portfolio.live_cash)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">Spend Total</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-text)]">{fmtUSD(s.spend.total_usd)}</div>
              <div className="text-[11px] text-[var(--color-text-faint)]">{s.spend.calls_total} call{s.spend.calls_total === 1 ? '' : 's'}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">Spend Today</div>
              <div className="mt-1 text-sm font-semibold text-[var(--color-text)]">{fmtUSD(s.spend.today_usd)}</div>
              <div className="text-[11px] text-[var(--color-text-faint)]">{s.spend.calls_today} call{s.spend.calls_today === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">Experiment</span>
              <span className="font-mono text-[10px] text-[var(--color-text-faint)]">{trips ?? '—'}/{target} live trips</span>
            </div>
            <div className="mt-1.5 h-1 w-full bg-[var(--color-surface-2)]">
              <div className="h-full transition-all duration-300" style={{ width: `${tripPct}%`, backgroundColor: 'var(--color-accent)', boxShadow: '0 0 6px var(--color-accent)' }} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-text-dim)]">
            <span className="uppercase tracking-[0.12em]">[market {s.market.is_open ? 'open' : 'closed'}]</span>
            {s.experiment.rules_ok === false && <span className="font-semibold uppercase tracking-[0.12em] text-[var(--color-danger)]">rules drift</span>}
            {generatedAgo && <span className="text-[var(--color-text-faint)]">{generatedAgo}</span>}
          </div>
        </div>
      )}
    </Card>
  )
}

// Usage color shared by every host bar: calm accent, amber past 80, red past 90.
const usageColor = (p: number) =>
  clampPct(p) >= 90 ? 'var(--color-danger)' : clampPct(p) >= 80 ? 'var(--color-warning)' : 'var(--color-accent)'

function HostBar({ label, pct, sub }: { label: string; pct: number | null; sub?: string }) {
  const c = pct == null ? null : clampPct(pct)
  return (
    <div className="flex items-center gap-2.5" title={sub}>
      <span className="w-9 shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">{label}</span>
      <div className="h-2.5 min-w-0 flex-1 rounded-full bg-[var(--color-surface-2)]">
        {c != null && (
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${c}%`, backgroundColor: usageColor(c) }} />
        )}
      </div>
      <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--color-text)]">{c == null ? '—' : `${c}%`}</span>
    </div>
  )
}

// One machine: name + a status dot, three usage bars, one footer line. odin,
// thor, and mimir all render identically, so the fleet reads as one list rather
// than one rich card and two afterthoughts.
function HostCard({ h }: { h: HostStat }) {
  const status = !h.online
    ? { label: 'offline', color: 'var(--color-danger)' }
    : h.stale
    ? { label: 'stale', color: 'var(--color-warning)' }
    : { label: 'online', color: 'var(--color-success)' }
  const load = h.cpu?.loadAvg ? `load ${h.cpu.loadAvg[0].toFixed(2)}` : null
  const cores = h.cpu?.cores ? `${h.cpu.cores} cores` : null
  const up = h.uptime != null ? `up ${fmtUptime(h.uptime)}` : null
  const footer = [cores, load, up].filter(Boolean).join(' · ')
  const memSub = h.memory ? `${fmtBytes(h.memory.used)} / ${fmtBytes(h.memory.total)}` : undefined
  const diskSub = h.disk ? `${fmtBytes(h.disk.used)} / ${fmtBytes(h.disk.total)}` : undefined
  return (
    <div className="space-y-3 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base font-semibold text-[var(--color-text)]">{h.label}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{h.os}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: status.color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: status.color, boxShadow: `0 0 6px ${status.color}` }} aria-hidden />
          {status.label}
        </span>
      </div>
      {h.online ? (
        <>
          <HostBar label="cpu" pct={h.cpu?.usage ?? null} sub={cores ?? undefined} />
          <HostBar label="mem" pct={h.memory?.percent ?? null} sub={memSub} />
          <HostBar label="disk" pct={h.disk?.percent ?? null} sub={diskSub} />
          {footer && <div className="pt-0.5 text-[10px] text-[var(--color-text-faint)]">{footer}</div>}
        </>
      ) : (
        <div className="text-[11px] text-[var(--color-text-dim)]">{h.error || 'not reachable'}</div>
      )}
    </div>
  )
}

function HostsCard() {
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts, refetchInterval: 30_000 })
  return (
    <Card title="Hosts">
      {hosts.isLoading && !hosts.data ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : hosts.error ? (
        <div className="text-sm text-[var(--color-danger)]">Host telemetry unavailable</div>
      ) : (
        // Side by side now that this card owns the wide column: three machines
        // stacked in a 360px rail wasted most of the row.
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {(hosts.data ?? []).map((h) => <HostCard key={h.host} h={h} />)}
        </div>
      )}
    </Card>
  )
}

export default function Dashboard() {
  const profile = useProfile()
  return (
    // overflow-x-clip rather than overflow-hidden. `hidden` makes this element a
    // scroll container in BOTH axes; `clip` clips the horizontal axis without
    // creating one, which is all this needs. Measured, so the record is honest:
    // the old `hidden` was NOT clipping the page (clientHeight == scrollHeight at
    // every viewport tested) and was NOT the scroll bug - that was the shell
    // being taller than the window under CSS zoom, fixed in index.css. This is a
    // correctness tidy-up, not the fix.
    <div className="min-w-0 space-y-8 overflow-x-clip">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// overview</div>
            <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>dashboard<span className="cursor-blink">_</span></h1>
          </div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            [live telemetry]
          </div>
        </div>

        <NowBanner />
      </div>

      {/* Above the fold on purpose: a daily habit check is worthless if you
          have to scroll past the fleet to find it. */}
      <SupplementsCard size={profile.size} />

      {/* AI usage is the headline: full width, first thing under the banner. */}
      <AIUsageHero />

      {/* The desk relight and the room's bulbs, the same controls the Lights
          page carries, in their compact form. On every profile now, desktop
          included: the dashboard is the screen that is already open, and hopping
          to Lights for one button was the whole friction. LightsPanel renders
          each bulb as a single row until tapped, so the whole room fits here
          without turning the dashboard into the Lights page. */}
      <div className="space-y-5">
        <ThorRgbControl size={profile.size} />
        <LightsPanel size={profile.size} />
      </div>

      {/* Two columns now that the sessions card is gone: hosts take the wide
          side (the Sessions page owns session state, and this card duplicated
          it), the trade bot keeps the narrow one. */}
      <div className="grid max-w-full min-w-0 gap-5 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] xl:items-start">
        <div className="order-1 min-w-0">
          <HostsCard />
        </div>

        <div className="order-2 min-w-0 space-y-6 xl:sticky xl:top-24">
          <TradeBotCard />
        </div>
      </div>
    </div>
  )
}
