// True when this copy of the app is inside another page's iframe, which is how
// the VR workspace (pages/Vr.tsx) shows a Valkyrie page as a screen. The frame
// already has a header and owns Ctrl+K, and it said which page it wants with
// ?go=, so an embedded copy draws no chrome and never rewrites its start path.
// Same-origin, so the check cannot throw, but a cross-origin embed would, and
// hiding the chrome is the right answer there as well.
export const isEmbedded: boolean = (() => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top
  } catch {
    return true
  }
})()
