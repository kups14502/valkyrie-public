import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { resolveApiBase } from './lib/api'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { isTauri } from './lib/auth'
import { classicToV2, getTabUi, resolveProfile, safeV2Path, tabWantsV2 } from './lib/deviceMode'
import { isEmbedded } from './lib/embed'

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

// The device profile decides the landing screen and the UI, so rewrite the URL
// before the router reads it. Done here, not in a React effect, so it happens
// exactly once per page load and can't refire when the gate remounts. A page
// load is the only entry: a link v2 follows to a classic page (Settings > Slop,
// "All sessions (classic)") is an in-app navigation and is never rewritten.
//
// A tab that wants v2 (it was in v2, or it is fresh on a desktop, phone or iPad
// profile) lands on the v2 screen for the classic URL it loaded: the start URL,
// a bookmark, an alert tap. An alert tap names its v2 screen itself (?v2=, see
// public/push-sw.js). ?classic=1, or a tab already in the classic UI, keeps the
// classic page; a classic URL v2 has no screen for stays classic too.
//
// Not when the URL names its page with ?go= (the VR workspace loads "/?go=/x"
// into an iframe and RootRedirect in App.tsx routes from there), and never
// inside an iframe at all: the embedder chose the page, and a vr profile would
// otherwise send the embedded copy to /vr, nesting the workspace in itself.
if (!isEmbedded) {
  const params = new URLSearchParams(location.search)
  const handedV2 = safeV2Path(params.get('v2'))
  const classicAsked = params.get('classic') === '1' || getTabUi() === 'classic'
  const onV2 = location.pathname === '/m' || location.pathname.startsWith('/m/')
  let to: string | null = null
  if (!params.has('go') && !classicAsked && !onV2) {
    if (tabWantsV2()) to = handedV2 ?? classicToV2(location.pathname, location.search)
    else if (location.pathname === '/' || location.pathname === '/dashboard') {
      const home = resolveProfile().home
      if (home !== '/dashboard' && !home.startsWith('/m/')) to = home
    }
  }
  // ?v2= means nothing to a classic page: drop it so the classic URL stays clean
  if (!to && params.has('v2')) {
    params.delete('v2')
    const rest = params.toString()
    to = `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`
  }
  if (to) {
    try { history.replaceState(null, '', to) } catch { /* ignore */ }
  }
}

// Settle the API base before the first request. In the desktop app this probes
// odin over the tailnet, so being at home means no sign-in: the backend trusts
// the socket address and AuthGate lets us straight through. Off the tailnet the
// probe fails in about a second and we fall back to Cloudflare, where signing in
// is correct. Awaited rather than fired-and-forgotten, otherwise AuthGate can
// ask Cloudflare first and show a login card that did not need to exist.
void resolveApiBase().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})

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
