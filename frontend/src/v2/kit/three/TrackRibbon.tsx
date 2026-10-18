import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { Palette } from '../theme'
import { Camera, DEG, clamp, mixRGB, parseColor, rgba, smooth, type RGB } from './engine'

export type TrackRibbonProps = {
  /** 0-100, oldest first; null = gap */
  series: (number | null)[]
  palette: Palette
  label?: string
  /** px, default 150 */
  height?: number
  /** stop the RAF loop; a paused ribbon draws the finished chart once (no draw-in) */
  paused?: boolean
  className?: string
  // ---- extras ----
  /** a second line on the same path (e.g. memory); faint in the classic look, clearly visible in `honest` */
  series2?: (number | null)[]
  /** right-aligned readout in the header row (e.g. "37%") */
  value?: ReactNode
  style?: CSSProperties
  /** 'reduced' skips the draw-in and the drift */
  motion?: 'full' | 'reduced'
  /**
   * 'contain' fits the whole plane in the box (the classic look); 'width'
   * stretches the track until it fills the box's width, for wide short boxes;
   * 'auto' (default) picks 'width' when the box is at least 2:1. Ignored by `honest`.
   */
  fit?: 'auto' | 'contain' | 'width'
  // ---- honest value chart ----
  /**
   * A value chart that never misdraws: the path is straight and seen square
   * on from a fixed camera (no meander, no drift), so a flat series draws flat
   * and every point reads against the same height scale. The first series is
   * one color (hot), the second a clearly visible fg line. Still on the
   * perspective dot plane.
   */
  honest?: boolean
  /** x position per point, 0 (left) to 1 (right), e.g. by time over a fixed window; default even spacing */
  at?: number[]
  /** x positions for series2; default `at` when the lengths match, else even spacing */
  at2?: number[]
  /** value gridlines (honest): v on the 0-100 series scale, labeled at the left end */
  ticks?: { v: number; label: string }[]
  /** labels under the baseline (honest): at 0-1 along x */
  xTicks?: { at: number; label: string }[]
  /** points from this index on are not live readings (a repeated fallback figure): drawn dim and dashed (honest) */
  tailFrom?: number
}

const H = 2.3 // height at 100%
const GRID = 0.3
const PZ = 2.5

const trackZ = (x: number) => 1.25 * Math.sin(x * 0.58 + 0.7) - 0.15 * Math.sin(x * 1.3)
const BASE_SPAN = 4.6
const WIDE_ASPECT = 2
const MAX_SPAN = 34
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

// honest chart: a fixed front-on camera over a straight path
const HONEST_PITCH = 13
const HONEST_SPAN = 5
// canvas text follows the v2 font setting (Mono by default, html[data-font])
const canvasFont = (px: number) => `500 ${px}px ${typeof document === 'undefined' ? 'system-ui, sans-serif' : getComputedStyle(document.body).fontFamily}`

/**
 * Valkyrie's 3D history chart: a tilted perspective dot plane with the series
 * as a glowing curve over a meandering path, faint drop lines to the floor,
 * and an arrow marker on the newest point. Draws in on mount, then drifts.
 * `honest` turns it into a square-on value chart with gridlines and labels.
 * (The name is historical; `Ribbon` is the same component.)
 */
