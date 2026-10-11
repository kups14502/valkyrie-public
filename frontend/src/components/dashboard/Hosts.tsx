import { useQuery } from '@tanstack/react-query'
import { Zap } from 'lucide-react'
import { fetchHosts, type HostStat } from '../../lib/api'
import { clampPct, fmtAgo, fmtBytes, fmtUptime, usageColor } from './format'
import { Note, Section } from './Section'

const HOUR_MS = 3_600_000

type SparkPoint = { t: number; v: number }

// One usage figure as a chart: the last hour as a filled line, now at the
// right edge, the figure beside it. x is the clock, so a backend that
// restarted ten minutes ago fills the last sixth rather than stretching ten
// minutes across the hour. y is a fixed 0-100: an autoscaled line turns a
// steady 1% into a mountain range.
function HostChart({ pct, sub, points, now }: { pct: number | null; sub?: string; points: SparkPoint[]; now: number }) {
  const c = pct == null ? null : clampPct(pct)
  const color = c == null ? 'var(--color-text-faint)' : usageColor(c)
  const xy = points
    .filter((p) => now - p.t <= HOUR_MS)
    .map((p) => [((p.t - (now - HOUR_MS)) / HOUR_MS) * 100, 100 - clampPct(p.v)] as const)
  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  return (
    <div className="flex min-w-0 items-center gap-2" title={sub ? `${sub} · last hour` : 'last hour'}>
      <div className="relative h-7 min-w-0 flex-1 overflow-hidden border-b border-[var(--color-border-strong)]/40">
        {xy.length >= 2 && (
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polygon points={`${xy[0][0].toFixed(2)},100 ${line} ${xy[xy.length - 1][0].toFixed(2)},100`} fill={color} fillOpacity={0.2} />
            <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-[var(--color-text)]">{c == null ? '—' : `${c}%`}</span>
    </div>
  )
}

// A battery host's charge where the others show uptime: amber at 30%, red at
// 15%, a bolt while it charges.
function Battery({ b }: { b: NonNullable<HostStat['battery']> }) {
  const p = clampPct(b.percent)
  const color = p <= 15 ? 'var(--color-danger)' : p <= 30 ? 'var(--color-warning)' : 'var(--color-accent)'
  return (
    <div className="flex items-center gap-1.5 pl-3.5" title={`battery ${p}% · ${b.status}`}>
      <div className="h-1.5 w-7 shrink-0 overflow-hidden bg-[var(--color-surface-2)]">
        <div className="h-full" style={{ width: `${p}%`, backgroundColor: color }} />
      </div>
      <span className="text-[11px] tabular-nums text-[var(--color-text-faint)]">{p}%</span>
      {b.status === 'charging' && <Zap className="h-2.5 w-2.5 shrink-0" style={{ color }} aria-label="charging" />}
    </div>
  )
}

const GRID = 'grid grid-cols-[6rem_repeat(3,minmax(0,1fr))] items-center gap-x-3'

const series = (h: HostStat, key: 'cpu' | 'mem' | 'disk'): SparkPoint[] =>
  (h.history ?? []).flatMap((p) => {
    const v = p[key]
    return v == null ? [] : [{ t: p.t, v }]
  })

// One machine per row: name and state, then cpu, mem and disk side by side,
// so the fleet reads as one table. now: when the hosts answered.
function HostRow({ h, now }: { h: HostStat; now: number }) {
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
  const second = status.label === 'online' ? up ?? h.os : status.label
  return (
    <div className={`${GRID} border-b border-[var(--color-border)]/40 py-1 last:border-b-0`}>
      <div className="min-w-0" title={[h.os, cores, load, up].filter(Boolean).join(' · ')}>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: status.color }} aria-hidden />
          <span className="truncate text-[13px] leading-tight text-[var(--color-text)]">{h.label}</span>
        </div>
        {status.label === 'online' && h.battery ? (
          <Battery b={h.battery} />
        ) : (
          <div className="truncate pl-3.5 text-[11px]" style={{ color: status.label === 'online' ? 'var(--color-text-faint)' : status.color }}>
            {second}
          </div>
        )}
      </div>
      {h.online ? (
        <>
          <HostChart pct={h.cpu?.usage ?? null} sub={[cores, load].filter(Boolean).join(' · ') || undefined} points={series(h, 'cpu')} now={now} />
          <HostChart pct={h.memory?.percent ?? null} sub={memSub} points={series(h, 'mem')} now={now} />
          <HostChart pct={h.disk?.percent ?? null} sub={diskSub} points={series(h, 'disk')} now={now} />
        </>
      ) : (
        <div className="col-span-3 truncate text-[12px] text-[var(--color-text-faint)]">
          {[h.error || 'not reachable', h.battery && `battery ${clampPct(h.battery.percent)}% ${fmtAgo(h.ts) ?? ''}`.trim()].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  )
}

export function Hosts() {
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: fetchHosts, refetchInterval: 30_000 })
  return (
    <Section title="hosts" meta="last hour">
      {hosts.isLoading && !hosts.data ? (
        <Note>loading…</Note>
      ) : hosts.error ? (
        <Note tone="danger">host telemetry unavailable</Note>
      ) : (
        <div>
          <div className={`${GRID} text-[11px] text-[var(--color-text-faint)]`}>
            <span />
            <span>cpu</span>
            <span>mem</span>
            <span>disk</span>
          </div>
          {(hosts.data ?? []).map((h) => <HostRow key={h.host} h={h} now={hosts.dataUpdatedAt} />)}
        </div>
      )}
    </Section>
  )
}
