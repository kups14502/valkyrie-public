// thor in x-ray: a modern glass-side mid tower (units ~100 mm).
// Front panel faces +z, the glass side panel is +x (the side the home pose
// sees), the motherboard hangs on the -x wall. Floor at y = 0.
//
// Groups: cpu (pump, block, radiator, hoses), mem (4 DIMMs), gpu (card and its
// fans), disk (NVMe x2 + 2.5in SSD), fans (case fans), psu (PSU, cables).

import type { Model, Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX

const HX = 1.15, Y0 = 0.2, Y1 = 5.2, HZ = 2.4
const CY = (Y0 + Y1) / 2

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.55 }
const MESH: Style = { layer: 'mesh' }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

/** Map a point in the board plane (z, y) to world, `lift` toward the glass. */
const onBoard = (z: number, y: number, lift = 0): Vec3 => [-0.9 + lift, y, z]

function traces(b: Builder, path: [number, number][], count: number, pitch: number, st: Style) {
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * pitch
    const pts: Vec3[] = path.map(([z, y], k) => {
      // offset perpendicular to the local direction
      const [pz, py] = path[Math.max(0, k - 1)]
      const [nz, ny] = path[Math.min(path.length - 1, k + 1)]
      const dz = nz - pz, dy = ny - py
      const l = Math.hypot(dz, dy) || 1
      return onBoard(z + (-dy / l) * off, y + (dz / l) * off, 0.005)
    })
    b.poly(pts, false, st)
  }
}

