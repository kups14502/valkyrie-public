import axios from 'axios'

const configuredApiUrl = import.meta.env.VITE_API_URL

const inferredApiOrigin = (() => {
  if (typeof window === 'undefined') return undefined
  const { protocol, hostname } = window.location
  if (hostname === 'master-control.brendonkupsch.com') {
    return `${protocol}//api.brendonkupsch.com`
  }
  return undefined
})()

const baseURL = configuredApiUrl
  ? `${configuredApiUrl}/api`
  : inferredApiOrigin
    ? `${inferredApiOrigin}/api`
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
}

export type AIUsage = {
  totalTokensInput: number
  totalTokensOutput: number
  totalCostUSD: number
  byModel: Record<string, { input: number; output: number; costUSD: number }>
}

export type ProjectStatus = {
  name: string
  path: string
  status: 'active' | 'paused' | 'idle'
  lastTouched: string
}

export const fetchSystem = () => api.get<SystemStatus>('/system').then((r) => r.data)
export const fetchSessions = () => api.get<SessionInfo[]>('/sessions').then((r) => r.data)
export const fetchAIUsage = () => api.get<AIUsage>('/ai-usage').then((r) => r.data)
export const fetchProjects = () => api.get<ProjectStatus[]>('/projects').then((r) => r.data)
