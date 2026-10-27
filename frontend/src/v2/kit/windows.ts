import { isTauri, isTauriMobile } from '../../lib/auth'
import { TERM_NAME_RE } from '../../lib/term'
import { toast } from './ui'

// Pop-out windows: one project, one session or the call (AI > Call) in a window
// of its own, beside the main one. The window shows a standalone page with no
// tab bar (src/v2/App.tsx routes /m/w/project/<id>, /m/w/term/<name> and
// /m/w/call), whose status strip is the frameless window's title bar, as it is
// in the main window. The call window stays on top, so it can sit beside the
// Teams or Zoom window.
//
// In the desktop app a pop-out is a real app window, labeled by its target
// (project-<id>, session-<name>), so asking for one that is already open
// brings that window forward instead of opening a second copy. The label glob
// is granted its permissions in src-tauri/capabilities/default.json. In a
// browser it is window.open with a named target, so the same target lands in
// the same window. The Android app has no second window: the target opens in
// place, at its usual page.

export type DetachTarget = { kind: 'project'; id: string } | { kind: 'session'; name: string; title?: string } | { kind: 'call' }

/** Where the standalone pages live. */
export const DETACHED_BASE = '/m/w'

/** A project id as the backend mints it (backend lib/projectTypes KEY_RE). */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const SIZE = {
  project: { width: 1180, height: 820, minWidth: 560, minHeight: 480 },
  session: { width: 1100, height: 760, minWidth: 420, minHeight: 480 },
  call: { width: 480, height: 820, minWidth: 360, minHeight: 420 },
} as const

const valid = (t: DetachTarget): boolean => (t.kind === 'call' ? true : t.kind === 'project' ? PROJECT_ID_RE.test(t.id) : TERM_NAME_RE.test(t.name))

/** The standalone page for a target, null for an id or name that is not one. */
export function detachedPath(t: DetachTarget): string | null {
  if (!valid(t)) return null
  if (t.kind === 'call') return `${DETACHED_BASE}/call`
  return t.kind === 'project' ? `${DETACHED_BASE}/project/${t.id}` : `${DETACHED_BASE}/term/${t.name}`
}

/** The target's usual page in the main UI (the Android app, and a pop-out that cannot open). */
function inAppPath(t: DetachTarget): string {
  if (t.kind === 'call') return '/m/ai/call'
  return t.kind === 'project' ? `/m/ai/projects?p=${encodeURIComponent(t.id)}` : `/m/ai/term/${encodeURIComponent(t.name)}`
}

/** One window per target: the desktop app's window label, and the browser's window name. */
export function windowLabel(t: DetachTarget): string {
  if (t.kind === 'call') return 'call'
  return t.kind === 'project' ? `project-${t.id}` : `session-${t.name}`
}

const desktopApp = (): boolean => isTauri() && !isTauriMobile()

/** True where a pop-out is a real second window: the desktop app, or a browser with a mouse. */
export function canDetach(): boolean {
  if (isTauri()) return !isTauriMobile()
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches
}

/** True on a standalone page (this window is a pop-out). */
export function isDetachedWindow(): boolean {
  return typeof location !== 'undefined' && location.pathname.startsWith(`${DETACHED_BASE}/`)
}

/**
 * A client-side navigation without the router's hook: React Router follows
 * popstate. The entry carries the router's own state shape (key, idx), so its
 * back-button checks keep working.
 */
function goInPlace(path: string): void {
  const idx = (history.state as { idx?: number } | null)?.idx
  history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: (idx ?? 0) + 1 }, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// Labels being created right now: a double-click must not ask for the same window twice.
const creating = new Set<string>()
// Browser pop-outs this page opened, by name, so a second ask focuses one instead of reloading it.
const opened = new Map<string, Window>()

async function focusWindow(w: { unminimize: () => Promise<void>; show: () => Promise<void>; setFocus: () => Promise<void> }): Promise<void> {
  await w.unminimize().catch(() => {})
  await w.show().catch(() => {})
  await w.setFocus().catch(() => {})
}

