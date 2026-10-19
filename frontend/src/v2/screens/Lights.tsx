import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useShell, type ScreenProps } from '../kit/shell'
import { Panel, Press, Segmented, cx, toast } from '../kit/ui'
import { Icon, type IconName } from '../kit/icons'
import { ago, useHosts, useLights, useThorRgb, useTick, type LightVM, type RgbVM } from '../kit/data'
import { usePalette } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import { POSES, WireScene, parseColor, room, type CameraPose, type Light, type Model, type RGB } from '../kit/three'
import { setThorRgb, type LightUpdate } from '../../lib/api'
import { PRESETS, brightnessFromPct, hexToRgb, lightColor, pctFromBrightness, presetSwatchStyle, rgbToHex, useLightsControl } from '../../lib/lights'
import './lights.css'

// Lights in the red HUD style: the all-lights master as a big power plate, the
// real presets as glass plates plus a Custom plate (the browser's color picker),
// one icon-led row per bulb (a lit bulb's strip has the same Custom swatch) (its bulb icon glows
// in the bulb's real color while it is on), Thor RGB, and the room model as a
// compact panel that shows every bulb in its real color. Every bulb control
// writes through src/lib/lights.ts useLightsControl: its desire overlay shows
// what was asked at once and falls back to the bulb's real state when the call
// fails, and the room re-lights from that same state.
// Phone: one column. Landscape and desktop: master + presets | bulbs | room + Thor RGB.

type Vars = CSSProperties & Record<`--${string}`, string | number>
/** raw: Home Assistant's 0-255 brightness, sent back with a color pick so the bulb keeps its level */
type Bulb = LightVM & { raw: number | null }
type RgbPick = 'relight' | 'dark'
type Swatch = (typeof SWATCHES)[number]

/** glow strength the room gives a lit bulb whose brightness is unknown (drawing only, never shown as a number) */
const UNKNOWN_GLOW = 0.7
/** " · " that keeps the dot on the line before: a wrapped status never starts with a dot */
const SEP = String.fromCharCode(160) + '· '

const SWATCHES = PRESETS.map((p) => ({ label: p.label, rgb: p.rgb, kelvin: p.kelvin, swatch: presetSwatchStyle(p), rgb3: parseColor(presetSwatchStyle(p)) }))
/** a preset as the color half of a light command: rgb, or a white by kelvin, never both */
const colorOf = (p: Swatch): Pick<LightUpdate, 'rgb_color' | 'color_temp_kelvin'> =>
  p.rgb ? { rgb_color: p.rgb } : p.kelvin ? { color_temp_kelvin: p.kelvin } : {}
/** the white presets get the sun / moon that says which end of white they are */
const PRESET_ICON: Partial<Record<string, IconName>> = { Warm: 'warm', Cool: 'night' }
const RGB_OPTS: { value: RgbPick; label: string; icon: IconName }[] = [
  { value: 'relight', label: 'Relight', icon: 'refresh' },
  { value: 'dark', label: 'Dark', icon: 'bulbOff' },
]

// bulbs quantize color (the real backend allows 12 per channel), so match loosely, but tightly
// enough that lightColor's '#ffd9a0' fallback for an unknown color matches no preset
const near = (a: string, b: [number, number, number]) => {
  const c = parseColor(a)
  return Math.max(Math.abs(c[0] - b[0]), Math.abs(c[1] - b[1]), Math.abs(c[2] - b[2])) <= 16
}
const presetOf = (color: string): string | null => SWATCHES.find((p) => near(color, p.rgb3))?.label ?? null
/** any CSS color this screen draws ('rgb(...)' or '#rrggbb') as the '#rrggbb' a color input takes */
const hexOf = (color: string) => rgbToHex(parseColor(color).map((n) => Math.round(n)) as RGB)
/** the Custom plate's chip before anything was picked: a hue strip that says "any color" */
const HUES = 'linear-gradient(90deg, #ff4b4b, #ffb340, #5dff7a, #4bd2ff, #6a6bff, #e85bff)'
/** what the room picker opens on before the first pick (the classic control's default) */
const CUSTOM_START = '#ffb87a'

/** Why a write failed, short enough for a two-line toast: the backend's own word, else its status. */
function why(e: unknown): string {
  const x = (e ?? {}) as { response?: { status?: number; data?: { error?: unknown } }; detail?: unknown; message?: unknown }
  const msg = [x.response?.data?.error, x.detail, x.message].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const status = x.response?.status
  const text = msg ? (msg.length > 72 ? `${msg.slice(0, 71)}…` : msg) : 'no answer'
  return status ? `${status} ${text}` : text
}

// ---------- Thor RGB: the press and its wait ----------
//
// The classic ThorRgbControl's rules. The press does not wait for the work: a
// relight runs two OpenRGB cycles (about 45 s), so it fires thor's task and
// polls until thor reports the asked state. Not optimistic: the plates keep
// showing the real state, and the status line says what is in flight.

/** worst case for a relight, after which the screen stops claiming to be busy */
const RGB_SETTLE_MS = 90_000
/** a press that thor already agrees with (Relight while lit unsticks a wedged keyboard) still shows for this long */
const RGB_MIN_BUSY_MS = 6_000

type RgbPending = { id: number; mode: RgbPick; at: number; sent: boolean }
let rgbSeq = 0

