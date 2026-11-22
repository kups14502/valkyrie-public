import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Valkyrie's own tooltips, in place of the browser's yellow-grey title boxes: every element that has a title in v2
// shows it in the app's look (a panel under the element, the palette's line and ink), after a short rest of the
// mouse on it, at once when another tip just showed. The title moves to data-vk-title while the mouse is on the
// element (so the browser draws none) and comes back when it leaves, so the markup, screen readers and tests keep
// reading title. Mouse only: touch has no hover. Gone on a press, a key, a scroll or the mouse leaving.
// Mounted once by src/v2/App.tsx.

const STASH = 'data-vk-title'
const REST_MS = 450
const WARM_MS = 600

type Tip = { text: string; rect: DOMRect }

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let el: Element | null = null
    let timer = 0
    let lastHide = 0

    const restore = () => {
      if (el) {
        const t = el.getAttribute(STASH)
        el.removeAttribute(STASH)
        // React set a new title meanwhile: that one stands
        if (t !== null && !el.hasAttribute('title')) el.setAttribute('title', t)
      }
      el = null
    }
    const hide = () => {
      window.clearTimeout(timer)
      setTip((cur) => {
        if (cur) lastHide = Date.now()
        return null
      })
    }
    const leave = () => {
      hide()
      restore()
    }

    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const target = e.target instanceof Element ? e.target : null
      const next = target?.closest(`[title], [${STASH}]`) ?? null
      if (next === el) return
      leave()
      if (!next || next.closest('.xterm') || !document.documentElement.hasAttribute('data-v2')) return
      const text = (next.getAttribute('title') ?? '').trim()
      if (!text) return
      el = next
      next.setAttribute(STASH, next.getAttribute('title') ?? '')
      next.removeAttribute('title')
      const show = () => {
        if (el !== next || !next.isConnected) return
        setTip({ text, rect: next.getBoundingClientRect() })
      }
      if (Date.now() - lastHide < WARM_MS) show()
      else timer = window.setTimeout(show, REST_MS)
    }
    const out = (e: PointerEvent) => {
      if (!el) return
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null
      if (to && el.contains(to)) return
      leave()
    }
    const press = () => hide()

    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('keydown', press, true)
    window.addEventListener('wheel', press, { capture: true, passive: true })
    window.addEventListener('scroll', press, true)
    window.addEventListener('blur', leave)
    return () => {
      leave()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('keydown', press, true)
      window.removeEventListener('wheel', press, true)
      window.removeEventListener('scroll', press, true)
      window.removeEventListener('blur', leave)
    }
  }, [])

  if (!tip) return null
  return createPortal(<TipBox tip={tip} />, document.body)
}

function TipBox({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // client px are zoomed under the UI zoom; the box is placed in CSS px
    const k = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1
    const r = tip.rect
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth / k
    const vh = window.innerHeight / k
    let left = (r.left + r.width / 2) / k - w / 2
    left = Math.min(Math.max(6, left), vw - w - 6)
    let top = r.bottom / k + 6
    let up = false
    if (top + h > vh - 6) {
      top = r.top / k - h - 6
      up = true
    }
    setPos({ left, top: Math.max(6, top), up })
  }, [tip])
  return (
    <div
      ref={ref}
      className="vk-tip"
      role="tooltip"
      data-up={pos?.up || undefined}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.text}
    </div>
  )
}
