import {
  useEffect, useRef, useSyncExternalStore,
  type ButtonHTMLAttributes, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref,
} from 'react'
import { SlotIcon, type IconSlot, type IconTone } from './icons'

// Valkyrie's primitives in the reference's design language: thin-line
// chamfered panels, bar gauges with ticks, glass segmented plates, option rows
// and a layered plate column. Colors come from the CSS variables in v2.css,
// so a mode change morphs everything without a re-render.
//
// Icons (kit/icons.tsx) lead labels: every primitive with a label takes an
// optional `icon` (a name from ICONS or an element). `lit` gives it the glow
// (on, selected, live, asking); without it the icon is dim and flat.

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type Vars = CSSProperties & Record<`--${string}`, string | number>

// ---------- Press ----------

export type PressProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  onPress: () => void
  ref?: Ref<HTMLButtonElement>
}

/**
 * A button that reacts on pointerdown (sets data-pressed in the same frame) and
 * commits on pointerup. Moving more than 10 px cancels, so a swipe that starts
 * on a button never triggers it. Keyboard Enter/Space still work.
 */
export function Press({ onPress, onPointerDown, onClick, className, children, ref, ...rest }: PressProps) {
  const own = useRef<HTMLButtonElement | null>(null)
  const cb = useRef(onPress)
  cb.current = onPress
  const setRef = (el: HTMLButtonElement | null) => {
    own.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLButtonElement | null }).current = el
  }

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e)
    if (rest.disabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = own.current
    if (!el) return
    el.dataset.pressed = ''
    const id = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let done = false
    const end = (commit: boolean) => {
      if (done) return
      done = true
      delete el.dataset.pressed
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (commit) cb.current()
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === id && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) end(false)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const r = el.getBoundingClientRect()
      const inside = ev.clientX >= r.left - 12 && ev.clientX <= r.right + 12 && ev.clientY >= r.top - 12 && ev.clientY <= r.bottom + 12
      end(inside)
    }
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === id) end(false) }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <button
      ref={setRef}
      type="button"
      {...rest}
      className={cx('vl-press', className)}
      onPointerDown={down}
      onClick={(e) => {
        onClick?.(e)
        // detail 0 = keyboard activation; pointer activations committed on pointerup
        if (e.detail === 0 && !rest.disabled) cb.current()
      }}
    >
      {children}
    </button>
  )
}

// ---------- Button and IconButton ----------

export type ButtonProps = PressProps & {
  /** icon leading the text */
  icon?: IconSlot
  /**
   * plate (default): the solid lit plate, one primary action per screen.
   * line: a thin outlined box in the accent (a secondary action that still reads as a control).
   * link: small plain text.
   */
  kind?: 'plate' | 'line' | 'link'
  /** line and link: the thing is on (outline lit, icon glowing) */
  lit?: boolean
}

/** A text button with an optional leading icon. The plate kind is the old `.vl-btn`. */
export function Button({ icon, kind = 'plate', lit, className, children, ...rest }: ButtonProps) {
  const cls = kind === 'plate' ? 'vl-btn' : kind === 'line' ? 'vl-btn-line' : 'vl-link'
  return (
    <Press {...rest} className={cx(cls, className)} data-lit={lit || undefined}>
      {icon !== undefined && <SlotIcon icon={icon} tone={kind === 'plate' ? 'ink' : undefined} lit={kind !== 'plate' && !!lit} size={kind === 'link' ? 13 : 15} />}
      {children}
    </Press>
  )
}

export type IconButtonProps = Omit<PressProps, 'children'> & {
  icon: IconSlot
  /** accessible name (also the tooltip) */
  label: string
  /** the thing is on / live / asking: full color with the glow */
  lit?: boolean
  /** override the tone (e.g. 'acc2' for asking) */
  tone?: IconTone
  /** drawn size, default 18; the target is always at least 44 px */
  size?: number
  /** a tiny count or mark in the corner (e.g. 2 asking) */
  badge?: ReactNode
}

