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
    // queue slot behind it) open forever.
    signal: AbortSignal.timeout(HA_TIMEOUT_MS),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`HA ${method} ${path} -> ${r.status} ${txt}`.trim())
  }
  return r.json()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type HAState = { entity_id?: string; state?: string; attributes?: Record<string, any> }
type LightRow = {
  entity_id: string
  name: string
  on: boolean
  unavailable: boolean
  brightness: number | null
  rgb_color: [number, number, number] | null
  color_temp_kelvin: number | null
  color_mode: string | null
  supported_color_modes: string[]
  min_kelvin: number | null
  max_kelvin: number | null
}

// ALL states in one HA round trip, filtered locally, instead of one request per
// bulb. Five sequential-ish calls per poll was most of the page's latency: the
// bulbs themselves are slow enough without us multiplying the transport.
function rowFrom(entity_id: string, s: HAState | undefined): LightRow {
  const a = s?.attributes ?? {}
  return {
    entity_id,
    name: DISPLAY_NAMES[entity_id] ?? a.friendly_name ?? entity_id,
    on: s?.state === 'on',
    unavailable: !s || s.state === 'unavailable',
    brightness: typeof a.brightness === 'number' ? a.brightness : null,
    rgb_color: Array.isArray(a.rgb_color) ? a.rgb_color as [number, number, number] : null,
    color_temp_kelvin: typeof a.color_temp_kelvin === 'number' ? a.color_temp_kelvin : null,
    color_mode: a.color_mode ?? null,
    supported_color_modes: Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [],
    min_kelvin: typeof a.min_color_temp_kelvin === 'number' ? a.min_color_temp_kelvin : null,
    max_kelvin: typeof a.max_color_temp_kelvin === 'number' ? a.max_color_temp_kelvin : null,
  }
}

async function readLights(): Promise<LightRow[]> {
  const states = await haRequest('GET', '/api/states') as HAState[]
  const byId = new Map(states.map((s) => [s.entity_id, s]))
  const rows = LIGHTS.map((id) => rowFrom(id, byId.get(id)))
  for (const row of rows) remember(row)
  return rows
}

function remember(row: LightRow): void {
  if (row.min_kelvin != null && row.max_kelvin != null) {
    capsCache.set(row.entity_id, { min: row.min_kelvin, max: row.max_kelvin })
  }
  if (row.on && row.brightness != null) lastBrightness.set(row.entity_id, row.brightness)
}

// Each bulb's own color-temp range, learned from the last read. A kelvin outside
// it is not an error at the HA layer: the integration silently lands the bulb
// somewhere else, which then reads back as a color the user never picked.
const capsCache = new Map<string, { min: number; max: number }>()

// The brightness each bulb was last seen at. A color command that arrives
// without one is pinned to this, because a Cync bulb changing color mode
// otherwise picks its own brightness and throws away whatever was set.
const lastBrightness = new Map<string, number>()

// Short cache so the Lights page and the pad polling together cost one HA call,
// not two. It is deliberately NOT populated while a command is settling: a read
// taken mid-transition pins a stale snapshot for every client for its whole TTL,
// which is what made a change look like it had bounced back.
const STATE_CACHE_MS = 1500
const SETTLE_MS = 2500
let stateCache: { at: number; data: LightRow[] } | null = null
let lastCommandAt = 0

const settling = () => Date.now() - lastCommandAt < SETTLE_MS

router.get('/lights', async (_req, res) => {
  try {
    if (stateCache && !settling() && Date.now() - stateCache.at < STATE_CACHE_MS) {
      return res.json(stateCache.data)
    }
    const data = await readLights()
    if (!settling()) stateCache = { at: Date.now(), data }
    res.json(data)
  } catch (err) {
    // A cached read beats a 503 that blanks the page: the client can tell the
    // difference from the timestamps it already polls on.
    if (stateCache) return res.json(stateCache.data)
    res.status(503).json({ error: 'HA unreachable', detail: (err as Error).message })
  }
})

// ---------------------------------------------------------------------------
// Command queue
//
// One queue per entity. Commands for the SAME bulb are serialized, so an
// earlier value can never land after a later one; commands for DIFFERENT bulbs
// still run concurrently, so a five-bulb change costs one round trip, not five.
// A command that arrives while another is in flight replaces any unsent one:
// the user's newest intent is the only one worth sending, and the intermediate
// values a slider drag used to emit are dropped instead of queued.
// ---------------------------------------------------------------------------

type Cmd = {
  state: 'on' | 'off'
  brightness?: number
  rgb_color?: [number, number, number]
  color_temp_kelvin?: number
}

type Queue = { next: Cmd | null; busy: boolean }
const queues = new Map<string, Queue>()

function queueFor(entity: string): Queue {
  let q = queues.get(entity)
  if (!q) { q = { next: null, busy: false }; queues.set(entity, q) }
  return q
}

function serviceBody(entity: string, cmd: Cmd): Record<string, unknown> {
  const body: Record<string, unknown> = { entity_id: entity }
  if (cmd.state === 'off') return body
  if (typeof cmd.brightness === 'number') body.brightness = cmd.brightness
  // rgb and color temp are mutually exclusive modes. Sending both lets the
  // integration pick, and the bulb ends up in whichever mode it prefers.
  if (cmd.rgb_color) body.rgb_color = cmd.rgb_color
  else if (typeof cmd.color_temp_kelvin === 'number') body.color_temp_kelvin = cmd.color_temp_kelvin
  return body
}