export function TrackRibbon(props: TrackRibbonProps) {
  const { palette, label, height = 150, className, value, style } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const sharpRef = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<HTMLCanvasElement>(null)
  const propsRef = useRef(props)
  const st = useRef({
    raf: 0, visible: true, onscreen: true, w: 1, h: 1, dpr: 1, t0: -1, kick: () => {}, resize: () => {},
    fit: null as null | { s: number; ox: number; oy: number },
    // wide boxes get a longer track seen more from the front, so it fills the width
    span: BASE_SPAN, yaw: 26, pitch: 31,
    /** meander frequency scale: a stretched track keeps a calm curve */
    zf: 1, grid: GRID, fitMode: 'auto' as NonNullable<TrackRibbonProps['fit']>,
    /** plane bounds: x half-width, z behind (negative) and in front of the path */
    px: BASE_SPAN + 0.8, zLo: -PZ, zHi: PZ,
    /** height of 100% in world units */
    wallH: H,
    honest: false,
  })

  useLayoutEffect(() => {
    propsRef.current = props
    const s = st.current
    if ((props.fit ?? 'auto') !== s.fitMode || !!props.honest !== s.honest) s.resize()
    s.kick()
  })

  useEffect(() => {
    const wrap = wrapRef.current!, sharp = sharpRef.current!, glow = glowRef.current!
    const S = sharp.getContext('2d')!, G = glow.getContext('2d')!
    const s = st.current
    s.visible = !document.hidden
    const cam = new Camera({ yaw: 26, pitch: 31, dist: 10, fov: 34, target: [0, 0.55, 0] }, [0, 0, 0])
    const out = [0, 0, 0]
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    const reduced = () => (propsRef.current.motion ? propsRef.current.motion === 'reduced' : !!mq?.matches)

    // projected bounds of the plane and the curve's top at the current span
    const measure = () => {
      cam.cur.yaw = s.yaw
      cam.cur.pitch = s.pitch
      cam.cur.dist = 10 + (s.span - BASE_SPAN) * 0.9
      cam.cur.ty = s.honest ? s.wallH * 0.45 : 0.55
      cam.basis(s.w, s.h)
      const PX = s.px, SPAN = s.span, WH = s.wallH
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const [x, y, z] of [[-PX, 0, s.zLo], [PX, 0, s.zLo], [PX, 0, s.zHi], [-PX, 0, s.zHi], [-SPAN, WH, 0], [SPAN, WH, 0]]) {
        if (!cam.project(x, y, z, out)) continue
        x0 = Math.min(x0, out[0]); x1 = Math.max(x1, out[0]); y0 = Math.min(y0, out[1]); y1 = Math.max(y1, out[1])
      }
      // honest: room above the top gridline label and under the baseline labels
      const k = Math.min((s.w * 0.98) / (x1 - x0), (s.h * (s.honest ? 0.8 : 0.86)) / (y1 - y0))
      return { x0, x1, y0, y1, k, fill: ((x1 - x0) * k) / (s.w * 0.98) }
    }

    const fitCamera = () => {
      const aspect = s.w / s.h
      const p = propsRef.current
      const mode = p.fit ?? 'auto'
      s.fitMode = mode
      s.honest = !!p.honest
      if (s.honest) {
        // square on: x maps straight across, every point at the same depth
        s.yaw = 0
        s.pitch = HONEST_PITCH
        s.span = HONEST_SPAN
        s.px = HONEST_SPAN + 0.35
        s.zLo = -1.9
        s.zHi = 0.75
        s.zf = 1
        // the wall's on-screen aspect follows the box: about 62% of the height for the values
        s.wallH = clamp((2 * HONEST_SPAN * (s.h * 0.62)) / (s.w * 0.94 * Math.cos(HONEST_PITCH * DEG)), 0.6, 7)
        s.grid = clamp(s.wallH / 7, 0.2, 0.42)
        const m = measure()
        const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2
        s.fit = { s: m.k, ox: s.w / 2 - (cx - cam.ox) * m.k, oy: s.h * 0.5 - (cy - cam.oy) * m.k }
        return
      }
      s.pitch = 31
      s.wallH = H
      s.zLo = -PZ
      s.zHi = PZ
      s.span = BASE_SPAN * clamp(aspect / 2.4, 0.85, 3)
      s.px = s.span + 0.8
      s.yaw = 26 - 16 * smooth(2.4, 6, aspect)
      let m = measure()
      // 'width': lengthen the track until the plane spans the box (the height
      // binds first in a wide short box, which left the sides empty)
      if (mode === 'width' || (mode === 'auto' && aspect >= WIDE_ASPECT)) {
        for (let it = 0; it < 8 && m.fill < 0.985 && s.span < MAX_SPAN; it++) {
          s.span = Math.min(MAX_SPAN, s.span / Math.max(0.2, m.fill))
          s.px = s.span + 0.8
          m = measure()
        }
      }
      s.zf = Math.pow(BASE_SPAN / s.span, 0.6)
      // keep the dot pitch on screen close to the classic look on long tracks
      s.grid = GRID * clamp(Math.sqrt(s.span / (BASE_SPAN * 2)), 1, 2.2)
      const cx = (m.x0 + m.x1) / 2, cy = (m.y0 + m.y1) / 2
      s.fit = { s: m.k, ox: s.w / 2 - (cx - cam.ox) * m.k, oy: s.h * 0.54 - (cy - cam.oy) * m.k }
    }

    const size = () => {
      // layout size, not getBoundingClientRect: inside a tilting .vl-build the
      // transformed box is narrower, and ResizeObserver never corrects it
      s.w = Math.max(1, wrap.clientWidth); s.h = Math.max(1, wrap.clientHeight)
      s.dpr = Math.min(2, window.devicePixelRatio || 1)
      sharp.width = Math.round(s.w * s.dpr); sharp.height = Math.round(s.h * s.dpr)
      glow.width = Math.max(1, Math.round(s.w * 0.5)); glow.height = Math.max(1, Math.round(s.h * 0.5))
      fitCamera()
      kick()
    }

    const P = (x: number, y: number, z: number) => cam.project(x, y, z, out)

    const draw = (now: number) => {
      const p = propsRef.current
      const red = reduced()
      const honest = s.honest
      if (s.t0 < 0) s.t0 = now
      // a paused ribbon is a still picture: the finished chart, never a frozen draw-in
      const prog = red || p.paused ? 1 : easeOut(clamp((now - s.t0) / 1500, 0, 1))
      const fg: RGB = parseColor(p.palette.fg), hot: RGB = parseColor(p.palette.hot)
      const comp = clamp(Math.sqrt(0.8 / Math.max(0.05, (0.2126 * fg[0] + 0.7152 * fg[1] + 0.0722 * fg[2]) / 255)), 1, 1.7)
      const SPAN = s.span, PX = s.px, GR = s.grid, zf = s.zf, WH = s.wallH, ZL = s.zLo, ZH = s.zHi
      const tz = honest ? () => 0 : (x: number) => trackZ(x * zf)
      const drift = !honest && !red
      cam.cur.yaw = s.yaw + (drift ? Math.sin(now / 9000) * 5 : 0)
      cam.cur.pitch = s.pitch + (drift ? Math.sin(now / 13000) * 2 : 0)
      cam.basis(s.w, s.h)
      if (s.fit) { cam.focal *= s.fit.s; cam.ox = s.fit.ox; cam.oy = s.fit.oy }

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

      // dot plane, 4 alpha buckets by distance
      const lv: number[][] = [[], [], [], []]
      const zStep = honest ? GR : GRID
      const zFade = honest ? 0.5 : 0.9
      for (let x = -PX; x <= PX + 1e-6; x += GR) for (let z = ZL; z <= ZH + 1e-6; z += zStep) {
        if (!P(x, 0, z)) continue
        const edge = Math.min(1, (PX - Math.abs(x)) / 1.2) * Math.min(1, (z < 0 ? z - ZL : ZH - z) / zFade + (honest ? 0.15 : 0))
        const depth = clamp(1.35 - out[2] / (cam.dist * 1.25), 0.15, 1)
        const a = edge * depth * (honest ? 0.75 : 1)
        if (a < 0.06) continue
        lv[Math.min(3, (a * 4) | 0)].push(out[0], out[1], clamp((0.035 * cam.focal) / out[2], 0.45, 1.3))
      }
      lv.forEach((arr, i) => {
        if (!arr.length) return
        S.fillStyle = rgba(fg, ((i + 1) / 4) * 0.6 * comp)
        S.beginPath()
        for (let k = 0; k < arr.length; k += 3) { S.moveTo(arr[k] + arr[k + 2], arr[k + 1]); S.arc(arr[k], arr[k + 1], arr[k + 2], 0, 6.2832) }
        S.fill()
      })

      // honest: value gridlines on the wall, dotted, over the full width
      if (honest && p.ticks?.length) {
        S.beginPath()
        for (const t of p.ticks) {
          const y = (clamp(t.v, 0, 100) / 100) * WH
          for (let x = -SPAN; x <= SPAN + 1e-6; x += GR * 0.5) {
            if (!P(x, y, 0)) continue
            S.moveTo(out[0] + 0.6, out[1]); S.arc(out[0], out[1], 0.6, 0, 6.2832)
          }
        }
        S.fillStyle = rgba(fg, 0.34 * comp)
        S.fill()
      }

      const series = p.series
      const n = series.length
      const posOf = (arr: number[] | undefined, len: number) =>
        arr && arr.length === len ? (i: number) => -SPAN + 2 * SPAN * clamp(arr[i], 0, 1) : (i: number) => -SPAN + (2 * SPAN * i) / Math.max(1, len - 1)
      const tailFrom = honest && p.tailFrom != null && p.tailFrom >= 0 && p.tailFrom < n - 1 ? p.tailFrom : n
      let headPx: [number, number] | null = null
      if (n >= 2) {
        const xs = posOf(p.at, n)
        const head = prog * (n - 1)
        const pts: (null | [number, number, number])[] = series.map((v, i) => (v == null ? null : [xs(i), (clamp(v, 0, 100) / 100) * WH, tz(xs(i))]))
        // shown points, with an interpolated head while drawing in
        const shown: (null | [number, number, number])[] = []
        for (let i = 0; i < n && i <= Math.ceil(head); i++) {
          const q = pts[i]
          if (i > head && q && pts[i - 1]) {
            const a = pts[i - 1]!, f = head - (i - 1)
            shown.push([a[0] + (q[0] - a[0]) * f, a[1] + (q[1] - a[1]) * f, a[2] + (q[2] - a[2]) * f])
          } else shown.push(q)
        }
        // floor shadow of the track (in honest mode: the 0 baseline, full width)
        S.beginPath()
        if (honest) {
          if (P(-SPAN, 0, 0)) {
            S.moveTo(out[0], out[1])
            if (P(SPAN, 0, 0)) S.lineTo(out[0], out[1])
          }
          S.strokeStyle = rgba(fg, 0.3)
        } else {
          let pen = false
          for (const q of shown) {
            if (!q || !P(q[0], 0, q[2])) { pen = false; continue }
            if (!pen) { S.moveTo(out[0], out[1]); pen = true } else S.lineTo(out[0], out[1])
          }
          S.strokeStyle = rgba(fg, 0.16)
        }
        S.lineWidth = 1
        S.stroke()
        // drop lines: sparse for the body, a dense hatch curtain near the head
        const m = shown.length
        const tail = Math.max(1, Math.round(m * 0.78))
        S.beginPath()
        for (let i = 0; i < m; i++) {
          const q = shown[i]
          if (!q || i >= tail) continue
          if (i % 2) continue
          if (!P(q[0], q[1], q[2])) continue
          const ax = out[0], ay = out[1]
          if (!P(q[0], 0, q[2])) continue
          S.moveTo(ax, ay); S.lineTo(out[0], out[1])
        }
        S.strokeStyle = rgba(fg, honest ? 0.09 : 0.12)
        S.lineWidth = 0.7
        S.stroke()
        S.beginPath()
        for (let i = Math.max(1, tail - 1); i < m; i++) {
          const a = shown[i - 1], q = shown[i]
          if (!a || !q || i > tailFrom) continue
          for (let k = 0; k < 4; k++) {
            const f = k / 4
            const x = a[0] + (q[0] - a[0]) * f, y = a[1] + (q[1] - a[1]) * f, z = a[2] + (q[2] - a[2]) * f
            if (!P(x, y, z)) continue
            const ax = out[0], ay = out[1]
            if (!P(x, 0, z)) continue
            S.moveTo(ax, ay); S.lineTo(out[0], out[1])
          }
        }
        S.strokeStyle = rgba(mixRGB(fg, hot, 0.8), honest ? 0.22 : 0.3)
        S.lineWidth = 0.7
        S.stroke()

        // second series: no drops; faint in the classic look, a clear fg line when honest
        if (p.series2 && p.series2.length >= 2) {
          const n2 = p.series2.length
          const xs2 = posOf(p.at2 ?? (p.at && p.at.length === n2 ? p.at : undefined), n2)
          S.beginPath(); G.beginPath()
          let on = false
          for (let i = 0; i < n2; i++) {
            const t = i / (n2 - 1)
            if (t * (n - 1) > head) break
            const v = p.series2[i]
            const x = xs2(i)
            if (v == null || !P(x, (clamp(v, 0, 100) / 100) * WH, tz(x))) { on = false; continue }
            if (!on) { S.moveTo(out[0], out[1]); G.moveTo(out[0], out[1]); on = true } else { S.lineTo(out[0], out[1]); G.lineTo(out[0], out[1]) }
          }
          if (honest) {
            S.strokeStyle = rgba(fg, 0.78); S.lineWidth = 1.25; S.stroke()
            G.strokeStyle = rgba(fg, 0.3); G.lineWidth = 3.5; G.stroke()
          } else {
            S.strokeStyle = rgba(fg, 0.38)
            S.lineWidth = 0.9
            S.stroke()
          }
        }

        // the curve: fg -> hot in chunks (honest: one hot color, the fallback tail dashed), sharp + glow
        const scr: (null | [number, number])[] = shown.map((q) => (q && P(q[0], q[1], q[2]) ? [out[0], out[1]] : null))
        const CH = honest ? 1 : 10
        const liveEnd = Math.min(m - 1, tailFrom)
        for (let c = 0; c < CH; c++) {
          const i0 = Math.floor((c * liveEnd) / CH), i1 = Math.floor(((c + 1) * liveEnd) / CH)
          if (i1 <= i0 && c < CH - 1) continue
          const col = honest ? hot : mixRGB(fg, hot, smooth(0, 1, (c + 0.5) / CH))
          S.beginPath(); G.beginPath()
          let on = false
          for (let i = i0; i <= Math.min(liveEnd, i1); i++) {
            const q = scr[i]
            if (!q) { on = false; continue }
            if (!on) { S.moveTo(q[0], q[1]); G.moveTo(q[0], q[1]); on = true } else { S.lineTo(q[0], q[1]); G.lineTo(q[0], q[1]) }
          }
          S.strokeStyle = rgba(col, 0.95); S.lineWidth = honest ? 1.6 : 1.7; S.stroke()
          G.strokeStyle = rgba(col, honest ? 0.6 : 0.75); G.lineWidth = 5; G.stroke()
        }
        if (tailFrom < m - 1) {
          S.beginPath()
          let on = false
          for (let i = tailFrom; i < m; i++) {
            const q = scr[i]
            if (!q) { on = false; continue }
            if (!on) { S.moveTo(q[0], q[1]); on = true } else S.lineTo(q[0], q[1])
          }
          S.setLineDash([3, 4])
          S.strokeStyle = rgba(fg, 0.5); S.lineWidth = 1.2; S.stroke()
          S.setLineDash([])
        }

        // arrow marker at the newest shown point
        let li = m - 1
        while (li > 0 && !scr[li]) li--
        const hp = scr[li]
        if (hp) {
          headPx = hp
          let pi = li - 1
          while (pi > 0 && (!scr[pi] || Math.hypot(scr[pi]![0] - hp[0], scr[pi]![1] - hp[1]) < 6)) pi--
          const pp = scr[pi] ?? [hp[0] - 10, hp[1]]
          let dx = hp[0] - pp[0], dy = hp[1] - pp[1]
          const dl = Math.hypot(dx, dy) || 1
          dx /= dl; dy /= dl
          const L = honest ? 9 : 11, Wd = honest ? 5 : 6
          const tip: [number, number] = [hp[0] + dx * L * 0.55, hp[1] + dy * L * 0.55]
          const bx = hp[0] - dx * L * 0.45, by = hp[1] - dy * L * 0.45
          const white = mixRGB(fg, [255, 255, 255], 0.55)
          for (const [ctx, a] of [[S, 1], [G, 0.9]] as const) {
            ctx.fillStyle = rgba(white, a)
            ctx.beginPath()
            ctx.moveTo(tip[0], tip[1])
            ctx.lineTo(bx - dy * Wd, by + dx * Wd)
            ctx.lineTo(hp[0] - dx * L * 0.15, hp[1] - dy * L * 0.15)
            ctx.lineTo(bx + dy * Wd, by - dx * Wd)
            ctx.closePath()
            ctx.fill()
          }
          const pulse = red ? 0.5 : 0.5 + 0.5 * Math.sin(now / 320)
          G.strokeStyle = rgba(hot, 0.5 + 0.4 * pulse)
          G.lineWidth = 2
          G.beginPath(); G.arc(hp[0], hp[1], (honest ? 6 : 8) + pulse * (honest ? 3 : 5), 0, 6.2832); G.stroke()
        }
      }

      // honest: labels last, on top, with a black halo so a line under them never hides them
      if (honest && (p.ticks?.length || p.xTicks?.length)) {
        S.globalCompositeOperation = 'source-over'
        S.font = canvasFont(10)
        S.lineWidth = 3
        S.strokeStyle = 'rgba(0,0,0,0.9)'
        S.fillStyle = rgba(fg, 0.72)
        S.textBaseline = 'alphabetic'
        S.textAlign = 'left'
        for (const t of p.ticks ?? []) {
          if (!P(-SPAN, (clamp(t.v, 0, 100) / 100) * WH, 0)) continue
          const x = out[0] + 1, y = out[1] - 3
          S.strokeText(t.label, x, y); S.fillText(t.label, x, y)
        }
        S.textBaseline = 'top'
        for (const t of p.xTicks ?? []) {
          const at = clamp(t.at, 0, 1)
          if (!P(-SPAN + 2 * SPAN * at, 0, 0)) continue
          S.textAlign = at < 0.04 ? 'left' : at > 0.96 ? 'right' : 'center'
          let x = out[0]
          const y = out[1] + 4
          // a newest point low on the baseline: set the label beside the marker, not under it
          if (headPx && Math.abs(headPx[0] - x) < 14 && y - headPx[1] < 12) { S.textAlign = 'right'; x = Math.min(x, headPx[0] - 12) }
          S.strokeText(t.label, x, y); S.fillText(t.label, x, y)
        }
      }
      return prog < 1 || !red
    }

    function tick(now: number) {
      s.raf = 0
      if (!s.visible || !s.onscreen) return
      const keep = draw(now)
      if (keep && !propsRef.current.paused) s.raf = requestAnimationFrame(tick)
    }
    function kick() {
      if (!s.raf && s.visible && s.onscreen) s.raf = requestAnimationFrame(tick)
    }
    s.kick = kick
    s.resize = size
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
      s.resize = () => {}
    }
  }, [])

  const head = { font: '500 12px/1 var(--font)', letterSpacing: '.01em', fontVariantNumeric: 'tabular-nums' as const }
  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', height, overflow: 'hidden', ...style }}>
      <canvas ref={glowRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'blur(4px)', pointerEvents: 'none' }} />
      <canvas ref={sharpRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      {label && <span style={{ ...head, position: 'absolute', left: 8, top: 8, color: palette.fg }}>{label}</span>}
      {value != null && <span style={{ ...head, position: 'absolute', right: 8, top: 8, color: palette.fg, textAlign: 'right' }}>{value}</span>}
    </div>
  )
}