function useRgbPress(state: RgbVM['state'] | undefined) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<RgbPending | null>(null)

  // once the call has landed: done when thor agrees (after the floor), or when the worst case passes
  useEffect(() => {
    if (!pending?.sent) return
    const satisfied = pending.mode === 'relight' ? state === 'lit' : state === 'dark'
    const wait = Math.max(0, (satisfied ? RGB_MIN_BUSY_MS : RGB_SETTLE_MS) - (Date.now() - pending.at))
    const t = setTimeout(() => setPending((p) => (p?.id === pending.id ? null : p)), wait)
    return () => clearTimeout(t)
  }, [pending, state])

  // ask thor every 3 s while a press is out, not every 30
  const out = pending !== null
  useEffect(() => {
    if (!out) return
    const t = setInterval(() => { void qc.invalidateQueries({ queryKey: ['v2', 'thorRgb'] }) }, 3000)
    return () => clearInterval(t)
  }, [out, qc])

  const press = (mode: RgbPick) => {
    if (pending) return
    const id = ++rgbSeq
    setPending({ id, mode, at: Date.now(), sent: false })
    setThorRgb(mode)
      .then((r) => {
        if (r && r.ok === false) throw new Error(r.detail || 'thor refused it')
        setPending((p) => (p?.id === id ? { ...p, sent: true } : p))
        void qc.invalidateQueries({ queryKey: ['v2', 'thorRgb'] })
      })
      .catch((e: unknown) => {
        setPending((p) => (p?.id === id ? null : p))
        toast(`Thor RGB ${mode === 'dark' ? 'Dark' : 'Relight'} failed: ${why(e)}`)
      })
  }
  return { pending: pending?.mode ?? null, press }
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

type Fit = { dist: number; sy: number }

/** the room panel's header band: the room fits under it */
const ROOM_HD = 24

/**
 * Camera distance and vertical shift that fit the room into its compact box,
 * under the header band. Measures layout size (clientWidth/Height), so a
 * tilted column or a build-in transform does not skew it. From the 'lights'
 * pose, at the distances these boxes give, the room draws about 2.75 times as
 * wide and 1.65 times as tall as the projected radius of its bounding sphere,
 * with its middle 0.14 radius below the projection center (measured).
 */
function useBoxFit(box: RefObject<HTMLElement | null>, radius: number): Fit | null {
  const [fit, setFit] = useState<Fit | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w < 20 || h < 60) return
      const ah = h - ROOM_HD
      const fov = POSES.lights.fov ?? 38
      const focal = (Math.min(w, h) * 0.5) / Math.tan((fov * Math.PI) / 360)
      const R = Math.min((w * 0.9) / 2.75, (ah * 0.92) / 1.65)
      const dist = Math.round(Math.max(6, Math.min(40, (focal * radius) / R)) * 100) / 100
      const sy = Math.round(((ROOM_HD + ah / 2) / h - 0.5 - (0.14 * R) / h) * 1000) / 1000
      setFit((cur) => (cur && Math.abs(cur.dist - dist) < 0.05 && Math.abs(cur.sy - sy) < 0.004 ? cur : { dist, sy }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [box, radius])
  return fit
}

/** The Thor RGB status line, the real ThorRgbControl's wording. */
function rgbStatus(d: RgbVM | undefined, failed: boolean, updatedAt: number, pending: RgbPick | null, now: number, askedAt: number): { text: string; bad?: string } {
  if (failed) {
    // thor did not answer: say so, over the last good state and its age
    if (!d || !d.installed) return { text: '', bad: 'Thor is not answering' }
    const was = d.state === 'lit' ? 'lit' : d.state === 'dark' ? 'dark' : 'state unknown'
    return { bad: 'Thor is not answering', text: `${was} ${ago(updatedAt, now)} ago` }
  }
  // thor's agent can take 8 s to time out, twice: past a few seconds, say what is going on and for how long
  if (!d) return { text: now - askedAt >= 5000 ? `Thor is slow to answer · ${ago(askedAt, now)}` : 'Checking' }
  if (!d.installed) return { text: 'Not set up on this backend' }
  if (pending) return { text: pending === 'relight' ? 'Relighting · up to 45s' : 'Going dark' }
  if (d.state === 'lit') {
    const parts = ['Lit']
    if (d.storm) parts.push('storm streaming')
    if (d.relightAt) parts.push(`${d.relightOk === false ? 'relight failed' : 'relit'} ${ago(d.relightAt, now)} ago`)
    return { text: parts.join(' · ') }
  }
  if (d.state === 'dark') {
    const parts = ['Dark']
    if (d.darkAt) parts.push(`${d.darkOk === false ? 'blank failed' : 'blanked'} ${ago(d.darkAt, now)} ago`)
    return { text: parts.join(' · ') }
  }
  // nothing is streaming: say which half is up, it narrows the problem down
  return { text: d.openrgb ? 'Storm down · OpenRGB up' : 'Storm and OpenRGB down' }
}

/**
 * The bulbs this screen shows, and the one way it writes to them.
 *
 * Reads: server truth with the asked-for state laid over (useLightsControl's
 * desires), or the persisted read until the live one lands, so a cold open
 * paints the last bulbs in the first frame. A bulb's brightness stays null
 * (unknown) unless the bulb reported it or the user set it.
 *
 * Writes: every one goes through useLightsControl's mutation, which lays the
 * desire over the live state at once, sends one command at a time with the
 * newest per bulb winning, forgets the desire when the call fails (the bulb
 * falls back to what it really is) and refetches on success. Every press goes:
 * a tap is never dropped because an earlier one is still out, so the last
 * thing asked is where the bulb ends up. This adds the error toast, a refresh
 * of the dock's and Home's read, and the in-flight set the controls mark
 * themselves busy by.
 */
