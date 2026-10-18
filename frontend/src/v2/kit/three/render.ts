// The frame renderer behind WireScene. Two canvases:
//   sharp  full resolution (DPR <= 2): dots, lines, fills, all additive
//   glow   ~1/2 CSS resolution, blurred by CSS: wide strokes of the hot,
//          fg and acc2 parts, beam volumes and light sprites (bloom)
// Everything is batched: segments go into (style x depth bucket) arrays and
// each bucket is ONE stroke call; dots go into alpha buckets and each bucket
// is one fill. Nothing allocates per segment per frame.

import {
  type Camera, type Compiled, type RGB, type Vec3, LV, NEAR, NL, levelOf,
  add, applySpins, bezier, clamp, cross, len, mixRGB, norm, parseColor, rgba, scale, smooth, sub,
} from './engine'
import type { Palette } from '../theme'

/** spread = half-angle in degrees; intensity (extra) 0..1, default 1 */
export type Beam = { from: Vec3; dir: Vec3; spread: number; length: number; intensity?: number }
/** speed in world units/s. Extras: via (bend point), spread (lane scatter), lanes (count) */
export type Flow = { from: Vec3; to: Vec3; speed: number; via?: Vec3; spread?: number; lanes?: number }
/** Extras: cone (downward light cone, default true), radius (floor pool radius) */
export type Light = { at: Vec3; color: string; intensity: number; cone?: boolean; radius?: number }

export type Fx = {
  heat?: Record<string, number>
  floor: boolean
  beams: Beam[]
  flow: Flow[]
  lights: Light[]
  reduced: boolean
  /** floor disc radius as a multiple of the model radius */
  floorExtent: number
  /** fan spin multiplier, 0 stops the blades */
  spin: number
}

type Lane = { len: number; phases: number[]; samples: Float32Array; speed: number }
type BeamPre = { F: Vec3; D: Vec3; U: Vec3; V: Vec3; tan: number; L: number; I: number; foot: Vec3[]; footIn: Vec3[]; far: Vec3 }
type LightPre = { at: Vec3; rgb: RGB; I: number; r: number; cone: boolean }

const LAYER = {
  mesh: { a: 0.2, lw: 0.55, ga: 0, glw: 0 },
  shell: { a: 0.5, lw: 0.8, ga: 0.16, glw: 3 },
  fg: { a: 0.95, lw: 1.15, ga: 0.6, glw: 3.6 },
  hot: { a: 0.92, lw: 1.0, ga: 0.75, glw: 3.2 },
  acc2: { a: 1, lw: 2.4, ga: 1, glw: 7 },
} as const

// depth fade: front of the model -> back, as the minimum alpha multiplier at the far side
const DEPTH_MIN = 0.26
const DEPTH_MIN_HOT = 0.45
const DOT_LV = 6
const LIT_LV = 4
const TINT_LV = 3
const FLOW_LV = 5
const LANE_N = 40
const WARM: RGB = [255, 244, 220]
// beam volume layers [cone width factor, alpha]: many thin steps read as a round falloff
const BEAM_GLOW: [number, number][] = [[1.15, 0.05], [1, 0.06], [0.86, 0.07], [0.72, 0.08], [0.58, 0.09], [0.44, 0.09], [0.3, 0.08]]
const BEAM_CORE: [number, number][] = [[0.42, 0.035], [0.3, 0.04], [0.18, 0.05]]

/** Monotone-chain convex hull over flat [x0, y0, x1, y1, ...]. Returns flat hull. */
function hull(pts: number[]): number[] {
  const n = pts.length / 2
  if (n < 3) return pts
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1])
  const crossZ = (o: number, a: number, b: number) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2])
  const lower: number[] = []
  for (const i of idx) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i) }
  const upper: number[] = []
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i) }
  upper.pop(); lower.pop()
  const out: number[] = []
  for (const i of lower.concat(upper)) out.push(pts[i * 2], pts[i * 2 + 1])
  return out
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000 }
}

export class Renderer {
  sharp: CanvasRenderingContext2D
  glow: CanvasRenderingContext2D
  w = 1
  h = 1
  dpr = 1
  gs = 0.5
  model!: Compiled
  time = 0
  // palette (tweened)
  fg: RGB = [244, 244, 244]
  hot: RGB = [240, 180, 74]
  acc2: RGB = [255, 42, 42]
  private palFrom: RGB[] = []
  private palTo: RGB[] = []
  private palT0 = -1
  // floor
  private spacing = 0.4
  private floorR = 12
  private dotX = new Float32Array(0)
  private dotZ = new Float32Array(0)
  private dotLit = new Float32Array(0)
  private dotTint: Float32Array[] = []
  private litKey = ''
  private dotBuf: Float32Array[] = []
  private dotCnt = new Int32Array(DOT_LV + LIT_LV)
  private tintBuf: Float32Array[] = []
  private tintCnt = new Int32Array(0)
  private floorKey = ''
  // fx caches
  private beamKey = ''
  private beamRef: Beam[] | null = null
  private lightRef: Light[] | null = null
  private flowRef: Flow[] | null = null
  private beams: BeamPre[] = []
  private lightKey = ''
  private lights: LightPre[] = []
  private flowKey = ''
  private lanes: Lane[] = []
  private flowBuf: Float32Array[] = Array.from({ length: FLOW_LV }, () => new Float32Array(4096))
  private flowCnt = new Int32Array(FLOW_LV)
  private scratch = new Float32Array(3)
  private depthSpan = new Float32Array(0)
  private cacheS: CanvasRenderingContext2D | null = null
  private cacheG: CanvasRenderingContext2D | null = null
  private cacheKey = ''
  private lastFloorKey = ''
  private fxVersion = 0
  private modelVersion = 0
  stats = { segs: 0, dots: 0, tFloor: 0, tSegs: 0, tDraw: 0, tFx: 0 }

