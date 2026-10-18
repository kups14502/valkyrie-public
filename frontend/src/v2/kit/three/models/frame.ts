// frame (labeled Loki) in x-ray: Valve's Steam Frame. A slim core module
// behind a glossy black wraparound visor (ski-goggle outline, wrapping back at
// the sides, a nose cutout below), a soft fabric face cushion, two pancake
// lens barrels, rigid arms that carry the speakers, soft adjustable side
// straps to a cushioned rear battery pad with a VALVE plate, and a loose cable
// from the visor to that pad. The visor faces +z and floats at head height
// over the floor. Labels stay generic: no claims about exact parts.
//
// The ergo kit's top strap is an optional part, OFF by default (Brendon has
// the kit but is not sold on the look): frameHeadset({ topStrap: true }).
// The kit's controller straps are not modeled.
//
// Groups: cpu (SoC, heat pipe, fins), mem (memory), disk (storage), battery
// (the two cells in the rear pad, charge board, cable), fans (blower),
// display (the two panels), cams (tracking cameras, eye tracking), board.

import { add, bezier, cross, norm, scale, sub, type Model, type Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

const YC = 2.55
/** visor outline: half width and height, superellipse powers (squarer top, rounder bottom corners) */
const HW = 2.12, HH = 0.98, PT = 3.4, PB = 2.5
const NOSE_W = 0.56, NOSE_D = 0.5
/** glass front at the center, how far it wraps back at the sides, body back edge at the center */
const ZF = 3.2, WRAP = 1.08, ZB = 2.12
/** samples around every visor loop (index 0 = top center, i and N - i are mirror images) */
const N = 72

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

const narrow = (x: number) => 1 - 0.2 * Math.abs(x / HW) ** 4
const nose = (x: number, d = NOSE_D) => (Math.abs(x) >= NOSE_W ? 0 : d * Math.cos((Math.PI * x) / (2 * NOSE_W)) ** 2)
const ax = (x: number) => Math.min(1, Math.abs(x / HW))
/** top and bottom edge of the visor outline at x */
const topY = (x: number) => HH * (1 - ax(x) ** PT) ** (1 / PT) * narrow(x)
const botY = (x: number) => -HH * (1 - ax(x) ** PB) ** (1 / PB) * narrow(x) + nose(x)
/** the glass surface: bulges forward in the middle, wraps back hard at the sides */
const zFront = (x: number, y: number) => ZF - WRAP * Math.abs(x / HW) ** 2.3 - 0.16 * (y / HH) ** 2 - 0.05 * y
/** the back edge of the core, curved to the face */
const zBack = (x: number) => ZB - 0.5 * (x / HW) ** 2
const onGlass = (x: number, y: number, lift = 0.004): Vec3 => [x, YC + y, zFront(x, y) + lift]

/** Resample a dense open polyline to n + 1 points evenly spaced by arc length. */
function resample(dense: [number, number][], n: number): [number, number][] {
  const L = [0]
  for (let i = 1; i < dense.length; i++) L.push(L[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]))
  const tot = L[L.length - 1]
  const out: [number, number][] = []
  let j = 0
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * tot
    while (j < L.length - 2 && L[j + 1] < s) j++
    const t = (s - L[j]) / (L[j + 1] - L[j] || 1)
    out.push([dense[j][0] + (dense[j + 1][0] - dense[j][0]) * t, dense[j][1] + (dense[j + 1][1] - dense[j][1]) * t])
  }
  return out
}

/** The visor outline: N points from the top center, right side first, mirrored for the left. */
function visorOutline(): [number, number][] {
  const dense: [number, number][] = []
  const M = 720
  for (let i = 0; i <= M; i++) {
    const th = Math.PI / 2 - (i / M) * Math.PI
    const c = Math.max(0, Math.cos(th)), s = Math.sin(th)
    const p = s >= 0 ? PT : PB
    const x = HW * c ** (2 / p)
    const y = HH * Math.sign(s) * Math.abs(s) ** (2 / p) * narrow(x) + (s < 0 ? nose(x) : 0)
    dense.push([x, y])
  }
  const right = resample(dense, N / 2)
  const out = right.slice()
  for (let k = N / 2 - 1; k >= 1; k--) out.push([-right[k][0], right[k][1]])
  return out
}

