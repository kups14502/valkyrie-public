import type { Terminal as XTerm } from '@xterm/xterm'
import { PROJECT_BACK_RE, api } from './api'
import { getToken } from './auth'
import { copyText } from './clipboard'

// What every screen onto a tmux session shares: the phone terminal
// (pages/Terminal.tsx) and the VR workspace (pages/Vr.tsx) both attach to
// /ws/terminal and both paint with the app theme. Kept out of either page so
// the lazy chunks stay separate and the two can never drift on the socket URL.

export const TERM_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

// Mirrors SESSION_NAME_RE in backend/src/terminal/tmux.ts.
export const TERM_NAME_RE = /^vk-[0-9a-f]{10}$/

// The v2 terminal (v2/screens/Term.tsx) for one session. A project's path
// rides along as ?back=, as it does on the classic page.
export function v2TermPath(name: string, back?: string | null): string {
  const p = `/m/ai/term/${encodeURIComponent(name)}`
  return back && PROJECT_BACK_RE.test(back) ? `${p}?back=${encodeURIComponent(back)}` : p
}

// THE UI ZOOM AND XTERM DISAGREE ABOUT WHAT A PIXEL IS.
//
// Ctrl +/- sets a CSS `zoom` on <html> (lib/zoom.ts). Zoom scales painting, but
// xterm 6 measures its cell with OffscreenCanvas.measureText, which knows
// nothing about it, and then maps the pointer with getBoundingClientRect, which
// does. Dividing a zoomed offset by an unzoomed cell height lands a click z
// times too far down the grid, and the error grows with distance from the top:
// measured at zoom 1.3, a drag on row 4 selected row 5, row 12 selected 16, and
// row 20 selected 26. On the laptop that is "the line I am highlighting is five
// lines below my cursor".
//
// So a terminal cancels the zoom for its own subtree and pays it back in the
// font size: net scale 1 inside, glyphs still the size the zoom asked for, and
// xterm's two coordinate spaces are the same one again. Proven at 1.0, 1.3 and
// 1.5 before shipping.
export const readUiZoom = (): number => {
  if (typeof document === 'undefined') return 1
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(v) && v >= 0.5 && v <= 3 ? v : 1
}

// Empty string rather than '1', so nothing is left on the style attribute at
// the default zoom. `zoom` is not in the typed CSSStyleDeclaration but is
// honored by both webviews Tauri uses, which is the same bet lib/zoom.ts makes.
export const setTermZoom = (host: HTMLElement | null, zoom: number): void => {
  if (!host) return
  ;(host.style as unknown as Record<string, string>).zoom = zoom === 1 ? '' : String(1 / zoom)
}

// The app token rides the query string because a browser cannot set headers on
// a websocket handshake. It is the same trade the existing upgrade path makes;
// on the tailnet no token is sent at all, since the backend trusts the socket.
export function termWsUrl(name: string, cols: number, rows: number): string {
  const base = api.defaults.baseURL || '/api'
  const abs = base.startsWith('http') ? base : `${window.location.origin}${base}`
  const u = new URL(abs)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws/terminal'
  u.search = ''
  u.searchParams.set('s', name)
  u.searchParams.set('cols', String(cols))
  u.searchParams.set('rows', String(rows))
  const token = getToken()
  if (token) u.searchParams.set('token', token)
  return u.toString()
}

export function readTermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d
  const accent = v('--color-accent', '#00ff41')
  const bg = v('--color-bg', '#000000')
  const fg = v('--color-text', '#b8ffca')
  const warn = v('--color-accent-2', '#ffe500')
  const danger = v('--color-danger', '#ff1744')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: 'rgba(255,255,255,0.22)',
    black: bg,
    brightBlack: v('--color-text-faint', '#4a8055'),
    green: accent,
    brightGreen: accent,
    yellow: warn,
    brightYellow: warn,
    red: danger,
    brightRed: danger,
    white: fg,
    brightWhite: '#ffffff',
  }
}

// Ctrl is a modifier no soft keyboard offers, so a key bar arms it and the
// next real keystroke gets folded down into its control code.
export function toCtrl(d: string): string {
  if (d.length !== 1) return d
  const c = d.toLowerCase()
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96)
  if (d === '[') return '\x1b'
  if (d === ' ') return '\x00'
  return d
}

export const relative = (ms: number) => {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

// The board reports ISO strings; the tmux list reports epoch ms.
export const relIso = (iso: string | null) => {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isFinite(t) ? relative(t) : ''
}

export const errText = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error
  || (e as Error)?.message
  || 'failed'

// THE MOUSE BELONGS TO THE BROWSER, NOT TO TMUX OR CLAUDE.
//
// tmux's conf has `mouse on`, so it asks every attached terminal for mouse
// reports, and a fullscreen Claude (Remote-Session.ps1, 2026-10-12) asks tmux
// for them too. A drag then went to Claude, which ignores it because clicks
// are off, and nothing was ever selected. Before that it went to tmux's
// copy-mode, whose copy never reached the clipboard either. Refusing the
// request keeps xterm's own selection, and Ctrl+C copies it the way Windows
// Terminal does: with a selection it copies, without one it is still Ctrl+C.
// Only for a mouse: on a phone a tap stays a tap.
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016])

export function keepNativeSelection(term: XTerm): () => void {
  const csi = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) =>
    params.length > 0 && params.every((p) => typeof p === 'number' && MOUSE_MODES.has(p)))
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true
    if (e.key.toLowerCase() !== 'c' || !term.hasSelection()) return true
    void copyText(term.getSelection())
    term.clearSelection()
    e.preventDefault()
    return false
  })
  return () => csi.dispose()
}

// One scroll line per this many pixels of wheel travel.
const WHEEL_LINE_PX = 40

// The wheel scrolls through the socket, never xterm: the backend moves tmux's
// copy-mode for an inline session or Claude's own view for a fullscreen one
// (routes/terminal.ts). Captured on the host so xterm never sees the event:
// with mouse reports refused, xterm would turn it into arrow keys, which page
// through the prompt's history instead. Positive lines are older output.
export function wheelScroll(host: HTMLElement, scroll: (lines: number) => void): () => void {
  let acc = 0
  const onWheel = (e: WheelEvent) => {
    e.stopPropagation()
    // A trackpad pinch arrives as a ctrl+wheel. It is a zoom, not a scroll,
    // so the browser keeps it.
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    // Firefox can report a notch in lines (deltaMode 1) rather than pixels.
    const px = e.deltaMode === 1
      ? e.deltaY * WHEEL_LINE_PX
      : e.deltaMode === 2 ? e.deltaY * host.clientHeight : e.deltaY
    acc += px
    const steps = Math.trunc(acc / WHEEL_LINE_PX)
    if (!steps) return
    acc -= steps * WHEEL_LINE_PX
    // Wheel up is a negative deltaY.
    scroll(-steps)
  }
  host.addEventListener('wheel', onWheel, { passive: false, capture: true })
  return () => host.removeEventListener('wheel', onWheel, { capture: true })
}