/** An icon-only control: 44 px target around a thin line icon, lit state glows. */
export function IconButton({ icon, label, lit, tone, size = 18, badge, className, ...rest }: IconButtonProps) {
  return (
    <Press {...rest} className={cx('vl-iconbtn', className)} data-lit={lit || undefined} aria-label={label} title={rest.title ?? label}>
      <SlotIcon icon={icon} lit={lit} tone={tone} size={size} />
      {badge !== undefined && badge !== null && badge !== false && <span className="vl-iconbtn-badge">{badge}</span>}
    </Press>
  )
}

// ---------- text ----------

export function Label({ children, className, icon, lit }: { children: ReactNode; className?: string; icon?: IconSlot; lit?: boolean }) {
  if (icon === undefined) return <span className={cx('vl-label', className)}>{children}</span>
  return (
    <span className={cx('vl-label vl-label-icon', className)} data-lit={lit || undefined}>
      <SlotIcon icon={icon} lit={lit} size={12} />
      {children}
    </span>
  )
}

/**
 * Valkyrie's section title (src/components/HomePanels.tsx SectionTitle): accent
 * caps tracked wide with its glow. With an icon the icon leads; without one
 * Valkyrie's "> " prompt does. `action` sits at the right end of the row.
 */
export function Section({ children, icon, lit = true, action, className }: {
  children: ReactNode
  icon?: IconSlot
  /** the icon glows (default); false draws it dim */
  lit?: boolean
  action?: ReactNode
  className?: string
}) {
  const title = (
    <span className={cx('vl-section', action === undefined && className)}>
      {icon !== undefined ? <SlotIcon icon={icon} lit={lit} size={14} /> : <span className="vl-section-prompt" aria-hidden>&gt;</span>}
      <span className="vl-ellipsis">{children}</span>
    </span>
  )
  if (action === undefined) return title
  return (
    <div className={cx('vl-section-row', className)}>
      {title}
      {action}
    </div>
  )
}

// ---------- Panel (thin-line, chamfered) ----------

export type PanelProps = {
  label?: ReactNode
  value?: ReactNode
  unit?: string
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** build-in stagger index: the panel tilts in ~40 ms after panel i-1 */
  i?: number
  dense?: boolean
  /** icon leading the label: a name from ICONS or an element */
  icon?: IconSlot
  /** the panel's thing is on / live / asking: icon in full color with the glow, outline a step brighter */
  lit?: boolean
}

export function Panel({ label, value, unit, children, className, style, i, dense, icon, lit }: PanelProps) {
  const vars: Vars = { ...(style as Vars) }
  if (i !== undefined) vars['--i'] = i
  return (
    <section className={cx('vl-panel', i !== undefined && 'vl-build', className)} data-dense={dense || undefined} data-lit={lit || undefined} style={vars}>
      {(label !== undefined || value !== undefined) && (
        <header className="vl-panel-head">
          {icon !== undefined ? (
            <span className="vl-panel-title">
              <SlotIcon icon={icon} lit={lit} size={dense ? 13 : 14} className="vl-panel-icon" />
              <span className="vl-panel-label">{label}</span>
            </span>
          ) : (
            <span className="vl-panel-label">{label}</span>
          )}
          {value !== undefined && (
            <span className="vl-panel-value">
              {value}
              {unit && <span className="vl-panel-unit">{unit}</span>}
            </span>
          )}
        </header>
      )}
      {children !== undefined && children !== null && <div className="vl-panel-body">{children}</div>}
    </section>
  )
}

// ---------- Bar (ruler gauge) ----------

export function Bar({ value, ticks = 4, tone = 'fg', className }: {
  value: number | null
  ticks?: number
  tone?: 'fg' | 'hot' | 'acc2'
  className?: string
}) {
  const v = value === null || Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, value))
  const vars: Vars = { '--v': v, '--ticks': Math.max(1, ticks) }
  return (
    <div className={cx('vl-bar', className)} data-tone={tone} data-empty={value === null || undefined} style={vars}
      role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <div className="vl-bar-track" />
      <div className="vl-bar-fill" />
      <div className="vl-bar-head"><i /></div>
    </div>
  )
}

// ---------- Segmented (glass plates) ----------