  constructor(sharp: HTMLCanvasElement, glow: HTMLCanvasElement) {
    this.sharp = sharp.getContext('2d', { alpha: true })!
    this.glow = glow.getContext('2d', { alpha: true })!
  }

  resize(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w); this.h = Math.max(1, h); this.dpr = dpr
    const s = this.sharp.canvas, g = this.glow.canvas
    s.width = Math.round(this.w * dpr); s.height = Math.round(this.h * dpr)
    this.gs = Math.min(0.5, 700 / Math.max(this.w, this.h)) // cap the glow buffer on big screens
    g.width = Math.max(1, Math.round(this.w * this.gs)); g.height = Math.max(1, Math.round(this.h * this.gs))
    if (typeof document !== 'undefined') {
      const cs = this.cacheS?.canvas ?? document.createElement('canvas')
      const cg = this.cacheG?.canvas ?? document.createElement('canvas')
      cs.width = s.width; cs.height = s.height
      cg.width = g.width; cg.height = g.height
      this.cacheS = cs.getContext('2d')
      this.cacheG = cg.getContext('2d')
    }
    this.cacheKey = ''
  }

  setModel(c: Compiled, extent: number) {
    this.model = c
    this.modelVersion++
    this.depthSpan = new Float32Array(0)
    const key = `${c.radius}|${extent}`
    if (key === this.floorKey) return
    this.floorKey = key
    const s = (this.spacing = c.radius * 0.085)
    const R = (this.floorR = c.radius * extent)
    const N = Math.ceil(R / s)
    const xs: number[] = [], zs: number[] = []
    for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) if (i * i + j * j <= (N + 1) * (N + 1)) { xs.push(i * s); zs.push(j * s) }
    this.dotX = Float32Array.from(xs)
    this.dotZ = Float32Array.from(zs)
    this.dotLit = new Float32Array(xs.length)
    this.dotBuf = Array.from({ length: DOT_LV + LIT_LV }, () => new Float32Array(xs.length * 3))
    this.litKey = ''
    this.tintBuf = []
    this.lightKey = ''
    this.lightRef = null
    this.flowRef = null
    this.flowKey = ''
  }

  setPalette(p: Palette, now: number, instant: boolean) {
    const to = [parseColor(p.fg), parseColor(p.hot), parseColor(p.acc2)]
    if (instant || this.palT0 < 0 && this.palTo.length === 0) {
      ;[this.fg, this.hot, this.acc2] = to
      this.palTo = to
      this.palT0 = -1
      return
    }
    this.palFrom = [this.fg, this.hot, this.acc2]
    this.palTo = to
    this.palT0 = now
  }

  get colorTweening() { return this.palT0 >= 0 }

  private stepPalette(now: number) {
    if (this.palT0 < 0) return
    const k = clamp((now - this.palT0) / 450, 0, 1)
    const e = k * k * (3 - 2 * k)
    this.fg = mixRGB(this.palFrom[0], this.palTo[0], e)
    this.hot = mixRGB(this.palFrom[1], this.palTo[1], e)
    this.acc2 = mixRGB(this.palFrom[2], this.palTo[2], e)
    if (k >= 1) this.palT0 = -1
  }

  /** Nearest camera depth a beam may reach before it is cut and faded. */
  private zSafe(cam: Camera): number {
    return Math.max(NEAR * 6, cam.dist * 0.42)
  }

  /** How far along its axis a beam can run before its cone comes closer to the camera than zSafe. */
  private beamReach(b: BeamPre, cam: Camera): number {
    const z0 = (b.F[0] - cam.px) * cam.fx + (b.F[1] - cam.py) * cam.fy + (b.F[2] - cam.pz) * cam.fz
    // depth lost per unit of t: the axis moving toward the camera plus the cone opening up
    const k = -(b.D[0] * cam.fx + b.D[1] * cam.fy + b.D[2] * cam.fz) + b.tan * 1.1
    if (k <= 1e-4) return b.L
    return clamp((z0 - this.zSafe(cam)) / k, 0, b.L)
  }

  // ---------- fx preparation (cached by content) ----------

  private prepBeams(beams: Beam[]) {
    if (beams === this.beamRef) return
    this.beamRef = beams
    const key = JSON.stringify(beams)
    if (key === this.beamKey) return
    this.beamKey = key
    this.litKey = ''
    this.fxVersion++
    this.beams = beams.map((b) => {
      const D = norm(b.dir)
      const helper: Vec3 = Math.abs(D[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
      const U = norm(cross(D, helper))
      const V = norm(cross(U, D))
      const tan = Math.tan((b.spread * Math.PI) / 180)
      const F = b.from, L = b.length
      // floor footprints (outer and inner): boundary rays hit the floor, or stop at L dropped to the floor
      const footprint = (f: number): Vec3[] => {
        const foot: number[] = [F[0], F[2]]
        for (let k = 0; k < 48; k++) {
          const a = (k / 48) * Math.PI * 2
          for (const g of [0.5 * f, f]) {
            const r = add(D, add(scale(U, Math.cos(a) * tan * g), scale(V, Math.sin(a) * tan * g)))
            const rn = norm(r)
            let t = rn[1] < -1e-3 ? -F[1] / rn[1] : Infinity
            if (t > L * 1.05) t = L * 1.05
            const p = add(F, scale(rn, t))
            foot.push(p[0], p[2])
          }
        }
        const hh = hull(foot)
        const pts: Vec3[] = []
        for (let i = 0; i < hh.length; i += 2) pts.push([hh[i], 0, hh[i + 1]])
        return pts
      }
      const far = add(F, scale(D, L))
      return { F, D, U, V, tan, L, I: b.intensity ?? 1, foot: footprint(1.1), footIn: footprint(0.6), far: [far[0], 0, far[2]] as Vec3 }
    })
  }

  private prepLights(lights: Light[]) {
    if (lights === this.lightRef) return
    this.lightRef = lights
    const key = JSON.stringify(lights)
    if (key === this.lightKey) return
    this.lightKey = key
    this.litKey = ''
    this.fxVersion++
    this.lights = lights.map((l) => ({ at: l.at, rgb: parseColor(l.color), I: clamp(l.intensity, 0, 1), r: l.radius ?? this.model.radius * 0.4, cone: l.cone ?? true }))
    const n = this.dotX.length
    this.dotTint = this.lights.map(() => new Float32Array(n))
    this.tintBuf = this.lights.flatMap(() => Array.from({ length: TINT_LV }, () => new Float32Array(n * 3)))
    this.tintCnt = new Int32Array(this.tintBuf.length)
  }

  private prepFlow(flow: Flow[]) {
    if (flow === this.flowRef) return
    this.flowRef = flow
    const key = JSON.stringify(flow)
    if (key === this.flowKey) return
    this.flowKey = key
    const rnd = seeded(7)
    const jit = (s: number): Vec3 => [(rnd() - 0.5) * 2 * s, (rnd() - 0.5) * 2 * s, (rnd() - 0.5) * 2 * s]
    this.lanes = []
    for (const f of flow) {
      const n = f.lanes ?? 9
      const spread = f.spread ?? this.model.radius * 0.12
      const d = len(sub(f.to, f.from))
      const via = f.via ?? add(scale(add(f.from, f.to), 0.5), [0, d * 0.18, 0])
      const dir = norm(sub(f.to, f.from))
      for (let k = 0; k < n; k++) {
        // one shared offset per lane keeps the bundle parallel, like streamlines
        const o = jit(spread)
        const p0 = add(add(f.from, o), jit(spread * 0.15))
        const p3 = add(add(f.to, scale(o, 1.25)), jit(spread * 0.2))
        const v = add(add(via, scale(o, 0.9)), jit(spread * 0.12))
        const p1 = add(p0, scale(sub(v, p0), 0.85))
        const p2 = add(p3, scale(sub(v, p3), 0.85))
        // a slow sideways wave so the lines read as air, not rulers
        const side = norm(cross(dir, norm(jit(1))))
        const amp = spread * (0.25 + rnd() * 0.25), freq = 1 + rnd() * 1.2, ph = rnd() * 6.28
        const samples = new Float32Array((LANE_N + 1) * 3)
        let L = 0
        let prev = p0
        for (let i = 0; i <= LANE_N; i++) {
          const t = i / LANE_N
          const q = add(bezier(p0, p1, p2, p3, t), scale(side, amp * Math.sin(t * Math.PI * 2 * freq + ph) * Math.sin(t * Math.PI)))
          samples.set(q, i * 3)
          L += len(sub(q, prev)); prev = q
        }
        this.lanes.push({ len: Math.max(0.1, L), phases: [rnd(), rnd()], samples, speed: f.speed })
      }
    }
    const need = this.lanes.reduce((a, l) => a + l.phases.length, 0) * 4 * 6 + 8
    if (this.flowBuf[0].length < need) this.flowBuf = Array.from({ length: FLOW_LV }, () => new Float32Array(need))
  }

  private computeLit(gx: number, gz: number) {
    const n = this.dotX.length
    const lit = this.dotLit
    for (let i = 0; i < n; i++) {
      const wx = gx + this.dotX[i], wz = gz + this.dotZ[i]
      let v = 0
      for (const b of this.beams) {
        const vx = wx - b.F[0], vy = -b.F[1], vz = wz - b.F[2]
        const t = vx * b.D[0] + vy * b.D[1] + vz * b.D[2]
        if (t <= 0 || t > b.L) continue
        const lx = vx - t * b.D[0], ly = vy - t * b.D[1], lz = vz - t * b.D[2]
        const l = Math.sqrt(lx * lx + ly * ly + lz * lz)
        const rt = t * b.tan + 0.12
        const q = l / rt
        if (q >= 1.2) continue
        const e = (1 - smooth(0.55, 1.2, q)) * (1 - smooth(0.15 * b.L, b.L, t)) * b.I
        v = v + e - v * e
      }
      lit[i] = v
    }
    this.lights.forEach((L, k) => {
      const tint = this.dotTint[k]
      const R = L.r * 1.35
      for (let i = 0; i < n; i++) {
        const dx = gx + this.dotX[i] - L.at[0], dz = gz + this.dotZ[i] - L.at[2]
        const d = Math.sqrt(dx * dx + dz * dz)
        tint[i] = d >= R ? 0 : (1 - smooth(0, R, d)) * L.I
      }
    })
  }

  // ---------- the frame ----------

  frame(now: number, dt: number, cam: Camera, fx: Fx) {
    const c = this.model
    const S = this.sharp, G = this.glow
    const dpr = this.dpr, gs = this.gs
    this.stepPalette(now)
    if (!fx.reduced) this.time += dt
    const time = this.time
    const fg = this.fg, hot = this.hot, acc2 = this.acc2
    // red is far darker than white at the same alpha: lift the faint layers so the floor still reads
    const lum = (0.2126 * fg[0] + 0.7152 * fg[1] + 0.0722 * fg[2]) / 255
    const comp = clamp(Math.sqrt(0.8 / Math.max(0.05, lum)), 1, 1.7)

    cam.basis(this.w, this.h)
    const { px, py, pz, rx, rz, ux, uy, uz, fx: fwx, fy: fwy, fz: fwz, focal, ox, oy } = cam
    const ry = cam.ry
    const W = this.w, H = this.h

    S.setTransform(1, 0, 0, 1, 0, 0)
    S.globalCompositeOperation = 'source-over'
    S.clearRect(0, 0, S.canvas.width, S.canvas.height)
    G.setTransform(1, 0, 0, 1, 0, 0)
    G.globalCompositeOperation = 'source-over'
    G.clearRect(0, 0, G.canvas.width, G.canvas.height)
    S.setTransform(dpr, 0, 0, dpr, 0, 0)
    G.setTransform(gs, 0, 0, gs, 0, 0)
    S.globalCompositeOperation = 'lighter'
    G.globalCompositeOperation = 'lighter'
    S.lineCap = 'round'
    G.lineCap = 'round'

    const heatOf = (g: string | null): number => {
      if (!g) return 0.5
      const h = fx.heat?.[g] ?? fx.heat?.[g.split('.')[0]]
      return clamp(h ?? 0.35, 0, 1)
    }

    this.prepBeams(fx.beams)
    this.prepLights(fx.lights)
    if (!fx.reduced) this.prepFlow(fx.flow)

    const out = this.scratch
    const proj = (x: number, y: number, z: number): boolean => cam.project(x, y, z, out)

    const pool = (ctx: CanvasRenderingContext2D, at: Vec3, rxw: number, rzw: number, rgb: RGB, a: number) => {
      if (!proj(at[0], 0, at[2])) return
      const cx0 = out[0], cy0 = out[1]
      if (!proj(at[0] + rxw, 0, at[2])) return
      const ax = out[0] - cx0, ay = out[1] - cy0
      if (!proj(at[0], 0, at[2] + rzw)) return
      const bx = out[0] - cx0, by = out[1] - cy0
      ctx.save()
      ctx.transform(ax, ay, bx, by, cx0, cy0)
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
      g.addColorStop(0, rgba(rgb, a))
      g.addColorStop(0.45, rgba(rgb, a * 0.35))
      g.addColorStop(1, rgba(rgb, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(0, 0, 1, 0, 6.2832)
      ctx.fill()
      ctx.restore()
    }

    const polyFill = (ctx: CanvasRenderingContext2D, flat: number[], from: [number, number], to: [number, number], stops: [number, number][], rgb: RGB) => {
      if (flat.length < 6) return
      const g = ctx.createLinearGradient(from[0], from[1], to[0], to[1])
      for (const [o, a] of stops) g.addColorStop(o, rgba(rgb, a))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(flat[0], flat[1])
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1])
      ctx.closePath()
      ctx.fill()
    }

    // The floor (dots, washes, pools) depends only on the camera, the fx and the
    // palette. When the camera holds still it is painted once into a cache and
    // blitted; while it moves it is painted straight into the frame.
    const paintFloor = (S: CanvasRenderingContext2D, G: CanvasRenderingContext2D) => {
      // ---- floor dots ----
      let dots = 0
      if (fx.floor) {
        const s = this.spacing, R = this.floorR
        const gx = Math.round(cam.tx / s) * s, gz = Math.round(cam.tz / s) * s
        const key = `${gx.toFixed(3)}|${gz.toFixed(3)}|${this.beamKey.length}|${this.beamKey}|${this.lightKey}`
        if (key !== this.litKey) { this.litKey = key; this.computeLit(gx, gz) }
        const n = this.dotX.length
        const cnt = this.dotCnt
        cnt.fill(0)
        const tc = this.tintCnt
        tc.fill(0)
        const nl = this.lights.length
        const dotR = s * 0.065
        const fadeFar = cam.dist * 1.9
        const litNear = this.zSafe(cam)
        const tx = cam.tx, tz = cam.tz
        for (let i = 0; i < n; i++) {
          const wx = gx + this.dotX[i], wz = gz + this.dotZ[i]
          const ddx = wx - tx, ddz = wz - tz
          const rr = Math.sqrt(ddx * ddx + ddz * ddz) / R
          if (rr >= 1) continue
          const dx = wx - px, dy = -py, dz = wz - pz
          const zc = dx * fwx + dy * fwy + dz * fwz
          if (zc < NEAR) continue
          const xc = dx * rx + dy * ry + dz * rz
          const yc = dx * ux + dy * uy + dz * uz
          const sx = ox + (xc * focal) / zc, sy = oy - (yc * focal) / zc
          if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue
          const radial = 1 - smooth(0.12, 1, rr)
          const depth = clamp(1.3 - zc / fadeFar, 0.06, 1)
          let r = (dotR * focal) / zc
          r = r < 0.5 ? 0.5 : r > 1.6 ? 1.6 : r
          const base = radial * depth
          // beam light fades out where the beam itself is cut (close to the camera)
          const lit = this.dotLit[i] * radial * smooth(litNear * 0.75, litNear * 1.25, zc)
          dots++
          if (lit > 0.04) {
            const lv = Math.min(LIT_LV - 1, (lit * LIT_LV) | 0)
            const buf = this.dotBuf[DOT_LV + lv], k = cnt[DOT_LV + lv]
            buf[k] = sx; buf[k + 1] = sy; buf[k + 2] = Math.min(2.4, r * (1 + lit * 0.7))
            cnt[DOT_LV + lv] = k + 3
          } else {
            const lv = Math.min(DOT_LV - 1, (base * DOT_LV) | 0)
            const buf = this.dotBuf[lv], k = cnt[lv]
            buf[k] = sx; buf[k + 1] = sy; buf[k + 2] = r
            cnt[lv] = k + 3
          }
          for (let L = 0; L < nl; L++) {
            const t = this.dotTint[L][i] * radial
            if (t < 0.05) continue
            const lv = Math.min(TINT_LV - 1, (t * TINT_LV) | 0)
            const bi = L * TINT_LV + lv
            const buf = this.tintBuf[bi], k = tc[bi]
            buf[k] = sx; buf[k + 1] = sy; buf[k + 2] = r * 1.25
            tc[bi] = k + 3
          }
        }
        const fillDots = (ctx: CanvasRenderingContext2D, buf: Float32Array, count: number, style: string) => {
          if (!count) return
          ctx.fillStyle = style
          ctx.beginPath()
          for (let k = 0; k < count; k += 3) {
            const x = buf[k], y = buf[k + 1], r = buf[k + 2]
            ctx.moveTo(x + r, y)
            ctx.arc(x, y, r, 0, 6.2832)
          }
          ctx.fill()
        }
        for (let lv = 0; lv < DOT_LV; lv++) fillDots(S, this.dotBuf[lv], cnt[lv], rgba(fg, ((lv + 0.6) / DOT_LV) * 0.85 * comp))
        for (let lv = 0; lv < LIT_LV; lv++) {
          fillDots(S, this.dotBuf[DOT_LV + lv], cnt[DOT_LV + lv], rgba(fg, 0.55 + ((lv + 1) / LIT_LV) * 0.45))
          if (lv >= 1) fillDots(G, this.dotBuf[DOT_LV + lv], cnt[DOT_LV + lv], rgba(fg, ((lv + 1) / LIT_LV) * 0.5))
        }
        for (let L = 0; L < nl; L++) for (let lv = 0; lv < TINT_LV; lv++) {
          const bi = L * TINT_LV + lv
          fillDots(S, this.tintBuf[bi], tc[bi], rgba(this.lights[L].rgb, ((lv + 1) / TINT_LV) * 0.9))
        }
      }
      this.stats.dots = dots

      for (const b of this.beams) {
        // floor wash: outer soft footprint + brighter inner core. Footprint
        // points closer to the camera than zSafe are pulled back toward the
        // beam's foot, so a beam aimed past the camera never turns into a hard
        // screen-wide wedge; most of the wash goes to the blurred layer.
        const Le = this.beamReach(b, cam)
        if (Le < b.L * 0.12) continue
        const zSafe = this.zSafe(cam)
        const d0 = (b.F[0] - px) * fwx - py * fwy + (b.F[2] - pz) * fwz
        if (d0 <= zSafe || !proj(b.F[0], 0, b.F[2])) continue
        const a0: [number, number] = [out[0], out[1]]
        if (!proj(b.F[0] + b.D[0] * Le, 0, b.F[2] + b.D[2] * Le)) continue
        const a1: [number, number] = [out[0], out[1]]
        for (const [foot, k] of [[b.foot, 0.1], [b.footIn, 0.12]] as const) {
          const flat: number[] = []
          let ok = true
          for (const p of foot) {
            let x = p[0], z = p[2]
            const d = (x - px) * fwx - py * fwy + (z - pz) * fwz
            if (d < zSafe) {
              const s = (d0 - zSafe) / (d0 - d)
              x = b.F[0] + (x - b.F[0]) * s
              z = b.F[2] + (z - b.F[2]) * s
            }
            if (!proj(x, 0, z)) { ok = false; break }
            flat.push(out[0], out[1])
          }
          if (!ok) continue
          const hh = hull(flat)
          polyFill(G, hh, a0, a1, [[0, k * 2.2 * b.I], [0.35, k * 1.1 * b.I], [1, 0]], fg)
          polyFill(S, hh, a0, a1, [[0, k * 0.7 * b.I], [0.3, k * 0.3 * b.I], [0.8, 0]], fg)
        }
      }
      for (const L of this.lights) {
        pool(S, L.at, L.r, L.r, L.rgb, 0.3 * L.I)
        pool(G, L.at, L.r * 0.8, L.r * 0.8, L.rgb, 0.35 * L.I)
      }
      if (c.acc2 && c.acc2.y < 2) {
        const k = clamp(1 - c.acc2.y / 2.5, 0.2, 1)
        pool(S, [c.acc2.x, 0, c.acc2.z], c.acc2.rx + 0.9, c.acc2.rz + 0.9, acc2, 0.28 * k)
        pool(G, [c.acc2.x, 0, c.acc2.z], c.acc2.rx + 0.6, c.acc2.rz + 0.6, acc2, 0.3 * k)
      }
    }

    const T0 = performance.now()
    const fkey = `${px},${py},${pz},${fwx},${fwy},${fwz},${focal},${ox},${oy},${W},${H},${dpr},${fg},${acc2},${this.fxVersion},${this.modelVersion},${fx.floor}`
    if (fkey === this.lastFloorKey && this.cacheS && this.cacheG) {
      const cS = this.cacheS, cG = this.cacheG
      if (fkey !== this.cacheKey) {
        cS.setTransform(1, 0, 0, 1, 0, 0); cS.globalCompositeOperation = 'source-over'; cS.clearRect(0, 0, cS.canvas.width, cS.canvas.height)
        cG.setTransform(1, 0, 0, 1, 0, 0); cG.globalCompositeOperation = 'source-over'; cG.clearRect(0, 0, cG.canvas.width, cG.canvas.height)
        cS.setTransform(dpr, 0, 0, dpr, 0, 0); cS.globalCompositeOperation = 'lighter'
        cG.setTransform(gs, 0, 0, gs, 0, 0); cG.globalCompositeOperation = 'lighter'
        paintFloor(cS, cG)
        this.cacheKey = fkey
      }
      S.drawImage(cS.canvas, 0, 0, W, H)
      G.drawImage(cG.canvas, 0, 0, W, H)
    } else {
      paintFloor(S, G)
    }
    this.lastFloorKey = fkey

    const T1 = performance.now()
    // ---- model segments ----
    if (!fx.reduced && fx.spin > 0 && c.spins.length) applySpins(c, (g) => heatOf(g), dt, fx.spin)
    const P = c.work, ST = c.style, WT = c.wt, buckets = c.buckets, counts = c.counts
    counts.fill(0)
    const span = this.depthSpan.length === c.styles.length ? this.depthSpan
      : (this.depthSpan = Float32Array.from(c.styles, (st) => 1 - (st.layer === 'hot' || st.layer === 'acc2' ? DEPTH_MIN_HOT : DEPTH_MIN)))
    // depth normalisation around the model center (not the target, which may sit elsewhere)
    const mcx = c.center[0] - px, mcy = c.center[1] - py, mcz = c.center[2] - pz
    const zMid = mcx * fwx + mcy * fwy + mcz * fwz
    const invR = 1 / c.radius
    let drawn = 0
    for (let i = 0, n = c.n; i < n; i++) {
      const o = i * 6
      let dx = P[o] - px, dy = P[o + 1] - py, dz = P[o + 2] - pz
      let za = dx * fwx + dy * fwy + dz * fwz
      let xa = dx * rx + dy * ry + dz * rz
      let ya = dx * ux + dy * uy + dz * uz
      dx = P[o + 3] - px; dy = P[o + 4] - py; dz = P[o + 5] - pz
      let zb = dx * fwx + dy * fwy + dz * fwz
      let xb = dx * rx + dy * ry + dz * rz
      let yb = dx * ux + dy * uy + dz * uz
      if (za < NEAR) {
        if (zb < NEAR) continue
        const t = (NEAR - za) / (zb - za)
        xa += (xb - xa) * t; ya += (yb - ya) * t; za = NEAR
      } else if (zb < NEAR) {
        const t = (NEAR - zb) / (za - zb)
        xb += (xa - xb) * t; yb += (ya - yb) * t; zb = NEAR
      }
      const sxa = ox + (xa * focal) / za, sya = oy - (ya * focal) / za
      const sxb = ox + (xb * focal) / zb, syb = oy - (yb * focal) / zb
      if ((sxa < 0 && sxb < 0) || (sxa > W && sxb > W) || (sya < 0 && syb < 0) || (sya > H && syb > H)) continue
      let d = (((za + zb) * 0.5 - zMid) * invR + 1) * 0.5
      d = d < 0 ? 0 : d > 1 ? 1 : d
      const si = ST[i]
      const k = si * NL + levelOf(WT[i] * (1 - d * span[si]))
      const buf = buckets[k]
      const ci = counts[k]
      buf[ci] = sxa; buf[ci + 1] = sya; buf[ci + 2] = sxb; buf[ci + 3] = syb
      counts[k] = ci + 4
      drawn++
    }
    this.stats.segs = drawn
    const T2 = performance.now()

    const strokeBucket = (ctx: CanvasRenderingContext2D, buf: Float32Array, count: number) => {
      ctx.beginPath()
      for (let k = 0; k < count; k += 4) { ctx.moveTo(buf[k], buf[k + 1]); ctx.lineTo(buf[k + 2], buf[k + 3]) }
      ctx.stroke()
    }

    const pulseT = time * ((Math.PI * 2) / 2.6)
    c.styles.forEach((st, si) => {
      const L = LAYER[st.layer]
      let rgb: RGB
      let a = L.a * (st.layer === 'mesh' || st.layer === 'shell' ? comp : 1)
      let ga = L.ga
      if (st.layer === 'hot') {
        const h = st.group ? heatOf(st.group) : 0.5
        const ph = st.group ? (st.group.charCodeAt(0) * 1.7 + st.group.length) : 0
        const pulse = fx.reduced ? 1 : 1 + 0.22 * h * Math.sin(pulseT + ph)
        const k = st.group ? 0.22 + 0.78 * h : 0.55
        a *= k * pulse
        ga *= (st.group ? 0.12 + 0.88 * Math.pow(h, 1.3) : 0.35) * pulse
        rgb = mixRGB(hot, WARM, h * 0.32)
      } else if (st.layer === 'acc2') {
        rgb = acc2
      } else {
        rgb = fg
      }
      // only the bright levels go into the bloom pass: fine detail costs strokes and muddies the glow
      const glowLevels = st.layer === 'shell' ? 1 : 2
      for (let b = 0; b < NL; b++) {
        const cnt = counts[si * NL + b]
        if (!cnt) continue
        const buf = buckets[si * NL + b]
        S.strokeStyle = rgba(rgb, a * LV[b])
        S.lineWidth = L.lw
        strokeBucket(S, buf, cnt)
        if (b <= glowLevels && ga > 0.02) {
          G.strokeStyle = rgba(rgb, ga * LV[b])
          G.lineWidth = L.glw
          strokeBucket(G, buf, cnt)
        }
      }
    })

    const T3 = performance.now()
    // ---- glass faces (fresnel) ----
    for (const f of c.faces) {
      const st = c.styles[f.style]
      const rgb = st.layer === 'hot' ? hot : st.layer === 'acc2' ? acc2 : fg
      const vx = f.c[0] - px, vy = f.c[1] - py, vz = f.c[2] - pz
      const vl = Math.hypot(vx, vy, vz) || 1
      const cosT = Math.abs((vx * f.n[0] + vy * f.n[1] + vz * f.n[2]) / vl)
      const a = 0.05 * f.w * (0.35 + 1.4 * Math.pow(1 - cosT, 2))
      const flat: number[] = []
      let ok = true
      for (let i = 0; i < f.pts.length; i += 3) { if (!proj(f.pts[i], f.pts[i + 1], f.pts[i + 2])) { ok = false; break } flat.push(out[0], out[1]) }
      if (!ok || flat.length < 6) continue
      // diagonal sheen from the first corner to the third
      polyFill(S, flat, [flat[0], flat[1]], [flat[4], flat[5]], [[0, a * 1.6], [0.45, a * 0.35], [0.7, a * 0.9], [1, a * 0.25]], rgb)
    }

    // ---- flow streamlines ----
    if (!fx.reduced && this.lanes.length) {
      const fb = this.flowBuf, fc = this.flowCnt
      fc.fill(0)
      S.beginPath()
      for (const lane of this.lanes) {
        let started = false
        for (let i = 0; i <= LANE_N; i++) {
          if (!proj(lane.samples[i * 3], lane.samples[i * 3 + 1], lane.samples[i * 3 + 2])) { started = false; continue }
          if (!started) { S.moveTo(out[0], out[1]); started = true } else S.lineTo(out[0], out[1])
        }
      }
      S.strokeStyle = rgba(fg, 0.09)
      S.lineWidth = 0.5
      S.stroke()
      const pts = new Float32Array(14)
      for (const lane of this.lanes) {
        const speed = lane.speed
        const trail = Math.min(0.25, (this.model.radius * 0.38) / lane.len)
        for (const ph of lane.phases) {
          const t = (ph + (time * speed) / lane.len) % 1
          const fade = smooth(0, 0.12, t) * (1 - smooth(0.82, 1, t))
          if (fade < 0.03) continue
          let okAll = true
          const sm = lane.samples
          for (let k = 0; k <= 5; k++) {
            const tt = Math.max(0, t - trail * (1 - k / 5)) * LANE_N
            const i0 = Math.min(LANE_N - 1, tt | 0), fr = tt - i0, a = i0 * 3, b = a + 3
            if (!proj(sm[a] + (sm[b] - sm[a]) * fr, sm[a + 1] + (sm[b + 1] - sm[a + 1]) * fr, sm[a + 2] + (sm[b + 2] - sm[a + 2]) * fr)) { okAll = false; break }
            pts[k * 2] = out[0]; pts[k * 2 + 1] = out[1]
          }
          if (!okAll) continue
          for (let k = 0; k < 5; k++) {
            const a = ((k + 1) / 5) * fade
            const lv = Math.min(FLOW_LV - 1, Math.max(0, Math.ceil(a * FLOW_LV) - 1))
            const buf = fb[lv], ci = fc[lv]
            if (ci + 4 > buf.length) continue
            buf[ci] = pts[k * 2]; buf[ci + 1] = pts[k * 2 + 1]; buf[ci + 2] = pts[k * 2 + 2]; buf[ci + 3] = pts[k * 2 + 3]
            fc[lv] = ci + 4
          }
        }
      }
      for (let lv = 0; lv < FLOW_LV; lv++) {
        if (!fc[lv]) continue
        const a = (lv + 1) / FLOW_LV
        S.strokeStyle = rgba(fg, 0.5 * a * a)
        S.lineWidth = 0.55 + a * 0.45
        strokeBucket(S, fb[lv], fc[lv])
        if (lv >= 3) {
          G.strokeStyle = rgba(fg, 0.35 * a)
          G.lineWidth = 2.2
          strokeBucket(G, fb[lv], fc[lv])
        }
      }
    }

    // ---- beam volumes: many thin nested cones fake a soft, round falloff ----
    // The cone is cut where it would come closer to the camera than zSafe and
    // its gradient reaches zero there, so a beam aimed past the camera fades out
    // instead of filling the screen with hard wedges.
    for (const b of this.beams) {
      const Le = this.beamReach(b, cam)
      if (Le < b.L * 0.12) continue
      if (!proj(b.F[0], b.F[1], b.F[2])) continue
      const apex: [number, number] = [out[0], out[1]]
      const far = add(b.F, scale(b.D, Le))
      if (!proj(far[0], Math.max(0, far[1]), far[2])) continue
      const to: [number, number] = [out[0], out[1]]
      const cone = (f: number): number[] => {
        const flat: number[] = [apex[0], apex[1]]
        const R = Le * b.tan * f
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * Math.PI * 2
          let p = add(far, add(scale(b.U, Math.cos(a) * R), scale(b.V, Math.sin(a) * R)))
          if (p[1] < 0) {
            // clip the cone at the floor: slide back along the ray to y = 0
            const d = sub(p, b.F)
            p = add(b.F, scale(d, -b.F[1] / d[1]))
          }
          if (proj(p[0], p[1], p[2])) flat.push(out[0], out[1])
        }
        return hull(flat)
      }
      // the blurred layer carries the body (soft edges for free); the sharp layer only a faint narrow core
      for (const [f, a] of BEAM_GLOW) {
        polyFill(G, cone(f), apex, to, [[0, a * 2.4 * b.I], [0.25, a * b.I], [0.6, a * 0.3 * b.I], [1, 0]], fg)
      }
      for (const [f, a] of BEAM_CORE) {
        polyFill(S, cone(f), apex, to, [[0, a * 2.5 * b.I], [0.18, a * b.I], [0.45, a * 0.22 * b.I], [0.85, 0]], fg)
      }
    }

    // ---- bulbs: cones and sprites ----
    for (const L of this.lights) {
      if (!proj(L.at[0], L.at[1], L.at[2])) continue
      const sx = out[0], sy = out[1], z = out[2]
      if (L.cone) {
        const flat: number[] = [sx, sy]
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2
          if (proj(L.at[0] + Math.cos(a) * L.r * 0.8, 0, L.at[2] + Math.sin(a) * L.r * 0.8)) flat.push(out[0], out[1])
        }
        if (proj(L.at[0], 0, L.at[2])) {
          polyFill(S, hull(flat), [sx, sy], [out[0], out[1]], [[0, 0.26 * L.I], [0.6, 0.08 * L.I], [1, 0.02 * L.I]], L.rgb)
        }
      }
      const r = clamp((this.model.radius * 0.22 * focal) / z, 6, 60)
      for (const [ctx, rr, a] of [[S, r, 0.95], [G, r * 1.6, 0.8]] as const) {
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr)
        g.addColorStop(0, rgba(mixRGB(L.rgb, [255, 255, 255], 0.55), a * L.I))
        g.addColorStop(0.18, rgba(L.rgb, a * 0.7 * L.I))
        g.addColorStop(1, rgba(L.rgb, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(sx, sy, rr, 0, 6.2832)
        ctx.fill()
      }
    }
    const T4 = performance.now()
    const k = 0.1
    this.stats.tFloor += (T1 - T0 - this.stats.tFloor) * k
    this.stats.tSegs += (T2 - T1 - this.stats.tSegs) * k
    this.stats.tDraw += (T3 - T2 - this.stats.tDraw) * k
    this.stats.tFx += (T4 - T3 - this.stats.tFx) * k
  }
}
