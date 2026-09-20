import { useNavigate } from 'react-router-dom'
import { Cast, Clapperboard, Film, Music, Server, SquareTerminal, TrendingUp } from 'lucide-react'
import {
  openInApp, plexAppHomeLink, plexWebHomeLink, shouldDeferAppClick, spotifyAppLink, spotifyWebLink,
} from '../lib/api'
import { DownloadsPanel, LightsPanel, RecentStrip, SystemChips } from '../components/HomePanels'
import { PhoneClock } from '../components/HomePanels'
import { ThorRgbControl } from '../components/ThorRgbControl'
import { SupplementsCard } from '../components/SupplementsCard'

// iPhone home screen. Same panels as the iPad's (components/HomePanels.tsx) but
// laid out for one hand on a 390px screen: a single column, two tiles per row,
// a smaller clock, and tighter spacing so the lights and Plex land above the
// fold instead of below a full-height header.

const TILES = [
  { to: '/sessions', label: 'claude', icon: SquareTerminal },
  { to: '/plex', label: 'plex', icon: Clapperboard },
  { to: '/trade', label: 'trades', icon: TrendingUp },
  { to: '/services', label: 'services', icon: Server },
  { to: '/slop', label: 'slop', icon: Film },
]

const TILE = 'flex min-h-20 flex-col items-center justify-center gap-1.5 border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors active:border-[var(--color-accent)] active:bg-[rgba(var(--color-accent-rgb),0.08)]'
const GLOW = { filter: 'drop-shadow(0 0 8px var(--color-accent))' }

export default function Phone() {
  const navigate = useNavigate()

  return (
    <div className="mx-auto max-w-md space-y-6 pb-6">
      <div className="flex items-end justify-between gap-3">
        <PhoneClock />
        <SystemChips />
      </div>

      <section className="grid grid-cols-2 gap-2.5">
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
          <Cast size={26} className="text-[var(--color-accent)]" style={GLOW} />
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-text)]">watch on tv</span>
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
          <Music size={26} className="text-[var(--color-accent)]" style={GLOW} />
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-text)]">music</span>
        </a>
        {TILES.map(({ to, label, icon: Icon }) => (
          <button key={to} type="button" onClick={() => navigate(to)} className={TILE}>
            <Icon size={26} className="text-[var(--color-accent)]" style={GLOW} />
            <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-text)]">{label}</span>
          </button>
        ))}
      </section>

      <SupplementsCard size="normal" />
      <ThorRgbControl size="normal" />
      <LightsPanel size="normal" />
      <DownloadsPanel />
      <RecentStrip width="w-24" />
    </div>
  )
}
