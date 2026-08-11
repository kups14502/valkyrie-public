import { Router } from 'express'
import { Readable, pipeline } from 'node:stream'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { postDiscord } from '../alerts.js'
import { signImgToken } from '../auth/token.js'

// Plex library browsing + media requests.
//
// Browsing proxies the local Plex server (same box, loopback) so clients never
// need the Plex token. Requests ride the existing acquisition stack: movies go
// to Radarr, shows to Sonarr (lookup -> add -> they search and download, Plex
// picks the file up). Free-text requests that the automated path can't resolve
// are journaled and posted to Discord, where the agent (or Brendon) picks them
// up — that's the "message an agent" path.

const router = Router()

const PLEX_URL = process.env.PLEX_URL || 'http://127.0.0.1:32400'
const PLEX_TOKEN = process.env.PLEX_TOKEN || ''
const RADARR_URL = process.env.RADARR_URL || 'http://127.0.0.1:7878'
const RADARR_KEY = process.env.RADARR_API_KEY || ''
const SONARR_URL = process.env.SONARR_URL || 'http://127.0.0.1:8989'
const SONARR_KEY = process.env.SONARR_API_KEY || ''

const REQUESTS_LOG = path.join(process.cwd(), 'data', 'media-requests.jsonl')

const plexConfigured = () => Boolean(PLEX_TOKEN)

// ---------- Plex ----------

async function plexJSON<T>(p: string, params?: Record<string, string>, containerStart?: number, containerSize?: number): Promise<T> {
  const url = new URL(`${PLEX_URL}${p}`)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = {
    'X-Plex-Token': PLEX_TOKEN,
    Accept: 'application/json',
  }
  if (containerSize !== undefined) {
    headers['X-Plex-Container-Start'] = String(containerStart ?? 0)
    headers['X-Plex-Container-Size'] = String(containerSize)
  }
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`plex ${p} -> ${r.status} ${await r.text().catch(() => '')}`)
  return (await r.json()) as T
}

type PlexDirectory = { key: string; title: string; type: string }
type PlexMetadata = {
  ratingKey?: string
  key?: string
  type?: string
  title?: string
  parentTitle?: string
  grandparentTitle?: string
  summary?: string
  year?: number
  thumb?: string
  parentThumb?: string
  grandparentThumb?: string
  art?: string
  rating?: number
  audienceRating?: number
  contentRating?: string
  duration?: number
  addedAt?: number
  leafCount?: number
  childCount?: number
}
type PlexContainer<T> = { MediaContainer: { totalSize?: number; size?: number; Directory?: T[]; Metadata?: T[] } }

// A browsable item, normalized. Seasons/episodes from recentlyAdded roll up to
// their show title so the grid always shows something recognizable.
function normalizeItem(m: PlexMetadata) {
  const isChild = m.type === 'season' || m.type === 'episode'
  const title = isChild
    ? [m.grandparentTitle || m.parentTitle, m.title].filter(Boolean).join(' — ')
    : m.title || 'untitled'
  return {
    ratingKey: m.ratingKey ?? '',
    type: m.type ?? 'movie',
    title,
    year: m.year ?? null,
    summary: m.summary ?? '',
    thumb: m.thumb || m.parentThumb || m.grandparentThumb || null,
    art: m.art ?? null,
    rating: m.audienceRating ?? m.rating ?? null,
    contentRating: m.contentRating ?? null,
    duration: m.duration ?? null,
    addedAt: m.addedAt ?? null,
    leafCount: m.leafCount ?? null,
    childCount: m.childCount ?? null,
  }
}
export type PlexItem = ReturnType<typeof normalizeItem>

// Section list changes rarely; totals are a separate cheap call. Cache 5 min.
let sectionsCache: { at: number; data: { key: string; title: string; type: string; count: number }[] } | null = null

