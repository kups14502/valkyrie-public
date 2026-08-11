import axios from 'axios'
import { getToken, clearToken, isTauri } from './auth'

const configuredApiUrl = import.meta.env.VITE_API_URL

// When the app is served from odin over the tailnet (tailscale IP, MagicDNS
// name, or *.ts.net via `tailscale serve`), the same host serves the API — use
// it same-origin so the backend can trust the request by its tailnet socket
// address. The baked-in VITE_API_URL (Cloudflare) is only for the public web
// deployment and the desktop app.
const isTailnetHost = (h: string) =>
  h === 'odin' || h.endsWith('.ts.net')
  || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)

export const onTailnet = typeof window !== 'undefined' && isTailnetHost(window.location.hostname)

const baseURL = configuredApiUrl && !onTailnet
  ? `${configuredApiUrl}/api`
  : '/api'

export const api = axios.create({
  baseURL,
  withCredentials: true,
})

// Attach the self-hosted app token (if present) to every request.
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status as number | undefined
    const detail = error?.response?.data?.detail as string | undefined
    // A 401 means our token is missing/expired/invalid — drop it so the auth
    // gate re-prompts. The login/status/setup calls are exempt (they 401/409
    // legitimately during normal auth flows).
    const url = String(error?.config?.url || '')
    if (status === 401 && !url.includes('/auth/')) clearToken()
    return Promise.reject({
      ...error,
      isUnauthorized: status === 401,
      isBackendUnavailable: !status || status >= 500,
      detail,
    })
  },
)

export type AuthStatus = { configured: boolean; strict: boolean; trusted?: boolean }
export const fetchAuthStatus = async () => (await api.get<AuthStatus>('/auth/status')).data
export const setupAuth = async (password: string) =>
  (await api.post<{ ok: boolean; otpauthUri: string; secret: string }>('/auth/setup', { password })).data
export const loginAuth = async (password: string, totp: string) =>
  (await api.post<{ token: string; expiresAt: number }>('/auth/login', { password, totp })).data

export type SystemStatus = {
  cpu: { cores: number; loadAvg: [number, number, number]; usage: number }
  memory: { total: number; used: number; free: number; percent: number }
  disk: { total: number; used: number; percent: number }
  uptime: number
  hostname: string
}

export type SessionInfo = {
  id: string
  model: string
  pid: number
  startedAt: string
  cpu: number
  memory: number
  project: string | null
  cwd: string | null
  gitBranch: string | null
  lastActivity: number | null
}

export type UsageBucket = { tokens: number; costUSD: number; messages: number }
export type ProviderUsage = { today: UsageBucket; last7d: UsageBucket; last30d: UsageBucket }

export type ClaudeSession = {
  isActive: boolean
  startTime: string
  endTime: string
  totalTokens: number
  costUSD: number
  models: string[]
  projection: { totalTokens: number; totalCost: number; remainingMinutes: number } | null
  burnRate: { tokensPerMinute: number; costPerHour: number } | null
}

export type ClaudeQuota = {
  sessionPct: number
  weeklyPct: number
  sessionResetsAt: string | null
  weeklyResetsAt: string | null
  status?: string | null
}

export type ClaudeUsageClient = ProviderUsage & {
  id: string
  kind: 'claude'
  label: string
  subscription: string
  byModel: Record<string, UsageBucket>
  session: ClaudeSession | null
  quota: ClaudeQuota | null
  // set when the account's stored sign-in is dead, so quota can't be read at all
  authError?: string | null
}
export type AIClientUsage = ClaudeUsageClient

export type AIUsage = {
  claude: ProviderUsage & {
    byModel: Record<string, UsageBucket>
    session: ClaudeSession | null
    quota: ClaudeQuota | null
  }
  aiClients?: AIClientUsage[]
  updatedAt: string
}

export type ProjectStatus = {
  name: string
  path: string
  status: 'active' | 'paused' | 'idle'
  lastTouched: string
  lastCommit: { subject: string; sha: string; relative: string } | null
  dirty: boolean
  dirtyCount: number
  commitsToday: number
}

// The v1 ~/trading bot's types (TradingStatus and friends) lived here and are
// gone as of 2026-08-04: the only reader was the dashboard's stale "Trading"
// card, and the /api/trading route it fed from stopped being written 2026-07-31.
// The backend route still exists but now has no frontend client.

// v2 trade bot (~/trade-bot): passthrough of the status.json its status.py
// generator writes, plus the backend's `stale` flag.
export type TradeBotArm = { last_run: string | null; ok: boolean; detail: string }

