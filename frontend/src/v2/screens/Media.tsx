import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MUSIC_PAGE, addMediaRequest, fetchAlbumTracks, fetchArtistAlbums, fetchArtistTracks, fetchImgToken, fetchMusicAlbums, fetchMusicArtist,
  fetchMusicArtists, fetchMusicRecent, fetchPlexLibrary, fetchPlexSections, fetchPlexServer, onTailnet, openInApp, plexAppHomeLink,
  plexAppItemLink, plexWatchLink, plexWebHomeLink, plexWebItemLink, searchMediaRequests, searchMusic, sendMediaMessage,
  shouldDeferAppClick, spotifyAppLink, spotifyWebLink,
  type MediaSearchResult, type MusicAlbum, type MusicArtist, type MusicSearchResults, type MusicTrack, type PlexItem, type PlexSection,
} from '../../lib/api'
import { playerActions, usePlayer, usePlayerNow, useShell, type PlayerNow, type ScreenProps } from '../kit/shell'
import { Bar, Glyph, Press, cx, toast } from '../kit/ui'
import { Icon, type IconName, type IconTone } from '../kit/icons'
import { useReducedMotion } from '../kit/motion'
import {
  ago, musicArtUrl, plexArtUrl, useImgKey, useLive, useMediaQueue, usePlexRecentRich, useTick,
  type DownloadVM, type Live, type PlexRichVM, type RequestVM,
} from '../kit/data'
import './media.css'

// Media: Dashboard (Open Plex and Spotify at the top, the newest title as the hero, new shows and movies, music
// played and added lately, a glance at downloads), Movies and Shows (the whole
// Plex library as an A to Z poster grid with an index strip; a title opens a
// detail sheet with Open in Plex), Music (every artist A to Z in a windowed
// list with the same strip, an artist's albums, an album's tracks, played in
// the page by lib/player through the shell's player store), Requests (search
// Radarr / Sonarr / Lidarr and request, message the media agent, downloads,
// open requests, arrivals). The views stay mounted once opened, so switching
// sub-tabs keeps their data, state and scroll.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': Math.min(8, i) })


const NEW_MS = 7 * 86_400_000
const DAY = 86_400_000

// em and en dashes, written as char codes so the source carries none
const DASHES = new RegExp(String.raw`\s*[${String.fromCharCode(0x2014, 0x2013)}]\s*`, 'g')
const noDash = (s: string, sep = ' · ') => s.replace(DASHES, sep)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const runtime = (ms: number | null | undefined) => {
  if (!ms) return null
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** ago() tops out at days ("402d"): past 60 days say months, past two years say years. */
const longAgo = (ms: number, now: number) => {
  const d = (now - ms) / DAY
  if (d < 60) return ago(ms, now)
  const mo = Math.round(d / 30.44)
  return mo < 24 ? `${mo} mo` : `${Math.round(mo / 12)} y`
}
const monthYear = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

// Every image here is built at render time from a Plex path, through lib/api's plexImg and
// musicImg on the API base in use now (with the image token when that base needs one). Nothing
// keeps a URL: the desktop app moves the base after load, and the token expires.
/** <Art> src for a Plex path: undefined (the wait state) until image URLs can load. */
const plexSrc = (imgKey: number, path: string | null, w: number, h?: number) => (imgKey < 0 ? undefined : plexArtUrl(imgKey, path, w, h))
/** The same for album art and artist photos off the music server. */
const musicSrc = (imgKey: number, path: string | null, w: number) => (imgKey < 0 ? undefined : musicArtUrl(imgKey, path, w))
/** A title's backdrop, sharp enough for a 3x phone; the poster when Plex has no backdrop. */
const backdropSrc = (imgKey: number, it: { artPath: string | null; thumb: string | null }) =>
  it.artPath ? plexSrc(imgKey, it.artPath, 1280, 720) : plexSrc(imgKey, it.thumb, 300)

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * Render an input now (`open`) and focus it inside the tap, or iOS keeps the keyboard down. The
 * tap's own mousedown/click land after this on whatever now sits under the finger and would blur
 * it, so focus once more on that click.
 */
function openAndFocus(open: () => void, ref: RefObject<HTMLInputElement | null>) {
  flushSync(open)
  const focus = () => ref.current?.focus({ preventScroll: true })
  focus()
  const done = () => {
    window.removeEventListener('click', onClick, true)
    window.clearTimeout(t)
  }
  const onClick = () => {
    focus()
    done()
  }
  window.addEventListener('click', onClick, true)
  const t = window.setTimeout(done, 700)
}

const capFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
/** What a refused write says (the backend's detail or error, dash-free, capitalized), else `fallback`. */
function reason(e: unknown, fallback: string): string {
  const x = e as { detail?: unknown; response?: { data?: { error?: unknown } } } | null
  const said = typeof x?.detail === 'string' && x.detail ? x.detail : x?.response?.data?.error
  return typeof said === 'string' && said ? capFirst(noDash(said, ', ')) : fallback
}
const statusOf = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status

// ---------- pieces ----------

/** Fixed-size art box: the image fades in when it lands, nothing jumps. `src` undefined = not ready yet. */
function Art({ src, ratio, className, eager, children }: {
  src: string | null | undefined
  ratio: '2/3' | '1/1' | '16/9'
  className?: string
  eager?: boolean
  children?: ReactNode
}) {
  const [state, setState] = useState<'wait' | 'ok' | 'err'>('wait')
  const ref = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    setState('wait')
    const img = ref.current
    if (img?.complete && img.naturalWidth > 0) setState('ok')
  }, [src])
  return (
    <span className={cx('vm-art', className)} data-ratio={ratio} data-state={src ? state : src === undefined ? 'wait' : 'err'}>
      {src && (
        <img
          ref={ref}
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setState('ok')}
          onError={() => setState('err')}
        />
      )}
      {children}
      {/* the red frame sits over the image (an inset shadow would sit under it) */}
      <i className="vm-art-frame" aria-hidden />
    </span>
  )
}

/** Three bars that bounce while something plays (static when paused or reduced). */
function Eq({ on }: { on: boolean }) {
  return (
    <span className="vm-eq" data-on={on || undefined} aria-hidden>
      <i /><i /><i />
    </span>
  )
}

/**
 * A section header: icon, label, value, optional actions. The icon is dim with no glow unless the
 * section is live (something playing, downloading, searching), then it is lit.
 */
function Head({ icon, lit, label, value, children }: {
  icon?: IconName
  lit?: boolean
  label: ReactNode
  value?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="vm-head" data-lit={lit || undefined}>
      {icon && <Icon name={icon} size={15} tone={lit ? 'fg' : 'dim'} glow={lit} className="vm-head-icon" />}
      <span className="vm-head-label">{label}</span>
      <i className="vm-head-line" aria-hidden />
      {value !== undefined && value !== null && <span className="vm-head-value">{value}</span>}
      {children}
    </header>
  )
}

/** A list section: a thin red panel with a dark red fill, the header inside it. */
function Sec({ icon, lit, label, value, extra, className, i, children, ...rest }: {
  icon: IconName
  lit?: boolean
  label: ReactNode
  value?: ReactNode
  extra?: ReactNode
  className?: string
  i: number
  children: ReactNode
  'aria-label'?: string
}) {
  return (
    <section className={cx('vl-panel vm-sec vl-build', className)} style={iv(i)} {...rest}>
      <Head icon={icon} lit={lit} label={label} value={value}>{extra}</Head>
      {children}
    </section>
  )
}

/** A horizontal snap row with edge fades; the pager ignores drags that start inside it. */
function Row({ icon, lit, label, value, extra, i, children, keyFor }: {
  icon: IconName
  lit?: boolean
  label: ReactNode
  value?: ReactNode
  /** small text actions at the right end of the header */
  extra?: ReactNode
  i: number
  children: ReactNode
  /** scroll this tile into view when it changes (the selected / playing one) */
  keyFor?: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [over, setOver] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = () => {
      const max = el.scrollWidth - el.clientWidth
      setOver(max > 2)
      el.toggleAttribute('data-start', el.scrollLeft <= 2)
      el.toggleAttribute('data-end', el.scrollLeft >= max - 2)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || !keyFor) return
    const tile = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyFor)}"]`)
    if (!tile) return
    const l = tile.offsetLeft
    if (l < el.scrollLeft + 4 || l + tile.offsetWidth > el.scrollLeft + el.clientWidth - 4) {
      el.scrollTo({ left: Math.max(0, l - 12), behavior: reduced ? 'auto' : 'smooth' })
    }
  }, [keyFor, reduced])

  const step = (dir: number) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduced ? 'auto' : 'smooth' })
  }

  const name = typeof label === 'string' ? label : 'row'
  return (
    <section className="vm-row vl-build" style={iv(i)}>
      <Head icon={icon} lit={lit} label={label} value={value}>
        {extra}
        {over && (
          <span className="vm-arrows">
            <Press className="vm-arrow" aria-label={`Scroll ${name} left`} onPress={() => step(-1)}><Glyph name="left" size={12} /></Press>
            <Press className="vm-arrow" aria-label={`Scroll ${name} right`} onPress={() => step(1)}><Glyph name="right" size={12} /></Press>
          </span>
        )}
      </Head>
      <div ref={ref} className="vl-hscroll vm-scroll" data-no-swipe data-start>
        {children}
      </div>
    </section>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="vm-quiet vl-build" style={iv(1)}>{children}</p>
}

/** "Plex unreachable, showing 5m old": the last good data stays, this says how old it is. */
function Stale({ live, what, now }: { live: Live<unknown>; what: string; now: number }) {
  if (!live.failed || live.data === undefined) return null
  return (
    <p className="vm-stale" role="status">
      <Icon name="alert" size={13} tone="acc2" />
      {what} unreachable, showing {live.updatedAt && now - live.updatedAt >= 60_000 ? `${longAgo(live.updatedAt, now)} old data` : 'the last good data'}
    </p>
  )
}


/** A one-line hairline search input. 16 px text so iOS does not zoom on focus. */
function SearchLine({ value, onChange, placeholder, busy, onClose, autoFocus, label, inputRef }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  busy?: boolean
  onClose?: () => void
  autoFocus?: boolean
  label: string
  /** lets the opener focus the input inside its own tap, which is what makes iOS show the keyboard */
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const own = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? own
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  return (
    <div className="vm-search" data-no-swipe data-busy={busy || undefined}>
      <Icon name="search" size={16} tone={busy ? 'fg' : 'dim'} glow={busy} className="vm-search-icon" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') (onClose ? onClose() : onChange('')) }}
        placeholder={placeholder}
        aria-label={label}
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {busy && <i className="vm-search-busy" aria-hidden />}
      {(value || onClose) && (
        <Press className="vm-search-x" aria-label={onClose ? 'Close search' : 'Clear search'} onPress={() => (onClose ? onClose() : onChange(''))}>
          <Glyph name="close" size={10} />
        </Press>
      )}
    </div>
  )
}

/** Seconds since mount, for slow calls ("Searching · 6s"). */
function Waited() {
  const [t0] = useState(() => Date.now())
  const now = useTick(1000)
  return <span className="vm-waited">{Math.max(0, Math.round((now - t0) / 1000))}s</span>
}

// ---------- shared ----------

const num = (n: number) => n.toLocaleString('en-US')

/** The page scroller a view lives in (the shell gives every screen its own). */
const pageOf = (el: Element | null | undefined) => el?.closest<HTMLElement>('.vl-page') ?? null
/**
 * The UI zoom (lib/zoom puts a CSS `zoom` on <html>): client rects come back zoomed, scrollTop and
 * offset sizes do not, so a rect distance is divided by this before it meets a scroll position.
 */
const zoomOf = (el: HTMLElement) => {
  const h = el.offsetHeight
  return h > 0 ? el.getBoundingClientRect().height / h : 1
}
/** Where `el` starts in its page's scroll content, in layout px. */
const topIn = (el: Element, page: HTMLElement) =>
  (el.getBoundingClientRect().top - page.getBoundingClientRect().top) / zoomOf(page) + page.scrollTop

/** A small setting kept in localStorage (a sort, a list mode). */
function useStored<T extends string>(key: string, initial: T, ok: (v: unknown) => v is T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return ok(s) ? s : initial
    } catch {
      return initial
    }
  })
  const set = useCallback((n: T) => {
    setV(n)
    try { localStorage.setItem(key, n) } catch { /* private mode */ }
  }, [key])
  return [v, set]
}

/** An element's width in layout px (media queries see the window, which the UI zoom makes wider than the layout). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.offsetWidth)
    const ro = new ResizeObserver((es) => {
      const box = es[0]?.borderBoxSize?.[0]
      setW(Math.round(box ? box.inlineSize : el.offsetWidth))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** "/" focuses a view's search line (keyboard), unless something already takes the typing. */
function useSlash(ref: RefObject<HTMLInputElement | null>, on: boolean) {
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const el = ref.current
      if (!el) return
      e.preventDefault()
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref, on])
}

/** Escape runs `fn` while `on`, unless a field has the focus (its own Escape clears it). */
function useEscape(on: boolean, fn: () => void) {
  const cb = useRef(fn)
  cb.current = fn
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      cb.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])
}

// local search: accents, case and punctuation ignored, every word of the query must be in the
// name ("spider man" and "spiderman" both find Spider-Man; "lord rings" finds The Lord of the Rings)
const MARKS = new RegExp('[\\u0300-\\u036f]', 'g')
const fold = (s: string) => s.normalize('NFKD').replace(MARKS, '').toLowerCase()
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, '')
const queryWords = (q: string) => fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
/** `squashed` is squash(name); a four-digit word also matches the year. */
const hits = (words: readonly string[], squashed: string, year?: number | null) =>
  words.every((w) => squashed.includes(w) || (year != null && w.length === 4 && String(year) === w))

function useMq(query: string): boolean {
  const mq = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null), [query])
  const sub = useCallback((l: () => void) => {
    mq?.addEventListener('change', l)
    return () => mq?.removeEventListener('change', l)
  }, [mq])
  return useSyncExternalStore(sub, () => mq?.matches ?? false, () => false)
}

// ---------- Watch items ----------

type WatchItem = {
  key: string
  kind: 'movie' | 'show'
  title: string
  /** "1982", "Season 1", "Seasons 1-5" */
  label: string
  /** detail pieces after the label: "R", "2h 0m", "10 episodes" */
  facts: string[]
  /** ms epoch, 0 when unknown */
  added: number
  summary: string
  /** Plex image paths (poster, backdrop): the URLs are built at render time */
  thumb: string | null
  artPath: string | null
  /** audience rating out of 10, when the source has it */
  rating: number | null
  /** path on watch.plex.tv when Plex has a catalog match (opens the iOS app on the title) */
  watch: string | null
}

