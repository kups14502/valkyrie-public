import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowDown, ChevronRight, Copy, ExternalLink, Link2, PanelRight, Quote, Search, TextSelect, X } from 'lucide-react'
import { Button, Press, toast } from '../kit/ui'
import { ago, useTick } from '../kit/data'
import { useIntent, type ScreenProps } from '../kit/shell'
import { RavenComposer, RavenFiles, RavenPick } from '../kit/raven'
import { RAVEN_KEY, addToThread, refreshRavenUnread, useRaven, useRavenDraft, type DraftSnap } from '../kit/ravenStore'
import { openFind, useFindProvider } from '../kit/findApi'
import { feedsFromThread, liveLine, splitFeeds } from '../kit/ravenFeeds'
import { addMenu, copyWithToast } from '../kit/menuApi'
import { Markdown } from '../../components/Markdown'
import { api, apiErrorText } from '../../lib/api'
import { isTauri } from '../../lib/auth'
import { TERM_NAME_RE, v2TermPath } from '../../lib/term'
import {
  RAVEN_OLDER, approveProposal, declineAllProposals, declineProposal, etTime, fetchRavenOlder, markRavenRead, ravenBusy, ravenStatusText, replyMetaLine,
  replyMetaTitle, searchRaven, sendRaven, stopRaven, type Proposal, type RavenFeed, type RavenMsg, type RavenPage, type RavenSessionCopy, type Ref,
} from '../../lib/ravenApi'
import './messages.css'

// The Raven tab (/m/raven; the file keeps its old name, Messages): one
// conversation, Brendon and Raven (backend lib/raven). Raven answers here, and
// what the agents, his sessions, the features and Valkyrie itself say comes in
// as relays, labeled by their source; the agents' proposals sit inline as cards
// he decides. Newest at the bottom, older pages load on scroll-up, everything
// updates through the Messages long-poll (/api/msg/changes). A wide screen
// keeps a narrow "Connected" column on the right (main terminals, watched
// sessions, agents, feeds); the button at the header's right end hides or shows it there, and on a narrow
// screen (a phone) opens the same list as a drawer over the thread. Old links
// (/m/messages, ?c=<channel>) land here; ?compose=1 focuses the box. What he has typed, dictated or attached and
// not sent is the thread's draft (kit/ravenDraft.ts): kept on this device across tab switches, reloads and
// restarts, cleared only by the send.

const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const NY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })

/** "Today", "Yesterday", or "Tue, Nov 17" in New York */
function dayLabel(t: number, now: number): string {
  const k = NY_KEY.format(t)
  if (k === NY_KEY.format(now)) return 'Today'
  if (k === NY_KEY.format(now - 86_400_000)) return 'Yesterday'
  return NY_DAY.format(t)
}

/** The root's width: the UI zoom hides from media queries, so measure. */
function useWide(ref: RefObject<HTMLDivElement | null>, at: number): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => { if (el.clientWidth > 0) setWide(el.clientWidth >= at) }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [ref, at])
  return wide
}

/** The Connected column on a wide screen: shown unless he hid it, kept per device. */
const SIDE_KEY = 'v2.raven.side'
function useSideOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(SIDE_KEY) !== '0' } catch { return true }
  })
  const set = useCallback((v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(SIDE_KEY, v ? '1' : '0') } catch { /* storage off */ }
  }, [])
  return [open, set]
}

/** At a glance on the header's button: the sessions and agents at work, and the proposals waiting for him. */
function glanceOf(page: RavenPage): { working: number; waiting: number } {
  const panes = new Set<string>()
  for (const t of page.mains) if (t.state === 'working') panes.add(t.pane || t.target)
  for (const w of page.watching) if (w.state === 'working') panes.add(w.pane || w.sessionId)
  const agents = page.paused ? 0 : page.agents.filter((a) => a.status === 'working' || a.status === 'queued').length
  return { working: panes.size + agents, waiting: page.agents.reduce((n, a) => n + a.pending, 0) }
}

