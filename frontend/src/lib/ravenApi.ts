import { api } from './api'

// Raven (backend/src/routes/raven.ts): Brendon's one assistant, the only
// conversation in the Raven tab. He writes, Raven answers, and what the agents,
// his sessions and the features say comes into the same thread as relays.
// Proposals the agents make are decided here too (routes/msg.ts), and the
// thread updates through the Messages long-poll (/api/msg/changes).

/** A model's key in Raven's catalog (backend lib/raven/models.ts); the list itself comes with the page (`models`). */
export type RavenTier = string
export type RavenEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** The efforts he picks from. */
export type RavenPickEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** The automatic rules: his message sorted simple or complex, a voice (Siri) message, a run he did not start. */
export type RavenRuleKey = 'simple' | 'complex' | 'voice' | 'background'
export type RavenRule = { model: RavenTier; effort: RavenPickEffort }
/** His model and effort pick (backend lib/raven/settings.ts), the same on every device. */
export type RavenSettings = { model: RavenTier | 'auto'; effort: RavenPickEffort | 'auto'; rules: Record<RavenRuleKey, RavenRule> }
/** One model in the picker; `unavailable` says why odin's accounts refused it lately ("needs usage credits"), `fallback` what runs instead. */
export type RavenModelInfo = { key: RavenTier; id: string; label: string; unavailable?: string; fallback?: string }
/** A change to the pick: either part, any rule's model or effort, or reset (the rules' defaults). */
export type RavenSettingsPatch = {
  model?: RavenSettings['model']; effort?: RavenSettings['effort']; rules?: Partial<Record<RavenRuleKey, Partial<RavenRule>>>; reset?: boolean
}
export type RavenStatus = 'idle' | 'routing' | 'working' | 'error'

/** A file Brendon attached (stored on odin). */
export type RavenFile = { id: string; name: string; mime: string; size: number; createdAt: string }

export type RavenRelay = {
  kind: 'agent' | 'session' | 'feature' | 'system'
  /** agent id, tmux pane name, or source key ('backup') */
  from: string
  /** display name ("Work triage", "Personal", "Backup") */
  label: string
  sourceMessageId?: number
  sessionId?: string
  /** a session relay: the conversation's own title, when it says more than the label */
  title?: string
}

/** What a message carries beyond its text. Every field optional. */
export type RavenMeta = {
  tier?: RavenTier
  model?: string
  effort?: RavenEffort
  why?: string
  /** the automatic rule that chose the model or the effort; absent when he fixed both */
  rule?: RavenRuleKey
  /** the model id wanted when another ran in its place */
  asked?: string
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
  /** every proposal when one relay holds several (proposal is the first) */
  proposals?: Proposal[]
}

export type RavenMain = { target: string; label: string; pane: string | null; state: 'working' | 'idle' | 'closed' | 'dead' }
/**
 * label: the pane's name (often the main target's); title: the job's name as Raven labeled it, when that says more;
 * status: the first sentence of its newest answer, when short. state: null when thor's board is not answering for a
 * window on thor (absent from an older API); lastAt: its last activity.
 */
export type RavenWatch = { pane: string; label: string; sessionId: string; since: string; title?: string; status?: string; state?: 'working' | 'idle' | 'closed' | null; lastAt?: string }
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
  /** his read mark (the last line he read), the same on every device; absent from an older backend */
  lastRead?: number
  mains: RavenMain[]
  watching: RavenWatch[]
  agents: RavenAgent[]
  /** the agents' global pause */
  paused: boolean
  /** his model and effort pick and the models it offers (absent from a backend before the picker) */
  settings?: RavenSettings
  models?: RavenModelInfo[]
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

/** A voice clip (as the browser recorded it) to odin's transcriber; answers the words. */
export const transcribeRaven = async (clip: Blob): Promise<string> =>
  String((await api.post<{ text: string }>('/raven/transcribe', clip, { headers: { 'Content-Type': clip.type || 'audio/webm' }, timeout: 150_000 })).data.text ?? '')

