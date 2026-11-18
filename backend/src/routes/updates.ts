import { Router, type Request } from 'express'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { viaCloudflare } from '../middleware/auth.js'
import { tailnetOriginFor } from '../middleware/origin.js'

// Mirror of the Tauri auto-update release.
//
// The desktop apps fetch their update manifest without a token, but the GitHub
// repo (and thus its release assets) is private. This route re-serves the latest
// release's `latest.json` — with the per-platform download URLs rewritten to
// point back here — and proxies the installer binaries, using a server-side
// GitHub token.
//
// Mounted BEFORE requireAuth so the updater can reach it without a token.
// The desktop app checks over the tailnet first: release.sh gives it the
// `tailscale serve` https name, which stays out of the repo. Its fallback, and
// the only endpoint of builds from before that change, is the Cloudflare name,
// where these files would be anonymous downloads. So the Cloudflare path
// always answers 404.

const router = Router()
const OWNER = 'kups14502'
const REPO = 'valkyrie'

// One line per updater request: `via` says which path and `ip` names the
// tailnet device. `current` is the version a build since the tailnet change
// reports in its query string, so a Cloudflare line that carries it is such a
// build failing to reach the tailnet. It is logged before the 404.
router.use('/updates', (req, res, next) => {
  const via = viaCloudflare(req) ? 'cloudflare' : 'tailnet'
  console.log('[updates] ' + JSON.stringify({
    path: req.originalUrl.split('?')[0], via, ip: req.ip, current: req.query.current, target: req.query.target,
  }))
  if (via === 'cloudflare') return res.status(404).type('text/plain').send('Not found')
  next()
})

// Download URLs point back at the origin the manifest came from, so an app
// that checks over the tailnet downloads over it too. hostGuard has already
// checked the Host of every request that did not come through Cloudflare.
function assetBase(req: Request): string {
  return tailnetOriginFor(req) ?? `${req.protocol}://${req.headers.host}`
}

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
    headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'valkyrie-updates' },
  })
  if (!r.ok) throw new Error(`github releases ${r.status}`)
  const rel = (await r.json()) as Release
  relCache = { at: Date.now(), rel }
  return rel
}

function assetResponse(asset: Asset): Promise<Response> {
  return fetch(asset.url, { headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/octet-stream', 'User-Agent': 'valkyrie-updates' } })
}

// The Tauri updater manifest, with download URLs pointed back at this mirror.
router.get('/updates/latest.json', async (req, res) => {
  try {
    const rel = await latestRelease()
    const manifestAsset = rel.assets.find((a) => a.name === 'latest.json')
    if (!manifestAsset) return res.status(404).json({ error: 'no manifest in latest release' })
    const mr = await assetResponse(manifestAsset)
    if (!mr.ok) return res.status(502).json({ error: 'manifest fetch failed', status: mr.status })
    const manifest = (await mr.json()) as { platforms?: Record<string, { url: string; signature: string }> }
    const base = assetBase(req)
    for (const key of Object.keys(manifest.platforms ?? {})) {
      const p = manifest.platforms![key]
      const name = decodeURIComponent((p.url.split('/').pop() || '').split('?')[0])
      if (name) p.url = `${base}/api/updates/asset/${encodeURIComponent(name)}`
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
    // Cloudflare caches .exe and .apk at the edge by default, which would keep
    // serving them after the Cloudflare path closes.
    res.setHeader('Cache-Control', 'no-store')
    Readable.fromWeb(ar.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
  } catch (e) {
    res.status(502).json({ error: 'asset unavailable', detail: (e as Error).message })
  }
})

// Phone-friendly stable URL for the Android app: streams whatever .apk is
// attached to the latest release. Open it on the phone, sideload, done.
router.get('/updates/android.apk', async (_req, res) => {
  try {
    const rel = await latestRelease()
    const asset = rel.assets.find((a) => a.name.endsWith('.apk'))
    if (!asset) return res.status(404).json({ error: 'no apk in latest release' })
    const ar = await assetResponse(asset)
    if (!ar.ok || !ar.body) return res.status(502).json({ error: 'asset fetch failed', status: ar.status })
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    const len = ar.headers.get('content-length')
    if (len) res.setHeader('Content-Length', len)
    res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`)
    res.setHeader('Cache-Control', 'no-store')
    Readable.fromWeb(ar.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
  } catch (e) {
    res.status(502).json({ error: 'apk unavailable', detail: (e as Error).message })
  }
})

export default router