/** The app is in front (an app brought back with the thread open reads it then). */
function usePageShown(): boolean {
  const [shown, setShown] = useState(() => !document.hidden)
  useEffect(() => {
    const on = () => setShown(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return shown
}

const SOURCE_WORD: Record<string, string> = { siri: 'Siri', hotkey: 'hotkey', api: 'API' }

/** this close to the end counts as at the bottom */
const STICK_PX = 80
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])
const reducedMotion = () => document.documentElement.dataset.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
/** a row's top against the list's visible top */
const rowY = (list: Element, row: Element) => row.getBoundingClientRect().top - list.getBoundingClientRect().top
/** an older page the find bar or a link loads to a line at a time: the API's most */
const REACH_PAGE = 200

/** A link to a place in the app that opens from another device: the desktop app's own origin is its webview's. */
function appLink(path: string): string {
  const b = api.defaults.baseURL ?? ''
  if (isTauri() && /^https?:\/\//.test(b)) return b.replace(/\/api\/?$/, '') + path
  return window.location.origin + path
}

/** The text a Quote puts in the box: each line under "> ", then a blank line for his answer. */
function quoteText(text: string): string {
  const body = text.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')
  return body ? `${body}\n\n` : ''
}

export default function Messages({ active }: ScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWide(rootRef, 960)
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useRaven(active)
  const page = q.data
  // Connected: the drawer on a narrow screen, the column on a wide one
  const [showConn, setShowConn] = useState(false)
  const [side, setSide] = useSideOpen()
  const connBtn = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  // the drawer closes when the tab goes to the back or the screen grows wide (the column takes over)
  if (showConn && (!active || wide)) setShowConn(false)
  const drawer = showConn && active && !wide
  const draft = useRavenDraft()
  const ta = useRef<HTMLTextAreaElement>(null)

  // older pages, fetched on scroll-up; the live read always carries the newest 60
  const [older, setOlder] = useState<RavenMsg[]>([])
  const [noMore, setNoMore] = useState(false)
  const loadingOlder = useRef(false)
  const messages = useMemo(() => {
    const live = page?.messages ?? []
    const first = live[0]?.id ?? Infinity
    return [...older.filter((m) => m.id < first), ...live]
  }, [older, page])
  // once older pages are in, a line that slides out of the newest 60 (new ones came) joins them, so no gap opens
  const [kept, setKept] = useState<RavenPage | undefined>(undefined)
  if (page !== kept) {
    setKept(page)
    if (older.length && kept) {
      const was = kept.messages
      // the newest copy of each line wins (a proposal decided since)
      setOlder((cur) => [...new Map([...cur, ...was].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id))
    }
  }
  // an agent's line with no relay label still shows the agent's name
  const names = useMemo(() => new Map((page?.agents ?? []).map((a) => [a.id, a.name])), [page])

  // ?compose=1 focuses the box; ?c=<channel> (an old push) is dropped: there is one conversation. An old
  // /m/messages address waits for the shell to move it to /m/raven (with its query), so the two rewrites never race.
  const compose = params.get('compose') === '1'
  const oldAddress = /^\/m\/messages(\/|$)/.test(useLocation().pathname)
  useEffect(() => {
    if (!active || oldAddress || (!compose && !params.has('c'))) return
    if (compose) ta.current?.focus({ preventScroll: true })
    const p = new URLSearchParams(params)
    p.delete('compose')
    p.delete('c')
    setParams(p, { replace: true })
  }, [active, oldAddress, compose, params, setParams])

  // Ctrl+Shift+Space and the palette's "Message Raven" here: the box below, not the quick sheet
  useIntent('raven:compose', () => ta.current?.focus(), active)

  // the drawer: Escape or a press anywhere outside it closes it (a menu, a toast or the find bar over it first)
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.vk-menu, .vl-pal, [aria-modal="true"]') || (e.target as Element | null)?.closest?.('.vk-find')) return
      e.preventDefault()
      const inside = !!drawerRef.current?.contains(document.activeElement)
      setShowConn(false)
      if (inside) connBtn.current?.focus({ preventScroll: true })
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || drawerRef.current?.contains(t) || connBtn.current?.contains(t) || t.closest?.('.vk-menu, .vl-toasts')) return
      setShowConn(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [drawer])

  // ---- the list: stick to the newest, load older at the top ----
  // At the bottom the thread stays pinned there: new lines, Raven at work, a card or a picture that grows, the
  // keyboard (the visual viewport), the window, the composer growing, Connected opening. Scrolled up, it holds
  // where he is, and the chip over the composer counts what he has not read; a tap on it glides back down.
  const listRef = useRef<HTMLDivElement>(null)
  const colRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const lastId = messages.length ? messages[messages.length - 1].id : 0
  const firstId = messages[0]?.id ?? 0
  const busy = ravenBusy(page)
  const glideUntil = useRef(0)
  // the list's box and content height at the last look: a scroll that comes with a change of either is the layout's
  const dims = useRef({ ch: 0, sh: 0 })

  const pin = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    const resized = el.clientHeight !== dims.current.ch || el.scrollHeight !== dims.current.sh
    dims.current = { ch: el.clientHeight, sh: el.scrollHeight }
    if (!bottom && stick.current) {
      // the window or the thread changed size under him (a smaller window can scroll before the observer
      // runs): still pinned, back to the bottom
      if (resized) {
        pin()
        dims.current = { ch: el.clientHeight, sh: el.scrollHeight }
        return
      }
      // the chip's glide on its way down: still bound for the bottom
      if (Date.now() < glideUntil.current) return
    }
    stick.current = bottom
    setAtBottom(bottom)
  }, [pin])
  // The New line closes (messages.css). At the bottom the pin holds the newest lines and the rest slides down.
  // Scrolled up with the line above the screen, the rows he reads hold still: the row under the line keeps its
  // place on screen by the list scrolling up as much as the line shrank. The browser's own anchoring is off for
  // the close (messages.css), WebKit has none, so every engine does it this one way. `off` is the row's place in
  // the content, which his own scrolling never moves; `rest` the part of a pixel the scroll could not take yet.
  const closing = useRef<{ row: Element; off: number; rest: number } | null>(null)
  const hold = useCallback(() => {
    const el = listRef.current
    const c = closing.current
    if (!el || !c || !c.row.isConnected) return
    const off = rowY(el, c.row) + el.scrollTop
    const line = c.row.previousElementSibling
    if (line?.classList.contains('rv-new') && line.getBoundingClientRect().top < el.getBoundingClientRect().top) {
      const want = el.scrollTop + off - c.off + c.rest
      el.scrollTop = want
      c.rest = want - el.scrollTop
    }
    c.off = off
  }, [])

  useLayoutEffect(() => {
    if (stick.current) pin()
  }, [lastId, busy, active, pin])

  // anything that changes a height: the list's own box and the thread inside it, the window, the visual viewport
  useEffect(() => {
    const el = listRef.current
    const col = colRef.current
    if (!el || !col) return
    const follow = () => {
      if (stick.current) pin()
      else hold()
      measure()
    }
    const ro = new ResizeObserver(follow)
    ro.observe(el)
    ro.observe(col)
    // the keyboard on a phone: the layout settles a frame after the viewport says so
    const later = () => requestAnimationFrame(follow)
    const vv = window.visualViewport
    vv?.addEventListener('resize', later)
    window.addEventListener('resize', later)
    return () => {
      ro.disconnect()
      vv?.removeEventListener('resize', later)
      window.removeEventListener('resize', later)
    }
  }, [pin, measure, hold])

  // his own hand on the thread stops the chip's glide where it is
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const hand = () => { glideUntil.current = 0 }
    const key = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key) || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      hand()
    }
    el.addEventListener('wheel', hand, { passive: true })
    el.addEventListener('touchstart', hand, { passive: true })
    el.addEventListener('pointerdown', hand)
    window.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('wheel', hand)
      el.removeEventListener('touchstart', hand)
      el.removeEventListener('pointerdown', hand)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const toLatest = () => {
    const el = listRef.current
    if (!el) return
    stick.current = true
    if (reducedMotion()) {
      pin()
      return
    }
    glideUntil.current = Date.now() + 900
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // an older page went in above: hold what was on screen where it was
  const anchor = useRef<{ h: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollTop = a.top + (el.scrollHeight - a.h)
  }, [firstId])

  const loadOlder = async () => {
    const el = listRef.current
    if (!el || loadingOlder.current || noMore || !firstId) return
    loadingOlder.current = true
    try {
      const got = await fetchRavenOlder(firstId)
      if (got.length < RAVEN_OLDER) setNoMore(true)
      if (got.length) {
        anchor.current = { h: el.scrollHeight, top: el.scrollTop }
        setOlder((cur) => {
          const have = new Set(cur.map((m) => m.id))
          return [...got.filter((m) => !have.has(m.id)), ...cur].sort((a, b) => a.id - b.id)
        })
      }
    } catch (e) {
      toast(apiErrorText(e, 'Could not read older messages'), { ms: 4000 })
    } finally {
      loadingOlder.current = false
    }
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    measure()
    if (el.scrollTop < 160) void loadOlder()
  }

  // ---- reaching an older line: the find bar (Ctrl+F) and a copied link (?msg=<id>) ----
  const firstRef = useRef(firstId)
  useLayoutEffect(() => { firstRef.current = firstId }, [firstId])
  const loadTo = useCallback(async (id: number) => {
    let first = firstRef.current
    if (!first || id >= first) return
    if (loadingOlder.current) {
      // a scroll-up page in flight: wait for it, then go on from where it ends
      for (let t = 0; t < 50 && loadingOlder.current; t++) await new Promise((r) => setTimeout(r, 100))
      first = firstRef.current
      if (id >= first) return
    }
    loadingOlder.current = true
    stick.current = false
    const got: RavenMsg[] = []
    try {
      while (first > id) {
        const pg = await fetchRavenOlder(first, REACH_PAGE)
        got.push(...pg)
        if (pg.length < REACH_PAGE) setNoMore(true)
        if (pg.length < REACH_PAGE) break
        first = pg[0].id
      }
    } catch (e) {
      toast(apiErrorText(e, 'Could not read older messages'), { ms: 4000 })
    } finally {
      loadingOlder.current = false
    }
    if (got.length) {
      setOlder((cur) => [...new Map([...got, ...cur].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id))
    }
  }, [])
  useFindProvider({
    root: () => colRef.current,
    fromEnd: true,
    search: searchRaven,
    firstLoaded: () => firstRef.current || Infinity,
    reveal: loadTo,
    lineEl: (id) => listRef.current?.querySelector(`[data-mid="${id}"]`) ?? null,
  }, active)

  // ?msg=<id>: load to that line, bring it to the middle and light it a moment
  const msgParam = Number(params.get('msg')) || 0
  const hasPage = !!page
  useEffect(() => {
    if (!active || !hasPage || !msgParam) return
    let gone = false
    void (async () => {
      await loadTo(msgParam)
      for (let t = 0; t < 120 && !gone; t++) {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-mid="${msgParam}"]`)
        if (row) {
          stick.current = false
          row.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
          row.dataset.flash = ''
          window.setTimeout(() => { delete row.dataset.flash }, 2400)
          break
        }
        await new Promise((r) => requestAnimationFrame(r))
      }
      if (gone) return
      setParams((cur) => {
        const p = new URLSearchParams(cur)
        p.delete('msg')
        return p
      }, { replace: true })
    })()
    return () => { gone = true }
  }, [active, hasPage, msgParam, loadTo, setParams])

  // a Raven line's Quote: its words in the box, his caret under them
  const quote = useCallback((text: string) => {
    const q = quoteText(text)
    if (!q) return
    const cur = draft.text
    draft.setText(cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${q}` : q)
    requestAnimationFrame(() => {
      const t = ta.current
      if (!t) return
      t.focus({ preventScroll: true })
      t.setSelectionRange(t.value.length, t.value.length)
    })
  }, [draft])

  // files over the tab: say where they go
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  // read what is on screen: the newest line in view, the page in front
  const unread = page?.unread ?? 0
  const shown = usePageShown()
  useEffect(() => {
    if (!active || !atBottom || !unread || !lastId || !shown) return
    // the list itself, not the last scroll event: opening at the New line moves it before any event says so
    const el = listRef.current
    if (!el || el.scrollHeight - el.scrollTop - el.clientHeight >= STICK_PX) return
    void markRavenRead(lastId).then(() => {
      refreshRavenUnread(qc)
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    }, () => { /* the count stays until the next read */ })
  }, [active, atBottom, unread, lastId, shown, qc])

  // ---- unread: the New line ----
  // His read mark lives on odin, so every device follows it (the long-poll); his own lines never count. The New
  // line sits above the first unread line and fades out once the read lands. A line that arrives while he watches
  // the bottom is read on arrival and gets none. Coming in to unread lines that run past the screen, the thread
  // opens at the New line instead of the bottom.
  const lastRead = page?.lastRead
  // since when he has watched the bottom with the tab in front: a line made after that he saw as it came
  const watching = active && shown && atBottom
  const [watchSince, setWatchSince] = useState<number | null>(null)
  useEffect(() => {
    // a tick later is soon enough: a line made before he looked is older than the stamp either way
    const t = window.setTimeout(() => setWatchSince(watching ? Date.now() : null), 0)
    return () => window.clearTimeout(t)
  }, [watching])
  const seenLive = (m: RavenMsg) => watchSince !== null && Date.parse(m.createdAt) >= watchSince
  const firstUnread = lastRead === undefined ? null : messages.find((m) => m.id > lastRead && m.author !== 'brendon' && !seenLive(m))?.id ?? null
  const [mark, setMark] = useState<{ id: number; fading: boolean } | null>(null)
  if (firstUnread !== null && (mark?.id !== firstUnread || mark.fading)) setMark({ id: firstUnread, fading: false })
  else if (firstUnread === null && mark && !mark.fading) setMark({ ...mark, fading: true })
  useEffect(() => {
    if (!mark?.fading) return
    // the fade, then the close (messages.css): gone by 2.6 s, so dropping it moves nothing
    const t = window.setTimeout(() => setMark(null), 2900)
    return () => window.clearTimeout(t)
  }, [mark])
  // the row under a closing New line, and its place in the content at the last look
  useLayoutEffect(() => {
    const el = listRef.current
    const row = mark?.fading ? el?.querySelector('.rv-new[data-fading]')?.nextElementSibling : null
    closing.current = el && row ? { row, off: rowY(el, row) + el.scrollTop, rest: 0 } : null
  }, [mark])

  const entered = active && shown && !!page
  useLayoutEffect(() => {
    const el = listRef.current
    const line = el?.querySelector<HTMLElement>('.rv-new:not([data-fading])')
    if (!entered || !el || !line) return
    const y = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    // they all fit with the newest at the bottom: stay there (reaching it reads them)
    if (y - 12 >= el.scrollHeight - el.clientHeight) return
    stick.current = false
    el.scrollTop = y - 12
  }, [entered])

  // ---- writes ----
  const send = useMutation({
    mutationFn: (snap: DraftSnap) => sendRaven({ text: snap.text.trim(), files: snap.ids.length ? snap.ids : undefined, source: 'app' }),
    onSuccess: (m, snap) => {
      draft.markSent(snap)
      stick.current = true
      addToThread(qc, { messages: [m] })
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    },
    onError: (e) => toast(apiErrorText(e, 'Raven did not answer'), { ms: 4000 }),
  })
  const stop = useMutation({
    mutationFn: stopRaven,
    onSuccess: () => void qc.invalidateQueries({ queryKey: RAVEN_KEY }),
    onError: (e) => toast(apiErrorText(e, 'Raven did not stop'), { ms: 4000 }),
  })

  const status = page ? ravenStatusText(page) : ''
  const failed = q.isError && !page
  const connected = page ? <Connected page={page} messages={messages} onOpen={(to) => { setShowConn(false); navigate(to) }} /> : null
  const glance = page ? glanceOf(page) : { working: 0, waiting: 0 }
  const connOpen = wide ? side : drawer
  const connLabel = `Working, watching and agents${glance.working ? `, ${glance.working} working` : ''}${glance.waiting ? `, ${plural(glance.waiting, 'proposal')} waiting` : ''}`

  return (
    <div
      className="rv"
      ref={rootRef}
      data-wide={wide || undefined}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        dragDepth.current = 0
        setDragging(false)
        // a drop on the composer attached them already (it bubbles here)
        if (e.defaultPrevented) return
        const files = Array.from(e.dataTransfer.files)
        if (!files.length) return
        e.preventDefault()
        draft.add(files)
      }}
    >
      <section className="rv-conv" aria-label="Raven">
        <header className="rv-head">
          <h2>Raven</h2>
          {/* a narrow header keeps the first word while Raven works; the live line at the end of the thread has the model and effort */}
          <span className="rv-status" data-state={page?.status} data-busy={busy || undefined} title={status || undefined}>{failed ? 'not answering' : busy && !wide ? status.split(' · ')[0] : status}</span>
          {busy && <Button kind="link" className="rv-stop" disabled={stop.isPending} onPress={() => stop.mutate()}>Stop</Button>}
          {page && (
            <Press
              ref={connBtn}
              className="rv-panel-btn"
              data-on={connOpen || undefined}
              aria-expanded={connOpen}
              aria-controls={wide ? 'rv-side' : 'rv-drawer'}
              aria-label={connLabel}
              title={wide ? (side ? 'Hide working, watching and agents' : 'Show working, watching and agents') : 'Working, watching and agents'}
              onPress={() => (wide ? setSide(!side) : setShowConn((v) => !v))}
            >
              <PanelRight size={15} strokeWidth={1.7} aria-hidden />
              {glance.working > 0 && <span className="rv-panel-n"><span className="rv-dot" data-state="working" aria-hidden />{glance.working}</span>}
              {glance.waiting > 0 && <span className="rv-n rv-panel-wait">{glance.waiting}</span>}
            </Press>
          )}
        </header>
        <div className="rv-thread" data-read={lastRead} data-new={mark?.id} data-watch={watchSince ?? undefined}>
        {drawer && connected && (
          <>
            <div className="rv-drawer-back" aria-hidden />
            <aside id="rv-drawer" className="rv-conn rv-drawer" ref={drawerRef} aria-label="Working, watching and agents">{connected}</aside>
          </>
        )}
        <div className="rv-msgs" ref={listRef} onScroll={onScroll}>
          <div className="rv-col" ref={colRef}>
            {failed && <p className="rv-quiet">Raven is not answering: {apiErrorText(q.error, 'no reply from Valkyrie')}</p>}
            {!page && !failed && <p className="rv-quiet">Reading Raven</p>}
            {page && !messages.length && <p className="rv-quiet rv-empty">Nothing yet. Write Raven anything: a question, a task, a file, a session to start.</p>}
            {page && noMore && messages.length > 0 && <p className="rv-quiet rv-top">The start of the conversation.</p>}
            <Thread messages={messages} names={names} mark={mark} onQuote={quote} />
            {busy && (
              <div className="rv-working" aria-live="polite">
                <span className="rv-pulse" aria-hidden />
                <span>{status}</span>
              </div>
            )}
          </div>
        </div>
        {!atBottom && messages.length > 0 && (
          <Press
            className="rv-latest"
            data-n={unread || undefined}
            aria-label={unread ? `${unread} unread, go to the newest message` : 'Go to the newest message'}
            onPress={toLatest}
          >
            <ArrowDown size={13} strokeWidth={1.8} aria-hidden />
            <span>{unread ? `${unread} new` : 'Latest'}</span>
          </Press>
        )}
        </div>
        <RavenComposer draft={draft} sending={send.isPending} onSend={() => send.mutate(draft.snapshot())} placeholder="Message Raven" taRef={ta} tools={<RavenPick page={page} />} voiceOn={active} />
      </section>
      {wide && side && connected && <aside id="rv-side" className="rv-conn rv-side" aria-label="Working, watching and agents">{connected}</aside>}
      {dragging && <div className="rv-drop" aria-hidden><span>Drop to attach to your message</span></div>}
    </div>
  )
}

