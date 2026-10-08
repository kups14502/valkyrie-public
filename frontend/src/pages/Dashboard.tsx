import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { ThorRgbControl } from '../components/ThorRgbControl'
import { AllLightsControl, LightControl } from '../components/LightControl'
import { DailyTrackerCard } from '../components/DailyTrackerCard'
import { TodayCard } from '../components/TodayCard'
import { QuickSessions } from '../components/QuickSessions'
import { useProfile } from '../lib/deviceMode'
import { useLightsControl } from '../lib/lights'
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
    <section className="flex h-full flex-col justify-center border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
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

// One account per row: name, sign-in address, and a bar for each limit,
// 5-hour above weekly. Each bar carries its own reset countdown, and the email
// copies on click, so nothing needed for signing in hides behind a hover. The
// plan is on the name's hover: it never changes, and its column cost every bar
// a quarter of its length once the tile became one column of three.
function AIClientRow({ client }: { client: AIClientUsage }) {
  const q = client.quota
  const plan = client.subscription.replace(/ plan$/i, '')
  return (
    <div
      title={q ? undefined : client.authError || undefined}
      className="flex items-center gap-3 border-b border-[var(--color-border)]/50 py-1.5 text-sm last:border-b-0"
    >
      <div className="w-36 shrink-0 @lg:w-44" title={plan}>
        <div className="truncate font-semibold leading-tight text-[var(--color-text)]">{client.label}</div>
        {client.email && <AccountEmail email={client.email} />}
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
            <div key={row.label} className="flex items-center gap-2">
              <div className="h-1.5 min-w-0 flex-1 rounded-full bg-[var(--color-surface-2)]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${clampPct(row.pct)}%`, backgroundColor: claudeBarColor(row.pct) }}
                />
              </div>
              <div className={`w-14 shrink-0 text-right text-[13px] font-semibold leading-none tabular-nums ${claudePctText(row.pct)}`}>
                {clampPct(row.pct)}% <span className="text-[10px] font-normal text-[var(--color-text-faint)]">{row.label}</span>
              </div>
              <div
                title={fmtResetExact(row.resets)}
                className="w-[104px] shrink-0 truncate text-right text-[10px] leading-none tabular-nums text-[var(--color-text-faint)]"
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

// Every AI account's quota at a glance, sorted hottest-first so the account
// closest to a limit leads.
function AIUsageTile() {
  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })
  const clients: AIClientUsage[] = aiUsage.data?.aiClients ?? (aiUsage.data
    ? [{ id: 'claude-default', kind: 'claude' as const, label: 'Claude', subscription: 'Claude', ...aiUsage.data.claude }]
    : [])
  const hottest = (c: AIClientUsage) => Math.max(c.quota?.sessionPct ?? -1, c.quota?.weeklyPct ?? -1)
  const sorted = [...clients].sort((a, b) => hottest(b) - hottest(a))
  return (
    <Card title="AI Usage" dense>
      {aiUsage.isLoading && !aiUsage.data ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : aiUsage.error ? (
        <div className="text-sm text-[var(--color-danger)]">Usage data unavailable</div>
      ) : (
        <div className="@container flex flex-col">
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
function TradeBotTile() {
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
      dense
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
        <div className="@container space-y-2.5">
          <div className="truncate text-sm text-[var(--color-text-dim)]" title={s.up_detail}>&gt; {s.up_detail}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 @md:grid-cols-4">
            <div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Live Equity</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtUSD(s.portfolio.live_equity)}</div>
            </div>
            {/* Took the slot the retired paper arm used to occupy. Cash against
                equity says whether the bot is deployed or sitting flat. */}
            <div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Live Cash</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtUSD(s.portfolio.live_cash)}</div>
            </div>
            <div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Spend Total</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtUSD(s.spend.total_usd)}</div>
              <div className="text-[11px] text-[var(--color-text-faint)]">{s.spend.calls_total} call{s.spend.calls_total === 1 ? '' : 's'}</div>
            </div>
            <div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Spend Today</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--color-text)]">{fmtUSD(s.spend.today_usd)}</div>
              <div className="text-[11px] text-[var(--color-text-faint)]">{s.spend.calls_today} call{s.spend.calls_today === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">Experiment</span>
            <div className="h-1 min-w-0 flex-1 bg-[var(--color-surface-2)]">
              <div className="h-full transition-all duration-300" style={{ width: `${tripPct}%`, backgroundColor: 'var(--color-accent)', boxShadow: '0 0 6px var(--color-accent)' }} />
            </div>
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-faint)]">{trips ?? '—'}/{target} live trips</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-text-dim)]">
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

