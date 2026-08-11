import { useEffect, useState } from 'react'
import { isTauri } from './auth'

// Deploy detection that does NOT need a service worker.
//
// On the tailnet the app is served over plain http, where a service worker can
// never register, so useWebUpdate()'s needRefresh is permanently false and the
// phone/iPad gets no signal that a new build exists. Compare the hashed entry
// bundle named by the served index.html against the one actually running: if
// they differ, a deploy has landed and a plain reload will pick it up (index.html
// is served no-cache, assets are content-hashed).

const POLL_MS = 60_000

function entryFromDocument(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
  return el ? new URL(el.src, location.href).pathname : null
}

function entryFromHtml(html: string): string | null {
  const m = /<script[^>]+src="([^"]*\/assets\/index-[^"]+)"/.exec(html)
  return m ? new URL(m[1], location.href).pathname : null
}

export function useBuildUpdate(): boolean {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    // The desktop app ships bundled assets and updates through Tauri.
    if (isTauri()) return
    const running = entryFromDocument()
    if (!running) return

    let cancelled = false
    const check = async () => {
      if (cancelled || document.visibilityState === 'hidden') return
      try {
        const r = await fetch('/index.html', { cache: 'no-store', headers: { Accept: 'text/html' } })
        if (!r.ok) return
        const served = entryFromHtml(await r.text())
        if (!cancelled && served && served !== running) setStale(true)
      } catch {
        // Offline or the server is down; the next tick tries again.
      }
    }

    void check()
    const timer = window.setInterval(check, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return stale
}