export type TradeBotDoc = {
  generated_at: string
  market: { is_open: boolean; reason: string }
  up: boolean
  up_detail: string
  // The paper arm was retired 2026-08-04, so status.py no longer emits
  // arms.paper, portfolio.paper_*, or experiment.paper_trips.
  arms: {
    live_scan: TradeBotArm
    guard: TradeBotArm
    v1_legacy?: { scheduled: boolean; note: string }
  }
  // Every judge call the bot makes is priced into logs/cost_v2.jsonl, so this
  // is recorded spend end to end: nothing here is modelled from token counts.
  spend: { total_usd: number; today_usd: number; calls_total: number; calls_today: number; since: string | null }
  portfolio: {
    live_equity: number | null
    live_cash: number | null
    // "sample" = a real broker read; "day_open" = the 09:40 fallback, which is
    // NOT a live figure and must be labelled as stale wherever it is shown.
    live_equity_source?: string | null
    live_equity_age_min?: number | null
  }
  history?: {
    window_days: number
    points: { ts: string; total: number }[]
    first_total: number | null
    last_total: number | null
    // change_usd/pct are deposit-adjusted TRADING P&L. net_flows_usd is
    // transfers in/out and is never performance.
    change_usd: number | null
    change_pct: number | null
    net_flows_usd: number | null
    flows_detected: number | null
  }
  // live_trips: distinct closing sell orders since preregistered, counted by
  // status.py from logs/broker_snapshot.json. null = not knowable yet (no
  // snapshot or no pre-registration), which is not the same as zero.
  experiment: { target_trips: number; live_trips: number | null; preregistered: string | null; rules_ok: boolean | null }
}

export type TradeBotStatus = TradeBotDoc & { stale: boolean }

// One decision the judge made, from scan_v2.log.
// gate: null = nothing proposed, "executed" = orders placed, otherwise why not.
export type TradeBotDecision = {
  ts: string
  arm: 'live'
  regime: string | null
  confidence: number | null
  trade_needed: boolean | null
  trades_proposed: number | null
  summary: string | null
  gate: string | null
  cost_usd: number | null
}

export type TradeBotPosition = {
  symbol: string
  quantity: number | null
  shares_available_for_sells: number | null
  average_buy_price: number | null
}

export type TradeBotFill = {
  ts: string
  symbol: string
  side: string
  quantity: number | null
  price: number | null
  state: string | null
  placed_agent: string | null
  order_id: string | null
}

// broker_snapshot.json, exported read-only by equity_sampler.py. `realized` is
// computed by the same FIFO/L2 engine stats.py uses, so the two cannot disagree.
export type TradeBotSnapshot = {
  generated_at: string | null
  positions: TradeBotPosition[]
  fills: TradeBotFill[]
  realized: { pnl_usd: number | null; round_trips: number | null }
}

export type TradeBotCaps = {
  min_confidence_to_trade: number | null
  max_position_pct: number | null
  max_single_trade_pct: number | null
  max_trades_per_day: number | null
  daily_loss_limit_pct: number | null
  stop_loss_pct: number | null
  gain_trim_pct: number | null
  gain_trim_partial_pct: number | null
  model: string | null
  watchlist: string[]
  screener: {
    enabled: boolean
    shortlist_size: number | null
    min_abs_change_pct: number | null
    min_market_cap: number | null
    min_relative_volume: number | null
  } | null
}

export type TradeBotPage = {
  generated_at: string
  status: TradeBotDoc
  stale: boolean
  broker: TradeBotSnapshot | null
  broker_error: string | null
  decisions: TradeBotDecision[]
  /** Log verdicts with no recorded judge call behind them (selftest fixtures),
   *  withheld from `decisions`. Reported so the feed is never silently filtered. */
  decisions_unverified?: number
  config: TradeBotCaps
}

export type LightState = {
  entity_id: string
  name: string
  on: boolean
  unavailable: boolean
  brightness: number | null
  rgb_color: [number, number, number] | null
  color_temp_kelvin: number | null
  color_mode: string | null
  supported_color_modes: string[]
  min_kelvin: number | null
  max_kelvin: number | null
}

export type LightUpdate = {
  entity_id: string | string[]
  state: 'on' | 'off'
  brightness?: number
  rgb_color?: [number, number, number]
  color_temp_kelvin?: number
}

export type ServiceContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string[]
  project: string | null
  composeFile?: string | null
}

export type ServiceUnit = {
  name: string
  load: string
  active: string
  sub: string
  description: string
  scope?: 'user' | 'system'
}

export type ServiceTimer = {
  name: string
  service: string
  next: string
  left: string
  last: string
  passed: string
}

