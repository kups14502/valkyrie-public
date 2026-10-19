// The desktop app (Tauri) without the app: a stand-in for the bridge the
// webview gets (window.__TAURI_INTERNALS__), injected before any app script,
// plus Tauri's own drag script (tauri-drag.js, from the tauri 2.11 crate: the
// script the real window runs, so data-tauri-drag-region behaves as it does
// there). Every command the page invokes is recorded in window.__tauriCalls as
// { cmd, args } and answered here; nothing reaches a real window.
//
// The desktop app also probes odin's API over the tailnet at start
// (lib/api resolveApiBase); lib/cdp.mjs refuses that request, so the page
// falls back to the same-origin /api of the probe, unless the page is opened
// with `apiHosts` (lib/cdp.mjs), which answers it like odin would.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Tauri's drag-region script (Windows flavor: drag on the first press, maximize on a double-click). */
export const TAURI_DRAG = readFileSync(resolve(HERE, 'tauri-drag.js'), 'utf8')

/**
 * The bridge. `version` is what the app's getVersion answers; the updater
 * finds no update, so the strip's update chip stays away unless a test wants it.
 * `hostname` is what the app's local_hostname command answers (null: unknown,
 * 'thor' the app on thor, anything else the app on another machine). `label`
 * is this window's label ('main', or a pop-out's 'project-<id>' / 'session-<name>').
 *
 * Windows: the app's window list starts as [label]. A create_webview_window
 * adds its label (recorded with its options in window.__tauriWindows.created),
 * so a second ask for the same label finds it and focuses it; nothing opens.
 */
export function tauriStub({ version = '0.3.999', hostname = null, label = 'main' } = {}) {
  return `(() => {
  if (window.__TAURI_INTERNALS__) return
  const calls = window.__tauriCalls = []
  const wins = window.__tauriWindows = { labels: [${JSON.stringify(label)}], created: [] }
  let cb = 0
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: ${JSON.stringify(label)} }, currentWebview: { windowLabel: ${JSON.stringify(label)}, label: ${JSON.stringify(label)} } },
    transformCallback: (fn) => { const id = ++cb; window['_' + id] = fn; return id },
    unregisterCallback: (id) => { delete window['_' + id] },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args: args ?? null, at: Date.now() })
      switch (cmd) {
        case 'plugin:app|version': return ${JSON.stringify(version)}
        case 'plugin:window|is_maximized': return false
        case 'plugin:window|is_visible': return true
        case 'plugin:event|listen': return ++cb
        case 'plugin:updater|check': return null
        case 'local_hostname': return ${JSON.stringify(hostname)}
        case 'plugin:window|get_all_windows': return [...wins.labels]
        case 'plugin:webview|get_all_webviews': return wins.labels.map((l) => ({ windowLabel: l, label: l }))
        case 'plugin:webview|create_webview_window': {
          const o = (args && args.options) || {}
          wins.created.push({ label: o.label, url: o.url, title: o.title, decorations: o.decorations, visible: o.visible, width: o.width, height: o.height })
          if (o.label && !wins.labels.includes(o.label)) wins.labels.push(o.label)
          return null
        }
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

/** The calls themselves ({ cmd, args }) since `from`. */
export async function tauriCallsFull(page, from = 0) {
  return ((await page.eval(() => window.__tauriCalls ?? [])) ?? []).slice(from)
}
