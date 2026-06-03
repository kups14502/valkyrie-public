import axios from 'axios'

const configuredApiUrl = import.meta.env.VITE_API_URL

const baseURL = configuredApiUrl
  ? `${configuredApiUrl}/api`
  : '/api'

export const api = axios.create({
  baseURL,
  withCredentials: true,
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status as number | undefined
    const detail = error?.response?.data?.detail as string | undefined
    return Promise.reject({
      ...error,
      isUnauthorized: status === 401,
      isBackendUnavailable: !status || status >= 500,
      detail,
    })
  },
)

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

export type CodexRateLimit = { pct: number; windowMins: number; resetsAt: number }
export type RateLimits = { session5h: CodexRateLimit | null; weekly: CodexRateLimit | null }
export type ClaudeUsageClient = ProviderUsage & {
  id: string
  kind: 'claude'
  label: string
  subscription: string
  byModel: Record<string, UsageBucket>
  session: ClaudeSession | null
  quota: ClaudeQuota | null
}
export type CodexUsageClient = ProviderUsage & {
  id: string
  kind: 'codex'
  label: string
  subscription: string
  rateLimits: RateLimits
}
export type AIClientUsage = ClaudeUsageClient | CodexUsageClient

export type AIUsage = {
  claude: ProviderUsage & {
    byModel: Record<string, UsageBucket>
    session: ClaudeSession | null
    quota: ClaudeQuota | null
  }
  codex: ProviderUsage & {
    rateLimits: RateLimits
  }
  aiClients?: AIClientUsage[]
  dmBot?: ProviderUsage & { byModel: Record<string, UsageBucket> }
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

export type CodeDeckSession = {
  id: string
  title: string
  folder: string
  projectRootId: string
  cwd: string
  profileId: string
  model: string
  pinned: boolean
  status: string
  notes: string
  createdAt: string
  updatedAt: string
  launchCommand: string
}

export type CodeDeckRoot = { id: string; label: string; path: string; folder: string; exists: boolean }
export type CodeDeckProfile = { id: string; label: string; provider: string; defaultModel: string; command: string; env: Record<string, string> }
export type CodeDeckState = {
  sessions: CodeDeckSession[]
  folders: string[]
  projectRoots: CodeDeckRoot[]
  profiles: CodeDeckProfile[]
}

export const fetchCodeDeck = async () => {
  const r = await api.get<CodeDeckState>('/code-deck')
  return r.data
}

export const createCodeDeckSession = async (body: Partial<CodeDeckSession>) => {
  const r = await api.post<{ session: CodeDeckSession }>('/code-deck/sessions', body)
  return r.data.session
}

export const updateCodeDeckSession = async (id: string, body: Partial<CodeDeckSession>) => {
  const r = await api.patch<{ session: CodeDeckSession }>(`/code-deck/sessions/${id}`, body)
  return r.data.session
}

export type CodeDeckMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export const fetchCodeDeckMessages = async (sessionId: string) => {
  const r = await api.get<{ messages: CodeDeckMessage[] }>(`/code-deck/sessions/${sessionId}/messages`)
  return r.data.messages
}

export const sendCodeDeckMessage = async (sessionId: string, content: string) => {
  const r = await api.post<{ user: CodeDeckMessage; assistant: CodeDeckMessage }>(`/code-deck/sessions/${sessionId}/chat`, { content })
  return r.data
}

export const deleteCodeDeckSession = async (id: string) => {
  const r = await api.delete<{ ok: boolean }>(`/code-deck/sessions/${id}`)
  return r.data
}
