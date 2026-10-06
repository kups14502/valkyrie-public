import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { openDb } from './db.js'
import { AREAS } from './projectAreas.js'
import { addLilkupsReminder, normalizeAt, readLilkupsStates, removeLilkupsReminder } from './lilkups.js'
import {
  KEY_RE, LIMITS, MIXABLE_AREAS, ProjError, UUID_RE,
  type Area, type Automation, type AutomationKind, type AutomationSummary, type ChecklistItem, type Ctx,
  type EventEntity, type Exposure, type FileContent, type FileKind, type FilePatch, type FileRef, type LinkedVia,
  type LinkItem, type Model, type NewProjectInput, type NewTabInput, type PinFileInput, type ProjChange,
  type Project, type ProjectDoc, type ProjectEvent, type ProjectPatch, type ProjectSummary, type Reminder,
  type ReminderInput, type ReminderState, type Run, type SaveAutomationInput, type SessionLink, type Tab,
  type TabItemOp, type TabKind, type TabPatch,
} from './projectTypes.js'

// The Projects workspace, and the only writer of projects.sqlite.
//
// Three callers share it: the page's REST routes, the MCP tools that Claude
// sessions on thor call, and the terminal route that launches project
// sessions. Every change goes through mutate(), which in one transaction
// applies it, bumps projects.rev and logs an event holding the full row before
// and after. That single path is what makes a change attributable and
// undoable whoever made it, and projects.rev is what the page's long-poll
// waits on.
//
// Removes are soft (deletedAt), so an undo is a column copy onto the same row
// rather than a re-insert that would have to reinvent ids other rows point at.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  area           TEXT NOT NULL,
  targetKey      TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  nextAction     TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  exposure       TEXT NOT NULL CHECK (exposure IN ('tailnet','anywhere')),
  allowSnapshots INTEGER NOT NULL CHECK (allowSnapshots IN (0,1)),
  sessionEdits   INTEGER NOT NULL DEFAULT 1 CHECK (sessionEdits IN (0,1)),
  sortOrder      INTEGER NOT NULL DEFAULT 0,
  rev            INTEGER NOT NULL DEFAULT 0,
  metaRev        INTEGER NOT NULL DEFAULT 1,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_tabs (
  id         TEXT PRIMARY KEY,
  projectId  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('markdown','checklist','links')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  items      TEXT NOT NULL DEFAULT '[]',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  rev        INTEGER NOT NULL DEFAULT 1,
  deletedAt  TEXT,
  createdBy  TEXT NOT NULL,
  updatedBy  TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tabs_project ON project_tabs(projectId, sortOrder);

CREATE TABLE IF NOT EXISTS project_files (
  id           TEXT PRIMARY KEY,
  projectId    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('path','url','doc')),
  label        TEXT NOT NULL,
  relPath      TEXT,
  url          TEXT,
  note         TEXT NOT NULL DEFAULT '',
  content      TEXT,
  contentType  TEXT CHECK (contentType IN ('markdown','text')),
  contentBytes INTEGER,
  capturedAt   TEXT,
  sortOrder    INTEGER NOT NULL DEFAULT 0,
  rev          INTEGER NOT NULL DEFAULT 1,
  deletedAt    TEXT,
  createdBy    TEXT NOT NULL,
  updatedBy    TEXT NOT NULL,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL,
  CHECK ((kind = 'path' AND relPath IS NOT NULL AND url IS NULL)
      OR (kind = 'url'  AND url IS NOT NULL AND relPath IS NULL)
      OR (kind = 'doc'  AND relPath IS NULL AND url IS NULL AND content IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_files_path ON project_files(projectId, relPath) WHERE deletedAt IS NULL AND relPath IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_files_project ON project_files(projectId, sortOrder);

CREATE TABLE IF NOT EXISTS project_automations (
  id          TEXT PRIMARY KEY,
  projectId   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('agent','workflow')),
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '' CHECK (model IN ('','opus','sonnet','haiku')),
  rev         INTEGER NOT NULL DEFAULT 1,
  deletedAt   TEXT,
  createdBy   TEXT NOT NULL,
  updatedBy   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_auto_key ON project_automations(projectId, key) WHERE deletedAt IS NULL;

CREATE TABLE IF NOT EXISTS project_runs (
  id             TEXT PRIMARY KEY,
  projectId      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  automationId   TEXT NOT NULL,
  automationKey  TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('agent','workflow')),
  name           TEXT NOT NULL,
  brief          TEXT NOT NULL,
  model          TEXT NOT NULL DEFAULT '',
  sessionId      TEXT,
  tmuxName       TEXT,
  status         TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','done','failed','blocked')),
  summary        TEXT NOT NULL DEFAULT '',
  startedBy      TEXT NOT NULL,
  startedAt      TEXT NOT NULL,
  briefFetchedAt TEXT,
  endedAt        TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_project ON project_runs(projectId, startedAt);
CREATE INDEX IF NOT EXISTS ix_runs_tmux ON project_runs(tmuxName);

CREATE TABLE IF NOT EXISTS project_sessions (
  projectId       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sessionId       TEXT NOT NULL,
  launchSessionId TEXT NOT NULL,
  host            TEXT NOT NULL DEFAULT 'thor',
  tmuxName        TEXT,
  mode            TEXT NOT NULL DEFAULT '',
  runId           TEXT,
  linkedVia       TEXT NOT NULL CHECK (linkedVia IN ('launch','resume','link','clear','startup')),
  statusNote      TEXT NOT NULL DEFAULT '',
  statusAt        TEXT,
  linkedBy        TEXT NOT NULL,
  linkedAt        TEXT NOT NULL,
  PRIMARY KEY (projectId, sessionId)
);
CREATE INDEX IF NOT EXISTS ix_ps_session ON project_sessions(sessionId);
CREATE INDEX IF NOT EXISTS ix_ps_launch ON project_sessions(projectId, launchSessionId);

CREATE TABLE IF NOT EXISTS project_reminders (
  id            TEXT PRIMARY KEY,
  projectId     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lilkupsId     TEXT NOT NULL,
  at            TEXT NOT NULL,
  message       TEXT NOT NULL,
  deliveredText TEXT NOT NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  canceledAt    TEXT
);
CREATE INDEX IF NOT EXISTS ix_rem_project ON project_reminders(projectId, at);

CREATE TABLE IF NOT EXISTS project_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId TEXT NOT NULL,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  via       TEXT NOT NULL CHECK (via IN ('ui','mcp','hook','terminal','system')),
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL CHECK (entity IN ('project','tab','file','automation','run','session','reminder')),
  entityId  TEXT NOT NULL,
  summary   TEXT NOT NULL,
  before    TEXT,
  after     TEXT,
  undoOf    INTEGER,
  undoneBy  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ev_project ON project_events(projectId, id);
CREATE INDEX IF NOT EXISTS ix_ev_actor ON project_events(projectId, actor);
`

const db = openDb('projects', SCHEMA)
db.pragma('foreign_keys = ON')
// Later ALTER TABLEs are gated on this, so a migration runs once instead of
// being inferred from the shape of whatever table happens to be on disk.
if ((db.pragma('user_version', { simple: true }) as number) < 1) db.pragma('user_version = 1')

// Wakes the /changes long-polls. Every open project page on every device holds
// one listener, so the default cap of 10 would only produce false leak warnings.
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

// ------------------------------------------------------------------ rows ----

type ProjectRow = Omit<Project, 'allowSnapshots' | 'sessionEdits'> & { allowSnapshots: number; sessionEdits: number }
type TabRow = Omit<Tab, 'items' | 'bodyTruncated'> & { items: string; deletedAt: string | null }
type FileRow = Omit<FileRef, 'hasContent'> & { content: string | null; deletedAt: string | null }
type FileListRow = Omit<FileRef, 'hasContent'> & { hasContent: number }
type AutomationRow = Omit<Automation, 'bodyPreview'> & { deletedAt: string | null }
type RunRow = Run & { automationId: string; brief: string }
type SessionRow = SessionLink & { projectId: string }
type ReminderRow = {
  id: string; projectId: string; lilkupsId: string; at: string; message: string; deliveredText: string
  createdBy: string; createdAt: string; canceledAt: string | null
}
type EventRow = Omit<ProjectEvent, 'undoable'> & { projectId: string; before: string | null; after: string | null }
type EventListRow = Omit<EventRow, 'before' | 'after'>
type Restorable = 'project' | 'tab' | 'file' | 'automation'

const insertSql = (table: string, cols: string[]) =>
  `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`
const updateSql = (table: string, cols: string[]) =>
  `UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`

const PROJECT_COLS = ['id', 'name', 'area', 'targetKey', 'summary', 'nextAction', 'status', 'exposure', 'allowSnapshots', 'sessionEdits', 'sortOrder', 'rev', 'metaRev', 'createdAt', 'updatedAt']
const TAB_COLS = ['id', 'projectId', 'kind', 'title', 'body', 'items', 'sortOrder', 'rev', 'deletedAt', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']
const FILE_COLS = ['id', 'projectId', 'kind', 'label', 'relPath', 'url', 'note', 'content', 'contentType', 'contentBytes', 'capturedAt', 'sortOrder', 'rev', 'deletedAt', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']
const AUTO_COLS = ['id', 'projectId', 'kind', 'key', 'name', 'description', 'body', 'model', 'rev', 'deletedAt', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt']
const RUN_COLS = ['id', 'projectId', 'automationId', 'automationKey', 'kind', 'name', 'brief', 'model', 'sessionId', 'tmuxName', 'status', 'summary', 'startedBy', 'startedAt', 'briefFetchedAt', 'endedAt']
const REMINDER_COLS = ['id', 'projectId', 'lilkupsId', 'at', 'message', 'deliveredText', 'createdBy', 'createdAt', 'canceledAt']
const EVENT_COLS = ['projectId', 'at', 'actor', 'via', 'action', 'entity', 'entityId', 'summary', 'before', 'after', 'undoOf', 'undoneBy']

// List queries never read file content: a project can pin 200 files of up to
// 256 KB each, and the page fetches a body only when one is opened. A doc pin
// whose content was dropped keeps an empty body, which contentBytes tells
// apart without loading it.
const FILE_LIST = `id, projectId, kind, label, relPath, url, note, contentType, contentBytes, capturedAt,
  sortOrder, rev, createdBy, updatedBy, createdAt, updatedAt, (content IS NOT NULL AND contentBytes > 0) AS hasContent`
const AUTO_LIST = 'id, projectId, kind, key, name, description, model, substr(body, 1, 280) AS bodyPreview, rev, updatedBy, updatedAt'
const RUN_LIST = 'id, projectId, automationKey, kind, name, model, sessionId, tmuxName, status, summary, startedBy, startedAt, briefFetchedAt, endedAt'
// Events without their before and after images, which hold whole rows (a
// 64 KB tab twice over). The long-poll and every list read these; only undo
// needs the images, and it reads them through q.event.
const EVENT_LIST = (t = '') => ['id', 'projectId', 'at', 'actor', 'via', 'action', 'entity', 'entityId', 'summary', 'undoOf', 'undoneBy'].map((c) => t + c).join(', ')

const q = {
  project: db.prepare('SELECT * FROM projects WHERE id = @id'),
  projectsAll: db.prepare('SELECT * FROM projects'),
  projectInsert: db.prepare(insertSql('projects', PROJECT_COLS)),
  projectSave: db.prepare(updateSql('projects', ['name', 'area', 'targetKey', 'summary', 'nextAction', 'status', 'exposure', 'allowSnapshots', 'sessionEdits', 'sortOrder', 'metaRev'])),
  projectBump: db.prepare('UPDATE projects SET rev = rev + 1, updatedAt = @now WHERE id = @id'),

  tab: db.prepare('SELECT * FROM project_tabs WHERE id = @id AND projectId = @projectId'),
  tabsLive: db.prepare('SELECT * FROM project_tabs WHERE projectId = @projectId AND deletedAt IS NULL ORDER BY sortOrder, createdAt'),
  tabInsert: db.prepare(insertSql('project_tabs', TAB_COLS)),
  tabSave: db.prepare(updateSql('project_tabs', ['title', 'body', 'items', 'sortOrder', 'rev', 'deletedAt', 'updatedBy', 'updatedAt'])),
  tabSort: db.prepare('UPDATE project_tabs SET sortOrder = @sortOrder WHERE id = @id'),

  file: db.prepare('SELECT * FROM project_files WHERE id = @id AND projectId = @projectId'),
  fileRef: db.prepare(`SELECT ${FILE_LIST} FROM project_files WHERE id = @id`),
  filesLive: db.prepare(`SELECT ${FILE_LIST} FROM project_files WHERE projectId = @projectId AND deletedAt IS NULL ORDER BY sortOrder, createdAt`),
  fileByPath: db.prepare('SELECT * FROM project_files WHERE projectId = @projectId AND relPath = @relPath AND deletedAt IS NULL'),
  fileStats: db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sortOrder), -1) AS maxSort FROM project_files WHERE projectId = @projectId AND deletedAt IS NULL'),
  fileInsert: db.prepare(insertSql('project_files', FILE_COLS)),
  fileSave: db.prepare(updateSql('project_files', ['label', 'relPath', 'url', 'note', 'content', 'contentType', 'contentBytes', 'capturedAt', 'sortOrder', 'rev', 'deletedAt', 'updatedBy', 'updatedAt'])),
  // A doc pin cannot hold NULL content (the table CHECK), so it keeps its
  // label and note over an empty body.
  fileContentsDrop: db.prepare(`UPDATE project_files
    SET content = CASE WHEN kind = 'doc' THEN '' ELSE NULL END, contentType = NULL, contentBytes = NULL, capturedAt = NULL
    WHERE projectId = @projectId AND content IS NOT NULL AND contentBytes > 0`),

  automation: db.prepare('SELECT * FROM project_automations WHERE id = @id AND projectId = @projectId'),
  automationByKey: db.prepare('SELECT * FROM project_automations WHERE projectId = @projectId AND key = @key AND deletedAt IS NULL'),
  automationsLive: db.prepare(`SELECT ${AUTO_LIST} FROM project_automations WHERE projectId = @projectId AND deletedAt IS NULL ORDER BY kind, name COLLATE NOCASE`),
  automationCount: db.prepare('SELECT COUNT(*) AS n FROM project_automations WHERE projectId = @projectId AND deletedAt IS NULL'),
  automationInsert: db.prepare(insertSql('project_automations', AUTO_COLS)),
  automationSave: db.prepare(updateSql('project_automations', ['kind', 'name', 'description', 'body', 'model', 'rev', 'deletedAt', 'updatedBy', 'updatedAt'])),

  run: db.prepare('SELECT * FROM project_runs WHERE id = @id'),
  runsRecent: db.prepare(`SELECT ${RUN_LIST} FROM project_runs WHERE projectId = @projectId ORDER BY startedAt DESC LIMIT 20`),
  runsOpenForTmux: db.prepare("SELECT * FROM project_runs WHERE tmuxName = @tmuxName AND status IN ('starting','running')"),
  runInsert: db.prepare(insertSql('project_runs', RUN_COLS)),
  runAttach: db.prepare('UPDATE project_runs SET sessionId = @sessionId, tmuxName = @tmuxName WHERE id = @id'),
  runFetched: db.prepare("UPDATE project_runs SET briefFetchedAt = @now, status = 'running' WHERE id = @id AND briefFetchedAt IS NULL AND status = 'starting'"),
  runFail: db.prepare("UPDATE project_runs SET status = 'failed', summary = @summary, endedAt = @now WHERE id = @id AND status IN ('starting','running')"),
  runEnd: db.prepare('UPDATE project_runs SET status = @status, summary = @summary, endedAt = @now WHERE id = @id'),
  // The run a resumed conversation belongs to: the run's own conversation, or
  // one a /clear made from it, which the hook linked under the run's session
  // as its launch session.
  runForSession: db.prepare(`SELECT r.id FROM project_runs r
    WHERE r.projectId = @projectId
      AND r.sessionId IN (@sid, (SELECT s.launchSessionId FROM project_sessions s WHERE s.projectId = @projectId AND s.sessionId = @sid))
    ORDER BY r.startedAt DESC LIMIT 1`),

  session: db.prepare('SELECT * FROM project_sessions WHERE projectId = @projectId AND sessionId = @sessionId'),
  sessions: db.prepare('SELECT * FROM project_sessions WHERE projectId = @projectId ORDER BY linkedAt DESC'),
  sessionIdsAll: db.prepare('SELECT projectId, sessionId FROM project_sessions ORDER BY linkedAt DESC'),
  // A conversation /resume'd inside another process (the hook sends that
  // process's launch id) moves to that process's group, so its status line
  // follows the process now running it. A resume from the page sends the
  // conversation's own id, and its row keeps the group it was linked into.
  sessionUpsert: db.prepare(`
    INSERT INTO project_sessions (projectId, sessionId, launchSessionId, host, tmuxName, mode, runId, linkedVia, statusNote, statusAt, linkedBy, linkedAt)
    VALUES (@projectId, @sessionId, @launchSessionId, 'thor', @tmuxName, @mode, @runId, @linkedVia, '', NULL, @linkedBy, @linkedAt)
    ON CONFLICT(projectId, sessionId) DO UPDATE SET
      launchSessionId = CASE WHEN excluded.linkedVia = 'resume' AND excluded.launchSessionId != excluded.sessionId
        THEN excluded.launchSessionId ELSE launchSessionId END,
      tmuxName = COALESCE(excluded.tmuxName, tmuxName),
      runId = COALESCE(excluded.runId, runId)`),
  sessionDelete: db.prepare('DELETE FROM project_sessions WHERE projectId = @projectId AND sessionId = @sessionId'),
  // The MCP header names the process's launch id: the rows that process
  // launched or /clear'd into, and, for a conversation resumed from the page,
  // its own row, which kept the launch id it was first linked with.
  sessionStatus: db.prepare(`UPDATE project_sessions SET statusNote = @note, statusAt = @at
    WHERE projectId = @projectId AND (launchSessionId = @launchSessionId OR sessionId = @launchSessionId)`),
  projectsForSession: db.prepare(`SELECT ps.projectId FROM project_sessions ps JOIN projects p ON p.id = ps.projectId
    WHERE ps.sessionId = @sessionId AND p.status != 'archived'`),

  reminder: db.prepare('SELECT * FROM project_reminders WHERE id = @id AND projectId = @projectId'),
  reminderInsert: db.prepare(insertSql('project_reminders', REMINDER_COLS)),
  reminderCancel: db.prepare('UPDATE project_reminders SET canceledAt = @now WHERE id = @id'),
  reminderRelink: db.prepare('UPDATE project_reminders SET lilkupsId = @lilkupsId, deliveredText = @deliveredText WHERE id = @id'),
  remindersAhead: db.prepare('SELECT * FROM project_reminders WHERE projectId = @projectId AND canceledAt IS NULL AND at > @now'),
  remindersRecent: db.prepare('SELECT * FROM project_reminders WHERE projectId = @projectId AND (canceledAt IS NULL OR canceledAt >= @canceledCut) AND at >= @atCut'),
  remindersPending: db.prepare('SELECT COUNT(*) AS n FROM project_reminders WHERE projectId = @projectId AND canceledAt IS NULL AND at > @now'),
  nextReminders: db.prepare('SELECT projectId, MIN(at) AS next FROM project_reminders WHERE canceledAt IS NULL AND at > @now GROUP BY projectId'),

  event: db.prepare('SELECT * FROM project_events WHERE id = @id AND projectId = @projectId'),
  eventInsert: db.prepare(insertSql('project_events', EVENT_COLS)),
  eventUndone: db.prepare('UPDATE project_events SET undoneBy = @undoneBy WHERE id = @id'),
  eventPrune: db.prepare(`DELETE FROM project_events WHERE projectId = @projectId
    AND id <= (SELECT id FROM project_events WHERE projectId = @projectId ORDER BY id DESC LIMIT 1 OFFSET 1000)`),
  lastEvent: db.prepare(`SELECT ${EVENT_LIST()} FROM project_events WHERE projectId = @projectId ORDER BY id DESC LIMIT 1`),
  lastEvents: db.prepare(`SELECT ${EVENT_LIST('e.')} FROM project_events e JOIN (SELECT MAX(id) AS id FROM project_events GROUP BY projectId) m ON m.id = e.id`),
  eventsPage: db.prepare(`SELECT ${EVENT_LIST()} FROM project_events WHERE projectId = @projectId AND id < @before AND (@actor IS NULL OR actor = @actor) ORDER BY id DESC LIMIT @limit`),
  eventsByActor: db.prepare(`SELECT ${EVENT_LIST()} FROM project_events WHERE projectId = @projectId AND actor = @actor AND undoneBy IS NULL ORDER BY id DESC`),
  // Has anyone else changed this entity since the given event? Undos of this
  // actor's own events do not count, and neither do moves and notifications,
  // which leave the entity's content alone.
  foreignAfter: db.prepare(`SELECT 1 FROM project_events
    WHERE projectId = @projectId AND entity = @entity AND entityId = @entityId AND id > @id AND actor != @actor
      AND action NOT IN ('tab.move', 'notify')
      AND NOT (action = 'undo' AND undoOf IN (SELECT id FROM project_events WHERE projectId = @projectId AND actor = @actor))
    LIMIT 1`),
}

// sortOrder is never restored: a move is not undoable and bumps no rev, so an
// undo that copied the old position back would silently revert a later move.
// A project event restores only the columns it changed (see undoEvent), so
// these are the ones it may.
const RESTORE: Record<Restorable, { get: typeof q.tab; save: typeof q.tabSave; cols: string[] }> = {
  project: {
    get: q.project, save: q.projectSave,
    cols: ['name', 'summary', 'nextAction', 'status', 'area', 'targetKey', 'exposure', 'allowSnapshots', 'sessionEdits'],
  },
  tab: { get: q.tab, save: q.tabSave, cols: ['title', 'body', 'items', 'deletedAt'] },
  file: { get: q.file, save: q.fileSave, cols: ['label', 'note', 'relPath', 'url', 'deletedAt'] },
  automation: { get: q.automation, save: q.automationSave, cols: ['kind', 'name', 'description', 'body', 'model', 'deletedAt'] },
}
const NOT_UNDOABLE = new Set(['project.create', 'project.archive', 'tab.move', 'undo', 'notify'])
const isRestorable = (e: string): e is Restorable => e in RESTORE
const undoableRow = (e: Pick<EventRow, 'entity' | 'action' | 'undoneBy'>) =>
  isRestorable(e.entity) && !NOT_UNDOABLE.has(e.action) && e.undoneBy == null

// --------------------------------------------------------------- mappers ----

const now = () => new Date().toISOString()
// Reminder times are stored the way lilkups is handed them, so comparisons in
// SQL are plain string comparisons in one format.
const atFormat = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
const DAY_MS = 86_400_000

function parseItems(json: string): (ChecklistItem | LinkItem)[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v as (ChecklistItem | LinkItem)[] : []
  } catch {
    return []
  }
}

const projectFrom = (r: ProjectRow): Project => ({ ...r, allowSnapshots: r.allowSnapshots === 1, sessionEdits: r.sessionEdits === 1 })

const tabFrom = (r: TabRow): Tab => ({
  id: r.id, projectId: r.projectId, kind: r.kind, title: r.title,
  body: r.kind === 'markdown' ? r.body : '',
  items: (r.kind === 'markdown' ? [] : parseItems(r.items)) as ChecklistItem[] | LinkItem[],
  sortOrder: r.sortOrder, rev: r.rev,
  createdBy: r.createdBy, updatedBy: r.updatedBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
})

const fileFrom = (r: FileListRow): FileRef => ({ ...r, hasContent: r.hasContent === 1 })

const automationFrom = (r: AutomationRow): Automation => ({
  id: r.id, projectId: r.projectId, kind: r.kind, key: r.key, name: r.name, description: r.description,
  model: r.model, bodyPreview: r.body.slice(0, 280), rev: r.rev, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
  body: r.body, createdBy: r.createdBy, createdAt: r.createdAt,
})

const runFrom = (r: RunRow): Run => ({
  id: r.id, projectId: r.projectId, automationKey: r.automationKey, kind: r.kind, name: r.name, model: r.model,
  sessionId: r.sessionId, tmuxName: r.tmuxName, status: r.status, summary: r.summary,
  startedBy: r.startedBy, startedAt: r.startedAt, briefFetchedAt: r.briefFetchedAt, endedAt: r.endedAt,
})

const sessionFrom = (r: SessionRow): SessionLink => ({
  sessionId: r.sessionId, launchSessionId: r.launchSessionId, host: r.host, tmuxName: r.tmuxName, mode: r.mode,
  runId: r.runId, linkedVia: r.linkedVia, statusNote: r.statusNote, statusAt: r.statusAt, linkedBy: r.linkedBy, linkedAt: r.linkedAt,
})

const reminderFrom = (r: ReminderRow, state: ReminderState): Reminder => ({
  id: r.id, at: r.at, message: r.message, state, createdBy: r.createdBy, createdAt: r.createdAt, canceledAt: r.canceledAt,
})

const eventFrom = (r: EventListRow): ProjectEvent => ({
  id: r.id, at: r.at, actor: r.actor, via: r.via, action: r.action, entity: r.entity, entityId: r.entityId,
  summary: r.summary, undoable: undoableRow(r), undoOf: r.undoOf, undoneBy: r.undoneBy,
})

// -------------------------------------------------------------- validation ----

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

// 'line' is a one-line field (titles, labels, names), 'text' a trimmed
// paragraph, 'raw' a body whose leading whitespace is markdown and must stay.
type TextMode = 'line' | 'text' | 'raw'

function text(field: string, v: unknown, max: number, mode: TextMode, required = false): string {
  if (typeof v !== 'string') throw new ProjError(400, `${field} must be text`)
  let s = v.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').normalize('NFC')
  if (mode === 'line') s = s.replace(/[\n\t]+/g, ' ').trim()
  else if (mode === 'text') s = s.trim()
  if (required && !s.trim()) throw new ProjError(400, `${field} is required`)
  if (s.length > max) throw new ProjError(400, `${field} is longer than ${max} characters`)
  return s
}

// For text this process wrote itself (error messages, notification titles):
// cleaned and cut, never refused.
const soft = (s: unknown, max: number) => clip(String(s ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim(), max)

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 3) + '...' : s)
const quoted = (s: string) => `'${clip(s, 40)}'`

const keyOf = (field: string, v: unknown): string => {
  if (typeof v !== 'string' || !KEY_RE.test(v)) throw new ProjError(400, `${field} must be lowercase letters, digits and dashes, 32 at most`)
  return v
}

const areaOf = (v: unknown): Area => {
  if (!AREAS.includes(v as Area)) throw new ProjError(400, `area must be one of ${AREAS.join(', ')}`)
  return v as Area
}

// Client-area projects hold client material: hidden from Cloudflare requests
// and refusing file contents unless Brendon turns that on.
const areaDefaults = (area: Area): { exposure: Exposure; allowSnapshots: number } =>
  isClientArea(area) ? { exposure: 'tailnet', allowSnapshots: 0 } : { exposure: 'anywhere', allowSnapshots: 1 }

// An area dropped from PROJECT_EXTRA_AREAS still has its projects: they sort last.
const areaRank = (area: Area): number => {
  const i = AREAS.indexOf(area)
  return i < 0 ? AREAS.length : i
}

const flag = (field: string, v: unknown): number => {
  if (typeof v !== 'boolean') throw new ProjError(400, `${field} must be true or false`)
  return v ? 1 : 0
}

const REL_BAD_RE = /[<>"|?*\u0000-\u001f\u007f]/
const REL_RULES = "relPath must be relative to the project folder: no drive, no leading slash, no '..' and none of <>\"|?*"

// Relative to the project's launch-target folder on thor, which this box never
// learns. Separators are folded to '/' so the same file pinned as a\b and a/b
// is one row, which is what lets a session refresh a snapshot by re-pinning.
function relPathOf(v: unknown): string {
  if (typeof v !== 'string') throw new ProjError(400, 'relPath must be text')
  const s = v.normalize('NFC').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '')
  if (!s) throw new ProjError(400, 'relPath is required')
  if (s.length > LIMITS.relPath) throw new ProjError(400, `relPath is longer than ${LIMITS.relPath} characters`)
  if (s.startsWith('/') || s.startsWith('~') || s.includes(':') || s.split('/').includes('..') || REL_BAD_RE.test(s)) {
    throw new ProjError(400, REL_RULES)
  }
  return s
}

const LOCAL_PATH_RE = /^\/[A-Za-z0-9/_.?=&%#-]*$/

function urlOf(field: string, v: unknown, allowMailto: boolean): string {
  const s = text(field, v, LIMITS.url, 'line', true)
  // '//host' passes the path pattern but is a protocol-relative link to
  // another site, so it is not a same-origin path.
  if (LOCAL_PATH_RE.test(s) && !s.startsWith('//')) return s
  let u: URL | null = null
  try { u = new URL(s) } catch { /* not absolute */ }
  if (u && (u.protocol === 'http:' || u.protocol === 'https:' || (allowMailto && u.protocol === 'mailto:'))) return s
  throw new ProjError(400, `${field} must be an http or https link${allowMailto ? ', a mailto: address' : ''} or a /path on this site`)
}

const TAB_KINDS: TabKind[] = ['markdown', 'checklist', 'links']
const FILE_KINDS: FileKind[] = ['path', 'url', 'doc']
const MODELS: Model[] = ['', 'opus', 'sonnet', 'haiku']
const LINKED_VIA: LinkedVia[] = ['launch', 'resume', 'link', 'clear', 'startup']
const MODES = ['', 'new', 'resume', 'shell']
const TMUX_NAME_RE = /^vk-[0-9a-f]{10}$/
// Lines appended to a checklist usually arrive as a markdown list.
const LIST_MARK_RE = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/

const newCheckItem = (t: string): ChecklistItem => ({ id: randomUUID().slice(0, 8), text: t, done: false, doneAt: null })

function newLinkItem(label: unknown, url: unknown): LinkItem {
  return { id: randomUUID().slice(0, 8), label: text('label', label, LIMITS.linkLabel, 'line', true), url: urlOf('url', url, true) }
}

const itemName = (it: ChecklistItem | LinkItem) => ('text' in it ? it.text : it.label)

// ------------------------------------------------------------ rate limits ----

// A session stuck in a loop can rewrite a page faster than anyone reads it.
// These caps keep the damage to what one revert-by-session can take back.
// In memory on purpose: a restart forgets them, which is harmless.
const RULES = {
  sessionWrite: { max: 30, windowMs: 60_000 },
  sessionRemove: { max: 10, windowMs: 600_000 },
  notify: { max: 5, windowMs: 600_000 },
  hook: { max: 30, windowMs: 60_000 },
}
type Bucket = keyof typeof RULES
type Kind = 'write' | 'remove' | 'notify'
const hits = new Map<string, number[]>()

const isSession = (actor: string) => actor.startsWith('session:')

function rateLimit(projectId: string, actor: string, kind: Kind): void {
  const buckets: Bucket[] = []
  if (isSession(actor)) {
    buckets.push('sessionWrite')
    if (kind === 'remove') buckets.push('sessionRemove')
  } else if (actor.startsWith('hook:')) {
    buckets.push('hook')
  }
  if (kind === 'notify') buckets.push('notify')
  if (!buckets.length) return
  const t = Date.now()
  const lists = buckets.map((b) => {
    const key = `${projectId}|${b}`
    const list = (hits.get(key) ?? []).filter((at) => t - at < RULES[b].windowMs)
    hits.set(key, list)
    return { b, list }
  })
  const full = lists.find(({ b, list }) => list.length >= RULES[b].max)
  if (full) {
    throw new ProjError(429, full.b === 'notify'
      ? 'too many notifications from this project; try again in a few minutes'
      : 'too many changes from sessions in this project; try again in a minute')
  }
  for (const { list } of lists) list.push(t)
}

// ---------------------------------------------------------------- mutate ----

type Draft = {
  action: string; entity: EventEntity; entityId: string; summary: string
  before: unknown; after: unknown; undoOf?: number
}
type Step<T> = { result: T; event: Draft | null }

function access(projectId: string, ctx: Ctx): ProjectRow {
  const row = (typeof projectId === 'string' ? q.project.get({ id: projectId }) : undefined) as ProjectRow | undefined
  if (!row || (row.status === 'archived' && ctx.actor !== 'ui')) throw new ProjError(404, 'no such project')
  if (isSession(ctx.actor) && !row.sessionEdits) throw new ProjError(403, 'session edits are off for this project')
  return row
}

// Event images are whole rows, minus what would bloat a log of 1,000: file
// content (up to 256 KB) and run briefs. Undo restores neither.
function snapshot(entity: EventEntity, row: unknown): string | null {
  if (row == null) return null
  if (entity === 'file') {
    const { content: _c, contentBytes: _b, contentType: _t, capturedAt: _a, ...rest } = row as FileRow
    return JSON.stringify(rest)
  }
  if (entity === 'run') {
    const { brief: _b, ...rest } = row as RunRow
    return JSON.stringify(rest)
  }
  return JSON.stringify(row)
}

const bump = (projectId: string) => q.projectBump.run({ id: projectId, now: now() })

// Inside a transaction only.
function record(projectId: string, ctx: Ctx, ev: Draft | null): void {
  if (ev) {
    const info = q.eventInsert.run({
      projectId, at: now(), actor: ctx.actor, via: ctx.via, action: ev.action, entity: ev.entity, entityId: ev.entityId,
      summary: clip(ev.summary, 120), before: snapshot(ev.entity, ev.before), after: snapshot(ev.entity, ev.after),
      undoOf: ev.undoOf ?? null, undoneBy: null,
    })
    if (ev.undoOf != null) q.eventUndone.run({ id: ev.undoOf, undoneBy: Number(info.lastInsertRowid) })
    q.eventPrune.run({ projectId })
  }
  bump(projectId)
}

function apply<T>(projectId: string, ctx: Ctx, fn: () => Step<T>): T {
  const result = db.transaction(() => {
    const step = fn()
    record(projectId, ctx, step.event)
    return step.result
  })()
  emitter.emit('change', projectId)
  return result
}

function mutate<T>(projectId: string, ctx: Ctx, kind: Kind, fn: (p: Project) => Step<T>): T {
  const p = projectFrom(access(projectId, ctx))
  rateLimit(projectId, ctx.actor, kind)
  return apply(projectId, ctx, () => fn(p))
}

// A change with no actor behind it (a run's own bookkeeping): the page still
// has to see it, so the rev moves, but there is nothing to attribute or undo.
function touch(projectId: string, fn: () => number): void {
  const changed = db.transaction(() => {
    const n = fn()
    if (n) bump(projectId)
    return n
  })()
  if (changed) emitter.emit('change', projectId)
}

// -------------------------------------------------------------- projects ----

export function getProject(id: string): Project | null {
  const row = (typeof id === 'string' ? q.project.get({ id }) : undefined) as ProjectRow | undefined
  return row ? projectFrom(row) : null
}

const lastEventOf = (projectId: string): ProjectEvent | null => {
  const row = q.lastEvent.get({ projectId }) as EventListRow | undefined
  return row ? eventFrom(row) : null
}

export function listProjects(opts?: { includeArchived?: boolean }): ProjectSummary[] {
  const rows = (q.projectsAll.all() as ProjectRow[]).filter((r) => opts?.includeArchived || r.status !== 'archived')
  const sessionIds = new Map<string, string[]>()
  for (const s of q.sessionIdsAll.all() as { projectId: string; sessionId: string }[]) {
    const list = sessionIds.get(s.projectId) ?? []
    list.push(s.sessionId)
    sessionIds.set(s.projectId, list)
  }
  const next = new Map((q.nextReminders.all({ now: atFormat(Date.now()) }) as { projectId: string; next: string }[]).map((r) => [r.projectId, r.next]))
  const last = new Map((q.lastEvents.all() as EventListRow[]).map((e) => [e.projectId, eventFrom(e)]))
  return rows
    .sort((a, b) => areaRank(a.area) - areaRank(b.area) || a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => ({
      id: r.id, name: r.name, area: r.area, status: r.status, summary: r.summary, nextAction: r.nextAction,
      targetKey: r.targetKey, exposure: r.exposure, sessionIds: sessionIds.get(r.id) ?? [],
      nextReminderAt: next.get(r.id) ?? null, updatedAt: r.updatedAt, rev: r.rev, lastEvent: last.get(r.id) ?? null,
    }))
}

export async function getProjectDoc(id: string): Promise<ProjectDoc> {
  // The one await comes first, so everything below reads one consistent state.
  const states = await readLilkupsStates()
  const row = (typeof id === 'string' ? q.project.get({ id }) : undefined) as ProjectRow | undefined
  if (!row) throw new ProjError(404, 'no such project')
  const t = Date.now()
  const reminders = (q.remindersRecent.all({
    projectId: id, canceledCut: new Date(t - 30 * DAY_MS).toISOString(), atCut: atFormat(t - 30 * DAY_MS),
  }) as ReminderRow[]).map((r) => {
    const state: ReminderState = r.canceledAt ? 'canceled'
      : states.get(r.lilkupsId) ?? (Date.parse(r.at) < t ? 'gone' : 'pending')
    return reminderFrom(r, state)
  })
  const pending = reminders.filter((r) => r.state === 'pending').sort((a, b) => a.at.localeCompare(b.at))
  const rest = reminders.filter((r) => r.state !== 'pending').sort((a, b) => b.at.localeCompare(a.at))
  return {
    project: projectFrom(row),
    tabs: (q.tabsLive.all({ projectId: id }) as TabRow[]).map(tabFrom),
    files: (q.filesLive.all({ projectId: id }) as FileListRow[]).map(fileFrom),
    automations: q.automationsLive.all({ projectId: id }) as AutomationSummary[],
    runs: q.runsRecent.all({ projectId: id }) as Run[],
    sessions: (q.sessions.all({ projectId: id }) as SessionRow[]).map(sessionFrom),
    reminders: [...pending, ...rest],
    lastEvent: lastEventOf(id),
  }
}

function slug(name: string): string {
  const s = name.normalize('NFKD').toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return s || 'project'
}

function freeSlug(name: string): string {
  const base = slug(name)
  if (!q.project.get({ id: base })) return base
  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`
    const id = base.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix
    if (!q.project.get({ id })) return id
  }
  throw new ProjError(409, 'project id taken')
}

export function createProject(input: NewProjectInput, ctx: Ctx): Project {
  const inp = (input ?? {}) as Partial<NewProjectInput>
  const name = text('name', inp.name, LIMITS.projectName, 'line', true)
  const area = areaOf(inp.area)
  const targetKey = keyOf('targetKey', inp.targetKey)
  const summary = inp.summary == null ? '' : text('summary', inp.summary, LIMITS.summary, 'text')
  let id: string
  if (inp.id != null && inp.id !== '') {
    id = keyOf('id', inp.id)
    if (q.project.get({ id })) throw new ProjError(409, 'project id taken')
  } else {
    id = freeSlug(name)
  }
  const t = now()
  const d = areaDefaults(area)
  const row: ProjectRow = {
    id, name, area, targetKey, summary, nextAction: '', status: 'active', exposure: d.exposure,
    allowSnapshots: d.allowSnapshots, sessionEdits: 1, sortOrder: 0, rev: 0, metaRev: 1, createdAt: t, updatedAt: t,
  }
  const notes: TabRow = {
    id: randomUUID(), projectId: id, kind: 'markdown', title: 'notes', body: '', items: '[]', sortOrder: 0, rev: 1,
    deletedAt: null, createdBy: ctx.actor, updatedBy: ctx.actor, createdAt: t, updatedAt: t,
  }
  db.transaction(() => {
    q.projectInsert.run(row)
    q.tabInsert.run(notes)
    record(id, ctx, { action: 'project.create', entity: 'project', entityId: id, summary: 'created the project', before: null, after: row })
  })()
  emitter.emit('change', id)
  return getProject(id) as Project
}

const SETTINGS = new Set(['area', 'targetKey', 'exposure', 'sessionEdits', 'allowSnapshots'])

function projectSummary(next: ProjectRow, changed: string[]): string {
  if (changed.includes('name')) return `renamed the project to ${quoted(next.name)}`
  if (changed.length === 1 && changed[0] === 'nextAction') {
    return next.nextAction ? `set the next action to ${quoted(next.nextAction)}` : 'cleared the next action'
  }
  if (changed.length === 1 && changed[0] === 'summary') return 'edited the summary'
  if (changed.includes('status')) return next.status === 'paused' ? 'paused the project' : `set the project ${next.status}`
  return 'changed the project settings'
}

export function updateProject(id: string, patch: ProjectPatch, ctx: Ctx): Project {
  const pt = (patch ?? {}) as ProjectPatch
  mutate(id, ctx, 'write', () => {
    const before = q.project.get({ id }) as ProjectRow
    const next: ProjectRow = { ...before }
    if (pt.name !== undefined) next.name = text('name', pt.name, LIMITS.projectName, 'line', true)
    if (pt.summary !== undefined) next.summary = text('summary', pt.summary, LIMITS.summary, 'text')
    if (pt.nextAction !== undefined) next.nextAction = text('next action', pt.nextAction, LIMITS.nextAction, 'line')
    if (pt.status !== undefined) {
      if (pt.status !== 'active' && pt.status !== 'paused') throw new ProjError(400, 'status must be active or paused')
      next.status = pt.status
    }
    if (pt.area !== undefined) {
      next.area = areaOf(pt.area)
      // A project moved into a client area must not keep the looser
      // exposure it was created with. Explicit values below still win. A
      // session only ever tightens: moving a client project out of its area
      // keeps it hidden until Brendon loosens it on the page.
      if (next.area !== before.area && (ctx.actor === 'ui' || isClientArea(next.area))) {
        Object.assign(next, areaDefaults(next.area))
      }
    }
    if (pt.targetKey !== undefined) next.targetKey = keyOf('targetKey', pt.targetKey)
    if (pt.exposure !== undefined) {
      if (pt.exposure !== 'tailnet' && pt.exposure !== 'anywhere') throw new ProjError(400, 'exposure must be tailnet or anywhere')
      next.exposure = pt.exposure
    }
    if (pt.sessionEdits !== undefined) next.sessionEdits = flag('sessionEdits', pt.sessionEdits)
    if (pt.allowSnapshots !== undefined) next.allowSnapshots = flag('allowSnapshots', pt.allowSnapshots)
    const changed = (Object.keys(next) as (keyof ProjectRow)[]).filter((k) => next[k] !== before[k])
    if (!changed.length) return { result: undefined, event: null }
    // Sessions set up projects, so they may pick the area and folder. Who can
    // see the project and whether sessions may edit it stay with the page:
    // those are the brakes on sessions themselves.
    if (ctx.actor !== 'ui' && (pt.exposure !== undefined || pt.sessionEdits !== undefined || pt.allowSnapshots !== undefined)) {
      throw new ProjError(403, 'only the project page can change exposure, file contents or session edits')
    }
    next.metaRev = before.metaRev + 1
    q.projectSave.run(next)
    const dropped = dropContentsIfOff(id, before, next)
    const summary = projectSummary(next, changed) + (dropped ? ` and dropped ${dropped} stored file content${dropped === 1 ? '' : 's'}` : '')
    return {
      result: undefined,
      event: { action: 'project.update', entity: 'project', entityId: id, summary, before, after: next },
    }
  })
  return getProject(id) as Project
}

// Turning file contents off (directly, or by moving the project into a client
// area) must not leave the contents captured while it was on: the switch
// promises that no file contents are stored for the project. Event images
// never hold content, so this cannot be undone. Inside a transaction only.
function dropContentsIfOff(id: string, before: Pick<ProjectRow, 'allowSnapshots'>, next: Pick<ProjectRow, 'allowSnapshots'>): number {
  if (!(before.allowSnapshots === 1 && next.allowSnapshots === 0)) return 0
  return q.fileContentsDrop.run({ projectId: id }).changes
}

// Work and every extra area are client areas. Only personal and server may
// mix, and only they leave odin with full text.
export function isClientArea(area: Area): boolean {
  return !MIXABLE_AREAS.includes(area)
}

export function archiveProject(id: string, ctx: Ctx): void {
  if (ctx.actor !== 'ui') throw new ProjError(403, 'only the project page can archive a project')
  mutate(id, ctx, 'write', () => {
    const before = q.project.get({ id }) as ProjectRow
    if (before.status === 'archived') return { result: undefined, event: null }
    const next: ProjectRow = { ...before, status: 'archived', metaRev: before.metaRev + 1 }
    q.projectSave.run(next)
    return { result: undefined, event: { action: 'project.archive', entity: 'project', entityId: id, summary: 'archived the project', before, after: next } }
  })
}

// ------------------------------------------------------------------ tabs ----

function liveTab(projectId: string, tabId: unknown): TabRow {
  const row = (typeof tabId === 'string' ? q.tab.get({ id: tabId, projectId }) : undefined) as TabRow | undefined
  if (!row || row.deletedAt) throw new ProjError(404, 'no such tab')
  return row
}

export function getTab(id: string, tabId: string): Tab {
  return tabFrom(liveTab(id, tabId))
}

export function addTab(id: string, input: NewTabInput, ctx: Ctx): Tab {
  return mutate(id, ctx, 'write', () => {
    const inp = (input ?? {}) as Partial<NewTabInput>
    const kind = inp.kind as TabKind
    if (!TAB_KINDS.includes(kind)) throw new ProjError(400, 'kind must be markdown, checklist or links')
    const title = text('title', inp.title, LIMITS.tabTitle, 'line', true)
    const live = q.tabsLive.all({ projectId: id }) as TabRow[]
    if (live.length >= LIMITS.tabsPerProject) throw new ProjError(400, `a project has at most ${LIMITS.tabsPerProject} tabs`)
    let body = ''
    let items: (ChecklistItem | LinkItem)[] = []
    if (kind === 'markdown') {
      if (Array.isArray(inp.items) && inp.items.length) throw new ProjError(400, 'markdown tabs take a body, not items')
      if (inp.body != null) body = text('body', inp.body, LIMITS.tabBody, 'raw')
    } else {
      if (inp.body) throw new ProjError(400, `${kind} tabs take items, not a body`)
      if (inp.items != null && !Array.isArray(inp.items)) throw new ProjError(400, 'items must be a list')
      const raw = (inp.items ?? []) as unknown[]
      if (raw.length > LIMITS.itemsPerTab) throw new ProjError(400, `a tab holds at most ${LIMITS.itemsPerTab} items`)
      if (kind === 'checklist') {
        for (const v of raw) {
          if (typeof v !== 'string') throw new ProjError(400, 'checklist items must be text')
          const t = text('item text', v, LIMITS.checklistText, 'line')
          if (t) items.push(newCheckItem(t))
        }
      } else {
        items = raw.map((v) => {
          const o = (v ?? {}) as { label?: unknown; url?: unknown }
          return newLinkItem(o.label, o.url)
        })
      }
    }
    const orders = live.map((r) => r.sortOrder)
    const sortOrder = !orders.length ? 0 : inp.position === 'start' ? Math.min(...orders) - 1 : Math.max(...orders) + 1
    const t = now()
    const row: TabRow = {
      id: randomUUID(), projectId: id, kind, title, body, items: JSON.stringify(items), sortOrder, rev: 1, deletedAt: null,
      createdBy: ctx.actor, updatedBy: ctx.actor, createdAt: t, updatedAt: t,
    }
    q.tabInsert.run(row)
    return { result: tabFrom(row), event: { action: 'tab.add', entity: 'tab', entityId: row.id, summary: `added tab ${quoted(title)}`, before: null, after: row } }
  })
}

export function updateTab(id: string, tabId: string, patch: TabPatch, ctx: Ctx): Tab {
  return mutate(id, ctx, 'write', () => {
    const before = liveTab(id, tabId)
    const pt = (patch ?? {}) as TabPatch
    const replacing = pt.title !== undefined || pt.body !== undefined
    const baseRev = pt.baseRev ?? undefined
    if (baseRev !== undefined && !Number.isInteger(baseRev)) throw new ProjError(400, 'baseRev must be a whole number')
    if (replacing && baseRev !== undefined && baseRev !== before.rev) {
      throw new ProjError(409, 'changed since', { current: tabFrom(before) })
    }
    // A session replacing text it read a while ago would silently drop
    // whatever changed in between, so it has to say which version it read.
    if (replacing && baseRev === undefined && isSession(ctx.actor)) {
      throw new ProjError(400, 'pass baseRev (the tab rev from tab_get) to replace a title or body; use tab_append to add text')
    }
    if (!replacing && pt.appendBody === undefined) throw new ProjError(400, 'nothing to change')
    const next: TabRow = { ...before }
    if (pt.title !== undefined) next.title = text('title', pt.title, LIMITS.tabTitle, 'line', true)
    if (pt.body !== undefined) {
      if (before.kind !== 'markdown') throw new ProjError(400, 'only markdown tabs have a body; use tab_item or tab_append for items')
      next.body = text('body', pt.body, LIMITS.tabBody, 'raw')
    }
    if (pt.appendBody !== undefined) {
      const add = text('text', pt.appendBody, LIMITS.appendText, 'raw', true)
      if (before.kind === 'markdown') {
        next.body = next.body ? `${next.body}\n\n${add}` : add
      } else if (before.kind === 'checklist') {
        const items = parseItems(next.items)
        for (const line of add.split('\n')) {
          const t = line.trim().replace(LIST_MARK_RE, '')
          if (t) items.push(newCheckItem(text('item text', t, LIMITS.checklistText, 'line')))
        }
        next.items = JSON.stringify(items)
      } else {
        throw new ProjError(400, 'links tabs do not take appended text; use tab_item to add a link')
      }
    }
    if (next.body.length > LIMITS.tabBody) throw new ProjError(400, `body is longer than ${LIMITS.tabBody} characters`)
    if (parseItems(next.items).length > LIMITS.itemsPerTab) throw new ProjError(400, `a tab holds at most ${LIMITS.itemsPerTab} items`)
    next.rev = before.rev + 1
    next.updatedBy = ctx.actor
    next.updatedAt = now()
    q.tabSave.run(next)
    const event: Draft = replacing
      ? { action: 'tab.update', entity: 'tab', entityId: before.id, summary: `edited tab ${quoted(next.title)}`, before, after: next }
      : { action: 'tab.append', entity: 'tab', entityId: before.id, summary: `appended to ${quoted(next.title)}`, before, after: next }
    return { result: tabFrom(next), event }
  })
}

export function moveTab(id: string, tabId: string, toIndex: number, ctx: Ctx): void {
  mutate(id, ctx, 'write', () => {
    const tab = liveTab(id, tabId)
    if (!Number.isInteger(toIndex) || toIndex < 0) throw new ProjError(400, 'toIndex must be a whole number, 0 or more')
    const order = (q.tabsLive.all({ projectId: id }) as TabRow[]).filter((r) => r.id !== tab.id)
    order.splice(Math.min(toIndex, order.length), 0, tab)
    // sortOrder only, rev untouched: a move is not an edit, and bumping rev
    // would turn a session's in-flight baseRev into a false conflict.
    order.forEach((r, i) => { if (r.sortOrder !== i) q.tabSort.run({ id: r.id, sortOrder: i }) })
    const after = { ...tab, sortOrder: order.indexOf(tab) }
    return { result: undefined, event: { action: 'tab.move', entity: 'tab', entityId: tab.id, summary: `moved tab ${quoted(tab.title)}`, before: tab, after } }
  })
}

export function removeTab(id: string, tabId: string, ctx: Ctx): void {
  mutate(id, ctx, 'remove', () => {
    const before = liveTab(id, tabId)
    const t = now()
    const next: TabRow = { ...before, deletedAt: t, rev: before.rev + 1, updatedBy: ctx.actor, updatedAt: t }
    q.tabSave.run(next)
    return { result: undefined, event: { action: 'tab.remove', entity: 'tab', entityId: before.id, summary: `removed tab ${quoted(before.title)}`, before, after: next } }
  })
}

export function tabItem(id: string, tabId: string, op: TabItemOp, ctx: Ctx): Tab {
  const o = (op ?? {}) as Record<string, unknown>
  return mutate(id, ctx, o.op === 'remove' ? 'remove' : 'write', () => {
    const before = liveTab(id, tabId)
    if (before.kind === 'markdown') throw new ProjError(400, 'markdown tabs have no items; use tab_update or tab_append')
    const check = before.kind === 'checklist'
    const items = parseItems(before.items)
    const find = (): number => {
      const i = typeof o.itemId === 'string' ? items.findIndex((x) => x.id === o.itemId) : -1
      if (i < 0) throw new ProjError(404, 'no such item')
      return i
    }
    let summary: string
    switch (o.op) {
      case 'add': {
        if (items.length >= LIMITS.itemsPerTab) throw new ProjError(400, `a tab holds at most ${LIMITS.itemsPerTab} items`)
        const it = check ? newCheckItem(text('text', o.text, LIMITS.checklistText, 'line', true)) : newLinkItem(o.label, o.url)
        items.push(it)
        summary = `added ${quoted(itemName(it))} to ${quoted(before.title)}`
        break
      }
      case 'set': {
        if (!check) throw new ProjError(400, 'only checklist items can be checked')
        if (typeof o.done !== 'boolean') throw new ProjError(400, 'done must be true or false')
        const i = find()
        const it = items[i] as ChecklistItem
        items[i] = { ...it, done: o.done, doneAt: o.done ? (it.done ? it.doneAt : now()) : null }
        summary = `${o.done ? 'checked' : 'unchecked'} ${quoted(it.text)} in ${quoted(before.title)}`
        break
      }
      case 'edit': {
        const i = find()
        if (check) {
          const it = items[i] as ChecklistItem
          if (o.text !== undefined) items[i] = { ...it, text: text('text', o.text, LIMITS.checklistText, 'line', true) }
        } else {
          const it = items[i] as LinkItem
          items[i] = {
            ...it,
            label: o.label === undefined ? it.label : text('label', o.label, LIMITS.linkLabel, 'line', true),
            url: o.url === undefined ? it.url : urlOf('url', o.url, true),
          }
        }
        summary = `edited ${quoted(itemName(items[i]))} in ${quoted(before.title)}`
        break
      }
      case 'remove': {
        const [it] = items.splice(find(), 1)
        summary = `removed ${quoted(itemName(it))} from ${quoted(before.title)}`
        break
      }
      default:
        throw new ProjError(400, 'op must be add, set, edit or remove')
    }
    const next: TabRow = { ...before, items: JSON.stringify(items), rev: before.rev + 1, updatedBy: ctx.actor, updatedAt: now() }
    q.tabSave.run(next)
    return { result: tabFrom(next), event: { action: 'tab.item', entity: 'tab', entityId: before.id, summary, before, after: next } }
  })
}

// ----------------------------------------------------------------- files ----

function liveFile(projectId: string, fileId: unknown): FileRow {
  const row = (typeof fileId === 'string' ? q.file.get({ id: fileId, projectId }) : undefined) as FileRow | undefined
  if (!row || row.deletedAt) throw new ProjError(404, 'no such file')
  return row
}

const fileRef = (fileId: string): FileRef => fileFrom(q.fileRef.get({ id: fileId }) as FileListRow)

type Snap = Pick<FileRow, 'content' | 'contentType' | 'contentBytes' | 'capturedAt'>

function snapOf(p: Project, content: unknown, type: unknown, fallback: 'markdown' | 'text'): Snap {
  if (!p.allowSnapshots) throw new ProjError(403, 'file contents are off for this project; pin the path or a link instead')
  const c = text('content', content, LIMITS.fileContent, 'raw')
  if (type != null && type !== 'markdown' && type !== 'text') throw new ProjError(400, 'contentType must be markdown or text')
  return { content: c, contentType: (type ?? fallback) as 'markdown' | 'text', contentBytes: Buffer.byteLength(c), capturedAt: now() }
}

export function pinFile(id: string, input: PinFileInput, ctx: Ctx): FileRef {
  return mutate(id, ctx, 'write', (p) => {
    const inp = (input ?? {}) as Partial<PinFileInput>
    const kind = inp.kind as FileKind
    if (!FILE_KINDS.includes(kind)) throw new ProjError(400, 'kind must be path, url or doc')
    const label = text('label', inp.label, LIMITS.fileLabel, 'line', true)
    const note = inp.note == null ? null : text('note', inp.note, LIMITS.fileNote, 'text')
    if (kind === 'doc' && inp.content == null) throw new ProjError(400, 'a doc needs content')
    const relPath = kind === 'path' ? relPathOf(inp.relPath) : null
    const url = kind === 'url' ? urlOf('url', inp.url, false) : null
    const fallback = kind === 'doc' || /\.(md|markdown)$/i.test(relPath ?? '') ? 'markdown' : 'text'
    const snap = inp.content == null ? null : snapOf(p, inp.content, inp.contentType, fallback)
    const t = now()
    const existing = relPath ? q.fileByPath.get({ projectId: id, relPath }) as FileRow | undefined : undefined
    let before: FileRow | null = null
    let next: FileRow
    if (existing) {
      // Re-pinning is how a session refreshes a snapshot. Without new content
      // the old snapshot stays: a re-pin to fix a label must not drop it.
      before = existing
      next = { ...existing, ...(snap ?? {}), label, note: note ?? existing.note, rev: existing.rev + 1, updatedBy: ctx.actor, updatedAt: t }
      q.fileSave.run(next)
    } else {
      const stats = q.fileStats.get({ projectId: id }) as { n: number; maxSort: number }
      if (stats.n >= LIMITS.filesPerProject) throw new ProjError(400, `a project has at most ${LIMITS.filesPerProject} pinned files`)
      next = {
        id: randomUUID(), projectId: id, kind, label, relPath, url, note: note ?? '',
        content: snap?.content ?? null, contentType: snap?.contentType ?? null, contentBytes: snap?.contentBytes ?? null, capturedAt: snap?.capturedAt ?? null,
        sortOrder: stats.maxSort + 1, rev: 1, deletedAt: null, createdBy: ctx.actor, updatedBy: ctx.actor, createdAt: t, updatedAt: t,
      }
      q.fileInsert.run(next)
    }
    return {
      result: fileRef(next.id),
      event: { action: 'file.pin', entity: 'file', entityId: next.id, summary: `pinned ${relPath ?? url ?? label}`, before, after: next },
    }
  })
}

export function updateFile(id: string, fileId: string, patch: FilePatch, ctx: Ctx): FileRef {
  return mutate(id, ctx, 'write', (p) => {
    const before = liveFile(id, fileId)
    const pt = (patch ?? {}) as FilePatch
    const next: FileRow = { ...before }
    if (pt.label !== undefined) next.label = text('label', pt.label, LIMITS.fileLabel, 'line', true)
    if (pt.note !== undefined) next.note = text('note', pt.note, LIMITS.fileNote, 'text')
    if (pt.content !== undefined) {
      Object.assign(next, snapOf(p, pt.content, pt.contentType, before.contentType ?? (before.kind === 'doc' ? 'markdown' : 'text')))
    } else if (pt.contentType !== undefined) {
      if (before.content == null) throw new ProjError(400, 'this file has no content to retype')
      if (pt.contentType !== 'markdown' && pt.contentType !== 'text') throw new ProjError(400, 'contentType must be markdown or text')
      next.contentType = pt.contentType
    }
    next.rev = before.rev + 1
    next.updatedBy = ctx.actor
    next.updatedAt = now()
    q.fileSave.run(next)
    return { result: fileRef(next.id), event: { action: 'file.update', entity: 'file', entityId: next.id, summary: `edited pin ${quoted(next.label)}`, before, after: next } }
  })
}

export function unpinFile(id: string, fileId: string, ctx: Ctx): void {
  mutate(id, ctx, 'remove', () => {
    const before = liveFile(id, fileId)
    const t = now()
    const next: FileRow = { ...before, deletedAt: t, rev: before.rev + 1, updatedBy: ctx.actor, updatedAt: t }
    q.fileSave.run(next)
    return { result: undefined, event: { action: 'file.unpin', entity: 'file', entityId: before.id, summary: `unpinned ${before.label}`, before, after: next } }
  })
}

export function getFileContent(id: string, fileId: string): FileContent {
  // A second guard behind dropContentsIfOff: with contents off, nothing is
  // served, whatever a row still holds.
  if (!getProject(id)?.allowSnapshots) throw new ProjError(404, 'no file content')
  const row = (typeof fileId === 'string' ? q.file.get({ id: fileId, projectId: id }) : undefined) as FileRow | undefined
  if (!row || row.deletedAt || row.content == null) throw new ProjError(404, 'no file content')
  return { content: row.content, contentType: row.contentType ?? 'text', capturedAt: row.capturedAt }
}

// ----------------------------------------------------------- automations ----

function liveAutomation(projectId: string, key: unknown): AutomationRow {
  const row = (typeof key === 'string' ? q.automationByKey.get({ projectId, key }) : undefined) as AutomationRow | undefined
  if (!row) throw new ProjError(404, 'no such agent or workflow')
  return row
}

export function getAutomation(id: string, key: string): Automation {
  return automationFrom(liveAutomation(id, key))
}

export function saveAutomation(id: string, key: string, input: SaveAutomationInput, ctx: Ctx): Automation {
  return mutate(id, ctx, 'write', () => {
    const k = keyOf('key', key)
    const inp = (input ?? {}) as Partial<SaveAutomationInput>
    const kind = inp.kind as AutomationKind
    if (kind !== 'agent' && kind !== 'workflow') throw new ProjError(400, 'kind must be agent or workflow')
    const name = text('name', inp.name, LIMITS.automationName, 'line', true)
    const description = inp.description == null ? null : text('description', inp.description, LIMITS.automationDescription, 'text')
    const body = text('body', inp.body, LIMITS.automationBody, 'text', true)
    if (inp.model != null && !MODELS.includes(inp.model)) throw new ProjError(400, 'model must be opus, sonnet, haiku or empty')
    const existing = q.automationByKey.get({ projectId: id, key: k }) as AutomationRow | undefined
    // The page's edit form sends the rev it loaded (0 for a new one), so a
    // session's rewrite in between is never overwritten unseen. Sessions save
    // by key without one, as before.
    if (inp.baseRev !== undefined) {
      if (!Number.isInteger(inp.baseRev)) throw new ProjError(400, 'baseRev must be a whole number')
      if (inp.baseRev !== (existing?.rev ?? 0)) {
        if (!existing) throw new ProjError(409, 'this agent or workflow was removed since you opened it')
        throw new ProjError(409, 'changed since', { current: automationFrom(existing) })
      }
    }
    const t = now()
    let next: AutomationRow
    if (existing) {
      // Fields left out keep their value, so a session can tune a body
      // without restating the description and model.
      next = {
        ...existing, kind, name, body, description: description ?? existing.description, model: inp.model ?? existing.model,
        rev: existing.rev + 1, updatedBy: ctx.actor, updatedAt: t,
      }
      q.automationSave.run(next)
    } else {
      const { n } = q.automationCount.get({ projectId: id }) as { n: number }
      if (n >= LIMITS.automationsPerProject) throw new ProjError(400, `a project has at most ${LIMITS.automationsPerProject} agents and workflows`)
      next = {
        id: randomUUID(), projectId: id, kind, key: k, name, description: description ?? '', body, model: inp.model ?? '',
        rev: 1, deletedAt: null, createdBy: ctx.actor, updatedBy: ctx.actor, createdAt: t, updatedAt: t,
      }
      q.automationInsert.run(next)
    }
    return {
      result: automationFrom(next),
      event: { action: 'automation.save', entity: 'automation', entityId: next.id, summary: `saved ${kind} ${quoted(name)}`, before: existing ?? null, after: next },
    }
  })
}

export function removeAutomation(id: string, key: string, ctx: Ctx): void {
  mutate(id, ctx, 'remove', () => {
    const before = liveAutomation(id, key)
    const t = now()
    const next: AutomationRow = { ...before, deletedAt: t, rev: before.rev + 1, updatedBy: ctx.actor, updatedAt: t }
    q.automationSave.run(next)
    return { result: undefined, event: { action: 'automation.remove', entity: 'automation', entityId: before.id, summary: `removed ${before.kind} ${quoted(before.name)}`, before, after: next } }
  })
}

// ------------------------------------------------------------------ runs ----

const RUN_CLOSING = 'When you are done, call the valkyrie MCP tool run_report with status done, failed or blocked and a short summary. If the valkyrie tools are not available, say so in your last message.\n'

function composeBrief(p: Project, a: AutomationRow, runId: string): string {
  const line = `Project: ${p.name} (${p.area}), id ${p.id}. Run id: ${runId}.`
  if (a.kind === 'agent') return `# Valkyrie agent: ${a.name}\n${line}\n\n${a.body}\n\n${RUN_CLOSING}`
  return `# Valkyrie workflow: ${a.name}\n${line}\n\nDo these steps in order. Where a step says to update the project page, use the valkyrie MCP tools.\n\n${a.body}\n\n${RUN_CLOSING}`
}

// Remote-Session.ps1 fetches the brief once, seconds after the ssh hop. A
// second fetch, or one long after the launch, is a replayed URL rather than
// the run it was minted for.
const BRIEF_TTL_MS = 10 * 60_000

// shownRev is the rev of the body the run sheet showed Brendon. The page's own
// re-read before it posts leaves a round trip in which a session could still
// rewrite the body; checked here, inside the same transaction as the insert,
// the run starts from exactly what he read or not at all.
export function createRun(id: string, key: string, shownRev: number, ctx: Ctx): Run {
  // Sessions can write agents and workflows but never start one, so a
  // prompt-injected session cannot run a brief it planted itself.
  if (ctx.actor !== 'ui') throw new ProjError(403, 'only the project page starts runs')
  return mutate(id, ctx, 'write', (p) => {
    const a = (typeof key === 'string' ? q.automationByKey.get({ projectId: id, key }) : undefined) as AutomationRow | undefined
    if (!a) throw new ProjError(404, 'no such agent or workflow')
    // 'changed since' is the code the page matches on, as for tabs.
    if (a.rev !== shownRev) throw new ProjError(409, 'changed since', { currentRev: a.rev })
    const runId = randomUUID()
    const row: RunRow = {
      id: runId, projectId: id, automationId: a.id, automationKey: a.key, kind: a.kind, name: a.name,
      brief: composeBrief(p, a, runId), model: a.model, sessionId: null, tmuxName: null, status: 'starting', summary: '',
      startedBy: ctx.actor, startedAt: now(), briefFetchedAt: null, endedAt: null,
    }
    q.runInsert.run(row)
    return { result: runFrom(row), event: { action: 'run.start', entity: 'run', entityId: runId, summary: `started run ${quoted(a.name)}`, before: null, after: row } }
  })
}

export function takeRunBrief(id: string, runId: string): { brief: string; model: Model; name: string } {
  const run = (typeof runId === 'string' ? q.run.get({ id: runId }) : undefined) as RunRow | undefined
  if (!run || run.projectId !== id) throw new ProjError(404, 'no such run')
  const fresh = Date.now() - Date.parse(run.startedAt) <= BRIEF_TTL_MS
  let taken = 0
  if (fresh) touch(id, () => (taken = q.runFetched.run({ id: run.id, now: now() }).changes))
  if (!taken) throw new ProjError(410, 'this run brief was already used or expired')
  return { brief: run.brief, model: run.model, name: run.name }
}

export function attachRun(runId: string, sessionId: string, tmuxName: string): void {
  const run = q.run.get({ id: runId }) as RunRow | undefined
  if (!run) return
  touch(run.projectId, () => q.runAttach.run({ id: runId, sessionId, tmuxName }).changes)
}

export function failRun(runId: string, summary: string): void {
  const run = q.run.get({ id: runId }) as RunRow | undefined
  if (!run) return
  touch(run.projectId, () => q.runFail.run({ id: runId, summary: soft(summary, LIMITS.runSummary), now: now() }).changes)
}

export function failRunsForTmux(tmuxName: string, summary: string): void {
  for (const run of q.runsOpenForTmux.all({ tmuxName }) as RunRow[]) failRun(run.id, summary)
}

// Only a fresh run launch carries X-Valkyrie-Run. A resumed run conversation
// is found from its session id instead, so it can still report how it ended.
export function runForSession(projectId: string, sid: string): string | null {
  return (q.runForSession.get({ projectId, sid }) as { id: string } | undefined)?.id ?? null
}

export function reportRun(id: string, runId: string, status: 'done' | 'failed' | 'blocked', summary: string, ctx: Ctx): Run {
  return mutate(id, ctx, 'write', () => {
    const before = (typeof runId === 'string' ? q.run.get({ id: runId }) : undefined) as RunRow | undefined
    if (!before || before.projectId !== id) throw new ProjError(404, 'no such run')
    if (status !== 'done' && status !== 'failed' && status !== 'blocked') throw new ProjError(400, 'status must be done, failed or blocked')
    const s = text('summary', summary ?? '', LIMITS.runSummary, 'text')
    // A run can report more than once: blocked, then done after Brendon
    // unblocks it, or done again from a resumed session.
    q.runEnd.run({ id: before.id, status, summary: s, now: now() })
    const after = q.run.get({ id: before.id }) as RunRow
    return { result: runFrom(after), event: { action: 'run.report', entity: 'run', entityId: before.id, summary: `run ${quoted(before.name)} reported ${status}`, before, after } }
  })
}

// -------------------------------------------------------------- sessions ----

export function linkSession(
  id: string,
  link: { sessionId: string; launchSessionId?: string; tmuxName?: string | null; mode?: string; runId?: string | null; via: LinkedVia },
  ctx: Ctx,
): { created: boolean } {
  return mutate<{ created: boolean }>(id, ctx, 'write', () => {
    const l = (link ?? {}) as Partial<typeof link>
    const sessionId = l.sessionId
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new ProjError(400, 'sessionId must be a uuid')
    const launchSessionId = l.launchSessionId ?? sessionId
    if (typeof launchSessionId !== 'string' || !UUID_RE.test(launchSessionId)) throw new ProjError(400, 'launchSessionId must be a uuid')
    if (!LINKED_VIA.includes(l.via as LinkedVia)) throw new ProjError(400, `via must be one of ${LINKED_VIA.join(', ')}`)
    const tmuxName = l.tmuxName ?? null
    if (tmuxName !== null && !TMUX_NAME_RE.test(tmuxName)) throw new ProjError(400, 'tmuxName must be a terminal session name')
    const runId = l.runId ?? null
    if (runId !== null && !UUID_RE.test(runId)) throw new ProjError(400, 'runId must be a uuid')
    const mode = l.mode ?? ''
    if (!MODES.includes(mode)) throw new ProjError(400, 'mode must be new, resume or shell')
    const existed = Boolean(q.session.get({ projectId: id, sessionId }))
    q.sessionUpsert.run({ projectId: id, sessionId, launchSessionId, tmuxName, mode, runId, linkedVia: l.via as LinkedVia, linkedBy: ctx.actor, linkedAt: now() })
    // Every launch is linked twice, once here from the terminal route and once
    // by thor's SessionStart hook, so only the first one is news.
    if (existed) return { result: { created: false }, event: null }
    const after = q.session.get({ projectId: id, sessionId })
    return { result: { created: true }, event: { action: 'session.link', entity: 'session', entityId: sessionId, summary: 'linked a session', before: null, after } }
  })
}

// The live projects a conversation is linked to. A conversation reopened
// without naming its project gets it back from here.
export function projectsForSession(sessionId: string): string[] {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return []
  return (q.projectsForSession.all({ sessionId }) as { projectId: string }[]).map((r) => r.projectId)
}

export function unlinkSession(id: string, sessionId: string, ctx: Ctx): void {
  mutate(id, ctx, 'remove', () => {
    const before = (typeof sessionId === 'string' ? q.session.get({ projectId: id, sessionId }) : undefined) as SessionRow | undefined
    if (!before) throw new ProjError(404, 'no such linked session')
    q.sessionDelete.run({ projectId: id, sessionId })
    return { result: undefined, event: { action: 'session.unlink', entity: 'session', entityId: sessionId, summary: 'unlinked a session', before, after: null } }
  })
}

export function setSessionStatus(id: string, launchSessionId: string, note: string, ctx: Ctx): number {
  return mutate(id, ctx, 'write', () => {
    if (typeof launchSessionId !== 'string' || !UUID_RE.test(launchSessionId)) throw new ProjError(400, 'launchSessionId must be a uuid')
    const n = text('note', note ?? '', LIMITS.sessionNote, 'line')
    const count = q.sessionStatus.run({ projectId: id, launchSessionId, note: n, at: n ? now() : null }).changes
    if (!count) return { result: 0, event: null }
    return {
      result: count,
      event: { action: 'session.status', entity: 'session', entityId: launchSessionId, summary: n ? `set status ${quoted(n)}` : 'cleared its status', before: null, after: { statusNote: n } },
    }
  })
}

// ------------------------------------------------------------- reminders ----

function checkPendingCap(projectId: string): void {
  const { n } = q.remindersPending.get({ projectId, now: atFormat(Date.now()) }) as { n: number }
  if (n >= LIMITS.pendingReminders) throw new ProjError(400, `a project has at most ${LIMITS.pendingReminders} pending reminders`)
}

// The DM leaves odin for Discord. A client-area reminder therefore
// carries only a pointer, and the words stay in projects.sqlite. Not even the
// project id: it is the slug of the project's name, and a work project is
// usually named after its client. The ref is the start of the reminder's own
// id, which the reminders tab shows beside it.
const pointerText = (reminderId: string) => `Reminder from a Valkyrie project (ref ${reminderId.slice(0, 8)}): open Projects in Valkyrie.`
// Stays in lilkups' list on odin and is never sent.
const lilkupsName = (id: string) => `proj-${id}-${randomBytes(3).toString('hex')}`

export async function addReminder(id: string, input: ReminderInput, ctx: Ctx): Promise<Reminder> {
  const p = projectFrom(access(id, ctx))
  rateLimit(id, ctx.actor, 'write')
  const inp = (input ?? {}) as Partial<ReminderInput>
  const at = normalizeAt(typeof inp.at === 'string' ? inp.at : '')
  const message = text('message', inp.message, LIMITS.reminderMessage, 'text', true)
  checkPendingCap(id)
  const rowId = randomUUID()
  const deliveredText = isClientArea(p.area) ? pointerText(rowId) : `[${p.name}] ${message}`
  // Outside the transaction: better-sqlite3 transactions cannot span an await.
  const lilkupsId = await addLilkupsReminder(at, lilkupsName(id), deliveredText)
  try {
    access(id, ctx)
    return apply(id, ctx, () => {
      checkPendingCap(id)
      const row: ReminderRow = {
        id: rowId, projectId: id, lilkupsId, at, message, deliveredText, createdBy: ctx.actor, createdAt: now(), canceledAt: null,
      }
      q.reminderInsert.run(row)
      return { result: reminderFrom(row, 'pending'), event: { action: 'reminder.add', entity: 'reminder', entityId: row.id, summary: `set a reminder for ${at}`, before: null, after: row } }
    })
  } catch (err) {
    // Already scheduled with lilkups: take it back, or a reminder the page
    // never recorded would still arrive.
    await removeLilkupsReminder(lilkupsId).catch(() => false)
    throw err
  }
}

export async function cancelReminder(id: string, reminderId: string, ctx: Ctx): Promise<void> {
  access(id, ctx)
  rateLimit(id, ctx.actor, 'remove')
  const row = (typeof reminderId === 'string' ? q.reminder.get({ id: reminderId, projectId: id }) : undefined) as ReminderRow | undefined
  if (!row) throw new ProjError(404, 'no such reminder')
  if (row.canceledAt) return
  // `remind rm` drops a record whatever its status, so a DM that already went
  // out would otherwise be marked canceled. A pending one past its time is
  // still canceled: run-due retries a failed send, and the cancel stops that.
  const state = (await readLilkupsStates()).get(row.lilkupsId)
  if (state === 'sent') throw new ProjError(409, 'already sent')
  if (state === 'failed') throw new ProjError(409, 'already failed')
  if (state === undefined && Date.parse(row.at) < Date.now()) throw new ProjError(409, 'already sent or gone')
  await removeLilkupsReminder(row.lilkupsId)
  access(id, ctx)
  apply(id, ctx, () => {
    const t = now()
    q.reminderCancel.run({ id: row.id, now: t })
    return { result: undefined, event: { action: 'reminder.cancel', entity: 'reminder', entityId: row.id, summary: 'canceled a reminder', before: row, after: { ...row, canceledAt: t } } }
  })
}

// A personal or server reminder handed to lilkups with its full text keeps
// that text after the project moves into a client area. Each one still
// ahead is scheduled again as a pointer, then the old one is removed. Runs
// after the change, outside its transaction, because lilkups is a process.
// Returns how many are still scheduled with their full text.
export async function reissueClientReminders(id: string): Promise<number> {
  const p = getProject(id)
  if (!p || !isClientArea(p.area)) return 0
  let unchanged = 0
  for (const row of q.remindersAhead.all({ projectId: id, now: atFormat(Date.now()) }) as ReminderRow[]) {
    const text = pointerText(row.id)
    if (row.deliveredText === text) continue
    try {
      const lilkupsId = await addLilkupsReminder(row.at, lilkupsName(id), text)
      let removed = false
      try {
        removed = await removeLilkupsReminder(row.lilkupsId)
      } finally {
        // Gone already (sent, or removed by hand) or not removable: either
        // way the new pointer must not fire in its place.
        if (!removed) await removeLilkupsReminder(lilkupsId).catch(() => false)
      }
      if (!removed) continue
      touch(id, () => q.reminderRelink.run({ id: row.id, lilkupsId, deliveredText: text }).changes)
    } catch (err) {
      console.error('[projects] could not reissue a reminder as a pointer', (err as Error).message)
      unchanged++
    }
  }
  return unchanged
}

// ---------------------------------------------------------- events, undo ----

export function listEvents(id: string, opts: { before?: number; limit?: number; actor?: string } = {}): ProjectEvent[] {
  const o = opts ?? {}
  const limit = Number.isFinite(o.limit) ? Math.min(100, Math.max(1, Math.trunc(o.limit as number))) : 50
  const before = Number.isFinite(o.before) && (o.before as number) > 0 ? Math.trunc(o.before as number) : Number.MAX_SAFE_INTEGER
  const actor = typeof o.actor === 'string' && o.actor ? o.actor : null
  return (q.eventsPage.all({ projectId: id, before, actor, limit }) as EventListRow[]).map(eventFrom)
}

const parseImage = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null
  try { return JSON.parse(json) as Record<string, unknown> } catch { return null }
}

