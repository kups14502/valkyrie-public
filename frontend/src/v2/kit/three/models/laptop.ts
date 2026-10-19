// mimir in x-ray: an ASUS ROG Zephyrus G14 (2024, GA403UV), the model its
// device inventory records. 311 x 220 x 16 mm of CNC aluminum, the base on the
// floor with its front edge toward +z, the lid at the rear hinge leaning back
// 20 degrees with the 16:10 OLED facing the viewer.
//
// What makes it a G14 rather than any laptop: the Slash Lighting band across
// the back of the lid (a chromed diagonal strip, 7 zones of 4 LEDs), the four
// extra keys over the function row and the hexagonal power key, up-firing
// speaker grilles flanking the keyboard, the very large touchpad, the square
// DC jack at the back of the left edge (then HDMI, USB4, USB-A, audio; right:
// USB-A, USB-C, microSD), rear exhaust, and inside, the Ryzen 9 next to the
// RTX 4060 with its four GDDR6 chips, soldered LPDDR5X, one M.2 SSD, two
// blower fans fed by heat pipes, and the 4-cell 73 Wh battery under the palm rest.
//
// Groups: cpu (die and package), gpu (die and VRAM), mem (memory), disk (SSD),
// battery (cells, charge board), fans (blowers, heat pipes, fin stacks),
// display (backlight, the Slash LEDs), board.

import type { Model, Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

const HX = 2.7
const Z0 = -1.6, Z1 = 2.2
const ZC = (Z0 + Z1) / 2
const B0 = 0.12, B1 = 0.42
const LID_ANGLE = (20 * Math.PI) / 180
const L: Vec3 = [0, Math.cos(LID_ANGLE), -Math.sin(LID_ANGLE)]
const N: Vec3 = [0, Math.sin(LID_ANGLE), Math.cos(LID_ANGLE)]
const HINGE: Vec3 = [0, B1 + 0.02, Z0 + 0.06]
const LID_H = 3.72, LID_T = 0.1

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** A point on the lid: x across, t up the lid from the hinge, n out of the screen. */
const lid = (x: number, t: number, n = 0): Vec3 => [x, HINGE[1] + L[1] * t + N[1] * n, HINGE[2] + L[2] * t + N[2] * n]

// ANSI layout without a number pad; the function row is the short one. The
// last key of the function row is the power key (drawn as a hexagon).
const KEY_ROWS: { h: number; keys: number[] }[] = [
  { h: 0.55, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5] },
  { h: 1, keys: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2] },
  { h: 1, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5] },
  { h: 1, keys: [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25] },
  { h: 1, keys: [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75] },
  { h: 1, keys: [1, 1, 1, 1.25, 5.5, 1.25, 1, 3] },
]

