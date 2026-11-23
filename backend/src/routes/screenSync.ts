// Screen sync: the bulbs follow thor's main monitor.
//
// thor's C:\Thor\ThorRGB\screen_sync.py samples the monitor and posts one color
// four times a second to POST /lights/screen/frame. The first frame starts a
// session, POST /lights/screen/stop (or frames that stop coming) ends it, and
// the end puts every bulb back the way the session found it.
//
// Which bulbs: the ones that were on when the session started, so a bulb
// Brendon had off stays off. With every bulb off, all of them join (and go off
// again at the end). A bulb he changes himself during a session leaves it and
// keeps his change.
//
// Pacing: HA's Cync integration sends every command through ONE hub bulb,
// and the hub relays them over the mesh one at a time, about 0.45 s each
// (measured 2026-11-21: five commands sent together were reported 0.55, 1.0,
// 1.7 and 1.9 s later, in send order). Commands sent faster only queue at the
// hub and land late with an old color. So the session sends one command per
// HUB_GAP_MS across all its bulbs, each time to the bulb furthest from the
// screen, built from the newest frame at that moment.
//
// Fading: the bulbs cannot fade on their own (HA reports supported_features 0
// for all five Cync bulbs, so a transition is dropped), and the hub's pace
// leaves each bulb one command per hub gap per bulb in the session (about 2 s
// with all five). So the session follows
// a smoothed copy of the screen, by elapsed time: a scene change glides over
// about three seconds (colorTauMs, levelTauMs), and each command is the next
// step of that glide instead of a jump to whatever the last frame showed. A
// quick flash or a fast cut back and forth barely moves the bulbs. thor posts
// only every 2 s while its screen holds, so the session also steps the glide
// on its own timer until it arrives.

import type { Color, LightRow, Patch, RGB } from './lights.js'

export type ScreenFrame = { rgb: RGB; sat: number; level: number }

type Before = { on: boolean; pct: number | null; color: Color | null }
type Member = {
  id: string
  before: Before
  /** the brightest this bulb goes during the session: its own level when it was on */
  ceiling: number
  /** neutral screens show this white */
  white: Color
  lastAt: number
  last: { pct: number; color: Color } | null
  /** what the newest frame asks of this bulb */
  want: { pct: number; color: Color } | null
  colored: boolean
}

export type ScreenSyncDeps = {
  rows(): Promise<LightRow[]>
  submit(id: string, p: Patch): Promise<void>
  now?: () => number
  log?: (msg: string, data?: unknown) => void
}

export const SCREEN_TUNING = {
  /** least time between two commands to any of the session's bulbs: the Cync hub's own pace */
  hubGapMs: 450,
  /** least time between two commands to one bulb */
  minGapMs: 600,
  /** a smaller change than the thresholds still goes out once the screen has held it this long */
  settleMs: 3_000,
  /** a color change this big (0-255, brightest channel 255) is worth a command */
  rgbStep: 22,
  /** and a brightness change this big, in percent */
  pctStep: 4,
  /** no frame for this long ends the session (thor stopped or died) */
  staleMs: 10_000,
  /** a dark scene dims a bulb to this share of its ceiling, never off */
  floor: 0.3,
  /** screen means sit low: a typical game frame is about 0.3 */
  levelGain: 1.6,
  /** colorfulness that switches a bulb to color, and back to white below the second */
  colorOn: 0.1,
  colorOff: 0.06,
  /** ceiling for a bulb that was off when the session started */
  offCeiling: 80,
  neutralKelvin: 4000,
  /** the bulbs' color follows the screen's with this time constant: about 63% of a change after it, 95% after three (0 = jump) */
  colorTauMs: 1_500,
  /** and their brightness with this one */
  levelTauMs: 1_200,
  /** while the glide is still moving, the session looks again this often */
  glideTickMs: 250,
}

/**
 * The smoothed screen the bulbs follow. rgb is a plain linear blend of frames
 * (each with its brightest channel at 255, like thor's), so it can sit dimmer
 * mid-blend; shown() brings it back to full. Blending unscaled keeps the pace
 * the same however often it steps: 100 ms frames or a 2 s heartbeat.
 */
