import {
  createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ComponentType, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { applyPalette, saveMode, storedMode, useFont, useStoredMode, type Mode } from './theme'
import {
  animateSpring, getMotionSetting, isReducedMotion, setMotionSetting, useMotionSetting, useSwipePager, type MotionSetting,
} from './motion'
import { useHosts, useLights, useTick, type HostVM, type MediaVM } from './data'
import { Search } from 'lucide-react'
import { DotFloor, Glyph, Press, ToastHost, cx, dismissToast, openPalette, paletteOpen, toast, type DotFloorHandle, type ToastOptions } from './ui'
import { Icon, hostIcon, isIconName, type IconName } from './icons'
import { musicImg, type MusicTrack } from '../../lib/api'
import { isTauri, isTauriMobile } from '../../lib/auth'
import { useLightsControl } from '../../lib/lights'
import * as libPlayer from '../../lib/player'
import { WindowControls } from '../../components/TauriTitleBar'
import { UpdateAlarm } from '../../components/UpdateAlarm'

// The Valkyrie shell. The header: a tiny status strip (host icons, the AI 5h
// window, clock, the Settings gear), the primary text tabs under it, a
// hairline with a caret notch under the active tab, and the active tab's
// sub-tabs below that. Then a quiet scroll rail on the left with the active
// screen's icon and every primary screen mounted side by side in a
// finger-following pager. The round lights button floats in the bottom-left
// corner on every tab; while music plays it sits at the left end of a slim
// player bar. Settings is a full screen at /m/settings over the pager.
// URLs are /m/<screen>/<sub> (BASE below).

/** Where the shell lives in the app's routes (src/App.tsx mounts it at /m/*). */
export const BASE = '/m'

/** The Settings screen's URL segment (/m/settings): not a tab, it opens from the strip's gear. */
export const SETTINGS_ID = 'settings'

/**
 * Maps an old URL (screen and sub-tab that no longer exist) to its new place,
 * relative to BASE, e.g. ('claude', 'projects') -> 'ai/projects'. null = unknown.
 */
export type LegacyMap = (screen: string, sub?: string) => string | null

export type ScreenProps = { active: boolean; sub: string; setSub: (s: string) => void }

export type ScreenDef = {
  id: string
  label: string
  subs?: { id: string; label: string }[]
  Component: ComponentType<ScreenProps>
  /** the rail's icon for this screen; defaults to the ICONS entry named like the id */
  icon?: IconName
  /**
   * the shell's 2D dot floor behind this screen: true (default), 'faint' for
   * list screens (dimmed so rows never sit on bright dots), false when the
   * screen draws its own 3D floor. A function picks it per sub-tab.
   */
  floor?: FloorSetting | ((sub: string) => FloorSetting)
}

export type FloorSetting = boolean | 'faint'

/** The floor a screen asks for on a sub-tab (resolves the per-sub function). */
export function floorFor(def: ScreenDef, sub: string): FloorSetting {
  const f = def.floor
  return typeof f === 'function' ? f(sub) : f ?? true
}

export type ShellApi = {
  active: string
  go: (id: string, sub?: string, via?: 'tap' | 'swipe') => void
  sub: string
  /** a toast under the header; `opts.action` adds a button (Undo), `opts.ms` sets how long it shows */
  toast: (msg: string, opts?: ToastOptions) => void
  /** open the Settings screen (/m/settings) */
  openSettings: () => void
  /** the user's stored pick (Settings > Appearance) */
  mode: Mode
  setMode: (m: Mode) => void
  motion: MotionSetting
  setMotion: (m: MotionSetting) => void
  /** camera pose name the active screen asked for (defaults to the screen id) */
  pose: string
  setPose: (p: string) => void
  /** optional center text in the status strip ("2 live · 1 asking"); call only while active. Hidden on the phone. */
  setCenter: (text: string | null) => void
  /** the active page's vertical scroller */
  scroller: () => HTMLElement | null
}

const ShellCtx = createContext<ShellApi | null>(null)

const outside: ShellApi = {
  active: '',
  go: () => {},
  sub: '',
  toast,
  openSettings: () => {},
  get mode() { return storedMode() },
  setMode: (m) => { saveMode(m); applyPalette(m) },
  get motion() { return getMotionSetting() },
  setMotion: setMotionSetting,
  pose: '',
  setPose: () => {},
  setCenter: () => {},
  scroller: () => null,
}

export function useShell(): ShellApi {
  return useContext(ShellCtx) ?? outside
}

// ---------- first paint (Settings > Speed shows it) ----------

let firstPaintAt: number | null = null
/** ms from navigation start to the first painted shell frame (cached data included). */
export function firstPaint(): number | null {
  return firstPaintAt
}

// ---------- music player (lib/player: the app's one <audio>, shared with the classic PlayerBar) ----------
//
// Media starts queues through playerActions; the shell's player bar reads this
// store. lib/player only hands out a hook, so <PlayerSync /> (mounted once by
// the shell) copies its state in here. `playerNow` changes only when something
// other than the position does, so the bar and Media re-render on a new track
// or play/pause, not on every timeupdate.

export type PlayerItem = MediaVM
export type PlayerState = {
  /** the loaded track as the player bar shows it; null when nothing is queued */
  item: PlayerItem | null
  /** the queue as the player bar shows it, in the same order as tracks */
  queue: PlayerItem[]
  /** lib/player's own queue array (a new array means a new queue) */
  tracks: MusicTrack[]
  /** index of item in the queue, -1 when nothing is queued */
  index: number
  playing: boolean
  /** seconds into the track */
  position: number
  /** seconds, 0 while unknown */
  duration: number
  /** why the current track is not playing ("tap play to start"), else null */
  error: string | null
}
/** Everything but the position. */
export type PlayerNow = Omit<PlayerState, 'position'>

const EMPTY_PLAYER: PlayerState = { item: null, queue: [], tracks: [], index: -1, playing: false, position: 0, duration: 0, error: null }
let player: PlayerState = EMPTY_PLAYER
let playerNow: PlayerNow = EMPTY_PLAYER
const playerListeners = new Set<() => void>()
const subscribePlayer = (l: () => void) => {
  playerListeners.add(l)
  return () => { playerListeners.delete(l) }
}

const toPlayerItem = (t: MusicTrack): PlayerItem => ({
  key: `t${t.ratingKey}`,
  title: t.title,
  subtitle: [t.trackArtist ?? t.artist, t.album].filter(Boolean).join(' · '),
  img: t.thumb ? musicImg(t.thumb, 300) : null,
})

let mirrored: { tracks: MusicTrack[]; queue: PlayerItem[] } = { tracks: [], queue: [] }
function mirrorPlayer(s: libPlayer.PlayerState) {
  if (s.queue !== mirrored.tracks) mirrored = { tracks: s.queue, queue: s.queue.map(toPlayerItem) }
  const item = mirrored.queue[s.index] ?? null
  const now: PlayerNow = {
    item, queue: mirrored.queue, tracks: s.queue, index: item ? s.index : -1, playing: s.playing, duration: s.duration, error: s.error,
  }
  const same = (Object.keys(now) as (keyof PlayerNow)[]).every((k) => now[k] === playerNow[k])
  if (!same) playerNow = now
  if (same && s.position === player.position) return
  player = { ...playerNow, position: s.position }
  playerListeners.forEach((l) => l())
}

/** Copies lib/player into this store. Mounted once by V2Shell; renders nothing. */
function PlayerSync(): null {
  const s = libPlayer.usePlayer()
  useLayoutEffect(() => mirrorPlayer(s), [s])
  return null
}

export const playerActions = {
  /** start `tracks` at `index`; lib/player skips a track with no file or a format the browser cannot play */
  playQueue: libPlayer.playQueue,
  playAt: libPlayer.playAt,
  toggle: libPlayer.toggle,
  next: libPlayer.next,
  /** early in a track: the previous track; later: back to the start of this one */
  prev: libPlayer.prev,
  /** seconds */
  seek: libPlayer.seek,
  stop: libPlayer.stop,
}

/** 0..1 through the current track */
export function playerProgress(s: PlayerState): number {
  return s.duration > 0 ? Math.min(1, Math.max(0, s.position / s.duration)) : 0
}

/** The whole player, position included: re-renders about four times a second while playing. */
export function usePlayer(): PlayerState & typeof playerActions {
  const s = useSyncExternalStore(subscribePlayer, () => player, () => player)
  return { ...s, ...playerActions }
}

/** The player without the position: re-renders on a new track, play/pause or an error. */
export function usePlayerNow(): PlayerNow {
  return useSyncExternalStore(subscribePlayer, () => playerNow, () => playerNow)
}

// ---------- intents: the shell asks a screen to do something ----------

const INTENT = 'v2-intent'

/**
 * Ask the screens for an action by name (e.g. 'claude:new-session'). Returns
 * true when a screen took it (its useIntent handler ran).
 */
export function requestIntent(name: string): boolean {
  const ev = new CustomEvent(INTENT, { detail: name, cancelable: true })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}

/**
 * Take an intent while `on`: e.g. 'claude:new-session' (AI > Sessions opens
 * its target picker).
 */
export function useIntent(name: string, handler: () => void, on = true): void {
  const cb = useRef(handler)
  cb.current = handler
  useEffect(() => {
    if (!on) return
    const f = (e: Event) => {
      if (!(e instanceof CustomEvent) || e.detail !== name) return
      e.preventDefault()
      cb.current()
    }
    window.addEventListener(INTENT, f)
    return () => window.removeEventListener(INTENT, f)
  }, [name, on])
}

// ---------- status strip ----------

// Sort order only (thor first); labels and the host list come from /api/hosts.
const HOST_ORDER = ['thor', 'odin', 'frame', 'mimir']
const hostRank = (id: string) => {
  const i = HOST_ORDER.indexOf(id)
  // the phone and tablet after the machines, the cars last
  return i >= 0 ? i : id.startsWith('car-') ? HOST_ORDER.length + 1 : HOST_ORDER.length
}
/** a sleeping car is there, not offline: it reads asleep, unlit */
const hostState = (h: HostVM): 'on' | 'off' | 'stale' | 'sleep' => (h.stale ? 'stale' : !h.online ? 'off' : h.vehicle?.state === 'asleep' ? 'sleep' : 'on')
const STATE_WORD = { on: 'online', off: 'offline', stale: 'stale', sleep: 'asleep' } as const
const titleCase = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

/** The frameless desktop app's window (Tauri on Windows, Linux, macOS); the Android app has none. */
export const desktopWindow = (): boolean => isTauri() && !isTauriMobile()

/**
 * The status strip, on every v2 screen (the shell, AI > a session, the terminal
 * preview). In the desktop app it is also the frameless window's title bar:
 * a press on any empty part drags the window and a double-click maximizes
 * (Tauri's drag script, `data-tauri-drag-region="deep"`: buttons in it stay
 * buttons), and the minimize, maximize and close buttons sit at its right end.
 * In an installed PWA with the window controls overlay, v2.css keeps it clear
 * of the OS buttons and makes it the drag area. The app's update prompt
 * (UpdateAlarm: the desktop updater, a waiting service worker, a new deploy)
 * shows here too, so v2 never hides an update.
 */
export function StatusStrip({ center, onSettings, settingsOpen = false }: {
  center?: string | null
  /** shows the gear at the right end; a press opens (or, while open, closes) Settings */
  onSettings?: () => void
  settingsOpen?: boolean
}) {
  const hosts = useHosts()
  const now = useTick(5000)
  const list = [...(hosts.data ?? [])].sort((a, b) => hostRank(a.id) - hostRank(b.id) || a.label.localeCompare(b.label))
  const d = new Date(now)
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' })
  const date = `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const win = desktopWindow()
  return (
    <div className="vl-strip" data-center={center ? '' : undefined} data-win={win || undefined} data-tauri-drag-region={win ? 'deep' : undefined}>
      <div className="vl-strip-left">
        {/* Valkyrie's wordmark (src/App.tsx header): accent with its glow, the slashes dim, a blinking cursor */}
        <span className="vl-strip-name" role="img" aria-label="Valkyrie">
          <span aria-hidden>VALKYRIE<span className="vl-strip-slash">//</span>SYS<span className="vl-cursor">_</span></span>
        </span>
        {list.length > 0 && (
          <span className="vl-strip-hosts" role="list" aria-label="Hosts">
            {list.map((h) => {
              const st = hostState(h)
              return (
                <span key={h.id} className="vl-host" role="listitem" data-state={st} title={`${titleCase(h.label)}: ${STATE_WORD[st]}`}>
                  <Icon name={hostIcon(h.id)} size={11} tone="fg" glow={st === 'on'} />
                  <b>{h.label}</b>
                  <span className="sr-only">{STATE_WORD[st]}</span>
                </span>
              )
            })}
          </span>
        )}
      </div>
      {center && <div className="vl-strip-center" key={center.split(' ')[0]}>{center}</div>}
      <div className="vl-strip-right">
        <span className="vl-strip-upd"><UpdateAlarm /></span>
        <span className="vl-strip-date"><span className="vl-strip-wd">{weekday} </span>{date}</span>
        <b>·</b>
        <span className="vl-strip-time">{time}</span>
        {onSettings && (
          <Press className="vl-strip-search" aria-label="Search" title="Search: jump anywhere (Ctrl+K)" aria-haspopup="dialog" onPress={openPalette}>
            <Search size={13} strokeWidth={1.7} className="vl-icon vl-icon-dim" aria-hidden />
          </Press>
        )}
        {onSettings && (
          <Press
            className="vl-strip-gear"
            data-on={settingsOpen || undefined}
            aria-label={settingsOpen ? 'Close settings' : 'Settings'}
            aria-expanded={settingsOpen}
            title="Settings"
            onPress={onSettings}
          >
            <Icon name="settings" size={14} tone={settingsOpen ? 'fg' : 'dim'} glow={settingsOpen} />
          </Press>
        )}
      </div>
      {/* src/components/TauriTitleBar: absolute at the strip's right end; the strip reserves its width (v2.css) */}
      {win && <div className="vl-winctl"><WindowControls /></div>}
    </div>
  )
}

// ---------- left rail: a quiet scroll indicator ----------

function Rail({ getScroller, activeKey, icon, label }: {
  getScroller: () => HTMLElement | null
  activeKey: string
  /** the active screen's icon (the reference's lit car icon in the rail) */
  icon: IconName
  label: string
}) {
  const railRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const upRef = useRef<HTMLButtonElement>(null)
  const downRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = getScroller()
    const rail = railRef.current
    const track = trackRef.current
    const thumb = thumbRef.current
    if (!el || !rail || !track || !thumb) return
    let size = -1
    let moving = 0
    const update = () => {
      const max = el.scrollHeight - el.clientHeight
      const can = max > 2
      rail.toggleAttribute('data-scroll', can)
      upRef.current?.toggleAttribute('data-off', !can || el.scrollTop <= 1)
      downRef.current?.toggleAttribute('data-off', !can || el.scrollTop >= max - 1)
      if (!can) return
      const th = track.clientHeight
      const s = Math.round(Math.max(14, Math.min(th, (th * el.clientHeight) / el.scrollHeight)))
      if (s !== size) {
        size = s
        thumb.style.height = `${s}px`
      }
      const f = Math.min(1, Math.max(0, el.scrollTop / max))
      thumb.style.transform = `translate3d(0, ${(f * (th - s)).toFixed(1)}px, 0)`
    }
    const onScroll = () => {
      update()
      rail.setAttribute('data-moving', '')
      window.clearTimeout(moving)
      moving = window.setTimeout(() => rail.removeAttribute('data-moving'), 700)
    }
    update()
    // a page that opens and can scroll shows its thumb for a moment (the phone hides it at rest)
    if (rail.hasAttribute('data-scroll')) {
      rail.setAttribute('data-moving', '')
      moving = window.setTimeout(() => rail.removeAttribute('data-moving'), 1100)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    ro.observe(track)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      window.clearTimeout(moving)
      rail.removeAttribute('data-moving')
    }
  }, [activeKey, getScroller])

  const scrollStep = (dir: number) => {
    const el = getScroller()
    el?.scrollBy({ top: dir * el.clientHeight * 0.7, behavior: isReducedMotion() ? 'auto' : 'smooth' })
  }

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = getScroller()
    const track = trackRef.current
    if (!el || !track) return
    const r = track.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    el.scrollTop = f * (el.scrollHeight - el.clientHeight)
  }

  return (
    <aside className="vl-rail" ref={railRef} data-no-swipe aria-hidden>
      <Press ref={upRef} className="vl-rail-btn" tabIndex={-1} aria-label="Scroll up" onPress={() => scrollStep(-1)}><Glyph name="up" size={9} /></Press>
      {/* the active screen's icon, lit; a tap goes back to the top of the page */}
      <Press
        className="vl-rail-icon"
        tabIndex={-1}
        aria-label={`${label}: back to top`}
        title={label}
        onPress={() => getScroller()?.scrollTo({ top: 0, behavior: isReducedMotion() ? 'auto' : 'smooth' })}
      >
        <Icon key={icon} name={icon} size={17} tone="fg" glow />
      </Press>
      <div
        ref={trackRef}
        className="vl-rail-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub(e)
        }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e) }}
      >
        <div ref={thumbRef} className="vl-rail-thumb" />
      </div>
      <Press ref={downRef} className="vl-rail-btn" tabIndex={-1} aria-label="Scroll down" onPress={() => scrollStep(1)}><Glyph name="down" size={9} /></Press>
    </aside>
  )
}

// ---------- player bar: only while something plays ----------

function MiniProgress() {
  const p = usePlayer()
  return <div className="vl-mini-prog" aria-hidden><i style={{ transform: `scaleX(${playerProgress(p).toFixed(4)})` }} /></div>
}

const subscribeItem = subscribePlayer
const getItem = () => player.item

/** The player's item, held for the exit slide after it is cleared. */
function useMiniPresence(): { item: PlayerItem; leaving: boolean } | null {
  const item = useSyncExternalStore(subscribeItem, getItem, getItem)
  const [held, setHeld] = useState<PlayerItem | null>(item)
  useEffect(() => {
    if (item) {
      setHeld(item)
      return
    }
    const t = window.setTimeout(() => setHeld(null), isReducedMotion() ? 0 : 260)
    return () => window.clearTimeout(t)
  }, [item])
  if (item) return { item, leaving: false }
  return held ? { item: held, leaving: true } : null
}

function MiniPlayer({ item, leaving }: { item: PlayerItem; leaving: boolean }) {
  const p = usePlayerNow()
  const playing = !leaving && p.playing
  return (
    <div className="vl-mini" data-leaving={leaving || undefined} inert={leaving || undefined}>
      {item.img ? <img src={item.img} alt="" draggable={false} /> : <span className="vl-mini-art" aria-hidden />}
      <div className="vl-mini-text" key={item.key}>
        <b>{item.title}</b>
        {item.subtitle && <span>{item.subtitle}</span>}
      </div>
      <Press className="vl-mini-btn" data-on={playing || undefined} aria-label={playing ? 'Pause' : 'Play'} onPress={playerActions.toggle}>
        <Glyph name={playing ? 'pause' : 'play'} size={13} />
      </Press>
      <Press className="vl-mini-btn vl-mini-close" aria-label="Close player" onPress={playerActions.stop}>
        <Glyph name="close" size={11} />
      </Press>
    </div>
  )
}

// ---------- the lights button: bottom-left on every tab ----------

/** Why a write failed, short enough for a toast: the backend's own word, else its status. */
function why(e: unknown): string {
  const x = (e ?? {}) as { response?: { status?: number; data?: { error?: unknown } }; detail?: unknown; message?: unknown }
  const msg = [x.response?.data?.error, x.detail, x.message].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const status = x.response?.status
  const text = msg ? (msg.length > 72 ? `${msg.slice(0, 71)}…` : msg) : 'no answer'
  return status ? `${status} ${text}` : text
}

/**
 * All lights on/off: a round button, lit with the glow while any reachable
 * bulb is on. Writes through src/lib/lights.ts useLightsControl, the same
 * desire overlay Dashboard and Lights read, so a switch here shows there at
 * once and a failed one falls back. The toast's Undo puts back what was on.
 */
function LightsButton() {
  // the persisted view model paints the first frame; the switch needs the control's own read
  const cached = useLights()
  const ctl = useLightsControl()
  const real = ctl.lights.data ? ctl.all : null
  const list = real ? real.map((l) => ({ id: l.entity_id, on: l.on, unavailable: l.unavailable })) : cached.data ?? []
  const bulbs = list.filter((l) => !l.unavailable)
  const lit = bulbs.filter((l) => l.on).length
  const anyOn = lit > 0
  // one switch at a time; the toast's Undo waits for the switch it undoes
  const inflight = useRef<Promise<boolean> | null>(null)
  const send = (entity_id: string[], state: 'on' | 'off', msg: string, undo?: () => void) => {
    if (inflight.current || !entity_id.length) return
    const shown = toast(msg, undo ? { action: { label: 'Undo', run: undo } } : undefined)
    const run = ctl.mutation.mutateAsync({ entity_id, state })
      .then(() => true, (e: unknown) => {
        dismissToast(shown)
        toast(`Lights not switched: ${why(e)}`)
        return false
      })
      .finally(() => { inflight.current = null })
    inflight.current = run
  }
  const press = () => {
    if (!real) { toast(ctl.lights.isError ? 'Lights: Home Assistant is not answering' : 'Lights: still reading Home Assistant'); return }
    if (!bulbs.length) { toast('Lights: no bulb is reachable'); return }
    const all = bulbs.map((b) => b.id)
    const wasOn = bulbs.filter((b) => b.on).map((b) => b.id)
    const next = anyOn ? 'off' : 'on'
    // Undo of "all on" switches them all off; of "all off", only the bulbs that were on come back
    send(all, next, `All lights ${next}`, async () => {
      if ((await inflight.current) === false) return
      if (next === 'on') send(all, 'off', 'All lights off')
      else send(wasOn, 'on', `${wasOn.length} ${wasOn.length === 1 ? 'light' : 'lights'} back on`)
    })
  }
  const label = anyOn ? `Lights: ${lit} of ${bulbs.length} on, turn all off` : 'Lights: all off, turn all on'
  // the palette's "All lights on/off" is this button
  useIntent('lights:toggle', press)
  return (
    <Press className="vl-lamp" data-lit={anyOn || undefined} aria-pressed={anyOn} aria-label={label} title={label} onPress={press}>
      <Icon name={anyOn ? 'bulb' : 'bulbOff'} size={20} tone={anyOn ? 'fg' : 'dim'} glow={anyOn} />
    </Press>
  )
}

/**
 * The bottom layer: the round lights button in the corner, and while music
 * plays a slim player bar with the button at its left end. Pages reserve
 * room for it (v2.css --foot-pad), so it never covers the last row.
 */
function Foot() {
  const mini = useMiniPresence()
  return (
    <div className="vl-foot" data-bar={mini ? '' : undefined} data-leaving={mini?.leaving || undefined}>
      {mini && <div className="vl-foot-bg" aria-hidden><MiniProgress /></div>}
      <LightsButton />
      {mini && <MiniPlayer item={mini.item} leaving={mini.leaving} />}
    </div>
  )
}

// ---------- header tabs: primary tabs, the hairline with the caret, the active tab's sub-tabs ----------

/** The caret notch: a black gap in the hairline with an accent caret pointing up at the active tab. */
function NotchSvg() {
  return (
    <svg width="14" height="7" viewBox="0 0 14 7">
      <rect x="1.2" y="5.4" width="11.6" height="2" fill="#000" />
      <path d="M0.6 6.5 7 1.2 13.4 6.5" fill="#000" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="miter" />
    </svg>
  )
}

function Nav({ screens, activeId, sub, go }: {
  screens: ScreenDef[]
  activeId: string
  sub: string
  go: ShellApi['go']
}) {
  const def = screens.find((s) => s.id === activeId) ?? screens[0]
  const subs = def.subs ?? []
  const navRef = useRef<HTMLElement>(null)
  const primsRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const notchRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const primEls = useRef<Record<string, HTMLButtonElement | null>>({})
  const [ready, setReady] = useState(false)
  const subsKey = subs.map((s) => s.id).join(',')

  const layout = useCallback(() => {
    const nav = navRef.current
    const prims = primsRef.current
    const line = lineRef.current
    const notch = notchRef.current
    const box = boxRef.current
    const group = groupRef.current
    if (!nav || !prims || !line || !notch || !box || !group) return
    // Everything here is in the nav's own CSS px. Under the UI zoom (lib/zoom:
    // CSS zoom on <html>) a client rect is in zoomed px while offsetWidth,
    // scrollWidth and the transforms written below are not, so rects are
    // divided by the zoom. Mixing the two put the caret and the sub-tabs about
    // 100 px right of the active tab at his zoom of 1.2.
    const nr = nav.getBoundingClientRect()
    const k = nav.offsetWidth > 0 && nr.width > 0 ? nr.width / nav.offsetWidth : 1
    const left = (r: DOMRect) => (r.left - nr.left) / k
    const lr = line.getBoundingClientRect()
    const br = box.getBoundingClientRect()
    const prim = primEls.current[activeId]
    const primCenter = prim ? left(prim.getBoundingClientRect()) + prim.offsetWidth / 2 : nav.offsetWidth / 2
    // the caret sits on the hairline under the active tab
    const lineLeft = left(lr)
    const nx = Math.max(lineLeft + 8, Math.min(lineLeft + line.offsetWidth - 8, primCenter))
    notch.style.transform = `translate3d(${nx.toFixed(1)}px, ${((lr.top - nr.top) / k - 6).toFixed(1)}px, 0)`
    // the sub-tabs sit centered under their tab, clamped inside their row; a row too wide scrolls
    const gw = group.scrollWidth
    const bw = box.clientWidth
    const scroll = gw > bw + 1
    const gx = scroll ? 0 : Math.max(0, Math.min(bw - gw, primCenter - left(br) - gw / 2))
    group.style.transform = `translate3d(${gx.toFixed(1)}px, 0, 0)`
    box.toggleAttribute('data-scroll', scroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, subsKey])

  useLayoutEffect(() => {
    layout()
  }, [layout])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const ro = new ResizeObserver(() => layout())
    ro.observe(nav)
    if (primsRef.current) ro.observe(primsRef.current)
    if (boxRef.current) ro.observe(boxRef.current)
    // the tabs themselves: a font switch (Settings > Font) or a late webfont changes their widths, not the row's
    if (groupRef.current) ro.observe(groupRef.current)
    for (const el of Object.values(primEls.current)) if (el) ro.observe(el)
    document.fonts?.ready.then(() => layout())
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)))
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [layout])

  return (
    <nav className="vl-nav" ref={navRef} data-ready={ready || undefined} data-no-swipe aria-label="Sections" data-tauri-drag-region={desktopWindow() ? 'deep' : undefined}>
      <div className="vl-nav-prims" ref={primsRef}>
        {screens.map((s) => (
          <Press
            key={s.id}
            ref={(el) => { primEls.current[s.id] = el }}
            className="vl-tab vl-tab-prim"
            data-on={s.id === activeId || undefined}
            aria-current={s.id === activeId ? 'page' : undefined}
            onPress={() => go(s.id)}
          >
            {s.label}
          </Press>
        ))}
      </div>
      <div className="vl-nav-line" ref={lineRef} />
      <div className="vl-notch" ref={notchRef} aria-hidden>
        <NotchSvg key={activeId} />
      </div>
      <div className="vl-nav-subs" ref={boxRef} data-on={subs.length ? '' : undefined} role={subs.length ? 'group' : undefined} aria-label={subs.length ? `${def.label} sections` : undefined}>
        <div className="vl-subs-group" ref={groupRef}>
          {subs.map((s) => (
            <Press
              key={s.id}
              className="vl-tab vl-tab-sub"
              data-on={s.id === sub || undefined}
              aria-current={s.id === sub ? 'page' : undefined}
              onPress={() => go(activeId, s.id)}
            >
              {s.label}
            </Press>
          ))}
        </div>
      </div>
    </nav>
  )
}

/** Settings' header row in place of the tabs: back to the tab it came from, the title lit with the caret under it. */
function SettingsBar({ back, onBack }: { back: string; onBack: () => void }) {
  return (
    <div className="vl-setbar" data-no-swipe data-tauri-drag-region={desktopWindow() ? 'deep' : undefined}>
      <Press className="vl-setbar-back" aria-label={`Back to ${back}`} onPress={onBack}>
        <Glyph name="left" size={11} />
        <span>{back}</span>
      </Press>
      <h1 className="vl-setbar-title">
        <Icon name="settings" size={14} tone="fg" glow />
        <span>Settings</span>
      </h1>
      <div className="vl-nav-line" />
      <div className="vl-notch vl-setbar-notch" aria-hidden><NotchSvg /></div>
    </div>
  )
}

// ---------- pages ----------

const Page = memo(function Page({ def, active, sub, go, index, register }: {
  def: ScreenDef
  active: boolean
  sub: string
  go: ShellApi['go']
  index: number
  register: (i: number, el: HTMLDivElement | null) => void
}) {
  const setSub = useCallback((s: string) => go(def.id, s), [def.id, go])
  const C = def.Component
  return (
    <div
      className="vl-page"
      data-screen={def.id}
      data-active={active || undefined}
      ref={(el) => register(index, el)}
      inert={!active}
      aria-hidden={!active}
    >
      <C active={active} sub={sub} setSub={setSub} />
    </div>
  )
})

// ---------- the shell ----------

/** /m/<screen>/<sub> for a tab, the sub-tab always spelled out when the tab has sub-tabs. */
function tabPath(def: ScreenDef, sub: string): string {
  const subs = def.subs ?? []
  const s = subs.some((x) => x.id === sub) ? sub : subs[0]?.id
  return `${BASE}/${def.id}${s ? `/${s}` : ''}`
}

export function V2Shell({ screens, initial, backdrop, settings: SettingsScreen, legacy }: {
  screens: ScreenDef[]
  initial?: string
  /** extra layer behind the pager (e.g. a shared WireScene); the CSS dot floor is always under it */
  backdrop?: ReactNode
  /** the Settings screen, opened by the strip's gear at /m/settings; no gear without it */
  settings?: ComponentType<{ active: boolean }>
  /** old URLs to their new place (old /m/home, /m/claude links and bookmarks) */
  legacy?: LegacyMap
}): JSX.Element {
  const params = useParams<{ screen?: string; sub?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const ids = screens.map((s) => s.id)
  const idsKey = ids.join(',')
  const fallbackId = initial && ids.includes(initial) ? initial : ids[0]

  // an old URL is shown at its new place at once; the effect below rewrites the address
  let urlScreen = params.screen
  let urlSub = params.sub
  if (urlScreen && urlScreen !== SETTINGS_ID && !ids.includes(urlScreen)) {
    const to = legacy?.(urlScreen, urlSub)
    const [ls, lsub] = to ? to.split('/') : []
    urlScreen = ls && (ls === SETTINGS_ID || ids.includes(ls)) ? ls : undefined
    urlSub = lsub || undefined
  }
  const settingsOpen = !!SettingsScreen && urlScreen === SETTINGS_ID
  // under Settings the pager keeps the tab it came from
  const lastTab = useRef<string | null>(null)
  const urlTab = urlScreen && ids.includes(urlScreen) ? urlScreen : null
  const activeId = urlTab ?? (settingsOpen && lastTab.current && ids.includes(lastTab.current) ? lastTab.current : fallbackId)
  const index = Math.max(0, ids.indexOf(activeId))
  const def = screens[index]
  const subs = def.subs ?? []
  const lastSub = useRef<Record<string, string>>({})
  const wantSub = urlTab ? urlSub : lastSub.current[activeId]
  const sub = subs.length ? (wantSub && subs.some((s) => s.id === wantSub) ? wantSub : subs[0].id) : ''
  const floorSetting = floorFor(def, sub)

  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const screensRef = useRef(screens)
  screensRef.current = screens
  const legacyRef = useRef(legacy)
  legacyRef.current = legacy
  const settingsRef = useRef(settingsOpen)
  settingsRef.current = settingsOpen

  useEffect(() => {
    if (!settingsOpen) lastTab.current = activeId
  }, [settingsOpen, activeId])

  // the address bar follows: an old or unknown screen, or a sub-tab the screen does not have, is rewritten in place
  useEffect(() => {
    if (!params.screen) return
    let to: string | null = null
    if (settingsOpen) to = params.screen === SETTINGS_ID && !params.sub ? null : `${BASE}/${SETTINGS_ID}`
    else if (params.screen !== activeId) to = tabPath(def, sub)
    else if (params.sub !== undefined && params.sub !== sub) to = tabPath(def, sub)
    if (to) navigate(`${to}${location.search}`, { replace: true, state: location.state })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.screen, params.sub, idsKey, settingsOpen])

  useEffect(() => {
    lastSub.current[activeId] = sub
  }, [activeId, sub])

  // ---- navigation ----
  const navVia = useRef<'tap' | 'swipe' | 'url'>('url')
  const go = useCallback<ShellApi['go']>((id, s, via = 'tap') => {
    let d = screensRef.current.find((x) => x.id === id)
    let target = s
    if (!d) {
      // an old screen id (a screen still saying go('claude')) goes to its new place
      const to = legacyRef.current?.(id, s)
      const [ls, lsub] = to ? to.split('/') : []
      d = screensRef.current.find((x) => x.id === ls)
      if (!d) return
      target = lsub || undefined
    }
    const dsubs = d.subs ?? []
    const pick = target ?? lastSub.current[d.id] ?? dsubs[0]?.id ?? ''
    navVia.current = via
    navigate(tabPath(d, pick), { replace: true })
  }, [navigate])

  // ---- settings: pushed onto the history, so the phone's back gesture closes it too ----
  const openSettings = useCallback(() => {
    if (settingsRef.current) return
    navigate(`${BASE}/${SETTINGS_ID}`, { state: { v2Back: true } })
  }, [navigate])
  const closeSettings = useCallback(() => {
    const st = window.history.state as { usr?: { v2Back?: boolean } } | null
    if (st?.usr?.v2Back) { navigate(-1); return }
    const d = screensRef.current.find((x) => x.id === activeRef.current) ?? screensRef.current[0]
    navigate(tabPath(d, lastSub.current[d.id] ?? ''), { replace: true })
  }, [navigate])
  const toggleSettings = useCallback(() => {
    if (settingsRef.current) closeSettings()
    else openSettings()
  }, [openSettings, closeSettings])

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      // a sheet or dialog over Settings closes first
      if (paletteOpen() || document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, closeSettings])

  // ---- pager ----
  const pagerRef = useRef<HTMLDivElement>(null)
  const pageEls = useRef<(HTMLDivElement | null)[]>([])
  const widthRef = useRef(0)
  const floor = useRef<DotFloorHandle | null>(null)
  const floorStop = useRef<null | (() => void)>(null)
  const jumping = useRef(false)

  const setFloor = useCallback((p: number) => {
    floor.current?.setShift(p)
  }, [])
  const floorPos = useRef(0)
  const moveFloor = useCallback((p: number) => {
    floorPos.current = p
    setFloor(p)
  }, [setFloor])

  const onFrame = useCallback((pos: number) => {
    const W = widthRef.current || pagerRef.current?.clientWidth || 1
    const els = pageEls.current
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      if (!el) continue
      const d = i - pos
      if (d > -1 && d < 1) {
        el.style.transform = `translate3d(${(d * W).toFixed(2)}px, 0, 0)`
        el.style.opacity = d === 0 ? '' : (1 - Math.abs(d) * 0.55).toFixed(3)
        el.style.visibility = ''
      } else {
        // parked off to the left: never counted as horizontal overflow, never painted
        el.style.transform = 'translate3d(-99999px, 0, 0)'
        el.style.visibility = 'hidden'
      }
    }
    if (!jumping.current) {
      floorStop.current?.()
      floorStop.current = null
      moveFloor(pos)
    }
  }, [moveFloor])

  const register = useCallback((i: number, el: HTMLDivElement | null) => {
    pageEls.current[i] = el
  }, [])

  const pager = useSwipePager(pagerRef, {
    count: screens.length,
    index,
    onFrame,
    enabled: !settingsOpen,
    onCommit: (i) => {
      const id = screensRef.current[i]?.id
      if (id) go(id, undefined, 'swipe')
    },
  })

  useLayoutEffect(() => {
    const el = pagerRef.current
    if (!el) return
    widthRef.current = el.clientWidth
    let w = el.clientWidth
    const ro = new ResizeObserver(() => {
      // only a width change moves the pages (the header's sub-tab row changes the height)
      if (el.clientWidth === w) return
      w = el.clientWidth
      widthRef.current = w
      jumping.current = true
      onFrame(pager.pos())
      jumping.current = false
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [onFrame, pager])

  // ---- build-in: replay the staggered tilt on the page that just opened ----
  const buildTimers = useRef<Record<number, number>>({})
  const build = useCallback((i: number) => {
    const el = pageEls.current[i]
    if (!el) return
    el.removeAttribute('data-building')
    void el.offsetWidth
    el.setAttribute('data-building', '')
    window.clearTimeout(buildTimers.current[i])
    buildTimers.current[i] = window.setTimeout(() => el.removeAttribute('data-building'), 1500)
  }, [])

  const prevIndex = useRef(-1)
  const prevSub = useRef(sub)
  useLayoutEffect(() => {
    const via = navVia.current
    navVia.current = 'url'
    const from = prevIndex.current
    prevIndex.current = index
    if (from === index) {
      if (prevSub.current !== sub) build(index)
      prevSub.current = sub
      return
    }
    prevSub.current = sub
    if (via === 'swipe' && from !== -1) return
    // tap, key or URL: the content switches in place and builds in while the
    // floor glides like a camera move (reference: tabs do not slide pages)
    jumping.current = true
    pager.jump(index)
    jumping.current = false
    if (from === -1) {
      moveFloor(index)
    } else {
      floorStop.current?.()
      floorStop.current = animateSpring(floorPos.current, index, moveFloor, {
        stiffness: 70, onDone: () => { floorStop.current = null },
      })
    }
    build(index)
  }, [index, sub, build, pager, moveFloor])

  // ---- the user's mode (Settings > Appearance); no screen forces one ----
  const stored = useStoredMode()
  useLayoutEffect(() => {
    applyPalette(stored)
  }, [stored])
  // ---- the font (Settings > Font): useFont keeps <html data-font> in step with the setting ----
  useFont()

  // ---- desktop: arrow keys page left/right ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (settingsRef.current) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      // a sheet, dialog or the palette has the keys; the tabs behind it stay put
      if (paletteOpen() || document.querySelector('[aria-modal="true"]')) return
      const list = screensRef.current
      const i = list.findIndex((s) => s.id === activeRef.current) + (e.key === 'ArrowRight' ? 1 : -1)
      if (i < 0 || i >= list.length) return
      e.preventDefault()
      pager.settle(i)
      go(list[i].id, undefined, 'swipe')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, pager])

  // ---- first paint ----
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (firstPaintAt === null) firstPaintAt = Math.round(performance.now())
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- pose + center text, owned by the screen that set them ----
  const [poseState, setPoseState] = useState<{ screen: string; pose: string } | null>(null)
  const setPose = useCallback((p: string) => {
    const s = activeRef.current
    setPoseState((cur) => (cur && cur.screen === s && cur.pose === p ? cur : { screen: s, pose: p }))
  }, [])
  const pose = poseState && poseState.screen === activeId ? poseState.pose : activeId

  const [center, setCenterState] = useState<{ screen: string; text: string } | null>(null)
  const setCenter = useCallback((t: string | null) => {
    const s = activeRef.current
    setCenterState((cur) => {
      if (t === null) return cur && cur.screen === s ? null : cur
      return cur && cur.screen === s && cur.text === t ? cur : { screen: s, text: t }
    })
  }, [])
  const centerText = !settingsOpen && center && center.screen === activeId ? center.text : null

  const scroller = useCallback(() => {
    const i = screensRef.current.findIndex((s) => s.id === activeRef.current)
    return pageEls.current[i] ?? null
  }, [])

  const [motion, setMotion] = useMotionSetting()

  const api = useMemo<ShellApi>(() => ({
    active: activeId, go, sub, toast, openSettings, mode: stored, setMode: saveMode, motion, setMotion, pose, setPose, setCenter, scroller,
  }), [activeId, go, sub, openSettings, stored, motion, setMotion, pose, setPose, setCenter, scroller])

  return (
    <ShellCtx.Provider value={api}>
      <div className="vl-shell" data-screen={settingsOpen ? SETTINGS_ID : activeId}>
        <div className="vl-shell-backdrop">
          <DotFloor handle={floor} className={cx((floorSetting === false || settingsOpen) && 'opacity-0', floorSetting === 'faint' && 'vl-floor-faint')} />
          {backdrop}
        </div>
        <header className="vl-head">
          <StatusStrip center={centerText} onSettings={SettingsScreen ? toggleSettings : undefined} settingsOpen={settingsOpen} />
          {settingsOpen
            ? <SettingsBar back={def.label} onBack={closeSettings} />
            : <Nav screens={screens} activeId={activeId} sub={sub} go={go} />}
        </header>
        <div className="vl-mid">
          <Rail
            getScroller={scroller}
            activeKey={activeId + '/' + sub}
            icon={def.icon ?? (isIconName(def.id) ? def.id : 'home')}
            label={def.label}
          />
          <div className="vl-pager" ref={pagerRef}>
            {screens.map((s, i) => (
              <Page
                key={s.id}
                def={s}
                index={i}
                active={i === index && !settingsOpen}
                sub={i === index ? sub : lastSub.current[s.id] ?? s.subs?.[0]?.id ?? ''}
                go={go}
                register={register}
              />
            ))}
          </div>
          {settingsOpen && SettingsScreen && (
            <section className="vl-set vl-build-on" aria-label="Settings" data-no-swipe>
              <SettingsScreen active />
            </section>
          )}
          <ToastHost className="vl-shell-toasts" />
        </div>
        <PlayerSync />
        <Foot />
      </div>
    </ShellCtx.Provider>
  )
}