export function Segmented<T extends string>({ options, value, onChange, className }: {
  /** icon: optional, leads the cell's text (ink on the lit plate, dim elsewhere) */
  options: { value: T; label: string; icon?: IconSlot }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  const k = Math.max(0, options.findIndex((o) => o.value === value))
  const vars: Vars = { '--n': options.length, '--k': k }
  return (
    <div className={cx('vl-seg', className)} role="radiogroup" style={vars}>
      <div className="vl-seg-plate" aria-hidden />
      {options.map((o) => {
        const on = o.value === value
        return (
          <Press
            key={o.value}
            role="radio"
            aria-checked={on}
            data-on={on || undefined}
            className={cx('vl-seg-cell', o.icon !== undefined && 'vl-seg-cell-icon')}
            onPress={() => onChange(o.value)}
          >
            {o.icon !== undefined && <SlotIcon icon={o.icon} tone={on ? 'ink' : 'dim'} size={14} />}
            {o.icon !== undefined ? <span className="vl-ellipsis">{o.label}</span> : o.label}
          </Press>
        )
      })}
    </div>
  )
}

// ---------- OptionRow: a label and its choices, the active one boxed ----------

export function OptionRow<T extends string>({ label, options, value, onChange, i, icon, lit }: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  i?: number
  /** icon leading the row label */
  icon?: IconSlot
  lit?: boolean
}) {
  const vars: Vars = {}
  if (i !== undefined) vars['--i'] = i
  return (
    <div className={cx('vl-optrow', i !== undefined && 'vl-build')} style={vars}>
      {icon !== undefined ? (
        <span className="vl-optrow-label vl-optrow-label-icon">
          <SlotIcon icon={icon} lit={lit} size={15} />
          <span className="vl-ellipsis">{label}</span>
        </span>
      ) : (
        <span className="vl-optrow-label">{label}</span>
      )}
      <div className="vl-optrow-opts" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <Press
            key={o.value}
            role="radio"
            aria-checked={o.value === value}
            data-on={o.value === value || undefined}
            className="vl-opt"
            onPress={() => onChange(o.value)}
          >
            {o.label}
          </Press>
        ))}
      </div>
    </div>
  )
}

// ---------- PresetStack: a layered column of plates, the active one lit ----------

export function PresetStack({ items, active, onSelect, className }: {
  /** swatch: optional CSS color shown as a small dot (light presets); detail: optional dim second line; icon: optional, leads the name */
  items: { id: string; label: string; swatch?: string; detail?: ReactNode; icon?: IconSlot }[]
  active: string
  onSelect: (id: string) => void
  className?: string
}) {
  return (
    <div className={cx('vl-presets', className)} role="radiogroup">
      {items.map((it, k) => {
        const on = it.id === active
        const vars: Vars = { '--i': k }
        return (
          <Press
            key={it.id}
            role="radio"
            aria-checked={on}
            data-on={on || undefined}
            className="vl-preset vl-build"
            style={vars}
            onPress={() => onSelect(it.id)}
          >
            <span className="vl-preset-name">
              {it.icon !== undefined && <SlotIcon icon={it.icon} tone={on ? 'ink' : 'dim'} size={14} />}
              {it.swatch && <i className="vl-preset-swatch" style={{ background: it.swatch }} aria-hidden />}
              {it.label}
            </span>
            {it.detail !== undefined && <span className="vl-preset-detail">{it.detail}</span>}
          </Press>
        )
      })}
    </div>
  )
}

// ---------- Stat ----------

export function Stat({ label, value, unit, size = 'md', className, icon, lit }: {
  label: string
  value: ReactNode
  unit?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /** icon leading the label */
  icon?: IconSlot
  lit?: boolean
}) {
  return (
    <div className={cx('vl-stat', className)} data-size={size} data-lit={lit || undefined}>
      {icon !== undefined ? (
        <span className="vl-stat-label vl-stat-label-icon">
          <SlotIcon icon={icon} lit={lit} size={size === 'lg' ? 14 : 12} />
          <span className="vl-ellipsis">{label}</span>
        </span>
      ) : (
        <span className="vl-stat-label">{label}</span>
      )}
      <span className="vl-stat-value">
        {value}
        {unit && <span className="vl-stat-unit">{unit}</span>}
      </span>
    </div>
  )
}