export function laptop(): Model {
  const b = new Builder()

  // ---------- base shell ----------
  const bc = (y: number): Vec3 => [0, y, ZC]
  const W = 2 * HX, D = Z1 - Z0
  b.roundRect(bc(B0), X, Z, W - 0.1, D - 0.1, 0.2, SH)
  b.roundRect(bc(B1 - 0.05), X, Z, W, D, 0.24, FGd)
  b.roundRect(bc(B1), X, Z, W - 0.08, D - 0.08, 0.2, FG)
  {
    const lo = b.roundRectPts(bc(B0), X, Z, W - 0.1, D - 0.1, 0.2, 6)
    const mid = b.roundRectPts(bc(B1 - 0.05), X, Z, W, D, 0.24, 6)
    for (let q = 0; q < 4; q++) for (const i of [0, 3, 6]) b.line(lo[q * 7 + i], mid[q * 7 + i], SH)
  }
  b.face(b.roundRectPts(bc(B1), X, Z, W - 0.08, D - 0.08, 0.2, 3), 'fg', 0.5)
  b.face([[-HX + 0.1, B0 + 0.03, Z1], [HX - 0.1, B0 + 0.03, Z1], [HX - 0.1, B1 - 0.06, Z1], [-HX + 0.1, B1 - 0.06, Z1]], 'fg', 0.5)
  // status lights on the front lip
  for (const x of [-0.12, 0, 0.12]) b.rect([x, 0.22, Z1 + 0.006], X, Y, 0.06, 0.025, MESH)
  // long rubber feet front and rear, and the bottom intake under both fans
  for (const z of [Z0 + 0.3, Z1 - 0.28]) b.roundRect([0, B0 - 0.002, z], X, Z, 4.5, 0.1, 0.05, SHd, 3)
  for (let x = -2.3; x <= 2.3; x += 0.12) if (Math.abs(x) > 0.5) b.lineN([x, B0 - 0.002, -1.32], [x, B0 - 0.002, -0.3], 2, { layer: 'mesh', w: 0.4 })

  // keyboard well and keys
  const kw = 4.72, kd = 1.86, kz = -0.3
  const ky = B1 + 0.014
  b.rect([0, B1 + 0.003, kz], X, Z, kw, kd, SHd, 0.06)
  {
    const unit = 4.56 / 15, gap = 0.036, KEY: Style = { layer: 'shell', w: 1 }
    let z = kz - kd / 2 + 0.09
    KEY_ROWS.forEach((row, ri) => {
      const rh = row.h * unit
      let x = -4.56 / 2
      row.keys.forEach((k, ki) => {
        const kwid = k * unit
        if (ri === 0 && ki === row.keys.length - 1) {
          // the power key: an uneven hexagon, wider than tall
          const cx = x + kwid / 2, cz = z + rh / 2, hw = kwid / 2 - 0.03, hh = rh / 2 - 0.02
          b.poly([[cx - hw, ky, cz], [cx - hw * 0.55, ky, cz - hh], [cx + hw * 0.55, ky, cz - hh], [cx + hw, ky, cz], [cx + hw * 0.55, ky, cz + hh], [cx - hw * 0.55, ky, cz + hh]], true, FG)
        } else if (k === 3) {
          // arrow cluster: left, up over down, right
          const u = unit
          b.rect([x + u / 2, ky, z + rh / 2], X, Z, u - gap, rh - gap, KEY, 0.02)
          b.rect([x + 1.5 * u, ky, z + rh * 0.25], X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect([x + 1.5 * u, ky, z + rh * 0.75], X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect([x + 2.5 * u, ky, z + rh / 2], X, Z, u - gap, rh - gap, KEY, 0.02)
        } else {
          b.rect([x + kwid / 2, ky, z + rh / 2], X, Z, kwid - gap, rh - gap, KEY, 0.025)
        }
        x += kwid
      })
      z += rh
    })
    // the four extra keys over the function row, left side (volume down and up, mic, Armoury Crate)
    for (let i = 0; i < 4; i++) b.rect([-2.12 + i * 0.3, ky, kz - kd / 2 - 0.05], X, Z, 0.26, 0.075, KEY, 0.015)
  }
  // the very large glass touchpad, almost to the front edge
  b.roundRect([0, B1 + 0.004, 1.41], X, Z, 2.6, 1.42, 0.08, FGd, 3)
  b.face(b.roundRectPts([0, B1 + 0.004, 1.41], X, Z, 2.6, 1.42, 0.08, 2), 'fg', 0.6)
  // up-firing speaker grilles flanking the keyboard
  for (const sx of [-1, 1]) {
    for (let z = kz - kd / 2 + 0.04; z <= kz + kd / 2 - 0.04; z += 0.075) b.line([sx * 2.44, B1 + 0.003, z], [sx * 2.6, B1 + 0.003, z], MESHd)
  }

  // ---------- ports (y center 0.27, faces in the side walls) ----------
  const py = 0.27
  const side = (sx: number, z: number, dy = 0): Vec3 => [sx * (HX + 0.004), py + dy, z]
  // left, back to front: square DC jack, HDMI, USB4 (USB-C), USB-A, audio
  b.roundRect(side(-1, -1.25), Z, Y, 0.13, 0.12, 0.025, FG, 3)
  b.circle(side(-1, -1.25), Z, Y, 0.03, 8, SHd)
  b.poly([side(-1, -1.07, 0.045), side(-1, -0.81, 0.045), side(-1, -0.81, 0), side(-1, -0.84, -0.045), side(-1, -1.04, -0.045), side(-1, -1.07, 0)], true, FG)
  b.roundRect(side(-1, -0.6), Z, Y, 0.17, 0.06, 0.03, FG, 3)
  b.rect(side(-1, -0.33), Z, Y, 0.22, 0.085, FG)
  b.rect(side(-1, -0.33, 0.015), Z, Y, 0.18, 0.025, SHd)
  b.circle(side(-1, -0.07), Z, Y, 0.04, 10, FG)
  // right, back to front: USB-A, USB-C, microSD
  b.rect(side(1, -1.0), Z, Y, 0.22, 0.085, FG)
  b.rect(side(1, -1.0, 0.015), Z, Y, 0.18, 0.025, SHd)
  b.roundRect(side(1, -0.7), Z, Y, 0.17, 0.06, 0.03, FG, 3)
  b.rect(side(1, -0.38), Z, Y, 0.22, 0.024, FG)
  // rear exhaust vents over the fin stacks
  for (const sx of [-1, 1]) for (let x = 1.2; x <= 2.3; x += 0.06) b.line([sx * x, B0 + 0.05, Z0 - 0.004], [sx * x, B1 - 0.07, Z0 - 0.004], MESHd)

  // ---------- hinge ----------
  const hr = 0.13
  for (const x of [-2.1, 2.1]) {
    b.circle([x, HINGE[1], HINGE[2]], Z, Y, hr, 16, FG)
    b.circle([x, HINGE[1], HINGE[2]], Z, Y, hr * 0.45, 8, SHd)
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    b.lineN([-2.1, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], [2.1, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], 4, k % 3 === 0 ? SH : MESH)
  }

  // ---------- lid ----------
  const lc = lid(0, LID_H / 2 + 0.08)
  b.roundSlab(lc, X, L, W, LID_H, LID_T, 0.2, FG, SH, SH)
  // thin bezels around the 16:10 OLED, the screen's fine mesh and glass
  const sc = lid(0, LID_H / 2 + 0.12, LID_T / 2 + 0.004)
  const sw = 5.2, shh = 3.25
  b.roundRect(sc, X, L, sw, shh, 0.04, SHd, 2)
  b.roundGrid(sc, X, L, sw, shh, 0.04, 0.11, { layer: 'mesh', w: 0.72 }, 4)
  b.face(b.rectPts(lid(0, LID_H / 2 + 0.12, LID_T / 2), X, L, sw, shh), 'fg', 1.1)
  // FHD IR camera in the top bezel, the IR emitter beside it, a microphone each side
  const camT = LID_H - 0.02
  b.circle(lid(0, camT, LID_T / 2 + 0.005), X, L, 0.04, 10, FG)
  b.circle(lid(0, camT, LID_T / 2 + 0.006), X, L, 0.016, 6, SH)
  b.circle(lid(0.14, camT, LID_T / 2 + 0.005), X, L, 0.014, 6, SHd)
  for (const x of [-0.42, 0.42]) b.circle(lid(x, camT, LID_T / 2 + 0.005), X, L, 0.009, 4, SHd)
  // back of the lid: plain machined aluminum and its glass, then the Slash Lighting band
  const back = -LID_T / 2 - 0.006
  b.face(b.roundRectPts(lid(0, LID_H / 2 + 0.08, -LID_T / 2), X, L, W - 0.1, LID_H - 0.1, 0.18, 2), 'fg', 0.35)
  b.roundRect(lid(0, LID_H / 2 + 0.08, back), X, L, W - 0.3, LID_H - 0.3, 0.14, { layer: 'mesh', w: 0.45 }, 3)
  {
    // a diagonal across the middle of the lid, high on +x and low on -x
    const A: [number, number] = [1.0, 3.0], B: [number, number] = [-1.0, 0.95]
    const len = Math.hypot(B[0] - A[0], B[1] - A[1])
    const d: [number, number] = [(B[0] - A[0]) / len, (B[1] - A[1]) / len]
    const pp: [number, number] = [-d[1], d[0]]
    const at = (s: number, o: number, n = back): Vec3 => lid(A[0] + d[0] * s * len + pp[0] * o, A[1] + d[1] * s * len + pp[1] * o, n)
    const half = 0.055
    // the chromed strip: two long edges and rounded ends
    const CHROME: Style = { layer: 'fg', w: 0.7 }
    b.lineN(at(0, half), at(1, half), 8, CHROME)
    b.lineN(at(0, -half), at(1, -half), 8, CHROME)
    for (const [s, sgn] of [[0, -1], [1, 1]] as const) {
      const pts: Vec3[] = []
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * Math.PI
        const along = sgn * Math.sin(a) * half
        pts.push(at(s + along / len, Math.cos(a) * half))
      }
      b.poly(pts, false, CHROME)
    }
    // 7 zones of 4 LEDs
    for (let z = 1; z < 7; z++) b.line(at(z / 7, half * 0.8), at(z / 7, -half * 0.8), SHd)
    for (let i = 0; i < 28; i++) {
      const s = (Math.floor(i / 4) + (0.2 + (i % 4) * 0.2)) / 7
      const c = at(s, 0, back - 0.002)
      b.circle(c, X, L, 0.016, 6, hot('display', 0.65))
    }
  }
  // inside the lid: backlight strip, panel driver board, display cable into the base
  b.rect(lid(0, 0.4, 0), X, L, 4.9, 0.05, hot('display', 0.7))
  for (let x = -2.3; x <= 2.31; x += 0.2) b.line(lid(x, 0.38, 0), lid(x, 0.43, 0), hot('display', 0.5))
  b.rect(lid(0, LID_H / 2 + 0.12, -0.02), X, L, 5.06, 3.13, hot('display', 0.3), 0.04)
  b.rect(lid(0, 0.22, -0.01), X, L, 1.4, 0.14, hot('board', 0.55), 0.02)
  for (let i = 0; i < 3; i++) {
    const o = (i - 1) * 0.05
    b.curve(lid(0.1 + o, 0.15, -0.01), [0.1 + o, HINGE[1] + 0.02, HINGE[2] - 0.05], [0.3 + o, 0.3, -1.3], [0.55 + o, 0.28, -0.2], 10, hot('board', 0.4))
  }
  // wireless antennas up the lid edges
  for (const sx of [-1, 1]) b.curve([sx * 0.95, 0.27, -0.1], [sx * 1.6, 0.3, -1.4], lid(sx * 2.4, 0.3, 0), lid(sx * 2.45, 2.6, 0), 12, SHd)

  // ---------- logic board ----------
  const by = 0.2
  const P = (x: number, z: number, lift = 0): Vec3 => [x, by + lift, z]
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.38)
  b.poly([P(-1.15, -1.36), P(1.15, -1.36), P(1.15, -0.55), P(1.42, -0.32), P(1.42, 0.3), P(-1.95, 0.3), P(-1.95, -0.3), P(-1.15, -0.58)], true, BRD)
  for (const [x, z] of [[-1.0, -1.25], [1.08, -1.29], [1.3, 0.16], [-1.8, 0.16], [-1.8, -0.18]]) b.circle(P(x, z, 0.002), X, Z, 0.035, 8, BRD)
  const T = (x: number, z: number) => P(x, z, 0.002)
  b.traces(T, [[-0.25, -0.76], [-0.05, -0.76], [0.0, -0.82], [0.14, -0.82]], 6, 0.022, BRDd)
  b.traces(T, [[0.76, -0.66], [0.82, -0.66], [0.87, -0.58]], 4, 0.022, BRDd)
  b.traces(T, [[-0.25, -0.62], [-0.12, -0.62], [-0.12, -0.15], [-0.3, 0.06], [-0.45, 0.06]], 5, 0.024, BRDd)
  b.traces(T, [[0.3, -0.54], [0.3, -0.1], [0.5, 0.1], [0.7, 0.1]], 4, 0.026, BRDd)
  b.traces(T, [[-0.75, -0.76], [-1.0, -0.76], [-1.2, -0.45], [-1.85, -0.25]], 4, 0.026, BRDd)

  // CPU (Ryzen 9 8945HS): package, die, and the cold plate over it
  const CX = -0.5, CZ = -0.82
  b.box(P(CX - 0.25, CZ - 0.25), P(CX + 0.25, CZ + 0.25, 0.04), hot('cpu', 0.85))
  b.rect(P(CX, CZ, 0.045), X, Z, 0.3, 0.22, hot('cpu', 1), 0.02)
  b.rect(P(CX, CZ, 0.047), X, Z, 0.18, 0.12, hot('cpu', 0.7), 0.01)
  b.rect(P(CX, CZ, 0.1), X, Z, 0.62, 0.62, hot('fans', 0.6), 0.05)
  b.rect(P(CX, CZ, 0.102), X, Z, 0.52, 0.52, hot('fans', 0.35), 0.04)
  // GPU (RTX 4060 Laptop): package, die, cold plate, and four GDDR6 chips in a column beside it
  const GX = 0.45, GZ = -0.85
  b.box(P(GX - 0.31, GZ - 0.31), P(GX + 0.31, GZ + 0.31, 0.04), hot('gpu', 0.85))
  b.rect(P(GX, GZ, 0.045), X, Z, 0.36, 0.3, hot('gpu', 1), 0.02)
  b.rect(P(GX, GZ, 0.047), X, Z, 0.22, 0.18, hot('gpu', 0.7), 0.01)
  b.rect(P(GX, GZ, 0.1), X, Z, 0.74, 0.74, hot('fans', 0.6), 0.06)
  b.rect(P(GX, GZ, 0.102), X, Z, 0.64, 0.64, hot('fans', 0.35), 0.05)
  for (const z of [-1.08, -0.82, -0.56, -0.3]) {
    b.box(P(0.87, z - 0.08), P(1.07, z + 0.08, 0.03), hot('gpu', 0.8))
    b.rect(P(0.97, z, 0.032), X, Z, 0.13, 0.09, hot('gpu', 0.4), 0.01)
  }
  // memory: four soldered LPDDR5X packages, two behind the CPU and two in front of it
  for (const [x, z] of [[-0.66, -1.25], [-0.34, -1.25], [-0.66, -0.4], [-0.34, -0.4]]) {
    b.box(P(x - 0.13, z - 0.08), P(x + 0.13, z + 0.08, 0.035), hot('mem', 0.9))
    b.rect(P(x, z, 0.037), X, Z, 0.18, 0.1, hot('mem', 0.45), 0.015)
  }
  // SSD (M.2 2280) on the board's left wing
  {
    const x0 = -1.88, x1 = -0.47, z0 = -0.12, z1 = 0.24
    b.box(P(x0, z0), P(x1, z1, 0.03), hot('disk', 0.9))
    b.rect(P(-1.55, 0.06, 0.032), X, Z, 0.4, 0.26, hot('disk', 0.6), 0.02)
    for (const x of [-1.05, -0.72]) b.rect(P(x, 0.06, 0.032), X, Z, 0.26, 0.26, hot('disk', 0.45), 0.02)
    for (let z = z0 + 0.04; z < z1 - 0.02; z += 0.035) b.line(P(x0 + 0.01, z, 0.031), P(x0 + 0.08, z, 0.031), hot('disk', 0.4))
    b.circle(P(x1 - 0.02, 0.06, 0.032), X, Z, 0.05, 8, hot('disk', 0.6), -Math.PI / 2, Math.PI / 2)
  }
  // wireless card and small parts
  b.box(P(0.7, -0.05), P(1.15, 0.25, 0.03), hot('board', 0.55))
  b.rect(P(0.925, 0.1, 0.032), X, Z, 0.3, 0.2, BRDd, 0.02)
  for (const [x, z] of [[-0.95, -1.1], [-0.82, -1.1], [-0.95, -0.98], [0.15, -1.25], [0.3, -1.25], [-0.1, -1.25], [0.55, -0.3], [0.62, -0.3], [-0.85, -0.3], [-0.95, -0.42]]) {
    b.rect(P(x, z, 0.01), X, Z, 0.06, 0.035, BRDd)
  }

  // ---------- cooling: heat pipes, two blowers, fin stacks ----------
  const FAN = { frame: hot('fans', 0.5), ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 15, depth: 0.12, speed: 1.4, bare: true }
  for (const sx of [-1, 1]) {
    const fc: Vec3 = [sx * 1.75, 0.27, -0.82]
    b.fan(fc, X, Z, 0.92, FAN)
    // blower housing: a widening spiral that opens toward the rear
    for (const y of [0.17, 0.37]) {
      const st = y > 0.3 ? hot('fans', 0.55) : hot('fans', 0.3)
      const pts: Vec3[] = []
      for (let i = 0; i <= 28; i++) {
        const a = -Math.PI * 0.5 - sx * 0.12 * Math.PI - sx * (i / 28) * Math.PI * 1.62
        const r = 0.46 * (1 + 0.26 * (i / 28))
        pts.push([fc[0] + Math.cos(a) * r, y, fc[2] + Math.sin(a) * r])
      }
      b.poly(pts, false, st)
      // outlet walls straight back to the fin stack
      for (const p of [pts[0], pts[pts.length - 1]]) b.line(p, [p[0], y, Z0 + 0.24], st)
      if (y > 0.3) for (const p of [pts[0], pts[14], pts[pts.length - 1]]) b.line(p, [p[0], 0.17, p[2]], hot('fans', 0.3))
    }
    // fin stack at the rear vent
    const fx0 = sx > 0 ? 1.18 : -2.32, fx1 = sx > 0 ? 2.32 : -1.18
    b.box([fx0, 0.17, Z0 + 0.06], [fx1, 0.38, Z0 + 0.24], hot('fans', 0.6))
    for (let x = fx0 + 0.04; x < fx1; x += 0.045) b.line([x, 0.38, Z0 + 0.06], [x, 0.38, Z0 + 0.24], hot('fans.fin', 0.3))
    // two heat pipes from each cold plate (CPU to the left stack, GPU to the right)
    const px = sx < 0 ? CX : GX, pz = sx < 0 ? CZ : GZ, ph = sx < 0 ? 0.26 : 0.32
    for (const o of [-0.07, 0.07]) {
      b.tube([px + sx * ph, 0.31, pz + o], [sx * 1.0, 0.33, pz - 0.02 + o], [sx * 1.32, 0.33, -1.38 + o * 0.5], [sx * 1.75, 0.33, Z0 + 0.3 + o * 0.4], 0.04, Z, 12, hot('fans', 0.65))
    }
  }
  // a shared pipe bridging the two cold plates
  b.tube([CX + 0.3, 0.31, CZ + 0.2], [-0.05, 0.32, CZ + 0.2], [0.0, 0.32, GZ + 0.22], [GX - 0.36, 0.31, GZ + 0.22], 0.035, Z, 6, hot('fans', 0.55))

  // ---------- battery under the palm rest: four cells, 73 Wh ----------
  {
    const y0 = 0.15, y1 = 0.34
    const cells = [-1.62, -0.54, 0.54, 1.62]
    for (const x of cells) {
      const c0: Vec3 = [x, y1, 1.24], c1: Vec3 = [x, y0, 1.24]
      b.roundRect(c0, X, Z, 1.0, 1.3, 0.08, hot('battery', 0.85), 3)
      b.roundRect(c1, X, Z, 1.0, 1.3, 0.08, hot('battery', 0.4), 3)
      for (const [dx, dz] of [[-0.5, -0.65], [0.5, -0.65], [0.5, 0.65], [-0.5, 0.65]]) b.line([x + dx, y0, 1.24 + dz], [x + dx, y1, 1.24 + dz], hot('battery', 0.45))
      b.roundRect([x, y1 + 0.002, 1.24], X, Z, 0.8, 1.1, 0.06, hot('battery', 0.4), 3)
    }
    // charge board along the rear edge and its cable to the logic board
    b.box([-2.1, 0.17, 0.44], [2.1, 0.3, 0.54], hot('battery', 0.55))
    for (let x = -1.9; x <= 1.9; x += 0.3) b.rect([x, 0.302, 0.49], X, Z, 0.12, 0.05, hot('battery', 0.4))
    for (let i = 0; i < 3; i++) b.curve([0.2 + i * 0.05, 0.3, 0.44], [0.2 + i * 0.05, 0.3, 0.38], [0.05 + i * 0.05, 0.24, 0.36], [0.05 + i * 0.05, 0.22, 0.3], 4, hot('battery', 0.4))
  }
  // speakers under the grilles
  for (const sx of [-1, 1]) {
    b.box([sx * 2.34, 0.16, kz - kd / 2 + 0.05], [sx * 2.6, 0.36, kz + kd / 2 - 0.05], SHd)
    for (let z = kz - kd / 2 + 0.2; z < kz + kd / 2 - 0.1; z += 0.25) b.circle([sx * 2.47, 0.362, z], X, Z, 0.07, 8, MESH)
  }

  // ---------- hotspots ----------
  b.hotspot('cpu', P(CX, CZ, 0.12), 'CPU')
  b.hotspot('gpu', P(GX, GZ, 0.12), 'GPU')
  b.hotspot('mem', P(-0.34, -0.4, 0.05), 'Memory')
  b.hotspot('disk', P(-1.25, 0.06, 0.05), 'SSD')
  b.hotspot('battery', [0.54, 0.36, 1.24], 'Battery')
  b.hotspot('fans', [1.75, 0.38, -0.82], 'Cooling')

  return b.model()
}

/** The screen's light washing over the keyboard and the floor, and the fans pulling air under the base and out the rear. */
export const LAPTOP_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [
    { from: lid(0, 2.1, LID_T / 2 + 0.05), dir: [0, -0.5, 1], spread: 36, length: 8.5, intensity: 0.3 },
  ],
  flow: [
    { from: [-1.75, 0.06, Z1 + 2.6], to: [-1.9, 2.4, Z0 - 3.4], via: [-1.75, 0.26, Z0 + 0.1], speed: 1.9, spread: 0.32, lanes: 7 },
    { from: [1.75, 0.06, Z1 + 2.6], to: [1.9, 2.4, Z0 - 3.4], via: [1.75, 0.26, Z0 + 0.1], speed: 1.9, spread: 0.32, lanes: 7 },
  ],
}
