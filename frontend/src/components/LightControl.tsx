import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Lightbulb, Power } from 'lucide-react'
import { type LightState } from '../lib/api'
import {
  PRESETS, brightnessFromPct, hexToRgb, lightColor, pctFromBrightness, presetSwatchStyle,
  rgbToHex, useSliderSync, type LightPatch,
} from '../lib/lights'

// One light UI for the Lights page, the iPad pad screen and the desktop
// dashboard, in three sizes. Dense is the dashboard's: a flat row with a thin
// divider instead of a card, so a tile holds the whole room.
//
// The old layout repeated eight labelled preset buttons per bulb, so five lights
// meant forty word-buttons competing with the controls that actually matter.
// Colors are swatches now (the color IS the label), brightness leads, and a bulb
// that's off collapses to a single row.

type Size = 'normal' | 'pad' | 'dense'

const SZ = {
  normal: {
    card: 'p-4',
    name: 'text-base',
    pct: 'text-xl',
    toggle: 'min-h-11 px-5 text-xs',
    swatch: 'min-h-11',
    swatchIcon: 14,
    dot: 'h-7 w-7',
  },
  pad: {
    card: 'p-5',
    name: 'text-lg',
    pct: 'text-2xl',
    toggle: 'min-h-14 px-6 text-sm',
    swatch: 'min-h-14',
    swatchIcon: 16,
    dot: 'h-9 w-9',
  },
  dense: {
    card: 'border-b border-[var(--color-border)]/50 py-2 first:pt-0 last:border-b-0',
    name: 'text-sm',
    pct: 'text-sm',
    toggle: 'min-h-7 px-2.5 text-[10px]',
    swatch: 'min-h-6',
    swatchIcon: 12,
    dot: 'h-3 w-3',
  },
} as const

// A card on the Lights page and the pad, a flat row on the dashboard.
const shell = (size: Size) => (size === 'dense' ? SZ.dense.card : `panel ${SZ[size].card}`)
const body = (size: Size) => (size === 'dense' ? 'mt-2 space-y-2' : 'mt-4 space-y-4')
// Dense puts the state beside the name, so each row is one line. In a narrow
// column the state truncates first: the name shrinks ten times slower.
const nameBlock = (size: Size) => (size === 'dense' ? 'flex min-w-0 items-baseline gap-2' : 'min-w-0')
const nameShrink = (size: Size) => (size === 'dense' ? 'shrink-[0.1]' : '')
const stateLine = (size: Size) => (size === 'dense' ? 'min-w-0 truncate' : 'mt-0.5')

// Eight presets plus a custom picker. A responsive grid rather than fixed
// widths, so the swatches stay tappable at 390px and never wrap raggedly.
function Swatches({ size, customHex, onPick, onCustom }: {
  size: Size
  customHex: string
  onPick: (rgb: [number, number, number] | null, kelvin: number | null) => void
  onCustom: (rgb: [number, number, number]) => void
}) {
  const s = SZ[size]
  return (
    <div className={size === 'dense' ? 'grid grid-cols-9 gap-1.5' : 'grid grid-cols-5 gap-2 sm:grid-cols-9'}>
      {PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p.rgb, p.kelvin)}
          title={p.label}
          aria-label={p.label}
          className={`${s.swatch} border border-[var(--color-border)] transition active:border-[var(--color-accent)] active:scale-95`}
          style={{ backgroundColor: presetSwatchStyle(p) }}
        />
      ))}
      <label
        title="Custom color"
        className={`${s.swatch} relative flex cursor-pointer items-center justify-center border border-[var(--color-border-strong)] active:border-[var(--color-accent)]`}
        style={{ backgroundColor: customHex }}
      >
        <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-black/70 mix-blend-luminosity">+</span>
        <input
          type="color"
          value={customHex}
          onChange={(e) => { const rgb = hexToRgb(e.target.value); if (rgb) onCustom(rgb) }}
          className="sr-only"
          aria-label="Custom color"
        />
      </label>
    </div>
  )
}

// The slider commits ONCE, on release.
//
// It used to send a throttled command every 150-200ms while the finger moved,
// so one drag of the whole-room slider fired six or seven separate five-bulb
// commands at a cloud integration that answers slowly and drops commands. The
// bulbs spent the next several seconds working through values the user had
// already dragged past. Nothing about that was visible as feedback, because the
// percentage readout is local: it tracks the finger either way.
//
// The held value owns the thumb from the moment a drag starts until the light
// reports that value back. useSliderSync cannot write while it is held, and the
// committed value comes from a ref fed by onInput rather than being read back
// off the DOM at release, so a background sync can never be mistaken for what
// the user chose. Holding it past the release matters too: dropping it there
// exposed the thumb to the pre-command value for the frame before the write
// landed, which read as a flick backward.
const HOLD_CEILING_MS = 4_000

