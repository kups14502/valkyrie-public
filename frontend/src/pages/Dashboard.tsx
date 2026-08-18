import { useQuery } from '@tanstack/react-query'
import { Card, Stat } from '../components/Card'
import { Sparkline } from '../components/Sparkline'
import { fetchSystem, fetchSessions, fetchProjects, fetchAIUsage, fetchVault, fetchSystemHistory, fetchLauncher, fetchTradeBotStatus, type AIClientUsage } from '../lib/api'

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
const fmtCost = (n: number) => n > 0 ? `$${n.toFixed(n >= 10 ? 0 : 2)}` : '—'

function UsageBar({ pct, label, sub, warn, claude }: { pct: number; label: string; sub?: string; warn?: boolean; claude?: boolean }) {
  const clamped = clampPct(pct)
  const color = claude
    ? (clamped >= 85 ? 'var(--color-danger)' : '#D97757')
    : (warn || clamped >= 90 ? 'var(--color-danger)' : clamped >= 70 ? 'var(--color-warning)' : 'var(--color-accent)')
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-[var(--color-text-dim)]">{label}</span>
        <span className="shrink-0 font-semibold text-[var(--color-text)]">{clamped}% used</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-2)]">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </div>
      {sub && <div className="text-[11px] text-[var(--color-text-faint)]">{sub}</div>}
    </div>
  )
}

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

const hasSystemShape = (value: unknown): value is {
  cpu: { usage: number; cores: number; loadAvg: [number, number, number] }
  memory: { percent: number; used: number; total: number }
  disk: { percent: number; used: number; total: number }
  uptime: number
  hostname: string
} => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, any>
  return Boolean(
    v.cpu && typeof v.cpu.usage === 'number' && typeof v.cpu.cores === 'number' && Array.isArray(v.cpu.loadAvg) &&
    v.memory && typeof v.memory.percent === 'number' && typeof v.memory.used === 'number' && typeof v.memory.total === 'number' &&
    v.disk && typeof v.disk.percent === 'number' && typeof v.disk.used === 'number' && typeof v.disk.total === 'number' &&
    typeof v.uptime === 'number' && typeof v.hostname === 'string'
  )
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
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
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

  const sessionsList = Array.isArray(sessions.data) ? sessions.data : []
  if (sessionsList.length > 0) note(`${sessionsList.length} session${sessionsList.length === 1 ? '' : 's'}`, 'ok')
  else note('no sessions', 'dim')

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

