import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Copy, ExternalLink, Link2, RefreshCw, Search, Command, Image as ImageIcon, TextSelect } from 'lucide-react'
import { openFind } from './findApi'
import { openPalette } from './ui'
import { copyWithToast, menuAdded as added, type MenuItem } from './menuApi'
import { wordAt } from './findCore'

// Valkyrie's own context menu, in place of the browser's: a right click (or the menu key) anywhere in v2, and a
// long press on the phone and the iPad, open one small menu that fits what is under the pointer. A screen adds
// its rows with addMenu(e, items) from its own onContextMenu (a Raven line: Copy text, Copy link, Quote; a
// session card: Open), inner first; the menu adds a section for a selection (Copy, Find), a link (Open, Copy
// link) and a picture, and Find and the palette when nothing else fits. A handler that calls preventDefault keeps
// the press its own (the Desk's tab menu, AI > Sessions' select, the tracker's hold). Text boxes, terminals and
// Shift+right-click keep the browser's menu, so spellcheck and paste stay native. Mounted once by src/v2/App.tsx.

const NATIVE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, iframe, embed, object'
const LONG_MS = 480
const SLOP = 10

type Open = { x: number; y: number; sections: MenuItem[][]; touch: boolean }

/** The word under a point, from the caret the engine puts there. */
function wordFromPoint(x: number, y: number): string {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  let node: Node | null = null
  let off = 0
  try {
    const p = d.caretPositionFromPoint?.(x, y)
    if (p) { node = p.offsetNode; off = p.offset }
    else {
      const r = d.caretRangeFromPoint?.(x, y)
      if (r) { node = r.startContainer; off = r.startOffset }
    }
  } catch { /* no caret there */ }
  if (!node || node.nodeType !== Node.TEXT_NODE) return ''
  return wordAt(node.nodeValue ?? '', off).slice(0, 80)
}

const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function absolute(href: string): string {
  try { return new URL(href, window.location.href).href } catch { return href }
}

function selectionText(): string {
  const s = window.getSelection()
  return s && !s.isCollapsed ? s.toString().trim() : ''
}

/** The menu's own rows for what is under the pointer. */
function baseSections(target: Element, x: number, y: number, navigate: (to: string) => void, touch: boolean): { lead: MenuItem[][]; tail: MenuItem[][] } {
  const lead: MenuItem[][] = []
  const tail: MenuItem[][] = []
  const sel = selectionText()
  if (sel) {
    const one = sel.length <= 120 && !sel.includes('\n')
    lead.push([
      { label: 'Copy', icon: Copy, hint: touch ? undefined : 'Ctrl C', run: () => void copyWithToast(sel) },
      ...(one ? [{ label: `Find “${short(sel)}”`, icon: Search, run: () => openFind(sel) }] : []),
    ])
  }
  const a = target.closest<HTMLAnchorElement>('a[href]')
  if (a) {
    const href = a.getAttribute('href') ?? ''
    const inApp = href.startsWith('/m/')
    lead.push([
      { label: inApp ? 'Open' : 'Open link', icon: ExternalLink, run: () => (inApp ? navigate(href) : a.click()) },
      { label: 'Copy link', icon: Link2, run: () => void copyWithToast(absolute(href), 'Link copied') },
    ])
  }
  const img = target.closest('img')
  if (img && (img as HTMLImageElement).src && !a) {
    const src = (img as HTMLImageElement).src
    lead.push([
      { label: 'Open picture', icon: ImageIcon, run: () => window.open(src, '_blank', 'noopener') },
      { label: 'Copy picture address', icon: Link2, run: () => void copyWithToast(src, 'Address copied') },
    ])
  }
  if (!sel) {
    const word = wordFromPoint(x, y)
    if (word && word.length >= 2) tail.push([{ label: `Find “${short(word)}”`, icon: Search, run: () => openFind(word) }])
  }
  return { lead, tail }
}

function fallback(touch: boolean): MenuItem[] {
  return [
    { label: 'Find on this screen', icon: Search, hint: touch ? undefined : 'Ctrl F', run: () => openFind() },
    { label: 'Command palette', icon: Command, hint: touch ? undefined : 'Ctrl K', run: () => openPalette() },
    { label: 'Reload', icon: RefreshCw, hint: touch ? undefined : 'F5', run: () => window.location.reload() },
  ]
}

