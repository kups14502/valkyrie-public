import { useEffect, useRef, useState } from 'react'
import { BellRing, RefreshCw } from 'lucide-react'
import { useDesktopUpdate } from '../lib/updater'
import { useWebUpdate } from '../lib/pwaUpdate'

// Header alarm shown once a newer build is available. On the desktop app the
// update is downloaded + staged and the action relaunches into it ("restart to
// update"); on the web/PWA a new service worker is waiting and the action
// activates it + reloads ("reload to update"). Pulses to draw attention.
export function UpdateAlarm() {
  const { status, version, restart } = useDesktopUpdate()
  const { needRefresh, reload } = useWebUpdate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const desktopReady = status === 'ready'
  const visible = desktopReady || needRefresh
  if (!visible) return null

  const label = desktopReady ? 'restart to update' : 'reload to update'
  const onAct = desktopReady ? () => { void restart() } : () => reload()

  return (
    <div ref={ref} className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Update available"
        title="Update available"
        className="flex h-8 w-8 items-center justify-center border border-[var(--color-accent)] text-[var(--color-accent)] animate-pulse"
        style={{ boxShadow: '0 0 10px var(--color-accent)' }}
      >
        <BellRing size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 border border-[var(--color-border)] bg-[var(--color-surface,#05070b)] p-4">
          <div className="mb-1 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">&gt; update ready</div>
          <div className="mb-3 font-mono text-xs text-[var(--color-text-dim)]">
            {desktopReady ? `v${version ?? ''} downloaded` : 'new version available'}
          </div>
          <button
            type="button"
            onClick={onAct}
            className="flex w-full items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:bg-[rgba(0,255,65,0.08)]"
          >
            <RefreshCw size={13} /> {label}
          </button>
        </div>
      )}
    </div>
  )
}
