import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'node:fs'

const router = Router()
const AUTH_FILE = '/home/brendon/.config/homeassistant/claude_auth.json'
const LIGHTS = [
  'light.office_lamp',
  'light.dresser',
  'light.nightsand',
  'light.tv_strip',
  'light.kitche_light',
]

// What the UI calls each bulb, where the HA friendly_name is not the name
// Brendon uses for the room it is in.
const DISPLAY_NAMES: Record<string, string> = {
  'light.dresser': 'Bedroom',
  'light.nightsand': 'Table',
}

type HAConfig = { token_id: string; jwt_key: string; ha_url: string }
let cfgCache: HAConfig | null = null

function getConfig(): HAConfig {
  if (!cfgCache) cfgCache = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as HAConfig
  return cfgCache
}

// One signed token reused until shortly before it expires, not one per request.
let tokenCache: { token: string; exp: number } | null = null
function makeToken(): string {
  const now = Math.floor(Date.now() / 1000)
  if (tokenCache && tokenCache.exp - now > 120) return tokenCache.token
  const cfg = getConfig()
  const token = jwt.sign({ iss: cfg.token_id }, cfg.jwt_key, { algorithm: 'HS256', expiresIn: 1800 })
  tokenCache = { token, exp: now + 1800 }
  return token
}

const HA_TIMEOUT_MS = 8_000

