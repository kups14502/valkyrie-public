import { useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { isTauri, isTauriMobile } from './auth'

// The desktop app's Raven widget: a small always-on-top button with a compact
// chat, in a window of its own (label raven-widget, page /m/w/raven, see
// src/v2/screens/RavenWidget.tsx). Rust creates it, keeps the on/off choice
// and hides it after five minutes with no input (src-tauri/src/lib.rs). This
// file is the page's side of that: is the widget on, turn it on or off, and
// the main window following a link the widget hands it.

export const WIDGET_LABEL = 'raven-widget'
export const WIDGET_PATH = '/m/w/raven'

const desktopApp = (): boolean => isTauri() && !isTauriMobile()

/** This page is the widget itself. */
export const isWidgetPage = (): boolean =>
  desktopApp() && typeof location !== 'undefined' && location.pathname.startsWith(WIDGET_PATH)

let on: boolean | null = null
let started = false
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

function start(): void {
  if (started || !desktopApp()) return
  started = true
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<boolean>('raven_widget_enabled'))
    .then((v) => { on = !!v; emit() })
    // an older app build has no widget: it stays off
    .catch(() => { on = false; emit() })
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<boolean>('raven-widget:changed', (e) => { on = !!e.payload; emit() }))
    .catch(() => {})
}

/** The widget is on: true or false in the desktop app once known, null before that and everywhere else. */
export function useRavenWidgetOn(): boolean | null {
  return useSyncExternalStore(
    (f) => { start(); subs.add(f); return () => { subs.delete(f) } },
    () => on,
    () => null,
  )
}

export async function setRavenWidgetOn(next: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_raven_widget_enabled', { enabled: next })
  on = next
  emit()
}

/**
 * In the main window: a page the widget asks for (its "Open in Valkyrie", a
 * link in a reply) opens here. Rust brings this window forward first.
 */
export function useRavenWidgetBridge(): void {
  const navigate = useNavigate()
  useEffect(() => {
    if (!desktopApp() || isWidgetPage()) return
    let off: (() => void) | null = null
    let gone = false
    void import('@tauri-apps/api/webviewWindow')
      .then(async ({ getCurrentWebviewWindow }) => {
        const me = getCurrentWebviewWindow()
        if (me.label !== 'main') return
        const un = await me.listen<string>('raven-widget:navigate', (e) => {
          const to = typeof e.payload === 'string' ? e.payload : ''
          if (to.startsWith('/') && !to.startsWith('//')) navigate(to)
        })
        if (gone) un()
        else off = un
      })
      .catch(() => {})
    return () => { gone = true; off?.() }
  }, [navigate])
}
