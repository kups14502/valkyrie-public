// A 2026 Tesla Model Y (the Juniper refresh, Long Range AWD) in x-ray, for
// the cars on System > Hosts. Built from references, not memory:
//  - the published dimensions: 4,790 mm long, 1,920 mm wide without the
//    mirrors, 1,624 mm high, a 2,890 mm wheelbase, 255/45 R19 tires;
//  - a 1:25 Juniper blueprint (side, front, rear and top views,
//    the-blueprints.com vector drawing 31159). Every profile below is read off
//    it in the drawing's own millimeters: d from the nose along the side view,
//    h above the ground, x from the center line in the front, rear and top
//    views. zOf maps d onto the published overhangs and wheelbase, so the
//    wheels sit on the axles where the drawing is a percent off;
//  - photos of the car (Wikimedia Commons, the "Tesla Model Y Juniper"
//    series): the thin light bar along the hood's leading edge wrapping onto
//    the fenders, the slim headlamps low in the bumper corners over the air
//    curtains, the lower intake, the 19 in Crossflow wheels; at the rear the
//    ducktail spoiler lip over the TESLA band, the full-width bar ending in
//    C-shaped lamps that wrap onto the quarters, and the black diffuser.
//
// Built in meters and scaled to the shared ~4 unit radius. The nose faces +z,
// the car's left (the driver's side in the US) is +x, the floor is y = 0.
//
// Groups: battery (the pack under the floor, its high-voltage cables) and
// battery.c0..c9 (its ten module bands, lit from the rear as the charge
// rises), charge (the port in the left rear lamp and its cable to the pack),
// lights (the light bars and lamps, lit while the car is awake), cabin (the
// screens and the ambient strip).

import { add, cross, norm, scale, type Model, type Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

/** meters to model units */
const K = 1.46

// ---------- the blueprint ----------

type P2 = [number, number]

/** the drawing's front and rear wheel centers and its length, mm from the nose */
const BF = 889, BR = 3806, BL = 4751
/** the car's front overhang, wheelbase and rear overhang, m */
const OF = 0.92, WB = 2.89, OR = 0.98
const L2 = (OF + WB + OR) / 2
const ZF = L2 - OF, ZR = ZF - WB

/** blueprint d (mm from the nose) to z (m) and back */
const zOf = (d: number): number => (d <= BF ? L2 - (d / BF) * OF : d <= BR ? ZF - ((d - BF) / (BR - BF)) * WB : ZR - ((d - BR) / (BL - BR)) * OR)
const dOf = (z: number): number => (z >= ZF ? ((L2 - z) / OF) * BF : z >= ZR ? BF + ((ZF - z) / WB) * (BR - BF) : BR + ((ZR - z) / OR) * (BL - BR))

/** tire radius (255/45 R19), wheel center x (half the 1,636 mm track), tire width, the arch's paint edge radius */
const WR = 0.356, TX = 0.818, TW = 0.255, RA = 0.477

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

/** A profile read off the blueprint as [d, mm] pairs, returned in meters at z. */
const tab = (pts: P2[]): ((z: number) => number) => { const f = mono(pts); return (z) => f(dOf(z)) / 1000 }

const smooth01 = (t: number) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u) }

// The side view's top line: the bumper face, the hood, the windshield, the glass roof, the rear glass and the spoiler lip.
const yTop = tab([[0, 445], [35, 598], [70, 732], [105, 767], [141, 785], [211, 832], [281, 861], [351, 896], [422, 926], [492, 943],
  [598, 978], [703, 1013], [808, 1037], [914, 1066], [1019, 1084], [1125, 1101], [1230, 1131], [1300, 1140], [1371, 1158], [1476, 1219],
  [1582, 1278], [1687, 1337], [1793, 1395], [1898, 1442], [2003, 1489], [2109, 1532], [2214, 1572], [2320, 1597], [2425, 1610], [2531, 1618],
  [2650, 1624], [2750, 1624], [2882, 1618], [3005, 1612], [3146, 1601], [3286, 1583], [3409, 1562], [3532, 1543], [3655, 1520], [3740, 1500],
  [3866, 1455], [4007, 1410], [4147, 1368], [4288, 1326], [4429, 1285], [4552, 1260], [4650, 1248], [4720, 1238], [4751, 1180]])
// The lowest line: the front lip, the sills between the wheels, the diffuser.
const yBot = tab([[0, 290], [35, 272], [105, 258], [211, 242], [351, 225], [450, 210], [560, 200], [1300, 195], [3300, 195], [4100, 245],
  [4253, 258], [4394, 270], [4534, 305], [4604, 340], [4675, 390], [4720, 470], [4751, 570]])
// The sill (the lower body's outer bottom edge): the bumper lip's corners, the rockers, the diffuser's corners.
const yRk = tab([[0, 312], [105, 284], [300, 262], [450, 245], [600, 236], [1300, 226], [3300, 226], [3900, 242], [4250, 285], [4500, 330], [4650, 405], [4751, 590]])
const wRk = tab([[0, 420], [105, 600], [300, 800], [600, 880], [1300, 900], [3300, 900], [3900, 900], [4250, 880], [4500, 820], [4650, 720], [4751, 450]])
// Where the body is widest (the top view's outline; the fenders and haunches stand out of the doors).
const yMx = tab([[0, 400], [105, 470], [300, 560], [600, 650], [1300, 650], [2000, 610], [3000, 610], [3600, 690], [4250, 720], [4500, 700], [4751, 640]])
const wMx = tab([[0, 500], [50, 600], [146, 703], [293, 850], [440, 920], [586, 950], [733, 957], [1170, 957], [1318, 948], [1465, 931], [1600, 920],
  [3370, 920], [3516, 950], [3663, 957], [3956, 957], [4100, 949], [4248, 926], [4394, 879], [4540, 785], [4686, 609], [4751, 420]])
// The shoulder: the crease under the side glass, forward along the fender top to the light bar's end, back to the tail lamp.
const ySh = tab([[0, 430], [480, 822], [700, 925], [1000, 1012], [1265, 1052], [1500, 1060], [2000, 1066], [3000, 1078], [3700, 1090], [4240, 1110], [4500, 1110], [4650, 1100], [4751, 1060]])
const wSh = tab([[0, 470], [105, 670], [211, 780], [351, 840], [480, 880], [800, 890], [1265, 870], [2000, 865], [3000, 870], [3700, 885], [4240, 870], [4500, 800], [4650, 680], [4751, 450]])
// The belt: the side glass's lower edge (the front view's +-800 at 1,100); ahead of the cowl, the fender top beside the hood.
const yBlCabin = tab([[1265, 1092], [1440, 1100], [2000, 1105], [2660, 1115], [3500, 1140], [3620, 1150], [4000, 1170], [4300, 1185], [4550, 1195], [4720, 1195], [4751, 1150]])
const wBl = tab([[0, 440], [105, 630], [211, 740], [351, 780], [480, 820], [800, 830], [1265, 800], [1440, 800], [2600, 805], [3600, 800], [4000, 790], [4300, 750], [4500, 690], [4650, 600], [4751, 420]])
// The rail: the A-pillar over the windshield's edge, the roof's edge, the rear glass's edge; ahead of the cowl, the hood's flank.
const yRlCabin = tab([[1265, 1119], [1440, 1175], [1600, 1265], [1800, 1372], [2000, 1462], [2200, 1527], [2400, 1560], [2700, 1576], [3000, 1566],
  [3300, 1540], [3500, 1512], [3700, 1462], [3900, 1400], [4100, 1338], [4300, 1283], [4500, 1245], [4650, 1228], [4720, 1222], [4751, 1170]])
