import { useEffect, useState } from 'react'
import { TERM_NAME_RE, v2TermPath } from './term'

// Per-device profile. Chosen in Settings, stored in localStorage, so the iPad,
// the phone and the desktop each keep their own answer.
//
// Each profile controls three real things: which UI Valkyrie opens in (v2 at
// /m/*, or the classic pages), which screen it opens on (and where the classic
// header's home button goes), and whether touch controls on the classic pages
// render at the large "pad" size. Nothing here is cosmetic-only.

// 'vr' is the Steam Frame (or any headset browser): it opens on the VR
// workspace and gets the pad-sized controls, because a laser pointer wants
// targets as big as a finger does. Never auto-detected; a headset browser looks
// like a desktop to every media query.
export type DeviceMode = 'auto' | 'desktop' | 'iphone' | 'ipad' | 'vr'

const KEY = 'valkyrie-device-mode'
const LEGACY_PAD_KEY = 'valkyrie-pad'
const EVENT = 'valkyrie-device-mode-changed'

const MODES: DeviceMode[] = ['auto', 'desktop', 'iphone', 'ipad', 'vr']

export function getDeviceMode(): DeviceMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v && (MODES as string[]).includes(v)) return v as DeviceMode
    // Migrate the original single "iPad mode" flag.
    if (localStorage.getItem(LEGACY_PAD_KEY) === '1') return 'ipad'
  } catch { /* storage unavailable */ }
  return 'auto'
}

export function setDeviceMode(mode: DeviceMode): void {
  try {
    localStorage.setItem(KEY, mode)
    localStorage.removeItem(LEGACY_PAD_KEY)
  } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* non-browser */ }
}

// What 'auto' means: a touch device wide enough to be a tablet gets the pad
// screen, a narrow touch device is a phone, anything with a mouse is a desktop.
function detect(): Exclude<DeviceMode, 'auto'> {
  if (typeof window === 'undefined') return 'desktop'
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  if (!coarse) return 'desktop'
  return Math.min(window.innerWidth, window.innerHeight) >= 600 ? 'ipad' : 'iphone'
}

export type Profile = {
  mode: DeviceMode
  resolved: Exclude<DeviceMode, 'auto'>
  /** where this device opens: v2's dashboard, or the VR workspace on a headset */
  home: string
  /** the classic UI's own home for this device (the classic header's home button, Settings > Classic) */
  classicHome: string
  /** which UI a fresh tab opens in: v2 everywhere but the headset */
  ui: TabUi
  size: 'normal' | 'pad'
}

const CLASSIC_HOME: Record<Exclude<DeviceMode, 'auto'>, string> = {
  desktop: '/dashboard', iphone: '/phone', ipad: '/pad', vr: '/vr',
}

export function resolveProfile(mode: DeviceMode = getDeviceMode()): Profile {
  const resolved = mode === 'auto' ? detect() : mode
  // v2 (src/v2, /m/*) is the UI on the desktop, the phone and the iPad; the
  // headset keeps its VR workspace, which is a classic page. The classic homes
  // stay reachable from v2 Settings > Classic, the classic menu and ?classic=1.
  const ui: TabUi = resolved === 'vr' ? 'classic' : 'v2'
  return {
    mode,
    resolved,
    home: ui === 'v2' ? '/m/dashboard' : CLASSIC_HOME[resolved],
    classicHome: CLASSIC_HOME[resolved],
    ui,
    size: resolved === 'ipad' || resolved === 'vr' ? 'pad' : 'normal',
  }
}

export function useProfile(): Profile {
  const [profile, setProfile] = useState<Profile>(() => resolveProfile())
  useEffect(() => {
    const sync = () => setProfile(resolveProfile())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return profile
}

// ---------- which UI this tab is in ----------
//
// Set by v2 when it mounts and by the classic shell on any page but the
// terminal; per tab (sessionStorage), so the phone and a desktop browser never
// decide for each other, and a reload keeps the UI the tab was in. A fresh tab
// has none and follows its profile.

export type TabUi = 'v2' | 'classic'
const UI_KEY = 'valkyrie-ui'

export function getTabUi(): TabUi | null {
  try {
    const v = sessionStorage.getItem(UI_KEY)
    return v === 'v2' || v === 'classic' ? v : null
  } catch {
    return null
  }
}

export function setTabUi(ui: TabUi): void {
  try { sessionStorage.setItem(UI_KEY, ui) } catch { /* storage unavailable */ }
}

/** A page load in this tab should open v2: the tab was in v2, or it is fresh and the profile says v2. */
export function tabWantsV2(): boolean {
  const ui = getTabUi()
  return ui === 'v2' || (ui === null && resolveProfile().ui === 'v2')
}

// ---------- classic URLs in v2 ----------

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * The v2 screen for a classic URL, or null when v2 has no such screen (Vault,
 * Slop, Activity, the VR workspace): those stay classic pages. Used for entries only (a page load, a bookmark, an alert),
 * never for a link v2 itself follows to a classic page.
 */
export function classicToV2(pathname: string, search = ''): string | null {
  const p = pathname.replace(/\/+$/, '') || '/'
  const q = new URLSearchParams(search)
  switch (p) {
    case '/':
    case '/dashboard':
    case '/pad':
    case '/phone':
      return '/m/dashboard'
    case '/lights': return '/m/lights'
    case '/sessions': return '/m/ai/sessions'
    case '/projects': return '/m/ai/projects'
    case '/services': return '/m/system/services'
    case '/trade': return '/m/system/trades'
    case '/plex': return '/m/media/dashboard'
    case '/settings': return '/m/settings'
    case '/calendar': return '/m/calendar'
    case '/meals': return '/m/meals'
    case '/sessions/terminal':
    case '/terminal': {
      // only a named session: the v2 terminal never picks one itself
      const name = q.get('s') ?? ''
      return TERM_NAME_RE.test(name) ? v2TermPath(name, q.get('back')) : null
    }
  }
  const proj = /^\/projects\/([^/]+)$/.exec(p)
  if (proj && PROJECT_ID_RE.test(decodeURIComponent(proj[1]))) return `/m/ai/projects?p=${proj[1]}`
  return null
}

/** A v2 path handed over in a URL (?v2= from an alert tap): same origin, under /m/, nothing else. */
export function safeV2Path(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/m/') || raw.startsWith('//') || /[\s\\]/.test(raw)) return null
  return raw
}
