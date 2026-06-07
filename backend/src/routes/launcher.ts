import { Router } from 'express'
import { Agent, fetch as undiciFetch } from 'undici'

const router = Router()

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })

type Service = {
  id: string
  name: string
  url: string
  pingUrl?: string
  category: 'media' | 'home' | 'tools' | 'self' | 'ai' | 'trading' | 'storage'
  owner?: string
}

// Central web-app registry for the server. Add anything browser-addressable here;
// systemd units and Docker containers are inventoried separately by /api/services.
const SERVICES: Service[] = [
  { id: 'master-control', name: 'Valkyrie', url: 'https://master-control.brendonkupsch.com', pingUrl: 'http://127.0.0.1:3001/healthz', category: 'self', owner: 'master-control-api.service' },
  { id: 'trading-dashboard', name: 'Trading Dashboard', url: 'http://100.96.237.89:7734', pingUrl: 'http://127.0.0.1:7734', category: 'trading', owner: 'trading-dashboard.service' },
  { id: 'vaultwarden', name: 'Vaultwarden', url: 'https://100.96.237.89:8443', category: 'storage', owner: 'vaultwarden + vaultwarden-caddy' },
  { id: 'homeassistant', name: 'Home Assistant', url: 'http://100.96.237.89:8123', pingUrl: 'http://127.0.0.1:8123', category: 'home', owner: 'homeassistant' },
  { id: 'plex', name: 'Plex', url: 'http://100.96.237.89:32400/web', pingUrl: 'http://127.0.0.1:32400/identity', category: 'media', owner: 'plex' },
  { id: 'qbittorrent', name: 'qBittorrent', url: 'http://100.96.237.89:8080', pingUrl: 'http://127.0.0.1:8080', category: 'media', owner: 'qbittorrent' },
  { id: 'radarr', name: 'Radarr', url: 'http://100.96.237.89:7878', pingUrl: 'http://127.0.0.1:7878', category: 'media', owner: 'radarr' },
  { id: 'sonarr', name: 'Sonarr', url: 'http://100.96.237.89:8989', pingUrl: 'http://127.0.0.1:8989', category: 'media', owner: 'sonarr' },
  { id: 'lidarr', name: 'Lidarr', url: 'http://100.96.237.89:8686', pingUrl: 'http://127.0.0.1:8686', category: 'media', owner: 'lidarr' },
  { id: 'prowlarr', name: 'Prowlarr', url: 'http://100.96.237.89:9696', pingUrl: 'http://127.0.0.1:9696', category: 'media', owner: 'prowlarr' },
]

type Health = 'alive' | 'down' | 'unknown'
type Result = Service & { health: Health; latencyMs: number | null }

const CACHE_TTL_MS = 30_000
let cache: { at: number; data: Result[] } | null = null

async function pingOne(svc: Service): Promise<Result> {
  const target = svc.pingUrl ?? svc.url
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const r = await undiciFetch(target, {
      method: 'GET',
      signal: controller.signal,
      dispatcher: insecureAgent,
      redirect: 'manual',
    })
    void r.body?.cancel()
    return { ...svc, health: 'alive', latencyMs: Date.now() - start }
  } catch {
    return { ...svc, health: 'down', latencyMs: null }
  } finally {
    clearTimeout(timer)
  }
}

router.get('/launcher', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  const data = await Promise.all(SERVICES.map(pingOne))
  cache = { at: Date.now(), data }
  res.json(data)
})

export default router