export type ListeningPort = {
  protocol: string
  local: string
  port: number | null
  process: string | null
  pid: number | null
  exposure: 'public' | 'tailscale' | 'local' | 'docker' | 'lan' | 'unknown'
}

export type ComposeFile = {
  path: string
  project: string
}

export type LauncherEntry = {
  id: string
  name: string
  url: string
  category: 'media' | 'home' | 'tools' | 'self' | 'ai' | 'trading' | 'storage'
  owner?: string
  health: 'alive' | 'down' | 'unknown'
  latencyMs: number | null
}

export type ServicesStatus = {
  containers: ServiceContainer[]
  services: ServiceUnit[]
  systemServices?: ServiceUnit[]
  timers?: ServiceTimer[]
  ports?: ListeningPort[]
  composeFiles?: ComposeFile[]
}

export type Activity = {
  id: string
  type: 'commit' | 'trade' | 'backup'
  timestamp: number
  title: string
  subtitle: string | null
  tone: 'ok' | 'watch' | 'alert' | 'dim'
}

export type SystemHistory = {
  samples: { t: number; cpu: number; mem: number; disk: number }[]
  intervalMs: number
  capacity: number
}

export type VaultStatus = {
  container: {
    running: boolean
    healthy: boolean | null
    status: string | null
    startedAt: string | null
  }
  items: {
    total: number
    logins: number
    notes: number
    cards: number
    identities: number
    sshKeys: number
    trash: number
    folders: number
    attachments: number
    sends: number
    users: number
  } | null
  backups: {
    lastAt: string | null
    lastSize: number | null
    count: number
    totalSize: number
    stale: boolean
  }
  updatedAt: string
}

export const fetchSystem = async () => {
  const r = await api.get<SystemStatus | { error?: string; detail?: string }>('/system')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid system response')
  return r.data as SystemStatus
}

export const fetchSessions = async () => {
  const r = await api.get<SessionInfo[] | { error?: string; detail?: string }>('/sessions')
  if (!Array.isArray(r.data)) throw new Error((r.data as { detail?: string }).detail || 'Invalid sessions response')
  return r.data as SessionInfo[]
}

export const fetchAIUsage = async () => {
  const r = await api.get<AIUsage | { error?: string; detail?: string }>('/ai-usage')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid AI usage response')
  return r.data as AIUsage
}

export const fetchTradeBotStatus = async () => {
  const r = await api.get<TradeBotStatus | { error?: string; detail?: string }>('/tradebot/status')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid trade bot response')
  return r.data as TradeBotStatus
}

export const fetchTradeBotPage = async () => {
  const r = await api.get<TradeBotPage | { error?: string; detail?: string }>('/tradebot/page')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data || !('status' in r.data)) {
    throw new Error((r.data as { detail?: string }).detail || 'Invalid trade bot page response')
  }
  return r.data as TradeBotPage
}

export const fetchLights = async () => {
  const r = await api.get<LightState[] | { error?: string; detail?: string }>('/lights')
  if (!Array.isArray(r.data)) throw new Error((r.data as { detail?: string }).detail || 'Invalid lights response')
  return r.data as LightState[]
}

export const setLight = async (update: LightUpdate) => {
  const r = await api.post<{ ok: boolean; error?: string; detail?: string }>('/lights/turn', update)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to update light')
  return r.data
}

export const fetchLauncher = async () => {
  const r = await api.get<LauncherEntry[] | { error?: string; detail?: string }>('/launcher')
  if (!Array.isArray(r.data)) throw new Error((r.data as { detail?: string }).detail || 'Invalid launcher response')
  return r.data as LauncherEntry[]
}

export const fetchServices = async () => {
  const r = await api.get<ServicesStatus | { error?: string; detail?: string }>('/services')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid services response')
  return r.data as ServicesStatus
}

export const restartService = async (kind: 'container' | 'service', name: string) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>('/services/restart', { kind, name })
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'restart failed')
  return r.data
}

export const fetchActivity = async () => {
  const r = await api.get<Activity[] | { error?: string; detail?: string }>('/activity')
  if (!Array.isArray(r.data)) throw new Error((r.data as { detail?: string }).detail || 'Invalid activity response')
  return r.data as Activity[]
}

export const fetchSystemHistory = async () => {
  const r = await api.get<SystemHistory | { error?: string; detail?: string }>('/system/history')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid history response')
  return r.data as SystemHistory
}

export const fetchVault = async () => {
  const r = await api.get<VaultStatus | { error?: string; detail?: string }>('/vault')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid vault response')
  return r.data as VaultStatus
}

