import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { matchOffsets, nextOlderHit, oldestHit, startIndex, stepIndex, threadCount, type Hit } from './findCore'
import { FIND_EVENT, findProviders as providers } from './findApi'

// Valkyrie's own find bar (Ctrl+F, Cmd+F), in place of the browser's: a small box under the strip with the count,
// Enter / Shift+Enter (or the arrows, F3, Ctrl+G) for the next and the one before, Escape to close. It searches the
// screen in front (the active tab's page, else the page on its own) and marks every match through the CSS Custom
// Highlight API, so the DOM React draws is never touched; the one in focus is brighter and scrolled into view. A
// screen can lend it a provider (useFindProvider): the Raven tab does, so the count and the steps also reach lines
// of the thread it has not loaded (GET /api/raven/search), loaded on the way. Inside a terminal Ctrl+F stays the
// shell's (readline's forward-char); Cmd+F still opens it. Mounted once by src/v2/App.tsx.

const inTerminal = (t: EventTarget | null) => t instanceof Element && !!t.closest('.xterm')

const SKIP = 'script, style, noscript, textarea, input, select, option, svg, canvas, .vk-find, .vk-menu, .vk-tip, [data-sr], .sr-only'

type Css = typeof CSS & { highlights?: Map<string, unknown> }
type HighlightCtor = new (...r: Range[]) => unknown
const HL = (): { reg: Map<string, unknown>; make: HighlightCtor } | null => {
  const reg = (CSS as Css).highlights
  const make = (window as unknown as { Highlight?: HighlightCtor }).Highlight
  return reg && make ? { reg, make } : null
}

function defaultRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.vl-page[data-active]') ?? document.querySelector<HTMLElement>('#root') ?? document.body
}

function visible(el: Element, seen: Map<Element, boolean>): boolean {
  const k = seen.get(el)
  if (k !== undefined) return k
  let v: boolean
  if (el.closest(SKIP)) v = false
  else if (typeof (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility === 'function') {
    v = (el as HTMLElement & { checkVisibility: (o?: object) => boolean }).checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })
  } else v = el.getClientRects().length > 0
  seen.set(el, v)
  return v
}

/** Every match of `q` in `root`'s drawn text, in document order. A match can run across inline elements. */
function findRanges(root: HTMLElement, q: string): Range[] {
  if (!q) return []
  const seen = new Map<Element, boolean>()
  const nodes: { n: Text; at: number }[] = []
  let all = ''
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement
      if (!p || !n.nodeValue || !visible(p, seen)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    nodes.push({ n, at: all.length })
    all += n.nodeValue
  }
  const out: Range[] = []
  let k = 0
  const locate = (off: number, end: boolean) => {
    while (k < nodes.length - 1 && nodes[k + 1].at < off + (end ? 0 : 1)) k++
    return { node: nodes[k].n, off: off - nodes[k].at }
  }
  for (const s of matchOffsets(all, q)) {
    const a = locate(s, false)
    const b = locate(s + q.length, true)
    const r = document.createRange()
    try {
      r.setStart(a.node, a.off)
      r.setEnd(b.node, b.off)
      out.push(r)
    } catch { /* a node that changed under the walk */ }
  }
  return out
}

