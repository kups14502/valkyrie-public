import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import type { Palette } from '../theme'
import { Camera, Orbit, compile, type CameraPose, type Model } from './engine'
import { Renderer, type Beam, type Flow, type Fx, type Light } from './render'

export { projectHotspots } from './engine'

/** ms = average JS draw time per frame; parts = smoothed split (floor+pools, segment projection, line strokes, faces+flow+beams+bulbs) */
export type FrameStats = { ms: number; fps: number; segs: number; dots: number; parts: { floor: number; project: number; strokes: number; fx: number } }

export type WireSceneProps = {
  model: Model
  /** tweened ~900 ms (ease in-out) whenever it changes; degrees */
  pose: CameraPose
  palette: Palette
  /** group -> 0..1; a group missing here glows at 0.35 */
  heat?: Record<string, number>
  floor?: boolean
  beams?: Beam[]
  flow?: Flow[]
  lights?: Light[]
  orbit?: boolean
  autoSpin?: number
  paused?: boolean
  onHotspot?: (id: string, screen: { x: number; y: number }) => void
  showHotspots?: boolean
  className?: string
  // ---- extras ----
  style?: CSSProperties
  /** highlights one diamond and shows its label */
  activeHotspot?: string | null
  /** show every hotspot's label, not just the active one */
  hotspotLabels?: boolean
  /** 'reduced': no spin, no flow, no blade spin, no pulse, 120 ms camera moves. Default follows prefers-reduced-motion. */
  motion?: 'full' | 'reduced'
  /** fan blade speed multiplier (blades also speed up with heat.fans), default 1, 0 = still */
  spin?: number
  /** floor disc radius in model radii, default 3.4 */
  floorExtent?: number
  /** bloom layer opacity 0..1, default 1 */
  glow?: number
  /** called about twice a second with the average draw time */
  onFrameTime?: (s: FrameStats) => void
  /** HTML overlay drawn above the canvases (inside the same box) */
  children?: ReactNode
  /**
   * Where an orbit drag may start. 'box' (default): anywhere in the scene.
   * 'model': only a disc around the model (it follows the camera), so a
   * full-screen scene still leaves the empty floor to the shell's swipe pager.
   */
  orbitArea?: 'box' | 'model'
}

const NONE: never[] = []

type Engine = {
  r: Renderer
  cam: Camera
  orbit: Orbit
  raf: number
  last: number
  visible: boolean
  onscreen: boolean
  dirty: boolean
  reducedMQ: boolean
  hs: { x: number; y: number; ok: boolean; o: number }[]
  sumMs: number
  frames: number
  statT: number
}

const DIAMOND = 12

/** The UI zoom lib/zoom puts on <html> (1 in a browser that never set one). */
const uiZoom = (): number => {
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'))
  return Number.isFinite(z) && z > 0 ? z : 1
}

/**
 * The x-ray stage: perspective dot floor, the wireframe hero, beams, airflow,
 * bulbs and tappable diamond hotspots. One RAF loop that stops when paused,
 * hidden, or scrolled offscreen. Hotspots move by transform from refs, so a
 * frame never re-renders React.
 */
