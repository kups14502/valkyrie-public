import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

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

// ---------- pager ----------

export type PagerOpts = {
  /** committed page index (the shell's active tab) */
  index: number
  /** called every frame with the float page position (0 = first page) */
  onFrame: (pos: number) => void
}

export type Pager = {
  /** set the position at once (tab tap, deep link) */
  jump: (i: number) => void
  /** spring to a page */
  settle: (i: number, velocity?: number) => void
  /** current float position */
  pos: () => number
}

/**
 * Horizontal page position with a ~300 ms spring settle. Tabs change by tap,
 * key or URL only: dragging the screen sideways does nothing.
 */
export function usePager(opts: PagerOpts): Pager {
  const o = useRef(opts)
  o.current = opts
  const st = useRef({ pos: opts.index, stop: null as null | (() => void) })

  const api = useRef<Pager>(null as unknown as Pager)
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
    }
  }

  useEffect(() => () => st.current.stop?.(), [])

  return api.current
}
