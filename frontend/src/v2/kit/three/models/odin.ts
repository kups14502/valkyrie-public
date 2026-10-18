// odin in x-ray: the real rig. An HP Spectre x360 15 (15-ch0xx) convertible
// laptop, open, with the media RAID beside it: a TerraMaster four-bay USB
// enclosure holding four 2.5in SATA SSDs in 3.5in trays, its rear fan, the
// USB cable from the enclosure to the laptop, and a USB gigabit ethernet
// dongle. The laptop faces +z and sits right of center; the enclosure stands
// on its left, a little further back. Floor at y = 0.
//
// Laptop: thin, gem-cut (the rear corners of the base and the lid are cut at
// 45 degrees, the top edges carry a polished bevel), a 360-degree hinge
// between the cut corners, a speaker grille over the keyboard, a wide
// trackpad. Labels stay generic: no claims about exact parts.
//
// TO REFINE when Brendon sends photos of odin: which side each port and cable
// is on (the dongle is drawn on the right, the enclosure cable on the left),
// the lid angle and whether it stands as a laptop or a tent, the keyboard
// layout (no numpad drawn), the enclosure's real proportions, tray handles,
// front LEDs and rear port layout, where the ethernet cable runs, and the
// real gap and stagger between the laptop and the enclosure.
//
// Groups: cpu (die, package, cold plate), mem (memory), disk (the NVMe SSD;
// the enclosure's SSDs and backplane are disk.das, so they follow disk until
// the API reports the array), fans (laptop blowers, heat pipes, fins;
// fans.das for the enclosure fan), battery (cells), display (backlight),
// board.

import type { Model, Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

// ---------- laptop frame of reference (~72 mm per unit) ----------

/** laptop center x, base footprint (rear z0 to front z1), base bottom and top */
const LX = 1.15
const W = 5.0, D = 3.48
const Z0 = -1.55, Z1 = Z0 + D
const B0 = 0.04, B1 = 0.19
/** gem cut on the rear corners, round on the front corners */
const CUT = 0.26, RND = 0.12
const LID_ANGLE = (18 * Math.PI) / 180
const L: Vec3 = [0, Math.cos(LID_ANGLE), -Math.sin(LID_ANGLE)]
const NL: Vec3 = [0, Math.sin(LID_ANGLE), Math.cos(LID_ANGLE)]
const HINGE: Vec3 = [LX, B1 - 0.01, Z0 + 0.12]
const LID_T = 0.1

/** A point on the base: x across from the laptop center, z, y. */
const P = (x: number, z: number, y: number): Vec3 => [LX + x, y, z]
/** A point on the lid: x across, t up the lid from the hinge, n out of the screen. */
const lid = (x: number, t: number, n = 0): Vec3 => [LX + x, HINGE[1] + L[1] * t + NL[1] * n, HINGE[2] + L[2] * t + NL[2] * n]

/**
 * The gem-cut outline in 2D: u across (-w/2..w/2), v from the cut edge (0) to
 * the rounded edge (d), inset by `ins`. Returns the points and the indices of
 * the corners, for the vertical edges.
 */
function gem(w: number, d: number, ins = 0): { pts: [number, number][]; corners: number[] } {
  const a = w / 2 - ins, v0 = ins, v1 = d - ins
  const c = Math.max(0.02, CUT - ins * 0.4), r = Math.max(0.02, RND - ins)
  const pts: [number, number][] = []
  const corners: number[] = []
  const arc = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 4; i++) {
      const t = a0 + (i / 4) * (Math.PI / 2)
      if (i === 2) corners.push(pts.length)
      pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r])
    }
  }
  corners.push(pts.length)
  pts.push([a, v0 + c])
  arc(a - r, v1 - r, 0)
  arc(-a + r, v1 - r, Math.PI / 2)
  corners.push(pts.length)
  pts.push([-a, v0 + c])
  corners.push(pts.length)
  pts.push([-a + c, v0])
  corners.push(pts.length)
  pts.push([a - c, v0])
  return { pts, corners }
}

const KEY_ROWS: { h: number; keys: number[] }[] = [
  { h: 0.55, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1] },
  { h: 1, keys: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1] },
  { h: 1, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1] },
  { h: 1, keys: [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25, 1] },
  { h: 1, keys: [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75, 1] },
  { h: 1, keys: [1, 1, 1, 1.25, 5.5, 1.25, 1, 3, 1] },
]