// ------------------------------------------------------------- the thread ---

/** The thread as the Raven tab draws it; the desktop widget (RavenWidget.tsx) shows the same. */
export function Thread({ messages, names, mark = null, onQuote }: {
  messages: RavenMsg[]; names: Map<string, string>; mark?: { id: number; fading: boolean } | null
  /** the context menu's Quote: the Raven tab puts the words in its box; the widget has none */
  onQuote?: (text: string) => void
}) {
  const now = useTick(60_000)
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const next = messages[i + 1]
        const t = Date.parse(m.createdAt)
        const newDay = !prev || NY_KEY.format(Date.parse(prev.createdAt)) !== NY_KEY.format(t)
        const kind = kindOf(m)
        // his bubbles run together; every line from Raven, a relay or Valkyrie stands alone, with its label and time
        const grouped = !!prev && kind === 'me' && joins(prev, m)
        const last = !next || !joins(m, next)
        // two plain lines in a row on Raven's side get a hairline between them (a relay is a block of its own)
        const split = !newDay && !!prev && PLAIN.has(kind) && PLAIN.has(kindOf(prev))
        return (
          <div key={m.id} className="rv-item" data-mid={m.id}>
            {newDay && <div className="rv-day"><span>{dayLabel(t, now)}</span></div>}
            {mark?.id === m.id && <div className="rv-new" role="separator" aria-label="New messages" data-fading={mark.fading || undefined}><div><span>New</span></div></div>}
            <Row m={m} grouped={grouped} last={last} split={split} names={names} onQuote={onQuote} />
          </div>
        )
      })}
    </>
  )
}