export function undoEvent(id: string, eventId: number, opts: { force?: boolean; onlyActor?: string }, ctx: Ctx): { rev: number } {
  return mutate(id, ctx, 'write', (p) => {
    const ev = (Number.isInteger(eventId) ? q.event.get({ id: eventId, projectId: id }) : undefined) as EventRow | undefined
    if (!ev) throw new ProjError(404, 'no such change')
    if (opts?.onlyActor && ev.actor !== opts.onlyActor) throw new ProjError(403, 'you can only undo your own changes')
    if (!isRestorable(ev.entity) || NOT_UNDOABLE.has(ev.action)) throw new ProjError(400, 'not undoable')
    if (ev.undoneBy != null) throw new ProjError(409, 'already undone')
    const entity = ev.entity
    const spec = RESTORE[entity]
    const before = parseImage(ev.before)
    const after = parseImage(ev.after)
    const cur = spec.get.get({ id: ev.entityId, projectId: id }) as Record<string, unknown> | undefined
    if (!cur) throw new ProjError(404, 'that item no longer exists')
    // The project row's rev moves on every change in the project, so its own
    // fields are versioned by metaRev instead.
    const revKey = entity === 'project' ? 'metaRev' : 'rev'
    const currentRev = Number(cur[revKey])
    if (after && currentRev !== Number(after[revKey]) && !opts?.force) throw new ProjError(409, 'changed since', { currentRev })
    const next: Record<string, unknown> = { ...cur }
    if (before == null) {
      if (entity === 'project') throw new ProjError(400, 'not undoable')
      next.deletedAt = now()
    } else {
      // A project event puts back only what it changed. Copying every column
      // would undo the settings half of an edit as a no-op, or (when forced)
      // overwrite fields the event never touched.
      const cols = entity === 'project' && after ? spec.cols.filter((c) => before[c] !== after[c]) : spec.cols
      if (entity === 'project' && ctx.actor !== 'ui' && cols.some((c) => SETTINGS.has(c))) {
        throw new ProjError(403, 'only the project page can change the area, folder, exposure or session settings')
      }
      for (const c of cols) if (c in before) next[c] = before[c]
    }
    next[revKey] = currentRev + 1
    if (entity !== 'project') {
      next.updatedBy = ctx.actor
      next.updatedAt = now()
    }
    try {
      spec.save.run(next)
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ProjError(409, 'a newer item with the same path or key exists')
      throw err
    }
    // An undo that turns file contents back off drops them like a direct edit.
    if (entity === 'project') dropContentsIfOff(id, cur as Pick<ProjectRow, 'allowSnapshots'>, next as Pick<ProjectRow, 'allowSnapshots'>)
    return {
      result: { rev: p.rev + 1 },
      event: { action: 'undo', entity, entityId: ev.entityId, summary: `undid #${ev.id}: ${ev.summary}`, before: cur, after: next, undoOf: ev.id },
    }
  })
}