type Glide = { rgb: [number, number, number]; sat: number; level: number; at: number }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** brightest channel to 255, the shape thor's frames and the bulbs' colors take */
function norm(rgb: readonly number[]): [number, number, number] {
  const top = Math.max(...rgb)
  return (top > 1e-3 ? rgb.map((v) => (v * 255) / top) : [255, 255, 255]) as [number, number, number]
}
const pctOf = (b: number | null) => (b == null ? null : clamp(Math.round(b / 2.55), 1, 100))

function colorOfRow(r: LightRow): Color | null {
  if (!r.on) return null
  if (r.color_mode === 'color_temp' && r.color_temp_kelvin != null) return { kelvin: r.color_temp_kelvin }
  if (r.rgb_color) return { rgb: r.rgb_color }
  return null
}

function colorStep(a: Color, b: Color): number {
  if ('rgb' in a && 'rgb' in b) return Math.max(...a.rgb.map((v, i) => Math.abs(v - b.rgb[i])))
  if ('kelvin' in a && 'kelvin' in b) return Math.abs(a.kelvin - b.kelvin) > 100 ? Infinity : 0
  return Infinity
}

export function createScreenSync(d: ScreenSyncDeps, tuning: Partial<typeof SCREEN_TUNING> = {}) {
  const t = { ...SCREEN_TUNING, ...tuning }
  const now = d.now ?? (() => Date.now())
  const log = d.log ?? ((msg: string, data?: unknown) => console.warn(`[screen-sync] ${msg}`, data ?? ''))

  let members = new Map<string, Member>()
  let active = false
  let since = 0
  let lastFrameAt = 0
  let lastFrame: ScreenFrame | null = null
  let glide: Glide | null = null
  let starting: Promise<void> | null = null

  const ease = (dt: number, tau: number) => (tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau))

  /**
   * Moves the glide toward the newest frame by the time since its last step.
   * frame() calls it before it swaps in a new frame, so each stretch of time
   * pulls toward the frame that was on screen during it.
   */
  function advance(at: number): Glide | null {
    const f = lastFrame
    if (!f) return glide
    const target = norm(f.rgb)
    if (!glide) {
      glide = { rgb: target, sat: f.sat, level: f.level, at }
      return glide
    }
    const dt = at - glide.at
    const kc = ease(dt, t.colorTauMs)
    const kl = ease(dt, t.levelTauMs)
    const rgb = glide.rgb.map((v, i) => v + (target[i] - v) * kc) as [number, number, number]
    glide = { rgb, sat: glide.sat + (f.sat - glide.sat) * kc, level: glide.level + (f.level - glide.level) * kl, at }
    return glide
  }

  /** The glide has reached the frame closely enough that a further step would never be sent. */
  function settled(): boolean {
    if (!glide || !lastFrame) return true
    const f = lastFrame
    const target = norm(f.rgb)
    const seen = norm(glide.rgb)
    return Math.max(...seen.map((v, i) => Math.abs(v - target[i]))) < 2
      && Math.abs(glide.sat - f.sat) < 0.005 && Math.abs(glide.level - f.level) < 0.005
  }

  /** What a bulb gets: the glide at full brightness (red to blue passes a dark purple otherwise), rounded. */
  const shown = (g: Glide): ScreenFrame => ({ rgb: norm(g.rgb).map((v) => clamp(Math.round(v), 0, 255)) as RGB, sat: g.sat, level: g.level })
  const failed = new Set<string>()

  async function start() {
    const rows = (await d.rows()).filter((r) => !r.unavailable)
    const lit = rows.filter((r) => r.on)
    const chosen = lit.length ? lit : rows
    members = new Map(chosen.map((r) => {
      const pct = r.on ? pctOf(r.brightness) : null
      const color = colorOfRow(r)
      const white: Color = color && 'kelvin' in color ? color : { kelvin: t.neutralKelvin }
      return [r.entity_id, {
        id: r.entity_id,
        before: { on: r.on, pct, color },
        ceiling: pct ?? t.offCeiling,
        white,
        lastAt: -Infinity,
        last: null,
        want: null,
        colored: false,
      }]
    }))
    active = true
    since = now()
    failed.clear()
    log('started', { bulbs: [...members.keys()], from: lit.length ? 'the bulbs that were on' : 'every bulb (all were off)' })
  }

  function send(m: Member, pct: number, color: Color) {
    m.lastAt = now()
    m.last = { pct, color }
    d.submit(m.id, { state: 'on', pct, color }).then(
      () => { failed.delete(m.id) },
      (err: unknown) => {
        if (!failed.has(m.id)) log('send failed', { entity: m.id, error: (err as Error)?.message ?? String(err) })
        failed.add(m.id)
      },
    )
  }

  function follow(m: Member, f: ScreenFrame) {
    const level = clamp(f.level * t.levelGain, 0, 1)
    const pct = clamp(Math.round(m.ceiling * (t.floor + (1 - t.floor) * level)), 1, 100)
    if (m.colored ? f.sat < t.colorOff : f.sat >= t.colorOn) m.colored = !m.colored
    m.want = { pct, color: m.colored ? { rgb: f.rgb } : m.white }
  }

  /** How badly a bulb needs a command now: 0 none, 1 and up a visible change, Infinity never sent. */
  function need(m: Member, at: number): number {
    if (!m.want || at - m.lastAt < t.minGapMs) return 0
    if (!m.last) return Infinity
    const dc = colorStep(m.last.color, m.want.color)
    const dp = Math.abs(m.last.pct - m.want.pct)
    const n = Math.max(dc / t.rgbStep, dp / t.pctStep)
    if (n >= 1) return n
    // a smaller change still lands once the screen has held it a while
    return (dc > 4 || dp > 0) && at - m.lastAt >= t.settleMs ? 0.5 : 0
  }

  let hubAt = -Infinity
  let pumpTimer: ReturnType<typeof setTimeout> | null = null

  function pump() {
    if (!active) return
    const at = now()
    const wait = hubAt + t.hubGapMs - at
    if (wait > 0) {
      pumpTimer ??= setTimeout(() => { pumpTimer = null; pump() }, wait)
      pumpTimer.unref?.()
      return
    }
    const g = advance(at)
    if (g) for (const m of members.values()) follow(m, shown(g))
    let best: Member | null = null
    let most = 0
    for (const m of members.values()) {
      const n = need(m, at)
      if (n > most || (n > 0 && n === most && best && m.lastAt < best.lastAt)) { best = m; most = n }
    }
    if (!best || !best.want) {
      // nothing worth a command yet, but the glide is still moving: look again shortly
      if (!settled()) {
        pumpTimer ??= setTimeout(() => { pumpTimer = null; pump() }, t.glideTickMs)
        pumpTimer.unref?.()
      }
      return
    }
    hubAt = at
    send(best, best.want.pct, best.want.color)
    pumpTimer ??= setTimeout(() => { pumpTimer = null; pump() }, t.hubGapMs)
    pumpTimer.unref?.()
  }

  async function stop(why: string) {
    if (!active) return
    active = false
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null }
    hubAt = -Infinity
    const back = [...members.values()]
    members = new Map()
    lastFrame = null
    glide = null
    log('stopped, putting the bulbs back', { why, bulbs: back.map((m) => m.id) })
    await Promise.allSettled(back.map((m) => {
      const b = m.before
      const p: Patch = b.on
        ? { state: 'on', ...(b.pct != null ? { pct: b.pct } : {}), ...(b.color ? { color: b.color } : {}) }
        : { state: 'off' }
      return d.submit(m.id, p)
    }))
  }

  const timer = setInterval(() => {
    if (active && now() - lastFrameAt > t.staleMs) void stop('no frame from thor for 10 s')
  }, 2_000)
  timer.unref?.()

  return {
    async frame(f: ScreenFrame) {
      const at = now()
      if (active) advance(at)
      lastFrameAt = at
      lastFrame = f
      if (!active) {
        glide = null
        starting ??= start().finally(() => { starting = null })
        await starting
      }
      pump()
    },
    stop,
    /** Brendon changed these bulbs himself: they leave the session and keep his change. */
    release(ids: string[]) {
      if (!active) return
      for (const id of ids) if (members.delete(id)) log('left the session (changed by hand)', { entity: id })
    },
    status() {
      return {
        active,
        since: active ? new Date(since).toISOString() : null,
        lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
        bulbs: [...members.keys()],
        frame: lastFrame,
        shown: glide ? shown(glide) : null,
      }
    },
    /** test hook */
    dispose() { clearInterval(timer); if (pumpTimer) clearTimeout(pumpTimer) },
  }
}
