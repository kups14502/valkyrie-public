import { api } from './api'

// The Today page's own endpoints (backend/src/routes/today.ts): the Capture
// line, filed by Claude in the background, and the morning brief.

export type CaptureStatus = 'filing' | 'filed' | 'kept' | 'undone'

export type Capture = {
  id: string
  text: string
  status: CaptureStatus
  kind: 'task' | 'reminder' | 'event' | 'note' | null
  /** where it went, e.g. "Task · Project one · due Fri, Oct 30" */
  summary: string
  url: string | null
  undoable: boolean
  error: string | null
  createdAt: string
  filedAt: string | null
}

export type Brief = { day: string; status: 'writing' | 'done' | 'failed'; text: string; error: string | null; createdAt: string; updatedAt: string }

export const fetchCaptures = async (): Promise<Capture[]> =>
  (await api.get<{ captures: Capture[] }>('/capture', { params: { limit: 8 } })).data.captures

export const sendCapture = async (text: string): Promise<Capture> =>
  (await api.post<{ ok: boolean; capture: Capture }>('/capture', { text })).data.capture

export const undoCapture = async (id: string): Promise<Capture> =>
  (await api.post<{ ok: boolean; capture: Capture }>(`/capture/${encodeURIComponent(id)}/undo`)).data.capture

export const fetchBrief = async (): Promise<Brief | null> =>
  (await api.get<{ brief: Brief | null }>('/brief')).data.brief

export const refreshBrief = async (): Promise<Brief | null> =>
  (await api.post<{ ok: boolean; brief: Brief | null }>('/brief/refresh')).data.brief
