// A 2026 Tesla Model Y (the Juniper refresh) in x-ray, for the cars on System >
// Hosts. Proportions from the published dimensions: 4,790 mm long, 1,920 mm
// wide without the mirrors, 1,624 mm high, a 2,890 mm wheelbase, 167 mm of
// ground clearance and 255/45 R19 tires. Shapes borrowed from the photos, not
// the decoration: a sleek crossover with a fastback roof, one glass sweep from
// the windshield over the cabin, the full-width light bar across the nose with
// the headlamps low in the bumper corners, and the full-width light bar across
// the tail joining the two C-shaped lamps. The charge port is on the left rear
// (the driver's side), just ahead of the left lamp.
//
// Built in meters and scaled to the shared ~4 unit radius. The nose faces +z,
// the car's left (the driver's side in the US) is +x, the floor is y = 0.
//
// Groups: battery (the pack under the floor) and battery.c0..c9 (its ten
// module bands, lit from the rear as the charge rises), charge (the port and
// its cable to the pack), lights (the light bars and lamps, lit while the car
// is awake), cabin (the center screen and the ambient strip).

import { cross, norm, type Model, type Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

/** meters to model units */
const K = 1.46
/** half length; front and rear axle z; wheel radius, 19 in rim radius, wheel center x, tire width */
const L2 = 2.395
const ZF = 1.475, ZR = -1.415
const WR = 0.356, RIM = 0.242, TX = 0.818, TW = 0.25
/** body half width, wheel arch cut radius */
const W = 0.962, RA = 0.445

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const SHf: Style = { layer: 'shell', w: 0.35 }
const FG: Style = { layer: 'fg', w: 0.75 }
const FGd: Style = { layer: 'fg', w: 0.5 }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const MESHf: Style = { layer: 'mesh', w: 0.4 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

type P2 = [number, number]

/** Monotone cubic through points sorted by x (no overshoot between them). */
function mono(pts: P2[]): (x: number) => number {
  const n = pts.length
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const m: number[] = [d[0]]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i] }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (i < n - 2 && x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
  }
}

// ---------- the body: a loft of cross sections along z ----------

/** the roof's center line (hood, windshield, glass roof, rear glass, tail) */
const yTop = mono([[-L2, 1.03], [-2.3, 1.135], [-2.2, 1.175], [-1.75, 1.45], [-1.0, 1.6], [-0.4, 1.624], [0.15, 1.575], [1.1, 1.035], [1.6, 0.995], [2.1, 0.93], [2.3, 0.865], [L2, 0.83]])
/** the roof rail: the A-pillar over the windshield, the rail over the cabin, the edge of the rear glass, the hood crown */
const yRail = mono([[-L2, 1.005], [-2.3, 1.1], [-2.2, 1.15], [-1.75, 1.38], [-1.0, 1.525], [-0.4, 1.55], [0.15, 1.505], [1.1, 1.005], [1.6, 0.975], [2.1, 0.91], [2.3, 0.85], [L2, 0.815]])
const wRail = mono([[-L2, 0.45], [-2.3, 0.62], [-2.2, 0.68], [-1.75, 0.6], [-1.0, 0.645], [-0.4, 0.655], [0.15, 0.665], [1.1, 0.835], [1.6, 0.72], [2.1, 0.63], [L2, 0.4]])
/** the belt: the base of the side glass, then the fender tops and the hood edge */
const yBelt = mono([[-L2, 0.97], [-2.3, 1.07], [-2.2, 1.115], [-1.75, 1.14], [-1.0, 1.115], [0, 1.085], [1.1, 1.01], [1.6, 0.955], [2.1, 0.885], [2.3, 0.83], [L2, 0.805]])
/** where the lower body is widest, and its underside */
const yWide = mono([[-L2, 0.62], [-1.9, 0.66], [-1.4, 0.66], [0, 0.6], [1.5, 0.6], [2.2, 0.56], [L2, 0.52]])
const yBot = mono([[-L2, 0.44], [-2.3, 0.33], [-2.1, 0.25], [-1.6, 0.19], [-1.0, 0.17], [1.0, 0.17], [1.75, 0.19], [2.2, 0.24], [L2, 0.4]])

/** half width in plan: full between the wheels, rounded at the nose, squarer at the tail */
function halfW(z: number): number {
  const p = z >= 0 ? 6 : 8
  const u = Math.min(1, Math.abs(z) / L2)
  return W * Math.pow(Math.max(0, 1 - Math.pow(u, p)), 1 / p)
}

