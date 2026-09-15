import { useEffect, useState } from 'react'

// Per-device profile. Chosen in Settings, stored in localStorage, so the iPad,
// the phone and the desktop each keep their own answer.
//
// Each profile controls two real things: which screen Valkyrie opens on (and
// where the header's home button goes), and whether touch controls render at
// the large "pad" size. Nothing here is cosmetic-only.

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
  home: string
  size: 'normal' | 'pad'
}

export function resolveProfile(mode: DeviceMode = getDeviceMode()): Profile {
  const resolved = mode === 'auto' ? detect() : mode
  return {
    mode,
    resolved,
    // Each form factor has its own home screen; the desktop keeps the full one.
    home: resolved === 'desktop' ? '/dashboard'
      : resolved === 'ipad' ? '/pad'
        : resolved === 'vr' ? '/vr'
          : '/phone',
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
