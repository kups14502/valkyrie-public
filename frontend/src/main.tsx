import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { isTauri } from './lib/auth'

if (isTauri()) {
  // The desktop/mobile app loads bundled assets and auto-updates via Tauri —
  // a service worker would only serve stale UI after an update. Make sure none
  // is registered (including one left by an earlier build that shipped the SW).
  navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => void r.unregister())).catch(() => {})
} else {
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const checkForUpdate = () => {
        if (navigator.onLine) void registration.update()
      }
      checkForUpdate()
      window.addEventListener('focus', checkForUpdate)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
      window.setInterval(checkForUpdate, 60 * 1000)
    },
    onNeedRefresh() {
      updateSW(true)
    },
    onOfflineReady() {},
  })

  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    window.location.reload()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