/**
 * The right half of the cross section at z, bottom center to top center:
 * 0 bottom, 1 underbody edge, 2 lower round, 3 widest, 4 under the shoulder,
 * 5 belt, 6 roof rail, 7 crown, 8 top. Heights ascend.
 */
function sec(z: number): P2[] {
  const ww = halfW(z)
  const yt = yTop(z)
  const yr = Math.min(yRail(z), yt - 0.012)
  const ys = Math.min(yBelt(z), yr - 0.01)
  const yw = Math.min(yWide(z), ys - 0.07)
  const yb = Math.min(yBot(z), yw - 0.1)
  const wr = Math.min(wRail(z), ww * 0.9)
  return [
    [0, yb],
    [0.8 * ww, yb],
    [0.965 * ww, yb + 0.07],
    [ww, yw],
    [0.985 * ww, Math.max(yw + 0.02, ys - 0.1)],
    [0.95 * ww, ys],
    [wr, yr],
    [0.55 * wr, yt - (yt - yr) * 0.22],
    [0, yt],
  ]
}

const lerp2 = (a: P2, b: P2, f: number): P2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
/** A point on the body between section points k and k + 1 at fraction f, on side s (+1 the car's left, +x). */
const S = (z: number, k: number, f = 0, s = 1, lift = 0): Vec3 => {
  const q = sec(z)
  const [x, y] = lerp2(q[k], q[Math.min(8, k + 1)], f)
  return [s * (x + lift), y, z]
}
/** The section's half width at height y (0 above its top). */
function onSide(z: number, y: number): number {
  const q = sec(z)
  if (y >= q[8][1]) return 0
  for (let k = 1; k < 8; k++) {
    if (y <= q[k + 1][1]) {
      const t = (y - q[k][1]) / Math.max(1e-6, q[k + 1][1] - q[k][1])
      return q[k][0] + (q[k + 1][0] - q[k][0]) * Math.max(0, Math.min(1, t))
    }
  }
  return 0
}
/** Across the top at z: u = 1 the left rail, 0 the center, -1 the right rail. */
function top(z: number, u: number, lift = 0): Vec3 {
  const q = sec(z), a = Math.abs(u)
  const [x, y] = a <= 0.5 ? lerp2(q[8], q[7], a / 0.5) : lerp2(q[7], q[6], (a - 0.5) / 0.5)
  return [Math.sign(u) * x, y + lift, z]
}
/** Bisection for f(z) = 0 between a and b (f changes sign). */
function solve(f: (z: number) => number, a: number, b: number): number {
  let fa = f(a)
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2, fm = f(m)
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm } else b = m
  }
  return (a + b) / 2
}
/** How far toward the end `end` (+1 nose, -1 tail) the body reaches at height y. */
const zEnd = (y: number, end: 1 | -1): number => {
  const inside = (z: number) => yTop(z) - y
  return inside(end * L2) >= 0 ? end * L2 : solve(inside, end * 1.6, end * L2)
}
/** The point on the nose or tail face at (x, y), x toward the left. */
function onEnd(x: number, y: number, end: 1 | -1): Vec3 {
  const z1 = zEnd(y, end)
  const z = solve((zz) => onSide(zz, y) - Math.abs(x), end * 1.6, z1)
  return [x, y, z]
}

/** A wheel arch's cut: inside it the lower body lines stop. */
const archDist = (z: number, y: number) => Math.min(Math.hypot(z - ZF, y - WR), Math.hypot(z - ZR, y - WR)) - RA

/** The stations: denser at the nose and tail, where the plan turns. */
const NZ = 84
const STATIONS = Array.from({ length: NZ + 1 }, (_, i) => L2 * Math.sin(((i / NZ) * 2 - 1) * (Math.PI / 2)))

/** A line along the body through section point k (or between k and k + 1 at f), cut at the arches when `arches`. */
function along(b: Builder, k: number, f: number, s: 1 | -1, st: Style, opts: { arches?: boolean; from?: number; to?: number; lift?: number } = {}) {
  const lo = opts.from ?? -L2, hi = opts.to ?? L2
  const zs = [lo, ...STATIONS.filter((z) => z > lo && z < hi), hi]
  let run: Vec3[] = []
  const flush = () => { if (run.length > 1) b.poly(run, false, st); run = [] }
  let prevZ: number | null = null
  for (const z of zs) {
    const p = S(z, k, f, s, opts.lift ?? 0)
    const out = !opts.arches || archDist(z, p[1]) >= 0
    if (prevZ != null && opts.arches) {
      const pz: number = prevZ
      const wasOut = archDist(pz, S(pz, k, f, s)[1]) >= 0
      if (wasOut !== out) {
        const zc = solve((zz) => archDist(zz, S(zz, k, f, s)[1]), pz, z)
        run.push(S(zc, k, f, s, opts.lift ?? 0))
        if (!out) flush()
      }
    }
    if (out) run.push(p)
    prevZ = z
  }
  flush()
}