export function ContextMenuHost() {
  const navigate = useNavigate()
  const [menu, setMenu] = useState<Open | null>(null)
  const nav = useRef(navigate)
  useLayoutEffect(() => { nav.current = navigate }, [navigate])
  // the click that ends a long press that opened the menu is not a tap on what was under it
  const eatClick = useRef(0)

  useEffect(() => {
    let press: { id: number; x: number; y: number; t: number; target: Element } | null = null
    const clearPress = () => {
      if (press) window.clearTimeout(press.t)
      press = null
    }

    const onMenu = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const touchPress = press
      clearPress()
      if (!target || e.defaultPrevented || e.shiftKey) return
      if (target.closest(NATIVE) || target.closest('.vk-menu')) return
      if (!document.documentElement.hasAttribute('data-v2')) return
      e.preventDefault()
      const touch = !!touchPress
      const own = added.get(e) ?? []
      const base = baseSections(target, e.clientX, e.clientY, (to) => nav.current(to), touch)
      let sections = [...base.lead, ...own, ...base.tail]
      if (!base.lead.length && !own.length) sections = [...sections, fallback(touch)]
      // the menu key: under the focused element
      let x = e.clientX
      let y = e.clientY
      if (!x && !y && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        const r = document.activeElement.getBoundingClientRect()
        x = r.left + 8
        y = r.bottom - 4
      }
      setMenu({ x, y, sections, touch })
      if (touchPress) {
        eatClick.current = Date.now() + 900
        // a button under the finger lets go of its press (Press commits on pointerup otherwise)
        touchPress.target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: touchPress.id, pointerType: 'touch' }))
        window.getSelection()?.removeAllRanges()
      }
    }

    // a long press on touch: the same menu, through a contextmenu event at the finger (Android sends its own; iOS none)
    const onDown = (e: PointerEvent) => {
      clearPress()
      if (e.pointerType === 'mouse' || !e.isPrimary) return
      const target = e.target instanceof Element ? e.target : null
      if (!target || target.closest(NATIVE) || target.closest('.vk-menu')) return
      const t = window.setTimeout(() => {
        const p = press
        if (!p) return
        // still a press: hand it to the contextmenu path, which every screen's own handler sees first
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 2 })
        p.target.dispatchEvent(ev)
      }, LONG_MS)
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, t, target }
    }
    const onMove = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) clearPress()
    }
    const onUp = (e: PointerEvent) => { if (press && e.pointerId === press.id) clearPress() }
    const onClick = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('.vk-menu')) return
      if (Date.now() < eatClick.current) {
        eatClick.current = 0
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // the long press is the menu's on touch: no selection or callout starts under it
    const onSelectStart = (e: Event) => { if (press) e.preventDefault() }

    document.addEventListener('contextmenu', onMenu)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, { capture: true, passive: true })
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('scroll', clearPress, true)
    window.addEventListener('click', onClick, true)
    document.addEventListener('selectstart', onSelectStart)
    return () => {
      clearPress()
      document.removeEventListener('contextmenu', onMenu)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('scroll', clearPress, true)
      window.removeEventListener('click', onClick, true)
      document.removeEventListener('selectstart', onSelectStart)
    }
  }, [])

  const close = useCallback(() => setMenu(null), [])
  if (!menu) return null
  return createPortal(<MenuBox menu={menu} onClose={close} />, document.body)
}

function MenuBox({ menu, onClose }: { menu: Open; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const items = menu.sections.flat()
  const [on, setOn] = useState(-1)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const back = useRef<Element | null>(document.activeElement)

  // at the pointer, inside the window, in CSS px (the UI zoom scales client px)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const k = el.offsetWidth ? r.width / el.offsetWidth : 1
    const vw = window.innerWidth / k
    const vh = window.innerHeight / k
    const w = el.offsetWidth
    const h = el.offsetHeight
    let x = menu.x / k
    let y = menu.y / k
    // on touch it sits above the finger, so the finger never covers it
    if (menu.touch) y = y - h - 14
    if (x + w > vw - 8) x = Math.max(8, x - w)
    if (y + h > vh - 8) y = Math.max(8, vh - h - 8)
    if (y < 8) y = Math.min(vh - h - 8, menu.y / k + 14)
    setPos({ left: Math.max(8, x), top: Math.max(8, y) })
    el.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    const away = (e: Event) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return
      onClose()
    }
    const blur = () => onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('wheel', away, { capture: true, passive: true })
    window.addEventListener('resize', blur)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('wheel', away, true)
      window.removeEventListener('resize', blur)
      window.removeEventListener('blur', blur)
    }
  }, [onClose])

  const run = (it: MenuItem) => {
    if (it.disabled) return
    onClose()
    const b = back.current as HTMLElement | null
    if (b?.isConnected && typeof b.focus === 'function' && b !== document.body) b.focus({ preventScroll: true })
    it.run()
  }

  let n = -1
  return (
    <div
      ref={box}
      className="vk-menu"
      role="menu"
      tabIndex={-1}
      data-touch={menu.touch || undefined}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        const step = (d: number) => {
          let i = on
          for (let t = 0; t < items.length; t++) {
            i = (i + d + items.length) % items.length
            if (!items[i].disabled) break
          }
          setOn(i)
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); step(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
        else if (e.key === 'Home') { e.preventDefault(); setOn(0) }
        else if (e.key === 'End') { e.preventDefault(); setOn(items.length - 1) }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (items[on]) run(items[on]) }
        else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose() }
      }}
    >
      {menu.sections.map((sec, si) => (
        <div key={si} className="vk-menu-sec" role="group">
          {sec.map((it) => {
            n++
            const i = n
            const Icon = it.icon ?? TextSelect
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="vk-menu-row"
                data-on={on === i || undefined}
                data-danger={it.danger || undefined}
                disabled={it.disabled}
                onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOn(i) }}
                onPointerLeave={(e) => { if (e.pointerType === 'mouse') setOn(-1) }}
                onClick={() => run(it)}
              >
                <Icon size={14} strokeWidth={1.6} aria-hidden />
                <span className="vk-menu-label">{it.label}</span>
                {it.hint && <kbd>{it.hint}</kbd>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
