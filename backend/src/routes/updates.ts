import { Router } from 'express'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

// Public mirror of the Tauri auto-update release.
//
// The desktop apps fetch their update manifest anonymously, but the GitHub repo
// (and thus its release assets) is private. This route re-serves the latest
// release's `latest.json` — with the per-platform download URLs rewritten to
// point back here — and proxies the installer binaries, using a server-side
// GitHub token. Net effect: source stays private; only the (non-sensitive) app
// binaries are publicly downloadable, which is all the updater needs.
//
// Mounted BEFORE requireAuth so the updater can reach it without a token.

const router = Router()
const OWNER = 'kups14502'
const REPO = 'master-control'
const PUBLIC_BASE = process.env.PUBLIC_API_URL || 'https://master-control-api.brendonkupsch.com'

let tokenCache = ''
function ghToken(): string {
  if (process.env.GH_RELEASES_TOKEN) return process.env.GH_RELEASES_TOKEN
  if (tokenCache) return tokenCache
  try { tokenCache = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() } catch { /* gh unavailable */ }
  return tokenCache
}

type Asset = { id: number; name: string; url: string }
type Release = { tag_name: string; assets: Asset[]; published_at: string }

let relCache: { at: number; rel: Release } | null = null
async function latestRelease(): Promise<Release> {
  if (relCache && Date.now() - relCache.at < 30_000) return relCache.rel
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mc-updates' },
  })
  if (!r.ok) throw new Error(`github releases ${r.status}`)
  const rel = (await r.json()) as Release
  relCache = { at: Date.now(), rel }
  return rel
}

function assetResponse(asset: Asset): Promise<Response> {
  return fetch(asset.url, { headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/octet-stream', 'User-Agent': 'mc-updates' } })
}

// The Tauri updater manifest, with download URLs pointed back at this mirror.
router.get('/updates/latest.json', async (_req, res) => {
  try {
    const rel = await latestRelease()
    const manifestAsset = rel.assets.find((a) => a.name === 'latest.json')
    if (!manifestAsset) return res.status(404).json({ error: 'no manifest in latest release' })
    const mr = await assetResponse(manifestAsset)
    if (!mr.ok) return res.status(502).json({ error: 'manifest fetch failed', status: mr.status })
    const manifest = (await mr.json()) as { platforms?: Record<string, { url: string; signature: string }> }
    for (const key of Object.keys(manifest.platforms ?? {})) {
      const p = manifest.platforms![key]
      const name = decodeURIComponent((p.url.split('/').pop() || '').split('?')[0])
      if (name) p.url = `${PUBLIC_BASE}/api/updates/asset/${encodeURIComponent(name)}`
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(manifest)
  } catch (e) {
    res.status(502).json({ error: 'update manifest unavailable', detail: (e as Error).message })
  }
})

// Stream a named release binary from the private repo.
router.get('/updates/asset/:name', async (req, res) => {
  try {
    const rel = await latestRelease()
    const asset = rel.assets.find((a) => a.name === req.params.name)
    if (!asset) return res.status(404).json({ error: 'asset not found' })
    const ar = await assetResponse(asset)
    if (!ar.ok || !ar.body) return res.status(502).json({ error: 'asset fetch failed', status: ar.status })
    res.setHeader('Content-Type', 'application/octet-stream')
    const len = ar.headers.get('content-length')
    if (len) res.setHeader('Content-Length', len)
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`)
    Readable.fromWeb(ar.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
  } catch (e) {
    res.status(502).json({ error: 'asset unavailable', detail: (e as Error).message })
  }
})

export default router
