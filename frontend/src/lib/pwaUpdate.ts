import { useRegisterSW } from 'virtual:pwa-register/react'

// Web/PWA update detection. Registers the service worker and exposes whether a
// newer deployed build is waiting, plus a `reload()` that activates it and
// reloads the page. To make iOS Safari (which only re-checks the SW on relaunch)
// notice new builds, we poll `registration.update()` on an interval and whenever
// the tab/app regains focus.
const UPDATE_POLL_MS = 60_000

export function useWebUpdate(): { needRefresh: boolean; reload: () => void } {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const check = () => { void registration.update() }
      setInterval(check, UPDATE_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.addEventListener('focus', check)
    },
  })

  return { needRefresh, reload: () => void updateServiceWorker(true) }
}
