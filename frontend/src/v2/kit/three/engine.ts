// Wireframe engine core: vector math, the orbit camera with its pose tween,
// and the model compiler that turns Seg lists into typed arrays the renderer
// can project without allocating. No DOM in here.
//
// World: y up, the floor is the plane y = 0, units are arbitrary (the models
// are built to fit a sphere of radius ~4 so one set of POSES works for all).
// Angles in CameraPose are DEGREES. yaw 0 looks at the model's front (+z)
// from in front of it; positive yaw swings the camera toward +x.

export type Vec3 = [number, number, number]
export type Layer = 'shell' | 'mesh' | 'hot' | 'acc2' | 'fg'
/** `w` (extra): alpha weight 0..1, default 1. */
export type Seg = { a: Vec3; b: Vec3; layer: Layer; group?: string; w?: number }
export type Hotspot = { id: string; at: Vec3; label: string }
/** Extra: a faint additive glass face (fresnel-shaded fill). */
export type Face = { pts: Vec3[]; layer?: Layer; group?: string; w?: number }
/** Extra: segments [from, to) rotate around `axis` through `center` (fan blades). speed in rev/s at heat 1. */
export type Spin = { from: number; to: number; center: Vec3; axis: Vec3; speed: number; group?: string }
export type Model = {
  segs: Seg[]
  hotspots: Hotspot[]
  radius: number
  /** extra: orbit target when the pose has none (default: bounding-box center) */
  center?: Vec3
  faces?: Face[]
  spins?: Spin[]
}
/** yaw/pitch/fov in degrees. `shift` (extra) moves the projection center by a fraction of the canvas size, e.g. [0.2, 0] puts the hero right of center. */
export type CameraPose = { yaw: number; pitch: number; dist: number; target?: Vec3; fov?: number; shift?: [number, number] }

// ---------- vectors ----------

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const smooth = (e0: number, e1: number, x: number): number => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t) }
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const DEG = Math.PI / 180

/** Rotate p around a unit axis through c by angle (radians). */
export function rotateAround(p: Vec3, c: Vec3, axis: Vec3, ang: number): Vec3 {
  const [x, y, z] = sub(p, c)
  const [u, v, w] = axis
  const cs = Math.cos(ang), sn = Math.sin(ang)
  const d = u * x + v * y + w * z
  return [
    c[0] + u * d * (1 - cs) + x * cs + (-w * y + v * z) * sn,
    c[1] + v * d * (1 - cs) + y * cs + (w * x - u * z) * sn,
    c[2] + w * d * (1 - cs) + z * cs + (-v * x + u * y) * sn,
  ]
}

/** Cubic Bezier point. */
export function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ]
}

// ---------- colors ----------

export type RGB = [number, number, number]

