import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import {
  Camera, FRAME_FX, LAPTOP_FX, MODEL_Y_FX, ODIN_FX, PHONE_FX, POSES, TABLET_FX, TOWER_FX, WireScene, compile, frameHeadset, laptop, modelY, odinRig, phone, tablet, thorTower,
  type Beam, type CameraPose, type Flow, type Model, type Vec3,
} from './three'
import { useHosts } from './data'
import { usePalette, useSetting } from './theme'
import { useReducedMotion } from './motion'
import { useShell } from './shell'
import { cx } from './ui'

// The x-ray hero (reference f018/f016): thor's tower (or odin's laptop and
// RAID enclosure, per Settings > Hero) on its own 3D dot floor, and its
// internals glowing by the host's live load. `host` can show any device model:
// frame's headset, mimir's laptop, and the phone and tablet slabs.
//
// Camera: while its screen is active the hero holds `pose`. While the screen
// is hidden it is paused and silently follows the shell's pose bus (the pose
// the active screen asked for), so coming back flies the camera from the
// angle of the tab you left, the way the reference moves between tabs.
//
// Placement: the hero fills its box. Pass `anchor` (an element in your layout)
// and, for every pose, the model's projected outline is centered on the
// visible part of that element and sized to `fill` of it. Only a disc around
// the model starts an orbit.
//
// Legibility: with an anchor, a soft black scrim dims the floor, beams and
// airflow on the side where the content sits (the widest margin around the
// anchor), so text never sits on bright dots.

/** Settings > Hero choices (the Home hero): the two machines, and the phone and tablet slabs. */
export type HeroId = 'thor' | 'odin' | 'phone' | 'tablet'
export const HERO_IDS: readonly HeroId[] = ['thor', 'odin', 'phone', 'tablet']

/**
 * Every device the hero can draw. thor, odin, frame and mimir are API host ids
 * (frame is labeled Loki). phone and tablet join /api/hosts once odin's
 * tailscale status knows them or an iOS Shortcut has posted their battery
 * (backend routes/devices.ts); until then they show as models only (Settings >
 * Hero, System > Hosts). logicserver has no model: its physical form is unknown.
 * modelY is the cars' model (host ids car-<prefix>, backend routes/vehicles.ts):
 * a car whose Home Assistant device model is a Model Y draws it, any other car
 * draws none (see hostModel).
 */
export type HostModelId = HeroId | 'frame' | 'mimir' | 'modelY'
export const HOST_MODEL_IDS: readonly HostModelId[] = ['thor', 'odin', 'frame', 'mimir', 'phone', 'tablet', 'modelY']

/** Devices with a model that may have no host on the API: System > Hosts lists them as model-only rows until they report in. */
export const MODEL_ONLY_IDS = ['phone', 'tablet'] as const
export type ModelOnlyId = (typeof MODEL_ONLY_IDS)[number]
export const MODEL_ONLY_LABEL: Record<ModelOnlyId, string> = { phone: 'Phone', tablet: 'Tablet' }

// odin is the real rig (laptop + RAID enclosure, models/odin.ts); the older odinServer box stays exported but unused here.
// frame is built without the ergo kit's optional top strap (frameHeadset({ topStrap: true }) adds it).
const BUILD: Record<HostModelId, () => Model> = { thor: thorTower, odin: odinRig, frame: () => frameHeadset(), mimir: laptop, phone, tablet, modelY }
// Beams and airflow are OFF on every hero since 2026-10-17 ("the pc looks like the car"); kept for reference only.
export const HERO_FX: Record<HostModelId, { beams: Beam[]; flow: Flow[] }> = {
  thor: TOWER_FX, odin: ODIN_FX, frame: FRAME_FX, mimir: LAPTOP_FX, phone: PHONE_FX, tablet: TABLET_FX, modelY: MODEL_Y_FX,
}
const built: Partial<Record<HostModelId, Model>> = {}
/** Shared, memoized model per id (built on first use). */
export const heroModel = (id: HostModelId): Model => (built[id] ??= BUILD[id]())

/** The model for a car's Home Assistant device model ("Model Y"), or null for a car with none built. */
const vehicleModel = (model: string | null | undefined): HostModelId | null => (/^model\s*y$/i.test((model ?? '').trim()) ? 'modelY' : null)

