import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

// Motion primitives for v2. Everything here animates transform/opacity
// through plain RAF loops that stop as soon as they settle, so an idle screen
// costs nothing.

// ---------- motion setting (Display > Motion) merged with the OS setting ----------

export type MotionSetting = 'full' | 'reduced'

const MOTION_KEY = 'v2.motion'
const motionListeners = new Set<() => void>()

function readMotion(): MotionSetting {
  try { return localStorage.getItem(MOTION_KEY) === 'reduced' ? 'reduced' : 'full' } catch { return 'full' }
}

let motionSetting: MotionSetting = typeof window === 'undefined' ? 'full' : readMotion()
if (typeof document !== 'undefined') document.documentElement.dataset.motion = motionSetting

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
mq?.addEventListener?.('change', () => motionListeners.forEach((l) => l()))

const subscribeMotion = (l: () => void) => {
  motionListeners.add(l)
  return () => { motionListeners.delete(l) }
}

export function getMotionSetting(): MotionSetting {
  return motionSetting
}

export function setMotionSetting(m: MotionSetting): void {
  motionSetting = m
  try { localStorage.setItem(MOTION_KEY, m) } catch { /* storage unavailable */ }
  document.documentElement.dataset.motion = m
  motionListeners.forEach((l) => l())
}

export function useMotionSetting(): [MotionSetting, (m: MotionSetting) => void] {
  const m = useSyncExternalStore(subscribeMotion, getMotionSetting, () => 'full' as MotionSetting)
  return [m, setMotionSetting]
}

export function prefersReducedMotion(): boolean {
  return !!mq?.matches
}

/** True when either the OS asks for less motion or Display > Motion is Reduced. */
export function isReducedMotion(): boolean {
  return motionSetting === 'reduced' || prefersReducedMotion()
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, isReducedMotion, () => false)
}

// ---------- springs ----------

export type SpringOpts = {
  /** default 320 */
  stiffness?: number
  /** default 2*sqrt(stiffness) * 0.92 (a hair under critical) */
  damping?: number
  /** settle threshold on both position and velocity, default 0.001 */
  precision?: number
}

/**
 * Animate a number with a spring. Calls onUpdate every frame with the value and
 * velocity (units/s). Returns a cancel function. With reduced motion the value
 * jumps to `to` in the next frame.
 */
export function animateSpring(
  from: number,
  to: number,
  onUpdate: (v: number, velocity: number) => void,
  opts: SpringOpts & { velocity?: number; onDone?: () => void; instant?: boolean } = {},
): () => void {
  const k = opts.stiffness ?? 320
  const c = opts.damping ?? 2 * Math.sqrt(k) * 0.92
  const eps = opts.precision ?? 0.001
  let x = from
  let v = opts.velocity ?? 0
  let raf = 0
  let last = 0
  let cancelled = false
  if (opts.instant || isReducedMotion()) {
    raf = requestAnimationFrame(() => {
      if (cancelled) return
      onUpdate(to, 0)
      opts.onDone?.()
    })
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }
  const step = (t: number) => {
    if (cancelled) return
    if (!last) last = t - 16
    let dt = Math.min(0.05, (t - last) / 1000)
    last = t
    // fixed sub-steps keep the integration stable on slow frames
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240)
      const a = -k * (x - to) - c * v
      v += a * h
      x += v * h
      dt -= h
    }
    if (Math.abs(x - to) < eps && Math.abs(v) < eps * 10) {
      onUpdate(to, 0)
      opts.onDone?.()
      return
    }
    onUpdate(x, v)
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => { cancelled = true; cancelAnimationFrame(raf) }
}

/** A number that springs toward `target`. Re-renders per frame while moving. */
export function useSpringNumber(target: number, opts?: SpringOpts): number {
  const [v, setV] = useState(target)
  const cur = useRef({ x: target, vel: 0 })
  useEffect(() => {
    const stop = animateSpring(cur.current.x, target, (x, vel) => {
      cur.current = { x, vel }
      setV(x)
    }, { ...opts, velocity: cur.current.vel, precision: Math.max(0.01, Math.abs(target) * 0.0005) })
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])
  return v
}

// ---------- swipe pager ----------

export type SwipePagerOpts = {
  count: number
  /** committed page index (the shell's active tab) */
  index: number
  /** called on release when a swipe lands on a different page */
  onCommit: (i: number) => void
  /** called every frame with the float page position (0 = first page) */
  onFrame: (pos: number) => void
  /** gestures on these descendants are ignored, default '[data-no-swipe]' */
  ignore?: string
  enabled?: boolean
}

