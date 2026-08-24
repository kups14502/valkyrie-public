import { useQuery } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchSlopFactoryStats, type SlopStatsEnvelope } from '../lib/api'

// Slop factory page. Every figure comes from `run.py stats --json` on Odin via
// /api/slopfactory/stats. The pipeline turns long video into vertical shorts,
// holds them at a review gate, and the publish stage then uploads approved
// renders to the configured platforms. "posted" means a short has gone out to at
// least one platform (via the publish stage, or marked by hand). This tab is a
// read-only view: it does not itself trigger any upload.
//
// The two questions this tab answers at a glance: do I need to record more
// gameplay (the finite filler pool that sits under every short), and how many
// approved shorts are still waiting to be uploaded to each platform. Gameplay is
// the headline; the publish backlog sits with the shorts below it.
//
// Colour follows the same contract as the trade bot page:
//  * --color-danger ONLY when something actually wants a human. Here that is
//    exactly three things: the endpoint failing, gameplay running short, and a
//    render queue that stalled (budget_blocked or non-zero failures). A queue of
//    shorts waiting to be reviewed is routine and never red.
//  * --color-accent is EMPHASIS, not "good" (the hue is user-picked at runtime,
//    so green-means-good is not available).
//  * everything else is --color-text / -dim / -faint / --color-border.
// Coloured marks are always paired with a word, so colour alone never carries
// meaning.

// Compact view counts: 1.2K, 3.4M. Small numbers print as-is.
const fmtCount = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return `${n}`
}

const minutes = (seconds: number) => seconds / 60

