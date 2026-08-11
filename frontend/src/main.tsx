import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { isTauri } from './lib/auth'
import { resolveProfile } from './lib/deviceMode'

if (isTauri()) {
  // Mark the document so the custom-title-bar offset (--titlebar-h) applies.
  document.documentElement.classList.add('tauri')
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

// The device profile decides the landing screen, so rewrite the URL
// URL before the router reads it. Done here, not in a React effect, so it
// happens exactly once per page load and can't refire when the gate remounts.
const startHome = resolveProfile().home
if (startHome !== '/dashboard' && (location.pathname === '/' || location.pathname === '/dashboard')) {
  try { history.replaceState(null, '', startHome) } catch { /* ignore */ }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// The desktop window starts hidden (tauri.conf.json) and Rust only reveals it
// as a last resort, so reveal it here the moment the app has actually mounted.
// This guarantees the user never sees the WebView2 cold-start error page: a
// failed first navigation stays hidden and Rust retries it off-screen; only a
// real mount shows the window.
if (isTauri()) {
  requestAnimationFrame(() => {
    void import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().show())
      .catch(() => {})
  })
}
