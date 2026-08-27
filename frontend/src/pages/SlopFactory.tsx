import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchSlopFactoryStats, markTiktokPosted, type SlopStatsEnvelope } from '../lib/api'

// Slop factory page. Every figure comes from `run.py stats --json` on Odin via
// /api/slopfactory/stats. The pipeline turns long video into vertical shorts, holds them
// at a review gate, and the publish stage uploads approved renders to the platforms.
//
// This tab leads with PERFORMANCE and shows the published shorts as a thumbnail grid, like
// a content dashboard. The production pipeline (clips, render queue, gameplay footage) is
// real but secondary, so it sits below in compact, collapsible cards.
//
// Colour: --color-danger only when something wants a human (endpoint down, gameplay short,
// stalled queue). --color-accent is emphasis, not "good". Zero views is never red.

const fmtCount = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return `${n}`
}

const fmtMin = (seconds: number) => {
  const m = seconds / 60
  if (m >= 10) return `${Math.round(m)} min`
  if (m >= 1) return `${m.toFixed(1)} min`
  return `${Math.round(seconds)} s`
}

const fmtDur = (seconds: number | null | undefined) => {
  if (!seconds || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const days = Math.floor((Date.now() - t) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

type Video = {
  title: string
  url: string | null
  platform: string
  remote_id?: string | null
  views: number | null
  likes: number | null
  comments?: number | null
  duration?: number | null
  published_at: string | null
  stats_at: string | null
}

// A big number with a small caption, for the performance hero.
function Stat({
  value,
  label,
  sub,
  accent,
}: {
  value: string
  label: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-lg px-4 py-3"
      style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
    >
      <span
        className="text-3xl font-bold tabular-nums leading-none"
        style={{
          color: accent ? 'var(--color-accent)' : 'var(--color-text)',
          textShadow: accent ? '0 0 12px rgba(var(--color-accent-rgb),0.5)' : undefined,
        }}
      >
        {value}
      </span>
      <span
        className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em]"
        style={{ color: 'var(--color-text-faint)' }}
      >
        {label}
      </span>
      {sub ? (
        <span className="text-xs" style={{ color: 'var(--color-text-dim)' }}>
          {sub}
        </span>
      ) : null}
    </div>
  )
}

// Vertical thumbnail for a short. Tries the original 9:16 frame, falls back to the 16:9
// frame, then a placeholder. YouTube ids map to stable image URLs, so no fetch is needed.
function Thumb({ id, platform }: { id: string | null | undefined; platform: string }) {
  const base = platform === 'youtube' && id ? `https://i.ytimg.com/vi/${id}` : ''
  const [src, setSrc] = useState(base ? `${base}/oardefault.jpg` : '')
  const [dead, setDead] = useState(!base)
  return (
    <div
      className="relative w-full overflow-hidden rounded-md"
      style={{ aspectRatio: '9 / 16', background: 'var(--color-surface-3)' }}
    >
      {!dead ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => {
            if (src.includes('oardefault')) setSrc(`${base}/hqdefault.jpg`)
            else setDead(true)
          }}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-2xl"
          style={{ color: 'var(--color-text-faint)' }}
        >
          ▶
        </div>
      )}
    </div>
  )
}

