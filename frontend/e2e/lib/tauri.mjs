// The desktop app (Tauri) without the app: a stand-in for the bridge the
// webview gets (window.__TAURI_INTERNALS__), injected before any app script,
// plus Tauri's own drag script (tauri-drag.js, from the tauri 2.11 crate: the
// script the real window runs, so data-tauri-drag-region behaves as it does
// there). Every command the page invokes is recorded in window.__tauriCalls as
// { cmd, args } and answered here; nothing reaches a real window.
//
// The desktop app also probes odin's API over the tailnet at start
// (lib/api resolveApiBase); lib/cdp.mjs refuses that request, so the page
// falls back to the same-origin /api of the probe.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Tauri's drag-region script (Windows flavor: drag on the first press, maximize on a double-click). */
export const TAURI_DRAG = readFileSync(resolve(HERE, 'tauri-drag.js'), 'utf8')

/**
 * The bridge. `version` is what the app's getVersion answers; the updater
 * finds no update, so the strip's update chip stays away unless a test wants it.
 */
export function tauriStub({ version = '0.3.999' } = {}) {
  return `(() => {
  if (window.__TAURI_INTERNALS__) return
  const calls = window.__tauriCalls = []
  let cb = 0
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: (fn) => { const id = ++cb; window['_' + id] = fn; return id },
    unregisterCallback: (id) => { delete window['_' + id] },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args: args ?? null, at: Date.now() })
      switch (cmd) {
        case 'plugin:app|version': return ${JSON.stringify(version)}
        case 'plugin:window|is_maximized': return false
        case 'plugin:event|listen': return ++cb
        case 'plugin:updater|check': return null
        default: return null
      }
    },
  }
})()`
}

/** The commands the page invoked since `from` (an index into window.__tauriCalls). */
export async function tauriCalls(page, from = 0) {
  return ((await page.eval(() => window.__tauriCalls ?? [])) ?? []).slice(from).map((c) => c.cmd)
}
