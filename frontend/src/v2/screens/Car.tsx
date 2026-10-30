import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useShell, type ScreenProps } from '../kit/shell'
import { Press, cx, dismissToast, toast } from '../kit/ui'
import { Icon, type IconName } from '../kit/icons'
import { ago, useHosts, useLive, useTick, type HostVM } from '../kit/data'
import { Hero, hostModel } from '../kit/hero'
import { useSetting } from '../kit/theme'
import { useReducedMotion } from '../kit/motion'
import {
  CarCommandError, KEY_URL, carPlace, fetchCar, mapUrl, reviveCar, sendCarCommand,
  type CarAction, type CarVM, type Door, type LevelControl, type Opening, type Seat, type Tire,
} from '../kit/vehicle'
import './car.css'

// Car: the car on Home Assistant's Tesla Fleet integration, its Model Y
// wireframe large (glowing by the live reading, as on System > Hosts), the
// battery, range and charging line, and its controls in plain groups:
// Security (lock, sentry), Climate (on, temperature, defrost, a seat map,
// the wheel), Charging (start and stop, the limit, the current, the port),
// Openings (frunk, trunk, windows), Quick (flash, honk, wake) and Status
// (tires, odometer, software, home or away with a Map button).
//
// Every control writes through POST /api/vehicles/:id/command (kit/vehicle.ts).
// A press shows its result at once with the control marked busy; a failure
// puts the real state back, marks the control and toasts why. Unlock, the
// frunk, opening the trunk, venting the windows, opening the charge port and
// the horn take two taps (the second within 4 s). A sleeping car is woken by
// Home Assistant before the command, which can take about 30 s: the header
// says so while it runs. Steppers and the seat map send once the taps stop;
// the limit bar sends on release.
//
// The car's position never shows as text: Map opens Apple Maps (or Google
// Maps off Apple devices) with it, built at the tap.
// Phone: one column. iPad: the car and its status | the controls. Desktop:
// the car | security and climate | charging, openings and quick.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

/** how long an armed two-tap button waits for its second tap */
const ARM_MS = 4000
/** a stepper (temperature, current) sends once the taps stop for this long */
const STEP_SETTLE_MS = 1100
/** a seat sends its level once the taps stop for this long */
const SEAT_SETTLE_MS = 900
/** a failed control stays marked this long */
const FAILED_MS = 3500

const NY = 'America/New_York'
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' })
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
/** "2:00 PM" today, "Sun 9:00 AM" another day (New York time; the caller adds ET) */
const when = (ms: number, now: number) => (fmtDayKey.format(ms) === fmtDayKey.format(now) ? fmtTime.format(ms) : `${fmtWeekday.format(ms)} ${fmtTime.format(ms)}`)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const title = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

