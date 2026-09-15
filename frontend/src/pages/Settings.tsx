import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Glasses, Monitor, RefreshCw, Smartphone, Tablet, Wand2 } from 'lucide-react'
import { ThemePicker } from '../components/ThemePicker'
import { fetchPlexLibrary, fetchPlexServer } from '../lib/api'
import {
  getDeviceMode, resolveProfile, setDeviceMode, useProfile, type DeviceMode,
} from '../lib/deviceMode'

const OPTIONS: { mode: DeviceMode; label: string; icon: typeof Monitor; detail: string }[] = [
  { mode: 'auto', label: 'auto', icon: Wand2, detail: 'Pick from the screen and whether it has a touch pointer.' },
  { mode: 'desktop', label: 'desktop', icon: Monitor, detail: 'Opens on the full dashboard. Normal control sizes.' },
  { mode: 'iphone', label: 'iphone', icon: Smartphone, detail: 'Opens on the quick-launch screen at normal control sizes.' },
  { mode: 'ipad', label: 'ipad', icon: Tablet, detail: 'Opens on the quick-launch screen with large, touch-first controls.' },
  { mode: 'vr', label: 'vr headset', icon: Glasses, detail: 'Opens on the VR workspace: terminals and pages side by side on one big screen, with large controls for a laser pointer.' },
]

// Temporary: which link shape lands on the item's page on OUR server (the one
// with the Watch button) rather than Plex's catalog page.
//
// No Plex host publishes a server-scoped universal link (checked every AASA:
// watch.plex.tv only declares /movie/* and /show/*, links.plex.tv only /a/*),
// so only the plex:// scheme can name a machineIdentifier plus ratingKey, and
// the shape the rewritten app accepts is undocumented. Each row below is a
// candidate; tapping tells us more than any amount of further reading. Delete
// this section once one is confirmed.
function PlexLinkTest() {
  const server = useQuery({ queryKey: ['plex-server'], queryFn: fetchPlexServer, staleTime: Infinity, retry: 1 })
  const movies = useQuery({
    queryKey: ['plex-lib', '1', '', 'added'],
    queryFn: () => fetchPlexLibrary('1', 0, { sort: 'added' }),
    staleTime: 300_000,
    retry: 1,
  })
  const [open, setOpen] = useState(false)

  const mid = server.data?.machineIdentifier
  const item = movies.data?.items?.[0]
  if (!mid || !item) return null

  const key = `/library/metadata/${item.ratingKey}`
  const enc = encodeURIComponent(key)
  const watch = item.watchPath ? `https://watch.plex.tv${item.watchPath}` : null

  const candidates: { id: string; note: string; url: string }[] = [
    { id: 'A', note: 'raw key + metadataType', url: `plex://preplay/?metadataKey=${key}&metadataType=1&server=${mid}` },
    { id: 'B', note: 'server first, raw key', url: `plex://preplay/?server=${mid}&metadataKey=${key}` },
    { id: 'C', note: 'encoded key + metadataType', url: `plex://preplay/?metadataKey=${enc}&metadataType=1&server=${mid}` },
    { id: 'D', note: 'play verb (starts playback)', url: `plex://play/?metadataKey=${key}&server=${mid}` },
    { id: 'E', note: 'android-style server route', url: `plex://server://${mid}/com.plexapp.plugins.library${key}` },
    { id: 'F', note: 'no slash after verb', url: `plex://preplay?metadataKey=${enc}&server=${mid}` },
    ...(watch ? [
      { id: 'G', note: 'watch link + ?source=', url: `${watch}?source=${mid}` },
      { id: 'H', note: 'watch link + ?server=', url: `${watch}?server=${mid}` },
    ] : []),
  ]

  return (
    <section className="panel p-4 sm:p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 text-left"
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
          &gt; plex link test
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        <>
          <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-dim)]">
            Testing with <span className="text-[var(--color-text)]">{item.title}</span>. Tap each and
            note which one lands on the page with the Watch button (your server), rather than Plex's
            catalog page or the app's home screen. Then tell me the letter.
          </p>
          <ul className="mt-3 space-y-2">
            {candidates.map((c) => (
              <li key={c.id}>
                <a
                  href={c.url}
                  className="flex min-h-12 items-center gap-3 border border-[var(--color-border)] px-3 active:border-[var(--color-accent)]"
                >
                  <span className="w-5 shrink-0 text-sm font-bold text-[var(--color-accent)]">{c.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-[var(--color-text)]">{c.note}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--color-text-faint)]">{c.url}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export default function Settings() {
  const profile = useProfile()
  const current = getDeviceMode()

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// local</div>
        <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
          settings<span className="cursor-blink">_</span>
        </h1>
      </div>

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
          &gt; this device
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-dim)]">
          Sets which screen Valkyrie opens on, where the home button goes, and how big the
          touch controls are. Saved on this device only, so your iPad and your desktop can differ.
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {OPTIONS.map(({ mode, label, icon: Icon, detail }) => {
            const active = current === mode
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setDeviceMode(mode)}
                aria-pressed={active}
                className={`flex min-h-20 items-start gap-3 border p-3 text-left transition ${
                  active
                    ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.08)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/40 active:border-[var(--color-accent)]'
                }`}
              >
                <Icon size={20} className={`mt-0.5 shrink-0 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className={`text-sm uppercase tracking-[0.16em] ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                      {label}
                    </span>
                    {active && <Check size={13} className="text-[var(--color-accent)]" />}
                  </span>
                  <span className="mt-1 block text-[11px] leading-snug text-[var(--color-text-faint)]">{detail}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-3 text-[11px] text-[var(--color-text-faint)]">
          {current === 'auto'
            ? `Auto currently reads this device as ${profile.resolved}.`
            : `Set to ${profile.resolved}.`}
          {' '}Opens on <span className="text-[var(--color-text-dim)]">{profile.home}</span>.
          {current !== 'auto' && resolveProfile('auto').resolved !== profile.resolved
            && ` Auto would have said ${resolveProfile('auto').resolved}.`}
        </div>
      </section>

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
          &gt; appearance
        </h2>
        <div className="mt-3 flex items-center gap-3">
          <ThemePicker />
          <span className="text-[11px] text-[var(--color-text-faint)]">Accent color, saved on this device.</span>
        </div>
      </section>

      <PlexLinkTest />

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
          &gt; build
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-dim)]">
          Reloading always fetches the newest build. Added to the home screen there's no
          address bar, so this is the way to force it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 inline-flex min-h-12 items-center gap-2 border border-[var(--color-border)] px-5 text-xs uppercase tracking-[0.16em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] active:border-[var(--color-accent)]"
        >
          <RefreshCw size={14} /> reload now
        </button>
      </section>
    </div>
  )
}
