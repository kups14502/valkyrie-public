import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'

// Custom title bar for the installed PWA. Renders only when the app is running
// with Window Controls Overlay (manifest display_override). The OS keeps the
// minimize/maximize/close buttons in the overlay region on the right; we draw
// back/forward/refresh on the left and make the rest a draggable title area.
export function TitleBar() {
  const navigate = useNavigate()
  const [active, setActive] = useState(false)

  useEffect(() => {
    const wco = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean; addEventListener: (e: string, cb: () => void) => void; removeEventListener: (e: string, cb: () => void) => void } }).windowControlsOverlay
    const mq = window.matchMedia('(display-mode: window-controls-overlay)')
    const update = () => setActive(Boolean(wco?.visible) || mq.matches)
    update()
    mq.addEventListener('change', update)
    wco?.addEventListener('geometrychange', update)
    return () => {
      mq.removeEventListener('change', update)
      wco?.removeEventListener('geometrychange', update)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const prev = document.body.style.paddingTop
    document.body.style.paddingTop = 'env(titlebar-area-height, 36px)'
    return () => { document.body.style.paddingTop = prev }
  }, [active])

  if (!active) return null

  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2"
      style={{
        height: 'env(titlebar-area-height, 36px)',
        // Reserve the overlay strip (native window buttons) so our content
        // doesn't slide under them.
        paddingLeft: 'calc(env(titlebar-area-x, 0px) + 8px)',
        width: 'env(titlebar-area-width, 100vw)',
        // @ts-expect-error vendor property
        WebkitAppRegion: 'drag',
      }}
    >
      {/* @ts-expect-error vendor property */}
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' }}>
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" className="flex h-7 w-7 items-center justify-center border border-transparent text-[var(--color-text-dim)] transition hover:border-[var(--color-border)] hover:text-[var(--color-accent)]"><ArrowLeft size={15} /></button>
        <button type="button" onClick={() => navigate(1)} aria-label="Forward" className="flex h-7 w-7 items-center justify-center border border-transparent text-[var(--color-text-dim)] transition hover:border-[var(--color-border)] hover:text-[var(--color-accent)]"><ArrowRight size={15} /></button>
        <button type="button" onClick={() => window.location.reload()} aria-label="Refresh" className="flex h-7 w-7 items-center justify-center border border-transparent text-[var(--color-text-dim)] transition hover:border-[var(--color-border)] hover:text-[var(--color-accent)]"><RotateCw size={14} /></button>
      </div>
      <div className="ml-2 flex select-none items-center gap-2 text-[10px] font-bold uppercase tracking-[0.28em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
        BRNDN//SYS
      </div>
    </div>
  )
}
