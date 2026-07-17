import { Sparkline } from './Sparkline'

// Rich cards for assistant tool results. The backend streams the raw tool
// payload alongside the agent's prose (see backend/src/assistant/index.ts,
// CARD_KIND); each kind gets a compact touch-friendly rendering here.
// Payloads are typed loosely on purpose — cards degrade to nothing rather
// than crash when a field is missing.

export type AssistantCard = { kind: string; data: any }

const usd = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—'
const pct = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—')
const gb = (bytes: unknown) => (typeof bytes === 'number' ? `${(bytes / 1024 ** 3).toFixed(0)}G` : '—')

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">{title}</div>
      {children}
    </div>
  )
}

function Bar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value))
  const tone = v > 90 ? 'var(--color-danger)' : v > 75 ? 'var(--color-warning)' : 'var(--color-accent)'
  return (
    <div className="h-1.5 w-full bg-[rgba(255,255,255,0.06)]">
      <div className="h-full" style={{ width: `${v}%`, background: tone, boxShadow: `0 0 6px ${tone}` }} />
    </div>
  )
}

function TradingCard({ data }: { data: any }) {
  const positions = Array.isArray(data.positions) ? data.positions : []
  const history = Array.isArray(data.equityHistory) ? data.equityHistory.map((p: any) => Number(p.equity)).filter(Number.isFinite) : []
  return (
    <Frame title="trade-bot">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-bold text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>
            {usd(data.equity)}
          </div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
            equity · realized {usd(data.realizedTotalUSD)}
          </div>
        </div>
        {data.marketRegime && (
          <span className="border border-[var(--color-border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)]">
            {String(data.marketRegime)}
          </span>
        )}
      </div>
      {history.length > 1 && <Sparkline values={history} color="var(--color-accent)" height={26} />}
      {positions.length > 0 && (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {positions.slice(0, 8).map((p: any) => (
              <tr key={p.symbol} className="border-t border-[var(--color-border)]">
                <td className="py-1 font-mono">{p.symbol}</td>
                <td className="py-1 text-right text-[var(--color-text-dim)]">{Number(p.quantity ?? 0).toFixed(4).replace(/\.?0+$/, '')}</td>
                <td className={`py-1 text-right font-mono ${Number(p.pnlPct) >= 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-danger)]'}`}>
                  {pct(p.pnlPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Frame>
  )
}

function SystemCard({ data }: { data: any }) {
  const up = typeof data.uptime === 'number' ? `${Math.floor(data.uptime / 86400)}d ${Math.floor((data.uptime % 86400) / 3600)}h` : '—'
  const rows: Array<[string, number, string]> = [
    ['cpu', Number(data.cpu?.usage ?? 0), `${Number(data.cpu?.usage ?? 0).toFixed(0)}%`],
    ['mem', Number(data.memory?.percent ?? 0), `${gb(data.memory?.used)} / ${gb(data.memory?.total)}`],
    ['disk', Number(data.disk?.percent ?? 0), `${gb(data.disk?.used)} / ${gb(data.disk?.total)}`],
  ]
  return (
    <Frame title={`odin · up ${up}`}>
      <div className="space-y-2">
        {rows.map(([label, v, detail]) => (
          <div key={label}>
            <div className="mb-0.5 flex justify-between text-[11px] uppercase tracking-[0.14em]">
              <span className="text-[var(--color-text-dim)]">{label}</span>
              <span className="font-mono text-[var(--color-text)]">{detail}</span>
            </div>
            <Bar value={v} />
          </div>
        ))}
      </div>
    </Frame>
  )
}

function ServicesCard({ data }: { data: any }) {
  const services = Array.isArray(data.services) ? data.services : []
  if (services.length === 0) return null
  return (
    <Frame title="services">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {services.map((s: any) => (
          <div key={s.id ?? s.name} className="flex items-center gap-2 text-sm">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                background: s.health === 'alive' ? 'var(--color-accent)' : s.health === 'down' ? 'var(--color-danger)' : 'var(--color-text-faint)',
                boxShadow: s.health === 'alive' ? '0 0 6px var(--color-accent)' : undefined,
              }}
            />
            <span className="truncate text-[var(--color-text-dim)]">{s.name}</span>
          </div>
        ))}
      </div>
    </Frame>
  )
}

function LightsCard({ data }: { data: any }) {
  const lights = Array.isArray(data.lights) ? data.lights : []
  if (lights.length === 0) return null
  return (
    <Frame title="lights">
      <div className="flex flex-wrap gap-2">
        {lights.map((l: any) => (
          <span
            key={l.entity_id}
            className={`border px-2 py-1 text-xs uppercase tracking-[0.1em] ${
              l.on ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-faint)]'
            }`}
          >
            {l.name} {l.on ? 'on' : 'off'}
          </span>
        ))}
      </div>
    </Frame>
  )
}

function Poster({ item, wide }: { item: any; wide?: boolean }) {
  return (
    <div className={`shrink-0 ${wide ? 'w-40' : 'w-28'}`}>
      <div className="relative aspect-[2/3] w-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        {item.poster ? (
          <img src={item.poster} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-[var(--color-text-faint)]">{item.title}</div>
        )}
        {(item.inLibrary || item.alreadyInLibrary) && (
          <span className="absolute left-0 top-1 bg-black/80 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--color-accent)]">
            in library
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-xs text-[var(--color-text)]" title={item.title}>{item.title}</div>
      <div className="text-[10px] text-[var(--color-text-faint)]">
        {item.year ?? ''}{item.seasons ? ` · ${item.seasons} seasons` : ''}
      </div>
    </div>
  )
}

function MediaResultsCard({ data }: { data: any }) {
  const results = Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return null
  return (
    <Frame title="matches">
      <div className="flex gap-3 overflow-x-auto pb-1">
        {results.map((r: any, i: number) => <Poster key={r.tmdbId ?? r.tvdbId ?? i} item={r} />)}
      </div>
    </Frame>
  )
}

function MediaAddedCard({ data }: { data: any }) {
  return (
    <Frame title={data.alreadyInLibrary ? 'already in library' : 'added to library'}>
      <div className="flex gap-3">
        <Poster item={data} wide />
        <div className="min-w-0 text-sm leading-relaxed text-[var(--color-text-dim)]">
          {data.added && <div className="mb-1 text-[var(--color-accent)]">✓ downloading — it'll appear in Plex automatically</div>}
          <p className="line-clamp-5">{data.overview}</p>
        </div>
      </div>
    </Frame>
  )
}

function MediaQueueCard({ data }: { data: any }) {
  const items = Array.isArray(data.downloading) ? data.downloading : []
  return (
    <Frame title={`downloading · ${items.length}`}>
      {items.length === 0 && <div className="text-sm text-[var(--color-text-faint)]">queue is empty</div>}
      <div className="space-y-2">
        {items.slice(0, 8).map((d: any, i: number) => (
          <div key={i}>
            <div className="mb-0.5 flex justify-between gap-2 text-sm">
              <span className="truncate">{d.title}</span>
              <span className="shrink-0 font-mono text-[var(--color-text-faint)]">
                {typeof d.progress === 'number' ? `${d.progress}%` : d.status}{d.eta ? ` · ${d.eta}` : ''}
              </span>
            </div>
            {typeof d.progress === 'number' && <Bar value={d.progress} />}
          </div>
        ))}
      </div>
    </Frame>
  )
}

function GigsCard({ data }: { data: any }) {
  const gigs = Array.isArray(data) ? data : []
  const active = gigs.filter((g: any) => g.status === 'active')
  const shown = (active.length > 0 ? active : gigs).slice(0, 8)
  if (shown.length === 0) return null
  return (
    <Frame title={`gig log · ${active.length} active`}>
      <div className="space-y-1">
        {shown.map((g: any) => (
          <div key={g.id} className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-1.5 w-1.5 rotate-45 ${g.status === 'active' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-faint)]'}`} />
            <span className={`truncate ${g.status === 'completed' ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}>
              {g.title}
            </span>
            <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{g.category}</span>
          </div>
        ))}
      </div>
    </Frame>
  )
}

function UpdateCard({ data }: { data: any }) {
  return (
    <Frame title="valkyrie update">
      <div className="space-y-1 text-sm text-[var(--color-text-dim)]">
        {data.started && <div className="text-[var(--color-accent)]">⟳ {String(data.started)}</div>}
        {data.note && <div>{String(data.note)}</div>}
        {data.version && <div>installed: v{String(data.version)}</div>}
        {typeof data.commitsBehindOriginMain === 'number' && (
          <div>{data.commitsBehindOriginMain === 0 ? 'up to date with origin/main' : `${data.commitsBehindOriginMain} commit(s) behind origin/main`}</div>
        )}
        {data.latestRemoteCommit && <div className="truncate font-mono text-xs">latest: {String(data.latestRemoteCommit)}</div>}
        {data.backendUpdateLog && (
          <pre className="max-h-32 overflow-auto border border-[var(--color-border)] bg-black/40 p-2 text-[10px] leading-relaxed">{String(data.backendUpdateLog)}</pre>
        )}
      </div>
    </Frame>
  )
}

export function AssistantCardView({ card }: { card: AssistantCard }) {
  try {
    switch (card.kind) {
      case 'trading': return <TradingCard data={card.data} />
      case 'system': return <SystemCard data={card.data} />
      case 'services': return <ServicesCard data={card.data} />
      case 'lights': return <LightsCard data={card.data} />
      case 'media-results': return <MediaResultsCard data={card.data} />
      case 'media-added': return <MediaAddedCard data={card.data} />
      case 'media-queue': return <MediaQueueCard data={card.data} />
      case 'gigs': return <GigsCard data={card.data} />
      case 'update': return <UpdateCard data={card.data} />
      default: return null
    }
  } catch {
    return null
  }
}
