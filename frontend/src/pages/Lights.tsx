import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '../components/Card'
import { fetchLights, setLight, type LightState, type LightUpdate } from '../lib/api'

const PRESETS: { label: string; rgb: [number, number, number] | null; kelvin: number | null }[] = [
  { label: 'Warm', rgb: null, kelvin: 2200 },
  { label: 'Neutral', rgb: null, kelvin: 4000 },
  { label: 'Cool', rgb: null, kelvin: 6500 },
  { label: 'Red', rgb: [255, 60, 60], kelvin: null },
  { label: 'Amber', rgb: [255, 140, 40], kelvin: null },
  { label: 'Green', rgb: [80, 230, 110], kelvin: null },
  { label: 'Blue', rgb: [70, 130, 255], kelvin: null },
  { label: 'Purple', rgb: [180, 90, 255], kelvin: null },
]

function pctFromBrightness(b: number | null): number {
  if (b == null) return 100
  return Math.max(0, Math.min(100, Math.round((b / 255) * 100)))
}

function brightnessFromPct(p: number): number {
  return Math.max(1, Math.min(255, Math.round((p / 100) * 255)))
}

function presetSwatchStyle(p: { rgb: [number, number, number] | null; kelvin: number | null }): string {
  if (p.rgb) return `rgb(${p.rgb.join(',')})`
  if (p.kelvin) {
    if (p.kelvin <= 2700) return '#ffb87a'
    if (p.kelvin <= 4000) return '#fff1d6'
    return '#d6eaff'
  }
  return '#888'
}

function LightCard({ light, onUpdate }: { light: LightState; onUpdate: (update: Partial<LightState> & { state: 'on' | 'off' }) => void }) {
  const [pendingPct, setPendingPct] = useState<number | null>(null)
  const displayPct = pendingPct ?? pctFromBrightness(light.brightness)
  const swatchColor = light.rgb_color ? `rgb(${light.rgb_color.join(',')})` : light.on ? '#ffd9a0' : '#1a1f2b'

  useEffect(() => {
    if (pendingPct === null) return
    if (pctFromBrightness(light.brightness) === pendingPct) setPendingPct(null)
  }, [light.brightness, pendingPct])

  const commit = (pct: number) => {
    onUpdate({ state: 'on', brightness: brightnessFromPct(pct) })
  }

  return (
    <div className={`rounded-2xl border p-4 transition ${light.on ? 'border-[var(--color-warning)]/40 bg-[color:rgba(255,184,77,0.04)]' : 'border-[var(--color-border)] bg-[color:rgba(255,255,255,0.015)]'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-block h-6 w-6 rounded-full border border-[var(--color-border)] shadow-inner" style={{ backgroundColor: swatchColor }} aria-hidden />
          <div>
            <div className="text-sm font-medium text-[var(--color-text)]">{light.name}</div>
            <div className="text-[11px] text-[var(--color-text-faint)]">{light.unavailable ? 'unavailable' : light.on ? 'on' : 'off'}</div>
          </div>
        </div>
        <button
          type="button"
          disabled={light.unavailable}
          onClick={() => onUpdate({ state: light.on ? 'off' : 'on' })}
          className={`rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
            light.on
              ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)] hover:bg-[var(--color-warning)]/30'
              : 'bg-[color:rgba(255,255,255,0.04)] text-[var(--color-text-dim)] hover:bg-[color:rgba(255,255,255,0.07)]'
          }`}
        >
          {light.on ? 'On' : 'Off'}
        </button>
      </div>

      {light.on && !light.unavailable && (
        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-[var(--color-text-dim)]">Brightness</span>
              <span className="font-semibold text-[var(--color-text)]">{displayPct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={displayPct}
              onChange={(e) => setPendingPct(Number(e.target.value))}
              onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
              onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
              className="w-full accent-[var(--color-warning)]"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onUpdate({
                  state: 'on',
                  ...(p.rgb ? { rgb_color: p.rgb } : {}),
                  ...(p.kelvin ? { color_temp_kelvin: p.kelvin } : {}),
                })}
                className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-2.5 py-1 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)]/40 hover:text-[var(--color-text)]"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: presetSwatchStyle(p) }} aria-hidden />
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Lights() {
  const qc = useQueryClient()
  const lights = useQuery({ queryKey: ['lights'], queryFn: fetchLights, refetchInterval: 10_000 })

  const mutation = useMutation({
    mutationFn: setLight,
    onMutate: async (update: LightUpdate) => {
      await qc.cancelQueries({ queryKey: ['lights'] })
      const previous = qc.getQueryData<LightState[]>(['lights'])
      const targets = new Set(Array.isArray(update.entity_id) ? update.entity_id : [update.entity_id])
      qc.setQueryData<LightState[]>(['lights'], (old) => {
        if (!old) return old
        return old.map((l) => {
          if (!targets.has(l.entity_id)) return l
          return {
            ...l,
            on: update.state === 'on',
            brightness: update.state === 'on' && typeof update.brightness === 'number' ? update.brightness : l.brightness,
            rgb_color: update.state === 'on' && update.rgb_color ? update.rgb_color : l.rgb_color,
            color_temp_kelvin: update.state === 'on' && typeof update.color_temp_kelvin === 'number' ? update.color_temp_kelvin : l.color_temp_kelvin,
          }
        })
      })
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['lights'], ctx.previous)
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['lights'] }) },
  })

  const all = lights.data ?? []
  const anyOn = all.some((l) => l.on)

  const bulk = (state: 'on' | 'off') => {
    const targets = all.filter((l) => !l.unavailable).map((l) => l.entity_id)
    if (targets.length === 0) return
    mutation.mutate({ entity_id: targets, state })
  }

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">Environment</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Lights</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!all.length || mutation.isPending}
            onClick={() => bulk('on')}
            className="rounded-full border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-1 text-xs uppercase tracking-[0.22em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
          >
            All on
          </button>
          <button
            type="button"
            disabled={!anyOn || mutation.isPending}
            onClick={() => bulk('off')}
            className="rounded-full border border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] px-3 py-1 text-xs uppercase tracking-[0.22em] text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] disabled:opacity-40"
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {all.map((light) => (
            <LightCard
              key={light.entity_id}
              light={light}
              onUpdate={(update) => {
                const { state, brightness, rgb_color, color_temp_kelvin } = update as {
                  state: 'on' | 'off'
                  brightness?: number
                  rgb_color?: [number, number, number]
                  color_temp_kelvin?: number
                }
                mutation.mutate({ entity_id: light.entity_id, state, brightness, rgb_color, color_temp_kelvin })
              }}
            />
          ))}
        </div>
      )}

      {mutation.error && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {(mutation.error as Error).message}
        </div>
      )}
    </div>
  )
}
