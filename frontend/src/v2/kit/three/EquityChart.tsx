import { useEffect, useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { Palette } from '../theme'
import { Camera, clamp, easeInOut, mixRGB, parseColor, rgba, smooth, type RGB } from './engine'

export type EquityPoint = {
  /** position along the chart, 0 (left) to 1 (right), e.g. by trading time */
  x: number
  /** the value, in data units (dollars) */
  v: number
}

/** One trading day's slot along x, 0 to 1. */
export type EquityDay = { x0: number; x1: number; label: string; /** a longer label, used when the slot has room */ long?: string }

export type EquityChartProps = {
  /** oldest first, x ascending */
  points: EquityPoint[]
  /** the visible value range: the floor sits at `lo`, the top of the box at `hi` */
  lo: number
  hi: number
  /** value lines across the ribbon's plane, labeled at their left end (e.g. max and min) */
  ticks?: { v: number; label: string }[]
  /** one slot per trading day: a floor plate, a separator and a label each */
  days?: EquityDay[]
  /** points from this index on repeat one fallback figure: dashed, dim, no glow, no fill */
  tailFrom?: number
  /** value label at the newest point */
  lastLabel?: string
  /** a short dim note after it (e.g. "not live") */
  lastNote?: string
  palette: Palette
  /** stop the RAF loop; a paused chart draws the finished picture once */
  paused?: boolean
  /** 'reduced' skips the draw-in, the drift and the pulse */
  motion?: 'full' | 'reduced'
  className?: string
  style?: CSSProperties
  ariaLabel?: string
}

// world: x across (-SPAN..SPAN), y up (0 = lo, WH = hi), z toward the camera
const SPAN = 5
const PX = SPAN + 0.45
const ZB = -1.9 // back wall
const ZF = 0.95 // floor front edge
const DEPTH = 0.42 // ribbon thickness, back from the value plane z = 0
const GR = 0.32
const PITCH = 17
const FOV = 24
const DIST = 19
const DRAW_MS = 1150
const PAD_T = 8

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
/** canvas text follows the v2 font setting (Mono by default, html[data-font]) */
const fontFamily = () => (typeof document === 'undefined' ? 'system-ui, sans-serif' : getComputedStyle(document.body).fontFamily)

/** about 4 gridline steps over the span: 1, 2 or 5 times a power of ten */
function niceStep(span: number): number {
  if (!(span > 0)) return 1
  const raw = span / 4
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / p
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p
}

type V2 = [number, number]

/** the polyline up to x = cut, with an interpolated end point */
function cutPoly(pts: V2[], cut: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i]
    if (q[0] <= cut) { out.push(q); continue }
    const a = pts[i - 1]
    if (a && cut > a[0]) {
      const f = (cut - a[0]) / (q[0] - a[0] || 1)
      out.push([cut, a[1] + (q[1] - a[1]) * f])
    }
    break
  }
  return out
}

/**
 * Valkyrie's 3D equity chart: the equity line as the glowing front edge of an
 * extruded ribbon, a curtain under it fading to the floor, a perspective dot
 * floor with one plate per trading day, a faint back wall, value lines on the
 * ribbon's own plane (so a point reads against the same scale), and a marker
 * on the newest point with its value. A repeated fallback figure is dashed,
 * dim and unfilled. Draws in once, then drifts slowly; drag to turn it.
 */