function useBulbs() {
  const qc = useQueryClient()
  const ctl = useLightsControl()
  const cached = useLights()
  const server = ctl.lights.data
  const all: Bulb[] = useMemo(() => (server
    ? ctl.all.map((l): Bulb => ({
      id: l.entity_id, name: l.name, on: l.on, unavailable: l.unavailable,
      pct: pctFromBrightness(l.brightness), color: lightColor(l), raw: l.brightness,
    }))
    : (cached.data ?? []).map((l): Bulb => ({ ...l, raw: null }))), [server, ctl.all, cached.data])
  const lights = server
    ? { has: true, failed: ctl.lights.isError, updatedAt: ctl.lights.dataUpdatedAt }
    : { has: !!cached.data, failed: cached.failed || ctl.lights.isError, updatedAt: cached.updatedAt }

  // commands in flight per bulb: the ref answers at once (two taps inside one
  // frame), the state re-renders the controls that wait on it
  const inflight = useRef(new Map<string, number>())
  const [busy, setBusy] = useState<Record<string, number>>({})
  const mark = (ids: string[], d: 1 | -1) => {
    for (const id of ids) {
      const n = (inflight.current.get(id) ?? 0) + d
      if (n > 0) inflight.current.set(id, n)
      else inflight.current.delete(id)
    }
    setBusy(Object.fromEntries(inflight.current))
  }
  const { mutateAsync } = ctl.mutation
  const send = (u: LightUpdate, failed: string) => {
    const ids = Array.isArray(u.entity_id) ? [...u.entity_id] : [u.entity_id]
    if (!ids.length) return
    if (!server) { toast('Lights: still reading Home Assistant'); return }
    mark(ids, 1)
    mutateAsync(u)
      .then(() => { void qc.invalidateQueries({ queryKey: ['v2', 'lights'] }) })
      .catch((e: unknown) => { toast(`${failed}: ${why(e)}`) })
      .finally(() => mark(ids, -1))
  }
  return { all, lights, busy, send }
}

