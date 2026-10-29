import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BASE, SETTINGS_ID, playerActions, requestIntent, usePlayerNow, type ScreenDef } from './shell'
import { useSessionIndex } from './data'
import { Icon, isIconName, type IconName } from './icons'
import { PALETTE_EVENT, paletteState, toast } from './ui'
import { getMotionSetting, setMotionSetting } from './motion'
import { fetchTermSessions, termLabel, type TermSession } from '../../lib/api'
import { clearToken, setAuthSkipped } from '../../lib/auth'
import { resolveProfile } from '../../lib/deviceMode'
import { v2TermPath } from '../../lib/term'
import { applyZoom, getZoom } from '../../lib/zoom'

// The command palette (Ctrl+K, or the strip's search button): one box that
// jumps to every v2 tab, sub-tab and screen, opens a running session by name,
// runs the quick actions, and reaches the classic pages v2 has no screen for.
// The classic CommandPalette (src/components) did pages only. Keyboard first:
// type, arrows, Enter; Escape or a click outside closes it. Mounted once by
// src/v2/App.tsx, so it works on the tabs, in Settings and on a session.
// Inside a terminal Ctrl+K stays the terminal's (readline's kill-line).

type Cmd = {
  id: string
  label: string
  group: 'Go to' | 'Sessions' | 'Actions' | 'Classic'
  icon: IconName
  /** extra words it answers to */
  keys?: string
  /** dim text at the right end */
  hint?: string
  run: () => void
}

const GROUPS: Cmd['group'][] = ['Go to', 'Sessions', 'Actions', 'Classic']

// a sub-tab's icon and the words it answers to; a sub-tab not listed takes its screen's icon
const SUB_META: Record<string, { icon: IconName; keys: string }> = {
  'dashboard/overview': { icon: 'dashboard', keys: 'home tracker lights trade' },
  'dashboard/today': { icon: 'calendar', keys: 'today day brief capture agenda due now' },
  'ai/sessions': { icon: 'claude', keys: 'claude terminals board' },
  'ai/projects': { icon: 'projects', keys: 'project' },
  'ai/usage': { icon: 'gauge', keys: 'quota limits 5h week claude accounts' },
  'media/dashboard': { icon: 'media', keys: 'plex recent' },
  'media/movies': { icon: 'movie', keys: 'films plex' },
  'media/shows': { icon: 'watch', keys: 'tv series plex' },
  'media/music': { icon: 'music', keys: 'albums artists songs' },
  'media/requests': { icon: 'download', keys: 'downloads queue radarr sonarr' },
  'system/hosts': { icon: 'thor', keys: 'machines cpu memory disk thor odin' },
  'system/services': { icon: 'service', keys: 'containers launcher' },
  'system/trades': { icon: 'trades', keys: 'trade bot stocks equity' },
}
const SCREEN_KEYS: Record<string, string> = {
  dashboard: 'home today tracker calendar',
  lights: 'bulbs rgb home assistant',
}

// classic pages with no v2 screen; following one marks the tab classic until "new ui"
const CLASSIC_PAGES: { to: string; label: string; icon: IconName; keys: string }[] = [
  { to: '/sessions', label: 'All sessions', icon: 'claude', keys: 'snapshots restore closed history' },
  { to: '/projects', label: 'Projects board', icon: 'projects', keys: 'notes files' },
  { to: '/vault', label: 'Vault', icon: 'container', keys: 'passwords backups' },
  { to: '/activity', label: 'Activity', icon: 'timer', keys: 'log events' },
  { to: '/slop', label: 'Slop factory', icon: 'movie', keys: 'moments' },
  { to: '/vr', label: 'VR workspace', icon: 'frame', keys: 'headset' },
]

const ZOOM_STEP = 0.1
const pct = (z: number) => `${Math.round(z * 100)}%`

