import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ok, fail } from './util.js'

// Media tools: add movies (Radarr) and TV shows (Sonarr) to the library by
// natural language. Downloads flow through the existing qBittorrent/Prowlarr
// pipeline and land in Plex automatically — "add" here means "add + search".
// API keys live in backend/.env on odin (read from each app's config.xml).

const RADARR_URL = process.env.RADARR_URL || 'http://127.0.0.1:7878'
const SONARR_URL = process.env.SONARR_URL || 'http://127.0.0.1:8989'
const RADARR_KEY = process.env.RADARR_API_KEY || ''
const SONARR_KEY = process.env.SONARR_API_KEY || ''

type Kind = 'movie' | 'show'
const cfg = (kind: Kind) =>
  kind === 'movie'
    ? { base: RADARR_URL, key: RADARR_KEY, app: 'Radarr' }
    : { base: SONARR_URL, key: SONARR_KEY, app: 'Sonarr' }

async function arr<T = any>(kind: Kind, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const { base, key, app } = cfg(kind)
  if (!key) throw new Error(`${app} API key not configured (set ${kind === 'movie' ? 'RADARR' : 'SONARR'}_API_KEY in backend/.env)`)
  const res = await fetch(`${base}/api/v3${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'X-Api-Key': key,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json() as any
      const first = Array.isArray(body) ? body[0] : body
      if (first?.errorMessage || first?.message) msg = `${msg}: ${first.errorMessage ?? first.message}`
    } catch { /* keep plain status */ }
    throw new Error(`${app} ${path} failed (${msg})`)
  }
  return res.json() as Promise<T>
}

// Result shape shared by lookups so the UI card renderer has one format.
function briefMovie(m: any) {
  return {
    kind: 'movie' as const,
    title: String(m.title ?? ''),
    year: m.year ?? null,
    tmdbId: m.tmdbId ?? null,
    overview: String(m.overview ?? '').slice(0, 300),
    poster: m.remotePoster ?? m.images?.find((i: any) => i.coverType === 'poster')?.remoteUrl ?? null,
    runtime: m.runtime ?? null,
    inLibrary: Boolean(m.id),
    downloaded: Boolean(m.hasFile),
  }
}

function briefShow(s: any) {
  return {
    kind: 'show' as const,
    title: String(s.title ?? ''),
    year: s.year ?? null,
    tvdbId: s.tvdbId ?? null,
    overview: String(s.overview ?? '').slice(0, 300),
    poster: s.remotePoster ?? s.images?.find((i: any) => i.coverType === 'poster')?.remoteUrl ?? null,
    seasons: Array.isArray(s.seasons) ? s.seasons.filter((x: any) => x.seasonNumber > 0).length : null,
    status: s.status ?? null,
    inLibrary: Boolean(s.id),
  }
}

async function firstRootFolder(kind: Kind): Promise<string> {
  const folders = await arr<any[]>(kind, '/rootfolder')
  const p = folders?.[0]?.path
  if (!p) throw new Error(`no ${kind === 'movie' ? 'Radarr' : 'Sonarr'} root folder configured`)
  return String(p)
}

async function defaultQualityProfile(kind: Kind): Promise<number> {
  const profiles = await arr<any[]>(kind, '/qualityprofile')
  const id = profiles?.[0]?.id
  if (!id) throw new Error('no quality profile configured')
  return Number(id)
}

export const mediaTools = [
  tool(
    'search_media',
    'Search for a movie or TV show to add to the Plex library (movies via Radarr, shows via Sonarr). Returns top matches with year, overview, and whether it is already in the library. ALWAYS search before adding.',
    { query: z.string().min(1).max(200), kind: z.enum(['movie', 'show']) },
    async (args) => {
      try {
        const results = args.kind === 'movie'
          ? (await arr<any[]>('movie', `/movie/lookup?term=${encodeURIComponent(args.query)}`)).slice(0, 5).map(briefMovie)
          : (await arr<any[]>('show', `/series/lookup?term=${encodeURIComponent(args.query)}`)).slice(0, 5).map(briefShow)
        return ok({ results })
      } catch (e) { return fail(e) }
    },
  ),
  tool(
    'add_media',
    'Add a movie (by tmdbId) or TV show (by tvdbId) to the library and start searching for it. Get the id from search_media first. New content downloads automatically and appears in Plex when done.',
    {
      kind: z.enum(['movie', 'show']),
      id: z.number().int().positive().describe('tmdbId for movies, tvdbId for shows'),
    },
    async (args) => {
      try {
        if (args.kind === 'movie') {
          const [match] = await arr<any[]>('movie', `/movie/lookup/tmdb?tmdbId=${args.id}`)
            .catch(() => [])
            .then((r) => (Array.isArray(r) ? r : [r]))
          if (!match) throw new Error(`tmdbId ${args.id} not found`)
          if (match.id) return ok({ alreadyInLibrary: true, ...briefMovie(match) })
          const added = await arr<any>('movie', '/movie', {
            method: 'POST',
            body: {
              ...match,
              qualityProfileId: Number(process.env.RADARR_QUALITY_PROFILE_ID) || await defaultQualityProfile('movie'),
              rootFolderPath: process.env.RADARR_ROOT_FOLDER || await firstRootFolder('movie'),
              monitored: true,
              addOptions: { searchForMovie: true },
            },
          })
          return ok({ added: true, ...briefMovie(added) })
        }
        const results = await arr<any[]>('show', `/series/lookup?term=tvdb:${args.id}`)
        const match = results?.[0]
        if (!match) throw new Error(`tvdbId ${args.id} not found`)
        if (match.id) return ok({ alreadyInLibrary: true, ...briefShow(match) })
        const added = await arr<any>('show', '/series', {
          method: 'POST',
          body: {
            ...match,
            qualityProfileId: Number(process.env.SONARR_QUALITY_PROFILE_ID) || await defaultQualityProfile('show'),
            rootFolderPath: process.env.SONARR_ROOT_FOLDER || await firstRootFolder('show'),
            monitored: true,
            addOptions: { searchForMissingEpisodes: true },
          },
        })
        return ok({ added: true, ...briefShow(added) })
      } catch (e) { return fail(e) }
    },
  ),
  tool(
    'media_queue',
    'Show what is currently downloading (movies and TV episodes), with progress and ETA. Use when asked "is it done yet" / "what is downloading".',
    {},
    async () => {
      try {
        const [movies, shows] = await Promise.all([
          arr<any>('movie', '/queue?pageSize=20&includeMovie=true').catch(() => null),
          arr<any>('show', '/queue?pageSize=20&includeSeries=true&includeEpisode=true').catch(() => null),
        ])
        const items = [
          ...(movies?.records ?? []).map((r: any) => ({
            kind: 'movie',
            title: r.movie?.title ?? r.title ?? 'unknown',
            status: r.status ?? 'unknown',
            progress: r.size > 0 ? Math.round((1 - (r.sizeleft ?? 0) / r.size) * 100) : null,
            eta: r.timeleft ?? null,
          })),
          ...(shows?.records ?? []).map((r: any) => ({
            kind: 'show',
            title: r.series?.title
              ? `${r.series.title}${r.episode ? ` S${String(r.episode.seasonNumber).padStart(2, '0')}E${String(r.episode.episodeNumber).padStart(2, '0')}` : ''}`
              : r.title ?? 'unknown',
            status: r.status ?? 'unknown',
            progress: r.size > 0 ? Math.round((1 - (r.sizeleft ?? 0) / r.size) * 100) : null,
            eta: r.timeleft ?? null,
          })),
        ]
        return ok({ downloading: items, count: items.length })
      } catch (e) { return fail(e) }
    },
  ),
]