function Brightness({ size, pct, onCommit }: {
  size: Size
  pct: number | null
  onCommit: (pct: number) => void
}) {
  const [held, setHeld] = useState<number | null>(null)
  const dragging = useRef(false)
  const value = useRef(pct ?? 100)
  const ceiling = useRef<number | null>(null)
  const ref = useSliderSync(pct, held !== null)
  const s = SZ[size]
  const shown = held ?? pct

  const clearCeiling = () => {
    if (ceiling.current !== null) { clearTimeout(ceiling.current); ceiling.current = null }
  }
  useEffect(() => clearCeiling, [])

  // The light agreed: stop holding and let it drive the thumb again.
  useEffect(() => {
    if (dragging.current || held === null || pct !== held) return
    clearCeiling()
    setHeld(null)
  }, [pct, held])

  const begin = (v: number) => {
    clearCeiling()
    dragging.current = true
    value.current = v
    setHeld(v)
  }

  // A bulb that never reports the value it was given must not freeze the thumb.
  const commit = () => {
    clearCeiling()
    ceiling.current = window.setTimeout(() => { ceiling.current = null; setHeld(null) }, HOLD_CEILING_MS)
    onCommit(value.current)
  }

  const release = () => {
    if (!dragging.current) return
    dragging.current = false
    commit()
  }

  return (
    <div>
      <div className={`${size === 'dense' ? 'mb-1' : 'mb-2'} flex items-baseline justify-between`}>
        <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">brightness</span>
        <span className={`${s.pct} font-semibold tabular-nums leading-none text-[var(--color-text)]`}>
          {shown != null ? `${shown}%` : '—'}
        </span>
      </div>
      <input
        ref={ref}
        type="range"
        min={1}
        max={100}
        defaultValue={pct ?? 100}
        // Pointer events cover mouse, pen and touch. Binding touchend as well
        // made every release on the iPad commit twice.
        onPointerDown={(e) => begin(Number(e.currentTarget.value))}
        onInput={(e) => {
          const v = Number(e.currentTarget.value)
          value.current = v
          setHeld(v)
        }}
        onPointerUp={release}
        // A touch the OS steals (notification, palm, scroll takeover) fires
        // pointercancel and never pointerup.
        onPointerCancel={release}
        onLostPointerCapture={release}
        // Arrow keys change the value with no pointer event at all, so they get
        // their own commit. Guarded on a real held value so a stray Tab keyup
        // cannot fire a write.
        onKeyUp={() => { if (!dragging.current && held !== null) commit() }}
        className="brightness-slider"
      />
    </div>
  )
}