const STATE_WORD: Record<CarVM['state'], string> = { awake: 'Awake', asleep: 'Asleep', offline: 'Offline', unknown: 'Online' }
const CHARGE_WORD: Record<NonNullable<CarVM['charge']['state']>, string> = {
  starting: 'Starting to charge', charging: 'Charging', stopped: 'Charging stopped', complete: 'Charge complete', disconnected: 'Unplugged', no_power: 'No power at the charger',
}
const DOOR_WORD: Record<Door, string> = { front_driver: 'Driver', front_passenger: 'Passenger', rear_driver: 'Rear left', rear_passenger: 'Rear right' }
const SEAT_WORD: Record<Seat, string> = {
  front_left: 'Driver', front_right: 'Passenger', rear_left: 'Rear left', rear_center: 'Rear middle', rear_right: 'Rear right', third_row_left: 'Third left', third_row_right: 'Third right',
}
const SEAT_SHORT: Record<Seat, string> = {
  front_left: 'Driver', front_right: 'Passenger', rear_left: 'Left', rear_center: 'Middle', rear_right: 'Right', third_row_left: 'Left', third_row_right: 'Right',
}
const SEAT_ROWS: Seat[][] = [['front_left', 'front_right'], ['rear_left', 'rear_center', 'rear_right'], ['third_row_left', 'third_row_right']]
const OPEN_WORD: Record<Opening, string> = { open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing' }
const TIRE_WORD: Record<Tire, string> = { fl: 'Front left', fr: 'Front right', rl: 'Rear left', rr: 'Rear right' }
/** the model's diamonds and the group each one opens */
const SPOT_GROUP: Record<string, string> = { battery: 'charging', charge: 'charging', cabin: 'climate' }

const isCharging = (s: CarVM['charge']['state']) => s === 'charging' || s === 'starting'

// ---------- commands: what was asked, shown at once, the real state back on a failure ----------

type Pend = { action: CarAction; want: unknown; seq: number; asleep: boolean }
type Ctl = {
  v: CarVM
  /** Home Assistant can reach the car */
  reach: boolean
  has: (a: CarAction) => boolean
  pend: (key: string) => Pend | null
  /** the value a control shows: what was asked while its command is out, else the car's */
  want: <T>(key: string, real: T) => T
  failed: (key: string) => boolean
  send: (key: string, action: CarAction, value: number | string | undefined, want: unknown, label: string) => void
}

let cmdSeq = 0
const omit = <T,>(o: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

/**
 * The car's commands. One per control at a time (a press while its command is
 * out does nothing). The asked-for value is laid over the car's state until
 * the answer lands; the answer carries the car's fresh state (the backend
 * reads it right after the command), which replaces the view, success or not.
 */
function useCommands(id: string, view: CarVM | null) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<Record<string, Pend>>({})
  const [failedAt, setFailedAt] = useState<Record<string, number>>({})
  /** the newest command's word on the car's key; null = go by the view */
  const [keyLost, setKeyLost] = useState<boolean | null>(null)
  const out = useRef(new Set<string>())
  // commands out on a sleeping car, and the toast that says so (the head may be scrolled away)
  const waking = useRef<{ n: number; toast: number }>({ n: 0, toast: 0 })
  const asleep = useRef(false)
  useLayoutEffect(() => { asleep.current = view?.state === 'asleep' })

  useEffect(() => {
    if (!Object.keys(failedAt).length) return
    const t = window.setTimeout(() => {
      setFailedAt((f) => Object.fromEntries(Object.entries(f).filter(([, at]) => Date.now() - at < FAILED_MS)))
    }, FAILED_MS)
    return () => window.clearTimeout(t)
  }, [failedAt])

  const send = useCallback((key: string, action: CarAction, value: number | string | undefined, want: unknown, label: string) => {
    if (out.current.has(key)) return
    out.current.add(key)
    const seq = ++cmdSeq
    setPending((p) => ({ ...p, [key]: { action, want, seq, asleep: asleep.current } }))
    setFailedAt((f) => (key in f ? omit(f, key) : f))
    const put = (v: CarVM | null) => { if (v) qc.setQueryData(['v2', `car.${id}`], v) }
    const wakes = asleep.current
    if (wakes) {
      waking.current.n++
      waking.current.toast = toast('Waking the car. A command on a sleeping car can take 30 s.', { ms: 45_000 })
    }
    sendCarCommand(id, action, value)
      .then((r) => {
        put(r.view)
        setKeyLost(false)
        void qc.invalidateQueries({ queryKey: ['v2', 'hosts'] })
      })
      .catch((e: unknown) => {
        const err = e instanceof CarCommandError ? e : null
        put(err?.view ?? null)
        if (err?.keyMissing) setKeyLost(true)
        setFailedAt((f) => ({ ...f, [key]: Date.now() }))
        toast(`${label} failed: ${err?.keyMissing ? "the car does not have Valkyrie's key" : err?.message ?? 'no answer'}`, err?.keyMissing
          ? { ms: 9000, action: { label: 'Add key', run: () => { window.open(KEY_URL, '_blank', 'noopener,noreferrer') } } }
          : { ms: 5000 })
      })
      .finally(() => {
        out.current.delete(key)
        if (wakes && --waking.current.n <= 0) { waking.current.n = 0; dismissToast(waking.current.toast) }
        setPending((p) => (p[key]?.seq === seq ? omit(p, key) : p))
      })
  }, [id, qc])

  return { pending, failedAt, keyLost, send }
}

/** A two-tap button's state: the first tap arms, the second (within ARM_MS) fires. */
function useArm(): [boolean, (v: boolean) => void] {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  return [armed, setArmed]
}

// ---------- the screen ----------

export default function Car({ active }: ScreenProps) {
  const { setPose } = useShell()
  const hosts = useHosts()
  const cars = (hosts.data ?? []).filter((h) => h.vehicle)
  const [pick, setPick] = useSetting<string>('carPick', '')
  const host = cars.find((h) => h.id === pick) ?? cars[0] ?? null
  // mounts the first time the tab opens: no reads and no model until then
  const [seen, setSeen] = useState(active)
  if (active && !seen) setSeen(true)
  useEffect(() => { if (active) setPose('car') }, [active, setPose])

  if (!seen) return <div className="vl-screen car" />
  if (!host) {
    return (
      <div className="vl-screen car">
        <div className="car-empty vl-build" style={iv(0)}>
          <Icon name="car" size={22} tone="dim" />
          <b>{hosts.data ? 'No car on Home Assistant' : hosts.failed ? 'Hosts unreachable' : 'Loading the car'}</b>
          {hosts.data && <span>Valkyrie shows a car once Home Assistant's Tesla Fleet integration reports one.</span>}
        </div>
      </div>
    )
  }
  return <CarScreen key={host.id} host={host} cars={cars} active={active} onPick={setPick} />
}

function CarScreen({ host, cars, active, onPick }: { host: HostVM; cars: HostVM[]; active: boolean; onPick: (id: string) => void }) {
  const id = host.id
  const { setCenter, scroller } = useShell()
  const reduced = useReducedMotion()
  const now = useTick(active ? 5000 : 60_000)
  const q = useLive<CarVM>(`car.${id}`, () => fetchCar(id), active ? 10_000 : 120_000, { revive: reviveCar })
  const v = q.data ?? null
  const cmd = useCommands(id, v)
  const hv = host.vehicle!

  // the header reads the view, else the host list's reading of the same car
  const state = v?.state ?? hv.state
  const online = v ? v.online : host.online
  const battery = v?.battery ?? host.battery?.percent ?? null
  const range = v?.rangeMi ?? hv.rangeMi
  const chState = v ? v.charge.state : hv.charging
  const kw = v ? v.charge.kw : hv.chargerKw
  const rate = v ? v.charge.rateMph : hv.chargeRateMph
  const fullAt = v ? v.charge.fullAt : hv.fullAt
  const label = v?.label ?? host.label
  const model = hostModel(id, v?.model ?? hv.model)
  const reach = !!v && online && state !== 'offline'
  const waking = Object.values(cmd.pending).some((p) => p.asleep)
  const keyMissing = cmd.keyLost ?? v?.keyMissing ?? false

  useEffect(() => {
    if (!active) return
    setCenter(battery != null ? `${label} ${battery}%${range != null ? ` · ${Math.round(range)} mi` : ''}` : label)
  }, [active, label, battery, range, setCenter])

  // a diamond opens its group: scrolled into view and lit for a moment
  const [focus, setFocus] = useState<{ group: string; spot: string } | null>(null)
  useEffect(() => {
    if (!focus) return
    const t = window.setTimeout(() => setFocus(null), 2600)
    return () => window.clearTimeout(t)
  }, [focus])
  const onSpot = (spot: string) => {
    const group = SPOT_GROUP[spot]
    if (!group) return
    setFocus({ group, spot })
    const el = document.querySelector<HTMLElement>(`.vl-page[data-screen="car"] [data-grp="${group}"]`)
    const sc = scroller()
    if (!el || !sc) return
    const r = el.getBoundingClientRect()
    const sr = sc.getBoundingClientRect()
    if (r.top < sr.top + 40 || r.top > sr.bottom - 120) sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - 8, behavior: reduced ? 'auto' : 'smooth' })
  }

  const ctl: Ctl | null = v ? {
    v,
    reach,
    has: (a) => v.actions.includes(a),
    pend: (key) => cmd.pending[key] ?? null,
    want: <T,>(key: string, real: T): T => (key in cmd.pending ? cmd.pending[key].want as T : real),
    failed: (key) => key in cmd.failedAt,
    send: cmd.send,
  } : null

  const read = v?.ts || host.ts
  const whenLine = state === 'asleep' && (v?.since ?? hv.since) ? `asleep since ${when((v?.since ?? hv.since) as number, now)} ET`
    : !online && read ? `last read ${when(read, now)} ET`
      : read ? `read ${ago(read, now)} ago` : null
  const charging = isCharging(chState)
  const chargeLine = charging
    ? [`Charging${kw ? ` ${kw} kW` : ''}`, rate ? `+${Math.round(rate)} mi/h` : null, fullAt ? `full ${when(fullAt, now)} ET` : null].filter(Boolean).join(' · ')
    : chState ? CHARGE_WORD[chState] : null
  const viewWhy = !v && q.failed ? carError(q.error) : null

  return (
    <div className="vl-screen car" data-state={state}>
      <div className="car-col car-col-a">
        <header className="car-head vl-build" style={iv(0)}>
          <div className="car-id">
            <Icon name="car" size={16} tone={!online ? 'faint' : state === 'asleep' ? 'dim' : 'fg'} glow={online && state === 'awake'} />
            <h2 className="car-name">{label}</h2>
            <span className="car-state" data-state={online ? state : 'offline'}>{online ? STATE_WORD[state] : 'Offline'}</span>
            {whenLine && <span className="car-when">{whenLine}</span>}
          </div>
          <div className="car-big">
            <span className="car-bat" data-low={(battery != null && battery < 20) || undefined}>
              <Icon name={charging ? 'charging' : 'battery'} size={18} tone={battery != null && battery < 20 ? 'acc2' : 'fg'} glow={charging} />
              <b>{battery ?? '--'}<small>%</small></b>
            </span>
            <span className="car-range"><b>{range != null ? Math.round(range) : '--'}<small>mi</small></b></span>
            {chargeLine && <span className="car-chg" data-on={charging || undefined}>{chargeLine}</span>}
          </div>
          {cars.length > 1 && (
            <div className="car-pick" role="tablist" aria-label="Cars">
              {cars.map((c) => (
                <Press key={c.id} className="car-pick-tab" role="tab" aria-selected={c.id === id} data-on={c.id === id || undefined} onPress={() => onPick(c.id)}>{c.label}</Press>
              ))}
            </div>
          )}
          {waking && (
            <div className="car-note car-waking" data-tone="hot" role="status">
              <Icon name="wake" size={14} tone="hot" glow className="vl-pulse" />
              <span>Waking the car. A command on a sleeping car can take 30 s.</span>
            </div>
          )}
          {!waking && state === 'asleep' && online && ctl && (
            <div className="car-note car-asleep">
              <Icon name="wake" size={14} tone="dim" />
              <span>Asleep. A command wakes it first, about 30 s.</span>
              {ctl.has('wake') && <Act c={ctl} k="wake" action="wake" label="Wake" busyLabel="Waking" icon="wake" small />}
            </div>
          )}
          {keyMissing && (
            <div className="car-note car-key" data-tone="acc2" role="alert">
              <Icon name="key" size={14} tone="acc2" glow />
              <span>Add Valkyrie's key to the car: open <a href={KEY_URL} target="_blank" rel="noopener noreferrer">tesla.com/_ak/kups14502.github.io</a> on your phone</span>
            </div>
          )}
          {!online && <div className="car-note" data-tone="acc2"><Icon name="offline" size={14} tone="acc2" /><span>Home Assistant cannot reach the car.</span></div>}
          {viewWhy && <div className="car-note" data-tone="acc2"><Icon name="alert" size={14} tone="acc2" /><span>Controls unavailable: {viewWhy}</span></div>}
          {!v && !q.failed && <div className="car-note"><span>Loading the controls</span></div>}
        </header>

        {model && (
          <div className="car-model vl-build" style={iv(1)}>
            <Hero
              active={active}
              pose="car"
              host={model}
              hostId={id}
              fill={0.92}
              layoutKey={`${id}:car`}
              className="absolute inset-0"
              activeHotspot={focus?.spot ?? null}
              onHotspot={onSpot}
            />
          </div>
        )}

        {ctl && <Status c={ctl} i={8} />}
      </div>

      {ctl && (
        <>
          <div className="car-col car-col-b">
            <Security c={ctl} i={2} />
            <Climate c={ctl} i={3} focus={focus?.group === 'climate'} />
          </div>
          <div className="car-col car-col-c">
            <Charging c={ctl} i={4} focus={focus?.group === 'charging'} now={now} />
            <Openings c={ctl} i={5} />
            <Quick c={ctl} i={6} />
          </div>
        </>
      )}
    </div>
  )
}