const wRl = tab([[0, 380], [105, 520], [211, 590], [351, 615], [600, 630], [1000, 670], [1265, 700], [1500, 695], [1800, 678], [2200, 650], [2600, 645],
  [3000, 635], [3500, 615], [3800, 595], [4100, 565], [4400, 525], [4600, 495], [4700, 470], [4751, 380]])

/** the cowl (the windshield's base), d */
const COWL = 1265

/**
 * The right half of the cross section at z (x >= 0), bottom center to top
 * center: 0 bottom, 1 floor edge, 2 sill, 3 widest, 4 shoulder, 5 belt, 6 rail,
 * 7 top; 8 is the rail mirrored, so the crown is level at the center. At the
 * nose and the tail the upper points settle onto fixed shares of the section's
 * height, so the lines close smoothly around the ends.
 */
function knots(z: number): P2[] {
  const d = dOf(z)
  const yt = yTop(z), yb = yBot(z)
  const hood = d < COWL
  const ends = Math.max(smooth01((560 - d) / 320), smooth01((d - 4560) / 190))
  const share = (y: number, f: number) => y + (yb + f * (yt - yb) - y) * ends
  const y = [yb, yb, yRk(z), yMx(z),
    share(ySh(z), 0.85),
    share(hood ? yt - 0.045 : yBlCabin(z), 0.94),
    share(hood ? yt - 0.018 : yRlCabin(z), 0.985),
    yt]
  for (let k = 2; k <= 6; k++) y[k] = Math.max(y[k], y[k - 1] + 0.004)
  for (let k = 6; k >= 2; k--) y[k] = Math.min(y[k], y[k + 1] - 0.003)
  const w = [0, Math.max(0.2, wRk(z) - 0.12), wRk(z), wMx(z), wSh(z), wBl(z), wRl(z), 0]
  const q: P2[] = y.map((v, k) => [w[k], v])
  q.push([-w[6], y[6]])
  return q
}

const kCache = new Map<number, P2[]>()
const kn = (z: number): P2[] => {
  let q = kCache.get(z)
  if (!q) { q = knots(z); kCache.set(z, q) }
  return q
}

const lerp2 = (a: P2, b: P2, f: number): P2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]

/** Centripetal Catmull-Rom between p1 and p2. */
function cr(p0: P2, p1: P2, p2: P2, p3: P2, t: number): P2 {
  const dt = (a: P2, b: P2) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])))
  const t1 = dt(p0, p1), t2 = t1 + dt(p1, p2), t3 = t2 + dt(p2, p3)
  const u = t1 + (t2 - t1) * t
  const L = (a: P2, b: P2, ta: number, tb: number): P2 => lerp2(a, b, (u - ta) / (tb - ta))
  const a1 = L(p0, p1, 0, t1), a2 = L(p1, p2, t1, t2), a3 = L(p2, p3, t2, t3)
  const b1 = L(a1, a2, 0, t2), b2 = L(a2, a3, t1, t3)
  return L(b1, b2, t1, t2)
}

/** The section at z, u from 0 (bottom center) to 7 (top center); whole u are the knots. */
function sec(z: number, u: number): P2 {
  const q = kn(z)
  const k = Math.max(0, Math.min(6, Math.floor(u)))
  const t = Math.min(1, u - k)
  if (k === 0) return lerp2(q[0], q[1], t)
  // the crown (roof, hood, deck): a parabola from the rail, level at the center line, never above it
  if (k === 6) return [q[6][0] * (1 - t), q[6][1] + (q[7][1] - q[6][1]) * (1 - (1 - t) * (1 - t))]
  // the side glass runs straight into the rail (a crease there, not a roll over the top)
  const p3: P2 = k === 5 ? [2 * q[6][0] - q[5][0], 2 * q[6][1] - q[5][1]] : q[k + 2]
  return cr(q[k - 1], q[k], q[k + 1], p3, t)
}

/** points per span when a section is drawn or searched */
const SPAN_N = [2, 3, 6, 6, 3, 6, 6]
const U_STEPS: number[] = SPAN_N.flatMap((n, k) => Array.from({ length: n }, (_, i) => k + i / n)).concat(7)

/** The half width of the body at (z, y), searched up the section from the floor edge; 0 above its top or under its floor. */
function xAt(z: number, y: number): number {
  let a = sec(z, 1)
  for (let i = U_STEPS.indexOf(1) + 1; i < U_STEPS.length; i++) {
    const b = sec(z, U_STEPS[i])
    if (a[1] !== b[1] && (y - a[1]) * (y - b[1]) <= 0) return a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1])
    a = b
  }
  return 0
}

/** The body's height at (z, x) on its top (hood, roof, deck), searched from the center out. */
function yOnTop(z: number, x: number): number {
  let a = sec(z, 7)
  for (let u = 6.9; u >= 4; u -= 0.1) {
    const b = sec(z, u)
    if ((x - a[0]) * (x - b[0]) <= 0 && a[0] !== b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])
    a = b
  }
  return a[1]
}

/** Bisection for f(z) = 0 between a and b (f changes sign). */
function solve(f: (z: number) => number, a: number, b: number): number {
  let fa = f(a)
  for (let i = 0; i < 22; i++) {
    const m = (a + b) / 2, fm = f(m)
    if ((fm < 0) === (fa < 0)) { a = m; fa = fm } else b = m
  }
  return (a + b) / 2
}

// ---------- points on the surface, in the blueprint's units ----------

/** On the side at (d, h mm), side s (+1 the car's left), lifted off it by `lift` m. */
const SP = (d: number, h: number, s: 1 | -1 = 1, lift = 0.004): Vec3 => {
  const z = zOf(d), y = h / 1000
  return [s * (xAt(z, y) + lift), y, z]
}
/** On the top at d, x mm from the center line. */
const TP = (d: number, x: number, lift = 0.004): Vec3 => {
  const z = zOf(d)
  return [x / 1000, yOnTop(z, Math.abs(x / 1000)) + lift, z]
}
/** On the nose (end +1) or the tail (end -1) at (x, h mm), as the front and rear views place it. */
function EP(x: number, h: number, end: 1 | -1, lift = 0.004): Vec3 {
  const y = h / 1000, ax = Math.max(0.004, Math.abs(x / 1000))
  const zE = end * L2
  if (xAt(zE, y) >= ax) return [x / 1000, y, zE + end * lift]
  const z = solve((zz) => xAt(zz, y) - ax, end * 1.75, zE)
  return [x / 1000, y, z + end * lift]
}
/** Across the roof at d: f from -1 (the right rail) through 0 (the center) to 1 (the left rail). */
const RF = (d: number, f: number, lift = 0.004): Vec3 => {
  const z = zOf(d)
  const [x, y] = sec(z, 7 - Math.min(1, Math.abs(f)))
  return [Math.sign(f) * x, y + lift, z]
}

/** The body at height h from d0 on the left, around the end and back along the right: a plan curve. */
function around(h: number, d0: number, end: 1 | -1, n = 22, lift = 0.004): Vec3[] {
  const y = h / 1000
  const z0 = zOf(d0), zE = end * L2
  const z1 = xAt(zE, y) > 0.005 ? zE : solve((zz) => xAt(zz, y) - 0.005, end * 1.75, zE)
  const half: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const z = z0 + (z1 - z0) * Math.sin(((i / n) * Math.PI) / 2)
    half.push([xAt(z, y) + lift, y, z + (i === n ? end * lift : 0)])
  }
  const right = half.slice().reverse().map(([x, yy, z]): Vec3 => [-x, yy, z])
  if (half[n][0] < 0.02) right.shift()
  return [...half, ...right]
}

