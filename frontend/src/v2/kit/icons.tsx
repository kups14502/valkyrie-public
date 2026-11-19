import { isValidElement, type CSSProperties, type ReactElement } from 'react'
import {
  Activity, ArrowRight, Battery, BatteryCharging, Bird, CalendarDays, CarFront, Check, ChevronLeft, ChevronRight, CircleAlert, CirclePause, CirclePlay,
  Clapperboard, Clock, Container, Copy, Cpu, Download, Dumbbell, Film, FolderKanban, Gauge, Glasses, Hand, HardDrive,
  House, Inbox, LayoutDashboard, MessagesSquare, Laptop, Lightbulb, LightbulbOff, ListChecks, ListMusic, Lock, LockOpen, MapPin, MemoryStick, MessageCircleQuestion, MessageSquarePlus, Monitor,
  Moon, Music, Palette, Pill, Plug, PlugZap, Plus, Power, RefreshCw, Rocket, Route, Search, Server, Settings, ShieldCheck,
  Smartphone, Sparkles, SquareTerminal, SquareArrowOutUpRight, Sun, Tablet, Thermometer, Timer, TrendingDown, TrendingUp, Tv, Undo2, Wifi, WifiOff, X, Zap,
  UtensilsCrossed, MapPinned, CloudDownload, KeyRound,
  AppWindow, createLucideIcon, type LucideIcon,
} from 'lucide-react'
import { STATE_ICON, type SessionState } from './sessionState'
import './sicon.css'

// Thor RGB: three overlapping light circles (the additive RGB mark), drawn in lucide's 24 px line style.
const RgbCircles = createLucideIcon('rgb-circles', [
  ['circle', { cx: '12', cy: '8.6', r: '5.2', key: 'r' }],
  ['circle', { cx: '8.6', cy: '14.6', r: '5.2', key: 'g' }],
  ['circle', { cx: '15.4', cy: '14.6', r: '5.2', key: 'b' }],
])

// local join: ui.tsx imports this file, so nothing is imported back from it
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// v2's one icon set: thin line icons in the scheme's accent with a soft
// glow on lit ones, as in the red frames of the reference (f002, f004, f005). One name per Valkyrie concept so
// every screen draws the same thing for the same idea. Color comes from the
// tone (palette variables), so icons morph with the mode like everything else.

// The names and their helpers live beside the Icon component on purpose (every screen takes both
// from here); an edit to this file reloads the page instead of hot-swapping it.
/* eslint-disable react-refresh/only-export-components */