/** Why the control view did not load, in a few words. */
function carError(e: unknown): string {
  const x = (e ?? {}) as { response?: { status?: number; data?: { error?: unknown } }; message?: unknown }
  const msg = x.response?.data?.error
  if (typeof msg === 'string' && msg.trim()) return msg.slice(0, 90)
  if (x.response?.status === 404) return 'this server has no car controls yet'
  return typeof x.message === 'string' && x.message ? x.message.slice(0, 90) : 'no answer'
}

// ---------- building blocks: a group, a row, a two-tap action, a switch, a stepper, the limit bar ----------

function Group({ id, icon, label, value, lit, i, focus, children, foot }: {
  id: string
  icon: IconName
  label: string
  value?: ReactNode
  lit?: boolean
  i: number
  focus?: boolean
  children: ReactNode
  foot?: ReactNode
}) {
  return (
    <section className="car-grp vl-build" data-grp={id} data-focus={focus || undefined} style={iv(i)} aria-label={label}>
      <header className="car-grp-hd">
        <Icon name={icon} size={14} tone={lit ? 'fg' : 'dim'} glow={lit} />
        <span className="car-grp-label">{label}</span>
        {value != null && <span className="car-grp-val">{value}</span>}
      </header>
      <div className="car-rows">{children}</div>
      {foot && <div className="car-grp-foot">{foot}</div>}
    </section>
  )
}