/** The section at z as one loop across both sides, points k0..k1 on each, cut at the arches. */
function rib(b: Builder, z: number, k0: number, k1: number, st: Style) {
  const half: P2[] = []
  const q = sec(z)
  for (let k = k0; k < k1; k++) for (let t = 0; t < 3; t++) half.push(lerp2(q[k], q[k + 1], t / 3))
  half.push(q[k1])
  for (const s of [1, -1]) {
    let run: Vec3[] = []
    for (const [x, y] of half) {
      if (archDist(z, y) < 0) { if (run.length > 1) b.poly(run, false, st); run = []; continue }
      run.push([s * x, y, z])
    }
    if (run.length > 1) b.poly(run, false, st)
  }
}

/** A closed outline on the side surface from (z, y) pairs, lifted off it by `lift`. */
function onSidePath(b: Builder, pts: P2[], s: 1 | -1, st: Style, closed = true, lift = 0.004) {
  b.poly(pts.map(([z, y]): Vec3 => [s * (onSide(z, y) + lift), y, z]), closed, st)
}

/** The body at height y from z0 around the end (+1 nose, -1 tail) and back along the other side: a plan curve. */
function across(y: number, z0: number, end: 1 | -1, n = 22, lift = 0.004): Vec3[] {
  const z1 = zEnd(y, end)
  const half: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    // ease toward the end, where the plan turns fastest
    const z = z0 + (z1 - z0) * Math.sin((t * Math.PI) / 2)
    half.push([onSide(z, y) + lift, y, z])
  }
  const right = half.slice(0, -1).reverse().map(([x, yy, z]): Vec3 => [-x, yy, z])
  return [...half.slice(0, -1), [0, y, z1 + end * lift], ...right]
}

// ---------- parts ----------

function wheel(b: Builder, zc: number, s: 1 | -1) {
  const xo = s * (TX + TW / 2), xi = s * (TX - TW / 2)
  // the tire: both sidewalls, the shoulders and the tread
  b.circle([xo, WR, zc], Z, Y, WR - 0.02, 44, SH)
  b.circle([xo - s * 0.03, WR, zc], Z, Y, WR, 44, SHd)
  b.circle([xi + s * 0.03, WR, zc], Z, Y, WR, 44, SHf)
  b.circle([xi, WR, zc], Z, Y, WR - 0.02, 40, SHf)
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a)
    b.line([xo - s * 0.03, WR + sn * WR, zc + c * WR], [xi + s * 0.03, WR + sn * WR, zc + c * WR], MESHd)
  }
  // the rim and its aero face: five twin spokes swept toward the rear
  const xr = s * (TX + TW / 2 - 0.035)
  b.circle([xr, WR, zc], Z, Y, RIM, 40, FG)
  b.circle([xr - s * 0.02, WR, zc], Z, Y, RIM * 0.9, 36, SHd)
  b.circle([xr + s * 0.004, WR, zc], Z, Y, 0.055, 16, FGd)
  for (let k = 0; k < 5; k++) {
    const a0 = (k / 5) * Math.PI * 2 + 0.3
    for (const off of [-0.11, 0.11]) {
      const pts: Vec3[] = []
      for (let i = 0; i <= 4; i++) {
        const r = 0.06 + (RIM * 0.9 - 0.06) * (i / 4)
        const a = a0 + off * (0.5 + i / 8) + 0.18 * (i / 4) ** 2
        pts.push([xr + s * 0.004, WR + Math.sin(a) * r, zc + Math.cos(a) * r])
      }
      b.poly(pts, false, SHd)
    }
  }
  // brake disc and caliper behind the spokes
  const xd = s * (TX - 0.02)
  b.circle([xd, WR, zc], Z, Y, 0.17, 28, MESHd)
  b.circle([xd, WR, zc], Z, Y, 0.1, 18, MESHf)
  b.circle([xd, WR, zc], Z, Y, 0.19, 10, MESHd, Math.PI * 0.55, Math.PI * 0.95)
}