export const ICONS = {
  // tabs and sections
  dashboard: LayoutDashboard,
  home: House,
  ai: SquareTerminal,
  claude: SquareTerminal,
  // the Desk: sessions in tabs, like a terminal window
  desk: AppWindow,
  lights: Lightbulb,
  media: Clapperboard,
  system: Activity,
  settings: Settings,
  calendar: CalendarDays,
  meals: UtensilsCrossed,
  inbox: Inbox,
  messages: MessagesSquare,
  // Raven, his assistant (the Raven tab, its corner button and the Dashboard's Raven block)
  raven: Bird,
  tasks: ListChecks,
  projects: FolderKanban,
  // opening something in a window of its own
  popout: SquareArrowOutUpRight,
  // hosts and devices (by host id)
  thor: Monitor,
  odin: Server,
  frame: Glasses,
  mimir: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  logicserver: HardDrive,
  // the cars (host ids car-<prefix>, see hostIcon)
  car: CarFront,
  range: Route,
  plug: Plug,
  plugged: PlugZap,
  locked: Lock,
  unlocked: LockOpen,
  away: MapPin,
  temp: Thermometer,
  // places, updates and sign-ins
  map: MapPinned,
  update: CloudDownload,
  key: KeyRound,
  // metrics
  cpu: Cpu,
  mem: MemoryStick,
  disk: HardDrive,
  battery: Battery,
  charging: BatteryCharging,
  gauge: Gauge,
  uptime: Timer,
  online: Wifi,
  offline: WifiOff,
  // session states and actions
  working: Zap,
  asking: MessageCircleQuestion,
  idle: CirclePause,
  start: Rocket,
  newSession: MessageSquarePlus,
  copy: Copy,
  done: Check,
  stop: X,
  undo: Undo2,
  // daily tracker
  supplements: Pill,
  exercise: Dumbbell,
  sf: Sparkles,
  // lights
  bulb: Lightbulb,
  bulbOff: LightbulbOff,
  power: Power,
  color: Palette,
  warm: Sun,
  night: Moon,
  rgb: RgbCircles,
  // media
  watch: Tv,
  movie: Film,
  music: Music,
  tracks: ListMusic,
  play: CirclePlay,
  download: Download,
  search: Search,
  // system
  service: ShieldCheck,
  container: Container,
  timer: Timer,
  trades: TrendingUp,
  down: TrendingDown,
  alert: CircleAlert,
  clock: Clock,
  refresh: RefreshCw,
  add: Plus,
  // navigation and hints
  go: ChevronRight,
  back: ChevronLeft,
  enter: ArrowRight,
  swipe: Hand,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

/** A name from ICONS, or a lucide component a feature brings (features never add names here). */
export type IconRef = IconName | LucideIcon

export type IconTone = 'fg' | 'dim' | 'faint' | 'hot' | 'acc2' | 'ink'

/**
 * A Valkyrie icon. `glow` adds the soft accent bloom the reference gives lit
 * icons; leave it off for dim, secondary icons so the glow keeps meaning
 * "this is on / selected". `ink` is for an icon sitting on a solid lit plate.
 */
export function Icon({ name, size = 16, tone = 'fg', glow = false, className, style, title }: {
  name: IconRef
  size?: number
  tone?: IconTone
  glow?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}) {
  const C = typeof name === 'string' ? ICONS[name] : name
  return (
    <C
      size={size}
      strokeWidth={size <= 12 ? 1.8 : size <= 14 ? 1.6 : 1.4}
      absoluteStrokeWidth={false}
      className={cx('vl-icon', `vl-icon-${tone}`, glow && 'vl-icon-glow', className)}
      style={style}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? 'img' : undefined}
    />
  )
}

// ---------- a Claude session's state (the table is sessionState.ts) ----------

/** The state icon in its column: a soft halo breathes behind it, gently while working, quicker while asking (sicon.css). */
export function StateIcon({ a, size = 17, className }: { a: SessionState; size?: number; className?: string }) {
  const s = STATE_ICON[a]
  return (
    <span className={cx('vl-sicon', className)} data-a={a} aria-hidden>
      <Icon name={s.name} size={size} tone={s.tone} glow={s.glow} />
    </span>
  )
}

/** The icon for a host id from /api/hosts: a car for car-<prefix>, else by id (falls back to a generic monitor). */
export const hostIcon = (id: string): IconName => (id.startsWith('car-') ? 'car' : id in ICONS ? (id as IconName) : 'thor')

export const isIconName = (v: unknown): v is IconName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ICONS, v)

/** An icon slot on a primitive: a name from ICONS or a lucide component (drawn here), or any element (drawn as given). */
export type IconSlot = IconRef | ReactElement

/** A stable key for an icon: its name, or a component's display name. */
export const iconKey = (icon: IconRef): string => (typeof icon === 'string' ? icon : icon.displayName ?? 'icon')

/**
 * Draws an IconSlot the way the HUD does: `lit` = full color with the glow
 * (on, selected, live, asking), otherwise the dim tone without glow. An
 * element passes through untouched.
 */
export function SlotIcon({ icon, lit = false, tone, size = 15, className }: {
  icon: IconSlot | undefined
  lit?: boolean
  tone?: IconTone
  size?: number
  className?: string
}) {
  if (icon === undefined) return null
  if (isValidElement(icon)) return icon
  return <Icon name={icon} size={size} tone={tone ?? (lit ? 'fg' : 'dim')} glow={lit && tone !== 'ink'} className={className} />
}