async function openAppWindow(t: DetachTarget, path: string): Promise<void> {
  const label = windowLabel(t)
  if (creating.has(label)) return
  creating.add(label)
  // a create the app never answers must not block that target for good
  window.setTimeout(() => creating.delete(label), 10_000)
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await focusWindow(existing)
      creating.delete(label)
      return
    }
    const w = new WebviewWindow(label, {
      url: path,
      title: t.kind === 'session' && t.title ? `${t.title} · Valkyrie` : t.kind === 'call' ? 'Call · Valkyrie' : 'Valkyrie',
      ...SIZE[t.kind],
      center: true,
      alwaysOnTop: t.kind === 'call',
      resizable: true,
      // the strip is the title bar (src/v2 StatusStrip, data-tauri-drag-region), as in the main window
      decorations: false,
      focus: true,
      // hidden until the page mounts (main.tsx shows every app window then), so a load never flashes white
      visible: false,
      backgroundColor: '#000000',
    })
    void w.once('tauri://created', () => {
      creating.delete(label)
      // never left hidden: a page that failed to load still gets its window shown
      window.setTimeout(() => {
        void w.isVisible().then((v) => { if (!v) void focusWindow(w) }).catch(() => {})
      }, 4000)
    })
    void w.once<string>('tauri://error', (e) => {
      creating.delete(label)
      // two asks raced past the lookup: the other one made it, so bring that forward
      void WebviewWindow.getByLabel(label).then((again) => {
        if (again) void focusWindow(again)
        else toast(`Could not open the window: ${String(e.payload ?? 'no reason given')}`, { ms: 5000 })
      })
    })
  } catch (e) {
    creating.delete(label)
    toast(`Could not open the window: ${(e as Error | null)?.message ?? 'no reason given'}`, { ms: 5000 })
  }
}

function openBrowserWindow(t: DetachTarget, path: string): void {
  const name = `valkyrie-${windowLabel(t)}`
  const had = opened.get(name)
  if (had && !had.closed) {
    had.focus()
    return
  }
  const { width, height } = SIZE[t.kind]
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2))
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2))
  // same origin on purpose (no noopener): the pop-out shares the sign-in, and this page keeps its handle
  const w = window.open(path, name, `popup,width=${width},height=${height},left=${left},top=${top}`)
  if (!w) {
    toast('The browser blocked the new window. Allow pop-ups for Valkyrie and try again.', { ms: 5000 })
    return
  }
  opened.set(name, w)
  w.focus()
}

/**
 * Opens a project or a session in its own window: in the desktop app a new app
 * window (the one already showing that target is focused instead), in a
 * browser a named pop-up. The window shows /m/w/project/<id> or /m/w/term/<name>.
 */
export function openDetached(target: DetachTarget): void {
  const path = detachedPath(target)
  if (!path) {
    toast(target.kind === 'project' ? 'That is not a project id' : 'That is not a session name')
    return
  }
  if (desktopApp()) {
    void openAppWindow(target, path)
    return
  }
  if (!canDetach()) {
    goInPlace(inAppPath(target))
    return
  }
  openBrowserWindow(target, path)
}

/**
 * Closes this pop-out. A browser tab the page did not open itself refuses
 * window.close(), so after a moment it goes to `fallback` instead.
 */
export function closeDetached(fallback = '/m/ai/sessions'): void {
  if (desktopApp()) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => goInPlace(fallback))
    return
  }
  window.close()
  window.setTimeout(() => { if (!window.closed) goInPlace(fallback) }, 250)
}

/** The pop-out's title: the document's, and the window's in the desktop app (its taskbar entry). */
export function setDetachedTitle(title: string): void {
  if (typeof document === 'undefined') return
  document.title = title
  if (!desktopApp()) return
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {})
}
