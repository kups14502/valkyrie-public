// UI zoom: Ctrl/Cmd + to grow, Ctrl/Cmd - to shrink, Ctrl/Cmd 0 to reset.
// We scale via the `zoom` CSS property (supported by Chromium + WebKitGTK,
// the webviews Tauri uses) instead of root font-size, because the UI relies
// on fixed-px Tailwind classes (text-[10px], etc.) that wouldn't respond to a
// rem-based scale. The level is persisted so it survives app restarts.

const KEY = 'mc-zoom'
const MIN = 0.6
const MAX = 2.0
const STEP = 0.1

function clamp(z: number) {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100))
}

export function getZoom(): number {
  const stored = parseFloat(localStorage.getItem(KEY) ?? '1')
  return Number.isFinite(stored) ? clamp(stored) : 1
}

export function applyZoom(z: number) {
  const level = clamp(z)
  // `zoom` isn't in the typed CSSStyleDeclaration but is honored at runtime.
  ;(document.documentElement.style as unknown as Record<string, string>).zoom = String(level)
  localStorage.setItem(KEY, String(level))
  return level
}

function adjust(delta: number) {
  return applyZoom(getZoom() + delta)
}

/**
 * Apply the saved zoom and wire up the keyboard shortcuts.
 * Returns a cleanup function that removes the listener.
 */
export function setupZoom(): () => void {
  applyZoom(getZoom())

  const handler = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    switch (e.key) {
      case '+':
      case '=': // unshifted "+" key
        e.preventDefault()
        adjust(STEP)
        break
      case '-':
      case '_':
        e.preventDefault()
        adjust(-STEP)
        break
      case '0':
        e.preventDefault()
        applyZoom(1)
        break
    }
  }

  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
