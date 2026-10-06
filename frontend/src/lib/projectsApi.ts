import { api } from './api'

// The project workspace (/projects). The types mirror backend/src/lib/projectTypes.ts
// field for field. Everything here is named proj*, never projects*: GET
// /api/projects, fetchProjects, ProjectStatus and the ['projects'] query key
// already belong to the Dashboard's git-status card, and two queryFns under one
// key share a cache entry, so whichever loaded first would hand the other a
// shape it does not expect.

// personal and server are fixed. The client areas are odin's private config
// (backend lib/projectAreas.ts) because this repo is public, and GET
// /proj-areas hands over the full list in display order. Until it answers,
// only the fixed two are offered.
export type Area = string
export const MIXABLE_AREAS: readonly Area[] = ['personal', 'server']
export const BASE_AREAS = MIXABLE_AREAS
export const isClientArea = (area: Area) => !MIXABLE_AREAS.includes(area)
// ProjectStatus on the backend; renamed here because lib/api.ts already exports one.
export type ProjStatus = 'active' | 'paused' | 'archived'
export type Exposure = 'tailnet' | 'anywhere'
export type Via = 'ui' | 'mcp' | 'hook' | 'terminal' | 'system'

export type Project = {
  id: string; name: string; area: Area; targetKey: string
  summary: string; nextAction: string; status: ProjStatus; exposure: Exposure
  allowSnapshots: boolean; sessionEdits: boolean; sortOrder: number
  rev: number; metaRev: number; createdAt: string; updatedAt: string
}
export type TabKind = 'markdown' | 'checklist' | 'links'
export type ChecklistItem = { id: string; text: string; done: boolean; doneAt: string | null }
export type LinkItem = { id: string; label: string; url: string }
export type Tab = {
  id: string; projectId: string; kind: TabKind; title: string
  body: string                            // markdown only, '' otherwise
  items: ChecklistItem[] | LinkItem[]     // [] for markdown
  sortOrder: number; rev: number
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string
  bodyTruncated?: boolean                 // MCP project_get only
}
export type FileKind = 'path' | 'url' | 'doc'
export type FileRef = {
  id: string; projectId: string; kind: FileKind; label: string
  relPath: string | null; url: string | null; note: string
  hasContent: boolean; contentType: 'markdown' | 'text' | null; contentBytes: number | null; capturedAt: string | null
  sortOrder: number; rev: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string
}
export type FileContent = { content: string; contentType: 'markdown' | 'text'; capturedAt: string | null }
export type AutomationKind = 'agent' | 'workflow'
export type Model = '' | 'opus' | 'sonnet' | 'haiku'
export type AutomationSummary = {
  id: string; projectId: string; kind: AutomationKind; key: string; name: string; description: string
  model: Model; bodyPreview: string; rev: number; updatedBy: string; updatedAt: string
}
export type Automation = AutomationSummary & { body: string; createdBy: string; createdAt: string }
export type RunStatus = 'starting' | 'running' | 'done' | 'failed' | 'blocked'
export type Run = {
  id: string; projectId: string; automationKey: string; kind: AutomationKind; name: string; model: Model
  sessionId: string | null; tmuxName: string | null; status: RunStatus; summary: string
  startedBy: string; startedAt: string; briefFetchedAt: string | null; endedAt: string | null
}
export type LinkedVia = 'launch' | 'resume' | 'link' | 'clear' | 'startup'
export type SessionLink = {
  sessionId: string; launchSessionId: string; host: string; tmuxName: string | null; mode: string
  runId: string | null; linkedVia: LinkedVia; statusNote: string; statusAt: string | null; linkedBy: string; linkedAt: string
}
export type ReminderState = 'pending' | 'sent' | 'failed' | 'gone' | 'canceled'
export type Reminder = { id: string; at: string; message: string; state: ReminderState; createdBy: string; createdAt: string; canceledAt: string | null }
export type EventEntity = 'project' | 'tab' | 'file' | 'automation' | 'run' | 'session' | 'reminder'
export type ProjectEvent = {
  id: number; at: string; actor: string; via: Via; action: string; entity: EventEntity; entityId: string
  summary: string; undoable: boolean; undoOf: number | null; undoneBy: number | null
}
export type ProjectDoc = {
  project: Project
  tabs: Tab[]                       // live, by sortOrder
  files: FileRef[]
  automations: AutomationSummary[]
  runs: Run[]                       // newest 20
  sessions: SessionLink[]           // newest linkedAt first
  reminders: Reminder[]             // pending by at asc, then the rest of the last 30 days
  lastEvent: ProjectEvent | null
}
export type ProjectSummary = {
  id: string; name: string; area: Area; status: ProjStatus; summary: string; nextAction: string
  targetKey: string; exposure: Exposure; sessionIds: string[]; nextReminderAt: string | null
  updatedAt: string; rev: number; lastEvent: ProjectEvent | null
}
export type ProjChange = { rev: number; lastEvent: ProjectEvent | null }
export type NewProjectInput = { name: string; area: Area; targetKey: string; id?: string; summary?: string }
export type ProjectPatch = { name?: string; summary?: string; nextAction?: string; status?: 'active' | 'paused'; area?: Area; targetKey?: string; exposure?: Exposure; sessionEdits?: boolean; allowSnapshots?: boolean }
export type NewTabInput = { kind: TabKind; title: string; body?: string; items?: string[] | { label: string; url: string }[]; position?: 'start' | 'end' }
export type TabPatch = { baseRev?: number; title?: string; body?: string; appendBody?: string }
export type TabItemOp =
  | { op: 'add'; text?: string; label?: string; url?: string }
  | { op: 'set'; itemId: string; done: boolean }
  | { op: 'edit'; itemId: string; text?: string; label?: string; url?: string }
  | { op: 'remove'; itemId: string }
