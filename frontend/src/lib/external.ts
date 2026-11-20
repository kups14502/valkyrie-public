import { isTauri, isTauriMobile } from './auth'

// Outside links in the desktop app (Tauri on Windows, macOS and Linux).
//
// The app's webview opens no second window by itself: wry hands every
// window.open and every target="_blank" link to the app's on_new_window
// handler, and with none set (Valkyrie sets none) it marks the request handled
// and opens nothing, without a word (wry 0.55 webview2 NewWindowRequested).
// That is why the inbox's Open did nothing in the desktop app (2026-11-20).
//
// installExternalLinks() sends such a request to the system browser instead,
// through the app's open_external command (src-tauri/src/lib.rs): a click on
// a target="_blank" link, a middle or Ctrl click on any link, and a
// window.open, whenever the address is http(s) on another origin. It runs in
// every window of the app (each loads this bundle). A same-window link and an
// address of the app's own are left alone, and so are browsers and the
// Android app, where a link opens a tab as it always has.

/** The address as an absolute http(s) URL on another origin, else null. */
function outside(href: string): string | null {
  try {
    const u = new URL(href, location.href)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== location.origin ? u.href : null
  } catch {
    return null
  }
}

/** Opens an http(s) address in the system browser (desktop app only). */
export async function openInSystemBrowser(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_external', { url })
}

const send = (url: string) => {
  openInSystemBrowser(url).catch((e) => console.warn('[external] the system browser did not open', url, e))
}

let installed = false

export function installExternalLinks(): void {
  if (installed || !isTauri() || isTauriMobile()) return
  installed = true

  const native = window.open.bind(window)
  window.open = (url?: string | URL, target?: string, features?: string) => {
    const href = url == null ? null : outside(String(url))
    if (!href) return native(url, target, features)
    send(href)
    return null
  }

  // the bubble phase on the document: after the page's own handlers, so one that took the click wins
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!a || a.hasAttribute('download')) return
    const newWindow = a.target === '_blank' || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey
    const href = newWindow ? outside(a.href) : null
    if (!href) return
    e.preventDefault()
    send(href)
  }
  document.addEventListener('click', onClick)
  document.addEventListener('auxclick', onClick)
}