export const fetchProjects = async () => {
  const r = await api.get<ProjectStatus[] | { error?: string; detail?: string }>('/projects')
  if (!Array.isArray(r.data)) throw new Error((r.data as { detail?: string }).detail || 'Invalid projects response')
  return r.data as ProjectStatus[]
}

// ---------- slop factory ----------
// Mirrors backend/src/routes/slopfactory.ts, which mirrors `run.py stats --json`
// on Odin. The envelope is always HTTP 200: a failing CLI is a fact about the
// pipeline, not a broken dashboard, so the tab draws the diagnostic itself.
export type SlopStats = {
  generated_at: string
  footage: {
    episodes_ingested: number
    episodes_awaiting_clip: number
    source_seconds: number
    clips_total: number
    clips_awaiting_render: number
  }
  shorts: {
    total: number
    pending: number
    approved: number
    rejected: number
    posted: number
    seconds_total: number
  }
  gameplay: {
    files: { name: string; seconds: number }[]
    seconds_available: number
    seconds_consumed: number
    seconds_remaining: number
    shorts_supported_remaining: number
    seconds_needed_for_backlog: number
    short_on_gameplay: boolean
  }
  pipeline: {
    last_render_at: string | null
    failing_sources: number
    failing_clips: number
    budget_blocked: boolean
  }
}

export type SlopStatsEnvelope = {
  ok: boolean
  generated_at: string
  stats: SlopStats | null
  stale: boolean
  error: {
    kind: string
    message: string
    exit_code: number | null
    signal: string | null
    stderr_tail: string | null
  } | null
}

export const fetchSlopFactoryStats = async () => {
  const r = await api.get<SlopStatsEnvelope>('/slopfactory/stats')
  return r.data
}

// ---------- Plex ----------

export type PlexSection = { key: string; title: string; type: 'movie' | 'show'; count: number }

export type PlexItem = {
  ratingKey: string
  type: string
  title: string
  year: number | null
  summary: string
  thumb: string | null
  art: string | null
  rating: number | null
  contentRating: string | null
  duration: number | null
  addedAt: number | null
  leafCount: number | null
  childCount: number | null
  // Path on watch.plex.tv, when Plex has a catalog match for this item.
  watchPath: string | null
}

export type PlexLibraryPage = { total: number; offset: number; items: PlexItem[] }

export type MediaSearchResult = {
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

export type MediaRequestEntry = {
  at: string
  kind: 'movie' | 'show' | 'message'
  title?: string
  year?: number
  message?: string
  status?: string
}

export type MediaDownload = {
  kind: 'movie' | 'show'
  title: string
  status: string
  progress: number
  timeleft: string | null
}

// Poster URLs need auth, but an <img> tag can't set an Authorization header —
// so a short-lived IMAGE-SCOPED token rides the URL instead (never the 30-day
// app token: URLs end up in proxy logs and browser caches). Tailnet clients
// don't need it at all (trusted by socket address).
let imgToken: { token: string; expiresAt: number } | null = null

export const fetchImgToken = async () => {
  const r = await api.get<{ token: string; expiresAt: number }>('/plex/img-token')
  imgToken = r.data
  return r.data
}

export const plexImg = (path: string, w = 300): string => {
  const params = new URLSearchParams({ path, w: String(w) })
  if (imgToken && imgToken.expiresAt > Date.now() + 60_000) params.set('token', imgToken.token)
  return `${baseURL}/plex/img?${params.toString()}`
}

export type PlexServer = { machineIdentifier: string; friendlyName: string; version: string }

export const fetchPlexServer = async () => (await api.get<PlexServer>('/plex/server')).data

// Deep links into Plex itself. Valkyrie can't AirPlay (a page can only cast a
// <video> it owns), so "watch on the TV" means handing off to a real Plex
// client, which offers AirPlay from its own player.
//
// app.plex.tv serves no apple-app-site-association (verified: 404), so an https
// link can never open the native iOS/iPadOS app — it only ever lands in Plex
// Web. The native app registers the plex:// scheme instead, so Apple touch
// devices get that and everything else gets the web app. Same split, and the
// same URL shapes, that Overseerr uses.
const metadataKey = (ratingKey: string) => `%2Flibrary%2Fmetadata%2F${ratingKey}`

// The link that actually opens a specific title in the Plex app on iOS/iPadOS.
//
// watch.plex.tv publishes an apple-app-site-association listing both Plex app
// IDs (including the rewritten tv.plex.rn.app) with /movie/* and /show/*
// components, so iOS hands these to the app. Verified against the live AASA.
// Two things this is NOT:
//   - app.plex.tv, which publishes no AASA at all (404) and can only ever land
//     in Plex Web, and whose item identity hides behind a # fragment that
//     universal-link matching never evaluates.
//   - plex://preplay/?metadataKey=…, which the rewritten app opens on its Home
//     screen while ignoring the item entirely (observed on a real iPad).
// It must be followed by a genuine link tap, not a scripted location assignment,
// or iOS treats it as a plain navigation and universal-link matching is skipped.
// So callers render a bare <a href> for this and do NOT route it through
// openInApp(). It costs one extra tap to start playback, since it lands on the
// title's details screen rather than a preplay screen.
export const plexWatchLink = (watchPath: string): string => `https://watch.plex.tv${watchPath}`

// The native app (iOS, Android, desktop) registers the plex:// scheme.
export const plexAppItemLink = (machineIdentifier: string, ratingKey: string): string =>
  `plex://preplay/?metadataKey=${metadataKey(ratingKey)}&server=${machineIdentifier}`

export const plexAppHomeLink = (): string => 'plex://'

// Plex Web. A bare #!/server/<id> is not a route, so "home" is the app root.
export const plexWebItemLink = (machineIdentifier: string, ratingKey: string): string =>
  `https://app.plex.tv/desktop#!/server/${machineIdentifier}/details?key=${metadataKey(ratingKey)}`

export const plexWebHomeLink = (): string => 'https://app.plex.tv/desktop'

// Always try the Plex app, and only fall back to the web player if nothing took
// over the page.
//
// Deciding by user agent (what this used to do) is wrong in both directions: a
// device we didn't recognize got the website even with Plex installed, and a
// phone without Plex got a dead tap. Firing the scheme and watching for the page
// to be backgrounded works everywhere, because the app taking focus is the
// signal, not a UA string.
// True when the click should be left to the browser: the desktop app (where
// navigating the top-level webview to an external URL would replace Valkyrie's
// own UI with a web page and strand the window), or a modified/middle click the
// user meant to open in a new tab.
export function shouldDeferAppClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }): boolean {
  return isTauri() || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0
}