/**
 * The model for an API host id (`HostVM.id`), or null when the host has no known
 * shape (logicserver). A car (car-<prefix>) goes by its device model, `vehicle`.
 */
export function hostModel(hostId: string, vehicle?: string | null): HostModelId | null {
  if (hostId.startsWith('car-')) return vehicleModel(vehicle)
  return (HOST_MODEL_IDS as readonly string[]).includes(hostId) ? (hostId as HostModelId) : null
}

/**
 * Suggested POSES name per model for System > Hosts. thor keeps the pose
 * System already uses; odin's rig, the headset, the laptop and the slabs read
 * best from the raised front 3/4 ('device'), where the enclosure's bays, the
 * strap loop, the keyboard and the camera bump show. The car takes 'car': its
 * nose and the whole left side, charge port included.
 */
export const HOST_POSE: Record<HostModelId, string> = { thor: 'track', odin: 'device', frame: 'device', mimir: 'device', phone: 'device', tablet: 'device', modelY: 'car' }

/**
 * POSES swing toward +x (the glass side they were written for). thor's real
 * case has its glass on the left as seen from the front (-x, models/tower.ts),
 * so thor takes every pose with its yaw mirrored: each screen (System > Hosts,
 * Dashboard > This device, Settings) still looks at the glass from the same
 * angle, with the case the right way around.
 */
const MIRROR_YAW: Partial<Record<HostModelId, true>> = { thor: true }

/**
 * Poses a model takes in place of the shared one. thor on System > Hosts and
 * Dashboard > This device: straight through the glass, a little toward the
 * front fans (Brendon's pick, 2026-10-19), not the rear 3/4 the shared pose gives.
 */
const POSE_OVERRIDE: Partial<Record<HostModelId, Record<string, CameraPose>>> = {
  thor: {
    hosts: { yaw: -76, pitch: 12, dist: 14, fov: 38 },
    track: { yaw: -76, pitch: 12, dist: 14, fov: 38 },
  },
}

/** The POSES entry `name` as model `id` takes it. */
function modelPose(id: HostModelId, name: string): CameraPose {
  const own = POSE_OVERRIDE[id]?.[name]
  if (own) return own
  const p = POSES[name] ?? POSES.home
  return MIRROR_YAW[id] ? { ...p, yaw: -p.yaw } : p
}

/** Settings > Hero ('v2.hero'). */
export function useHeroId(): [HeroId, (v: HeroId) => void] {
  return useSetting<HeroId>('hero', 'thor', HERO_IDS)
}

const unit = (v: number | null | undefined, d: number) => (v == null ? d : Math.max(0, Math.min(1, v / 100)))

/**
 * WireScene heat for a host: { cpu, mem, disk } 0..1 from live data, gpu a dim
 * idle glow (no metric), fans follow cpu. battery = HostVM.battery percent
 * (frame, mimir, phone, tablet), display a steady glow while online. Hosts
 * without a battery get no battery key, so thor and odin render exactly as before.
 *
 * A car (HostVM.vehicle): its pack glows with the charge and its ten module
 * bands light from the rear up to the charge level (asleep too: the reading
 * stands), the light bars and the cabin screen while it is awake, the charge
 * port while a cable is in (bright while charging). Offline dims it all.
 */
export function useHeat(hostId: string): { heat: Record<string, number>; online: boolean; cpu: number } {
  const hosts = useHosts()
  const h = hosts.data?.find((x) => x.id === hostId)
  const v = h?.vehicle ?? null
  const online = !!h && h.online && !h.stale
  const cpu = online && !v ? unit(h?.cpu, 0.2) : 0.04
  const mem = online ? unit(h?.mem, 0.3) : 0.04
  const disk = online ? unit(h?.disk, 0.3) : 0.04
  const pct = h?.battery?.percent
  const battery = pct == null ? null : online ? unit(pct, 0.5) : 0.04
  // a car is still there while asleep: only offline (or a stale reading) dims its pack
  const car = v ? `${online ? 1 : 0}|${v.state}|${v.charging}|${v.cable}|${v.climateOn}|${pct ?? ''}` : ''
  const heat = useMemo(() => {
    if (car) {
      const [on, state, charging, cable, climate, p] = car.split('|')
      const live = on === '1'
      const level = Math.max(0, Math.min(100, Number(p) || 0))
      const awake = live && state === 'awake'
      const out: Record<string, number> = {
        battery: live ? 0.3 + 0.55 * (level / 100) : 0.08,
        lights: awake ? 0.72 : 0.1,
        cabin: awake ? (climate === 'true' ? 0.9 : 0.55) : 0.06,
        charge: charging === 'charging' || charging === 'starting' ? 1 : cable === 'true' ? 0.5 : 0.06,
      }
      for (let k = 0; k < 10; k++) out[`battery.c${k}`] = level >= k * 10 + 5 ? (live ? 0.35 + 0.6 * (level / 100) : 0.12) : 0.03
      return out
    }
    const out: Record<string, number> = { cpu, mem, disk, gpu: online ? 0.14 : 0.04, fans: cpu, psu: online ? 0.3 : 0.04 }
    if (battery != null) out.battery = battery
    if (hostId === 'frame' || hostId === 'mimir') out.display = online ? 0.55 : 0.04
    return out
  }, [car, cpu, mem, disk, online, battery, hostId])
  return { heat, online, cpu }
}

