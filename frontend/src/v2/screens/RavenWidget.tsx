import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bird, ExternalLink, Minus } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { isTauri } from '../../lib/auth'
import { markRavenRead, ravenBusy, ravenStatusText, sendRaven } from '../../lib/ravenApi'
import { WIDGET_PATH } from '../../lib/ravenWidget'
import { RavenComposer, RavenPick } from '../kit/raven'
import { RAVEN_KEY, addToThread, refreshRavenUnread, useRaven, useRavenDraft, useRavenUnread } from '../kit/ravenStore'
import { Icon } from '../kit/icons'
import { Press, toast } from '../kit/ui'
import { Thread } from './Messages'
import './ravenwidget.css'

// The desktop app's Raven widget (/m/w/raven, in the always-on-top window
// lib.rs opens as raven-widget): a round Raven button, and on a click a
// compact chat, the Raven tab's own thread and box. Drag the button, or the
// chat by its header, anywhere; the spot is remembered as the window's
// bottom-right corner, so the button stays put when the chat opens above it.
// Rust shows and hides the window (on, placed, five minutes idle): this page
// only sizes and places it, then says it is ready.

/** window sizes, logical px: the button with room for its glow, and the chat */
const BTN = 64
const PANEL_W = 380
const PANEL_H = 540
/** the first spot, from the work area's bottom-right corner */
const MARGIN = 16
const CORNER_KEY = 'vk.ravenWidget.corner'

type Pt = { x: number; y: number }
type Area = { x: number; y: number; w: number; h: number }

function loadCorner(): Pt | null {
  try {
    const v = JSON.parse(localStorage.getItem(CORNER_KEY) ?? 'null') as Pt | null
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: Math.round(v.x), y: Math.round(v.y) } : null
  } catch {
    return null
  }
}

const saveCorner = (p: Pt) => { try { localStorage.setItem(CORNER_KEY, JSON.stringify(p)) } catch { /* the next start uses the default */ } }

async function workAreas(): Promise<Area[]> {
  const { availableMonitors } = await import('@tauri-apps/api/window')
  return (await availableMonitors()).map((m) => ({ x: m.workArea.position.x, y: m.workArea.position.y, w: m.workArea.size.width, h: m.workArea.size.height }))
}

const inside = (p: Pt, a: Area) => p.x > a.x && p.y > a.y && p.x <= a.x + a.w && p.y <= a.y + a.h
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The remembered corner, if it is still on a screen; else the primary work area's bottom-right. */
async function startCorner(scale: number): Promise<Pt> {
  const areas = await workAreas()
  const saved = loadCorner()
  if (saved && areas.some((a) => inside(saved, a))) return saved
  const { primaryMonitor } = await import('@tauri-apps/api/window')
  const m = await primaryMonitor()
  const a = m ? { x: m.workArea.position.x, y: m.workArea.position.y, w: m.workArea.size.width, h: m.workArea.size.height } : areas[0]
  const s = m?.scaleFactor ?? scale
  return a ? { x: a.x + a.w - Math.round(MARGIN * s), y: a.y + a.h - Math.round(MARGIN * s) } : { x: 1200, y: 800 }
}

export default function RavenWidget() {
  const [open, setOpen] = useState(false)
  const corner = useRef<Pt | null>(null)
  // our own moves must not be taken for a drag
  const placingUntil = useRef(0)
  const location = useLocation()
  const navigate = useNavigate()

  // the window is see-through: only the button or the chat draws
  useLayoutEffect(() => {
    const el = document.documentElement
    el.dataset.rwidget = ''
    return () => { delete el.dataset.rwidget }
  }, [])

  /** size the window for the button or the chat and put its bottom-right on the corner, kept on the screen */
  const place = async (asOpen: boolean) => {
    // a browser tab (the dev preview) has no window to place
    if (!isTauri()) return
    const { getCurrentWindow, LogicalSize, PhysicalPosition } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    const scale = await win.scaleFactor()
    if (!corner.current) corner.current = await startCorner(scale)
    const c = corner.current
    const w = Math.round((asOpen ? PANEL_W : BTN) * scale)
    const h = Math.round((asOpen ? PANEL_H : BTN) * scale)
    const area = (await workAreas()).find((a) => inside(c, a))
    let x = c.x - w
    let y = c.y - h
    if (area) {
      x = clamp(x, area.x, area.x + area.w - w)
      y = clamp(y, area.y, area.y + area.h - h)
    }
    placingUntil.current = Date.now() + 600
    await win.setSize(new LogicalSize(asOpen ? PANEL_W : BTN, asOpen ? PANEL_H : BTN))
    await win.setPosition(new PhysicalPosition(x, y))
    placingUntil.current = Date.now() + 400
  }

  // first placement, then Rust may show it; a drag (the button, or the chat's header) moves the corner
  useEffect(() => {
    let off: (() => void) | null = null
    let gone = false
    let save = 0
    void (async () => {
      try {
        await place(false)
        if (!isTauri()) return
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('raven_widget_ready')
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        const un = await win.onMoved(({ payload: pos }) => {
          if (Date.now() < placingUntil.current) return
          void win.outerSize().then((size) => {
            corner.current = { x: pos.x + size.width, y: pos.y + size.height }
            window.clearTimeout(save)
            save = window.setTimeout(() => { if (corner.current) saveCorner(corner.current) }, 300)
          })
        })
        if (gone) un()
        else off = un
      } catch (e) {
        console.warn('[raven widget] could not place the window', e)
      }
    })()
    return () => { gone = true; off?.(); window.clearTimeout(save) }
    // once: the window is placed at mount, later by open and close
  }, [])

  const toggle = (next: boolean) => {
    setOpen(next)
    void place(next).then(async () => {
      if (!next || !isTauri()) return
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setFocus().catch(() => {})
    })
  }

  // a link in the thread (a session's Open, a page in a reply) opens in the main window, never in here
  useEffect(() => {
    if (location.pathname === WIDGET_PATH) return
    const to = `${location.pathname}${location.search}${location.hash}`
    navigate(WIDGET_PATH, { replace: true })
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('raven_widget_open_main', { path: to }))
      .catch((e) => toast(`Could not open it in Valkyrie: ${String(e)}`, { ms: 4000 }))
  }, [location, navigate])

  return open
    ? <WidgetChat onClose={() => toggle(false)} />
    : <WidgetButton onOpen={() => toggle(true)} />
}

