// thor in x-ray, rebuilt from Brendon's photos (2026-10-18): a black mid tower
// with panoramic glass, about 460 x 230 x 506 mm (one unit ~100 mm). Front
// faces +z, the glass side is +x (the side every pose looks at), the
// motherboard hangs on the -x side. Floor at y = 0. The real case has its glass
// on the left, so the model is its mirror image: every part keeps its place
// front to back and top to bottom.
//
// From the photos: front and side glass meet at the front corner with no
// pillar; three lit intake fans stand in a column at the front edge, facing the
// glass (they pull through a vent in the solid side); the top is a Y-pattern
// perforated panel over the three fans of a 360 radiator; a solid strip runs
// along the top's far edge with the front I/O (power button at the front end)
// and the LEGO New York City skyline standing on it, a small light among the
// towers; the GPU lies horizontal with its lit logo on the glass side; the
// board shows a big I/O cover, the AIO pump head and two memory sticks; the PSU
// shroud has a perforated top and the floor in front of it is open mesh. At the
// rear: a handle slot, a LINK label, the I/O plate, a Y-pattern vent over the
// lit exhaust fan, seven slot covers and the PSU.
//
// Groups: cpu (pump head, cold plate, hoses, radiator, VRM fins), mem (the two
// sticks), gpu (card, its fans, logo), disk (M.2 drives under the board's heat
// sinks), fans (intake, radiator and exhaust fans), psu (PSU, cables), board.