// ---------- fitting the model's outline into the anchor ----------

/** box size and the anchor's visible rect inside it, CSS px */
type Geo = { w: number; h: number; l: number; t: number; r: number; b: number }

const cornersCache = new WeakMap<Model, Vec3[]>()
function corners(model: Model): Vec3[] {
  const hit = cornersCache.get(model)
  if (hit) return hit
  const P = compile(model).pos
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  }
  const out: Vec3[] = []
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push([x, y, z])
  cornersCache.set(model, out)
  return out
}

/** Pose with dist and shift chosen so the model's projected box fills `fill` of the anchor and is centered on it. */
function fitPose(model: Model, p: CameraPose, g: Geo, fill: number): CameraPose {
  const c = compile(model)
  const pts = corners(model)
  const aw = Math.max(60, g.r - g.l)
  const ah = Math.max(60, g.b - g.t)
  const out = [0, 0, 0]
  const minDist = c.radius * 1.7
  let dist = p.dist
  let box = { x0: 0, y0: 0, x1: 0, y1: 0 }
  for (let iter = 0; iter < 4; iter++) {
    const cam = new Camera({ ...p, dist, shift: [0, 0] }, c.center)
    cam.basis(g.w, g.h)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let ok = true
    for (const q of pts) {
      if (!cam.project(q[0], q[1], q[2], out)) { ok = false; break }
      if (out[0] < x0) x0 = out[0]
      if (out[0] > x1) x1 = out[0]
      if (out[1] < y0) y0 = out[1]
      if (out[1] > y1) y1 = out[1]
    }
    if (!ok) { dist *= 1.6; continue }
    box = { x0, y0, x1, y1 }
    const s = Math.max((x1 - x0) / (aw * fill), (y1 - y0) / (ah * fill))
    if (Math.abs(s - 1) < 0.01) break
    dist = Math.max(minDist, Math.min(c.radius * 14, dist * s))
  }
  const sx = ((g.l + g.r) / 2 - (box.x0 + box.x1) / 2) / g.w
  const sy = ((g.t + g.b) / 2 - (box.y0 + box.y1) / 2) / g.h
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return { ...p, dist: Math.round(dist * 100) / 100, shift: [r3(sx), r3(sy)] }
}

/** Black falloff over the floor on the content side of the anchor (the widest margin). */
function scrimStyle(g: Geo, a: number): CSSProperties | null {
  if (a <= 0) return null
  const sides = [
    { dir: '90deg', edge: g.l, room: g.l / g.w },
    { dir: '270deg', edge: g.w - g.r, room: (g.w - g.r) / g.w },
    { dir: '180deg', edge: g.t, room: g.t / g.h },
    { dir: '0deg', edge: g.h - g.b, room: (g.h - g.b) / g.h },
  ]
  const best = sides.reduce((m, s) => (s.room > m.room ? s : m))
  if (best.room < 0.18) return null
  const k = `rgba(0, 0, 0, ${a})`
  const solid = Math.max(0, best.edge - 36)
  const clear = best.edge + 48
  return { background: `linear-gradient(${best.dir}, ${k} 0px, ${k} ${solid.toFixed(0)}px, rgba(0, 0, 0, 0) ${clear.toFixed(0)}px)` }
}

