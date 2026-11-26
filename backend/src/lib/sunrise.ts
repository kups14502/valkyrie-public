import { haBrightnessFor } from './lightScale.js'

// A one-time sunrise on one light: a Home Assistant automation that ramps the
// bulb from a dim warm white up to full cool white by a wake time, then leaves
// it on. Raven's light_sunrise plans one (lib/raven/tools/lights.ts) and
// routes/lights.ts saves it in HA. Pure: no Home Assistant, no clock.
//
// The design is the first one, written by hand for the Bedroom on 2026-11-26
// and tried on this HA with a logbook-only copy (scripts/fixtures/
// sunrise-bedroom-2026-11-26.json is that automation, and the smoke tests hold
// this builder to it):
// - a tick every minute and HA's own start trigger it; a condition keeps it to
//   its date and its window (start to 5 minutes past the end). Mode single with
//   max_exceeded silent: a running ramp ignores the ticks, and a dead run (HA
//   restarted, a step failed) picks up on the next tick
// - every value comes from the wall clock, never from a counter, so a resumed
//   run lands where the ramp should be by then
// - each step sends brightness and color_temp_kelvin together: HA's Cync light
//   sends one combo packet and fills a missing field from its cached copy of
//   the bulb, which can hold an old color (routes/lights.ts, the notes on top)
// - brightness is (255 * p + 99) // 100, the least HA brightness that HA's
//   int(b / 255 * 100) turns back into p: every percent lands exactly, which
//   brightness_pct does not do. It is the number haBrightnessFor gives.
// - a change by hand stops it: the run logs that, switches itself off and
//   stops. A change by hand is the light off with its switch after armed (the
//   start, or the moment it was scheduled when that came later) plus 5 s, or
//   any state of the light written with a user's context after armed plus 5 s
//   (Valkyrie or the HA app; the ramp's own steps carry no user). An off that
//   lands within 2 minutes after this automation was loaded does not count:
//   HA writes every Cync light as off when it starts, before the cloud reports
//   the real state, and a restart mid-ramp must resume, not stop
// - a run still going 10 minutes after the end (a Cync call that hung while
//   the cloud was down) stops without the full-brightness send
// - after the end it sends full brightness and the last kelvin, again a minute
//   later, writes a logbook line and switches itself off
//
// Every sunrise carries its own facts as automation variables (`sunrise`), so
// listing one never reads its templates.
//
// HA's today_at() and now() compare and subtract as wall clock, and today_at()
// is always the day it renders on. So checkSunrise keeps every step of a run on
// its own date (an end after 23:53 is refused) and clear of a clock change (in
// spring 2:00 to 3:00 AM never happens, in the fall 1:00 to 2:00 AM happens
// twice).

export const SUNRISE_VERSION = 1
/** seconds between two steps of the ramp */
export const SUNRISE_STEP_S = 15
/** the last command goes out once more this long after the end */
export const SUNRISE_SETTLE_S = 60
/** a tick up to this long after the end still finishes a run HA dropped */
export const SUNRISE_RESUME_MIN = 5
/** how long a ramp can be */
export const SUNRISE_MINUTES = { min: 5, max: 120 } as const
/** after the end a run can still be going this long: a tick until the window closes, the settle, and a minute for the steps */
const SUNRISE_TAIL_S = SUNRISE_RESUME_MIN * 60 + SUNRISE_SETTLE_S + 60

/** One sunrise: New York date and wall clock, the light, and the ramp. */
export type SunriseMeta = {
  version: number
  entity: string
  /** the light's Valkyrie name: the id and the alias use it */
  light: string
  /** YYYY-MM-DD */
  date: string
  /** HH:mm */
  start: string
  /** HH:mm, full brightness from here on */
  end: string
  /**
   * HH:mm:ss. The light found off with a change after this (plus 5 s) was turned off by hand: the start, or the
   * moment it was scheduled when that came later, so a light switched off just before the ask does not stop it.
   */
  armed: string
  fromPercent: number
  toPercent: number
  fromKelvin: number
  toKelvin: number
}

/** A sunrise that cannot be one (a bad date, time, light or level). */
export class SunriseError extends Error {}

/** The id every sunrise has: sunrise_<light>_<YYYY>_<MM>_<DD>, one per light per date. */
export const SUNRISE_ID_RE = /^sunrise_[a-z0-9]+(?:_[a-z0-9]+)*_\d{4}_\d{2}_\d{2}$/