async function haRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const cfg = getConfig()
  const r = await fetch(`${cfg.ha_url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Without this a hung Home Assistant holds an Express handler (and the
    // bulb's queue behind it) open forever.
    signal: AbortSignal.timeout(HA_TIMEOUT_MS),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`HA ${method} ${path} -> ${r.status} ${txt}`.trim())
  }
  return r.json()
}

// ---------------------------------------------------------------------------
// What the bulbs actually do (Home Assistant history and recorder, 2026-10-11
// to 10-18, and HA's own cync/light.py and pycync 0.5.0)
//
// 1. HA's Cync light sends every turn_on as ONE combo packet: on, brightness
//    and a color. Any field the call leaves out is filled from HA's cached
//    copy of the bulb. A brightness-only call re-sends the cached color; a
//    color-only call re-sends the cached brightness.
// 2. That cache is often old. The office lamp's own changes mostly never
//    reach HA as a push: HA only learns them from the Cync coordinator's 30 s
//    status poll, and every push from another bulb restarts that 30 s timer.
//    So the lamp's state in HA lands about 31.5 s after the last command of a
//    burst (02:07:57, 14:49:18, 01:36:04, 01:01:59, 19:50:46, 14:39:37,
//    19:54:29 and 20:00:22, each 31 to 32 s after the other bulbs reported).
//    The other four push within 0.3 to 3 s, so theirs is old only mid-burst.
// 3. Put together: on 10-18 at 14:38:59 Amber went out, and 2 s later a
//    brightness-only 100% went out while HA still held the lamp at red from
//    03:23, so HA sent it red again. The Warm and Amber taps just before had
//    gone out pinned to brightness 111 (this file pinned color commands to the
//    last brightness HA reported, which was the stale one), 2 s after the lamp
//    was set to 255.
// 4. HA's Cync scaling is not symmetric: it sends int(b / 255 * 100) and
//    reports round((level + 1) * 255 / 101). 49 of the 100 percentages came
//    back as a different number, so a bulb "did not go where it was set" by 1%.
//
// So Valkyrie keeps its own copy of what each bulb was told, completes every
// command to on + brightness + color from it (never from HA's cache), sends
// one command at a time per bulb with the newest target winning, holds the
// target as the displayed state until the bulb reports it, and converts
// brightness so each percent lands exactly.
// ---------------------------------------------------------------------------

export type RGB = [number, number, number]
export type Color = { rgb: RGB } | { kelvin: number }
/** A bulb's whole state as Valkyrie means it. pct is the bulb's own 1-100 level; null = unknown. */
export type Full = { on: boolean; pct: number | null; color: Color | null }
/** What one /lights/turn asks of one bulb: anything left out is completed from the bulb's target. */
export type Patch = { state: 'on' | 'off'; pct?: number; color?: Color }
export type HAState = { entity_id?: string; state?: string; attributes?: Record<string, any>; last_updated?: string }

export type LightRow = {
  entity_id: string
  name: string
  on: boolean
  unavailable: boolean
  brightness: number | null
  rgb_color: RGB | null
  color_temp_kelvin: number | null
  color_mode: string | null
  supported_color_modes: string[]
  min_kelvin: number | null
  max_kelvin: number | null
  /** a command for this bulb has not been confirmed by the bulb yet: the row shows the target */
  pending: boolean
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// ---- brightness ----
//
// Three scales: the API's 0-255 (what the frontend's pctFromBrightness reads),
// the bulb's own 0-100 level, and HA's 0-255 for this integration. The API
// figure is round(pct * 2.55), so the frontend reads back exactly the percent
// the bulb is at.

/** HA's Cync light: the level it sends for a brightness. */
const cyncLevelSent = (b: number) => Math.trunc((b / 255) * 100)
/** HA's Cync light: the brightness it reports for a level. No .5 ties exist, so Math.round matches Python's round. */
const haReported = (level: number) => clamp(Math.round(((level + 1) * 255) / 101), 1, 255)

/** The brightness to send HA so the bulb lands on exactly this percent. */
export function haBrightnessFor(pct: number): number {
  const p = clamp(Math.round(pct), 1, 100)
  const start = Math.max(1, Math.floor(p * 2.55) - 1)
  for (let b = start; b <= Math.min(255, start + 4); b++) if (cyncLevelSent(b) === p) return b
  return clamp(Math.round(p * 2.55), 1, 255)
}

/** The bulb's percent from the brightness HA reports. */
export function pctFromHa(b: number): number {
  const v = Math.round((b * 101) / 255) - 1
  if (v >= 0 && v <= 100 && haReported(v) === b) return Math.max(1, v)
  return clamp(Math.round(b / 2.55), 1, 100)
}

export const apiBrightness = (pct: number) => clamp(Math.round(pct * 2.55), 1, 255)
export const pctFromApi = (b: number) => clamp(Math.round(b / 2.55), 1, 100)

// ---- color ----
//
// Bulbs report rgb scaled their own way (the office lamp reads [224, 0, 0] for
// red), so rgb is compared with the brightest channel scaled to 255.

const normRgb = (rgb: RGB): RGB => {
  const m = Math.max(rgb[0], rgb[1], rgb[2])
  if (m <= 0) return [0, 0, 0]
  return rgb.map((v) => clamp(Math.round((v * 255) / m), 0, 255)) as RGB
}
const RGB_TOL = 32
const KELVIN_TOL = 120

function colorClose(want: Color, got: Color): boolean {
  if ('rgb' in want) {
    if (!('rgb' in got)) return false
    const a = normRgb(want.rgb)
    const b = normRgb(got.rgb)
    return a.every((v, i) => Math.abs(v - b[i]) <= RGB_TOL)
  }
  return 'kelvin' in got && Math.abs(want.kelvin - got.kelvin) <= KELVIN_TOL
}

// ---- one reading of one bulb, from HA ----

type Reading = {
  /** HA's last_updated: when the bulb last reported a change */
  at: number
  unavailable: boolean
  full: Full
  attrs: Record<string, any>
}

function readingOf(s: HAState | undefined): Reading {
  const a = s?.attributes ?? {}
  const on = s?.state === 'on'
  const mode = typeof a.color_mode === 'string' ? a.color_mode : null
  let color: Color | null = null
  if (mode === 'color_temp' && typeof a.color_temp_kelvin === 'number') color = { kelvin: a.color_temp_kelvin }
  else if (mode !== 'color_temp' && Array.isArray(a.rgb_color) && a.rgb_color.length === 3) color = { rgb: normRgb(a.rgb_color as RGB) }
  return {
    at: Date.parse(s?.last_updated ?? '') || 0,
    unavailable: !s || s.state === 'unavailable',
    // A Cync bulb reports no brightness for a beat while it changes mode: unknown, never a guess.
    full: { on, pct: on && typeof a.brightness === 'number' ? pctFromHa(a.brightness) : null, color: on ? color : null },
    attrs: a,
  }
}

/** Is the bulb where the target says? A field the bulb has not reported counts as not there yet. */
function matches(r: Reading, t: Full): boolean {
  if (r.unavailable) return false
  if (!t.on) return !r.full.on
  if (!r.full.on) return false
  if (t.pct != null && (r.full.pct == null || Math.abs(r.full.pct - t.pct) > 1)) return false
  if (t.color && (!r.full.color || !colorClose(t.color, r.full.color))) return false
  return true
}

// ---------------------------------------------------------------------------
// The engine: one per backend, every client's commands go through it
// ---------------------------------------------------------------------------

export type HAClient = {
  states(): Promise<HAState[]>
  call(service: 'turn_on' | 'turn_off', body: Record<string, unknown>): Promise<void>
  /** homeassistant.update_entity: makes the Cync coordinator poll now instead of in up to 30 s. Touches no light. */
  refresh(entities: string[]): Promise<void>
}

export type Clock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

export const TUNING = {
  /** least time between two sends to one bulb; newer targets wait and replace each other meanwhile */
  minGapMs: 350,
  /** a report this soon after a send can be the bulb catching up (or an older command's echo): not judged yet */
  graceMs: 3_500,
  /** how long a target owns a bulb that has not reported it; covers the office lamp's ~31.5 s poll lag */
  holdMs: 40_000,
  /** after a bulb confirms, a different report inside this window gets the target sent once more */
  stickyMs: 15_000,
  /** the engine's own Home Assistant read cadence while a target is pending */
  verifyMs: 1_000,
  /** a client read this soon after the last one reuses it */
  readTtlMs: 600,
  /** ask HA to poll a bulb this long after a send it has not confirmed */
  refreshAfterMs: 2_000,
  /** and not more often than this (HA's own debounce is 10 s) */
  refreshGapMs: 10_000,
  /** how long after asking HA to poll its answer is in the state (the hub answers in about a second) */
  pollSettleMs: 2_000,
}
export type Tuning = typeof TUNING

type Waiter = { resolve: () => void; reject: (err: unknown) => void }

type Bulb = {
  id: string
  reading: Reading | null
  /** what Valkyrie believes the bulb is: the last target it confirmed, or what it last reported on its own */
  known: Full | null
  /** the last lit state, so switching back on restores it */
  lit: { pct: number | null; color: Color | null }
  /** the newest target, until the bulb reports it */
  want: Full | null
  /** want changed since the last send */
  dirty: boolean
  inflight: boolean
  resends: number
  lastSendStart: number
  /** when HA accepted the last send, and the first send of the current target */
  sentAt: number
  firstSentAt: number
  /** readings from this time on reflect an HA poll Valkyrie asked for */
  polledAt: number
  pumpTimer: unknown | null
  /** set when the bulb confirms: a later different report inside the window gets the target once more */
  guard: { target: Full; at: number; until: number } | null
  waiters: Waiter[]
}

export type EngineOptions = {
  ha: HAClient
  lights: string[]
  names?: Record<string, string>
  clock?: Clock
  tuning?: Partial<Tuning>
  /** call HA's update_entity for a bulb that has not confirmed (default true) */
  refresh?: boolean
  log?: (msg: string, data?: unknown) => void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

export function createLightEngine(o: EngineOptions) {
  const ha = o.ha
  const clock = o.clock ?? realClock
  const t: Tuning = { ...TUNING, ...o.tuning }
  const names = o.names ?? {}
  const log = o.log ?? ((msg: string, data?: unknown) => console.warn(`[lights] ${msg}`, data ?? ''))
  const refreshOn = o.refresh !== false

  const bulbs = new Map<string, Bulb>(o.lights.map((id) => [id, {
    id, reading: null, known: null, lit: { pct: null, color: null }, want: null, dirty: false, inflight: false,
    resends: 0, lastSendStart: -Infinity, sentAt: 0, firstSentAt: 0, polledAt: 0, pumpTimer: null, guard: null, waiters: [],
  }]))
  const all = () => [...bulbs.values()]

  let lastReadAt = -Infinity
  let reading: Promise<void> | null = null
  let readFailures = 0
  let lastRefreshAt = -Infinity
  let refreshWarned = false
  let loopTimer: unknown | null = null

  const describe = (f: Full | null) => (!f ? null : !f.on ? 'off' : `${f.pct ?? '?'}% ${!f.color ? '?' : 'rgb' in f.color ? `rgb(${f.color.rgb.join(',')})` : `${f.color.kelvin}K`}`)

  function remember(b: Bulb, f: Full) {
    if (!f.on) return
    if (f.pct != null) b.lit.pct = f.pct
    if (f.color) b.lit.color = f.color
  }

  function kelvinFor(b: Bulb, k: number): number {
    const a = b.reading?.attrs ?? {}
    const lo = typeof a.min_color_temp_kelvin === 'number' ? a.min_color_temp_kelvin : 2000
    const hi = typeof a.max_color_temp_kelvin === 'number' ? a.max_color_temp_kelvin : 6500
    return clamp(Math.round(k), lo, hi)
  }

  /** The one HA call for a target: off, or on with brightness and one color together. */
  function commandFor(b: Bulb, f: Full): { service: 'turn_on' | 'turn_off'; body: Record<string, unknown> } {
    if (!f.on) return { service: 'turn_off', body: { entity_id: b.id } }
    const body: Record<string, unknown> = { entity_id: b.id }
    if (f.pct != null) body.brightness = haBrightnessFor(f.pct)
    if (f.color && 'rgb' in f.color) body.rgb_color = f.color.rgb
    else if (f.color) body.color_temp_kelvin = kelvinFor(b, f.color.kelvin)
    return { service: 'turn_on', body }
  }

  function complete(b: Bulb, p: Patch): Full {
    const base = b.want ?? b.known ?? b.reading?.full ?? null
    const from = base?.on ? base : null
    const pct = p.pct ?? from?.pct ?? b.lit.pct ?? null
    const color = p.color ?? from?.color ?? b.lit.color ?? null
    return { on: p.state === 'on', pct, color }
  }

  function setWant(b: Bulb, target: Full, resends: number) {
    b.want = target
    b.dirty = true
    b.resends = resends
    b.guard = null
    remember(b, target)
    pump(b)
    ensureLoop()
  }

  function pump(b: Bulb) {
    if (b.inflight || !b.dirty || !b.want) return
    const now = clock.now()
    const wait = b.lastSendStart + t.minGapMs - now
    if (wait > 0) {
      if (b.pumpTimer === null) b.pumpTimer = clock.setTimeout(() => { b.pumpTimer = null; pump(b) }, wait)
      return
    }
    const target = b.want
    const waiters = b.waiters.splice(0)
    b.inflight = true
    b.dirty = false
    b.lastSendStart = now
    const { service, body } = commandFor(b, target)
    const resend = b.resends > 0
    ha.call(service, body).then(() => {
      b.sentAt = clock.now()
      if (!resend) b.firstSentAt = b.sentAt
      for (const w of waiters) w.resolve()
    }, (err: unknown) => {
      log('send failed', { entity: b.id, target: describe(target), error: (err as Error)?.message ?? String(err) })
      for (const w of waiters) w.reject(err)
      // nothing newer was asked: fall back to what the bulb reports
      if (b.want === target && !b.dirty) b.want = null
    }).finally(() => {
      b.inflight = false
      pump(b)
      ensureLoop()
    })
  }

  function settle(b: Bulb, r: Reading, now: number) {
    const target = b.want!
    b.known = target
    b.want = null
    b.resends = 0
    b.guard = { target, at: r.at, until: now + t.stickyMs }
  }

  function adopt(b: Bulb, r: Reading, why: string) {
    log(why, { entity: b.id, wanted: describe(b.want), got: describe(r.full) })
    b.known = r.full
    b.want = null
    b.resends = 0
    b.guard = null
  }

  function reconcile(b: Bulb, r: Reading, now: number) {
    b.reading = r
    if (b.want) {
      // a newer target has not gone out yet: nothing to judge against
      if (b.inflight || b.dirty) return
      if (r.unavailable) { adopt(b, r, 'unavailable'); return }
      if (matches(r, b.want)) { settle(b, r, now); return }
      const since = now - b.sentAt
      // Has the bulb said anything since it was asked? A report after the first
      // send, or an HA poll Valkyrie asked for after this one. Without either,
      // HA's copy is just old (the office lamp) and proves nothing.
      const heard = r.at > b.firstSentAt || (b.polledAt > b.sentAt && now >= b.polledAt)
      if (heard && since >= t.graceMs) {
        // it has, and it is somewhere else
        if (b.resends < 1) { log('settled elsewhere, sending once more', { entity: b.id, wanted: describe(b.want), got: describe(r.full) }); setWant(b, b.want, 1); return }
        adopt(b, r, 'settled elsewhere twice, showing what it reports')
        return
      }
      if (since >= t.holdMs) {
        if (b.resends < 1) { log('never reported, sending once more', { entity: b.id, wanted: describe(b.want) }); setWant(b, b.want, 1); return }
        adopt(b, r, 'never reported, showing what HA has')
      }
      return
    }
    if (b.guard) {
      if (now >= b.guard.until) b.guard = null
      else if (r.at > b.guard.at && !r.unavailable && !matches(r, b.guard.target)) {
        // an older command's late report, or a bulb that wandered off right after confirming
        const target = b.guard.target
        log('moved after confirming, sending once more', { entity: b.id, wanted: describe(target), got: describe(r.full) })
        setWant(b, target, 1)
        return
      }
    }
    if (!b.known || !matches(r, b.known)) b.known = r.full
    if (!r.unavailable) remember(b, b.known)
  }

  function rowFor(b: Bulb): LightRow {
    const r = b.reading
    const a = r?.attrs ?? {}
    const shown = b.want ?? (b.known && r && matches(r, b.known) ? b.known : r?.full ?? null)
    const exact = !!b.want || shown === b.known
    const on = !!shown?.on
    const color = on ? shown?.color ?? null : null
    const raw = !exact && on ? a : {}
    return {
      entity_id: b.id,
      name: names[b.id] ?? a.friendly_name ?? b.id,
      on,
      unavailable: r ? r.unavailable : true,
      brightness: on && shown?.pct != null ? apiBrightness(shown.pct) : null,
      rgb_color: color && 'rgb' in color ? color.rgb : Array.isArray(raw.rgb_color) ? raw.rgb_color as RGB : null,
      color_temp_kelvin: color && 'kelvin' in color ? color.kelvin : null,
      color_mode: color ? ('rgb' in color ? 'rgb' : 'color_temp') : on && typeof a.color_mode === 'string' ? a.color_mode : null,
      supported_color_modes: Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [],
      min_kelvin: typeof a.min_color_temp_kelvin === 'number' ? a.min_color_temp_kelvin : null,
      max_kelvin: typeof a.max_color_temp_kelvin === 'number' ? a.max_color_temp_kelvin : null,
      pending: !!b.want,
    }
  }

  const rows = () => all().map(rowFor)
  const haveRead = () => lastReadAt > -Infinity

  async function readNow(): Promise<void> {
    const states = await ha.states()
    const byId = new Map(states.map((s) => [s.entity_id, s]))
    const now = clock.now()
    lastReadAt = now
    for (const b of all()) reconcile(b, readingOf(byId.get(b.id)), now)
  }

  /** One HA read shared by everyone asking at once; `fresh` skips the reuse window. */
  function read(fresh = false): Promise<void> {
    if (reading) return reading
    if (!fresh && clock.now() - lastReadAt < t.readTtlMs) return Promise.resolve()
    reading = readNow().finally(() => { reading = null })
    return reading
  }

  const busy = (b: Bulb) => !!b.want || b.inflight || (!!b.guard && clock.now() < b.guard.until)

  function ensureLoop() {
    if (loopTimer !== null || !all().some(busy)) return
    const wait = readFailures > 0 ? Math.min(10_000, t.verifyMs * 2 ** readFailures) : t.verifyMs
    loopTimer = clock.setTimeout(() => { void tick() }, wait)
  }

  async function tick() {
    try {
      await read(true)
      readFailures = 0
      await maybeRefresh()
    } catch {
      readFailures = Math.min(4, readFailures + 1)
    } finally {
      loopTimer = null
      ensureLoop()
    }
  }

  // A bulb that has not confirmed a couple of seconds after its send is most
  // likely the office lamp waiting on HA's 30 s poll. Asking HA to poll now
  // reads the bulbs; it sends them nothing.
  async function maybeRefresh() {
    if (!refreshOn) return
    const now = clock.now()
    if (now - lastRefreshAt < t.refreshGapMs) return
    const ids = all().filter((b) => b.want && !b.inflight && !b.dirty && now - b.sentAt >= t.refreshAfterMs).map((b) => b.id)
    if (!ids.length) return
    lastRefreshAt = now
    try {
      await ha.refresh(ids)
      const at = clock.now() + t.pollSettleMs
      for (const id of ids) bulbs.get(id)!.polledAt = at
    } catch (err) {
      if (!refreshWarned) { refreshWarned = true; log('update_entity failed, waiting on HA\'s own poll', (err as Error)?.message ?? String(err)) }
    }
  }

  return {
    /** Every bulb as the UI should show it: a pending target over the bulb's report. */
    async lights(): Promise<LightRow[]> {
      await read()
      return rows()
    },
    /** The last rows, for when HA does not answer. */
    lastRows(): LightRow[] | null {
      return haveRead() ? rows() : null
    },
    /** Resolves when the send carrying this patch is accepted by HA; rejects when that send fails. */
    async submit(id: string, p: Patch): Promise<void> {
      const b = bulbs.get(id)
      if (!b) throw new Error(`unknown light ${id}`)
      // The first command after a start learns the bulb first, so it completes from a real state.
      if (!haveRead()) await read(true).catch(() => null)
      const target = complete(b, p)
      return new Promise<void>((resolve, reject) => {
        b.waiters.push({ resolve, reject })
        setWant(b, target, 0)
      })
    },
    /** test hook: a bulb's internal state */
    inspect(id: string) {
      const b = bulbs.get(id)!
      return { want: b.want, known: b.known, lit: { ...b.lit }, resends: b.resends, inflight: b.inflight, dirty: b.dirty, guard: b.guard }
    },
    /** test hook: stop every timer */
    stop() {
      if (loopTimer !== null) clock.clearTimeout(loopTimer)
      loopTimer = null
      for (const b of all()) if (b.pumpTimer !== null) { clock.clearTimeout(b.pumpTimer); b.pumpTimer = null }
    },
  }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const engine = createLightEngine({
  lights: LIGHTS,
  names: DISPLAY_NAMES,
  ha: {
    states: async () => await haRequest('GET', '/api/states') as HAState[],
    call: async (service, body) => { await haRequest('POST', `/api/services/light/${service}`, body) },
    refresh: async (entities) => { await haRequest('POST', '/api/services/homeassistant/update_entity', { entity_id: entities }) },
  },
})

router.get('/lights', async (_req, res) => {
  try {
    res.json(await engine.lights())
  } catch (err) {
    // The last rows beat a 503 that blanks the page: the client can tell the
    // difference from the timestamps it already polls on.
    const rows = engine.lastRows()
    if (rows) return res.json(rows)
    res.status(503).json({ error: 'HA unreachable', detail: (err as Error).message })
  }
})

const isRgb = (v: unknown): v is unknown[] => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)))

router.post('/lights/turn', async (req, res) => {
  const { entity_id, state, brightness, rgb_color, color_temp_kelvin } = req.body ?? {}
  const entities: string[] = Array.isArray(entity_id) ? entity_id : [entity_id]
  if (!entities.length || entities.some((e) => !LIGHTS.includes(e))) {
    return res.status(400).json({ error: 'invalid entity_id' })
  }
  if (state !== 'on' && state !== 'off') {
    return res.status(400).json({ error: 'state must be on or off' })
  }
  if (rgb_color !== undefined && typeof color_temp_kelvin === 'number') {
    return res.status(400).json({ error: 'send rgb_color or color_temp_kelvin, not both' })
  }

  // brightness is the API's 0-255 (round(pct * 2.55)); the engine works in the bulb's percent
  const patch: Patch = { state }
  if (state === 'on') {
    if (typeof brightness === 'number' && Number.isFinite(brightness)) patch.pct = pctFromApi(Math.max(1, brightness))
    if (isRgb(rgb_color)) patch.color = { rgb: rgb_color.map((n) => clamp(Math.round(Number(n)), 0, 255)) as RGB }
    else if (typeof color_temp_kelvin === 'number' && Number.isFinite(color_temp_kelvin)) patch.color = { kelvin: color_temp_kelvin }
  }

  // Per bulb: each completes the patch from its own target, so a preset keeps
  // every bulb at its own level, and each has its own queue.
  const results = await Promise.allSettled(entities.map((e) => engine.submit(e, patch)))

  const failed = results
    .map((r, i) => (r.status === 'rejected' ? entities[i] : null))
    .filter((e): e is string => e !== null)

  if (failed.length === entities.length) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    return res.status(503).json({ error: 'HA call failed', detail: first ? String(first.reason?.message ?? first.reason) : 'unknown' })
  }
  // A partial failure is reported, not rolled back: the bulbs that obeyed
  // should stay where the user put them.
  res.json({ ok: true, ...(failed.length ? { failed } : {}) })
})

export default router
