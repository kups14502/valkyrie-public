import axios from 'axios'
import { getToken, clearToken } from './auth'

const configuredApiUrl = import.meta.env.VITE_API_URL

const baseURL = configuredApiUrl
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

export type AuthStatus = { configured: boolean; strict: boolean }
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

export type TradingPosition = {
  symbol: string
  quantity: number
  avgBuyPrice: number
  currentPrice: number
  pnlPct: number
  locked: boolean
}

export type TradingSignal = {
  symbol: string
  direction: string
  conviction: string
  reasoning: string
  suggestedInstrument: string | null
  timeHorizon: string | null
}

export type ExecutedTrade = {
  symbol: string
  action: string
  assetType: string
  status: string
  timestamp: string
}

export type PlannedTrade = {
  action: string
  assetType: string
  symbol: string
  quantity: number | null
  dollarAmount: number | null
  optionType: string | null
  strikePrice: number | null
  expirationDate: string | null
  notes: string | null
}

export type TradingStatus = {
  lastUpdated: string | null
  marketRegime: string | null
  marketSummary: string | null
  signals: TradingSignal[]
  portfolio: {
    equity: number
    buyingPower: number
    stockPositions: TradingPosition[]
    cryptoPositions: TradingPosition[]
    optionsPositions: TradingPosition[]
  } | null
  latestRun: {
    timestamp: string
    sonnetSummary: string | null
    plan: { reasoning: string; riskAssessment: string; trades: PlannedTrade[] } | null
  } | null
  runsToday: number
  executedToday: ExecutedTrade[]
  executedRecent: ExecutedTrade[]
  equityHistory: { date: string; equity: number }[]
  realized: {
    totalUSD: number
    closedTrades: number
    bySymbol: Record<string, { realizedUSD: number; trades: number }>
  }
}

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
}

export type TradeBotPage = {
  generated_at: string
  status: TradeBotDoc
  stale: boolean
  broker: TradeBotSnapshot | null
  broker_error: string | null
  decisions: TradeBotDecision[]
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

export const fetchTrading = async () => {
  const r = await api.get<TradingStatus | { error?: string; detail?: string }>('/trading')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid trading response')
  return r.data as TradingStatus
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