function mirror(b: Builder, s: 1 | -1) {
  const c: Vec3 = [s * 1.0, 1.1, 0.97]
  b.roundSlab(c, X, Y, 0.2, 0.11, 0.08, 0.045, SHd, FG, SHd, 4)
  // the arm down to the door, at the belt behind the A-pillar
  b.line([s * 0.92, 1.06, 0.99], [s * 0.94, 1.075, 0.975], SHd)
  b.line([s * 0.92, 1.06, 0.95], [s * 0.94, 1.075, 0.955], SHd)
}

/** The battery pack under the cabin floor: its case, ten module bands and the cables to the motors. */
function pack(b: Builder) {
  const x0 = 0.72, y0 = 0.18, y1 = 0.31, z0 = -1.15, z1 = 1.0
  const P = hot('battery', 0.6)
  b.chamferBox([0, (y0 + y1) / 2, (z0 + z1) / 2], [x0, (y1 - y0) / 2, (z1 - z0) / 2], 0.03, (axis) => (axis === 1 ? P : hot('battery', 0.45)), hot('battery', 0.4))
  b.line([0, y1 + 0.002, z0 + 0.04], [0, y1 + 0.002, z1 - 0.04], hot('battery', 0.6))
  const n = 10, gap = 0.025
  const zA = z0 + 0.06, zB = z1 - 0.16
  for (let k = 0; k < n; k++) {
    const g = `battery.c${k}`
    const za = zA + ((zB - zA) * k) / n + gap / 2, zb = zA + ((zB - zA) * (k + 1)) / n - gap / 2
    const zc = (za + zb) / 2
    b.rect([0, y1 - 0.004, zc], X, Z, 2 * x0 - 0.1, zb - za, hot(g, 0.72), 0.012)
    for (const x of [-0.45, -0.15, 0.15, 0.45]) b.line([x, y1 - 0.004, za + 0.01], [x, y1 - 0.004, zb - 0.01], hot(g, 0.3))
    b.line([-x0 + 0.05, y0 + 0.02, zc], [x0 - 0.05, y0 + 0.02, zc], hot(g, 0.2))
  }
  // the junction box at the front of the pack, and the cables to the motors
  b.box([-0.2, y1, zB + 0.03], [0.2, y1 + 0.07, z1 - 0.03], hot('battery', 0.55))
  b.tube([0, y1 + 0.05, z1 - 0.05], [0, 0.42, 1.1], [0, 0.42, 1.2], [0, 0.4, ZF - 0.2], 0.02, X, 8, hot('battery', 0.35))
  b.tube([0, y1, z0 + 0.02], [0, 0.33, -1.2], [0, 0.36, -1.18], [0, 0.38, ZR + 0.22], 0.02, X, 8, hot('battery', 0.35))
}

function motors(b: Builder) {
  // rear drive unit and the front one (dual motor), with their half shafts
  b.chamferBox([0, 0.37, ZR], [0.27, 0.16, 0.21], 0.04, () => SHd, SHf)
  b.circle([0.12, 0.37, ZR], Z, Y, 0.13, 20, MESHd)
  b.chamferBox([0, 0.38, ZF], [0.24, 0.14, 0.18], 0.04, () => SHd, SHf)
  b.circle([-0.1, 0.38, ZF], Z, Y, 0.11, 18, MESHd)
  for (const s of [1, -1] as const) {
    b.line([s * 0.27, 0.37, ZR], [s * (TX - 0.06), WR, ZR], SHf)
    b.line([s * 0.24, 0.38, ZF], [s * (TX - 0.06), WR, ZF], SHf)
  }
}