const fromRich = (r: PlexRichVM): WatchItem => {
  const movie = r.kind === 'movie'
  return {
    key: r.key,
    kind: movie ? 'movie' : 'show',
    title: r.title,
    label: movie ? (r.year ? String(r.year) : 'Movie') : r.subtitle,
    facts: [
      r.contentRating,
      movie ? runtime(r.duration) : r.episodes ? plural(r.episodes, 'episode') : null,
    ].filter((x): x is string => !!x),
    added: r.added,
    summary: r.summary,
    thumb: r.thumb,
    artPath: r.artPath,
    rating: null,
    // the shared view model has no watchPath yet; read it once it does
    watch: (r as { watchPath?: string | null }).watchPath ?? null,
  }
}

/** One library title as the index caches it: image paths, not URLs (a URL can carry an expiring token). */
type TitleRow = {
  key: string
  kind: 'movie' | 'show'
  title: string
  year: number | null
  thumb: string | null
  art: string | null
  summary: string
  rating: number | null
  /** content rating ("PG-13"), null when unrated */
  cr: string | null
  /** runtime in ms (movies) */
  dur: number | null
  /** seasons (shows) */
  kids: number | null
  /** ms epoch, 0 when unknown */
  added: number
  watch: string | null
}

const toTitle = (i: PlexItem): TitleRow => ({
  key: i.ratingKey,
  kind: i.type === 'movie' ? 'movie' : 'show',
  title: noDash(i.title),
  year: i.year,
  thumb: i.thumb,
  art: i.art,
  summary: noDash(i.summary ?? '', ', ').trim(),
  rating: i.rating,
  cr: i.contentRating && i.contentRating !== 'Not Rated' ? i.contentRating : null,
  dur: i.duration,
  kids: i.childCount,
  added: (i.addedAt ?? 0) * 1000,
  watch: i.watchPath,
})

const fromTitle = (r: TitleRow): WatchItem => ({
  key: r.key,
  kind: r.kind,
  title: r.title,
  label: r.year ? String(r.year) : r.kind === 'movie' ? 'Movie' : 'Show',
  facts: [r.cr, r.kind === 'movie' ? runtime(r.dur) : r.kids ? plural(r.kids, 'season') : null].filter((x): x is string => !!x),
  added: r.added,
  summary: r.summary,
  thumb: r.thumb,
  artPath: r.art,
  rating: r.rating,
  watch: r.watch,
})

const fromPlex = (i: PlexItem): WatchItem => fromTitle(toTitle(i))

/** Movies and TV sections on the main Plex server (counts for the row headers, keys for search). */
function useSections(): Live<PlexSection[]> {
  return useLive('plexSections', async () => (await fetchPlexSections()).filter((s) => s.server === 'main' && s.type !== 'artist'), 10 * 60_000)
}

// ---------- Dashboard ----------

const GLANCE_CAP = 3

function Dashboard({ setSub }: { setSub: (s: string) => void }) {
  const recent = usePlexRecentRich({ grouped: true })
  const sections = useSections()
  const music = useMusic()
  const queue = useMediaQueue()
  const p = usePlayerNow()
  const starter = useStarter()
  const imgKey = useImgKey()
  const now = useTick(60_000)
  const [sel, setSel] = useState<WatchItem | null>(null)
  const [searching, setSearching] = useState(false)
  const [text, setText] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const q = useDebounced(text.trim(), 350)

  const items = useMemo(() => (recent.data ?? []).map(fromRich), [recent.data])
  const secs = sections.data ?? []
  const total = (kind: 'movie' | 'show') => secs.filter((s) => s.type === kind).reduce((n, s) => n + s.count, 0)

  const searchOn = searching && q.length >= 2
  const found = useQuery({
    queryKey: ['v2-x', 'plexSearch', q.toLowerCase(), secs.map((s) => s.key).join(',')],
    queryFn: async () => {
      const pages = await Promise.all(secs.map((s) => fetchPlexLibrary(s.key, 0, { search: q })))
      return pages.flatMap((pg) => pg.items).map(fromPlex)
    },
    enabled: searchOn && secs.length > 0,
    staleTime: 60_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
    retry: 0,
  })

  const cur = sel ?? items[0] ?? null
  const shows = items.filter((x) => x.kind === 'show')
  const movies = items.filter((x) => x.kind === 'movie')
  const rows = [
    { id: 'shows', icon: 'watch' as const, label: 'New Shows', list: shows, total: total('show') },
    { id: 'movies', icon: 'movie' as const, label: 'New Movies', list: movies, total: total('movie') },
  ].filter((r) => r.list.length)
    .sort((a, b) => b.list[0].added - a.list[0].added)

  const tile = (m: WatchItem) => (
    <Press
      key={m.key}
      data-key={m.key}
      className="vm-tile vm-poster"
      data-on={m.key === cur?.key || undefined}
      aria-pressed={m.key === cur?.key}
      onPress={() => setSel(m)}
    >
      <Art src={plexSrc(imgKey, m.thumb, 300)} ratio="2/3" />
      <span className="vm-tile-t">{m.title}</span>
      <span className="vm-tile-s">
        {m.added > 0 && now - m.added < NEW_MS && <b className="vm-new" title="Added this week" />}
        {m.label}
      </span>
    </Press>
  )

  const searchAction = (
    <Press
      className="vm-hact"
      onPress={() => openAndFocus(() => setSearching(true), searchRef)}
    >
      <Icon name="search" size={14} tone="dim" />
      Search
    </Press>
  )
  const results = found.data ?? []

  // music: a tile plays (or pauses) what it shows
  const src = sourceOf(p)
  const playedList = music.data?.played ?? []
  const addedList = music.data?.added ?? []
  const tap = (m: MusicItem) => (src === m.key ? playerActions.toggle() : starter.start(m))
  const lastPlayed = playedList[0]?.at ?? 0
  const newestAdd = addedList.reduce((n, a) => Math.max(n, a.at), 0)

  const { downloads, moving } = countQueue(queue.data)

  return (
    <>
      <Stale live={recent} what="Plex" now={now} />
      <div className="vm-split vm-split-dash">
        {/* the classic phone home's Watch on TV and Music tiles: hand off to the real apps */}
        <header className="vm-dhead vl-build" style={iv(0)}>
          <AppLink icon="watch" label="Open Plex" app={plexAppHomeLink} web={plexWebHomeLink} />
          <AppLink icon="music" label="Spotify" app={spotifyAppLink} web={spotifyWebLink} />
        </header>
        <div className="vm-side">
          {cur ? (
            <WatchHero item={cur} newest={cur.key === items[0]?.key} now={now} />
          ) : (
            <Quiet>{recent.failed || recent.error ? 'Plex did not answer.' : recent.isFetching ? 'Loading Plex' : 'Nothing added to Plex lately.'}</Quiet>
          )}
        </div>
        <div className="vm-main">
          {searching && (
            <div className="vm-tools vl-build-on">
              <div className="vl-build">
                <SearchLine
                  label="Search Plex"
                  value={text}
                  onChange={setText}
                  placeholder="Search movies and shows"
                  busy={found.isFetching}
                  autoFocus
                  inputRef={searchRef}
                  onClose={() => { setSearching(false); setText('') }}
                />
              </div>
            </div>
          )}
          {searchOn ? (
            results.length ? (
              <Row icon="search" lit={found.isFetching} label="Results" value={found.isFetching ? 'Searching' : plural(results.length, 'title')} i={2} keyFor={cur?.key}>
                {results.map(tile)}
              </Row>
            ) : (
              <p className="vm-quiet-line">{found.isError ? 'Plex did not answer the search.' : found.isFetching || q !== text.trim() ? 'Searching Plex' : `Nothing in Plex matches "${q}".`}</p>
            )
          ) : (
            rows.map((r, k) => (
              <Row
                key={r.id}
                icon={r.icon}
                label={r.label}
                value={r.total ? `${r.list.length} · ${r.total} in library` : r.list.length}
                extra={k === 0 && !searching ? searchAction : undefined}
                i={2 + k}
                keyFor={cur && r.list.some((x) => x.key === cur.key) ? cur.key : null}
              >
                {r.list.map(tile)}
              </Row>
            ))
          )}
          {playedList.length > 0 && (
            <Row
              icon="music"
              lit={p.playing && !!src && playedList.some((m) => m.key === src)}
              label="Recently Played"
              value={lastPlayed ? `${playedList.length} artists · last ${longAgo(lastPlayed, now)} ago` : `${playedList.length} artists`}
              i={4}
              keyFor={src}
            >
              {playedList.map((m) => (
                <MusicTile key={m.key} m={m} sub={m.sub || 'Artist'} cur={src === m.key} playing={p.playing} wait={starter.pending === m.key} imgKey={imgKey} onPress={() => tap(m)} />
              ))}
            </Row>
          )}
          {addedList.length > 0 && (
            <Row
              icon="add"
              lit={p.playing && !!src && addedList.some((m) => m.key === src)}
              label="Recently Added"
              value={newestAdd ? `${addedList.length} albums · newest ${monthYear(newestAdd)}` : `${addedList.length} albums`}
              i={5}
              keyFor={src}
            >
              {addedList.map((m) => (
                <MusicTile key={m.key} m={m} sub={m.sub} cur={src === m.key} playing={p.playing} wait={starter.pending === m.key} imgKey={imgKey} onPress={() => tap(m)} />
              ))}
            </Row>
          )}
          {downloads.length > 0 && (
            <Sec
              className="vm-glance"
              i={6}
              icon="download"
              lit={moving > 0}
              label="Downloads"
              value={downloads.length}
              extra={(
                <Press className="vm-hact" onPress={() => setSub('requests')}>
                  Requests<Glyph name="right" size={10} />
                </Press>
              )}
            >
              <div className="vl-rows">
                {downloads.slice(0, GLANCE_CAP).map((d, k) => <DownloadRow key={d.title + k} d={d} i={7 + k} />)}
              </div>
              {downloads.length > GLANCE_CAP && (
                <Press className="vm-more" onPress={() => setSub('requests')}>{`${downloads.length - GLANCE_CAP} more in Requests`}</Press>
              )}
            </Sec>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Open an app at its home, as the classic phone home does: try the app's scheme, then its web
 * player if nothing took the page. The desktop app and a modified click keep the plain link.
 */
function AppLink({ icon, label, app, web }: { icon: IconName; label: string; app: () => string; web: () => string }) {
  return (
    <a
      className="vl-btn-line vm-app"
      href={web()}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (shouldDeferAppClick(e)) return
        e.preventDefault()
        openInApp(app(), web())
      }}
    >
      <Icon name={icon} size={15} tone="dim" />
      <span className="vm-app-label">{label}</span>
    </a>
  )
}

function WatchHero({ item, newest, now }: { item: WatchItem; newest: boolean; now: number }) {
  const fresh = item.added > 0 && now - item.added < NEW_MS
  const cap = `${newest ? 'Newest ' : ''}${item.kind === 'movie' ? 'Movie' : 'Show'}`
  const detail = [
    item.label,
    ...item.facts,
    item.rating != null ? `${item.rating.toFixed(1)}/10` : null,
    item.added ? `added ${longAgo(item.added, now)} ago` : null,
  ].filter(Boolean).join(' · ')
  const imgKey = useImgKey()
  return (
    <section className="vm-whero vl-build-on" key={item.key}>
      {/* the backdrop is the biggest image on screen: fetched sharp for a 3x phone */}
      <Art src={backdropSrc(imgKey, item)} ratio="16/9" className="vm-whero-art vl-build" eager />
      <div className="vm-whero-text">
        {/* the kind icon is lit while the title is new this week */}
        <span className="vm-cap vl-build" style={iv(1)} title={fresh ? 'Added this week' : undefined}>
          <Icon name={item.kind === 'movie' ? 'movie' : 'watch'} size={13} tone={fresh ? 'hot' : 'dim'} glow={fresh} />
          {cap}
        </span>
        <h2 className="vm-whero-title vl-build" style={iv(2)}>{item.title}</h2>
        <div className="vm-whero-meta vl-build" style={iv(3)}>
          <span className="vl-ellipsis">{detail}</span>
        </div>
        {/* always rendered at a fixed height, so the rows under it never move when the pick changes */}
        <p className="vm-whero-sum vl-build" style={iv(4)}>{item.summary}</p>
        <OpenInPlex item={item} />
      </div>
    </section>
  )
}

/**
 * Hand the title to a real Plex client (it can AirPlay; a page cannot), the way the classic Home
 * strip does: a catalog match is a bare link to watch.plex.tv, which iOS gives to the Plex app;
 * anything else tries the plex:// app link, then Plex Web if nothing took the page.
 */
function OpenInPlex({ item }: { item: WatchItem }) {
  const server = useQuery({ queryKey: ['plex-server'], queryFn: fetchPlexServer, staleTime: Infinity, refetchInterval: false, retry: 1 })
  const inner = (
    <>
      <Icon name="play" size={17} tone="ink" />
      Open in Plex
    </>
  )
  // no JS on this one: a scripted navigation skips iOS universal-link matching
  if (item.watch) {
    return <a className="vl-btn vm-open vl-build" style={iv(5)} href={plexWatchLink(item.watch)}>{inner}</a>
  }
  const id = server.data?.machineIdentifier
  if (!id) {
    return (
      <Press
        className="vl-btn vm-open vl-build"
        style={iv(5)}
        data-wait={server.isFetching || undefined}
        onPress={() => {
          if (server.isFetching) return
          toast('Plex did not answer. Trying again.')
          void server.refetch()
        }}
      >
        {inner}
      </Press>
    )
  }
  const web = plexWebItemLink(id, item.key)
  return (
    <a
      className="vl-btn vm-open vl-build"
      style={iv(5)}
      href={web}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (shouldDeferAppClick(e)) return
        e.preventDefault()
        openInApp(plexAppItemLink(id, item.key), web)
      }}
    >
      {inner}
    </a>
  )
}

// ---------- detail sheet ----------