// Spotify: the app registers spotify://, and open.spotify.com is the web player.
export const spotifyAppLink = (): string => 'spotify://'
export const spotifyWebLink = (): string => 'https://open.spotify.com'

const FALLBACK_DELAY_MS = 1200

export function openInApp(appUrl: string, webUrl: string): void {
  let handedOff = false
  const mark = () => { handedOff = true }
  document.addEventListener('visibilitychange', mark, { once: true })
  window.addEventListener('pagehide', mark, { once: true })
  window.addEventListener('blur', mark, { once: true })

  const startedAt = Date.now()
  window.location.href = appUrl

  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', mark)
    window.removeEventListener('pagehide', mark)
    window.removeEventListener('blur', mark)
    // A timer that fires much later than scheduled means the page was frozen
    // while another app had focus, so the hand-off DID work and this is running
    // on the way back. Navigating now would dump the user into a stray Plex Web
    // page (and from a home-screen app, an external URL spawns Safari, which is
    // the "browser open to plex when I came back" seen on the iPad).
    const firedLate = Date.now() - startedAt > FALLBACK_DELAY_MS + 600
    if (handedOff || firedLate || document.hidden) return
    window.location.href = webUrl
  }, FALLBACK_DELAY_MS)
}

export const fetchPlexSections = async () => (await api.get<PlexSection[]>('/plex/sections')).data
export const fetchPlexLibrary = async (section: string, offset: number, opts: { search?: string; sort?: string } = {}) => {
  const r = await api.get<PlexLibraryPage>('/plex/library', {
    params: { section, offset, limit: 60, search: opts.search || undefined, sort: opts.sort || undefined },
  })
  return r.data
}
export const fetchPlexRecent = async (limit = 24) =>
  (await api.get<{ items: PlexItem[] }>('/plex/recent', { params: { limit } })).data.items
export const searchMediaRequests = async (q: string) =>
  (await api.get<{ results: MediaSearchResult[] }>('/plex/request/search', { params: { q } })).data.results
export const addMediaRequest = async (r: MediaSearchResult) =>
  (await api.post<{ ok: boolean; detail: string }>('/plex/request/add', {
    kind: r.kind,
    tmdbId: r.tmdbId ?? undefined,
    tvdbId: r.tvdbId ?? undefined,
  })).data
export const sendMediaMessage = async (message: string) =>
  (await api.post<{ ok: boolean; detail: string }>('/plex/request/message', { message })).data
export const fetchMediaRequests = async () =>
  (await api.get<{ requests: MediaRequestEntry[] }>('/plex/requests')).data.requests
export const fetchMediaDownloads = async () =>
  (await api.get<{ downloads: MediaDownload[] }>('/plex/downloads')).data.downloads
