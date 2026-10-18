import { useEffect, useState } from 'react'
import { applyAccent } from '../../components/ThemePicker'

// Valkyrie's color schemes. v2 themes the way the classic pages do
// (src/components/ThemePicker.tsx): ONE accent color, picked from the same
// presets (or any hex), stored under the same 'valkyrie-accent' key, with the
// text tones derived from it by Valkyrie's own formulas. Brendon: "we should be
// pulling a lot from valkyrie. including the color scheme and ability to select
// different color schemes".
//
// The whole UI is one color family at a time and a change morphs every color
// (v2.css registers the variables with @property). Canvas code reads
// usePalette(), so it re-renders on change.
//
// `Mode` survives as the name of a scheme (an accent hex, or a legacy name:
// 'white' | 'red' | 'cyan'), so older call sites keep compiling.

export type Mode = string

export type Palette = {
  /** scheme id: a preset id ('matrix', 'cyan'...) or 'custom' */
  mode: string
  /** the accent: lines, lit plates, lit icons, key numbers */
  fg: string
  /** body text: Valkyrie's --color-text, a pale tint of the accent */
  text: string
  dim: string
  faint: string
  /** second highlight (Valkyrie's accent-2 yellow; x-ray internals) */
  hot: string
  /** alert (Valkyrie's danger red; yellow when the accent is red or pink) */
  acc2: string
  /**
   * a loss (Trades: a down day, a down week): never yellow. The alert red where
   * acc2 is red; on red and pink, where acc2 is the yellow, the pale text tone
   * (the down arrow and the minus sign carry the direction)
   */
  loss: string
  /** "r, g, b" for rgba() */
  fgRgb: string
  hotRgb: string
  acc2Rgb: string
  lossRgb: string
  /** ink on a solid lit plate: a near-black accent on bright schemes, a near-white tint on deep ones */
  plateInk: string
  /** relative luminance of the accent, 0..1 (WCAG); bright schemes are > ~0.5 */
  lum: number
}

export type Scheme = { id: string; label: string; accent: string }

/** Valkyrie's own presets, in its order, then two v2 extras. */
export const SCHEMES: Scheme[] = [
  { id: 'matrix', label: 'Matrix', accent: '#00ff41' },
  { id: 'cyan', label: 'Cyan', accent: '#00ffe5' },
  { id: 'yellow', label: 'Yellow', accent: '#ffe500' },
  { id: 'pink', label: 'Pink', accent: '#ff2d78' },
  { id: 'blue', label: 'Blue', accent: '#3d9eff' },
  { id: 'orange', label: 'Orange', accent: '#ff6b1a' },
  { id: 'violet', label: 'Violet', accent: '#bd00ff' },
  { id: 'amber', label: 'Amber', accent: '#ff9900' },
  { id: 'red', label: 'Red', accent: '#ff2a1a' },
  { id: 'white', label: 'White', accent: '#f4f4f4' },
]

export const DEFAULT_ACCENT = '#00ffe5'

const LEGACY: Record<string, string> = { white: '#f4f4f4', red: '#ff2a1a', cyan: '#00ffe5' }

const parseHex = (hex: string): [number, number, number] | null => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

/** A scheme name or hex to a normalized '#rrggbb' accent (falls back to the default). */
export function accentOf(mode: string): string {
  const legacy = LEGACY[mode]
  if (legacy) return legacy
  const preset = SCHEMES.find((s) => s.id === mode)
  if (preset) return preset.accent
  const rgb = parseHex(mode)
  return rgb ? `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}` : DEFAULT_ACCENT
}