/** Who a row is from, for grouping: the author, and a relay's source. */
const who = (m: RavenMsg) => `${m.author}|${m.meta.relay?.kind ?? ''}|${m.meta.relay?.from ?? ''}`

/** `m` continues `prev`'s run: the same day, the same source, within 10 minutes, not a proposal. */
function joins(prev: RavenMsg, m: RavenMsg): boolean {
  const a = Date.parse(prev.createdAt)
  const b = Date.parse(m.createdAt)
  return NY_KEY.format(a) === NY_KEY.format(b) && who(prev) === who(m) && b - a < 10 * 60_000 && !m.proposal
}

type Kind = 'me' | 'raven' | 'relay' | 'system'
const PLAIN = new Set<Kind>(['raven', 'system'])

function kindOf(m: RavenMsg): Kind {
  if (m.meta.relay) return 'relay'
  if (m.author === 'brendon') return 'me'
  if (m.author === 'raven') return 'raven'
  if (m.author === 'system') return 'system'
  return 'relay'
}

/**
 * One line of the thread. His own lines are bubbles on the right, with the time
 * (and "via Siri") under the last of a run; their You label is for screen
 * readers. Every other line opens with its sender and time: Raven's replies are
 * plain text under a RAVEN label, the model, effort and rule under each, a
 * hairline between two in a row; a relay (an agent, a session, a feed, the
 * brief) is a tinted block of its own with a lit edge and its source's name.
 */