function scrollToRange(r: Range): void {
  const el = r.startContainer.parentElement
  if (!el) return
  const box = r.getBoundingClientRect()
  const vh = window.innerHeight
  // already well in view: leave the screen where it is
  if (box.height && box.top > 60 && box.bottom < vh - 80) {
    const sc = el.closest('.rv-msgs, .vl-pager')
    if (!sc || (box.top >= sc.getBoundingClientRect().top + 20 && box.bottom <= sc.getBoundingClientRect().bottom - 20)) return
  }
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

export function FindBar() {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [count, setCount] = useState({ n: 0, cur: -1, total: 0, pos: 0, loading: false })
  // every Ctrl+F puts the caret in the box with its words picked, once the box is drawn
  const [focusTick, setFocusTick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const ranges = useRef<Range[]>([])
  const cur = useRef(-1)
  const hits = useRef<{ q: string; list: Hit[] } | null>(null)
  const back = useRef<Element | null>(null)
  const qRef = useRef(q)
  useLayoutEffect(() => { qRef.current = q }, [q])

  const provider = () => providers[providers.length - 1]?.p ?? null
  const rootOf = () => provider()?.root() ?? defaultRoot()

  const paint = useCallback(() => {
    const hl = HL()
    const list = ranges.current
    const i = cur.current
    if (hl) {
      hl.reg.set('vk-find', new hl.make(...list.filter((_, j) => j !== i)))
      if (i >= 0 && list[i]) hl.reg.set('vk-find-cur', new hl.make(list[i]))
      else hl.reg.delete('vk-find-cur')
    } else if (i >= 0 && list[i] && !document.activeElement?.closest('.vk-find')) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(list[i])
    }
    const p = provider()
    const h = hits.current && hits.current.q === qRef.current ? hits.current.list : null
    if (p?.search && p.firstLoaded && h) {
      const c = threadCount(h, p.firstLoaded(), list.length, i)
      setCount({ n: list.length, cur: i, total: c.total, pos: c.pos, loading: false })
    } else {
      setCount({ n: list.length, cur: i, total: list.length, pos: i + 1, loading: !!p?.search && !!qRef.current })
    }
  }, [])

  const clear = useCallback(() => {
    const hl = HL()
    hl?.reg.delete('vk-find')
    hl?.reg.delete('vk-find-cur')
    ranges.current = []
    cur.current = -1
  }, [])

  /** Find again in what is drawn now; keep the match in focus when it is still there. */
  const rescan = useCallback((pick: 'keep' | 'start') => {
    const root = rootOf()
    const was = ranges.current[cur.current]
    const list = findRanges(root, qRef.current)
    ranges.current = list
    if (pick === 'start') {
      const top = root.getBoundingClientRect().top
      const tops = list.map((r) => r.getBoundingClientRect().top - Math.max(0, top))
      cur.current = startIndex(tops, window.innerHeight - Math.max(0, top), !!provider()?.fromEnd)
    } else if (was) {
      const same = list.findIndex((r) => r.startContainer === was.startContainer && r.startOffset === was.startOffset)
      cur.current = same !== -1 ? same : Math.min(cur.current, list.length - 1)
    } else cur.current = list.length ? Math.min(Math.max(cur.current, 0), list.length - 1) : -1
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint])

  const focusMatch = useCallback((i: number) => {
    cur.current = i
    paint()
    const r = ranges.current[i]
    if (r) scrollToRange(r)
  }, [paint])

  // load the thread back to line `id`, then focus its first (or last) match
  const reach = useCallback(async (id: number, last: boolean) => {
    const p = provider()
    if (!p?.reveal || !p.lineEl) return false
    setCount((c) => ({ ...c, loading: true }))
    await p.reveal(id)
    for (let t = 0; t < 120 && !p.lineEl(id); t++) await frame()
    await frame()
    const line = p.lineEl(id)
    rescan('keep')
    if (!line) return false
    const inLine = ranges.current.map((r, j) => (line.contains(r.startContainer) ? j : -1)).filter((j) => j !== -1)
    if (!inLine.length) return false
    focusMatch(last ? inLine[inLine.length - 1] : inLine[0])
    return true
  }, [rescan, focusMatch])

  const step = useCallback(async (dir: 1 | -1) => {
    const p = provider()
    const n = ranges.current.length
    const h = hits.current && hits.current.q === qRef.current ? hits.current.list : []
    const first = p?.firstLoaded?.() ?? 0
    if (p?.reveal && h.length) {
      // up past the oldest drawn match: the newest older line that holds the words
      if (dir === -1 && (cur.current <= 0 || n === 0)) {
        const older = nextOlderHit(h, first)
        if (older !== null && (await reach(older, true))) return
      }
      // down past the newest: around to the very first line that holds them
      if (dir === 1 && (cur.current === n - 1 || n === 0)) {
        const oldest = oldestHit(h)
        if (oldest !== null && oldest < first && (await reach(oldest, false))) return
      }
    }
    if (!n) return
    focusMatch(stepIndex(cur.current, n, dir))
  }, [reach, focusMatch])

  const close = useCallback(() => {
    setOpen(false)
    clear()
    const b = back.current as HTMLElement | null
    back.current = null
    if (b?.isConnected && typeof b.focus === 'function') b.focus({ preventScroll: true })
  }, [clear])
  const closeRef = useRef(close)
  useLayoutEffect(() => { closeRef.current = close }, [close])

  // Ctrl+F / Cmd+F, F3, Ctrl+G; the context menu's Find
  useEffect(() => {
    const show = (seed: string | null) => {
      if (!open) back.current = document.activeElement
      setOpen(true)
      if (seed !== null) setQ(seed)
      setFocusTick((n) => n + 1)
    }
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && !e.shiftKey && k === 'f') {
        if (e.ctrlKey && !e.metaKey && inTerminal(e.target)) return
        e.preventDefault()
        const sel = window.getSelection()?.toString().trim() ?? ''
        show(sel && sel.length <= 120 && !sel.includes('\n') ? sel : null)
        return
      }
      if (!open) return
      // Escape with the focus on the page (the box has its own): close, unless a menu or the palette is up
      if (e.key === 'Escape' && (!document.activeElement || document.activeElement === document.body) && !document.querySelector('.vk-menu, .vl-pal')) {
        closeRef.current()
        return
      }
      if (e.key === 'F3' || (mod && !e.altKey && k === 'g')) {
        e.preventDefault()
        void step(e.shiftKey ? -1 : 1)
      }
    }
    const onOpen = (e: Event) => show((e as CustomEvent<string | null>).detail)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener(FIND_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener(FIND_EVENT, onOpen)
    }
  }, [open, step])


  // another screen: the bar closes (a new screen is a new search)
  const path = location.pathname
  const [shownOn, setShownOn] = useState(path)
  if (shownOn !== path) {
    setShownOn(path)
    if (open) setOpen(false)
  }
  useEffect(() => { if (!open) clear() }, [open, clear])
  useLayoutEffect(() => {
    if (!open || !focusTick) return
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [open, focusTick])

  // a new query: find it in what is drawn at once, ask the provider for the rest a moment later
  useLayoutEffect(() => {
    if (!open) return
    rescan('start')
    const r = ranges.current[cur.current]
    if (r) scrollToRange(r)
    const p = provider()
    if (!p?.search || !q.trim()) {
      hits.current = null
      return
    }
    let gone = false
    const t = window.setTimeout(() => {
      void p.search!(q).then((list) => {
        if (gone) return
        hits.current = { q, list }
        paint()
      }, () => {
        if (gone) return
        hits.current = { q, list: [] }
        paint()
      })
    }, 220)
    return () => { gone = true; window.clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, path])

  // what is drawn changes (new lines, a tab's data): find again, keep the focus
  useEffect(() => {
    if (!open || !q) return
    const root = rootOf()
    let t = 0
    const mo = new MutationObserver(() => {
      window.clearTimeout(t)
      t = window.setTimeout(() => rescan('keep'), 180)
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'data-active'] })
    return () => { mo.disconnect(); window.clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, path, rescan])

  if (!open) return null
  const none = !!q && count.total === 0 && !count.loading
  const label = !q ? '' : count.loading && count.total === 0 ? '…' : count.total === 0 ? 'No matches' : `${count.pos || '–'} of ${count.total}`
  return createPortal(
    <div className="vk-find" role="search" aria-label="Find">
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={provider()?.search ? 'Find in the thread' : 'Find on this screen'}
        aria-label="Find"
        spellCheck={false}
        autoComplete="off"
        data-none={none || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            void step(e.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      />
      <span className="vk-find-n" aria-live="polite" data-none={none || undefined}>{label}</span>
      <button type="button" className="vk-find-btn" aria-label="Previous match (Shift+Enter)" title="Previous (Shift+Enter)" disabled={!count.total} onClick={() => void step(-1)}>
        <ChevronUp size={15} strokeWidth={1.7} aria-hidden />
      </button>
      <button type="button" className="vk-find-btn" aria-label="Next match (Enter)" title="Next (Enter)" disabled={!count.total} onClick={() => void step(1)}>
        <ChevronDown size={15} strokeWidth={1.7} aria-hidden />
      </button>
      <button type="button" className="vk-find-btn" aria-label="Close find (Escape)" title="Close (Esc)" onClick={close}>
        <X size={14} strokeWidth={1.7} aria-hidden />
      </button>
    </div>,
    document.body,
  )
}