/** Every word typed appears somewhere in the label, group or keywords; label hits sort first. */
function filter(cmds: Cmd[], query: string): Cmd[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return cmds
  const scored: { c: Cmd; s: number; i: number }[] = []
  cmds.forEach((c, i) => {
    const label = c.label.toLowerCase()
    const hay = `${label} ${c.group.toLowerCase()} ${c.keys ?? ''} ${c.hint?.toLowerCase() ?? ''}`
    if (!words.every((w) => hay.includes(w))) return
    const s = label.startsWith(words[0]) ? 0 : label.split(/[\s·]+/).some((t) => t.startsWith(words[0])) ? 1 : label.includes(words[0]) ? 2 : 3
    scored.push({ c, s, i })
  })
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.c)
}

/** Is the event inside a terminal (xterm)? There Ctrl+K belongs to the shell running in it. */
const inTerminal = (t: EventTarget | null) => t instanceof Element && !!t.closest('.xterm')

export function Palette({ screens }: { screens: ScreenDef[] }) {
  // open on the history entry it was opened on: any navigation (a row, the back gesture) closes it
  const location = useLocation()
  const keyRef = useRef(location.key)
  useLayoutEffect(() => { keyRef.current = location.key }, [location.key])
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn !== null && openOn === location.key

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return
      if (e.key !== 'k' && e.key !== 'K') return
      if (inTerminal(e.target)) return
      e.preventDefault()
      setOpenOn((cur) => (cur === keyRef.current ? null : keyRef.current))
    }
    const onOpen = () => setOpenOn(keyRef.current)
    window.addEventListener('keydown', onKey)
    window.addEventListener(PALETTE_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(PALETTE_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    paletteState.open = open
    return () => { paletteState.open = false }
  }, [open])

  if (!open) return null
  return createPortal(<PaletteBox screens={screens} onClose={() => setOpenOn(null)} />, document.body)
}