function Row({ m, grouped, last, split, names, onQuote }: {
  m: RavenMsg; grouped: boolean; last: boolean; split: boolean; names: Map<string, string>; onQuote?: (text: string) => void
}) {
  const navigate = useNavigate()
  const kind = kindOf(m)
  const relay = m.meta.relay
  const pane = relay?.kind === 'session' && TERM_NAME_RE.test(relay.from) ? relay.from : null
  const termPath = pane ? v2TermPath(pane) : null
  // a session relay names the conversation by its own title, the pane's name (a main target) beside it
  const label = kind === 'me' ? 'You' : kind === 'raven' ? 'Raven' : kind === 'system' ? 'Valkyrie' : relay?.title || relay?.label || names.get(m.author) || m.author
  const from = relay?.title && relay.label ? relay.label : null
  const via = kind === 'me' && m.meta.source ? SOURCE_WORD[m.meta.source] : undefined
  const meta = kind === 'raven' && !m.meta.error && (m.meta.model || m.meta.tier) ? replyMetaLine(m.meta, m.createdAt, { time: false }) : null
  // a feed's notice about a state that changes: the count as it stands, or cleared
  const live = relay?.kind === 'feature' || relay?.kind === 'system' ? liveLine(relay, etTime) : null
  // a session relay's ref link to its pane is the Open link already
  const refs = termPath ? m.refs.filter((r) => !(r.type === 'link' && r.url === termPath)) : m.refs
  const files = m.meta.files && m.meta.files.length > 0 ? <RavenFiles files={m.meta.files} /> : null
  const time = <time title={NY_DAY.format(Date.parse(m.createdAt))}>{etTime(m.createdAt)}</time>
  // his own lines: the bubble says who, the label is for screen readers, the time goes under the line
  const quiet = kind === 'me'
  // the context menu on a line: its text, a link to it, Quote, Select, Find; Open for a session's line
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const sel = window.getSelection()
    const picked = sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode) ? sel.toString().trim() : ''
    const text = m.text.trim()
    const art = e.currentTarget
    addMenu(e, [
      text && !picked && { label: 'Copy text', icon: Copy, run: () => void copyWithToast(text) },
      { label: 'Copy link to this message', icon: Link2, run: () => void copyWithToast(appLink(`/m/raven?msg=${m.id}`), 'Link copied') },
      onQuote && (picked || text) && { label: picked ? 'Quote the selection' : kind === 'me' ? 'Quote' : 'Quote and reply', icon: Quote, run: () => onQuote(picked || text) },
      text && !picked && { label: 'Select text', icon: TextSelect, run: () => {
        const body = art.querySelector('.rv-md')
        const s = window.getSelection()
        if (!body || !s) return
        const r = document.createRange()
        r.selectNodeContents(body)
        s.removeAllRanges()
        s.addRange(r)
      } },
      termPath && { label: `Open ${label}`, icon: ExternalLink, run: () => navigate(termPath) },
      { label: 'Find in the thread', icon: Search, hint: 'Ctrl F', run: () => openFind(picked && picked.length <= 120 && !picked.includes('\n') ? picked : undefined) },
    ])
  }
  return (
    <article className="rv-msg" data-kind={kind} data-relay={relay?.kind} data-grouped={grouped || undefined} data-split={split || undefined} data-error={m.meta.error ? '' : undefined} data-cleared={relay?.cleared ? '' : undefined} onContextMenu={onContextMenu}>
      {!grouped && (
        <div className="rv-msg-head" data-sr={quiet || undefined}>
          <b>{label}</b>
          {from && <span className="rv-msg-from">{from}</span>}
          {termPath && (
            <a
              className="rv-open"
              href={termPath}
              onClick={(e) => { e.preventDefault(); navigate(termPath) }}
            >Open</a>
          )}
          {!quiet && time}
        </div>
      )}
      {kind === 'me' ? (
        <>
          {files}
          {m.text && <div className="rv-bubble"><Markdown className="rv-md">{m.text}</Markdown></div>}
          {refs.length > 0 && <Refs refs={refs} />}
          {(last || via) && <p className="rv-foot">{time}{via && <span className="rv-via">via {via}</span>}</p>}
        </>
      ) : (
        <>
          {m.text && <Markdown className="rv-md">{m.text}</Markdown>}
          {live && <p className="rv-live">{live}</p>}
          {files}
          {refs.length > 0 && <Refs refs={refs} />}
          {m.meta.sessions?.map((c, i) => <SessionCopy key={`${c.from}-${i}`} copy={c} />)}
          {(m.proposals ?? (m.proposal ? [m.proposal] : [])).map((p) => <ProposalCard key={p.id} p={p} />)}
          {meta && <p className="rv-meta" title={replyMetaTitle(m.meta)}>{meta}</p>}
        </>
      )}
    </article>
  )
}