export type HeroProps = {
  /** the hosting screen is active: runs the loop and holds `pose` */
  active: boolean
  /** POSES name to hold while active */
  pose: string
  /** element whose visible part the model is centered on and sized to; default the whole box */
  anchor?: RefObject<HTMLElement | null>
  /** re-measure when this changes (for example the sub-tab, when the layout moves the anchor) */
  layoutKey?: string
  /** share of the anchor's width and height the model's projected outline may span, default 0.8 (above 1 overflows the anchor) */
  fill?: number
  /** override Settings > Hero: any model, e.g. hostModel(host.id) for System > Hosts */
  host?: HostModelId
  /** the API host its glow follows, when that is not the model's own id (a car: car-<prefix>) */
  hostId?: string
  onHotspot?: (id: string, at: { x: number; y: number }) => void
  activeHotspot?: string | null
  /** darkness 0..1 of the floor on the content side of the anchor, default 0.55 (0 = off; needs `anchor`) */
  scrim?: number
  className?: string
  style?: CSSProperties
  /** HTML overlay inside the scene box (popovers, labels) */
  children?: ReactNode
}

export function Hero({ active, pose, anchor, layoutKey, fill = 0.8, host, hostId, onHotspot, activeHotspot, scrim = 0.55, className, style, children }: HeroProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const shell = useShell()
  const palette = usePalette()
  const reduced = useReducedMotion()
  const [stored] = useHeroId()
  const id = host ?? stored
  const model = heroModel(id)
  const { heat, online } = useHeat(hostId ?? id)
  const [geo, setGeo] = useState<Geo | null>(null)

  // Measure the box and the anchor's visible part inside it.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => {
      const b = box.getBoundingClientRect()
      if (b.width < 20 || b.height < 20) return
      // Geo is in the box's own CSS px, the space the scene renders and places
      // its diamonds in. Client rects come back zoomed under the UI zoom, so
      // they are divided by the box's on-screen scale (see WireScene's size()).
      const k = box.offsetWidth > 0 ? b.width / box.offsetWidth : 1
      const a = anchor?.current?.getBoundingClientRect()
      const l = ((a ? Math.max(b.left, a.left) : b.left) - b.left) / k
      const r = ((a ? Math.min(b.right, a.right) : b.right) - b.left) / k
      const t = ((a ? Math.max(b.top, a.top) : b.top) - b.top) / k
      const btm = ((a ? Math.min(b.bottom, a.bottom) : b.bottom) - b.top) / k
      const next: Geo = {
        w: box.clientWidth || Math.round(b.width / k), h: box.clientHeight || Math.round(b.height / k),
        l: Math.round(l), r: Math.round(Math.max(l + 60, r)),
        t: Math.round(t), b: Math.round(Math.max(t + 60, btm)),
      }
      setGeo((cur) => (cur && cur.w === next.w && cur.h === next.h && Math.abs(cur.l - next.l) < 2 && Math.abs(cur.r - next.r) < 2 &&
        Math.abs(cur.t - next.t) < 2 && Math.abs(cur.b - next.b) < 2 ? cur : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    if (anchor?.current) ro.observe(anchor.current)
    return () => ro.disconnect()
  }, [anchor, layoutKey])

  // Active: hold our pose. Hidden: follow the shell's pose bus (snaps while paused).
  const name = active ? pose : POSES[shell.pose] ? shell.pose : pose
  const scenePose = useMemo<CameraPose | null>(() => (geo ? fitPose(model, modelPose(id, name), geo, fill) : null), [model, id, name, geo, fill])
  const scrimCss = useMemo(() => (geo && anchor ? scrimStyle(geo, scrim) : null), [geo, anchor, scrim])


  return (
    <div ref={boxRef} className={cx('vl-hero', className)} style={style} data-hero={id}>
      {scenePose && (
        <WireScene
          className="h-full w-full"
          model={model}
          pose={scenePose}
          palette={palette}
          heat={heat}
          spin={online ? 1 : 0}
          orbit
          orbitArea="model"
          paused={!active}
          motion={reduced ? 'reduced' : 'full'}
          onHotspot={onHotspot}
          activeHotspot={activeHotspot}
        >
          {scrimCss && <div className="vl-hero-scrim" style={scrimCss} aria-hidden />}
          {children}
        </WireScene>
      )}
    </div>
  )
}