export default function Lights({ active }: ScreenProps) {
  const { setPose, setCenter } = useShell()
  const palette = usePalette()
  const reduced = useReducedMotion()
  const wide = useMedia('(min-width: 1100px)')
  const now = useTick(5000)

  const { all, lights, busy, send } = useBulbs()
  const rgbQ = useThorRgb()
  const hosts = useHosts()
  const [sel, setSel] = useState<string | null>(null)

  useEffect(() => {
    if (active) setPose('lights')
  }, [active, setPose])

  const avail = all.filter((b) => !b.unavailable)
  const lit = avail.filter((b) => b.on)
  const anyOn = lit.length > 0
  const allNA = all.length > 0 && avail.length === 0
  // one unknown bulb makes the room reading unknown (the real roomPct rule), never an invented average
  const avg = lit.length && lit.every((b) => b.pct != null)
    ? Math.round(lit.reduce((a, b) => a + (b.pct as number), 0) / lit.length)
    : null
  const ordered = [...avail, ...all.filter((b) => b.unavailable)]
  const activePreset = anyOn && lit.every((b) => presetOf(b.color) === presetOf(lit[0].color)) ? presetOf(lit[0].color) : null
  // every lit bulb shares one color that no preset matches: the Custom plate is the lit one
  const roomCustom = anyOn && !activePreset && lit.every((b) => near(b.color, parseColor(lit[0].color))) ? lit[0].color : null
  const presetValue: ReactNode = !anyOn ? undefined : activePreset ?? (
    <span className="lt-dimval">{lit.length > 1 && lit.some((b) => !near(b.color, parseColor(lit[0].color))) ? 'Mixed' : 'Custom'}</span>
  )

  // ---- Thor RGB ----
  const rgbD = rgbQ.data
  const rgbPress = useRgbPress(rgbD?.state)
  const rgbUsable = !!rgbD && rgbD.installed && !rgbQ.failed
  // the plates and the room show what the desk is really doing; a press in flight is the status line's to say
  const rgb: RgbPick | null = rgbD?.installed && (rgbUsable || rgbQ.failed) ? (rgbD.state === 'lit' ? 'relight' : rgbD.state === 'dark' ? 'dark' : null) : null
  const [rgbAskedAt] = useState(() => Date.now())
  const rgbLine = rgbStatus(rgbD, rgbQ.failed, rgbQ.updatedAt, rgbPress.pending, now, rgbAskedAt)

  const thorOn = !!hosts.data?.find((h) => h.id === 'thor' && h.online && !h.stale)

  useEffect(() => {
    if (!active || !lights.has) return
    setCenter(allNA ? `0/${all.length} reachable` : avail.length ? `${lit.length}/${avail.length} on${avg !== null ? ` · ${avg}%` : ''}` : null)
  }, [active, lights.has, allNA, all.length, avail.length, lit.length, avg, setCenter])

  // ---- writes (useBulbs sends them; a control shows busy while a command for its bulbs is out, and still takes presses) ----
  const availBusy = avail.some((b) => !!busy[b.id])
  const litBusy = lit.some((b) => !!busy[b.id])

  // switching on restores the level and color the bulb last had (the backend completes the command); unknown stays unknown
  const toggleBulb = (b: Bulb) => send({ entity_id: b.id, state: b.on ? 'off' : 'on' }, `Could not turn ${b.name} ${b.on ? 'off' : 'on'}`)
  const setBulbPct = (b: Bulb, v: number) => send(
    v <= 0 ? { entity_id: b.id, state: 'off' } : { entity_id: b.id, state: 'on', brightness: brightnessFromPct(v) },
    v <= 0 ? `Could not turn ${b.name} off` : `Could not set ${b.name} to ${v}%`,
  )
  // a color pick carries the level the bulb is at: sent without one, a Cync bulb changing color mode picks its own
  const colorBulb = (b: Bulb, p: Swatch) =>
    send({ entity_id: b.id, state: 'on', ...(b.raw != null ? { brightness: b.raw } : {}), ...colorOf(p) }, `Could not set ${b.name} to ${p.label}`)
  const toggleAll = () => {
    if (!avail.length) return
    send({ entity_id: avail.map((b) => b.id), state: anyOn ? 'off' : 'on' }, `Could not turn the lights ${anyOn ? 'off' : 'on'}`)
  }
  // the master drag owns the bulbs that were lit when it started (all of them when none were)
  const masterTargets = useRef<string[]>([])
  const startMaster = () => { masterTargets.current = (anyOn ? lit : avail).map((b) => b.id) }
  const setMaster = (v: number) => send(
    v <= 0 ? { entity_id: masterTargets.current, state: 'off' } : { entity_id: masterTargets.current, state: 'on', brightness: brightnessFromPct(v) },
    v <= 0 ? 'Could not turn the lights off' : `Could not set the lights to ${v}%`,
  )
  // presets color the bulbs that are ON, never a dark one, and carry no brightness:
  // five bulbs at five levels keep their own (the backend completes each bulb's command with its own level)
  const applyPreset = (p: Swatch) => {
    if (!lit.length) { toast('Turn a light on first'); return }
    send({ entity_id: lit.map((b) => b.id), state: 'on', ...colorOf(p) }, `Could not apply ${p.label}`)
  }
  // a picked color is one deliberate commit (ColorPick sends once per pick). The room gets it as a
  // preset does: no brightness, the backend completes each lit bulb's command with its own level.
  // One bulb gets the level it is at, as a preset tap on its strip does.
  const applyCustom = (rgb: RGB) => {
    if (!lit.length) { toast('Turn a light on first'); return }
    send({ entity_id: lit.map((b) => b.id), state: 'on', rgb_color: rgb }, 'Could not apply the custom color')
  }
  const customBulb = (b: Bulb, rgb: RGB) =>
    send({ entity_id: b.id, state: 'on', ...(b.raw != null ? { brightness: b.raw } : {}), rgb_color: rgb }, `Could not set ${b.name} to a custom color`)

  // ---- selection: a row tap lights its diamond (and opens a lit bulb's colors), a diamond tap finds its row ----
  const rowEls = useRef<Record<string, HTMLDivElement | null>>({})
  const selectFromRoom = (id: string) => {
    setSel((cur) => (cur === id ? null : id))
    rowEls.current[id]?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }
  const shownSel = active ? sel : null
  const selBulb = shownSel ? all.find((b) => b.id === shownSel) : undefined

  // ---- the room: a compact panel, the one 3D element on this screen ----
  const roomBox = useRef<HTMLDivElement>(null)
  const roomKey = all.map((l) => l.id + '\u0001' + l.name).join('\u0002')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model = useMemo(() => room(all.map((l) => ({ id: l.id, name: l.name }))), [roomKey])
  const fit = useBoxFit(roomBox, model.radius)

  // The compact room on a narrow screen labels the selected bulb, or the lit ones while few are lit
  // (the light pools already say which are on), so names never pile up. Same segments, so the camera
  // and the floor stay put.
  const litKey = lit.map((b) => b.id).join('|')
  const sceneModel = useMemo<Model>(() => {
    if (wide) return model
    const litIds = litKey ? litKey.split('|') : []
    const show = new Set(shownSel ? [shownSel] : litIds.length <= 2 ? litIds : [])
    return { ...model, hotspots: model.hotspots.map((h) => (show.has(h.id) ? h : { ...h, label: '' })) }
  }, [model, wide, litKey, shownSel])

  const pose = useMemo<CameraPose | null>(() => {
    if (!fit) return null
    const p = POSES.lights
    // a little left of center leaves room for the bulb labels on the right
    const shift: [number, number] = [-0.05, fit.sy]
    // hidden: wait a little wider and lower, so opening the tab dollies into the room
    if (!active && !reduced) return { ...p, yaw: p.yaw - 48, pitch: 12, dist: fit.dist * 1.22, shift }
    return { ...p, dist: fit.dist, shift }
  }, [fit, active, reduced])

  const glowOf = (b: Bulb) => (b.pct == null ? UNKNOWN_GLOW : b.pct / 100)
  const lightKey = all.map((b) => `${b.id}|${b.on ? 1 : 0}|${b.pct ?? ''}|${b.color}|${b.unavailable ? 1 : 0}`).join(';')
  const sceneLights = useMemo<Light[]>(() => model.hotspots.flatMap((h) => {
    const b = all.find((x) => x.id === h.id)
    if (!b || !b.on || b.unavailable) return []
    return [{ at: h.at, color: b.color, intensity: 0.22 + 0.78 * glowOf(b) }]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [model, lightKey])
  const heat = useMemo(() => {
    const h: Record<string, number> = {
      screens: thorOn ? 0.5 : 0.06,
      fans: rgb === 'relight' ? 0.9 : rgb === 'dark' ? 0.03 : 0.3,
    }
    for (const b of all) h[`bulb.${b.id}`] = b.on && !b.unavailable ? 0.35 + 0.65 * glowOf(b) : 0.04
    return h
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightKey, thorOn, rgb])

  // rows build in on half steps inside their panel, so no empty frame paints on a warm open
  const rowI = (j: number) => 3.4 + j * 0.4

  return (
    <div className="lt-layout vl-screen">
      <div className="lt-col lt-col-a">
        {/* ALL LIGHTS: the power plate toggles everything, the bar sets the lit bulbs */}
        <Panel
          className="lt-p-master"
          icon="lights"
          lit={anyOn}
          label="All lights"
          value={!lights.has || !all.length ? undefined : allNA
            ? <span className="lt-count-na"><Icon name="alert" size={13} tone="acc2" />All unavailable</span>
            : <span className="lt-count" data-stale={lights.failed || undefined}><b>{lit.length}</b> of {avail.length} on</span>}
          i={0}
        >
          <div className="lt-master">
            <Press
              className="lt-mpwr"
              data-on={anyOn || undefined}
              aria-pressed={anyOn}
              aria-label={anyOn ? 'Turn all lights off' : 'Turn all lights on'}
              aria-busy={availBusy || undefined}
              data-busy={availBusy || undefined}
              disabled={!avail.length}
              onPress={toggleAll}
            >
              <Icon name="power" size={22} tone={anyOn ? 'ink' : 'dim'} glow={anyOn} />
              <span className="lt-mpwr-cap">{anyOn ? 'On' : 'Off'}</span>
            </Press>
            <Slider
              size="lg"
              label="All lights brightness"
              value={anyOn ? avg : 0}
              readout={avg !== null}
              disabled={!avail.length}
              onStart={startMaster}
              onCommit={setMaster}
            />
          </div>
          {allNA && <div className="lt-note">Home Assistant cannot reach the bulbs. Cync may need re-auth.</div>}
        </Panel>

        {/* PRESETS: the real list from src/lib/lights.ts */}
        <Panel className="lt-p-presets" icon="color" lit={!!activePreset || !!roomCustom} label="Presets" value={presetValue} i={1}>
          <PresetPlates
            active={activePreset}
            custom={roomCustom}
            idle={!anyOn}
            busy={anyOn && litBusy}
            onPick={applyPreset}
            onCustom={applyCustom}
          />
        </Panel>
      </div>

      <div className="lt-col lt-col-b">
        {/* BULBS: one icon-led row each, unavailable ones dim at the bottom */}
        <Panel
          className="lt-p-bulbs"
          icon="bulb"
          label="Bulbs"
          value={lights.has ? (
            <span className="lt-bulbs-val">
              {lights.failed
                ? <span className="lt-age" data-bad>unreachable · {ago(lights.updatedAt, now)}</span>
                : <span className="lt-age">{ago(lights.updatedAt, now)}</span>}
            </span>
          ) : undefined}
          i={3}
        >
          <div className="lt-bulbs">
            {ordered.map((b, j) => (
              <BulbRow
                key={b.id}
                b={b}
                i={rowI(j)}
                selected={shownSel === b.id}
                busy={!!busy[b.id]}
                rowRef={(el) => { rowEls.current[b.id] = el }}
                onSelect={() => setSel((cur) => (cur === b.id ? null : b.id))}
                onToggle={() => toggleBulb(b)}
                onPct={(v) => setBulbPct(b, v)}
                onColor={(p) => colorBulb(b, p)}
                onCustom={(rgb) => customBulb(b, rgb)}
              />
            ))}
            {!lights.has && <div className="lt-empty">{lights.failed ? 'Lights unreachable' : 'Loading lights'}</div>}
            {lights.has && !all.length && <div className="lt-empty">No bulbs reported</div>}
          </div>
        </Panel>
      </div>

      <div className="lt-col lt-col-c">
        {/* ROOM: compact, each bulb in its real color; a diamond finds its row */}
        <section className="vl-panel vl-build lt-p-room" style={{ '--i': 2 } as Vars}>
          <div ref={roomBox} className="lt-room">
            {pose && (
              <WireScene
                className="h-full w-full"
                model={sceneModel}
                pose={pose}
                palette={palette}
                heat={heat}
                lights={sceneLights}
                orbit
                orbitArea="model"
                paused={!active}
                motion={reduced ? 'reduced' : 'full'}
                activeHotspot={shownSel}
                hotspotLabels
                onHotspot={(id) => selectFromRoom(id)}
              />
            )}
            <div className="lt-room-hd" aria-hidden>
              <span className="lt-room-label"><Icon name="home" size={14} tone="dim" className="lt-hd-ic" />Room</span>
              {selBulb && <span className="lt-room-sel">{selBulb.name}</span>}
            </div>
          </div>
        </section>

        {/* THOR RGB */}
        <Panel className="lt-p-rgb" i={4} dense>
          <div className="lt-rgb">
            <div className="lt-rgb-text min-w-0 flex-1">
              <div className="lt-rgb-name">
                <Icon name="thor" size={15} tone={rgb === 'relight' ? 'fg' : 'dim'} glow={rgb === 'relight'} className="lt-hd-ic" />
                Thor RGB
              </div>
              <div className="lt-rgb-state">
                {rgbLine.bad && <span className="lt-bad"><Icon name="alert" size={12} tone="acc2" />{rgbLine.bad}</span>}
                {rgbLine.bad && rgbLine.text && SEP}
                {/* each part wraps as a unit, its dot kept at the end of the line */}
                {rgbLine.text.split(' · ').flatMap((p, k, all) => [
                  <span key={k} className="lt-part">{p}{k < all.length - 1 ? ' ·' : ''}</span>,
                  k < all.length - 1 ? ' ' : null,
                ])}
              </div>
            </div>
            {/* a press in flight locks both plates and marks the one pressed until thor agrees */}
            <div
              className="lt-rgb-ctl"
              data-locked={!rgbUsable || undefined}
              data-pending={rgbPress.pending ?? undefined}
              aria-busy={!!rgbPress.pending || undefined}
              inert={!rgbUsable || !!rgbPress.pending}
            >
              <Segmented<RgbPick>
                className={cx('lt-rgb-seg', rgb === null && 'lt-seg-none')}
                options={RGB_OPTS}
                // no known state: a value that matches no option, so no cell claims to be on
                value={(rgb ?? '') as RgbPick}
                onChange={rgbPress.press}
              />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}

// ---------- presets: glass plates, each with its swatch ----------

function PresetPlates({ active, custom, idle, busy, onPick, onCustom }: {
  active: string | null
  /** the one color every lit bulb shares when no preset matches it (lights the Custom plate) */
  custom: string | null
  /** nothing to color yet: dimmed, a tap explains why */
  idle?: boolean
  /** a command for the lit bulbs is in flight (a newer pick still goes, and wins) */
  busy?: boolean
  onPick: (p: Swatch) => void
  onCustom: (rgb: RGB) => void
}) {
  // the picker's value while it moves (the chip follows it), and the last color sent from here
  const [pick, setPick] = useState<string | null>(null)
  const [last, setLast] = useState(CUSTOM_START)
  const customOn = !!custom
  const sw = pick ?? custom ?? HUES
  const inner = (
    <>
      <span className="lt-chip" aria-hidden />
      <span className="lt-pre-name">Custom</span>
      <Icon name="color" size={13} tone={customOn ? 'ink' : 'dim'} className="lt-pre-ic" />
    </>
  )
  return (
    <div className="lt-pres" role="radiogroup" aria-label="Presets" data-idle={idle || undefined} data-busy={busy || undefined} aria-busy={busy || undefined}>
      {SWATCHES.map((p) => {
        const on = active === p.label
        const ic = PRESET_ICON[p.label]
        return (
          <Press
            key={p.label}
            role="radio"
            aria-checked={on}
            data-on={on || undefined}
            className="lt-pre"
            style={{ '--sw': p.swatch } as Vars}
            onPress={() => onPick(p)}
          >
            <span className="lt-chip" aria-hidden />
            <span className="lt-pre-name">{p.label}</span>
            {ic && <Icon name={ic} size={13} tone={on ? 'ink' : 'dim'} className="lt-pre-ic" />}
          </Press>
        )
      })}
      {/* Custom: nothing lit, a tap says why; otherwise the color picker sits over the plate */}
      {idle ? (
        <Press className="lt-pre lt-pre-custom" style={{ '--sw': sw } as Vars} onPress={() => toast('Turn a light on first')}>
          {inner}
        </Press>
      ) : (
        <label
          className="vl-press lt-pre lt-pre-custom"
          data-on={customOn || undefined}
          data-pick={pick !== null || undefined}
          style={{ '--sw': sw } as Vars}
          title="Custom color"
        >
          {inner}
          <ColorPick
            value={pick ?? (custom ? hexOf(custom) : last)}
            label="Custom color for the lit lights"
            onPreview={setPick}
            onCommit={(rgb, hex) => { setPick(null); setLast(hex); onCustom(rgb) }}
          />
        </label>
      )}
    </div>
  )
}

// ---------- custom color: the browser's own picker over a plate ----------

/** a run of change events this close together is one pick (see ColorPick) */
const PICK_SETTLE_MS = 450

/**
 * A color input laid over its plate (transparent, covering the hit area), so the tap lands on the
 * input itself: iOS opens the picker from a direct tap. It previews while the picker moves and
 * sends on the input's change event, not React's onChange (that is the input event, which fires
 * for every step of a drag; a command per step is what the brightness bars learned not to send a
 * cloud integration). A picker that fires change while it is still open gets one command for the
 * whole run: the last value, once the changes stop for PICK_SETTLE_MS. A pick still waiting when
 * the plate goes away (the strip closed) is sent at once. Blur drops a preview that never became a
 * change (the picker closed on the color it opened with).
 */
function ColorPick({ value, label, onPreview, onCommit }: {
  value: string
  label: string
  onPreview: (hex: string | null) => void
  onCommit: (rgb: RGB, hex: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const cb = useRef({ onPreview, onCommit })
  useLayoutEffect(() => { cb.current = { onPreview, onCommit } })
  const waiting = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let hex = ''
    const send = () => {
      timer = null
      waiting.current = false
      const rgb = hexToRgb(hex)
      if (rgb) cb.current.onCommit(rgb, hex)
    }
    const change = () => {
      hex = el.value.toLowerCase()
      waiting.current = true
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(send, PICK_SETTLE_MS)
    }
    el.addEventListener('change', change)
    return () => {
      el.removeEventListener('change', change)
      if (timer !== null) { clearTimeout(timer); send() }
    }
  }, [])
  return (
    <input
      ref={ref}
      type="color"
      className="lt-cin"
      value={value}
      aria-label={label}
      onChange={(e) => cb.current.onPreview(e.currentTarget.value.toLowerCase())}
      onBlur={() => { if (!waiting.current) cb.current.onPreview(null) }}
    />
  )
}

// ---------- a lit bulb's own colors (the swatch strip under its row) ----------

function Swatches({ label, active, color, busy, onPick, onCustom }: {
  label: string
  active: string | null
  /** the bulb's real color: what the Custom swatch shows when no preset matches, and where its picker opens */
  color: string
  busy?: boolean
  onPick: (p: Swatch) => void
  onCustom: (rgb: RGB) => void
}) {
  const [pick, setPick] = useState<string | null>(null)
  const customOn = active === null
  return (
    <div className="lt-sws" role="radiogroup" aria-label={label} data-busy={busy || undefined} aria-busy={busy || undefined}>
      {SWATCHES.map((p, n) => (
        <Press
          key={p.label}
          role="radio"
          aria-checked={active === p.label}
          aria-label={p.label}
          title={p.label}
          data-on={active === p.label || undefined}
          className="lt-sw"
          style={{ '--sw': p.swatch, '--n': n } as Vars}
          onPress={() => onPick(p)}
        />
      ))}
      {/* Custom: a thin line box until the bulb is a color no preset matches, then that color, lit */}
      <label
        className="vl-press lt-sw lt-sw-custom"
        data-on={customOn || undefined}
        data-pick={pick !== null || undefined}
        style={{ '--sw': pick ?? color, '--n': SWATCHES.length } as Vars}
        title="Custom color"
      >
        <Icon name="color" size={14} tone="dim" className="lt-sw-ic" />
        <ColorPick
          value={pick ?? hexOf(color)}
          label={`${label}: custom`}
          onPreview={setPick}
          onCommit={(rgb) => { setPick(null); onCustom(rgb) }}
        />
      </label>
    </div>
  )
}

// ---------- one bulb ----------

function BulbRow({ b, i, selected, busy, rowRef, onSelect, onToggle, onPct, onColor, onCustom }: {
  b: Bulb
  i: number
  selected: boolean
  /** a command for this bulb is in flight (a newer press still goes, and wins) */
  busy: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onToggle: () => void
  onPct: (v: number) => void
  onColor: (p: Swatch) => void
  onCustom: (rgb: RGB) => void
}) {
  const lit = b.on && !b.unavailable
  const open = selected && lit
  // the value under the finger while the bar is dragged (the bulb is only told on release)
  const [preview, setPreview] = useState<number | null>(null)
  const pct = preview !== null ? (preview > 0 ? preview : null) : b.on ? b.pct : null
  return (
    <div
      ref={rowRef}
      className="lt-bulb-wrap vl-build"
      style={{ '--i': i } as Vars}
      data-sel={selected || undefined}
    >
      <div className="lt-bulb" data-off={!b.on || undefined} data-na={b.unavailable || undefined}>
        <Press
          className="lt-bulb-id"
          aria-label={lit ? `${b.name} color` : `Show ${b.name} in the room`}
          aria-expanded={lit ? open : undefined}
          onPress={onSelect}
        >
          {/* lit: the bulb glows in its real color; off: the struck bulb, dim */}
          <Icon
            name={lit ? 'bulb' : 'bulbOff'}
            size={17}
            tone={lit ? 'fg' : b.unavailable ? 'faint' : 'dim'}
            glow={lit}
            className="lt-bulb-ic"
            style={lit ? { color: b.color } : undefined}
          />
          <span className="lt-bulb-name">{b.name}</span>
          {lit && <Icon name="color" size={12} tone={open ? 'fg' : 'dim'} glow={open} className="lt-bulb-more" />}
        </Press>
        {b.unavailable ? (
          <span className="lt-na"><Icon name="offline" size={12} tone="dim" />Unavailable</span>
        ) : (
          <>
            <Slider
              size="sm"
              label={`${b.name} brightness`}
              value={b.on ? b.pct : 0}
              look={(preview !== null ? preview > 0 : b.on) ? 'glass' : 'line'}
              onPreview={setPreview}
              onCommit={onPct}
            />
            <span className="lt-pct">{pct != null ? <>{pct}<small>%</small></> : null}</span>
            <Press
              className="lt-tg"
              data-on={b.on || undefined}
              data-busy={busy || undefined}
              aria-busy={busy || undefined}
              aria-pressed={b.on}
              aria-label={b.on ? `Turn ${b.name} off` : `Turn ${b.name} on`}
              onPress={onToggle}
            >
              <Icon name="power" size={15} tone={b.on ? 'fg' : 'dim'} glow={b.on} />
            </Press>
          </>
        )}
      </div>
      {open && (
        <div className="lt-strip">
          <Swatches label={`${b.name} color`} active={presetOf(b.color)} color={b.color} busy={busy} onPick={onColor} onCustom={onCustom} />
        </div>
      )}
    </div>
  )
}

// ---------- glass brightness bar (f016 "Display Brightness") ----------

/**
 * A glass bar you drag or tap. Lights up on pointerdown. A mouse sets the value
 * at once; a finger sets it on a sideways drag or on lift, and a vertical move
 * hands the gesture back to the page scroll (touch-action: pan-y). The shell's
 * swipe pager ignores it (data-no-swipe). `value` null = unknown: a dim full
 * track with no head. `look` 'line' = an off bulb: a hairline in the same 44 px
 * hit box, still draggable to turn the bulb on.
 *
 * It commits ONCE per gesture (release, tap, or key up after the arrows), as
 * the classic Brightness does: a command per move sent a cloud integration
 * values the finger had already left. The held value owns the bar from the
 * first move until the light reports it back, or HOLD_MS for one that never does.
 */
const HOLD_MS = 4_000

function Slider({ value, onCommit, onStart, onPreview, size, label, disabled, look = 'glass', readout }: {
  value: number | null
  onCommit: (v: number) => void
  /** the gesture began (the master captures its target bulbs here) */
  onStart?: () => void
  /** the value under the finger while it moves; null when the gesture ends */
  onPreview?: (v: number | null) => void
  size: 'sm' | 'lg'
  label: string
  disabled?: boolean
  look?: 'glass' | 'line'
  /** the value inside the bar at its right end (f016 "100%"): false = only while held, true = also when idle, unset = never */
  readout?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef({ onCommit, onStart, onPreview })
  useLayoutEffect(() => { cb.current = { onCommit, onStart, onPreview } })
  const [drag, setDrag] = useState(false)
  const [held, setHeld] = useState<number | null>(null)
  const last = useRef(0)
  const keying = useRef(false)
  const ceiling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = held ?? value
  const unknown = shown === null
  const v = unknown ? 0 : Math.max(0, Math.min(100, Math.round(shown)))

  const clearCeiling = () => {
    if (ceiling.current !== null) { clearTimeout(ceiling.current); ceiling.current = null }
  }
  useEffect(() => clearCeiling, [])
  // the light agreed (bulbs round, so within a point): it drives the bar again
  useEffect(() => {
    if (drag || keying.current || held === null || value === null || Math.abs(value - held) > 1) return
    clearCeiling()
    setHeld(null)
  }, [value, held, drag])

  const hold = (n: number) => {
    last.current = n
    setHeld(n)
    cb.current.onPreview?.(n)
  }
  const commit = () => {
    cb.current.onPreview?.(null)
    clearCeiling()
    ceiling.current = setTimeout(() => { ceiling.current = null; setHeld(null) }, HOLD_MS)
    cb.current.onCommit(last.current)
  }

  const at = (clientX: number) => {
    const bar = ref.current?.querySelector('.lt-sl-bar') as HTMLElement | null
    const r = (bar ?? ref.current!).getBoundingClientRect()
    return Math.max(0, Math.min(100, Math.round(((clientX - r.left) / Math.max(1, r.width)) * 100)))
  }

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (disabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = ref.current
    if (!el) return
    const id = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    const mouse = e.pointerType === 'mouse'
    let mode: 'wait' | 'drag' = 'wait'
    el.dataset.pressed = ''
    const begin = (x: number) => {
      mode = 'drag'
      clearCeiling()
      setDrag(true)
      try { el.setPointerCapture(id) } catch { /* pointer gone */ }
      cb.current.onStart?.()
      hold(at(x))
    }
    if (mouse) begin(x0)
    const end = () => {
      delete el.dataset.pressed
      setDrag(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      if (mode === 'wait') {
        const dx = Math.abs(ev.clientX - x0)
        const dy = Math.abs(ev.clientY - y0)
        if (dy > 8 && dy > dx) { end(); return }
        if (dx > 5 && dx >= dy) begin(ev.clientX)
        return
      }
      hold(at(ev.clientX))
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      if (mode === 'wait') {
        // a tap: the value under the finger
        clearCeiling()
        cb.current.onStart?.()
        hold(at(ev.clientX))
      } else {
        hold(at(ev.clientX))
      }
      end()
      commit()
    }
    // the OS took a drag away (notification, palm): keep what the finger chose; a scroll takeover sends nothing
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      end()
      if (mode === 'drag') commit()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  // arrows move the held value; the key up sends it, so a held key is one command
  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0
    if (!step) return
    e.preventDefault()
    if (!keying.current) {
      keying.current = true
      clearCeiling()
      cb.current.onStart?.()
    }
    hold(Math.max(0, Math.min(100, (unknown ? 50 : v) + step)))
  }
  const keyUp = () => {
    if (!keying.current) return
    keying.current = false
    commit()
  }
  const blur = () => {
    // focus left mid-arrow (no key up will come): send what was chosen
    if (keying.current) keyUp()
  }

  const vars: Vars = { '--v': v }
  return (
    <div
      ref={ref}
      className="lt-sl"
      data-size={size}
      data-look={look}
      data-unknown={unknown || undefined}
      data-drag={drag || undefined}
      data-disabled={disabled || undefined}
      data-no-swipe
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unknown ? undefined : v}
      aria-valuetext={unknown ? 'brightness unknown' : undefined}
      aria-disabled={disabled || undefined}
      style={vars}
      onPointerDown={down}
      onKeyDown={key}
      onKeyUp={keyUp}
      onBlur={blur}
    >
      <div className="lt-sl-bar">
        <div className="lt-sl-fill" />
        <div className="lt-sl-head" data-zero={v === 0 || undefined}><i /></div>
      </div>
      {readout !== undefined && (held !== null || (readout && !unknown)) && (
        <span className="lt-sl-reads">
          <span className="lt-sl-read">{v}<small>%</small></span>
          <span className="lt-sl-in" aria-hidden><span className="lt-sl-read">{v}<small>%</small></span></span>
        </span>
      )}
    </div>
  )
}