// ---------- Diamond hotspot ----------

/** A diamond hotspot marker centered on (x, y) px in its positioned parent. 44 px hit area. */
export function Diamond({ x, y, label, active, onPress, className }: {
  x: number
  y: number
  label?: string
  active?: boolean
  onPress?: () => void
  className?: string
}) {
  const style: CSSProperties = { transform: `translate3d(${x - 22}px, ${y - 22}px, 0)` }
  const body = (
    <>
      <i className="vl-diamond-mark" />
      {label && <span className="vl-diamond-label">{label}</span>}
    </>
  )
  if (!onPress) {
    return <div className={cx('vl-diamond', className)} data-on={active || undefined} style={style}>{body}</div>
  }
  return (
    <Press className={cx('vl-diamond', className)} data-on={active || undefined} style={style} onPress={onPress} aria-label={label}>
      {body}
    </Press>
  )
}

// ---------- Beam (CSS light cone) ----------

/** A soft light cone pointing right from its left edge. Size and rotate it with className/style. */
export function Beam({ className, style, intensity = 1 }: { className?: string; style?: CSSProperties; intensity?: number }) {
  const vars: Vars = { ...(style as Vars), '--beam': Math.max(0, Math.min(1.5, intensity)) }
  return (
    <div className={cx('vl-beam', className)} style={vars} aria-hidden>
      <div className="vl-beam-cone" />
      <div className="vl-beam-core" />
    </div>
  )
}

// ---------- DotFloor (2D painted perspective dot floor behind screens without a 3D scene) ----------

export type DotFloorHandle = {
  /** camera sideways offset in pages (the shell's pager position): near dots move more than far ones */
  setShift: (pages: number) => void
}

/**
 * Round dots on a ground plane receding to a horizon, fading with distance
 * (f016/f018). Painted on demand only: on resize, on setShift (paging), and for
 * ~0.5 s after a mode change so the color morphs. No idle RAF loop.
 */
export function DotFloor({ className, handle, horizon = 0.42 }: {
  className?: string
  handle?: Ref<DotFloorHandle>
  /** horizon height as a fraction of the canvas height */
  horizon?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const st = useRef({ shift: 0, raf: 0, until: 0, w: 0, h: 0, dpr: 1, color: '244, 244, 244' })

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const s = st.current

    const readColor = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()
      const m = v.match(/rgba?\(([^)]+)\)/)
      if (m) s.color = m[1].split(',').slice(0, 3).map((x) => x.trim()).join(', ')
      else if (/^#[0-9a-f]{6}$/i.test(v)) {
        const n = parseInt(v.slice(1), 16)
        s.color = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
      }
    }

    const draw = () => {
      s.raf = 0
      const { w, h, dpr } = s
      if (!w || !h) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const hy = h * horizon
      const span = h - hy
      const near = Math.max(22, Math.min(34, w / 24)) // px between dots at the bottom edge
      const H = span / near // camera height in grid units
      const f = Math.max(w, h) * 0.62
      const cx = w / 2
      const camX = s.shift * 3
      const zMin = (f * H) / span
      const zMax = Math.sqrt((f * H) / 2.6)
      for (let z = Math.ceil(zMin); z <= zMax; z++) {
        const y = hy + (f * H) / z
        const t = (y - hy) / span // 1 at the bottom, 0 at the horizon
        if (t < 0.025) break
        const a = Math.min(1, t * 1.25) ** 1.5 * 0.5
        if (a < 0.02) continue
        const r = Math.max(0.45, (1.75 * zMin) / z)
        ctx.fillStyle = `rgba(${s.color}, ${a.toFixed(3)})`
        const half = (cx * z) / f + 1
        const x0 = Math.floor(camX - half)
        const x1 = Math.ceil(camX + half)
        if (r > 0.8) {
          ctx.beginPath()
          for (let x = x0; x <= x1; x++) {
            const px = cx + (f * (x - camX)) / z
            ctx.moveTo(px + r, y)
            ctx.arc(px, y, r, 0, Math.PI * 2)
          }
          ctx.fill()
        } else {
          const d = r * 2
          for (let x = x0; x <= x1; x++) ctx.fillRect(cx + (f * (x - camX)) / z - r, y - r, d, d)
        }
      }
      if (performance.now() < s.until) s.raf = requestAnimationFrame(() => { readColor(); draw() })
    }
    const request = () => { if (!s.raf) s.raf = requestAnimationFrame(draw) }

    const resize = () => {
      const r = c.getBoundingClientRect()
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      s.w = r.width
      s.h = r.height
      c.width = Math.round(r.width * s.dpr)
      c.height = Math.round(r.height * s.dpr)
      readColor()
      request()
    }
    const morph = () => {
      s.until = performance.now() + 560
      readColor()
      request()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(c)
    window.addEventListener('v2-mode-changed', morph)
    const api: DotFloorHandle = { setShift: (p) => { s.shift = p; request() } }
    if (typeof handle === 'function') handle(api)
    else if (handle) (handle as { current: DotFloorHandle | null }).current = api
    return () => {
      ro.disconnect()
      window.removeEventListener('v2-mode-changed', morph)
      cancelAnimationFrame(s.raf)
      s.raf = 0
    }
  }, [handle, horizon])

  return <canvas ref={ref} className={cx('vl-floor', className)} aria-hidden />
}