/** A wheel arch's cut: inside it the lower body's lines stop. */
const archDist = (z: number, y: number) => Math.min(Math.hypot(z - ZF, y - WR), Math.hypot(z - ZR, y - WR)) - RA

/** The stations: denser at the nose and tail, where the plan turns. */
const NZ = 64
const STATIONS = Array.from({ length: NZ + 1 }, (_, i) => L2 * Math.sin(((i / NZ) * 2 - 1) * (Math.PI / 2)))

/** A line along the body at section parameter u, between blueprint d0 and d1, cut at the arches when `arches`; `coarse` takes every other station. */
function along(b: Builder, u: number, s: 1 | -1, st: Style, o: { d0?: number; d1?: number; arches?: boolean; lift?: number; coarse?: boolean } = {}) {
  const zHi = zOf(o.d0 ?? 0), zLo = zOf(o.d1 ?? BL)
  const zs = [zHi, ...STATIONS.filter((z, i) => z < zHi && z > zLo && (!o.coarse || i % 2 === 0)).reverse(), zLo]
  const lift = o.lift ?? 0
  const P = (z: number): Vec3 => { const [x, y] = sec(z, u); return [s * (x + lift), y, z] }
  let run: Vec3[] = []
  const flush = () => { if (run.length > 1) b.poly(run, false, st); run = [] }
  let prev: number | null = null
  for (const z of zs) {
    const out = !o.arches || archDist(z, sec(z, u)[1]) >= 0
    if (prev !== null && o.arches) {
      const pz = prev
      const was = archDist(pz, sec(pz, u)[1]) >= 0
      if (was !== out) {
        run.push(P(solve((zz) => archDist(zz, sec(zz, u)[1]), pz, z)))
        if (!out) flush()
      }
    }
    if (out) run.push(P(z))
    prev = z
  }
  flush()
}

/** The section at d from u0 up to u1 on both sides, joined over the top when u1 is 7; cut at the arches. */
function rib(b: Builder, d: number, u0: number, u1: number, st: Style) {
  const z = zOf(d)
  const us = [u0, ...U_STEPS.filter((u) => u > u0 && u < u1), u1]
  const half = us.map((u) => sec(z, u))
  const runs = (s: 1 | -1): Vec3[][] => {
    const out: Vec3[][] = []
    let run: Vec3[] = []
    for (const [x, y] of half) {
      if (archDist(z, y) < 0) { if (run.length > 1) out.push(run); run = []; continue }
      run.push([s * x, y, z])
    }
    if (run.length > 1) out.push(run)
    return out
  }
  const L = runs(1), R = runs(-1)
  if (u1 >= 7 && L.length && R.length) {
    const l = L.pop()!, r = R.pop()!
    b.poly([...l, ...r.reverse().slice(1)], false, st)
  }
  for (const r of [...L, ...R]) b.poly(r, false, st)
}

/** A path of [d, h] pairs on the side. */
const sidePath = (b: Builder, pts: P2[], s: 1 | -1, st: Style, closed = false, lift = 0.004) => b.poly(pts.map(([d, h]) => SP(d, h, s, lift)), closed, st)

/** Densify a [d, h] polyline so long runs follow the curved surface. */
function dense(pts: P2[], step = 60): P2[] {
  const out: P2[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [a, c] = [pts[i - 1], pts[i]]
    const n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / step))
    for (let k = 1; k <= n; k++) out.push(lerp2(a, c, k / n))
  }
  return out
}

// ---------- styles ----------

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const SHf: Style = { layer: 'shell', w: 0.35 }
const FG: Style = { layer: 'fg', w: 0.8 }
const FGd: Style = { layer: 'fg', w: 0.5 }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const MESHf: Style = { layer: 'mesh', w: 0.38 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

// ---------- the body ----------

function body(b: Builder) {
  for (const s of [1, -1] as const) {
    // the long lines: the sill, the widest, the shoulder crease, the belt and the rail, with the skin's contours between them
    along(b, 1.5, s, MESHd, { arches: true, coarse: true })
    along(b, 2, s, SH, { arches: true })
    along(b, 2.5, s, MESHd, { arches: true, coarse: true })
    along(b, 3, s, SHd, { arches: true })
    along(b, 3.5, s, MESHd, { arches: true, coarse: true })
    along(b, 4, s, SH, { d0: 160 })
    along(b, 4.5, s, MESHd, { d0: 120, coarse: true })
    along(b, 5, s, SH, { d0: 100 })
    along(b, 6, s, FG, { d0: COWL, d1: 4740 })
    along(b, 6, s, SHf, { d0: 90, d1: COWL })
    along(b, 5.5, s, MESHd, { d0: 90, d1: COWL + 20, coarse: true })
    along(b, 6.5, s, MESHd, { d0: 80, d1: COWL, coarse: true })
    along(b, 5.5, s, MESHd, { d0: 4380, d1: BL, coarse: true })
    along(b, 6.5, s, MESHd, { d0: 4430, d1: BL, coarse: true })
    // the paint's lower edge between the arches (black cladding below it), the side crease, the lower swoosh
    sidePath(b, dense([[1345, 305], [3330, 305]], 120), s, SHd)
    sidePath(b, dense([[1345, 880], [2000, 893], [2700, 908], [3300, 926], [3590, 936]], 120), s, SHf)
    sidePath(b, dense([[1418, 462], [2000, 520], [2600, 600], [3100, 690], [3400, 770], [3590, 845]], 120), s, SHf)
  }
  // the spine over the hood and the deck
  along(b, 7, 1, MESHd, { d0: 70, d1: COWL })
  along(b, 7, 1, MESHd, { d0: 4450, d1: BL })

  // cross sections every 250 mm: the lower body all along, over the top ahead of the windshield and behind the rear glass
  for (let d = 125; d < BL; d += 250) {
    if (d < COWL || d > 4500) rib(b, d, 1, 7, MESHd)
    else rib(b, d, 1, 5, MESHd)
  }
  // the end sections: the bumper face at the nose, the tail face
  rib(b, 0, 1, 7, SHd)
  rib(b, BL, 1, 7, SHd)

  // ---- wheel arches: the paint edge, the black flare inside it, the liner ----
  for (const zc of [ZF, ZR]) for (const s of [1, -1] as const) {
    const edge: Vec3[] = [], flare: Vec3[] = [], liner: Vec3[] = []
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI
      const z = zc + RA * Math.cos(a), y = WR + RA * Math.sin(a)
      if (y < 0.3) continue
      edge.push([s * (xAt(z, y) + 0.004), y, z])
      const r2 = RA - 0.05
      const z2 = zc + r2 * Math.cos(a), y2 = WR + r2 * Math.sin(a)
      flare.push([s * (xAt(z, y) + 0.018), y2, z2])
      liner.push([s * (xAt(z, y) - 0.2), WR + (RA + 0.015) * Math.sin(a), zc + (RA + 0.015) * Math.cos(a)])
    }
    b.poly(edge, false, FG)
    b.poly(flare, false, SHd)
    b.poly(liner, false, MESHd)
    for (let i = 0; i < edge.length; i += 5) b.line(flare[i], liner[i], MESHf)
  }
  // the rear arch's haunch: the eyebrow over the rear wheel
  for (const s of [1, -1] as const) {
    const pts: Vec3[] = []
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI * (0.78 - 0.56 * (i / 16))
      pts.push(SP(dOf(ZR + 0.545 * Math.cos(a)), (WR + 0.545 * Math.sin(a)) * 1000, s, 0.004))
    }
    b.poly(pts, false, MESHd)
  }

  // ---- bumpers: the black lip under the nose, the diffuser at the tail ----
  b.poly(around(305, 431, 1), false, SHd)
  for (const s of [1, -1] as const) sidePath(b, dense([[4262, 400], [4400, 440], [4520, 490], [4640, 556], [4712, 600]], 60), s, SHd)
  b.poly(around(600, 4712, -1, 8), false, SHd)
  b.poly(around(420, 4560, -1, 14), false, MESHd)
}