/** A bottom sheet over everything (portaled, so the pager's transforms never move it); drag the grip down to close. */
function Sheet({ open, onClose, label, children }: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (open) {
      setMounted(true)
      let r2 = 0
      const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 360)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const drag = useRef<{ id: number; y0: number; dy: number; t: number; vy: number } | null>(null)
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, vy: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
    panel.current?.setAttribute('data-drag', '')
  }
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dy = Math.max(0, e.clientY - d.y0)
    d.vy = (dy - d.dy) / Math.max(1, e.timeStamp - d.t)
    d.dy = dy
    d.t = e.timeStamp
    panel.current?.style.setProperty('--drag', `${dy}px`)
  }
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    panel.current?.removeAttribute('data-drag')
    panel.current?.style.removeProperty('--drag')
    if (d.dy > 90 || (d.dy > 20 && d.vy > 0.5)) close.current()
  }

  if (!mounted) return null
  return createPortal(
    <div className="vm vm-sheet-root" data-shown={shown || undefined}>
      <div className="vm-sheet-back" onClick={() => close.current()} />
      <div className="vm-sheet" ref={panel} role="dialog" aria-modal="true" aria-label={label}>
        <div className="vm-sheet-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
          <i />
        </div>
        <Press className="vm-sheet-x" aria-label="Close" onPress={() => close.current()}><Glyph name="close" size={11} /></Press>
        <div className="vm-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/** A movie or show: poster, title, the facts, the whole summary, Open in Plex. */
function TitleSheet({ item, onClose }: { item: WatchItem | null; onClose: () => void }) {
  // the last title stays drawn while the sheet slides away
  const last = useRef<WatchItem | null>(item)
  if (item) last.current = item
  const it = item ?? last.current
  const now = useTick(60_000)
  return (
    <Sheet open={!!item} onClose={onClose} label={it?.title ?? 'Title'}>
      {it && <TitleDetail key={it.key} item={it} now={now} />}
    </Sheet>
  )
}

function TitleDetail({ item, now }: { item: WatchItem; now: number }) {
  const fresh = item.added > 0 && now - item.added < NEW_MS
  const facts = [item.label, ...item.facts, item.rating != null ? `${item.rating.toFixed(1)}/10` : null].filter(Boolean).join(' · ')
  const imgKey = useImgKey()
  return (
    <div className="vm-detail vl-build-on">
      {item.artPath && <Art src={plexSrc(imgKey, item.artPath, 1280, 720)} ratio="16/9" className="vm-detail-back" eager />}
      <div className="vm-detail-top">
        <Art src={plexSrc(imgKey, item.thumb, 300)} ratio="2/3" className="vm-detail-poster vl-build" eager />
        <div className="vm-detail-text">
          <span className="vm-cap vl-build" style={iv(1)} title={fresh ? 'Added this week' : undefined}>
            <Icon name={item.kind === 'movie' ? 'movie' : 'watch'} size={13} tone={fresh ? 'hot' : 'dim'} glow={fresh} />
            {item.kind === 'movie' ? 'Movie' : 'Show'}
          </span>
          <h2 className="vm-detail-title vl-build" style={iv(2)}>{item.title}</h2>
          <span className="vm-detail-meta vl-build" style={iv(3)}>{facts}</span>
          {item.added > 0 && <span className="vm-detail-added vl-build" style={iv(3)}>Added {longAgo(item.added, now)} ago</span>}
          <OpenInPlex item={item} />
        </div>
      </div>
      {item.summary && <p className="vm-detail-sum vl-build" style={iv(4)}>{item.summary}</p>}
    </div>
  )
}

// ---------- library index: every page, a few at a time, cached ----------

type Part<T> = { rows: T[]; total: number } | null
type PartStore<T> = { get: () => Part<T>; set: (v: Part<T>) => void; sub: (l: () => void) => () => void }

/** What a running load has so far, so a list can draw while the rest arrives. */
function partStore<T>(): PartStore<T> {
  let v: Part<T> = null
  const ls = new Set<() => void>()
  return {
    get: () => v,
    set: (n) => { v = n; ls.forEach((l) => l()) },
    sub: (l) => { ls.add(l); return () => { ls.delete(l) } },
  }
}

const PAGES_IN_FLIGHT = 3
const PLEX_PAGE = 60

/**
 * Every page of a list, `size` per call, a few calls in flight. `onPart` gets the run loaded so far
 * from the start, in order, so rows only ever arrive at the end and the list never jumps.
 */
async function pageAll<P, T>(
  fetchPage: (offset: number) => Promise<{ total: number; items: P[] }>,
  size: number,
  map: (p: P) => T,
  onPart: (rows: T[], total: number) => void,
  head?: { total: number; items: P[] },
): Promise<{ rows: T[]; total: number }> {
  const first = head ?? await fetchPage(0)
  const total = first.total
  const count = Math.max(1, Math.ceil(total / size))
  const pages: (T[] | undefined)[] = [first.items.map(map)]
  let shown = 0
  const publish = () => {
    let n = shown
    while (n < count && pages[n]) n++
    if (n === shown) return
    shown = n
    onPart(pages.slice(0, n).flat() as T[], total)
  }
  publish()
  let next = 1
  const worker = async () => {
    while (next < count) {
      const i = next++
      const pg = await fetchPage(i * size)
      pages[i] = pg.items.map(map)
      publish()
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGES_IN_FLIGHT, count - 1) }, () => worker()))
  return { rows: pages.flat() as T[], total }
}

const FRESH_MS = 10 * 60_000

/** A loader that answers from memory for a while after a full load, so focus refetches cost nothing. */
function memoLoad<A extends unknown[], T>(load: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let last: { at: number; data: T } | null = null
  let running: Promise<T> | null = null
  return (...args) => {
    if (last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.data)
    if (!running) {
      running = load(...args)
        .then((data) => { last = { at: Date.now(), data }; return data })
        .finally(() => { running = null })
    }
    return running
  }
}

/** A cached index. `at`: when it was last loaded in full (the artist index skips a reload while it is fresh). */
type IndexData<T> = { v: 1; at?: number; total: number; rows: T[] }
const reviveIndex = <T,>(d: unknown): IndexData<T> | undefined => {
  const x = d as Partial<IndexData<T>> | null
  return x && x.v === 1 && Array.isArray(x.rows) && typeof x.total === 'number' ? (x as IndexData<T>) : undefined
}

// A to Z: '#' holds digits and anything that is not a letter
const AZ = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const AZ_RANK = new Map(AZ.map((l, i) => [l, i]))
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const ARTICLE = /^(the|a|an)\s+/i
/** How a title files: accents and a leading article off, as Plex sorts ("The Beatles" under B). */
const sortKey = (t: string) => {
  const k = t.normalize('NFKD').replace(MARKS, '').trim().replace(ARTICLE, '').replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
  return k || t.toLowerCase()
}
const letterOf = (k: string) => {
  const c = k.charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}

type Lettered<T> = T & { letter: string }
type Indexed<T> = { list: Lettered<T>[]; first: Map<string, number> }

/** Sorted A to Z with each row's letter, and where each letter starts. */
function indexRows<T extends { title: string }>(rows: readonly T[]): Indexed<T> {
  const dec = rows.map((r) => {
    const sk = sortKey(r.title)
    return { r, sk, letter: letterOf(sk) }
  })
  dec.sort((a, b) => (AZ_RANK.get(a.letter) ?? 0) - (AZ_RANK.get(b.letter) ?? 0) || collator.compare(a.sk, b.sk))
  const first = new Map<string, number>()
  const list = dec.map((d, i) => {
    if (!first.has(d.letter)) first.set(d.letter, i)
    return { ...d.r, letter: d.letter }
  })
  return { list, first }
}

const titleParts = { movie: partStore<TitleRow>(), show: partStore<TitleRow>() }

