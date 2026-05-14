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

function makeToken(): string {
  const cfg = getConfig()
  return jwt.sign({ iss: cfg.token_id }, cfg.jwt_key, { algorithm: 'HS256', expiresIn: 1800 })
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

router.get('/lights', async (_req, res) => {
  try {
    const results = await Promise.all(LIGHTS.map(async (entity_id) => {
      const s = await haRequest('GET', `/api/states/${entity_id}`) as {
        state?: string
        attributes?: Record<string, any>
      }
      const a = s.attributes ?? {}
      return {
        entity_id,
        name: a.friendly_name ?? entity_id,
        on: s.state === 'on',
        unavailable: s.state === 'unavailable',
        brightness: typeof a.brightness === 'number' ? a.brightness : null,
        rgb_color: Array.isArray(a.rgb_color) ? a.rgb_color as [number, number, number] : null,
        color_temp_kelvin: typeof a.color_temp_kelvin === 'number' ? a.color_temp_kelvin : null,
        color_mode: a.color_mode ?? null,
        supported_color_modes: Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [],
        min_kelvin: typeof a.min_color_temp_kelvin === 'number' ? a.min_color_temp_kelvin : null,
        max_kelvin: typeof a.max_color_temp_kelvin === 'number' ? a.max_color_temp_kelvin : null,
      }
    }))
    res.json(results)
  } catch (err) {
    res.status(503).json({ error: 'HA unreachable', detail: (err as Error).message })
  }
})

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
    const body: Record<string, unknown> = { entity_id: entities.length === 1 ? entities[0] : entities }
    if (state === 'on') {
      if (typeof brightness === 'number') body.brightness = Math.max(1, Math.min(255, Math.round(brightness)))
      if (Array.isArray(rgb_color) && rgb_color.length === 3) {
        body.rgb_color = rgb_color.map((n: number) => Math.max(0, Math.min(255, Math.round(Number(n)))))
      }
      if (typeof color_temp_kelvin === 'number') body.color_temp_kelvin = Math.round(color_temp_kelvin)
    }
    await haRequest('POST', `/api/services/light/turn_${state}`, body)
    res.json({ ok: true })
  } catch (err) {
    res.status(503).json({ error: 'HA call failed', detail: (err as Error).message })
  }
})

export default router