/** Windshield, glass roof, rear glass and the side windows, with their faint faces. */
function glass(b: Builder) {
  const span = (d0: number, d1: number, f: number, n: number) => {
    const edge = (d: number) => Array.from({ length: n + 1 }, (_, i) => RF(d, -f + (2 * f * i) / n))
    const side = (ff: number) => Array.from({ length: n + 1 }, (_, i) => RF(d0 + ((d1 - d0) * i) / n, ff))
    return { edge, side }
  }
  const faces = (d0: number, d1: number, f: number, strips: number, w: number) => {
    for (let k = 0; k < strips; k++) {
      const a = -f + (2 * f * k) / strips, c = -f + (2 * f * (k + 1)) / strips
      b.face([RF(d0, a, 0.003), RF(d0, c, 0.003), RF(d1, c, 0.003), RF(d1, a, 0.003)], 'fg', w)
    }
  }
  // the windshield, the cowl to the header; its base runs a little forward at the center
  {
    const n = 14
    const base = Array.from({ length: n + 1 }, (_, i) => { const f = -0.96 + (1.92 * i) / n; return RF(1270 + 40 * f * f, f) })
    const head = span(1300, 2214, 0.96, n).edge(2214)
    b.poly(base, false, FG)
    b.poly(head, false, FGd)
    for (const f of [-0.96, 0.96]) b.poly(Array.from({ length: 13 }, (_, i) => RF(1270 + 40 * 0.92 + ((2214 - 1307) * i) / 12, f)), false, FG)
    // the black frit band along the base and the camera housing behind the mirror
    b.poly(span(1340, 2214, 0.8, n).edge(1340), false, MESHf)
    b.rect(RF(2140, 0, 0.002), X, norm([0, 0.25, -1]), 0.16, 0.07, SHd, 0.015)
    faces(1300, 2214, 0.96, 6, 1.6)
  }
  // the glass roof: one panel from the header bar to the bar over the liftgate
  {
    const g = span(2240, 3735, 0.9, 14)
    b.poly(g.edge(2240), false, FGd)
    b.poly(g.edge(3735), false, FGd)
    b.poly(g.side(0.9), false, FGd)
    b.poly(g.side(-0.9), false, FGd)
    for (const d of [2226, 3752]) b.poly(span(0, 0, 0.98, 14).edge(d), false, SH)
    for (const f of [-0.45, 0, 0.45]) b.poly(span(2260, 3715, f, 12).side(f), false, MESHf)
    faces(2240, 3735, 0.9, 4, 1.4)
  }
  // the rear glass on the liftgate, its lower edge rounded into the spoiler
  {
    const n = 14
    const topEdge = Array.from({ length: n + 1 }, (_, i) => RF(3775, -0.86 + (1.72 * i) / n))
    const left: Vec3[] = []
    for (let i = 1; i <= 10; i++) left.push(RF(3775 + ((4400 - 3775) * i) / 10, 0.86))
    for (let i = 1; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); left.push(RF(4400 + 130 * Math.sin(a), 0.86 * Math.cos(a))) }
    const right = left.slice(0, -1).reverse().map(([x, y, z]): Vec3 => [-x, y, z])
    b.poly([...topEdge, ...left, ...right], true, FGd)
    faces(3775, 4400, 0.86, 4, 1.2)
  }

  // the side windows: front door, rear door and the quarter glass that kicks up into the C-pillar
  for (const s of [1, -1] as const) {
    const top = (d0: number, d1: number, off = 25): P2[] => Array.from({ length: 9 }, (_, i) => { const d = d0 + ((d1 - d0) * i) / 8; return [d, yRlCabin(zOf(d)) * 1000 - off] })
    const front: P2[] = [[1445, 1103], [2050, 1107], [2655, 1115], ...top(2690, 1445, 30).slice(0, 8), [1520, 1180]]
    const rear: P2[] = [[2775, 1118], [3150, 1128], [3495, 1143], ...top(3500, 2815)]
    const quarter: P2[] = [[3625, 1150], [3750, 1176], [3850, 1214], [3935, 1268], [3978, 1322], ...top(3965, 3630)]
    for (const w of [front, rear, quarter]) sidePath(b, dense(w, 90), s, FGd, true, 0.005)
    // the black B and C pillars between them
    sidePath(b, [[2655, 1115], [2690, 1546]], s, SHd)
    sidePath(b, [[2775, 1118], [2815, 1551]], s, SHd)
    sidePath(b, [[3495, 1143], [3500, 1487]], s, SHd)
    sidePath(b, [[3625, 1150], [3630, 1437]], s, SHd)
    // faint glass faces
    for (const w of [front, rear, quarter]) {
      const n = w.length
      const k = Math.floor(n / 2)
      b.face([SP(w[0][0], w[0][1], s, 0.003), SP(w[k - 1][0], w[k - 1][1], s, 0.003), SP(w[k][0], w[k][1], s, 0.003), SP(w[n - 1][0], w[n - 1][1], s, 0.003)], 'fg', 0.7)
    }
  }
}

