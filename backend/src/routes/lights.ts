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

async function haRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const cfg = getConfig()
  const r = await fetch(`${cfg.ha_url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`HA ${method} ${path} -> ${r.status} ${txt}`.trim())
  }
  return r.json()
}

type HAState = { entity_id?: string; state?: string; attributes?: Record<string, any> }

// ALL states in one HA round trip, filtered locally, instead of one request per
// bulb. Five sequential-ish calls per poll was most of the page's latency: the
// bulbs themselves are slow enough without us multiplying the transport.
async function readLights() {
  const states = await haRequest('GET', '/api/states') as HAState[]
  const byId = new Map(states.map((s) => [s.entity_id, s]))
  return LIGHTS.map((entity_id) => {
    const s = byId.get(entity_id)
    const a = s?.attributes ?? {}
    return {
      entity_id,
      name: a.friendly_name ?? entity_id,
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
  })
}

// Short cache so the Lights page and the pad polling together cost one HA call,
// not two. Busted on every command, so a change is never served stale.
const STATE_CACHE_MS = 1500
let stateCache: { at: number; data: Awaited<ReturnType<typeof readLights>> } | null = null

router.get('/lights', async (_req, res) => {
  try {
    if (stateCache && Date.now() - stateCache.at < STATE_CACHE_MS) {
      return res.json(stateCache.data)
    }
    const data = await readLights()
    stateCache = { at: Date.now(), data }
    res.json(data)
  } catch (err) {
    res.status(503).json({ error: 'HA unreachable', detail: (err as Error).message })
  }
})

async function getStillOn(entities: string[]): Promise<string[]> {
  try {
    const states = await haRequest('GET', '/api/states') as HAState[]
    const on = new Set(states.filter((s) => s.state === 'on').map((s) => s.entity_id))
    return entities.filter((e) => on.has(e))
  } catch {
    return []
  }
}

// The Cync bulbs sometimes ignore the first turn_off, which is why the verify
// and retry exist. But holding the HTTP response through two 800ms settles made
// every off feel like a two-second button: the UI is optimistic, so the client
// needs the command ACCEPTED, not the bulbs certified dark. First command is
// awaited (so a dead HA still errors), the verify runs after the response.
function verifyOffInBackground(entities: string[]): void {
  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, 800))
      const stillOn = await getStillOn(entities)
      if (stillOn.length === 0) return
      await Promise.all(stillOn.map((e) =>
        haRequest('POST', '/api/services/light/turn_off', { entity_id: e }).catch(() => null),
      ))
      await new Promise((r) => setTimeout(r, 800))
      const stubborn = await getStillOn(stillOn)
      stateCache = null
      if (stubborn.length > 0) console.warn('[lights] still on after retry', { stubborn })
    } catch (err) {
      console.warn('[lights] off verify failed', (err as Error).message)
    }
  })()
}

router.post('/lights/turn', async (req, res) => {
  const { entity_id, state, brightness, rgb_color, color_temp_kelvin } = req.body ?? {}
  const entities = Array.isArray(entity_id) ? entity_id : [entity_id]
  if (!entities.length || entities.some((e) => !LIGHTS.includes(e))) {
    return res.status(400).json({ error: 'invalid entity_id' })
  }
  if (state !== 'on' && state !== 'off') {
    return res.status(400).json({ error: 'state must be on or off' })
  }
  try {
    if (state === 'off') {
      await haRequest('POST', '/api/services/light/turn_off', {
        entity_id: entities.length === 1 ? entities[0] : entities,
      })
      stateCache = null
      verifyOffInBackground(entities)
      return res.json({ ok: true })
    }
    const body: Record<string, unknown> = { entity_id: entities.length === 1 ? entities[0] : entities }
    if (typeof brightness === 'number') body.brightness = Math.max(1, Math.min(255, Math.round(brightness)))
    if (Array.isArray(rgb_color) && rgb_color.length === 3) {
      body.rgb_color = rgb_color.map((n: number) => Math.max(0, Math.min(255, Math.round(Number(n)))))
    }
    if (typeof color_temp_kelvin === 'number') body.color_temp_kelvin = Math.round(color_temp_kelvin)
    await haRequest('POST', '/api/services/light/turn_on', body)
    stateCache = null
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ error: 'HA call failed', detail: (err as Error).message })
  }
})

export default router