function spectre(b: Builder) {
  // ---------- base: bottom, bevel line, top face inset by the polished bevel ----------
  const base = (ins: number, y: number): Vec3[] => gem(W, D, ins).pts.map(([u, v]) => P(u, Z0 + v, y))
  const lo = base(0.05, B0 + 0.01)
  const mid = base(0, B1 - 0.035)
  const top = base(0.035, B1)
  b.poly(lo, true, SH)
  b.poly(mid, true, FG)
  b.poly(top, true, FGd)
  for (const i of gem(W, D).corners) {
    b.line(lo[i], mid[i], SH)
    b.line(mid[i], top[i], SHd)
  }
  b.face(base(0.035, B1), 'fg', 0.45)
  // rubber feet strips and the bottom intake
  for (const z of [Z0 + 0.35, Z1 - 0.3]) b.box(P(-2.0, z - 0.05, 0), P(2.0, z + 0.05, B0), SHd)
  for (let x = -1.9; x <= 1.9; x += 0.12) b.lineN(P(x, -1.2, B0 + 0.008), P(x, -0.35, B0 + 0.008), 2, { layer: 'mesh', w: 0.4 })

  // speaker grille across the top of the deck, keyboard, wide trackpad
  const yt = B1 + 0.003
  b.rect(P(0, Z0 + 0.37, yt), X, Z, 4.3, 0.2, SHd, 0.05)
  for (let x = -2.08; x <= 2.08; x += 0.055) b.line(P(x, Z0 + 0.3, yt), P(x, Z0 + 0.44, yt), MESHd)
  const kw = 4.36, kd = 1.64, kz = Z0 + 0.52 + kd / 2
  b.rect(P(0, kz, yt), X, Z, kw, kd, SHd, 0.05)
  {
    const unit = 4.24 / 16, gap = 0.034, KEY: Style = { layer: 'shell', w: 1 }
    let z = kz - kd / 2 + 0.07
    for (const row of KEY_ROWS) {
      const rh = row.h * unit
      let x = -4.24 / 2
      for (const k of row.keys) {
        const kwid = k * unit
        if (k === 3) {
          const u = unit
          b.rect(P(x + u / 2, z + rh / 2, B1 + 0.012), X, Z, u - gap, rh - gap, KEY, 0.02)
          b.rect(P(x + 1.5 * u, z + rh * 0.25, B1 + 0.012), X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect(P(x + 1.5 * u, z + rh * 0.75, B1 + 0.012), X, Z, u - gap, rh / 2 - gap, KEY, 0.015)
          b.rect(P(x + 2.5 * u, z + rh / 2, B1 + 0.012), X, Z, u - gap, rh - gap, KEY, 0.02)
        } else {
          b.rect(P(x + kwid / 2, z + rh / 2, B1 + 0.012), X, Z, kwid - gap, rh - gap, KEY, 0.022)
        }
        x += kwid
      }
      z += rh
    }
  }
  const tz = Z1 - 0.66
  b.roundRect(P(0, tz, B1 + 0.004), X, Z, 2.0, 1.0, 0.07, FGd, 3)
  b.face(b.roundRectPts(P(0, tz, B1 + 0.004), X, Z, 2.0, 1.0, 0.07, 2), 'fg', 0.6)
  // status light on the front lip
  b.rect(P(0, Z1 + 0.004, 0.12), X, Y, 0.6, 0.025, ACC)

  // ports: right side (power on the cut corner, USB-A, audio), left side (two USB-C, card slot)
  {
    const xr = W / 2 + 0.004
    b.roundRect(P(xr, -0.35, 0.115), Z, Y, 0.3, 0.075, 0.03, FG, 3)
    b.circle(P(xr, 0.15, 0.115), Z, Y, 0.035, 10, FG)
    const xl = -W / 2 - 0.004
    for (const z of [-0.95, -0.6]) b.roundRect(P(xl, z, 0.115), Z, Y, 0.2, 0.06, 0.03, FG, 3)
    b.rect(P(xl, 0.25, 0.115), Z, Y, 0.26, 0.03, SHd)
    // the cut corners: power button right, USB-C left
    const m = CUT / 2
    b.roundRect(P(W / 2 - m + 0.003, Z0 + m - 0.003, 0.115), [0.7071, 0, 0.7071], Y, 0.14, 0.05, 0.02, FG, 2)
    b.roundRect(P(-W / 2 + m - 0.003, Z0 + m - 0.003, 0.115), [0.7071, 0, -0.7071], Y, 0.16, 0.055, 0.025, FG, 2)
  }
  // exhaust vents in the rear edge between the cut corners
  for (let x = -2.0; x <= 2.0; x += 0.05) if (Math.abs(x) > 1.1) b.line(P(x, Z0 - 0.004, B0 + 0.035), P(x, Z0 - 0.004, B1 - 0.05), MESHd)

  // ---------- 360-degree hinge ----------
  const hr = 0.075
  for (const x0 of [-1.85, 1.35]) {
    const x1 = x0 + 0.5
    for (const x of [x0, x1]) b.circle([LX + x, HINGE[1], HINGE[2]], Z, Y, hr, 14, FG)
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4
      b.line([LX + x0, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], [LX + x1, HINGE[1] + Math.sin(a) * hr, HINGE[2] + Math.cos(a) * hr], SH)
    }
    b.circle([LX + (x0 + x1) / 2, HINGE[1], HINGE[2]], Z, Y, hr * 0.5, 8, SHd)
  }

  // ---------- lid: same gem cut at the hinge edge ----------
  const lidLoop = (ins: number, n: number): Vec3[] => gem(W, D, ins).pts.map(([u, v]) => lid(u, v - 0.06, n))
  const lf = lidLoop(0, LID_T / 2), lb = lidLoop(0, -LID_T / 2), lbv = lidLoop(0.035, -LID_T / 2 - 0.004)
  b.poly(lf, true, FG)
  b.poly(lb, true, SH)
  b.poly(lbv, true, SHd)
  for (const i of gem(W, D).corners) b.line(lf[i], lb[i], SH)
  // screen: bezel, fine mesh, glass
  const sc = lid(0, 0.5 + 1.35, LID_T / 2 + 0.004)
  const sw = 4.78, shh = 2.7
  b.roundRect(sc, X, L, sw, shh, 0.03, SHd, 2)
  b.roundGrid(sc, X, L, sw, shh, 0.03, 0.11, { layer: 'mesh', w: 0.72 }, 4)
  b.face(b.rectPts(lid(0, 0.5 + 1.35, LID_T / 2), X, L, sw, shh), 'fg', 1.1)
  // webcam in the top bezel
  b.circle(lid(0, D - 0.2, LID_T / 2 + 0.005), X, L, 0.04, 10, FG)
  b.circle(lid(0, D - 0.2, LID_T / 2 + 0.006), X, L, 0.016, 6, SH)
  // back of the lid: faint grid, glass, and the logo's four slashes
  b.grid(lid(0, D / 2 - 0.06, -LID_T / 2 - 0.004), X, L, W - 0.5, D - 0.5, 0.42, { layer: 'mesh', w: 0.4 }, 3)
  b.face(b.roundRectPts(lid(0, D / 2 - 0.06, -LID_T / 2), X, L, W - 0.1, D - 0.1, 0.12, 2), 'fg', 0.35)
  for (let k = 0; k < 4; k++) {
    const x = -0.2 + k * 0.13
    b.line(lid(x - 0.06, D / 2 - 0.2, -LID_T / 2 - 0.006), lid(x + 0.06, D / 2 + 0.2, -LID_T / 2 - 0.006), SHd)
  }
  // inside the lid: backlight strip, panel, driver board, cable into the base
  b.rect(lid(0, 0.4, 0), X, L, 4.7, 0.05, hot('display', 0.7))
  for (let x = -2.2; x <= 2.21; x += 0.2) b.line(lid(x, 0.38, 0), lid(x, 0.43, 0), hot('display', 0.5))
  b.rect(lid(0, 0.5 + 1.35, -0.015), X, L, 4.68, 2.62, hot('display', 0.3), 0.04)
  b.rect(lid(0, 0.2, -0.01), X, L, 1.3, 0.12, hot('board', 0.55), 0.02)
  for (let i = 0; i < 3; i++) {
    const o = (i - 1) * 0.05
    b.curve(lid(0.1 + o, 0.14, -0.01), [LX + 0.1 + o, HINGE[1] - 0.02, HINGE[2] - 0.02], P(0.35 + o, -1.25, 0.14), P(0.6 + o, -1.0, 0.13), 8, hot('board', 0.4))
  }

  // ---------- logic board ----------
  const by = 0.08
  const Bp = (x: number, z: number, lift = 0): Vec3 => P(x, z, by + lift)
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.38)
  b.poly([Bp(-1.2, -1.4), Bp(1.2, -1.4), Bp(1.2, -0.6), Bp(1.4, -0.36), Bp(1.4, 0.2), Bp(-2.0, 0.2), Bp(-2.0, -0.32), Bp(-1.2, -0.6)], true, BRD)
  for (const [x, z] of [[-1.05, -1.26], [1.05, -1.26], [1.26, 0.06], [-1.86, 0.06], [-1.86, -0.2]]) b.circle(Bp(x, z, 0.002), X, Z, 0.035, 8, BRD)
  const T = (x: number, z: number) => Bp(x, z, 0.002)
  b.traces(T, [[0.47, -0.66], [0.6, -0.66], [0.66, -0.56], [0.76, -0.56]], 6, 0.022, BRDd)
  b.traces(T, [[-0.17, -0.66], [-0.3, -0.66], [-0.36, -0.76], [-0.46, -0.76]], 6, 0.022, BRDd)
  b.traces(T, [[0.15, -0.42], [0.15, -0.16], [-0.1, 0.02], [-0.5, 0.02]], 5, 0.026, BRDd)
  b.traces(T, [[0.35, -0.42], [0.35, -0.1], [0.6, 0.06], [1.2, 0.06]], 4, 0.026, BRDd)
  // CPU: package, die, cold plate
  b.box(Bp(-0.16, -0.98), Bp(0.46, -0.36, 0.035), hot('cpu', 0.85))
  b.rect(Bp(0.15, -0.67, 0.04), X, Z, 0.34, 0.26, hot('cpu', 1), 0.02)
  b.rect(Bp(0.15, -0.67, 0.042), X, Z, 0.2, 0.14, hot('cpu', 0.7), 0.01)
  b.rect(Bp(0.15, -0.67, 0.07), X, Z, 0.82, 0.78, hot('fans', 0.6), 0.06)
  // memory: four packages around the CPU
  for (const [x, z] of [[0.86, -0.86], [0.86, -0.48], [-0.56, -0.86], [-0.56, -0.48]]) {
    b.box(Bp(x - 0.17, z - 0.12), Bp(x + 0.17, z + 0.12, 0.03), hot('mem', 0.9))
    b.rect(Bp(x, z, 0.032), X, Z, 0.24, 0.14, hot('mem', 0.45), 0.015)
  }
  // NVMe SSD (M.2 2280) on the board's left wing
  {
    const x0 = -1.94, x1 = -0.5, z0 = -0.16, z1 = 0.16
    b.box(Bp(x0, z0), Bp(x1, z1, 0.025), hot('disk', 0.9))
    b.rect(Bp(-1.6, 0, 0.027), X, Z, 0.4, 0.24, hot('disk', 0.6), 0.02)
    for (const x of [-1.1, -0.78]) b.rect(Bp(x, 0, 0.027), X, Z, 0.26, 0.24, hot('disk', 0.45), 0.02)
    for (let z = z0 + 0.04; z < z1 - 0.02; z += 0.035) b.line(Bp(x0 + 0.01, z, 0.026), Bp(x0 + 0.08, z, 0.026), hot('disk', 0.4))
    b.circle(Bp(x1 - 0.02, 0, 0.027), X, Z, 0.045, 8, hot('disk', 0.6), -Math.PI / 2, Math.PI / 2)
  }
  // wireless card and passives
  b.box(Bp(0.7, -0.24), Bp(1.15, 0.06, 0.025), hot('board', 0.55))
  for (const [x, z] of [[-0.95, -1.14], [-0.82, -1.14], [-0.95, -1.02], [0.7, -1.19], [0.82, -1.19], [-0.2, -1.24], [-0.05, -1.24]]) b.rect(Bp(x, z, 0.01), X, Z, 0.06, 0.035, BRDd)

  // ---------- cooling: two blowers, heat pipes, fin stacks at the rear vents ----------
  const FAN = { frame: hot('fans', 0.5), ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 15, depth: 0.07, speed: 1.4, bare: true }
  for (const sx of [-1, 1]) {
    const fc = P(sx * 1.82, -0.82, 0.12)
    b.fan(fc, X, Z, 0.86, FAN)
    for (const y of [0.07, 0.16]) {
      const st = y > 0.12 ? hot('fans', 0.55) : hot('fans', 0.3)
      const pts: Vec3[] = []
      for (let i = 0; i <= 26; i++) {
        const a = -Math.PI * 0.5 - sx * 0.12 * Math.PI - sx * (i / 26) * Math.PI * 1.62
        const r = 0.43 * (1 + 0.26 * (i / 26))
        pts.push([fc[0] + Math.cos(a) * r, y, fc[2] + Math.sin(a) * r])
      }
      b.poly(pts, false, st)
      for (const p of [pts[0], pts[pts.length - 1]]) b.line(p, [p[0], y, Z0 + 0.24], st)
    }
    const fx0 = sx > 0 ? 1.2 : -2.25, fx1 = sx > 0 ? 2.25 : -1.2
    b.box(P(fx0, Z0 + 0.06, 0.07), P(fx1, Z0 + 0.24, 0.17), hot('fans', 0.6))
    for (let x = fx0 + 0.04; x < fx1; x += 0.045) b.line(P(x, Z0 + 0.06, 0.17), P(x, Z0 + 0.24, 0.17), hot('fans.fin', 0.3))
    for (const o of [-0.07, 0.07]) {
      b.tube(P(0.15 + sx * 0.3, -0.67 + o, 0.15), P(sx * 0.9, -0.69 + o, 0.15), P(sx * 1.3, -1.38 + o * 0.5, 0.15), P(sx * 1.72, Z0 + 0.3 + o * 0.4, 0.15), 0.035, Z, 12, hot('fans', 0.65))
    }
  }

  // ---------- battery under the palm rest ----------
  for (const x of [-1.8, -0.6, 0.6, 1.8]) {
    b.roundRect(P(x, 1.12, 0.15), X, Z, 1.06, 1.36, 0.08, hot('battery', 0.42), 3)
    b.roundRect(P(x, 1.12, 0.07), X, Z, 1.06, 1.36, 0.08, hot('battery', 0.22), 3)
    for (const [dx, dz] of [[-0.53, -0.68], [0.53, -0.68], [0.53, 0.68], [-0.53, 0.68]]) b.line(P(x + dx, 1.12 + dz, 0.07), P(x + dx, 1.12 + dz, 0.15), hot('battery', 0.22))
  }
  b.box(P(-2.1, 0.3, 0.07), P(2.1, 0.4, 0.14), hot('battery', 0.3))
}