// ---------- Toasts ----------

export type ToastAction = { label: string; run: () => void }
export type ToastOptions = {
  /** one small text button on the toast (Undo); tapping it runs and closes the toast */
  action?: ToastAction
  /** how long it shows: default 2200 ms, 4500 ms with an action */
  ms?: number
}

type ToastItem = { id: number; msg: string; until: number; action?: ToastAction; leaving?: boolean }

let toasts: ToastItem[] = []
let toastSeq = 0
const toastListeners = new Set<() => void>()
const emitToasts = () => toastListeners.forEach((l) => l())
const TOAST_OUT_MS = 180

// expired toasts fade out, then leave the list
function sweepToasts(): void {
  const t = Date.now()
  let changed = false
  toasts = toasts.map((x) => {
    if (x.leaving || x.until > t) return x
    changed = true
    return { ...x, leaving: true }
  })
  if (!changed) return
  emitToasts()
  setTimeout(() => {
    const next = toasts.filter((x) => !x.leaving)
    if (next.length !== toasts.length) {
      toasts = next
      emitToasts()
    }
  }, TOAST_OUT_MS)
}

/**
 * Show a short message under the status strip. Repeats of the same text extend
 * it (and take the newest action). Returns the toast's id for dismissToast.
 */
export function toast(msg: string, opts?: ToastOptions): number {
  const now = Date.now()
  const ms = Math.max(800, opts?.ms ?? (opts?.action ? 4500 : 2200))
  const same = toasts.find((t) => t.msg === msg && !t.leaving)
  let id: number
  if (same) {
    same.until = now + ms
    if (opts?.action) same.action = opts.action
    id = same.id
    toasts = [...toasts]
  } else {
    id = ++toastSeq
    toasts = [...toasts.filter((t) => !t.leaving).slice(-2), { id, msg, until: now + ms, action: opts?.action }]
  }
  emitToasts()
  setTimeout(sweepToasts, ms + 20)
  return id
}

/** Close a toast now (e.g. after its action ran elsewhere). */
export function dismissToast(id: number): void {
  const t = toasts.find((x) => x.id === id)
  if (!t || t.leaving) return
  t.until = 0
  sweepToasts()
}

export function useToast(): typeof toast {
  return toast
}

const subscribeToasts = (l: () => void) => {
  toastListeners.add(l)
  return () => { toastListeners.delete(l) }
}