/** '#rgb', '#rrggbb', 'rgb(r, g, b)', or 'r, g, b'. Unknown input is white. */
export function parseColor(c: string): RGB {
  const s = c.trim()
  if (s[0] === '#') {
    const h = s.length === 4 ? s.slice(1).split('').map((x) => x + x).join('') : s.slice(1, 7)
    const n = parseInt(h, 16)
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = s.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return [255, 255, 255]
}

export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : Math.round(a * 1000) / 1000})`

// ---------- camera ----------

type CamVals = { yaw: number; pitch: number; dist: number; tx: number; ty: number; tz: number; fov: number; sx: number; sy: number }

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180

export const NEAR = 0.15

/**
 * Orbit camera. `setPose` starts a tween from wherever the camera is now
 * (drag and spin offsets included) to the new pose. The renderer reads the
 * basis fields directly: position p*, right r*, up u*, forward f*, focal
 * length in CSS px, and the projection center o*.
 */
export class Camera {
  cur: CamVals
  from: CamVals
  to: CamVals
  t0 = 0
  dur = 900
  dragYaw = 0
  dragPitch = 0
  spinYaw = 0
  px = 0; py = 0; pz = 0
  rx = 1; ry = 0; rz = 0
  ux = 0; uy = 1; uz = 0
  fx = 0; fy = 0; fz = -1
  focal = 500
  ox = 0; oy = 0
  /** current orbit distance and target, after the tween */
  dist = 10
  tx = 0; ty = 0; tz = 0

  constructor(p: CameraPose, center: Vec3) {
    this.cur = Camera.vals(p, center)
    this.from = { ...this.cur }
    this.to = { ...this.cur }
  }

  static vals(p: CameraPose, center: Vec3): CamVals {
    const t = p.target ?? center
    return { yaw: p.yaw, pitch: p.pitch, dist: p.dist, tx: t[0], ty: t[1], tz: t[2], fov: p.fov ?? 30, sx: p.shift?.[0] ?? 0, sy: p.shift?.[1] ?? 0 }
  }

  /** Fly to a pose. dur 0 snaps. */
  setPose(p: CameraPose, center: Vec3, now: number, dur = 900) {
    const next = Camera.vals(p, center)
    const start = { ...this.cur }
    start.yaw += this.dragYaw + this.spinYaw
    start.pitch += this.dragPitch
    this.dragYaw = 0
    this.dragPitch = 0
    this.spinYaw = 0
    next.yaw = start.yaw + wrap180(next.yaw - start.yaw)
    this.from = start
    this.to = next
    this.t0 = now
    this.dur = dur
    if (dur <= 0) this.cur = { ...next }
    else this.cur = { ...start }
  }

  get tweening(): boolean {
    const c = this.cur, t = this.to
    return c.yaw !== t.yaw || c.pitch !== t.pitch || c.dist !== t.dist || c.tx !== t.tx || c.ty !== t.ty || c.tz !== t.tz ||
      c.fov !== t.fov || c.sx !== t.sx || c.sy !== t.sy
  }

  /** Advance the tween. */
  step(now: number) {
    if (!this.tweening) return
    const k = this.dur <= 0 ? 1 : clamp((now - this.t0) / this.dur, 0, 1)
    if (k >= 1) { this.cur = { ...this.to }; return }
    const e = easeInOut(k)
    const f = this.from, t = this.to
    this.cur = {
      yaw: f.yaw + (t.yaw - f.yaw) * e,
      pitch: f.pitch + (t.pitch - f.pitch) * e,
      // distance eases on a slight arc: pull back a little mid-flight, like the reference camera
      dist: f.dist + (t.dist - f.dist) * e + Math.sin(Math.PI * e) * Math.min(2, Math.abs(wrap180(t.yaw - f.yaw)) / 60) * 0.6,
      tx: f.tx + (t.tx - f.tx) * e,
      ty: f.ty + (t.ty - f.ty) * e,
      tz: f.tz + (t.tz - f.tz) * e,
      fov: f.fov + (t.fov - f.fov) * e,
      sx: f.sx + (t.sx - f.sx) * e,
      sy: f.sy + (t.sy - f.sy) * e,
    }
  }

  /** Recompute the basis for a canvas of w x h CSS px. */
  basis(w: number, h: number) {
    const c = this.cur
    const yaw = (c.yaw + this.dragYaw + this.spinYaw) * DEG
    const pitch = clamp(c.pitch + this.dragPitch, -10, 85) * DEG
    const cp = Math.cos(pitch)
    this.tx = c.tx; this.ty = c.ty; this.tz = c.tz
    this.dist = c.dist
    this.px = c.tx + c.dist * cp * Math.sin(yaw)
    this.py = c.ty + c.dist * Math.sin(pitch)
    this.pz = c.tz + c.dist * cp * Math.cos(yaw)
    let fx = c.tx - this.px, fy = c.ty - this.py, fz = c.tz - this.pz
    const fl = Math.hypot(fx, fy, fz) || 1
    fx /= fl; fy /= fl; fz /= fl
    // right = f x up(0,1,0)
    let rx = -fz, rz = fx
    const rl = Math.hypot(rx, rz) || 1
    rx /= rl; rz /= rl
    // up = r x f
    this.fx = fx; this.fy = fy; this.fz = fz
    this.rx = rx; this.ry = 0; this.rz = rz
    this.ux = 0 * fz - rz * fy
    this.uy = rz * fx - rx * fz
    this.uz = rx * fy - 0 * fx
    this.focal = (Math.min(w, h) * 0.5) / Math.tan((c.fov * DEG) / 2)
    this.ox = w * (0.5 + c.sx)
    this.oy = h * (0.5 + c.sy)
  }

  /** Project a world point. Returns false when it is behind the near plane. out = [x, y, depth]. */
  project(x: number, y: number, z: number, out: Float32Array | number[], o = 0): boolean {
    const dx = x - this.px, dy = y - this.py, dz = z - this.pz
    const cz = dx * this.fx + dy * this.fy + dz * this.fz
    if (cz < NEAR) return false
    const cx = dx * this.rx + dy * this.ry + dz * this.rz
    const cy = dx * this.ux + dy * this.uy + dz * this.uz
    out[o] = this.ox + (cx * this.focal) / cz
    out[o + 1] = this.oy - (cy * this.focal) / cz
    out[o + 2] = cz
    return true
  }
}

// ---------- orbit drag ----------

/** Drag-to-orbit state machine. Feed it pointer moves; call update() every frame. */
export class Orbit {
  dragging = false
  lastX = 0
  lastY = 0
  lastT = 0
  vel = 0
  releasedAt = -1
  backFrom: [number, number] | null = null
  backT0 = 0

  down(x: number, y: number, now: number) {
    this.dragging = true
    this.lastX = x; this.lastY = y; this.lastT = now
    this.vel = 0
    this.backFrom = null
  }

  move(cam: Camera, x: number, y: number, now: number) {
    if (!this.dragging) return
    const dx = x - this.lastX, dy = y - this.lastY
    const dt = Math.max(1, now - this.lastT)
    cam.dragYaw -= dx * 0.38
    const basePitch = cam.cur.pitch
    cam.dragPitch = clamp(cam.dragPitch + dy * 0.28, 2 - basePitch, 80 - basePitch)
    this.vel = this.vel * 0.6 + ((-dx * 0.38) / dt) * 1000 * 0.4
    this.lastX = x; this.lastY = y; this.lastT = now
  }

  up(now: number) {
    if (!this.dragging) return
    this.dragging = false
    this.releasedAt = now
    if (now - this.lastT > 80) this.vel = 0
  }

  /** Inertia, then ease back to the pose 2.5 s after release. Returns true while it still moves. */
  update(cam: Camera, now: number, dt: number): boolean {
    if (this.dragging) return true
    let moving = false
    if (Math.abs(this.vel) > 0.5) {
      cam.dragYaw += this.vel * dt
      this.vel *= Math.exp(-dt * 3.5)
      moving = true
    } else this.vel = 0
    if (this.releasedAt >= 0 && now - this.releasedAt > 2500 && (cam.dragYaw !== 0 || cam.dragPitch !== 0)) {
      if (!this.backFrom) {
        // take the shortest way home
        this.backFrom = [wrap180(cam.dragYaw), cam.dragPitch]
        this.backT0 = now
        this.vel = 0
      }
      const k = clamp((now - this.backT0) / 1100, 0, 1)
      const e = 1 - easeInOut(k)
      cam.dragYaw = this.backFrom[0] * e
      cam.dragPitch = this.backFrom[1] * e
      if (k >= 1) { cam.dragYaw = 0; cam.dragPitch = 0; this.backFrom = null; this.releasedAt = -1 }
      moving = true
    }
    return moving
  }
}

// ---------- compiled model ----------

/**
 * Segments are batched by (layer, group) and an alpha LEVEL. The level folds
 * the segment's weight and its depth fade together, so each style is at most
 * NL stroke calls per frame no matter how many weights the model uses.
 */
export const NL = 6
export const LV = [1, 0.76, 0.57, 0.42, 0.3, 0.18]
export const levelOf = (f: number): number => (f >= 0.88 ? 0 : f >= 0.665 ? 1 : f >= 0.495 ? 2 : f >= 0.36 ? 3 : f >= 0.24 ? 4 : 5)

export type Style = { layer: Layer; group: string | null }

export type CompiledFace = { pts: Float32Array; n: Vec3; c: Vec3; style: number; w: number }

export type Compiled = {
  n: number
  pos: Float32Array
  work: Float32Array
  style: Uint16Array
  /** per-segment alpha weight */
  wt: Float32Array
  styles: Style[]
  spins: (Spin & { phase: number })[]
  faces: CompiledFace[]
  center: Vec3
  radius: number
  /** acc2 segments' footprint, for the colored floor reflection */
  acc2: { x: number; z: number; rx: number; rz: number; y: number } | null
  buckets: Float32Array[]
  counts: Int32Array
  hotspots: Hotspot[]
}

const cache = new WeakMap<Model, Compiled>()

export function compile(m: Model): Compiled {
  const hit = cache.get(m)
  if (hit) return hit
  const n = m.segs.length
  const pos = new Float32Array(n * 6)
  const style = new Uint16Array(n)
  const styles: Style[] = []
  const keys = new Map<string, number>()
  const wt = new Float32Array(n)
  const styleOf = (layer: Layer, group: string | undefined) => {
    const key = `${layer}|${group ?? ''}`
    let s = keys.get(key)
    if (s === undefined) { s = styles.length; styles.push({ layer, group: group ?? null }); keys.set(key, s) }
    return s
  }
  let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  let accLo: Vec3 | null = null, accHi: Vec3 | null = null
  m.segs.forEach((s, i) => {
    pos.set([s.a[0], s.a[1], s.a[2], s.b[0], s.b[1], s.b[2]], i * 6)
    style[i] = styleOf(s.layer, s.group)
    wt[i] = s.w ?? 1
    for (const p of [s.a, s.b]) {
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k] }
      if (s.layer === 'acc2' && p[1] < 1.6) {
        if (!accLo || !accHi) { accLo = [...p]; accHi = [...p] }
        for (let k = 0; k < 3; k++) { if (p[k] < accLo[k]) accLo[k] = p[k]; if (p[k] > accHi[k]) accHi[k] = p[k] }
      }
    }
  })
  const faces: CompiledFace[] = (m.faces ?? []).map((f) => {
    const pts = new Float32Array(f.pts.length * 3)
    f.pts.forEach((p, i) => pts.set(p, i * 3))
    const nrm = norm(cross(sub(f.pts[1], f.pts[0]), sub(f.pts[2], f.pts[0])))
    const c = scale(f.pts.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / f.pts.length)
    return { pts, n: nrm, c, style: styleOf(f.layer ?? 'fg', f.group), w: f.w ?? 1 }
  })
  const counts = new Int32Array(styles.length * NL)
  const perStyle = new Int32Array(styles.length)
  for (let i = 0; i < n; i++) perStyle[style[i]]++
  const buckets: Float32Array[] = []
  for (let s = 0; s < styles.length; s++) for (let b = 0; b < NL; b++) buckets.push(new Float32Array(perStyle[s] * 4 + 4))
  const center: Vec3 = m.center ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const al = accLo as Vec3 | null, ah = accHi as Vec3 | null
  const out: Compiled = {
    n, pos, work: new Float32Array(pos), style, wt, styles,
    spins: (m.spins ?? []).map((s) => ({ ...s, axis: norm(s.axis), phase: 0 })),
    faces, center, radius: m.radius,
    acc2: al && ah ? { x: (al[0] + ah[0]) / 2, z: (al[2] + ah[2]) / 2, rx: Math.max(0.4, (ah[0] - al[0]) / 2), rz: Math.max(0.4, (ah[2] - al[2]) / 2), y: (al[1] + ah[1]) / 2 } : null,
    buckets, counts, hotspots: m.hotspots,
  }
  cache.set(m, out)
  return out
}

/** Apply spinner rotations into `work` for this frame. */
export function applySpins(c: Compiled, heat: (g: string) => number, dt: number, mul: number) {
  for (const s of c.spins) {
    const h = heat(s.group ?? 'fans')
    s.phase = (s.phase + dt * s.speed * Math.PI * 2 * (0.25 + h) * mul) % (Math.PI * 2)
    const [u, v, w] = s.axis
    const cs = Math.cos(s.phase), sn = Math.sin(s.phase), oc = 1 - cs
    // rotation matrix
    const m00 = cs + u * u * oc, m01 = u * v * oc - w * sn, m02 = u * w * oc + v * sn
    const m10 = v * u * oc + w * sn, m11 = cs + v * v * oc, m12 = v * w * oc - u * sn
    const m20 = w * u * oc - v * sn, m21 = w * v * oc + u * sn, m22 = cs + w * w * oc
    const [cx, cy, cz] = s.center
    const P = c.pos, W = c.work
    for (let i = s.from * 6, e = s.to * 6; i < e; i += 3) {
      const x = P[i] - cx, y = P[i + 1] - cy, z = P[i + 2] - cz
      W[i] = cx + m00 * x + m01 * y + m02 * z
      W[i + 1] = cy + m10 * x + m11 * y + m12 * z
      W[i + 2] = cz + m20 * x + m21 * y + m22 * z
    }
  }
}

/** Screen positions of a model's hotspots for a pose on a w x h canvas (static, no tween). */
export function projectHotspots(model: Model, pose: CameraPose, w: number, h: number): { id: string; label: string; x: number; y: number; visible: boolean }[] {
  const c = compile(model)
  const cam = new Camera(pose, c.center)
  cam.basis(w, h)
  const out = [0, 0, 0]
  return model.hotspots.map((hs) => {
    const ok = cam.project(hs.at[0], hs.at[1], hs.at[2], out)
    return { id: hs.id, label: hs.label, x: out[0], y: out[1], visible: ok && out[0] >= 0 && out[0] <= w && out[1] >= 0 && out[1] <= h }
  })
}
