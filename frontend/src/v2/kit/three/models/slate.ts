// The slab family in x-ray: phone() (portrait) and tablet() (landscape). Both
// stand on their bottom edge just above the floor, leaning back a little, the
// screen facing +z and the camera bump on the back. Not API hosts yet: they
// are here so the hero can show them once they report in.
//
// Groups: cpu (processor), mem (memory), disk (storage), battery (cells,
// charge board, charging coil), cam (camera modules), board.

import { DEG, type Model, type Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

type P2 = [number, number]

/** Shell of a slab: glass front, frame band, back glass, the display's mesh and the glass faces. */
function slabShell(b: Builder, o: { w: number; h: number; d: number; r: number; y0: number; inset: number; displayR: number; grid: number }) {
  const cy = o.y0 + o.h / 2, hz = o.d / 2
  const c: Vec3 = [0, cy, 0]
  // frame band: both edges, the edges joining them, and a faint middle line
  b.roundSlab(c, X, Y, o.w, o.h, o.d - 0.08, o.r, SH, SH, SH, 8)
  b.roundRect(c, X, Y, o.w + 0.004, o.h + 0.004, o.r, { layer: 'mesh', w: 0.5 }, 8)
  // glass on both faces, slightly inset
  const gf = b.roundRectPts([0, cy, hz], X, Y, o.w - 0.06, o.h - 0.06, o.r - 0.03, 8)
  const gb = b.roundRectPts([0, cy, -hz], X, Y, o.w - 0.06, o.h - 0.06, o.r - 0.03, 8)
  b.poly(gf, true, FG)
  b.poly(gb, true, FGd)
  const ff = b.roundRectPts([0, cy, hz - 0.04], X, Y, o.w, o.h, o.r, 8)
  const fb = b.roundRectPts([0, cy, -hz + 0.04], X, Y, o.w, o.h, o.r, 8)
  for (let q = 0; q < 4; q++) for (const i of [0, 4, 8]) { b.line(gf[q * 9 + i], ff[q * 9 + i], SHd); b.line(gb[q * 9 + i], fb[q * 9 + i], SHd) }
  // display: active area outline, fine mesh, glass faces
  const dw = o.w - 2 * o.inset, dh = o.h - 2 * o.inset
  b.roundRect([0, cy, hz + 0.003], X, Y, dw, dh, o.displayR, SHd, 6)
  b.roundGrid([0, cy, hz + 0.004], X, Y, dw, dh, o.displayR, o.grid, { layer: 'mesh', w: 0.72 }, 4)
  b.face(b.roundRectPts([0, cy, hz], X, Y, o.w - 0.06, o.h - 0.06, o.r - 0.03, 3), 'fg', 1.1)
  b.face(b.roundRectPts([0, cy, -hz], X, Y, o.w - 0.06, o.h - 0.06, o.r - 0.03, 3), 'fg', 0.4)
}

/** A flat part: polygon outline at two depths with the edges at its corners. */
function prism(b: Builder, pts: P2[], z0: number, z1: number, front: Style, back: Style, edge: Style) {
  const f = pts.map(([x, y]): Vec3 => [x, y, z1])
  const k = pts.map(([x, y]): Vec3 => [x, y, z0])
  b.poly(f, true, front)
  b.poly(k, true, back)
  for (let i = 0; i < pts.length; i++) b.line(f[i], k[i], edge)
}

/** Chip on a board: package box, top mark, optional inner die. */
function chip(b: Builder, x0: number, y0: number, x1: number, y1: number, z: number, h: number, group: string, die = false) {
  b.box([x0, y0, z], [x1, y1, z + h], hot(group, 0.9))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, hh = y1 - y0
  b.rect([cx, cy, z + h + 0.002], X, Y, w * 0.7, hh * 0.62, hot(group, die ? 1 : 0.45), Math.min(w, hh) * 0.06)
  if (die) b.rect([cx, cy, z + h + 0.004], X, Y, w * 0.38, hh * 0.38, hot(group, 0.7), Math.min(w, hh) * 0.03)
}

/** Raised camera plateau on the back (z < 0) with its outline at both heights. */
function plateau(b: Builder, cx: number, cy: number, w: number, h: number, r: number, z0: number, z1: number) {
  const lo = b.roundRectPts([cx, cy, z0], X, Y, w, h, r, 6)
  const hi = b.roundRectPts([cx, cy, z1], X, Y, w - 0.04, h - 0.04, r - 0.02, 6)
  b.poly(lo, true, SH)
  b.poly(hi, true, FG)
  for (let q = 0; q < 4; q++) for (const i of [0, 3, 6]) b.line(lo[q * 7 + i], hi[q * 7 + i], SHd)
  b.face(b.roundRectPts([cx, cy, z1], X, Y, w - 0.04, h - 0.04, r - 0.02, 2), 'fg', 0.6)
}

/** A rear camera: ring on the plateau, raised ring, glass, aperture, and the module inside the body. */
function rearLens(b: Builder, x: number, y: number, r: number, zp: number, rise: number, zIn: number) {
  const zt = zp - rise
  b.circle([x, y, zp], X, Y, r, 32, FG)
  b.circle([x, y, zt], X, Y, r * 0.94, 32, FG)
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    b.line([x + Math.cos(a) * r, y + Math.sin(a) * r, zp], [x + Math.cos(a) * r * 0.94, y + Math.sin(a) * r * 0.94, zt], SHd)
  }
  b.circle([x, y, zt - 0.002], X, Y, r * 0.7, 24, SH)
  b.circle([x, y, zt - 0.003], X, Y, r * 0.4, 16, MESH)
  b.circle([x, y, zt - 0.004], X, Y, r * 0.17, 10, hot('cam', 0.9))
  // module in the body
  b.circle([x, y, zIn], X, Y, r * 0.82, 20, hot('cam', 0.55))
  b.rect([x, y, zIn + 0.08], X, Y, r * 1.3, r * 1.3, hot('cam', 0.45), r * 0.12)
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k / 4) * Math.PI * 2
    b.line([x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82, zIn], [x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7, zt], hot('cam', 0.3))
  }
}