/** Doors, handles, the hood, the liftgate, the mirrors and the side cameras. */
function panels(b: Builder) {
  for (const s of [1, -1] as const) {
    // front door: from behind the front arch to the B-pillar; rear door: to the C-pillar, round the rear arch
    sidePath(b, dense([[1440, 1100], [1400, 1000], [1385, 900], [1380, 750], [1386, 600], [1398, 480], [1420, 320]], 80), s, SHd)
    sidePath(b, dense([[2652, 1112], [2630, 700], [2605, 320]], 120), s, SHd)
    const rearEdge: P2[] = [[3640, 1160], [3622, 1000], [3600, 880]]
    for (let i = 1; i <= 8; i++) {
      const a = Math.PI * (0.62 + 0.3 * (i / 8))
      rearEdge.push([dOf(ZR + 0.53 * Math.cos(a)), (WR + 0.53 * Math.sin(a)) * 1000])
    }
    rearEdge.push([3290, 320])
    sidePath(b, dense(rearEdge, 80), s, SHd)
    // flush handles
    for (const [d0, d1, h] of [[2315, 2515, 968], [3344, 3544, 1020]]) {
      sidePath(b, [[d0, h + 8], [d1, h + 12], [d1 - 12, h - 8], [d0 + 10, h - 12]], s, SH, true, 0.006)
      sidePath(b, [[d0 + 30, h - 2], [d1 - 40, h + 2]], s, SHf, false, 0.007)
    }
    // the side repeater camera on the front fender, behind the arch
    sidePath(b, [[1195, 855], [1340, 878], [1330, 842], [1250, 800]], s, FGd, true, 0.008)
    sidePath(b, [[1300, 862], [1300, 830]], s, SHf, false, 0.009)

    // the mirror: its stalk on the door's sail, the head, the glass facing back
    const base = SP(1500, 1115, s, 0)
    const c: Vec3 = [s * 0.985, 1.165, zOf(1640)]
    // the slab's normal (u x v) faces forward on both sides: the back face is the glass
    const u = norm([1, 0, -0.18 * s]), v = norm([0, 1, 0.05])
    const f = b.roundSlab(c, u, v, 0.215, 0.13, 0.1, 0.05, SH, FGd, SHd, 4)
    b.face(f.back, 'fg', 0.6)
    const inner = add(c, scale(norm([-s, 0, 0.18]), 0.09))
    b.line(base, inner, SHd)
    b.line(add(base, [0, -0.03, -0.06]), add(inner, [0, -0.04, -0.03]), SHd)
  }
  // the hood: its shut lines along the fenders, from the light bar to the cowl; the cowl
  const hoodW: P2[] = [[150, 480], [300, 545], [600, 610], [900, 655], [1200, 690], [1265, 700]]
  const hw = mono(hoodW)
  for (const s of [1, -1]) b.poly(Array.from({ length: 13 }, (_, i) => { const d = 150 + ((1262 - 150) * i) / 12; return TP(d, s * hw(d)) }), false, SHd)
  b.poly(Array.from({ length: 15 }, (_, i) => TP(1262, -700 + (1400 * i) / 14)), false, SHd)
  // the liftgate: its shut lines down the tail face, its lower edge over the bumper
  for (const x of [-620, 620]) b.poly([EP(x, 1175, -1), EP(x, 1000, -1), EP(x, 850, -1), EP(x, 700, -1)], false, SHd)
  b.poly(Array.from({ length: 13 }, (_, i) => EP(-620 + (1240 * i) / 12, 690, -1)), false, SHd)
  // the spoiler lip's underside, the plate recess, the reflectors on the diffuser
  b.poly(Array.from({ length: 15 }, (_, i) => EP(-640 + (1280 * i) / 14, 1180, -1, 0.012)), false, SHd)
  b.poly([EP(-260, 470, -1), EP(260, 470, -1), EP(260, 570, -1), EP(-260, 570, -1)], true, MESHd)
  for (const s of [1, -1]) b.poly([EP(s * 370, 548, -1), EP(s * 560, 552, -1), EP(s * 560, 562, -1), EP(s * 380, 560, -1)], true, SHd)
  // diffuser fins
  for (const x of [-330, -110, 110, 330]) b.poly([EP(x, 420, -1), EP(x * 0.97, 300, -1), EP(x * 0.95, 240, -1)], false, MESHd)
  // the front plate area and the lower intake with its slats
  b.poly([EP(-250, 500, 1), EP(250, 500, 1), EP(250, 580, 1), EP(-250, 580, 1)], true, MESHf)
  const intake: Vec3[] = []
  for (let i = 0; i <= 12; i++) { const x = -540 + (1080 * i) / 12; intake.push(EP(x, 445 - 12 * (x / 540) ** 2, 1)) }
  for (const [x, h] of [[500, 380], [470, 300], [430, 262]] as const) intake.push(EP(x, h, 1))
  for (let i = 1; i < 12; i++) { const x = 430 - (860 * i) / 12; intake.push(EP(x, 258, 1)) }
  for (const [x, h] of [[-430, 262], [-470, 300], [-500, 380]] as const) intake.push(EP(x, h, 1))
  b.poly(intake, true, SH)
  for (const h of [300, 340, 380, 415]) { const w = 430 + (h - 262) * 0.48; b.poly(Array.from({ length: 7 }, (_, i) => EP(-w + (2 * w * i) / 6, h, 1, 0.002)), false, MESHd) }
  // the air curtains in the bumper corners, under the headlamps
  for (const s of [1, -1]) for (const o of [0, 18]) b.poly([EP(s * (858 - o), 560, 1), EP(s * (862 - o), 450, 1), EP(s * (866 - o), 340, 1)], false, SHd)
}

// ---------- lights ----------

/** The light bar along the hood's leading edge, round the corners onto the fenders; the slim headlamps; the tail. */
function lights(b: Builder) {
  const L = hot('lights', 1), Ld = hot('lights', 0.6), Lf = hot('lights', 0.3)
  // the front bar: on the side from its end back on the fender, round the corner, across the nose
  const bar = (dh: number, lift: number): Vec3[] => {
    // the fender part, from its end back at d 480 to where the body is 860 mm out at its height
    const left: Vec3[] = []
    for (let i = 0; i <= 4; i++) { const d = 480 - 110 * (i / 4); left.push(SP(d, 822 - 10 * (i / 4) + dh, 1, lift)) }
    // across the nose, as the front view places it: 770 mm at the center rising to 805 at the corners
    const front: Vec3[] = []
    for (let i = 0; i <= 20; i++) {
      const x = 840 - (1680 * i) / 20
      front.push(EP(x, 770 + 40 * (x / 840) ** 2 + dh, 1, lift))
    }
    const right = left.slice().reverse().map(([x, y, z]): Vec3 => [-x, y, z])
    return [...left, ...front, ...right]
  }
  b.poly(bar(7, 0.006), false, L)
  b.poly(bar(-7, 0.006), false, L)
  b.poly(bar(0, 0.008), false, Ld)

  // the headlamps: slim lenses low in the bumper corners, wrapping onto the sides
  for (const s of [1, -1] as const) {
    // the inner tip on the bumper face, the top edge out to the corner and back onto the side, the bottom edge home
    const pts: Vec3[] = []
    for (const x of [660, 720, 790, 860, 900]) pts.push(EP(s * x, 628 + (x - 660) * 0.12, 1, 0.006))
    for (const d of [300, 370]) pts.push(SP(d, 655, s, 0.006))
    pts.push(SP(345, 603, s, 0.006))
    for (const x of [900, 850, 780, 710]) pts.push(EP(s * x, 590 + (900 - x) * 0.12, 1, 0.006))
    b.poly(pts, true, Ld)
    b.poly([EP(s * 690, 625, 1, 0.008), EP(s * 800, 638, 1, 0.008), EP(s * 890, 645, 1, 0.008), SP(340, 640, s, 0.008)], false, L)
    b.circle(EP(s * 830, 622, 1, 0.006), X, Y, 0.016, 10, Lf)
  }

  // the tail: the bar across the liftgate under the spoiler, ending in C-shaped lamps that wrap onto the quarters
  const tail = (h: number, lift: number): Vec3[] => Array.from({ length: 15 }, (_, i) => EP(-600 + (1200 * i) / 14, h, -1, lift))
  b.poly(tail(1098, 0.006), false, L)
  b.poly(tail(1062, 0.006), false, Ld)
  b.poly(tail(1080, 0.008), false, L)
  // the indirect light below it, reflected off the liftgate
  for (const [h, w] of [[1046, 0.35], [1028, 0.24], [1008, 0.15]] as const) b.poly(tail(h, 0.004).slice(2, 13), false, hot('lights', w))
  for (const s of [1, -1] as const) {
    // the lamp's outline: across the corner of the tail face, then the teardrop along the quarter
    // the top edge from the bar's end round the corner to the lamp's forward tip on the quarter, the bottom edge back
    const o: Vec3[] = [EP(s * 600, 1112, -1, 0.006), EP(s * 700, 1114, -1, 0.006), EP(s * 790, 1114, -1, 0.006)]
    for (const d of [4420, 4330, 4245]) o.push(SP(d, 1120, s, 0.006))
    for (const [d, h] of [[4300, 1088], [4380, 1048], [4460, 1012]] as const) o.push(SP(d, h, s, 0.006))
    o.push(EP(s * 790, 978, -1, 0.006), EP(s * 700, 962, -1, 0.006), EP(s * 615, 975, -1, 0.006), EP(s * 600, 1040, -1, 0.006))
    b.poly(o, true, Ld)
    // the C: round the lamp's outer end, open toward the center bar
    const c: Vec3[] = [EP(s * 650, 1092, -1, 0.008), EP(s * 760, 1095, -1, 0.008), EP(s * 830, 1080, -1, 0.008), EP(s * 845, 1040, -1, 0.008), EP(s * 800, 1000, -1, 0.008), EP(s * 700, 988, -1, 0.008), EP(s * 650, 990, -1, 0.008)]
    b.poly(c, false, L)
    b.poly([SP(4280, 1108, s, 0.008), SP(4360, 1085, s, 0.008), EP(s * 800, 1060, -1, 0.008)], false, Lf)
  }

  // TESLA across the band between the spoiler lip and the bar
  const glyph: Record<string, P2[][]> = {
    T: [[[0, 1], [0.7, 1]], [[0.35, 1], [0.35, 0]]],
    E: [[[0.7, 1], [0, 1], [0, 0], [0.7, 0]], [[0, 0.5], [0.6, 0.5]]],
    S: [[[0.7, 1], [0, 1], [0, 0.5], [0.7, 0.5], [0.7, 0], [0, 0]]],
    L: [[[0, 1], [0, 0], [0.7, 0]]],
    A: [[[0, 0], [0, 1], [0.7, 1], [0.7, 0]], [[0, 0.5], [0.7, 0.5]]],
  }
  const word = 'TESLA'
  const H = 26, step = 150
  for (let i = 0; i < word.length; i++) {
    const x0 = -((word.length - 1) * step) / 2 + i * step - 25
    for (const stroke of glyph[word[i]]) b.poly(stroke.map(([x, y]) => EP(x0 + x * 70, 1128 + y * H, -1, 0.006)), false, SHd)
  }
}

