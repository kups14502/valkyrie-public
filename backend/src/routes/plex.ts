import { Router } from 'express'
import { Readable, pipeline } from 'node:stream'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Agent, fetch as undiciFetch } from 'undici'
import { postDiscord } from '../alerts.js'
import { signImgToken } from '../auth/token.js'

// Plex library browsing + media requests.
//
// Browsing proxies the local Plex server (same box, loopback) so clients never
// need the Plex token. Requests ride the existing acquisition stack: movies go
// to Radarr, shows to Sonarr, albums to Lidarr (lookup -> add -> they search
// and download, Plex picks the file up). Free-text requests that the automated
// path can't resolve are journaled and posted to Discord, where the agent (or
// Brendon) picks them up — that's the "message an agent" path.

const router = Router()

const PLEX_URL = process.env.PLEX_URL || 'http://127.0.0.1:32400'
const PLEX_TOKEN = process.env.PLEX_TOKEN || ''
// The music library lives on a second Plex server (LogicServer, reached over
// the tailnet), not on odin's own. Same account owns both, so its token
// defaults to the main one. Unset PLEX_MUSIC_URL and the music routes answer
// 503 and no music tab appears.
const PLEX_MUSIC_URL = (process.env.PLEX_MUSIC_URL || '').replace(/\/+$/, '')
const PLEX_MUSIC_TOKEN = process.env.PLEX_MUSIC_TOKEN || PLEX_TOKEN
const RADARR_URL = process.env.RADARR_URL || 'http://127.0.0.1:7878'
const RADARR_KEY = process.env.RADARR_API_KEY || ''
const SONARR_URL = process.env.SONARR_URL || 'http://127.0.0.1:8989'
const SONARR_KEY = process.env.SONARR_API_KEY || ''
// Lidarr sits on LogicServer next to the music library, not on this box, and
// its API is v1 where Radarr and Sonarr are v3. Unset and album requests are
// simply absent from search.
const LIDARR_URL = (process.env.LIDARR_URL || '').replace(/\/+$/, '')
const LIDARR_KEY = process.env.LIDARR_API_KEY || ''
// Quality profile each service adds with, by name. Unset, or not found, and
// the service's first profile is used.
const RADARR_PROFILE = (process.env.RADARR_QUALITY_PROFILE || '').trim()
const SONARR_PROFILE = (process.env.SONARR_QUALITY_PROFILE || '').trim()
const LIDARR_PROFILE = (process.env.LIDARR_QUALITY_PROFILE || '').trim()

const REQUESTS_LOG = path.join(process.cwd(), 'data', 'media-requests.jsonl')

type PlexTarget = { name: 'main' | 'music'; url: string; token: string }
const mainServer: PlexTarget = { name: 'main', url: PLEX_URL, token: PLEX_TOKEN }
const musicServer: PlexTarget = { name: 'music', url: PLEX_MUSIC_URL, token: PLEX_MUSIC_TOKEN }

const plexConfigured = () => Boolean(PLEX_TOKEN)
const musicConfigured = () => Boolean(PLEX_MUSIC_URL && PLEX_MUSIC_TOKEN)
// Which server a client-supplied ?server= names. Anything but "music" is main.
const targetFor = (name: unknown): PlexTarget => (name === 'music' ? musicServer : mainServer)

// ---------- Upstream reachability ----------
//
// LogicServer (the music Plex and Lidarr) sits across the tailnet, and when it
// is offline its address swallows the SYN: every call to it waited out undici's
// 10 s connect timeout, which put 10 s on each downloads poll, 10 s on the tab
// list, and 20 s on every request search. So connects give up after 3 s, and an
// origin whose connect hung is refused on the spot. While any origin is marked,
// a TCP probe runs every 10 s whether or not anyone is calling, and clears the
// mark once the port stops hanging. Only slow failures mark an origin: a
// refused port or an unknown name fails in milliseconds on its own, and gating
// those would keep a restarted service refused after it came back.

const upstreamAgent = new Agent({ connect: { timeout: 3_000 } })
const SLOW_CONNECT_ERRORS = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'EAI_AGAIN',
])
const PROBE_EVERY_MS = 10_000
// origin -> when it was marked down
const unreachable = new Map<string, number>()
let prober: NodeJS.Timeout | undefined
let reprobing = false

// Null when the port accepts a connection, otherwise why it did not: 'timeout'
// or the socket error's code.
function probe(origin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let u: URL
    try { u = new URL(origin) } catch { return resolve('EINVAL') }
    const s = net.connect({
      host: u.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    })
    const done = (why: string | null) => { s.destroy(); resolve(why) }
    s.setTimeout(3_000, () => done('timeout'))
    s.once('connect', () => done(null))
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'))
  })
}

const isSlow = (why: string | null) => why === 'timeout' || (why !== null && SLOW_CONNECT_ERRORS.has(why))

async function reprobe() {
  if (reprobing) return
  reprobing = true
  await Promise.all([...unreachable.keys()].map(async (origin) => {
    const why = await probe(origin)
    if (isSlow(why)) return
    unreachable.delete(origin)
    console.log(`[plex] ${origin} answering again (${why ?? 'connected'})`)
  }))
  reprobing = false
  if (!unreachable.size && prober) {
    clearInterval(prober)
    prober = undefined
  }
}

function markDown(origin: string, why: string) {
  if (unreachable.has(origin)) return
  unreachable.set(origin, Date.now())
  console.warn(`[plex] ${origin} unreachable (${why}), refusing calls to it until a probe connects`)
  if (!prober) {
    prober = setInterval(() => void reprobe(), PROBE_EVERY_MS)
    prober.unref()
  }
}

function refuseIfDown(origin: string) {
  const since = unreachable.get(origin)
  if (since !== undefined) throw new Error(`${origin} unreachable since ${new Date(since).toISOString()}`)
}

const upstreamUp = (url: string) => {
  try { return !unreachable.has(new URL(url).origin) } catch { return true }
}

async function upstream(url: string | URL, init: NonNullable<Parameters<typeof undiciFetch>[1]> = {}) {
  const origin = new URL(url).origin
  refuseIfDown(origin)
  try {
    return await undiciFetch(url, { ...init, dispatcher: upstreamAgent })
  } catch (err) {
    const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } }).cause
    const code = cause?.code ?? cause?.errors?.[0]?.code
    if (code && SLOW_CONNECT_ERRORS.has(code)) markDown(origin, code)
    throw err
  }
}

// Learn LogicServer's state at startup instead of on the first page load.
for (const u of [PLEX_MUSIC_URL, LIDARR_URL]) {
  if (!URL.canParse(u)) continue
  const origin = new URL(u).origin
  if (origin === 'null') continue
  void probe(origin).then((why) => { if (isSlow(why)) markDown(origin, `startup probe: ${why}`) })
}

// ---------- Plex ----------

async function plexJSON<T>(srv: PlexTarget, p: string, params?: Record<string, string>, containerStart?: number, containerSize?: number): Promise<T> {
  const url = new URL(`${srv.url}${p}`)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = {
    'X-Plex-Token': srv.token,
    Accept: 'application/json',
  }
  if (containerSize !== undefined) {
    headers['X-Plex-Container-Start'] = String(containerStart ?? 0)
    headers['X-Plex-Container-Size'] = String(containerSize)
  }
  const r = await upstream(url, { headers, signal: AbortSignal.timeout(10_000) })
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
  // watch.plex.tv slugs. Present on items matched by the new Plex agents, which
  // is what makes a universal link into the Plex app possible.
  slug?: string
  parentSlug?: string
  grandparentSlug?: string
  index?: number
  parentIndex?: number
  // Music. A track's parent is its album and grandparent its artist;
  // originalTitle is the per-track artist on compilations; parentYear is the
  // album year as seen from a track.
  parentRatingKey?: string
  grandparentRatingKey?: string
  originalTitle?: string
  parentYear?: number
  lastViewedAt?: number
  viewCount?: number
  Genre?: { tag: string }[]
  // External ids ("tmdb://765"), only with includeGuids=1.
  Guid?: { id: string }[]
  Media?: {
    duration?: number
    bitrate?: number
    audioCodec?: string
    container?: string
    Part?: { key?: string; container?: string; size?: number }[]
  }[]
}
type PlexContainer<T> = { MediaContainer: { totalSize?: number; size?: number; Directory?: T[]; Metadata?: T[] } }