// ---------------------------------------------------------------- phone

const PW = 3.6, PH = 7.4, PD = 0.4, PR = 0.6, PY0 = 0.45
const PTOP = PY0 + PH

export function phone(): Model {
  const b = new Builder()
  const hz = PD / 2
  slabShell(b, { w: PW, h: PH, d: PD, r: PR, y0: PY0, inset: 0.13, displayR: 0.5, grid: 0.1 })

  // front: island with its camera, earpiece slit
  b.roundRect([0, PTOP - 0.42, hz + 0.005], X, Y, 0.92, 0.27, 0.135, FG, 6)
  b.circle([0.3, PTOP - 0.42, hz + 0.006], X, Y, 0.065, 10, SH)
  b.circle([-0.18, PTOP - 0.42, hz + 0.006], X, Y, 0.03, 6, SHd)
  b.rect([0, PTOP - 0.16, hz + 0.004], X, Y, 0.62, 0.025, SHd)

  // side buttons: action and volume on the left, side button on the right
  for (const [y, len] of [[6.95, 0.32], [6.35, 0.6], [5.62, 0.6]] as const) b.roundRect([-PW / 2 - 0.006, y, 0], Y, Z, len, 0.13, 0.06, FG, 3)
  b.roundRect([PW / 2 + 0.006, 5.95, 0], Y, Z, 0.95, 0.13, 0.06, FG, 3)
  // antenna breaks in the frame
  for (const sx of [-1, 1]) for (const y of [7.2, 1.1]) b.line([sx * (PW / 2 + 0.004), y, -hz + 0.05], [sx * (PW / 2 + 0.004), y, hz - 0.05], SH)
  for (const x of [-1.1, 1.1]) b.line([x, PTOP + 0.004, -hz + 0.05], [x, PTOP + 0.004, hz - 0.05], SH)
  // bottom edge: port with its charge light, speaker and mic holes
  b.roundRect([0, PY0 - 0.004, 0], X, Z, 0.44, 0.14, 0.07, FG, 4)
  b.rect([0, PY0 - 0.006, 0], X, Z, 0.3, 0.035, ACC)
  for (let k = 0; k < 6; k++) {
    b.circle([0.62 + k * 0.13, PY0 - 0.004, 0], X, Z, 0.03, 6, SHd)
    b.circle([-0.62 - k * 0.13, PY0 - 0.004, 0], X, Z, 0.03, 6, k < 3 ? SHd : MESH)
  }

  // ---------- logic board (two stacked layers) ----------
  const bz = -0.03
  const board: P2[] = [[-1.45, 7.62], [-0.1, 7.62], [-0.02, 7.54], [-0.02, 5.98], [0.08, 5.88], [1.45, 5.88], [1.55, 5.78], [1.55, 5.05], [1.45, 4.95], [-1.45, 4.95], [-1.55, 5.05], [-1.55, 7.52]]
  b.path([0, 0, bz], X, Y, board, true, hot('board', 0.6))
  b.path([0, 0, bz + 0.1], X, Y, board.map(([x, y]) => [x * 0.96, 4.95 + (y - 4.95) * 0.97] as P2), true, hot('board', 0.32))
  for (const [x, y] of [[-1.4, 7.5], [-0.15, 7.5], [1.4, 5.1], [-1.4, 5.1], [0.1, 5.95]] as P2[]) {
    b.line([x, y, bz], [x * 0.96, 4.95 + (y - 4.95) * 0.97, bz + 0.1], hot('board', 0.35))
    b.circle([x, y, bz + 0.002], X, Y, 0.035, 8, hot('board', 0.55))
  }
  const T = (x: number, y: number): Vec3 => [x, y, bz + 0.003]
  const BRDd = hot('board', 0.38)
  b.traces(T, [[-0.89, 6.42], [-0.89, 6.36], [-0.96, 6.3]], 6, 0.03, BRDd)
  b.traces(T, [[-0.48, 6.8], [-0.3, 6.8], [-0.2, 6.7], [-0.2, 5.8], [0.1, 5.5], [0.3, 5.5]], 5, 0.028, BRDd)
  b.traces(T, [[-1.0, 5.98], [-1.0, 5.75], [-0.95, 5.62]], 4, 0.03, BRDd)
  b.traces(T, [[-0.25, 5.4], [0.1, 5.25], [0.3, 5.25]], 3, 0.03, BRDd)
  chip(b, -1.3, 6.42, -0.48, 7.24, bz, 0.09, 'cpu', true)
  b.rect([-0.89, 6.83, bz + 0.002], X, Y, 1.0, 1.0, BRDd, 0.05)
  chip(b, -1.32, 5.98, -0.62, 6.3, bz, 0.06, 'mem')
  chip(b, 0.3, 5.12, 1.25, 5.66, bz, 0.06, 'disk')
  chip(b, -1.3, 5.12, -0.6, 5.62, bz, 0.05, 'board')
  chip(b, -0.45, 5.1, -0.05, 5.42, bz, 0.04, 'board')
  // battery and display connectors
  b.box([0.35, 4.92, bz], [0.8, 5.04, bz + 0.05], hot('battery', 0.6))
  b.box([-0.55, 7.42, bz], [-0.15, 7.56, bz + 0.05], hot('board', 0.55))

  // ---------- battery ----------
  const BX = 1.45, BY0 = 1.1, BY1 = 4.8
  b.roundRect([0, (BY0 + BY1) / 2, 0.08], X, Y, 2 * BX, BY1 - BY0, 0.14, hot('battery', 0.9), 4)
  b.roundRect([0, (BY0 + BY1) / 2, -0.13], X, Y, 2 * BX, BY1 - BY0, 0.14, hot('battery', 0.45), 4)
  for (const [x, y] of [[-BX, BY0 + 0.1], [BX, BY0 + 0.1], [BX, BY1 - 0.1], [-BX, BY1 - 0.1]] as P2[]) b.line([x, y, 0.08], [x, y, -0.13], hot('battery', 0.45))
  b.roundRect([0, (BY0 + BY1) / 2, 0.082], X, Y, 2 * BX - 0.24, BY1 - BY0 - 0.24, 0.08, hot('battery', 0.35), 3)
  for (const x of [-0.7, 0.7]) b.poly([[x - 0.12, BY0 + 0.02, 0.083], [x - 0.12, 0.9, 0.083], [x + 0.12, 0.9, 0.083], [x + 0.12, BY0 + 0.02, 0.083]], false, hot('battery', 0.4))
  for (let y = BY0 + 0.3; y < BY1 - 0.25; y += 0.24) b.line([-BX + 0.18, y, 0.081], [BX - 0.18, y, 0.081], hot('battery', 0.2))
  b.rect([0.58, BY1 - 0.14, 0.085], X, Y, 1.1, 0.14, hot('battery', 0.6), 0.02)
  b.poly([[0.58, BY1 - 0.07, 0.087], [0.58, 4.88, 0.05], [0.58, 4.95, bz + 0.05]], false, hot('battery', 0.45))
  // wireless charging coil behind the cells, magnet ring on the back glass
  for (const r of [0.95, 0.83, 0.71, 0.59]) b.circle([0, 3.75, -0.16], X, Y, r, 36, hot('battery', 0.35))
  b.circle([0, 3.75, -hz - 0.004], X, Y, 1.0, 40, SHd)
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2
    b.line([Math.cos(a) * 0.9, 3.75 + Math.sin(a) * 0.9, -hz - 0.004], [Math.cos(a) * 1.0, 3.75 + Math.sin(a) * 1.0, -hz - 0.004], MESH)
  }
  b.rect([0, 2.5, -hz - 0.004], X, Y, 0.14, 0.42, SHd)

  // flex from the board down the right edge to the port board
  for (let i = 0; i < 3; i++) {
    const x = 1.6 - i * 0.04
    b.poly([[1.4, 5.0, bz + 0.02], [x, 4.85, 0.0], [x, 1.25, 0.0], [x - 0.15, 1.05, -0.02], [0.3, 1.05, -0.02]], false, hot('board', 0.36))
  }
  b.box([-0.42, 0.5, -0.1], [0.42, 0.62, 0.08], hot('board', 0.5))
  // haptic engine and speaker at the bottom
  b.box([-1.42, 0.62, -0.09], [-0.55, 0.98, 0.07], hot('board', 0.5))
  b.line([-1.3, 0.8, 0.07], [-0.67, 0.8, 0.07], hot('board', 0.4))
  b.box([0.55, 0.62, -0.09], [1.42, 0.98, 0.07], SHd)
  for (let x = 0.68; x < 1.4; x += 0.12) b.line([x, 0.66, 0.072], [x, 0.94, 0.072], MESHd)

  // ---------- rear camera bump ----------
  const zb = -hz
  plateau(b, 0.84, 6.83, 1.62, 1.68, 0.38, zb, zb - 0.11)
  for (const [x, y] of [[1.25, 7.25], [1.25, 6.42], [0.45, 6.84]] as P2[]) rearLens(b, x, y, 0.33, zb - 0.11, 0.06, -0.06)
  b.circle([0.45, 7.38, zb - 0.112], X, Y, 0.09, 12, ACC)
  b.circle([0.45, 7.38, zb - 0.113], X, Y, 0.045, 8, ACC)
  b.circle([0.45, 6.3, zb - 0.112], X, Y, 0.09, 12, SH)
  b.circle([0.45, 6.3, zb - 0.113], X, Y, 0.04, 8, SHd)
  b.circle([0.86, 6.84, zb - 0.112], X, Y, 0.025, 6, SHd)

  b.hotspot('cpu', [-0.89, 6.83, bz + 0.12], 'Processor')
  b.hotspot('mem', [-0.97, 6.14, bz + 0.09], 'Memory')
  b.hotspot('disk', [0.78, 5.39, bz + 0.09], 'Storage')
  b.hotspot('battery', [0, 2.95, 0.1], 'Battery')

  b.rotate([0, PY0, 0], X, -9 * DEG)
  return b.model()
}

