import { api } from './api'

// Valkyrie Messages (backend/src/routes/msg.ts): Brendon and his work agents.
// Agents post, propose and answer on their own; the UI reads, posts as
// Brendon, decides proposals and runs the agents' switches.

export type AgentStatus = 'idle' | 'queued' | 'working' | 'resting' | 'error'

export type MsgAgent = {
  id: string; name: string; role: string; kind: 'triage' | 'project' | 'shopping'; area: string
  franchise: string | null; projectId: string | null; channelId: string; model: string
  enabled: boolean; status: AgentStatus; statusNote: string; lastRunAt: string | null
}

export type MsgChannel = {
  id: string; name: string; kind: 'home' | 'team' | 'dm'; area: string; topic: string; agentIds: string[]; sortOrder: number
  lastMessageAt: string | null; last: { author: string; text: string } | null; unread: number; notify: number
}

export type Ref =
  | { type: 'ticket'; franchise: string; id: number; number: string; title?: string; url?: string }
  | { type: 'mail'; n: number; subject?: string; from?: string; url?: string }
  | { type: 'link'; url: string; label?: string }
  | { type: 'task'; text: string; projectId?: string }
  | { type: 'project'; id: string; name?: string }

export type ProposalStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined'

export type Proposal = {
  id: number; kind: 'mail_reply' | 'ticket_note' | 'ticket_update' | 'ticket_create'; title: string
  payload: Record<string, unknown>; status: ProposalStatus; result: string; decidedAt: string | null
}

export type Msg = {
  id: number; channelId: string; author: string; text: string; refs: Ref[]; mentions: string[]; notify: boolean
  hop: number; proposalId: number | null; createdAt: string; proposal: Proposal | null
}

export type FeedStatus = {
  tickets: Record<string, { at: string | null; error: string | null; open: number }>
  mail: { lastAt: string | null; lastCount: number }
  teams: { lastAt: string | null }
}

export type Overview = { seq: number; paused: boolean; channels: MsgChannel[]; agents: MsgAgent[]; pending: number; feeds: FeedStatus | null }

export type TrackerCounts = { open: number; mine: number; needsBrendon: number }

export type ChannelPage = { channel: MsgChannel; messages: Msg[]; agent: MsgAgent | null; tracker: TrackerCounts | null }

export type Run = {
  id: string; trigger: string; status: 'running' | 'done' | 'failed'; startedAt: string; endedAt: string | null
  summary: string; error: string | null; costUsd: number | null; turns: number | null; durationMs: number | null
}

export type AgentDetail = { agent: MsgAgent & { notebook: string }; runs: Run[]; tracker: TrackerCounts | null }

export type TrackedTicket = {
  franchise: string; id: number; number: string; title: string; company: string; status: string; priority: string; queue: string
  assignee: string | null; mine: boolean; lastActivity: string | null; due: string | null; url: string
  summary: string; next: string; needsBrendon: boolean; waitingOn: string
}

export const fetchOverview = async (): Promise<Overview> => (await api.get<Overview>('/msg/overview')).data

export const fetchMsgCount = async (): Promise<{ unread: number; notify: number; pending: number }> =>
  (await api.get('/msg/count')).data

export const fetchChannel = async (id: string): Promise<ChannelPage> =>
  (await api.get<ChannelPage>(`/msg/channels/${encodeURIComponent(id)}`, { params: { limit: 120 } })).data

/** Resolves when anything in Messages changed after `since` (or after 25 s). */
export const waitMsgChange = async (since: number, signal: AbortSignal): Promise<number> =>
  (await api.get<{ seq: number }>('/msg/changes', { params: { since }, signal, timeout: 40_000 })).data.seq

export const postMessage = async (channelId: string, text: string) =>
  (await api.post<{ ok: boolean; message: Msg; woke: string[] }>(`/msg/channels/${encodeURIComponent(channelId)}/messages`, { text })).data

export const markRead = async (channelId: string, upTo?: number) =>
  (await api.post(`/msg/channels/${encodeURIComponent(channelId)}/read`, upTo ? { upTo } : {})).data

export const approveProposal = async (id: number, body: { how?: 'send' | 'draft'; body?: string; cc?: string[] } = {}) =>
  (await api.post<{ ok: boolean; proposal: Proposal }>(`/msg/proposals/${id}/approve`, body)).data

export const declineProposal = async (id: number, reason: string) =>
  (await api.post<{ ok: boolean; proposal: Proposal }>(`/msg/proposals/${id}/decline`, { reason })).data

export const fetchAgent = async (id: string): Promise<AgentDetail> => (await api.get<AgentDetail>(`/msg/agents/${encodeURIComponent(id)}`)).data

export const patchAgent = async (id: string, patch: { enabled?: boolean; model?: string }) =>
  (await api.patch<{ ok: boolean; agent: MsgAgent }>(`/msg/agents/${encodeURIComponent(id)}`, patch)).data

export const checkAgent = async (id: string) => (await api.post(`/msg/agents/${encodeURIComponent(id)}/check`, {})).data

export const setAgentsPaused = async (paused: boolean) => (await api.put<{ ok: boolean; paused: boolean }>('/msg/paused', { paused })).data

export const fetchTickets = async (franchise: string): Promise<{ tickets: TrackedTicket[]; counts: TrackerCounts }> =>
  (await api.get(`/msg/tickets/${encodeURIComponent(franchise)}`)).data
