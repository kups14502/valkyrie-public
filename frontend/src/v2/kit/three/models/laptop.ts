// mimir in x-ray: an open laptop. The base sits on the floor with its front
// edge toward +z, the lid stands at the rear hinge leaning back 20 degrees and
// the screen faces the viewer. Inside the base: the board with CPU and memory,
// an SSD, two blower fans fed by heat pipes, and the battery cells under the
// palm rest.
//
// Groups: cpu (die and package), mem (memory), disk (SSD), battery (cells,
// charge board), fans (blowers, heat pipes, fin stacks), display (backlight),
// board.

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
const LID_H = 3.72, LID_T = 0.12

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** A point on the lid: x across, t up the lid from the hinge, n out of the screen. */
const lid = (x: number, t: number, n = 0): Vec3 => [x, HINGE[1] + L[1] * t + N[1] * n, HINGE[2] + L[2] * t + N[2] * n]

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
  b.roundRect(bc(B0), X, Z, W - 0.1, D - 0.1, 0.24, SH)
  b.roundRect(bc(B1 - 0.05), X, Z, W, D, 0.28, FGd)
  b.roundRect(bc(B1), X, Z, W - 0.08, D - 0.08, 0.24, FG)
  {
    const lo = b.roundRectPts(bc(B0), X, Z, W - 0.1, D - 0.1, 0.24, 6)
    const mid = b.roundRectPts(bc(B1 - 0.05), X, Z, W, D, 0.28, 6)
    for (let q = 0; q < 4; q++) for (const i of [0, 3, 6]) b.line(lo[q * 7 + i], mid[q * 7 + i], SH)
  }
  b.face(b.roundRectPts(bc(B1), X, Z, W - 0.08, D - 0.08, 0.24, 3), 'fg', 0.5)
  b.face([[-HX + 0.1, B0 + 0.03, Z1], [HX - 0.1, B0 + 0.03, Z1], [HX - 0.1, B1 - 0.06, Z1], [-HX + 0.1, B1 - 0.06, Z1]], 'fg', 0.5)
  // finger scoop at the front edge
  b.circle([0, B1 + 0.002, Z1 - 0.04], X, Z, 0.42, 16, SHd, Math.PI, Math.PI * 2)
  // status light on the front lip
  b.rect([0, 0.22, Z1 + 0.006], X, Y, 1.0, 0.03, ACC)
  // feet and bottom intake
  for (const z of [Z0 + 0.32, Z1 - 0.3]) b.box([-2.15, 0, z - 0.06], [2.15, B0, z + 0.06], SHd)
  for (let x = -1.9; x <= 1.9; x += 0.12) b.lineN([x, B0 - 0.002, -1.25], [x, B0 - 0.002, -0.35], 2, { layer: 'mesh', w: 0.4 })

  // keyboard well and keys
  const kw = 4.72, kd = 1.86, kz = -0.44
  b.rect([0, B1 + 0.003, kz], X, Z, kw, kd, SHd, 0.06)
  {
    const unit = 4.56 / 15, gap = 0.036, KEY: Style = { layer: 'shell', w: 1 }
    let z = kz - kd / 2 + 0.09
    for (const row of KEY_ROWS) {
      const rh = row.h * unit
      let x = -4.56 / 2
      for (const k of row.keys) {
        const kwid = k * unit
        if (k === 3) {
          // arrow cluster: left, up over down, right
          const u = unit
          b.rect([x + u / 2, B1 + 0.014, z + rh / 2], X, Z, u - gap, rh - gap, KEY, 0.02)
          b.rect([x + 1.5 * u, B1 + 0.014, z + rh * 0.25], X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect([x + 1.5 * u, B1 + 0.014, z + rh * 0.75], X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect([x + 2.5 * u, B1 + 0.014, z + rh / 2], X, Z, u - gap, rh - gap, KEY, 0.02)
        } else {
          b.rect([x + kwid / 2, B1 + 0.014, z + rh / 2], X, Z, kwid - gap, rh - gap, KEY, 0.025)
        }
        x += kwid
      }
      z += rh
    }
  }
  // trackpad
  b.roundRect([0, B1 + 0.004, 1.38], X, Z, 2.3, 1.26, 0.08, FGd, 3)
  b.face(b.roundRectPts([0, B1 + 0.004, 1.38], X, Z, 2.3, 1.26, 0.08, 2), 'fg', 0.6)
  // speaker grills beside the keyboard
  for (const sx of [-1, 1]) {
    for (let z = -1.3; z <= 0.42; z += 0.075) b.line([sx * 2.48, B1 + 0.003, z], [sx * 2.6, B1 + 0.003, z], MESHd)
  }
  // ports: two USB-C on the left, audio + USB-C on the right
  for (const z of [-0.95, -0.55]) b.roundRect([-HX - 0.004, 0.26, z], Z, Y, 0.24, 0.085, 0.04, FG, 3)
  b.circle([HX + 0.004, 0.26, -0.95], Z, Y, 0.045, 10, FG)
  b.roundRect([HX + 0.004, 0.26, -0.55], Z, Y, 0.24, 0.085, 0.04, FG, 3)
  // rear exhaust vents over the fin stacks
  for (const sx of [-1, 1]) for (let x = 1.25; x <= 2.25; x += 0.06) b.line([sx * x, B0 + 0.06, Z0 - 0.004], [sx * x, B1 - 0.07, Z0 - 0.004], MESHd)

  // ---------- hinge ----------
  const hr = 0.15
  for (const x of [-2.15, 2.15]) {
    b.circle([x, HINGE[1], HINGE[2]], Z, Y, hr, 16, FG)
    b.circle([x, HINGE[1], HINGE[2]], Z, Y, hr * 0.45, 8, SHd)
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2
    b.lineN([-2.15, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], [2.15, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], 4, k % 3 === 0 ? SH : MESH)
  }

  // ---------- lid ----------
  const lc = lid(0, LID_H / 2 + 0.08)
  b.roundSlab(lc, X, L, W, LID_H, LID_T, 0.22, FG, SH, SH)
  // bezel and the screen's fine mesh + glass
  const sc = lid(0, LID_H / 2 + 0.12, LID_T / 2 + 0.004)
  const sw = 5.14, shh = 3.22
  b.roundRect(sc, X, L, sw, shh, 0.05, SHd, 2)
  b.roundGrid(sc, X, L, sw, shh, 0.05, 0.11, { layer: 'mesh', w: 0.72 }, 4)
  b.face(b.rectPts(lid(0, LID_H / 2 + 0.12, LID_T / 2), X, L, sw, shh), 'fg', 1.1)
  // webcam in the top bezel
  b.circle(lid(0, LID_H + 0.02, LID_T / 2 + 0.005), X, L, 0.045, 10, FG)
  b.circle(lid(0, LID_H + 0.02, LID_T / 2 + 0.006), X, L, 0.018, 6, SH)
  b.circle(lid(0.16, LID_H + 0.02, LID_T / 2 + 0.005), X, L, 0.015, 6, SHd)
  // back of the lid: coarse faint grid + glass
  b.grid(lid(0, LID_H / 2 + 0.08, -LID_T / 2 - 0.004), X, L, W - 0.5, LID_H - 0.4, 0.42, { layer: 'mesh', w: 0.4 }, 3)
  b.face(b.roundRectPts(lid(0, LID_H / 2 + 0.08, -LID_T / 2), X, L, W - 0.1, LID_H - 0.1, 0.2, 2), 'fg', 0.35)
  // inside the lid: backlight strip, panel driver board, display cable into the base
  b.rect(lid(0, 0.4, 0), X, L, 4.9, 0.05, hot('display', 0.7))
  for (let x = -2.3; x <= 2.31; x += 0.2) b.line(lid(x, 0.38, 0), lid(x, 0.43, 0), hot('display', 0.5))
  b.rect(lid(0, LID_H / 2 + 0.12, -0.02), X, L, 5.0, 3.1, hot('display', 0.3), 0.04)
  b.rect(lid(0, 0.22, -0.01), X, L, 1.4, 0.14, hot('board', 0.55), 0.02)
  for (let i = 0; i < 3; i++) {
    const o = (i - 1) * 0.05
    b.curve(lid(0.1 + o, 0.15, -0.01), [0.1 + o, HINGE[1] + 0.02, HINGE[2] - 0.05], [0.4 + o, 0.3, -1.3], [0.7 + o, 0.28, -1.0], 10, hot('board', 0.4))
  }
  // wireless antennas up the lid edges
  for (const sx of [-1, 1]) b.curve([sx * 0.95, 0.27, -0.25], [sx * 1.6, 0.3, -1.4], lid(sx * 2.4, 0.3, 0), lid(sx * 2.45, 2.6, 0), 12, SHd)

  // ---------- logic board ----------
  const by = 0.2
  const P = (x: number, z: number, lift = 0): Vec3 => [x, by + lift, z]
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.38)
  b.poly([P(-1.15, -1.36), P(1.15, -1.36), P(1.15, -0.55), P(1.42, -0.32), P(1.42, 0.3), P(-1.95, 0.3), P(-1.95, -0.3), P(-1.15, -0.58)], true, BRD)
  for (const [x, z] of [[-1.0, -1.22], [1.0, -1.22], [1.28, 0.16], [-1.8, 0.16], [-1.8, -0.18]]) b.circle(P(x, z, 0.002), X, Z, 0.035, 8, BRD)
  const T = (x: number, z: number) => P(x, z, 0.002)
  b.traces(T, [[0.47, -0.62], [0.6, -0.62], [0.66, -0.52], [0.76, -0.52]], 6, 0.022, BRDd)
  b.traces(T, [[-0.17, -0.62], [-0.3, -0.62], [-0.36, -0.72], [-0.46, -0.72]], 6, 0.022, BRDd)
  b.traces(T, [[0.15, -0.38], [0.15, -0.1], [-0.1, 0.1], [-0.42, 0.1]], 5, 0.026, BRDd)
  b.traces(T, [[0.35, -0.38], [0.35, -0.05], [0.6, 0.12], [1.2, 0.12]], 4, 0.026, BRDd)
  b.traces(T, [[-1.0, -0.62], [-1.0, -0.42], [-1.3, -0.25], [-1.85, -0.25]], 4, 0.026, BRDd)

  // CPU: package, die, and the cold plate over it
  b.box(P(-0.16, -0.94), P(0.46, -0.32, 0.04), hot('cpu', 0.85))
  b.rect(P(0.15, -0.63, 0.045), X, Z, 0.34, 0.26, hot('cpu', 1), 0.02)
  b.rect(P(0.15, -0.63, 0.047), X, Z, 0.2, 0.14, hot('cpu', 0.7), 0.01)
  b.rect(P(0.15, -0.63, 0.1), X, Z, 0.82, 0.78, hot('fans', 0.6), 0.06)
  b.rect(P(0.15, -0.63, 0.102), X, Z, 0.72, 0.68, hot('fans', 0.35), 0.05)
  // memory: four packages around the CPU
  for (const [x, z] of [[0.86, -0.82], [0.86, -0.44], [-0.56, -0.82], [-0.56, -0.44]]) {
    b.box(P(x - 0.17, z - 0.12), P(x + 0.17, z + 0.12, 0.035), hot('mem', 0.9))
    b.rect(P(x, z, 0.037), X, Z, 0.24, 0.14, hot('mem', 0.45), 0.015)
  }
  // SSD (M.2) on the board's left wing
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
  for (const [x, z] of [[-0.95, -1.1], [-0.82, -1.1], [-0.95, -0.98], [0.7, -1.15], [0.82, -1.15], [0.95, -1.15], [-0.2, -1.2], [-0.05, -1.2], [-0.3, 0.2], [-0.18, 0.2]]) {
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
    const fx0 = sx > 0 ? 1.22 : -2.3, fx1 = sx > 0 ? 2.3 : -1.22
    b.box([fx0, 0.17, Z0 + 0.06], [fx1, 0.38, Z0 + 0.24], hot('fans', 0.6))
    for (let x = fx0 + 0.04; x < fx1; x += 0.045) b.line([x, 0.38, Z0 + 0.06], [x, 0.38, Z0 + 0.24], hot('fans.fin', 0.3))
    // two heat pipes from the cold plate to the fin stack
    for (const o of [-0.07, 0.07]) {
      b.tube([0.15 + sx * 0.3, 0.31, -0.63 + o], [sx * 0.9, 0.33, -0.65 + o], [sx * 1.3, 0.33, -1.38 + o * 0.5], [sx * 1.75, 0.33, Z0 + 0.3 + o * 0.4], 0.04, Z, 12, hot('fans', 0.65))
    }
  }

  // ---------- battery under the palm rest ----------
  {
    const y0 = 0.15, y1 = 0.34
    const cells = [-1.62, -0.54, 0.54, 1.62]
    for (const x of cells) {
      const c0: Vec3 = [x, y1, 1.22], c1: Vec3 = [x, y0, 1.22]
      b.roundRect(c0, X, Z, 1.0, 1.32, 0.08, hot('battery', 0.85), 3)
      b.roundRect(c1, X, Z, 1.0, 1.32, 0.08, hot('battery', 0.4), 3)
      for (const [dx, dz] of [[-0.5, -0.66], [0.5, -0.66], [0.5, 0.66], [-0.5, 0.66]]) b.line([x + dx, y0, 1.22 + dz], [x + dx, y1, 1.22 + dz], hot('battery', 0.45))
      b.roundRect([x, y1 + 0.002, 1.22], X, Z, 0.8, 1.12, 0.06, hot('battery', 0.4), 3)
    }
    // charge board along the rear edge and its cable to the logic board
    b.box([-2.1, 0.17, 0.42], [2.1, 0.3, 0.52], hot('battery', 0.55))
    for (let x = -1.9; x <= 1.9; x += 0.3) b.rect([x, 0.302, 0.47], X, Z, 0.12, 0.05, hot('battery', 0.4))
    for (let i = 0; i < 3; i++) b.curve([0.2 + i * 0.05, 0.3, 0.42], [0.2 + i * 0.05, 0.3, 0.36], [0.05 + i * 0.05, 0.24, 0.36], [0.05 + i * 0.05, 0.22, 0.3], 4, hot('battery', 0.4))
  }
  // speakers under the grills
  for (const sx of [-1, 1]) {
    b.box([sx * 2.32, 0.16, -1.25], [sx * 2.6, 0.36, 0.38], SHd)
    for (let z = -1.1; z < 0.3; z += 0.25) b.circle([sx * 2.46, 0.362, z], X, Z, 0.07, 8, MESH)
  }

  // ---------- hotspots ----------
  b.hotspot('cpu', P(0.15, -0.63, 0.12), 'CPU')
  b.hotspot('mem', P(0.86, -0.44, 0.05), 'Memory')
  b.hotspot('disk', P(-1.25, 0.06, 0.05), 'SSD')
  b.hotspot('battery', [0.54, 0.36, 1.22], 'Battery')
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
