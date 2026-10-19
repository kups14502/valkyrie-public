import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchLights, setLight, type LightState, type LightUpdate } from './api'

// Shared light control: the presets, the unit conversions, the intent overlay,
// the send queue, and the slider sync. The Lights page, the dashboards, the pad
// and the lights button all drive lights through this, so there is one source
// of truth for what a light update does.
//
// The model:
//
//   1. The query cache holds SERVER TRUTH only. Nothing optimistic is ever
//      written into it. The backend's rows already show a command's target
//      until the bulb reports it (a row with pending: true), for every client.
//   2. What this client asked for lives beside it, in a per-entity DESIRE: the
//      merge of every patch since the server last agreed, so a brightness and
//      then a color both show at once. It only has to bridge the moment until
//      the server's own row carries the target.
//   3. Commands go out ONE AT A TIME from this client, the newest per bulb
//      winning. Two POSTs in flight at once can reach the backend in either
//      order, and the older one landing last is how fast switching ended up
//      somewhere it was never set.

export const PRESETS: { label: string; rgb: [number, number, number] | null; kelvin: number | null }[] = [
  { label: 'Warm', rgb: null, kelvin: 2200 },
  { label: 'Neutral', rgb: null, kelvin: 4000 },
  { label: 'Cool', rgb: null, kelvin: 6500 },
  { label: 'Red', rgb: [255, 0, 0], kelvin: null },
  { label: 'Amber', rgb: [255, 140, 40], kelvin: null },
  { label: 'Green', rgb: [80, 230, 110], kelvin: null },
  { label: 'Blue', rgb: [70, 130, 255], kelvin: null },
  { label: 'Purple', rgb: [180, 90, 255], kelvin: null },
]

// null means "unknown", and stays unknown. Returning 100 for a bulb that has no
// brightness attribute (which is what a Cync bulb reports for a beat while it
// changes color mode) put a fabricated 100% into the readout and, through
// useSliderSync, into the slider thumb.
export function pctFromBrightness(b: number | null): number | null {
  if (b == null) return null
  return Math.max(0, Math.min(100, Math.round((b / 255) * 100)))
}

export function brightnessFromPct(p: number): number {
  return Math.max(1, Math.min(255, Math.round((p / 100) * 255)))
}