export function WireScene(props: WireSceneProps) {
  const {
    model, pose, palette, orbit = false, showHotspots = true, className, style,
    activeHotspot, hotspotLabels = false, glow = 1, children,
  } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const sharpRef = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<HTMLCanvasElement>(null)
  const hotRefs = useRef<(HTMLButtonElement | null)[]>([])
  const zoneRef = useRef<HTMLDivElement>(null)
  const zoneAt = useRef({ x: -1, y: -1, r: -1 })
  const propsRef = useRef(props)
  const eng = useRef<Engine | null>(null)
  const [pressed, setPressed] = useState<string | null>(null)
  const zoneOnly = orbit && props.orbitArea === 'model'

  const kick = () => {
    const e = eng.current
    if (!e) return
    e.dirty = true
    if (!e.raf && e.visible && e.onscreen) e.raf = requestAnimationFrame(tick)
  }

  const reduced = () => {
    const m = propsRef.current.motion
    return m ? m === 'reduced' : !!eng.current?.reducedMQ
  }

  const placeHotspots = () => {
    const e = eng.current
    if (!e) return
    const hs = propsRef.current.model.hotspots
    const cam = e.cam
    const out = [0, 0, 0]
    const c = compile(propsRef.current.model)
    // depth of the model center, to dim diamonds on the far side
    const dz = (c.center[0] - cam.px) * cam.fx + (c.center[1] - cam.py) * cam.fy + (c.center[2] - cam.pz) * cam.fz
    for (let i = 0; i < hs.length; i++) {
      const el = hotRefs.current[i]
      const at = hs[i].at
      const ok = cam.project(at[0], at[1], at[2], out) && out[0] > -20 && out[0] < e.r.w + 20 && out[1] > -20 && out[1] < e.r.h + 20
      const o = !ok ? 0 : out[2] > dz + c.radius * 0.15 ? 0.5 : 1
      const prev = e.hs[i] ?? { x: -1, y: -1, ok: false, o: -1 }
      e.hs[i] = { x: out[0], y: out[1], ok, o }
      if (!el) continue
      if (ok && (Math.abs(prev.x - out[0]) > 0.05 || Math.abs(prev.y - out[1]) > 0.05 || !prev.ok)) {
        el.style.transform = `translate3d(${out[0].toFixed(1)}px, ${out[1].toFixed(1)}px, 0)`
      }
      if (o !== prev.o) {
        el.style.opacity = String(o)
        el.style.pointerEvents = ok ? 'auto' : 'none'
      }
    }
    // orbit disc around the model (orbitArea 'model'), follows the camera
    const z = zoneRef.current
    if (z) {
      const vis = cam.project(c.center[0], c.center[1], c.center[2], out)
      const r = vis ? Math.max(40, ((cam.focal * c.radius) / out[2]) * 0.78) : 0
      const zp = zoneAt.current
      if (Math.abs(zp.x - out[0]) > 0.5 || Math.abs(zp.y - out[1]) > 0.5 || Math.abs(zp.r - r) > 0.5) {
        zoneAt.current = { x: out[0], y: out[1], r }
        z.style.width = z.style.height = `${(r * 2).toFixed(1)}px`
        z.style.transform = `translate3d(${(out[0] - r).toFixed(1)}px, ${(out[1] - r).toFixed(1)}px, 0)`
      }
    }
  }

  const fxOf = (): Fx => {
    const p = propsRef.current
    return {
      heat: p.heat,
      floor: p.floor ?? true,
      beams: p.beams ?? NONE,
      flow: p.flow ?? NONE,
      lights: p.lights ?? NONE,
      reduced: reduced(),
      floorExtent: p.floorExtent ?? 3.4,
      spin: p.spin ?? 1,
    }
  }

  function tick(now: number) {
    const e = eng.current
    if (!e) return
    e.raf = 0
    if (!e.visible || !e.onscreen) return
    const p = propsRef.current
    const running = !p.paused
    const dt = e.last ? Math.min(0.05, (now - e.last) / 1000) : 1 / 60
    e.last = running ? now : 0
    const red = reduced()
    if (!running) {
      // one still frame: land the camera and the colors where they are going
      e.cam.cur = { ...e.cam.to }
    }
    e.cam.step(now)
    e.orbit.update(e.cam, now, dt)
    if (running && !red && p.autoSpin && !e.orbit.dragging) e.cam.spinYaw = (e.cam.spinYaw + p.autoSpin * dt) % 360
    const t0 = performance.now()
    e.r.frame(now, running ? dt : 0, e.cam, fxOf())
    const ms = performance.now() - t0
    placeHotspots()
    e.dirty = false
    if (running) {
      e.sumMs += ms
      e.frames++
      if (now - e.statT > 500) {
        const avg = e.sumMs / Math.max(1, e.frames)
        const fps = (e.frames * 1000) / (now - e.statT)
        wrapRef.current?.setAttribute('data-ms', avg.toFixed(2))
        const st = e.r.stats
        p.onFrameTime?.({ ms: avg, fps, segs: st.segs, dots: st.dots, parts: { floor: st.tFloor, project: st.tSegs, strokes: st.tDraw, fx: st.tFx } })
        e.sumMs = 0; e.frames = 0; e.statT = now
      }
      e.raf = requestAnimationFrame(tick)
    }
  }

  // keep the latest props for the loop; redraw when anything changes
  useLayoutEffect(() => {
    propsRef.current = props
    kick()
  })

  // mount: renderer, camera, observers, loop
  useEffect(() => {
    const wrap = wrapRef.current!, sharp = sharpRef.current!, glowC = glowRef.current!
    const p = propsRef.current
    const c = compile(p.model)
    const r = new Renderer(sharp, glowC)
    r.setModel(c, p.floorExtent ?? 3.4)
    r.setPalette(p.palette, performance.now(), true)
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    const e: Engine = {
      r, cam: new Camera(p.pose, c.center), orbit: new Orbit(), raf: 0, last: 0,
      visible: !document.hidden, onscreen: true, dirty: true, reducedMQ: !!mq?.matches,
      hs: [], sumMs: 0, frames: 0, statT: performance.now(),
    }
    eng.current = e
    // dev builds only: the probe reads the live camera to check every diamond against its projected point
    if (import.meta.env.DEV) (wrap as HTMLDivElement & { __wire?: Engine }).__wire = e
    // The renderer works in the box's own CSS px (layout size), the space the
    // diamonds, the orbit disc and any overlay are positioned in. Under the UI
    // zoom (lib/zoom: CSS zoom on <html>) a client rect is zoomed and those
    // transforms are not: sizing from the client rect put every diamond zoom x
    // its distance from the corner, beside the model at his 1.2 (a tilting
    // .vl-build parent skews a client rect the same way). The zoom goes into
    // the backing store instead, so the lines stay sharp.
    const size = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight
      const dpr = Math.min(2, (window.devicePixelRatio || 1) * uiZoom())
      if (w === r.w && h === r.h && Math.abs(dpr - r.dpr) < 0.01) return
      r.resize(w, h, dpr)
      kick()
    }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(wrap)
    // applyZoom fires a window resize: the box keeps its CSS size, only the backing store changes
    window.addEventListener('resize', size)
    const io = new IntersectionObserver((ents) => {
      const vis = ents.some((x) => x.isIntersecting)
      if (vis !== e.onscreen) { e.onscreen = vis; e.last = 0; if (vis) kick() }
    })
    io.observe(wrap)
    const onVis = () => { e.visible = !document.hidden; e.last = 0; if (e.visible) kick() }
    document.addEventListener('visibilitychange', onVis)
    const onMQ = () => { e.reducedMQ = !!mq?.matches; kick() }
    mq?.addEventListener('change', onMQ)
    kick()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', size)
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      mq?.removeEventListener('change', onMQ)
      if (e.raf) cancelAnimationFrame(e.raf)
      eng.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // model swap (memoize models: a new object every render recompiles it)
  useEffect(() => {
    const e = eng.current
    if (!e) return
    const prev = e.r.model?.center
    const c = compile(model)
    e.r.setModel(c, propsRef.current.floorExtent ?? 3.4)
    e.hs = []
    // re-aim only when the orbit target moves; same-center swaps keep drag/spin state
    if (!propsRef.current.pose.target && (!prev || prev[0] !== c.center[0] || prev[1] !== c.center[1] || prev[2] !== c.center[2])) {
      e.cam.setPose(propsRef.current.pose, c.center, performance.now(), reduced() ? 120 : 900)
    }
    kick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, props.floorExtent])

  // pose change flies the camera. A paused scene snaps, so a hidden screen can
  // follow the shell's pose and fly back from that angle once it is active.
  const poseKey = JSON.stringify(pose)
  useEffect(() => {
    const e = eng.current
    if (!e) return
    const dur = propsRef.current.paused ? 0 : reduced() ? 120 : 900
    e.cam.setPose(propsRef.current.pose, compile(propsRef.current.model).center, performance.now(), dur)
    kick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poseKey])

  // palette morph
  useEffect(() => {
    const e = eng.current
    if (!e) return
    e.r.setPalette(palette, performance.now(), reduced())
    kick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette.mode, palette.fg, palette.hot, palette.acc2])

  // ---- orbit drag ----
  const onDown = (ev: RPointerEvent<HTMLDivElement>) => {
    if (!orbit || !eng.current) return
    if ((ev.target as HTMLElement).closest('[data-hotspot]')) return
    const cap = zoneOnly ? zoneRef.current : ev.currentTarget
    if (!cap || (zoneOnly && ev.target !== cap)) return
    cap.setPointerCapture(ev.pointerId)
    eng.current.orbit.down(ev.clientX, ev.clientY, performance.now())
    kick()
  }
  const onMove = (ev: RPointerEvent<HTMLDivElement>) => {
    const e = eng.current
    if (!e || !e.orbit.dragging) return
    e.orbit.move(e.cam, ev.clientX, ev.clientY, performance.now())
    kick()
  }
  const onUp = () => {
    const e = eng.current
    if (!e) return
    e.orbit.up(performance.now())
    kick()
  }

  const fg = palette.fg
  const fgRgb = palette.fgRgb
  const hotRgb = palette.hotRgb

  return (
    <div
      ref={wrapRef}
      className={className}
      data-wire-scene=""
      {...(orbit ? { 'data-no-swipe': '' } : {})}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{
        position: 'relative', overflow: 'hidden', touchAction: orbit && !zoneOnly ? 'none' : undefined,
        userSelect: 'none', WebkitUserSelect: 'none', cursor: orbit && !zoneOnly ? 'grab' : undefined,
        ...(zoneOnly ? { pointerEvents: 'none' as const } : null), ...style,
      }}
    >
      <canvas
        ref={glowRef}
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'blur(5px)', opacity: glow, pointerEvents: 'none' }}
      />
      <canvas ref={sharpRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      {zoneOnly && (
        <div
          ref={zoneRef}
          data-orbit-zone=""
          aria-hidden
          style={{
            position: 'absolute', left: 0, top: 0, width: 0, height: 0, borderRadius: '50%', pointerEvents: 'auto',
            touchAction: 'none', cursor: 'grab', willChange: 'transform',
          }}
        />
      )}
      {showHotspots && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {model.hotspots.map((h, i) => {
            const active = activeHotspot === h.id
            const down = pressed === h.id
            return (
              <button
                key={h.id}
                type="button"
                data-hotspot={h.id}
                aria-label={h.label}
                ref={(el) => { hotRefs.current[i] = el }}
                onPointerDown={(ev) => { ev.stopPropagation(); setPressed(h.id) }}
                onPointerUp={() => setPressed(null)}
                onPointerLeave={() => setPressed(null)}
                onClick={() => {
                  const pt = eng.current?.hs[i]
                  propsRef.current.onHotspot?.(h.id, { x: pt?.x ?? 0, y: pt?.y ?? 0 })
                }}
                style={{
                  position: 'absolute', left: 0, top: 0, width: 44, height: 44, marginLeft: -22, marginTop: -22,
                  padding: 0, border: 0, background: 'transparent', cursor: 'pointer', opacity: 0,
                  touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent', willChange: 'transform',
                  transition: 'opacity 200ms',
                }}
              >
                <span
                  style={{
                    pointerEvents: 'none',
                    position: 'absolute', left: '50%', top: '50%', width: DIAMOND, height: DIAMOND,
                    marginLeft: -DIAMOND / 2, marginTop: -DIAMOND / 2,
                    transform: `rotate(45deg) scale(${down ? 1.35 : active ? 1.2 : 1})`,
                    border: `1.4px solid ${fg}`,
                    background: active || down ? `rgba(${fgRgb}, .9)` : 'rgba(0,0,0,.45)',
                    boxShadow: active || down ? `0 0 10px rgba(${fgRgb}, .9), 0 0 22px rgba(${hotRgb}, .45)` : `0 0 6px rgba(${fgRgb}, .55)`,
                    transition: 'transform 120ms, background 120ms',
                  }}
                />
                <span
                  style={{
                    pointerEvents: 'none', opacity: active || down ? 0 : 1,
                    position: 'absolute', left: '50%', top: '50%', width: 3, height: 3, marginLeft: -1.5, marginTop: -1.5,
                    transform: 'rotate(45deg)', background: fg,
                  }}
                />
                {(active || hotspotLabels) && (
                  <span
                    style={{
                      position: 'absolute', left: 40, top: '50%', transform: 'translateY(-50%)', whiteSpace: 'nowrap',
                      font: '500 11px/1 var(--font)', letterSpacing: '.02em', color: fg,
                      textShadow: `0 0 3px #000, 0 0 8px rgba(${fgRgb}, .55)`, pointerEvents: 'none',
                    }}
                  >
                    {h.label}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
}