async function sendCmd(entity: string, cmd: Cmd): Promise<void> {
  lastCommandAt = Date.now()
  stateCache = null
  const service = cmd.state === 'off' ? 'turn_off' : 'turn_on'
  await haRequest('POST', `/api/services/light/${service}`, serviceBody(entity, cmd))
}

async function readOne(entity: string): Promise<LightRow | null> {
  try {
    const s = await haRequest('GET', `/api/states/${entity}`) as HAState
    const row = rowFrom(entity, s)
    remember(row)
    return row
  } catch {
    return null
  }
}

// Did the bulb actually take the command? Only the fields we commanded are
// checked, and each with the tolerance that bulb class quantizes to. The Cync
// bulbs report their old state for a beat and sometimes drop the first command
// outright, which is why this exists at all.
function obeyed(row: LightRow, cmd: Cmd): boolean {
  if (cmd.state === 'off') return !row.on
  if (!row.on) return false
  if (row.unavailable) return true
  // A field the bulb has not reported yet counts as not obeyed. One retry is
  // the whole cost of being wrong here, and a Cync bulb that silently dropped
  // the command reports exactly this.
  if (typeof cmd.brightness === 'number') {
    if (row.brightness == null || Math.abs(row.brightness - cmd.brightness) > 3) return false
  }
  if (cmd.rgb_color) {
    if (!row.rgb_color || cmd.rgb_color.some((v, i) => Math.abs(v - row.rgb_color![i]) > 12)) return false
  }
  if (typeof cmd.color_temp_kelvin === 'number') {
    if (row.color_temp_kelvin == null || Math.abs(row.color_temp_kelvin - cmd.color_temp_kelvin) > 200) return false
  }
  return true
}

const VERIFY_DELAY_MS = 900
const MAX_RETRIES = 1

// Runs after the response has gone out. Applies anything that superseded the
// command we just sent, then verifies and retries once. Never holds the HTTP
// request open: the UI needs the command ACCEPTED, not the bulbs certified.
async function drain(entity: string, q: Queue, applied: Cmd): Promise<void> {
  try {
    let retries = 0
    for (;;) {
      if (q.next) {
        const cmd = q.next
        q.next = null
        applied = cmd
        retries = 0
        await sendCmd(entity, cmd).catch((err) => {
          console.warn('[lights] send failed', entity, (err as Error).message)
        })
        continue
      }
      if (retries >= MAX_RETRIES) break
      await sleep(VERIFY_DELAY_MS)
      if (q.next) continue
      const row = await readOne(entity)
      if (!row || obeyed(row, applied)) break
      retries += 1
      await sendCmd(entity, applied).catch(() => null)
    }
    await sleep(VERIFY_DELAY_MS)
    if (!q.next) {
      const row = await readOne(entity)
      if (row && !obeyed(row, applied)) {
        console.warn('[lights] did not settle', { entity, applied, got: { on: row.on, brightness: row.brightness, kelvin: row.color_temp_kelvin, rgb: row.rgb_color } })
      }
    }
  } finally {
    stateCache = null
    q.busy = false
    // A command that arrived during the final verify still needs a runner.
    if (q.next) {
      const cmd = q.next
      q.next = null
      q.busy = true
      void sendCmd(entity, cmd)
        .catch(() => null)
        .then(() => drain(entity, q, cmd))
    }
  }
}

// Awaited by the route so a dead Home Assistant still fails the request. Only
// the FIRST send is awaited; verification and any superseded command run after
// the response.
async function submit(entity: string, cmd: Cmd): Promise<void> {
  const q = queueFor(entity)
  q.next = cmd
  if (q.busy) return
  q.busy = true
  const first = q.next
  q.next = null
  try {
    await sendCmd(entity, first!)
  } catch (err) {
    q.busy = false
    throw err
  }
  void drain(entity, q, first!)
}

function clampKelvin(entity: string, kelvin: number): number {
  const caps = capsCache.get(entity)
  const k = Math.round(kelvin)
  if (!caps) return k
  return Math.max(caps.min, Math.min(caps.max, k))
}

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

  const base: Cmd = { state }
  if (state === 'on') {
    if (typeof brightness === 'number') {
      base.brightness = Math.max(1, Math.min(255, Math.round(brightness)))
    }
    if (Array.isArray(rgb_color) && rgb_color.length === 3) {
      base.rgb_color = rgb_color.map((n: number) => Math.max(0, Math.min(255, Math.round(Number(n))))) as [number, number, number]
    }
    if (typeof color_temp_kelvin === 'number') base.color_temp_kelvin = color_temp_kelvin
  }

  // Per-entity, because the kelvin clamp and the pinned brightness both depend
  // on that particular bulb.
  const results = await Promise.allSettled(entities.map((e) => {
    const cmd: Cmd = { ...base }
    if (typeof cmd.color_temp_kelvin === 'number') cmd.color_temp_kelvin = clampKelvin(e, cmd.color_temp_kelvin)
    if (cmd.state === 'on' && cmd.brightness === undefined && (cmd.rgb_color || cmd.color_temp_kelvin !== undefined)) {
      const b = lastBrightness.get(e)
      if (b != null) cmd.brightness = b
    }
    return submit(e, cmd)
  }))

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
