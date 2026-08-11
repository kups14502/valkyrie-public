import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLights, setLight, type LightState, type LightUpdate } from './api'

// Shared light control: the presets, the unit conversions, the optimistic
// mutation, and the drag throttle. Both the Lights page and pad mode drive
// lights through this, so there's one source of truth for what a light update
// does to the cache.

export const PRESETS: { label: string; rgb: [number, number, number] | null; kelvin: number | null }[] = [
  { label: 'Warm', rgb: null, kelvin: 2200 },
  { label: 'Neutral', rgb: null, kelvin: 4000 },
  { label: 'Cool', rgb: null, kelvin: 6500 },
  { label: 'Red', rgb: [255, 60, 60], kelvin: null },
  { label: 'Amber', rgb: [255, 140, 40], kelvin: null },
  { label: 'Green', rgb: [80, 230, 110], kelvin: null },
  { label: 'Blue', rgb: [70, 130, 255], kelvin: null },
  { label: 'Purple', rgb: [180, 90, 255], kelvin: null },
]

export function pctFromBrightness(b: number | null): number {
  if (b == null) return 100
  return Math.max(0, Math.min(100, Math.round((b / 255) * 100)))
}

export function brightnessFromPct(p: number): number {
  return Math.max(1, Math.min(255, Math.round((p / 100) * 255)))
}

export function presetSwatchStyle(p: { rgb: [number, number, number] | null; kelvin: number | null }): string {
  if (p.rgb) return `rgb(${p.rgb.join(',')})`
  if (p.kelvin) {
    if (p.kelvin <= 2700) return '#ffb87a'
    if (p.kelvin <= 4000) return '#fff1d6'
    return '#d6eaff'
  }
  return '#888'
}

export function rgbToHex(rgb: [number, number, number] | null): string {
  if (!rgb) return '#ffb87a'
  return `#${rgb.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}

export type LightPatch = Omit<LightUpdate, 'entity_id'>

// Lights + an optimistic mutation. The optimistic write matters on touch: the
// slider and toggles would otherwise snap back to the old value until Home
// Assistant answers and the next poll lands.
export function useLightsControl() {
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
  })

  const { mutate } = mutation
  const all = lights.data ?? []
  const anyOn = all.some((l) => l.on)
  const availableTargets = all.filter((l) => !l.unavailable).map((l) => l.entity_id)

  const updateOne = useCallback((entity_id: string, update: LightPatch) => {
    mutate({ entity_id, ...update })
  }, [mutate])

  const bulk = (state: 'on' | 'off') => {
    if (availableTargets.length === 0) return
    mutate({ entity_id: availableTargets, state })
  }

  const bulkBrightness = (pct: number) => {
    if (availableTargets.length === 0) return
    mutate({ entity_id: availableTargets, state: 'on', brightness: brightnessFromPct(pct) })
  }

  const bulkPreset = (rgb: [number, number, number] | null, kelvin: number | null) => {
    if (availableTargets.length === 0) return
    mutate({
      entity_id: availableTargets,
      state: 'on',
      ...(rgb ? { rgb_color: rgb } : {}),
      ...(kelvin ? { color_temp_kelvin: kelvin } : {}),
    })
  }

  return { lights, mutation, all, anyOn, availableTargets, updateOne, bulk, bulkBrightness, bulkPreset }
}

// Keeps an uncontrolled range input's thumb in sync with the real light.
//
// A range input stops honoring its value attribute (which is all React writes
// via defaultValue) once the user has dragged it, so after one drag the thumb
// freezes and stops reflecting changes made elsewhere: the bulk slider, the
// other page, or Home Assistant itself. Worse, touching that stale thumb emits
// its old value and shoves the bulb back. Writing .value directly is the only
// fix. Pass null while a drag owns the thumb so we never fight the user.
export function useSliderSync(syncTo: number | null) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (syncTo == null || !el) return
    if (Number(el.value) !== syncTo) el.value = String(syncTo)
  }, [syncTo])
  return ref
}

// Rate-limits slider drags to one request per interval, with a trailing send so
// the value you released on is always the value that sticks.
export function useBrightnessThrottle(send: (pct: number) => void, ms: number) {
  // Latest-ref so a re-render (new closure over the current light) doesn't
  // invalidate an in-flight trailing timer.
  const sendRef = useRef(send)
  useEffect(() => { sendRef.current = send })
  const lastSent = useRef(0)
  const trailing = useRef<number | null>(null)

  const clearTrailing = useCallback(() => {
    if (trailing.current !== null) {
      clearTimeout(trailing.current)
      trailing.current = null
    }
  }, [])

  useEffect(() => clearTrailing, [clearTrailing])

  const push = useCallback((pct: number) => {
    const now = Date.now()
    const elapsed = now - lastSent.current
    clearTrailing()
    if (elapsed >= ms) {
      lastSent.current = now
      sendRef.current(pct)
    } else {
      trailing.current = window.setTimeout(() => {
        lastSent.current = Date.now()
        trailing.current = null
        sendRef.current(pct)
      }, ms - elapsed)
    }
  }, [clearTrailing, ms])

  // Called on release: cancel any pending trailing send and commit immediately.
  const commit = useCallback((pct: number) => {
    clearTrailing()
    lastSent.current = Date.now()
    sendRef.current(pct)
  }, [clearTrailing])

  return { push, commit }
}