// Newest first, so each undo lands on the state its own event produced. An
// actor that edited the same tab three times would otherwise conflict with
// itself on every edit but the last: the first undo moves the rev past what
// the older events recorded. So an undo is forced when nobody else has touched
// the entity since that event, and checked as usual when someone has.
export function revertActor(id: string, actor: string, ctx: Ctx): { reverted: number; conflicts: number } {
  let reverted = 0
  let conflicts = 0
  for (const ev of q.eventsByActor.all({ projectId: id, actor }) as EventListRow[]) {
    if (!undoableRow(ev)) continue
    const clear = !q.foreignAfter.get({ projectId: id, entity: ev.entity, entityId: ev.entityId, id: ev.id, actor })
    try {
      undoEvent(id, ev.id, { force: clear }, ctx)
      reverted++
    } catch (err) {
      if (!(err instanceof ProjError) || err.status === 429) throw err
      conflicts++
    }
  }
  return { reverted, conflicts }
}

// ------------------------------------------------------------- live poll ----

export function currentChange(id: string): ProjChange {
  const row = (typeof id === 'string' ? q.project.get({ id }) : undefined) as ProjectRow | undefined
  if (!row) throw new ProjError(404, 'no such project')
  return { rev: row.rev, lastEvent: lastEventOf(id) }
}

export async function waitForChange(id: string, sinceRev: number, ms: number, signal?: AbortSignal): Promise<ProjChange> {
  const first = currentChange(id)
  if (first.rev > sinceRev || signal?.aborted) return first
  return new Promise<ProjChange>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      emitter.off('change', onChange)
      signal?.removeEventListener('abort', finish)
      try { resolve(currentChange(id)) } catch { resolve(first) }
    }
    const onChange = (projectId: string) => {
      if (projectId !== id) return
      try { if (currentChange(id).rev > sinceRev) finish() } catch { finish() }
    }
    timer = setTimeout(finish, ms)
    emitter.on('change', onChange)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export function noteNotify(id: string, ctx: Ctx, title: string): void {
  mutate(id, ctx, 'notify', () => ({
    result: undefined,
    event: { action: 'notify', entity: 'project', entityId: id, summary: 'sent a notification', before: null, after: { title: soft(title, 80) } },
  }))
}
