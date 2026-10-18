// Geometry helpers for the wireframe models. Everything appends Seg records
// to one list so the models read like a parts list.

import { add, bezier, cross, norm, rotateAround, scale, sub, type Face, type Hotspot, type Layer, type Model, type Seg, type Spin, type Vec3 } from '../engine'

export type Style = { layer: Layer; group?: string; w?: number }

const X: Vec3 = [1, 0, 0]
const Y: Vec3 = [0, 1, 0]
const Z: Vec3 = [0, 0, 1]
export const AX = { X, Y, Z }

/**
 * A rounded rectangle (half sizes hw, hh, corner radius r) sampled at N points
 * spaced evenly by arc length, symmetric in both axes, starting at (hw, 0) and
 * running counterclockwise. N must be a multiple of 4. Loops sampled with the
 * same N have matching indices, so they can be lofted into a shell.
 */
export function rrLoop(hw: number, hh: number, r: number, N: number): [number, number][] {
  const k = Math.max(0, Math.min(r, hw, hh))
  const m = Math.max(1, Math.round(N / 4))
  const a = hh - k, arc = (Math.PI * k) / 2, c = hw - k
  const L = a + arc + c
  const q: [number, number][] = []
  for (let i = 0; i <= m; i++) {
    const s = (i / m) * L
    if (s <= a) q.push([hw, s])
    else if (s <= a + arc) { const t = (s - a) / (k || 1); q.push([c + Math.cos(t) * k, a + Math.sin(t) * k]) }
    else q.push([hw - k - (s - a - arc), hh])
  }
  const out: [number, number][] = []
  for (let i = 0; i < m; i++) out.push(q[i])
  for (let i = 0; i < m; i++) out.push([-q[m - i][0], q[m - i][1]])
  for (let i = 0; i < m; i++) out.push([-q[i][0], -q[i][1]])
  for (let i = 0; i < m; i++) out.push([q[m - i][0], -q[m - i][1]])
  return out
}

export class Builder {
  segs: Seg[] = []
  hotspots: Hotspot[] = []
  faces: Face[] = []
  spins: Spin[] = []

  line(a: Vec3, b: Vec3, s: Style) {
    this.segs.push({ a, b, layer: s.layer, group: s.group, w: s.w })
  }

