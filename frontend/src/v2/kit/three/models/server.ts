// odin in x-ray: a compact 5-bay storage server. Front (+z) holds the drive
// trays, the backplane splits the box, and the rear section carries a Mini-ITX
// board (cpu, mem), the PSU and a big exhaust fan.

import type { Model, Vec3 } from '../engine'
import type { Beam, Flow } from '../render'
import { AX, Builder, type Style } from './build'

const { X, Y, Z } = AX
const HX = 1.8, Y0 = 0.2, Y1 = 3.2, HZ = 2.2
const CY = (Y0 + Y1) / 2

const SH: Style = { layer: 'shell' }
const SHd: Style = { layer: 'shell', w: 0.55 }
const FG: Style = { layer: 'fg' }
const FGd: Style = { layer: 'fg', w: 0.55 }
const MESHd: Style = { layer: 'mesh', w: 0.6 }
const ACC: Style = { layer: 'mesh' }
const hot = (group: string, w = 1): Style => ({ layer: 'hot', group, w })

export function odinServer(): Model {
  const b = new Builder()

  b.chamferBox([0, CY, 0], [HX, (Y1 - Y0) / 2, HZ], 0.14,
    (axis, s) => (axis === 2 && s === 1) || (axis === 1 && s === 1) ? FG : axis === 0 && s === 1 ? FGd : SH, SH)
  // side panels: fine mesh on +x, coarse on -x
  b.grid([HX + 0.004, CY, 0], Z, Y, 2 * HZ - 0.3, Y1 - Y0 - 0.3, 0.13, { layer: 'mesh', w: 0.45 }, 5)
  b.grid([-HX - 0.004, CY, 0], Z, Y, 2 * HZ - 0.3, Y1 - Y0 - 0.3, 0.36, { layer: 'mesh', w: 0.4 }, 3)
  b.face([[HX, Y0 + 0.14, -HZ + 0.14], [HX, Y0 + 0.14, HZ - 0.14], [HX, Y1 - 0.14, HZ - 0.14], [HX, Y1 - 0.14, -HZ + 0.14]], 'fg', 0.8)
  b.face([[-HX + 0.14, Y1, -HZ + 0.14], [HX - 0.14, Y1, -HZ + 0.14], [HX - 0.14, Y1, HZ - 0.14], [-HX + 0.14, Y1, HZ - 0.14]], 'fg', 0.35)
  b.face([[-HX + 0.14, Y0 + 0.14, HZ], [HX - 0.14, Y0 + 0.14, HZ], [HX - 0.14, Y1 - 0.14, HZ], [-HX + 0.14, Y1 - 0.14, HZ]], 'fg', 0.4)
  // top vent
  for (let z = -1.9; z <= -0.4; z += 0.09) b.lineN([-1.3, Y1 + 0.004, z], [1.3, Y1 + 0.004, z], 3, MESHd)
  b.rect([0, Y1 + 0.004, -1.15], X, Z, 2.8, 1.75, SHd, 0.06)

  // front: status strip, five trays, light bar
  const fz = HZ + 0.004
  b.rect([0, Y1 - 0.28, fz], X, Y, 2 * HX - 0.4, 0.3, SHd, 0.04)
  b.circle([1.35, Y1 - 0.28, fz + 0.005], X, Y, 0.08, 14, FG)
  for (let i = 0; i < 5; i++) b.circle([-1.3 + i * 0.18, Y1 - 0.28, fz + 0.005], X, Y, 0.025, 6, hot('disk', 1))
  b.rect([0, Y0 + 0.12, fz + 0.01], X, Y, 2.6, 0.04, ACC)
  for (let i = 0; i < 5; i++) {
    const x = -1.36 + i * 0.68
    const D = hot('disk', 0.9)
    b.rect([x, 1.55, fz], X, Y, 0.6, 2.2, SH, 0.05)
    b.rect([x, 0.85, fz + 0.01], X, Y, 0.4, 0.5, SHd, 0.04)
    for (let k = 0; k < 6; k++) b.line([x - 0.2, 1.3 + k * 0.18, fz + 0.005], [x + 0.2, 1.3 + k * 0.18, fz + 0.005], MESHd)
    b.circle([x, 2.48, fz + 0.01], X, Y, 0.03, 6, hot('disk', 1))
    // the drive behind it, platter and actuator arm in x-ray
    const z0 = HZ - 0.15, z1 = HZ - 2.35
    b.box([x - 0.2, 0.45, z1], [x + 0.2, 2.6, z0], D)
    const pc: Vec3 = [x + 0.205, 1.6, (z0 + z1) / 2 + 0.25]
    b.circle(pc, Z, Y, 0.72, 32, hot('disk', 0.55))
    b.circle(pc, Z, Y, 0.18, 14, hot('disk', 0.7))
    const from = b.segs.length
    b.line([pc[0], pc[1] + 0.2, pc[2]], [pc[0], pc[1] + 0.68, pc[2]], hot('disk', 0.8))
    b.spins.push({ from, to: b.segs.length, center: pc, axis: X, speed: 1.2, group: 'disk' })
    b.poly([[pc[0], 0.75, z1 + 0.35], [pc[0], 1.1, z1 + 0.9], [pc[0], 1.45, pc[2] + 0.05]], false, hot('disk', 0.8))
    b.circle([pc[0], 0.75, z1 + 0.35], Z, Y, 0.1, 10, hot('disk', 0.6))
    b.rect([x + 0.205, 2.25, (z0 + z1) / 2], Z, Y, 1.4, 0.4, hot('disk', 0.35), 0.03)
  }

  // backplane
  const zb = -0.25
  b.rect([0, 1.55, zb], X, Y, 3.3, 2.3, hot('board', 0.6), 0.04)
  for (let i = 0; i < 5; i++) b.box([-1.36 + i * 0.68 - 0.18, 0.8, zb - 0.06], [-1.36 + i * 0.68 + 0.18, 0.95, zb], hot('board', 0.5))
  for (let i = 0; i < 4; i++) b.lineN([-1.5, 1.4 + i * 0.05, zb - 0.002], [1.5, 1.4 + i * 0.05, zb - 0.002], 6, hot('board', 0.35))

  // rear section: Mini-ITX board on the floor of the case
  const by = 0.42
  b.rect([-0.55, by, -1.3], X, Z, 1.7, 1.7, hot('board', 0.6), 0.03)
  for (let i = 0; i < 5; i++) b.poly([[-1.2, by + 0.003, -1.9 + i * 0.05], [-0.7, by + 0.003, -1.9 + i * 0.05], [-0.55, by + 0.003, -1.75 + i * 0.05], [-0.2, by + 0.003, -1.75 + i * 0.05]], false, hot('board', 0.35))
  // cpu cooler: fin tower + small fan
  const C = hot('cpu', 0.9)
  b.box([-0.95, by, -1.6], [-0.35, by + 0.9, -1.0], C)
  for (let y = by + 0.1; y < by + 0.9; y += 0.06) b.rect([-0.65, y, -1.3], X, Z, 0.6, 0.6, hot('cpu', 0.3))
  b.fan([-0.65, by + 0.55, -0.95], X, Y, 0.62, { frame: hot('cpu', 0.5), ring: C, blade: hot('cpu', 0.7), blades: 7, depth: 0.1, speed: 1.1, group: 'cpu' })
  // two SO-DIMMs lying flat
  for (const z of [-0.65, -0.48]) {
    b.box([-1.25, by, z - 0.06], [0.1, by + 0.05, z + 0.06], hot('mem', 0.9))
    for (let k = 0; k < 4; k++) b.rect([-1.05 + k * 0.32, by + 0.052, z], X, Z, 0.2, 0.09, hot('mem', 0.45))
  }
  // PSU
  b.box([0.55, by - 0.15, -2.1], [1.65, by + 0.75, -0.75], hot('psu', 0.8))
  for (let z = -2.0; z < -0.85; z += 0.08) b.line([1.1, by + 0.75, z], [1.6, by + 0.75, z], hot('psu', 0.35))
  // rear exhaust fan + grill
  b.fan([0.55, 2.15, -HZ + 0.18], X, Y, 1.7, { frame: SHd, ring: hot('fans', 0.9), blade: hot('fans', 0.75), blades: 7, depth: 0.25, speed: 0.8 })
  for (const r of [0.78, 0.6, 0.42, 0.24]) b.circle([0.55, 2.15, -HZ - 0.004], X, Y, r, 36, MESHd)
  // rear IO + power
  b.rect([-1.1, 1.1, -HZ - 0.004], X, Y, 0.5, 1.2, SH)
  for (let k = 0; k < 5; k++) b.rect([-1.1, 0.65 + k * 0.2, -HZ - 0.008], X, Y, 0.3, 0.08, SHd)
  b.rect([1.2, 0.7, -HZ - 0.004], X, Y, 0.35, 0.25, SH)
  // cables from the PSU to the backplane
  for (let i = 0; i < 4; i++) b.curve([0.7 + i * 0.06, by + 0.75, -0.8], [0.7 + i * 0.06, 1.6, -0.6], [0.2 + i * 0.05, 1.0, -0.4], [0.0 + i * 0.12, 0.88, zb - 0.06], 10, hot('psu', 0.4))

  // feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.chamferBox([sx * 1.4, Y0 / 2, sz * 1.8], [0.22, Y0 / 2, 0.22], 0.04, () => SH, SHd)

  b.hotspot('disk', [0, 2.48, HZ + 0.02], 'Drives')
  b.hotspot('cpu', [-0.65, by + 0.95, -1.3], 'CPU')
  b.hotspot('mem', [-0.6, by + 0.08, -0.56], 'Memory')
  b.hotspot('fans', [0.55, 2.15, -HZ - 0.02], 'Exhaust')

  return b.model([0, CY, 0], 3.4)
}

export const SERVER_FX: { beams: Beam[]; flow: Flow[] } = {
  beams: [{ from: [0, 0.4, HZ + 0.05], dir: [0, -0.22, 1], spread: 24, length: 9, intensity: 0.6 }],
  flow: [
    { from: [0, 1.5, HZ + 2.2], to: [0.55, 2.15, -HZ - 2.4], via: [0.3, 1.8, 0], speed: 2.2, spread: 0.7, lanes: 12 },
  ],
}
