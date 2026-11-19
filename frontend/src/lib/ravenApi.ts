import { api } from './api'

// Raven (backend/src/routes/raven.ts): Brendon's one assistant, the only
// conversation in Messages. He writes, Raven answers, and what the agents,
// his sessions and the features say comes into the same thread as relays.
// Proposals the agents make are decided here too (routes/msg.ts), and the
// thread updates through the Messages long-poll (/api/msg/changes).

export type RavenTier = 'haiku' | 'sonnet' | 'opus'
export type RavenEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RavenStatus = 'idle' | 'routing' | 'working' | 'error'

/** A file Brendon attached (stored on odin). */
export type RavenFile = { id: string; name: string; mime: string; size: number; createdAt: string }

export type RavenRelay = {
  kind: 'agent' | 'session' | 'feature' | 'system'
  /** agent id, tmux pane name, or source key ('backup') */
  from: string
  /** display name ("Work triage", "Personal (main)", "Backup") */
  label: string
  sourceMessageId?: number
  sessionId?: string
}

/** What a message carries beyond its text. Every field optional. */
export type RavenMeta = {
  tier?: RavenTier
  model?: string
  effort?: RavenEffort
  why?: string
  replyTo?: number
  files?: RavenFile[]
  relay?: RavenRelay
  source?: 'app' | 'quick' | 'siri' | 'hotkey' | 'api'
  error?: string
}

export type Ref =
  | { type: 'ticket'; franchise: string; id: number; number: string; title?: string; url?: string }
  | { type: 'mail'; n: number; subject?: string; from?: string; url?: string }
  | { type: 'link'; url: string; label?: string }
  | { type: 'task'; text: string; projectId?: string }
  | { type: 'project'; id: string; name?: string }

export type ProposalStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined'

export type Proposal = {
  id: number; kind: string; title: string; payload: unknown; status: ProposalStatus | string
  result: string | null; decidedAt: string | null
}

export type RavenMsg = {
  id: number
  /** 'brendon' | 'raven' | 'system', or the agent id of an agent relay */
  author: string
  text: string
  createdAt: string
  refs: Ref[]
  meta: RavenMeta
  proposal: Proposal | null
}

export type RavenMain = { target: string; label: string; pane: string | null; state: 'working' | 'idle' | 'closed' | 'dead' }
export type RavenWatch = { pane: string; label: string; sessionId: string; since: string }
export type RavenAgent = { id: string; name: string; area: string; status: string; pending: number }

export type RavenState = {
  /** for GET /api/msg/changes?since= */
  seq: number
  status: RavenStatus
  statusNote: string
  tier: RavenTier | null
  model: string | null
  effort: RavenEffort | null
  unread: number
  mains: RavenMain[]
  watching: RavenWatch[]
  agents: RavenAgent[]
  /** the agents' global pause */
  paused: boolean
}

export type RavenPage = RavenState & { messages: RavenMsg[] }

/** How many messages GET /api/raven returns (the newest, oldest first). */
export const RAVEN_PAGE = 60
/** The size of each older page fetched on scroll-up. */
export const RAVEN_OLDER = 40
/** POST /api/raven/files refuses anything larger. */
export const RAVEN_FILE_MAX = 50 * 1024 * 1024

export const fetchRaven = async (): Promise<RavenPage> => normalize((await api.get<RavenPage>('/raven')).data)

export const fetchRavenOlder = async (before: number, limit = RAVEN_OLDER): Promise<RavenMsg[]> =>
  ((await api.get<{ messages: RavenMsg[] }>('/raven/messages', { params: { before, limit } })).data.messages ?? []).map(normMsg)

export const sendRaven = async (body: { text: string; files?: string[]; source?: RavenMeta['source'] }): Promise<RavenMsg> =>
  normMsg((await api.post<{ message: RavenMsg }>('/raven/messages', body)).data.message)

export const markRavenRead = async (upTo?: number) => (await api.post<{ ok: true }>('/raven/read', upTo ? { upTo } : {})).data

export const stopRaven = async () => (await api.post<{ ok: true }>('/raven/stop', {})).data

