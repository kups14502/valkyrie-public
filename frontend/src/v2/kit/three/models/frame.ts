// frame (labeled Loki) in x-ray: a standalone VR headset. The visor faces +z,
// the face gasket and the head strap loop run back toward -z, and the battery
// pack sits on the back of the strap as a counterweight. It floats at head
// height over the floor. Labels stay generic: no claims about exact parts.
//
// Groups: cpu (processor, heat pipe, fins), mem (memory), disk (storage),
// battery (rear pack, cells, cable), fans (blower fan), display (the two
// panels), cams (tracking and eye cameras), board.

import { cross, norm, type Model, type Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, rrLoop, type Style } from './build'

const { X, Y, Z } = AX

const YC = 2.55
const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.6 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** visor cross sections, front to back: z, half width, half height, corner radius, nose notch depth */
const SECTIONS: [number, number, number, number, number][] = [
  [3.4, 1.9, 0.96, 0.52, 0],
  [3.24, 2.1, 1.13, 0.66, 0],
  [2.9, 2.18, 1.19, 0.71, 0],
  [2.55, 2.22, 1.22, 0.74, 0],
  [2.2, 2.2, 1.19, 0.73, 0.18],
  [1.85, 2.14, 1.14, 0.7, 0.5],
]
const N = 64
const NOSE_W = 0.62

/** Raise the bottom edge around x = 0 into a nose cutout. */
const notch = (p: [number, number], depth: number): [number, number] => {
  if (depth <= 0 || p[1] >= 0 || Math.abs(p[0]) >= NOSE_W) return p
  const c = Math.cos((Math.PI * p[0]) / (2 * NOSE_W))
  return [p[0], p[1] + depth * c * c]
}

const loop = (hw: number, hh: number, r: number, depth: number, z: (x: number) => number): Vec3[] =>
  rrLoop(hw, hh, r, N).map((p) => { const [x, y] = notch(p, depth); return [x, YC + y, z(x)] })

