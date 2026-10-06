// Shared shapes for the Projects workspace. The frontend keeps a verbatim copy
// in frontend/src/lib/projectsApi.ts, so a change here is a change there too.

// personal and server mix; every other area holds client material. Which
// client areas exist is odin's own config (lib/projectAreas.ts), because this
// repo is public and their names are not.
export type Area = string
export const MIXABLE_AREAS: readonly Area[] = ['personal', 'server']
export type ProjectStatus = 'active' | 'paused' | 'archived'
export type Exposure = 'tailnet' | 'anywhere'
export type Via = 'ui' | 'mcp' | 'hook' | 'terminal' | 'system'

export type Project = {
  id: string; name: string; area: Area; targetKey: string
  summary: string; nextAction: string; status: ProjectStatus; exposure: Exposure
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
  id: string; name: string; area: Area; status: ProjectStatus; summary: string; nextAction: string
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

export type Ctx = { actor: string; via: Via }

// Carries the HTTP status with the message, so the REST routes, the MCP tools
// and the terminal route's existing catch can all answer from the same throw.
export class ProjError extends Error {
  status: number
  body?: Record<string, unknown>
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
}

export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
