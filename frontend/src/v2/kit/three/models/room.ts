// Brendon's room as a wireframe: floor outline, back and right walls, the desk
// with thor's monitors, a bed, and one bulb per Home Assistant light near the
// ceiling. Each bulb is a hotspot (id = light id) so a screen can place glows:
//   lights={model.hotspots.map((h) => ({ at: h.at, color, intensity }))}

import type { Model, Vec3 } from '../engine'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX
const RX = 3.6, RZ = 2.6, RH = 3.0

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const MESH: Style = { layer: 'mesh', w: 0.6 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

// Good bulb spots first (over the desk, over the bed, center, corners), then a grid.
const SPOTS: [number, number][] = [
  [-2.0, -1.5], [2.15, -0.9], [-0.5, 0.5], [2.6, 1.7], [-2.9, 1.7], [0.4, -1.9], [-1.4, 1.9], [1.1, 0.9],
]

/** Bulb positions for n lights (world space, the same ones room() uses). */
export function bulbSpots(n: number): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    if (i < SPOTS.length) { out.push([-SPOTS[i][0], RH - 0.32, SPOTS[i][1]]); continue }
    const k = i - SPOTS.length
    out.push([3.0 - (k % 6) * 1.2, RH - 0.45, -2.0 + Math.floor(k / 6) * 1.1])
  }
  return out
}

// The room is drawn with the side wall on -x, then mirrored so the open
// corner faces the 'lights' pose (camera on the -x, +z side).
const mirror = (p: Vec3): Vec3 => [-p[0], p[1], p[2]]