async function loadTitles(kind: 'movie' | 'show'): Promise<IndexData<TitleRow>> {
  const part = titleParts[kind]
  const secs = (await fetchPlexSections()).filter((s) => s.server === 'main' && s.type === kind)
  const total = secs.reduce((n, s) => n + s.count, 0)
  let rows: TitleRow[] = []
  for (const s of secs) {
    const before = rows
    const out = await pageAll((o) => fetchPlexLibrary(s.key, o, { sort: 'title' }), PLEX_PAGE, toTitle, (got) => part.set({ rows: before.concat(got), total }))
    rows = before.concat(out.rows)
  }
  // the same title in two sections (an HD and a 4K copy) shows once
  const seen = new Set<string>()
  rows = rows.filter((r) => {
    const k = `${r.title.toLowerCase()}|${r.year ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { v: 1, total: rows.length, rows }
}

const titleLoaders = { movie: memoLoad(() => loadTitles('movie')), show: memoLoad(() => loadTitles('show')) }

/** The whole movie or show library, A to Z: the cached index paints at once, a running load shows as it fills. */
function useTitleIndex(kind: 'movie' | 'show') {
  const live = useLive(`mediaIndex.${kind}`, titleLoaders[kind], 30 * 60_000, { revive: reviveIndex<TitleRow> })
  const store = titleParts[kind]
  const part = useSyncExternalStore(store.sub, store.get, store.get)
  const rows = live.data?.rows ?? part?.rows
  const idx = useMemo(() => indexRows(rows ?? []), [rows])
  return { ...idx, live, total: live.data?.total ?? part?.total ?? 0, filling: !live.data, started: rows !== undefined }
}

// ---------- the A to Z strip ----------

const SLOT_MIN = 13

/**
 * The index down the right side. Tap a letter to jump to its first title; drag along it to scrub
 * (the big letter beside the finger says where you are). Letters with no titles are dim and do
 * nothing when tapped; a scrub that crosses one lands on the nearest letter that has titles.
 */
function AZStrip({ has, current, onJump, label }: {
  has: ReadonlySet<string>
  current: string | null
  onJump: (letter: string) => void
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrub, setScrub] = useState<{ l: string; y: number } | null>(null)
  const [step, setStep] = useState(1)
  const drag = useRef<{ id: number; y0: number; moved: boolean; last: string | null } | null>(null)
  const jump = useRef(onJump)
  jump.current = onJump

  // a short strip (landscape) shows every second or third letter, with dots between
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const per = el.clientHeight / AZ.length
      setStep(per >= SLOT_MIN ? 1 : per * 2 >= SLOT_MIN ? 2 : 3)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const at = (clientY: number) => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    const y = Math.min(r.height, Math.max(0, clientY - r.top))
    // y is in client px; the bubble is placed in layout px (they differ under the UI zoom)
    return { i: Math.min(AZ.length - 1, Math.floor((y / Math.max(1, r.height)) * AZ.length)), y: y / zoomOf(el) }
  }
  const nearest = (i: number) => {
    for (let d = 0; d < AZ.length; d++) {
      const a = AZ[i + d]
      if (a && has.has(a)) return a
      const b = AZ[i - d]
      if (b && has.has(b)) return b
    }
    return null
  }
  const go = (l: string, y: number) => {
    const d = drag.current
    if (d && d.last !== l) {
      d.last = l
      jump.current(l)
    }
    setScrub((s) => (s && s.l === l && Math.abs(s.y - y) < 1 ? s : { l, y }))
  }

  return (
    <div
      ref={ref}
      className="vm-az"
      data-no-swipe
      data-scrub={scrub ? '' : undefined}
      role="group"
      aria-label={label}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* the pointer is already gone */ }
        const { i, y } = at(e.clientY)
        drag.current = { id: e.pointerId, y0: e.clientY, moved: false, last: null }
        if (has.has(AZ[i])) go(AZ[i], y)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        if (!d.moved && Math.abs(e.clientY - d.y0) < 5) return
        d.moved = true
        const { i, y } = at(e.clientY)
        const l = nearest(i)
        if (l) go(l, y)
      }}
      onPointerUp={(e) => {
        if (drag.current?.id !== e.pointerId) return
        drag.current = null
        setScrub(null)
      }}
      onPointerCancel={() => {
        drag.current = null
        setScrub(null)
      }}
    >
      {AZ.map((l, i) => {
        const on = has.has(l)
        const text = step === 1 || i % step === 0 || l === current
        return (
          <button
            key={l}
            type="button"
            className="vm-az-l"
            data-off={!on || undefined}
            data-cur={l === current || undefined}
            aria-disabled={!on || undefined}
            tabIndex={on ? 0 : -1}
            aria-label={l === '#' ? 'Jump to numbers and symbols' : `Jump to ${l}`}
            onClick={(e) => { if (e.detail === 0 && on) jump.current(l) }}
          >
            {text ? l : <i className="vm-az-dot" aria-hidden />}
          </button>
        )
      })}
      {scrub && <span className="vm-az-bubble" style={{ top: scrub.y }} aria-hidden>{scrub.l}</span>}
    </div>
  )
}

/** Which letter's titles are at the top of the page right now, from the elements carrying data-letter. */
function useTopLetter(root: RefObject<HTMLElement | null>, on: boolean, deps: unknown, fallback: string | null): string | null {
  const [cur, setCur] = useState<string | null>(null)
  useEffect(() => {
    const el = root.current
    const page = pageOf(el)
    if (!on || !el || !page) return
    let raf = 0
    const calc = () => {
      raf = 0
      const edge = page.getBoundingClientRect().top + 12
      let l: string | null = null
      for (const g of el.querySelectorAll<HTMLElement>('[data-letter]')) {
        if (g.getBoundingClientRect().top <= edge) l = g.dataset.letter ?? null
        else break
      }
      setCur(l)
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(calc) }
    calc()
    page.addEventListener('scroll', kick, { passive: true })
    const ro = new ResizeObserver(kick)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      page.removeEventListener('scroll', kick)
      ro.disconnect()
    }
  }, [root, on, deps])
  return cur ?? fallback
}

/**
 * The letter last jumped to, held until the next real scroll: at the end of a short list the page
 * cannot bring that letter to the top, and the strip should still light the one tapped.
 */
function usePin(root: RefObject<HTMLElement | null>): [string | null, (l: string) => void] {
  const [pin, setPin] = useState<string | null>(null)
  const at = useRef(0)
  useEffect(() => {
    const page = pageOf(root.current)
    if (!pin || !page) return
    const onScroll = () => { if (Math.abs(page.scrollTop - at.current) > 4) setPin(null) }
    page.addEventListener('scroll', onScroll, { passive: true })
    return () => page.removeEventListener('scroll', onScroll)
  }, [pin, root])
  const set = useCallback((l: string) => {
    at.current = pageOf(root.current)?.scrollTop ?? 0
    setPin(l)
  }, [root])
  return [pin, set]
}

/** "Loading 120 of 540" while a first load fills, the count once it is whole. */
function countLabel(n: number, total: number, filling: boolean, one: string) {
  return filling && total > n ? `Loading ${num(n)} of ${num(total)}` : `${num(n)} ${n === 1 ? one : `${one}s`}`
}

// ---------- Movies and Shows ----------

type SortBy = 'title' | 'year' | 'added' | 'rating'
const SORTS: readonly { id: SortBy; label: string; aria: string }[] = [
  { id: 'title', label: 'Title', aria: 'Sort by title, A to Z' },
  { id: 'year', label: 'Year', aria: 'Sort by year, newest first' },
  { id: 'added', label: 'Added', aria: 'Sort by recently added' },
  { id: 'rating', label: 'Rating', aria: 'Sort by rating, highest first' },
]
const isSort = (s: unknown): s is SortBy => SORTS.some((x) => x.id === s)
// ties keep the A to Z order (the list arrives sorted by title and Array sort is stable)
const SORT_FN: Record<Exclude<SortBy, 'title'>, (a: TitleRow, b: TitleRow) => number> = {
  year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  added: (a, b) => b.added - a.added,
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
}

/** The tile's second line says what the list is sorted by. */
const tileSub = (r: TitleRow, label: string, sort: SortBy, now: number) =>
  sort === 'added' && r.added ? `${longAgo(r.added, now)} ago`
    : sort === 'rating' && r.rating != null ? `${r.rating.toFixed(1)} · ${label}`
      : label

/** Small underlined text toggles: how a list is sorted. */
function SortToggles({ value, onChange }: { value: SortBy; onChange: (s: SortBy) => void }) {
  return (
    <div className="vm-sorts" role="group" aria-label="Sort">
      <span className="vm-sorts-cap" aria-hidden>Sort</span>
      <span className="vm-toggles">
        {SORTS.map((s) => (
          <Press
            key={s.id}
            className="vm-toggle"
            data-on={value === s.id || undefined}
            aria-pressed={value === s.id}
            aria-label={s.aria}
            onPress={() => onChange(s.id)}
          >
            {s.label}
          </Press>
        ))}
      </span>
    </div>
  )
}

/** Library width (layout px) from which a picked title opens beside the grid instead of in a sheet. */
const BESIDE_MIN = 900

function Library({ kind, visible }: { kind: 'movie' | 'show'; visible: boolean }) {
  const idx = useTitleIndex(kind)
  const imgKey = useImgKey()
  const qc = useQueryClient()
  const now = useTick(60_000)
  const [sel, setSel] = useState<WatchItem | null>(null)
  const [sort, setSort] = useStored<SortBy>(`v2.media.sort.${kind}`, 'title', isSort)
  const [text, setText] = useState('')
  const q = useDeferredValue(text.trim())
  const rootRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const beside = useWidth(rootRef) >= BESIDE_MIN
  useSlash(searchRef, visible)

  useEffect(() => {
    if (!visible) setSel(null)
  }, [visible])

  // the search narrows the whole list; title order keeps the A to Z strip, the other orders drop it
  const view = useMemo(() => {
    const words = queryWords(q)
    const base = words.length ? idx.list.filter((r) => hits(words, squash(r.title), r.year)) : idx.list
    const list = sort === 'title' ? base : [...base].sort(SORT_FN[sort])
    const first = new Map<string, number>()
    if (sort === 'title') list.forEach((r, i) => { if (!first.has(r.letter)) first.set(r.letter, i) })
    return { list, first, searching: words.length > 0 }
  }, [idx.list, q, sort])

  // one continuous grid; the first title of each letter (by year: of each decade) carries it as a tag
  const tiles = useMemo(() => {
    let decade = ''
    return view.list.map((r, i) => {
      const letter = view.first.get(r.letter) === i ? r.letter : null
      let tag = letter
      if (sort === 'year' && r.year) {
        const d = `${Math.floor(r.year / 10) * 10}s`
        tag = d !== decade ? d : null
        decade = d
      }
      return { row: r, item: fromTitle(r), letter, tag }
    })
  }, [view, sort])
  const has = useMemo(() => new Set(view.first.keys()), [view.first])
  const strip = sort === 'title'
  const top = useTopLetter(mainRef, visible && strip, tiles, view.list[0]?.letter ?? null)
  const [pin, pinTo] = usePin(mainRef)

  const jump = (l: string) => {
    const page = pageOf(mainRef.current)
    const g = mainRef.current?.querySelector<HTMLElement>(`[data-letter="${l}"]`)
    if (!page || !g) return
    page.scrollTop = topIn(g, page) - 6
    pinTo(l)
  }

  // wide: the pick opens a pane beside the grid, which takes columns away; the tile that was
  // clicked keeps its height on screen through that reflow (and through the close)
  const tileOf = (key: string) => mainRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) ?? null
  const anchor = useRef<{ key: string; y: number } | null>(null)
  const pick = (m: WatchItem | null) => {
    const key = m?.key ?? sel?.key
    const page = pageOf(mainRef.current)
    const el = key ? tileOf(key) : null
    anchor.current = beside && key && page && el ? { key, y: el.getBoundingClientRect().top - page.getBoundingClientRect().top } : null
    setSel(m)
  }
  useLayoutEffect(() => {
    const a = anchor.current
    anchor.current = null
    const page = pageOf(mainRef.current)
    const el = a ? tileOf(a.key) : null
    if (!a || !page || !el) return
    page.scrollTop += (el.getBoundingClientRect().top - page.getBoundingClientRect().top - a.y) / zoomOf(page)
  }, [sel])
  const paneOpen = beside && !!sel
  useEscape(paneOpen, () => pick(null))

  const word = kind === 'movie' ? 'Movies' : 'Shows'
  const n = idx.list.length
  const shown = view.list.length
  const failed = idx.live.failed || !!idx.live.error
  return (
    <div ref={rootRef} className={cx('vm-lwrap', paneOpen && 'vm-lsplit')}>
      <div className="vm-lib" data-noaz={!strip || undefined}>
        <div className="vm-lib-main" ref={mainRef}>
          <Head
            icon={kind === 'movie' ? 'movie' : 'watch'}
            lit={idx.filling && idx.started}
            label={word}
            value={!idx.started ? undefined : view.searching ? `${num(shown)} of ${num(n)}` : countLabel(n, idx.total, idx.filling, 'title')}
          >
            {failed && (
              <Press className="vm-hact" onPress={() => void qc.refetchQueries({ queryKey: ['v2', `mediaIndex.${kind}`] })}>
                <Icon name="refresh" size={13} tone="dim" />
                Retry
              </Press>
            )}
          </Head>
          {n > 0 && (
            <div className="vm-ltools">
              <SearchLine label={`Search ${word.toLowerCase()}`} value={text} onChange={setText} placeholder={`Search ${word.toLowerCase()}`} inputRef={searchRef} />
              <SortToggles value={sort} onChange={setSort} />
            </div>
          )}
          {failed && <p className="vm-quiet-line vm-err">{n ? `Plex did not answer. Showing ${num(n)} ${word.toLowerCase()}.` : 'Plex did not answer.'}</p>}
          {!n && !failed && <p className="vm-quiet-line">{idx.started ? `No ${word.toLowerCase()} in Plex.` : `Loading ${word.toLowerCase()}`}</p>}
          {n > 0 && !shown && <p className="vm-quiet-line">Nothing in {word} matches "{q}".</p>}
          {shown > 0 && (
            <div className="vm-grid">
              {tiles.map(({ row, item: m, letter, tag }) => (
                <Press
                  key={m.key}
                  data-key={m.key}
                  className="vm-tile vm-gtile"
                  data-letter={letter ?? undefined}
                  data-on={sel?.key === m.key || undefined}
                  aria-pressed={paneOpen ? sel?.key === m.key : undefined}
                  aria-label={`${m.title}, ${m.label}`}
                  onPress={() => pick(paneOpen && sel?.key === m.key ? null : m)}
                >
                  <Art src={plexSrc(imgKey, m.thumb, 300)} ratio="2/3">
                    {tag && <b className="vm-ltag" aria-hidden>{tag}</b>}
                  </Art>
                  <span className="vm-tile-t">{m.title}</span>
                  <span className="vm-tile-s">{tileSub(row, m.label, sort, now)}</span>
                </Press>
              ))}
            </div>
          )}
        </div>
        {strip && (
          <div className="vm-az-col">
            <AZStrip has={has} current={pin ?? top} onJump={jump} label={`${word} A to Z`} />
          </div>
        )}
      </div>
      {paneOpen && sel && (
        <aside className="vm-ldetail" aria-label={sel.title}>
          <Press className="vm-ldetail-x" aria-label="Close" onPress={() => pick(null)}><Glyph name="close" size={11} /></Press>
          <TitleDetail key={sel.key} item={sel} now={now} />
        </aside>
      )}
      {!beside && <TitleSheet item={sel} onClose={() => setSel(null)} />}
    </div>
  )
}

// ---------- Music ----------

type MusicItem = {
  key: string
  kind: 'artist' | 'album'
  title: string
  /** artist: first genre ('' when none); album: the artist */
  sub: string
  /** the Plex path of the art; the URL is built at render time */
  thumb: string | null
  /** ms epoch last played (artists) or added (albums), 0 when unknown */
  at: number
  artistKey: string | null
  year: number | null
}

type MusicVM = { played: MusicItem[]; added: MusicItem[] }

const ts = (s: number | null | undefined) => (s ? s * 1000 : 0)

/** Older builds cached an image URL beside each path: keep the fields, drop the URL. */
const reviveMusic = (c: unknown): MusicVM | undefined => {
  const v = c as Partial<MusicVM> | null
  if (!v || !Array.isArray(v.played) || !Array.isArray(v.added)) return undefined
  const row = (m: MusicItem): MusicItem => ({
    key: m.key, kind: m.kind, title: m.title, sub: m.sub, thumb: m.thumb ?? null, at: m.at, artistKey: m.artistKey, year: m.year,
  })
  return { played: v.played.map(row), added: v.added.map(row) }
}

/** Music with the dates the shared view model drops (lastPlayedAt, addedAt), so ages can show. */
function useMusic(): Live<MusicVM> {
  return useLive('mediaMusic', async (): Promise<MusicVM> => {
    const r = await fetchMusicRecent()
    return {
      played: r.played.map((a) => ({
        key: a.ratingKey, kind: 'artist', title: a.title, sub: a.genres[0] ?? '', thumb: a.thumb,
        at: ts(a.lastPlayedAt), artistKey: a.ratingKey, year: null,
      })),
      added: r.added.map((a) => ({
        key: a.ratingKey, kind: 'album', title: a.title, sub: a.artist, thumb: a.thumb,
        at: ts(a.addedAt), artistKey: a.artistKey, year: a.year,
      })),
    }
  }, 120_000, { revive: reviveMusic })
}

// What the current queue was started from (an artist or album key), so the hero and the tiles
// can say it is playing. lib/player keeps the array it was handed, so a different array there
// means a queue started elsewhere (the classic Plex page) and this no longer applies.
let started: { tracks: MusicTrack[]; source: string; mix: boolean } | null = null
const tKey = (t: MusicTrack) => `t${t.ratingKey}`
const sourceOf = (p: PlayerNow) => (started && p.item && p.tracks === started.tracks ? started.source : null)

// Off the tailnet an <audio> src needs the short-lived media token (lib/api adds it once fetched).
let tokenUntil = 0
let playSeq = 0
function withStreamToken(run: () => void) {
  const seq = ++playSeq
  if (onTailnet || tokenUntil > Date.now() + 5 * 60_000) {
    run()
    return
  }
  fetchImgToken()
    .then((t) => { tokenUntil = t.expiresAt })
    // a trusted address streams without one, and the player reports a real failure itself
    .catch(() => {})
    .finally(() => { if (seq === playSeq) run() })
}

/** Play `list` from `start` (or shuffled) through lib/player; tracks with no file are left out. */
function playList(list: MusicTrack[], start: number, source: string, title: string, mix = false) {
  const ok = list.filter((t) => t.streamKey)
  if (!ok.length) {
    toast(`No playable files for ${title}`)
    return
  }
  const q = mix ? shuffled(ok) : ok
  const i = mix ? 0 : Math.max(0, q.indexOf(list[start]))
  withStreamToken(() => {
    started = { tracks: q, source, mix }
    playerActions.playQueue(q, i)
  })
}

function shuffled<T>(list: T[]): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const tracksQuery = (m: MusicItem) => ({
  queryKey: ['v2-x', 'tracks', m.kind, m.key],
  queryFn: () => (m.kind === 'artist' ? fetchArtistTracks(m.key) : fetchAlbumTracks(m.key)),
  staleTime: 5 * 60_000,
  // the app's QueryClient polls every query by default; these lists only change with the library
  refetchInterval: false as const,
})

/** Starts an artist or album from the top (its tracks cached 5 min, else fetched first); `pending` is the one loading. */
function useStarter() {
  const qc = useQueryClient()
  const seq = useRef(0)
  const [pending, setPending] = useState<string | null>(null)
  const start = useCallback((m: MusicItem, mix = false) => {
    const token = ++seq.current
    // cached tracks start inside the tap: iOS lets a page start audio only from one (the first time)
    const cached = qc.getQueryData<MusicTrack[]>(tracksQuery(m).queryKey)
    if (cached) {
      setPending(null)
      playList(cached, 0, m.key, m.title, mix)
      return
    }
    setPending(m.key)
    qc.fetchQuery(tracksQuery(m))
      .then((list) => { if (token === seq.current) playList(list, 0, m.key, m.title, mix) })
      .catch(() => { if (token === seq.current) toast('The music server did not answer') })
      .finally(() => { if (token === seq.current) setPending(null) })
  }, [qc])
  return { start, pending }
}
type Starter = ReturnType<typeof useStarter>

function MusicTile({ m, sub, cur, playing, wait, imgKey, onPress }: {
  m: MusicItem
  sub: string
  cur: boolean
  playing: boolean
  wait: boolean
  /** useImgKey() of the row */
  imgKey: number
  onPress: () => void
}) {
  return (
    <Press
      data-key={m.key}
      className="vm-tile vm-square"
      data-on={cur || undefined}
      data-wait={wait || undefined}
      aria-pressed={cur}
      aria-label={cur ? `${playing ? 'Pause' : 'Resume'} ${m.title}` : `Play ${m.title}`}
      onPress={onPress}
    >
      <Art src={musicSrc(imgKey, m.thumb, 300)} ratio="1/1">{cur && <Eq on={playing} />}</Art>
      <span className="vm-tile-t">{m.title}</span>
      <span className="vm-tile-s">{sub}</span>
    </Press>
  )
}

// ---------- the artist and album indexes ----------

type ArtistRow = { key: string; title: string; thumb: string | null; albums: number | null; genre: string }
/** One artist as the index caches it: [key, name, thumb path, album count, first genre], small enough to persist 1,700 of. */
type ArtistTuple = [string, string, string | null, number | null, string?]

const artistPart = partStore<ArtistRow>()
const toArtist = (a: MusicArtist): ArtistRow => ({ key: a.ratingKey, title: noDash(a.title), thumb: a.thumb, albums: a.albumCount, genre: a.genres[0] ?? '' })
const INDEX_KEEP_MS = 24 * 3600_000

/**
 * The whole artist list, 60 at a time. A cached index younger than a day is kept when the server's
 * artist count has not changed, so an app open costs one page, not 28 (the list carries every bio).
 */
const loadArtists = memoLoad(async (cached?: IndexData<ArtistTuple>): Promise<IndexData<ArtistTuple>> => {
  const fetchPage = (o: number) => fetchMusicArtists(o, { sort: 'title' })
  let head: Awaited<ReturnType<typeof fetchPage>> | undefined
  if (cached?.at && Date.now() - cached.at < INDEX_KEEP_MS) {
    head = await fetchPage(0)
    if (head.total === cached.total) return cached
  }
  const out = await pageAll(fetchPage, MUSIC_PAGE, toArtist, (rows, total) => artistPart.set({ rows, total }), head)
  return { v: 1, at: Date.now(), total: out.total, rows: out.rows.map((r): ArtistTuple => [r.key, r.title, r.thumb, r.albums, r.genre]) }
})

type ListIndex<T> = Indexed<T> & { live: Live<unknown>; total: number; filling: boolean; started: boolean }

/** Every artist A to Z: the cached index paints at once, a first load shows what has arrived and keeps going. */
function useArtistIndex(): ListIndex<ArtistRow> {
  // the loader sees what is on screen (the cached index), to keep it when nothing changed
  const shown = useRef<IndexData<ArtistTuple> | undefined>(undefined)
  const live = useLive('musicArtists', () => loadArtists(shown.current), 30 * 60_000, { revive: reviveIndex<ArtistTuple> })
  shown.current = live.data
  const part = useSyncExternalStore(artistPart.sub, artistPart.get, artistPart.get)
  const rows = useMemo(
    () => (live.data ? live.data.rows.map(([key, title, thumb, albums, genre]): ArtistRow => ({ key, title, thumb, albums, genre: genre ?? '' })) : part?.rows),
    [live.data, part],
  )
  const idx = useMemo(() => indexRows(rows ?? []), [rows])
  return { ...idx, live, total: live.data?.total ?? part?.total ?? 0, filling: !live.data, started: rows !== undefined }
}

type AlbumRow = { key: string; title: string; artist: string; artistKey: string | null; year: number | null; thumb: string | null }
/** One album as the index caches it: [key, title, artist, artist key, year, thumb]. */
type AlbumTuple = [string, string, string, string | null, number | null, string | null]

const albumPart = partStore<AlbumRow>()
const toAlbumRow = (a: MusicAlbum): AlbumRow => ({
  key: a.ratingKey, title: noDash(a.title), artist: noDash(a.artist), artistKey: a.artistKey, year: a.year, thumb: a.thumb,
})
// an album's thumb is nearly always /library/metadata/<key>/thumb/<stamp>: the cache keeps "~<stamp>" (4,900 albums persist)
const thumbIn = (key: string, t: string | null) => {
  const pre = `/library/metadata/${key}/thumb/`
  return t && t.startsWith(pre) ? `~${t.slice(pre.length)}` : t
}
const thumbOut = (key: string, t: string | null) => (t && t.startsWith('~') ? `/library/metadata/${key}/thumb/${t.slice(1)}` : t)

/** The whole album list, 60 at a time, kept for a day while the album count holds (as the artists). */
const loadAlbums = memoLoad(async (cached?: IndexData<AlbumTuple>): Promise<IndexData<AlbumTuple>> => {
  const fetchPage = (o: number) => fetchMusicAlbums(o, { sort: 'title' })
  let head: Awaited<ReturnType<typeof fetchPage>> | undefined
  if (cached?.at && Date.now() - cached.at < INDEX_KEEP_MS) {
    head = await fetchPage(0)
    if (head.total === cached.total) return cached
  }
  const out = await pageAll(fetchPage, MUSIC_PAGE, toAlbumRow, (rows, total) => albumPart.set({ rows, total }), head)
  return { v: 1, at: Date.now(), total: out.total, rows: out.rows.map((r): AlbumTuple => [r.key, r.title, r.artist, r.artistKey, r.year, thumbIn(r.key, r.thumb)]) }
})

/** Every album A to Z; it loads the first time the Albums list opens. */
function useAlbumIndex(): ListIndex<AlbumRow> {
  const shown = useRef<IndexData<AlbumTuple> | undefined>(undefined)
  const live = useLive('musicAlbums', () => loadAlbums(shown.current), 30 * 60_000, { revive: reviveIndex<AlbumTuple> })
  shown.current = live.data
  const part = useSyncExternalStore(albumPart.sub, albumPart.get, albumPart.get)
  const rows = useMemo(
    () => (live.data
      ? live.data.rows.map(([key, title, artist, artistKey, year, thumb]): AlbumRow => ({ key, title, artist, artistKey, year, thumb: thumbOut(key, thumb) }))
      : part?.rows),
    [live.data, part],
  )
  const idx = useMemo(() => indexRows(rows ?? []), [rows])
  return { ...idx, live, total: live.data?.total ?? part?.total ?? 0, filling: !live.data, started: rows !== undefined }
}

const artistItem = (r: ArtistRow): MusicItem => ({
  key: r.key, kind: 'artist', title: r.title, sub: r.genre, thumb: r.thumb, at: 0, artistKey: r.key, year: null,
})
const albumItem = (a: MusicAlbum): MusicItem => ({
  key: a.ratingKey, kind: 'album', title: a.title, sub: a.artist, thumb: a.thumb,
  at: ts(a.addedAt), artistKey: a.artistKey, year: a.year,
})
const albumRowItem = (r: AlbumRow): MusicItem => ({
  key: r.key, kind: 'album', title: r.title, sub: r.artist, thumb: r.thumb, at: 0, artistKey: r.artistKey, year: r.year,
})
/** An album's artist as the album knows it (name and key); the artist page fetches the rest. */
const artistOf = (key: string, name: string): MusicItem => ({
  key, kind: 'artist', title: name, sub: '', thumb: null, at: 0, artistKey: key, year: null,
})
const trackAlbum = (t: MusicTrack): MusicItem | null => (t.albumKey ? {
  key: t.albumKey, kind: 'album', title: noDash(t.album), sub: noDash(t.artist), thumb: t.thumb,
  at: 0, artistKey: t.artistKey, year: t.year,
} : null)

const OVERSCAN = 12
const CHUNK = 8

/**
 * The rows of a fixed-height list that are on screen (plus a margin), from the page's scroll. Only
 * those are rendered; the range moves in chunks so a scroll re-renders every few rows, not every
 * frame. `onTop` gets the index of the row at the top edge.
 */
function useWindow(ref: RefObject<HTMLElement | null>, count: number, rowH: number, on: boolean, onTop: (i: number) => void): [number, number] {
  const [win, setWin] = useState<[number, number]>(() => [0, Math.min(count, 40)])
  const top = useRef(onTop)
  top.current = onTop
  useEffect(() => {
    const el = ref.current
    const page = pageOf(el)
    if (!on || !el || !page) return
    let raf = 0
    const calc = () => {
      raf = 0
      // how far the list's top is above the page's top edge, in layout px like rowH
      const y = (page.getBoundingClientRect().top - el.getBoundingClientRect().top) / zoomOf(page)
      const a = Math.max(0, Math.floor(y / rowH) - OVERSCAN)
      const b = Math.min(count, Math.ceil((y + page.clientHeight) / rowH) + OVERSCAN)
      const f = Math.min(count, Math.floor(a / CHUNK) * CHUNK)
      const l = Math.max(f, Math.min(count, Math.ceil(b / CHUNK) * CHUNK))
      setWin((w) => (w[0] === f && w[1] === l ? w : [f, l]))
      if (count) top.current(Math.min(count - 1, Math.max(0, Math.floor((y + 4) / rowH))))
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(calc) }
    calc()
    page.addEventListener('scroll', kick, { passive: true })
    const ro = new ResizeObserver(kick)
    ro.observe(page)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      page.removeEventListener('scroll', kick)
      ro.disconnect()
    }
  }, [ref, count, rowH, on])
  return win
}

type BackTo = { label: string; go: () => void }

function Back({ to }: { to: BackTo }) {
  return (
    <Press className="vl-link vm-back" onPress={to.go}>
      <Glyph name="left" size={11} />
      <span className="vl-ellipsis">{to.label}</span>
    </Press>
  )
}

// ---------- Music rows ----------

/** One artist: art, name, album count (or genre). The A to Z list and the search results share it. */
function ArtistLine({ r, on, eq, playing, imgKey, onPress }: {
  r: ArtistRow
  on: boolean
  /** the playing track is this artist's */
  eq: boolean
  playing: boolean
  imgKey: number
  onPress: () => void
}) {
  return (
    <Press
      className="vm-arow"
      data-on={on || undefined}
      aria-label={r.albums ? `${r.title}, ${plural(r.albums, 'album')}` : r.genre ? `${r.title}, ${r.genre}` : r.title}
      onPress={onPress}
    >
      <Art src={musicSrc(imgKey, r.thumb, 120)} ratio="1/1" className="vm-arow-art" />
      <span className="vm-arow-t">{r.title}</span>
      {eq && <Eq on={playing} />}
      {/* the artist list carries no album count from Plex today; the genre stands in */}
      <span className="vm-arow-n">{r.albums ? plural(r.albums, 'album') : r.genre}</span>
    </Press>
  )
}

/** One album: art, title over artist and year. */
function AlbumLine({ r, on, eq, playing, imgKey, onPress }: {
  r: AlbumRow
  on: boolean
  eq: boolean
  playing: boolean
  imgKey: number
  onPress: () => void
}) {
  const sub = [r.artist, r.year].filter(Boolean).join(' · ')
  return (
    <Press className="vm-arow vm-arow2" data-on={on || undefined} aria-label={sub ? `${r.title}, ${sub}` : r.title} onPress={onPress}>
      <Art src={musicSrc(imgKey, r.thumb, 120)} ratio="1/1" className="vm-arow-art" />
      <span className="vm-arow-text">
        <span className="vm-arow-t">{r.title}</span>
        {sub && <span className="vm-arow-s">{sub}</span>}
      </span>
      {eq && <Eq on={playing} />}
    </Press>
  )
}

/** One track in the search results: art, title over artist and album, the length; a tap plays it. */
function TrackLine({ t, cur, playing, wait, imgKey, onPress }: {
  t: MusicTrack
  cur: boolean
  playing: boolean
  wait: boolean
  imgKey: number
  onPress: () => void
}) {
  const sub = [t.trackArtist ?? t.artist, t.album].filter(Boolean).map((s) => noDash(s)).join(' · ')
  return (
    <Press
      className="vm-arow vm-arow2"
      data-on={cur || undefined}
      data-wait={wait || undefined}
      disabled={!t.streamKey}
      aria-label={cur ? `${playing ? 'Pause' : 'Resume'} ${t.title}` : `Play ${t.title}`}
      onPress={onPress}
    >
      <Art src={musicSrc(imgKey, t.thumb, 120)} ratio="1/1" className="vm-arow-art" />
      <span className="vm-arow-text">
        <span className="vm-arow-t">{noDash(t.title)}</span>
        {sub && <span className="vm-arow-s">{sub}</span>}
      </span>
      {cur && <Eq on={playing} />}
      <span className="vm-arow-n">{!t.streamKey ? 'No file' : t.duration ? clock(t.duration) : ''}</span>
    </Press>
  )
}

// ---------- the A to Z lists (Artists, Albums) ----------

type ListMode = 'artists' | 'albums'
const isListMode = (s: unknown): s is ListMode => s === 'artists' || s === 'albums'

/**
 * A windowed list of fixed-height rows with the A to Z strip beside it: only the rows on screen
 * are rendered, so 4,900 albums cost what 40 do. `children` is the header over the rows.
 */
function IndexList<T extends { key: string }>({ idx, rowH, visible, stripLabel, row, children }: {
  idx: Indexed<T>
  rowH: number
  visible: boolean
  stripLabel: string
  row: (r: Lettered<T>) => ReactNode
  children: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const n = idx.list.length
  const [cur, setCur] = useState<string | null>(null)
  const listNow = useRef(idx.list)
  listNow.current = idx.list
  const onTop = useCallback((i: number) => setCur(listNow.current[i]?.letter ?? null), [])
  const [a, b] = useWindow(listRef, n, rowH, visible, onTop)
  const has = useMemo(() => new Set(idx.first.keys()), [idx.first])
  const [pin, pinTo] = usePin(listRef)

  const jump = (l: string) => {
    const list = listRef.current
    const page = pageOf(list)
    const i = idx.first.get(l)
    if (!list || !page || i == null) return
    page.scrollTop = topIn(list, page) + i * rowH
    pinTo(l)
  }

  return (
    <div className="vm-lib">
      <div className="vm-lib-main">
        {children}
        <div ref={listRef} className="vm-alist" style={{ height: n * rowH, '--row': `${rowH}px` } as Vars}>
          <ol className="vm-alist-win" style={{ transform: `translate3d(0, ${a * rowH}px, 0)` }}>
            {idx.list.slice(a, b).map((r) => <li key={r.key}>{row(r)}</li>)}
          </ol>
        </div>
      </div>
      <div className="vm-az-col">
        <AZStrip has={has} current={pin ?? cur} onJump={jump} label={stripLabel} />
      </div>
    </div>
  )
}

/** Artists | Albums as text tabs in the list header, its count, and what the server said. */
function ListHead({ mode, setMode, idx, retryKey }: {
  mode: ListMode
  setMode: (m: ListMode) => void
  idx: ListIndex<unknown>
  retryKey: string
}) {
  const qc = useQueryClient()
  const failed = idx.live.failed || !!idx.live.error
  const n = idx.list.length
  const one = mode === 'albums' ? 'album' : 'artist'
  return (
    <>
      <Head
        icon="music"
        lit={idx.filling && idx.started}
        label={(
          <span className="vm-htabs" role="group" aria-label="List">
            {(['artists', 'albums'] as const).map((m) => (
              <Press key={m} className="vm-htab" data-on={mode === m || undefined} aria-pressed={mode === m} onPress={() => setMode(m)}>
                {m === 'artists' ? 'Artists' : 'Albums'}
              </Press>
            ))}
          </span>
        )}
        value={idx.started ? countLabel(n, idx.total, idx.filling, one) : undefined}
      >
        {failed && (
          <Press className="vm-hact" onPress={() => void qc.refetchQueries({ queryKey: ['v2', retryKey] })}>
            <Icon name="refresh" size={13} tone="dim" />
            Retry
          </Press>
        )}
      </Head>
      {failed && <p className="vm-quiet-line vm-err">{n ? `The music server did not answer. Showing ${num(n)} ${one}s.` : 'The music server did not answer.'}</p>}
      {!n && !failed && <p className="vm-quiet-line">{idx.started ? `No ${one}s on the music server.` : `Loading ${one}s`}</p>}
    </>
  )
}

/** The Albums list: its own component, so the 4,900-album index loads only once it is opened. */
function AlbumList({ mode, setMode, rowH, visible, imgKey, hilite, playingAlbum, playing, onAlbum }: {
  mode: ListMode
  setMode: (m: ListMode) => void
  rowH: number
  visible: boolean
  imgKey: number
  hilite: string | null
  playingAlbum: string | null
  playing: boolean
  onAlbum: (al: MusicItem) => void
}) {
  const idx = useAlbumIndex()
  return (
    <IndexList
      idx={idx}
      rowH={rowH}
      visible={visible}
      stripLabel="Albums A to Z"
      row={(r) => (
        <AlbumLine r={r} on={hilite === r.key} eq={playingAlbum === r.key} playing={playing} imgKey={imgKey} onPress={() => onAlbum(albumRowItem(r))} />
      )}
    >
      <ListHead mode={mode} setMode={setMode} idx={idx} retryKey="musicAlbums" />
    </IndexList>
  )
}

// ---------- Music search ----------

/** /plex/music/search answers at most this many of each kind. */
const SEARCH_CAP = 12
const ARTIST_CAP = 8

/**
 * Artists, albums and tracks matching the search. Artists come from the loaded A to Z index (every
 * match, at once) plus any the server found that it lacks; albums and tracks from the server.
 */
function MusicResults({ typed, q, found, busy, failed, artists, artistH, rowH, imgKey, p, hiArtist, hiAlbum, pendingTrack, onArtist, onAlbum, onTrack }: {
  typed: string
  q: string
  found: MusicSearchResults | undefined
  busy: boolean
  failed: boolean
  artists: readonly ArtistRow[]
  artistH: number
  rowH: number
  imgKey: number
  p: PlayerNow
  hiArtist: string | null
  hiAlbum: string | null
  pendingTrack: string | null
  onArtist: (a: MusicItem) => void
  onAlbum: (al: MusicItem) => void
  onTrack: (t: MusicTrack) => void
}) {
  const [all, setAll] = useState(false)
  useEffect(() => setAll(false), [q])
  const keys = useMemo(() => artists.map((r) => squash(r.title)), [artists])
  const local = useDeferredValue(typed)
  const artistList = useMemo(() => {
    const words = queryWords(local)
    const mine = words.length ? artists.filter((_, i) => hits(words, keys[i])) : []
    const seen = new Set(mine.map((r) => r.key))
    return [...mine, ...(found?.artists ?? []).map(toArtist).filter((r) => !seen.has(r.key))]
  }, [local, artists, keys, found])
  const albums = useMemo(() => (found?.albums ?? []).map(toAlbumRow), [found])
  const tracks = found?.tracks ?? []
  const now = p.item ? p.tracks[p.index] ?? null : null
  const capped = (n: number) => (n >= SEARCH_CAP ? `First ${SEARCH_CAP}` : num(n))
  const rows = (h: number) => ({ '--row': `${h}px` } as Vars)

  return (
    <div className="vm-mres">
      {artistList.length > 0 && (
        <section className="vm-rsec">
          <Head icon="music" label="Artists" value={num(artistList.length)} />
          <ol className="vm-alist-win vm-rlist" style={rows(artistH)}>
            {(all ? artistList : artistList.slice(0, ARTIST_CAP)).map((r) => (
              <li key={r.key}>
                <ArtistLine r={r} on={hiArtist === r.key} eq={now?.artistKey === r.key} playing={p.playing} imgKey={imgKey} onPress={() => onArtist(artistItem(r))} />
              </li>
            ))}
          </ol>
          {artistList.length > ARTIST_CAP && (
            <Press className="vm-more" onPress={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${num(artistList.length)}`}</Press>
          )}
        </section>
      )}
      {albums.length > 0 && (
        <section className="vm-rsec">
          <Head icon="tracks" label="Albums" value={capped(albums.length)} />
          <ol className="vm-alist-win vm-rlist" style={rows(rowH)}>
            {albums.map((r) => (
              <li key={r.key}>
                <AlbumLine r={r} on={hiAlbum === r.key} eq={now?.albumKey === r.key} playing={p.playing} imgKey={imgKey} onPress={() => onAlbum(albumRowItem(r))} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {tracks.length > 0 && (
        <section className="vm-rsec">
          <Head icon="play" lit={p.playing && tracks.some((t) => p.item?.key === tKey(t))} label="Tracks" value={capped(tracks.length)} />
          <ol className="vm-alist-win vm-rlist" style={rows(rowH)}>
            {tracks.map((t) => (
              <li key={t.ratingKey}>
                <TrackLine t={t} cur={p.item?.key === tKey(t)} playing={p.playing} wait={pendingTrack === t.ratingKey} imgKey={imgKey} onPress={() => onTrack(t)} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {!artistList.length && !albums.length && !tracks.length && (
        <p className="vm-quiet-line">
          {failed ? 'The music server did not answer the search.' : busy || q !== typed ? 'Searching music' : `Nothing on the music server matches "${typed}".`}
        </p>
      )}
    </div>
  )
}

// ---------- Music library ----------

/** What the detail shows: an artist, an album, or an album with its artist (`from`: where the album was opened). */
type OpenMusic = { artist: MusicItem | null; album: MusicItem | null; from: 'list' | 'artist' }

function MusicLib({ visible }: { visible: boolean }) {
  const wide = useMq('(min-width: 640px)')
  const artists = useArtistIndex()
  const recent = useMusic()
  const p = usePlayerNow()
  const starter = useStarter()
  const imgKey = useImgKey()
  const qc = useQueryClient()
  const [mode, setMode] = useStored<ListMode>('v2.media.musicList', 'artists', isListMode)
  const [text, setText] = useState('')
  const typed = text.trim()
  const q = useDebounced(typed, 300)
  const searching = typed.length >= 2
  const [open, setOpen] = useState<OpenMusic | null>(null)
  const [last, setLast] = useState<{ artist: string | null; album: string | null }>({ artist: null, album: null })
  const rootRef = useRef<HTMLDivElement>(null)
  const colRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const saved = useRef(0)
  const artistH = wide ? 44 : 48
  const rowH = wide ? 48 : 52
  const listOn = visible && (wide || !open)
  useSlash(searchRef, listOn)

  const found = useQuery({
    queryKey: ['v2-x', 'musicSearch', q.toLowerCase()],
    queryFn: () => searchMusic(q),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
    retry: 0,
  })

  // phone: an open artist (or album) takes the list's place, and the list's scroll comes back with it
  const openTo = (next: OpenMusic | null) => {
    const page = pageOf(rootRef.current)
    if (!wide && page && !open && next) saved.current = page.scrollTop
    if (next) setLast({ artist: next.artist?.key ?? null, album: next.album?.key ?? null })
    setOpen(next)
  }
  const openKey = open ? `${open.artist?.key ?? ''}/${open.album?.key ?? ''}` : ''
  const firstRun = useRef(true)
  useLayoutEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const root = rootRef.current
    const page = pageOf(root)
    if (!root || !page) return
    if (wide) {
      const pane = root.querySelector<HTMLElement>('.vm-mdetail')
      if (pane) pane.scrollTop = 0
      return
    }
    page.scrollTop = openKey ? Math.max(0, topIn(root, page) - 8) : saved.current
  }, [openKey, wide])

  // another list (Artists, Albums, results) starts at its top when the page was scrolled into the last one
  const listKey = searching ? 'search' : mode
  const firstList = useRef(true)
  useLayoutEffect(() => {
    if (firstList.current) {
      firstList.current = false
      return
    }
    const box = colRef.current?.querySelector<HTMLElement>('.vm-msearch')
    const page = pageOf(box)
    if (!box || !page) return
    const t = Math.max(0, topIn(box, page) - 8)
    if (page.scrollTop > t) page.scrollTop = t
  }, [listKey])

  // wide screens always show an artist beside the list: the one picked, else the last played
  const fallback = recent.data?.played[0] ?? null
  const shown: OpenMusic | null = open ?? (wide && fallback ? { artist: fallback, album: null, from: 'list' } : null)
  const nowTrack = p.item ? p.tracks[p.index] ?? null : null
  const hiArtist = shown?.artist?.key ?? last.artist
  const hiAlbum = shown ? shown.album?.key ?? null : last.album

  const toList: BackTo = { label: searching ? 'Results' : mode === 'albums' ? 'All albums' : 'All artists', go: () => openTo(null) }
  const openArtist = (a: MusicItem) => openTo({ artist: a, album: null, from: 'list' })
  const openAlbum = (al: MusicItem) => openTo({ artist: al.artistKey ? artistOf(al.artistKey, al.sub) : null, album: al, from: 'list' })

  // a found track plays its album from that track (the album's tracks are fetched once, then cached)
  const [pendingTrack, setPendingTrack] = useState<string | null>(null)
  const trackSeq = useRef(0)
  const playTrack = (t: MusicTrack) => {
    if (p.item?.key === tKey(t)) {
      playerActions.toggle()
      return
    }
    const token = ++trackSeq.current
    const al = trackAlbum(t)
    if (!al) {
      setPendingTrack(null)
      playList([t], 0, tKey(t), t.title)
      return
    }
    if (wide) openAlbum(al)
    const run = (list: MusicTrack[]) => {
      const i = list.findIndex((x) => x.ratingKey === t.ratingKey)
      if (i >= 0) playList(list, i, al.key, al.title)
      else playList([t], 0, tKey(t), t.title)
    }
    const cached = qc.getQueryData<MusicTrack[]>(tracksQuery(al).queryKey)
    if (cached) {
      setPendingTrack(null)
      run(cached)
      return
    }
    setPendingTrack(t.ratingKey)
    qc.fetchQuery(tracksQuery(al))
      .then((list) => { if (token === trackSeq.current) run(list) })
      .catch(() => { if (token === trackSeq.current) playList([t], 0, tKey(t), t.title) })
      .finally(() => { if (token === trackSeq.current) setPendingTrack(null) })
  }

  let detail: ReactNode = null
  if (shown?.album) {
    const { album, artist, from } = shown
    const toArtistPage = artist ? () => openTo({ artist, album: null, from: 'list' }) : null
    detail = (
      <AlbumPane
        key={`al${album.key}`}
        album={album}
        p={p}
        starter={starter}
        imgKey={imgKey}
        visible={visible}
        back={from === 'artist' && artist && toArtistPage ? { label: artist.title, go: toArtistPage } : wide ? null : toList}
        onArtist={from === 'list' && toArtistPage ? toArtistPage : undefined}
      />
    )
  } else if (shown?.artist) {
    const { artist } = shown
    detail = (
      <ArtistPane
        key={`ar${artist.key}`}
        artist={artist}
        p={p}
        starter={starter}
        imgKey={imgKey}
        back={wide ? null : toList}
        onAlbum={(al) => openTo({ artist, album: albumItem(al), from: 'artist' })}
      />
    )
  }

  return (
    <div ref={rootRef} className={cx('vm-music', wide && 'vm-msplit')}>
      <div ref={colRef} className="vm-mcol" hidden={!wide && !!open}>
        <NowPlaying i={0} />
        <div className="vm-msearch">
          <SearchLine
            label="Search music"
            value={text}
            onChange={setText}
            placeholder="Search artists, albums, tracks"
            busy={searching && (found.isFetching || q !== typed)}
            inputRef={searchRef}
          />
        </div>
        {searching ? (
          <MusicResults
            typed={typed}
            q={q}
            found={q.length >= 2 ? found.data : undefined}
            busy={found.isFetching}
            failed={found.isError}
            artists={artists.list}
            artistH={artistH}
            rowH={rowH}
            imgKey={imgKey}
            p={p}
            hiArtist={hiArtist}
            hiAlbum={hiAlbum}
            pendingTrack={pendingTrack}
            onArtist={openArtist}
            onAlbum={openAlbum}
            onTrack={playTrack}
          />
        ) : mode === 'albums' ? (
          <AlbumList
            mode={mode}
            setMode={setMode}
            rowH={rowH}
            visible={listOn}
            imgKey={imgKey}
            hilite={hiAlbum}
            playingAlbum={nowTrack?.albumKey ?? null}
            playing={p.playing}
            onAlbum={openAlbum}
          />
        ) : (
          <IndexList
            idx={artists}
            rowH={artistH}
            visible={listOn}
            stripLabel="Artists A to Z"
            row={(r) => (
              <ArtistLine r={r} on={hiArtist === r.key} eq={nowTrack?.artistKey === r.key} playing={p.playing} imgKey={imgKey} onPress={() => openArtist(artistItem(r))} />
            )}
          >
            <ListHead mode={mode} setMode={setMode} idx={artists} retryKey="musicArtists" />
          </IndexList>
        )}
      </div>
      {(wide || open) && (
        <div className="vm-mdetail">
          {detail ?? <Quiet>Pick an artist.</Quiet>}
        </div>
      )}
    </div>
  )
}

/** An artist or album at the top of its page: art, what it is (or what is playing), Play and Shuffle. */
function MusicHead({ item, thumb, imgKey, sub, isCur, p, wait, onPlay, onShuffle }: {
  item: MusicItem
  thumb: string | null
  imgKey: number
  sub: string
  isCur: boolean
  p: PlayerNow
  wait: boolean
  onPlay: () => void
  onShuffle: () => void
}) {
  const playing = isCur && p.playing
  const art = musicSrc(imgKey, thumb, 600)
  const aura = musicArtUrl(imgKey, thumb, 300)
  const cap = isCur
    ? `${p.playing ? 'Playing' : 'Paused'}${p.index >= 0 && p.queue.length > 1 ? ` · ${p.index + 1} / ${p.queue.length}` : ''}`
    : item.kind === 'artist' ? 'Artist' : 'Album'
  return (
    <section className="vm-mhero vm-phero">
      <div className="vm-mhero-art vl-build">
        {aura && <img className="vm-aura" src={aura} alt="" aria-hidden decoding="async" />}
        <Art src={art} ratio="1/1" eager>{isCur && <Eq on={playing} />}</Art>
      </div>
      <div className="vm-mhero-text">
        <span className="vm-cap vl-build" style={iv(1)}>
          <Icon name={isCur ? (p.playing ? 'play' : 'idle') : item.kind === 'album' ? 'tracks' : 'music'} size={13} tone={playing ? 'fg' : 'dim'} glow={playing} />
          <span className="vl-ellipsis">{cap}</span>
        </span>
        <h2 className="vm-mhero-title vl-build" style={iv(2)}>{item.title}</h2>
        <span className="vm-mhero-sub vl-ellipsis vl-build" style={iv(3)}>{sub}</span>
        <div className="vm-mhero-acts vl-build" style={iv(4)}>
          <Press className="vl-btn vm-play" data-playing={playing || undefined} data-wait={wait || undefined} onPress={onPlay}>
            <Icon name={playing ? 'idle' : 'play'} size={17} tone="ink" />
            {playing ? 'Pause' : isCur ? 'Resume' : 'Play'}
          </Press>
          <Press className="vl-link vm-shuffle" onPress={onShuffle}>Shuffle</Press>
        </div>
      </div>
    </section>
  )
}

/** An artist: Play / Shuffle everything, then the albums (newest first); an album opens its tracks. */
function ArtistPane({ artist, p, starter, imgKey, back, onAlbum }: {
  artist: MusicItem
  p: PlayerNow
  starter: Starter
  imgKey: number
  back: BackTo | null
  onAlbum: (a: MusicAlbum) => void
}) {
  const albums = useQuery({
    queryKey: ['v2-x', 'albums', artist.key],
    queryFn: () => fetchArtistAlbums(artist.key),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  })
  const meta = useQuery({
    queryKey: ['v2-x', 'artist', artist.key],
    queryFn: () => fetchMusicArtist(artist.key),
    staleTime: 60 * 60_000,
    refetchInterval: false,
  })
  const src = sourceOf(p)
  const isCur = src === artist.key
  const list = useMemo(
    () => [...(albums.data ?? [])].sort((x, y) => (y.year ?? 0) - (x.year ?? 0) || collator.compare(x.title, y.title)),
    [albums.data],
  )
  const genre = artist.sub || meta.data?.genres[0] || ''
  const sub = [genre || 'Artist', albums.data ? plural(albums.data.length, 'album') : null].filter(Boolean).join(' · ')
  return (
    <div className="vm-pane vl-build-on">
      {back && <Back to={back} />}
      <MusicHead
        item={artist}
        thumb={artist.thumb ?? meta.data?.thumb ?? null}
        imgKey={imgKey}
        sub={sub}
        isCur={isCur}
        p={p}
        wait={starter.pending === artist.key}
        onPlay={() => (isCur ? playerActions.toggle() : starter.start(artist))}
        onShuffle={() => starter.start(artist, true)}
      />
      <Sec icon="tracks" lit={p.playing && !!src && list.some((al) => al.ratingKey === src)} label="Albums" value={albums.data?.length} i={3}>
        {!list.length ? (
          <p className="vm-quiet-line">{albums.isError ? 'The music server did not answer.' : albums.isFetching ? 'Loading albums' : 'No albums.'}</p>
        ) : (
          <div className="vm-agrid">
            {list.map((al) => {
              const cur = src === al.ratingKey
              return (
                <Press key={al.ratingKey} className="vm-tile vm-atile" data-on={cur || undefined} aria-label={`${al.title}: tracks`} onPress={() => onAlbum(al)}>
                  <Art src={musicSrc(imgKey, al.thumb, 300)} ratio="1/1">{cur && <Eq on={p.playing} />}</Art>
                  <span className="vm-tile-t">{al.title}</span>
                  <span className="vm-tile-s">{[al.year, al.trackCount ? plural(al.trackCount, 'track') : null].filter(Boolean).join(' · ')}</span>
                </Press>
              )
            })}
          </div>
        )}
      </Sec>
      {(!isCur || started?.mix) && <UpNext i={5} />}
    </div>
  )
}

/** An album: Play / Shuffle, then every track; a track plays the album from there. */
function AlbumPane({ album, p, starter, imgKey, visible, back, onArtist }: {
  album: MusicItem
  p: PlayerNow
  starter: Starter
  imgKey: number
  visible: boolean
  back: BackTo | null
  /** opened from a list (not its artist's page): "More by <artist>" goes there */
  onArtist?: () => void
}) {
  const tracks = useQuery(tracksQuery(album))
  const list = tracks.data ?? []
  const src = sourceOf(p)
  const isCur = src === album.key
  const totalMs = list.reduce((s, t) => s + (t.duration ?? 0), 0)
  const sub = [album.sub, album.year].filter(Boolean).join(' · ') || 'Album'
  const curKey = p.item?.key ?? null
  const liveHere = p.playing && !!curKey && list.some((t) => tKey(t) === curKey)
  return (
    <div className="vm-pane vl-build-on">
      {back && <Back to={back} />}
      <MusicHead
        item={album}
        thumb={album.thumb}
        imgKey={imgKey}
        sub={sub}
        isCur={isCur}
        p={p}
        wait={starter.pending === album.key}
        onPlay={() => (isCur ? playerActions.toggle() : starter.start(album))}
        onShuffle={() => starter.start(album, true)}
      />
      <Sec
        className="vm-tracks"
        icon="tracks"
        lit={liveHere}
        label="Tracks"
        value={list.length ? `${plural(list.length, 'track')}${totalMs ? ` · ${runtime(totalMs)}` : ''}` : undefined}
        extra={onArtist && album.sub ? (
          <Press className="vm-hact" onPress={onArtist}>
            <span className="vl-ellipsis">More by {album.sub}</span>
            <Glyph name="right" size={10} />
          </Press>
        ) : undefined}
        i={3}
      >
        {!list.length ? (
          <p className="vm-quiet-line">{tracks.isError ? 'The music server did not answer.' : tracks.isFetching ? 'Loading tracks' : 'No tracks.'}</p>
        ) : (
          <TrackList list={list} p={p} visible={visible} onPlay={(t) => playList(list, list.indexOf(t), album.key, album.title)} />
        )}
      </Sec>
      {(!isCur || started?.mix) && <UpNext i={5} />}
    </div>
  )
}

function TrackList({ list, p, visible, onPlay }: { list: MusicTrack[]; p: PlayerNow; visible: boolean; onPlay: (t: MusicTrack) => void }) {
  const multiDisc = new Set(list.map((t) => t.disc ?? 1)).size > 1
  const curKey = p.item?.key ?? null
  return (
    <ol className="vl-rows vm-tlist">
      {list.map((t) => {
        const isCur = tKey(t) === curKey
        const subLine = t.trackArtist && t.trackArtist !== t.artist ? t.trackArtist : null
        const no = multiDisc && t.disc != null ? `${t.disc}-${t.index ?? ''}` : String(t.index ?? '')
        return (
          <li key={t.ratingKey}>
            <Press
              className="vm-track"
              data-on={isCur || undefined}
              disabled={!t.streamKey}
              aria-label={isCur ? `${p.playing ? 'Pause' : 'Resume'} ${t.title}` : `Play ${t.title}`}
              onPress={() => (isCur ? playerActions.toggle() : onPlay(t))}
            >
              <span className="vm-track-n">
                {isCur ? <Icon name={p.playing ? 'play' : 'idle'} size={15} tone="fg" glow={p.playing} /> : no}
              </span>
              <span className="vm-track-text">
                <span className="vm-track-t">{t.title}</span>
                {subLine && <span className="vm-track-s">{subLine}</span>}
              </span>
              <span className="vm-track-d">
                {!t.streamKey ? 'No file' : isCur && t.duration && visible ? <Elapsed total={t.duration} /> : t.duration ? clock(t.duration) : ''}
              </span>
            </Press>
          </li>
        )
      })}
    </ol>
  )
}


/** "1:23 / 3:40" for the playing track, following the player's position. */
function Elapsed({ total }: { total: number }) {
  const p = usePlayer()
  return <><b>{clock(Math.min(total, p.position * 1000))}</b> / {clock(total)}</>
}

/** The loaded track: art, title, previous / play / next, a seek line, and why it stopped. */
function NowPlaying({ i }: { i: number }) {
  const p = usePlayer()
  // while the thumb is dragged the line follows the finger, not the clock; the seek happens once on release
  const [scrub, setScrub] = useState<number | null>(null)
  if (!p.item) return null
  const pos = scrub ?? p.position
  const max = Math.max(1, p.duration)
  const commit = () => {
    if (scrub == null) return
    playerActions.seek(scrub)
    setScrub(null)
  }
  return (
    <Sec
      className="vm-now"
      i={i}
      icon="play"
      lit={p.playing}
      label="Now Playing"
      value={p.queue.length > 1 ? `${p.index + 1} / ${p.queue.length}` : undefined}
    >
      <div className="vm-now-row">
        <Art src={p.item.img} ratio="1/1" className="vm-now-art" />
        <span className="vm-now-text">
          <span className="vm-now-t">{p.item.title}</span>
          {p.item.subtitle && <span className="vm-now-s">{p.item.subtitle}</span>}
        </span>
        <span className="vm-now-ctl">
          <Press className="vm-ctl" aria-label="Previous" onPress={playerActions.prev}><Glyph name="prev" size={13} /></Press>
          <Press className="vm-ctl vm-ctl-main" data-on={p.playing || undefined} aria-label={p.playing ? 'Pause' : 'Play'} onPress={playerActions.toggle}>
            <Glyph name={p.playing ? 'pause' : 'play'} size={14} />
          </Press>
          <Press className="vm-ctl" aria-label="Next" disabled={p.index >= p.queue.length - 1} onPress={playerActions.next}><Glyph name="next" size={13} /></Press>
        </span>
      </div>
      <div className="vm-seek" data-no-swipe>
        <span>{clock(pos * 1000)}</span>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={Math.min(pos, max)}
          disabled={!p.duration}
          style={{ '--p': Math.min(1, pos / max) } as Vars}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          onBlur={commit}
          aria-label="Seek"
        />
        <span>{clock(p.duration * 1000)}</span>
      </div>
      {p.error && <p className="vm-quiet-line vm-err">{capFirst(p.error)}</p>}
    </Sec>
  )
}

const UP_CAP = 5

/** The rest of the queue after the current track; a tap jumps there. */
function UpNext({ i }: { i: number }) {
  const p = usePlayerNow()
  const [all, setAll] = useState(false)
  const rest = p.index >= 0 ? p.queue.slice(p.index + 1) : []
  if (!rest.length) return null
  const shown = all ? rest : rest.slice(0, UP_CAP)
  return (
    <Sec className="vm-tracks" i={i} icon="tracks" label="Up Next" value={plural(rest.length, 'track')}>
      <ol className="vl-rows vm-tlist">
        {shown.map((it, k) => {
          const qi = p.index + 1 + k
          const ms = p.tracks[qi]?.duration
          return (
            <li key={`${qi}-${it.key}`}>
              <Press className="vm-track" aria-label={`Play ${it.title}`} onPress={() => playerActions.playAt(qi)}>
                <span className="vm-track-n">{qi + 1}</span>
                <span className="vm-track-text">
                  <span className="vm-track-t">{it.title}</span>
                  {it.subtitle && <span className="vm-track-s">{it.subtitle}</span>}
                </span>
                <span className="vm-track-d">{ms ? clock(ms) : ''}</span>
              </Press>
            </li>
          )
        })}
      </ol>
      {rest.length > UP_CAP && (
        <Press className="vm-more" onPress={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rest.length}`}</Press>
      )}
    </Sec>
  )
}

// ---------- Requests ----------

const TONE_RANK: Record<string, number> = { stuck: 0, active: 1, waiting: 2, unknown: 3, done: 4 }
const cap1 = (s: string) => (s ? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/\bplex\b/gi, 'Plex') : s)
/** "0/6 eps · searching" -> "0/6 eps · Searching" */
const capSegs = (s: string) => s.split(' · ').map(cap1).join(' · ')
const kindLabel = (k: string) => (k === 'show' ? 'Show' : cap1(k))

/** The queue's counts, shared by the Requests view and the strip's center line so both say the same. */
function countQueue(d: { requests: RequestVM[]; downloads: DownloadVM[] } | undefined) {
  const downloads = [...(d?.downloads ?? [])].sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.progress - a.progress)
  const requests = d?.requests ?? []
  const open = requests
    .filter((r) => r.tone !== 'done')
    .sort((a, b) => (TONE_RANK[a.tone ?? 'unknown'] - TONE_RANK[b.tone ?? 'unknown']) || b.at - a.at)
  const done = requests.filter((r) => r.tone === 'done')
  // a stuck request is usually the same item as a stuck download ("Severance" / "Severance S02E04"): count it once
  const stuckDl = downloads.filter((x) => x.stuck)
  const stuckReq = open.filter((r) => r.tone === 'stuck' && !stuckDl.some((x) => x.title.toLowerCase().startsWith(r.title.toLowerCase())))
  const waitingRows = open.filter((r) => r.tone === 'waiting' || r.tone === null)
  return {
    downloads,
    requests,
    open,
    done,
    stuck: stuckDl.length + stuckReq.length,
    moving: downloads.length - stuckDl.length,
    waiting: waitingRows.length,
    // label the count the way its rows read: "Searching" when every waiting row says so
    waitWord: waitingRows.length && waitingRows.every((r) => /searching/i.test(r.status)) ? 'Searching' : 'Waiting',
  }
}

function Requests({ visible }: { visible: boolean }) {
  const q = useMediaQueue()
  const now = useTick(5_000)
  const [allDone, setAllDone] = useState(false)
  const { downloads, requests, open, done, stuck, moving, waiting, waitWord } = countQueue(q.data)
  const oldest = open.reduce((m, r) => (r.at && r.at < m ? r.at : m), Infinity)

  const shownDone = allDone ? done : done.slice(0, 5)
  const pipeTotal = done.length + waiting + moving + stuck
  // one tree for loading and loaded, so the search box (and what is typed in it) never remounts
  return (
    <>
      <Stale live={q} what="The request queue" now={now} />
      <div className="vm-split vm-split-req">
        <div className="vm-side">
          {!q.data ? (
            <Quiet>{q.failed || q.error ? 'The request queue did not answer.' : 'Loading requests'}</Quiet>
          ) : (
            <>
              <div className="vm-stats vl-build" style={iv(1)}>
                <Count icon="download" label="Downloading" n={moving} tone="hot" />
                <Count icon={waitWord === 'Searching' ? 'search' : 'clock'} label={waitWord} n={waiting} tone="fg" />
                <Count icon="alert" label="Stuck" n={stuck} tone="acc2" />
                <Count icon="done" label="Arrived" n={done.length} tone="dim" />
              </div>
              {pipeTotal > 0 && (
                <div className="vm-pipe vl-build" style={iv(2)} aria-label={`${done.length} arrived, ${moving} downloading, ${waiting} ${waitWord.toLowerCase()}, ${stuck} stuck`}>
                  <div className="vm-pipe-bar">
                    {([['dim', done.length], ['hot', moving], ['fg', waiting], ['acc2', stuck]] as const).map(([tone, n]) => (
                      n > 0 ? <i key={tone} data-tone={tone} style={{ flexGrow: n }} /> : null
                    ))}
                  </div>
                  <span className="vm-pipe-cap">{plural(pipeTotal, 'request')}<Fresh at={q.updatedAt} now={now} live={!q.fromCache && !q.failed} /></span>
                </div>
              )}
              {downloads.length > 0 && (
                <Sec className="vm-block vm-dls" i={3} icon="download" lit={moving > 0} label="Downloads" value={downloads.length}>
                  <div className="vl-rows">
                    {downloads.map((d, k) => <DownloadRow key={d.title + k} d={d} i={4 + k} />)}
                  </div>
                </Sec>
              )}
              {done.length > 0 && (
                <Sec className="vm-block vm-arrived" i={6} icon="done" label="Arrived" value={done.length}>
                  <div className="vl-rows">
                    {shownDone.map((r, k) => <RequestRow key={r.at + r.title} r={r} now={now} i={7 + k} />)}
                  </div>
                  {done.length > 5 && (
                    <Press className="vm-more" onPress={() => setAllDone((v) => !v)}>
                      {allDone ? 'Show fewer' : `Show all ${done.length}`}
                    </Press>
                  )}
                </Sec>
              )}
            </>
          )}
        </div>
        <div className="vm-main">
          <RequestSearch open={requests} visible={visible} />
          {open.length > 0 && (
            <Sec
              className="vm-open-panel"
              i={4}
              icon="clock"
              label="Open Requests"
              value={<><b className="vm-head-n">{open.length}</b>{Number.isFinite(oldest) && <> · oldest {ago(oldest, now)}</>}</>}
            >
              <div className="vl-rows">
                {open.map((r, k) => <RequestRow key={r.at + r.title} r={r} now={now} i={5 + k} />)}
              </div>
            </Sec>
          )}
        </div>
      </div>
    </>
  )
}

type Ask = 'library' | 'requested' | 'asked' | null
const resultId = (r: MediaSearchResult) => `${r.kind}-${r.tmdbId ?? r.tvdbId ?? r.foreignAlbumId ?? r.title}`
const RESULT_CAP = 6

const addTo = (id: string) => (s: ReadonlySet<string>) => new Set(s).add(id)
const dropFrom = (id: string) => (s: ReadonlySet<string>) => {
  const n = new Set(s)
  n.delete(id)
  return n
}

/** Request new media: the search (GET, about 15 s), Request per result, and a message to the media agent. */
function RequestSearch({ open, visible }: { open: RequestVM[]; visible: boolean }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  /** requested this session (the queue shows them on its next poll) */
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set())
  /** requests on their way: their button is disabled, so one tap sends one request */
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set())
  const [all, setAll] = useState(false)
  const [composing, setComposing] = useState(false)
  const [msg, setMsg] = useState('')
  const [posting, setPosting] = useState(false)
  const msgRef = useRef<HTMLInputElement>(null)
  const dq = useDebounced(text.trim(), 400)
  const on = dq.length >= 2
  const res = useQuery({
    queryKey: ['v2-x', 'reqSearch', dq.toLowerCase()],
    queryFn: () => searchMediaRequests(dq),
    enabled: on,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: false,
    retry: 0,
    refetchOnWindowFocus: false,
  })
  useEffect(() => setAll(false), [dq])
  const known = useMemo(() => new Set(open.map((r) => r.title.toLowerCase())), [open])
  const list = on ? res.data ?? [] : []
  const shown = all ? list : list.slice(0, RESULT_CAP)
  const waiting = on && res.isFetching

  const state = (r: MediaSearchResult): Ask => {
    if (r.downloaded) return 'library'
    if (r.inLibrary) return 'requested'
    if (asked.has(resultId(r))) return 'asked'
    const t = (r.artist ? `${r.artist} · ${r.title}` : r.title).toLowerCase()
    return known.has(t) ? 'requested' : null
  }
  const request = (r: MediaSearchResult) => {
    const id = resultId(r)
    if (sending.has(id)) return
    const name = r.year ? `${r.title} (${r.year})` : r.title
    setSending(addTo(id))
    addMediaRequest(r)
      .then((out) => {
        setAsked(addTo(id))
        toast(out.detail ? capFirst(noDash(out.detail, ', ')) : `Requested ${name}`, { ms: 4000 })
        void qc.invalidateQueries({ queryKey: ['v2', 'mediaQueue'] })
      })
      .catch((e: unknown) => {
        // 409: the *arr already tracks it, so it counts as requested
        if (statusOf(e) === 409) {
          setAsked(addTo(id))
          toast(`${name}: ${reason(e, 'already requested')}`, { ms: 4000 })
          return
        }
        toast(`Could not request ${name}: ${reason(e, 'Valkyrie did not answer')}`, { ms: 5000 })
      })
      .finally(() => setSending(dropFrom(id)))
  }

  const openComposer = () => {
    // nothing found: start the message from what was searched
    if (!msg && on && res.data && !res.data.length) setMsg(dq)
    openAndFocus(() => setComposing(true), msgRef)
  }
  const send = () => {
    const m = msg.trim()
    if (posting || m.length < 3) return
    setPosting(true)
    sendMediaMessage(m)
      .then((out) => {
        toast(out.detail ? capFirst(noDash(out.detail, ', ')) : 'Sent to the agent', { ms: 3500 })
        setMsg('')
        setComposing(false)
        void qc.invalidateQueries({ queryKey: ['v2', 'mediaQueue'] })
      })
      // the text stays in the box, so nothing typed is lost
      .catch((e: unknown) => toast(`Message not sent: ${reason(e, 'Valkyrie did not answer')}`, { ms: 5000 }))
      .finally(() => setPosting(false))
  }

  return (
    <Sec
      className="vm-reqsearch"
      i={0}
      aria-label="Request new media"
      icon="add"
      lit={waiting}
      label="Request"
      value={visible && waiting ? <>Searching <Waited key={dq} /></> : undefined}
    >
      <SearchLine label="Request a movie, show, or album" value={text} onChange={setText} placeholder="Movie, show, or album" busy={waiting} />
      {waiting && !res.data && (
        <p className="vm-quiet-line">Searching Radarr, Sonarr and Lidarr. This can take 15 seconds.</p>
      )}
      {on && res.isError && <p className="vm-quiet-line vm-err">The request service did not answer. Try again in a moment.</p>}
      {on && res.data && !res.data.length && !waiting && (
        <p className="vm-quiet-line">Nothing found for "{dq}". Message the agent instead.</p>
      )}
      {shown.length > 0 && (
        <ol className="vl-rows vm-results">
          {shown.map((r) => {
            const st = state(r)
            return (
              <li key={resultId(r)} className="vm-res" data-kind={r.kind}>
                <Art src={r.poster} ratio={r.kind === 'album' ? '1/1' : '2/3'} className="vm-res-art" />
                <span className="vm-res-text">
                  <span className="vm-res-t">{r.title}{r.year ? <span className="vm-res-y"> ({r.year})</span> : null}</span>
                  <span className="vm-res-s">
                    <Icon name={KIND_ICON[r.kind] ?? 'movie'} size={12} tone="dim" />
                    <span className="vl-ellipsis">{r.kind === 'album' ? `Album · ${r.artist ?? 'Unknown artist'}` : r.kind === 'show' ? 'Show' : 'Movie'}</span>
                  </span>
                </span>
                {st === null ? (
                  <Press
                    className="vm-reqbtn"
                    disabled={sending.has(resultId(r))}
                    data-wait={sending.has(resultId(r)) || undefined}
                    aria-label={`Request ${r.title}`}
                    onPress={() => request(r)}
                  >
                    <Icon name={sending.has(resultId(r)) ? 'refresh' : 'add'} size={14} tone="fg" />
                    {sending.has(resultId(r)) ? 'Requesting' : 'Request'}
                  </Press>
                ) : (
                  <span className="vm-res-st" data-st={st}>
                    <Icon name={st === 'library' ? 'done' : 'clock'} size={14} tone={st === 'asked' ? 'hot' : 'dim'} glow={st === 'asked'} />
                    {st === 'library' ? 'In library' : 'Requested'}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {(list.length > RESULT_CAP || !composing) && (
        <div className="vm-reqfoot">
          {list.length > RESULT_CAP && (
            <Press className="vm-more" onPress={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${list.length}`}</Press>
          )}
          {!composing && (
            <Press className="vl-link vm-agent" onPress={openComposer}>
              <Icon name="asking" size={15} tone="dim" />
              Message the agent<Glyph name="right" size={10} />
            </Press>
          )}
        </div>
      )}
      {composing && (
        <form className="vm-compose" onSubmit={(e) => { e.preventDefault(); send() }}>
          <p className="vm-quiet-line">Not in the results, or something specific? The media agent takes it from there.</p>
          <div className="vm-search" data-no-swipe data-busy={posting || undefined}>
            <Icon name="asking" size={16} tone={posting ? 'fg' : 'dim'} glow={posting} className="vm-search-icon" />
            <input
              ref={msgRef}
              type="text"
              value={msg}
              readOnly={posting}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && !posting) setComposing(false) }}
              placeholder="e.g. season 2 of Severance in 4K"
              aria-label="Message the media agent"
              enterKeyHint="send"
              autoComplete="off"
            />
            {posting && <i className="vm-search-busy" aria-hidden />}
            <Press className="vm-search-x" aria-label="Close the message" disabled={posting} onPress={() => setComposing(false)}>
              <Glyph name="close" size={10} />
            </Press>
          </div>
          <div className="vm-compose-foot">
            <Press className="vm-reqbtn" disabled={posting || msg.trim().length < 3} data-wait={posting || undefined} onPress={send}>
              <Icon name={posting ? 'refresh' : 'go'} size={14} tone="fg" />
              {posting ? 'Sending' : 'Send'}
            </Press>
          </div>
        </form>
      )}
    </Sec>
  )
}