function PaletteBox({ screens, onClose }: { screens: ScreenDef[]; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const player = usePlayerNow()
  const index = useSessionIndex()
  const terms = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, staleTime: 5_000, retry: 1 })

  // focus the box, and give focus back to whatever had it when the palette closes
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => { if (before && document.contains(before)) before.focus({ preventScroll: true }) }
  }, [])

  const cmds = useMemo<Cmd[]>(() => {
    const onTab = /^\/m\/(?!settings\b|ai\/term\b|ai\/skin\b)[^/]+/.test(location.pathname)
    const go = (to: string) => navigate(to, { replace: onTab && to.startsWith(`${BASE}/`) && !to.startsWith(`${BASE}/ai/term/`) })
    const out: Cmd[] = []

    // ---- every tab and sub-tab, Settings, the terminal preview ----
    for (const s of screens) {
      const icon: IconName = s.icon ?? (isIconName(s.id) ? s.id : 'home')
      if (!s.subs?.length) {
        out.push({ id: `go:${s.id}`, label: s.label, group: 'Go to', icon, keys: SCREEN_KEYS[s.id], run: () => go(`${BASE}/${s.id}`) })
        continue
      }
      for (const sub of s.subs) {
        const meta = SUB_META[`${s.id}/${sub.id}`]
        out.push({
          id: `go:${s.id}/${sub.id}`,
          label: `${s.label} · ${sub.label}`,
          group: 'Go to',
          icon: meta?.icon ?? icon,
          keys: meta?.keys,
          run: () => go(`${BASE}/${s.id}/${sub.id}`),
        })
      }
    }
    // the full pages outside the tabs (Calendar.tsx PageFrame): pushed, so their Back returns here
    const page = (to: string) => navigate(to, { state: { v2Back: true } })
    out.push({ id: 'go:calendar', label: 'Calendar', group: 'Go to', icon: 'calendar', keys: 'events month week agenda day', run: () => page(`${BASE}/calendar`) })
    out.push({ id: 'go:tasks', label: 'Tasks', group: 'Go to', icon: 'tasks', keys: 'todo to-do checklist due overdue', run: () => page(`${BASE}/tasks`) })
    out.push({ id: 'go:inbox', label: 'Inbox', group: 'Go to', icon: 'inbox', keys: 'alerts notifications messages reminders unread', run: () => page(`${BASE}/inbox`) })
    out.push({ id: 'go:meals', label: 'Meals', group: 'Go to', icon: 'supplements', keys: 'food macros calories protein', run: () => page(`${BASE}/meals`) })
    out.push({ id: 'go:settings', label: 'Settings', group: 'Go to', icon: 'settings', keys: 'appearance scheme color font notifications build sign out device', run: () => go(`${BASE}/${SETTINGS_ID}`) })
    out.push({ id: 'go:skin', label: 'AI · Terminal preview', group: 'Go to', icon: 'claude', keys: 'skin sample', run: () => go(`${BASE}/ai/skin`) })

    // ---- running sessions, by the name the board gives them ----
    const titles = new Map<string, string>()
    for (const [id, b] of index.byId) if (b.title) titles.set(id, b.title)
    const panes = (terms.data ?? []).filter((t: TermSession) => !t.dead).sort((a, b) => b.activityAt - a.activityAt)
    for (const t of panes) {
      out.push({
        id: `term:${t.name}`,
        label: termLabel(t, titles),
        group: 'Sessions',
        icon: t.mode === 'shell' ? 'start' : 'claude',
        hint: t.host || undefined,
        keys: `session terminal open ${t.label} ${t.name}`,
        run: () => navigate(v2TermPath(t.name)),
      })
    }

    // ---- quick actions ----
    out.push({ id: 'act:new', label: 'New AI session', group: 'Actions', icon: 'newSession', keys: 'start claude launch', run: () => navigate(`${BASE}/ai/sessions?new=1`, { replace: onTab }) })
    // the shell's round lights button does the switching (and its Undo); no button, no row
    if (document.querySelector('.vl-lamp')) {
      const lit = document.querySelector('.vl-lamp[data-lit]') !== null
      out.push({
        id: 'act:lights',
        label: lit ? 'All lights off' : 'All lights on',
        group: 'Actions',
        icon: lit ? 'bulbOff' : 'bulb',
        keys: 'lamp bulbs toggle switch',
        run: () => { if (!requestIntent('lights:toggle')) toast('Lights: not ready yet') },
      })
    }
    if (player.item) {
      out.push({ id: 'act:play', label: player.playing ? 'Pause music' : 'Play music', group: 'Actions', icon: 'play', hint: player.item.title, keys: 'player resume', run: playerActions.toggle })
      out.push({ id: 'act:next', label: 'Next track', group: 'Actions', icon: 'tracks', keys: 'skip music player', run: playerActions.next })
      out.push({ id: 'act:stop', label: 'Stop music', group: 'Actions', icon: 'stop', keys: 'close player', run: playerActions.stop })
    }
    const z = getZoom()
    out.push({ id: 'act:zoom-in', label: 'Zoom in', group: 'Actions', icon: 'add', hint: `${pct(z)}, Ctrl +`, keys: 'bigger larger scale', run: () => applyZoom(z + ZOOM_STEP) })
    out.push({ id: 'act:zoom-out', label: 'Zoom out', group: 'Actions', icon: 'down', hint: `${pct(z)}, Ctrl -`, keys: 'smaller scale', run: () => applyZoom(z - ZOOM_STEP) })
    if (z !== 1) out.push({ id: 'act:zoom-reset', label: 'Reset zoom to 100%', group: 'Actions', icon: 'refresh', hint: 'Ctrl 0', keys: 'scale', run: () => applyZoom(1) })
    const reduced = getMotionSetting() === 'reduced'
    out.push({ id: 'act:motion', label: reduced ? 'Full motion' : 'Reduce motion', group: 'Actions', icon: 'swipe', keys: 'animation', run: () => setMotionSetting(reduced ? 'full' : 'reduced') })
    out.push({ id: 'act:reload', label: 'Reload', group: 'Actions', icon: 'refresh', keys: 'update new build refresh', run: () => window.location.reload() })
    out.push({
      id: 'act:signout',
      label: 'Sign out',
      group: 'Actions',
      icon: 'back',
      keys: 'log out logout',
      run: () => { setAuthSkipped(false); clearToken() },
    })

    // ---- the classic UI ----
    const classicHome = resolveProfile().classicHome
    out.push({ id: 'classic:home', label: 'Classic UI', group: 'Classic', icon: 'home', keys: 'old previous', run: () => navigate(`${classicHome}?classic=1`) })
    for (const p of CLASSIC_PAGES) {
      out.push({ id: `classic:${p.to}`, label: p.label, group: 'Classic', icon: p.icon, hint: 'classic', keys: p.keys, run: () => navigate(p.to) })
    }
    return out
  }, [screens, index.byId, terms.data, player.item, player.playing, location.pathname, navigate])

  const shown = useMemo(() => filter(cmds, query), [cmds, query])
  const grouped = query.trim() === ''
  // in group order with the header rows, the way the list draws them
  const rows = useMemo(() => (grouped ? GROUPS.flatMap((g) => shown.filter((c) => c.group === g)) : shown), [grouped, shown])
  const at = Math.min(active, Math.max(0, rows.length - 1))

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at, rows])

  const run = (c: Cmd | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // nothing typed here reaches the shell's arrow paging, Escape or a sheet's keys
    e.stopPropagation()
    const n = rows.length
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive((at + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((at - 1 + n) % n) }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(Math.min(n - 1, at + 8)) }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(Math.max(0, at - 8)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows[at]) }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); onClose() }
  }

  let k = -1
  const row = (c: Cmd) => {
    k += 1
    const i = k
    const on = i === at
    return (
      <div
        key={c.id}
        id={`vl-pal-${i}`}
        data-row={i}
        role="option"
        aria-selected={on}
        className="vl-pal-row"
        data-on={on || undefined}
        onPointerMove={() => { if (!on) setActive(i) }}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => run(c)}
      >
        <Icon name={c.icon} size={15} tone={on ? 'fg' : 'dim'} glow={on} />
        <span className="vl-pal-label vl-ellipsis">{c.label}</span>
        {(c.hint || !grouped) && <span className="vl-pal-hint vl-ellipsis">{c.hint ?? c.group}</span>}
        {on && <Icon name="enter" size={13} tone="fg" className="vl-pal-enter" />}
      </div>
    )
  }

  return (
    <div className="vl-pal" onPointerDown={onClose}>
      <div
        className="vl-pal-box"
        role="dialog"
        aria-modal="true"
        aria-label="Search Valkyrie"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="vl-pal-field">
          <Icon name="search" size={15} tone="dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            placeholder="Jump to a tab, a session or an action"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="vl-pal-list"
            aria-activedescendant={rows.length ? `vl-pal-${at}` : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            enterKeyHint="go"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="vl-pal-list" id="vl-pal-list" role="listbox" aria-label="Results" ref={listRef}>
          {!rows.length && <div className="vl-pal-empty">No match</div>}
          {grouped
            ? GROUPS.map((g) => {
              const list = shown.filter((c) => c.group === g)
              // Sessions keeps its header with a line saying why it is empty
              const note = g !== 'Sessions' || list.length ? null
                : terms.isError ? 'The terminal list did not load'
                  : terms.data ? 'No session is open in a terminal' : 'Reading the open terminals'
              if (!list.length && !note) return null
              return (
                <div key={g} role="group" aria-label={g} className="vl-pal-group">
                  <div className="vl-pal-head">{g}</div>
                  {list.map(row)}
                  {note && <div className="vl-pal-note">{note}</div>}
                </div>
              )
            })
            : rows.map(row)}
        </div>
      </div>
    </div>
  )
}