export function frameHeadset(): Model {
  const b = new Builder()

  // ---------- visor shell: lofted sections ----------
  const secs = SECTIONS.map(([z, hw, hh, r, d]) => loop(hw, hh, r, d, () => z))
  const secStyle: Style[] = [FG, FG, MESH, SH, MESH, SH]
  secs.forEach((s, i) => b.poly(s, true, secStyle[i]))
  // long edges: the strong ones at the corners and mid-sides, a fine mesh between
  const strong = new Set<number>()
  for (let q = 0; q < 4; q++) { strong.add(q * (N / 4)); strong.add(q * (N / 4) + N / 8) }
  for (let i = 0; i < N; i++) {
    if (i % 2 === 0) b.line(secs[0][i], secs[1][i], strong.has(i) ? FGd : SHd)
    for (let k = 1; k < secs.length - 1; k++) b.line(secs[k][i], secs[k + 1][i], strong.has(i) ? SH : { layer: 'mesh', w: 0.7 })
  }

  // faceplate: inset ring, fine mesh, glass
  const fz = 3.4
  b.roundRect([0, YC, fz + 0.003], X, Y, 3.56, 1.68, 0.42, SHd, 5)
  b.roundGrid([0, YC, fz + 0.004], X, Y, 3.56, 1.68, 0.42, 0.075, { layer: 'mesh', w: 0.7 }, 5)
  b.face(b.roundRectPts([0, YC, fz], X, Y, 3.8, 1.92, 0.52, 3), 'fg', 1.1)
  // chamfer glass band (faint) above and below
  b.face([[-1.4, YC + 0.96, 3.4], [1.4, YC + 0.96, 3.4], [1.44, YC + 1.13, 3.24], [-1.44, YC + 1.13, 3.24]], 'fg', 0.5)

  // tracking cameras on the four chamfer corners, angled outward
  const cams: Vec3[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const at: Vec3 = [sx * 1.83, YC + sy * 0.87, 3.32]
    cams.push(at)
    b.lens(at, [sx * 0.435, sy * 0.435, 0.788], 0.115, FG, SHd, hot('cams', 0.9), 0.16)
  }
  // status light on the lower chamfer
  b.rect([0, YC - 1.045, 3.322], X, norm([0, -0.728, -0.685]), 1.4, 0.04, ACC)

  // top vents over the fan, bottom intake
  for (let z = 2.22; z <= 2.96; z += 0.07) b.lineN([-0.62, YC + 1.224, z], [0.98, YC + 1.224, z], 2, MESHd)
  b.rect([0.18, YC + 1.224, 2.59], X, Z, 1.72, 0.86, SHd, 0.06)
  for (let z = 2.3; z <= 3.02; z += 0.07) b.lineN([-0.95, YC - 1.224, z], [0.95, YC - 1.224, z], 2, MESHd)
  b.rect([0, YC - 1.224, 2.66], X, Z, 2.0, 0.8, SHd, 0.06)
  // power button and volume rocker on the lower right edge
  b.rect([1.55, YC - 1.2, 2.45], X, Z, 0.32, 0.1, FG, 0.02)
  b.rect([1.05, YC - 1.215, 2.45], X, Z, 0.4, 0.1, SH, 0.02)

  // ---------- main board behind the faceplate ----------
  const bz = 2.98
  const B = (x: number, y: number, lift = 0): Vec3 => [x, YC + y, bz + lift]
  const BRD = hot('board', 0.6), BRDd = hot('board', 0.38)
  b.poly([B(-1.55, 0.55), B(-1.4, 0.71), B(1.4, 0.71), B(1.55, 0.55), B(1.55, -0.52), B(1.38, -0.69), B(0.42, -0.69), B(0.3, -0.58), B(-0.3, -0.58), B(-0.42, -0.69), B(-1.38, -0.69), B(-1.55, -0.52)], true, BRD)
  for (const [x, y] of [[-1.38, 0.53], [1.38, 0.53], [-1.38, -0.5], [1.38, -0.5], [0, -0.48]]) b.circle(B(x, y, 0.002), X, Y, 0.04, 8, BRD)
  // traces: processor fan-out to memory, storage, power and the display connectors
  const T = (x: number, y: number) => B(x, y, 0.002)
  b.traces(T, [[0.34, 0.27], [0.43, 0.27], [0.47, 0.23], [0.52, 0.23]], 6, 0.022, BRDd)
  b.traces(T, [[0.34, -0.12], [0.43, -0.12], [0.47, -0.18], [0.52, -0.18]], 6, 0.022, BRDd)
  b.traces(T, [[-0.34, 0.02], [-0.43, 0.02], [-0.47, 0.0], [-0.52, 0.0]], 6, 0.022, BRDd)
  b.traces(T, [[0.16, -0.26], [0.16, -0.42], [0.3, -0.54], [1.0, -0.54]], 5, 0.026, BRDd)
  b.traces(T, [[-0.62, -0.22], [-0.62, -0.42], [-0.76, -0.54], [-1.02, -0.54]], 5, 0.026, BRDd)
  b.traces(T, [[0.92, 0.36], [1.02, 0.42], [1.02, 0.5]], 3, 0.026, BRDd)

  // processor: package, die, and the heat pipe to the fan's fin stack
  const CPU = hot('cpu', 1)
  b.box(B(-0.34, -0.26), B(0.34, 0.42, 0.08), hot('cpu', 0.9))
  b.rect(B(0, 0.08, 0.082), X, Y, 0.42, 0.42, CPU, 0.04)
  b.rect(B(0, 0.08, 0.084), X, Y, 0.24, 0.24, hot('cpu', 0.75), 0.02)
  b.line(B(-0.12, -0.04, 0.085), B(0.12, 0.2, 0.085), hot('cpu', 0.5))
  b.line(B(-0.12, 0.2, 0.085), B(0.12, -0.04, 0.085), hot('cpu', 0.5))
  b.rect(B(0, 0.1, 0.1), X, Y, 0.86, 0.78, hot('cpu', 0.55), 0.08)
  b.rect(B(0, 0.1, 0.102), X, Y, 0.78, 0.7, hot('cpu', 0.3), 0.06)
  b.tube(B(0.18, 0.42, 0.06), B(0.22, 0.78, 0.06), [0.42, YC + 0.9, 2.98], [0.5, YC + 0.89, 2.75], 0.032, X, 12, hot('cpu', 0.6))
  b.box([0.36, YC + 0.8, 2.2], [0.96, YC + 0.98, 2.92], hot('cpu', 0.6))
  for (let z = 2.24; z < 2.9; z += 0.045) {
    b.line([0.36, YC + 0.98, z], [0.96, YC + 0.98, z], hot('cpu.rad', 0.3))
    b.line([0.96, YC + 0.8, z], [0.96, YC + 0.98, z], hot('cpu.rad', 0.32))
  }

  // memory: two packages
  for (const y0 of [0.04, -0.36]) {
    b.box(B(0.52, y0), B(0.92, y0 + 0.32, 0.05), hot('mem', 0.9))
    b.rect(B(0.72, y0 + 0.16, 0.052), X, Y, 0.28, 0.2, hot('mem', 0.45), 0.02)
    b.circle(B(0.57, y0 + 0.27, 0.053), X, Y, 0.018, 6, hot('mem', 1))
  }
  // storage
  b.box(B(-0.98, -0.22), B(-0.52, 0.24, 0.05), hot('disk', 0.9))
  b.rect(B(-0.75, 0.01, 0.052), X, Y, 0.34, 0.34, hot('disk', 0.45), 0.03)
  for (let k = 0; k < 3; k++) b.line(B(-0.88, 0.12 - k * 0.07, 0.054), B(-0.68 + (k === 2 ? -0.08 : 0), 0.12 - k * 0.07, 0.054), hot('disk', 0.5))
  // power management, radio, passives
  b.box(B(-0.42, -0.58), B(-0.12, -0.36, 0.04), hot('board', 0.55))
  b.box(B(1.0, 0.24), B(1.34, 0.56, 0.04), hot('board', 0.55))
  b.rect(B(1.17, 0.4, 0.042), X, Y, 0.22, 0.2, BRDd, 0.02)
  for (const [x, y] of [[-1.25, 0.3], [-1.15, 0.3], [-1.25, 0.18], [-1.1, -0.1], [-1.25, -0.25], [1.2, -0.1], [1.3, -0.1], [1.2, -0.25], [-0.05, 0.56], [0.08, 0.56], [-0.2, 0.56]]) {
    b.rect(B(x, y, 0.01), X, Y, 0.06, 0.035, BRDd)
  }
  // display connectors + flex cables back to the panels
  for (const sx of [-1, 1]) {
    b.box(B(sx * 1.12 - 0.12, -0.6), B(sx * 1.12 + 0.12, -0.5, 0.04), hot('board', 0.55))
    for (let i = 0; i < 3; i++) {
      const o = (i - 1) * 0.05
      b.curve(B(sx * 1.12 + o, -0.6, 0.02), [sx * 1.12 + o, YC - 0.85, 2.85], [sx * 0.95 + o, YC - 0.88, 2.5], [sx * 0.74 + o, YC - 0.7, 2.4], 8, hot('display', 0.4))
    }
  }
  // radio antennas up into the top corners
  for (const sx of [-1, 1]) b.curve(B(1.17, 0.5, 0.03), [1.2, YC + 0.85, 2.95], [sx * 1.4, YC + 1.0, 2.9], [sx * 1.75, YC + 0.95, 2.7], 8, SHd)

  // ---------- fan ----------
  b.fan([-0.12, YC + 0.9, 2.58], X, Z, 0.8, { frame: SHd, ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 11, depth: 0.14, speed: 1.2 })

  // ---------- the two display panels ----------
  for (const sx of [-1, 1]) {
    const c: Vec3 = [sx * 0.74, YC - 0.05, 2.42]
    b.rect(c, X, Y, 1.22, 1.22, hot('display', 0.75), 0.06)
    b.rect([c[0], c[1], 2.36], X, Y, 1.22, 1.22, hot('display', 0.35), 0.06)
    b.rect([c[0], c[1], 2.425], X, Y, 1.06, 1.06, hot('display', 0.45), 0.03)
    for (const [dx, dy] of [[-0.58, -0.58], [0.58, -0.58], [0.58, 0.58], [-0.58, 0.58]]) b.line([c[0] + dx, c[1] + dy, 2.42], [c[0] + dx, c[1] + dy, 2.36], hot('display', 0.35))
  }

  // ---------- pancake lenses ----------
  for (const sx of [-1, 1]) {
    const cx = sx * 0.74, cy = YC - 0.08
    b.circle([cx, cy, 2.27], X, Y, 0.55, 40, SH)
    b.circle([cx, cy, 2.12], X, Y, 0.53, 40, FG)
    for (const r of [0.4, 0.27, 0.14]) b.circle([cx, cy, 2.08], X, Y, r, 28, MESH)
    b.circle([cx, cy, 1.93], X, Y, 0.57, 40, FG)
    b.circle([cx, cy, 1.94], X, Y, 0.5, 36, SHd)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      b.line([cx + Math.cos(a) * 0.55, cy + Math.sin(a) * 0.55, 2.27], [cx + Math.cos(a) * 0.57, cy + Math.sin(a) * 0.57, 1.93], SHd)
    }
    // eye tracking LEDs around the rim
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8
      b.circle([cx + Math.cos(a) * 0.65, cy + Math.sin(a) * 0.65, 1.91], X, Y, 0.022, 6, hot('cams', 0.7))
    }
  }
  // lens spacing rail between the barrels
  b.lineN([-0.2, YC + 0.52, 2.1], [0.2, YC + 0.52, 2.1], 2, SHd)
  b.circle([0, YC + 0.52, 2.1], X, Y, 0.07, 10, SHd)

  // ---------- face gasket ----------
  const G0 = loop(2.08, 1.1, 0.68, 0.48, () => 1.83)
  const G1 = loop(2.12, 1.14, 0.7, 0.46, (x) => 1.66 - 0.12 * (x / 2) ** 2)
  const G2 = loop(2.02, 1.06, 0.66, 0.5, (x) => 1.5 - 0.42 * (x / 2.05) ** 2)
  const G3 = loop(1.7, 0.8, 0.5, 0.38, (x) => 1.56 - 0.3 * (x / 1.7) ** 2)
  b.poly(G0, true, SH)
  b.poly(G1, true, MESH)
  b.poly(G2, true, FGd)
  b.poly(G3, true, SHd)
  for (let i = 0; i < N; i += 2) {
    b.line(G0[i], G1[i], MESH)
    b.line(G1[i], G2[i], MESH)
    if (i % 4 === 0) b.line(G2[i], G3[i], MESHd)
  }

  // ---------- head strap ----------
  // centerline: right arm from the hinge, the loop around the back, left arm
  const zc = 0.62, a = 2.06, depth = 3.0, p = 2.5
  const cl: { at: Vec3; back: number }[] = []
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    cl.push({ at: [2.2 - 0.12 * t, YC + 0.15, 1.95 - (1.95 - zc) * t], back: 0 })
  }
  const LOOP = 40
  for (let i = 1; i < LOOP; i++) {
    const th = -(i / LOOP) * Math.PI
    const c = Math.cos(th), s = Math.sin(th)
    const x = a * Math.sign(c) * Math.abs(c) ** (2 / p)
    const z = zc + depth * Math.sign(s) * Math.abs(s) ** (2 / p)
    const back = Math.abs(s) ** 1.2
    cl.push({ at: [x, YC + 0.15 - 0.5 * back, z], back })
  }
  for (let i = 4; i >= 0; i--) {
    const t = i / 4
    cl.push({ at: [-(2.2 - 0.12 * t), YC + 0.15, 1.95 - (1.95 - zc) * t], back: 0 })
  }
  // outward normal in the floor plane at each point
  const outN = cl.map((_, i) => {
    const pa = cl[Math.max(0, i - 1)].at, pb = cl[Math.min(cl.length - 1, i + 1)].at
    const t = norm([pb[0] - pa[0], 0, pb[2] - pa[2]])
    return norm(cross(t, Y))
  })
  const off = (i: number, o: number, dy: number): Vec3 => {
    const q = cl[i].at, n = outN[i]
    return [q[0] + n[0] * o, q[1] + dy, q[2] + n[2] * o]
  }
  const HB = 0.27, TH = 0.08
  b.poly(cl.map((_, i) => off(i, TH, HB)), false, { layer: 'fg', w: 0.5 })
  b.poly(cl.map((_, i) => off(i, TH, -HB)), false, SH)
  b.poly(cl.map((_, i) => off(i, 0, HB)), false, SHd)
  b.poly(cl.map((_, i) => off(i, 0, -HB)), false, SHd)
  b.poly(cl.map((_, i) => off(i, TH + 0.002, 0)), false, { layer: 'mesh', w: 0.5 })
  for (let i = 0; i < cl.length; i += 2) {
    b.line(off(i, TH, HB), off(i, TH, -HB), MESH)
    b.line(off(i, 0, HB), off(i, TH, HB), MESHd)
  }
  // rear pad on the inside of the loop
  const backIdx = cl.map((c, i) => (c.back > 0.55 ? i : -1)).filter((i) => i >= 0)
  b.poly(backIdx.map((i) => off(i, -0.1, HB - 0.04)), false, MESH)
  b.poly(backIdx.map((i) => off(i, -0.1, -HB + 0.04)), false, MESH)
  for (let k = 0; k < backIdx.length; k += 3) b.line(off(backIdx[k], -0.1, HB - 0.04), off(backIdx[k], -0.1, -HB + 0.04), MESHd)

  // hinges where the strap meets the visor
  for (const sx of [-1, 1]) {
    b.circle([sx * 2.22, YC + 0.15, 1.95], Z, Y, 0.2, 20, FG)
    b.circle([sx * 2.23, YC + 0.15, 1.95], Z, Y, 0.1, 12, SH)
    b.circle([sx * 2.17, YC + 0.15, 1.95], Z, Y, 0.2, 20, SHd)
  }
  // speakers on the arms by the ears
  for (const sx of [-1, 1]) {
    const x = sx * 2.17
    b.roundRect([x, YC - 0.36, 0.45], Z, Y, 0.72, 0.36, 0.15, SH, 4)
    b.roundRect([x - sx * 0.08, YC - 0.36, 0.45], Z, Y, 0.72, 0.36, 0.15, SHd, 4)
    for (let k = 0; k < 4; k++) b.line([x + sx * 0.004, YC - 0.43 + k * 0.045, 0.2], [x + sx * 0.004, YC - 0.43 + k * 0.045, 0.62], MESH)
    b.circle([x - sx * 0.04, YC - 0.36, 0.45], Z, Y, 0.11, 14, SHd)
  }

  // ---------- battery pack on the back of the strap ----------
  const bat = cl.map((c, i) => (c.back > 0.72 ? i : -1)).filter((i) => i >= 0)
  const BH = 0.44, BO = 0.56, BI = TH + 0.02
  const Bo = hot('battery', 0.9), Bi = hot('battery', 0.55)
  // the shell, its outer face rounded over at top and bottom
  const prof: [number, number, Style][] = [[BI, BH, Bi], [BO - 0.1, BH, Bo], [BO, BH - 0.1, hot('battery', 0.5)], [BO, -BH + 0.1, hot('battery', 0.5)], [BO - 0.1, -BH, Bo], [BI, -BH, Bi]]
  const rails = prof.map(([o, dy, st]) => { const pts = bat.map((i) => off(i, o, dy)); b.poly(pts, false, st); return pts })
  for (let k = 0; k < bat.length; k += 2) {
    const end = k === 0 || k >= bat.length - 2
    const kk = k >= bat.length - 2 ? bat.length - 1 : k
    b.poly(rails.map((r) => r[kk]), end, end ? Bo : hot('battery', 0.32))
  }
  // three cells inside
  const cells = 3
  const per = (bat.length - 1) / cells
  for (let c = 0; c < cells; c++) {
    const i0 = Math.round(c * per) + 1, i1 = Math.round((c + 1) * per) - 1
    const idx = bat.slice(i0, i1 + 1)
    for (const o of [0.2, 0.42]) {
      const top = idx.map((i) => off(i, o, BH - 0.1)), bot = idx.map((i) => off(i, o, -BH + 0.12))
      b.poly([...top, ...bot.reverse()], true, hot('battery', o > 0.3 ? 0.75 : 0.45))
    }
    for (const i of [idx[0], idx[idx.length - 1]]) for (const dy of [BH - 0.1, -BH + 0.12]) b.line(off(i, 0.2, dy), off(i, 0.42, dy), hot('battery', 0.45))
    b.poly(idx.map((i) => off(i, 0.42, 0.0)), false, hot('battery', 0.3))
  }
  // charge board along the top and the charge light
  b.poly(bat.slice(2, -2).map((i) => off(i, 0.31, BH - 0.05)), false, hot('battery', 0.45))
  const mid = bat[Math.floor(bat.length / 2)]
  const led = off(mid, BO + 0.005, 0.22)
  b.rect(led, X, Y, 0.2, 0.028, ACC)
  // power cable from the pack forward along the right side of the strap
  const cableIdx = cl.map((_, i) => i).filter((i) => i <= bat[0] && i >= 2)
  b.poly(cableIdx.map((i) => off(i, TH / 2, -0.12)), false, hot('battery', 0.4))

  // ---------- hotspots ----------
  b.hotspot('cpu', B(0, 0.08, 0.09), 'Processor')
  b.hotspot('mem', B(0.86, 0.3, 0.06), 'Memory')
  b.hotspot('disk', B(-0.86, -0.14, 0.06), 'Storage')
  b.hotspot('battery', off(mid, BO, BH - 0.05), 'Battery')
  b.hotspot('lens', [1.31, YC - 0.08, 1.93], 'Lenses')

  return b.model()
}

const CAM_L: Vec3 = [-1.83, YC - 0.87, 3.32]
const CAM_R: Vec3 = [1.83, YC - 0.87, 3.32]

/** Lower tracking cameras' view cones on the floor, and air through the fan and over the visor. */
export const FRAME_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [
    { from: CAM_L, dir: [-0.42, -0.72, 0.55], spread: 17, length: 6.5, intensity: 0.5 },
    { from: CAM_R, dir: [0.42, -0.72, 0.55], spread: 17, length: 6.5, intensity: 0.5 },
  ],
  flow: [
    { from: [-0.1, YC - 2.0, 4.2], to: [0.1, YC + 1.7, -2.6], via: [-0.12, YC + 0.4, 2.55], speed: 1.8, spread: 0.4, lanes: 7 },
    { from: [0, YC + 0.1, 6.8], to: [0, YC + 0.2, -5.8], via: [0, YC + 1.55, 0.6], speed: 2.4, spread: 1.1, lanes: 10 },
  ],
}