const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)))
const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`
const rgbStr = (hex: string) => (parseHex(hex) ?? [0, 0, 0]).join(', ')

const hue = ([r, g, b]: [number, number, number]): number => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max === min) return -1
  const d = max - min
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

/** The full palette for an accent, by Valkyrie's applyAccent formulas. */
export function paletteFor(mode: string): Palette {
  const accent = accentOf(mode)
  const [r, g, b] = parseHex(accent) ?? [0, 255, 229]
  const h = hue([r, g, b])
  const grey = h < 0
  // hot is Valkyrie's accent-2 yellow, except where it would sit on top of the
  // accent: yellow and amber get white, red and pink get amber (their alert is the yellow)
  const yellowish = !grey && h >= 29 && h <= 79
  const reddish = !grey && (h >= 330 || h <= 15)
  const hot = yellowish ? '#f4f4f4' : grey ? '#f0b44a' : reddish ? '#ff9a1f' : '#ffe500'
  const acc2 = reddish ? '#ffe500' : '#ff1744'
  const id = SCHEMES.find((s) => s.accent === accent)?.id ?? 'custom'
  const look = lookFor(accent)
  // Valkyrie's text tones. A deep accent (Violet, Pink, Red) makes its dim and
  // faint too dark to read on black, so those two get a luminance floor: they
  // slide toward the pale text tone just far enough (bright schemes are untouched).
  const text: [number, number, number] = [r * 0.18 + 192, g * 0.18 + 192, b * 0.18 + 192]
  const dim = atLeast([r * 0.45 + 90, g * 0.45 + 90, b * 0.45 + 90], text, 0.24)
  const faint = atLeast([r * 0.28 + 40, g * 0.28 + 40, b * 0.28 + 40], text, 0.1)
  // Brendon does not want yellow on Trades: a loss there is never acc2's yellow
  const loss = reddish ? toHex(...text) : acc2
  return {
    mode: id,
    fg: accent,
    text: toHex(...text),
    dim: toHex(...dim),
    faint: toHex(...faint),
    hot,
    acc2,
    loss,
    fgRgb: `${r}, ${g}, ${b}`,
    hotRgb: rgbStr(hot),
    acc2Rgb: rgbStr(acc2),
    lossRgb: rgbStr(loss),
    plateInk: look.plateInk,
    lum: look.lum,
  }
}

// ---------- the look per scheme, keyed by the accent's luminance (never by name) ----------

const lin = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const mixHex = ([r, g, b]: [number, number, number], [r2, g2, b2]: [number, number, number], t: number) =>
  toHex(r + (r2 - r) * t, g + (g2 - g) * t, b + (b2 - b) * t)
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** `c`, moved toward `to` only as far as it takes to reach luminance `min`. */
function atLeast(c: [number, number, number], to: [number, number, number], min: number): [number, number, number] {
  const at = (t: number): [number, number, number] => [c[0] + (to[0] - c[0]) * t, c[1] + (to[1] - c[1]) * t, c[2] + (to[2] - c[2]) * t]
  const lum = (v: [number, number, number]) => luminance(v.map((n) => clamp(n)) as [number, number, number])
  if (lum(c) >= min) return c
  let lo = 0, hi = 1
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2
    if (lum(at(mid)) >= min) hi = mid
    else lo = mid
  }
  return at(hi)
}

/**
 * How lines, fills, plates and glow are dosed for one accent. A bright accent
 * (Cyan, Matrix, Yellow, White) already reads at low alpha and blooms into a
 * haze when glowed hard; a deep one (Violet, Red, Pink) needs stronger lines
 * and fills to read at all. So every number here slides with luminance.
 */
export type Look = {
  /** relative luminance of the accent */
  lum: number
  /** 0 for a bright accent, 1 for a deep one */
  depth: number
  /** lit plate fill strength, percent of the accent over black */
  plate: number
  /** ink on the lit plate */
  plateInk: string
  /** true when the plate is light enough to take dark ink */
  darkInk: boolean
  /** text-shadow under plate ink */
  plateShadow: string
  /** white lifted into a lit plate's edge, percent */
  edgeW: number
  /** the ink of a reading (panel values, stats): the accent, lifted toward white on deep schemes */
  inkHi: string
  /** hairline, panel outline, panel fill top and bottom, percent of the accent */
  lineA: number
  panelA: number
  fillA: number
  fillB: number
  /** glow strength multiplier (1 = full) */
  glowK: number
}

export function lookFor(mode: string): Look {
  const accent = accentOf(mode)
  const rgb = parseHex(accent) ?? [0, 255, 229]
  const lum = luminance(rgb)
  const depth = clamp01((0.75 - lum) / 0.55)
  const grey = hue(rgb) < 0
  // the plate is the accent at ~82% over black: pick whichever ink has more
  // contrast against that fill (the crossover is a fill luminance near 0.2)
  const fillLum = luminance([rgb[0] * 0.82, rgb[1] * 0.82, rgb[2] * 0.82])
  const darkInk = fillLum > 0.2
  return {
    lum,
    depth,
    plate: darkInk ? 82 : 84,
    plateInk: darkInk ? mixHex(rgb, [0, 0, 0], 0.88) : mixHex(rgb, [255, 255, 255], 0.9),
    darkInk,
    plateShadow: darkInk ? 'none' : '0 0 5px rgba(0, 0, 0, .45)',
    edgeW: Math.round(10 + 20 * depth),
    inkHi: mixHex(rgb, [255, 255, 255], Math.min(0.4, Math.max(0, (0.5 - lum) * 0.9))),
    lineA: Math.round(20 + 10 * depth),
    panelA: Math.round(34 + 28 * depth),
    fillA: Math.round((7 + 7 * depth) * 10) / 10,
    fillB: Math.round((2 + 3 * depth) * 10) / 10,
    glowK: grey ? 0.55 : Math.round((0.7 + 0.3 * depth) * 100) / 100,
  }
}

/** Legacy lookups ('white' | 'red' | 'cyan') and every preset by id. */
export const PALETTES: Record<string, Palette> = Object.fromEntries([
  ...Object.keys(LEGACY).map((k) => [k, paletteFor(k)]),
  ...SCHEMES.map((s) => [s.id, paletteFor(s.accent)]),
])

// Valkyrie's own key, so v2 and the classic pages share one pick ('mc-accent'
// is the classic pages' older key, read as a fallback the way they read it).
const KEY = 'valkyrie-accent'
const LEGACY_KEY = 'mc-accent'
const EVENT = 'v2-mode-changed'
const STORED = 'v2-mode-stored'

/** The scheme the user picked (an accent hex), Valkyrie's default cyan when none. */
export function storedMode(): Mode {
  try {
    const v = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (v && parseHex(v)) return accentOf(v)
  } catch { /* storage unavailable */ }
  return DEFAULT_ACCENT
}

let shown: Mode = typeof window === 'undefined' ? DEFAULT_ACCENT : storedMode()

/** Paint a scheme into the CSS variables without changing the stored choice. */
export function applyPalette(mode: Mode): void {
  const p = paletteFor(mode)
  const k = lookFor(p.fg)
  shown = p.fg
  const root = document.documentElement
  const s = root.style
  s.setProperty('--fg', p.fg)
  s.setProperty('--text', p.text)
  s.setProperty('--dim', p.dim)
  s.setProperty('--faint', p.faint)
  s.setProperty('--hot', p.hot)
  s.setProperty('--acc2', p.acc2)
  s.setProperty('--loss', p.loss)
  s.setProperty('--fg-rgb', p.fgRgb)
  s.setProperty('--hot-rgb', p.hotRgb)
  s.setProperty('--acc2-rgb', p.acc2Rgb)
  s.setProperty('--loss-rgb', p.lossRgb)
  // the look, dosed by luminance (v2.css registers these so they morph too)
  s.setProperty('--plate', `${k.plate}%`)
  s.setProperty('--plate-ink', k.plateInk)
  s.setProperty('--plate-shadow', k.plateShadow)
  s.setProperty('--edge-w', `${k.edgeW}%`)
  s.setProperty('--ink-hi', k.inkHi)
  s.setProperty('--line-a', `${k.lineA}%`)
  s.setProperty('--panel-a', `${k.panelA}%`)
  s.setProperty('--fill-a', `${k.fillA}%`)
  s.setProperty('--fill-b', `${k.fillB}%`)
  s.setProperty('--glow-k', String(k.glowK))
  // The classic pages' --color-* variables are left alone: saveMode hands a new
  // pick to their own applyAccent, so they keep their formulas.
  root.dataset.mode = p.mode
  // 'bright' plates take dark ink, 'deep' ones light ink: for the few rules that must differ
  root.dataset.lum = k.darkInk ? 'bright' : 'deep'
  window.dispatchEvent(new Event(EVENT))
}

/** Store the pick without painting it (the shell paints it). The classic pages follow it at once. */
export function saveMode(m: Mode): void {
  try { applyAccent(accentOf(m)) } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(STORED))
}

export function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setModeState] = useState<Mode>(() => storedMode())
  useEffect(() => {
    const sync = () => setModeState(storedMode())
    window.addEventListener('storage', sync)
    window.addEventListener(STORED, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(STORED, sync)
    }
  }, [])
  const setMode = (m: Mode) => {
    saveMode(m)
    setModeState(accentOf(m))
    applyPalette(m)
  }
  return [mode, setMode]
}

/** Same as useMode, named for what it is now: [accent hex, set accent]. */
export const useAccent = useMode

/** The stored pick, kept in sync across hooks in this tab and other tabs. */
export function useStoredMode(): Mode {
  const [mode, setModeState] = useState<Mode>(() => storedMode())
  useEffect(() => {
    const sync = () => setModeState(storedMode())
    window.addEventListener('storage', sync)
    window.addEventListener(STORED, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(STORED, sync)
    }
  }, [])
  return mode
}

/** The scheme on screen right now (accent hex). */
export function shownMode(): Mode {
  return shown
}

const SETTING = 'v2-setting-changed'

/** A small persisted v2 setting ('v2.<key>'), synced between hooks. */
export function useSetting<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const read = (): T => {
    try {
      const v = localStorage.getItem('v2.' + key)
      if (v !== null && (!allowed || (allowed as readonly string[]).includes(v))) return v as T
    } catch { /* storage unavailable */ }
    return initial
  }
  const [value, setValue] = useState<T>(read)
  useEffect(() => {
    const sync = (e: Event) => {
      if (e instanceof CustomEvent && e.detail !== key) return
      setValue(read())
    }
    window.addEventListener(SETTING, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(SETTING, sync)
      window.removeEventListener('storage', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const set = (v: T) => {
    try { localStorage.setItem('v2.' + key, v) } catch { /* storage unavailable */ }
    setValue(v)
    window.dispatchEvent(new CustomEvent(SETTING, { detail: key }))
  }
  return [value, set]
}

// ---------- font (Home > Settings > Font) ----------

export type FontSetting = 'mono' | 'sans'
export const FONTS: readonly FontSetting[] = ['mono', 'sans']

/** The stored font pick, read before React (main.tsx paints it on <html> before the first frame). */
export function storedFont(): FontSetting {
  try {
    const v = localStorage.getItem('v2.font')
    if (v === 'mono' || v === 'sans') return v
  } catch { /* storage unavailable */ }
  return 'mono'
}

/** Put a font pick on <html data-font>; v2.css switches --font on it. */
export function applyFont(f: FontSetting): void {
  document.documentElement.dataset.font = f
}

/**
 * The font setting: 'mono' (JetBrains Mono, Valkyrie's font, the default) or
 * 'sans' (Inter Tight). Applies itself to <html>, so any screen can offer the
 * switch and the shell keeps it in sync.
 */
export function useFont(): [FontSetting, (f: FontSetting) => void] {
  const [font, setFont] = useSetting<FontSetting>('font', 'mono', FONTS)
  useEffect(() => { applyFont(font) }, [font])
  return [font, setFont]
}

/** The palette currently on screen. */
export function usePalette(): Palette {
  const [mode, setMode] = useState<Mode>(shown)
  useEffect(() => {
    const sync = () => setMode(shown)
    window.addEventListener(EVENT, sync)
    sync()
    return () => window.removeEventListener(EVENT, sync)
  }, [])
  return paletteFor(mode)
}
