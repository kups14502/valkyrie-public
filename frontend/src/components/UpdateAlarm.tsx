import { useEffect, useRef, useState } from 'react'
import { BellRing, Download, RefreshCw } from 'lucide-react'
import { useDesktopUpdate } from '../lib/updater'
import { useWebUpdate } from '../lib/pwaUpdate'

// Header update indicator, styled to match Valkyrie (no native Windows installer
// dialog — the install runs silently and all UX lives here).
// Desktop app: shows download progress, then a pulsing alarm with "restart to
// update" (installs silently + relaunches). Web/PWA: a waiting service worker
// surfaces "reload to update".
export function UpdateAlarm() {
  const { status, version, progress, restart } = useDesktopUpdate()
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

  const downloading = status === 'downloading'
  const installing = status === 'installing'
  const desktopReady = status === 'ready'
  if (!(downloading || installing || desktopReady || needRefresh)) return null

  const actionable = desktopReady || needRefresh
  const pct = Math.round(progress * 100)
  const onAct = desktopReady ? () => { void restart() } : () => reload()

  return (
    <div ref={ref} className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Update"
        title="Update"
        className={`flex h-8 w-8 items-center justify-center border text-[var(--color-accent)] ${actionable ? 'animate-pulse border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}
        style={actionable ? { boxShadow: '0 0 10px var(--color-accent)' } : undefined}
      >
        {downloading ? <Download size={15} /> : installing ? <RefreshCw size={15} className="animate-spin" /> : <BellRing size={15} />}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-60 border border-[var(--color-border)] bg-[var(--color-surface,#05070b)] p-4">
          <div className="mb-2 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">&gt; update</div>

          {downloading && (
            <>
              <div className="mb-2 font-mono text-xs text-[var(--color-text-dim)]">
                downloading {version ? `v${version}` : ''} · {pct}%
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-[rgba(255,255,255,0.08)]">
                <div
                  className="h-full rounded transition-[width] duration-200"
                  style={{ width: `${pct}%`, background: 'var(--color-accent)', boxShadow: '0 0 10px var(--color-accent)' }}
                />
              </div>
            </>
          )}

          {installing && (
            <div className="flex items-center gap-2 font-mono text-xs text-[var(--color-accent)]">
              <RefreshCw size={13} className="animate-spin" /> installing update…
            </div>
          )}

          {(desktopReady || needRefresh) && (
            <>
              <div className="mb-3 font-mono text-xs text-[var(--color-text-dim)]">
                {desktopReady ? `v${version ?? ''} ready to install` : 'new version available'}
              </div>
              <button
                type="button"
                onClick={onAct}
                className="flex w-full items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:bg-[rgba(0,255,65,0.08)]"
              >
                <RefreshCw size={13} /> {desktopReady ? 'restart to update' : 'reload to update'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
