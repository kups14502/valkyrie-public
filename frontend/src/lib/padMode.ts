import { useEffect, useState } from 'react'

// iPad mode. When on, this device treats the pad screen as its dashboard: the
// app opens there and the header's home button goes there instead of the
// regular dashboard. Per device (localStorage), so turning it on for the iPad
// leaves the desktop and phone alone.

const KEY = 'valkyrie-pad'
const EVENT = 'valkyrie-pad-mode-changed'

export function isPadMode(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function setPadMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new Event(EVENT)) } catch { /* non-browser */ }
}

// The home route for this device, so the header button and the launch redirect
// agree on where "home" is.
export const padHome = (on: boolean) => (on ? '/pad' : '/dashboard')

export function usePadMode(): boolean {
  const [on, setOn] = useState(isPadMode)
  useEffect(() => {
    const sync = () => setOn(isPadMode())
    window.addEventListener(EVENT, sync)
    // Also follow the setting when another tab changes it.
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return on
}