export type PinFileInput = { kind: FileKind; label: string; relPath?: string; url?: string; note?: string; content?: string; contentType?: 'markdown' | 'text' }
export type FilePatch = { label?: string; note?: string; content?: string; contentType?: 'markdown' | 'text' }
export type SaveAutomationInput = { kind: AutomationKind; name: string; description?: string; body: string; model?: Model; baseRev?: number }
export type ReminderInput = { at: string; message: string }

export const LIMITS = {
  projectName: 60, summary: 500, nextAction: 140,
  tabTitle: 40, tabBody: 65536, tabsPerProject: 30, itemsPerTab: 200, checklistText: 300, linkLabel: 80, url: 2000,
  fileLabel: 80, fileNote: 300, relPath: 260, fileContent: 262144, filesPerProject: 200,
  automationName: 60, automationDescription: 300, automationBody: 16000, automationsPerProject: 30,
  reminderMessage: 500, pendingReminders: 50, reminderMaxDays: 366,
  sessionNote: 200, runSummary: 2000, appendText: 8000,
} as const

export const PROJ_KEYS = {
  list: ['proj', 'list'] as const,
  areas: ['proj', 'areas'] as const,
  doc: (id: string) => ['proj', 'doc', id] as const,
  events: (id: string) => ['proj', 'events', id] as const,
  file: (id: string, fileId: string) => ['proj', 'file', id, fileId] as const,
  automation: (id: string, key: string) => ['proj', 'automation', id, key] as const,
}

// The 409 a stale rev gets (a run started from an older brief, an edit saved
// over a newer one). The session cap is also a 409, with its own message.
export const isChangedSince = (e: unknown): boolean => {
  const r = (e as { response?: { status?: number; data?: { error?: string } } } | null)?.response
  return r?.status === 409 && r.data?.error === 'changed since'
}

// The project id comes straight out of the URL, so it is encoded like any
// other user input rather than trusted to be a slug.
const p = (id: string) => `/proj/${encodeURIComponent(id)}`
const seg = (s: string) => encodeURIComponent(s)

// Archived projects are left out unless asked for; the list asks only when its
// "show archived" toggle is on.
export const fetchProjAreas = async () =>
  (await api.get<{ areas: Area[]; mixable: Area[] }>('/proj-areas')).data.areas

// The list only changes with odin's .env, so no interval (the app default polls).
export const projAreasQuery = {
  queryKey: PROJ_KEYS.areas, queryFn: fetchProjAreas, staleTime: 3_600_000, refetchInterval: false as const,
}

export const fetchProjList = async (archived = false) =>
  (await api.get<ProjectSummary[]>('/proj', { params: archived ? { archived: '1' } : undefined })).data

export const createProj = async (body: NewProjectInput) =>
  (await api.post<ProjectDoc>('/proj', body)).data

export const fetchProjDoc = async (id: string) =>
  (await api.get<ProjectDoc>(p(id))).data

export const updateProj = async (id: string, patch: ProjectPatch) =>
  (await api.patch<ProjectDoc>(p(id), patch)).data

export const archiveProj = async (id: string) =>
  (await api.post<{ ok: true }>(`${p(id)}/archive`)).data

export const waitProjChange = async (id: string, rev: number, signal?: AbortSignal) =>
  (await api.get<ProjChange>(`${p(id)}/changes`, { params: { rev }, signal })).data

export const fetchProjEvents = async (id: string, opts: { before?: number; limit?: number; actor?: string } = {}) =>
  (await api.get<ProjectEvent[]>(`${p(id)}/events`, { params: opts })).data