/** Resolves when anything in Messages changed after `since` (or after about 25 s). */
export const waitMsgChange = async (since: number, signal: AbortSignal): Promise<number> =>
  (await api.get<{ seq: number }>('/msg/changes', { params: { since }, signal, timeout: 40_000 })).data.seq

/** The Messages badge: Raven's unread count is in `unread`. */
export const fetchMsgCount = async (): Promise<{ unread: number; notify?: number; pending?: number }> =>
  (await api.get('/msg/count')).data

export const approveProposal = async (id: number, body: { how?: 'send' | 'draft'; body?: string; cc?: string[] } = {}) =>
  (await api.post<{ ok: boolean; proposal: Proposal }>(`/msg/proposals/${id}/approve`, body)).data

export const declineProposal = async (id: number, reason: string) =>
  (await api.post<{ ok: boolean; proposal: Proposal }>(`/msg/proposals/${id}/decline`, { reason })).data

/**
 * One file to odin as a raw body. Header values must be Latin-1, so a name
 * with anything outside printable ASCII goes percent-encoded.
 */
export async function uploadRavenFile(file: File, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<RavenFile> {
  if (!file.size) throw new Error(`${file.name || 'The file'} is empty`)
  if (file.size > RAVEN_FILE_MAX) throw new Error(`${file.name} is over 50 MB`)
  const name = file.name || 'file'
  const r = await api.post<RavenFile>('/raven/files', file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': /^[\x20-\x7e]*$/.test(name) ? name : encodeURIComponent(name),
    },
    timeout: 10 * 60_000,
    signal,
    onUploadProgress: (e) => onProgress?.(e.loaded ?? 0, file.size),
  })
  return r.data
}

/** The file's own URL; `token` is the media-scoped image token a client off the tailnet needs. */
export function ravenFileUrl(id: string, token: string | null): string {
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${api.defaults.baseURL ?? '/api'}/raven/files/${encodeURIComponent(id)}${q}`
}

// ---------- reading what the backend sent ----------

function normMsg(m: RavenMsg): RavenMsg {
  return {
    ...m,
    text: typeof m.text === 'string' ? m.text : '',
    // the time formats throw on a date they cannot read, which would take the whole thread down
    createdAt: Number.isFinite(Date.parse(m.createdAt)) ? m.createdAt : new Date().toISOString(),
    refs: Array.isArray(m.refs) ? m.refs : [],
    meta: m.meta && typeof m.meta === 'object' ? m.meta : {},
    proposal: m.proposal ?? null,
  }
}

function normalize(p: RavenPage): RavenPage {
  return {
    ...p,
    statusNote: p.statusNote ?? '',
    mains: p.mains ?? [],
    watching: p.watching ?? [],
    agents: p.agents ?? [],
    messages: (p.messages ?? []).map(normMsg),
  }
}

// ---------- words ----------

const TIER_NAME: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5"; anything else as it came. */
export function modelLabel(model: string | null | undefined, tier?: string | null): string {
  if (model) {
    const m = /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model)
    if (m) return `${TIER_NAME[m[1]]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
    return model
  }
  return tier ? TIER_NAME[tier] ?? tier : ''
}

/** The header's live line: "idle", "thinking · Sonnet 5.5 · high", "relaying", or the error. */
export function ravenStatusText(s: Pick<RavenState, 'status' | 'statusNote' | 'model' | 'tier' | 'effort'>): string {
  const note = s.statusNote.trim()
  const soft = note ? note.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()) : ''
  if (s.status === 'idle') return soft || 'idle'
  if (s.status === 'routing') return soft || 'choosing a model'
  if (s.status === 'error') return soft || 'the last run failed'
  if (soft) return soft
  return ['thinking', modelLabel(s.model, s.tier), s.effort].filter(Boolean).join(' · ')
}

/** Raven is busy: a run is choosing its model or working. */
export const ravenBusy = (s: Pick<RavenState, 'status'> | null | undefined): boolean => s?.status === 'routing' || s?.status === 'working'

const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

/** "3:04 PM ET" */
export const etTime = (iso: string): string => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? `${NY_TIME.format(t)} ET` : ''
}

export const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`

export const isImageFile = (f: { mime: string; name: string }): boolean =>
  /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(f.mime) || (!f.mime && /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.name))
