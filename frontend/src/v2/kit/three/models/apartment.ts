// Brendon's apartment as a one-floor wireframe plan, read from his 2026-10-18
// walkthrough (lab/reference/apartment/NOTES.md): the entry with the front door
// and two closets, the dining table, the living room (the sectional facing the
// TV), the L-desk corner by the windows with thor and odin, the kitchen, the
// hall, the bedroom and the bathroom. Walls are low cutaway outlines so the
// plan reads from a raised camera. Each Home Assistant light sits where it is
// in the apartment and is a hotspot keyed by its entity id, so a screen lights
// it in its real color:
//   lights={model.hotspots.map((h) => ({ at: h.at, color, intensity }))}
// A light this file does not know hangs in a free spot, so a new bulb still shows.
//
// Built in plan meters (x east, z south, y up), then centered on the origin.

import { Camera, compile, type CameraPose, type Model, type Vec3 } from '../engine'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

/** wall cut height: low enough that every room reads from above */
const WH = 0.78
const TE = 0.16
const TI = 0.1
/** plan center, the origin after building */
const PX = 4.0, PZ = 4.0

const CAP: Style = { layer: 'fg', w: 0.6 }
const WALL: Style = { layer: 'shell', w: 0.5 }
const SH: Style = { layer: 'shell', w: 1 }
const SHd: Style = { layer: 'shell', w: 0.62 }
const MESH: Style = { layer: 'mesh', w: 0.9 }
/** where furniture meets the floor: faint, so the tops carry the shapes */
const BASE: Style = { layer: 'mesh', w: 0.7 }
const dim = (s: Style, k = 0.72): Style => ({ ...s, w: (s.w ?? 1) * k })
const GLASS: Style = { layer: 'mesh', w: 1 }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** The camera the plan is drawn for (degrees). Screens fit `dist` and `shift` to their box with fitView. */
export const APARTMENT_POSE: CameraPose = { yaw: 155, pitch: 38, dist: 22, fov: 30 }

type Gap = [from: number, to: number, kind: 'open' | 'window' | 'slider' | 'closet' | 'louver' | 'double']

/** Where each known light is, plan meters (the glowing part). */
const SPOTS: Record<string, Vec3> = {
  'light.office_lamp': [7.13, 1.43, 0.1],
  'light.tv_strip': [5.6, 0.95, 4.06],
  'light.kitche_light': [0.22, 2.2, 4.75],
  'light.nightsand': [3.02, 0.97, 0.26],
  'light.dresser': [4.48, 0.8, 5.72],
}

/** Free spots for lights this file does not know: living room, bedroom, kitchen, dining, hall, bathroom. */
const SPARE: [number, number][] = [[5.4, 2.9], [5.9, 6.2], [1.7, 4.5], [2.4, 2.2], [3.55, 6.2], [1.8, 6.6], [6.8, 3.3], [4.9, 6.9]]

/** Hanging bulb positions for n unknown lights (plan meters). */
function spareSpot(i: number): Vec3 {
  if (i < SPARE.length) return [SPARE[i][0], 1.75, SPARE[i][1]]
  const k = i - SPARE.length
  return [1 + (k % 6) * 1.2, 1.75, 1.6 + Math.floor(k / 6) * 1.0]
}