// ---------- wheels ----------

/** A 255/45 R19 tire on a 19 in Crossflow aero wheel: ten twisted blades, the disc and caliper behind them. */
function wheel(b: Builder, zc: number, s: 1 | -1, front: boolean) {
  const at = (x: number, r: number, a: number): Vec3 => [s * x, WR + Math.sin(a) * r, zc + Math.cos(a) * r]
  const ring = (x: number, r: number, n: number, st: Style) => b.circle([s * x, WR, zc], Z, Y, r, n, st)
  const xo = TX + TW / 2, xi = TX - TW / 2
  // the tire: its shoulders and crown, the outer sidewall's bulge and bead, the inner sidewall, the tread blocks
  ring(xo - 0.014, WR - 0.014, 36, SH)
  ring(xi + 0.014, WR - 0.014, 30, SHd)
  ring(xo, 0.305, 32, SHd)
  ring(xo - 0.012, 0.258, 28, SHf)
  ring(xi, 0.3, 24, SHf)
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2
    b.line(at(xi + 0.02, WR - 0.004, a), at(xo - 0.02, WR - 0.004, a + 0.06), SHf)
  }
  // the rim's lip and the aero face's blades, dished in toward the hub
  const xf = TX + 0.095
  ring(xf + 0.004, 0.246, 36, FG)
  ring(xf - 0.006, 0.232, 30, SHd)
  ring(TX - 0.085, 0.236, 20, SHf)
  for (let k = 0; k < 10; k++) {
    const a0 = (k / 10) * Math.PI * 2 + (front ? 0.2 : 0.5)
    const lead: Vec3[] = [], trail: Vec3[] = []
    for (let i = 0; i <= 4; i++) {
      const t = i / 4
      const r = 0.07 + (0.228 - 0.07) * t
      const tw = s * (0.5 * t * t + 0.12 * t)
      const x = xf - 0.035 * (1 - t) * (1 - t)
      lead.push(at(x, r, a0 + tw))
      trail.push(at(x - 0.006, r, a0 + tw - 0.3 + 0.04 * t))
    }
    b.poly(lead, false, SHd)
    b.poly(trail, false, SHf)
  }
  ring(xf - 0.035, 0.07, 16, SHd)
  ring(xf - 0.03, 0.042, 10, FGd)
  // the disc (355 mm front, 335 rear), its hat, and the caliper on the trailing side
  const rd = front ? 0.1775 : 0.1675
  ring(TX - 0.03, rd, 24, SHf)
  ring(TX - 0.03, 0.095, 12, MESHd)
  ring(TX - 0.058, rd, 16, MESHd)
  const cal = (x: number): Vec3[] => {
    const pts: Vec3[] = []
    for (let i = 0; i <= 5; i++) pts.push(at(x, rd + 0.018, Math.PI * (0.78 + 0.32 * (i / 5))))
    for (let i = 5; i >= 0; i--) pts.push(at(x, rd - 0.05, Math.PI * (0.8 + 0.28 * (i / 5))))
    return pts
  }
  const c1 = cal(TX - 0.005), c2 = cal(TX - 0.06)
  b.poly(c1, true, SH)
  b.poly(c2, true, SHd)
  for (const i of [0, 5, 6, 11]) b.line(c1[i], c2[i], SHd)
}

/** A coil spring and its damper between two points (the corner's coilover). */
function coilover(b: Builder, a: Vec3, c: Vec3, r: number, turns: number) {
  const ax = norm([c[0] - a[0], c[1] - a[1], c[2] - a[2]])
  const u = norm(cross(ax, X)), v = norm(cross(ax, u))
  const n = turns * 8
  const pts: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, ang = t * turns * Math.PI * 2
    const p = add(a, scale([c[0] - a[0], c[1] - a[1], c[2] - a[2]], 0.1 + 0.75 * t))
    pts.push(add(p, add(scale(u, Math.cos(ang) * r), scale(v, Math.sin(ang) * r))))
  }
  b.poly(pts, false, SHf)
  b.line(a, c, SHd)
  b.circle(c, u, v, r * 1.25, 10, SHd)
  b.circle(add(a, scale([c[0] - a[0], c[1] - a[1], c[2] - a[2]], 0.1)), u, v, r * 1.15, 10, SHf)
}

// ---------- underneath and inside ----------