/**
 * What a watched session wrote, under Raven's take on it: closed until he opens it. Raven reads every line; the
 * thread shows only Raven's words, and this is there to look back at. Open goes to the session itself.
 */
function SessionCopy({ copy }: { copy: RavenSessionCopy }) {
  const navigate = useNavigate()
  const pane = TERM_NAME_RE.test(copy.from) ? copy.from : null
  const termPath = pane ? v2TermPath(pane) : null
  const name = copy.title || copy.label
  const n = copy.lines.length + (copy.more ?? 0)
  return (
    <details className="rv-said">
      <summary>
        <ChevronRight className="rv-said-chev" size={13} strokeWidth={1.8} aria-hidden />
        <span>What {name} wrote <span className="rv-said-n">· {n} {n === 1 ? 'message' : 'messages'}</span></span>
      </summary>
      <div className="rv-said-body">
        {copy.more ? <p className="rv-said-more">{copy.more} older {copy.more === 1 ? 'message is' : 'messages are'} in the session.</p> : null}
        {copy.lines.map((l, i) => (
          <div key={i} className="rv-said-line">
            <time title={NY_DAY.format(Date.parse(l.at))}>{etTime(l.at)}</time>
            <Markdown className="rv-md">{l.text}</Markdown>
          </div>
        ))}
        {termPath && (
          <a className="rv-open" href={termPath} onClick={(e) => { e.preventDefault(); navigate(termPath) }}>Open the session</a>
        )}
      </div>
    </details>
  )
}