/** Seats, the dash with its ambient strip, the wheel and the screens. */
function cabin(b: Builder) {
  const SEAT = MESHd, SEATe = MESHf
  // front seats: a cushion and a reclined back, outlined on both sides and joined
  for (const xs of [0.37, -0.37]) {
    const side = (x: number): Vec3[] => [[x, 0.5, 0.52], [x, 0.58, 0.55], [x, 0.62, 0.1], [x, 0.6, 0.02], [x, 1.18, -0.12], [x, 1.26, -0.08], [x, 1.22, -0.02], [x, 0.66, 0.1]]
    const l = side(xs - 0.23), r = side(xs + 0.23)
    b.poly(l, false, SEAT)
    b.poly(r, false, SEAT)
    for (const i of [1, 2, 4, 5]) b.line(l[i], r[i], SEATe)
    b.rect([xs, 1.34, -0.1], X, norm([0, 1, 0.2]), 0.26, 0.15, SEAT, 0.04)
  }
  // rear bench
  const bench = (x: number): Vec3[] => [[x, 0.55, -0.42], [x, 0.66, -0.45], [x, 0.68, -0.92], [x, 1.2, -1.08], [x, 1.24, -1.02], [x, 0.72, -0.86]]
  const bl = bench(0.7), br = bench(-0.7)
  b.poly(bl, false, SEAT)
  b.poly(br, false, SEAT)
  for (const i of [1, 2, 3, 4]) b.line(bl[i], br[i], SEATe)
  for (const x of [-0.24, 0.24]) b.line([x, 0.68, -0.92], [x, 1.2, -1.08], SEATe)
  // dash top, and the ambient strip across it and along the front doors
  const dash: Vec3[] = []
  for (let i = 0; i <= 16; i++) { const x = -0.8 + (1.6 * i) / 16; dash.push([x, 0.95 + 0.02 * (1 - (x / 0.8) ** 2), 0.86 - 0.06 * (1 - (x / 0.8) ** 2)]) }
  b.poly(dash, false, SHd)
  const strip: Vec3[] = [[0.84, 0.88, 0.02], ...dash.map(([x, , z]): Vec3 => [x * 1.04, 0.885, z - 0.035]), [-0.84, 0.88, 0.02]]
  b.poly(strip, false, hot('cabin', 0.5))
  // the wheel, on the left (+x)
  const n: Vec3 = norm([0, 0.38, -0.92])
  b.circle([0.37, 0.95, 0.66], X, norm(cross(n, X)), 0.18, 28, SHd)
  b.circle([0.37, 0.95, 0.66], X, norm(cross(n, X)), 0.05, 10, SHf)
  b.line([0.37, 0.95, 0.66], [0.37, 0.9, 0.84], SHf)
  // the 15.4 in center screen, landscape over the dash, tilted to the driver
  const up: Vec3 = norm([0, 0.96, 0.27])
  b.rect([0, 1.06, 0.7], X, up, 0.36, 0.22, hot('cabin', 0.9), 0.012)
  b.rect([0, 1.06, 0.701], X, up, 0.33, 0.19, hot('cabin', 0.5), 0.008)
  b.face([[-0.17, 1.06 - 0.1 * up[1], 0.7 - 0.1 * up[2]], [0.17, 1.06 - 0.1 * up[1], 0.7 - 0.1 * up[2]], [0.17, 1.06 + 0.1 * up[1], 0.7 + 0.1 * up[2]], [-0.17, 1.06 + 0.1 * up[1], 0.7 + 0.1 * up[2]]], 'fg', 0.9)
  // what is on it: a status line and the map's road
  b.line([-0.13, 1.06, 0.7015], [0.13, 1.06, 0.7015], hot('cabin', 0.35))
  b.line([-0.13, 1.06 + 0.05 * up[1], 0.7015 + 0.05 * up[2]], [0.02, 1.06 + 0.05 * up[1], 0.7015 + 0.05 * up[2]], hot('cabin', 0.35))
  b.line([0, 0.95, 0.73], [0, 1.0, 0.71], SHf)
  // the rear passengers' screen at the back of the console
  b.rect([0, 0.66, -0.1], X, norm([0, 1, 0.15]), 0.2, 0.12, hot('cabin', 0.6), 0.01)
  b.line([-0.12, 0.6, 0.6], [-0.12, 0.6, -0.08], SEATe)
  b.line([0.12, 0.6, 0.6], [0.12, 0.6, -0.08], SEATe)
}

// ---------- the car ----------

