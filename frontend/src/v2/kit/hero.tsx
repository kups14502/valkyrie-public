import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import {
  Camera, FRAME_FX, LAPTOP_FX, PHONE_FX, POSES, SERVER_FX, TABLET_FX, TOWER_FX, WireScene, compile, frameHeadset, laptop, odinServer, phone, tablet, thorTower,
  type Beam, type CameraPose, type Flow, type Model, type Vec3,
} from './three'
import { useHosts } from './data'
import { usePalette, useSetting } from './theme'
import { useReducedMotion } from './motion'
import { useShell } from './shell'
import { cx } from './ui'

// The x-ray hero (reference f018/f016): thor's tower (or odin's server, per
// Settings > Hero) on its own 3D dot floor, front-fan beams, airflow, and
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
// the model starts an orbit; the rest of the floor still swipes between tabs.
//
// Legibility: with an anchor, a soft black scrim dims the floor, beams and
// airflow on the side where the content sits (the widest margin around the
// anchor), so text never sits on bright dots.

/** Settings > Hero choices (the Home hero). */
export type HeroId = 'thor' | 'odin'
export const HERO_IDS: readonly HeroId[] = ['thor', 'odin']

/**
 * Every device the hero can draw. thor, odin, frame and mimir are API host ids
 * (frame is labeled Loki); phone and tablet are ready for when they report in.
 * logicserver has no model: its physical form is unknown.
 */
export type HostModelId = HeroId | 'frame' | 'mimir' | 'phone' | 'tablet'
export const HOST_MODEL_IDS: readonly HostModelId[] = ['thor', 'odin', 'frame', 'mimir', 'phone', 'tablet']

const BUILD: Record<HostModelId, () => Model> = { thor: thorTower, odin: odinServer, frame: frameHeadset, mimir: laptop, phone, tablet }
// Beams and airflow are OFF on every hero since 2026-10-17 ("the pc looks like the car"); kept for reference only.
export const HERO_FX: Record<HostModelId, { beams: Beam[]; flow: Flow[] }> = {
  thor: TOWER_FX, odin: SERVER_FX, frame: FRAME_FX, mimir: LAPTOP_FX, phone: PHONE_FX, tablet: TABLET_FX,
}
const built: Partial<Record<HostModelId, Model>> = {}
/** Shared, memoized model per id (built on first use). */
export const heroModel = (id: HostModelId): Model => (built[id] ??= BUILD[id]())

/** The model for an API host id (`HostVM.id`), or null when the host has no known shape (logicserver). */
export function hostModel(hostId: string): HostModelId | null {
  return (HOST_MODEL_IDS as readonly string[]).includes(hostId) ? (hostId as HostModelId) : null
}

/**
 * Suggested POSES name per model for System > Hosts. thor and odin keep the
 * poses System already uses; the headset, laptop and slabs read best from the
 * raised front 3/4 ('device'), where the strap loop, keyboard and camera bump show.
 */
export const HOST_POSE: Record<HostModelId, string> = { thor: 'track', odin: 'home', frame: 'device', mimir: 'device', phone: 'device', tablet: 'device' }

/** Settings > Hero ('v2.hero'). */
export function useHeroId(): [HeroId, (v: HeroId) => void] {
  return useSetting<HeroId>('hero', 'thor', HERO_IDS)
}

const unit = (v: number | null | undefined, d: number) => (v == null ? d : Math.max(0, Math.min(1, v / 100)))

/**
 * WireScene heat for a host: { cpu, mem, disk } 0..1 from live data, gpu a dim
 * idle glow (no metric), fans follow cpu. battery = HostVM.battery percent
 * (frame, mimir), display a steady glow while online. Hosts without a battery
 * get no battery key, so thor and odin render exactly as before.
 */
export function useHeat(hostId: string): { heat: Record<string, number>; online: boolean; cpu: number } {
  const hosts = useHosts()
  const h = hosts.data?.find((x) => x.id === hostId)
  const online = !!h && h.online && !h.stale
  const cpu = online ? unit(h?.cpu, 0.2) : 0.04
  const mem = online ? unit(h?.mem, 0.3) : 0.04
  const disk = online ? unit(h?.disk, 0.3) : 0.04
  const pct = h?.battery?.percent
  const battery = pct == null ? null : online ? unit(pct, 0.5) : 0.04
  const heat = useMemo(() => {
    const out: Record<string, number> = { cpu, mem, disk, gpu: online ? 0.14 : 0.04, fans: cpu, psu: online ? 0.3 : 0.04 }
    if (battery != null) out.battery = battery
    if (hostId === 'frame' || hostId === 'mimir') out.display = online ? 0.55 : 0.04
    return out
  }, [cpu, mem, disk, online, battery, hostId])
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
  onHotspot?: (id: string, at: { x: number; y: number }) => void
  activeHotspot?: string | null
  /** darkness 0..1 of the floor on the content side of the anchor, default 0.55 (0 = off; needs `anchor`) */
  scrim?: number
  className?: string
  style?: CSSProperties
  /** HTML overlay inside the scene box (popovers, labels) */
  children?: ReactNode
}

export function Hero({ active, pose, anchor, layoutKey, fill = 0.8, host, onHotspot, activeHotspot, scrim = 0.55, className, style, children }: HeroProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const shell = useShell()
  const palette = usePalette()
  const reduced = useReducedMotion()
  const [stored] = useHeroId()
  const id = host ?? stored
  const model = heroModel(id)
  const { heat, online } = useHeat(id)
  const [geo, setGeo] = useState<Geo | null>(null)

  // Measure the box and the anchor's visible part inside it.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => {
      const b = box.getBoundingClientRect()
      if (b.width < 20 || b.height < 20) return
      const a = anchor?.current?.getBoundingClientRect()
      const l = a ? Math.max(b.left, a.left) : b.left
      const r = a ? Math.min(b.right, a.right) : b.right
      const t = a ? Math.max(b.top, a.top) : b.top
      const btm = a ? Math.min(b.bottom, a.bottom) : b.bottom
      const next: Geo = {
        w: Math.round(b.width), h: Math.round(b.height),
        l: Math.round(l - b.left), r: Math.round(Math.max(l + 60, r) - b.left),
        t: Math.round(t - b.top), b: Math.round(Math.max(t + 60, btm) - b.top),
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
  const scenePose = useMemo<CameraPose | null>(() => (geo ? fitPose(model, POSES[name] ?? POSES.home, geo, fill) : null), [model, name, geo, fill])
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