export function apartment(lights: { id: string; name: string }[]): Model {
  const b = new Builder()
  const hasLight = new Set(lights.map((l) => l.id))

  // ---------- helpers ----------

  /** A long line split about every meter, so the depth fade runs along it. */
  const ln = (a: Vec3, c: Vec3, s: Style) => {
    const n = Math.max(1, Math.round(Math.hypot(c[0] - a[0], c[2] - a[2]) / 1.0))
    if (n === 1) b.line(a, c, s)
    else b.lineN(a, c, n, s)
  }

  /**
   * Box edges, the long ones split for the depth fade. The top outline carries
   * the shape (s), the uprights are dimmer and the bottom outline faint.
   */
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, s: Style, side: Style = dim(s), base: Style = BASE) => {
    const q = (y: number): Vec3[] => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]
    const lo = q(y0), hi = q(y1)
    for (let i = 0; i < 4; i++) {
      ln(lo[i], lo[(i + 1) % 4], base)
      ln(hi[i], hi[(i + 1) % 4], s)
      b.line(lo[i], hi[i], side)
    }
  }

  /** A box with its own axes: c is the floor center, f the way its front faces (xz), w across, d along f. */
  const obox = (cx: number, cz: number, f: [number, number], w: number, d: number, y0: number, y1: number, s: Style) => {
    const rx = -f[1], rz = f[0]
    const P = (a: number, k: number, y: number): Vec3 => [cx + rx * a + f[0] * k, y, cz + rz * a + f[1] * k]
    const lo = [P(-w / 2, -d / 2, y0), P(w / 2, -d / 2, y0), P(w / 2, d / 2, y0), P(-w / 2, d / 2, y0)]
    const hi = [P(-w / 2, -d / 2, y1), P(w / 2, -d / 2, y1), P(w / 2, d / 2, y1), P(-w / 2, d / 2, y1)]
    for (let i = 0; i < 4; i++) {
      b.line(lo[i], lo[(i + 1) % 4], s)
      b.line(hi[i], hi[(i + 1) % 4], s)
      b.line(lo[i], hi[i], s)
    }
    return P
  }

  /** A floor rectangle (x0..x1, z0..z1). */
  const floorRect = (x0: number, z0: number, x1: number, z1: number, y: number, s: Style) => {
    ln([x0, y, z0], [x1, y, z0], s)
    ln([x1, y, z0], [x1, y, z1], s)
    ln([x1, y, z1], [x0, y, z1], s)
    ln([x0, y, z1], [x0, y, z0], s)
  }

  /** A globe (three rings) of radius r: a lamp's glowing shade. */
  const globe = (c: Vec3, r: number, s: Style) => {
    b.circle(c, X, Y, r, 14, s)
    b.circle(c, Z, Y, r, 14, s)
    b.circle(c, X, Z, r, 14, s)
  }

  /**
   * A wall on its centerline from (ax, az) to (bx, bz), t thick, cut at WH.
   * Gaps run along it in meters from (ax, az): open doorways, windows (the
   * wall stays, the glass shows on its cut), sliding glass doors, and closed
   * closet doors. Each end runs on by t/2 so corners close.
   */
  const wall = (ax: number, az: number, bx: number, bz: number, t: number, gaps: Gap[] = []) => {
    const L = Math.hypot(bx - ax, bz - az)
    const ux = (bx - ax) / L, uz = (bz - az) / L
    const nx = -uz, nz = ux
    const h = t / 2
    const at = (s: number, o: number, y: number): Vec3 => [ax + ux * s + nx * o, y, az + uz * s + nz * o]
    const solid = (s0: number, s1: number) => {
      if (s1 - s0 < 0.005) return
      for (const o of [-h, h]) {
        ln(at(s0, o, WH), at(s1, o, WH), CAP)
        ln(at(s0, o, 0.004), at(s1, o, 0.004), WALL)
        b.line(at(s0, o, 0), at(s0, o, WH), WALL)
        b.line(at(s1, o, 0), at(s1, o, WH), WALL)
      }
      b.line(at(s0, -h, WH), at(s0, h, WH), CAP)
      b.line(at(s1, -h, WH), at(s1, h, WH), CAP)
    }
    /** a closed door leaf in the opening, cut at WH */
    const leaf = (s0: number, s1: number, slats: boolean) => {
      b.rect(at((s0 + s1) / 2, 0, WH / 2), [ux, 0, uz], Y, s1 - s0 - 0.02, WH, SHd)
      if (slats) for (let y = 0.12; y < WH - 0.04; y += 0.09) b.line(at(s0 + 0.06, 0, y), at(s1 - 0.06, 0, y), MESH)
    }
    let s = -h
    for (const [g0, g1, kind] of [...gaps].sort((p, q) => p[0] - q[0])) {
      solid(s, g0)
      if (kind === 'window') {
        // the sill stays: its cut shows both faces and the glass between them
        for (const o of [-h, h]) {
          ln(at(g0, o, WH), at(g1, o, WH), WALL)
          ln(at(g0, o, 0.004), at(g1, o, 0.004), WALL)
        }
        ln(at(g0, 0, WH), at(g1, 0, WH), GLASS)
      } else if (kind === 'slider') {
        // two glass panels on their tracks, one in front of the other
        const m = (g0 + g1) / 2
        for (const [p0, p1, o] of [[g0, m + 0.05, -h / 2], [m - 0.05, g1, h / 2]] as const) {
          b.rect(at((p0 + p1) / 2, o, WH / 2), [ux, 0, uz], Y, p1 - p0, WH, GLASS)
          ln(at(p0, o, 0.004), at(p1, o, 0.004), WALL)
        }
      } else if (kind === 'closet' || kind === 'louver') {
        leaf(g0, g1, kind === 'louver')
      } else if (kind === 'double') {
        const m = (g0 + g1) / 2
        leaf(g0, m, false)
        leaf(m, g1, false)
      }
      s = g1
    }
    solid(s, L + h)
  }

  /** A door swing on the floor: the open leaf from the hinge and its arc, angles in the xz plane (x = cos, z = sin). */
  const swing = (hx: number, hz: number, closed: number, open: number, r: number) => {
    const c: Vec3 = [hx, 0.008, hz]
    b.circle(c, X, Z, r, 14, MESH, Math.min(closed, open), Math.max(closed, open))
    b.line(c, [hx + Math.cos(open) * r, 0.008, hz + Math.sin(open) * r], SHd)
  }

  /** A slat-back dining chair at (cx, cz) facing f (toward the table). */
  const chair = (cx: number, cz: number, f: [number, number]) => {
    const P = obox(cx, cz, f, 0.42, 0.42, 0.42, 0.46, SHd)
    for (const [a, k] of [[-0.19, -0.19], [0.19, -0.19], [0.19, 0.19], [-0.19, 0.19]]) b.line(P(a, k, 0), P(a, k, 0.42), SHd)
    // the back on the far side from the table
    for (const a of [-0.19, 0.19]) b.line(P(a, -0.2, 0.46), P(a, -0.2, 0.95), SHd)
    b.line(P(-0.19, -0.2, 0.95), P(0.19, -0.2, 0.95), SHd)
    b.line(P(-0.19, -0.2, 0.82), P(0.19, -0.2, 0.82), SHd)
    for (const a of [-0.06, 0.06]) b.line(P(a, -0.2, 0.46), P(a, -0.2, 0.82), SHd)
  }

  /** A monitor facing f (xz), its center at c, on a post to the desk top at y 0.76. */
  const monitor = (c: Vec3, f: [number, number], w: number, hgt: number) => {
    const u: Vec3 = [-f[1], 0, f[0]]
    b.rect(c, u, Y, w, hgt, SH, 0.01)
    b.rect(c, u, Y, w - 0.04, hgt - 0.04, hot('screens', 0.7))
    for (let k = 1; k < 4; k++) b.line(Builder.at(c, u, Y, -w / 2 + 0.03, -hgt / 2 + (hgt * k) / 4), Builder.at(c, u, Y, w / 2 - 0.03, -hgt / 2 + (hgt * k) / 4), hot('screens', 0.25))
    const post: Vec3 = [c[0] - f[0] * 0.05, 0, c[2] - f[1] * 0.05]
    b.line([post[0], c[1] - hgt / 2, post[2]], [post[0], 0.76, post[2]], SHd)
    b.rect([post[0], 0.765, post[2]], u, [f[0], 0, f[1]], 0.22, 0.16, SHd)
  }

  // ---------- walls ----------

  // outside: north (front door), east (window over the desk, sliding door, bedroom window), south, west
  wall(0, 0, 8, 0, TE, [[0.85, 1.75, 'open']])
  wall(8, 0, 8, 8, TE, [[0.45, 1.95, 'window'], [2.3, 3.95, 'slider'], [5.6, 7.0, 'window']])
  wall(8, 8, 0, 8, TE)
  wall(0, 8, 0, 0, TE)
  // entry closet (double doors) from the front door's corner, then the laundry closet (louvered
  // door) on the same wall, about 3 m from the front door wall to the kitchen
  wall(0, 1.75, 0.75, 1.75, TI)
  wall(0.75, 0, 0.75, 1.75, TI, [[0.12, 1.62, 'double']])
  wall(0.75, 1.75, 0.75, 3.1, TI, [[0.3, 1.1, 'louver']])
  // kitchen: closed behind the laundry, open to the entry up to the pillar and, past the pillar, to
  // the living room; that opening ends where the bedroom door starts across the hall
  wall(0, 3.1, 0.75, 3.1, TI)
  box(2.65, 0, 3.1, 3.0, WH, 3.45, CAP, WALL, WALL)
  wall(0, 5.7, 3.0, 5.7, TI)
  // the hall: kitchen and bathroom on its west side, the bedroom on its east
  wall(3.0, 4.4, 3.0, 8, TI, [[2.3, 3.1, 'open']])
  wall(4.1, 4.2, 8, 4.2, TI)
  wall(4.1, 4.2, 4.1, 8, TI, [[0.2, 1.05, 'open']])
  // doors that swing: front door into the entry, bedroom door into the bedroom, bathroom door into the bathroom
  swing(1.75, 0.08, Math.PI, Math.PI / 2, 0.9)
  swing(4.15, 4.4, Math.PI / 2, 0, 0.85)
  swing(2.95, 7.5, Math.PI * 1.5, Math.PI, 0.8)

  // ---------- dining: table against the wall, four chairs, the Table lamp in its corner ----------

  box(2.0, 0.72, 0.1, 3.2, 0.76, 0.9, SH)
  for (const [x, z] of [[2.05, 0.15], [3.15, 0.15], [3.15, 0.85], [2.05, 0.85]]) b.line([x, 0, z], [x, 0.72, z], SHd)
  chair(1.78, 0.5, [1, 0])
  chair(3.42, 0.5, [-1, 0])
  chair(2.3, 1.12, [0, -1])
  chair(2.9, 1.12, [0, -1])
  if (!hasLight.has('light.nightsand')) globe(SPOTS['light.nightsand'], 0.11, SHd)

  // ---------- living room: folding mats, the sectional (chaise toward the desk) facing the TV ----------

  floorRect(3.15, 1.45, 4.3, 3.75, 0.015, SHd)
  for (const z of [2.03, 2.6, 3.18]) b.line([3.15, 0.015, z], [4.3, 0.015, z], MESH)
  box(4.35, 0, 1.5, 6.85, 0.42, 2.45, SH)
  box(4.35, 0.42, 1.5, 6.85, 0.85, 1.72, SH)
  box(4.35, 0.42, 1.72, 4.55, 0.6, 2.45, SHd)
  box(6.0, 0, 2.45, 6.85, 0.42, 3.15, SH)
  for (const x of [5.17, 6.0]) b.line([x, 0.42, 1.72], [x, 0.42, 2.45], SHd)
  for (const x of [5.17, 6.0]) b.line([x, 0.42, 1.72], [x, 0.85, 1.72], SHd)
  // TV on its low stand against the bedroom wall, the strip glowing behind it
  box(4.6, 0, 3.78, 6.4, 0.45, 4.14, SH)
  b.line([5.5, 0.06, 3.78], [5.5, 0.4, 3.78], SHd)
  b.rect([5.6, 0.95, 3.97], X, Y, 1.44, 0.82, SH, 0.01)
  b.rect([5.6, 0.95, 3.965], X, Y, 1.38, 0.76, SHd)
  for (const x of [5.05, 6.15]) b.line([x, 0.45, 3.98], [x, 0.54, 3.98], SHd)
  if (!hasLight.has('light.tv_strip')) b.rect([5.6, 0.95, 4.04], X, Y, 1.24, 0.62, SHd)

  // ---------- desk corner: the L-desk by the windows, thor, odin ----------

  box(5.3, 0.72, 0.08, 7.92, 0.76, 0.73, SH)
  box(7.3, 0.72, 0.73, 7.92, 0.76, 2.2, SH)
  for (const [x, z] of [[5.35, 0.13], [5.35, 0.68], [7.87, 0.13], [7.35, 2.15], [7.87, 2.15]]) b.line([x, 0, z], [x, 0.72, z], SHd)
  b.line([5.35, 0.12, 0.4], [7.87, 0.12, 0.4], MESH)
  // two monitors and the vertical one, keyboard
  monitor([5.76, 1.1, 0.34], [Math.sin(0.4), Math.cos(0.4)], 0.55, 0.33)
  monitor([6.33, 1.12, 0.3], [0, 1], 0.64, 0.37)
  monitor([6.8, 1.2, 0.3], [0, 1], 0.32, 0.58)
  b.rect([6.3, 0.765, 0.58], X, Z, 0.46, 0.14, SHd, 0.01)
  // thor: black tower, three intake fans behind the front glass
  b.chamferBox([7.1, 1.01, 0.44], [0.12, 0.25, 0.23], 0.02, (axis, s) => (axis === 2 && s === 1 ? SH : SHd), SHd)
  for (let k = 0; k < 3; k++) b.circle([7.1, 0.84 + k * 0.15, 0.672], X, Y, 0.06, 12, hot('fans', 0.9))
  // the Office lamp: black arm lamp behind thor, its head aimed at the wall
  b.circle([7.28, 0.765, 0.16], X, Z, 0.06, 10, SHd)
  b.poly([[7.28, 0.77, 0.16], [7.3, 1.2, 0.26], [7.15, 1.45, 0.17]], false, SH)
  b.line([7.15, 1.45, 0.17], [7.13, 1.43, 0.13], SH)
  if (!hasLight.has('light.office_lamp')) b.circle(SPOTS['light.office_lamp'], X, Y, 0.06, 12, SHd)
  // gaming chair facing the desk
  b.rect([6.3, 0.5, 1.12], X, Z, 0.5, 0.48, SH, 0.06)
  b.rect([6.3, 0.92, 1.38], X, Y, 0.48, 0.8, SH, 0.1)
  b.line([6.3, 0.5, 1.12], [6.3, 0.09, 1.12], SHd)
  for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; b.line([6.3, 0.09, 1.12], [6.3 + Math.cos(a) * 0.3, 0.03, 1.12 + Math.sin(a) * 0.3], SHd) }
  // odin on the return under the window: the laptop on its stand, the 4-bay with the router on top, fan, purifier
  b.poly([[7.4, 0.76, 0.92], [7.62, 0.9, 0.92], [7.62, 0.9, 1.28], [7.4, 0.76, 1.28]], true, SHd)
  b.rect([7.52, 0.86, 1.1], [Math.cos(0.55), Math.sin(0.55), 0], Z, 0.26, 0.38, SH)
  b.rect([7.66, 1.07, 1.1], [Math.sin(0.25), Math.cos(0.25), 0], Z, 0.24, 0.38, SH)
  box(7.48, 0.76, 1.42, 7.72, 1.0, 1.66, SH)
  for (const z of [1.48, 1.54, 1.6]) b.line([7.48, 0.78, z], [7.48, 0.98, z], SHd)
  box(7.44, 1.0, 1.4, 7.76, 1.04, 1.7, SHd)
  b.circle([7.62, 1.0, 1.95], Z, Y, 0.12, 14, SHd)
  b.line([7.62, 0.76, 1.95], [7.62, 0.88, 1.95], SHd)
  b.circle([7.75, 0.76, 2.1], X, Z, 0.08, 10, SHd)
  b.circle([7.75, 1.08, 2.1], X, Z, 0.08, 10, SHd)
  for (const a of [0, Math.PI]) b.line([7.75 + Math.cos(a) * 0.08, 0.76, 2.1], [7.75 + Math.cos(a) * 0.08, 1.08, 2.1], SHd)

  // ---------- kitchen: fridge by the laundry, sink run and dishwasher, range with the microwave above ----------

  box(0.08, 0, 3.18, 0.82, 1.8, 3.9, SH)
  b.line([0.82, 0.68, 3.18], [0.82, 0.68, 3.9], SHd)
  b.line([0.82, 0.68, 3.54], [0.82, 1.8, 3.54], SHd)
  // west run with the sink and the dishwasher next to the fridge
  box(0.08, 0, 3.9, 0.7, 0.9, 5.64, SH)
  b.rect([0.42, 0.905, 4.85], X, Z, 0.34, 0.5, SHd, 0.06)
  b.rect([0.7, 0.45, 4.2], Z, Y, 0.56, 0.78, SHd)
  // south run with the range
  box(0.7, 0, 5.02, 2.6, 0.9, 5.64, SH)
  b.rect([1.93, 0.45, 5.02], X, Y, 0.62, 0.5, SHd)
  for (const [x, z] of [[1.75, 5.18], [2.11, 5.18], [1.75, 5.46], [2.11, 5.46]]) b.circle([x, 0.905, z], X, Z, 0.07, 10, SHd)
  box(1.55, 1.45, 5.26, 2.31, 1.82, 5.64, SH, SHd, SHd)
  // the upper cabinets over the sink run; the Kitchen Light bar lies on top of them and washes the ceiling
  box(0.08, 1.45, 3.9, 0.42, 2.15, 5.64, SH, SHd, SHd)
  for (const z of [4.48, 5.06]) b.line([0.42, 1.45, z], [0.42, 2.15, z], SHd)
  if (!hasLight.has('light.kitche_light')) box(0.16, 2.15, 4.3, 0.28, 2.19, 5.2, SHd)

  // ---------- hall: runner, the basket by the bathroom door and the robot vacuum at the end ----------

  floorRect(3.25, 4.9, 3.85, 7.3, 0.01, MESH)
  floorRect(3.32, 5.0, 3.78, 7.2, 0.01, MESH)
  box(3.1, 0, 7.5, 3.55, 0.45, 7.88, SHd)
  b.circle([3.84, 0.02, 7.7], X, Z, 0.17, 14, SHd)
  b.circle([3.84, 0.09, 7.7], X, Z, 0.17, 14, SHd)

  // ---------- bedroom: bed under the window, dresser, the globe lamp on its round table by the door ----------

  box(6.15, 0, 5.95, 7.75, 0.3, 7.92, SH)
  box(6.18, 0.3, 5.98, 7.72, 0.55, 7.9, SH)
  b.rect([6.95, 0.55, 7.92], X, Y, 1.66, 1.1, SH, 0.04)
  for (const x of [6.58, 7.32]) b.rect([x, 0.57, 7.6], X, Z, 0.6, 0.34, SHd, 0.06)
  b.line([6.18, 0.56, 6.9], [7.72, 0.56, 6.9], SHd)
  box(4.35, 0, 7.45, 5.55, 0.86, 7.92, SH)
  for (const y of [0.3, 0.58]) b.line([4.35, y, 7.45], [5.55, y, 7.45], SHd)
  b.line([4.95, 0, 7.45], [4.95, 0.86, 7.45], SHd)
  b.circle([4.48, 0.6, 5.72], X, Z, 0.2, 16, SH)
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4
    b.line([4.48 + Math.cos(a) * 0.12, 0.6, 5.72 + Math.sin(a) * 0.12], [4.48 + Math.cos(a) * 0.17, 0, 5.72 + Math.sin(a) * 0.17], SHd)
  }
  if (!hasLight.has('light.dresser')) globe(SPOTS['light.dresser'], 0.14, SHd)

  // ---------- bathroom: tub along the far wall, vanity, toilet ----------

  box(0.08, 0, 7.18, 1.62, 0.5, 7.92, SH)
  b.roundRect([0.85, 0.5, 7.55], X, Z, 1.36, 0.56, 0.18, SHd)
  box(0.08, 0, 6.45, 0.6, 0.85, 7.15, SH)
  b.roundRect([0.36, 0.86, 6.8], Z, X, 0.4, 0.3, 0.12, SHd)
  box(0.08, 0.38, 5.95, 0.3, 0.75, 6.35, SH)
  b.roundRect([0.56, 0.4, 6.15], X, Z, 0.5, 0.36, 0.17, SH)
  b.line([0.4, 0, 6.15], [0.4, 0.38, 6.15], SHd)

  // ---------- the lights ----------

  let spare = 0
  for (const l of lights) {
    const g = hot(`bulb.${l.id}`, 1)
    const p = SPOTS[l.id]
    if (l.id === 'light.office_lamp') {
      // the lamp head: a shade aimed at the wall, the bulb in its mouth
      b.circle(p, X, Y, 0.065, 12, g)
      b.circle([p[0], p[1], p[2] + 0.06], X, Y, 0.035, 10, g)
      for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2; b.line([p[0] + Math.cos(a) * 0.065, p[1] + Math.sin(a) * 0.065, p[2]], [p[0] + Math.cos(a) * 0.035, p[1] + Math.sin(a) * 0.035, p[2] + 0.06], g) }
    } else if (l.id === 'light.tv_strip') {
      // the strip runs round the back of the TV
      b.rect(p, X, Y, 1.24, 0.62, g)
      b.rect([p[0], p[1], p[2] + 0.004], X, Y, 1.18, 0.56, hot(`bulb.${l.id}`, 0.45))
    } else if (l.id === 'light.kitche_light') {
      // an LED bar on top of the upper cabinets
      box(p[0] - 0.06, 2.15, 4.3, p[0] + 0.06, 2.19, 5.2, g)
      b.line([p[0], 2.19, 4.35], [p[0], 2.19, 5.15], g)
    } else if (l.id === 'light.nightsand') {
      // the table lamp: a small base and its glowing globe
      b.circle([p[0], 0.765, p[2]], X, Z, 0.06, 10, SHd)
      b.line([p[0], 0.76, p[2]], [p[0], p[1] - 0.11, p[2]], SHd)
      globe(p, 0.11, g)
    } else if (l.id === 'light.dresser') {
      // the white globe lamp on the round side table
      globe(p, 0.14, g)
    } else {
      // unknown: a bulb hanging in a free spot
      const q = spareSpot(spare++)
      b.line([q[0], 2.2, q[2]], [q[0], q[1] + 0.1, q[2]], SHd)
      globe(q, 0.1, g)
      b.hotspot(l.id, q, l.name)
      continue
    }
    b.hotspot(l.id, p, l.name)
  }

  b.transform((p) => [p[0] - PX, p[1], p[2] - PZ], (d) => d)
  return b.model([0, 0.6, 0], 5.2)
}