router.get('/plex/sections', async (_req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured', detail: 'set PLEX_URL / PLEX_TOKEN' })
  try {
    if (sectionsCache && Date.now() - sectionsCache.at < 300_000) return res.json(sectionsCache.data)
    const dirs = (await plexJSON<PlexContainer<PlexDirectory>>('/library/sections')).MediaContainer.Directory ?? []
    const sections = await Promise.all(
      dirs
        .filter((d) => d.type === 'movie' || d.type === 'show')
        .map(async (d) => {
          // Zero-size page returns just the container header with totalSize.
          const c = await plexJSON<PlexContainer<never>>(`/library/sections/${d.key}/all`, {}, 0, 0)
            .catch(() => null)
          return { key: d.key, title: d.title, type: d.type, count: c?.MediaContainer.totalSize ?? 0 }
        }),
    )
    sectionsCache = { at: Date.now(), data: sections }
    res.json(sections)
  } catch (err) {
    res.status(503).json({ error: 'plex unreachable', detail: (err as Error).message })
  }
})

const SORTS: Record<string, string> = {
  added: 'addedAt:desc',
  title: 'titleSort:asc',
  year: 'year:desc',
  rating: 'audienceRating:desc',
}

router.get('/plex/library', async (req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured' })
  const section = String(req.query.section ?? '')
  if (!/^\d+$/.test(section)) return res.status(400).json({ error: 'invalid section' })
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const limit = Math.min(120, Math.max(1, Number(req.query.limit) || 60))
  const search = String(req.query.search ?? '').slice(0, 100)
  const sort = SORTS[String(req.query.sort ?? '')] ?? SORTS.added
  try {
    const params: Record<string, string> = { sort }
    if (search) params.title = search
    const c = await plexJSON<PlexContainer<PlexMetadata>>(`/library/sections/${section}/all`, params, offset, limit)
    const mc = c.MediaContainer
    res.json({
      total: mc.totalSize ?? mc.size ?? 0,
      offset,
      items: (mc.Metadata ?? []).map(normalizeItem),
    })
  } catch (err) {
    res.status(503).json({ error: 'plex unreachable', detail: (err as Error).message })
  }
})

router.get('/plex/recent', async (req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured' })
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24))
  try {
    const c = await plexJSON<PlexContainer<PlexMetadata>>('/library/recentlyAdded', {}, 0, limit)
    res.json({ items: (c.MediaContainer.Metadata ?? []).map(normalizeItem) })
  } catch (err) {
    res.status(503).json({ error: 'plex unreachable', detail: (err as Error).message })
  }
})

// Poster/art proxy. Streams Plex's photo transcoder so clients get right-sized
// JPEGs without ever seeing the Plex token. Path is restricted to Plex image
// paths (no arbitrary proxying).
router.get('/plex/img', async (req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured' })
  const p = String(req.query.path ?? '')
  if (!/^\/(library|photo)\/[\w\-/:.]+$/.test(p)) return res.status(400).json({ error: 'invalid path' })
  const w = Math.min(1200, Math.max(60, Number(req.query.w) || 300))
  const h = Math.min(1800, Math.max(60, Number(req.query.h) || Math.round(w * 1.5)))
  try {
    const url = new URL(`${PLEX_URL}/photo/:/transcode`)
    url.searchParams.set('width', String(w))
    url.searchParams.set('height', String(h))
    url.searchParams.set('minSize', '1')
    url.searchParams.set('upscale', '1')
    url.searchParams.set('url', p)
    const r = await fetch(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok || !r.body) return res.status(502).json({ error: 'image fetch failed', status: r.status })
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/jpeg')
    // Plex image paths embed a version stamp so long caching is safe, but the
    // URL may carry an auth token — keep it out of shared caches.
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable')
    // pipeline (not pipe): destroys both ends on error or client disconnect,
    // so an abandoned poster grid can't leak sockets or throw listener-less
    // stream errors.
    pipeline(
      Readable.fromWeb(r.body as import('node:stream/web').ReadableStream),
      res,
      (err) => {
        if (err) console.warn('[plex] image stream aborted:', (err as Error).message)
      },
    )
  } catch (err) {
    res.status(502).json({ error: 'image fetch failed', detail: (err as Error).message })
  }
})