export const lightSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/** "sunrise_bedroom_2026_11_26" */
export function sunriseId(light: string, date: string): string {
  const slug = lightSlug(light)
  if (!slug || !realDate(date)) throw new SunriseError(`no sunrise id for "${light}" on "${date}"`)
  return `sunrise_${slug}_${date.replaceAll('-', '_')}`
}

// ---- wall clock, as text ----

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const HMS_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/

/** A real YYYY-MM-DD. */
export const realDate = (s: string): boolean => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00Z`) : NaN
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
}
/** A real HH:mm, 00:00 to 23:59. */
export const realHm = (s: string): boolean => HM_RE.test(s)

const secondsOf = (t: string): number => {
  const [h, m, s = '0'] = t.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}
const two = (n: number) => String(n).padStart(2, '0')
const clockOf = (sec: number): string => `${two(Math.floor(sec / 3600))}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`

/** HH:mm this many minutes before, or null when that is the day before. */
export function hmBefore(hm: string, minutes: number): string | null {
  const m = secondsOf(hm) / 60 - minutes
  return m < 0 ? null : clockOf(m * 60).slice(0, 5)
}

/** HH:mm:ss the window to finish a run closes: 5 minutes past the end, at the latest the day's last second. */
export const sunriseWindowEnd = (end: string): string => clockOf(Math.min(secondsOf(end) + SUNRISE_RESUME_MIN * 60, 24 * 3600 - 1))

// ---- New York clock ----

const NY_FACE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
/** New York's wall clock at an instant, as a UTC clock face in whole seconds. */
function nyFace(ms: number): number {
  const p: Record<string, number> = {}
  for (const x of NY_FACE.formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
}
const nyOffsetMs = (ms: number) => nyFace(ms) - Math.floor(ms / 1000) * 1000
const nextDate = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** The instant a New York date and HH:mm or HH:mm:ss is. */
export function nyInstant(date: string, hms: string): number {
  const face = Date.parse(`${date}T${hms.length === 5 ? `${hms}:00` : hms}Z`)
  return face - nyOffsetMs(face - nyOffsetMs(face))
}

/**
 * The wall-clock span a clock change on this New York date skips (forward) or runs twice (back), as seconds of the
 * day, from (inclusive) to (exclusive). null on every other date.
 */
export function clockChange(date: string): { from: number; to: number; forward: boolean } | null {
  let a = nyInstant(date, '00:00')
  let b = nyInstant(nextDate(date), '00:00') - 1000
  const after = nyOffsetMs(b)
  if (nyOffsetMs(a) === after) return null
  // the old offset at a, the new one at b: close in on the first second of the new one
  while (b - a > 1000) {
    const mid = a + Math.floor((b - a) / 2000) * 1000
    if (nyOffsetMs(mid) === after) b = mid
    else a = mid
  }
  const day0 = Date.parse(`${date}T00:00:00Z`)
  const was = (nyFace(a) - day0) / 1000 + 1
  const is = (nyFace(b) - day0) / 1000
  return { from: Math.min(was, is), to: Math.max(was, is), forward: is > was }
}

/** Where the ramp is at a share (0 to 1) of its length. */
export function rampAt(m: Pick<SunriseMeta, 'fromPercent' | 'toPercent' | 'fromKelvin' | 'toKelvin'>, f: number): { percent: number; kelvin: number } {
  const x = Math.max(0, Math.min(1, f))
  return { percent: Math.round(m.fromPercent + (m.toPercent - m.fromPercent) * x), kelvin: Math.round(m.fromKelvin + (m.toKelvin - m.fromKelvin) * x) }
}

// ---- checking one ----

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi

/** The sunrise in x, every field checked, or a SunriseError that says which is wrong. lights: the entities allowed. */
export function checkSunrise(x: unknown, lights?: readonly string[]): SunriseMeta {
  const m = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const bad = (what: string): never => { throw new SunriseError(what) }
  if (m.version !== SUNRISE_VERSION) bad(`version must be ${SUNRISE_VERSION}`)
  const entity = typeof m.entity === 'string' ? m.entity : ''
  if (!/^light\.[a-z0-9_]+$/.test(entity) || (lights && !lights.includes(entity))) bad('entity is not one of the lights')
  const light = typeof m.light === 'string' ? m.light.trim() : ''
  if (!light || light.length > 60 || !lightSlug(light)) bad('light needs a name')
  const date = typeof m.date === 'string' ? m.date : ''
  if (!realDate(date)) bad('date must be a real YYYY-MM-DD')
  const start = typeof m.start === 'string' ? m.start : ''
  const end = typeof m.end === 'string' ? m.end : ''
  if (!realHm(start) || !realHm(end)) bad('start and end must be real HH:mm times')
  const minutes = (secondsOf(end) - secondsOf(start)) / 60
  if (minutes < SUNRISE_MINUTES.min || minutes > SUNRISE_MINUTES.max) bad(`a sunrise runs ${SUNRISE_MINUTES.min} to ${SUNRISE_MINUTES.max} minutes on one day`)
  // past midnight today_at() is the next day's, so the off check could never fire
  if (secondsOf(end) + SUNRISE_TAIL_S > 24 * 3600) bad(`the end must be ${clockOf(24 * 3600 - SUNRISE_TAIL_S).slice(0, 5)} or earlier, so its last steps finish on its date`)
  const change = clockChange(date)
  if (change && secondsOf(start) < change.to && secondsOf(end) + SUNRISE_TAIL_S > change.from) {
    const hm = (sec: number) => clockOf(sec).slice(0, 5)
    const by = change.from - SUNRISE_TAIL_S
    bad(`the clocks go ${change.forward ? 'forward' : 'back'} on ${date} and ${hm(change.from)} to ${hm(change.to)} `
      + `${change.forward ? 'does not happen' : 'happens twice'}: a sunrise that day must ${by >= 0 ? `end by ${hm(by)} or ` : ''}start at ${hm(change.to)} or later`)
  }
  const armed = typeof m.armed === 'string' ? m.armed : ''
  if (!HMS_RE.test(armed) || secondsOf(armed) < secondsOf(start) || secondsOf(armed) >= secondsOf(end)) bad('armed must be an HH:mm:ss from the start to before the end')
  if (!isInt(m.fromPercent, 1, 100) || !isInt(m.toPercent, 1, 100)) bad('percents are whole numbers 1 to 100')
  if (!isInt(m.fromKelvin, 1000, 10000) || !isInt(m.toKelvin, 1000, 10000)) bad('kelvins are whole numbers 1000 to 10000')
  return {
    version: SUNRISE_VERSION, entity, light, date, start, end, armed,
    fromPercent: m.fromPercent as number, toPercent: m.toPercent as number, fromKelvin: m.fromKelvin as number, toKelvin: m.toKelvin as number,
  }
}

// ---- the automation ----

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clock12 = (hm: string) => {
  const h = Number(hm.slice(0, 2))
  return { t: `${h % 12 || 12}:${hm.slice(3, 5)}`, ap: h < 12 ? 'AM' : 'PM' }
}

/** "Sunrise: Bedroom, Thu 2026-11-26 10:30-11:00 AM" */
export function sunriseAlias(m: Pick<SunriseMeta, 'light' | 'date' | 'start' | 'end'>): string {
  const [y, mo, d] = m.date.split('-').map(Number)
  const dow = DOW[new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay()]
  const s = clock12(m.start)
  const e = clock12(m.end)
  return `Sunrise: ${m.light}, ${dow} ${m.date} ${s.ap === e.ap ? `${s.t}-${e.t} ${e.ap}` : `${s.t} ${s.ap}-${e.t} ${e.ap}`}`
}

/** The HA automation config for one sunrise. stepS, settleS and windowEnd (HH:mm:ss) are fixed in use; the fixture test names them. */
export function buildSunrise(m: SunriseMeta, o: { stepS?: number; settleS?: number; windowEnd?: string } = {}): Record<string, unknown> {
  const step = o.stepS ?? SUNRISE_STEP_S
  const settle = o.settleS ?? SUNRISE_SETTLE_S
  const start = `${m.start}:00`
  const end = `${m.end}:00`
  const alias = sunriseAlias(m)
  const e = m.entity
  const S = `today_at('${start}')`
  const E = `today_at('${end}')`
  const W = `today_at('${o.windowEnd ?? sunriseWindowEnd(m.end)}')`
  const A = `today_at('${m.armed}')`
  const self = '{{ this.entity_id }}'
  const L = `states['${e}']`
  const hand = `{{ (is_state('${e}', 'off') and ${L}.last_changed > ${A} + timedelta(seconds=5)`
    + ` and ${L}.last_changed > states[this.entity_id].last_changed + timedelta(seconds=120))`
    + ` or (${L}.context.user_id is not none and ${L}.last_updated > ${A} + timedelta(seconds=5)) }}`
  const quit = (where: string, why: string) => [
    { action: 'logbook.log', data: { name: alias, message: `stopped ${where}: ${why}`, entity_id: self } },
    { action: 'automation.turn_off', target: { entity_id: self }, data: { stop_actions: false } },
    { stop: why },
  ]
  const offCheck = (where: string) => ({
    if: [{ condition: 'template', value_template: hand }],
    then: quit(where, 'the light was changed by hand during the sunrise'),
  })
  const send = (b: number | string, k: number | string) => ({
    action: 'light.turn_on', continue_on_error: true, target: { entity_id: e }, data: { brightness: b, color_temp_kelvin: k },
  })
  const span = `((${E}) - (${S})).total_seconds()`
  const last = haBrightnessFor(m.toPercent)
  return {
    id: sunriseId(m.light, m.date),
    alias,
    description: `One-time sunrise on ${e}, ${m.date} ${start} to ${end} New York time: ${m.fromPercent}% ${m.fromKelvin}K up to `
      + `${m.toPercent}% ${m.toKelvin}K in steps every ${step} s, then it stays on. A tick every minute resumes it after an HA restart or a `
      + 'failed step. It stops (and disables itself) if the light is turned off or changed by hand during the ramp, and disables itself when done.',
    mode: 'single',
    max_exceeded: 'silent',
    trace: { stored_traces: 100 },
    variables: { sunrise: { ...m } },
    triggers: [{ trigger: 'time_pattern', minutes: '/1', id: 'tick' }, { trigger: 'homeassistant', event: 'start', id: 'ha_start' }],
    conditions: [{ condition: 'template', value_template: `{{ now().strftime('%Y-%m-%d') == '${m.date}' and ${S} <= now() < ${W} }}` }],
    actions: [
      {
        repeat: {
          while: [{ condition: 'template', value_template: `{{ now() < ${E} }}` }],
          sequence: [
            offCheck('mid-ramp'),
            {
              variables: {
                f: `{% set x = (now() - ${S}).total_seconds() / ${span} %}{{ [[x, 0] | max, 1] | min }}`,
                p: `{{ (${m.fromPercent} + ${m.toPercent - m.fromPercent} * f) | round(0) | int }}`,
                b: '{{ ((255 * p + 99) // 100) | int }}',
                k: `{{ (${m.fromKelvin} + ${m.toKelvin - m.fromKelvin} * f) | round(0) | int }}`,
              },
            },
            send('{{ b }}', '{{ k }}'),
            { delay: { seconds: step } },
          ],
        },
      },
      { if: [{ condition: 'template', value_template: `{{ now() >= ${E} + timedelta(minutes=10) }}` }], then: quit('late', 'the ramp was held up past its end') },
      offCheck('at the end'),
      send(last, m.toKelvin),
      { delay: { seconds: settle } },
      offCheck('after the end'),
      send(last, m.toKelvin),
      { action: 'logbook.log', data: { name: alias, message: `finished: ${m.toPercent}% ${m.toKelvin}K, staying on`, entity_id: self } },
      { action: 'automation.turn_off', target: { entity_id: self }, data: { stop_actions: false } },
    ],
  }
}

/** The automation carries this feature's own facts block (only those are ever cleaned up on their own). */
export const ownSunrise = (config: unknown): boolean => {
  const v = (config as { variables?: { sunrise?: unknown } } | null)?.variables?.sunrise
  return !!v && typeof v === 'object'
}

/**
 * The sunrise an automation config is, from its facts block, or for one saved before the block existed (the first,
 * by hand) from its description and alias, which this builder writes the same way. null when it is not one.
 */
export function sunriseOf(config: unknown): SunriseMeta | null {
  const c = (config && typeof config === 'object' ? config : {}) as { variables?: { sunrise?: unknown }; description?: unknown; alias?: unknown }
  if (ownSunrise(c)) {
    try { return checkSunrise(c.variables!.sunrise) } catch { return null }
  }
  const d = /^One-time sunrise on (light\.[a-z0-9_]+), (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):00 to (\d{2}:\d{2}):00 New York time: (\d+)% (\d+)K up to (\d+)% (\d+)K /
    .exec(String(c.description ?? ''))
  const a = /^Sunrise: (.+), [A-Z][a-z]{2} \d{4}-\d{2}-\d{2} /.exec(String(c.alias ?? ''))
  if (!d || !a) return null
  try {
    return checkSunrise({
      version: SUNRISE_VERSION, entity: d[1], light: a[1], date: d[2], start: d[3], end: d[4], armed: `${d[3]}:00`,
      fromPercent: Number(d[5]), fromKelvin: Number(d[6]), toPercent: Number(d[7]), toKelvin: Number(d[8]),
    })
  } catch {
    return null
  }
}