export function EquityChart(props: EquityChartProps) {
  const { className, style, ariaLabel } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const sharpRef = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const st = useRef({
    raf: 0, visible: true, onscreen: true, w: 1, h: 1, dpr: 1, t0: -1, last: 0,
    fit: { k: 1, ox: 0, oy: 0 },
    wallH: 3,
    /** px reserved left of the box for the value labels; strip under it for the day labels */
    gutter: 0, padB: 20,
    // drag: offsets from the drifting pose, eased home a while after release
    dragYaw: 0, dragPitch: 0,
    drag: null as null | { id: number; x: number; y: number; yaw0: number; pitch0: number; mouse: boolean },
    releasedAt: -1, backFrom: null as null | V2, backT0: 0,
    kick: () => {},
  })

  useLayoutEffect(() => {
    propsRef.current = props
    st.current.kick()
  })

  useEffect(() => {
    const wrap = wrapRef.current!, sharp = sharpRef.current!, glow = glowRef.current!
    const S = sharp.getContext('2d')!, G = glow.getContext('2d')!
    const s = st.current
    s.visible = !document.hidden
    const cam = new Camera({ yaw: 0, pitch: PITCH, dist: DIST, fov: FOV, target: [0, 1, 0] }, [0, 0, 0])
    const out = [0, 0, 0]
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    const reduced = () => (propsRef.current.motion ? propsRef.current.motion === 'reduced' : !!mq?.matches)
    const P = (x: number, y: number, z: number) => cam.project(x, y, z, out)

    const pose = (yaw: number, pitch: number) => {
      cam.cur.yaw = yaw
      cam.cur.pitch = clamp(pitch, 3, 58)
      cam.cur.dist = DIST
      cam.cur.fov = FOV
      cam.cur.tx = 0
      cam.cur.ty = s.wallH * 0.45
      cam.cur.tz = (ZB + ZF) / 2
      cam.basis(s.w, s.h)
    }

    // the box at the resting pose with a wall WH tall: its on-screen bounds
    const bounds = (WH: number) => {
      s.wallH = WH
      pose(0, PITCH)
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const [x, y, z] of [[-PX, 0, ZB], [PX, 0, ZB], [PX, 0, ZF], [-PX, 0, ZF], [-SPAN, WH, ZB], [SPAN, WH, ZB], [-SPAN, WH, 0], [SPAN, WH, 0]]) {
        if (!P(x, y, z)) continue
        x0 = Math.min(x0, out[0]); x1 = Math.max(x1, out[0]); y0 = Math.min(y0, out[1]); y1 = Math.max(y1, out[1])
      }
      return { w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), cx: (x0 + x1) / 2 - cam.ox, cy: (y0 + y1) / 2 - cam.oy }
    }
    // the value labels sit in a gutter on the left, the day labels in a strip
    // under the floor; the wall grows until the box fills the rest both ways
    // (the value range scales with it, so a move keeps its share of the height)
    const fitCamera = () => {
      const fs = s.w >= 560 ? 11 : 10
      s.padB = fs + 11
      const left = s.gutter + 2, availW = Math.max(10, s.w - left - 4) * 0.97
      const availH = Math.max(10, s.h - PAD_T - s.padB)
      let a = 0.6, b = 12
      for (let i = 0; i < 24; i++) {
        const m = (a + b) / 2, r = bounds(m)
        if (availH / r.h > availW / r.w) a = m; else b = m
      }
      const r = bounds(a)
      const k = Math.min(availW / r.w, availH / r.h)
      s.fit = { k, ox: left + (s.w - left - 4) / 2 - r.cx * k, oy: PAD_T + availH / 2 - r.cy * k }
    }

    const size = () => {
      // layout size, not getBoundingClientRect: a tilting .vl-build parent shrinks the transformed box
      s.w = Math.max(1, wrap.clientWidth); s.h = Math.max(1, wrap.clientHeight)
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      sharp.width = Math.round(s.w * s.dpr); sharp.height = Math.round(s.h * s.dpr)
      glow.width = Math.max(1, Math.round(s.w * 0.5)); glow.height = Math.max(1, Math.round(s.h * 0.5))
      fitCamera()
      kick()
    }

    /** a world polyline at depth z: moveTo/lineTo on both contexts */
    const trace = (ctxs: CanvasRenderingContext2D[], pts: V2[], z: number, start = true) => {
      let on = !start
      for (const [x, y] of pts) {
        if (!P(x, y, z)) { on = false; continue }
        for (const c of ctxs) { if (on) c.lineTo(out[0], out[1]); else c.moveTo(out[0], out[1]) }
        on = true
      }
    }

    /** returns true while it still needs frames */
    const draw = (now: number): boolean => {
      const p = propsRef.current
      const red = reduced()
      if (s.t0 < 0) s.t0 = now
      const still = red || !!p.paused
      const age = now - s.t0
      const prog = still ? 1 : easeOut(clamp((age - 120) / DRAW_MS, 0, 1))
      const gridA = still ? 1 : smooth(0, 380, age)
      const labelA = still ? 1 : smooth(DRAW_MS * 0.85, DRAW_MS + 250, age)

      // drag offsets ease home 2 s after release
      let easing = false
      if (!s.drag && s.releasedAt >= 0 && now - s.releasedAt > 2000 && !s.backFrom && !s.dragYaw && !s.dragPitch) s.releasedAt = -1
      if (!s.drag && s.releasedAt >= 0 && now - s.releasedAt > 2000) {
        if (!s.backFrom) { s.backFrom = [s.dragYaw, s.dragPitch]; s.backT0 = now }
        const k = clamp((now - s.backT0) / 1000, 0, 1)
        const e = 1 - easeInOut(k)
        s.dragYaw = s.backFrom[0] * e
        s.dragPitch = s.backFrom[1] * e
        if (k >= 1) { s.dragYaw = 0; s.dragPitch = 0; s.backFrom = null; s.releasedAt = -1 } else easing = true
      }
      // the value-label gutter follows the widest label; a new width refits the box
      const fs = s.w >= 560 ? 11 : 10
      const fam = fontFamily()
      const canvasFont = (px: number, weight = 500) => `${weight} ${px}px ${fam}`
      const ticks = p.ticks ?? []
      S.font = canvasFont(fs)
      const gutter = ticks.length ? Math.ceil(Math.max(...ticks.map((t) => S.measureText(t.label).width))) + 8 : 0
      if (gutter !== s.gutter) { s.gutter = gutter; fitCamera() }

      const drift = !still
      pose(
        (drift ? Math.sin(now / 9000) * 4.5 : 0) + s.dragYaw,
        PITCH + (drift ? Math.sin(now / 13000) * 1.4 : 0) + s.dragPitch,
      )
      cam.focal *= s.fit.k; cam.ox = s.fit.ox; cam.oy = s.fit.oy

      const fg: RGB = parseColor(p.palette.fg), hot: RGB = parseColor(p.palette.hot)
      // deep colors (blue, violet, red) need more alpha to read on black
      const boost = (c: RGB) => clamp(Math.sqrt(0.8 / Math.max(0.05, (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255)), 1, 1.7)
      const comp = boost(fg), compH = boost(hot)
      const white = mixRGB(hot, [255, 255, 255], 0.5)
      const WH = s.wallH
      const lo = p.lo, hi = p.hi > p.lo ? p.hi : p.lo + 1
      const Y = (v: number) => (clamp(v, lo, hi) - lo) / (hi - lo) * WH
      const X = (f: number) => -SPAN + 2 * SPAN * clamp(f, 0, 1)

      S.setTransform(1, 0, 0, 1, 0, 0)
      S.globalCompositeOperation = 'source-over'
      S.clearRect(0, 0, sharp.width, sharp.height)
      G.setTransform(1, 0, 0, 1, 0, 0)
      G.globalCompositeOperation = 'source-over'
      G.clearRect(0, 0, glow.width, glow.height)
      S.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
      G.setTransform(0.5, 0, 0, 0.5, 0, 0)
      S.globalCompositeOperation = 'lighter'
      G.globalCompositeOperation = 'lighter'
      S.lineCap = 'round'; S.lineJoin = 'round'
      G.lineCap = 'round'; G.lineJoin = 'round'

      // ---- floor: one faint plate per other trading day, then the dot plane
      const days = p.days ?? []
      S.fillStyle = rgba(fg, 0.035 * comp * gridA)
      S.beginPath()
      days.forEach((d, k) => {
        if (k % 2 === 0) return
        const xa = X(d.x0), xb = X(d.x1)
        if (!P(xa, 0, ZB)) return
        S.moveTo(out[0], out[1])
        if (P(xb, 0, ZB)) S.lineTo(out[0], out[1])
        if (P(xb, 0, ZF)) S.lineTo(out[0], out[1])
        if (P(xa, 0, ZF)) S.lineTo(out[0], out[1])
        S.closePath()
      })
      S.fill()

      const lv: number[][] = [[], [], [], []]
      for (let x = -PX; x <= PX + 1e-6; x += GR) for (let z = ZB; z <= ZF + 1e-6; z += GR) {
        if (!P(x, 0, z)) continue
        const edge = Math.min(1, (PX - Math.abs(x)) / 0.9) * Math.min(1, (ZF - z) / 0.45 + 0.2)
        const near = 0.45 + 0.55 * ((z - ZB) / (ZF - ZB))
        const a = edge * near * gridA
        if (a < 0.06) continue
        lv[Math.min(3, (a * 4) | 0)].push(out[0], out[1], clamp((0.034 * cam.focal) / out[2], 0.45, 1.25))
      }
      lv.forEach((arr, i) => {
        if (!arr.length) return
        S.fillStyle = rgba(fg, ((i + 1) / 4) * 0.32 * comp)
        S.beginPath()
        for (let k = 0; k < arr.length; k += 3) { S.moveTo(arr[k] + arr[k + 2], arr[k + 1]); S.arc(arr[k], arr[k + 1], arr[k + 2], 0, 6.2832) }
        S.fill()
      })

      // ---- back wall: the floor seam, its side edges, faint value steps
      S.beginPath()
      if (P(-SPAN, 0, ZB)) { S.moveTo(out[0], out[1]); if (P(SPAN, 0, ZB)) S.lineTo(out[0], out[1]) }
      S.strokeStyle = rgba(fg, 0.2 * comp * gridA); S.lineWidth = 0.8; S.stroke()
      S.beginPath()
      for (const x of [-SPAN, SPAN]) {
        if (!P(x, 0, ZB)) continue
        S.moveTo(out[0], out[1])
        if (P(x, WH, ZB)) S.lineTo(out[0], out[1])
      }
      if (P(-SPAN, WH, ZB)) { S.moveTo(out[0], out[1]); if (P(SPAN, WH, ZB)) S.lineTo(out[0], out[1]) }
      const step = niceStep(hi - lo)
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        if (!P(-SPAN, Y(v), ZB)) continue
        S.moveTo(out[0], out[1])
        if (P(SPAN, Y(v), ZB)) S.lineTo(out[0], out[1])
      }
      S.strokeStyle = rgba(fg, 0.075 * comp * gridA); S.lineWidth = 0.7; S.stroke()

      // ---- day separators: across the floor and up the back wall
      S.beginPath()
      for (let k = 1; k < days.length; k++) {
        const x = X(days[k].x0)
        if (!P(x, 0, ZF)) continue
        S.moveTo(out[0], out[1])
        if (P(x, 0, ZB)) S.lineTo(out[0], out[1])
        if (P(x, WH * 0.35, ZB)) S.lineTo(out[0], out[1])
      }
      S.strokeStyle = rgba(fg, 0.13 * comp * gridA); S.lineWidth = 0.7; S.stroke()

      // ---- the floor's front edge, with a tick down at every day boundary
      S.beginPath()
      if (P(-SPAN, 0, ZF)) { S.moveTo(out[0], out[1]); if (P(SPAN, 0, ZF)) S.lineTo(out[0], out[1]) }
      for (let k = 0; days.length && k <= days.length; k++) {
        const x = k < days.length ? X(days[k].x0) : X(days[k - 1].x1)
        if (!P(x, 0, ZF)) continue
        S.moveTo(out[0], out[1]); S.lineTo(out[0], out[1] + 4)
      }
      S.strokeStyle = rgba(fg, 0.3 * comp * gridA); S.lineWidth = 0.8; S.stroke()

      // ---- value lines on the ribbon's plane, dotted, from the label gutter across
      if (ticks.length) {
        S.beginPath()
        for (const t of ticks) {
          const y = Y(t.v)
          for (let x = -PX; x <= SPAN + 1e-6; x += GR * 0.5) {
            if (!P(x, y, 0)) continue
            S.moveTo(out[0] + 0.65, out[1]); S.arc(out[0], out[1], 0.65, 0, 6.2832)
          }
        }
        S.fillStyle = rgba(fg, 0.36 * comp * gridA)
        S.fill()
      }

      // ---- the series
      const pts: V2[] = p.points.map((q) => [X(q.x), Y(q.v)])
      const n = pts.length
      const tf = p.tailFrom != null && p.tailFrom >= 0 && p.tailFrom < n - 1 ? p.tailFrom : n - 1
      const hasTail = tf < n - 1
      let headPx: V2 | null = null, liveEndPx: V2 | null = null
      if (n >= 2) {
        const cut = pts[0][0] + (pts[n - 1][0] - pts[0][0]) * prog
        const live = cutPoly(pts.slice(0, tf + 1), cut)
        const tail = hasTail ? cutPoly(pts.slice(tf), cut) : []

        // a filled curtain from a polyline down to the floor, gradient to transparent
        const curtain = (poly: V2[], col: RGB, aTop: number) => {
          if (poly.length < 2) return
          let top = Infinity, bot = -Infinity
          S.beginPath()
          trace([S], poly, 0)
          for (const [x, y] of poly) if (P(x, y, 0)) top = Math.min(top, out[1])
          for (const x of [poly[poly.length - 1][0], poly[0][0]]) {
            if (!P(x, 0, 0)) continue
            S.lineTo(out[0], out[1]); bot = Math.max(bot, out[1])
          }
          S.closePath()
          if (!(bot > top)) return
          const g = S.createLinearGradient(0, top, 0, bot)
          g.addColorStop(0, rgba(col, aTop))
          g.addColorStop(0.55, rgba(col, aTop * 0.3))
          g.addColorStop(1, rgba(col, 0))
          S.fillStyle = g
          S.fill()
        }
        // the ribbon's top face: the value line at z = 0 back to z = -DEPTH
        const face = (poly: V2[], col: RGB, a: number) => {
          if (poly.length < 2) return
          S.beginPath()
          trace([S], poly, 0)
          trace([S], [...poly].reverse(), -DEPTH, false)
          S.closePath()
          S.fillStyle = rgba(col, a)
          S.fill()
        }
        curtain(live, hot, 0.3 * compH)
        curtain(tail, fg, 0.06 * comp)
        face(live, hot, 0.13 * compH)
        face(tail, fg, 0.05 * comp)

        // baseline where the curtain meets the floor
        S.beginPath()
        if (live.length > 1 && P(live[0][0], 0, 0)) { S.moveTo(out[0], out[1]); if (P(live[live.length - 1][0], 0, 0)) S.lineTo(out[0], out[1]) }
        S.strokeStyle = rgba(hot, 0.3); S.lineWidth = 0.9; S.stroke()
        if (tail.length > 1) {
          S.beginPath()
          if (P(tail[0][0], 0, 0)) { S.moveTo(out[0], out[1]); if (P(tail[tail.length - 1][0], 0, 0)) S.lineTo(out[0], out[1]) }
          S.strokeStyle = rgba(fg, 0.14); S.stroke()
        }

        // drop lines, one per reading (live part only)
        S.beginPath()
        for (const [x, y] of live) {
          if (!P(x, y, 0)) continue
          const ax = out[0], ay = out[1]
          if (!P(x, 0, 0)) continue
          S.moveTo(ax, ay); S.lineTo(out[0], out[1])
        }
        S.strokeStyle = rgba(hot, 0.1 * compH); S.lineWidth = 0.6; S.stroke()

        // back edges: thin, the tail dashed
        S.beginPath(); trace([S], live, -DEPTH)
        S.strokeStyle = rgba(hot, 0.34); S.lineWidth = 0.8; S.stroke()
        if (tail.length > 1) {
          S.setLineDash([2, 4])
          S.beginPath(); trace([S], tail, -DEPTH)
          S.strokeStyle = rgba(fg, 0.22); S.lineWidth = 0.8; S.stroke()
          S.setLineDash([])
        }

        // the end cap at the newest shown point: its two vertical edges
        const endP = tail.length > 1 ? tail[tail.length - 1] : live[live.length - 1]
        if (endP) {
          S.beginPath()
          for (const z of [0, -DEPTH]) {
            if (!P(endP[0], endP[1], z)) continue
            const ax = out[0], ay = out[1]
            if (!P(endP[0], 0, z)) continue
            S.moveTo(ax, ay); S.lineTo(out[0], out[1])
          }
          S.strokeStyle = tail.length > 1 ? rgba(fg, 0.2) : rgba(hot, 0.4); S.lineWidth = 0.8; S.stroke()
        }

        // the value line: sharp + glow; the tail dashed and dim, no glow
        S.beginPath(); G.beginPath()
        trace([S, G], live, 0)
        S.strokeStyle = rgba(hot, 0.95); S.lineWidth = 1.8; S.stroke()
        G.strokeStyle = rgba(hot, 0.6); G.lineWidth = 5.5; G.stroke()
        if (tail.length > 1) {
          S.setLineDash([3, 4])
          S.beginPath(); trace([S], tail, 0)
          S.strokeStyle = rgba(fg, 0.55); S.lineWidth = 1.3; S.stroke()
          S.setLineDash([])
        }

        const le = live[live.length - 1]
        if (le && P(le[0], le[1], 0)) liveEndPx = [out[0], out[1]]
        if (endP && P(endP[0], endP[1], 0)) headPx = [out[0], out[1]]

        // markers once drawn in: a live head pulses; a repeated head is a dim ring,
        // and the last live reading keeps a small solid dot
        if (prog >= 1 && headPx) {
          const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 340)
          if (!hasTail) {
            for (const [ctx, a] of [[S, 1], [G, 0.9]] as const) {
              ctx.fillStyle = rgba(white, a)
              ctx.beginPath(); ctx.arc(headPx[0], headPx[1], 2.6, 0, 6.2832); ctx.fill()
            }
            G.strokeStyle = rgba(hot, 0.5 + 0.4 * pulse); G.lineWidth = 2
            G.beginPath(); G.arc(headPx[0], headPx[1], 6 + pulse * 3.5, 0, 6.2832); G.stroke()
            S.strokeStyle = rgba(hot, 0.7); S.lineWidth = 1
            S.beginPath(); S.arc(headPx[0], headPx[1], 5.5, 0, 6.2832); S.stroke()
          } else {
            S.strokeStyle = rgba(fg, 0.65); S.lineWidth = 1.1
            S.beginPath(); S.arc(headPx[0], headPx[1], 4, 0, 6.2832); S.stroke()
            if (liveEndPx) {
              for (const [ctx, a] of [[S, 0.95], [G, 0.7]] as const) {
                ctx.fillStyle = rgba(hot, a)
                ctx.beginPath(); ctx.arc(liveEndPx[0], liveEndPx[1], 2.4, 0, 6.2832); ctx.fill()
              }
            }
          }
        }
      }

      // ---- labels last, on top, with a black halo
      S.globalCompositeOperation = 'source-over'
      S.lineWidth = 3
      S.lineJoin = 'round'
      S.strokeStyle = 'rgba(0,0,0,0.92)'
      const label = (text: string, x: number, y: number, col: string) => {
        S.fillStyle = col
        S.strokeText(text, x, y); S.fillText(text, x, y)
      }
      if (gridA > 0.02) {
        // value labels in the gutter, right-aligned at the end of their line;
        // two close together are pushed apart, never stacked
        S.font = canvasFont(fs)
        S.textAlign = 'right'
        S.textBaseline = 'middle'
        const placed: { text: string; x: number; y: number }[] = []
        for (const t of [...ticks].sort((a, b) => b.v - a.v)) if (P(-PX, Y(t.v), 0)) placed.push({ text: t.label, x: out[0], y: out[1] })
        // one right edge for the column, so the labels line up as the camera drifts
        const right = Math.min(...placed.map((l) => l.x)) - 4
        let prevY = -Infinity
        for (const l of placed) {
          const y = Math.max(l.y, prevY + fs + 2)
          label(l.text, Math.max(right, S.measureText(l.text).width + 2), y, rgba(fg, 0.82 * gridA))
          prevY = y
        }
        // day labels under the floor's front edge, centered in their slot
        S.textBaseline = 'top'
        S.textAlign = 'center'
        for (const d of days) {
          const xa = X(d.x0), xb = X(d.x1)
          if (!P(xa, 0, ZF)) continue
          const ax = out[0]
          if (!P((xa + xb) / 2, 0, ZF)) continue
          const cxp = out[0], cyp = out[1] + 5
          const room = Math.abs(cxp - ax) * 2 - 8
          const text = d.long && S.measureText(d.long).width <= room ? d.long : d.label
          if (S.measureText(text).width > room + 6) continue
          label(text, cxp, cyp, rgba(fg, 0.66 * gridA))
        }
      }
      // the newest value beside its marker
      if (headPx && p.lastLabel && labelA > 0.02) {
        S.font = canvasFont(fs + 1, 600)
        const vw = S.measureText(p.lastLabel).width
        S.font = canvasFont(fs - 0.5)
        const note = p.lastNote ? ` ${p.lastNote}` : ''
        const nw = note ? S.measureText(note).width : 0
        const total = vw + nw
        let x = headPx[0] - total / 2
        if (x + total > s.w - 3) x = s.w - 3 - total
        if (x < 3) x = 3
        let y = headPx[1] - 11
        if (y - fs < 2) y = headPx[1] + 14 + fs
        S.textAlign = 'left'
        S.textBaseline = 'alphabetic'
        S.font = canvasFont(fs + 1, 600)
        label(p.lastLabel, x, y, hasTail ? rgba(mixRGB(fg, [255, 255, 255], 0.35), 0.95 * labelA) : rgba(hot, labelA))
        if (note) {
          S.font = canvasFont(fs - 0.5)
          label(note, x + vw, y, rgba(mixRGB(fg, [255, 255, 255], 0.2), 0.7 * labelA))
        }
      }

      s.last = now
      // a still chart (reduced motion, paused) only needs frames while a drag moves it
      return still ? !!s.drag || easing || s.releasedAt >= 0 : true
    }

    function tick(now: number) {
      s.raf = 0
      if (!s.visible || !s.onscreen) return
      const p = propsRef.current
      const settled = now - s.t0 > DRAW_MS + 400 && !s.drag && s.releasedAt < 0
      // after the draw-in the drift is slow: about 30 fps is plenty
      if (s.t0 >= 0 && settled && now - s.last < 30) { s.raf = requestAnimationFrame(tick); return }
      const keep = draw(now)
      if (keep && (!p.paused || s.drag || s.releasedAt >= 0)) s.raf = requestAnimationFrame(tick)
    }
    function kick() {
      if (!s.raf && s.visible && s.onscreen) s.raf = requestAnimationFrame(tick)
    }
    s.kick = kick
    size()
    const ro = new ResizeObserver(size)
    ro.observe(wrap)
    const io = new IntersectionObserver((e) => { s.onscreen = e.some((x) => x.isIntersecting); if (s.onscreen) kick() })
    io.observe(wrap)
    const onVis = () => { s.visible = !document.hidden; if (s.visible) kick() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      ro.disconnect(); io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      if (s.raf) cancelAnimationFrame(s.raf)
      s.raf = 0
      s.kick = () => {}
    }
  }, [])

  // drag turns it (sideways) and tilts it (up and down, mouse only: on touch a vertical drag scrolls the page)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const s = st.current
    s.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw0: s.dragYaw, pitch0: s.dragPitch, mouse: e.pointerType !== 'touch' }
    s.backFrom = null
    s.releasedAt = -1
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    s.kick()
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = st.current, d = s.drag
    if (!d || d.id !== e.pointerId) return
    s.dragYaw = clamp(d.yaw0 - (e.clientX - d.x) * 0.3, -26, 26)
    if (d.mouse) s.dragPitch = clamp(d.pitch0 + (e.clientY - d.y) * 0.22, 3 - PITCH, 50 - PITCH)
    s.kick()
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = st.current
    if (!s.drag || s.drag.id !== e.pointerId) return
    s.drag = null
    s.releasedAt = performance.now()
    s.kick()
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
      data-no-swipe
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{ position: 'relative', overflow: 'hidden', touchAction: 'pan-y', cursor: 'grab', userSelect: 'none', ...style }}
    >
      <canvas ref={glowRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'blur(4px)', pointerEvents: 'none' }} />
      <canvas ref={sharpRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
    </div>
  )
}
