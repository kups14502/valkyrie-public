import { useEffect, useState } from 'react'
import { ChevronDown, Lightbulb, Power } from 'lucide-react'
import { type LightState } from '../lib/api'
import {
  PRESETS, brightnessFromPct, hexToRgb, pctFromBrightness, presetSwatchStyle, rgbToHex,
  useBrightnessThrottle, useSliderSync, type LightPatch,
} from '../lib/lights'

// One light UI for both the Lights page and the iPad pad screen, in two sizes.
//
// The old layout repeated eight labelled preset buttons per bulb, so five lights
// meant forty word-buttons competing with the controls that actually matter.
// Colors are swatches now (the color IS the label), brightness leads, and a bulb
// that's off collapses to a single row.

type Size = 'normal' | 'pad'

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
} as const

// The brightness a finger is currently holding, plus the release that pointer
// events miss. onCommit only fires on pointerup/touchend, so an arrow-key nudge
// or a touch the OS cancels would leave the hold set forever, and the thumb and
// the % readout would stop tracking the bulb for the life of the component.
// Dropping the hold once the light reports the held value covers those.
function usePendingPct(externalPct: number | null) {
  const [pending, setPending] = useState<number | null>(null)
  useEffect(() => {
    if (pending !== null && externalPct === pending) setPending(null)
  }, [externalPct, pending])
  return [pending, setPending] as const
}

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
    <div className="grid grid-cols-5 gap-2 sm:grid-cols-9">
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

function Brightness({ size, pct, syncTo, onDrag, onCommit }: {
  size: Size
  pct: number | null
  syncTo: number | null
  onDrag: (pct: number) => void
  onCommit: (pct: number) => void
}) {
  const ref = useSliderSync(syncTo)
  const s = SZ[size]
  const release = (e: React.SyntheticEvent<HTMLInputElement>) => onCommit(Number(e.currentTarget.value))
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">brightness</span>
        <span className={`${s.pct} font-semibold tabular-nums leading-none text-[var(--color-text)]`}>
          {pct != null ? `${pct}%` : '—'}
        </span>
      </div>
      <input
        ref={ref}
        type="range"
        min={1}
        max={100}
        defaultValue={pct ?? 100}
        onInput={(e) => onDrag(Number(e.currentTarget.value))}
        onPointerUp={release}
        onTouchEnd={release}
        // A touch the OS steals (notification, palm, scroll takeover) fires
        // pointercancel and never pointerup.
        onPointerCancel={release}
        // Arrow keys change the value without any pointer event at all. syncTo
        // is null exactly while a value is held, so this won't fire a redundant
        // write for stray keyups like Tab.
        onKeyUp={(e) => { if (syncTo === null) release(e) }}
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
  const externalPct = pctFromBrightness(light.brightness)
  const [pendingPct, setPendingPct] = usePendingPct(externalPct)
  const displayPct = pendingPct ?? externalPct
  const color = light.rgb_color ? `rgb(${light.rgb_color.join(',')})` : '#ffd9a0'

  const { push, commit } = useBrightnessThrottle(
    (pct) => onUpdate(light.entity_id, { state: 'on', brightness: brightnessFromPct(pct) }),
    150,
  )

  const off = !light.on || light.unavailable
  return (
    <div
      className={`panel ${s.card} transition ${light.on ? 'border-[var(--color-border-strong)]' : ''} ${light.unavailable ? 'opacity-45' : ''}`}
      style={light.on ? { boxShadow: `0 0 24px -8px ${color}` } : undefined}
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
          <div className="min-w-0">
            <div className={`${s.name} truncate leading-tight text-[var(--color-text)]`}>{light.name}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              {light.unavailable ? 'unavailable' : light.on ? `on · ${displayPct}%` : 'off'}
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
        <div className="mt-4 space-y-4">
          <Brightness
            size={size}
            pct={displayPct}
            // null while a drag owns the thumb, so we never fight the finger.
            syncTo={pendingPct === null ? externalPct : null}
            onDrag={(pct) => { setPendingPct(pct); push(pct) }}
            onCommit={(pct) => { commit(pct); setPendingPct(null) }}
          />
          <Swatches
            size={size}
            customHex={rgbToHex(light.rgb_color)}
            onPick={(rgb, kelvin) => onUpdate(light.entity_id, {
              state: 'on',
              ...(rgb ? { rgb_color: rgb } : {}),
              ...(kelvin ? { color_temp_kelvin: kelvin } : {}),
            })}
            onCustom={(rgb) => onUpdate(light.entity_id, { state: 'on', rgb_color: rgb })}
          />
        </div>
      )}
    </div>
  )
}

// The whole-room control. Deliberately the same shape as a single light so the
// page reads as one system rather than two different widgets.
export function AllLightsControl({
  count, anyOn, avgPct, size = 'normal', onToggleAll, onBrightness, onPreset,
}: {
  count: number
  anyOn: boolean
  avgPct: number | null
  size?: Size
  onToggleAll: (state: 'on' | 'off') => void
  onBrightness: (pct: number) => void
  onPreset: (rgb: [number, number, number] | null, kelvin: number | null) => void
}) {
  const s = SZ[size]
  const [pct, setPct] = usePendingPct(avgPct)
  const [hex, setHex] = useState('#ffb87a')
  const { push, commit } = useBrightnessThrottle(onBrightness, 200)
  const shown = pct ?? avgPct

  return (
    <div className={`panel ${s.card}`} style={{ boxShadow: anyOn ? '0 0 24px -10px rgba(var(--color-accent-rgb),0.5)' : undefined }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Lightbulb
            size={size === 'pad' ? 26 : 22}
            className={`shrink-0 ${anyOn ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}
            style={anyOn ? { filter: 'drop-shadow(0 0 6px var(--color-accent))' } : undefined}
          />
          <div className="min-w-0">
            <div className={`${s.name} truncate leading-tight text-[var(--color-text)]`}>every light</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
              {count} bulb{count === 1 ? '' : 's'}{anyOn && shown != null ? ` · ${shown}%` : ''}
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

      <div className="mt-4 space-y-4">
        <Brightness
          size={size}
          pct={shown}
          syncTo={pct === null ? avgPct : null}
          onDrag={(v) => { setPct(v); push(v) }}
          onCommit={(v) => { commit(v); setPct(null) }}
        />
        <Swatches
          size={size}
          customHex={hex}
          onPick={onPreset}
          onCustom={(rgb) => { setHex(rgbToHex(rgb)); onPreset(rgb, null) }}
        />
      </div>
    </div>
  )
}
