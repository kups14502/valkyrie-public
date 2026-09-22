import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Disc3, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { musicImg } from '../lib/api'
import { next, prev, seek, stop, toggle, usePlayer } from '../lib/player'

// Now-playing bar for the music player (lib/player.ts). Mounted once in the
// shell, under <main>, so it stays put across routes; renders nothing until
// something is queued.

const fmt = (sec: number) => {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const ctl = 'flex h-10 w-10 items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30'

export default function PlayerBar() {
  const p = usePlayer()
  // While the thumb is being dragged the slider follows the finger, not the
  // clock; the seek happens once on release.
  const [scrub, setScrub] = useState<number | null>(null)
  const track = p.queue[p.index]
  if (!track) return null

  const pos = scrub ?? p.position
  const max = Math.max(1, p.duration)
  const commit = () => {
    if (scrub == null) return
    seek(scrub)
    setScrub(null)
  }
  const seekBar = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-[var(--color-text-faint)]">{fmt(pos)}</span>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(pos, max)}
        onChange={(e) => setScrub(Number(e.target.value))}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        aria-label="Seek"
        className="min-w-0 flex-1"
        style={{ accentColor: 'var(--color-accent)' }}
      />
      <span className="w-10 shrink-0 text-[10px] tabular-nums text-[var(--color-text-faint)]">{fmt(p.duration)}</span>
    </div>
  )

  return (
    <div
      data-player
      className="relative z-10 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 sm:px-6"
      style={{ boxShadow: '0 -8px 24px rgba(0,0,0,0.35)' }}
    >
      <div className="mx-auto flex max-w-[1800px] items-center gap-3">
        <Link to="/plex" className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
            {track.thumb
              ? <img src={musicImg(track.thumb, 120)} alt="" className="h-full w-full object-cover" />
              : <Disc3 size={18} className="text-[var(--color-text-faint)]" />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm text-[var(--color-text)]">{track.title}</div>
            <div className="truncate text-[11px] text-[var(--color-text-faint)]">
              {track.trackArtist ?? track.artist}{track.album ? ` · ${track.album}` : ''}
            </div>
          </div>
        </Link>

        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label="Previous" onClick={prev} className={ctl}><SkipBack size={18} /></button>
          <button
            type="button"
            aria-label={p.playing ? 'Pause' : 'Play'}
            onClick={toggle}
            className={`${ctl} border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)]`}
          >
            {p.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" aria-label="Next" onClick={next} disabled={p.index >= p.queue.length - 1} className={ctl}><SkipForward size={18} /></button>
        </div>

        <div className="hidden min-w-0 flex-[2] md:flex">{seekBar}</div>
        <span className="hidden shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)] lg:inline">
          {p.index + 1} / {p.queue.length}
        </span>
        <button type="button" aria-label="Stop" onClick={stop} className={ctl}><X size={16} /></button>
      </div>
      {/* Narrow screens: the seek bar drops to its own row. */}
      <div className="mt-1.5 md:hidden">{seekBar}</div>
      {p.error && <div className="mt-1 truncate text-[10px] text-[var(--color-danger)]">{p.error}</div>}
    </div>
  )
}
