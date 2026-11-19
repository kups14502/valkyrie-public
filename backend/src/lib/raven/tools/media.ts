import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { RavenToolCtx } from '../types.js'
import { apiJson, clip, et, needBrendon, RavenToolError, routeError, toolRun } from './util.js'

// Plex requests, through the same routes Media > Requests uses
// (routes/plex.ts on loopback): search Radarr, Sonarr and Lidarr, add one,
// and the live status of what was asked for. Something already on Plex is
// never requested again.

type Kind = 'movie' | 'show' | 'album'
type SearchResult = {
  kind: Kind; title: string; artist: string | null; year: number | null; overview: string; poster: string | null
  tmdbId: number | null; tvdbId: number | null; foreignAlbumId: string | null; inLibrary: boolean; downloaded: boolean
}
type RequestEntry = { at: string; kind: string; title?: string; message?: string; status?: string; tone?: string; progress?: number }

async function search(q: string): Promise<SearchResult[]> {
  const { status, body } = await apiJson<{ results?: SearchResult[] }>(`/plex/request/search?q=${encodeURIComponent(q)}`)
  if (status === 503) throw new RavenToolError('media requests are not set up on odin (Radarr, Sonarr and Lidarr keys)')
  if (status !== 200) throw new RavenToolError(`the media search failed: ${routeError(body, status)}`)
  return body?.results ?? []
}

const idOf = (r: Pick<SearchResult, 'kind' | 'tmdbId' | 'tvdbId' | 'foreignAlbumId'>) =>
  (r.kind === 'movie' ? r.tmdbId : r.kind === 'show' ? r.tvdbId : r.foreignAlbumId)

// the routes' own wording has dashes; Raven's never does
const plain = (s: string | undefined) => (s ?? '').replace(/\s*\u2014\s*/g, ', ')

const nameOf = (r: Pick<SearchResult, 'title' | 'artist' | 'year'>) => `${r.artist ? `${r.artist}: ` : ''}${r.title}${r.year ? ` (${r.year})` : ''}`

export function registerMediaTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('media_search', {
    description: 'Search movies, shows and albums to request for Plex. onPlex means it is already there to watch or play; requested means it is '
      + 'already being fetched. Pass the result\'s kind and id to media_request.',
    inputSchema: { query: z.string().min(2).max(100), kind: z.enum(['movie', 'show', 'album']).optional() },
  }, (a) => toolRun(async () => {
    const results = (await search(a.query)).filter((r) => !a.kind || r.kind === a.kind).slice(0, 8)
    if (!results.length) return `Nothing found for "${a.query}".`
    return results.map((r) => ({
      kind: r.kind, title: r.title, artist: r.artist ?? undefined, year: r.year ?? undefined,
      tmdbId: r.tmdbId ?? undefined, tvdbId: r.tvdbId ?? undefined, foreignAlbumId: r.foreignAlbumId ?? undefined,
      onPlex: r.downloaded || undefined, requested: (r.inLibrary && !r.downloaded) || undefined,
      about: r.overview ? clip(r.overview, 160) : undefined,
    }))
  }))

  server.registerTool('media_requests', {
    description: 'What was requested lately and where each one stands now (in plex, downloading N%, searching, stuck...), newest first.',
    inputSchema: { limit: z.number().int().min(1).max(30).optional() },
  }, (a) => toolRun(async () => {
    const { status, body } = await apiJson<{ requests?: RequestEntry[] }>('/plex/requests')
    if (status !== 200) throw new RavenToolError(`the request list failed: ${routeError(body, status)}`)
    return (body?.requests ?? []).slice(0, a.limit ?? 10).map((r) => ({
      title: r.kind === 'message' ? clip(r.message ?? '', 120) : r.title, kind: r.kind, status: r.status, stuck: r.tone === 'stuck' || undefined, asked: et(r.at),
    }))
  }))

  server.registerTool('media_request', {
    description: 'Request a movie (tmdbId), show (tvdbId) or album (foreignAlbumId) for Plex, from a media_search result. title is its name as shown. '
      + 'Something already on Plex is not requested again. Only when Brendon\'s message asks.',
    inputSchema: {
      kind: z.enum(['movie', 'show', 'album']), title: z.string().min(1).max(200),
      tmdbId: z.number().int().optional(), tvdbId: z.number().int().optional(), foreignAlbumId: z.string().max(40).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'A media request')
    const id = a.kind === 'movie' ? a.tmdbId : a.kind === 'show' ? a.tvdbId : a.foreignAlbumId
    if (id === undefined) throw new RavenToolError(`a ${a.kind} needs its ${a.kind === 'movie' ? 'tmdbId' : a.kind === 'show' ? 'tvdbId' : 'foreignAlbumId'} from media_search`)
    // the same search the screen ran: on Plex already means there is nothing to ask for
    const hit = (await search(a.title).catch(() => [])).find((r) => r.kind === a.kind && idOf(r) === id)
    if (hit?.downloaded) return `${nameOf(hit)} is already on Plex. Nothing was requested.`
    const { status, body } = await apiJson<{ ok?: boolean; detail?: string; error?: string }>('/plex/request/add', {
      method: 'POST',
      body: { kind: a.kind, tmdbId: a.tmdbId, tvdbId: a.tvdbId, foreignAlbumId: a.foreignAlbumId },
      timeoutMs: 60_000,
    })
    if (status === 409) return `${hit ? nameOf(hit) : a.title} was requested before: ${plain(body?.detail) || 'it is already being tracked'}.`
    if (status !== 200 || !body?.ok) throw new RavenToolError(`the request failed: ${routeError(body, status)}`)
    ctx.acted()
    return { requested: hit ? nameOf(hit) : a.title, detail: plain(body.detail) }
  }))
}
