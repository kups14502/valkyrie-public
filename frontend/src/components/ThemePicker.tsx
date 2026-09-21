import { useState, useRef, useEffect, useLayoutEffect } from 'react'

const PRESETS = [
  { label: 'Matrix', color: '#00ff41' },
  { label: 'Cyan', color: '#00ffe5' },
  { label: 'Yellow', color: '#ffe500' },
  { label: 'Pink', color: '#ff2d78' },
  { label: 'Blue', color: '#3d9eff' },
  { label: 'Orange', color: '#ff6b1a' },
  { label: 'Violet', color: '#bd00ff' },
  { label: 'Amber', color: '#ff9900' },
]

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

const c = (n: number) => Math.min(255, Math.max(0, Math.round(n)))

function updateScrollbarStyle(r: number, g: number, b: number) {
  const id = 'valkyrie-scrollbar-style'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  // Literal colors (not CSS vars) — webkit scrollbars don't repaint on var changes.
  el.textContent = `
    html { scrollbar-color: rgb(${r},${g},${b}) #000000; }
    ::-webkit-scrollbar-track { border-left: 1px solid rgba(${r},${g},${b},0.08); }
    ::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, rgba(${r},${g},${b},0.85), rgba(${r},${g},${b},0.28));
      box-shadow: inset 0 0 0 1px rgba(${r},${g},${b},0.35), 0 0 8px rgba(${r},${g},${b},0.25);
    }
    ::-webkit-scrollbar-thumb:hover { background: rgb(${r},${g},${b}); }
  `
}

export function applyAccent(hex: string) {
  const rgb = hexToRgb(hex)
  if (!rgb) return
  const [r, g, b] = rgb
  const root = document.documentElement
  root.style.setProperty('--color-accent', hex)
  root.style.setProperty('--color-accent-rgb', `${r}, ${g}, ${b}`)
  root.style.setProperty('--color-border', `rgba(${r},${g},${b},0.14)`)
  root.style.setProperty('--color-border-strong', `rgba(${r},${g},${b},0.55)`)
  root.style.setProperty('--color-success', hex)
  root.style.setProperty('--color-text', `rgb(${c(r * 0.18 + 192)},${c(g * 0.18 + 192)},${c(b * 0.18 + 192)})`)
  root.style.setProperty('--color-text-dim', `rgb(${c(r * 0.45 + 90)},${c(g * 0.45 + 90)},${c(b * 0.45 + 90)})`)
  root.style.setProperty('--color-text-faint', `rgb(${c(r * 0.28 + 40)},${c(g * 0.28 + 40)},${c(b * 0.28 + 40)})`)
  updateScrollbarStyle(r, g, b)
  localStorage.setItem('valkyrie-accent', hex)
}

const PANEL_W = 224
const EDGE = 8

export function ThemePicker() {
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState(() => localStorage.getItem('valkyrie-accent') ?? localStorage.getItem('mc-accent') ?? '#00ff41')
  const [draft, setDraft] = useState(hex)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Where the panel sits, measured rather than declared. It used to be
  // right-0, which anchors its RIGHT edge to the button's. That is right in
  // the header, where the button sits near the right of the screen, but the
  // same component also sits a few pixels from the LEFT edge inside the
  // phone's hamburger menu, and there a 224px panel hung off the display.
  const [box, setBox] = useState<{ left: number; width: number } | null>(null)

  useEffect(() => {
    applyAccent(hex)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const btn = btnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const width = Math.min(PANEL_W, vw - EDGE * 2)
      // Start right-aligned to the button, then push back inside whichever
      // edge it crossed. `left` is an offset from the anchor, not a page
      // coordinate.
      let left = r.width - width
      const overLeft = EDGE - (r.left + left)
      if (overLeft > 0) left += overLeft
      const overRight = (r.left + left + width) - (vw - EDGE)
      if (overRight > 0) left -= overRight
      setBox({ left, width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('orientationchange', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('orientationchange', place)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const apply = (color: string) => {
    const normalized = color.startsWith('#') ? color : `#${color}`
    if (hexToRgb(normalized)) {
      setHex(normalized)
      setDraft(normalized)
      applyAccent(normalized)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Theme color"
        className="flex items-center gap-2 border border-[var(--color-border)] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-dim)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      >
        <span
          className="inline-block h-3 w-3 shrink-0"
          style={{ backgroundColor: hex, boxShadow: `0 0 6px ${hex}` }}
        />
        <span className="hidden sm:inline">theme</span>
      </button>

      {open && (
        <div
          className="absolute top-full z-50 mt-2 border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          style={box ? { left: box.left, width: box.width } : { left: 0, visibility: 'hidden' }}
        >
          <div className="mb-3 text-[9px] uppercase tracking-[0.28em] text-[var(--color-text-faint)]">&gt; accent color</div>

          <div className="mb-4 grid grid-cols-4 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.color}
                type="button"
                onClick={() => { apply(p.color); setOpen(false) }}
                title={p.label}
                className="group flex flex-col items-center gap-1"
              >
                <span
                  className="block h-6 w-full transition-transform group-hover:scale-105"
                  style={{
                    backgroundColor: p.color,
                    outline: hex === p.color ? `1px solid ${p.color}` : '1px solid rgba(255,255,255,0.08)',
                    outlineOffset: '1px',
                    boxShadow: hex === p.color ? `0 0 8px ${p.color}` : undefined,
                  }}
                />
                <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--color-text-faint)]">{p.label}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="color"
              value={hex}
              onChange={(e) => apply(e.target.value)}
              className="h-7 w-7 shrink-0 cursor-pointer border border-[var(--color-border)] bg-transparent p-0.5"
              title="Pick color"
            />
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => apply(draft)}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(draft) }}
              placeholder="#00ff41"
              maxLength={7}
              spellCheck={false}
              className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
            />
          </div>
        </div>
      )}
    </div>
  )
}
