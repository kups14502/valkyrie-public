import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cast, Clapperboard, Download, Loader2, MessageSquare, Search, Send, Star, X } from 'lucide-react'
import {
  addMediaRequest, fetchImgToken, fetchMediaDownloads, fetchMediaRequests, fetchPlexLibrary,
  fetchPlexRecent, fetchPlexSections, fetchPlexServer, onTailnet, openInApp, plexAppItemLink,
  plexImg, plexWatchLink, plexWebItemLink, searchMediaRequests, sendMediaMessage,
  shouldDeferAppClick, type PlexItem, type PlexSection,
} from '../lib/api'

// Plex library browser + media requests. Tabs: one per Plex section (movies /
// tv), recently added, and the request pipeline (search radarr/sonarr, one tap
// to queue; free text goes to the agent).

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
      label: sec.type === 'movie' ? 'movies' : sec.type === 'show' ? 'tv' : sec.title.toLowerCase(),
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
      {active?.kind === 'section' && active.section && <SectionGrid key={active.section.key} section={active.section} />}
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
            placeholder="movie or show name…"
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
              <li key={`${r.kind}-${r.tmdbId ?? r.tvdbId}`} className="flex items-center gap-3 py-3">
                <div className="h-16 w-11 shrink-0 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                  {r.poster ? <img src={r.poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Clapperboard size={16} className="m-auto mt-5 text-[var(--color-text-faint)]" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--color-text)]">
                    {r.title} {r.year && <span className="text-[var(--color-text-faint)]">({r.year})</span>}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{r.kind === 'movie' ? 'movie' : 'tv show'}</div>
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
                  {r.kind === 'message' ? `"${r.message}"` : `${r.title}${r.year ? ` (${r.year})` : ''}`}
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
