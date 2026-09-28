import { useNavigate } from 'react-router-dom'
import { Cast, Clapperboard, Film, Music, Server, TrendingUp } from 'lucide-react'
import {
  openInApp, plexAppHomeLink, plexWebHomeLink, shouldDeferAppClick, spotifyAppLink, spotifyWebLink,
} from '../lib/api'
import { Clock, DownloadsPanel, LightsPanel, RecentStrip, SystemChips } from '../components/HomePanels'
import { useProfile } from '../lib/deviceMode'
import { DailyTrackerCard } from '../components/DailyTrackerCard'

// iPad home screen: a big-touch dashboard for the wall/coffee-table iPad.
// Everything is a large target, nothing depends on hover or a keyboard. Lights
// are controlled in full here, and Plex hands off to the Plex app so it can
// AirPlay to the TV. The iPhone equivalent is pages/Phone.tsx; both compose the
// same panels from components/HomePanels.tsx.

// Six tiles in a three-wide grid: two even rows. Two open native apps (below),
// these four navigate. Everything else stays in the nav menu.
const TILES = [
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/services', label: 'services', icon: Server },
  { to: '/slop', label: 'slop', icon: Film },
]

const TILE = 'flex min-h-28 flex-col items-center justify-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.08)]'
const GLOW = { filter: 'drop-shadow(0 0 8px var(--color-accent))' }

export default function Pad() {
  const navigate = useNavigate()
  const profile = useProfile()

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Clock />
        <SystemChips />
      </div>

      <section className="grid grid-cols-3 gap-3">
        {/* Watch on the TV: hands off to the Plex app, which can AirPlay.
            Valkyrie itself can't cast, so this is the honest route. */}
        <a
          href={plexWebHomeLink()}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (shouldDeferAppClick(e)) return
            e.preventDefault()
            openInApp(plexAppHomeLink(), plexWebHomeLink())
          }}
          className={TILE}
        >
          <Cast size={34} className="text-[var(--color-accent)]" style={GLOW} />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">watch on tv</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">opens plex</span>
        </a>
        <a
          href={spotifyWebLink()}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (shouldDeferAppClick(e)) return
            e.preventDefault()
            openInApp(spotifyAppLink(), spotifyWebLink())
          }}
          className={TILE}
        >
          <Music size={34} className="text-[var(--color-accent)]" style={GLOW} />
          <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">music</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">opens spotify</span>
        </a>
        {TILES.map(({ to, label, icon: Icon }) => (
          <button key={to} type="button" onClick={() => navigate(to)} className={TILE}>
            <Icon size={34} className="text-[var(--color-accent)]" style={GLOW} />
            <span className="text-sm uppercase tracking-[0.2em] text-[var(--color-text)]">{label}</span>
          </button>
        ))}
      </section>

      <DailyTrackerCard size={profile.size} />
      <LightsPanel size={profile.size} />
      <DownloadsPanel />
      <RecentStrip />
    </div>
  )
}