// Path on watch.plex.tv for this item, or null when Plex has no catalog match
// (personal media, home videos, unmatched files).
//
// This is the ONLY link shape that can open the native iOS/iPadOS Plex app:
// watch.plex.tv publishes an apple-app-site-association naming both Plex app
// IDs with /movie/* and /show/* components, whereas app.plex.tv publishes none
// and the plex:// scheme is ignored by the rewritten app (it opens on Home).
function watchPathFor(m: PlexMetadata): string | null {
  if (m.type === 'movie' && m.slug) return `/movie/${m.slug}`
  if (m.type === 'show' && m.slug) return `/show/${m.slug}`
  if (m.type === 'season' && m.parentSlug && m.index != null) {
    return `/show/${m.parentSlug}/season/${m.index}`
  }
  if (m.type === 'episode' && m.grandparentSlug && m.parentIndex != null && m.index != null) {
    return `/show/${m.grandparentSlug}/season/${m.parentIndex}/episode/${m.index}`
  }
  return null
}

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
    watchPath: watchPathFor(m),
  }
}
export type PlexItem = ReturnType<typeof normalizeItem>

// Section list changes rarely; totals are a separate cheap call. Cache 5 min,
// or 20 s when the music server failed, so its tab returns soon after it does.
type SectionSummary = { key: string; title: string; type: string; count: number; server: PlexTarget['name'] }
let sectionsCache: { at: number; ttl: number; data: SectionSummary[] } | null = null

// Every music section on the music server, with its artist count; null when
// the server did not answer. Fails soft: the movie/tv tabs must not disappear
// because LogicServer is asleep.
async function musicSections(): Promise<SectionSummary[] | null> {
  if (!musicConfigured()) return []
  try {
    const dirs = (await plexJSON<PlexContainer<PlexDirectory>>(musicServer, '/library/sections')).MediaContainer.Directory ?? []
    return await Promise.all(
      dirs
        .filter((d) => d.type === 'artist')
        .map(async (d) => {
          const c = await plexJSON<PlexContainer<never>>(musicServer, `/library/sections/${d.key}/all`, { type: '8' }, 0, 0)
            .catch(() => null)
          return { key: d.key, title: d.title, type: d.type, count: c?.MediaContainer.totalSize ?? 0, server: 'music' as const }
        }),
    )
  } catch (err) {
    console.warn('[plex] music server unreachable:', (err as Error).message)
    return null
  }
}

router.get('/plex/sections', async (_req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured', detail: 'set PLEX_URL / PLEX_TOKEN' })
  try {
    if (sectionsCache && Date.now() - sectionsCache.at < sectionsCache.ttl) return res.json(sectionsCache.data)
    const [dirs, music] = await Promise.all([
      plexJSON<PlexContainer<PlexDirectory>>(mainServer, '/library/sections').then((c) => c.MediaContainer.Directory ?? []),
      musicSections(),
    ])
    const sections = await Promise.all(
      dirs
        .filter((d) => d.type === 'movie' || d.type === 'show')
        .map(async (d): Promise<SectionSummary> => {
          // Zero-size page returns just the container header with totalSize.
          const c = await plexJSON<PlexContainer<never>>(mainServer, `/library/sections/${d.key}/all`, {}, 0, 0)
            .catch(() => null)
          return { key: d.key, title: d.title, type: d.type, count: c?.MediaContainer.totalSize ?? 0, server: 'main' }
        }),
    )
    const data = [...sections, ...(music ?? [])]
    sectionsCache = { at: Date.now(), ttl: music ? 300_000 : 20_000, data }
    res.json(data)
  } catch (err) {
    res.status(503).json({ error: 'plex unreachable', detail: (err as Error).message })
  }
})

// Server identity, for building Plex deep links on the client (opening an item
// in the real Plex app is how you get AirPlay to a TV — this app can't cast).
let serverCache: { at: number; data: { machineIdentifier: string; friendlyName: string; version: string } } | null = null

router.get('/plex/server', async (_req, res) => {
  if (!plexConfigured()) return res.status(503).json({ error: 'plex not configured' })
  try {
    if (serverCache && Date.now() - serverCache.at < 3600_000) return res.json(serverCache.data)
    const c = await plexJSON<{ MediaContainer: { machineIdentifier?: string; friendlyName?: string; version?: string } }>(mainServer, '/')
    const mc = c.MediaContainer
    if (!mc.machineIdentifier) throw new Error('no machineIdentifier in response')
    const data = {
      machineIdentifier: mc.machineIdentifier,
      friendlyName: mc.friendlyName ?? 'plex',
      version: mc.version ?? '',
    }
    serverCache = { at: Date.now(), data }
    res.json(data)
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
    const c = await plexJSON<PlexContainer<PlexMetadata>>(mainServer, `/library/sections/${section}/all`, params, offset, limit)
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
    const c = await plexJSON<PlexContainer<PlexMetadata>>(mainServer, '/library/recentlyAdded', {}, 0, limit)
    res.json({ items: (c.MediaContainer.Metadata ?? []).map(normalizeItem) })
  } catch (err) {
    res.status(503).json({ error: 'plex unreachable', detail: (err as Error).message })
  }
})

