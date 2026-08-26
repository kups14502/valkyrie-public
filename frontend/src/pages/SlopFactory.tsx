import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchSlopFactoryStats, type SlopStatsEnvelope } from '../lib/api'

// Slop factory page. Every figure comes from `run.py stats --json` on Odin via
// /api/slopfactory/stats. The pipeline turns long video into vertical shorts, holds them
// at a review gate, and the publish stage uploads approved renders to the platforms.
//
// This tab leads with PERFORMANCE: what is published and how it is doing (views, likes,
// per-short list). The production pipeline (clips, render queue, gameplay footage) is real
// but secondary, so it sits below in compact cards.
//
// Colour contract, same as the trade bot page:
//  * --color-danger ONLY when something wants a human: the endpoint failing, gameplay
//    running short, or a stalled render queue. Zero views is never red.
//  * --color-accent is EMPHASIS, not "good" (the hue is user-picked at runtime).
//  * everything else is --color-text / -dim / -faint / --color-border.

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

// Short relative date for the shorts list: "today", "2d ago", else a locale date.
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

// Thumbnail for a published video. YouTube ids map to a stable image URL, so no fetch or
// stored column is needed; other platforms fall back to no image.
const thumbUrl = (platform: string, remoteId: string | null | undefined) =>
  platform === 'youtube' && remoteId
    ? `https://i.ytimg.com/vi/${remoteId}/mqdefault.jpg`
    : null

function Figure({
  label,
  value,
  sub,
  tone = 'normal',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'normal' | 'emphasis' | 'danger'
}) {
  const colour =
    tone === 'danger'
      ? 'var(--color-danger)'
      : tone === 'emphasis'
        ? 'var(--color-accent)'
        : 'var(--color-text)'
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--color-text-faint)' }}>
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums" style={{ color: colour }}>
        {value}
      </span>
      {sub ? (
        <span className="text-xs" style={{ color: 'var(--color-text-dim)' }}>
          {sub}
        </span>
      ) : null}
    </div>
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

