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

export type EmailMessage = {
  account: string
  uid: string
  message_id: string
  sender: string
  subject: string
  date: string
  classification: string
  reason: string
  snippet: string
  seen_at: string
}

export type EmailsResponse = {
  messages: EmailMessage[]
  total: number
  accounts: { account: string; count: number }[]
  byClassification: { classification: string; count: number }[]
}

export const fetchEmails = async (params: { account?: string; classification?: string; limit?: number; offset?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.account) q.set('account', params.account)
  if (params.classification) q.set('classification', params.classification)
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.offset != null) q.set('offset', String(params.offset))
  const r = await api.get<EmailsResponse>(`/emails?${q}`)
  return r.data
}

export const fetchEmailStatus = async () => {
  const r = await api.get<{ timer: Record<string, string>; service: Record<string, string>; dbStats: { total: number; lastSeen: string | null } }>('/emails/status')
  return r.data
}

export type GigStatus = 'active' | 'completed' | 'failed' | 'on_hold'
export type GigCategory = 'main' | 'side' | 'daily' | 'work'

export type GigLink = {
  id: number
  gigId: string
  kind: 'email' | 'ticket' | 'url'
  ref: string
  label: string
  createdAt: string
}

export type GigRow = {
  id: string
  parentId: string | null
  title: string
  detail: string
  category: GigCategory
  section: string
  status: GigStatus
  tracked: boolean
  sort: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type Gig = GigRow & {
  subgigs: GigRow[]
  links: GigLink[]
  progress: { done: number; total: number }
}

export const fetchGigs = async () => {
  const r = await api.get<{ gigs: Gig[] } | { error?: string; detail?: string }>('/gigs')
  if (!r.data || typeof r.data !== 'object' || 'error' in r.data) throw new Error((r.data as { detail?: string }).detail || 'Invalid gigs response')
  return (r.data as { gigs: Gig[] }).gigs
}

export type GigStats = {
  xp: number
  level: number
  levelXp: number
  nextLevelXp: number
  completed: number
  breakdown: { work: number; personal: number; objectives: number }
}

export const fetchGigStats = async () => {
  const r = await api.get<GigStats>('/gigs/stats')
  return r.data
}

export const createGig = async (input: { title: string; detail?: string; category?: GigCategory; section?: string; parentId?: string; tracked?: boolean }) => {
  const r = await api.post<{ gig: GigRow; error?: string; detail?: string }>('/gigs', input)
  if (!r.data.gig) throw new Error(r.data.detail || r.data.error || 'Failed to create gig')
  return r.data.gig
}

export const updateGig = async (id: string, patch: { title?: string; detail?: string; category?: GigCategory; section?: string; status?: GigStatus; tracked?: boolean; sort?: number }) => {
  const r = await api.patch<{ gig: GigRow; error?: string; detail?: string }>(`/gigs/${id}`, patch)
  if (!r.data.gig) throw new Error(r.data.detail || r.data.error || 'Failed to update gig')
  return r.data.gig
}

export const deleteGig = async (id: string) => {
  const r = await api.delete<{ ok?: boolean; error?: string; detail?: string }>(`/gigs/${id}`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to delete gig')
  return r.data
}

export const addGigLink = async (gigId: string, input: { kind: 'email' | 'ticket' | 'url'; ref: string; label?: string }) => {
  const r = await api.post<{ link: GigLink; error?: string; detail?: string }>(`/gigs/${gigId}/links`, input)
  if (!r.data.link) throw new Error(r.data.detail || r.data.error || 'Failed to add link')
  return r.data.link
}

export const deleteGigLink = async (gigId: string, linkId: number) => {
  const r = await api.delete<{ ok?: boolean; error?: string; detail?: string }>(`/gigs/${gigId}/links/${linkId}`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to delete link')
  return r.data
}

export type IntakeTicketMatch = { id: number; ticketNumber: string; title: string; score: number }

export type IntakeItem = {
  account: string
  uid: string
  isWork: boolean
  summary: string
  ticketMatches: IntakeTicketMatch[]
  gigMatch: { id: string; title: string } | null
  suggestedGigTitle: string | null
  status: 'pending' | 'linked' | 'dismissed'
  linkedKind: string | null
  linkedRef: string | null
  linkedBy: 'auto' | 'user' | null
  processedAt: string
  sender: string
  subject: string
  date: string
  snippet: string
  classification: string
}

export type IntakeResponse = {
  items: IntakeItem[]
  counts: { pending: number; linked: number; dismissed: number }
}

export const fetchEmailIntake = async (status: 'pending' | 'linked' | 'dismissed' | 'all' = 'pending') => {
  const r = await api.get<IntakeResponse>(`/emails/intake?status=${status}`)
  return r.data
}

export const linkIntakeItem = async (
  account: string,
  uid: string,
  input: { kind: 'ticket' | 'gig' | 'new-gig'; ref?: string; title?: string },
) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>(
    `/emails/intake/${encodeURIComponent(account)}/${encodeURIComponent(uid)}/link`, input)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to link intake item')
  return r.data
}

export type EmailCorrection = 'spam' | 'spam_once' | 'not_important' | 'important' | 'flip_side'

export const sendEmailFeedback = async (account: string, uid: string, correction: EmailCorrection) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>('/emails/feedback', { account, uid, correction })
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to record feedback')
  return r.data
}

// Skip: drop an email off the action inbox without training the classifier.
export const skipEmailSignal = async (account: string, uid: string) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>(
    `/email/signals/${encodeURIComponent(account)}/${encodeURIComponent(uid)}/ack`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to skip email')
  return r.data
}

export const dismissIntakeItem = async (account: string, uid: string) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>(
    `/emails/intake/${encodeURIComponent(account)}/${encodeURIComponent(uid)}/dismiss`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to dismiss intake item')
  return r.data
}

// Create a new Autotask ticket from a work email and link the intake item.
export const createTicketFromIntake = async (account: string, uid: string) => {
  const r = await api.post<{ ok?: boolean; ticket?: { id: number; ref: string }; error?: string; detail?: string }>(
    `/emails/intake/${encodeURIComponent(account)}/${encodeURIComponent(uid)}/create-ticket`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to create ticket')
  return r.data.ticket!
}

// Undo a link (auto or manual): the item returns to the pending queue.
export const unlinkIntakeItem = async (account: string, uid: string) => {
  const r = await api.post<{ ok?: boolean; error?: string; detail?: string }>(
    `/emails/intake/${encodeURIComponent(account)}/${encodeURIComponent(uid)}/unlink`)
  if (!r.data.ok) throw new Error(r.data.detail || r.data.error || 'Failed to unlink intake item')
  return r.data
}

export type EmailSignalItem = {
  account: string; uid: string; sender: string; subject: string
  date: string; classification: 'important' | 'routine'; reason: string
  snippet: string; seen_at: string
}

export type EmailSignals = {
  timer: { active: string | null; nextRun: string | null; lastTrigger: string | null }
  service: { active: string | null; sub: string | null; result: string | null; lastStart: string | null }
  accounts: { id: string; address: string; provider: string; enabled: boolean }[]
  counts: { important24h: number; important7d: number; routine24h: number; routine7d: number; ignoredTotal: number; total: number }
  items: EmailSignalItem[]
  drafts: { filename: string; mtime: string; preview: string }[]
  recentErrors: string[]
}

export const fetchEmailSignals = async () => {
  const r = await api.get<EmailSignals>('/email/signals')
  return r.data
}