/** The structural pack under the floor: its case, ten module bands of cells, the penthouse and the high-voltage cables. */
function pack(b: Builder) {
  const x0 = 0.74, y0 = 0.17, y1 = 0.3, z0 = -1.0, z1 = 0.98
  const P = hot('battery', 0.6)
  b.chamferBox([0, (y0 + y1) / 2, (z0 + z1) / 2], [x0, (y1 - y0) / 2, (z1 - z0) / 2], 0.035, (axis) => (axis === 1 ? P : hot('battery', 0.42)), hot('battery', 0.35))
  // the lid's seam down the middle and its rails along the sides
  b.line([0, y1 + 0.003, z0 + 0.05], [0, y1 + 0.003, z1 - 0.05], hot('battery', 0.7))
  for (const x of [-x0 + 0.06, x0 - 0.06]) b.line([x, y1 + 0.003, z0 + 0.05], [x, y1 + 0.003, z1 - 0.05], hot('battery', 0.4))
  // ten bands, the first at the rear; cells in two staggered rows across each
  const n = 10, zA = z0 + 0.05, zB = z1 - 0.05, gap = 0.018
  for (let k = 0; k < n; k++) {
    const g = `battery.c${k}`
    const za = zA + ((zB - zA) * k) / n + gap / 2, zb = zA + ((zB - zA) * (k + 1)) / n - gap / 2
    const zc = (za + zb) / 2, yc = y1 - 0.004
    b.rect([0, yc, zc], X, Z, 2 * x0 - 0.16, zb - za, hot(g, 0.75), 0.012)
    for (const [dz, off] of [[-0.042, 0], [0.042, 0.04]] as const) {
      for (let i = 0; i < 16; i++) {
        const x = -0.6 + off + i * 0.08
        if (x > 0.62) continue
        b.line([x, yc, zc + dz - 0.022], [x, yc, zc + dz + 0.022], hot(g, 0.42))
      }
    }
    b.line([-x0 + 0.08, y0 + 0.02, zc], [x0 - 0.08, y0 + 0.02, zc], hot(g, 0.2))
  }
  // the penthouse at the rear: the junction, the charger and the DC-DC, where the charge cable comes in
  b.box([-0.32, y1, z0 + 0.02], [0.4, y1 + 0.085, z0 + 0.2], hot('battery', 0.55))
  b.rect([0.2, y1 + 0.088, z0 + 0.11], X, Z, 0.24, 0.12, hot('battery', 0.35), 0.01)
  // the orange cables forward to the front drive unit and back to the rear one
  b.tube([-0.1, y1 + 0.04, z1 - 0.04], [-0.12, 0.4, 1.12], [-0.1, 0.46, 1.25], [-0.06, 0.48, ZF - 0.16], 0.016, X, 10, hot('battery', 0.38))
  b.tube([-0.12, y1 + 0.06, z0 + 0.02], [-0.12, 0.42, -1.12], [-0.1, 0.5, -1.2], [-0.06, 0.55, ZR + 0.2], 0.016, X, 10, hot('battery', 0.38))
}

/** The front and rear drive units on the axles, with their half shafts, and the four corners' coilovers. */
function driveUnits(b: Builder) {
  const du = (zc: number, big: boolean) => {
    const r = big ? 0.13 : 0.11, len = big ? 0.38 : 0.32
    const zm = zc + (big ? 0.13 : -0.12)
    // the motor: a drum across the car, its end bells
    for (const x of [-0.24, -0.24 + len]) b.circle([x, 0.4, zm], Z, Y, r, 18, SHd)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      b.line([-0.24, 0.4 + Math.sin(a) * r, zm + Math.cos(a) * r], [-0.24 + len, 0.4 + Math.sin(a) * r, zm + Math.cos(a) * r], SHf)
    }
    // the gearbox beside it on the axle, and the inverter on top
    b.chamferBox([0.24, 0.39, zc + (big ? 0.03 : -0.02)], [0.1, 0.15, big ? 0.2 : 0.17], 0.03, () => SHd, SHf)
    b.chamferBox([-0.05, 0.4 + r + 0.05, zm], [0.2, 0.04, big ? 0.13 : 0.11], 0.015, () => SHd, SHf)
    // half shafts with their CV joints
    for (const s of [1, -1] as const) {
      const a: Vec3 = [s * (s > 0 ? 0.34 : 0.26), WR, zc], c: Vec3 = [s * (TX - 0.1), WR, zc]
      b.line(a, c, SHd)
      b.circle(add(a, [s * 0.04, 0, 0]), Z, Y, 0.045, 10, SHf)
      b.circle(add(c, [-s * 0.04, 0, 0]), Z, Y, 0.045, 10, SHf)
    }
  }
  du(ZF, false)
  du(ZR, true)
  for (const s of [1, -1] as const) {
    coilover(b, [s * 0.64, 0.3, ZF - 0.02], [s * 0.6, 0.82, ZF - 0.1], 0.062, 6)
    coilover(b, [s * 0.6, 0.27, ZR + 0.12], [s * 0.56, 0.66, ZR + 0.1], 0.06, 5)
    // lower arms
    b.poly([[s * 0.7, 0.24, ZF], [s * 0.34, 0.26, ZF + 0.16], [s * 0.34, 0.26, ZF - 0.2]], true, SHf)
    b.poly([[s * 0.7, 0.24, ZR], [s * 0.32, 0.27, ZR + 0.2], [s * 0.32, 0.27, ZR - 0.14]], true, SHf)
  }
  // the steering rack behind the front axle and its tie rods
  b.line([-0.42, 0.42, ZF - 0.16], [0.42, 0.42, ZF - 0.16], SHd)
  for (const s of [1, -1]) b.line([s * 0.42, 0.42, ZF - 0.16], [s * 0.72, 0.4, ZF - 0.13], SHf)
  // the front trunk's tub and the heat exchangers behind the intake, the trunk and its sub-trunk well
  b.box([-0.46, 0.46, 1.62], [0.46, 0.84, 2.12], MESHf, { top: true })
  b.rect([0, 0.43, 2.2], X, Y, 0.86, 0.26, MESHd, 0.02)
  for (let i = 1; i < 12; i++) { const x = -0.43 + (0.86 * i) / 12; b.line([x, 0.31, 2.2], [x, 0.55, 2.2], MESHf) }
  b.box([-0.56, 0.42, -2.22], [0.56, 0.72, -1.62], MESHf, { top: true })
  b.box([-0.42, 0.26, -2.12], [0.42, 0.42, -1.72], MESHf, { top: true })
}