function Row({ icon, lit, label, sub, children, k, busy, failed }: {
  icon: IconName
  lit?: boolean
  label: ReactNode
  sub?: ReactNode
  children?: ReactNode
  /** the control's key (tests and the failed mark find the row by it) */
  k?: string
  busy?: boolean
  failed?: boolean
}) {
  return (
    <div className="car-row" data-k={k} data-busy={busy || undefined} data-failed={failed || undefined}>
      <span className="car-row-id">
        <Icon name={icon} size={15} tone={failed ? 'acc2' : lit ? 'fg' : 'dim'} glow={lit && !failed} />
        <span className="car-row-text">
          <b>{label}</b>
          {sub != null && sub !== '' && <em>{sub}</em>}
        </span>
      </span>
      {children != null && <span className="car-row-ctl">{children}</span>}
    </div>
  )
}

/** A text button for one action; `confirm` takes two taps (the second within 4 s). */
function Act({ c, k, action, value, want, label, name, busyLabel, confirmLabel, confirm, icon, disabled, small, why }: {
  c: Ctl
  /** the control's key: one command per key at a time */
  k: string
  action: CarAction
  value?: number | string
  want?: unknown
  label: string
  /** what the failure toast calls it, default the label ("Open" alone says nothing) */
  name?: string
  busyLabel: string
  /** the armed text, default "<label>?" */
  confirmLabel?: string
  confirm?: boolean
  icon?: IconName
  disabled?: boolean
  small?: boolean
  /** why it is disabled (the tooltip and the accessible name) */
  why?: string
}) {
  const [armed, setArmed] = useArm()
  const p = c.pend(k)
  const busy = !!p && p.action === action
  const failed = c.failed(k) && !p
  const off = disabled || !c.reach || !c.has(action) || (!!p && !busy)
  const press = () => {
    if (busy || off) return
    if (confirm && !armed) { setArmed(true); return }
    setArmed(false)
    c.send(k, action, value, want, name ?? label)
  }
  const text = busy ? busyLabel : armed ? confirmLabel ?? `${label}?` : label
  return (
    <Press
      className={cx('car-act vl-btn-line', small && 'car-act-sm')}
      data-act={action}
      data-armed={armed || undefined}
      data-busy={busy || undefined}
      data-failed={failed || undefined}
      aria-busy={busy || undefined}
      aria-label={armed ? `Confirm: ${label}` : off && why ? `${label}: ${why}` : label}
      title={off && why ? why : undefined}
      disabled={off && !busy}
      onPress={press}
    >
      {icon && <Icon name={icon} size={13} tone={armed ? 'ink' : busy ? 'hot' : 'dim'} className={busy ? 'vl-pulse' : undefined} />}
      <span>{text}</span>
    </Press>
  )
}

/** An on/off switch for a pair of actions; it shows the asked-for side while its command is out. */
function Switch({ c, k, on: real, onAction, offAction, label, disabled }: {
  c: Ctl
  k: string
  on: boolean | null
  onAction: CarAction
  offAction: CarAction
  label: string
  disabled?: boolean
}) {
  const on = c.want(k, real)
  const p = c.pend(k)
  const failed = c.failed(k) && !p
  const off = disabled || !c.reach || !c.has(onAction) || !c.has(offAction)
  const press = () => {
    if (p || off) return
    c.send(k, on ? offAction : onAction, undefined, !on, `${label} ${on ? 'off' : 'on'}`)
  }
  return (
    <Press
      className="car-sw"
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      aria-busy={!!p || undefined}
      data-k={k}
      data-on={on || undefined}
      data-busy={p ? '' : undefined}
      data-failed={failed || undefined}
      disabled={off}
      onPress={press}
    >
      <span className="car-sw-word">{p ? (on ? 'Turning on' : 'Turning off') : on ? 'On' : on === false ? 'Off' : '--'}</span>
      <i className="car-sw-track" aria-hidden><i /></i>
    </Press>
  )
}

/**
 * A [-] value [+] stepper. Taps move a draft; once they stop for
 * STEP_SETTLE_MS the draft goes out as one command, and the value stays on
 * screen as the asked-for one until the car answers.
 */
