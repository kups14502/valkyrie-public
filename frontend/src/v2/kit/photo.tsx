import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './photo.css'

// A picture shown full size over everything (a Raven thumbnail opens one). Four ways out: the X in the top-right
// corner (clear of the notch and the home bar), a tap on the dark around the picture, Escape, and on touch a swipe
// down. In the desktop app it starts under the strip, so the window's own buttons stay where they are.

/** how far down a finger must drag the picture to close it, in px; a fast flick needs less */
const DISMISS_PX = 90
const FLICK_PX = 30
const FLICK_SPEED = 0.6
/** a press that moves less than this is a tap */
const TAP_SLOP = 10

/** The viewer. Mount it while it is open; `onClose` unmounts it. */
export function PhotoViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const xBtn = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose })
  // the press in progress: where it started, whether it started on the dark, and whether it has moved
  const press = useRef<{ id: number; x: number; y: number; t: number; back: boolean; moved: boolean; drag: boolean } | null>(null)
  const closing = useRef(false)

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    xBtn.current?.focus({ preventScroll: true })
    // capture, before every other Escape in the app: the viewer closes, nothing under it does
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  const setDrag = (dy: number, animate: boolean) => {
    const el = img.current
    const r = root.current
    if (!el || !r) return
    el.style.transition = animate ? '' : 'none'
    r.style.transition = animate ? '' : 'none'
    el.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : ''
    r.style.setProperty('--fade', String(Math.max(0, 1 - dy / 400)))
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || closing.current) { press.current = null; return }
    const t = e.target as Element
    const back = !t.closest('.vk-photo-img, .vk-photo-x')
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, back, moved: false, drag: e.pointerType !== 'mouse' && !t.closest('.vk-photo-x') }
    if (press.current.drag) root.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) p.moved = true
    if (p.drag) setDrag(Math.max(0, e.clientY - p.y), false)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || p.id !== e.pointerId || !p.drag) return
    const dy = Math.max(0, e.clientY - p.y)
    const speed = dy / Math.max(1, e.timeStamp - p.t)
    if (dy >= DISMISS_PX || (dy >= FLICK_PX && speed >= FLICK_SPEED)) {
      closing.current = true
      const reduced = document.documentElement.dataset.motion === 'reduced'
      if (reduced) { close.current(); return }
      setDrag(Math.max(dy, window.innerHeight), true)
      window.setTimeout(() => close.current(), 160)
      return
    }
    setDrag(0, true)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (press.current?.id !== e.pointerId) return
    press.current = null
    setDrag(0, true)
  }

  // a tap on the dark closes it; a tap on the picture, or a drag, does not. Judged by where the press began: a
  // finger's press is captured by the viewer, so its click lands on the viewer itself. On click, not pointerup, so
  // the tap's own click never lands on whatever is under the viewer once it is gone.
  const onClick = (e: SyntheticEvent) => {
    e.stopPropagation()
    const p = press.current
    press.current = null
    if (closing.current) return
    if (p ? !p.back || p.moved : (e.target as Element).closest('.vk-photo-img, .vk-photo-x')) return
    close.current()
  }

  // nothing in the viewer reaches the thread row it was opened from (React passes a portal's events up its tree)
  const stop = (e: SyntheticEvent) => e.stopPropagation()

  return createPortal(
    <div
      ref={root}
      className="vk-photo"
      role="dialog"
      aria-modal="true"
      aria-label={name || 'Picture'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onContextMenu={stop}
    >
      <img ref={img} className="vk-photo-img" src={src} alt={name} draggable={false} />
      <button
        ref={xBtn}
        type="button"
        className="vk-photo-x"
        aria-label="Close"
        title="Close (Esc)"
        onClick={(e) => { e.stopPropagation(); if (!closing.current) close.current() }}
      >
        <X size={22} strokeWidth={1.8} aria-hidden />
      </button>
    </div>,
    document.body,
  )
}
