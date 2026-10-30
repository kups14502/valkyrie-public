import { openDb } from './db.js'
import type { Franchise, Ticket } from './psa.js'

// The work agents' data: the agents themselves, the channels Brendon and they
// talk in, messages, proposals waiting on his approval, the action queue thor
// runs (mail), the ticket tracker, and the mail and Teams items the feeds
// bring in. One file, agents.sqlite. lib/agents.ts runs them; this file only
// keeps the rows and tells waiters that something changed.

export type AgentKind = 'triage' | 'project' | 'shopping'
export type AgentStatus = 'idle' | 'queued' | 'working' | 'resting' | 'error'
export type ChannelKind = 'home' | 'team' | 'dm'
export type ProposalKind = 'mail_reply' | 'ticket_note' | 'ticket_update' | 'ticket_create'
export type ProposalStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined'
export type MailState = 'new' | 'handled' | 'ignored' | 'needs-brendon'

const db = openDb('agents', `
  CREATE TABLE IF NOT EXISTS agents (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL CHECK (kind IN ('triage','project','shopping')),
    area       TEXT NOT NULL,
    franchise  TEXT,
    projectId  TEXT,
    channelId  TEXT NOT NULL,
    model      TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    notebook   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'idle',
    statusNote TEXT NOT NULL DEFAULT '',
    lastRunAt  TEXT,
    createdAt  TEXT NOT NULL,
    updatedAt  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('home','team','dm')),
    area          TEXT NOT NULL,
    topic         TEXT NOT NULL DEFAULT '',
    agentIds      TEXT NOT NULL DEFAULT '[]',
    sortOrder     INTEGER NOT NULL DEFAULT 100,
    createdAt     TEXT NOT NULL,
    archivedAt    TEXT,
    lastMessageAt TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channelId  TEXT NOT NULL,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    refs       TEXT NOT NULL DEFAULT '[]',
    mentions   TEXT NOT NULL DEFAULT '[]',
    notify     INTEGER NOT NULL DEFAULT 0,
    hop        INTEGER NOT NULL DEFAULT 0,
    proposalId INTEGER,
    createdAt  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_msg_channel ON messages (channelId, id);
  CREATE TABLE IF NOT EXISTS reads (
    channelId  TEXT PRIMARY KEY,
    lastReadId INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId   TEXT NOT NULL,
    kind      TEXT NOT NULL,
    payload   TEXT NOT NULL DEFAULT '{}',
    hop       INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    runId     TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_events_open ON events (agentId, runId);
  CREATE TABLE IF NOT EXISTS runs (
    id         TEXT PRIMARY KEY,
    agentId    TEXT NOT NULL,
    trigger    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'running',
    startedAt  TEXT NOT NULL,
    endedAt    TEXT,
    summary    TEXT NOT NULL DEFAULT '',
    error      TEXT,
    cred       TEXT,
    costUsd    REAL,
    turns      INTEGER,
    durationMs INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_runs_agent ON runs (agentId, startedAt);
  CREATE TABLE IF NOT EXISTS proposals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId   TEXT NOT NULL,
    channelId TEXT NOT NULL,
    messageId INTEGER,
    kind      TEXT NOT NULL,
    title     TEXT NOT NULL,
    payload   TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending',
    result    TEXT NOT NULL DEFAULT '',
    decidedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    proposalId INTEGER NOT NULL,
    runner     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    createdAt  TEXT NOT NULL,
    claimedAt  TEXT,
    doneAt     TEXT,
    result     TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS tickets (
    franchise    TEXT NOT NULL,
    id           INTEGER NOT NULL,
    number       TEXT NOT NULL,
    title        TEXT NOT NULL,
    company      TEXT NOT NULL,
    companyId    INTEGER NOT NULL,
    status       TEXT NOT NULL,
    priority     TEXT NOT NULL,
    queue        TEXT NOT NULL,
    assignee     TEXT,
    mine         INTEGER NOT NULL DEFAULT 0,
    created      TEXT NOT NULL,
    lastActivity TEXT,
    due          TEXT,
    completed    TEXT,
    url          TEXT NOT NULL,
    firstSeenAt  TEXT NOT NULL,
    updatedAt    TEXT NOT NULL,
    closedAt     TEXT,
    summary      TEXT NOT NULL DEFAULT '',
    next         TEXT NOT NULL DEFAULT '',
    needsBrendon INTEGER NOT NULL DEFAULT 0,
    waitingOn    TEXT NOT NULL DEFAULT '',
    agentAt      TEXT,
    selfTouchAt  TEXT,
    PRIMARY KEY (franchise, id)
  );
  CREATE TABLE IF NOT EXISTS mail (
    n                 INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox           TEXT NOT NULL,
    address           TEXT NOT NULL,
    graphId           TEXT NOT NULL,
    conversationId    TEXT NOT NULL DEFAULT '',
    subject           TEXT NOT NULL DEFAULT '',
    fromName          TEXT NOT NULL DEFAULT '',
    fromAddress       TEXT NOT NULL DEFAULT '',
    toList            TEXT NOT NULL DEFAULT '',
    ccList            TEXT NOT NULL DEFAULT '',
    receivedAt        TEXT NOT NULL,
    body              TEXT NOT NULL DEFAULT '',
    webLink           TEXT,
    importance        TEXT NOT NULL DEFAULT 'normal',
    focused           INTEGER NOT NULL DEFAULT 1,
    attachments       TEXT NOT NULL DEFAULT '',
    franchise         TEXT,
    agentId           TEXT,
    state             TEXT NOT NULL DEFAULT 'new',
    outcome           TEXT NOT NULL DEFAULT '',
    createdAt         TEXT NOT NULL,
    UNIQUE (mailbox, graphId)
  );
  CREATE INDEX IF NOT EXISTS ix_mail_recent ON mail (receivedAt);
  CREATE TABLE IF NOT EXISTS teams (
    id        TEXT PRIMARY KEY,
    chatId    TEXT NOT NULL,
    chatTopic TEXT NOT NULL DEFAULT '',
    fromName  TEXT NOT NULL DEFAULT '',
    text      TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    webUrl    TEXT,
    agentId   TEXT,
    seenAt    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS senders (
    email     TEXT PRIMARY KEY,
    franchise TEXT NOT NULL,
    companyId INTEGER NOT NULL,
    company   TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

export const nowIso = () => new Date().toISOString()
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

export class AgentError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// ------------------------------------------------------------ changes ----
// One counter for the whole feature. The UI long-polls /msg/changes with the
// last value it saw; anything that changes a row it shows bumps it.

// Starts at the boot time, so a tab still holding a count from before a
// restart always differs and refetches.
let seq = Date.now() % 1_000_000_000
const waiters = new Set<() => void>()

export function bump(): number {
  seq += 1
  for (const w of [...waiters]) w()
  return seq
}

export const currentSeq = () => seq

export function waitForChange(since: number, ms: number, signal?: AbortSignal): Promise<number> {
  if (seq !== since) return Promise.resolve(seq)
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(seq) }
    const timer = setTimeout(done, ms)
    waiters.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// ----------------------------------------------------------------- kv ----

export function getKv(key: string): string | null {
  return (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}

export function setKv(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ------------------------------------------------------------- agents ----

type AgentRow = {
  id: string; name: string; role: string; kind: AgentKind; area: string; franchise: Franchise | null; projectId: string | null
  channelId: string; model: string; enabled: 0 | 1; notebook: string; status: AgentStatus; statusNote: string
  lastRunAt: string | null; createdAt: string; updatedAt: string
}
export type Agent = Omit<AgentRow, 'enabled'> & { enabled: boolean }

const toAgent = (r: AgentRow): Agent => ({ ...r, enabled: r.enabled === 1 })

export function listAgents(): Agent[] {
  return (db.prepare('SELECT * FROM agents ORDER BY kind DESC, name').all() as AgentRow[]).map(toAgent)
}

export function getAgent(id: string): Agent | null {
  const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
  return r ? toAgent(r) : null
}

export function agentForProject(projectId: string): Agent | null {
  const r = db.prepare('SELECT * FROM agents WHERE projectId = ?').get(projectId) as AgentRow | undefined
  return r ? toAgent(r) : null
}

export type NewAgent = Pick<Agent, 'id' | 'name' | 'role' | 'kind' | 'area' | 'franchise' | 'projectId' | 'channelId'> & { model?: string }

export function upsertAgent(a: NewAgent): Agent {
  const at = nowIso()
  db.prepare(`INSERT INTO agents (id, name, role, kind, area, franchise, projectId, channelId, model, createdAt, updatedAt)
    VALUES (@id, @name, @role, @kind, @area, @franchise, @projectId, @channelId, @model, @at, @at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, area = excluded.area,
      franchise = excluded.franchise, projectId = excluded.projectId, channelId = excluded.channelId, updatedAt = excluded.updatedAt`)
    .run({ ...a, model: a.model ?? '', at })
  bump()
  return getAgent(a.id)!
}

export function patchAgent(id: string, patch: Partial<Pick<Agent, 'enabled' | 'model' | 'notebook' | 'status' | 'statusNote' | 'lastRunAt' | 'name' | 'role'>>): Agent {
  const cur = getAgent(id)
  if (!cur) throw new AgentError(404, `no agent ${id}`)
  const next = { ...cur, ...patch }
  db.prepare(`UPDATE agents SET enabled = ?, model = ?, notebook = ?, status = ?, statusNote = ?, lastRunAt = ?, name = ?, role = ?, updatedAt = ? WHERE id = ?`)
    .run(next.enabled ? 1 : 0, next.model, next.notebook, next.status, next.statusNote, next.lastRunAt, next.name, next.role, nowIso(), id)
  bump()
  return getAgent(id)!
}

// ----------------------------------------------------------- channels ----

type ChannelRow = {
  id: string; name: string; kind: ChannelKind; area: string; topic: string; agentIds: string; sortOrder: number
  createdAt: string; archivedAt: string | null; lastMessageAt: string | null
}
export type Channel = Omit<ChannelRow, 'agentIds'> & { agentIds: string[] }

const toChannel = (r: ChannelRow): Channel => ({ ...r, agentIds: parse<string[]>(r.agentIds, []) })

export function listChannels(includeArchived = false): Channel[] {
  return (db.prepare(`SELECT * FROM channels ${includeArchived ? '' : 'WHERE archivedAt IS NULL'} ORDER BY sortOrder, name`).all() as ChannelRow[]).map(toChannel)
}

export function getChannel(id: string): Channel | null {
  const r = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
  return r ? toChannel(r) : null
}

export function upsertChannel(c: Pick<Channel, 'id' | 'name' | 'kind' | 'area' | 'topic' | 'agentIds' | 'sortOrder'>): Channel {
  db.prepare(`INSERT INTO channels (id, name, kind, area, topic, agentIds, sortOrder, createdAt)
    VALUES (@id, @name, @kind, @area, @topic, @agentIds, @sortOrder, @at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, area = excluded.area, topic = excluded.topic,
      agentIds = excluded.agentIds, sortOrder = excluded.sortOrder, archivedAt = NULL`)
    .run({ ...c, agentIds: JSON.stringify(c.agentIds), at: nowIso() })
  bump()
  return getChannel(c.id)!
}

export function archiveChannel(id: string): void {
  db.prepare('UPDATE channels SET archivedAt = ? WHERE id = ? AND archivedAt IS NULL').run(nowIso(), id)
  bump()
}

/** The DM channel between two agents, made on first use. Brendon sees it like any other. */
export function dmChannel(a: Agent, b: Agent): Channel {
  const [x, y] = [a.id, b.id].sort()
  const id = `dm-${x}--${y}`
  const have = getChannel(id)
  if (have) return have
  // two areas in one DM: it stays tailnet-only, like the team channel
  const area = a.area === b.area ? a.area : 'team'
  return upsertChannel({ id, name: `${a.name} + ${b.name}`, kind: 'dm', area, topic: '', agentIds: [x, y], sortOrder: 300 })
}

// ----------------------------------------------------------- messages ----

export type Ref =
  | { type: 'ticket'; franchise: Franchise; id: number; number: string; title?: string; url?: string }
  | { type: 'mail'; n: number; subject?: string; from?: string; url?: string }
  | { type: 'link'; url: string; label?: string }
  | { type: 'task'; text: string; projectId?: string }
  | { type: 'project'; id: string; name?: string }

type MessageRow = {
  id: number; channelId: string; author: string; text: string; refs: string; mentions: string; notify: 0 | 1
  hop: number; proposalId: number | null; createdAt: string
}
export type Message = Omit<MessageRow, 'refs' | 'mentions' | 'notify'> & { refs: Ref[]; mentions: string[]; notify: boolean }

const toMessage = (r: MessageRow): Message => ({ ...r, refs: parse<Ref[]>(r.refs, []), mentions: parse<string[]>(r.mentions, []), notify: r.notify === 1 })

export const MAX_TEXT = 12_000

export function addMessage(m: { channelId: string; author: string; text: string; refs?: Ref[]; mentions?: string[]; notify?: boolean; hop?: number; proposalId?: number | null }): Message {
  const at = nowIso()
  const r = db.prepare(`INSERT INTO messages (channelId, author, text, refs, mentions, notify, hop, proposalId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(m.channelId, m.author, m.text.slice(0, MAX_TEXT), JSON.stringify(m.refs ?? []), JSON.stringify(m.mentions ?? []),
      m.notify ? 1 : 0, m.hop ?? 0, m.proposalId ?? null, at)
  db.prepare('UPDATE channels SET lastMessageAt = ? WHERE id = ?').run(at, m.channelId)
  bump()
  return getMessage(Number(r.lastInsertRowid))!
}

export function getMessage(id: number): Message | null {
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
  return r ? toMessage(r) : null
}

export function listMessages(channelId: string, opts: { before?: number; after?: number; limit?: number } = {}): Message[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60))
  if (opts.after !== undefined) {
    return (db.prepare('SELECT * FROM messages WHERE channelId = ? AND id > ? ORDER BY id LIMIT ?').all(channelId, opts.after, limit) as MessageRow[]).map(toMessage)
  }
  const rows = db.prepare(`SELECT * FROM messages WHERE channelId = ? ${opts.before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(opts.before ? [channelId, opts.before, limit] : [channelId, limit])) as MessageRow[]
  return rows.reverse().map(toMessage)
}

export function lastReadId(channelId: string): number {
  return (db.prepare('SELECT lastReadId FROM reads WHERE channelId = ?').get(channelId) as { lastReadId: number } | undefined)?.lastReadId ?? 0
}

export function markChannelRead(channelId: string, upTo?: number): void {
  const last = upTo ?? ((db.prepare('SELECT MAX(id) AS m FROM messages WHERE channelId = ?').get(channelId) as { m: number | null }).m ?? 0)
  db.prepare(`INSERT INTO reads (channelId, lastReadId) VALUES (?, ?)
    ON CONFLICT(channelId) DO UPDATE SET lastReadId = MAX(lastReadId, excluded.lastReadId)`).run(channelId, last)
  bump()
}

/** Unread messages per channel: anything not Brendon's own past his read mark. */
export function unreadCounts(): Map<string, { unread: number; notify: number }> {
  const rows = db.prepare(`SELECT m.channelId AS c, COUNT(*) AS n, SUM(m.notify) AS k FROM messages m
    LEFT JOIN reads r ON r.channelId = m.channelId
    WHERE m.author != 'brendon' AND m.id > COALESCE(r.lastReadId, 0) GROUP BY m.channelId`).all() as { c: string; n: number; k: number | null }[]
  return new Map(rows.map((r) => [r.c, { unread: r.n, notify: r.k ?? 0 }]))
}

export function pruneMessages(days = 180): void {
  db.prepare('DELETE FROM messages WHERE createdAt < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
}

// ------------------------------------------------------------- events ----
// What wakes an agent: new mail, a ticket that moved, a message for it, a
// proposal Brendon decided. A run takes every open event at its start.

export type AgentEvent = { id: number; agentId: string; kind: string; payload: Record<string, unknown>; hop: number; createdAt: string; runId: string | null }

export function addEvent(agentId: string, kind: string, payload: Record<string, unknown>, hop = 0): number {
  const r = db.prepare('INSERT INTO events (agentId, kind, payload, hop, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(agentId, kind, JSON.stringify(payload), hop, nowIso())
  return Number(r.lastInsertRowid)
}

export function openEvents(agentId: string): AgentEvent[] {
  return (db.prepare('SELECT * FROM events WHERE agentId = ? AND runId IS NULL ORDER BY id LIMIT 200').all(agentId) as (Omit<AgentEvent, 'payload'> & { payload: string })[])
    .map((e) => ({ ...e, payload: parse<Record<string, unknown>>(e.payload, {}) }))
}

export function claimEvents(agentId: string, runId: string, ids: number[]): void {
  const stmt = db.prepare('UPDATE events SET runId = ? WHERE id = ? AND agentId = ? AND runId IS NULL')
  db.transaction(() => { for (const id of ids) stmt.run(runId, id, agentId) })()
}

/** Events a failed run took go back on the pile, once. */
export function releaseEvents(runId: string): number {
  // a second failure drops them: they stay with the failed run
  return db.prepare("UPDATE events SET runId = NULL, kind = 'retry:' || kind WHERE runId = ? AND kind NOT LIKE 'retry:%'").run(runId).changes
}

export function agentsWithOpenEvents(): string[] {
  return (db.prepare('SELECT DISTINCT agentId FROM events WHERE runId IS NULL').all() as { agentId: string }[]).map((r) => r.agentId)
}

export function pruneEvents(days = 30): void {
  db.prepare('DELETE FROM events WHERE runId IS NOT NULL AND createdAt < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
}

// --------------------------------------------------------------- runs ----

export type Run = {
  id: string; agentId: string; trigger: string; status: 'running' | 'done' | 'failed'; startedAt: string; endedAt: string | null
  summary: string; error: string | null; cred: string | null; costUsd: number | null; turns: number | null; durationMs: number | null
}

export function startRun(id: string, agentId: string, trigger: string): void {
  db.prepare('INSERT INTO runs (id, agentId, trigger, startedAt) VALUES (?, ?, ?, ?)').run(id, agentId, trigger.slice(0, 500), nowIso())
}

export function endRun(id: string, r: { status: 'done' | 'failed'; summary?: string; error?: string | null; cred?: string | null; costUsd?: number | null; turns?: number | null; durationMs?: number | null }): void {
  db.prepare('UPDATE runs SET status = ?, endedAt = ?, summary = ?, error = ?, cred = ?, costUsd = ?, turns = ?, durationMs = ? WHERE id = ?')
    .run(r.status, nowIso(), (r.summary ?? '').slice(0, 2000), r.error ?? null, r.cred ?? null, r.costUsd ?? null, r.turns ?? null, r.durationMs ?? null, id)
  bump()
}

export function listRuns(agentId: string, limit = 20): Run[] {
  return db.prepare('SELECT * FROM runs WHERE agentId = ? ORDER BY startedAt DESC LIMIT ?').all(agentId, limit) as Run[]
}

/** Runs an agent started since an instant: the hourly and daily caps count these. */
export function runsSince(agentId: string, iso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE agentId = ? AND startedAt >= ?').get(agentId, iso) as { n: number }).n
}

/** A run left 'running' by a restart never finishes: close it, and give its events one more try. */
export function failStaleRuns(): number {
  const ids = (db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: string }[]).map((r) => r.id)
  db.prepare("UPDATE runs SET status = 'failed', endedAt = ?, error = 'Valkyrie restarted during the run' WHERE status = 'running'").run(nowIso())
  for (const id of ids) releaseEvents(id)
  return ids.length
}

// ---------------------------------------------------------- proposals ----

type ProposalRow = {
  id: number; agentId: string; channelId: string; messageId: number | null; kind: ProposalKind; title: string; payload: string
  status: ProposalStatus; result: string; decidedAt: string | null; createdAt: string; updatedAt: string
}
export type Proposal = Omit<ProposalRow, 'payload'> & { payload: Record<string, unknown> }

const toProposal = (r: ProposalRow): Proposal => ({ ...r, payload: parse<Record<string, unknown>>(r.payload, {}) })

export function addProposal(p: { agentId: string; channelId: string; kind: ProposalKind; title: string; payload: Record<string, unknown> }): Proposal {
  const at = nowIso()
  const r = db.prepare('INSERT INTO proposals (agentId, channelId, kind, title, payload, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.agentId, p.channelId, p.kind, p.title.slice(0, 300), JSON.stringify(p.payload), at, at)
  bump()
  return getProposal(Number(r.lastInsertRowid))!
}

export function getProposal(id: number): Proposal | null {
  const r = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined
  return r ? toProposal(r) : null
}

export function proposalsFor(ids: number[]): Map<number, Proposal> {
  if (!ids.length) return new Map()
  const rows = db.prepare(`SELECT * FROM proposals WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as ProposalRow[]
  return new Map(rows.map((r) => [r.id, toProposal(r)]))
}

export function setProposalMessage(id: number, messageId: number): void {
  db.prepare('UPDATE proposals SET messageId = ? WHERE id = ?').run(messageId, id)
}

/** Moves a proposal on; `from` guards the transition so two taps never run it twice. */
export function moveProposal(id: number, from: ProposalStatus[], to: ProposalStatus, patch: { result?: string; payload?: Record<string, unknown> } = {}): Proposal | null {
  const cur = getProposal(id)
  if (!cur || !from.includes(cur.status)) return null
  const at = nowIso()
  const r = db.prepare(`UPDATE proposals SET status = ?, result = ?, payload = ?, updatedAt = ?, decidedAt = COALESCE(decidedAt, ?)
    WHERE id = ? AND status = ?`)
    .run(to, patch.result ?? cur.result, JSON.stringify(patch.payload ?? cur.payload), at, at, id, cur.status)
  if (!r.changes) return null
  bump()
  return getProposal(id)
}

export function pendingProposals(agentId?: string): Proposal[] {
  const rows = agentId
    ? db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND agentId = ? ORDER BY id").all(agentId)
    : db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id").all()
  return (rows as ProposalRow[]).map(toProposal)
}

// ------------------------------------------------------------ actions ----
// Work only thor can do (mail, with the certificate that never leaves it).
// thor claims queued rows, does them, and reports. A claimed row is never
// handed out again: a send that died mid-way must not go out twice.

export type Action = { id: number; proposalId: number; runner: string; kind: string; payload: Record<string, unknown>; status: 'queued' | 'claimed' | 'done' | 'failed'; createdAt: string; claimedAt: string | null; doneAt: string | null; result: string }

export function queueAction(proposalId: number, runner: string, kind: string, payload: Record<string, unknown>): number {
  const r = db.prepare('INSERT INTO actions (proposalId, runner, kind, payload, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(proposalId, runner, kind, JSON.stringify(payload), nowIso())
  bump()
  return Number(r.lastInsertRowid)
}

export function claimActions(runner: string, max = 5): Action[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM actions WHERE runner = ? AND status = 'queued' ORDER BY id LIMIT ?").all(runner, max) as (Omit<Action, 'payload'> & { payload: string })[]
    const at = nowIso()
    for (const r of rows) db.prepare("UPDATE actions SET status = 'claimed', claimedAt = ? WHERE id = ?").run(at, r.id)
    return rows.map((r) => ({ ...r, status: 'claimed' as const, claimedAt: at, payload: parse<Record<string, unknown>>(r.payload, {}) }))
  })()
}

export function finishAction(id: number, ok: boolean, result: string): Action | null {
  const r = db.prepare("UPDATE actions SET status = ?, doneAt = ?, result = ? WHERE id = ? AND status = 'claimed'")
    .run(ok ? 'done' : 'failed', nowIso(), result.slice(0, 2000), id)
  if (!r.changes) return null
  bump()
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Omit<Action, 'payload'> & { payload: string }
  return { ...row, payload: parse<Record<string, unknown>>(row.payload, {}) }
}

// ------------------------------------------------------------ tickets ----

type TicketTrackRow = {
  franchise: Franchise; id: number; number: string; title: string; company: string; companyId: number; status: string
  priority: string; queue: string; assignee: string | null; mine: 0 | 1; created: string; lastActivity: string | null
  due: string | null; completed: string | null; url: string; firstSeenAt: string; updatedAt: string; closedAt: string | null
  summary: string; next: string; needsBrendon: 0 | 1; waitingOn: string; agentAt: string | null; selfTouchAt: string | null
}
export type TrackedTicket = Omit<TicketTrackRow, 'mine' | 'needsBrendon'> & { mine: boolean; needsBrendon: boolean }

const toTracked = (r: TicketTrackRow): TrackedTicket => ({ ...r, mine: r.mine === 1, needsBrendon: r.needsBrendon === 1 })

export function trackedTicket(f: Franchise, id: number): TrackedTicket | null {
  const r = db.prepare('SELECT * FROM tickets WHERE franchise = ? AND id = ?').get(f, id) as TicketTrackRow | undefined
  return r ? toTracked(r) : null
}

export function trackedByNumber(number: string): TrackedTicket[] {
  return (db.prepare('SELECT * FROM tickets WHERE number = ?').all(number.toUpperCase()) as TicketTrackRow[]).map(toTracked)
}

export function listTracked(f: Franchise, opts: { open?: boolean; mine?: boolean; needsBrendon?: boolean; companyId?: number; limit?: number } = {}): TrackedTicket[] {
  const where = ['franchise = ?']
  const args: unknown[] = [f]
  if (opts.open !== false) where.push('closedAt IS NULL')
  if (opts.mine) where.push('mine = 1')
  if (opts.needsBrendon) where.push('needsBrendon = 1')
  if (opts.companyId) { where.push('companyId = ?'); args.push(opts.companyId) }
  args.push(Math.min(500, opts.limit ?? 300))
  return (db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY needsBrendon DESC, COALESCE(lastActivity, created) DESC LIMIT ?`).all(...args) as TicketTrackRow[]).map(toTracked)
}

export type TicketChange = { kind: 'new' | 'activity' | 'closed' | 'reopened'; ticket: TrackedTicket; changes: string[]; self: boolean }

/** One ticket as Autotask has it now. Returns what changed since the last look, or null. */
export function upsertTracked(t: Ticket, closed: boolean): TicketChange | null {
  const before = trackedTicket(t.franchise, t.id)
  const at = nowIso()
  const row = {
    franchise: t.franchise, id: t.id, number: t.number, title: t.title, company: t.company, companyId: t.companyId,
    status: t.status, priority: t.priority, queue: t.queue, assignee: t.assignee, mine: t.mine ? 1 : 0, created: t.created,
    lastActivity: t.lastActivity, due: t.due, completed: t.completed, url: t.url, at,
    closedAt: closed ? (before?.closedAt ?? at) : null,
  }
  db.prepare(`INSERT INTO tickets (franchise, id, number, title, company, companyId, status, priority, queue, assignee, mine, created, lastActivity, due, completed, url, firstSeenAt, updatedAt, closedAt)
    VALUES (@franchise, @id, @number, @title, @company, @companyId, @status, @priority, @queue, @assignee, @mine, @created, @lastActivity, @due, @completed, @url, @at, @at, @closedAt)
    ON CONFLICT(franchise, id) DO UPDATE SET number = excluded.number, title = excluded.title, company = excluded.company, companyId = excluded.companyId,
      status = excluded.status, priority = excluded.priority, queue = excluded.queue, assignee = excluded.assignee, mine = excluded.mine,
      lastActivity = excluded.lastActivity, due = excluded.due, completed = excluded.completed, url = excluded.url,
      updatedAt = excluded.updatedAt, closedAt = excluded.closedAt`).run(row)
  const now = trackedTicket(t.franchise, t.id)!
  const self = Boolean(before?.selfTouchAt && Date.now() - Date.parse(before.selfTouchAt) < 10 * 60_000)
  if (!before) return closed ? null : { kind: 'new', ticket: now, changes: [], self: false }
  const changes: string[] = []
  if (before.status !== now.status) changes.push(`status ${before.status} -> ${now.status}`)
  if (before.assignee !== now.assignee) changes.push(`assignee ${before.assignee ?? 'none'} -> ${now.assignee ?? 'none'}`)
  if (before.priority !== now.priority) changes.push(`priority ${before.priority} -> ${now.priority}`)
  if (before.title !== now.title) changes.push('title changed')
  if (before.lastActivity !== now.lastActivity && !changes.length) changes.push('new activity (note or time entry)')
  if (!changes.length) return null
  if (closed && !before.closedAt) return { kind: 'closed', ticket: now, changes, self }
  if (!closed && before.closedAt) return { kind: 'reopened', ticket: now, changes, self }
  return { kind: 'activity', ticket: now, changes, self }
}

export function trackNote(f: Franchise, id: number, patch: { summary?: string; next?: string; needsBrendon?: boolean; waitingOn?: string }): TrackedTicket {
  const cur = trackedTicket(f, id)
  if (!cur) throw new AgentError(404, `ticket ${id} is not in the tracker (only open tickets outside Monitoring Alert are)`)
  db.prepare('UPDATE tickets SET summary = ?, next = ?, needsBrendon = ?, waitingOn = ?, agentAt = ? WHERE franchise = ? AND id = ?')
    .run((patch.summary ?? cur.summary).slice(0, 600), (patch.next ?? cur.next).slice(0, 300),
      (patch.needsBrendon ?? cur.needsBrendon) ? 1 : 0, (patch.waitingOn ?? cur.waitingOn).slice(0, 120), nowIso(), f, id)
  bump()
  return trackedTicket(f, id)!
}

export function markSelfTouch(f: Franchise, id: number): void {
  db.prepare('UPDATE tickets SET selfTouchAt = ? WHERE franchise = ? AND id = ?').run(nowIso(), f, id)
}

/** Open tickets the poller did not see this time were closed or moved to monitoring. */
export function openTrackedIds(f: Franchise): number[] {
  return (db.prepare('SELECT id FROM tickets WHERE franchise = ? AND closedAt IS NULL').all(f) as { id: number }[]).map((r) => r.id)
}

export function closeTracked(f: Franchise, id: number): void {
  db.prepare('UPDATE tickets SET closedAt = ? WHERE franchise = ? AND id = ? AND closedAt IS NULL').run(nowIso(), f, id)
}

export function pruneTracked(days = 30): void {
  db.prepare('DELETE FROM tickets WHERE closedAt IS NOT NULL AND closedAt < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
}

export function trackerCounts(f: Franchise): { open: number; mine: number; needsBrendon: number } {
  const r = db.prepare('SELECT COUNT(*) AS open, SUM(mine) AS mine, SUM(needsBrendon) AS nb FROM tickets WHERE franchise = ? AND closedAt IS NULL').get(f) as { open: number; mine: number | null; nb: number | null }
  return { open: r.open, mine: r.mine ?? 0, needsBrendon: r.nb ?? 0 }
}

// --------------------------------------------------------------- mail ----

type MailRow = {
  n: number; mailbox: string; address: string; graphId: string; conversationId: string; subject: string; fromName: string
  fromAddress: string; toList: string; ccList: string; receivedAt: string; body: string; webLink: string | null; importance: string
  focused: 0 | 1; attachments: string; franchise: Franchise | null; agentId: string | null; state: MailState; outcome: string; createdAt: string
}
export type MailItem = Omit<MailRow, 'focused'> & { focused: boolean }

const toMail = (r: MailRow): MailItem => ({ ...r, focused: r.focused === 1 })

export type MailInput = Omit<MailItem, 'n' | 'franchise' | 'agentId' | 'state' | 'outcome' | 'createdAt'>

/** A new mail item, or null when this message is already known. */
export function addMail(m: MailInput): MailItem | null {
  const r = db.prepare(`INSERT OR IGNORE INTO mail (mailbox, address, graphId, conversationId, subject, fromName, fromAddress, toList, ccList, receivedAt, body, webLink, importance, focused, attachments, createdAt)
    VALUES (@mailbox, @address, @graphId, @conversationId, @subject, @fromName, @fromAddress, @toList, @ccList, @receivedAt, @body, @webLink, @importance, @focused, @attachments, @at)`)
    .run({ ...m, focused: m.focused ? 1 : 0, at: nowIso() })
  if (!r.changes) return null
  return getMail(Number(r.lastInsertRowid))
}

export function getMail(n: number): MailItem | null {
  const r = db.prepare('SELECT * FROM mail WHERE n = ?').get(n) as MailRow | undefined
  return r ? toMail(r) : null
}

export function routeMail(n: number, franchise: Franchise | null, agentId: string | null, state?: MailState, outcome?: string): void {
  db.prepare('UPDATE mail SET franchise = ?, agentId = ?, state = COALESCE(?, state), outcome = COALESCE(?, outcome) WHERE n = ?')
    .run(franchise, agentId, state ?? null, outcome ?? null, n)
  bump()
}

export function setMailState(n: number, agentId: string, state: MailState, outcome: string): MailItem {
  const cur = getMail(n)
  if (!cur) throw new AgentError(404, `no mail ${n}`)
  db.prepare('UPDATE mail SET state = ?, outcome = ?, agentId = ? WHERE n = ?').run(state, outcome.slice(0, 500), agentId, n)
  bump()
  return getMail(n)!
}

export function listMail(opts: { agentId?: string; franchise?: Franchise; state?: MailState; days?: number; limit?: number } = {}): MailItem[] {
  const where = ['receivedAt >= ?']
  const args: unknown[] = [new Date(Date.now() - (opts.days ?? 3) * 86_400_000).toISOString()]
  if (opts.agentId) { where.push('agentId = ?'); args.push(opts.agentId) }
  if (opts.franchise) { where.push('franchise = ?'); args.push(opts.franchise) }
  if (opts.state) { where.push('state = ?'); args.push(opts.state) }
  args.push(Math.min(200, opts.limit ?? 50))
  return (db.prepare(`SELECT * FROM mail WHERE ${where.join(' AND ')} ORDER BY receivedAt DESC LIMIT ?`).all(...args) as MailRow[]).map(toMail)
}

export function mailInConversation(conversationId: string, limit = 10): MailItem[] {
  if (!conversationId) return []
  return (db.prepare('SELECT * FROM mail WHERE conversationId = ? ORDER BY receivedAt DESC LIMIT ?').all(conversationId, limit) as MailRow[]).map(toMail)
}

export function pruneMail(days = 30): void {
  db.prepare('DELETE FROM mail WHERE receivedAt < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
  db.prepare('DELETE FROM teams WHERE createdAt < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
}

// -------------------------------------------------------------- teams ----

export type TeamsItem = { id: string; chatId: string; chatTopic: string; fromName: string; text: string; createdAt: string; webUrl: string | null; agentId: string | null; seenAt: string }

export function addTeams(t: Omit<TeamsItem, 'agentId' | 'seenAt'>): TeamsItem | null {
  const r = db.prepare('INSERT OR IGNORE INTO teams (id, chatId, chatTopic, fromName, text, createdAt, webUrl, seenAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, t.chatId, t.chatTopic, t.fromName, t.text, t.createdAt, t.webUrl, nowIso())
  if (!r.changes) return null
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(t.id) as TeamsItem
}

export function setTeamsAgent(id: string, agentId: string): void {
  db.prepare('UPDATE teams SET agentId = ? WHERE id = ?').run(agentId, id)
}

export function listTeams(days = 2, limit = 40): TeamsItem[] {
  return db.prepare('SELECT * FROM teams WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT ?')
    .all(new Date(Date.now() - days * 86_400_000).toISOString(), limit) as TeamsItem[]
}

// ------------------------------------------------------------ senders ----
// Who a mail is from, by Autotask contact: the router's first look.

export function replaceSenders(f: Franchise, rows: { email: string; companyId: number; company: string; name: string }[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM senders WHERE franchise = ?').run(f)
    const ins = db.prepare('INSERT OR REPLACE INTO senders (email, franchise, companyId, company, name) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) ins.run(r.email.toLowerCase(), f, r.companyId, r.company, r.name)
  })()
}

export function senderByEmail(email: string): { email: string; franchise: Franchise; companyId: number; company: string; name: string }[] {
  return db.prepare('SELECT * FROM senders WHERE email = ?').all(email.toLowerCase()) as { email: string; franchise: Franchise; companyId: number; company: string; name: string }[]
}

export function sendersByDomain(domain: string): { franchise: Franchise; companyId: number; company: string; n: number }[] {
  return db.prepare(`SELECT franchise, companyId, company, COUNT(*) AS n FROM senders WHERE email LIKE ? GROUP BY franchise, companyId ORDER BY n DESC`)
    .all(`%@${domain.toLowerCase()}`) as { franchise: Franchise; companyId: number; company: string; n: number }[]
}