function Stepper({ c, k, action, value: real, min, max, step, grid, unit, label, fmt = (n) => String(n), disabled }: {
  c: Ctl
  k: string
  action: CarAction
  value: number | null
  min: number
  max: number
  /** one tap */
  step: number
  /** the values the car takes (the temperature's 0.5, the current's step) */
  grid: number
  unit: string
  label: string
  fmt?: (n: number) => string
  disabled?: boolean
}) {
  const shownReal = c.want<number | null>(k, real)
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef(0)
  const cb = useRef({ c, real })
  useLayoutEffect(() => { cb.current = { c, real } })
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const p = c.pend(k)
  const failed = c.failed(k) && !p
  const off = disabled || !c.reach || !c.has(action)
  const shown = draft ?? shownReal
  const snap = (x: number) => clamp(min + Math.round((x - min) / grid) * grid, min, max)
  const bump = (d: number) => {
    if (off || p) return
    const next = snap((shown ?? (min + max) / 2) + d * step)
    setDraft(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setDraft(null)
      const { c: cc, real: r } = cb.current
      if (next !== r) cc.send(k, action, next, next, `${label} ${fmt(next)}${unit}`)
    }, STEP_SETTLE_MS)
  }
  return (
    <span className="car-step" role="group" aria-label={label} data-k={k} data-busy={p ? '' : undefined} data-failed={failed || undefined} data-draft={draft !== null || undefined}>
      <Press className="car-step-btn vl-hit" aria-label={`Lower ${label.toLowerCase()}`} disabled={off || !!p || (shown != null && shown <= min)} onPress={() => bump(-1)}>−</Press>
      <b className="car-step-val" aria-live="polite">{shown != null ? fmt(shown) : '--'}<small>{unit}</small></b>
      <Press className="car-step-btn vl-hit" aria-label={`Raise ${label.toLowerCase()}`} disabled={off || !!p || (shown != null && shown >= max)} onPress={() => bump(1)}>+</Press>
    </span>
  )
}

/**
 * The charge limit: a bar from min to max you drag or tap. A mouse sets it at
 * once; a finger on a sideways drag or on lift, and an upright move hands the
 * gesture back to the page. It sends once, on release (or on the arrow key's
 * key up).
 */
function LimitBar({ c, k, action, ctl, label }: {
  c: Ctl
  k: string
  action: CarAction
  ctl: { value: number | null; min: number; max: number; step: number }
  label: string
}) {
  const { min, max, step } = ctl
  const real = c.want<number | null>(k, ctl.value)
  const ref = useRef<HTMLDivElement>(null)
  const [held, setHeld] = useState<number | null>(null)
  const heldRef = useRef<number | null>(null)
  const keying = useRef(false)
  const cb = useRef({ c, value: ctl.value })
  useLayoutEffect(() => { cb.current = { c, value: ctl.value } })
  const p = c.pend(k)
  const failed = c.failed(k) && !p
  // no car to reach, or no such control: dimmed; a command still out: takes no new input, still lit
  const blocked = !c.reach || !c.has(action)
  const off = blocked || !!p
  const shown = held ?? real
  const snap = (x: number) => clamp(min + Math.round((x - min) / step) * step, min, max)
  const at = (clientX: number) => {
    const r = (ref.current?.querySelector('.car-bar-track') ?? ref.current)!.getBoundingClientRect()
    return snap(min + ((clientX - r.left) / Math.max(1, r.width)) * (max - min))
  }
  const hold = (n: number) => { heldRef.current = n; setHeld(n) }
  const commit = () => {
    const n = heldRef.current
    heldRef.current = null
    setHeld(null)
    const { c: cc, value } = cb.current
    if (n != null && n !== value) cc.send(k, action, n, n, `${label} ${n}%`)
  }
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (off) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = ref.current
    if (!el) return
    const pid = e.pointerId
    const x0 = e.clientX
    const y0 = e.clientY
    let mode: 'wait' | 'drag' = 'wait'
    const begin = (x: number) => {
      mode = 'drag'
      el.dataset.drag = ''
      try { el.setPointerCapture(pid) } catch { /* pointer gone */ }
      hold(at(x))
    }
    if (e.pointerType === 'mouse') begin(x0)
    const end = () => {
      delete el.dataset.drag
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
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
      if (ev.pointerId !== pid) return
      hold(at(ev.clientX))
      end()
      commit()
    }
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      end()
      if (mode === 'drag') commit()
      else { heldRef.current = null; setHeld(null) }
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }
  const key = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (off) return
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (!d) return
    e.preventDefault()
    keying.current = true
    hold(snap((heldRef.current ?? shown ?? min) + d * step))
  }
  const keyUp = () => {
    if (!keying.current) return
    keying.current = false
    commit()
  }
  const pct = shown == null ? 0 : ((shown - min) / Math.max(1, max - min)) * 100
  return (
    <div
      ref={ref}
      className="car-bar"
      role="slider"
      tabIndex={off ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown ?? undefined}
      aria-disabled={off || undefined}
      aria-busy={!!p || undefined}
      data-k={k}
      data-held={held !== null || undefined}
      data-busy={p ? '' : undefined}
      data-failed={failed || undefined}
      data-off={blocked || undefined}
      style={{ '--v': pct.toFixed(2) } as Vars}
      onPointerDown={down}
      onKeyDown={key}
      onKeyUp={keyUp}
      onBlur={keyUp}
    >
      <span className="car-bar-track"><i className="car-bar-fill" /><i className="car-bar-head" /></span>
      <b className="car-bar-val">{shown ?? '--'}<small>%</small></b>
    </div>
  )
}

// ---------- Security ----------

