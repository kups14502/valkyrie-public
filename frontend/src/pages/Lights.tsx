import { memo, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { type LightState } from '../lib/api'
import {
  PRESETS, brightnessFromPct, hexToRgb, pctFromBrightness, presetSwatchStyle, rgbToHex,
  useBrightnessThrottle, useLightsControl, useSliderSync, type LightPatch,
} from '../lib/lights'

function ColorWheel({ value, onPick }: { value: string; onPick: (rgb: [number, number, number]) => void }) {
  return (
    <label className="group flex cursor-pointer items-center gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]">
      <span className="h-3.5 w-3.5 border border-[var(--color-border-strong)] shadow-[0_0_8px_var(--color-accent)]" style={{ backgroundColor: value }} aria-hidden />
      custom
      <input
        type="color"
        value={value}
        onChange={(e) => {
          const rgb = hexToRgb(e.target.value)
          if (rgb) onPick(rgb)
        }}
        className="sr-only"
      />
    </label>
  )
}

const DRAG_THROTTLE_MS = 150

const LightCard = memo(function LightCard({ light, onUpdate }: { light: LightState; onUpdate: (entity_id: string, update: LightPatch) => void }) {
  const [pendingPct, setPendingPct] = useState<number | null>(null)
  const lastExternalPct = pctFromBrightness(light.brightness)
  const displayPct = pendingPct ?? lastExternalPct
  const swatchColor = light.rgb_color ? `rgb(${light.rgb_color.join(',')})` : light.on ? '#ffd9a0' : '#1a1f2b'
  const customHex = rgbToHex(light.rgb_color)

  const inputRef = useSliderSync(pendingPct === null ? lastExternalPct : null)
  const { push: sendBrightness, commit: commitFinal } = useBrightnessThrottle(
    (pct) => onUpdate(light.entity_id, { state: 'on', brightness: brightnessFromPct(pct) }),
    DRAG_THROTTLE_MS,
  )

  useEffect(() => {
    if (pendingPct === null) return
    if (lastExternalPct === pendingPct) setPendingPct(null)
  }, [lastExternalPct, pendingPct])

  return (
    <div className={`panel p-4 transition ${light.on ? 'border-[var(--color-warning)]' : ''} ${light.unavailable ? 'opacity-50' : ''}`} style={light.on ? { boxShadow: '0 0 12px rgba(255,229,0,0.08)' } : {}}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-block h-7 w-7 border border-[var(--color-border-strong)] shadow-[0_0_12px_rgba(255,255,255,0.12)]" style={{ backgroundColor: swatchColor }} aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-[var(--color-text)]">{light.name}</div>
            <div className="text-xs text-[var(--color-text-faint)]">{light.unavailable ? 'unplugged / unavailable' : light.on ? 'on' : 'off'}</div>
          </div>
        </div>
        <button
          type="button"
          disabled={light.unavailable}
          onClick={() => onUpdate(light.entity_id, { state: light.on ? 'off' : 'on' })}
          className={`border px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] transition active:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 ${
            light.on
              ? 'border-[var(--color-warning)] bg-[var(--color-warning)]/10 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/20'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
          }`}
        >
          [{light.on ? 'on' : 'off'}]
        </button>
      </div>

      {light.on && !light.unavailable && (
        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-sm">
              <span className="text-[var(--color-text-dim)]">Brightness</span>
              <span className="font-semibold text-[var(--color-text)]">{displayPct}%</span>
            </div>
            <input
              ref={inputRef}
              type="range"
              min={1}
              max={100}
              defaultValue={lastExternalPct}
              onInput={(e) => {
                const pct = Number((e.target as HTMLInputElement).value)
                setPendingPct(pct)
                sendBrightness(pct)
              }}
              onPointerUp={(e) => commitFinal(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => commitFinal(Number((e.target as HTMLInputElement).value))}
              className="brightness-slider"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onUpdate(light.entity_id, {
                  state: 'on',
                  ...(p.rgb ? { rgb_color: p.rgb } : {}),
                  ...(p.kelvin ? { color_temp_kelvin: p.kelvin } : {}),
                })}
                className="flex items-center gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-xs text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)]/40 hover:text-[var(--color-text)] active:border-[var(--color-accent)]"
              >
                <span className="h-3 w-3 border border-[var(--color-border)]" style={{ backgroundColor: presetSwatchStyle(p) }} aria-hidden />
                {p.label}
              </button>
            ))}
            <ColorWheel value={customHex} onPick={(rgb) => onUpdate(light.entity_id, { state: 'on', rgb_color: rgb })} />
          </div>
        </div>
      )}
    </div>
  )
})