// A short-lived token the web/desktop app appends to poster <img> URLs (an
// image can't send an Authorization header). Scoped: grants /plex/img only.
// Handed out only to already-authenticated callers (this route sits behind
// requireAuth). Tailnet clients never need it.
router.get('/plex/img-token', (_req, res) => {
  res.json(signImgToken())
})

// ---------- Requests (Radarr / Sonarr + agent journal) ----------

type ArrService = { base: string; key: string }
const radarr: ArrService = { base: RADARR_URL, key: RADARR_KEY }
const sonarr: ArrService = { base: SONARR_URL, key: SONARR_KEY }
const arrConfigured = () => Boolean(RADARR_KEY || SONARR_KEY)

async function arrJSON<T>(svc: ArrService, p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${svc.base}/api/v3${p}`, {
    ...init,
    headers: { 'X-Api-Key': svc.key, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await r.text()
  if (!r.ok) {
    const err = new Error(`arr ${p} -> ${r.status} ${text.slice(0, 300)}`) as Error & { status?: number; body?: string }
    err.status = r.status
    err.body = text
    throw err
  }
  return (text ? JSON.parse(text) : null) as T
}

type ArrMovie = { id?: number; title: string; year?: number; tmdbId: number; overview?: string; remotePoster?: string; hasFile?: boolean; monitored?: boolean }
type ArrSeries = { id?: number; title: string; year?: number; tvdbId: number; overview?: string; remotePoster?: string; statistics?: { episodeFileCount?: number }; monitored?: boolean }

type SearchResult = {
  kind: 'movie' | 'show'
  title: string
  year: number | null
  overview: string
  poster: string | null
  tmdbId: number | null
  tvdbId: number | null
  inLibrary: boolean
  downloaded: boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// How well a candidate matches what was typed. Radarr and Sonarr each return
// their own loosely-sorted list, so without this an exact-title show loses to
// eight obscure same-word movies.
function score(r: SearchResult, q: string): number {
  const t = norm(r.title)
  let n = 0
  if (t === q) n += 100
  else if (t.startsWith(q)) n += 50
  else if (t.includes(q)) n += 20
  if (r.poster) n += 5
  if (r.year) n += 3
  return n
}

router.get('/plex/request/search', async (req, res) => {
  if (!arrConfigured()) return res.status(503).json({ error: 'radarr/sonarr not configured' })
  const q = String(req.query.q ?? '').trim().slice(0, 100)
  if (q.length < 2) return res.json({ results: [] })
  const term = encodeURIComponent(q)
  const [movies, series] = await Promise.all([
    RADARR_KEY ? arrJSON<ArrMovie[]>(radarr, `/movie/lookup?term=${term}`).catch(() => []) : [],
    SONARR_KEY ? arrJSON<ArrSeries[]>(sonarr, `/series/lookup?term=${term}`).catch(() => []) : [],
  ])
  const nq = norm(q)
  const rank = (list: SearchResult[]) => list
    // Drop metadata stubs (no year and no artwork) — they're never the intent.
    .filter((r) => r.year || r.poster)
    .map((r) => ({ r, s: score(r, nq) }))
    .sort((a, b) => b.s - a.s)

  const rankedMovies = rank(movies.map((m) => ({
    kind: 'movie' as const,
    title: m.title,
    year: m.year ?? null,
    overview: (m.overview ?? '').slice(0, 300),
    poster: m.remotePoster ?? null,
    tmdbId: m.tmdbId,
    tvdbId: null,
    inLibrary: Boolean(m.id),
    downloaded: Boolean(m.hasFile),
  })))
  const rankedShows = rank(series.map((s) => ({
    kind: 'show' as const,
    title: s.title,
    year: s.year ?? null,
    overview: (s.overview ?? '').slice(0, 300),
    poster: s.remotePoster ?? null,
    tmdbId: null,
    tvdbId: s.tvdbId,
    inLibrary: Boolean(s.id),
    downloaded: (s.statistics?.episodeFileCount ?? 0) > 0,
  })))

  // Merge highest-score-first, alternating on ties so a movie and a show that
  // both match exactly are adjacent at the top instead of one kind burying the
  // other. "severance" then puts the 2022 series in the first two rows.
  const results: SearchResult[] = []
  let i = 0
  let j = 0
  let lastKind: 'movie' | 'show' | null = null
  while (results.length < 12 && (i < rankedMovies.length || j < rankedShows.length)) {
    const m = rankedMovies[i]
    const s = rankedShows[j]
    let takeMovie: boolean
    if (!s) takeMovie = true
    else if (!m) takeMovie = false
    else if (m.s !== s.s) takeMovie = m.s > s.s
    else takeMovie = lastKind !== 'movie'
    if (takeMovie && m) { results.push(m.r); lastKind = 'movie'; i += 1 }
    else if (s) { results.push(s.r); lastKind = 'show'; j += 1 }
  }
  res.json({ results })
})

// Default quality profile + root folder, discovered once from each service.
const arrDefaults = new Map<string, { at: number; qualityProfileId: number; rootFolderPath: string }>()
async function getArrDefaults(svc: ArrService, name: string) {
  const hit = arrDefaults.get(name)
  if (hit && Date.now() - hit.at < 600_000) return hit
  const [profiles, roots] = await Promise.all([
    arrJSON<{ id: number }[]>(svc, '/qualityprofile'),
    arrJSON<{ path: string }[]>(svc, '/rootfolder'),
  ])
  if (!profiles.length || !roots.length) throw new Error(`${name}: no quality profile or root folder configured`)
  const d = { at: Date.now(), qualityProfileId: profiles[0].id, rootFolderPath: roots[0].path }
  arrDefaults.set(name, d)
  return d
}

function journalAppend(entry: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(REQUESTS_LOG), { recursive: true })
    appendFileSync(REQUESTS_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch (err) {
    console.error('[plex] failed to journal request', (err as Error).message)
  }
}

router.post('/plex/request/add', async (req, res) => {
  const { kind, tmdbId, tvdbId } = (req.body ?? {}) as { kind?: string; tmdbId?: number; tvdbId?: number }
  try {
    if (kind === 'movie' && typeof tmdbId === 'number' && RADARR_KEY) {
      const [movie] = await arrJSON<ArrMovie[]>(radarr, `/movie/lookup/tmdb?tmdbId=${tmdbId}`).then((m) => (Array.isArray(m) ? m : [m]))
      if (!movie) return res.status(404).json({ error: 'movie not found' })
      const d = await getArrDefaults(radarr, 'radarr')
      await arrJSON(radarr, '/movie', {
        method: 'POST',
        body: JSON.stringify({
          ...movie,
          qualityProfileId: d.qualityProfileId,
          rootFolderPath: d.rootFolderPath,
          monitored: true,
          addOptions: { searchForMovie: true },
        }),
      })
      journalAppend({ kind: 'movie', title: movie.title, year: movie.year, tmdbId, status: 'queued' })
      void postDiscord(`🎬 media request: **${movie.title}**${movie.year ? ` (${movie.year})` : ''} → radarr, searching now`)
      return res.json({ ok: true, detail: `${movie.title} sent to radarr — it will appear in Plex once downloaded` })
    }
    if (kind === 'show' && typeof tvdbId === 'number' && SONARR_KEY) {
      const [series] = await arrJSON<ArrSeries[]>(sonarr, `/series/lookup?term=${encodeURIComponent(`tvdb:${tvdbId}`)}`)
      if (!series) return res.status(404).json({ error: 'show not found' })
      const d = await getArrDefaults(sonarr, 'sonarr')
      await arrJSON(sonarr, '/series', {
        method: 'POST',
        body: JSON.stringify({
          ...series,
          qualityProfileId: d.qualityProfileId,
          rootFolderPath: d.rootFolderPath,
          monitored: true,
          seasonFolder: true,
          addOptions: { searchForMissingEpisodes: true },
        }),
      })
      journalAppend({ kind: 'show', title: series.title, year: series.year, tvdbId, status: 'queued' })
      void postDiscord(`📺 media request: **${series.title}**${series.year ? ` (${series.year})` : ''} → sonarr, searching now`)
      return res.json({ ok: true, detail: `${series.title} sent to sonarr — episodes will appear in Plex as they download` })
    }
    return res.status(400).json({ error: 'invalid request', detail: 'need kind=movie+tmdbId or kind=show+tvdbId' })
  } catch (err) {
    const e = err as Error & { status?: number; body?: string }
    // Radarr/Sonarr answer 400 with a validation array when the item exists.
    if (e.status === 400 && /already/i.test(e.body ?? '')) {
      return res.status(409).json({ error: 'already added', detail: 'it is already being tracked — check downloads' })
    }
    console.error('[plex] request add failed', e.message)
    return res.status(502).json({ error: 'request failed', detail: e.message })
  }
})

// Free-text request — the "message the agent" path. Journaled + posted to the
// Discord alerts channel, where the agent picks it up.
router.post('/plex/request/message', async (req, res) => {
  const message = String((req.body ?? {}).message ?? '').trim().slice(0, 500)
  if (message.length < 3) return res.status(400).json({ error: 'message too short' })
  journalAppend({ kind: 'message', message, status: 'sent to agent' })
  void postDiscord(`🤖 **media request for the agent:** ${message}`)
  res.json({ ok: true, detail: 'sent — the agent will take it from here' })
})

router.get('/plex/requests', (_req, res) => {
  try {
    if (!existsSync(REQUESTS_LOG)) return res.json({ requests: [] })
    const lines = readFileSync(REQUESTS_LOG, 'utf8').trim().split('\n')
    const requests = lines
      .slice(-50)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .reverse()
    res.json({ requests })
  } catch (err) {
    res.status(500).json({ error: 'journal unreadable', detail: (err as Error).message })
  }
})

// Live download queue across both services, for the requests tab + pad mode.
router.get('/plex/downloads', async (_req, res) => {
  if (!arrConfigured()) return res.json({ downloads: [] })
  type QueueRecord = {
    title?: string
    status?: string
    sizeleft?: number
    size?: number
    timeleft?: string
    movie?: { title?: string; year?: number }
    series?: { title?: string }
    episode?: { seasonNumber?: number; episodeNumber?: number }
  }
  type Queue = { records?: QueueRecord[] }
  const [rq, sq] = await Promise.all([
    RADARR_KEY ? arrJSON<Queue>(radarr, '/queue?pageSize=20&includeMovie=true').catch(() => null) : null,
    SONARR_KEY ? arrJSON<Queue>(sonarr, '/queue?pageSize=20&includeSeries=true&includeEpisode=true').catch(() => null) : null,
  ])
  const norm = (r: QueueRecord, kind: 'movie' | 'show') => ({
    kind,
    title: kind === 'movie'
      ? (r.movie?.title ? `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ''}` : r.title ?? 'unknown')
      : (r.series?.title
        ? `${r.series.title}${r.episode ? ` S${String(r.episode.seasonNumber ?? 0).padStart(2, '0')}E${String(r.episode.episodeNumber ?? 0).padStart(2, '0')}` : ''}`
        : r.title ?? 'unknown'),
    status: r.status ?? 'unknown',
    progress: r.size && r.size > 0 ? Math.round((1 - (r.sizeleft ?? 0) / r.size) * 100) : 0,
    timeleft: r.timeleft ?? null,
  })
  res.json({
    downloads: [
      ...(rq?.records ?? []).map((r) => norm(r, 'movie')),
      ...(sq?.records ?? []).map((r) => norm(r, 'show')),
    ],
  })
})

export default router
