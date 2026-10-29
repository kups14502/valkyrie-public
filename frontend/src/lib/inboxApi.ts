import { api } from './api'

// The inbox (backend/src/routes/inbox.ts): everything the machines want to tell
// Brendon, kept in one list. Senders post on their own; the UI only reads,
// marks read, archives and sets each source's push.

export type InboxLevel = 'info' | 'warn' | 'alert'
export type PushSetting = 'auto' | 'on' | 'off'
export type InboxView = 'open' | 'archive'

export type InboxItem = {
  id: number
  source: string
  level: InboxLevel
  title: string
  body: string
  /** where Open goes: an app path or an http(s) link */
  url: string | null
  tag: string | null
  /** repeats folded into this item (same source and tag) */
  count: number
  firstAt: string
  lastAt: string
  readAt: string | null
  archivedAt: string | null
  pushedAt: string | null
  pushDetail: string | null
}

export type InboxSource = { source: string; open: number; unread: number; push: PushSetting; lastAt: string | null }

export type InboxCount = { unread: number; alerts: number; lastAt: string | null }

export type InboxPage = { view: InboxView; items: InboxItem[]; sources: InboxSource[]; count: InboxCount }

export const fetchInbox = async (view: InboxView, source?: string | null): Promise<InboxPage> =>
  (await api.get<InboxPage>('/inbox', { params: { view, ...(source ? { source } : {}) } })).data

export const fetchInboxCount = async (): Promise<InboxCount> =>
  (await api.get<InboxCount>('/inbox/count')).data

export type InboxSelection = { ids?: number[]; source?: string; all?: boolean }

export const markInboxRead = async (sel: InboxSelection, read = true) =>
  (await api.post<{ ok: boolean; changed: number; count: InboxCount }>('/inbox/read', { ...sel, read })).data

export const archiveInbox = async (sel: InboxSelection & { readOnly?: boolean }, archived = true) =>
  (await api.post<{ ok: boolean; changed: number; count: InboxCount }>('/inbox/archive', { ...sel, archived })).data

export const setInboxPush = async (source: string, push: PushSetting) =>
  (await api.put<{ ok: boolean; sources: InboxSource[] }>(`/inbox/sources/${encodeURIComponent(source)}`, { push })).data