// ---------- the enclosure (~72 mm per unit, like the laptop) ----------

const DX = -2.78, DZ = -0.4
const DW = 1.9, DH = 2.45, DD = 3.0
const DY0 = 0.06
const DFZ = DZ + DD / 2
const BAY_W = (DW - 0.26) / 4

function enclosure(b: Builder) {
  const cy = DY0 + DH / 2
  b.chamferBox([DX, cy, DZ], [DW / 2, DH / 2, DD / 2], 0.08,
    (axis, s) => (axis === 2 && s === 1) || (axis === 1 && s === 1) ? FG : axis === 0 && s === 1 ? FGd : SH, SH)
  b.face([[DX - DW / 2 + 0.08, DY0 + 0.08, DFZ], [DX + DW / 2 - 0.08, DY0 + 0.08, DFZ], [DX + DW / 2 - 0.08, DY0 + DH - 0.08, DFZ], [DX - DW / 2 + 0.08, DY0 + DH - 0.08, DFZ]], 'fg', 0.4)
  b.face([[DX - DW / 2 + 0.08, DY0 + DH, DZ - DD / 2 + 0.08], [DX + DW / 2 - 0.08, DY0 + DH, DZ - DD / 2 + 0.08], [DX + DW / 2 - 0.08, DY0 + DH, DFZ - 0.08], [DX - DW / 2 + 0.08, DY0 + DH, DFZ - 0.08]], 'fg', 0.35)
  // feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.circle([DX + sx * (DW / 2 - 0.2), DY0 - 0.002, DZ + sz * (DD / 2 - 0.25)], X, Z, 0.09, 10, SHd)
  // side vents (+x, toward the laptop)
  for (let z = DZ - 1.1; z <= DZ + 0.9; z += 0.09) b.line([DX + DW / 2 + 0.004, DY0 + 0.5, z], [DX + DW / 2 + 0.004, DY0 + DH - 0.5, z], MESHd)

  // front: status strip with the power button and a light per bay
  const fz = DFZ + 0.004
  const sy = DY0 + DH - 0.2
  b.rect([DX, sy, fz], X, Y, DW - 0.24, 0.2, SHd, 0.04)
  b.circle([DX + DW / 2 - 0.25, sy, fz + 0.004], X, Y, 0.06, 12, FG)
  for (let i = 0; i < 4; i++) b.circle([DX - DW / 2 + 0.13 + BAY_W * (i + 0.5), sy, fz + 0.004], X, Y, 0.022, 6, hot('disk.das', 1))
  b.rect([DX, DY0 + 0.1, fz + 0.006], X, Y, DW - 0.4, 0.03, ACC)

  // four vertical trays, each with a 2.5in SSD standing on its edge inside
  const ty0 = DY0 + 0.2, ty1 = DY0 + DH - 0.38
  const tdepth = 2.15
  for (let i = 0; i < 4; i++) {
    const x = DX - DW / 2 + 0.13 + BAY_W * (i + 0.5)
    const tyc = (ty0 + ty1) / 2
    // tray face: outline, latch, vent slots
    b.rect([x, tyc, fz], X, Y, BAY_W - 0.04, ty1 - ty0, SH, 0.03)
    b.rect([x, ty0 + 0.32, fz + 0.006], X, Y, BAY_W - 0.14, 0.42, SHd, 0.03)
    b.line([x - 0.06, ty0 + 0.5, fz + 0.008], [x + 0.06, ty0 + 0.5, fz + 0.008], SH)
    for (let k = 0; k < 9; k++) {
      const y = ty0 + 0.7 + k * 0.1
      b.line([x - BAY_W / 2 + 0.07, y, fz + 0.005], [x + BAY_W / 2 - 0.07, y, fz + 0.005], MESHd)
    }
    // the tray body back into the box
    b.box([x - BAY_W / 2 + 0.03, ty0 + 0.04, DFZ - tdepth], [x + BAY_W / 2 - 0.03, ty1 - 0.04, DFZ - 0.06], { layer: 'shell', w: 0.4 })
    // the SSD (100 x 70 x 7 mm), screwed to the tray floor on its side
    const sz1 = DFZ - 0.35, sz0 = sz1 - 1.39
    const sy0 = ty0 + 0.24, sy1 = sy0 + 0.97
    const SSD = hot('disk.das', 0.9)
    b.box([x - 0.05, sy0, sz0], [x + 0.05, sy1, sz1], SSD)
    b.rect([x + 0.052, (sy0 + sy1) / 2, (sz0 + sz1) / 2], Z, Y, 1.1, 0.7, hot('disk.das', 0.45), 0.04)
    b.line([x + 0.054, sy1 - 0.2, sz1 - 0.2], [x + 0.054, sy1 - 0.2, sz1 - 0.65], hot('disk.das', 0.55))
    for (const zz of [sz0 + 0.2, sz1 - 0.2]) for (const yy of [sy0 + 0.08, sy1 - 0.08]) b.circle([x + 0.053, yy, zz], Z, Y, 0.022, 6, hot('disk.das', 0.4))
    // SATA connector into the backplane
    b.box([x - 0.04, sy0 + 0.1, DFZ - tdepth - 0.08], [x + 0.04, sy0 + 0.5, sz0], hot('disk.das', 0.5))
  }
  // backplane, USB bridge board, power board
  const bpz = DFZ - 2.3
  b.rect([DX, DY0 + 1.05, bpz], X, Y, DW - 0.2, 1.7, hot('disk.das', 0.45), 0.05)
  for (let i = 0; i < 4; i++) b.rect([DX - DW / 2 + 0.13 + BAY_W * (i + 0.5), DY0 + 0.65, bpz - 0.004], X, Y, 0.08, 0.42, hot('disk.das', 0.6))
  b.box([DX - 0.75, DY0 + 0.1, bpz - 0.45], [DX + 0.35, DY0 + 0.16, bpz - 0.05], hot('board', 0.55))
  b.rect([DX - 0.2, DY0 + 0.162, bpz - 0.25], X, Z, 0.28, 0.2, hot('board', 0.7), 0.02)
  // rear fan, USB-C port, power jack
  const rz = DZ - DD / 2
  b.fan([DX - 0.15, DY0 + 1.35, rz + 0.08], X, Y, 1.25, { frame: SHd, ring: hot('fans.das', 0.8), blade: hot('fans.das', 0.6), blades: 7, depth: 0.16, speed: 0.8, group: 'fans.das', grill: MESHd })
  b.roundRect([DX + 0.62, DY0 + 0.45, rz - 0.004], X, Y, 0.12, 0.06, 0.025, FG, 3)
  b.circle([DX + 0.62, DY0 + 0.25, rz - 0.004], X, Y, 0.05, 10, FG)
}