// One usage meter in a host row. The used / total figure is on the hover.
function HostMeter({ pct, sub }: { pct: number | null; sub?: string }) {
  const c = pct == null ? null : clampPct(pct)
  return (
    <div className="flex min-w-0 items-center gap-2" title={sub}>
      <div className="h-1.5 min-w-0 flex-1 rounded-full bg-[var(--color-surface-2)]">
        {c != null && (
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${c}%`, backgroundColor: usageColor(c) }} />
        )}
      </div>
      <span className="w-9 shrink-0 text-right text-[13px] font-semibold tabular-nums text-[var(--color-text)]">{c == null ? '—' : `${c}%`}</span>
    </div>
  )
}

const HOST_GRID = 'grid grid-cols-[6.5rem_repeat(3,minmax(0,1fr))] items-center gap-x-3'

// One machine per row: name and status, then cpu, mem and disk side by side.
// odin, thor and mimir share the columns, so the fleet reads as one table.
function HostRow({ h }: { h: HostStat }) {
  const status = !h.online
    ? { label: 'offline', color: 'var(--color-danger)' }
    : h.stale
    ? { label: 'stale', color: 'var(--color-warning)' }
    : { label: 'online', color: 'var(--color-success)' }
  const load = h.cpu?.loadAvg ? `load ${h.cpu.loadAvg[0].toFixed(2)}` : null
  const cores = h.cpu?.cores ? `${h.cpu.cores} cores` : null
  const up = h.uptime != null ? `up ${fmtUptime(h.uptime)}` : null
  const memSub = h.memory ? `${fmtBytes(h.memory.used)} / ${fmtBytes(h.memory.total)}` : undefined
  const diskSub = h.disk ? `${fmtBytes(h.disk.used)} / ${fmtBytes(h.disk.total)}` : undefined
  // Online and fresh is the normal case, so the second line spends its room on
  // uptime; anything else says what is wrong in the status color.
  const second = status.label === 'online' ? up ?? h.os : status.label
  return (
    <div className={`${HOST_GRID} border-b border-[var(--color-border)]/50 py-1.5 last:border-b-0`}>
      <div className="min-w-0" title={[h.os, cores, load, up].filter(Boolean).join(' · ')}>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: status.color, boxShadow: `0 0 6px ${status.color}` }} aria-hidden />
          <span className="truncate text-sm font-semibold leading-tight text-[var(--color-text)]">{h.label}</span>
        </div>
        <div
          className="truncate pl-3 text-[10px] uppercase tracking-[0.12em]"
          style={{ color: status.label === 'online' ? 'var(--color-text-faint)' : status.color }}
        >
          {second}
        </div>
      </div>
      {h.online ? (
        <>
          <HostMeter pct={h.cpu?.usage ?? null} sub={[cores, load].filter(Boolean).join(' · ') || undefined} />
          <HostMeter pct={h.memory?.percent ?? null} sub={memSub} />
          <HostMeter pct={h.disk?.percent ?? null} sub={diskSub} />
        </>
      ) : (
        <div className="col-span-3 truncate text-[11px] text-[var(--color-text-dim)]">{h.error || 'not reachable'}</div>
      )}
    </div>
  )
}

function HostsTile() {
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts, refetchInterval: 30_000 })
  return (
    <Card title="Hosts" dense>
      {hosts.isLoading && !hosts.data ? (
        <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : hosts.error ? (
        <div className="text-sm text-[var(--color-danger)]">Host telemetry unavailable</div>
      ) : (
        <div>
          <div className={`${HOST_GRID} pb-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]`}>
            <span />
            <span>cpu</span>
            <span>mem</span>
            <span>disk</span>
          </div>
          {(hosts.data ?? []).map((h) => <HostRow key={h.host} h={h} />)}
        </div>
      )}
    </Card>
  )
}

// Same key as the phone and pad lights panel, so the bulbs stay unrolled or
// rolled up the way they were left on this device.
const LIGHTS_BULBS_KEY = 'valkyrie-lights-bulbs-open'

// The room's bulbs and the desk relight in one tile: every light on top, the
// bulbs under it on request, the desk RGB last. Flat rows, no card per bulb.
function LightsTile() {
  const { lights, all, anyOn, availableTargets, litTargets, roomPct, updateOne, bulk, bulkBrightness, bulkPreset } = useLightsControl()
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(LIGHTS_BULBS_KEY) === '1' } catch { return false }
  })
  const toggle = () => setOpen((v) => {
    const next = !v
    try { localStorage.setItem(LIGHTS_BULBS_KEY, next ? '1' : '0') } catch { /* ignore */ }
    return next
  })
  const ordered = useMemo(
    () => [...all].sort((a, b) => Number(a.unavailable) - Number(b.unavailable)),
    [all],
  )
  const onCount = all.filter((l) => l.on).length
  // With one bulb there is no every-light row to fold into, so it always shows.
  const foldable = availableTargets.length > 1

  return (
    <Card
      title="Lights"
      dense
      action={all.length > 0 && (
        <button
          type="button"
          onClick={foldable ? toggle : undefined}
          disabled={!foldable}
          aria-expanded={foldable ? open : undefined}
          className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:hover:text-[var(--color-text-faint)]"
        >
          {onCount} of {all.length} on{foldable ? (open ? ' · hide bulbs' : ' · show bulbs') : ''}
        </button>
      )}
    >
      {lights.isLoading && !lights.data ? (
        <div className="pb-2 text-sm text-[var(--color-text-dim)]">Loading…</div>
      ) : lights.error ? (
        <div className="pb-2 text-sm text-[var(--color-danger)]">Home Assistant unreachable</div>
      ) : all.length > 0 && availableTargets.length === 0 ? (
        <div className="pb-2 text-sm text-[var(--color-warning)]">All lights unavailable. Home Assistant can't reach any bulb.</div>
      ) : all.length > 0 ? (
        <div>
          {foldable && (
            <AllLightsControl
              size="dense"
              count={availableTargets.length}
              litCount={litTargets.length}
              anyOn={anyOn}
              pct={roomPct}
              onToggleAll={bulk}
              onBrightness={bulkBrightness}
              onPreset={bulkPreset}
            />
          )}
          {(open || !foldable) && ordered.map((l) => (
            <LightControl key={l.entity_id} light={l} onUpdate={updateOne} size="dense" compact />
          ))}
        </div>
      ) : null}
      <ThorRgbControl size="dense" />
    </Card>
  )
}

const WIDE_2 = '(min-width: 1024px)'
const WIDE_3 = '(min-width: 1536px)'

// How many columns the window has room for. The tiles are dealt into columns
// rather than laid on grid rows, so a tall tile never leaves a hole beside a
// short one, and opening the bulbs grows one column instead of the whole row.
function useColumnCount(): 1 | 2 | 3 {
  const read = () => (window.matchMedia(WIDE_3).matches ? 3 : window.matchMedia(WIDE_2).matches ? 2 : 1)
  const [n, setN] = useState<1 | 2 | 3>(read)
  useEffect(() => {
    const queries = [WIDE_2, WIDE_3].map((q) => window.matchMedia(q))
    const on = () => setN(read())
    queries.forEach((q) => q.addEventListener('change', on))
    return () => queries.forEach((q) => q.removeEventListener('change', on))
  }, [])
  return n
}

export default function Dashboard() {
  const profile = useProfile()
  const columns = useColumnCount()

  const tiles: Record<string, ReactNode> = {
    tracker: <DailyTrackerCard size={profile.size} dense />,
    today: <TodayCard dense />,
    ai: <AIUsageTile />,
    hosts: <HostsTile />,
    lights: <LightsTile />,
    trade: <TradeBotTile />,
  }
  // The daily tracker and AI usage lead their columns: a habit check is
  // worthless below the fold, and AI usage is the number checked most.
  const layout: string[][] = columns === 3
    ? [['tracker', 'today'], ['ai', 'hosts'], ['lights', 'trade']]
    : columns === 2
    ? [['tracker', 'today', 'lights'], ['ai', 'hosts', 'trade']]
    : [['tracker', 'today', 'ai', 'lights', 'hosts', 'trade']]
  const grid = columns === 3
    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]'
    : columns === 2
    ? 'grid-cols-2'
    : 'grid-cols-1'

  return (
    // overflow-x-clip rather than overflow-hidden. `hidden` makes this element a
    // scroll container in BOTH axes; `clip` clips the horizontal axis without
    // creating one, which is all this needs. Measured, so the record is honest:
    // the old `hidden` was NOT clipping the page (clientHeight == scrollHeight at
    // every viewport tested) and was NOT the scroll bug - that was the shell
    // being taller than the window under CSS zoom, fixed in index.css. This is a
    // correctness tidy-up, not the fix.
    // vk-compact: lets the small text sizes on the tiles' buttons apply (index.css).
    // A dashboard, not a page of stacked cards: everything fits one screen at
    // 1920x1080, so there is no page title and every tile is dense.
    <div className="vk-compact min-w-0 space-y-3 overflow-x-clip">
      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="min-w-0 xl:flex-1">
          <NowBanner />
        </div>
        <div className="xl:shrink-0 [&>section]:h-full">
          <QuickSessions />
        </div>
      </div>

      <div className={`grid items-start gap-3 ${grid}`}>
        {layout.map((col, i) => (
          <div key={i} className="min-w-0 space-y-3">
            {col.map((key) => <div key={key}>{tiles[key]}</div>)}
          </div>
        ))}
      </div>
    </div>
  )
}