function ShortCard({ v }: { v: Video }) {
  const views = v.views
  const dur = fmtDur(v.duration)
  const card = (
    <div className="group flex flex-col gap-2">
      <div className="relative">
        <Thumb id={v.remote_id} platform={v.platform} />
        {/* views badge, YouTube-style overlay */}
        <div
          className="absolute bottom-1.5 right-1.5 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
          style={{ background: 'rgba(0,0,0,0.78)', color: '#fff' }}
        >
          {views == null ? '—' : `${fmtCount(views)} views`}
        </div>
        {dur ? (
          <div
            className="absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[11px] tabular-nums"
            style={{ background: 'rgba(0,0,0,0.78)', color: '#fff' }}
          >
            {dur}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div
          className="text-sm leading-snug"
          style={{
            color: 'var(--color-text)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {v.title}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: 'var(--color-text-faint)' }}>
          {fmtWhen(v.published_at)}
          {v.likes != null && v.likes > 0 ? ` · ${fmtCount(v.likes)} likes` : ''}
        </div>
      </div>
    </div>
  )
  return v.url ? (
    <a href={v.url} target="_blank" rel="noreferrer" className="block no-underline hover:opacity-90">
      {card}
    </a>
  ) : (
    card
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 py-1.5 border-b last:border-b-0"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <span className="min-w-0 truncate text-sm" style={{ color: 'var(--color-text-dim)' }}>
        {label}
      </span>
      <span
        className="shrink-0 text-sm tabular-nums"
        style={{ color: tone === 'danger' ? 'var(--color-danger)' : 'var(--color-text)' }}
      >
        {value}
      </span>
    </div>
  )
}

function MiniStat({ value, label, tone }: { value: string; label: string; tone?: 'danger' | 'emphasis' }) {
  const color =
    tone === 'danger' ? 'var(--color-danger)' : tone === 'emphasis' ? 'var(--color-accent)' : 'var(--color-text)'
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </span>
      <span className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--color-text-faint)' }}>
        {label}
      </span>
    </div>
  )
}

type TiktokItem = {
  render_id: number
  title: string
  path: string
  caption: string
  duration?: number
}

function TiktokChecklist({
  posted,
  remaining,
  queue,
  postedToday = 0,
  dailyLimit = 3,
}: {
  posted: number
  remaining: number
  queue: TiktokItem[]
  postedToday?: number
  dailyLimit?: number
}) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState<number | null>(null)
  const mark = useMutation({
    mutationFn: (id: number) => markTiktokPosted(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slopfactory', 'stats'] }),
  })
  const copy = (item: TiktokItem) => {
    navigator.clipboard?.writeText(item.caption).then(
      () => {
        setCopied(item.render_id)
        setTimeout(() => setCopied((c) => (c === item.render_id ? null : c)), 1500)
      },
      () => {},
    )
  }
  return (
    <Card title="tiktok · to post by hand">
      <div className="mb-3 flex flex-wrap gap-x-10 gap-y-4">
        <MiniStat value={`${postedToday}/${dailyLimit}`} label="posted today" tone={postedToday >= dailyLimit ? 'emphasis' : undefined} />
        <MiniStat value={`${remaining}`} label="left in backlog" />
        <MiniStat value={`${posted}`} label="total posted" />
      </div>
      {queue.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--color-text-dim)' }}>
          {remaining === 0
            ? 'Nothing waiting. New shorts appear here as they render.'
            : `Today's ${dailyLimit} are done. The next ${Math.min(dailyLimit, remaining)} show up tomorrow.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {queue.map((item) => (
            <div
              key={item.render_id}
              className="rounded-lg p-3"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            >
              <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {item.title}
              </div>
              <div className="mt-1 break-all text-xs" style={{ color: 'var(--color-text-faint)' }}>
                {item.path.replace('/home/brendon/slop-factory/', 'B:\\slop-factory\\').replace(/\//g, '\\')}
              </div>
              <div
                className="mt-2 rounded p-2 text-xs"
                style={{ background: 'var(--color-surface-3)', color: 'var(--color-text-dim)' }}
              >
                {item.caption}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => copy(item)}
                  className="rounded px-3 py-1.5 text-xs font-semibold"
                  style={{ border: '1px solid var(--color-border-strong)', color: 'var(--color-text)' }}
                >
                  {copied === item.render_id ? 'copied ✓' : 'copy caption'}
                </button>
                <button
                  onClick={() => mark.mutate(item.render_id)}
                  disabled={mark.isPending}
                  className="rounded px-3 py-1.5 text-xs font-bold"
                  style={{ background: 'var(--color-accent)', color: '#000', opacity: mark.isPending ? 0.6 : 1 }}
                >
                  {mark.isPending && mark.variables === item.render_id ? 'marking…' : 'posted ✓'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {mark.isError ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-danger)' }}>
          could not mark posted, try again
        </p>
      ) : null}
      <p className="mt-3 text-xs" style={{ color: 'var(--color-text-faint)' }}>
        Open the file in B:\slop-factory\renders, upload it in the TikTok app, paste the
        caption, then hit posted. {dailyLimit} per day, best shorts first.
      </p>
    </Card>
  )
}

export default function SlopFactory() {
  const { data, isLoading, error } = useQuery<SlopStatsEnvelope>({
    queryKey: ['slopfactory', 'stats'],
    queryFn: fetchSlopFactoryStats,
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <div className="p-0 sm:p-4">
        <Card title="slop factory">
          <span style={{ color: 'var(--color-text-dim)' }}>loading…</span>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-0 sm:p-4">
        <Card title="slop factory">
          <p style={{ color: 'var(--color-danger)' }}>
            [unreachable] could not load the slop factory endpoint.
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-dim)' }}>
            The Valkyrie backend may be down, or it could not reach Odin.
          </p>
        </Card>
      </div>
    )
  }

  const { stats, error: cliError, stale } = data

  if (!stats) {
    return (
      <div className="p-0 sm:p-4">
        <Card title="slop factory">
          <p style={{ color: 'var(--color-danger)' }}>
            [cli failed] {cliError?.message ?? 'the pipeline CLI did not return stats'}
          </p>
          {cliError?.stderr_tail ? (
            <pre
              className="mt-2 overflow-x-auto rounded p-2 text-xs"
              style={{ background: 'var(--color-border)', color: 'var(--color-text-dim)' }}
            >
              {cliError.stderr_tail}
            </pre>
          ) : null}
        </Card>
      </div>
    )
  }

  const g = stats.gameplay
  const s = stats.shorts
  const f = stats.footage
  const p = stats.pipeline
  const pub = stats.publishing
  const publishing = pub != null && pub.platforms_enabled.length > 0
  const stalled = p.budget_blocked || p.failing_sources > 0 || p.failing_clips > 0

  const videos: Video[] = (pub?.videos ?? []) as Video[]
  const byViews = videos.slice().sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
  const posted = pub?.total ?? 0
  const totalViews = pub?.total_views ?? 0
  const totalLikes = pub?.total_likes ?? 0
  const avgViews = posted > 0 ? Math.round(totalViews / posted) : 0

  const perRun = pub?.per_run ?? 0
  const queued = pub?.uploads_needed ?? 0
  const daysToClear = perRun > 0 && queued > 0 ? Math.ceil(queued / perRun) : 0

  return (
    <div className="flex flex-col gap-4 p-0 sm:p-4">
      {stale ? (
        <Card title="stale">
          <p style={{ color: 'var(--color-danger)' }}>
            [stale] showing the last good figures. {cliError?.message ?? 'the CLI is failing'}
          </p>
        </Card>
      ) : null}

      {/* Performance hero. */}
      {publishing ? (
        <Card title="performance">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat value={fmtCount(totalViews)} label="total views" accent />
            <Stat value={fmtCount(totalLikes)} label="total likes" />
            <Stat value={`${posted}`} label="published" sub={`${pub!.platforms_enabled.join(', ')}`} />
            <Stat value={fmtCount(avgViews)} label="avg / short" />
          </div>
          {totalViews === 0 ? (
            <p className="mt-3 text-sm" style={{ color: 'var(--color-text-dim)' }}>
              No views yet. Fresh uploads sit near zero until subscribers or the algorithm
              surface them, which is the cold-start problem, not a pipeline fault.
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Shorts as a thumbnail grid, top performers first. */}
      {publishing && byViews.length > 0 ? (
        <Card title={`shorts · ${byViews.length}`}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {byViews.map((v, i) => (
              <ShortCard key={v.url ?? v.remote_id ?? i} v={v} />
            ))}
          </div>
          <p className="mt-4 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            Sorted by views. Counts refresh on each run and on load. Click a short to open it.
          </p>
        </Card>
      ) : null}

      {/* Upload pipeline: cadence and backlog. */}
      {publishing ? (
        <Card title="upload pipeline">
          <div className="flex flex-wrap gap-x-10 gap-y-4">
            <MiniStat value={`${posted}`} label="posted" />
            <MiniStat value={`${queued}`} label="queued" tone={queued > 0 ? 'emphasis' : undefined} />
            <MiniStat value={`${s.pending}`} label="awaiting review" />
            {pub!.failed > 0 ? (
              <MiniStat value={`${pub!.failed}`} label="upload failures" tone="danger" />
            ) : null}
          </div>
          <div className="mt-4">
            {pub!.platforms_enabled.map((name) => {
              const need = pub!.uploads_needed_by_platform[name] ?? 0
              const done = pub!.by_platform[name] ?? 0
              return (
                <Row
                  key={name}
                  label={name}
                  value={need > 0 ? `${need} to upload · ${done} posted` : `up to date · ${done} posted`}
                />
              )
            })}
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            {pub!.auto_publish && perRun > 0
              ? `Auto-posting up to ${perRun} per run on Odin's daily timer${
                  daysToClear > 0 ? ` · about ${daysToClear} day(s) to clear the queue` : ''
                }.`
              : 'Publishing is manual (run.py publish on Odin).'}
            {pub!.last_published_at ? ` Last posted ${fmtWhen(pub!.last_published_at)}.` : ''}
          </p>
        </Card>
      ) : (
        <Card title="publishing">
          <p className="text-sm" style={{ color: 'var(--color-text-dim)' }}>
            No platforms configured. Set publish.platforms in config.toml on Odin to start
            uploading.
          </p>
        </Card>
      )}

      {/* Manual TikTok checklist. */}
      {pub?.tiktok ? (
        <TiktokChecklist
          posted={pub.tiktok.posted}
          remaining={pub.tiktok.remaining}
          queue={pub.tiktok.queue}
          postedToday={pub.tiktok.posted_today}
          dailyLimit={pub.tiktok.daily_limit}
        />
      ) : null}

      {/* Production, compact and collapsible. */}
      <Card title="production" collapsible storageKey="slop-production">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <MiniStat value={`${f.episodes_ingested}`} label="episodes" />
          <MiniStat value={`${f.clips_total}`} label="clips cut" />
          <MiniStat value={`${s.total}`} label="shorts made" />
          <MiniStat
            value={`${f.clips_awaiting_render}`}
            label="awaiting render"
            tone={p.budget_blocked ? 'danger' : undefined}
          />
        </div>
        <div className="mt-4">
          <Row label="pending review" value={`${s.pending}`} />
          <Row label="approved, not yet posted" value={`${s.approved}`} />
          <Row label="posted" value={`${s.posted}`} />
          <Row label="rejected (gameplay returned)" value={`${s.rejected}`} />
        </div>
      </Card>

      {/* Gameplay footage budget, compact and collapsible. */}
      <Card title="gameplay footage" collapsible storageKey="slop-gameplay">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <MiniStat
            value={fmtMin(g.seconds_remaining)}
            label="footage left"
            tone={g.short_on_gameplay ? 'danger' : undefined}
          />
          <MiniStat
            value={`${g.shorts_supported_remaining}`}
            label="covers N more"
            tone={g.shorts_supported_remaining === 0 ? 'danger' : undefined}
          />
        </div>
        <p className="mt-3 text-sm" style={{ color: g.short_on_gameplay ? 'var(--color-danger)' : 'var(--color-text-dim)' }}>
          {g.short_on_gameplay
            ? `Record about ${fmtMin(g.seconds_needed_for_backlog)} more to cover the ${f.clips_awaiting_render} waiting clip(s).`
            : `Enough footage for the current queue (${fmtMin(g.seconds_available)} across ${g.files.length} file(s)).`}
        </p>
      </Card>

      {stalled ? (
        <Card title="needs attention">
          {p.budget_blocked ? (
            <Row label="render stopped early" value="out of gameplay" tone="danger" />
          ) : null}
          {p.failing_sources > 0 ? (
            <Row label="episodes failing" value={`${p.failing_sources}`} tone="danger" />
          ) : null}
          {p.failing_clips > 0 ? (
            <Row label="clips failing" value={`${p.failing_clips}`} tone="danger" />
          ) : null}
          <p className="mt-3 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            On Odin: run.py failures shows why, run.py retry &lt;id&gt; puts an item back.
          </p>
        </Card>
      ) : null}

      <p className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
        last render {p.last_render_at ? new Date(p.last_render_at).toLocaleString() : 'never'} ·
        stats generated {new Date(stats.generated_at).toLocaleTimeString()}
      </p>
    </div>
  )
}