export default function Lights() {
  const {
    lights, mutation, all, anyOn, availableTargets, updateOne, bulk, bulkBrightness, bulkPreset,
  } = useLightsControl()

  const [bulkPct, setBulkPct] = useState<number | null>(null)
  const [bulkCustomHex, setBulkCustomHex] = useState('#ffb87a')

  const bulkDisplayPct = useMemo(() => {
    if (bulkPct !== null) return bulkPct
    const onLights = all.filter((l) => !l.unavailable && l.on && l.brightness != null)
    if (!onLights.length) return null
    return Math.round(onLights.reduce((sum, l) => sum + pctFromBrightness(l.brightness), 0) / onLights.length)
  }, [bulkPct, all])
  const { push: bulkSend, commit: bulkCommit } = useBrightnessThrottle(bulkBrightness, 200)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// env</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>lights<span className="cursor-blink">_</span></h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!all.length || mutation.isPending}
            onClick={() => bulk('on')}
            className="border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
          >
            All on
          </button>
          <button
            type="button"
            disabled={!anyOn || mutation.isPending}
            onClick={() => bulk('off')}
            className="border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
          >
            All off
          </button>
        </div>
      </div>

      {lights.isLoading && !lights.data ? (
        <Card><div className="text-sm text-[var(--color-text-dim)]">Loading…</div></Card>
      ) : lights.error ? (
        <Card><div className="text-sm text-[var(--color-danger)]">Home Assistant unreachable</div></Card>
      ) : (
        <>
          {all.length > 0 && availableTargets.length === 0 && (
            <Card>
              <div className="space-y-1 text-sm">
                <div className="text-[var(--color-warning)]">All lights unavailable</div>
                <div className="text-[var(--color-text-dim)]">
                  Home Assistant can't reach any bulb. If some are plugged in, the Cync
                  integration likely needs re-authentication (HA → Settings → Devices &
                  Services → Cync).
                </div>
              </div>
            </Card>
          )}

          {availableTargets.length > 0 && (
            <Card title={`All ${availableTargets.length} lights`}>
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-sm">
                    <span className="text-[var(--color-text-dim)]">Brightness</span>
                    <span className="font-semibold text-[var(--color-text)]">{bulkDisplayPct != null ? `${bulkDisplayPct}%` : '—'}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    defaultValue={100}
                    onInput={(e) => {
                      const pct = Number((e.target as HTMLInputElement).value)
                      setBulkPct(pct)
                      bulkSend(pct)
                    }}
                    onPointerUp={(e) => bulkCommit(Number((e.target as HTMLInputElement).value))}
                    onTouchEnd={(e) => bulkCommit(Number((e.target as HTMLInputElement).value))}
                    className="brightness-slider"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => bulkPreset(p.rgb, p.kelvin)}
                      className="flex items-center gap-2 border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-2.5 text-xs text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)]/40 hover:text-[var(--color-text)]"
                    >
                      <span className="h-3 w-3 border border-[var(--color-border)]" style={{ backgroundColor: presetSwatchStyle(p) }} aria-hidden />
                      {p.label}
                    </button>
                  ))}
                  <ColorWheel
                    value={bulkCustomHex}
                    onPick={(rgb) => {
                      setBulkCustomHex(rgbToHex(rgb))
                      bulkPreset(rgb, null)
                    }}
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Plugged-in lights first; unplugged ones trail dimmed so two live
              bulbs don't drown in a grid of dead cards. */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...all].sort((a, b) => Number(a.unavailable) - Number(b.unavailable)).map((light) => (
              <LightCard key={light.entity_id} light={light} onUpdate={updateOne} />
            ))}
          </div>
        </>
      )}

      {mutation.error && (
        <div className="border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {(mutation.error as Error).message}
        </div>
      )}
    </div>
  )
}