const fmtMin = (seconds: number) => {
  const m = minutes(seconds)
  if (m >= 10) return `${Math.round(m)} min`
  if (m >= 1) return `${m.toFixed(1)} min`
  return `${Math.round(seconds)} s`
}

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

  // A transport failure and a CLI failure are different facts, but both mean the
  // numbers on screen cannot be trusted, so both say so rather than drawing zeros.
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

  return (
    <div className="flex flex-col gap-4 p-0 sm:p-4">
      {stale ? (
        <Card title="stale">
          <p style={{ color: 'var(--color-danger)' }}>
            [stale] showing the last good figures. {cliError?.message ?? 'the CLI is failing'}
          </p>
        </Card>
      ) : null}

      {/* Headline: the only question that decides whether the operator has to act. */}
      <Card title="gameplay">
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
            tone={g.shorts_supported_remaining === 0 ? 'danger' : 'emphasis'}
          />
          <Figure label="spent" value={fmtMin(g.seconds_consumed)} sub="under existing shorts" />
        </div>

        {g.short_on_gameplay ? (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-danger)' }}>
            [record more] about {fmtMin(g.seconds_needed_for_backlog)} of extra gameplay is
            needed to cover the {f.clips_awaiting_render} clip(s) waiting to render. Drop
            recordings into the filler directory on Odin and run render again.
          </p>
        ) : (
          <p className="mt-4 text-sm" style={{ color: 'var(--color-text-dim)' }}>
            Enough footage for the current queue.
          </p>
        )}

        <div className="mt-4">
          {g.files.map((file) => (
            <Row key={file.name} label={file.name} value={fmtMin(file.seconds)} />
          ))}
          {g.files.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
              [empty] no filler videos found. Every short would render without gameplay.
            </p>
          ) : null}
        </div>
      </Card>

      <Card title="shorts">
        <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
          <Figure label="made" value={`${s.total}`} sub={fmtMin(s.seconds_total)} />
          <Figure label="posted" value={`${s.posted}`} sub="on a platform" tone="emphasis" />
          <Figure label="awaiting review" value={`${s.pending}`} />
        </div>
        <div className="mt-4">
          <Row label="pending" value={`${s.pending}`} />
          <Row label="approved, not yet posted" value={`${s.approved}`} />
          <Row label="posted" value={`${s.posted}`} />
          <Row label="rejected (gameplay returned)" value={`${s.rejected}`} />
        </div>
      </Card>

      {/* Publish backlog: only drawn once at least one platform is configured. The
          headline is uploads still needed; per-platform rows break it down. */}
      {publishing && pub ? (
        <Card title="publishing">
          <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
            <Figure
              label="to upload"
              value={`${pub.uploads_needed}`}
              sub="approved, not yet on every platform"
              tone={pub.uploads_needed > 0 ? 'emphasis' : 'normal'}
            />
            <Figure label="published" value={`${pub.total}`} sub={`across ${pub.platforms_enabled.length} platform(s)`} />
            <Figure
              label="total views"
              value={fmtCount(pub.total_views ?? 0)}
              tone={(pub.total_views ?? 0) > 0 ? 'emphasis' : 'normal'}
            />
            {pub.failed > 0 ? (
              <Figure label="failed" value={`${pub.failed}`} sub="see run.py publish" tone="danger" />
            ) : null}
          </div>
          <div className="mt-4">
            {pub.platforms_enabled.map((name) => {
              const need = pub.uploads_needed_by_platform[name] ?? 0
              const done = pub.by_platform[name] ?? 0
              return (
                <Row
                  key={name}
                  label={name}
                  value={need > 0 ? `${need} to upload · ${done} posted` : `up to date · ${done} posted`}
                />
              )
            })}
          </div>

          {/* Per-short view counts, newest first. Views read null until the first fetch,
              shown as a dash rather than 0 so "unknown" and "no views yet" stay distinct. */}
          {pub.videos && pub.videos.length > 0 ? (
            <div className="mt-5">
              <div
                className="mb-1 text-xs uppercase tracking-wide"
                style={{ color: 'var(--color-text-faint)' }}
              >
                shorts
              </div>
              {pub.videos.map((v, i) => {
                const label =
                  v.views == null ? '—' : `${fmtCount(v.views)} view${v.views === 1 ? '' : 's'}`
                const row = (
                  <div
                    className="flex items-baseline justify-between gap-4 py-1.5 border-b last:border-b-0"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <span
                      className="min-w-0 truncate text-sm"
                      style={{ color: 'var(--color-text-dim)' }}
                    >
                      {v.title}
                    </span>
                    <span
                      className="shrink-0 text-sm tabular-nums"
                      style={{ color: 'var(--color-text)' }}
                    >
                      {label}
                    </span>
                  </div>
                )
                return v.url ? (
                  <a
                    key={v.url ?? i}
                    href={v.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block no-underline hover:opacity-80"
                  >
                    {row}
                  </a>
                ) : (
                  <div key={i}>{row}</div>
                )
              })}
            </div>
          ) : null}

          <p className="mt-3 text-xs" style={{ color: 'var(--color-text-faint)' }}>
            {pub.last_published_at
              ? `last published ${new Date(pub.last_published_at).toLocaleString()}`
              : 'nothing published yet'}
            . On Odin: run.py publish uploads the backlog.
          </p>
        </Card>
      ) : null}

      <Card title="footage">
        <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-8">
          <Figure
            label="episodes"
            value={`${f.episodes_ingested}`}
            sub={`${fmtMin(f.source_seconds)} ingested`}
          />
          <Figure label="clips cut" value={`${f.clips_total}`} />
          <Figure
            label="awaiting render"
            value={`${f.clips_awaiting_render}`}
            tone={p.budget_blocked ? 'danger' : 'normal'}
          />
        </div>
        {f.episodes_awaiting_clip > 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--color-text-dim)' }}>
            {f.episodes_awaiting_clip} episode(s) ingested but not yet cut into clips.
          </p>
        ) : null}
      </Card>

      {/* Only drawn when something is actually wrong: a silently stalled pipeline is
          the failure the operator would otherwise not notice, especially on a timer. */}
      {stalled ? (
        <Card title="needs attention">
          {p.budget_blocked ? (
            <Row
              label="render stopped early"
              value="out of gameplay"
              tone="danger"
            />
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