// Rough blackbody ramp, enough to tint a swatch. A bulb in color_temp mode
// reports no rgb_color, so without this the dot and the glow fall back to a
// fixed amber and stop tracking the light after a Warm/Neutral/Cool tap.
export function kelvinToHex(k: number): string {
  const t = Math.max(0, Math.min(1, (k - 2000) / 4500))
  const r = 255
  const g = Math.round(150 + 90 * t)
  const b = Math.round(70 + 175 * t)
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`
}

// What color this bulb actually is right now, in whichever mode it is in.
export function lightColor(l: Pick<LightState, 'rgb_color' | 'color_temp_kelvin' | 'color_mode'>): string {
  if (l.color_mode === 'color_temp' && l.color_temp_kelvin != null) return kelvinToHex(l.color_temp_kelvin)
  if (l.rgb_color) return `rgb(${l.rgb_color.join(',')})`
  if (l.color_temp_kelvin != null) return kelvinToHex(l.color_temp_kelvin)
  return '#ffd9a0'
}

export function presetSwatchStyle(p: { rgb: [number, number, number] | null; kelvin: number | null }): string {
  if (p.rgb) return `rgb(${p.rgb.join(',')})`
  if (p.kelvin) return kelvinToHex(p.kelvin)
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

/** A server row; `pending` is set by backends that hold a command's target until the bulb reports it. */
type ServerRow = LightState & { pending?: boolean }

const targetsOf = (u: Pick<LightUpdate, 'entity_id'>): string[] => (Array.isArray(u.entity_id) ? [...u.entity_id] : [u.entity_id])

function patchOf(u: LightUpdate): LightPatch {
  const p: LightPatch = { state: u.state }
  if (u.brightness !== undefined) p.brightness = u.brightness
  if (u.rgb_color !== undefined) p.rgb_color = u.rgb_color
  if (u.color_temp_kelvin !== undefined) p.color_temp_kelvin = u.color_temp_kelvin
  return p
}

/**
 * Two patches for one bulb as the one patch they add up to: off wins outright,
 * an on keeps the earlier on's brightness and color unless it sets its own, and
 * rgb and kelvin replace each other (they are two modes, never both).
 */
export function mergePatch(prev: LightPatch | undefined, next: LightPatch): LightPatch {
  if (next.state === 'off' || !prev || prev.state === 'off') return { ...next }
  const out: LightPatch = { state: 'on' }
  const b = next.brightness ?? prev.brightness
  if (b !== undefined) out.brightness = b
  if (next.rgb_color) out.rgb_color = next.rgb_color
  else if (next.color_temp_kelvin !== undefined) out.color_temp_kelvin = next.color_temp_kelvin
  else if (prev.rgb_color) out.rgb_color = prev.rgb_color
  else if (prev.color_temp_kelvin !== undefined) out.color_temp_kelvin = prev.color_temp_kelvin
  return out
}

// ---------------------------------------------------------------------------
// The send queue
// ---------------------------------------------------------------------------

type Job = { update: LightUpdate; resolve: (v: unknown) => void; reject: (e: unknown) => void }

/**
 * One POST in flight at a time. Updates asked meanwhile wait, and when the
 * POST returns they go as few POSTs as they add up to: per bulb the merge of
 * its patches (the newest winning), bulbs with the same result in one POST.
 * A lone waiting update goes exactly as it was asked. Each caller's promise
 * settles with the POST that carried its update.
 */
export function createSendQueue(send: (u: LightUpdate) => Promise<unknown>) {
  let busy = false
  let waiting: Job[] = []

  function batches(jobs: Job[]): { update: LightUpdate; jobs: Job[] }[] {
    if (jobs.length === 1) return [{ update: jobs[0].update, jobs }]
    const per = new Map<string, { patch: LightPatch; jobs: Set<Job> }>()
    for (const j of jobs) {
      const p = patchOf(j.update)
      for (const id of targetsOf(j.update)) {
        const cur = per.get(id)
        if (cur) { cur.patch = mergePatch(cur.patch, p); cur.jobs.add(j) } else per.set(id, { patch: p, jobs: new Set([j]) })
      }
    }
    const groups = new Map<string, { ids: string[]; patch: LightPatch; jobs: Set<Job> }>()
    for (const [id, { patch, jobs: js }] of per) {
      const key = JSON.stringify(patch)
      const g = groups.get(key)
      if (g) { g.ids.push(id); js.forEach((j) => g.jobs.add(j)) } else groups.set(key, { ids: [id], patch, jobs: new Set(js) })
    }
    return [...groups.values()].map((g) => ({ update: { entity_id: g.ids.length === 1 ? g.ids[0] : g.ids, ...g.patch }, jobs: [...g.jobs] }))
  }

  async function run() {
    if (busy) return
    busy = true
    try {
      while (waiting.length) {
        const jobs = waiting
        waiting = []
        const failed = new Map<Job, unknown>()
        for (const b of batches(jobs)) {
          try {
            await send(b.update)
          } catch (e) {
            for (const j of b.jobs) if (!failed.has(j)) failed.set(j, e)
          }
        }
        for (const j of jobs) {
          if (failed.has(j)) j.reject(failed.get(j))
          else j.resolve(undefined)
        }
      }
    } finally {
      busy = false
    }
  }

  return (update: LightUpdate): Promise<unknown> => new Promise((resolve, reject) => {
    waiting.push({ update, resolve, reject })
    void run()
  })
}

const sendLight = createSendQueue(setLight)

// ---------------------------------------------------------------------------
// Desired state
// ---------------------------------------------------------------------------

// How long a command owns a bulb's displayed state in this client. The
// backend's own row takes over as soon as the command is accepted; this only
// covers a backend that does not hold targets, or one that does not answer.
const DESIRE_MS = 9_000

type Desire = { patch: LightPatch; at: number }

const desires = new Map<string, Desire>()
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version += 1
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleExpiry() {
  if (expiryTimer !== null) return
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    const cutoff = Date.now() - DESIRE_MS
    let changed = false
    for (const [id, d] of desires) {
      if (d.at <= cutoff) { desires.delete(id); changed = true }
    }
    if (desires.size > 0) scheduleExpiry()
    if (changed) emit()
  }, DESIRE_MS + 100)
}

function want(entities: string[], patch: LightPatch) {
  const at = Date.now()
  for (const id of entities) desires.set(id, { patch: mergePatch(desires.get(id)?.patch, patch), at })
  scheduleExpiry()
  emit()
}

function forget(entities: string[]) {
  let changed = false
  for (const id of entities) changed = desires.delete(id) || changed
  if (changed) emit()
}

// Tolerances match the backend's: bulbs quantize brightness, rgb, and kelvin,
// so an exact match is a test no bulb passes.
export function satisfied(row: LightState, p: LightPatch): boolean {
  if (p.state === 'off') return !row.on
  if (!row.on) return false
  if (row.unavailable) return true
  // A field the bulb does not report yet counts as not there yet. Skipping the
  // check instead would drop the desire mid mode-switch, exactly when the bulb
  // is reporting nulls and the display needs the desire most.
  if (p.brightness != null) {
    if (row.brightness == null || Math.abs(row.brightness - p.brightness) > 3) return false
  }
  if (p.rgb_color) {
    if (!row.rgb_color || p.rgb_color.some((v, i) => Math.abs(v - row.rgb_color![i]) > 12)) return false
  }
  if (p.color_temp_kelvin != null) {
    if (row.color_temp_kelvin == null || Math.abs(row.color_temp_kelvin - p.color_temp_kelvin) > 200) return false
  }
  return true
}

// A color command switches the bulb's mode, so the field for the mode it left
// becomes meaningless. Blanking it here is what stops the dot from showing the
// previous rgb color for a second after a Warm/Neutral/Cool tap.
export function overlay(row: LightState, p: LightPatch): LightState {
  if (p.state === 'off') return { ...row, on: false }
  const toCt = p.color_temp_kelvin != null
  const toRgb = !!p.rgb_color
  return {
    ...row,
    on: true,
    brightness: p.brightness ?? row.brightness,
    rgb_color: toRgb ? p.rgb_color! : toCt ? null : row.rgb_color,
    color_temp_kelvin: toCt ? p.color_temp_kelvin! : toRgb ? null : row.color_temp_kelvin,
    color_mode: toRgb ? 'rgb' : toCt ? 'color_temp' : row.color_mode,
  }
}

// ---------------------------------------------------------------------------

export function useLightsControl() {
  const qc = useQueryClient()
  useSyncExternalStore(subscribe, () => version, () => version)

  const hasDesires = desires.size > 0

  const lights = useQuery({
    queryKey: ['lights'],
    queryFn: fetchLights,
    // Poll harder while a command is outstanding, here or at the backend: the
    // overlay makes a mid-transition read harmless, so the only thing left to
    // optimize is how fast the bulb's confirmation reaches the screen.
    refetchInterval: (q) => (hasDesires || (q.state.data as ServerRow[] | undefined)?.some((r) => r.pending) ? 1_200 : 5_000),
    refetchOnWindowFocus: true,
    // Server truth only. Nothing optimistic is written here, so there is no
    // window in which a refetch and a rollback own the same array.
    staleTime: 0,
  })

  const server = useMemo(() => lights.data ?? [], [lights.data])

  // Drop a desire the moment the server agrees with it. Done in an effect, not
  // during render, so the map is never mutated mid-render.
  useEffect(() => {
    if (!server.length || desires.size === 0) return
    let changed = false
    for (const row of server) {
      const d = desires.get(row.entity_id)
      if (d && satisfied(row, d.patch)) { desires.delete(row.entity_id); changed = true }
    }
    if (changed) emit()
  }, [server])

  const all = useMemo(() => server.map((row) => {
    const d = desires.get(row.entity_id)
    return d ? overlay(row, d.patch) : row
    // version is the dependency that matters here: the desires map is mutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [server, version])

  const mutation = useMutation({
    mutationFn: sendLight,
    onMutate: (update: LightUpdate) => {
      const targets = targetsOf(update)
      want(targets, patchOf(update))
      return { targets }
    },
    // Fall back to server truth for the bulbs that failed, and only those.
    onError: (_err, _vars, ctx) => { if (ctx?.targets) forget(ctx.targets) },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lights'] }) },
  })

  const { mutate } = mutation
  const reachable = all.filter((l) => !l.unavailable)
  const anyOn = reachable.some((l) => l.on)
  const availableTargets = reachable.map((l) => l.entity_id)
  // Brightness and color apply to the bulbs that are ON. Sending them to a dark
  // bulb turns it on, which is why tapping a preset used to light the room back
  // up after you had switched things off.
  const litTargets = reachable.filter((l) => l.on).map((l) => l.entity_id)

  // The room percentage, over a fixed membership so the denominator cannot
  // change between polls and move the thumb on its own. A bulb whose brightness
  // is unknown makes the whole reading unknown rather than silently dropping
  // out of the average.
  const roomPct = useMemo(() => {
    const lit = reachable.filter((l) => l.on)
    if (!lit.length) return null
    const pcts = lit.map((l) => pctFromBrightness(l.brightness))
    if (pcts.some((p) => p == null)) return null
    return Math.round((pcts as number[]).reduce((a, b) => a + b, 0) / pcts.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all])

  const updateOne = useCallback((entity_id: string, update: LightPatch) => {
    mutate({ entity_id, ...update })
  }, [mutate])

  const bulk = (state: 'on' | 'off') => {
    if (availableTargets.length === 0) return
    mutate({ entity_id: availableTargets, state })
  }

  const bulkBrightness = (pct: number) => {
    if (litTargets.length === 0) return
    mutate({ entity_id: litTargets, state: 'on', brightness: brightnessFromPct(pct) })
  }

  // No brightness here on purpose. A color change must not flatten five bulbs
  // that are at five different levels onto one room average: the backend
  // completes each bulb's command with that bulb's own level, so the color and
  // the brightness go out together and the bulb cannot pick its own.
  const bulkPreset = (rgb: [number, number, number] | null, kelvin: number | null) => {
    if (litTargets.length === 0) return
    mutate({
      entity_id: litTargets,
      state: 'on',
      ...(rgb ? { rgb_color: rgb } : {}),
      ...(kelvin && !rgb ? { color_temp_kelvin: kelvin } : {}),
    })
  }

  return {
    lights, mutation, all, anyOn, availableTargets, litTargets, roomPct,
    updateOne, bulk, bulkBrightness, bulkPreset,
  }
}

// Keeps an uncontrolled range input's thumb in sync with the real light.
//
// A range input stops honoring its value attribute (which is all React writes
// via defaultValue) once the user has dragged it, so after one drag the thumb
// freezes and stops reflecting changes made elsewhere: the bulk slider, the
// other page, or Home Assistant itself. Writing .value directly is the only
// fix. It must never run while a finger owns the thumb, though: doing that
// moved the slider under the user, and because the release handler read its
// value back off the DOM, the value that got committed was the sync's, not the
// user's.
export function useSliderSync(syncTo: number | null, dragging: boolean) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (dragging || syncTo == null || !el) return
    if (Number(el.value) !== syncTo) el.value = String(syncTo)
  }, [syncTo, dragging])
  return ref
}