function ShortRow({ v }: { v: Video }) {
  const thumb = thumbUrl(v.platform, v.remote_id)
  const views = v.views == null ? null : v.views
  const inner = (
    <div
      className="flex items-center gap-3 py-2 border-b last:border-b-0"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div
        className="relative shrink-0 overflow-hidden rounded"
        style={{ width: 64, height: 36, background: 'var(--color-border)' }}
      >
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" style={{ color: 'var(--color-text)' }}>
          {v.title}
        </div>
        <div className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
          {v.platform}
          {v.published_at ? ` · ${fmtWhen(v.published_at)}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
          {views == null ? '—' : fmtCount(views)}
        </div>
        <div className="text-xs" style={{ color: 'var(--color-text-faint)' }}>
          {views == null ? 'views n/a' : views === 1 ? 'view' : 'views'}
          {v.likes != null && v.likes > 0 ? ` · ${fmtCount(v.likes)} likes` : ''}
        </div>
      </div>
    </div>
  )
  return v.url ? (
    <a href={v.url} target="_blank" rel="noreferrer" className="block no-underline hover:opacity-80">
      {inner}
    </a>
  ) : (
    inner
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

  // Performance figures, from the published-video list.
  const videos = (pub?.videos ?? []).slice()
  const byViews = videos
    .slice()
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
  const posted = pub?.total ?? 0
  const totalViews = pub?.total_views ?? 0
  const totalLikes = pub?.total_likes ?? 0
  const avgViews = posted > 0 ? Math.round(totalViews / posted) : 0
  const best = byViews.find((v) => (v.views ?? 0) > 0) ?? null

  // Cadence: how fast the approved backlog drains.
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

      {/* Headline: performance of what is published. Only shown once publishing is set up. */}
      {publishing ? (
        <Card title="performance">
          <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
            <Figure
              label="total views"
              value={fmtCount(totalViews)}
              tone={totalViews > 0 ? 'emphasis' : 'normal'}
            />
            <Figure label="total likes" value={fmtCount(totalLikes)} />
            <Figure label="published" value={`${posted}`} sub={`across ${pub!.platforms_enabled.length} platform(s)`} />
            <Figure label="avg / short" value={fmtCount(avgViews)} sub="views" />
          </div>
          {best ? (
            <p className="mt-4 text-sm" style={{ color: 'var(--color-text-dim)' }}>
              Top short:{' '}
              <span style={{ color: 'var(--color-text)' }}>{best.title}</span>{' '}
              <span className="tabular-nums" style={{ color: 'var(--color-accent)' }}>
                ({fmtCount(best.views ?? 0)} views)
              </span>
            </p>
          ) : (
            <p className="mt-4 text-sm" style={{ color: 'var(--color-text-dim)' }}>
              No views yet. Fresh uploads sit near zero until something surfaces them.
            </p>
          )}
        </Card>
      ) : null}

      {/* The shorts themselves, top performers first. */}
      {publishing && byViews.length > 0 ? (
        <Card title={`shorts (${byViews.length})`}>
          <div>
            {byViews.map((v, i) => (
              <ShortRow key={v.url ?? v.remote_id ?? i} v={v} />
            ))}
          </div>
          <p className="mt-3 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            Sorted by views. Click a short to open it. Counts refresh on each run and on load.
          </p>
        </Card>
      ) : null}

      {/* Upload pipeline: what is queued and how fast it posts. */}
      {publishing ? (
        <Card title="upload pipeline">
          <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
            <Figure label="posted" value={`${posted}`} />
            <Figure
              label="queued"
              value={`${queued}`}
              sub="approved, not yet up"
              tone={queued > 0 ? 'emphasis' : 'normal'}
            />
            <Figure label="awaiting review" value={`${s.pending}`} />
            {pub!.failed > 0 ? (
              <Figure label="upload failures" value={`${pub!.failed}`} sub="see run.py publish" tone="danger" />
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

      {/* Production: clips and the render queue. Compact, below the fold. */}
      <Card title="production" collapsible storageKey="slop-production">
        <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
          <Figure label="episodes" value={`${f.episodes_ingested}`} sub={`${fmtMin(f.source_seconds)} ingested`} />
          <Figure label="clips cut" value={`${f.clips_total}`} />
          <Figure label="shorts made" value={`${s.total}`} sub={fmtMin(s.seconds_total)} />
          <Figure
            label="awaiting render"
            value={`${f.clips_awaiting_render}`}
            tone={p.budget_blocked ? 'danger' : 'normal'}
          />
        </div>
        <div className="mt-4">
          <Row label="pending review" value={`${s.pending}`} />
          <Row label="approved, not yet posted" value={`${s.approved}`} />
          <Row label="posted" value={`${s.posted}`} />
          <Row label="rejected (gameplay returned)" value={`${s.rejected}`} />
        </div>
      </Card>

      {/* Gameplay footage budget: the finite filler pool under every short. */}
      <Card title="gameplay footage" collapsible storageKey="slop-gameplay">
        <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
          <Figure
            label="footage left"
            value={fmtMin(g.seconds_remaining)}
            sub={`of ${fmtMin(g.seconds_available)} across ${g.files.length} file(s)`}
            tone={g.short_on_gameplay ? 'danger' : 'normal'}
          />
          <Figure
            label="covers"
            value={`${g.shorts_supported_remaining}`}
            sub="more short(s) before footage repeats"
            tone={g.shorts_supported_remaining === 0 ? 'danger' : 'normal'}
          />
        </div>
        {g.short_on_gameplay ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-danger)' }}>
            Record about {fmtMin(g.seconds_needed_for_backlog)} more to cover the{' '}
            {f.clips_awaiting_render} waiting clip(s).
          </p>
        ) : (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-text-dim)' }}>
            Enough footage for the current queue.
          </p>
        )}
      </Card>

      {/* Only drawn when the pipeline actually stalled: the failure a timer would hide. */}
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