const KIND_ICON: Record<string, IconName> = { movie: 'movie', show: 'watch', album: 'music' }

/** Quiet freshness: a dot (lit once this session fetched) and the data's age. */
function Fresh({ at, now, live }: { at: number; now: number; live: boolean }) {
  if (!at) return null
  return <span className="vm-fresh" data-live={live || undefined} title="Updated"><i aria-hidden />{ago(at, now)}</span>
}

/** One stat: icon and label over a big number. The icon is lit only for live, nonzero counts. */
function Count({ icon, label, n, tone }: { icon: IconName; label: string; n: number; tone: 'hot' | 'fg' | 'acc2' | 'dim' }) {
  const lit = n > 0 && (tone === 'hot' || tone === 'acc2')
  return (
    <div className="vm-count" data-tone={tone} data-zero={n === 0 || undefined}>
      <span className="vm-count-label vl-ellipsis">{label}</span>
      <span className="vm-count-n">
        <Icon name={icon} size={17} tone={n === 0 ? 'faint' : lit ? tone : 'dim'} glow={lit} />
        <b>{n}</b>
      </span>
    </div>
  )
}

function DownloadRow({ d, i }: { d: DownloadVM; i: number }) {
  return (
    <div className="vm-dl vl-build" data-stuck={d.stuck || undefined} style={iv(i)}>
      <div className="vm-dl-top">
        <Icon name={d.stuck ? 'alert' : 'download'} size={15} tone={d.stuck ? 'acc2' : 'hot'} glow className="vm-dl-icon" />
        <span className="vm-dl-title vl-ellipsis">{noDash(d.title)}</span>
        <span className="vm-dl-pct">{Math.round(d.progress)}<small>%</small></span>
      </div>
      <Bar value={d.progress} ticks={10} tone={d.stuck ? 'acc2' : 'hot'} />
      <div className="vm-dl-sub">
        <span className="vl-ellipsis">{kindLabel(d.kind)} · {d.stuck ? 'Stuck' : capSegs(d.status)}</span>
        <span>{d.stuck ? 'Needs manual import' : d.timeleft ? `${d.timeleft} left` : ''}</span>
      </div>
    </div>
  )
}