/** Five seats, the dash with its ambient strip, the wheel, the 15.4 in screen and the rear 8 in screen. */
function cabin(b: Builder) {
  const SEAT: Style = { layer: 'shell', w: 0.4 }, SEATe = MESHd
  // front seats: cushion and a reclined back with its headrest, outlined on both sides and joined
  const zh = zOf(2420)
  for (const xs of [0.37, -0.37]) {
    const side = (x: number): Vec3[] => [
      [x, 0.52, zh + 0.46], [x, 0.6, zh + 0.48], [x, 0.62, zh + 0.1], [x, 0.58, zh - 0.02],
      [x, 1.12, zh - 0.24], [x, 1.18, zh - 0.18], [x, 1.14, zh - 0.1], [x, 0.66, zh + 0.06],
    ]
    const l = side(xs - 0.25), r = side(xs + 0.25)
    b.poly(l, false, SEAT)
    b.poly(r, false, SEAT)
    for (const i of [1, 2, 4, 5]) b.line(l[i], r[i], SEATe)
    b.roundRect([xs, 1.3, zh - 0.26], X, norm([0, 1, 0.25]), 0.26, 0.15, 0.04, SEAT, 3)
    b.line([xs - 0.06, 1.18, zh - 0.22], [xs - 0.06, 1.23, zh - 0.24], SEATe)
    b.line([xs + 0.06, 1.18, zh - 0.22], [xs + 0.06, 1.23, zh - 0.24], SEATe)
  }
  // rear bench: three places and three headrests
  const zr = zOf(3330)
  const bench = (x: number): Vec3[] => [[x, 0.56, zr + 0.48], [x, 0.66, zr + 0.46], [x, 0.68, zr + 0.02], [x, 1.14, zr - 0.2], [x, 1.18, zr - 0.13], [x, 0.72, zr + 0.08]]
  const bl = bench(0.7), br = bench(-0.7)
  b.poly(bl, false, SEAT)
  b.poly(br, false, SEAT)
  for (const i of [1, 2, 3, 4]) b.line(bl[i], br[i], SEATe)
  for (const x of [-0.24, 0.24]) b.line([x, 0.68, zr + 0.02], [x, 1.14, zr - 0.2], SEATe)
  for (const x of [-0.45, 0, 0.45]) b.roundRect([x, 1.26, zr - 0.21], X, norm([0, 1, 0.2]), x === 0 ? 0.2 : 0.25, 0.12, 0.035, SEAT, 3)

  // the dash: its top across the car, and the ambient strip under it running on into the doors
  const zd = zOf(1580)
  const dash: Vec3[] = []
  for (let i = 0; i <= 16; i++) { const x = -0.8 + (1.6 * i) / 16; dash.push([x, 0.96 + 0.02 * (1 - (x / 0.8) ** 2), zd - 0.05 * (1 - (x / 0.8) ** 2)]) }
  b.poly(dash, false, SHd)
  b.poly(dash.map(([x, y, z]): Vec3 => [x, y - 0.16, z - 0.12]), false, SHf)
  const amb = hot('cabin', 0.55)
  b.poly(dash.map(([x, , z]): Vec3 => [x * 1.02, 0.885, z - 0.06]), false, amb)
  for (const s of [1, -1]) {
    b.poly([[s * 0.816, 0.885, zd - 0.06], [s * 0.8, 0.9, zOf(2000)], [s * 0.79, 0.905, zOf(2600)]], false, amb)
    b.poly([[s * 0.79, 0.93, zOf(2820)], [s * 0.8, 0.94, zOf(3450)]], false, hot('cabin', 0.4))
  }
  // the wheel, on the left (+x), its three spokes and the column into the dash
  const wc: Vec3 = [0.37, 0.93, zOf(2030)]
  const n: Vec3 = norm([0, 0.42, -0.9])
  const wu = X, wv = norm(cross(n, X))
  b.circle(wc, wu, wv, 0.185, 28, SHd)
  b.circle(wc, wu, wv, 0.165, 24, SHf)
  b.circle(wc, wu, wv, 0.05, 10, SHf)
  for (const a of [0, Math.PI, -Math.PI / 2]) b.line(add(wc, add(scale(wu, Math.cos(a) * 0.05), scale(wv, Math.sin(a) * 0.05))), add(wc, add(scale(wu, Math.cos(a) * 0.165), scale(wv, Math.sin(a) * 0.165))), SHf)
  b.line(add(wc, scale(n, 0.03)), [0.37, 0.84, zd - 0.12], SHf)
  // the 15.4 in center screen, landscape over the dash, leaning back
  const sc: Vec3 = [0, 1.07, zd - 0.12]
  const up: Vec3 = norm([0, 0.95, 0.3])
  b.rect(sc, X, up, 0.36, 0.22, hot('cabin', 0.95), 0.012)
  b.rect(add(sc, [0, 0, -0.002]), X, up, 0.33, 0.19, hot('cabin', 0.5), 0.008)
  b.face([add(sc, add(scale(X, -0.17), scale(up, -0.1))), add(sc, add(scale(X, 0.17), scale(up, -0.1))), add(sc, add(scale(X, 0.17), scale(up, 0.1))), add(sc, add(scale(X, -0.17), scale(up, 0.1)))], 'fg', 0.9)
  // what is on it: the car on the left third, the map's roads on the rest
  const on = (x: number, y: number): Vec3 => add(add(sc, [0, 0, -0.003]), add(scale(X, x), scale(up, y)))
  b.poly([on(-0.15, -0.05), on(-0.15, 0.03), on(-0.11, 0.06), on(-0.08, 0.03), on(-0.08, -0.05)], false, hot('cabin', 0.4))
  b.poly([on(-0.04, -0.08), on(0.02, -0.02), on(0.06, 0.04), on(0.14, 0.07)], false, hot('cabin', 0.45))
  b.poly([on(0.0, 0.07), on(0.05, 0.0), on(0.15, -0.06)], false, hot('cabin', 0.3))
  b.line([0, 0.96, zd - 0.08], [0, 1.0, zd - 0.12], SHf)
  // the center console between the front seats, the rear passengers' 8 in screen at its back
  b.box([-0.12, 0.5, zOf(2700)], [0.12, 0.66, zd - 0.16], MESHf, { bottom: true })
  const rc: Vec3 = [0, 0.74, zOf(2690)]
  b.rect(rc, X, norm([0, 1, 0.25]), 0.19, 0.11, hot('cabin', 0.7), 0.01)
  b.rect(add(rc, [0, 0, -0.002]), X, norm([0, 1, 0.25]), 0.165, 0.09, hot('cabin', 0.35), 0.006)
}

/** The charge port in the left rear lamp (+x): its door, the NACS inlet, and the cable to the pack's penthouse. */
function chargePort(b: Builder): Vec3 {
  const d0 = 4275, d1 = 4385, h0 = 985, h1 = 1062
  const C = hot('charge', 0.85)
  b.poly(dense([[d0 + 15, h1], [d1 - 15, h1], [d1, h1 - 15], [d1, h0 + 15], [d1 - 15, h0], [d0 + 15, h0], [d0, h0 + 15], [d0, h1 - 15], [d0 + 15, h1]], 20).map(([d, h]) => SP(d, h, 1, 0.006)), false, C)
  // the inlet: the egg-shaped face with two large pins and three small
  const dc = (d0 + d1) / 2, hc = (h0 + h1) / 2
  const c = SP(dc, hc, 1, 0.008)
  const nrm = norm([1, 0, -0.32])
  const u = norm(cross(nrm, Y)), v = Y
  const egg: Vec3[] = []
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2
    egg.push(add(c, add(scale(u, Math.cos(a) * 0.032), scale(v, Math.sin(a) * (Math.sin(a) > 0 ? 0.03 : 0.022)))))
  }
  b.poly(egg, true, hot('charge', 1))
  for (const o of [-0.013, 0.013]) b.circle(add(c, add(scale(u, o), scale(v, 0.004))), u, v, 0.007, 8, hot('charge', 1))
  for (const [ou, ov] of [[-0.01, -0.014], [0.01, -0.014], [0, 0.02]] as const) b.circle(add(c, add(scale(u, ou), scale(v, ov))), u, v, 0.0035, 6, hot('charge', 0.8))
  // its cable inside the body, over the wheel well and down to the penthouse
  const inside = add(c, [-0.06, 0, 0])
  b.tube(inside, [0.66, 0.98, -1.95], [0.5, 0.62, -1.42], [0.28, 0.42, -0.9], 0.012, Y, 14, hot('charge', 0.75))
  return c
}

// ---------- the car ----------

export function modelY(): Model {
  const b = new Builder()
  body(b)
  glass(b)
  panels(b)
  lights(b)
  const port = chargePort(b)
  pack(b)
  driveUnits(b)
  cabin(b)
  for (const [zc, front] of [[ZF, true], [ZR, false]] as const) for (const s of [1, -1] as const) wheel(b, zc, s, front)

  // hotspots: the lid's seam over the middle of the pack, the port's inlet, the center screen
  b.hotspot('battery', [0, 0.303, -0.01], 'Battery')
  b.hotspot('charge', port, 'Charge port')
  b.hotspot('cabin', [0, 1.07, zOf(1580) - 0.122], 'Cabin')

  b.transform((p) => [p[0] * K, p[1] * K, p[2] * K], (d) => d)
  kCache.clear()
  return b.model()
}

/** No beams or airflow on the heroes since 2026-10-17; kept so the car fits the shared FX table. */
export const MODEL_Y_FX: { beams: Beam[]; flow: Flow[] } = { beams: [], flow: [] }