export type FitOptions = {
  /** px kept clear on each side (the panel's header band goes in `top`) */
  top?: number
  right?: number
  bottom?: number
  left?: number
  /** share of the clear area the plan may fill, default 0.94 */
  fill?: number
  /** px each hotspot's label runs right of its point, by hotspot id: the fit keeps them inside */
  labels?: Record<string, number>
}

/**
 * The camera distance and screen shift that fit a model into a w x h box (CSS
 * px) seen from `pose`'s angles: every drawn point (and every label in
 * `labels`) inside the clear area, centered in it. Measured by projecting the
 * model's own segments, so it holds for any shape and any angle.
 */
export function fitView(model: Model, pose: CameraPose, w: number, h: number, o: FitOptions = {}): CameraPose {
  const c = compile(model)
  const pos = c.pos
  const n = pos.length / 3
  const step = Math.max(1, Math.floor(n / 2400))
  const top = o.top ?? 0, right = o.right ?? 0, bottom = o.bottom ?? 0, left = o.left ?? 0
  const aw = Math.max(8, w - left - right), ah = Math.max(8, h - top - bottom)
  const fill = o.fill ?? 0.94
  const tags = model.hotspots.filter((x) => (o.labels?.[x.id] ?? 0) > 0)
  const out = [0, 0, 0]
  const measure = (dist: number) => {
    const cam = new Camera({ ...pose, dist, shift: [0, 0] }, c.center)
    cam.basis(w, h)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < n; i += step) {
      if (!cam.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], out)) return null
      if (out[0] < x0) x0 = out[0]
      if (out[0] > x1) x1 = out[0]
      if (out[1] < y0) y0 = out[1]
      if (out[1] > y1) y1 = out[1]
    }
    for (const t of tags) {
      if (!cam.project(t.at[0], t.at[1], t.at[2], out)) return null
      x1 = Math.max(x1, out[0] + (o.labels?.[t.id] ?? 0))
      y0 = Math.min(y0, out[1] - 8)
      y1 = Math.max(y1, out[1] + 8)
    }
    return { x0, x1, y0, y1 }
  }
  const fits = (m: ReturnType<typeof measure>) => !!m && m.x1 - m.x0 <= aw * fill && m.y1 - m.y0 <= ah * fill
  let lo = c.radius * 0.8, hi = c.radius * 80
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2
    if (fits(measure(mid))) hi = mid
    else lo = mid
  }
  const m = measure(hi)
  if (!m) return pose
  const sx = (left + aw / 2 - (m.x0 + m.x1) / 2) / w
  const sy = (top + ah / 2 - (m.y0 + m.y1) / 2) / h
  return { ...pose, dist: Math.round(hi * 100) / 100, shift: [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000] }
}

/**
 * The apartment's camera for a w x h box: APARTMENT_POSE's side and height for
 * a squarish box, lower for a wide short one (a lower camera draws the plan
 * wider than deep, so it fills the box), fitted with fitView.
 */
export function apartmentView(model: Model, w: number, h: number, o: FitOptions = {}): CameraPose {
  const aw = w - (o.left ?? 0) - (o.right ?? 0), ah = h - (o.top ?? 0) - (o.bottom ?? 0)
  const k = Math.min(1, Math.max(0, (aw / Math.max(1, ah) - 1.4) / 1.2))
  return fitView(model, { ...APARTMENT_POSE, pitch: APARTMENT_POSE.pitch - k * 12 }, w, h, o)
}