// ---------------------------------------------------------------- tablet

const TW = 7.2, TH = 5.0, TD = 0.24, TR = 0.4, TY0 = 0.5
const TTOP = TY0 + TH, TCY = TY0 + TH / 2

export function tablet(): Model {
  const b = new Builder()
  const hz = TD / 2
  slabShell(b, { w: TW, h: TH, d: TD, r: TR, y0: TY0, inset: 0.26, displayR: 0.2, grid: 0.12 })

  // front camera in the long top bezel
  b.circle([0, TTOP - 0.13, hz + 0.004], X, Y, 0.045, 10, FG)
  b.circle([0, TTOP - 0.13, hz + 0.005], X, Y, 0.018, 6, SH)
  b.circle([0.22, TTOP - 0.13, hz + 0.004], X, Y, 0.016, 6, SHd)
  // top button, volume buttons, port with its charge light
  b.roundRect([-2.7, TTOP + 0.004, 0], X, Z, 0.55, 0.1, 0.05, FG, 3)
  for (const y of [4.75, 4.25]) b.roundRect([TW / 2 + 0.006, y, 0], Y, Z, 0.4, 0.1, 0.05, FG, 3)
  b.roundRect([TW / 2 + 0.006, TCY, 0], Y, Z, 0.44, 0.12, 0.06, FG, 4)
  b.rect([TW / 2 + 0.008, TCY, 0], Y, Z, 0.3, 0.032, ACC)
  // magnetic strip for the stylus on the top edge, connector dots on the back
  b.rect([0, TTOP + 0.004, 0], X, Z, 2.6, 0.06, SHd)
  for (const x of [-0.12, 0, 0.12]) b.circle([x, TY0 + 0.32, -hz - 0.004], X, Y, 0.03, 6, SH)
  // speaker grills on both short edges
  for (const sx of [-1, 1]) for (const yc of [1.25, 4.75]) {
    if (sx > 0 && yc > 4) continue
    for (let k = -3; k <= 3; k++) b.line([sx * (TW / 2 + 0.004), yc + k * 0.09, -0.04], [sx * (TW / 2 + 0.004), yc + k * 0.09, 0.04], SH)
  }

  // ---------- batteries left and right (the right one stepped around the camera) ----------
  const BF = 0.06, BB = -0.07
  const left: P2[] = [[-3.25, 0.95], [-0.82, 0.95], [-0.78, 1.0], [-0.78, 5.0], [-0.82, 5.05], [-3.25, 5.05], [-3.3, 5.0], [-3.3, 1.0]]
  const right: P2[] = [[0.82, 0.95], [3.25, 0.95], [3.3, 1.0], [3.3, 3.72], [3.25, 3.77], [2.25, 3.77], [2.2, 3.82], [2.2, 5.0], [2.15, 5.05], [0.82, 5.05], [0.78, 5.0], [0.78, 1.0]]
  const seams: P2[][] = [
    [[-3.15, 1.05], [-0.88, 1.05], [-0.88, 4.95], [-3.15, 4.95]],
    [[0.88, 1.05], [3.2, 1.05], [3.2, 3.67], [2.1, 3.67], [2.1, 4.95], [0.88, 4.95]],
  ]
  for (const poly of [left, right]) prism(b, poly, BB, BF, hot('battery', 0.9), hot('battery', 0.45), hot('battery', 0.45))
  for (const seam of seams) b.path([0, 0, BF + 0.002], X, Y, seam, true, hot('battery', 0.32))
  for (const [x0, x1] of [[-3.2, -0.88], [0.88, 3.2]]) b.lineN([x0, TCY, BF + 0.003], [x1, TCY, BF + 0.003], 3, hot('battery', 0.4))
  for (let y = 1.3; y < 4.8; y += 0.26) {
    if (Math.abs(y - TCY) < 0.12) continue
    b.line([-3.05, y, BF + 0.002], [-1.0, y, BF + 0.002], hot('battery', 0.2))
    b.line([1.0, y, BF + 0.002], [y > 3.6 ? 2.0 : 3.05, y, BF + 0.002], hot('battery', 0.2))
  }
  for (const sx of [-1, 1]) {
    b.box([sx * 0.88 - 0.06, 1.3, BF], [sx * 0.88 + 0.06, 4.7, BF + 0.03], hot('battery', 0.55))
    for (let y = 1.5; y < 4.6; y += 0.4) b.rect([sx * 0.88, y, BF + 0.032], X, Y, 0.05, 0.12, hot('battery', 0.4))
  }

  // ---------- logic board down the middle ----------
  const bz = -0.04
  b.rect([0, TCY, bz], X, Y, 1.3, 4.1, hot('board', 0.6), 0.1)
  b.rect([0, TCY, bz + 0.002], X, Y, 1.16, 3.96, hot('board', 0.3), 0.08)
  for (const [x, y] of [[-0.52, 1.1], [0.52, 1.1], [-0.52, 4.9], [0.52, 4.9]] as P2[]) b.circle([x, y, bz + 0.002], X, Y, 0.035, 8, hot('board', 0.55))
  const T = (x: number, y: number): Vec3 => [x, y, bz + 0.003]
  const BRDd = hot('board', 0.38)
  b.traces(T, [[0, 3.35], [0, 3.1], [-0.28, 3.0], [-0.28, 2.98]], 5, 0.026, BRDd)
  b.traces(T, [[0.2, 3.35], [0.2, 3.15], [0.28, 3.05], [0.28, 2.98]], 4, 0.026, BRDd)
  b.traces(T, [[-0.3, 2.62], [-0.3, 2.35], [-0.1, 2.15]], 4, 0.026, BRDd)
  b.traces(T, [[0.38, 3.9], [0.5, 4.0], [0.5, 4.5]], 3, 0.026, BRDd)
  chip(b, -0.38, 3.35, 0.38, 4.11, bz, 0.08, 'cpu', true)
  chip(b, -0.5, 2.62, -0.06, 2.98, bz, 0.05, 'mem')
  chip(b, 0.06, 2.62, 0.5, 2.98, bz, 0.05, 'mem')
  chip(b, -0.45, 1.6, 0.45, 2.15, bz, 0.05, 'disk')
  chip(b, -0.45, 4.35, -0.02, 4.72, bz, 0.04, 'board')
  chip(b, 0.12, 1.2, 0.45, 1.45, bz, 0.03, 'board')
  // speaker modules in the corners
  for (const sx of [-1, 1]) for (const yc of [1.25, 4.75]) {
    if (sx > 0 && yc > 4) continue
    b.box([sx * 3.36 - 0.1, yc - 0.42, -0.08], [sx * 3.36 + 0.1, yc + 0.42, 0.06], SHd)
  }
  // flexes from the board to the port, the speakers and the display
  for (let i = 0; i < 3; i++) b.poly([[0.62, 3.1 + i * 0.05, bz + 0.03], [0.75, 3.1 + i * 0.05, -0.09], [3.3, 3.1 + i * 0.05, -0.09], [TW / 2 - 0.12, TCY + (i - 1) * 0.05, -0.02]], false, hot('board', 0.36))
  for (const sx of [-1, 1]) b.poly([[sx * 0.62, 1.3, bz + 0.03], [sx * 0.75, 1.3, -0.09], [sx * 3.2, 1.3, -0.09], [sx * 3.26, 1.25, -0.06]], false, hot('board', 0.32))
  for (let i = 0; i < 4; i++) b.poly([[-0.3 + i * 0.2, 4.9, bz + 0.03], [-0.3 + i * 0.2, 5.15, 0.03], [-0.3 + i * 0.2, 5.25, 0.07]], false, hot('display', 0.4))
  // a flex from the right battery's step to the board
  b.curve([2.2, 4.4, BF], [1.6, 4.5, 0.04], [0.9, 4.6, 0.0], [0.62, 4.6, bz + 0.03], 8, hot('board', 0.38))

  // ---------- rear camera bump ----------
  const zb = -hz
  plateau(b, 2.85, 4.62, 1.1, 1.3, 0.34, zb, zb - 0.08)
  rearLens(b, 2.85, 4.92, 0.27, zb - 0.08, 0.05, -0.02)
  b.circle([3.06, 4.28, zb - 0.082], X, Y, 0.14, 16, SH)
  b.circle([3.06, 4.28, zb - 0.083], X, Y, 0.06, 8, SHd)
  b.circle([2.6, 4.28, zb - 0.082], X, Y, 0.075, 12, ACC)
  b.circle([2.6, 4.28, zb - 0.083], X, Y, 0.035, 8, ACC)
  b.circle([2.6, 4.6, zb - 0.082], X, Y, 0.02, 6, SHd)

  b.hotspot('cpu', [0, 3.73, bz + 0.11], 'Processor')
  b.hotspot('mem', [0.28, 2.8, bz + 0.08], 'Memory')
  b.hotspot('disk', [0, 1.88, bz + 0.08], 'Storage')
  b.hotspot('battery', [-2.0, TCY, BF + 0.01], 'Battery')

  b.rotate([0, TY0, 0], X, -10 * DEG)
  return b.model()
}

/** A low wash of screen light on the floor in front. No airflow: neither has a fan. */
export const PHONE_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [{ from: [0, 0.75, 0.32], dir: [0, -0.16, 1], spread: 22, length: 8, intensity: 0.4 }],
  flow: [],
}

export const TABLET_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [{ from: [0, 0.75, 0.22], dir: [0, -0.16, 1], spread: 30, length: 8.5, intensity: 0.4 }],
  flow: [],
}