export function ToastHost({ className, style }: { className?: string; style?: CSSProperties }) {
  const list = useSyncExternalStore(subscribeToasts, () => toasts, () => toasts)
  return (
    <div className={cx('vl-toasts', className)} style={style} aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="vl-toast" data-action={t.action ? '' : undefined} data-leaving={t.leaving || undefined}>
          <span className="vl-toast-msg">{t.msg}</span>
          {t.action && (
            <Press
              className="vl-toast-btn"
              onPress={() => {
                const run = t.action?.run
                dismissToast(t.id)
                run?.()
              }}
            >
              {t.action.label}
            </Press>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------- small glyphs (SVG, currentColor) ----------

export function Glyph({ name, size = 12, className }: {
  name: 'prev' | 'next' | 'pause' | 'play' | 'up' | 'down' | 'left' | 'right' | 'tower' | 'exit' | 'speaker' | 'flag' | 'close'
  size?: number
  className?: string
}) {
  const p = { width: size, height: size, viewBox: '0 0 12 12', className, 'aria-hidden': true as const }
  switch (name) {
    case 'prev': return <svg {...p}><rect x="1.5" y="2" width="1.6" height="8" fill="currentColor" /><path d="M10.5 2v8L3.6 6z" fill="currentColor" /></svg>
    case 'next': return <svg {...p}><rect x="8.9" y="2" width="1.6" height="8" fill="currentColor" /><path d="M1.5 2v8L8.4 6z" fill="currentColor" /></svg>
    case 'pause': return <svg {...p}><rect x="2.5" y="2" width="2.4" height="8" fill="currentColor" /><rect x="7.1" y="2" width="2.4" height="8" fill="currentColor" /></svg>
    case 'play': return <svg {...p}><path d="M3 1.8v8.4L10.2 6z" fill="currentColor" /></svg>
    case 'up': return <svg {...p}><path d="M6 1 10.5 5.6H7.4V11H4.6V5.6H1.5z" fill="currentColor" /></svg>
    case 'down': return <svg {...p}><path d="M6 11 1.5 6.4h3.1V1h2.8v5.4h3.1z" fill="currentColor" /></svg>
    case 'left': return <svg {...p}><path d="M7.6 1.8 3.4 6l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
    case 'right': return <svg {...p}><path d="M4.4 1.8 8.6 6l-4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
    case 'tower': return (
      <svg {...p} viewBox="0 0 12 18">
        <rect x="1.5" y="1" width="9" height="16" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="6" cy="6" r="2.1" fill="none" stroke="currentColor" strokeWidth="0.9" />
        <circle cx="6" cy="11.4" r="2.1" fill="none" stroke="currentColor" strokeWidth="0.9" />
        <rect x="3.6" y="14.6" width="4.8" height="0.9" fill="currentColor" />
      </svg>
    )
    case 'exit': return <svg {...p}><path d="M5 1.5H2v9h3M7.5 3.5 10 6 7.5 8.5M10 6H4.5" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
    case 'speaker': return <svg {...p} viewBox="0 0 16 12"><path d="M1 4h2.6L7 1v10L3.6 8H1z" fill="currentColor" /><path d="M9.3 3.6a3.2 3.2 0 0 1 0 4.8M11.4 2a5.4 5.4 0 0 1 0 8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
    case 'close': return <svg {...p}><path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
    case 'flag': return <svg {...p}><path d="M2.2 11V1.4M2.2 1.6h7.6L8.4 4l1.4 2.4H2.2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
  }
}

// ---------- the command palette's open signal (kit/palette.tsx draws it) ----------

/** The window event that opens the palette (Ctrl+K, the strip's search button). */
export const PALETTE_EVENT = 'v2-palette-open'
/** Set by the palette while it is on screen. */
export const paletteState = { open: false }

/** Open the command palette (kit/palette.tsx), from anywhere in v2. */
export function openPalette(): void {
  window.dispatchEvent(new Event(PALETTE_EVENT))
}

/** True while the palette is on screen: the shell's arrow keys and Escape leave it alone. */
export const paletteOpen = (): boolean => paletteState.open

// ---------- hooks ----------

/** Run `fn` on an interval only while `on` is true. */
export function useInterval(fn: () => void, ms: number, on = true): void {
  const cb = useRef(fn)
  cb.current = fn
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => cb.current(), ms)
    return () => clearInterval(t)
  }, [ms, on])
}