function Security({ c, i }: { c: Ctl; i: number }) {
  const { v } = c
  const locked = c.want('lock', v.security.locked)
  const sentry = c.want('sentry', v.security.sentry)
  const lockP = c.pend('lock')
  const open = [...v.security.doorsOpen.map((d) => `${DOOR_WORD[d]} door`), ...v.security.windowsOpen.map((d) => `${DOOR_WORD[d]} window`)]
  // the button follows the car, not the asked-for state: Unlock while it is (or reads) locked
  const unlockNext = lockP ? lockP.action === 'unlock' : v.security.locked !== false
  return (
    <Group id="security" icon={locked === false ? 'unlocked' : 'locked'} label="Security" lit={locked === false || !!sentry} value={locked == null ? null : locked ? 'Locked' : 'Unlocked'} i={i}>
      <Row k="lock" icon={locked === false ? 'unlocked' : 'locked'} lit={locked === false} busy={!!lockP} failed={c.failed('lock') && !lockP}
        label={locked == null ? 'Lock unknown' : locked ? 'Locked' : 'Unlocked'}
        sub={open.length ? `${open.join(', ')} open` : 'Doors and windows closed'}>
        {unlockNext
          ? <Act c={c} k="lock" action="unlock" want={false} label="Unlock" busyLabel="Unlocking" confirm icon="unlocked" />
          : <Act c={c} k="lock" action="lock" want={true} label="Lock" busyLabel="Locking" icon="locked" />}
      </Row>
      <Row k="sentry" icon="sentry" lit={!!sentry} label="Sentry" sub={sentry ? 'Cameras watching' : 'Off'}>
        <Switch c={c} k="sentry" on={v.security.sentry} onAction="sentry_on" offAction="sentry_off" label="Sentry" />
      </Row>
    </Group>
  )
}

// ---------- Climate ----------

function Climate({ c, i, focus }: { c: Ctl; i: number; focus?: boolean }) {
  const { v } = c
  const cl = v.climate
  const on = c.want('climate', cl.on)
  const temps = [cl.insideF != null ? `${Math.round(cl.insideF)}°F inside` : null, cl.outsideF != null ? `${Math.round(cl.outsideF)}°F out` : null].filter(Boolean).join(' · ')
  const fmtT = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const rear = cl.seats.some((s) => !s.seat.startsWith('front'))
  return (
    <Group id="climate" icon="fan" label="Climate" lit={!!on} value={on == null ? null : on ? 'On' : 'Off'} i={i} focus={focus}
      foot={!rear && cl.seats.length > 0 ? 'Rear seat heaters are off in Home Assistant.' : undefined}>
      <Row k="climate" icon="fan" lit={!!on} label="Climate" sub={temps || null}>
        <Switch c={c} k="climate" on={cl.on} onAction="climate_on" offAction="climate_off" label="Climate" />
      </Row>
      {cl.min != null && cl.max != null && (
        <Row k="temp" icon="temp" lit={!!on} label="Temperature" sub={`${fmtT(cl.min)} to ${fmtT(cl.max)}°${cl.unit}`}>
          <Stepper c={c} k="temp" action="climate_temp" value={cl.target} min={cl.min} max={cl.max} step={cl.unit === 'C' ? 0.5 : 1} grid={0.5} unit={`°${cl.unit}`} label="Temperature" fmt={fmtT} />
        </Row>
      )}
      <Row k="defrost" icon="defrost" lit={!!c.want('defrost', cl.defrost)} label="Defrost" sub="Full heat on the glass">
        <Switch c={c} k="defrost" on={cl.defrost} onAction="defrost_on" offAction="defrost_off" label="Defrost" />
      </Row>
      {cl.seats.length > 0 && <SeatMap c={c} />}
      {cl.wheel && <WheelRow c={c} wheel={cl.wheel} />}
    </Group>
  )
}

/**
 * The seat heaters, one plate per seat where it sits (driver on the left).
 * A tap steps the seat's level (off, low, medium, high, off); once the taps
 * stop the level goes out as one command.
 */