/** A closed superellipse (half sizes a, b, power p), n points evenly spaced by arc length, from the top center. */
function superLoop(a: number, b: number, p: number, n: number): [number, number][] {
  const dense: [number, number][] = []
  const M = 480
  for (let i = 0; i <= M; i++) {
    const th = Math.PI / 2 - (i / M) * Math.PI
    const c = Math.max(0, Math.cos(th)), s = Math.sin(th)
    dense.push([a * c ** (2 / p), b * Math.sign(s) * Math.abs(s) ** (2 / p)])
  }
  const right = resample(dense, n / 2)
  const out = right.slice()
  for (let k = n / 2 - 1; k >= 1; k--) out.push([-right[k][0], right[k][1]])
  return out
}

/** A 2D rounded rectangle (closed), for mapping onto curved parts. */
function rr2(cx: number, cy: number, w: number, h: number, r: number, n = 4): [number, number][] {
  const a = w / 2, b = h / 2, k = Math.min(r, a, b)
  const out: [number, number][] = []
  const cs: [number, number, number][] = [[a - k, b - k, 0], [-a + k, b - k, 0.5], [-a + k, -b + k, 1], [a - k, -b + k, 1.5]]
  for (const [x0, y0, a0] of cs) for (let i = 0; i <= n; i++) {
    const t = (a0 + (i / n) * 0.5) * Math.PI
    out.push([cx + x0 + Math.cos(t) * k, cy + y0 + Math.sin(t) * k])
  }
  return out
}

// ---------- the rear battery pad: a pillow on a vertical cylinder around the back of the head ----------

/** center of the pad's curvature (inside the head), its radius at the head-side face, pad height */
const PAD_CZ = -1.05, PAD_R = 2.1, PAD_Y = YC - 0.82
/** pad outline half sizes along the arc and up, and its superellipse power */
const PAD_W = 1.3, PAD_H = 0.88, PAD_P = 2.7
/** radial depth of the pad from the head-side face to the outer fabric */
const PAD_T = 0.72
/** A point on the pad: s along the arc (at the head-side face), t up, r from the curvature axis. */
const padPt = (s: number, t: number, r: number): Vec3 => {
  const phi = s / PAD_R
  return [r * Math.sin(phi), PAD_Y + t, PAD_CZ - r * Math.cos(phi)]
}

export type FrameOptions = {
  /** the ergo kit's top strap over the crown, off by default */
  topStrap?: boolean
}

