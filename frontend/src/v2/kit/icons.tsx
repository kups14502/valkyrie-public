import type { CSSProperties, ReactElement } from 'react'
import {
  Activity, ArrowRight, Battery, BatteryCharging, CalendarDays, CarFront, Check, ChevronLeft, ChevronRight, CircleAlert, CirclePause, CirclePlay,
  Clapperboard, Clock, Container, Copy, Cpu, Download, Dumbbell, Film, FolderKanban, Gauge, Glasses, Hand, HardDrive,
  House, Inbox, LayoutDashboard, Laptop, Lightbulb, LightbulbOff, ListMusic, Lock, LockOpen, MapPin, MemoryStick, MessageCircleQuestion, MessageSquarePlus, Monitor,
  Moon, Music, Palette, Pill, Plug, PlugZap, Plus, Power, RefreshCw, Rocket, Route, Search, Server, Settings, ShieldCheck,
  Smartphone, Sparkles, SquareTerminal, PhoneCall, SquareArrowOutUpRight, Video, Sun, Tablet, Thermometer, Timer, TrendingDown, TrendingUp, Tv, Undo2, Wifi, WifiOff, X, Zap,
  UtensilsCrossed, Cctv, Fan, Snowflake, Armchair, Package, Blinds, Flashlight, Megaphone, Sunrise, MapPinned, CircleDot, CloudDownload, KeyRound,
  createLucideIcon, type LucideIcon,
} from 'lucide-react'

// Thor RGB: three overlapping light circles (the additive RGB mark), drawn in lucide's 24 px line style.
const RgbCircles = createLucideIcon('rgb-circles', [
  ['circle', { cx: '12', cy: '8.6', r: '5.2', key: 'r' }],
  ['circle', { cx: '8.6', cy: '14.6', r: '5.2', key: 'g' }],
  ['circle', { cx: '15.4', cy: '14.6', r: '5.2', key: 'b' }],
])

// The Car tab's steering wheel heater: a rim, a hub and three spokes, in the same line style (lucide has none).
const SteeringWheel = createLucideIcon('steering-wheel', [
  ['circle', { cx: '12', cy: '12', r: '9', key: 'rim' }],
  ['circle', { cx: '12', cy: '12', r: '2.2', key: 'hub' }],
  ['path', { d: 'M9.8 12H3.2', key: 'left' }],
  ['path', { d: 'M14.2 12h6.6', key: 'right' }],
  ['path', { d: 'M12 14.2v6.6', key: 'down' }],
])

// local join: ui.tsx imports this file, so nothing is imported back from it
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// v2's one icon set: thin line icons in the scheme's accent with a soft
// glow on lit ones, as in the red frames of the reference (f002, f004, f005). One name per Valkyrie concept so
// every screen draws the same thing for the same idea. Color comes from the
// tone (palette variables), so icons morph with the mode like everything else.

export const ICONS = {
  // tabs and sections
  dashboard: LayoutDashboard,
  home: House,
  ai: SquareTerminal,
  claude: SquareTerminal,
  lights: Lightbulb,
  media: Clapperboard,
  system: Activity,
  settings: Settings,
  calendar: CalendarDays,
  meals: UtensilsCrossed,
  inbox: Inbox,
  projects: FolderKanban,
  // AI > Call, and opening something in a window of its own
  call: PhoneCall,
  popout: SquareArrowOutUpRight,
  video: Video,
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
  // the Car tab's controls
  sentry: Cctv,
  fan: Fan,
  defrost: Snowflake,
  seat: Armchair,
  wheel: SteeringWheel,
  cargo: Package,
  windows: Blinds,
  flash: Flashlight,
  honk: Megaphone,
  wake: Sunrise,
  map: MapPinned,
  tire: CircleDot,
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

export type IconTone = 'fg' | 'dim' | 'faint' | 'hot' | 'acc2' | 'ink'

/**
 * A Valkyrie icon. `glow` adds the soft accent bloom the reference gives lit
 * icons; leave it off for dim, secondary icons so the glow keeps meaning
 * "this is on / selected". `ink` is for an icon sitting on a solid lit plate.
 */
export function Icon({ name, size = 16, tone = 'fg', glow = false, className, style, title }: {
  name: IconName
  size?: number
  tone?: IconTone
  glow?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}) {
  const C = ICONS[name]
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

/** The icon for a host id from /api/hosts: a car for car-<prefix>, else by id (falls back to a generic monitor). */
export const hostIcon = (id: string): IconName => (id.startsWith('car-') ? 'car' : id in ICONS ? (id as IconName) : 'thor')

export const isIconName = (v: unknown): v is IconName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ICONS, v)

/** An icon slot on a primitive: a name from ICONS (drawn here) or any element (drawn as given). */
export type IconSlot = IconName | ReactElement

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
  if (!isIconName(icon)) return icon
  return <Icon name={icon} size={size} tone={tone ?? (lit ? 'fg' : 'dim')} glow={lit && tone !== 'ink'} className={className} />
}