// Poster/art proxy. Streams Plex's photo transcoder so clients get right-sized
// JPEGs without ever seeing the Plex token. Path is restricted to Plex image
// paths (no arbitrary proxying). ?server=music reads album art and artist
// photos off the music server instead.
router.get('/plex/img', async (req, res) => {
  const srv = targetFor(req.query.server)
  if (srv === musicServer ? !musicConfigured() : !plexConfigured()) return res.status(503).json({ error: 'plex not configured' })
  const p = String(req.query.path ?? '')
  if (!/^\/(library|photo)\/[\w\-/:.]+$/.test(p)) return res.status(400).json({ error: 'invalid path' })
  const w = Math.min(1200, Math.max(60, Number(req.query.w) || 300))
  const h = Math.min(1800, Math.max(60, Number(req.query.h) || Math.round(w * 1.5)))
  try {
    const url = new URL(`${srv.url}/photo/:/transcode`)
    url.searchParams.set('width', String(w))
    url.searchParams.set('height', String(h))
    url.searchParams.set('minSize', '1')
    url.searchParams.set('upscale', '1')
    url.searchParams.set('url', p)
    const r = await upstream(url, {
      headers: { 'X-Plex-Token': srv.token },
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

// ---------- Music (second server) ----------
//
// Browsing follows Plex's own hierarchy: artist (type 8) -> album (9) ->
// track (10). Playback does not hand off to the Plex app the way movies do:
// tracks are direct-played in the page through /plex/music/stream, a
// range-aware proxy of the file part, so the browser's <audio> element can seek
// and the Plex token never leaves this box.

const MUSIC_TYPES = { artist: '8', album: '9', track: '10' } as const

// The one artist-type section on the music server, cached for an hour.
let musicSectionCache: { at: number; key: string; title: string } | null = null
async function musicSection(): Promise<{ key: string; title: string }> {
  if (musicSectionCache && Date.now() - musicSectionCache.at < 3600_000) return musicSectionCache
  const dirs = (await plexJSON<PlexContainer<PlexDirectory>>(musicServer, '/library/sections')).MediaContainer.Directory ?? []
  const d = dirs.find((x) => x.type === 'artist')
  if (!d) throw new Error('the music server has no music library')
  musicSectionCache = { at: Date.now(), key: d.key, title: d.title }
  return musicSectionCache
}

const genres = (m: PlexMetadata) => (m.Genre ?? []).map((g) => g.tag).filter(Boolean).slice(0, 4)

function normalizeArtist(m: PlexMetadata) {
  return {
    ratingKey: m.ratingKey ?? '',
    title: m.title || 'unknown artist',
    thumb: m.thumb ?? null,
    art: m.art ?? null,
    summary: m.summary ?? '',
    genres: genres(m),
    albumCount: m.childCount ?? null,
    addedAt: m.addedAt ?? null,
    lastPlayedAt: m.lastViewedAt ?? null,
  }
}
export type MusicArtist = ReturnType<typeof normalizeArtist>

function normalizeAlbum(m: PlexMetadata) {
  return {
    ratingKey: m.ratingKey ?? '',
    title: m.title || 'untitled',
    artist: m.parentTitle ?? '',
    artistKey: m.parentRatingKey ?? null,
    year: m.year ?? null,
    thumb: m.thumb || m.parentThumb || null,
    trackCount: m.leafCount ?? null,
    genres: genres(m),
    addedAt: m.addedAt ?? null,
    lastPlayedAt: m.lastViewedAt ?? null,
  }
}
export type MusicAlbum = ReturnType<typeof normalizeAlbum>

function normalizeTrack(m: PlexMetadata) {
  const media = m.Media?.[0]
  const part = media?.Part?.[0]
  return {
    ratingKey: m.ratingKey ?? '',
    title: m.title || 'untitled',
    index: m.index ?? null,
    disc: m.parentIndex ?? null,
    album: m.parentTitle ?? '',
    albumKey: m.parentRatingKey ?? null,
    artist: m.grandparentTitle ?? '',
    artistKey: m.grandparentRatingKey ?? null,
    // Set on compilations, where the album artist is "Various Artists".
    trackArtist: m.originalTitle ?? null,
    year: m.parentYear ?? null,
    duration: m.duration ?? null,
    thumb: m.thumb || m.parentThumb || m.grandparentThumb || null,
    // What /plex/music/stream takes. Null for a track Plex knows but has no
    // file for.
    streamKey: part?.key ?? null,
    container: part?.container ?? media?.container ?? null,
    codec: media?.audioCodec ?? null,
    bitrate: media?.bitrate ?? null,
  }
}
export type MusicTrack = ReturnType<typeof normalizeTrack>

const MUSIC_SORTS: Record<string, string> = {
  title: 'titleSort:asc',
  added: 'addedAt:desc',
  played: 'lastViewedAt:desc',
  year: 'year:desc',
}

const pageParams = (req: { query: Record<string, unknown> }) => ({
  offset: Math.max(0, Number(req.query.offset) || 0),
  limit: Math.min(120, Math.max(1, Number(req.query.limit) || 60)),
  search: String(req.query.search ?? '').slice(0, 100),
  sort: MUSIC_SORTS[String(req.query.sort ?? '')],
})

function musicGate(res: import('express').Response): boolean {
  if (musicConfigured()) return true
  res.status(503).json({ error: 'music not configured', detail: 'set PLEX_MUSIC_URL' })
  return false
}

const musicFail = (res: import('express').Response, err: unknown) =>
  res.status(503).json({ error: 'music server unreachable', detail: (err as Error).message })

router.get('/plex/music/artists', async (req, res) => {
  if (!musicGate(res)) return
  const { offset, limit, search, sort } = pageParams(req)
  try {
    const sec = await musicSection()
    const params: Record<string, string> = { type: MUSIC_TYPES.artist, sort: sort ?? MUSIC_SORTS.title }
    if (search) params.title = search
    const mc = (await plexJSON<PlexContainer<PlexMetadata>>(musicServer, `/library/sections/${sec.key}/all`, params, offset, limit)).MediaContainer
    res.json({ total: mc.totalSize ?? mc.size ?? 0, offset, items: (mc.Metadata ?? []).map(normalizeArtist) })
  } catch (err) {
    musicFail(res, err)
  }
})

// One artist by key, for the header of an artist page reached from an album
// (where only the name was known).
router.get('/plex/music/artist', async (req, res) => {
  if (!musicGate(res)) return
  const key = String(req.query.key ?? '')
  if (!/^\d+$/.test(key)) return res.status(400).json({ error: 'invalid key' })
  try {
    const m = (await plexJSON<PlexContainer<PlexMetadata>>(musicServer, `/library/metadata/${key}`)).MediaContainer.Metadata?.[0]
    if (!m || m.type !== 'artist') return res.status(404).json({ error: 'artist not found' })
    res.json(normalizeArtist(m))
  } catch (err) {
    musicFail(res, err)
  }
})

// ?artist=<key> lists that artist's albums; otherwise a page of every album.
router.get('/plex/music/albums', async (req, res) => {
  if (!musicGate(res)) return
  const artist = String(req.query.artist ?? '')
  const { offset, limit, search, sort } = pageParams(req)
  try {
    if (artist) {
      if (!/^\d+$/.test(artist)) return res.status(400).json({ error: 'invalid artist' })
      const mc = (await plexJSON<PlexContainer<PlexMetadata>>(musicServer, `/library/metadata/${artist}/children`)).MediaContainer
      const items = (mc.Metadata ?? []).filter((m) => m.type === 'album').map(normalizeAlbum)
      return res.json({ total: items.length, offset: 0, items })
    }
    const sec = await musicSection()
    const params: Record<string, string> = { type: MUSIC_TYPES.album, sort: sort ?? MUSIC_SORTS.added }
    if (search) params.title = search
    const mc = (await plexJSON<PlexContainer<PlexMetadata>>(musicServer, `/library/sections/${sec.key}/all`, params, offset, limit)).MediaContainer
    res.json({ total: mc.totalSize ?? mc.size ?? 0, offset, items: (mc.Metadata ?? []).map(normalizeAlbum) })
  } catch (err) {
    musicFail(res, err)
  }
})

// ?album=<key> is that album's tracks in order; ?artist=<key> is every track
// the artist has (Plex's allLeaves), which is what "play all" and shuffle use.
router.get('/plex/music/tracks', async (req, res) => {
  if (!musicGate(res)) return
  const album = String(req.query.album ?? '')
  const artist = String(req.query.artist ?? '')
  try {
    let p: string
    if (/^\d+$/.test(album)) p = `/library/metadata/${album}/children`
    else if (/^\d+$/.test(artist)) p = `/library/metadata/${artist}/allLeaves`
    else return res.status(400).json({ error: 'need album or artist' })
    const mc = (await plexJSON<PlexContainer<PlexMetadata>>(musicServer, p)).MediaContainer
    res.json({ items: (mc.Metadata ?? []).filter((m) => m.type === 'track').map(normalizeTrack) })
  } catch (err) {
    musicFail(res, err)
  }
})

// Substring title match across all three levels at once. Plex's hub search
// only surfaced tracks for music, so this asks each type directly.
router.get('/plex/music/search', async (req, res) => {
  if (!musicGate(res)) return
  const q = String(req.query.q ?? '').trim().slice(0, 100)
  if (q.length < 2) return res.json({ artists: [], albums: [], tracks: [] })
  try {
    const sec = await musicSection()
    const find = (type: string, sort: string) => plexJSON<PlexContainer<PlexMetadata>>(
      musicServer, `/library/sections/${sec.key}/all`, { type, title: q, sort }, 0, 12,
    ).then((c) => c.MediaContainer.Metadata ?? []).catch(() => [])
    const [artists, albums, tracks] = await Promise.all([
      find(MUSIC_TYPES.artist, MUSIC_SORTS.title),
      find(MUSIC_TYPES.album, MUSIC_SORTS.title),
      find(MUSIC_TYPES.track, MUSIC_SORTS.title),
    ])
    res.json({
      artists: artists.map(normalizeArtist),
      albums: albums.map(normalizeAlbum),
      tracks: tracks.map(normalizeTrack),
    })
  } catch (err) {
    musicFail(res, err)
  }
})

// Plex's own music hubs for the section: recently played artists and recently
// added albums. That is the landing view.
router.get('/plex/music/recent', async (req, res) => {
  if (!musicGate(res)) return
  const count = Math.min(24, Math.max(1, Number(req.query.count) || 12))
  try {
    const sec = await musicSection()
    type Hub = { hubIdentifier?: string; type?: string; Metadata?: PlexMetadata[] }
    const hubs = (await plexJSON<{ MediaContainer: { Hub?: Hub[] } }>(musicServer, `/hubs/sections/${sec.key}`, { count: String(count) })).MediaContainer.Hub ?? []
    const pick = (prefix: string) => hubs.find((h) => h.hubIdentifier?.startsWith(prefix))?.Metadata ?? []
    res.json({
      played: pick('music.recent.played').filter((m) => m.type === 'artist').map(normalizeArtist),
      added: pick('music.recent.added').filter((m) => m.type === 'album').map(normalizeAlbum),
    })
  } catch (err) {
    musicFail(res, err)
  }
})

// The audio itself. Forwards the browser's Range header and hands back Plex's
// 200/206 with its Content-Range, so <audio> can seek and resume. The key is
// pinned to Plex's part-file shape, so this can't be turned into a general
// proxy. No overall timeout: a long track streams at the client's pace, and a
// client that leaves tears the upstream fetch down through the abort.
const STREAM_KEY = /^\/library\/parts\/\d+\/\d+\/file\.[a-z0-9]{2,5}$/i

router.get('/plex/music/stream', async (req, res) => {
  if (!musicGate(res)) return
  const key = String(req.query.key ?? '')
  if (!STREAM_KEY.test(key)) return res.status(400).json({ error: 'invalid key' })
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())
  try {
    const headers: Record<string, string> = { 'X-Plex-Token': musicServer.token }
    if (typeof req.headers.range === 'string') headers.Range = req.headers.range
    const r = await upstream(`${musicServer.url}${key}`, { headers, signal: ctl.signal })
    if ((r.status !== 200 && r.status !== 206) || !r.body) {
      return res.status(r.status === 404 ? 404 : 502).json({ error: 'stream fetch failed', status: r.status })
    }
    res.status(r.status)
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h)
      if (v) res.setHeader(h, v)
    }
    // Part keys carry the file's version stamp, so a day of private caching is
    // safe; the URL may carry the media token, so never a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=86400')
    pipeline(
      Readable.fromWeb(r.body as import('node:stream/web').ReadableStream),
      res,
      (err) => {
        if (err && !ctl.signal.aborted) console.warn('[plex] music stream aborted:', (err as Error).message)
      },
    )
  } catch (err) {
    if (ctl.signal.aborted || res.headersSent) return
    res.status(502).json({ error: 'stream fetch failed', detail: (err as Error).message })
  }
})

// Mark a track played when it finishes, so Plex's own "recently played" (and
// this page's landing view) reflect what was played here.
router.post('/plex/music/scrobble', async (req, res) => {
  if (!musicGate(res)) return
  const key = String((req.body ?? {}).ratingKey ?? '')
  if (!/^\d+$/.test(key)) return res.status(400).json({ error: 'invalid key' })
  try {
    const url = new URL(`${musicServer.url}/:/scrobble`)
    url.searchParams.set('key', key)
    url.searchParams.set('identifier', 'com.plexapp.plugins.library')
    const r = await upstream(url, { headers: { 'X-Plex-Token': musicServer.token }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`scrobble -> ${r.status}`)
    res.json({ ok: true })
  } catch (err) {
    musicFail(res, err)
  }
})

// ---------- Requests (Radarr / Sonarr + agent journal) ----------

type ArrService = { name: string; base: string; key: string; api: string; profile: string }
const radarr: ArrService = { name: 'radarr', base: RADARR_URL, key: RADARR_KEY, api: '/api/v3', profile: RADARR_PROFILE }
const sonarr: ArrService = { name: 'sonarr', base: SONARR_URL, key: SONARR_KEY, api: '/api/v3', profile: SONARR_PROFILE }
const lidarr: ArrService = { name: 'lidarr', base: LIDARR_URL, key: LIDARR_KEY, api: '/api/v1', profile: LIDARR_PROFILE }
const lidarrConfigured = () => Boolean(LIDARR_URL && LIDARR_KEY)
const arrConfigured = () => Boolean(RADARR_KEY || SONARR_KEY || lidarrConfigured())

async function arrJSON<T>(svc: ArrService, p: string, init?: { method?: string; body?: string }): Promise<T> {
  const r = await upstream(`${svc.base}${svc.api}${p}`, {
    ...init,
    headers: { 'X-Api-Key': svc.key, 'Content-Type': 'application/json' },
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

type ArrMovie = {
  id?: number
  title: string
  year?: number
  tmdbId: number
  overview?: string
  remotePoster?: string
  hasFile?: boolean
  monitored?: boolean
  isAvailable?: boolean
  movieFile?: { relativePath?: string; quality?: { quality?: { name?: string } } }
}
type ArrSeries = { id?: number; title: string; year?: number; tvdbId: number; overview?: string; remotePoster?: string; statistics?: { episodeFileCount?: number; episodeCount?: number }; monitored?: boolean }
type ArrArtist = {
  id?: number
  artistName: string
  foreignArtistId: string
  qualityProfileId?: number
  metadataProfileId?: number
  rootFolderPath?: string
  monitored?: boolean
  monitorNewItems?: string
}
type ArrAlbum = {
  id?: number
  title: string
  // MusicBrainz release-group id: what a request names.
  foreignAlbumId: string
  releaseDate?: string
  albumType?: string
  remoteCover?: string
  images?: { coverType?: string; remoteUrl?: string; url?: string }[]
  artistId?: number
  artist?: ArrArtist
  monitored?: boolean
  statistics?: { trackFileCount?: number; trackCount?: number }
}

// Lidarr grabs an album only while the album AND its artist are monitored.
// A new artist comes out of its post-add refresh unmonitored whatever the add
// asked for, and a change made before that refresh ends is overwritten. So
// this waits for the artist's commands to finish, then monitors both and
// searches. Measured on odin's Lidarr 3.1: the refresh settles in about 2 s.
async function monitorAndSearch(artistId: number, albumId: number) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const cmds = await arrJSON<{ status?: string; body?: { artistId?: number; artistIds?: number[] } }[]>(lidarr, '/command')
    const mine = cmds.filter((c) => c.body?.artistId === artistId || c.body?.artistIds?.includes(artistId))
    if (!mine.some((c) => c.status === 'queued' || c.status === 'started')) break
    if (Date.now() > deadline) throw new Error(`lidarr: artist ${artistId} refresh still running after 30 s`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  const artist = await arrJSON<ArrArtist>(lidarr, `/artist/${artistId}`)
  if (!artist.monitored) await arrJSON(lidarr, `/artist/${artistId}`, { method: 'PUT', body: JSON.stringify({ ...artist, monitored: true }) })
  const album = await arrJSON<ArrAlbum>(lidarr, `/album/${albumId}`)
  if (!album.monitored) await arrJSON(lidarr, `/album/${albumId}`, { method: 'PUT', body: JSON.stringify({ ...album, monitored: true }) })
  await arrJSON(lidarr, '/command', { method: 'POST', body: JSON.stringify({ name: 'AlbumSearch', albumIds: [albumId] }) })
}

type QueueRecord = {
  title?: string
  status?: string
  trackedDownloadStatus?: string
  trackedDownloadState?: string
  statusMessages?: { title?: string; messages?: string[] }[]
  errorMessage?: string
  sizeleft?: number
  size?: number
  timeleft?: string
  movieId?: number
  seriesId?: number
  albumId?: number
  movie?: { title?: string; year?: number }
  series?: { title?: string }
  episode?: { seasonNumber?: number; episodeNumber?: number }
  album?: { title?: string }
  artist?: { artistName?: string }
}
type Queue = { records?: QueueRecord[] }

// Downloaded but not importable: the *arr is waiting on something it will not
// fix by itself (an archive, a name it cannot match, a failed import).
const IMPORT_PROBLEM = new Set(['importPending', 'importBlocked', 'failedPending'])
const queueProgress = (r: QueueRecord) => (r.size && r.size > 0 ? Math.round((1 - (r.sizeleft ?? 0) / r.size) * 100) : 0)
const queueText = (r: QueueRecord) =>
  [r.errorMessage, ...(r.statusMessages ?? []).flatMap((m) => [m.title, ...(m.messages ?? [])])].filter(Boolean).join(' ')

// A BR-DISK rip is a disc folder or image that Plex cannot play, so it counts
// as no file.
const isDiscImage = (m: ArrMovie | undefined) => Boolean(m?.hasFile && (
  m.movieFile?.quality?.quality?.name === 'BR-DISK' || /\.(iso|img)$/i.test(m.movieFile?.relativePath ?? '')
))

type SearchResult = {
  kind: 'movie' | 'show' | 'album'
  title: string
  // Album artist; null for movies and shows.
  artist: string | null
  year: number | null
  overview: string
  poster: string | null
  tmdbId: number | null
  tvdbId: number | null
  foreignAlbumId: string | null
  inLibrary: boolean
  downloaded: boolean
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// MusicBrainz leaves unknown dates as year 0001; that is no year at all.
function albumYear(a: ArrAlbum): number | null {
  const y = a.releaseDate ? Number(a.releaseDate.slice(0, 4)) : 0
  return y > 1000 ? y : null
}

// Lidarr's text search runs against its own metadata mirror, which trails
// MusicBrainz by weeks for new releases: the exact thing people request. So
// MusicBrainz is asked too, and any release group Lidarr's search missed is
// pulled through Lidarr by id, which it can do even when its search cannot.
const MB_UA = 'Valkyrie/1.0 (+https://valkyrie.brendonkupsch.com)'
async function musicBrainzReleaseGroupIds(q: string): Promise<string[]> {
  // Lucene syntax on the other end: strip its operators from what was typed.
  const words = q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').trim()
  if (!words) return []
  const url = new URL('https://musicbrainz.org/ws/2/release-group/')
  url.searchParams.set('query', `(${words}) AND (primarytype:album OR primarytype:ep)`)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('limit', '5')
  const r = await fetch(url, { headers: { 'User-Agent': MB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) })
  if (!r.ok) return []
  const body = (await r.json()) as { 'release-groups'?: { id: string; score?: number }[] }
  return (body['release-groups'] ?? []).filter((g) => (g.score ?? 0) >= 80).map((g) => g.id)
}

async function lidarrAlbumsFor(q: string): Promise<ArrAlbum[]> {
  // MusicBrainz ids are only worth fetching when Lidarr can resolve them.
  if (!upstreamUp(LIDARR_URL)) return []
  const [own, mbIds] = await Promise.all([
    arrJSON<ArrAlbum[]>(lidarr, `/album/lookup?term=${encodeURIComponent(q)}`).catch(() => [] as ArrAlbum[]),
    musicBrainzReleaseGroupIds(q).catch(() => [] as string[]),
  ])
  const seen = new Set(own.map((a) => a.foreignAlbumId))
  const extra = await Promise.all(mbIds.filter((id) => !seen.has(id)).slice(0, 4).map((id) =>
    arrJSON<ArrAlbum[]>(lidarr, `/album/lookup?term=${encodeURIComponent(`lidarr:${id}`)}`).then((r) => r[0] ?? null).catch(() => null),
  ))
  return [...own, ...extra.filter((a): a is ArrAlbum => Boolean(a?.foreignAlbumId))]
}

// Lidarr drops an album whose type the artist's metadata profile excludes on
// the next refresh, and every artist here sits on "Standard" (Albums only).
// Requesting an EP or single therefore moves the artist to a profile that is
// the same plus that type, created from the base on first use.
type MetadataProfile = {
  id?: number
  name: string
  primaryAlbumTypes: { albumType: { id: number; name: string }; allowed: boolean }[]
  secondaryAlbumTypes: unknown[]
  releaseStatuses: unknown[]
}
async function metadataProfileAllowing(artist: ArrArtist, albumType: string | undefined, d: ArrDefaults): Promise<number> {
  const baseId = artist.metadataProfileId || d.metadataProfileId
  if (!albumType) return baseId
  const profiles = await arrJSON<MetadataProfile[]>(lidarr, '/metadataprofile')
  const base = profiles.find((p) => p.id === baseId) ?? profiles[0]
  if (!base) return baseId
  const allows = (p: MetadataProfile) => p.primaryAlbumTypes.some((t) => t.allowed && t.albumType.name === albumType)
  if (allows(base)) return base.id ?? baseId
  const name = `${base.name} + ${albumType}`
  let target = profiles.find((p) => p.name === name && allows(p))
  if (!target) {
    const clone: MetadataProfile = {
      ...base,
      id: undefined,
      name,
      primaryAlbumTypes: base.primaryAlbumTypes.map((t) => (t.albumType.name === albumType ? { ...t, allowed: true } : t)),
    }
    delete clone.id
    target = await arrJSON<MetadataProfile>(lidarr, '/metadataprofile', { method: 'POST', body: JSON.stringify(clone) })
    console.log(`[plex] lidarr: created metadata profile "${name}"`)
  }
  if (artist.id && target.id) {
    const full = await arrJSON<ArrArtist>(lidarr, `/artist/${artist.id}`)
    await arrJSON(lidarr, `/artist/${artist.id}`, { method: 'PUT', body: JSON.stringify({ ...full, metadataProfileId: target.id }) })
  }
  return target.id ?? baseId
}

// How well a candidate matches what was typed. Each service returns its own
// loosely-sorted list, so without this an exact-title show loses to eight
// obscure same-word movies. An album also matches on "artist title", which is
// how people type one.
function score(r: SearchResult, q: string): number {
  const t = norm(r.title)
  const full = r.artist ? norm(`${r.artist} ${r.title}`) : t
  let n = 0
  if (t === q || full === q) n += 100
  else if (t.startsWith(q) || full.startsWith(q)) n += 50
  else if (t.includes(q) || full.includes(q)) n += 20
  if (r.poster) n += 5
  if (r.year) n += 3
  return n
}

router.get('/plex/request/search', async (req, res) => {
  if (!arrConfigured()) return res.status(503).json({ error: 'radarr/sonarr/lidarr not configured' })
  const q = String(req.query.q ?? '').trim().slice(0, 100)
  if (q.length < 2) return res.json({ results: [] })
  const term = encodeURIComponent(q)
  // Radarr's lookup carries no hasFile (and not always movieFile), so what is
  // on disk, disc images included, comes from its own movie list.
  const [movies, series, albums, ownMovies] = await Promise.all([
    RADARR_KEY ? arrJSON<ArrMovie[]>(radarr, `/movie/lookup?term=${term}`).catch(() => []) : [],
    SONARR_KEY ? arrJSON<ArrSeries[]>(sonarr, `/series/lookup?term=${term}`).catch(() => []) : [],
    lidarrConfigured() ? lidarrAlbumsFor(q) : [],
    radarrMovies(),
  ])
  // Lidarr's lookup says whether it knows an album (it has an id) but not
  // whether the files are down or the album is even monitored; that takes one
  // more call per known album. An album an artist brought along unmonitored
  // is still requestable, so "in library" means files or monitoring.
  const known = new Map<number, { files: number; monitored: boolean }>()
  await Promise.all(albums.filter((a) => a.id).slice(0, 6).map(async (a) => {
    const full = await arrJSON<ArrAlbum>(lidarr, `/album/${a.id}`).catch(() => null)
    if (full?.id) known.set(full.id, { files: full.statistics?.trackFileCount ?? 0, monitored: Boolean(full.monitored) })
  }))
  const nq = norm(q)
  const rank = (list: SearchResult[]) => list
    // Drop metadata stubs (no year and no artwork) — they're never the intent.
    .filter((r) => r.year || r.poster)
    .map((r) => ({ r, s: score(r, nq) }))
    .sort((a, b) => b.s - a.s)

  const onDisk = (m: ArrMovie) => {
    const own = ownMovies?.get(m.tmdbId)
    return own ? Boolean(own.hasFile) && !isDiscImage(own) : Boolean(m.hasFile)
  }
  const rankedMovies = rank(movies.map((m) => ({
    kind: 'movie' as const,
    title: m.title,
    artist: null,
    year: m.year ?? null,
    overview: (m.overview ?? '').slice(0, 300),
    poster: m.remotePoster ?? null,
    tmdbId: m.tmdbId,
    tvdbId: null,
    foreignAlbumId: null,
    inLibrary: Boolean(m.id),
    downloaded: onDisk(m),
  })))
  const rankedShows = rank(series.map((s) => ({
    kind: 'show' as const,
    title: s.title,
    artist: null,
    year: s.year ?? null,
    overview: (s.overview ?? '').slice(0, 300),
    poster: s.remotePoster ?? null,
    tmdbId: null,
    tvdbId: s.tvdbId,
    foreignAlbumId: null,
    inLibrary: Boolean(s.id),
    downloaded: (s.statistics?.episodeFileCount ?? 0) > 0,
  })))
  const rankedAlbums = rank(albums
    .filter((a) => a.foreignAlbumId && a.artist?.artistName)
    .map((a) => ({
      kind: 'album' as const,
      title: a.title,
      artist: a.artist?.artistName ?? null,
      year: albumYear(a),
      overview: a.albumType ?? '',
      poster: a.remoteCover ?? a.images?.find((i) => i.coverType === 'cover')?.remoteUrl ?? a.images?.[0]?.remoteUrl ?? null,
      tmdbId: null,
      tvdbId: null,
      foreignAlbumId: a.foreignAlbumId,
      inLibrary: Boolean(a.id && ((known.get(a.id)?.files ?? 0) > 0 || known.get(a.id)?.monitored)),
      downloaded: Boolean(a.id && (known.get(a.id)?.files ?? 0) > 0),
    })))

  // Merge highest-score-first across the kinds, breaking ties away from the
  // kind just taken, so a movie, a show, and an album that all match exactly
  // sit together at the top instead of one kind burying the others.
  // "severance" then puts the 2022 series in the first two rows.
  const lists = [rankedMovies, rankedShows, rankedAlbums]
  const cursors = lists.map(() => 0)
  const results: SearchResult[] = []
  let lastKind: SearchResult['kind'] | null = null
  while (results.length < 12) {
    let pick = -1
    for (let i = 0; i < lists.length; i += 1) {
      const c = lists[i][cursors[i]]
      if (!c) continue
      if (pick === -1) { pick = i; continue }
      const best = lists[pick][cursors[pick]]
      if (c.s > best.s || (c.s === best.s && best.r.kind === lastKind && c.r.kind !== lastKind)) pick = i
    }
    if (pick === -1) break
    const chosen = lists[pick][cursors[pick]]
    cursors[pick] += 1
    results.push(chosen.r)
    lastKind = chosen.r.kind
  }
  res.json({ results })
})

// Default quality profile (the named one when set) + root folder (+ metadata
// profile, a Lidarr-only concept), discovered once from each service.
type ArrDefaults = { at: number; qualityProfileId: number; rootFolderPath: string; metadataProfileId: number }
const arrDefaults = new Map<string, ArrDefaults>()
const profileWarned = new Set<string>()
async function getArrDefaults(svc: ArrService): Promise<ArrDefaults> {
  const hit = arrDefaults.get(svc.name)
  if (hit && Date.now() - hit.at < 600_000) return hit
  const isLidarr = svc.api === '/api/v1'
  const [profiles, roots, metas] = await Promise.all([
    arrJSON<{ id: number; name: string }[]>(svc, '/qualityprofile'),
    arrJSON<{ path: string }[]>(svc, '/rootfolder'),
    isLidarr ? arrJSON<{ id: number }[]>(svc, '/metadataprofile') : Promise.resolve<{ id: number }[]>([]),
  ])
  if (!profiles.length || !roots.length) throw new Error(`${svc.name}: no quality profile or root folder configured`)
  if (isLidarr && !metas.length) throw new Error(`${svc.name}: no metadata profile configured`)
  const named = svc.profile ? profiles.find((p) => p.name.toLowerCase() === svc.profile.toLowerCase()) : undefined
  if (svc.profile && !named && !profileWarned.has(svc.name)) {
    profileWarned.add(svc.name)
    console.warn(`[plex] ${svc.name}: no quality profile named "${svc.profile}", using "${profiles[0].name}"`)
  }
  const d: ArrDefaults = { at: Date.now(), qualityProfileId: (named ?? profiles[0]).id, rootFolderPath: roots[0].path, metadataProfileId: metas[0]?.id ?? 0 }
  arrDefaults.set(svc.name, d)
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
  const { kind, tmdbId, tvdbId, foreignAlbumId } = (req.body ?? {}) as { kind?: string; tmdbId?: number; tvdbId?: number; foreignAlbumId?: string }
  try {
    if (kind === 'movie' && typeof tmdbId === 'number' && RADARR_KEY) {
      const [movie] = await arrJSON<ArrMovie[]>(radarr, `/movie/lookup/tmdb?tmdbId=${tmdbId}`).then((m) => (Array.isArray(m) ? m : [m]))
      if (!movie) return res.status(404).json({ error: 'movie not found' })
      const d = await getArrDefaults(radarr)
      await arrJSON(radarr, '/movie', {
        method: 'POST',
        body: JSON.stringify({
          ...movie,
          qualityProfileId: d.qualityProfileId,
          rootFolderPath: d.rootFolderPath,
          monitored: true,
          // The lookup carries 'tba', which lets Radarr grab a cam the day a
          // movie is announced.
          minimumAvailability: 'released',
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
      const d = await getArrDefaults(sonarr)
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
    if (kind === 'album' && typeof foreignAlbumId === 'string' && /^[0-9a-f-]{36}$/i.test(foreignAlbumId) && lidarrConfigured()) {
      const [album] = await arrJSON<ArrAlbum[]>(lidarr, `/album/lookup?term=${encodeURIComponent(`lidarr:${foreignAlbumId}`)}`)
      if (!album?.artist) return res.status(404).json({ error: 'album not found' })
      const year = albumYear(album) ?? undefined
      const label = `${album.artist.artistName}: ${album.title}`
      const done = () => {
        journalAppend({ kind: 'album', title: album.title, artist: album.artist?.artistName, year, foreignAlbumId, status: 'queued' })
        void postDiscord(`🎵 media request: **${label}**${year ? ` (${year})` : ''} → lidarr, searching now`)
        return res.json({ ok: true, detail: `${label} sent to lidarr, it will appear in Plex once downloaded` })
      }
      // Lidarr already knows it. With files it is in the library; monitored
      // with a monitored artist it is already wanted; otherwise it came along
      // with its artist unmonitored, and monitoring both plus one search is
      // the request.
      const requestKnown = async (albumId: number) => {
        const current = await arrJSON<ArrAlbum>(lidarr, `/album/${albumId}`)
        if ((current.statistics?.trackFileCount ?? 0) > 0) return res.status(409).json({ error: 'already added', detail: 'it is already in the library' })
        const artistId = current.artistId ?? current.artist?.id
        if (!artistId) throw new Error(`lidarr: album ${albumId} has no artist`)
        const artist = await arrJSON<ArrArtist>(lidarr, `/artist/${artistId}`)
        if (current.monitored && artist.monitored) return res.status(409).json({ error: 'already added', detail: 'it is already being tracked — check downloads' })
        await monitorAndSearch(artistId, albumId)
        return done()
      }
      if (album.id) return requestKnown(album.id)
      const d = await getArrDefaults(lidarr)
      const metadataProfileId = await metadataProfileAllowing(album.artist, album.albumType, d)
      // Lidarr adds an album by taking its artist along: a new artist is created
      // with only this album monitored (albumsToMonitor; "monitor none" alone
      // unmonitors every album, this one included); an existing artist just
      // gains the album. The search waits for the post-add refresh, see
      // monitorAndSearch. Verified on odin's Lidarr 3.1 with a throwaway add.
      let added: ArrAlbum
      try {
        added = await arrJSON<ArrAlbum>(lidarr, '/album', {
          method: 'POST',
          body: JSON.stringify({
            ...album,
            monitored: true,
            addOptions: { searchForNewAlbum: false },
            artist: {
              ...album.artist,
              qualityProfileId: album.artist.qualityProfileId || d.qualityProfileId,
              metadataProfileId,
              rootFolderPath: album.artist.rootFolderPath || d.rootFolderPath,
              monitored: true,
              monitorNewItems: 'none',
              addOptions: { monitor: 'none', albumsToMonitor: [foreignAlbumId], searchForMissingAlbums: false },
            },
          }),
        })
      } catch (err) {
        // A profile change refreshes the artist, and that refresh can add the
        // album (unmonitored) before this POST lands. Then it is simply known.
        const e = err as Error & { status?: number; body?: string }
        if (!(e.status === 400 && /already/i.test(e.body ?? ''))) throw err
        const [again] = await arrJSON<ArrAlbum[]>(lidarr, `/album/lookup?term=${encodeURIComponent(`lidarr:${foreignAlbumId}`)}`)
        if (!again?.id) throw err
        return requestKnown(again.id)
      }
      const artistId = added.artistId ?? added.artist?.id
      if (!added.id || !artistId) throw new Error('lidarr: add returned no album or artist id')
      await monitorAndSearch(artistId, added.id)
      return done()
    }
    return res.status(400).json({ error: 'invalid request', detail: 'need kind=movie+tmdbId, kind=show+tvdbId, or kind=album+foreignAlbumId' })
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

// ---------- Live request status ----------
//
// The journal only records that a request was sent. The history shows where
// each item stands now, read from the *arrs and Plex and cached 30 s. A failed
// lookup is not cached, so the next poll asks again, and until one answers its
// entries keep the journal's status.

type JournalEntry = {
  at: string
  kind: 'movie' | 'show' | 'album' | 'message'
  title?: string
  tmdbId?: number
  tvdbId?: number
  foreignAlbumId?: string
  status?: string
  message?: string
}
type Tone = 'done' | 'active' | 'stuck' | 'waiting'
type LiveStatus = { status: string; tone?: Tone; progress?: number }
type Lookups = {
  // Keyed by tmdbId / tvdbId / foreignAlbumId. An album missing from the map
  // failed its lookup; null means Lidarr does not have it.
  movies: Map<number, ArrMovie> | null
  movieQueue: QueueRecord[] | null
  series: Map<number, ArrSeries> | null
  seriesQueue: QueueRecord[] | null
  albums: Map<string, ArrAlbum | null>
  albumQueue: QueueRecord[] | null
  plex: { tmdb: Set<number>; tvdb: Set<number> } | null
}

// notBefore is the newest journal time the data has to cover. A request added
// after the cached copy was read (the search right before an add reads the
// Radarr list) would otherwise show as missing for up to 30 s.
const lookupCache = new Map<string, { at: number; data: unknown }>()
async function cachedLookup<T>(key: string, load: () => Promise<T>, notBefore = 0): Promise<T | null> {
  const hit = lookupCache.get(key)
  if (hit && hit.at >= notBefore && Date.now() - hit.at < 30_000) return hit.data as T
  const data = await load().catch(() => null)
  if (data !== null) lookupCache.set(key, { at: Date.now(), data })
  return data
}

const byKey = <K, T>(list: T[], key: (t: T) => K) => new Map(list.map((t) => [key(t), t]))
const radarrMovies = (notBefore = 0) => (RADARR_KEY
  ? cachedLookup('radarr-movies', () => arrJSON<ArrMovie[]>(radarr, '/movie').then((l) => byKey(l, (m) => m.tmdbId)), notBefore)
  : Promise.resolve(null))
const arrQueue = (svc: ArrService, p: string, notBefore = 0) =>
  cachedLookup(`${svc.name}-queue`, () => arrJSON<Queue>(svc, p).then((q) => q.records ?? []), notBefore)

// Lidarr 3.1's /album takes a foreignAlbumId filter. The id is matched again
// here, so a build that ignores the filter still resolves the right album.
const lidarrAlbum = (foreignAlbumId: string, notBefore = 0) => cachedLookup(`lidarr-album:${foreignAlbumId}`, async () => {
  const list = await arrJSON<ArrAlbum[]>(lidarr, `/album?foreignAlbumId=${encodeURIComponent(foreignAlbumId)}`)
  const hit = list.find((a) => a.id && a.foreignAlbumId === foreignAlbumId)
  if (hit?.id && !hit.statistics) return { album: await arrJSON<ArrAlbum>(lidarr, `/album/${hit.id}`) }
  return { album: hit ?? null }
}, notBefore)

// External ids of everything in the main server's movie and show sections.
// Movies carry tvdb guids too, so each set only takes its own section type.
async function plexGuids() {
  const dirs = (await plexJSON<PlexContainer<PlexDirectory>>(mainServer, '/library/sections')).MediaContainer.Directory ?? []
  const tmdb = new Set<number>()
  const tvdb = new Set<number>()
  await Promise.all(dirs.filter((d) => d.type === 'movie' || d.type === 'show').map(async (d) => {
    const items = (await plexJSON<PlexContainer<PlexMetadata>>(mainServer, `/library/sections/${d.key}/all`, { includeGuids: '1' })).MediaContainer.Metadata ?? []
    const scheme = d.type === 'movie' ? 'tmdb://' : 'tvdb://'
    const into = d.type === 'movie' ? tmdb : tvdb
    for (const m of items) {
      for (const g of m.Guid ?? []) if (g.id.startsWith(scheme)) into.add(Number(g.id.slice(scheme.length)))
    }
  }))
  return { tmdb, tvdb }
}

async function gatherLookups(entries: JournalEntry[]): Promise<Lookups> {
  const has = (kind: JournalEntry['kind']) => entries.some((e) => e.kind === kind)
  const newest = (match: (e: JournalEntry) => boolean) =>
    Math.max(0, ...entries.filter(match).map((e) => Date.parse(e.at)).filter(Number.isFinite))
  const since = (kind: JournalEntry['kind']) => newest((e) => e.kind === kind)
  const albumIds = [...new Set(entries.flatMap((e) => (e.kind === 'album' && e.foreignAlbumId ? [e.foreignAlbumId] : [])))]
  const [movies, movieQueue, series, seriesQueue, albumQueue, plex, albums] = await Promise.all([
    has('movie') ? radarrMovies(since('movie')) : null,
    has('movie') && RADARR_KEY ? arrQueue(radarr, '/queue?pageSize=200&includeMovie=true', since('movie')) : null,
    has('show') && SONARR_KEY ? cachedLookup('sonarr-series', () => arrJSON<ArrSeries[]>(sonarr, '/series').then((l) => byKey(l, (s) => s.tvdbId)), since('show')) : null,
    has('show') && SONARR_KEY ? arrQueue(sonarr, '/queue?pageSize=200&includeSeries=true', since('show')) : null,
    albumIds.length && lidarrConfigured() ? arrQueue(lidarr, '/queue?pageSize=200&includeAlbum=true', since('album')) : null,
    (has('movie') || has('show')) && plexConfigured() ? cachedLookup('plex-guids', plexGuids) : null,
    lidarrConfigured()
      ? Promise.all(albumIds.map(async (id) => [id, await lidarrAlbum(id, newest((e) => e.kind === 'album' && e.foreignAlbumId === id))] as const))
      : [],
  ])
  const albumMap = new Map<string, ArrAlbum | null>()
  for (const [id, hit] of albums) if (hit) albumMap.set(id, hit.album)
  return { movies, movieQueue, series, seriesQueue, albums: albumMap, albumQueue, plex }
}

// The queue record that says the most: an import problem, then a live
// download, then whatever is left.
const pickQueue = (records: QueueRecord[]) =>
  records.find((r) => IMPORT_PROBLEM.has(r.trackedDownloadState ?? '')) ?? records.find((r) => r.status === 'downloading') ?? records[0]

const QUEUE_WORDS: Record<string, string> = {
  queued: 'queued', paused: 'paused', delay: 'delayed', completed: 'completed', failed: 'failed',
  downloadClientUnavailable: 'client offline', fallback: 'fallback',
}
// A record that is neither stuck on import nor downloading. A stalled torrent
// comes back as status 'warning' with trackedDownloadStatus 'ok', so the
// status counts toward stuck as well.
function queueState(r: QueueRecord): LiveStatus {
  const status = r.status === 'warning' ? (/stalled/i.test(queueText(r)) ? 'stalled' : 'warning')
    : r.trackedDownloadState === 'importing' ? 'importing'
    : QUEUE_WORDS[r.status ?? ''] ?? (r.status ?? 'unknown').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ').slice(0, 2).join(' ')
  const bad = ['warning', 'error'].includes(r.trackedDownloadStatus ?? '') || r.status === 'warning' || r.status === 'failed'
  return { status, tone: bad ? 'stuck' : 'active' }
}

function fromQueue(r: QueueRecord, archiveHint: boolean): LiveStatus {
  if (IMPORT_PROBLEM.has(r.trackedDownloadState ?? '')) {
    return { status: archiveHint && /archive/i.test(queueText(r)) ? 'import stuck: archive' : 'import stuck', tone: 'stuck' }
  }
  if (r.status === 'downloading') {
    const progress = queueProgress(r)
    return { status: `downloading ${progress}%`, tone: 'active', progress }
  }
  return queueState(r)
}

// The low-grade qualities the Valkyrie profile disallows. Unknown stays out:
// playable m2ts files come in as Unknown.
const CAM_QUALITIES = new Set(['WORKPRINT', 'CAM', 'TELESYNC', 'TELECINE', 'REGIONAL', 'DVDSCR'])

function liveStatus(e: JournalEntry, l: Lookups): LiveStatus {
  const unknown: LiveStatus = { status: e.status ?? e.kind }
  if (e.kind === 'message') return { status: 'agent' }
  if (e.kind === 'movie') {
    if (!l.movies || !l.movieQueue || !l.plex || typeof e.tmdbId !== 'number') return unknown
    const m = l.movies.get(e.tmdbId)
    if (l.plex.tmdb.has(e.tmdbId)) {
      const cam = m?.hasFile && CAM_QUALITIES.has(m.movieFile?.quality?.quality?.name ?? '')
      if (!cam) return { status: 'in plex', tone: 'done' }
      // The real release that replaces a cam shows its download.
      const cq = m ? pickQueue(l.movieQueue.filter((r) => r.movieId === m.id)) : undefined
      return cq ? fromQueue(cq, true) : { status: 'in plex · cam', tone: 'waiting' }
    }
    if (!m) return { status: 'not in radarr', tone: 'stuck' }
    const q = pickQueue(l.movieQueue.filter((r) => r.movieId === m.id))
    if (q) return fromQueue(q, true)
    if (isDiscImage(m)) return { status: 'disc image', tone: 'stuck' }
    if (m.hasFile) return { status: 'downloaded', tone: 'active' }
    if (!m.isAvailable) return { status: 'not out yet', tone: 'waiting' }
    if (m.monitored) return { status: 'searching', tone: 'waiting' }
    return { status: 'unmonitored', tone: 'stuck' }
  }
  if (e.kind === 'show') {
    if (!l.series || !l.seriesQueue || !l.plex || typeof e.tvdbId !== 'number') return unknown
    const s = l.series.get(e.tvdbId)
    if (!s) return { status: 'not in sonarr', tone: 'stuck' }
    const files = s.statistics?.episodeFileCount ?? 0
    const count = s.statistics?.episodeCount ?? 0
    if (count > 0 && files >= count) {
      return l.plex.tvdb.has(e.tvdbId) ? { status: 'in plex', tone: 'done' } : { status: 'downloaded', tone: 'active' }
    }
    const eps = `${files}/${count} eps`
    const q = pickQueue(l.seriesQueue.filter((r) => r.seriesId === s.id))
    if (!q) return s.monitored ? { status: `${eps} · searching`, tone: 'waiting' } : { status: `${eps} · unmonitored`, tone: 'stuck' }
    if (IMPORT_PROBLEM.has(q.trackedDownloadState ?? '')) return { status: `${eps} · import stuck`, tone: 'stuck' }
    if (q.status === 'downloading') return { status: `${eps} · downloading`, tone: 'active' }
    const other = queueState(q)
    return { status: `${eps} · ${other.status}`, tone: other.tone }
  }
  if (e.kind === 'album') {
    if (!l.albumQueue || !e.foreignAlbumId || !l.albums.has(e.foreignAlbumId)) return unknown
    const a = l.albums.get(e.foreignAlbumId)
    if (!a?.id) return { status: 'not in lidarr', tone: 'stuck' }
    const files = a.statistics?.trackFileCount ?? 0
    const count = a.statistics?.trackCount ?? 0
    if (count > 0 && files >= count) return { status: 'in library', tone: 'done' }
    const q = pickQueue(l.albumQueue.filter((r) => r.albumId === a.id))
    if (q) return fromQueue(q, false)
    // An unmonitored artist keeps a monitored album out of wanted.
    if (a.monitored && a.artist?.monitored !== false) return { status: 'searching', tone: 'waiting' }
    return { status: 'unmonitored', tone: 'stuck' }
  }
  return unknown
}

// Newest first, one row per item: a repeat request of the same movie, show, or
// album drops the older rows. Messages are never merged.
function readJournal(): JournalEntry[] {
  if (!existsSync(REQUESTS_LOG)) return []
  const seen = new Set<string>()
  return readFileSync(REQUESTS_LOG, 'utf8').trim().split('\n')
    .slice(-50)
    .map((l) => { try { return JSON.parse(l) as JournalEntry } catch { return null } })
    .filter((e): e is JournalEntry => Boolean(e && typeof e === 'object' && e.kind))
    .reverse()
    .filter((e) => {
      const id = e.kind === 'movie' ? e.tmdbId : e.kind === 'show' ? e.tvdbId : e.kind === 'album' ? e.foreignAlbumId : undefined
      if (id === undefined) return true
      const key = `${e.kind}:${id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

router.get('/plex/requests', async (_req, res) => {
  let entries: JournalEntry[]
  try {
    entries = readJournal()
  } catch (err) {
    return res.status(500).json({ error: 'journal unreadable', detail: (err as Error).message })
  }
  const lookups = await gatherLookups(entries)
  res.json({ requests: entries.map((e) => ({ ...e, ...liveStatus(e, lookups), journalStatus: e.status })) })
})

// Live download queue across both services, for the requests tab + pad mode.
router.get('/plex/downloads', async (_req, res) => {
  if (!arrConfigured()) return res.json({ downloads: [] })
  const [rq, sq, lq] = await Promise.all([
    RADARR_KEY ? arrJSON<Queue>(radarr, '/queue?pageSize=200&includeMovie=true').catch(() => null) : null,
    SONARR_KEY ? arrJSON<Queue>(sonarr, '/queue?pageSize=200&includeSeries=true&includeEpisode=true').catch(() => null) : null,
    lidarrConfigured() ? arrJSON<Queue>(lidarr, '/queue?pageSize=200&includeArtist=true&includeAlbum=true').catch(() => null) : null,
  ])
  const queueTitle = (r: QueueRecord, kind: 'movie' | 'show' | 'album'): string => {
    if (kind === 'movie' && r.movie?.title) return `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ''}`
    if (kind === 'show' && r.series?.title) {
      const ep = r.episode ? ` S${String(r.episode.seasonNumber ?? 0).padStart(2, '0')}E${String(r.episode.episodeNumber ?? 0).padStart(2, '0')}` : ''
      return `${r.series.title}${ep}`
    }
    if (kind === 'album' && r.album?.title) return `${r.artist?.artistName ? `${r.artist.artistName}: ` : ''}${r.album.title}`
    return r.title ?? 'unknown'
  }
  const norm = (r: QueueRecord, kind: 'movie' | 'show' | 'album') => ({
    kind,
    title: queueTitle(r, kind),
    status: r.status ?? 'unknown',
    progress: queueProgress(r),
    timeleft: r.timeleft ?? null,
    state: r.trackedDownloadState,
    stuck: IMPORT_PROBLEM.has(r.trackedDownloadState ?? '') || r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error',
    // Sonarr puts a stalled torrent's reason in errorMessage, not statusMessages.
    message: (r.statusMessages?.find((m) => m.messages?.length)?.messages?.[0] ?? r.errorMessage)?.slice(0, 120),
  })
  res.json({
    downloads: [
      ...(rq?.records ?? []).map((r) => norm(r, 'movie')),
      ...(sq?.records ?? []).map((r) => norm(r, 'show')),
      ...(lq?.records ?? []).map((r) => norm(r, 'album')),
    ],
  })
})

export default router