function Refs({ refs }: { refs: Ref[] }) {
  const navigate = useNavigate()
  const items: ReactNode[] = refs.map((r, i) => {
    if (r.type === 'ticket') return <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{r.number}{r.title ? ` · ${r.title}` : ''}</a>
    if (r.type === 'mail') {
      const label = `Mail${r.from ? ` from ${r.from}` : ''}${r.subject ? `: ${r.subject}` : ''}`
      return r.url ? <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={i} className="rv-ref">{label}</span>
    }
    if (r.type === 'link') {
      const label = r.label || r.url.replace(/^https:\/\//, '').slice(0, 60)
      // an app path moves inside the app; never opens a window of its own
      if (/^\/m\//.test(r.url)) return <a key={i} className="rv-ref" href={r.url} onClick={(e) => { e.preventDefault(); navigate(r.url) }}>{label}</a>
      return /^https?:\/\//.test(r.url) ? <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{label}</a> : null
    }
    return null
  })
  return <div className="rv-refs">{items}</div>
}

// --------------------------------------------------------------- proposals ---

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** An agent's proposal inline: a mail draft he can edit, then Send, Save to drafts or Decline; anything else Approve or Decline. */
function ProposalCard({ p }: { p: Proposal }) {
  const qc = useQueryClient()
  const pl = (p.payload && typeof p.payload === 'object' ? p.payload : {}) as Record<string, unknown>
  const mail = p.kind === 'mail_reply'
  const [body, setBody] = useState(str(pl.body))
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const pending = p.status === 'pending' || p.status === 'failed'
  const refresh = () => qc.invalidateQueries({ queryKey: RAVEN_KEY })
  const approve = useMutation({
    mutationFn: (how: 'send' | 'draft') => approveProposal(p.id, mail ? { how, body } : {}),
    onSuccess: (_r, how) => { toast(mail ? (how === 'draft' ? 'Saving to Outlook drafts' : 'Sending from thor') : 'Done'); void refresh() },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 5000 }),
  })
  const decline = useMutation({
    mutationFn: () => declineProposal(p.id, reason),
    onSuccess: () => { setDeclining(false); void refresh() },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 5000 }),
  })
  const cc = Array.isArray(pl.cc) ? (pl.cc as string[]) : []

  return (
    <div className="rv-prop" data-status={p.status}>
      <div className="rv-prop-head">
        <b>{p.title}</b>
        <span className="rv-prop-state">{
          p.status === 'pending' ? 'waiting for you'
            : p.status === 'running' ? (mail ? 'with thor' : 'working')
              : p.status === 'done' ? 'done' : p.status === 'declined' ? 'declined' : 'failed'
        }</span>
      </div>
      {mail && (
        <dl className="rv-prop-meta">
          <dt>To</dt><dd>{str(pl.toName) ? `${str(pl.toName)} <${str(pl.to)}>` : str(pl.to)}</dd>
          {pl.replyAll ? <><dt>Cc</dt><dd>everyone on the thread</dd></> : cc.length > 0 && <><dt>Cc</dt><dd>{cc.join(', ')}</dd></>}
          <dt>Subject</dt><dd>RE: {str(pl.subject).replace(/^re:\s*/i, '')}</dd>
        </dl>
      )}
      {p.kind === 'ticket_note' && <pre className="rv-prop-body">{str(pl.title)}{'\n\n'}{str(pl.text)}</pre>}
      {p.kind === 'ticket_create' && <pre className="rv-prop-body">{str(pl.company)}: {str(pl.title)}{'\n\n'}{str(pl.description)}</pre>}
      {mail && (pending
        ? <textarea className="rv-prop-edit" value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(16, Math.max(5, body.split('\n').length + 1))} aria-label="The draft" />
        : <pre className="rv-prop-body">{str(pl.body)}</pre>)}
      {mail && pending && <p className="rv-prop-hint">"Thank you," and your signature are added when it goes out.</p>}
      {p.result && p.status !== 'pending' && <p className="rv-prop-result">{p.result}</p>}
      {pending && !declining && (
        <div className="rv-prop-acts">
          {mail ? (
            <>
              <Button kind="line" lit disabled={approve.isPending} onPress={() => approve.mutate('send')}>{p.status === 'failed' ? 'Try sending again' : 'Send'}</Button>
              <Button kind="link" disabled={approve.isPending} onPress={() => approve.mutate('draft')}>Save to Outlook drafts</Button>
            </>
          ) : (
            <Button kind="line" lit disabled={approve.isPending} onPress={() => approve.mutate('send')}>{p.status === 'failed' ? 'Try again' : 'Approve'}</Button>
          )}
          <Button kind="link" onPress={() => setDeclining(true)}>Decline</Button>
        </div>
      )}
      {declining && (
        <form className="rv-prop-decline" onSubmit={(e) => { e.preventDefault(); decline.mutate() }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional, the agent learns from it)" autoFocus />
          <Button kind="link" type="button" disabled={decline.isPending} onPress={() => decline.mutate()}>Decline</Button>
          <Button kind="link" type="button" onPress={() => setDeclining(false)}>Keep</Button>
        </form>
      )}
    </div>
  )
}

// -------------------------------------------------------------- connected ---

const MAIN_WORD: Record<string, string> = { working: 'working', idle: 'idle', closed: 'not open', dead: 'ended' }
const WATCH_WORD: Record<string, string> = { working: 'Working', idle: 'Idle', closed: 'Closed' }
// the clock ticks once a minute, so under a minute is "just now", never a seconds count already behind
const lastSeen = (at: number, now: number) => (now - at < 60_000 ? 'just now' : `${ago(at, now)} ago`)
const AGENT_WORD: Record<string, string> = { idle: 'idle', queued: 'about to start', working: 'working', resting: 'resting', error: 'last run failed' }

/** The feeds that wrote into the thread (a feature's process, an odin script), each with its latest line. */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** An agent's own feed under its row: the newest line, a cleared one never shown (the API leaves it out). */
function AgentFeedLine({ feed, now }: { feed: RavenFeed; now: number }) {
  return <span className="rv-crow-line" data-feed={feed.from} title={`${etTime(feed.at)} · ${ago(Date.parse(feed.at), now)}`}>{feed.text}</span>
}

/**
 * Decline all, asked first: the line under an agent (or under the Agents heading, for every agent) that names the
 * count and says nothing is sent or applied. Declines the oldest `count` waiting proposals, the ones he saw.
 */
function DeclineAll({ agentId, count, who, onDone }: { agentId?: string; count: number; who: string; onDone: () => void }) {
  const qc = useQueryClient()
  const go = useMutation({
    mutationFn: () => declineAllProposals({ agentId, count }),
    onSuccess: (r) => {
      toast(`Declined ${plural(r.declined, 'proposal')}${agentId ? ` from ${who}` : ''}`, { ms: 4000 })
      onDone()
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
      refreshRavenUnread(qc)
    },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not decline them'), { ms: 5000 }),
  })
  return (
    <div className="rv-confirm" role="alertdialog" aria-label={`Decline all from ${who}`}>
      <p>Decline all {plural(count, 'waiting proposal')} from {who}? Nothing is sent or applied.</p>
      <div className="rv-confirm-acts">
        <Button kind="line" lit disabled={go.isPending} onPress={() => go.mutate()}>{go.isPending ? 'Declining' : `Decline ${count}`}</Button>
        <Button kind="link" disabled={go.isPending} onPress={onDone}>Keep</Button>
      </div>
    </div>
  )
}

/** What Raven reaches: his main terminals, the sessions it watches, the agents, the feeds. */
/** One line of text that shows only while it fits whole: never cut off with an ellipsis, left out instead. */
function FitLine({ className, text }: { className: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setFits(el.scrollWidth <= el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])
  return <div ref={ref} className={className} data-fit={fits ? undefined : 'no'} aria-hidden={fits ? undefined : true}>{text}</div>
}