export const undoProjEvent = async (id: string, eventId: number, force?: boolean) =>
  (await api.post<{ ok: true; rev: number }>(`${p(id)}/events/${eventId}/undo`, { force })).data

export const revertProjActor = async (id: string, actor: string) =>
  (await api.post<{ reverted: number; conflicts: number }>(`${p(id)}/revert`, { actor })).data

export const addProjTab = async (id: string, body: NewTabInput) =>
  (await api.post<Tab>(`${p(id)}/tabs`, body)).data

export const updateProjTab = async (id: string, tabId: string, patch: TabPatch) =>
  (await api.patch<Tab>(`${p(id)}/tabs/${seg(tabId)}`, patch)).data

export const projTabItem = async (id: string, tabId: string, op: TabItemOp) =>
  (await api.post<Tab>(`${p(id)}/tabs/${seg(tabId)}/items`, op)).data

export const moveProjTab = async (id: string, tabId: string, toIndex: number) =>
  (await api.post<{ ok: true }>(`${p(id)}/tabs/${seg(tabId)}/move`, { toIndex })).data

export const removeProjTab = async (id: string, tabId: string) =>
  (await api.delete<{ ok: true }>(`${p(id)}/tabs/${seg(tabId)}`)).data

export const pinProjFile = async (id: string, body: PinFileInput) =>
  (await api.post<FileRef>(`${p(id)}/files`, body)).data

export const updateProjFile = async (id: string, fileId: string, patch: FilePatch) =>
  (await api.patch<FileRef>(`${p(id)}/files/${seg(fileId)}`, patch)).data

export const unpinProjFile = async (id: string, fileId: string) =>
  (await api.delete<{ ok: true }>(`${p(id)}/files/${seg(fileId)}`)).data

export const fetchProjFileContent = async (id: string, fileId: string) =>
  (await api.get<FileContent>(`${p(id)}/files/${seg(fileId)}/content`)).data

export const fetchProjAutomation = async (id: string, key: string) =>
  (await api.get<Automation>(`${p(id)}/automations/${seg(key)}`)).data

export const saveProjAutomation = async (id: string, key: string, body: SaveAutomationInput) =>
  (await api.put<Automation>(`${p(id)}/automations/${seg(key)}`, body)).data

export const removeProjAutomation = async (id: string, key: string) =>
  (await api.delete<{ ok: true }>(`${p(id)}/automations/${seg(key)}`)).data

export const linkProjSession = async (id: string, sessionId: string) =>
  (await api.post<{ ok: true; created: boolean }>(`${p(id)}/sessions/link`, { sessionId, via: 'link' })).data

export const unlinkProjSession = async (id: string, sessionId: string) =>
  (await api.delete<{ ok: true }>(`${p(id)}/sessions/${seg(sessionId)}`)).data

export const addProjReminder = async (id: string, body: ReminderInput) =>
  (await api.post<Reminder>(`${p(id)}/reminders`, body)).data

export const cancelProjReminder = async (id: string, reminderId: string) =>
  (await api.delete<{ ok: true }>(`${p(id)}/reminders/${seg(reminderId)}`)).data

// Who made a change, in the words the page uses. `titles` maps a conversation
// id to its session-board title, so an edit reads as the session it came from.
export function actorLabel(actor: string, titles: Map<string, string>): string {
  if (actor === 'ui') return 'you'
  if (actor.startsWith('session:unknown@')) return 'a session'
  if (actor.startsWith('session:')) {
    const id = actor.slice('session:'.length)
    return titles.get(id) ?? `session ${id.slice(0, 8)}`
  }
  if (actor.startsWith('hook:')) return 'session hook'
  return actor
}

// What a tab body gets to do with the page's terminal. On the desktop that is
// the TermPane column beside the tabs; on the phone every open is a navigation
// to the pinned terminal, which has its own way back to the project.
export type ProjectTerm = {
  embedded: boolean                  // desktop: a TermPane column exists on this page
  selected: string | null            // tmux name in the pane (desktop)
  canSend: boolean                   // embedded && a pane is live
  send: (text: string) => void       // types into the selected pane, no Enter
  open: (tmuxName: string) => void   // desktop: select the pane; phone: navigate(termPath(name, '/projects/<id>'))
  resume: (sessionId: string, title?: string) => Promise<void>
  // A run passes the rev of the brief on screen; a newer one rejects with 409
  // "changed since", which start rethrows rather than showing on the page.
  start: (opts?: { automation?: string; automationRev?: number }) => Promise<void>
  busy: boolean
  error: string | null
}
export type ProjectTabProps = { projectId: string; doc: ProjectDoc; term: ProjectTerm }
export type CustomTabProps = ProjectTabProps & { tab: Tab }