import type { Model, Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

/** case half width (x) and half depth (z), feet height, top */
const HX = 1.15, HZ = 2.3, Y0 = 0.16, Y1 = 5.06
const CY = (Y0 + Y1) / 2
/** top panel thickness */
const TT = 0.06
/** motherboard plane and outline (ATX, 305 x 244 mm) */
const XB = -0.65
const BZ0 = -2.12, BZ1 = 0.32, BY0 = 1.27, BY1 = 4.32
/** CPU socket center on the board */
const CPU_Z = -1.1, CPU_Y = 3.38
/** PSU shroud: front face z, top y */
const SZ = 0.55, SY = 1.22
/** GPU body, horizontal: PCB edge at the board, the glass-facing edge, thickness (y), length (z) */
const GX0 = XB + 0.06, GX1 = 0.79, GY0 = 2.0, GY1 = 2.64, GZ0 = -2.2, GZ1 = 1.02
/** the column of intake fans facing the glass: center plane x, column z, each fan's y */
const FAN_X = XB + 0.13, FAN_Z = 1.66, FAN_YS = [1.52, 2.72, 3.92]
/** radiator under the top: fans right under the panel, core below them */
const RX0 = -0.32, RX1 = 0.88, RAD_Y0 = 4.49, RAD_Y1 = 4.76, RZ0 = -1.95, RZ1 = 1.69
const TOP_FAN_ZS = [-1.33, -0.13, 1.07]
const TOP_FAN_Y = 4.885
/** rear exhaust fan center */
const EXH: Vec3 = [0.42, 3.65, -HZ + 0.17]
/** the skyline's base on the top strip: center x, depth (x), ends (z) */
const SKX = -HX + 0.25, SKD = 0.4, SKZ0 = -2.12, SKZ1 = 0.3
/** the skyline's heights against its footprint */
const SKY_H = 0.8

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const SHf: Style = { layer: 'shell', w: 0.35 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const GLASS: Style = { layer: 'mesh', w: 0.7 }
/** the Y-pattern perforation where the photos show it best (top panel, rear vent): a touch above mesh */
const PERF: Style = { layer: 'shell', w: 0.32 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** A point on the board plane at (z, y), `lift` toward the glass. */
const onBoard = (z: number, y: number, lift = 0): Vec3 => [XB + lift, y, z]

/**
 * The case's Y-pattern perforation: tri-star holes on a staggered lattice,
 * pointing up and down on alternate rows, inside a w x h rectangle centered at
 * c in the (u, v) plane.
 */
function ymesh(b: Builder, c: Vec3, u: Vec3, v: Vec3, w: number, h: number, pitch: number, st: Style) {
  const r = pitch * 0.34
  const row = pitch * 0.62
  const ny = Math.floor((h / 2 - r) / row)
  for (let j = -ny; j <= ny; j++) {
    const odd = ((j % 2) + 2) % 2 === 1
    const y = j * row
    const a0 = odd ? -Math.PI / 2 : Math.PI / 2
    const off = odd ? pitch / 2 : 0
    const nx = Math.floor((w / 2 - r - off) / pitch)
    for (let i = -nx - (odd ? 1 : 0); i <= nx; i++) {
      const x = i * pitch + off
      if (Math.abs(x) > w / 2 - r) continue
      const o = Builder.at(c, u, v, x, y)
      for (let k = 0; k < 3; k++) {
        const a = a0 + (k * Math.PI * 2) / 3
        b.line(o, Builder.at(c, u, v, x + Math.cos(a) * r, y + Math.sin(a) * r), st)
      }
    }
  }
}

/** Stroke letters (L, I, N, K) in a unit cell: x along the reading direction (0..0.6), y up (0..1). */
const LETTERS: Record<string, [number, number][][]> = {
  L: [[[0, 1], [0, 0], [0.6, 0]]],
  I: [[[0.3, 0], [0.3, 1]]],
  N: [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
  K: [[[0, 0], [0, 1]], [[0.6, 1], [0.05, 0.42]], [[0.2, 0.58], [0.6, 0]]],
}

function text(b: Builder, s: string, origin: Vec3, read: Vec3, up: Vec3, size: number, st: Style) {
  let pen = 0
  for (const ch of s) {
    for (const stroke of LETTERS[ch] ?? []) {
      b.poly(stroke.map(([x, y]) => Builder.at(origin, read, up, (pen + x) * size, y * size)), false, st)
    }
    pen += 0.95
  }
}

// ---------- case ----------

function shell(b: Builder) {
  const yu = Y1 - TT
  // top panel: bright rim, its thickness, corner posts down to the frame
  b.rect([0, Y1, 0], X, Z, 2 * HX, 2 * HZ, FG, 0.02)
  b.rect([0, yu, 0], X, Z, 2 * HX, 2 * HZ, SHd)
  // bottom frame
  b.rect([0, Y0, 0], X, Z, 2 * HX, 2 * HZ, SH)
  // vertical edges: frame posts on three corners; the front glass corner is
  // only the seam where the two panes meet (no pillar)
  b.lineN([-HX, Y0, -HZ], [-HX, Y1, -HZ], 3, SH)
  b.lineN([-HX, Y0, HZ], [-HX, Y1, HZ], 3, SH)
  b.lineN([HX, Y0, -HZ], [HX, Y1, -HZ], 3, SH)
  b.lineN([HX, Y0, HZ], [HX, yu, HZ], 4, GLASS)

  // side glass (+x): edge, dark print bands along the top and bottom, glass face
  const gx = HX + 0.004
  b.lineN([gx, yu - 0.02, -HZ + 0.07], [gx, yu - 0.02, HZ], 4, SHd)
  b.lineN([gx, Y0 + 0.03, -HZ + 0.07], [gx, Y0 + 0.03, HZ], 4, SHd)
  b.line([gx, Y0 + 0.03, -HZ + 0.07], [gx, yu - 0.02, -HZ + 0.07], SHd)
  b.lineN([gx, yu - 0.26, -HZ + 0.07], [gx, yu - 0.26, HZ], 4, MESHd)
  b.lineN([gx, Y0 + 0.2, -HZ + 0.07], [gx, Y0 + 0.2, HZ], 4, MESHd)
  b.face([[gx, Y0 + 0.03, -HZ + 0.07], [gx, Y0 + 0.03, HZ], [gx, yu - 0.02, HZ], [gx, yu - 0.02, -HZ + 0.07]], 'fg', 1)

  // front glass (+z): the same bands, meeting the side pane at the seam
  const fz = HZ + 0.004
  b.lineN([-HX + 0.06, yu - 0.02, fz], [HX, yu - 0.02, fz], 2, SHd)
  b.lineN([-HX + 0.06, Y0 + 0.03, fz], [HX, Y0 + 0.03, fz], 2, SHd)
  b.line([-HX + 0.06, Y0 + 0.03, fz], [-HX + 0.06, yu - 0.02, fz], SHd)
  b.lineN([-HX + 0.06, yu - 0.26, fz], [HX, yu - 0.26, fz], 2, MESHd)
  b.lineN([-HX + 0.06, Y0 + 0.2, fz], [HX, Y0 + 0.2, fz], 2, MESHd)
  b.face([[-HX + 0.06, Y0 + 0.03, fz], [HX, Y0 + 0.03, fz], [HX, yu - 0.02, fz], [-HX + 0.06, yu - 0.02, fz]], 'fg', 0.8)

  // solid side (-x): inset edge and the Y-pattern vent the intake fans pull through
  const sx = -HX - 0.004
  b.rect([sx, CY, 0], Z, Y, 2 * HZ - 0.16, Y1 - Y0 - 0.2, SHf, 0.04)
  b.roundRect([sx, FAN_YS[1], FAN_Z], Z, Y, 1.3, 3.72, 0.06, SHd, 2)
  ymesh(b, [sx, FAN_YS[1], FAN_Z], Z, Y, 1.22, 3.62, 0.17, { layer: 'mesh', w: 0.7 })
  b.face([[-HX, Y0 + 0.1, -HZ + 0.1], [-HX, Y0 + 0.1, HZ - 0.1], [-HX, yu - 0.1, HZ - 0.1], [-HX, yu - 0.1, -HZ + 0.1]], 'fg', 0.35)

  // top: a solid strip along the far edge (front I/O, the skyline), the mesh field over the radiator fans
  const yt = Y1 + 0.004
  const mx0 = -HX + 0.32, mx1 = HX - 0.1, mz = HZ - 0.12
  b.roundRect([(mx0 + mx1) / 2, yt, 0], X, Z, mx1 - mx0, 2 * mz, 0.05, SHd, 2)
  ymesh(b, [(mx0 + mx1) / 2, yt, 0], Z, X, 2 * mz - 0.06, mx1 - mx0 - 0.06, 0.17, PERF)
  b.face([[-HX + 0.04, Y1, -HZ + 0.04], [HX - 0.04, Y1, -HZ + 0.04], [HX - 0.04, Y1, HZ - 0.04], [-HX + 0.04, Y1, HZ - 0.04]], 'fg', 0.3)
  // front I/O on the strip, rear to front: LED button, audio, USB-C, USB-A, then the lit power button
  const ix = -HX + 0.16
  b.rect([ix, yt, 0.82], X, Z, 0.07, 0.07, SH)
  b.circle([ix, yt, 0.98], X, Z, 0.03, 8, SH)
  b.roundRect([ix, yt, 1.14], X, Z, 0.04, 0.1, 0.018, SH, 2)
  b.rect([ix, yt, 1.32], X, Z, 0.055, 0.13, SH)
  b.rect([ix, yt, 1.6], X, Z, 0.17, 0.17, SHd, 0.02)
  b.circle([ix, yt + 0.002, 1.6], X, Z, 0.055, 16, FG)
  b.line([ix, yt + 0.002, 1.6 - 0.035], [ix, yt + 0.002, 1.6 + 0.005], FG)

  // feet
  for (const sxn of [-1, 1]) for (const szn of [-1, 1]) {
    b.box([sxn * 0.95 - 0.16, 0, szn * 2.0 - 0.22], [sxn * 0.95 + 0.16, Y0, szn * 2.0 + 0.22], SHd)
  }

  // floor in front of the shroud: open mesh under the intake column
  ymesh(b, [0.2, Y0 + 0.03, 1.42], Z, X, 1.5, 1.7, 0.17, { layer: 'mesh', w: 0.5 })
}

function rear(b: Builder) {
  const z = -HZ - 0.004
  b.face([[-HX + 0.06, Y0 + 0.06, -HZ], [HX - 0.06, Y0 + 0.06, -HZ], [HX - 0.06, Y1 - TT - 0.04, -HZ], [-HX + 0.06, Y1 - TT - 0.04, -HZ]], 'fg', 0.3)
  // handle slot under the top edge
  b.roundRect([-0.1, 4.79, z], X, Y, 1.1, 0.07, 0.035, SH, 3)
  // LINK label up the far corner, reading upward from behind (the letters are not mirrored with the case)
  b.roundRect([-0.9, 4.32, z], X, Y, 0.17, 0.62, 0.06, SHd, 3)
  text(b, 'LINK', [-0.95, 4.32 - 0.21, z - 0.002], Y, X, 0.1, SHd)

  // I/O plate on the board's rear edge: antennas, port rows, audio
  const ioX = XB + 0.23
  b.rect([ioX, 3.51, z], X, Y, 0.42, 1.58, SH, 0.02)
  for (const x of [-0.08, 0.08]) b.circle([ioX + x, 4.13, z - 0.003], X, Y, 0.03, 8, SHd)
  for (let k = 0; k < 7; k++) for (const x of [-0.09, 0.09]) b.rect([ioX + x, 3.92 - k * 0.13, z - 0.003], X, Y, 0.14, 0.055, SHd)
  for (const x of [-0.1, 0, 0.1]) b.circle([ioX + x, 2.88, z - 0.003], X, Y, 0.028, 8, SHd)

  // exhaust vent: Y pattern over the fan, height-adjust slots on both sides
  b.roundRect([EXH[0], EXH[1], z], X, Y, 1.04, 1.36, 0.06, SHd, 2)
  ymesh(b, [EXH[0], EXH[1], z], X, Y, 0.98, 1.3, 0.14, PERF)
  for (const x of [EXH[0] - 0.6, EXH[0] + 0.6]) for (const y of [EXH[1] - 0.4, EXH[1] + 0.35]) b.roundRect([x, y, z], X, Y, 0.05, 0.3, 0.025, SHd, 2)

  // seven slot covers; the GPU's bracket fills the top three
  const slot = (k: number) => 2.6 - k * 0.2032
  b.rect([0.06, (slot(0) + slot(2)) / 2, z - 0.002], X, Y, 1.12, 0.6, hot('gpu', 0.8), 0.02)
  for (let i = 0; i < 4; i++) b.roundRect([-0.33 + i * 0.22, slot(1) + 0.02, z - 0.004], X, Y, 0.16, 0.07, 0.015, hot('gpu', 0.6), 2)
  for (let i = 0; i < 6; i++) b.line([-0.4 + i * 0.12, slot(2) - 0.06, z - 0.004], [-0.4 + i * 0.12, slot(2) + 0.05, z - 0.004], hot('gpu', 0.35))
  for (let k = 3; k < 7; k++) {
    b.rect([0.06, slot(k), z], X, Y, 1.12, 0.15, SHd)
    b.line([-0.3, slot(k), z - 0.003], [0.42, slot(k), z - 0.003], SHf)
  }
  // Y-pattern strip beside the slots
  b.roundRect([0.86, 1.98, z], X, Y, 0.26, 1.36, 0.04, SHd, 2)
  ymesh(b, [0.86, 1.98, z], X, Y, 0.22, 1.3, 0.11, MESH)

  // PSU: inlet, switch, fan grille
  b.rect([0.15, 0.67, z], X, Y, 1.5, 0.86, SH, 0.03)
  b.roundRect([-0.36, 0.78, z - 0.003], X, Y, 0.2, 0.15, 0.03, hot('psu', 0.6), 2)
  b.rect([-0.12, 0.78, z - 0.003], X, Y, 0.07, 0.12, hot('psu', 0.6))
  for (let y = 0.36; y < 1.0; y += 0.06) b.line([0.06, y, z - 0.003], [0.82, y, z - 0.003], hot('psu', 0.3))
}

// ---------- the LEGO New York City skyline ----------

type Tier = [w: number, d: number, top: number]

/** A stepped tower: each tier a box from the last tier's top to its own, centered at (x, z). */
function stepped(b: Builder, x: number, z: number, y0: number, tiers: Tier[], st: Style) {
  let y = y0
  tiers.forEach(([w, d, top], i) => {
    b.box([x - d / 2, y, z - w / 2], [x + d / 2, y0 + top, z + w / 2], st, { bottom: i > 0 })
    y = y0 + top
  })
}

function skyline(b: Builder) {
  const from = b.segs.length
  towers(b)
  // the set stands about 0.4 of the case's height; drawn at 0.8 of that so the hero's fit keeps the case large
  const yb = Y1 + 0.094
  const squash = (p: Vec3): Vec3 => (p[1] > yb ? [p[0], yb + (p[1] - yb) * SKY_H, p[2]] : p)
  for (let i = from; i < b.segs.length; i++) {
    const s = b.segs[i]
    s.a = squash(s.a)
    s.b = squash(s.b)
  }
}

function towers(b: Builder) {
  const SK: Style = { layer: 'shell', w: 0.95 }
  const SKd: Style = { layer: 'shell', w: 0.5 }
  const y0 = Y1 + 0.004
  const base = 0.09
  const yb = y0 + base
  const xf = SKX + SKD / 2
  const at = (t: number) => SKZ0 + (SKZ1 - SKZ0) * t
  // base plate, its nameplate tile on the glass-facing side
  b.box([SKX - SKD / 2, y0, SKZ0], [xf, yb, SKZ1], SK)
  b.rect([xf + 0.003, y0 + base / 2, at(0.62)], Z, Y, 0.62, 0.045, SKd)

  // Statue of Liberty on its star-shaped fort
  {
    const z = at(0.07), x = SKX + 0.04
    const star: Vec3[] = []
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      const r = k % 2 ? 0.075 : 0.13
      star.push([x + Math.cos(a) * r, yb + 0.03, z + Math.sin(a) * r])
    }
    b.poly(star, true, SKd)
    stepped(b, x, z, yb + 0.03, [[0.09, 0.09, 0.12], [0.06, 0.06, 0.24]], SKd)
    b.lineN([x, yb + 0.27, z], [x, yb + 0.46, z], 2, SK)
    b.line([x, yb + 0.4, z], [x + 0.01, yb + 0.55, z - 0.04], SK)
    b.circle([x, yb + 0.46, z], Z, Y, 0.022, 6, SKd)
  }
  // Empire State Building: podium, shaft with its pilasters, setbacks, mast and antenna
  {
    const z = at(0.27), x = SKX
    stepped(b, x, z, yb, [[0.38, 0.3, 0.18], [0.3, 0.24, 0.3], [0.22, 0.18, 1.12], [0.17, 0.14, 1.22], [0.12, 0.1, 1.3], [0.075, 0.07, 1.36], [0.04, 0.04, 1.5]], SK)
    for (const dz of [-0.06, 0, 0.06]) b.lineN([x + 0.091, yb + 0.32, z + dz], [x + 0.091, yb + 1.1, z + dz], 3, SKd)
    b.line([x, yb + 1.5, z], [x, yb + 1.76, z], SK)
  }
  // Chrysler Building: shaft, the stepped crown with its arches, spire
  {
    const z = at(0.5), x = SKX
    stepped(b, x, z, yb, [[0.28, 0.24, 0.16], [0.21, 0.19, 0.92], [0.16, 0.15, 1.0], [0.12, 0.11, 1.07], [0.085, 0.08, 1.13], [0.05, 0.05, 1.18]], SK)
    for (const [w, top] of [[0.21, 0.92], [0.16, 1.0], [0.12, 1.07], [0.085, 1.13]] as const) {
      b.circle([x + 0.1, yb + top - 0.005, z], Z, Y, w / 2 - 0.01, 10, SKd, 0, Math.PI)
    }
    for (const dz of [-0.05, 0.05]) b.lineN([x + 0.096, yb + 0.2, z + dz], [x + 0.096, yb + 0.88, z + dz], 2, SKd)
    b.line([x, yb + 1.18, z], [x, yb + 1.42, z], SK)
  }
  // Flatiron: a wedge pointing at the glass
  {
    const z = at(0.68), x = SKX, h = 0.6
    const foot: [number, number][] = [[x - 0.12, z - 0.1], [x + 0.13, z], [x - 0.12, z + 0.1]]
    b.poly(foot.map(([fx, fz]) => [fx, yb, fz] as Vec3), true, SKd)
    b.poly(foot.map(([fx, fz]) => [fx, yb + h, fz] as Vec3), true, SK)
    for (const [fx, fz] of foot) b.line([fx, yb, fz], [fx, yb + h, fz], SK)
    for (const t of [0.3, 0.55, 0.8]) b.poly(foot.map(([fx, fz]) => [fx, yb + h * t, fz] as Vec3), true, SHf)
  }
  // the small light among the towers, shining up: the one lit part
  {
    const z = at(0.79), x = SKX + 0.06
    b.box([x - 0.04, yb, z - 0.04], [x + 0.04, yb + 0.05, z + 0.04], SKd)
    b.rect([x + 0.042, yb + 0.12, z], Z, Y, 0.035, 0.14, FG)
    b.line([x + 0.042, yb + 0.07, z], [x + 0.042, yb + 0.17, z], FGd)
  }
  // One World Trade Center: podium, eight triangular facets between a square base and a square top turned 45 degrees, spire
  {
    const z = at(0.91), x = SKX
    const pod = 0.2, a = 0.11, top = 1.62, t = 0.8
    b.box([x - 0.13, yb, z - 0.13], [x + 0.13, yb + pod, z + 0.13], SK)
    const y0t = yb + pod, y1t = yb + top
    const lo: Vec3[] = [[x - a, y0t, z - a], [x + a, y0t, z - a], [x + a, y0t, z + a], [x - a, y0t, z + a]]
    const hi: Vec3[] = [[x, y1t, z - a * t], [x + a * t, y1t, z], [x, y1t, z + a * t], [x - a * t, y1t, z]]
    b.poly(lo, true, SK)
    b.poly(hi, true, SK)
    for (let k = 0; k < 4; k++) {
      b.lineN(lo[k], hi[k], 3, SK)
      b.lineN(lo[k], hi[(k + 3) % 4], 3, SK)
    }
    b.box([x - 0.035, y1t, z - 0.035], [x + 0.035, y1t + 0.05, z + 0.035], SKd, { bottom: true })
    b.lineN([x, y1t + 0.05, z], [x, y1t + 0.42, z], 2, SK)
  }
}

// ---------- inside ----------

function board(b: Builder) {
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.36)
  b.rect(onBoard((BZ0 + BZ1) / 2, (BY0 + BY1) / 2), Z, Y, BZ1 - BZ0, BY1 - BY0, BRD, 0.03)
  for (const [z, y] of [[BZ0 + 0.1, BY1 - 0.1], [BZ0 + 0.1, 2.1], [BZ0 + 0.1, BY0 + 0.15], [-0.85, BY1 - 0.1], [-0.85, BY0 + 0.15], [BZ1 - 0.1, BY1 - 0.1], [BZ1 - 0.1, 2.6], [BZ1 - 0.1, BY0 + 0.15]]) {
    b.circle(onBoard(z, y, 0.004), Z, Y, 0.035, 8, BRD)
  }
  // a few trace bundles: socket to memory, socket down to the slots, chipset fan-out
  const map = (z: number, y: number) => onBoard(z, y, 0.005)
  b.traces(map, [[-0.75, 3.6], [-0.62, 3.6], [-0.56, 3.5], [-0.52, 3.5]], 6, 0.035, BRDd)
  b.traces(map, [[-1.3, 2.98], [-1.3, 2.86], [-1.45, 2.76], [-1.7, 2.76]], 5, 0.035, BRDd)
  b.traces(map, [[-0.25, 1.95], [-0.5, 1.95], [-0.7, 2.1], [-1.9, 2.1]], 5, 0.03, BRDd)
  b.traces(map, [[0.1, 2.0], [0.1, 1.5], [-0.15, 1.38], [-1.6, 1.38]], 4, 0.03, BRDd)
  // socket keep-out
  b.rect(onBoard(CPU_Z, CPU_Y, 0.004), Z, Y, 0.86, 0.86, BRDd, 0.02)

  // the I/O cover over the rear edge: a tall block with a slanted foot and vertical slats
  {
    const x1 = XB + 0.42, z0 = BZ0, z1 = -1.62, y0 = 3.12, y1 = BY1 - 0.03
    const prof = (x: number, st: Style) => b.poly([[x, y0 + 0.14, z0], [x, y1, z0], [x, y1, z1], [x, y0 + 0.3, z1], [x, y0, z1 - 0.16], [x, y0, z0 + 0.06]], true, st)
    prof(x1, hot('board', 0.7))
    prof(XB + 0.01, BRDd)
    for (const [y, zz] of [[y1, z0], [y1, z1], [y0 + 0.3, z1], [y0, z1 - 0.16], [y0, z0 + 0.06]]) b.line([XB + 0.01, y, zz], [x1, y, zz], BRDd)
    for (let zz = z0 + 0.07; zz < z1 - 0.03; zz += 0.07) b.line([x1 + 0.003, y0 + 0.36, zz], [x1 + 0.003, y1 - 0.08, zz], hot('cpu', 0.28))
    b.rect([x1 + 0.004, y0 + 0.2, (z0 + z1) / 2 - 0.04], Z, Y, 0.26, 0.06, hot('board', 0.5))
  }
  // VRM heat sink along the top of the socket
  b.box([XB, 3.95, -1.62], [XB + 0.3, BY1 - 0.05, -0.72], hot('cpu', 0.42))
  for (let zz = -1.56; zz < -0.74; zz += 0.07) b.line([XB + 0.3, 3.97, zz], [XB + 0.3, BY1 - 0.07, zz], hot('cpu', 0.26))
  // EPS 8-pin in the top corner, 24-pin on the front edge
  b.box([XB, 4.18, -2.04], [XB + 0.12, 4.29, -1.8], hot('psu', 0.6))
  b.box([XB, 2.95, 0.18], [XB + 0.16, 3.6, 0.31], hot('psu', 0.6))
  for (let y = 3.0; y < 3.58; y += 0.05) b.line([XB + 0.16, y, 0.18], [XB + 0.16, y, 0.31], hot('psu', 0.32))
  // PCIe x16 under the GPU, the chipset heat sink below it
  b.box([XB, 2.5, -2.05], [XB + 0.06, 2.58, -1.18], BRDd)
  b.box([XB, 1.36, -0.55], [XB + 0.1, 1.9, 0.2], hot('board', 0.5))
  b.line([XB + 0.1, 1.36, -0.55], [XB + 0.1, 1.9, 0.2], BRDd)
  // DIMM slots: four, sticks in the second and fourth
  for (const z of [-0.48, -0.38, -0.28, -0.18]) b.box([XB, 2.84, z - 0.03], [XB + 0.05, 4.24, z + 0.03], BRDd)
}

function cpu(b: Builder) {
  // cold plate on the socket, the round pump head with its lit ring and logo
  const px0 = XB + 0.08, px1 = XB + 0.5, R = 0.36
  const c = (x: number): Vec3 => [x, CPU_Y, CPU_Z]
  b.rect(onBoard(CPU_Z, CPU_Y, 0.06), Z, Y, 0.62, 0.62, hot('cpu', 0.6), 0.05)
  b.circle(c(px0), Z, Y, R, 32, hot('cpu', 0.55))
  b.circle(c(px1 - 0.06), Z, Y, R, 32, hot('cpu', 0.8))
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2
    b.line([px0, CPU_Y + Math.sin(a) * R, CPU_Z + Math.cos(a) * R], [px1 - 0.06, CPU_Y + Math.sin(a) * R, CPU_Z + Math.cos(a) * R], hot('cpu', 0.4))
  }
  b.circle(c(px1), Z, Y, R - 0.04, 32, hot('cpu', 1))
  b.circle(c(px1 + 0.002), Z, Y, 0.27, 28, hot('cpu', 0.75))
  b.circle(c(px1 + 0.003), Z, Y, 0.12, 14, hot('cpu', 0.6))
  // the sails logo: three strokes fanning up from the center
  for (const [dz, dy] of [[-0.06, 0.1], [0, 0.12], [0.06, 0.1]]) b.line([px1 + 0.004, CPU_Y - 0.05, CPU_Z], [px1 + 0.004, CPU_Y - 0.05 + dy, CPU_Z + dz], hot('cpu', 1))

  // hoses: up out of the pump, forward over the memory, into the radiator's front tank
  for (let i = 0; i < 2; i++) {
    const hx = -0.31 + i * 0.13, rx = 0.02 + i * 0.22
    const pts: [Vec3, Vec3, Vec3, Vec3] = [[hx, CPU_Y + 0.3, CPU_Z + 0.12], [hx, 4.42, CPU_Z + 0.5], [rx, 4.3, RZ1 - 0.6], [rx, RAD_Y0 - 0.03, RZ1 + 0.1]]
    b.tube(...pts, 0.045, X, 14, hot('cpu', 0.5))
    b.tube(...pts, 0.045, Y, 14, hot('cpu', 0.35))
  }

  // radiator: core, end tanks, fins, fittings
  b.box([RX0, RAD_Y0, RZ0], [RX1, RAD_Y1, RZ1], hot('cpu', 0.4))
  b.box([RX0 - 0.03, RAD_Y0 - 0.02, RZ0 - 0.2], [RX1 + 0.03, RAD_Y1 + 0.01, RZ0], hot('cpu', 0.5))
  b.box([RX0 - 0.03, RAD_Y0 - 0.02, RZ1], [RX1 + 0.03, RAD_Y1 + 0.01, RZ1 + 0.2], hot('cpu', 0.5))
  for (let z = RZ0 + 0.06; z < RZ1; z += 0.06) b.line([RX0, RAD_Y0, z], [RX1, RAD_Y0, z], hot('cpu.rad', 0.18))
  for (let z = RZ0 + 0.07; z < RZ1; z += 0.07) b.line([RX1, RAD_Y0, z], [RX1, RAD_Y1, z], hot('cpu.rad', 0.22))
  for (const x of [0.02, 0.24]) b.circle([x, RAD_Y0 - 0.025, RZ1 + 0.1], X, Z, 0.055, 10, hot('cpu', 0.7))
}

function memory(b: Builder) {
  // two sticks with tall heat spreaders, the lit bar along the top edge
  for (const z of [-0.38, -0.18]) {
    const x1 = XB + 0.56
    b.box([XB + 0.05, 2.88, z - 0.035], [x1, 4.2, z + 0.035], hot('mem', 0.85))
    b.lineN([x1 + 0.003, 2.92, z], [x1 + 0.003, 4.16, z], 3, hot('mem', 1))
    for (let k = 0; k < 4; k++) b.rect([XB + 0.3, 3.05 + k * 0.3, z + 0.037], X, Y, 0.3, 0.2, hot('mem', 0.4), 0.02)
  }
}

function disks(b: Builder) {
  // the top M.2 under its heat sink, between the socket and the GPU; two more under the card
  b.box([XB, 2.72, -1.75], [XB + 0.07, 2.92, -0.62], hot('disk', 0.9))
  for (let z = -1.69; z < -0.64; z += 0.08) b.line([XB + 0.07, 2.74, z], [XB + 0.07, 2.9, z], hot('disk', 0.45))
  b.box([XB, 1.62, -1.85], [XB + 0.06, 1.8, -0.75], hot('disk', 0.55))
  b.box([XB, 1.38, -1.85], [XB + 0.06, 1.54, -0.95], hot('disk', 0.45))
}

function gpu(b: Builder) {
  const G = hot('gpu', 0.9), Gd = hot('gpu', 0.45), Gf = hot('gpu', 0.3)
  // shroud profile (z, y) on both long edges: square at the bracket, chamfered at the front end
  const prof: [number, number][] = [
    [GZ0, GY0 + 0.04], [GZ0, GY1], [GZ1 - 0.14, GY1], [GZ1, GY1 - 0.12], [GZ1, GY0 + 0.1], [GZ1 - 0.1, GY0], [GZ0 + 0.04, GY0],
  ]
  const edge = (x: number, st: Style) => b.poly(prof.map(([z, y]) => [x, y, z] as Vec3), true, st)
  edge(GX1, G)
  edge(GX0, Gd)
  for (const [z, y] of prof) b.line([GX0, y, z], [GX1, y, z], Gd)
  // the glass-facing side: angular shroud cuts, the GEFORCE RTX plate, the lit logo and its Z
  const sx = GX1 + 0.003
  b.poly([[sx, GY1 - 0.1, GZ0 + 0.3], [sx, GY1 - 0.1, -0.9], [sx, GY1 - 0.24, -0.62], [sx, GY1 - 0.24, 0.55], [sx, GY1 - 0.1, 0.75]], false, G)
  b.roundRect([sx, GY0 + 0.15, -1.3], Z, Y, 1.1, 0.1, 0.03, Gd, 2)
  b.roundRect([sx + 0.002, GY0 + 0.14, 0.38], Z, Y, 0.72, 0.1, 0.03, FG, 2)
  b.line([sx + 0.002, GY0 + 0.14, 0.08], [sx + 0.002, GY0 + 0.14, 0.68], FGd)
  b.poly([[sx + 0.002, GY0 + 0.22, 0.82], [sx + 0.002, GY0 + 0.22, 0.94], [sx + 0.002, GY0 + 0.07, 0.82], [sx + 0.002, GY0 + 0.07, 0.94]], false, FG)
  // fin stack through the shroud, seen at the front end
  for (let x = GX0 + 0.06; x < GX1 - 0.03; x += 0.05) b.line([x, GY0 + 0.06, GZ1 + 0.002], [x, GY1 - 0.15, GZ1 + 0.002], Gf)
  b.rect([(GX0 + GX1) / 2, GY1 - 0.07, GZ1 - 0.06], X, Y, 0.7, 0.05, Gd)
  // backplate on top with its angular cutouts
  const by = GY1 + 0.004
  b.rect([(GX0 + GX1) / 2, by, (GZ0 + GZ1) / 2], X, Z, GX1 - GX0 - 0.08, GZ1 - GZ0 - 0.1, Gd, 0.05)
  b.poly([[0.5, by, -1.85], [0.1, by, -1.45], [0.5, by, -1.05], [0.1, by, -0.65]], false, Gf)
  b.poly([[-0.35, by, -0.3], [0.45, by, -0.3], [-0.35, by, 0.55], [0.45, by, 0.55]], false, Gf)
  // three fans underneath, blowing down
  for (const z of [-1.62, -0.58, 0.46]) {
    b.fan([(GX0 + GX1) / 2, GY0 - 0.02, z], X, Z, 1.0, { frame: Gd, ring: G, blade: hot('gpu', 0.7), blades: 9, depth: 0.08, speed: 0.7, group: 'gpu', bare: true })
  }
  // power connector on the glass-facing edge, its cable down into the shroud
  b.box([GX1, 2.24, -0.08], [GX1 + 0.08, 2.42, 0.14], G)
  for (let i = 0; i < 4; i++) {
    const o = i * 0.045
    b.curve([GX1 + 0.08, 2.27 + o * 0.7, -0.06 + o], [GX1 + 0.28, 2.3, 0.0 + o], [0.85, 1.55, 0.25 + o], [0.62, SY, 0.28 + o * 0.6], 12, hot('psu', 0.45))
  }
}

function intake(b: Builder) {
  // three lit fans in a column at the front edge, facing the glass, on a bracket beside the board
  for (const y of FAN_YS) {
    b.fan([FAN_X, y, FAN_Z], Y, Z, 1.2, { frame: SHd, ring: hot('fans', 0.8), blade: hot('fans', 0.9), blades: 9, depth: 0.25, speed: 0.8 })
  }
  for (const z of [FAN_Z - 0.62, FAN_Z + 0.62]) b.lineN([XB, FAN_YS[0] - 0.62, z], [XB, FAN_YS[2] + 0.62, z], 3, SHd)
  // tray cutouts between the board and the fans, the 24-pin's cables into one
  for (const y of [1.85, 2.9, 3.95]) b.roundRect([XB - 0.004, y, 0.66], Z, Y, 0.18, 0.55, 0.08, SHd, 3)
  for (let i = 0; i < 5; i++) {
    const o = i * 0.1
    b.curve([XB + 0.16, 3.05 + o, 0.31], [XB + 0.32, 3.05 + o, 0.42], [XB + 0.2, 2.95 + o * 0.4, 0.6], [XB, 2.95 + o * 0.4, 0.66], 6, hot('psu', 0.4))
  }

  // radiator fans right under the top mesh, blowing up
  for (const z of TOP_FAN_ZS) {
    b.fan([(RX0 + RX1) / 2, TOP_FAN_Y, z], Z, X, 1.2, { frame: SHd, ring: hot('fans', 0.7), blade: hot('fans', 0.65), blades: 9, depth: 0.25, speed: 0.9 })
  }
  // lit exhaust fan behind the rear vent
  b.fan(EXH, Y, X, 1.2, { frame: SHd, ring: hot('fans', 0.8), blade: hot('fans', 0.7), blades: 9, depth: 0.25, speed: 0.9 })
}

function psu(b: Builder) {
  // shroud (part of the case): a box over the rear of the floor, perforated top, cable cutout
  b.box([-HX + 0.02, Y0, -HZ + 0.02], [HX - 0.04, SY, SZ], { layer: 'shell', w: 0.75 }, { bottom: true })
  b.roundRect([0.25, SY + 0.003, -1.03], Z, X, 2.18, 1.42, 0.05, SHd, 2)
  ymesh(b, [0.25, SY + 0.003, -1.03], Z, X, 2.1, 1.34, 0.15, MESH)
  b.roundRect([0.6, SY + 0.003, 0.32], X, Z, 0.36, 0.26, 0.05, SHd, 2)
  b.rect([0, (Y0 + SY) / 2, SZ + 0.003], X, Y, 2 * HX - 0.3, SY - Y0 - 0.2, SHf, 0.04)

  // the PSU: fan down at the floor, modular sockets at its front
  const P = hot('psu', 0.8), Pd = hot('psu', 0.4)
  b.box([-0.6, 0.24, -2.27], [0.9, 1.1, -0.67], P)
  b.fan([0.15, 0.25, -1.47], X, Z, 1.2, { frame: Pd, ring: P, blade: hot('psu', 0.6), blades: 7, depth: 0.06, speed: 0.6, group: 'psu', bare: true })
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) b.rect([-0.35 + i * 0.32, 0.55 + j * 0.3, -0.665], X, Y, 0.22, 0.16, Pd)
  b.rect([0.903, 0.67, -1.47], Z, Y, 0.9, 0.5, Pd, 0.04)
}