/** Request status as an icon: lit while it moves or needs a hand, dim while it waits or is done. */
function reqIcon(tone: string, status: string): { name: IconName; tone: IconTone; glow?: boolean } {
  if (tone === 'active') return { name: 'download', tone: 'hot', glow: true }
  if (tone === 'stuck') return { name: 'alert', tone: 'acc2', glow: true }
  if (tone === 'done') return { name: 'done', tone: 'dim' }
  if (/searching/i.test(status)) return { name: 'search', tone: 'dim' }
  return { name: 'clock', tone: tone === 'unknown' ? 'faint' : 'dim' }
}

function RequestRow({ r, now, i }: { r: RequestVM; now: number; i: number }) {
  const tone = r.tone ?? 'unknown'
  const ic = reqIcon(tone, r.status)
  return (
    <div className="vm-req vl-build" data-tone={tone} style={iv(i)}>
      <Icon name={ic.name} size={16} tone={ic.tone} glow={ic.glow} className="vm-req-icon" />
      <div className="vm-req-text">
        <span className="vm-req-title vl-ellipsis">{noDash(r.title) || 'Untitled'}{r.year ? <span className="vm-res-y"> ({r.year})</span> : null}</span>
        <span className="vm-req-sub">{kindLabel(r.kind)} · {ago(r.at, now)}</span>
      </div>
      {tone !== 'done' && (
        <span className="vm-req-status">
          {r.progress != null && tone === 'active' ? `${Math.round(r.progress)}%` : capSegs(r.status) || 'Unknown'}
        </span>
      )}
    </div>
  )
}