export function LightControl({ light, onUpdate, size = 'normal', compact = false }: {
  light: LightState
  onUpdate: (entity_id: string, update: LightPatch) => void
  size?: Size
  // compact: brightness and colors hide behind a per-light toggle so every bulb
  // fits on one screen. Used on the iPad, where five expanded cards don't.
  compact?: boolean
}) {
  const s = SZ[size]
  const [open, setOpen] = useState(!compact)
  const pct = pctFromBrightness(light.brightness)
  const color = lightColor(light)

  // Every color change carries the brightness the bulb is already at. Sent
  // without one, a Cync bulb switching color mode picks its own, which is how
  // tapping Neutral threw away a brightness that had just been set.
  const pickColor = (rgb: [number, number, number] | null, kelvin: number | null) => {
    onUpdate(light.entity_id, {
      state: 'on',
      ...(light.brightness != null ? { brightness: light.brightness } : {}),
      ...(rgb ? { rgb_color: rgb } : {}),
      ...(kelvin && !rgb ? { color_temp_kelvin: kelvin } : {}),
    })
  }

  const off = !light.on || light.unavailable
  return (
    <div
      className={`${shell(size)} transition ${light.on && size !== 'dense' ? 'border-[var(--color-border-strong)]' : ''} ${light.unavailable ? 'opacity-45' : ''}`}
      style={light.on && size !== 'dense' ? { boxShadow: `0 0 24px -8px ${color}` } : undefined}
    >
      <div className="flex items-center justify-between gap-3">
        {/* When compact, the whole name block is the expand target — a much
            bigger touch area than a chevron on its own. */}
        <button
          type="button"
          onClick={compact ? () => setOpen((v) => !v) : undefined}
          disabled={!compact}
          aria-expanded={compact ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        >
          {/* The swatch is the status light: it carries the bulb's real color. */}
          <span
            className={`${s.dot} shrink-0 border border-[var(--color-border-strong)]`}
            style={{
              backgroundColor: light.on ? color : 'transparent',
              boxShadow: light.on ? `0 0 12px ${color}` : undefined,
            }}
            aria-hidden
          />
          <div className={nameBlock(size)}>
            <div className={`${s.name} ${nameShrink(size)} min-w-0 truncate leading-tight text-[var(--color-text)]`}>{light.name}</div>
            <div className={`${stateLine(size)} text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]`}>
              {light.unavailable ? 'unavailable' : light.on ? `on${pct != null ? ` · ${pct}%` : ''}` : 'off'}
            </div>
          </div>
          {compact && !light.unavailable && (
            <ChevronDown
              size={16}
              className={`shrink-0 text-[var(--color-text-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
          )}
        </button>
        <button
          type="button"
          disabled={light.unavailable}
          onClick={() => onUpdate(light.entity_id, { state: light.on ? 'off' : 'on' })}
          aria-label={light.on ? `Turn ${light.name} off` : `Turn ${light.name} on`}
          className={`${s.toggle} flex shrink-0 items-center gap-2 border font-semibold uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] disabled:opacity-40 ${
            light.on
              ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.1)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
          }`}
        >
          <Power size={s.swatchIcon} />
          {light.on ? 'on' : 'off'}
        </button>
      </div>

      {!off && open && (
        <div className={body(size)}>
          <Brightness
            size={size}
            pct={pct}
            onCommit={(v) => onUpdate(light.entity_id, { state: 'on', brightness: brightnessFromPct(v) })}
          />
          <Swatches
            size={size}
            customHex={rgbToHex(light.rgb_color)}
            onPick={pickColor}
            onCustom={(rgb) => pickColor(rgb, null)}
          />
        </div>
      )}
    </div>
  )
}

// The whole-room control. Deliberately the same shape as a single light so the
// page reads as one system rather than two different widgets.
export function AllLightsControl({
  count, litCount, anyOn, pct, size = 'normal', onToggleAll, onBrightness, onPreset,
}: {
  count: number
  litCount: number
  anyOn: boolean
  pct: number | null
  size?: Size
  onToggleAll: (state: 'on' | 'off') => void
  onBrightness: (pct: number) => void
  onPreset: (rgb: [number, number, number] | null, kelvin: number | null) => void
}) {
  const s = SZ[size]
  const [hex, setHex] = useState('#ffb87a')

  return (
    <div className={shell(size)} style={{ boxShadow: anyOn && size !== 'dense' ? '0 0 24px -10px rgba(var(--color-accent-rgb),0.5)' : undefined }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Lightbulb
            size={size === 'pad' ? 26 : size === 'dense' ? 16 : 22}
            className={`shrink-0 ${anyOn ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}
            style={anyOn ? { filter: 'drop-shadow(0 0 6px var(--color-accent))' } : undefined}
          />
          <div className={nameBlock(size)}>
            <div className={`${s.name} ${nameShrink(size)} min-w-0 truncate leading-tight text-[var(--color-text)]`}>every light</div>
            <div className={`${stateLine(size)} text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]`}>
              {count} bulb{count === 1 ? '' : 's'}{anyOn && pct != null ? ` · ${pct}%` : ''}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onToggleAll(anyOn ? 'off' : 'on')}
          className={`${s.toggle} flex shrink-0 items-center gap-2 border font-semibold uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] ${
            anyOn
              ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.1)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)]'
          }`}
        >
          <Power size={s.swatchIcon} />
          all {anyOn ? 'off' : 'on'}
        </button>
      </div>

      {/* Brightness and color apply to the bulbs that are on, so with the room
          dark there is nothing here to drive. Showing the controls anyway made
          a preset tap turn the whole room back on. */}
      {litCount > 0 ? (
        <div className={body(size)}>
          <Brightness size={size} pct={pct} onCommit={onBrightness} />
          <Swatches
            size={size}
            customHex={hex}
            onPick={onPreset}
            onCustom={(rgb) => { setHex(rgbToHex(rgb)); onPreset(rgb, null) }}
          />
        </div>
      ) : (
        <div className={`${size === 'dense' ? 'mt-1' : 'mt-4'} text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]`}>
          all off · turn a light on to set brightness or color
        </div>
      )}
    </div>
  )
}