function SeatMap({ c }: { c: Ctl }) {
  const seats = c.v.climate.seats
  const [draft, setDraft] = useState<Partial<Record<Seat, string>>>({})
  const timers = useRef<Partial<Record<Seat, number>>>({})
  const cb = useRef(c)
  useLayoutEffect(() => { cb.current = c })
  useEffect(() => () => { for (const t of Object.values(timers.current)) window.clearTimeout(t) }, [])
  const rows = SEAT_ROWS.filter((r) => r.some((s) => seats.some((x) => x.seat === s)))
  const tap = (seat: Seat) => {
    const s = seats.find((x) => x.seat === seat)
    const k = `seat:${seat}`
    if (!s || !c.reach || !c.has(`seat_heat_${seat}`) || c.pend(k)) return
    const cur = draft[seat] ?? c.want(k, s.level) ?? s.options[0]
    const next = s.options[(s.options.indexOf(cur) + 1) % s.options.length]
    setDraft((d) => ({ ...d, [seat]: next }))
    window.clearTimeout(timers.current[seat])
    timers.current[seat] = window.setTimeout(() => {
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([x]) => x !== seat)))
      const cc = cb.current
      const real = cc.v.climate.seats.find((x) => x.seat === seat)?.level ?? null
      if (next !== real) cc.send(k, `seat_heat_${seat}`, next, next, `${SEAT_WORD[seat]} seat heat ${next}`)
    }, SEAT_SETTLE_MS)
  }
  return (
    <div className="car-seats" role="group" aria-label="Seat heaters">
      <span className="car-seats-label"><Icon name="seat" size={15} tone="dim" />Seats</span>
      <div className="car-seatmap">
        {rows.map((row) => (
          <div key={row.join()} className="car-seatrow" data-n={row.length}>
            {row.map((seat) => {
              const s = seats.find((x) => x.seat === seat)
              if (!s) return <span key={seat} className="car-seat" data-none aria-hidden />
              const k = `seat:${seat}`
              const p = c.pend(k)
              const level = draft[seat] ?? c.want(k, s.level)
              const n = level ? Math.max(0, s.options.indexOf(level)) : 0
              const steps = s.options.length - 1
              return (
                <Press
                  key={seat}
                  className="car-seat"
                  data-k={k}
                  data-seat={seat}
                  data-level={level ?? undefined}
                  data-on={n > 0 || undefined}
                  data-busy={p ? '' : undefined}
                  data-failed={(c.failed(k) && !p) || undefined}
                  data-draft={draft[seat] !== undefined || undefined}
                  aria-label={`${SEAT_WORD[seat]} seat heat: ${level ?? 'unknown'}. Tap for the next level`}
                  disabled={!c.reach || !c.has(`seat_heat_${seat}`)}
                  onPress={() => tap(seat)}
                >
                  <span className="car-seat-pips" aria-hidden>
                    {Array.from({ length: steps }, (_, j) => <i key={j} data-on={j < n || undefined} />)}
                  </span>
                  <span className="car-seat-name">{SEAT_SHORT[seat]}</span>
                  <span className="car-seat-level">{level ? title(level) : '--'}</span>
                </Press>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The steering wheel heater: its levels as small plates, the lit one is the wheel's. */
function WheelRow({ c, wheel }: { c: Ctl; wheel: LevelControl }) {
  const level = c.want('wheel', wheel.level)
  const p = c.pend('wheel')
  const off = !c.reach || !c.has('wheel_heat')
  return (
    <Row k="wheel" icon="wheel" lit={!!level && level !== wheel.options[0]} label="Wheel" busy={!!p} failed={c.failed('wheel') && !p}>
      <span className="car-opts" role="radiogroup" aria-label="Steering wheel heat">
        {wheel.options.map((o) => (
          <Press
            key={o}
            className="car-opt"
            role="radio"
            aria-checked={o === level}
            data-on={o === level || undefined}
            disabled={off}
            onPress={() => { if (!p && o !== level) c.send('wheel', 'wheel_heat', o, o, `Wheel heat ${o}`) }}
          >
            {title(o)}
          </Press>
        ))}
      </span>
    </Row>
  )
}

// ---------- Charging ----------

function Charging({ c, i, focus, now }: { c: Ctl; i: number; focus?: boolean; now: number }) {
  const { v } = c
  const ch = v.charge
  const charging = isCharging(ch.state)
  const plugged = ch.cable === true || (ch.state != null && ch.state !== 'disconnected')
  const p = c.pend('charge')
  // the button follows the car (Stop while it charges), or the command that is out
  const startNext = p ? p.action === 'charge_start' : !(charging || ch.on === true)
  const port = c.want<Opening | null>('port', ch.port)
  const portP = c.pend('port')
  const line = charging
    ? [ch.kw ? `${ch.kw} kW` : null, ch.amps ? `${ch.amps} A` : null, ch.rateMph ? `+${Math.round(ch.rateMph)} mi/h` : null, ch.fullAt ? `full ${when(ch.fullAt, now)} ET` : null].filter(Boolean).join(' · ')
    : ch.addedKwh ? `${ch.addedKwh} kWh added last session` : null
  const state = ch.state ? CHARGE_WORD[ch.state] : plugged ? 'Plugged in' : 'Not plugged in'
  const openNext = portP ? portP.action === 'port_open' : ch.port !== 'open'
  return (
    <Group id="charging" icon={charging ? 'plugged' : 'plug'} label="Charging" lit={charging} value={ch.limit?.value != null ? `Limit ${c.want('limit', ch.limit.value)}%` : null} i={i} focus={focus}>
      <Row k="charge" icon={charging ? 'charging' : plugged ? 'plugged' : 'plug'} lit={charging} label={state} sub={line} busy={!!p} failed={c.failed('charge') && !p}>
        {startNext
          ? <Act c={c} k="charge" action="charge_start" want={true} label="Start" name="Charge start" busyLabel="Starting" icon="charging" disabled={!plugged} why="plug the car in first" />
          : <Act c={c} k="charge" action="charge_stop" want={false} label="Stop" name="Charge stop" busyLabel="Stopping" icon="stop" />}
      </Row>
      {ch.limit && (
        <div className="car-row car-row-bar" data-k="limit">
          <span className="car-row-id">
            <Icon name="gauge" size={15} tone="dim" />
            <span className="car-row-text"><b>Limit</b></span>
          </span>
          <LimitBar c={c} k="limit" action="charge_limit" ctl={ch.limit} label="Charge limit" />
        </div>
      )}
      {ch.current && (
        <Row k="amps" icon="plugged" label="Current" sub={`${ch.current.min} to ${ch.current.max} A`}>
          <Stepper c={c} k="amps" action="charge_amps" value={ch.current.value} min={ch.current.min} max={ch.current.max} step={ch.current.step} grid={ch.current.step} unit="A" label="Charge current" />
        </Row>
      )}
      <Row k="port" icon="plug" lit={port === 'open'} label="Charge port" sub={port ? OPEN_WORD[port] : null} busy={!!portP} failed={c.failed('port') && !portP}>
        {openNext
          ? <Act c={c} k="port" action="port_open" want="open" label="Open" name="Charge port open" busyLabel="Opening" confirm confirmLabel="Open port?" />
          : <Act c={c} k="port" action="port_close" want="closed" label="Close" name="Charge port close" busyLabel="Closing" />}
      </Row>
    </Group>
  )
}

// ---------- Openings ----------

function Openings({ c, i }: { c: Ctl; i: number }) {
  const { v } = c
  const frunk = c.want<Opening | null>('frunk', v.openings.frunk)
  const trunk = c.want<Opening | null>('trunk', v.openings.trunk)
  const windows = c.want<Opening | null>('windows', v.openings.windows)
  const trunkP = c.pend('trunk')
  const winP = c.pend('windows')
  const anyOpen = [frunk, trunk, windows].some((x) => x === 'open' || x === 'opening')
  const trunkOpenNext = trunkP ? trunkP.action === 'trunk_open' : v.openings.trunk !== 'open'
  const ventNext = winP ? winP.action === 'windows_vent' : v.openings.windows !== 'open'
  return (
    <Group id="openings" icon="cargo" label="Openings" lit={anyOpen} value={anyOpen ? 'Open' : 'All closed'} i={i}>
      <Row k="frunk" icon="cargo" lit={frunk === 'open'} label="Frunk" sub={frunk ? (frunk === 'open' ? 'Open: close it by hand' : OPEN_WORD[frunk]) : null}>
        {(v.openings.frunk !== 'open' || !!c.pend('frunk')) && <Act c={c} k="frunk" action="frunk_open" want="open" label="Open" name="Frunk open" busyLabel="Opening" confirm confirmLabel="Open frunk?" />}
      </Row>
      <Row k="trunk" icon="cargo" lit={trunk === 'open'} label="Trunk" sub={trunk ? OPEN_WORD[trunk] : null}>
        {trunkOpenNext
          ? <Act c={c} k="trunk" action="trunk_open" want="open" label="Open" name="Trunk open" busyLabel="Opening" confirm confirmLabel="Open trunk?" />
          : <Act c={c} k="trunk" action="trunk_close" want="closed" label="Close" name="Trunk close" busyLabel="Closing" />}
      </Row>
      <Row k="windows" icon="windows" lit={windows === 'open'} label="Windows" sub={windows ? (windows === 'open' ? 'Vented' : OPEN_WORD[windows]) : null}>
        {ventNext
          ? <Act c={c} k="windows" action="windows_vent" want="open" label="Vent" name="Windows vent" busyLabel="Venting" confirm confirmLabel="Vent?" />
          : <Act c={c} k="windows" action="windows_close" want="closed" label="Close" name="Windows close" busyLabel="Closing" />}
      </Row>
    </Group>
  )
}

// ---------- Quick ----------

function Quick({ c, i }: { c: Ctl; i: number }) {
  return (
    <Group id="quick" icon="flash" label="Quick" i={i}>
      <div className="car-quick">
        <Act c={c} k="flash" action="flash" label="Flash lights" busyLabel="Flashing" icon="flash" />
        <Act c={c} k="honk" action="honk" label="Honk" busyLabel="Honking" icon="honk" confirm />
        <Act c={c} k="wake" action="wake" label="Wake" busyLabel="Waking" icon="wake" />
      </div>
    </Group>
  )
}

// ---------- Status ----------

function Status({ c, i }: { c: Ctl; i: number }) {
  const { v } = c
  const st = v.status
  const sw = st.software
  const swLine = !sw ? null : sw.installing ? `Installing${sw.pct != null ? ` ${sw.pct}%` : ''}` : sw.available && sw.latest ? `${sw.latest} ready to install` : 'Up to date'
  const open = (e: RMouseEvent<HTMLAnchorElement>) => {
    const p = carPlace(v.id)
    if (!p) { e.preventDefault(); toast('No position for the car yet'); return }
    // the position goes into the link only now, at the tap
    e.currentTarget.href = mapUrl(p, v.label)
  }
  return (
    <section className="car-grp car-status vl-build" data-grp="status" style={iv(i)} aria-label="Status">
      <header className="car-grp-hd">
        <Icon name="gauge" size={14} tone="dim" />
        <span className="car-grp-label">Status</span>
      </header>
      <div className="car-rows">
        <Row k="tires" icon="tire" lit={st.tireWarn.length > 0} label="Tires" sub={st.tiresPsi ? null : 'Off in Home Assistant'}>
          {st.tiresPsi && (
            <span className="car-tires" aria-label="Tire pressure, psi">
              {(['fl', 'fr', 'rl', 'rr'] as Tire[]).map((t) => (
                <span key={t} className="car-tire" data-warn={st.tireWarn.includes(t) || undefined} title={TIRE_WORD[t]}>
                  {st.tiresPsi![t] != null ? Math.round(st.tiresPsi![t] as number) : '--'}
                </span>
              ))}
              <small>psi</small>
            </span>
          )}
        </Row>
        <Row k="odometer" icon="range" label="Odometer" sub={st.odometerMi == null ? 'Off in Home Assistant' : null}>
          {st.odometerMi != null && <b className="car-val">{st.odometerMi.toLocaleString('en-US')}<small>mi</small></b>}
        </Row>
        <Row k="software" icon="update" lit={!!sw?.available} label="Software" sub={swLine}>
          {sw?.installed && <b className="car-val car-val-sm">{sw.installed}</b>}
        </Row>
        <Row k="location" icon={st.home ? 'home' : 'away'} label={st.home == null ? 'Location unknown' : st.home ? 'Home' : 'Away'} sub={st.home === false ? 'Not at the home zone' : null}>
          {st.located && (
            <a className="car-act car-map vl-btn-line" href="#map" target="_blank" rel="noopener noreferrer" aria-label="Map: show where the car is" onClick={open}>
              <Icon name="map" size={13} tone="dim" />
              <span>Map</span>
            </a>
          )}
        </Row>
      </div>
      {v.online && v.state === 'asleep' && <div className="car-grp-foot">Read when the car fell asleep.</div>}
    </section>
  )
}