export function frameHeadset(opts: FrameOptions = {}): Model {
  const b = new Builder()
  const O = visorOutline()
  const ring = (k: number, z: (x: number, y: number) => number): Vec3[] => O.map(([x, y]) => [x * k, YC + y * k, z(x * k, y * k)])

  // ---------- core module: glass edge, rim lip, body, back edge ----------
  const G = ring(0.985, zFront)
  const R = ring(1, (x, y) => zFront(x, y) - 0.05)
  const M = ring(1.035, (x, y) => (zFront(x, y) - 0.05) * 0.55 + zBack(x) * 0.45)
  const K = ring(1, (x) => zBack(x))
  b.poly(G, true, FG)
  b.poly(R, true, SH)
  b.poly(M, true, { layer: 'mesh', w: 0.8 })
  b.poly(K, true, { layer: 'fg', w: 0.8 })
  // long edges: strong at the top and bottom centers, the ends and the four corners
  let iEnd = 0
  for (let i = 0; i <= N / 2; i++) if (O[i][0] > O[iEnd][0]) iEnd = i
  const key = new Set<number>([0, N / 2, iEnd, N - iEnd, Math.round(iEnd / 2), N - Math.round(iEnd / 2), Math.round((iEnd + N / 2) / 2), N - Math.round((iEnd + N / 2) / 2)])
  for (let i = 0; i < N; i++) {
    if (i % 2 === 0) b.line(G[i], R[i], SHd)
    const strong = key.has(i)
    if (strong || i % 3 === 0) {
      b.line(R[i], M[i], strong ? SH : MESHd)
      b.line(M[i], K[i], strong ? SH : MESHd)
    }
  }

  // the glossy visor: fine mesh on the curved glass, and glass faces in strips so the sheen rolls around the wrap
  const GK = 0.965
  const inside = (x: number, y: number) => Math.abs(x) < HW * GK && y < topY(x / GK) * GK && y > botY(x / GK) * GK
  const step = 0.13
  for (let x = -HW * GK + step; x < HW * GK - 1e-6; x += step) {
    const y0 = botY(x / GK) * GK, y1 = topY(x / GK) * GK
    if (y1 - y0 < 0.06) continue
    const pts: Vec3[] = []
    for (let k = 0; k <= 6; k++) pts.push(onGlass(x, y0 + ((y1 - y0) * k) / 6))
    b.poly(pts, false, { layer: 'mesh', w: 0.72 })
  }
  for (let y = -HH + step; y < HH - 1e-6; y += step) {
    let run: Vec3[] = []
    const flush = () => { if (run.length > 1) b.poly(run, false, { layer: 'mesh', w: 0.72 }); run = [] }
    for (let k = 0; k <= 80; k++) {
      const x = -HW + (2 * HW * k) / 80
      if (inside(x, y)) run.push(onGlass(x, y))
      else flush()
    }
    flush()
  }
  const strips = 10
  for (let s = 0; s < strips; s++) {
    const x0 = -HW * GK + (2 * HW * GK * s) / strips, x1 = x0 + (2 * HW * GK) / strips
    b.face([onGlass(x0, botY(x0 / GK) * GK, 0), onGlass(x1, botY(x1 / GK) * GK, 0), onGlass(x1, topY(x1 / GK) * GK, 0), onGlass(x0, topY(x0 / GK) * GK, 0)], 'fg', 1.15)
  }

  // body top: point at fraction f from the glass edge (0) to the back edge (1)
  const topPt = (x: number, f: number, lift = 0.004): Vec3 => {
    const yt = topY(x)
    const z0 = zFront(x, yt) - 0.05
    return [x, YC + yt * (1 + 0.035 * Math.sin(Math.PI * f)) + lift, z0 + (zBack(x) - z0) * f]
  }
  // the long vent slot along the top rear edge, over the blower
  {
    const pts: Vec3[] = []
    for (let k = 0; k <= 12; k++) pts.push(topPt(-1.2 + (2.4 * k) / 12, 0.62))
    for (let k = 12; k >= 0; k--) pts.push(topPt(-1.2 + (2.4 * k) / 12, 0.8))
    b.poly(pts, true, SHd)
    for (let x = -1.15; x <= 1.15; x += 0.05) b.line(topPt(x, 0.64, 0.005), topPt(x, 0.78, 0.005), MESHd)
  }
  // a small sensor window at the top center of the rim
  b.poly([topPt(-0.16, 0.08), topPt(0.16, 0.08), topPt(0.16, 0.2), topPt(-0.16, 0.2)], true, SH)

  // ---------- tracking cameras: a pair low on the front corners, a pair on the sides ----------
  const camL: Vec3[] = []
  for (const s of [-1, 1]) {
    const fx = s * 1.6, fy = -0.5
    const at = onGlass(fx, fy, 0.012)
    camL.push(at)
    b.lens(at, [s * 0.5, -0.32, 0.8], 0.1, FG, SHd, hot('cams', 0.9), 0.14)
    b.circle(at, norm([0.8, 0, -s * 0.5]), norm(cross([s * 0.5, -0.32, 0.8], norm([0.8, 0, -s * 0.5]))), 0.15, 20, SHd)
    const sy = 0.14
    const sz = (zFront(HW, sy) + zBack(HW)) / 2 + 0.03
    b.lens([s * (HW + 0.06), YC + sy, sz], [s * 0.92, 0.1, 0.38], 0.09, FG, SHd, hot('cams', 0.9), 0.12)
  }
  // power button on the right side
  {
    const x = HW + 0.05, z = (zFront(HW, -0.35) + zBack(HW)) / 2
    b.roundRect([x, YC - 0.35, z], Z, Y, 0.28, 0.09, 0.04, FG, 3)
  }

  // ---------- SoC board behind the visor ----------
  const BZ = 2.66
  const B = (x: number, y: number, lift = 0): Vec3 => [x, YC + y, BZ + lift]
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.38)
  b.poly([B(-1.3, 0.46), B(-1.14, 0.62), B(1.14, 0.62), B(1.3, 0.46), B(1.3, -0.3), B(1.12, -0.46), B(0.44, -0.46), B(0.3, -0.3), B(-0.3, -0.3), B(-0.44, -0.46), B(-1.12, -0.46), B(-1.3, -0.3)], true, BRD)
  for (const [x, y] of [[-1.16, 0.46], [1.16, 0.46], [-1.16, -0.3], [1.16, -0.3]]) b.circle(B(x, y, 0.002), X, Y, 0.04, 8, BRD)
  const T = (x: number, y: number) => B(x, y, 0.002)
  b.traces(T, [[0.34, 0.3], [0.43, 0.3], [0.47, 0.26], [0.54, 0.26]], 6, 0.022, BRDd)
  b.traces(T, [[0.34, -0.06], [0.43, -0.06], [0.47, -0.1], [0.54, -0.1]], 6, 0.022, BRDd)
  b.traces(T, [[-0.34, 0.1], [-0.43, 0.1], [-0.47, 0.06], [-0.54, 0.06]], 6, 0.022, BRDd)
  b.traces(T, [[0.12, -0.18], [0.12, -0.3], [0.22, -0.38], [1.0, -0.38]], 5, 0.026, BRDd)
  b.traces(T, [[-0.6, -0.12], [-0.6, -0.3], [-0.72, -0.38], [-1.0, -0.38]], 5, 0.026, BRDd)
  // SoC: package, die, shield
  b.box(B(-0.32, -0.18), B(0.32, 0.46, 0.07), hot('cpu', 0.9))
  b.rect(B(0, 0.14, 0.072), X, Y, 0.4, 0.4, hot('cpu', 1), 0.04)
  b.rect(B(0, 0.14, 0.074), X, Y, 0.22, 0.22, hot('cpu', 0.75), 0.02)
  b.line(B(-0.11, 0.03, 0.075), B(0.11, 0.25, 0.075), hot('cpu', 0.5))
  b.line(B(-0.11, 0.25, 0.075), B(0.11, 0.03, 0.075), hot('cpu', 0.5))
  b.rect(B(0, 0.14, 0.09), X, Y, 0.8, 0.74, hot('cpu', 0.5), 0.08)
  // heat pipe up to the blower's fin stack under the top vent
  b.tube(B(0.16, 0.46, 0.05), B(0.2, 0.7, 0.05), [0.36, YC + 0.8, 2.66], [0.42, YC + 0.79, 2.5], 0.03, X, 10, hot('cpu', 0.6))
  b.box([0.3, YC + 0.73, 2.24], [0.82, YC + 0.86, 2.7], hot('cpu', 0.55))
  for (let z = 2.27; z < 2.68; z += 0.045) b.line([0.3, YC + 0.86, z], [0.82, YC + 0.86, z], hot('cpu.rad', 0.3))
  // memory: two packages
  for (const y0 of [0.12, -0.26]) {
    b.box(B(0.54, y0), B(0.92, y0 + 0.3, 0.05), hot('mem', 0.9))
    b.rect(B(0.73, y0 + 0.15, 0.052), X, Y, 0.26, 0.18, hot('mem', 0.45), 0.02)
    b.circle(B(0.59, y0 + 0.25, 0.053), X, Y, 0.018, 6, hot('mem', 1))
  }
  // storage
  b.box(B(-0.98, -0.38), B(-0.54, 0.06, 0.05), hot('disk', 0.9))
  b.rect(B(-0.76, -0.16, 0.052), X, Y, 0.32, 0.32, hot('disk', 0.45), 0.03)
  for (let k = 0; k < 3; k++) b.line(B(-0.86, -0.06 - k * 0.07, 0.054), B(-0.66 + (k === 2 ? -0.08 : 0), -0.06 - k * 0.07, 0.054), hot('disk', 0.5))
  // power, radio, passives
  b.box(B(1.0, 0.22), B(1.24, 0.5, 0.04), hot('board', 0.55))
  b.box(B(-1.24, 0.22), B(-1.02, 0.48, 0.04), hot('board', 0.55))
  for (const [x, y] of [[-0.8, 0.2], [-0.68, 0.2], [-0.8, 0.32], [1.08, 0.04], [1.2, 0.04], [1.14, -0.1], [-0.05, 0.54], [0.08, 0.54], [-0.2, 0.54]]) b.rect(B(x, y, 0.01), X, Y, 0.06, 0.035, BRDd)
  // display connectors and flex cables back to the panels
  for (const s of [-1, 1]) {
    b.box(B(s * 1.0 - 0.12, -0.44), B(s * 1.0 + 0.12, -0.36, 0.04), hot('board', 0.55))
    b.curve(B(s * 1.0, -0.44, 0.02), [s * 1.0, YC - 0.62, 2.6], [s * 0.9, YC - 0.66, 2.52], [s * 0.8, YC - 0.6, 2.47], 6, hot('display', 0.4))
  }
  // antennas into the top corners
  for (const s of [-1, 1]) b.curve(B(s * 1.12, 0.5, 0.03), [s * 1.2, YC + 0.72, 2.6], [s * 1.5, YC + 0.8, 2.45], [s * 1.75, YC + 0.68, 2.2], 8, SHd)

  // blower under the vent
  b.fan([-0.2, YC + 0.79, 2.46], X, Z, 0.6, { frame: SHd, ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 11, depth: 0.12, speed: 1.2 })

  // ---------- the two display panels ----------
  for (const s of [-1, 1]) {
    const c: Vec3 = [s * 0.78, YC - 0.06, 2.48]
    b.rect(c, X, Y, 1.12, 1.12, hot('display', 0.75), 0.06)
    b.rect([c[0], c[1], 2.42], X, Y, 1.12, 1.12, hot('display', 0.35), 0.06)
    b.rect([c[0], c[1], 2.485], X, Y, 0.98, 0.98, hot('display', 0.45), 0.03)
    for (const [dx, dy] of [[-0.53, -0.53], [0.53, -0.53], [0.53, 0.53], [-0.53, 0.53]]) b.line([c[0] + dx, c[1] + dy, 2.48], [c[0] + dx, c[1] + dy, 2.42], hot('display', 0.35))
  }

  // ---------- pancake lens barrels, standing out of the back of the core ----------
  const LR = 0.58
  for (const s of [-1, 1]) {
    const cx = s * 0.78, cy = YC - 0.06
    b.circle([cx, cy, 2.36], X, Y, LR, 40, SHd)
    b.circle([cx, cy, 2.04], X, Y, LR + 0.01, 40, MESHd)
    b.circle([cx, cy, 1.78], X, Y, LR + 0.03, 40, SH)
    b.circle([cx, cy, 1.79], X, Y, LR - 0.07, 36, SH)
    for (const r of [0.38, 0.25, 0.12]) b.circle([cx, cy, 1.84], X, Y, r, 28, MESH)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      b.line([cx + Math.cos(a) * LR, cy + Math.sin(a) * LR, 2.36], [cx + Math.cos(a) * (LR + 0.03), cy + Math.sin(a) * (LR + 0.03), 1.78], k % 4 === 0 ? SH : SHd)
    }
    // eye tracking LEDs around the rim
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8
      b.circle([cx + Math.cos(a) * (LR - 0.035), cy + Math.sin(a) * (LR - 0.035), 1.775], X, Y, 0.018, 6, hot('cams', 0.7))
    }
  }

  // ---------- fabric face cushion ----------
  const deep = (x: number, y: number) => (y < 0 ? nose(x, 0.14) : 0)
  const cush = (k: number, dz: (x: number) => number, nd = 0): Vec3[] => O.map(([x, y]) => [x * k, YC + y * k + nd * deep(x, y), zBack(x) - dz(x * k)])
  const F0 = cush(0.97, () => 0.02)
  const F1 = cush(1.0, (x) => 0.2 + 0.1 * (x / HW) ** 2, 0.5)
  const F2 = cush(0.95, (x) => 0.4 + 0.36 * (x / HW) ** 2, 1)
  const F3 = cush(0.8, (x) => 0.3 + 0.3 * (x / HW) ** 2, 1)
  b.poly(F0, true, SHd)
  b.poly(F1, true, MESH)
  b.poly(F2, true, FGd)
  b.poly(F3, true, SHd)
  for (let i = 0; i < N; i += 2) {
    b.line(F0[i], F1[i], MESHd)
    b.line(F1[i], F2[i], MESHd)
    if (i % 4 === 0) b.line(F2[i], F3[i], MESHd)
  }

  // ---------- rigid arms (speakers inside) and soft side straps ----------
  const padSide = (s: number): Vec3 => padPt(s * (PAD_W + 0.04), 0.04, PAD_R + 0.42)
  const STEPS = 30
  for (const s of [-1, 1]) {
    const p0: Vec3 = [s * (HW + 0.1), YC - 0.02, 1.8]
    const p1: Vec3 = [s * 2.48, YC - 0.06, 0.35]
    const p2: Vec3 = [s * 2.3, YC - 0.5, -1.95]
    const p3 = padSide(s)
    const cl: Vec3[] = []
    for (let i = 0; i <= STEPS; i++) cl.push(bezier(p0, p1, p2, p3, i / STEPS))
    const outN = cl.map((_, i) => {
      const t = norm([cl[Math.min(STEPS, i + 1)][0] - cl[Math.max(0, i - 1)][0], 0, cl[Math.min(STEPS, i + 1)][2] - cl[Math.max(0, i - 1)][2]])
      return scale(norm(cross(t, Y)), s)
    })
    const off = (i: number, o: number, dy: number): Vec3 => add(cl[i], [outN[i][0] * o, dy, outN[i][2] * o])

    // the arm: a rounded slab from the hinge back past the ear
    const IA = 9, TA = 0.12, HA = 0.34
    for (const o of [0, TA]) {
      const pts: Vec3[] = []
      for (let i = 0; i <= IA; i++) pts.push(off(i, o, HA - (i === IA ? 0.05 : 0)))
      for (let i = IA; i >= 0; i--) pts.push(off(i, o, -HA + (i === IA ? 0.05 : 0)))
      b.poly(pts, true, o > 0 ? FG : SH)
    }
    for (const i of [0, IA]) for (const dy of [HA - 0.05, -HA + 0.05]) b.line(off(i, 0, dy), off(i, TA, dy), SH)
    // speaker grille on the outer face by the ear
    for (let i = 4; i <= IA - 1; i++) b.line(off(i, TA + 0.004, 0.18), off(i, TA + 0.004, -0.18), MESH)
    b.poly([off(4, TA + 0.004, 0.2), off(IA - 1, TA + 0.004, 0.2), off(IA - 1, TA + 0.004, -0.2), off(4, TA + 0.004, -0.2)], true, SHd)
    // hinge into the core
    b.circle(add(p0, [s * 0.02, 0, 0]), Z, Y, 0.2, 20, FG)
    b.circle(add(p0, [s * 0.025, 0, 0]), Z, Y, 0.09, 12, SH)

    // the soft strap
    const HB = 0.3, TH = 0.06
    const strap = cl.map((_, i) => i).filter((i) => i >= IA - 1)
    b.poly(strap.map((i) => off(i, TH, HB)), false, SH)
    b.poly(strap.map((i) => off(i, TH, -HB)), false, SH)
    b.poly(strap.map((i) => off(i, 0, HB)), false, SHd)
    b.poly(strap.map((i) => off(i, 0, -HB)), false, SHd)
    for (const i of strap) if (i % 2 === 0) b.line(off(i, TH, HB), off(i, TH, -HB), MESH)
    // the adjuster buckle, and the strap doubling back through it
    const ib = Math.round(STEPS * 0.74)
    for (const [i, st] of [[ib, FG], [ib + 1, SHd]] as const) {
      b.rect(off(i, TH / 2, 0), outN[i], Y, TH + 0.12, 2 * HB + 0.14, st, 0.03)
    }
    b.poly(strap.filter((i) => i >= ib - 5 && i <= ib).map((i) => off(i, TH + 0.05, HB - 0.03)), false, MESHd)
    b.poly(strap.filter((i) => i >= ib - 5 && i <= ib).map((i) => off(i, TH + 0.05, -HB + 0.03)), false, MESHd)
  }

  // ---------- rear battery pad ----------
  const PO = superLoop(PAD_W, PAD_H, PAD_P, 48)
  const padRing = (k: number, r: number): Vec3[] => PO.map(([s, t]) => padPt(s * k, t * k, r))
  const stations: [number, number, Style][] = [
    [0.9, PAD_R, SH],
    [1.0, PAD_R + 0.2, { layer: 'shell', w: 0.8 }],
    [1.0, PAD_R + 0.5, FG],
    [0.88, PAD_R + PAD_T, FG],
  ]
  const rings = stations.map(([k, r, st]) => { const pts = padRing(k, r); b.poly(pts, true, st); return pts })
  for (let i = 0; i < PO.length; i++) {
    const strong = i % 6 === 0
    if (!strong && i % 2 !== 0) continue
    for (let q = 0; q < rings.length - 1; q++) b.line(rings[q][i], rings[q + 1][i], strong ? SH : MESHd)
  }
  // fabric weave on the outer face
  {
    const k = 0.86, rr = PAD_R + PAD_T + 0.004
    const inPad = (s: number, t: number) => Math.abs(s / (PAD_W * k)) ** PAD_P + Math.abs(t / (PAD_H * k)) ** PAD_P < 1
    const plate = (s: number, t: number) => Math.abs(s) < 0.5 && Math.abs(t - 0.02) < 0.25
    for (const dir of [1, -1]) for (let c = -2.4; c <= 2.4; c += 0.13) {
      let run: Vec3[] = []
      const flush = () => { if (run.length > 1) b.poly(run, false, { layer: 'mesh', w: 0.42 }); run = [] }
      for (let j = 0; j <= 40; j++) {
        const s = -PAD_W + (2 * PAD_W * j) / 40
        const t = dir * s * 0.7 + c
        if (inPad(s, t) && !plate(s, t)) run.push(padPt(s, t, rr))
        else flush()
      }
      flush()
    }
  }
  // the VALVE plate
  b.poly(rr2(0, 0.02, 0.96, 0.46, 0.08).map(([s, t]) => padPt(s, t, PAD_R + PAD_T + 0.012)), true, FG)
  b.poly(rr2(0, 0.02, 0.5, 0.06, 0.02).map(([s, t]) => padPt(s, t, PAD_R + PAD_T + 0.014)), true, SHd)
  // the two cells inside, and the charge board above them
  for (const s0 of [-0.53, 0.53]) {
    const cell = rr2(s0, -0.04, 0.9, 1.04, 0.07)
    b.poly(cell.map(([s, t]) => padPt(s, t, PAD_R + 0.56)), true, hot('battery', 0.85))
    b.poly(cell.map(([s, t]) => padPt(s, t, PAD_R + 0.3)), true, hot('battery', 0.45))
    for (const [s, t] of [[s0 - 0.45, 0.48], [s0 + 0.45, 0.48], [s0 + 0.45, -0.56], [s0 - 0.45, -0.56]]) b.line(padPt(s, t, PAD_R + 0.3), padPt(s, t, PAD_R + 0.56), hot('battery', 0.45))
    b.poly(rr2(s0, -0.04, 0.7, 0.84, 0.05).map(([s, t]) => padPt(s, t, PAD_R + 0.565)), true, hot('battery', 0.4))
    b.line(padPt(s0 - 0.3, -0.04, PAD_R + 0.566), padPt(s0 + 0.3, -0.04, PAD_R + 0.566), hot('battery', 0.3))
  }
  b.poly(rr2(0, 0.62, 1.9, 0.12, 0.03).map(([s, t]) => padPt(s, t, PAD_R + 0.44)), true, hot('battery', 0.5))
  // charge light
  b.poly(rr2(0.62, 0.62, 0.16, 0.03, 0.01).map(([s, t]) => padPt(s, t, PAD_R + PAD_T - 0.01)), true, ACC)

  // ---------- the cable from the visor to the pad, looping free on the wearer's right ----------
  {
    const q0: Vec3 = [-(HW + 0.06), YC - 0.3, 1.64]
    const q3 = padPt(-PAD_W - 0.02, 0.32, PAD_R + 0.44)
    b.tube(q0, [-2.8, YC + 0.3, 0.1], [-2.5, YC + 0.12, -2.4], q3, 0.02, Y, 22, SHd)
    b.box(add(q0, [-0.1, -0.05, -0.08]), add(q0, [0.0, 0.05, 0.06]), SH)
  }

  // ---------- ergo kit top strap (optional) ----------
  if (opts.topStrap) {
    const t0 = topPt(0, 0.82)
    const t3 = padPt(0, PAD_H * 0.92, PAD_R + 0.36)
    const STEPS2 = 26
    const cl: Vec3[] = []
    for (let i = 0; i <= STEPS2; i++) cl.push(bezier(t0, [0, YC + 2.35, 1.45], [0, YC + 2.65, -2.1], t3, i / STEPS2))
    const up = cl.map((_, i) => {
      const t = norm([0, cl[Math.min(STEPS2, i + 1)][1] - cl[Math.max(0, i - 1)][1], cl[Math.min(STEPS2, i + 1)][2] - cl[Math.max(0, i - 1)][2]])
      return norm(cross(X, t))
    })
    const off = (i: number, o: number, dx: number): Vec3 => add(cl[i], [dx, up[i][1] * o, up[i][2] * o])
    const HS = 0.27, TS = 0.05
    for (const [o, dx, st] of [[TS, HS, SH], [TS, -HS, SH], [0, HS, SHd], [0, -HS, SHd]] as const) b.poly(cl.map((_, i) => off(i, o, dx)), false, st)
    for (let i = 0; i <= STEPS2; i += 2) b.line(off(i, TS, HS), off(i, TS, -HS), MESH)
    const ib = Math.round(STEPS2 * 0.42)
    b.rect(off(ib, TS / 2, 0), X, norm(cross(norm(sub(cl[ib + 1], cl[ib - 1])), X)), 2 * HS + 0.12, TS + 0.12, FG, 0.03)
  }

  // ---------- hotspots ----------
  b.hotspot('cpu', B(0, 0.14, 0.1), 'Processor')
  b.hotspot('mem', B(0.73, 0.4, 0.06), 'Memory')
  b.hotspot('disk', B(-0.76, -0.2, 0.06), 'Storage')
  b.hotspot('battery', padPt(0, PAD_H * 0.55, PAD_R + PAD_T), 'Battery')
  b.hotspot('lens', [0.78, YC - 0.06 - LR, 1.8], 'Lenses')

  return b.model()
}


const CAM_L: Vec3 = [-1.6, YC - 0.5, zFront(1.6, -0.5)]
const CAM_R: Vec3 = [1.6, YC - 0.5, zFront(1.6, -0.5)]

/** The lower tracking cameras' view cones on the floor, and air through the blower and over the visor (unused since beams and airflow went off). */
export const FRAME_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [
    { from: CAM_L, dir: [-0.42, -0.72, 0.55], spread: 17, length: 6.5, intensity: 0.5 },
    { from: CAM_R, dir: [0.42, -0.72, 0.55], spread: 17, length: 6.5, intensity: 0.5 },
  ],
  flow: [
    { from: [-0.2, YC - 2.0, 4.2], to: [0.1, YC + 1.7, -2.6], via: [-0.2, YC + 0.4, 2.46], speed: 1.8, spread: 0.4, lanes: 7 },
    { from: [0, YC + 0.1, 6.8], to: [0, YC + 0.2, -5.8], via: [0, YC + 1.55, 0.6], speed: 2.4, spread: 1.1, lanes: 10 },
  ],
}
