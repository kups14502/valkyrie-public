import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
})

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