export function odinRig(): Model {
  const b = new Builder()
  spectre(b)
  enclosure(b)

  // USB cable: out of the enclosure's rear, around its corner on the floor, into the laptop's left side
  b.tube([DX + 0.62, DY0 + 0.45, DZ - DD / 2 - 0.02], [DX + 0.62, 0.03, DZ - DD / 2 - 0.6], [-1.75, 0.03, -1.6], P(-W / 2 - 0.004, -0.95, 0.115), 0.025, Y, 22, SH)
  b.box(P(-W / 2 - 0.2, -0.99, 0.09), P(-W / 2 - 0.004, -0.91, 0.14), FG)

  // USB gigabit ethernet dongle in the right side, its cable trailing back
  {
    const x0 = W / 2 + 0.004, z = -0.35, y = 0.115
    b.box(P(x0, z - 0.06, y - 0.025), P(x0 + 0.16, z + 0.06, y + 0.025), SH)
    b.box(P(x0 + 0.16, z - 0.15, y - 0.06), P(x0 + 0.82, z + 0.15, y + 0.06), FG)
    b.rect(P(x0 + 0.822, z, y), Z, Y, 0.18, 0.09, SH, 0.01)
    b.rect(P(x0 + 0.5, z, y + 0.062), X, Z, 0.2, 0.03, ACC)
    b.tube(P(x0 + 0.84, z, y), P(x0 + 1.35, z, 0.05), P(x0 + 1.25, Z0 - 0.2, 0.03), P(x0 + 0.9, Z0 - 1.4, 0.03), 0.02, Y, 16, SHd)
  }

  // ---------- hotspots ----------
  b.hotspot('cpu', P(0.15, -0.67, 0.18), 'Processor')
  b.hotspot('mem', P(0.86, -0.48, 0.13), 'Memory')
  b.hotspot('disk', P(-1.25, 0, 0.12), 'NVMe')
  b.hotspot('raid', [DX, DY0 + DH + 0.02, DZ + 0.4], 'RAID array')

  return b.model()
}

/** Unused since beams and airflow went off; kept so every model has its FX. */
export const ODIN_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [{ from: lid(0, 1.85, LID_T / 2 + 0.05), dir: [0, -0.5, 1], spread: 36, length: 8.5, intensity: 0.3 }],
  flow: [
    { from: [LX - 1.8, 0.03, Z1 + 2.4], to: [LX - 1.9, 2.4, Z0 - 3.2], via: [LX - 1.8, 0.12, Z0 + 0.1], speed: 1.9, spread: 0.3, lanes: 6 },
    { from: [DX, DY0 + 1.2, DFZ + 2.2], to: [DX, DY0 + 1.4, DZ - DD / 2 - 3.0], via: [DX, DY0 + 1.2, DZ], speed: 1.6, spread: 0.5, lanes: 6 },
  ],
}
