import { api } from './api'
import { getToken } from './auth'

// What every screen onto a tmux session shares: the phone terminal
// (pages/Terminal.tsx) and the VR workspace (pages/Vr.tsx) both attach to
// /ws/terminal and both paint with the app theme. Kept out of either page so
// the lazy chunks stay separate and the two can never drift on the socket URL.

export const TERM_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

// Mirrors SESSION_NAME_RE in backend/src/terminal/tmux.ts.
export const TERM_NAME_RE = /^vk-[0-9a-f]{10}$/

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