// "resets in 42m" / "resets in 3h 10m" / "resets Mon Jul 14" — pick the
// granularity that reads best for the distance.
function fmtResetAt(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'resets now'
  if (mins < 100) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  return `resets ${new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
}

function AIClientCard({ client }: { client: AIClientUsage }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{client.label}</div>
        <div className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
          claude · {client.subscription.replace(/ plan$/i, '')}
        </div>
      </div>
      {client.quota ? (
        <div className="space-y-2.5">
          <UsageBar
            claude
            pct={client.quota.sessionPct}
            label="5h session"
            sub={fmtResetAt(client.quota.sessionResetsAt)}
          />
          <UsageBar
            claude
            pct={client.quota.weeklyPct}
            label="Week"
            sub={fmtResetAt(client.quota.weeklyResetsAt)}
          />
        </div>
      ) : (
        // A dead sign-in used to fill the whole card with a warning box, which
        // read as "this account is gone" and left the card taller than its
        // neighbours. The local token history is still real, so show that and
        // keep the auth badge to one line.
        <div className="flex flex-col gap-2">
          {client.authError && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-warning)]">
                {client.authError}
              </span>
              <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                claude /login
              </span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            {([
              ['Today', client.today],
              ['7d', client.last7d],
              ['30d', client.last30d],
            ] as const).map(([label, bucket]) => (
              <div key={label} className="rounded bg-[var(--color-surface)] px-2 py-1.5">
                <div className="text-[10px] text-[var(--color-text-faint)]">{label}</div>
                <div className="text-xs font-semibold text-[var(--color-text)]">{fmtTokens(bucket.tokens)}</div>
                <div className="text-[10px] text-[var(--color-text-faint)]">{fmtCost(bucket.costUSD)}</div>
              </div>
            ))}
          </div>
        </div>
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((client) => <AIClientCard key={client.id} client={client} />)}
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

export default function Dashboard() {
  const sys = useQuery({ queryKey: ['system'], queryFn: fetchSystem })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: fetchSessions })
  const history = useQuery({ queryKey: ['system-history'], queryFn: fetchSystemHistory, refetchInterval: 30_000 })
  const launcher = useQuery({ queryKey: ['launcher'], queryFn: fetchLauncher, refetchInterval: 60_000 })

  const samples = history.data?.samples ?? []
  const cpuSeries = samples.map((s) => s.cpu)
  const memSeries = samples.map((s) => s.mem)
  const diskSeries = samples.map((s) => s.disk)

  const sysError = sys.error as { isUnauthorized?: boolean; isBackendUnavailable?: boolean; detail?: string; message?: string } | null
  const sysUnauthorized = Boolean(sysError?.isUnauthorized)
  const sysBackendUnavailable = Boolean(sysError?.isBackendUnavailable)
  const sysValid = hasSystemShape(sys.data)
  const sessionsList = Array.isArray(sessions.data) ? sessions.data : []

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

      {/* AI usage is the headline: full width, first thing under the banner. */}
      <AIUsageHero />

      <div className="grid max-w-full min-w-0 gap-5 sm:gap-6 xl:grid-cols-[minmax(280px,360px)_minmax(420px,1fr)_minmax(280px,420px)] xl:items-start">
        <div className="order-1 min-w-0 space-y-6 xl:sticky xl:top-24 xl:order-1">
          <TradeBotCard />
        </div>

        <div className="order-3 min-w-0 space-y-6 xl:order-2">
          <Card title="Launcher">
            {launcher.isLoading && !launcher.data ? (
              <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
            ) : launcher.error ? (
              <div className="text-sm text-[var(--color-danger)]">Launcher unavailable</div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                {(launcher.data ?? []).map((s) => {
                  const dot = s.health === 'alive' ? 'bg-[var(--color-success)]' : s.health === 'down' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-faint)]'
                  const tone = s.health === 'alive' ? 'text-[var(--color-text)]' : s.health === 'down' ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text-faint)]'
                  return (
                    <a
                      key={s.id}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`flex items-center justify-between gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 transition hover:border-[var(--color-accent)] active:border-[var(--color-accent)] ${tone}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 ${dot}`} aria-hidden />
                        <span className="truncate text-sm">{s.name}</span>
                      </span>
                      {s.latencyMs != null && (
                        <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">{s.latencyMs}ms</span>
                      )}
                    </a>
                  )
                })}
              </div>
            )}
          </Card>

          <Card title={`Sessions (${sessionsList.length})`}>
            {sessionsList.length > 0 ? (
              <div className="space-y-2">
                {sessionsList.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold">{s.model}</span>
                        {s.project && (
                          <span className="text-[var(--color-text-dim)]">· {s.project}</span>
                        )}
                        {s.gitBranch && s.gitBranch !== 'master' && s.gitBranch !== 'main' && (
                          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-accent)]">
                            [{s.gitBranch}]
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--color-text-dim)]">
                        pid:{s.pid}{s.gitBranch && (s.gitBranch === 'master' || s.gitBranch === 'main') ? ` · ${s.gitBranch}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-[var(--color-text-dim)]">
                      <div>{s.cpu.toFixed(2)}% cpu</div>
                      <div className="mt-0.5">
                        {fmtBytes(s.memory)}
                        {sys.data?.memory?.total
                          ? <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">({clampPct((s.memory / sys.data.memory.total) * 100)}%)</span>
                          : null}
                      </div>
                      {s.lastActivity != null && (
                        <div className="mt-0.5 text-[10px] text-[var(--color-text-faint)]">
                          {fmtAgo(s.lastActivity)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-[var(--color-text-dim)]">{sessions.isLoading ? 'Loading…' : 'No active sessions'}</div>
            )}
          </Card>
        </div>

        <div className="order-2 min-w-0 xl:sticky xl:top-24 xl:order-3">
          <Card title="Server">
            {sys.isLoading ? (
              <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
            ) : sysUnauthorized ? (
              <div className="space-y-1 text-sm">
                <div className="text-[var(--color-warning)]">Access handshake required</div>
                <div className="text-[var(--color-text-dim)]">API is online, but this session is not passing auth yet.</div>
              </div>
            ) : sysBackendUnavailable ? (
              <div className="space-y-1 text-sm">
                <div className="text-[var(--color-danger)]">API route unavailable</div>
                <div className="text-[var(--color-text-dim)]">The frontend cannot currently reach the telemetry API from this host.</div>
              </div>
            ) : sys.error ? (
              <div className="space-y-1 text-sm">
                <div className="text-[var(--color-danger)]">Telemetry unavailable</div>
                {sysError?.detail || sysError?.message ? <div className="text-[var(--color-text-dim)]">{sysError.detail || sysError.message}</div> : null}
              </div>
            ) : sys.data && sysValid ? (
              <div className="grid grid-cols-1 gap-4">
                <Stat
                  label="CPU"
                  value={`${sys.data.cpu.usage.toFixed(1)}%`}
                  sub={`${sys.data.cpu.cores} cores · load ${sys.data.cpu.loadAvg[0].toFixed(2)}`}
                  chart={<Sparkline values={cpuSeries} color="var(--color-accent)" />}
                />
                <Stat
                  label="Memory"
                  value={`${sys.data.memory.percent.toFixed(0)}%`}
                  sub={`${fmtBytes(sys.data.memory.used)} / ${fmtBytes(sys.data.memory.total)}`}
                  chart={<Sparkline values={memSeries} color="#7a5cff" />}
                />
                <Stat
                  label="Disk"
                  value={`${sys.data.disk.percent.toFixed(0)}%`}
                  sub={`${fmtBytes(sys.data.disk.used)} / ${fmtBytes(sys.data.disk.total)}`}
                  chart={<Sparkline values={diskSeries} color="#48e3ce" />}
                />
                <Stat label="Uptime" value={fmtUptime(sys.data.uptime)} sub={sys.data.hostname} />
              </div>
            ) : sys.data ? (
              <div className="text-sm text-[var(--color-warning)]">System data shape was invalid.</div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  )
}
