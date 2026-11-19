// True when this copy is a panel of the Steam Frame app (xr/ in the repo). The
// app gives each panel its own offscreen tab and installs the valkyrieXr binding
// on window before any script runs, so this is settled at import time. A panel
// calls it to talk back (pages/Xr.tsx).
export const isXrPanel: boolean =
  typeof window !== 'undefined' && typeof (window as { valkyrieXr?: unknown }).valkyrieXr === 'function'

// True when this copy of the app is inside another page's iframe, which is how
// the VR workspace (pages/Vr.tsx) shows a Valkyrie page as a screen, or when it
// is a Steam Frame panel. Either way the host already has a header and owns
// Ctrl+K, and it said which page it wants with ?go=, so an embedded copy draws
// no chrome and never rewrites its start path.
// Same-origin, so the check cannot throw, but a cross-origin embed would, and
// hiding the chrome is the right answer there as well.
export const isEmbedded: boolean = isXrPanel || (() => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top
  } catch {
    return true
  }
})()

// True only inside another page's iframe (a screen of a desk), never for a
// Steam Frame panel, which is a window of its own.
export const isFramed: boolean = isEmbedded && !isXrPanel

// The v2 Desk (v2/screens/Desk.tsx) puts this on its window so the sessions in
// its tabs can ask it for things a pop-out window would do for itself: open
// another session (a tab beside this one), close (the tab leaves the Desk),
// the Desk's own keys, which a terminal with the focus hands up instead of
// typing them into the session, and whether its tab is in view.
export type DeskHost = {
  open: (name: string, from: Window) => void
  close: (from: Window) => void
  key: (chord: DeskChord, from: Window) => void
  /** true while this tab is the active tab of its column and the Desk is the screen in front */
  shown: (from: Window) => boolean
}

/**
 * The Desk's keys: Ctrl+Tab and Ctrl+Shift+Tab (next and previous tab of the
 * column), Alt+1 to Alt+9 (tab N of the column), Alt+Left and Alt+Right (the
 * column beside), Ctrl+Alt+D (the session done the longest). Claude Code binds
 * none of them (its defaults checked in 2.1.303).
 */
export type DeskChord = 'next' | 'prev' | 'left' | 'right' | 'done' | `tab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

/** The Desk chord a key press is, or null. Physical keys (code), so Option on a Mac keyboard still reads as Alt. */
export function deskChord(e: KeyboardEvent): DeskChord | null {
  if (e.metaKey || e.isComposing) return null
  if (e.ctrlKey && !e.altKey && e.key === 'Tab') return e.shiftKey ? 'prev' : 'next'
  if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyD') return 'done'
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === 'ArrowLeft') return 'left'
    if (e.key === 'ArrowRight') return 'right'
    const n = /^Digit([1-9])$/.exec(e.code)?.[1]
    if (n) return `tab${Number(n) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  }
  return null
}

/** Sent to a tab's window when the Desk opens it: its terminal (or Chat's box) takes the keyboard. */
export const DESK_FOCUS_EVENT = 'valkyrie-desk-focus'

/** Sent to a tab's window when it comes into view or leaves it (deskTabShown says which). */
export const DESK_SHOWN_EVENT = 'valkyrie-desk-shown'

/**
 * Whether this copy is in view as far as the Desk knows: false for a tab kept
 * mounted behind another one, or while the Desk is not the screen in front.
 * A hidden iframe's document still reads as visible, so its polls ask this
 * too. true for anything that is not a Desk tab.
 */
export function deskTabShown(): boolean {
  const d = deskHost()
  if (!d) return true
  try {
    return d.shown(window)
  } catch {
    return true
  }
}

/** The desk this copy is a screen of, or null. */
export function deskHost(): DeskHost | null {
  if (!isFramed) return null
  try {
    return (window.parent as Window & { valkyrieDesk?: DeskHost }).valkyrieDesk ?? null
  } catch {
    return null
  }
}

/** Tells the Steam Frame app to close the panel this copy is in. */
export function closeXrPanel(): void {
  const bind = (window as { valkyrieXr?: (payload: string) => void }).valkyrieXr
  bind?.(JSON.stringify({ op: 'close' }))
}
