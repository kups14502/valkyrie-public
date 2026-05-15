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
}

export type CodexRateLimit = { pct: number; windowMins: number; resetsAt: number }

export type AIUsage = {
  claude: ProviderUsage & {
    byModel: Record<string, UsageBucket>
    session: ClaudeSession | null
    quota: ClaudeQuota | null
  }
  codex: {
    rateLimits: { session5h: CodexRateLimit | null; weekly: CodexRateLimit | null }
  }
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