function Connected({ page, messages, onOpen }:{ page: RavenPage; messages: RavenMsg[]; onOpen: (to: string) => void }) {
  const now = useTick(60_000)
  // each feed's newest line (a cleared one left out); an agent's own feed goes under its row, not under Feeds
  const { byAgent, rest: feeds } = splitFeeds(page.feeds ?? feedsFromThread(messages), page.agents)
  // which Decline all is asking: an agent's id, 'all', or none
  const [asking, setAsking] = useState<string | null>(null)
  const waiting = page.agents.reduce((n, a) => n + a.pending, 0)
  const withPending = page.agents.filter((a) => a.pending > 0).length
  const open = (pane: string) => (
    <a className="rv-open" href={v2TermPath(pane)} onClick={(e) => { e.preventDefault(); onOpen(v2TermPath(pane)) }}>Open</a>
  )
  // a session's card: Open, a link to it, its name
  const sessionMenu = (e: ReactMouseEvent, pane: string | null, name: string) => addMenu(e, [
    pane && { label: `Open ${name}`, icon: ExternalLink, run: () => onOpen(v2TermPath(pane)) },
    pane && { label: 'Copy link to the session', icon: Link2, run: () => void copyWithToast(appLink(v2TermPath(pane)), 'Link copied') },
    { label: 'Copy name', icon: Copy, run: () => void copyWithToast(name) },
  ])
  // a closed session leaves Watching at once (the API lists none either)
  const watching = page.watching.filter((w) => w.state !== 'closed')
  const empty = !page.mains.length && !watching.length && !page.agents.length && !feeds.length
  return (
    <>
      {empty && <p className="rv-quiet">Nothing connected yet.</p>}
      {page.mains.length > 0 && (
        <div className="rv-group">
          <h3>Main terminals</h3>
          {page.mains.map((t) => (
            <div key={t.target} className="rv-crow" data-state={t.state} onContextMenu={(e) => sessionMenu(e, t.pane && t.state !== 'dead' ? t.pane : null, t.label)}>
              <span className="rv-dot" data-state={t.state === 'working' ? 'working' : t.state === 'idle' ? 'idle' : 'off'} aria-hidden />
              <span className="rv-crow-name">{t.label}</span>
              <span className="rv-crow-note">{MAIN_WORD[t.state] ?? t.state}</span>
              {t.pane && t.state !== 'dead' && open(t.pane)}
            </div>
          ))}
        </div>
      )}
      {watching.length > 0 && (
        <div className="rv-group">
          <h3>Watching</h3>
          <div className="rv-wcards">
            {watching.map((w) => {
              const state = w.state ?? null
              const at = w.lastAt || w.since
              return (
                <div key={w.pane || w.sessionId} className="rv-wcard" data-state={state ?? 'unknown'} onContextMenu={(e) => sessionMenu(e, w.pane || null, w.title || w.label)}>
                  <div className="rv-wcard-top">
                    <span className="rv-dot" data-state={state === 'working' ? 'working' : state === 'idle' ? 'idle' : state === 'closed' ? 'off' : 'watch'} aria-hidden />
                    <span className="rv-wcard-name" title={w.title || w.label}>{w.title || w.label}</span>
                    {w.pane && open(w.pane)}
                  </div>
                  {w.status && <FitLine className="rv-wcard-status" text={w.status} />}
                  <div className="rv-wcard-meta">
                    {state && <span className="rv-wcard-state">{WATCH_WORD[state]}</span>}
                    <span className="rv-wcard-at" title={etTime(at)}>{w.lastAt ? lastSeen(Date.parse(at), now) : `since ${etTime(at)}`}</span>
                    {w.title && <span className="rv-wcard-from">{w.label}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {page.agents.length > 0 && (
        <div className="rv-group">
          <div className="rv-group-head">
            <h3>Agents{page.paused ? <span className="rv-warn"> · paused</span> : null}</h3>
            {waiting > 0 && (
              <Press className="rv-h-act" aria-expanded={asking === 'all'} onPress={() => setAsking((v) => (v === 'all' ? null : 'all'))}>Decline all</Press>
            )}
          </div>
          {asking === 'all' && <DeclineAll count={waiting} who={plural(withPending, 'agent')} onDone={() => setAsking(null)} />}
          {page.agents.map((a) => (
            <div key={a.id} className="rv-crow-wrap">
              <div className="rv-crow" data-state={a.status} onContextMenu={(e) => addMenu(e, [
                a.pending > 0 && { label: `Decline all from ${a.name}`, icon: X, danger: true, run: () => setAsking(a.id) },
              ])}>
                <span className="rv-dot" data-state={page.paused ? 'off' : a.status} aria-hidden />
                <span className="rv-crow-name">{a.name}</span>
                <span className="rv-crow-note">{AGENT_WORD[a.status] ?? a.status}</span>
                {a.pending > 0 && (
                  <span className="rv-n" role="img" title={`${plural(a.pending, 'proposal')} waiting`} aria-label={`${plural(a.pending, 'proposal')} waiting`}>{a.pending}</span>
                )}
                {a.pending > 0 && (
                  <Press className="rv-crow-act" aria-expanded={asking === a.id} onPress={() => setAsking((v) => (v === a.id ? null : a.id))}>Decline all</Press>
                )}
                {byAgent.has(a.id) && <AgentFeedLine feed={byAgent.get(a.id)!} now={now} />}
              </div>
              {asking === a.id && a.pending > 0 && <DeclineAll agentId={a.id} count={a.pending} who={a.name} onDone={() => setAsking(null)} />}
            </div>
          ))}
        </div>
      )}
      {feeds.length > 0 && (
        <div className="rv-group">
          <h3>Feeds</h3>
          {feeds.map((f) => (
            <div key={f.label} className="rv-crow">
              <span className="rv-dot" data-state="idle" aria-hidden />
              <span className="rv-crow-name">{f.label}</span>
              <span className="rv-crow-note" title={etTime(f.at)}>{ago(Date.parse(f.at), now)}</span>
              {f.text && <span className="rv-crow-line">{f.text}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