export function thorTower(): Model {
  const b = new Builder()
  shell(b)
  rear(b)
  skyline(b)
  board(b)
  cpu(b)
  memory(b)
  disks(b)
  gpu(b)
  intake(b)
  psu(b)

  // each on its part, spread apart for the small heroes: the pump head, the top of the outer memory stick's lit
  // edge, the GPU's lit logo, the M.2 heat sink under the card
  b.hotspot('cpu', [XB + 0.505, CPU_Y, CPU_Z], 'CPU')
  b.hotspot('mem', [XB + 0.565, 4.1, -0.18], 'Memory')
  b.hotspot('gpu', [GX1 + 0.006, GY0 + 0.14, 0.38], 'GPU')
  b.hotspot('disk', [XB + 0.065, 1.71, -1.3], 'Disk')

  // orbit around the case itself (the skyline only adds height); radius as before, so the floor keeps its scale
  return b.model([0, CY, 0], 3.75)
}

/** Light beams and airflow for WireScene (off on every hero since 2026-10-17, kept for reference): in through the solid side, out the top and rear. */
export const TOWER_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [],
  flow: [
    { from: [-HX - 3, 2.7, FAN_Z], to: [0.3, Y1 + 2.2, -0.2], via: [0.2, 3.2, 1.2], speed: 2.4, spread: 0.7, lanes: 10 },
    { from: [-HX - 3, 2.2, FAN_Z], to: [EXH[0], EXH[1], -HZ - 3], via: [0.2, 3.0, 0], speed: 2.6, spread: 0.6, lanes: 9 },
  ],
}