export const saveRavenSettings = async (patch: RavenSettingsPatch) =>
  (await api.post<{ settings: RavenSettings; models: RavenModelInfo[] }>('/raven/settings', patch)).data

/** The rules Automatic starts with (the backend's DEFAULT_RAVEN_SETTINGS), for Reset before the answer comes. */
export const DEFAULT_RAVEN_RULES: RavenSettings['rules'] = {
  simple: { model: 'sonnet', effort: 'low' },
  complex: { model: 'opus', effort: 'high' },
  voice: { model: 'sonnet', effort: 'low' },
  background: { model: 'sonnet', effort: 'low' },
}

/** The pick with a change applied, as the backend will save it. */
export function patchSettings(s: RavenSettings, p: RavenSettingsPatch): RavenSettings {
  const rules = { ...(p.reset ? DEFAULT_RAVEN_RULES : s.rules) }
  for (const [k, v] of Object.entries(p.rules ?? {}) as [RavenRuleKey, Partial<RavenRule>][]) rules[k] = { ...rules[k], ...v }
  return { model: p.model ?? s.model, effort: p.effort ?? s.effort, rules }
}

/** Resolves when anything in Messages changed after `since` (or after about 25 s). */
export const waitMsgChange = async (since: number, signal: AbortSignal): Promise<number> =>
  (await api.get<{ seq: number }>('/msg/changes', { params: { since }, signal, timeout: 40_000 })).data.seq

/** The Messages badge: Raven's unread count is in `unread`. */
export const fetchMsgCount = async (): Promise<{ unread: number; notify?: number; pending?: number }> =>
  (await api.get('/msg/count')).data

export const approveProposal = async (id: number, body: { how?: 'send' | 'draft'; body?: string; cc?: string[] } = {}) =>
  (await api.post<{ ok: boolean; proposal: Proposal }>(`/msg/proposals/${id}/approve`, body)).data

/** Decline all: the oldest `count` waiting proposals of one agent, or of every agent; nothing is sent or applied. */
export const declineAllProposals = async (body: { agentId?: string; count: number; reason?: string }) =>
  (await api.post<{ ok: boolean; declined: number; ids: number[] }>('/msg/proposals/decline-all', body)).data

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
    ...(Array.isArray(m.proposals) && m.proposals.length > 1 ? { proposals: m.proposals } : {}),
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

const TIER_NAME: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

/** "claude-sonnet-5-5" -> "Sonnet 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5"; anything else as it came. */
export function modelLabel(model: string | null | undefined, tier?: string | null): string {
  if (model) {
    const m = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model)
    if (m) return `${TIER_NAME[m[1]]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
    return model
  }
  return tier ? TIER_NAME[tier] ?? tier : ''
}

export const RULE_NAME: Record<RavenRuleKey, string> = { simple: 'Simple', complex: 'Complex', voice: 'Voice', background: 'Background' }

/**
 * A reply's line under it: the model that ran (and the one wanted, when another ran in its place), the effort, the
 * automatic rule that chose it, the time. "Sonnet 5.5 · low · simple · 3:04 PM ET".
 */
export function replyMetaLine(meta: RavenMeta, createdAt: string, opts: { time?: boolean } = {}): string {
  const ran = modelLabel(meta.model, meta.tier)
  const model = ran && meta.asked ? `${ran} (${modelLabel(meta.asked)} unavailable)` : ran
  return [model, meta.effort, meta.rule ? meta.rule : null, opts.time === false ? null : etTime(createdAt)].filter(Boolean).join(' · ')
}

/** The reply line's tooltip: how it was chosen. */
export function replyMetaTitle(meta: RavenMeta): string | undefined {
  const how = meta.rule ? `Automatic, ${meta.rule === 'background' ? 'a run you did not start' : `${meta.rule} message`}` : meta.model ? 'Your pick' : ''
  return [how, meta.why && meta.why !== 'your pick' ? meta.why : ''].filter(Boolean).join(': ') || undefined
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