// ---------- screen ----------

const VIEWS = ['dashboard', 'movies', 'shows', 'music', 'requests'] as const
type View = (typeof VIEWS)[number]
const isView = (s: string): s is View => (VIEWS as readonly string[]).includes(s)

export default function Media({ active, sub, setSub }: ScreenProps) {
  const { setCenter } = useShell()
  const view: View = isView(sub) ? sub : 'dashboard'
  const rootRef = useRef<HTMLDivElement>(null)
  const center = useCenter(view)
  // below ~1000 px the strip's left side (hosts + 5h meter) reaches the middle, so a center line would overlap it
  const roomy = useSyncExternalStore(subscribeRoomy, isRoomy, () => true)
  useEffect(() => {
    if (active) setCenter(roomy ? center : null)
  }, [active, center, roomy, setCenter])

  // the library views mount on their first look (they page through the whole library), then stay
  const [seen, setSeen] = useState<ReadonlySet<View>>(() => new Set([view]))
  if (!seen.has(view)) setSeen(new Set(seen).add(view))

  // each view keeps its own vertical scroll: the page scroller is shared, so save on scroll, restore on switch
  const scrolls = useRef<Partial<Record<View, number>>>({})
  const shownView = useRef(view)
  useEffect(() => {
    const page = pageOf(rootRef.current)
    if (!page) return
    const save = () => { scrolls.current[shownView.current] = page.scrollTop }
    page.addEventListener('scroll', save, { passive: true })
    return () => page.removeEventListener('scroll', save)
  }, [])
  useLayoutEffect(() => {
    if (shownView.current === view) return
    shownView.current = view
    const page = pageOf(rootRef.current)
    if (page) page.scrollTop = scrolls.current[view] ?? 0
  }, [view])

  // the page's height, for the A to Z strip and the music detail pane (both fit the visible page)
  useLayoutEffect(() => {
    const root = rootRef.current
    const page = pageOf(root)
    if (!root || !page) return
    const fit = () => root.style.setProperty('--vm-ph', `${page.clientHeight}px`)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(page)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={rootRef} className="vl-screen vm" data-view={view}>
      {VIEWS.map((v) => {
        const on = v === view
        const visible = active && on
        return (
          <div key={v} className="vm-view" data-view={v} data-on={on || undefined} inert={!on || undefined} aria-hidden={!on || undefined}>
            {v === 'dashboard' && <Dashboard setSub={setSub} />}
            {v === 'movies' && seen.has(v) && <Library kind="movie" visible={visible} />}
            {v === 'shows' && seen.has(v) && <Library kind="show" visible={visible} />}
            {v === 'music' && seen.has(v) && <MusicLib visible={visible} />}
            {v === 'requests' && <Requests visible={visible} />}
          </div>
        )
      })}
    </div>
  )
}

const roomyMq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1000px)') : null
const isRoomy = () => roomyMq?.matches ?? true
const subscribeRoomy = (l: () => void) => {
  roomyMq?.addEventListener('change', l)
  return () => roomyMq?.removeEventListener('change', l)
}

/** The strip's center line on wide screens: one short fact, or nothing. */
function useCenter(view: View): string | null {
  const p = usePlayerNow()
  const q = useMediaQueue()
  if (view === 'music') return p.item ? `${p.playing ? 'Playing' : 'Paused'} · ${p.item.title}` : null
  if (view === 'requests' && q.data) {
    const c = countQueue(q.data)
    if (c.stuck) return `${c.stuck} stuck`
    if (c.moving) return `${c.moving} downloading`
    return c.waiting ? `${c.waiting} ${c.waitWord.toLowerCase()}` : null
  }
  return null
}