export function room(lights: { id: string; name: string }[]): Model {
  const b = new Builder()

  // floor + walls
  b.rect([0, 0.003, 0], X, Z, 2 * RX, 2 * RZ, FG)
  b.rect([0, RH / 2, -RZ], X, Y, 2 * RX, RH, SH)
  b.rect([-RX, RH / 2, 0], Z, Y, 2 * RZ, RH, SH)
  b.line([-RX, 0.1, -RZ], [RX, 0.1, -RZ], SHd)
  b.line([-RX, 0.1, -RZ], [-RX, 0.1, RZ], SHd)
  for (let x = -RX + 0.45; x < RX; x += 0.45) b.lineN([x, 0.1, -RZ], [x, RH, -RZ], 3, MESH)
  for (let z = -RZ + 0.45; z < RZ; z += 0.45) b.lineN([-RX, 0.1, z], [-RX, RH, z], 3, MESH)
  b.face([[-RX, 0, -RZ], [RX, 0, -RZ], [RX, RH, -RZ], [-RX, RH, -RZ]], 'fg', 0.3)
  b.face([[-RX, 0, -RZ], [-RX, 0, RZ], [-RX, RH, RZ], [-RX, RH, -RZ]], 'fg', 0.3)
  // window (back wall, right) and door (left wall)
  b.rect([1.75, 1.75, -RZ + 0.01], X, Y, 1.7, 1.3, FG)
  b.rect([1.75, 1.75, -RZ + 0.02], X, Y, 1.56, 1.16, SHd)
  b.line([1.75, 1.17, -RZ + 0.02], [1.75, 2.33, -RZ + 0.02], SHd)
  b.line([0.97, 1.75, -RZ + 0.02], [2.53, 1.75, -RZ + 0.02], SHd)
  b.box([0.85, 1.05, -RZ], [2.65, 1.1, -RZ + 0.12], SHd)
  b.rect([-RX + 0.01, 1.1, 1.3], Z, Y, 1.0, 2.2, FG)
  b.rect([-RX + 0.02, 1.1, 1.3], Z, Y, 0.86, 2.06, SHd)
  b.circle([-RX + 0.04, 1.05, 0.95], Z, Y, 0.05, 8, SH)

  // desk + monitors + keyboard + mini tower + chair
  b.box([-3.3, 0.72, -2.55], [-0.7, 0.78, -1.75], SH)
  for (const [x, z] of [[-3.22, -2.47], [-0.78, -2.47], [-3.22, -1.83], [-0.78, -1.83]]) b.line([x, 0, z], [x, 0.72, z], SH)
  b.line([-3.22, 0.25, -2.47], [-0.78, 0.25, -2.47], SHd)
  const screen = (c: Vec3, u: Vec3, w: number, h: number) => {
    b.rect(c, u, Y, w, h, SH, 0.02)
    b.rect(c, u, Y, w - 0.06, h - 0.06, hot('screens', 0.7))
    for (let k = 1; k < 6; k++) b.line(Builder.at(c, u, Y, -w / 2 + 0.06, -h / 2 + (h * k) / 6), Builder.at(c, u, Y, w / 2 - 0.06, -h / 2 + (h * k) / 6), hot('screens', 0.25))
    b.line([c[0], c[1] - h / 2, c[2] - 0.05], [c[0], 0.78, c[2] - 0.05], SH)
    b.rect([c[0], 0.785, c[2] - 0.05], X, Z, 0.36, 0.2, SHd)
  }
  screen([-2.05, 1.3, -2.3], X, 1.7, 0.62)
  const tilt: Vec3 = [Math.cos(0.5), 0, Math.sin(0.5)]
  screen([-0.95, 1.28, -2.15], tilt, 0.75, 0.48)
  b.rect([-2.05, 0.785, -1.98], X, Z, 0.85, 0.24, SHd, 0.02)
  b.rect([-1.45, 0.785, -1.98], X, Z, 0.1, 0.16, SHd, 0.03)
  b.chamferBox([-3.0, 0.5, -2.1], [0.22, 0.5, 0.42], 0.04, (axis, s) => (axis === 2 && s === 1 ? FG : SH), SHd)
  b.circle([-3.0, 0.62, -1.675], X, Y, 0.15, 16, hot('fans', 0.9))
  b.circle([-3.0, 0.3, -1.675], X, Y, 0.15, 16, hot('fans', 0.9))
  b.box([-2.35, 0.45, -1.55], [-1.75, 0.52, -0.98], SH)
  b.rect([-2.05, 0.95, -0.95], X, Y, 0.56, 0.75, SH, 0.1)
  b.line([-2.05, 0.45, -1.26], [-2.05, 0.08, -1.26], SH)
  for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; b.line([-2.05, 0.08, -1.26], [-2.05 + Math.cos(a) * 0.32, 0.03, -1.26 + Math.sin(a) * 0.32], SHd) }

  // bed + nightstand + rug
  b.box([0.9, 0.12, -2.55], [3.45, 0.42, 0.9], SH)
  b.box([0.95, 0.42, -2.5], [3.4, 0.6, 0.85], SHd)
  b.rect([2.175, 0.95, -2.57], X, Y, 2.55, 0.9, FG, 0.12)
  b.rect([1.6, 0.66, -2.05], X, Z, 0.95, 0.5, SHd, 0.12)
  b.rect([2.75, 0.66, -2.05], X, Z, 0.95, 0.5, SHd, 0.12)
  b.lineN([0.95, 0.62, -1.2], [3.4, 0.62, -1.2], 4, SHd)
  for (let z = -1.0; z < 0.85; z += 0.3) b.lineN([0.95, 0.605, z], [3.4, 0.605, z], 4, MESH)
  b.box([0.25, 0, -2.55], [0.8, 0.6, -2.05], SH)
  b.rect([0.525, 0.6, -2.3], X, Z, 0.4, 0.3, SHd)
  b.rect([-0.7, 0.006, 0.55], X, Z, 2.6, 2.0, MESH, 0.1)
  b.rect([-0.7, 0.006, 0.55], X, Z, 2.4, 1.8, MESH, 0.08)

  // bulbs near the ceiling, one per light (spots are already mirrored: flip back, the whole model flips below)
  const spots = bulbSpots(lights.length).map(mirror)
  lights.forEach((l, i) => {
    const p = spots[i]
    const st = hot(`bulb.${l.id}`, 1)
    b.line([p[0], RH, p[2]], [p[0], p[1] + 0.12, p[2]], SHd)
    b.circle([p[0], RH - 0.003, p[2]], X, Z, 0.08, 10, SHd)
    b.circle(p, X, Y, 0.1, 12, st)
    b.circle(p, Z, Y, 0.1, 12, st)
    b.circle([p[0], p[1] + 0.04, p[2]], X, Z, 0.085, 12, st)
    b.hotspot(l.id, p, l.name)
  })

  for (const sg of b.segs) { sg.a = mirror(sg.a); sg.b = mirror(sg.b) }
  for (const f of b.faces) f.pts = f.pts.map(mirror).reverse()
  for (const h of b.hotspots) h.at = mirror(h.at)
  return b.model([0, 1.4, 0], 4.6)
}