/** The round Raven button: a click opens the chat, a drag moves the widget. */
function WidgetButton({ onOpen }: { onOpen: () => void }) {
  const unread = useRavenUnread().data?.unread ?? 0
  const down = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const label = unread ? `Message Raven (${unread} unread)` : 'Message Raven'

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    down.current = { x: e.screenX, y: e.screenY, dragged: false }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = down.current
    if (!d || d.dragged || !(e.buttons & 1)) return
    if (Math.hypot(e.screenX - d.x, e.screenY - d.y) < 4) return
    d.dragged = true
    // the system moves the window from here; the page may not hear the button come up
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(() => {})
  }
  const onPointerUp = () => {
    const d = down.current
    down.current = null
    if (d && !d.dragged) onOpen()
  }

  return (
    <div className="rw-btn-wrap">
      <button
        type="button"
        className="rv-fab rw-btn"
        data-unread={unread || undefined}
        aria-label={label}
        title={`${label}. Drag to move`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      >
        <Icon name={Bird} size={20} tone={unread ? 'fg' : 'dim'} glow={unread > 0} />
      </button>
    </div>
  )
}

/** The compact chat: Raven's header (drag to move), the thread, the box. */
function WidgetChat({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useRaven(true)
  const page = q.data
  const draft = useRavenDraft()
  const ta = useRef<HTMLTextAreaElement>(null)
  const messages = page?.messages ?? []
  const names = new Map((page?.agents ?? []).map((a) => [a.id, a.name]))
  const busy = ravenBusy(page)
  const status = page ? ravenStatusText(page) : ''
  const failed = q.isError && !page

  useEffect(() => { ta.current?.focus({ preventScroll: true }) }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // stick to the newest line unless he scrolled up
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const lastId = messages.length ? messages[messages.length - 1].id : 0
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastId, busy])
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
  }

  // read what is on screen, as the Raven tab does
  const unread = page?.unread ?? 0
  useEffect(() => {
    if (!atBottom || !unread || !lastId) return
    void markRavenRead(lastId).then(() => {
      refreshRavenUnread(qc)
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    }, () => { /* the count stays until the next read */ })
  }, [atBottom, unread, lastId, qc])

  const send = useMutation({
    mutationFn: () => sendRaven({ text: draft.text.trim(), files: draft.ids.length ? draft.ids : undefined, source: 'quick' }),
    onSuccess: (m) => {
      draft.clear()
      stick.current = true
      addToThread(qc, { messages: [m] })
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    },
    onError: (e) => toast(apiErrorText(e, 'Raven did not answer'), { ms: 4000 }),
  })

  const openMain = () => {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('raven_widget_open_main', { path: '/m/raven' }))
      .catch((e) => toast(`Could not open Valkyrie: ${String(e)}`, { ms: 4000 }))
  }

  return (
    <section
      className="rw-panel"
      aria-label="Raven"
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        if (e.defaultPrevented) return
        const files = Array.from(e.dataTransfer.files)
        if (!files.length) return
        e.preventDefault()
        draft.add(files)
      }}
    >
      <header className="rw-head" data-tauri-drag-region>
        <b data-tauri-drag-region>Raven</b>
        <span className="rw-status" data-tauri-drag-region data-busy={busy || undefined} data-state={page?.status} title={status || undefined}>
          {failed ? 'not answering' : status}
        </span>
        <Press className="rw-act" aria-label="Open in Valkyrie" title="Open in Valkyrie" onPress={openMain}>
          <ExternalLink size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />
        </Press>
        <Press className="rw-act" aria-label="Back to the button" title="Back to the button (Esc)" onPress={onClose}>
          <Minus size={15} strokeWidth={1.8} className="vl-icon vl-icon-dim" aria-hidden />
        </Press>
      </header>
      <div className="rv-msgs rw-msgs" ref={listRef} onScroll={onScroll}>
        <div className="rv-col">
          {failed && <p className="rv-quiet">Raven is not answering: {apiErrorText(q.error, 'no reply from Valkyrie')}</p>}
          {!page && !failed && <p className="rv-quiet">Reading Raven</p>}
          {page && !messages.length && <p className="rv-quiet">Nothing yet. Write Raven anything.</p>}
          <Thread messages={messages} names={names} />
          {busy && (
            <div className="rv-working" aria-live="polite">
              <span className="rv-pulse" aria-hidden />
              <span>{status}</span>
            </div>
          )}
        </div>
      </div>
      <RavenComposer
        draft={draft}
        sending={send.isPending}
        onSend={() => send.mutate()}
        placeholder="Message Raven"
        taRef={ta}
        className="rw-compose"
        maxHeight={120}
        tools={<RavenPick page={page} />}
      />
    </section>
  )
}
