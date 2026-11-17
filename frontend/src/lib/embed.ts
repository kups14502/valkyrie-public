// True when this copy is a panel of the Steam Frame app (xr/ in the repo). The
// app gives each panel its own offscreen tab and installs the valkyrieXr binding
// on window before any script runs, so this is settled at import time. A panel
// calls it to talk back (pages/Xr.tsx).
export const isXrPanel: boolean =
  typeof window !== 'undefined' && typeof (window as { valkyrieXr?: unknown }).valkyrieXr === 'function'

// True when this copy of the app is inside another page's iframe, which is how
// the VR workspace (pages/Vr.tsx) shows a Valkyrie page as a screen, or when it
// is a Steam Frame panel. Either way the host already has a header and owns
// Ctrl+K, and it said which page it wants with ?go=, so an embedded copy draws
// no chrome and never rewrites its start path.
// Same-origin, so the check cannot throw, but a cross-origin embed would, and
// hiding the chrome is the right answer there as well.
export const isEmbedded: boolean = isXrPanel || (() => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top
  } catch {
    return true
  }
})()
