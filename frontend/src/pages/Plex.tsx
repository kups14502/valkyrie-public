import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cast, ChevronLeft, Clapperboard, Disc3, Download, Loader2, MessageSquare, Pause, Play, Search, Send,
  Shuffle, Star, User, X,
} from 'lucide-react'
import {
  addMediaRequest, fetchAlbumTracks, fetchArtistAlbums, fetchArtistTracks, fetchImgToken,
  fetchMediaDownloads, fetchMediaRequests, fetchMusicAlbums, fetchMusicArtist, fetchMusicArtists,
  fetchMusicRecent, fetchPlexLibrary, fetchPlexRecent, fetchPlexSections, fetchPlexServer, musicImg,
  onTailnet, openInApp, plexAppItemLink, plexImg, plexWatchLink, plexWebItemLink, searchMediaRequests,
  searchMusic, sendMediaMessage, shouldDeferAppClick,
  type MusicAlbum, type MusicArtist, type MusicTrack, type PlexItem, type PlexSection,
} from '../lib/api'
import { playQueue, playShuffled, toggle, useIsPlaying, useNowPlayingKey } from '../lib/player'

// Plex library browser + media requests. Tabs: one per Plex section (movies /
// tv, plus music from the second server), recently added, and the request
// pipeline (search radarr/sonarr, one tap to queue; free text goes to the
// agent). Movies and TV hand off to the Plex app; music plays in the page.

type Tab = { id: string; label: string; kind: 'section' | 'recent' | 'requests'; section?: PlexSection }

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const runtime = (ms: number | null) => {
  if (!ms) return null
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

export default function Plex() {
  const [tabId, setTabId] = useState<string | null>(null)
  const sections = useQuery({
    queryKey: ['plex-sections'],
    queryFn: fetchPlexSections,
    refetchInterval: false,
    staleTime: 300_000,
  })
  // Off-tailnet clients need the image-scoped token before posters can load.
  const imgTok = useQuery({
    queryKey: ['plex-img-token'],
    queryFn: fetchImgToken,
    enabled: !onTailnet,
    refetchInterval: 6 * 3600_000,
    staleTime: Infinity,
    retry: 1,
  })
  const imagesReady = onTailnet || imgTok.isFetched

  const tabs = useMemo<Tab[]>(() => {
    const s = (sections.data ?? []).map((sec) => ({
      id: `section-${sec.key}`,
      label: sec.type === 'movie' ? 'movies' : sec.type === 'show' ? 'tv' : sec.type === 'artist' ? 'music' : sec.title.toLowerCase(),
      kind: 'section' as const,
      section: sec,
    }))
    return [...s, { id: 'recent', label: 'recent', kind: 'recent' }, { id: 'requests', label: 'requests', kind: 'requests' }]
  }, [sections.data])

  const active = tabs.find((t) => t.id === tabId) ?? tabs[0]

  if (sections.isLoading || !imagesReady) {
    return <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; scanning library<span className="cursor-blink">_</span></div>
  }
  if (sections.isError) {
    return (
      <div className="panel mx-auto max-w-md p-6 text-center">
        <div className="text-sm text-[var(--color-danger)]">plex unreachable</div>
        <div className="mt-2 text-xs text-[var(--color-text-dim)]">{String((sections.error as { detail?: string })?.detail ?? 'is the server up?')}</div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTabId(t.id)}
            className={`border px-4 py-2.5 text-xs uppercase tracking-[0.14em] transition-colors ${
              active?.id === t.id
                ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.12)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/40'
            }`}
          >
            {t.label}
            {t.section ? <span className="ml-2 text-[9px] text-[var(--color-text-faint)]">{t.section.count}</span> : null}
          </button>
        ))}
      </div>
      {active?.kind === 'section' && active.section && (
        active.section.type === 'artist'
          ? <MusicBrowser key={`music-${active.section.key}`} section={active.section} />
          : <SectionGrid key={active.section.key} section={active.section} />
      )}
      {active?.kind === 'recent' && <RecentGrid />}
      {active?.kind === 'requests' && <Requests />}
    </div>
  )
}

// ---------- library grid ----------

