import { Check, Monitor, RefreshCw, Smartphone, Tablet, Wand2 } from 'lucide-react'
import { ThemePicker } from '../components/ThemePicker'
import {
  getDeviceMode, resolveProfile, setDeviceMode, useProfile, type DeviceMode,
} from '../lib/deviceMode'

const OPTIONS: { mode: DeviceMode; label: string; icon: typeof Monitor; detail: string }[] = [
  { mode: 'auto', label: 'auto', icon: Wand2, detail: 'Pick from the screen and whether it has a touch pointer.' },
  { mode: 'desktop', label: 'desktop', icon: Monitor, detail: 'Opens on the full dashboard. Normal control sizes.' },
  { mode: 'iphone', label: 'iphone', icon: Smartphone, detail: 'Opens on the quick-launch screen at normal control sizes.' },
  { mode: 'ipad', label: 'ipad', icon: Tablet, detail: 'Opens on the quick-launch screen with large, touch-first controls.' },
]

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
