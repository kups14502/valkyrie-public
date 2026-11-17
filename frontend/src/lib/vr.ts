// Shared by the browser VR desk (pages/Vr.tsx) and the Steam Frame app's panels
// (pages/Xr.tsx). Kept out of the page files so those export only components.

export const FONT_KEY = 'valkyrie-vr-font'
export const FONT_MIN = 12
export const FONT_MAX = 32
export const FONT_DEFAULT = 18

// Pages worth a screen of their own in the headset. The terminal and the
// workspace itself are left out: one is a pane already, the other would nest.
export const PAGES: { path: string; label: string }[] = [
  { path: '/sessions', label: 'session board' },
  { path: '/projects', label: 'projects' },
  { path: '/dashboard', label: 'dashboard' },
  { path: '/calendar', label: 'calendar' },
  { path: '/meals', label: 'meals' },
  { path: '/lights', label: 'lights' },
  { path: '/plex', label: 'plex' },
  { path: '/trade', label: 'trades' },
  { path: '/slop', label: 'slop' },
  { path: '/activity', label: 'activity' },
  { path: '/services', label: 'services' },
]

export function loadFont(): number {
  const v = Number(localStorage.getItem(FONT_KEY))
  return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT
}