export function modelY(): Model {
  const b = new Builder()

  // ---- body: the long feature lines ----
  for (const s of [1, -1] as const) {
    along(b, 1, 0, s, MESHd, { arches: true })
    along(b, 2, 0, s, SH, { arches: true })
    along(b, 3, 0, s, SHd, { arches: true })
    along(b, 4, 0, s, SHd, { arches: true })
    along(b, 5, 0, s, FG)
    along(b, 6, 0, s, SH)
    // the crown only over the hood and the tail (glass elsewhere)
    along(b, 7, 0, s, MESHd, { from: 1.12 })
    along(b, 7, 0, s, MESHd, { to: -2.18 })
    // the shoulder crease just under the belt
    along(b, 4, 0.55, s, MESHf, { arches: true, from: -2.3, to: 2.3 })
  }
  along(b, 8, 0, 1, MESHd)
  along(b, 0, 0, 1, MESHf, { from: -1.9, to: 1.9 })

  // ---- cross sections: full at the pillars, the lower body elsewhere ----
  for (const z of [1.1, 0.0, -1.0, -1.75]) rib(b, z, 0, 8, MESHf)
  for (const z of [2.25, 1.95, 0.55, -0.5, -1.95, -2.25]) rib(b, z, 0, 5, MESHd)
  for (const z of [1.1, 0.0]) rib(b, z, 5, 8, SHd)

  // ---- wheel arches: the cut on the body and the liner behind it ----
  for (const za of [ZF, ZR]) {
    for (const s of [1, -1] as const) {
      const cut: Vec3[] = [], liner: Vec3[] = []
      for (let i = 0; i <= 36; i++) {
        const a = (i / 36) * Math.PI
        const z = za + RA * Math.cos(a), y = WR + RA * Math.sin(a)
        if (y < sec(z)[0][1] + 0.02) continue
        cut.push([s * (onSide(z, y) + 0.004), y, z])
        liner.push([s * (onSide(z, y) - 0.16), WR + (RA + 0.01) * Math.sin(a), za + (RA + 0.01) * Math.cos(a)])
      }
      b.poly(cut, false, FG)
      b.poly(liner, false, MESHd)
      for (let i = 0; i < cut.length; i += 6) b.line(cut[i], liner[i], MESHf)
    }
  }

  // ---- glass: windshield, the glass roof, the rear glass, and the side windows ----
  const glassStrip = (zA: number, zB: number, u: number, strips: number, w: number) => {
    for (let k = 0; k < strips; k++) {
      const u0 = -u + (2 * u * k) / strips, u1 = -u + (2 * u * (k + 1)) / strips
      b.face([top(zA, u0, 0.003), top(zA, u1, 0.003), top(zB, u1, 0.003), top(zB, u0, 0.003)], 'fg', w)
    }
  }
  const outlineTop = (zA: number, zB: number, u: number, st: Style) => {
    const n = 14
    const edge = (z: number) => { const pts: Vec3[] = []; for (let i = 0; i <= n; i++) pts.push(top(z, -u + (2 * u * i) / n, 0.004)); return pts }
    const side = (uu: number) => { const pts: Vec3[] = []; for (let i = 0; i <= n; i++) pts.push(top(zA + ((zB - zA) * i) / n, uu, 0.004)); return pts }
    b.poly(edge(zA), false, st)
    b.poly(edge(zB), false, st)
    b.poly(side(u), false, st)
    b.poly(side(-u), false, st)
  }
  // windshield, cowl to header
  outlineTop(1.08, 0.17, 0.96, FG)
  glassStrip(1.08, 0.17, 0.96, 6, 1.2)
  // the glass roof, one panel to the crossbar over the rear seats
  outlineTop(0.1, -1.45, 0.88, FGd)
  glassStrip(0.1, -1.45, 0.88, 4, 0.9)
  for (const u of [-0.44, 0.44]) { const pts: Vec3[] = []; for (let i = 0; i <= 12; i++) pts.push(top(0.06 - (1.47 * i) / 12, u, 0.004)); b.poly(pts, false, MESHf) }
  for (let z = -0.1; z > -1.45; z -= 0.28) { const pts: Vec3[] = []; for (let i = 0; i <= 10; i++) pts.push(top(z, -0.86 + (1.72 * i) / 10, 0.004)); b.poly(pts, false, MESHf) }
  // rear glass on the liftgate
  outlineTop(-1.62, -2.17, 0.86, FGd)
  glassStrip(-1.62, -2.17, 0.86, 4, 0.8)

  // side windows: between the belt and the rail, the rear quarter's edge sloping forward
  const G = (z: number, f: number, s: 1 | -1, lift = 0.004): Vec3 => S(z, 5, f, s, lift)
  for (const s of [1, -1] as const) {
    const lo = 0.04, hi = 0.93
    const pts: Vec3[] = []
    for (let i = 0; i <= 30; i++) pts.push(G(1.07 - ((1.07 + 1.86) * i) / 30, lo, s))
    for (let i = 1; i <= 6; i++) { const t = i / 6; pts.push(G(-1.86 + (0.42 * t), lo + (hi - lo) * t, s)) }
    for (let i = 1; i <= 30; i++) pts.push(G(-1.44 + ((1.07 + 1.44) * i) / 30, hi, s))
    b.poly(pts, true, FGd)
    // B and C pillars
    for (const zp of [0.05, -0.05, -0.97, -1.03]) b.line(G(zp, lo, s), G(zp, hi, s), SHd)
    for (let k = 0; k < 5; k++) {
      const za = 1.0 - (2.4 * k) / 5, zb = 1.0 - (2.4 * (k + 1)) / 5
      b.face([G(za, lo, s, 0.002), G(zb, lo, s, 0.002), G(zb, hi, s, 0.002), G(za, hi, s, 0.002)], 'fg', 0.7)
    }
  }

  // ---- panels: doors, handles, the hood and the liftgate ----
  for (const s of [1, -1] as const) {
    const ysAt = (z: number) => sec(z)[5][1] - 0.012
    const ybAt = (z: number) => sec(z)[2][1] + 0.01
    // front door: from behind the front arch to the B-pillar; rear door: from there to the C-pillar, clear of the rear arch
    onSidePath(b, [[0.99, ysAt(0.99)], [0.97, ybAt(0.97)]], s, SHd, false)
    onSidePath(b, [[0.01, ysAt(0.01)], [0.01, ybAt(0.01)]], s, SHd, false)
    onSidePath(b, [[-1.0, ysAt(-1.0)], [-0.99, 0.82], [-0.95, ybAt(-0.95)]], s, SHd, false)
    // flush handles
    for (const [za, zb] of [[0.5, 0.3], [-0.44, -0.62]]) {
      const y0 = ysAt(za) - 0.07
      onSidePath(b, [[za, y0], [zb, y0], [zb, y0 - 0.025], [za, y0 - 0.025]], s, SHd)
    }
    // the hood's shut line along the fender top
    along(b, 5, 0.45, s, SHd, { from: 1.12, to: 2.28 })
    mirror(b, s)
  }
  // the hood's front edge and the cowl, across the top
  for (const z of [2.28, 1.12]) { const pts: Vec3[] = []; for (let i = 0; i <= 16; i++) { const u = -1 + (2 * i) / 16; const q = sec(z); const ux = Math.abs(u) * (q[5][0] * 0.55 + q[6][0] * 0.45); pts.push([Math.sign(u) * ux, onTopY(z, ux) + 0.004, z]) } b.poly(pts, false, SHd) }
  // the liftgate's seams on the tail face, and the plate recess
  for (const x of [-0.56, 0.56]) b.poly([onEnd(x, 1.05, -1), onEnd(x, 0.88, -1), onEnd(x, 0.72, -1)], false, SHd)
  b.poly([onEnd(-0.56, 0.72, -1), onEnd(-0.3, 0.71, -1), onEnd(0, 0.71, -1), onEnd(0.3, 0.71, -1), onEnd(0.56, 0.72, -1)], false, SHd)
  b.poly([onEnd(-0.26, 0.47, -1), onEnd(0.26, 0.47, -1), onEnd(0.26, 0.64, -1), onEnd(-0.26, 0.64, -1)], true, MESHd)

  // ---- bumpers ----
  b.poly(across(0.3, 2.0, 1), false, SH)
  b.poly(across(0.36, 2.15, 1), false, MESHd)
  b.poly(across(0.7, -2.05, -1), false, SH)
  b.poly(across(0.42, -2.1, -1), false, MESHd)
  for (let x = -0.5; x <= 0.51; x += 0.125) b.line(onEnd(x, 0.42, -1), onEnd(x, 0.35, -1), MESHf)

  // ---- lights ----
  // the full-width light bar across the nose, under the hood's edge
  b.poly(across(0.775, 2.13, 1), false, hot('lights', 1))
  b.poly(across(0.795, 2.15, 1), false, hot('lights', 0.7))
  // the headlamps, low in the bumper corners
  for (const s of [1, -1] as const) {
    const lamp: Vec3[] = []
    for (const [y, za, zb] of [[0.58, 2.2, 2.33], [0.51, 2.33, 2.22]] as const) {
      for (let i = 0; i <= 5; i++) { const z = za + ((zb - za) * i) / 5; lamp.push([s * (onSide(z, y) + 0.005), y, z]) }
    }
    b.poly(lamp, true, hot('lights', 0.75))
    b.line([s * (onSide(2.27, 0.545) + 0.006), 0.545, 2.27], [s * (onSide(2.24, 0.545) + 0.006), 0.545, 2.24], hot('lights', 0.5))
  }
  // the tail: the full-width bar between the two C-shaped lamps
  b.poly(across(1.0, -2.12, -1), false, hot('lights', 1))
  for (const s of [1, -1] as const) {
    const c: Vec3[] = []
    for (let i = 0; i <= 6; i++) { const z = -2.3 + (0.2 * i) / 6; c.push([s * (onSide(z, 1.02) + 0.005), 1.02, z]) }
    for (let i = 0; i <= 4; i++) { const y = 1.02 - (0.16 * i) / 4; c.push([s * (onSide(-2.1, y) + 0.005), y, -2.1]) }
    for (let i = 1; i <= 6; i++) { const z = -2.1 - (0.2 * i) / 6; c.push([s * (onSide(z, 0.86) + 0.005), 0.86, z]) }
    b.poly(c, false, hot('lights', 0.85))
    b.poly([onEnd(s * 0.6, 1.02, -1), onEnd(s * 0.6, 0.94, -1), onEnd(s * 0.72, 0.86, -1)], false, hot('lights', 0.6))
  }

  // ---- the charge port, left rear (+x), ahead of the left lamp ----
  const PZ = -2.02, PY = 0.96
  const door: P2[] = [[PZ + 0.065, PY + 0.05], [PZ - 0.065, PY + 0.05], [PZ - 0.075, PY + 0.035], [PZ - 0.075, PY - 0.04], [PZ - 0.06, PY - 0.055], [PZ + 0.06, PY - 0.055], [PZ + 0.075, PY - 0.04], [PZ + 0.075, PY + 0.035]]
  onSidePath(b, door, 1, hot('charge', 0.8), true, 0.006)
  const px = onSide(PZ, PY) + 0.008
  const pn: Vec3 = norm([1, 0, 0.25])
  const pv = norm(cross(pn, Y))
  b.circle([px, PY, PZ], Y, pv, 0.03, 18, hot('charge', 1))
  b.circle([px, PY + 0.008, PZ - 0.012], Y, pv, 0.009, 8, hot('charge', 1))
  b.circle([px, PY + 0.008, PZ + 0.012], Y, pv, 0.009, 8, hot('charge', 1))
  b.circle([px, PY - 0.012, PZ], Y, pv, 0.005, 6, hot('charge', 0.8))
  // its cable inside the body, down to the rear of the pack
  b.tube([px - 0.03, PY, PZ], [0.66, 0.8, -1.98], [0.5, 0.36, -1.5], [0.4, 0.3, -1.16], 0.012, Y, 12, hot('charge', 0.4))

  // ---- underneath and inside ----
  pack(b)
  motors(b)
  cabin(b)
  for (const za of [ZF, ZR]) for (const s of [1, -1] as const) wheel(b, za, s)

  // ---- hotspots ----
  b.hotspot('battery', [0, 0.312, -0.05], 'Battery')
  b.hotspot('charge', [px + 0.002, PY, PZ], 'Charge port')
  b.hotspot('cabin', [0, 1.06, 0.701], 'Cabin')

  // the nose leans back above and below the bumper's front, and the tail a little at the top
  b.transform((p) => {
    let z = p[2]
    if (z > 1.85) {
      const g = smooth01((z - 1.85) / (L2 - 1.85))
      z -= g * Math.min(0.2, 0.13 * ((p[1] - 0.5) / 0.3) ** 2)
    } else if (z < -1.95) {
      const g = smooth01((-1.95 - z) / (L2 - 1.95))
      z += g * (p[1] > 0.75 ? Math.min(0.08, 0.05 * ((p[1] - 0.75) / 0.3) ** 2) : 0)
    }
    return [p[0] * K, p[1] * K, z * K]
  }, (d) => d)

  return b.model()
}

const smooth01 = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u) }

/** The top surface's height at z for a half width x (hood and roof), from the section's upper points. */
function onTopY(z: number, x: number): number {
  const q = sec(z)
  for (let k = 8; k > 4; k--) {
    const a = q[k], c = q[k - 1]
    if (x <= c[0]) {
      const t = (x - a[0]) / Math.max(1e-6, c[0] - a[0])
      return a[1] + (c[1] - a[1]) * Math.max(0, Math.min(1, t))
    }
  }
  return q[5][1]
}

/** No beams or airflow on the heroes since 2026-10-17; kept so the car fits the shared FX table. */
export const MODEL_Y_FX: { beams: Beam[]; flow: Flow[] } = { beams: [], flow: [] }