function SectionGrid({ section }: { section: PlexSection }) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('added')
  const q = useDebounced(search.trim(), 350)
  const [selected, setSelected] = useState<PlexItem | null>(null)

  // useInfiniteQuery keys pages to (section, search, sort), so a response from
  // an old query can never be appended to a new one (the manual accumulate-
  // in-state version had exactly that race).
  const lib = useInfiniteQuery({
    queryKey: ['plex-lib', section.key, q, sort],
    queryFn: ({ pageParam }) => fetchPlexLibrary(section.key, pageParam, { search: q, sort }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    refetchInterval: false,
    staleTime: 120_000,
  })

  const total = lib.data?.pages[0]?.total ?? 0
  // Dedupe by ratingKey: under the default recently-added sort, an item added
  // to the library between page fetches shifts offsets and repeats a row.
  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: PlexItem[] = []
    for (const i of lib.data?.pages.flatMap((p) => p.items) ?? []) {
      if (!seen.has(i.ratingKey)) { seen.add(i.ratingKey); out.push(i) }
    }
    return out
  }, [lib.data])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 focus-within:border-[var(--color-accent)]">
          <Search size={14} className="shrink-0 text-[var(--color-text-faint)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`search ${section.title.toLowerCase()}…`}
            className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] sm:text-sm"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <X size={14} />
            </button>
          )}
        </label>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort"
          className="border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent)]"
        >
          <option value="added">recently added</option>
          <option value="title">title</option>
          <option value="year">year</option>
          <option value="rating">rating</option>
        </select>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{total} items</span>
      </div>

      {lib.isLoading ? (
        <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-text-faint)]">no matches</div>
      ) : (
        <>
          <PosterGrid items={items} onSelect={setSelected} />
          {lib.hasNextPage && (
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => void lib.fetchNextPage()}
                disabled={lib.isFetchingNextPage}
                className="border border-[var(--color-border)] px-6 py-3 text-xs uppercase tracking-[0.16em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] active:border-[var(--color-accent)] disabled:opacity-50"
              >
                {lib.isFetchingNextPage ? 'loading…' : `load more (${items.length} / ${total})`}
              </button>
            </div>
          )}
        </>
      )}
      {selected && <DetailOverlay item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function RecentGrid() {
  const [selected, setSelected] = useState<PlexItem | null>(null)
  const recent = useQuery({
    queryKey: ['plex-recent'],
    queryFn: () => fetchPlexRecent(36),
    refetchInterval: 60_000,
  })
  if (recent.isLoading) {
    return <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
  }
  if (recent.isError) {
    return (
      <div className="py-16 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-danger)]">
        plex unreachable — {String((recent.error as { detail?: string })?.detail ?? 'recent items unavailable')}
      </div>
    )
  }
  if ((recent.data?.length ?? 0) === 0) {
    return <div className="py-16 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-text-faint)]">nothing added recently</div>
  }
  return (
    <>
      <PosterGrid items={recent.data ?? []} onSelect={setSelected} />
      {selected && <DetailOverlay item={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

function PosterGrid({ items, onSelect }: { items: PlexItem[]; onSelect: (i: PlexItem) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {items.map((item) => (
        <button
          key={item.ratingKey}
          type="button"
          onClick={() => onSelect(item)}
          className="group border border-[var(--color-border)] bg-[var(--color-surface)] text-left transition hover:border-[var(--color-accent)]/60"
        >
          <div className="relative aspect-[2/3] w-full overflow-hidden bg-[var(--color-surface-2)]">
            {item.thumb ? (
              <img
                src={plexImg(item.thumb, 300)}
                alt={item.title}
                loading="lazy"
                className="h-full w-full object-cover transition group-hover:opacity-90"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[var(--color-text-faint)]">
                <Clapperboard size={28} />
              </div>
            )}
            {item.rating != null && (
              <span className="absolute right-1 top-1 flex items-center gap-1 bg-black/80 px-1.5 py-0.5 text-[10px] text-[var(--color-accent-2)]">
                <Star size={9} /> {item.rating.toFixed(1)}
              </span>
            )}
          </div>
          <div className="p-2">
            <div className="truncate text-xs text-[var(--color-text)]">{item.title}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--color-text-faint)]">
              {item.year && <span>{item.year}</span>}
              {item.type === 'show' && item.childCount != null && <span>{item.childCount} season{item.childCount === 1 ? '' : 's'}</span>}
              {item.type === 'movie' && item.duration != null && <span>{runtime(item.duration)}</span>}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

function DetailOverlay({ item, onClose }: { item: PlexItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Portaled out of <main> so touch scrolling can't chain into the poster grid
  // behind the overlay (html itself is overflow:hidden, so there's nowhere for
  // the chain to go); overscroll-contain stops the panel's own edge-bounce.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 sm:items-center" onMouseDown={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-2xl overflow-y-auto overscroll-contain border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-4 sm:p-6"
        style={{ boxShadow: '0 0 40px rgba(0,0,0,0.8), 0 0 14px rgba(var(--color-accent-rgb),0.15)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          {item.thumb && (
            <img src={plexImg(item.thumb, 220)} alt="" className="hidden w-32 shrink-0 border border-[var(--color-border)] sm:block" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-bold text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>{item.title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="-m-2 shrink-0 p-2 text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
                <X size={18} />
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-faint)]">
              {item.year && <span>{item.year}</span>}
              {item.contentRating && <span className="border border-[var(--color-border)] px-1.5 py-0.5">{item.contentRating}</span>}
              {item.duration != null && item.type === 'movie' && <span>{runtime(item.duration)}</span>}
              {item.leafCount != null && item.type === 'show' && <span>{item.leafCount} episodes</span>}
              {item.rating != null && <span className="flex items-center gap-1 text-[var(--color-accent-2)]"><Star size={10} /> {item.rating.toFixed(1)}</span>}
            </div>
            {item.summary && <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-dim)]">{item.summary}</p>}
            <PlayInPlex ratingKey={item.ratingKey} watchPath={item.watchPath} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Hands off to Plex to actually play. Valkyrie can't AirPlay (a page can only
// cast a <video> it owns), so watching on the TV means opening the Plex app,
// which offers AirPlay from its own player. On iOS that's a plex:// link, which
// must navigate in place and does nothing when Plex isn't installed — hence the
// web link alongside it.
function PlayInPlex({ ratingKey, watchPath }: { ratingKey: string; watchPath: string | null }) {
  const server = useQuery({ queryKey: ['plex-server'], queryFn: fetchPlexServer, staleTime: Infinity, retry: 1 })

  // With a catalog match, a bare link tap to watch.plex.tv opens the Plex app on
  // this title. No JS interception: that would skip universal-link matching.
  if (watchPath) {
    return (
      <a
        href={plexWatchLink(watchPath)}
        className="mt-4 inline-flex min-h-12 items-center gap-2 border border-[var(--color-accent)] px-5 text-xs uppercase tracking-[0.16em] text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] active:bg-[rgba(var(--color-accent-rgb),0.14)]"
      >
        <Cast size={15} /> open in plex
      </a>
    )
  }

  if (!server.data) return null
  const { machineIdentifier } = server.data
  const web = plexWebItemLink(machineIdentifier, ratingKey)
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <a
        href={web}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (shouldDeferAppClick(e)) return
          e.preventDefault()
          openInApp(plexAppItemLink(machineIdentifier, ratingKey), web)
        }}
        className="inline-flex min-h-12 items-center gap-2 border border-[var(--color-accent)] px-5 text-xs uppercase tracking-[0.16em] text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] active:bg-[rgba(var(--color-accent-rgb),0.14)]"
      >
        <Cast size={15} /> play in plex
      </a>
      <a
        href={web}
        target="_blank"
        rel="noreferrer"
        className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)] underline hover:text-[var(--color-text-dim)]"
      >
        plex web
      </a>
    </div>
  )
}

// ---------- requests ----------

function Requests() {
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 400)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const results = useQuery({
    queryKey: ['media-search', dq],
    queryFn: () => searchMediaRequests(dq),
    enabled: dq.length >= 2,
    refetchInterval: false,
    staleTime: 60_000,
  })
  const history = useQuery({ queryKey: ['media-requests'], queryFn: fetchMediaRequests, refetchInterval: 30_000 })
  const downloads = useQuery({ queryKey: ['media-downloads'], queryFn: fetchMediaDownloads, refetchInterval: 15_000 })

  // One timer, replaced on each flash — otherwise an earlier timeout clears a
  // newer notice early.
  const noticeTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])
  const flash = (kind: 'ok' | 'err', text: string) => {
    window.clearTimeout(noticeTimer.current)
    setNotice({ kind, text })
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }

  const add = useMutation({
    mutationFn: addMediaRequest,
    onSuccess: (r) => {
      flash('ok', r.detail)
      void queryClient.invalidateQueries({ queryKey: ['media-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['media-downloads'] })
    },
    onError: (e: { detail?: string }) => flash('err', e.detail ?? 'request failed'),
  })

  const sendMsg = useMutation({
    mutationFn: sendMediaMessage,
    onSuccess: (r) => {
      flash('ok', r.detail)
      setMessage('')
      void queryClient.invalidateQueries({ queryKey: ['media-requests'] })
    },
    onError: (e: { detail?: string }) => flash('err', e.detail ?? 'send failed'),
  })

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {notice && (
        <div className={`border px-4 py-3 text-sm ${notice.kind === 'ok' ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]' : 'border-[var(--color-danger)] text-[var(--color-danger)]'}`}>
          {notice.text}
        </div>
      )}

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>&gt; request new media</h2>
        <label className="mt-3 flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 focus-within:border-[var(--color-accent)]">
          <Search size={14} className="shrink-0 text-[var(--color-text-faint)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="movie, show, or album…"
            className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] sm:text-sm"
          />
          {results.isFetching && <Loader2 size={14} className="animate-spin text-[var(--color-text-faint)]" />}
        </label>

        {dq.length >= 2 && results.data && (
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {results.data.length === 0 && !results.isFetching && (
              <li className="py-3 text-xs text-[var(--color-text-faint)]">nothing found — try the agent below</li>
            )}
            {results.data.map((r) => (
              <li key={`${r.kind}-${r.tmdbId ?? r.tvdbId ?? r.foreignAlbumId}`} className="flex items-center gap-3 py-3">
                <div className={`shrink-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)] ${r.kind === 'album' ? 'h-14 w-14' : 'h-16 w-11'}`}>
                  {r.poster
                    ? <img src={r.poster} alt="" loading="lazy" className="h-full w-full object-cover" />
                    : r.kind === 'album'
                      ? <Disc3 size={16} className="m-auto mt-5 text-[var(--color-text-faint)]" />
                      : <Clapperboard size={16} className="m-auto mt-5 text-[var(--color-text-faint)]" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--color-text)]">
                    {r.title} {r.year && <span className="text-[var(--color-text-faint)]">({r.year})</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                    {r.kind === 'movie' ? 'movie' : r.kind === 'show' ? 'tv show' : `album · ${r.artist ?? ''}`}
                  </div>
                </div>
                {r.inLibrary ? (
                  <span className="shrink-0 border border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                    {r.downloaded ? 'in library' : 'tracking'}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={add.isPending}
                    onClick={() => add.mutate(r)}
                    className="shrink-0 border border-[var(--color-accent)] px-4 py-2.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-50"
                  >
                    request
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
          <MessageSquare size={12} /> &gt; message the agent
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-dim)]">
          Can't find it above, or want something specific (a season, a quality, anything unusual)? Describe it and the agent takes it from there.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); if (message.trim().length >= 3) sendMsg.mutate(message.trim()) }}
          className="mt-3 flex gap-2"
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='e.g. "get season 2 of Severance in 4K"'
            className="min-w-0 flex-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] sm:text-sm"
          />
          <button
            type="submit"
            disabled={sendMsg.isPending || message.trim().length < 3}
            aria-label="Send to agent"
            className="shrink-0 border border-[var(--color-accent)] px-4 py-2.5 text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </form>
      </section>

      {(downloads.data?.length ?? 0) > 0 && (
        <section className="panel p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
            <Download size={12} /> &gt; downloading now
          </h2>
          <ul className="mt-3 space-y-3">
            {downloads.data!.map((d, i) => (
              <li key={`${d.title}-${i}`}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-[var(--color-text)]">{d.title}</span>
                  <span className="shrink-0 text-[var(--color-text-faint)]">{d.progress}%{d.timeleft ? ` · ${d.timeleft}` : ''}</span>
                </div>
                <div className="mt-1 h-1.5 w-full bg-[var(--color-surface-2)]">
                  <div className="h-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]" style={{ width: `${d.progress}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel p-4 sm:p-5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>&gt; request history</h2>
        {(history.data?.length ?? 0) === 0 ? (
          <p className="mt-3 text-xs text-[var(--color-text-faint)]">nothing requested yet</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {history.data!.map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex items-center gap-3 py-2.5 text-xs">
                <span className="shrink-0 text-[var(--color-text-faint)]">{new Date(r.at).toLocaleDateString()}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--color-text)]">
                  {r.kind === 'message' ? `"${r.message}"` : `${r.artist ? `${r.artist}: ` : ''}${r.title}${r.year ? ` (${r.year})` : ''}`}
                </span>
                <span className="shrink-0 border border-[var(--color-border)] px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                  {r.kind === 'message' ? 'agent' : r.status ?? r.kind}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ---------- music ----------
//
// The music section is on a second Plex server and plays in the page through
// lib/player.ts rather than handing off to the Plex app. Views: a landing page
// built from Plex's recently played / recently added hubs, the full artist and
// album lists, one artist, one album, and a search across all three levels.
// Navigation is a small in-memory stack, not the URL: the tab already is.

type MusicView =
  | { kind: 'home' }
  | { kind: 'artists' }
  | { kind: 'albums' }
  | { kind: 'artist'; key: string; seed?: MusicArtist }
  | { kind: 'album'; key: string; seed?: MusicAlbum }

type MusicNav = {
  openArtist: (key: string, seed?: MusicArtist) => void
  openAlbum: (key: string, seed?: MusicAlbum) => void
}

const trackTime = (ms: number | null) => {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Squares are smaller than posters, so the grid holds one more column per step.
const tileGrid = 'grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8'
const chip = (on: boolean) =>
  `border px-3 py-2 text-[11px] uppercase tracking-[0.14em] transition-colors ${
    on
      ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.12)] text-[var(--color-accent)]'
      : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/40'
  }`
const actionBtn = 'inline-flex min-h-11 items-center gap-2 border border-[var(--color-accent)] px-4 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] active:bg-[rgba(var(--color-accent-rgb),0.14)] disabled:opacity-40'
const selectCls = 'border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-xs uppercase tracking-[0.12em] text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent)]'

const MusicLoading = () => (
  <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
)
const MusicEmpty = ({ children }: { children: ReactNode }) => (
  <div className="py-16 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{children}</div>
)
const MusicError = ({ error }: { error: unknown }) => (
  <div className="py-16 text-center text-xs uppercase tracking-[0.2em] text-[var(--color-danger)]">
    music unreachable: {String((error as { detail?: string })?.detail ?? 'is the music server up?')}
  </div>
)
const MusicHead = ({ children }: { children: ReactNode }) => (
  <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}>
    &gt; {children}
  </h2>
)

function dedupeByKey<T extends { ratingKey: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const i of items) {
    if (!seen.has(i.ratingKey)) { seen.add(i.ratingKey); out.push(i) }
  }
  return out
}

function MusicBrowser({ section }: { section: PlexSection }) {
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim(), 350)
  const [view, setView] = useState<MusicView>({ kind: 'home' })
  const [stack, setStack] = useState<MusicView[]>([])

  const open = (v: MusicView) => {
    setStack((s) => [...s, view])
    setView(v)
    setSearch('')
  }
  const back = () => {
    const prev = stack[stack.length - 1]
    setStack((s) => s.slice(0, -1))
    setView(prev ?? { kind: 'home' })
  }
  const root = (v: MusicView) => {
    setStack([])
    setView(v)
  }
  const nav: MusicNav = {
    openArtist: (key, seed) => open({ kind: 'artist', key, seed }),
    openAlbum: (key, seed) => open({ kind: 'album', key, seed }),
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {stack.length > 0 && !q && (
          <button type="button" onClick={back} className={`${chip(false)} inline-flex items-center gap-1`}>
            <ChevronLeft size={14} /> back
          </button>
        )}
        <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 focus-within:border-[var(--color-accent)]">
          <Search size={14} className="shrink-0 text-[var(--color-text-faint)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search artists, albums, tracks…"
            className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] sm:text-sm"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <X size={14} />
            </button>
          )}
        </label>
        {!q && (
          <div className="flex gap-1">
            {(['home', 'artists', 'albums'] as const).map((k) => (
              <button key={k} type="button" onClick={() => root({ kind: k })} className={chip(view.kind === k)}>{k}</button>
            ))}
          </div>
        )}
      </div>

      {q
        ? <MusicSearch q={q} nav={nav} />
        : view.kind === 'home' ? <MusicHome nav={nav} onBrowse={root} artistCount={section.count} />
        : view.kind === 'artists' ? <ArtistList nav={nav} />
        : view.kind === 'albums' ? <AlbumList nav={nav} />
        : view.kind === 'artist' ? <ArtistView key={view.key} artistKey={view.key} seed={view.seed} nav={nav} />
        : <AlbumView key={view.key} albumKey={view.key} seed={view.seed} nav={nav} />}
    </div>
  )
}

function ArtistTile({ artist, onClick }: { artist: MusicArtist; onClick: () => void }) {
  const sub = artist.albumCount != null
    ? `${artist.albumCount} album${artist.albumCount === 1 ? '' : 's'}`
    : artist.genres[0] ?? ''
  return (
    <button
      type="button"
      onClick={onClick}
      className="group border border-[var(--color-border)] bg-[var(--color-surface)] text-left transition hover:border-[var(--color-accent)]/60"
    >
      <div className="aspect-square w-full overflow-hidden bg-[var(--color-surface-2)]">
        {artist.thumb ? (
          <img src={musicImg(artist.thumb, 300)} alt={artist.title} loading="lazy" className="h-full w-full object-cover transition group-hover:opacity-90" />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-text-faint)]"><User size={28} /></div>
        )}
      </div>
      <div className="p-2">
        <div className="truncate text-xs text-[var(--color-text)]">{artist.title}</div>
        <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-faint)]">{sub}</div>
      </div>
    </button>
  )
}

function AlbumTile({ album, onClick }: { album: MusicAlbum; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group border border-[var(--color-border)] bg-[var(--color-surface)] text-left transition hover:border-[var(--color-accent)]/60"
    >
      <div className="aspect-square w-full overflow-hidden bg-[var(--color-surface-2)]">
        {album.thumb ? (
          <img src={musicImg(album.thumb, 300)} alt={album.title} loading="lazy" className="h-full w-full object-cover transition group-hover:opacity-90" />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--color-text-faint)]"><Disc3 size={28} /></div>
        )}
      </div>
      <div className="p-2">
        <div className="truncate text-xs text-[var(--color-text)]">{album.title}</div>
        <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-faint)]">
          {[album.artist, album.year].filter(Boolean).join(' · ')}
        </div>
      </div>
    </button>
  )
}

function MoreButton({ onClick, busy, loaded, total }: { onClick: () => void; busy: boolean; loaded: number; total: number }) {
  return (
    <div className="mt-6 text-center">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="border border-[var(--color-border)] px-6 py-3 text-xs uppercase tracking-[0.16em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] active:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'loading…' : `load more (${loaded} / ${total})`}
      </button>
    </div>
  )
}

function MusicHome({ nav, onBrowse, artistCount }: { nav: MusicNav; onBrowse: (v: MusicView) => void; artistCount: number }) {
  const recent = useQuery({
    queryKey: ['music-recent'],
    queryFn: fetchMusicRecent,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  if (recent.isLoading) return <MusicLoading />
  if (recent.isError) return <MusicError error={recent.error} />
  const played = recent.data?.played ?? []
  const added = recent.data?.added ?? []
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onBrowse({ kind: 'artists' })} className={actionBtn}>
          <User size={14} /> all artists <span className="text-[9px] text-[var(--color-text-faint)]">{artistCount}</span>
        </button>
        <button type="button" onClick={() => onBrowse({ kind: 'albums' })} className={actionBtn}>
          <Disc3 size={14} /> all albums
        </button>
      </div>
      {played.length > 0 && (
        <section>
          <MusicHead>recently played</MusicHead>
          <div className={tileGrid}>
            {played.map((a) => <ArtistTile key={a.ratingKey} artist={a} onClick={() => nav.openArtist(a.ratingKey, a)} />)}
          </div>
        </section>
      )}
      {added.length > 0 && (
        <section>
          <MusicHead>recently added</MusicHead>
          <div className={tileGrid}>
            {added.map((al) => <AlbumTile key={al.ratingKey} album={al} onClick={() => nav.openAlbum(al.ratingKey, al)} />)}
          </div>
        </section>
      )}
      {played.length === 0 && added.length === 0 && <MusicEmpty>nothing played or added yet</MusicEmpty>}
    </div>
  )
}

function ArtistList({ nav }: { nav: MusicNav }) {
  const [sort, setSort] = useState('title')
  const lib = useInfiniteQuery({
    queryKey: ['music-artists', sort],
    queryFn: ({ pageParam }) => fetchMusicArtists(pageParam, { sort }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    refetchInterval: false,
    staleTime: 300_000,
  })
  const total = lib.data?.pages[0]?.total ?? 0
  const items = useMemo(() => dedupeByKey(lib.data?.pages.flatMap((p) => p.items) ?? []), [lib.data])
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" className={selectCls}>
          <option value="title">a to z</option>
          <option value="added">recently added</option>
          <option value="played">recently played</option>
        </select>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{total} artists</span>
      </div>
      {lib.isLoading ? <MusicLoading /> : lib.isError ? <MusicError error={lib.error} /> : items.length === 0 ? <MusicEmpty>no artists</MusicEmpty> : (
        <>
          <div className={tileGrid}>
            {items.map((a) => <ArtistTile key={a.ratingKey} artist={a} onClick={() => nav.openArtist(a.ratingKey, a)} />)}
          </div>
          {lib.hasNextPage && <MoreButton onClick={() => void lib.fetchNextPage()} busy={lib.isFetchingNextPage} loaded={items.length} total={total} />}
        </>
      )}
    </div>
  )
}

function AlbumList({ nav }: { nav: MusicNav }) {
  const [sort, setSort] = useState('added')
  const lib = useInfiniteQuery({
    queryKey: ['music-albums', sort],
    queryFn: ({ pageParam }) => fetchMusicAlbums(pageParam, { sort }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    refetchInterval: false,
    staleTime: 300_000,
  })
  const total = lib.data?.pages[0]?.total ?? 0
  const items = useMemo(() => dedupeByKey(lib.data?.pages.flatMap((p) => p.items) ?? []), [lib.data])
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" className={selectCls}>
          <option value="added">recently added</option>
          <option value="played">recently played</option>
          <option value="title">a to z</option>
          <option value="year">year</option>
        </select>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{total} albums</span>
      </div>
      {lib.isLoading ? <MusicLoading /> : lib.isError ? <MusicError error={lib.error} /> : items.length === 0 ? <MusicEmpty>no albums</MusicEmpty> : (
        <>
          <div className={tileGrid}>
            {items.map((al) => <AlbumTile key={al.ratingKey} album={al} onClick={() => nav.openAlbum(al.ratingKey, al)} />)}
          </div>
          {lib.hasNextPage && <MoreButton onClick={() => void lib.fetchNextPage()} busy={lib.isFetchingNextPage} loaded={items.length} total={total} />}
        </>
      )}
    </div>
  )
}

function ArtistView({ artistKey, seed, nav }: { artistKey: string; seed?: MusicArtist; nav: MusicNav }) {
  const artist = useQuery({
    queryKey: ['music-artist', artistKey],
    queryFn: () => fetchMusicArtist(artistKey),
    staleTime: 3600_000,
    placeholderData: seed,
  })
  const albums = useQuery({
    queryKey: ['music-artist-albums', artistKey],
    queryFn: () => fetchArtistAlbums(artistKey),
    staleTime: 300_000,
  })
  // Fetched up front so "play all" can start inside the tap itself: Safari only
  // lets audio start synchronously from a user gesture, and an await in between
  // loses that.
  const tracks = useQuery({
    queryKey: ['music-artist-tracks', artistKey],
    queryFn: () => fetchArtistTracks(artistKey),
    staleTime: 300_000,
  })
  const a = artist.data
  const playable = tracks.data?.filter((t) => t.streamKey) ?? []
  return (
    <div>
      <div className="flex items-start gap-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)] sm:h-36 sm:w-36">
          {a?.thumb
            ? <img src={musicImg(a.thumb, 300)} alt="" className="h-full w-full object-cover" />
            : <User size={32} className="text-[var(--color-text-faint)]" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>{a?.title ?? '…'}</h2>
          <div className="mt-1 text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-faint)]">
            {[
              a?.genres.join(' · '),
              albums.data && `${albums.data.length} album${albums.data.length === 1 ? '' : 's'}`,
              tracks.data && `${tracks.data.length} track${tracks.data.length === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' · ')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={playable.length === 0} onClick={() => playQueue(playable, 0)} className={actionBtn}>
              <Play size={14} /> play all
            </button>
            <button type="button" disabled={playable.length === 0} onClick={() => playShuffled(playable)} className={actionBtn}>
              <Shuffle size={14} /> shuffle
            </button>
          </div>
          {a?.summary && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--color-text-dim)]">{a.summary}</p>}
        </div>
      </div>
      <div className="mt-6">
        <MusicHead>albums</MusicHead>
        {albums.isLoading ? <MusicLoading /> : albums.isError ? <MusicError error={albums.error} /> : (albums.data?.length ?? 0) === 0 ? <MusicEmpty>no albums</MusicEmpty> : (
          <div className={tileGrid}>
            {albums.data!.map((al) => <AlbumTile key={al.ratingKey} album={al} onClick={() => nav.openAlbum(al.ratingKey, al)} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function AlbumView({ albumKey, seed, nav }: { albumKey: string; seed?: MusicAlbum; nav: MusicNav }) {
  const tracks = useQuery({
    queryKey: ['music-album-tracks', albumKey],
    queryFn: () => fetchAlbumTracks(albumKey),
    staleTime: 300_000,
  })
  const list = tracks.data ?? []
  const first = list[0]
  // The album's own facts come from whoever opened it, else from its tracks.
  const title = seed?.title ?? first?.album ?? '…'
  const artist = seed?.artist ?? first?.artist ?? ''
  const artistKey = seed?.artistKey ?? first?.artistKey ?? null
  const year = seed?.year ?? first?.year ?? null
  const thumb = seed?.thumb ?? first?.thumb ?? null
  const totalMs = list.reduce((n, t) => n + (t.duration ?? 0), 0)
  const multiDisc = new Set(list.map((t) => t.disc ?? 1)).size > 1
  const playable = list.filter((t) => t.streamKey)
  return (
    <div>
      <div className="flex items-start gap-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)] sm:h-36 sm:w-36">
          {thumb
            ? <img src={musicImg(thumb, 300)} alt="" className="h-full w-full object-cover" />
            : <Disc3 size={32} className="text-[var(--color-text-faint)]" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>{title}</h2>
          {artist && (
            artistKey
              ? <button type="button" onClick={() => nav.openArtist(artistKey, undefined)} className="mt-0.5 text-sm text-[var(--color-text-dim)] underline-offset-2 hover:text-[var(--color-text)] hover:underline">{artist}</button>
              : <div className="mt-0.5 text-sm text-[var(--color-text-dim)]">{artist}</div>
          )}
          <div className="mt-1 text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-faint)]">
            {[
              year,
              list.length > 0 && `${list.length} track${list.length === 1 ? '' : 's'}`,
              totalMs > 0 && runtime(totalMs),
            ].filter(Boolean).join(' · ')}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={playable.length === 0} onClick={() => playQueue(playable, 0)} className={actionBtn}>
              <Play size={14} /> play
            </button>
            <button type="button" disabled={playable.length === 0} onClick={() => playShuffled(playable)} className={actionBtn}>
              <Shuffle size={14} /> shuffle
            </button>
          </div>
        </div>
      </div>
      <div className="mt-5">
        {tracks.isLoading ? <MusicLoading /> : tracks.isError ? <MusicError error={tracks.error} /> : list.length === 0 ? <MusicEmpty>no tracks</MusicEmpty> : (
          <TrackList tracks={list} albumArtist={artist} multiDisc={multiDisc} />
        )}
      </div>
    </div>
  )
}

// Tap a row to play from there with the rest of the list as the queue; tap the
// playing row to pause and resume.
function TrackList({ tracks, albumArtist, multiDisc, withArt }: { tracks: MusicTrack[]; albumArtist?: string; multiDisc?: boolean; withArt?: boolean }) {
  const nowKey = useNowPlayingKey()
  const playing = useIsPlaying()
  return (
    <ol className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
      {tracks.map((t, i) => {
        const isCurrent = t.ratingKey === nowKey
        const sub = withArt
          ? [t.trackArtist ?? t.artist, t.album].filter(Boolean).join(' · ')
          : t.trackArtist && t.trackArtist !== albumArtist ? t.trackArtist : null
        const number = multiDisc && t.disc != null ? `${t.disc}-${t.index ?? ''}` : String(t.index ?? '')
        return (
          <li key={t.ratingKey}>
            <button
              type="button"
              disabled={!t.streamKey}
              onClick={() => (isCurrent ? toggle() : playQueue(tracks, i))}
              className={`flex min-h-12 w-full items-center gap-3 px-2 text-left transition-colors disabled:opacity-40 ${
                isCurrent ? 'bg-[rgba(var(--color-accent-rgb),0.08)]' : 'hover:bg-[var(--color-surface)]'
              }`}
            >
              {withArt ? (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                  {isCurrent
                    ? (playing ? <Pause size={14} className="text-[var(--color-accent)]" /> : <Play size={14} className="text-[var(--color-accent)]" />)
                    : t.thumb
                      ? <img src={musicImg(t.thumb, 80)} alt="" loading="lazy" className="h-full w-full object-cover" />
                      : <Disc3 size={14} className="text-[var(--color-text-faint)]" />}
                </span>
              ) : (
                <span className="inline-flex w-8 shrink-0 justify-end text-[11px] tabular-nums text-[var(--color-text-faint)]">
                  {isCurrent
                    ? (playing ? <Pause size={12} className="text-[var(--color-accent)]" /> : <Play size={12} className="text-[var(--color-accent)]" />)
                    : number}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${isCurrent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{t.title}</span>
                {sub && <span className="block truncate text-[10px] text-[var(--color-text-faint)]">{sub}</span>}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                {t.streamKey ? trackTime(t.duration) : 'no file'}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function MusicSearch({ q, nav }: { q: string; nav: MusicNav }) {
  const r = useQuery({
    queryKey: ['music-search', q],
    queryFn: () => searchMusic(q),
    refetchInterval: false,
    staleTime: 60_000,
  })
  if (r.isLoading) return <MusicLoading />
  if (r.isError) return <MusicError error={r.error} />
  const artists = r.data?.artists ?? []
  const albums = r.data?.albums ?? []
  const tracks = r.data?.tracks ?? []
  if (artists.length === 0 && albums.length === 0 && tracks.length === 0) return <MusicEmpty>no matches</MusicEmpty>
  return (
    <div className="space-y-6">
      {artists.length > 0 && (
        <section>
          <MusicHead>artists</MusicHead>
          <div className={tileGrid}>
            {artists.map((a) => <ArtistTile key={a.ratingKey} artist={a} onClick={() => nav.openArtist(a.ratingKey, a)} />)}
          </div>
        </section>
      )}
      {albums.length > 0 && (
        <section>
          <MusicHead>albums</MusicHead>
          <div className={tileGrid}>
            {albums.map((al) => <AlbumTile key={al.ratingKey} album={al} onClick={() => nav.openAlbum(al.ratingKey, al)} />)}
          </div>
        </section>
      )}
      {tracks.length > 0 && (
        <section>
          <MusicHead>tracks</MusicHead>
          <TrackList tracks={tracks} withArt />
        </section>
      )}
    </div>
  )
}