export function thorTower(): Model {
  const b = new Builder()

  // ---------- case shell ----------
  b.chamferBox([0, CY, 0], [HX, (Y1 - Y0) / 2, HZ], 0.12,
    (axis, s) => (axis === 2 && s === 1) || (axis === 1 && s === 1) ? FG : axis === 0 && s === 1 ? FGd : SH, SH)

  // glass side panel (+x): frame, glass edge, fine mesh, glass face
  const gx = HX + 0.004
  b.rect([gx, CY, 0], Z, Y, 2 * HZ - 0.2, Y1 - Y0 - 0.2, SH, 0.05)
  b.grid([gx, CY, 0], Z, Y, 2 * HZ - 0.2, Y1 - Y0 - 0.2, 0.115, { layer: 'mesh', w: 0.75 }, 6)
  b.face([[gx, Y0 + 0.1, -HZ + 0.1], [gx, Y0 + 0.1, HZ - 0.1], [gx, Y1 - 0.1, HZ - 0.1], [gx, Y1 - 0.1, -HZ + 0.1]], 'fg', 1)
  // thumb screws on the glass corners
  for (const [z, y] of [[-HZ + 0.22, Y0 + 0.22], [HZ - 0.22, Y0 + 0.22], [HZ - 0.22, Y1 - 0.22], [-HZ + 0.22, Y1 - 0.22]]) {
    b.circle([gx + 0.01, y, z], Z, Y, 0.045, 8, SH)
  }

  // solid side (-x): stamped ribs and a coarse faint grid
  b.grid([-HX - 0.004, CY, 0], Z, Y, 2 * HZ - 0.3, Y1 - Y0 - 0.3, 0.38, { layer: 'mesh', w: 0.4 }, 3)
  b.face([[-HX, Y0 + 0.12, -HZ + 0.12], [-HX, Y0 + 0.12, HZ - 0.12], [-HX, Y1 - 0.12, HZ - 0.12], [-HX, Y1 - 0.12, -HZ + 0.12]], 'fg', 0.35)

  // front panel (+z): inset frame, perforated mesh, light bar
  const fz = HZ + 0.004
  b.rect([0, CY, fz], X, Y, 2 * HX - 0.26, Y1 - Y0 - 0.3, SHd, 0.06)
  b.hatch([0, CY + 0.08, fz], X, Y, 2 * HX - 0.34, Y1 - Y0 - 0.55, 0.1, MESHd)
  b.face([[-HX + 0.12, Y0 + 0.12, HZ], [HX - 0.12, Y0 + 0.12, HZ], [HX - 0.12, Y1 - 0.12, HZ], [-HX + 0.12, Y1 - 0.12, HZ]], 'fg', 0.45)
  b.rect([0, Y0 + 0.2, fz + 0.01], X, Y, 1.7, 0.045, ACC)
  // power button + IO on the top front edge
  b.circle([0.55, Y1 + 0.004, HZ - 0.32], X, Z, 0.07, 12, FG)
  b.rect([0.2, Y1 + 0.004, HZ - 0.32], X, Z, 0.12, 0.06, SH)
  b.rect([0.02, Y1 + 0.004, HZ - 0.32], X, Z, 0.12, 0.06, SH)
  b.rect([-0.2, Y1 + 0.004, HZ - 0.32], X, Z, 0.16, 0.05, SH)

  // top panel: vent slats over the radiator
  for (let z = -1.95; z <= 1.75; z += 0.1) b.lineN([-0.75, Y1 + 0.004, z], [0.95, Y1 + 0.004, z], 2, MESHd)
  b.rect([0.1, Y1 + 0.004, -0.1], X, Z, 1.8, 3.9, SHd, 0.05)
  b.face([[-HX + 0.12, Y1, -HZ + 0.12], [HX - 0.12, Y1, -HZ + 0.12], [HX - 0.12, Y1, HZ - 0.12], [-HX + 0.12, Y1, HZ - 0.12]], 'fg', 0.35)

  // rear (-z): IO shield, exhaust grill, PCI slot covers, PSU opening, rear glow bar
  const rz = -HZ - 0.004
  b.rect([-0.66, 3.95, rz], X, Y, 0.42, 1.55, SH)
  for (let y = 3.35; y <= 4.6; y += 0.16) b.rect([-0.7, y, rz - 0.005], X, Y, 0.18, 0.06, SHd)
  for (const r of [0.55, 0.42, 0.29, 0.16]) b.circle([0.3, 4.0, rz], X, Y, r, 32, MESH)
  for (let k = 0; k < 7; k++) b.rect([-0.18, 3.0 - k * 0.2, rz], X, Y, 1.3, 0.14, SHd)
  b.rect([-0.18, 2.4, rz], X, Y, 1.45, 1.5, SH, 0.04)
  b.rect([-0.25, 0.68, rz], X, Y, 1.5, 0.86, SH, 0.03)
  b.grid([-0.4, 0.68, rz - 0.003], X, Y, 1.0, 0.7, 0.07, MESHd, 2)
  b.rect([0.25, 0.85, rz - 0.005], X, Y, 0.2, 0.16, SH)
  b.rect([0.25, 0.55, rz - 0.005], X, Y, 0.1, 0.16, SH)
  b.rect([0, Y1 - 0.2, rz - 0.01], X, Y, 1.9, 0.04, ACC)
  b.face([[-HX + 0.12, Y0 + 0.12, -HZ], [HX - 0.12, Y0 + 0.12, -HZ], [HX - 0.12, Y1 - 0.12, -HZ], [-HX + 0.12, Y1 - 0.12, -HZ]], 'fg', 0.3)

  // feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.chamferBox([sx * 0.8, Y0 / 2, sz * 1.95], [0.2, Y0 / 2, 0.32], 0.04, () => SH, SHd)
  }

  // ---------- front intake fans (they cast the beams) ----------
  for (const y of [1.02, 2.47, 3.92]) {
    b.fan([0, y, HZ - 0.3], X, Y, 1.4, { frame: SHd, ring: FG, blade: hot('fans', 0.85), blades: 7, speed: 0.8 })
  }

  // ---------- top radiator + fans (cpu loop) ----------
  const rx0 = -0.45, rx1 = 0.75, ry0 = 4.8, ry1 = 5.06, rz0 = -1.9, rz1 = 1.7
  b.box([rx0, ry0, rz0], [rx1, ry1, rz1], hot('cpu', 0.55))
  b.box([rx0 - 0.05, ry0 - 0.03, rz0 - 0.22], [rx1 + 0.05, ry1 + 0.02, rz0], hot('cpu', 0.7))
  b.box([rx0 - 0.05, ry0 - 0.03, rz1], [rx1 + 0.05, ry1 + 0.02, rz1 + 0.22], hot('cpu', 0.7))
  for (let z = rz0 + 0.05; z < rz1; z += 0.05) b.line([rx0, ry0, z], [rx1, ry0, z], hot('cpu.rad', 0.28))
  for (let z = rz0 + 0.06; z < rz1; z += 0.06) b.line([rx1, ry0, z], [rx1, ry1, z], hot('cpu.rad', 0.3))
  for (let x = rx0 + 0.15; x < rx1; x += 0.2) b.lineN([x, ry0 - 0.002, rz0], [x, ry0 - 0.002, rz1], 6, hot('cpu.rad', 0.4))
  for (const z of [-1.3, -0.1, 1.1]) {
    b.fan([0.15, 4.63, z], X, Z, 1.2, { frame: SHd, ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 9, depth: 0.25, speed: 0.9 })
  }

  // ---------- rear exhaust fan ----------
  b.fan([0.3, 4.0, -HZ + 0.2], X, Y, 1.2, { frame: SHd, ring: hot('fans', 0.85), blade: hot('fans', 0.7), blades: 7, depth: 0.25, speed: 0.9 })

  // ---------- motherboard ----------
  const BRD = hot('board', 0.6)
  const BRDd = hot('board', 0.38)
  b.rect(onBoard(-1.025, 3.125), Z, Y, 2.45, 3.05, BRD, 0.03)
  for (const [z, y] of [[-2.1, 1.75], [-2.1, 4.5], [0.05, 1.75], [0.05, 4.5], [-1.0, 1.75], [-1.0, 4.5], [0.05, 3.1], [-2.1, 3.1]]) {
    b.circle(onBoard(z, y, 0.004), Z, Y, 0.035, 8, BRD)
    b.line([-1.06, y, z], onBoard(z, y), SHd)
  }
  // pcb traces: socket -> dimms, socket -> pcie, chipset fan-out
  traces(b, [[-1.05, 3.72], [-0.9, 3.72], [-0.8, 3.62], [-0.72, 3.62]], 7, 0.035, BRDd)
  traces(b, [[-1.05, 4.0], [-0.9, 4.0], [-0.8, 4.1], [-0.72, 4.1]], 7, 0.035, BRDd)
  traces(b, [[-1.55, 3.5], [-1.55, 3.3], [-1.7, 3.15], [-1.95, 3.15]], 6, 0.035, BRDd)
  traces(b, [[-0.2, 2.5], [-0.2, 2.7], [-0.45, 2.95], [-0.8, 2.95], [-0.95, 3.1]], 5, 0.035, BRDd)
  traces(b, [[-0.5, 2.2], [-0.8, 2.2], [-1.0, 2.0], [-1.9, 2.0]], 6, 0.03, BRDd)
  traces(b, [[0.0, 2.0], [0.0, 1.8], [-0.2, 1.68], [-1.4, 1.68]], 4, 0.03, BRDd)
  traces(b, [[-1.9, 4.15], [-2.0, 4.05], [-2.0, 3.5]], 4, 0.035, BRDd)
  // socket keep-out silk + VRM heatsinks
  b.rect(onBoard(-1.35, 3.85, 0.004), Z, Y, 0.86, 0.86, BRDd, 0.02)
  b.box([-0.9, 4.32, -2.05], [-0.72, 4.52, -0.88], hot('cpu', 0.4))
  for (let z = -2.0; z < -0.9; z += 0.07) b.line([-0.72, 4.32, z], [-0.72, 4.52, z], hot('cpu', 0.3))
  b.box([-0.9, 3.0, -2.13], [-0.72, 4.27, -1.92], hot('cpu', 0.4))
  for (let y = 3.05; y < 4.25; y += 0.07) b.line([-0.72, y, -2.13], [-0.72, y, -1.92], hot('cpu', 0.3))
  // EPS 8-pin + 24-pin
  b.box([-0.9, 4.5, -2.22], [-0.78, 4.6, -1.98], hot('psu', 0.6))
  b.box([-0.9, 3.0, 0.07], [-0.74, 3.62, 0.2], hot('psu', 0.6))
  for (let y = 3.05; y < 3.6; y += 0.05) b.line([-0.74, y, 0.07], [-0.74, y, 0.2], hot('psu', 0.35))
  // PCIe + DIMM slots, chipset
  for (const y of [3.08, 2.28, 1.88]) b.box([-0.9, y - 0.03, -2.15], [-0.86, y + 0.03, -0.85], BRDd)
  b.box([-0.9, 1.95, -0.45], [-0.82, 2.45, 0.05], hot('board', 0.55))
  b.line([-0.82, 1.95, -0.45], [-0.82, 2.45, 0.05], hot('board', 0.4))
  b.line([-0.82, 2.45, -0.45], [-0.82, 1.95, 0.05], hot('board', 0.4))
  // IO shield block
  b.box([-0.9, 3.38, -2.36], [-0.56, 4.52, -2.16], BRD)
  // grommets in the tray beside the board
  for (const y of [2.1, 3.3, 4.35]) b.rect([-1.0, y, 0.48], Z, Y, 0.22, 0.6, SHd, 0.08)

  // ---------- CPU: AIO pump block ----------
  const CPU = hot('cpu', 1)
  b.rect(onBoard(-1.35, 3.85, 0.01), Z, Y, 0.62, 0.62, hot('cpu', 0.75), 0.05)
  for (const x of [-0.86, -0.52]) b.circle([x, 3.85, -1.35], Z, Y, 0.33, 32, x > -0.6 ? CPU : hot('cpu', 0.7))
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2
    b.line([-0.86, 3.85 + Math.sin(a) * 0.33, -1.35 + Math.cos(a) * 0.33], [-0.52, 3.85 + Math.sin(a) * 0.33, -1.35 + Math.cos(a) * 0.33], hot('cpu', 0.55))
  }
  b.circle([-0.515, 3.85, -1.35], Z, Y, 0.27, 28, CPU)
  b.circle([-0.512, 3.85, -1.35], Z, Y, 0.235, 28, hot('cpu', 0.8))
  b.circle([-0.51, 3.85, -1.35], Z, Y, 0.1, 14, CPU)
  b.poly([[-0.508, 3.9, -1.35], [-0.508, 3.81, -1.4], [-0.508, 3.81, -1.3]], true, CPU)
  // hoses to the radiator rear tank
  for (const dz of [0, 0.24]) {
    b.tube([-0.6, 4.05, -1.2 + dz * 0.4], [-0.3, 4.55, -1.0 + dz], [0.05, 4.55, -2.0 + dz * 0.2], [0.05 + dz, 4.77, -2.0], 0.04, X, 12, hot('cpu', 0.6))
  }

  // ---------- RAM: 4 DIMMs ----------
  for (const z of [-0.66, -0.54, -0.42, -0.3]) {
    const MEM = hot('mem', 0.9)
    b.box([-0.9, 3.2, z - 0.035], [-0.5, 4.53, z + 0.035], MEM)
    b.line([-0.5, 3.24, z], [-0.5, 4.49, z], hot('mem', 1))
    b.box([-0.9, 3.15, z - 0.045], [-0.87, 4.58, z + 0.045], hot('mem', 0.35))
    for (let k = 0; k < 4; k++) b.rect([-0.74, 3.38 + k * 0.3, z + 0.036], X, Y, 0.18, 0.2, hot('mem', 0.45))
  }

  // ---------- NVMe x2 ----------
  b.box([-0.9, 3.18, -1.78], [-0.83, 3.38, -0.95], hot('disk', 0.9))
  for (let z = -1.72; z < -0.98; z += 0.08) b.line([-0.83, 3.18, z], [-0.83, 3.38, z], hot('disk', 0.45))
  b.box([-0.9, 2.05, -1.6], [-0.86, 2.24, -0.8], hot('disk', 0.75))

  // ---------- GPU ----------
  const G = hot('gpu', 0.9), Gd = hot('gpu', 0.45), Gf = hot('gpu', 0.32)
  const gx0 = -0.88, gx1 = 0.48, gy0 = 2.38, gy1 = 3.02, gz0 = -2.33, gz1 = 0.95
  // shroud: chamfered outline on the glass-facing edge and the far edge
  const edge = (x: number, st: Style) => b.poly([
    [x, gy0 + 0.08, gz0], [x, gy1 - 0.04, gz0], [x, gy1, gz0 + 0.06], [x, gy1, gz1 - 0.22], [x, gy1 - 0.12, gz1],
    [x, gy0 + 0.1, gz1], [x, gy0, gz1 - 0.1], [x, gy0, gz0 + 0.3], [x, gy0 + 0.08, gz0 + 0.2],
  ], true, st)
  edge(gx1, G)
  edge(gx0 + 0.02, Gd)
  for (const [y, z] of [[gy0 + 0.08, gz0], [gy1 - 0.04, gz0], [gy1, gz1 - 0.22], [gy1 - 0.12, gz1], [gy0 + 0.1, gz1], [gy0, gz1 - 0.1], [gy0, gz0 + 0.3]]) {
    b.line([gx0 + 0.02, y, z], [gx1, y, z], Gd)
  }
  // angular accent lines on the glass-facing edge + LED strip
  b.poly([[gx1 + 0.003, gy0 + 0.14, gz0 + 0.5], [gx1 + 0.003, gy0 + 0.14, -0.7], [gx1 + 0.003, gy0 + 0.3, -0.45], [gx1 + 0.003, gy0 + 0.3, 0.6]], false, G)
  b.lineN([gx1 + 0.004, gy1 - 0.05, gz0 + 0.3], [gx1 + 0.004, gy1 - 0.05, gz1 - 0.3], 6, hot('gpu', 1))
  // fin stack seen through the edge
  for (let z = gz0 + 0.15; z < gz1 - 0.15; z += 0.05) b.line([gx1 - 0.01, gy0 + 0.36, z], [gx1 - 0.01, gy1 - 0.1, z], Gf)
  // heat pipes with U-bends
  for (const [k, y] of [[0, 2.62], [1, 2.72], [2, 2.82]] as const) {
    b.lineN([0.25 - k * 0.12, y, gz0 + 0.3], [0.25 - k * 0.12, y, gz1 - 0.25], 6, Gd)
    b.circle([0.25 - k * 0.12 - 0.15, y, gz1 - 0.25], X, Z, 0.15, 10, Gd, 0, Math.PI)
  }
  // backplate (top) with cutouts
  b.rect([(gx0 + gx1) / 2, gy1 + 0.003, (gz0 + gz1) / 2], X, Z, gx1 - gx0 - 0.08, gz1 - gz0 - 0.1, Gd, 0.06)
  b.poly([[0.1, gy1 + 0.005, -0.2], [0.3, gy1 + 0.005, 0.0], [0.3, gy1 + 0.005, 0.7], [-0.5, gy1 + 0.005, 0.7], [-0.5, gy1 + 0.005, 0.2]], true, Gf)
  for (let z = -2.1; z < -0.6; z += 0.12) b.rect([-0.1, gy1 + 0.005, z], X, Z, 0.5, 0.04, Gf)
  // fans underneath, blowing down at the shroud
  for (const z of [-1.55, -0.45, 0.62]) {
    b.fan([-0.2, gy0 - 0.02, z], X, Z, 1.0, { frame: Gd, ring: G, blade: hot('gpu', 0.75), blades: 9, depth: 0.08, speed: 0.7, group: 'gpu', bare: true })
  }
  // power connector + cable down through the shroud
  b.box([0.18, gy1, 0.1], [0.4, gy1 + 0.09, 0.36], G)
  for (let i = 0; i < 4; i++) {
    const o = i * 0.045
    b.curve([0.22 + o, gy1 + 0.09, 0.23], [0.24 + o, 3.55, 0.3], [0.75, 3.4, 1.25 + o * 0.5], [0.6 + o * 0.3, 1.36, 1.45], 14, hot('psu', 0.45))
  }
  // PCIe bracket on the rear
  b.rect([-0.18, (gy0 + gy1) / 2, -HZ + 0.03], X, Y, 1.36, 0.62, G, 0.02)
  for (const x of [-0.6, -0.3, 0.0, 0.3]) b.rect([x, 2.82, -HZ + 0.025], X, Y, 0.18, 0.08, Gd)

  // ---------- PSU shroud (part of the case) ----------
  b.box([-HX + 0.03, Y0, -HZ + 0.03], [HX - 0.03, 1.36, 1.84], { layer: 'shell', w: 0.75 }, { bottom: true })
  for (let z = -2.1; z < 1.6; z += 0.3) for (const x of [0.15, 0.7]) b.rect([x, 1.364, z], X, Z, 0.38, 0.05, MESH)
  b.rect([-0.66, 1.364, 0.5], X, Z, 0.42, 0.7, SH, 0.06)
  b.rect([HX - 0.026, 0.78, -1.55], Z, Y, 1.5, 0.75, SH, 0.04)
  for (let y = 0.52; y < 1.06; y += 0.06) b.line([HX - 0.024, y, -2.25], [HX - 0.024, y, -0.85], MESHd)

  // ---------- PSU ----------
  const P = hot('psu', 0.8), Pd = hot('psu', 0.4)
  b.box([-1.0, 0.26, -2.34], [0.5, 1.12, -0.74], P)
  b.fan([-0.25, 0.27, -1.54], X, Z, 1.2, { frame: Pd, ring: P, blade: hot('psu', 0.6), blades: 7, depth: 0.06, speed: 0.6, group: 'psu', bare: true })
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) b.rect([-0.75 + i * 0.32, 0.55 + j * 0.3, -0.735], X, Y, 0.22, 0.16, Pd)
  b.rect([0.501, 0.69, -1.54], Z, Y, 0.9, 0.5, Pd, 0.04)

  // ---------- 2.5in SSD on the shroud ----------
  b.box([0.2, 1.365, 0.35], [0.9, 1.44, 1.35], hot('disk', 0.95))
  b.rect([0.55, 1.442, 0.9], X, Z, 0.5, 0.6, hot('disk', 0.5), 0.04)
  b.rect([0.55, 1.4, 0.345], X, Y, 0.4, 0.04, hot('disk', 0.6))
  b.curve([0.4, 1.4, 0.34], [0.4, 1.42, 0.0], [-0.2, 1.42, 0.2], [-0.6, 1.37, 0.4], 10, hot('psu', 0.4))

  // ---------- cables: 24-pin bundle, EPS ----------
  for (let i = 0; i < 6; i++) {
    const o = i * 0.05
    b.curve([-0.78, 1.37, 0.3 + o], [-0.72, 2.0, 0.95 + o * 0.4], [-0.74, 3.0, 0.75], [-0.76, 3.08 + i * 0.09, 0.21], 14, hot('psu', 0.42))
  }
  for (let i = 0; i < 3; i++) b.curve([-1.0, 5.02, -2.05 + i * 0.05], [-0.95, 4.95, -2.1], [-0.85, 4.8, -2.1], [-0.84, 4.6, -2.15 + i * 0.07], 6, hot('psu', 0.42))

  // ---------- hotspots ----------
  b.hotspot('cpu', [-0.5, 3.85, -1.35], 'CPU')
  b.hotspot('mem', [-0.5, 4.5, -0.48], 'Memory')
  b.hotspot('gpu', [gx1, 2.72, -0.75], 'GPU')
  b.hotspot('disk', [0.6, 1.46, 0.85], 'Disk')

  return b.model([0, CY, 0])
}

/** Front-fan light beams and the case airflow, ready for WireScene. Scale `speed` by load. */
export const TOWER_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [
    { from: [0, 1.02, HZ + 0.05], dir: [0, -0.3, 1], spread: 20, length: 10, intensity: 0.75 },
    { from: [0, 2.47, HZ + 0.05], dir: [0, -0.36, 1], spread: 17, length: 11, intensity: 0.55 },
  ],
  flow: [
    { from: [0.1, 2.5, HZ + 3.2], to: [0.3, 3.9, -HZ - 3.4], via: [0.15, 2.8, 0], speed: 2.8, spread: 0.95, lanes: 14 },
    { from: [0.1, 1.3, HZ + 3.0], to: [0.2, Y1 + 1.6, -HZ - 2.8], via: [0.15, 4.6, 0.2], speed: 2.4, spread: 0.55, lanes: 9 },
  ],
}