  /** A long line split into n pieces so depth fade varies along it. */
  lineN(a: Vec3, b: Vec3, n: number, s: Style) {
    let p = a
    for (let i = 1; i <= n; i++) {
      const q: Vec3 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, a[2] + ((b[2] - a[2]) * i) / n]
      this.line(p, q, s)
      p = q
    }
  }

  poly(pts: Vec3[], closed: boolean, s: Style) {
    for (let i = 0; i < pts.length - 1; i++) this.line(pts[i], pts[i + 1], s)
    if (closed && pts.length > 2) this.line(pts[pts.length - 1], pts[0], s)
  }

  /** Point in the plane through c spanned by u, v. */
  static at(c: Vec3, u: Vec3, v: Vec3, x: number, y: number): Vec3 {
    return [c[0] + u[0] * x + v[0] * y, c[1] + u[1] * x + v[1] * y, c[2] + u[2] * x + v[2] * y]
  }

  /** Rectangle centered at c, w along u, h along v. Optional chamfer on the corners. */
  rect(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, s: Style, chamfer = 0) {
    this.poly(this.rectPts(c, u, v, w, h, chamfer), true, s)
  }

  rectPts(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, chamfer = 0): Vec3[] {
    const a = w / 2, b = h / 2, k = Math.min(chamfer, a, b)
    const P = (x: number, y: number) => Builder.at(c, u, v, x, y)
    if (k <= 0) return [P(-a, -b), P(a, -b), P(a, b), P(-a, b)]
    return [P(-a + k, -b), P(a - k, -b), P(a, -b + k), P(a, b - k), P(a - k, b), P(-a + k, b), P(-a, b - k), P(-a, -b + k)]
  }

  circle(c: Vec3, u: Vec3, v: Vec3, r: number, n: number, s: Style, a0 = 0, a1 = Math.PI * 2) {
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6
    const pts: Vec3[] = []
    const steps = full ? n : Math.max(2, Math.round((n * Math.abs(a1 - a0)) / (Math.PI * 2)))
    for (let i = 0; i <= steps; i++) {
      if (full && i === steps) break
      const a = a0 + ((a1 - a0) * i) / steps
      pts.push(Builder.at(c, u, v, Math.cos(a) * r, Math.sin(a) * r))
    }
    this.poly(pts, full, s)
  }

  /** Axis-aligned box edges. */
  box(lo: Vec3, hi: Vec3, s: Style, skip?: { top?: boolean; bottom?: boolean }) {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi
    const b: Vec3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]
    const t: Vec3[] = [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]
    if (!skip?.bottom) this.poly(b, true, s)
    if (!skip?.top) this.poly(t, true, s)
    for (let i = 0; i < 4; i++) this.line(b[i], t[i], s)
  }

  /**
   * Chamfered box: every edge beveled by c. `faceStyle(axis, sign)` styles the
   * face outlines, `cornerStyle` the corner triangles.
   */
  chamferBox(center: Vec3, half: Vec3, c: number, faceStyle: (axis: 0 | 1 | 2, sign: 1 | -1) => Style | null, cornerStyle: Style) {
    const [hx, hy, hz] = half
    const P = (sx: number, sy: number, sz: number, axis: 0 | 1 | 2): Vec3 => {
      const x = axis === 0 ? sx * hx : sx * (hx - c)
      const y = axis === 1 ? sy * hy : sy * (hy - c)
      const z = axis === 2 ? sz * hz : sz * (hz - c)
      return add(center, [x, y, z])
    }
    const signs = [-1, 1] as const
    for (const axis of [0, 1, 2] as const) for (const s of signs) {
      const st = faceStyle(axis, s)
      if (!st) continue
      let pts: Vec3[]
      if (axis === 0) pts = [P(s, -1, -1, 0), P(s, 1, -1, 0), P(s, 1, 1, 0), P(s, -1, 1, 0)]
      else if (axis === 1) pts = [P(-1, s, -1, 1), P(1, s, -1, 1), P(1, s, 1, 1), P(-1, s, 1, 1)]
      else pts = [P(-1, -1, s, 2), P(1, -1, s, 2), P(1, 1, s, 2), P(-1, 1, s, 2)]
      this.poly(pts, true, st)
    }
    for (const sx of signs) for (const sy of signs) for (const sz of signs) {
      this.poly([P(sx, sy, sz, 0), P(sx, sy, sz, 1), P(sx, sy, sz, 2)], true, cornerStyle)
    }
  }

  /** Grid of lines across a rectangle (each line split for depth fade). */
  grid(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, step: number, s: Style, split = 4) {
    const nu = Math.max(1, Math.round(w / step)), nv = Math.max(1, Math.round(h / step))
    for (let i = 1; i < nu; i++) {
      const x = -w / 2 + (w * i) / nu
      this.lineN(Builder.at(c, u, v, x, -h / 2), Builder.at(c, u, v, x, h / 2), split, s)
    }
    for (let j = 1; j < nv; j++) {
      const y = -h / 2 + (h * j) / nv
      this.lineN(Builder.at(c, u, v, -w / 2, y), Builder.at(c, u, v, w / 2, y), split, s)
    }
  }

  /** Diagonal crosshatch inside a rectangle (perforated mesh look). */
  hatch(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, step: number, s: Style, both = true) {
    const a = w / 2, b = h / 2
    const clipLine = (k: number, dir: 1 | -1): [number, number, number, number] | null => {
      // line y = dir * x + k, clipped to the rectangle
      const pts: [number, number][] = []
      const add2 = (x: number, y: number) => { if (x >= -a - 1e-9 && x <= a + 1e-9 && y >= -b - 1e-9 && y <= b + 1e-9) pts.push([x, y]) }
      add2(-a, dir * -a + k); add2(a, dir * a + k); add2((-b - k) / dir, -b); add2((b - k) / dir, b)
      if (pts.length < 2) return null
      pts.sort((p, q) => p[0] - q[0])
      return [pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]]
    }
    for (const dir of both ? ([1, -1] as const) : ([1] as const)) {
      for (let k = -(a + b); k <= a + b; k += step) {
        const l = clipLine(k, dir)
        if (!l) continue
        const len = Math.hypot(l[2] - l[0], l[3] - l[1])
        if (len < step * 0.3) continue
        this.lineN(Builder.at(c, u, v, l[0], l[1]), Builder.at(c, u, v, l[2], l[3]), Math.max(1, Math.round(len / 0.5)), s)
      }
    }
  }

  curve(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: number, s: Style) {
    let prev = p0
    for (let i = 1; i <= n; i++) {
      const q = bezier(p0, p1, p2, p3, i / n)
      this.line(prev, q, s)
      prev = q
    }
  }

  /** A tube: two parallel curves offset sideways by r (reads as a hose or cable). */
  tube(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, r: number, side: Vec3, n: number, s: Style) {
    const o = scale(norm(side), r)
    this.curve(add(p0, o), add(p1, o), add(p2, o), add(p3, o), n, s)
    this.curve(sub(p0, o), sub(p1, o), sub(p2, o), sub(p3, o), n, s)
  }

  /**
   * A case fan facing along `axis` (normal), square frame of `size`, with a
   * ring, hub and swept blades that spin. Returns nothing; registers the spin.
   */
  fan(c: Vec3, u: Vec3, v: Vec3, size: number, opt: { frame: Style; ring: Style; blade: Style; blades?: number; depth?: number; speed?: number; group?: string; grill?: Style; bare?: boolean }) {
    const n = norm(cross(u, v))
    const d = opt.depth ?? size * 0.18
    const front = add(c, scale(n, d / 2)), back = sub(c, scale(n, d / 2))
    const R = size * 0.47
    if (!opt.bare) {
      // frame: two chamfered squares + corner posts
      const f1 = this.rectPts(front, u, v, size, size, size * 0.12)
      const f2 = this.rectPts(back, u, v, size, size, size * 0.12)
      this.poly(f1, true, opt.frame)
      this.poly(f2, true, opt.frame)
      for (const i of [0, 2, 4, 6]) this.line(f1[i], f2[i], opt.frame)
      // screw holes
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        this.circle(Builder.at(front, u, v, sx * size * 0.41, sy * size * 0.41), u, v, size * 0.025, 6, opt.frame)
      }
    }
    // shroud ring on both faces
    this.circle(front, u, v, R, 40, opt.ring)
    this.circle(back, u, v, R, 32, { ...opt.frame, w: (opt.frame.w ?? 1) * 0.7 })
    // struts on the back face (motor arms)
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2
      this.line(Builder.at(back, u, v, Math.cos(a) * size * 0.16, Math.sin(a) * size * 0.16), Builder.at(back, u, v, Math.cos(a) * size * 0.6, Math.sin(a) * size * 0.6), opt.frame)
    }
    if (opt.grill) {
      for (const rr of [0.32, 0.22]) this.circle(add(front, scale(n, 0.02)), u, v, size * rr, 28, opt.grill)
    }
    // spinning part: hub + blades
    const from = this.segs.length
    const hubR = size * 0.15
    this.circle(c, u, v, hubR, 18, opt.blade)
    this.circle(c, u, v, hubR * 0.45, 10, opt.blade)
    const nb = opt.blades ?? 7
    for (let k = 0; k < nb; k++) {
      const a0 = (k / nb) * Math.PI * 2
      const pts: Vec3[] = []
      const back2: Vec3[] = []
      for (let i = 0; i <= 5; i++) {
        const t = i / 5
        const r = hubR + (R * 0.94 - hubR) * t
        const sweep = 0.75 * t * t + 0.15 * t
        const lead = a0 + sweep
        const trail = a0 + sweep - (0.5 + 0.25 * t)
        const z = d * 0.32 * (0.5 - t * 0.6)
        pts.push(add(Builder.at(c, u, v, Math.cos(lead) * r, Math.sin(lead) * r), scale(n, z)))
        back2.push(add(Builder.at(c, u, v, Math.cos(trail) * r, Math.sin(trail) * r), scale(n, -z)))
      }
      this.poly(pts, false, opt.blade)
      this.poly(back2, false, opt.blade)
      this.line(pts[5], back2[5], opt.blade)
    }
    this.spins.push({ from, to: this.segs.length, center: c, axis: n, speed: opt.speed ?? 0.9, group: opt.group ?? 'fans' })
  }

  hotspot(id: string, at: Vec3, label: string) {
    this.hotspots.push({ id, at, label })
  }

  // ---------- extras for the device models (frame, laptop, phone, tablet) ----------

  /** Rounded-rectangle outline centered at c in the u, v plane: corner radius r, n steps per corner (4 * (n + 1) points). */
  roundRectPts(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, r: number, n = 6): Vec3[] {
    const a = w / 2, b = h / 2, k = Math.max(0, Math.min(r, a, b))
    if (k <= 1e-6) return this.rectPts(c, u, v, w, h)
    const pts: Vec3[] = []
    const cs: [number, number, number][] = [[a - k, b - k, 0], [-a + k, b - k, 0.5], [-a + k, -b + k, 1], [a - k, -b + k, 1.5]]
    for (const [cx, cy, a0] of cs) {
      for (let i = 0; i <= n; i++) {
        const t = (a0 + (i / n) * 0.5) * Math.PI
        pts.push(Builder.at(c, u, v, cx + Math.cos(t) * k, cy + Math.sin(t) * k))
      }
    }
    return pts
  }

  roundRect(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, r: number, s: Style, n = 6) {
    this.poly(this.roundRectPts(c, u, v, w, h, r, n), true, s)
  }

  /**
   * A rounded slab: the outline on both faces (offset +-d/2 along u x v) and
   * the edges joining them at each corner's tangent points and middle.
   */
  roundSlab(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, d: number, r: number, front: Style | null, back: Style | null, edge: Style | null, n = 6) {
    const nrm = norm(cross(u, v))
    const f = this.roundRectPts(add(c, scale(nrm, d / 2)), u, v, w, h, r, n)
    const k = this.roundRectPts(sub(c, scale(nrm, d / 2)), u, v, w, h, r, n)
    if (front) this.poly(f, true, front)
    if (back) this.poly(k, true, back)
    if (edge) {
      const per = n + 1
      for (let q = 0; q < 4; q++) for (const i of [0, Math.round(n / 2), n]) this.line(f[q * per + i], k[q * per + i], edge)
    }
    return { front: f, back: k }
  }

  /** Grid of lines clipped to a rounded rectangle (screen glass, faceplate mesh). */
  roundGrid(c: Vec3, u: Vec3, v: Vec3, w: number, h: number, r: number, step: number, s: Style, split = 4) {
    const a = w / 2, b = h / 2, k = Math.max(0, Math.min(r, a, b))
    const ext = (t: number, half: number, other: number) => {
      const over = Math.abs(t) - (half - k)
      return over <= 0 ? other : other - k + Math.sqrt(Math.max(0, k * k - over * over))
    }
    const nu = Math.max(1, Math.round(w / step)), nv = Math.max(1, Math.round(h / step))
    for (let i = 1; i < nu; i++) {
      const x = -a + (w * i) / nu
      const e = ext(x, a, b)
      this.lineN(Builder.at(c, u, v, x, -e), Builder.at(c, u, v, x, e), split, s)
    }
    for (let j = 1; j < nv; j++) {
      const y = -b + (h * j) / nv
      const e = ext(y, b, a)
      this.lineN(Builder.at(c, u, v, -e, y), Builder.at(c, u, v, e, y), split, s)
    }
  }

  /** A path of 2D points in the plane through c spanned by u, v. */
  path(c: Vec3, u: Vec3, v: Vec3, pts: [number, number][], closed: boolean, s: Style) {
    this.poly(pts.map(([x, y]) => Builder.at(c, u, v, x, y)), closed, s)
  }

  /** Parallel PCB traces along a 2D path, mapped to world by `map`. */
  traces(map: (x: number, y: number) => Vec3, path: [number, number][], count: number, pitch: number, s: Style) {
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * pitch
      const pts: Vec3[] = path.map(([x, y], k) => {
        const [px, py] = path[Math.max(0, k - 1)]
        const [nx, ny] = path[Math.min(path.length - 1, k + 1)]
        const dx = nx - px, dy = ny - py
        const l = Math.hypot(dx, dy) || 1
        return map(x + (-dy / l) * off, y + (dx / l) * off)
      })
      this.poly(pts, false, s)
    }
  }

  /** A camera or sensor: outer ring, lens ring and pupil facing along `n`, with a short barrel behind it. */
  lens(c: Vec3, n: Vec3, r: number, ring: Style, glass: Style, pupil: Style, depth = r) {
    const nn = norm(n)
    const u = norm(Math.abs(nn[1]) > 0.9 ? cross(nn, X) : cross(nn, Y))
    const v = norm(cross(nn, u))
    this.circle(c, u, v, r, 24, ring)
    this.circle(c, u, v, r * 0.66, 18, glass)
    this.circle(add(c, scale(nn, -0.002)), u, v, r * 0.28, 10, pupil)
    const back = sub(c, scale(nn, depth))
    this.circle(back, u, v, r * 0.8, 16, glass)
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      this.line(Builder.at(c, u, v, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8), Builder.at(back, u, v, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8), glass)
    }
  }

  /** Map every point held so far (segments, faces, spin centers, hotspots) through f; `dir` maps directions (spin axes). */
  transform(f: (p: Vec3) => Vec3, dir: (d: Vec3) => Vec3) {
    for (const s of this.segs) { s.a = f(s.a); s.b = f(s.b) }
    for (const fc of this.faces) fc.pts = fc.pts.map(f)
    for (const sp of this.spins) { sp.center = f(sp.center); sp.axis = dir(sp.axis) }
    for (const h of this.hotspots) h.at = f(h.at)
  }

  /** Rotate everything built so far by `ang` radians around `axis` through `c`. */
  rotate(c: Vec3, axis: Vec3, ang: number) {
    const ax = norm(axis)
    this.transform((p) => rotateAround(p, c, ax, ang), (d) => rotateAround(d, [0, 0, 0], ax, ang))
  }

  face(pts: Vec3[], layer: Layer = 'fg', w = 1) {
    this.faces.push({ pts, layer, w })
  }

  model(center?: Vec3, radius?: number): Model {
    let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const s of this.segs) for (const p of [s.a, s.b]) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]) }
    const c: Vec3 = center ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    const r = radius ?? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2
    return { segs: this.segs, hotspots: this.hotspots, radius: r, center: c, faces: this.faces, spins: this.spins }
  }
}