export type SwipePager = {
  /** set the position at once (tab tap, deep link) */
  jump: (i: number) => void
  /** spring to a page */
  settle: (i: number, velocity?: number) => void
  /** current float position */
  pos: () => number
  /** true while a finger is dragging horizontally */
  dragging: () => boolean
}

const LOCK_PX = 8
const FLICK_PX_PER_MS = 0.35

/** iOS-like rubber band: x pages past the end shows as at most ~0.55 pages. */
function rubber(x: number): number {
  return (1 - 1 / (x * 0.55 + 1)) * 0.55
}

/**
 * Finger-following horizontal paging. Axis lock on the first 8 px (vertical
 * drags go to the page's native scroller), rubber band at the ends, velocity
 * flick, ~300 ms spring settle. The element should carry `touch-action: pan-y`
 * so the browser leaves horizontal touch moves to us.
 */
export function useSwipePager(ref: RefObject<HTMLElement | null>, opts: SwipePagerOpts): SwipePager {
  const o = useRef(opts)
  o.current = opts
  const st = useRef({
    pos: opts.index,
    stop: null as null | (() => void),
    drag: null as null | {
      id: number; x0: number; y0: number; axis: 'x' | 'y' | null; start: number; startIndex: number
      w: number; lastX: number; lastT: number; vx: number
    },
  })

  const api = useRef<SwipePager>(null as unknown as SwipePager)
  if (!api.current) {
    const set = (p: number) => {
      st.current.pos = p
      o.current.onFrame(p)
    }
    api.current = {
      jump: (i) => {
        st.current.stop?.()
        st.current.stop = null
        set(i)
      },
      settle: (i, velocity = 0) => {
        st.current.stop?.()
        st.current.stop = animateSpring(st.current.pos, i, (p) => set(p), {
          velocity, stiffness: 300, precision: 0.0005,
          onDone: () => { st.current.stop = null },
        })
      },
      pos: () => st.current.pos,
      dragging: () => st.current.drag?.axis === 'x',
    }
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ignore = () => o.current.ignore ?? '[data-no-swipe]'

    const down = (e: PointerEvent) => {
      if (o.current.enabled === false) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (st.current.drag) return
      const t = e.target as Element | null
      if (t?.closest?.(ignore())) return
      st.current.drag = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, start: st.current.pos,
        startIndex: o.current.index, w: el.clientWidth || 1, lastX: e.clientX, lastT: e.timeStamp, vx: 0,
      }
    }

    const move = (e: PointerEvent) => {
      const d = st.current.drag
      if (!d || e.pointerId !== d.id) return
      const dx = e.clientX - d.x0
      const dy = e.clientY - d.y0
      if (!d.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return
        d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        if (d.axis === 'y') { st.current.drag = null; return }
        try { el.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
        st.current.stop?.()
        st.current.stop = null
        d.start = st.current.pos
        el.dataset.swiping = ''
      }
      e.preventDefault()
      const dt = Math.max(1, e.timeStamp - d.lastT)
      const inst = (e.clientX - d.lastX) / dt
      d.vx = d.vx * 0.3 + inst * 0.7
      d.lastX = e.clientX
      d.lastT = e.timeStamp
      const max = o.current.count - 1
      let p = d.start - dx / d.w
      if (p < 0) p = -rubber(-p)
      else if (p > max) p = max + rubber(p - max)
      st.current.pos = p
      o.current.onFrame(p)
    }

    const up = (e: PointerEvent) => {
      const d = st.current.drag
      if (!d || e.pointerId !== d.id) return
      st.current.drag = null
      if (d.axis !== 'x') return
      delete el.dataset.swiping
      try { el.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      // a velocity sample older than 80 ms means the finger stopped before lifting
      const vx = e.timeStamp - d.lastT > 80 ? 0 : d.vx
      const max = o.current.count - 1
      const pos = st.current.pos
      let target = Math.round(pos)
      if (e.type !== 'pointercancel' && Math.abs(vx) > FLICK_PX_PER_MS) {
        target = vx < 0 ? Math.floor(pos) + 1 : Math.ceil(pos) - 1
        // one page per flick
        target = Math.max(d.startIndex - 1, Math.min(d.startIndex + 1, target))
      }
      target = Math.max(0, Math.min(max, target))
      // swallow the click a drag would otherwise produce
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      api.current.settle(target, (-vx * 1000) / d.w)
      if (target !== o.current.index) o.current.onCommit(target)
    }

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      st.current.stop?.()
    }
  }, [ref])

  return api.current
}
