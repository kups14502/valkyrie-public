import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Quest log storage: game-style quests with subquests (one level via parent_id),
// a tracked flag (the "watch this on the HUD" toggle), and links that connect a
// quest to external things: emails from the intake pipeline, Autotask tickets,
// or plain URLs. Lives in its own SQLite DB next to auth.sqlite. The email
// intake script on the server reads this DB (read-only) to suggest quest
// matches, so schema changes here must stay backward-compatible with it.

const DATA_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'quests.sqlite')

export type QuestStatus = 'active' | 'completed' | 'failed' | 'on_hold'
export type QuestCategory = 'main' | 'side' | 'daily' | 'work'
export type QuestLinkKind = 'email' | 'ticket' | 'url'

export type QuestLink = {
  id: number
  questId: string
  kind: QuestLinkKind
  ref: string
  label: string
  createdAt: string
}

export type QuestRow = {
  id: string
  parentId: string | null
  title: string
  detail: string
  category: QuestCategory
  status: QuestStatus
  tracked: boolean
  sort: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type Quest = QuestRow & {
  subquests: QuestRow[]
  links: QuestLink[]
  progress: { done: number; total: number }
}

const STATUSES: QuestStatus[] = ['active', 'completed', 'failed', 'on_hold']
const CATEGORIES: QuestCategory[] = ['main', 'side', 'daily', 'work']
const LINK_KINDS: QuestLinkKind[] = ['email', 'ticket', 'url']

let db: Database.Database | null = null
function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const d = new Database(DB_PATH)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  d.exec(`
    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES quests(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'side',
      status TEXT NOT NULL DEFAULT 'active',
      tracked INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS quest_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_id);
    CREATE INDEX IF NOT EXISTS idx_links_quest ON quest_links(quest_id);
  `)
  db = d
  return d
}

type DbQuestRow = {
  id: string
  parent_id: string | null
  title: string
  detail: string
  category: string
  status: string
  tracked: number
  sort: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

type DbLinkRow = {
  id: number
  quest_id: string
  kind: string
  ref: string
  label: string
  created_at: string
}

function toRow(r: DbQuestRow): QuestRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    detail: r.detail,
    category: (CATEGORIES.includes(r.category as QuestCategory) ? r.category : 'side') as QuestCategory,
    status: (STATUSES.includes(r.status as QuestStatus) ? r.status : 'active') as QuestStatus,
    tracked: Boolean(r.tracked),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  }
}

function toLink(r: DbLinkRow): QuestLink {
  return {
    id: r.id,
    questId: r.quest_id,
    kind: (LINK_KINDS.includes(r.kind as QuestLinkKind) ? r.kind : 'url') as QuestLinkKind,
    ref: r.ref,
    label: r.label,
    createdAt: r.created_at,
  }
}

export function listQuests(): Quest[] {
  const d = getDb()
  const rows = (d.prepare('SELECT * FROM quests ORDER BY sort, created_at').all() as DbQuestRow[]).map(toRow)
  const links = (d.prepare('SELECT * FROM quest_links ORDER BY created_at').all() as DbLinkRow[]).map(toLink)
  const linksByQuest = new Map<string, QuestLink[]>()
  for (const l of links) {
    const arr = linksByQuest.get(l.questId) ?? []
    arr.push(l)
    linksByQuest.set(l.questId, arr)
  }
  const subsByParent = new Map<string, QuestRow[]>()
  for (const r of rows) {
    if (!r.parentId) continue
    const arr = subsByParent.get(r.parentId) ?? []
    arr.push(r)
    subsByParent.set(r.parentId, arr)
  }
  return rows
    .filter((r) => !r.parentId)
    .map((r) => {
      const subquests = subsByParent.get(r.id) ?? []
      const done = subquests.filter((s) => s.status === 'completed').length
      return { ...r, subquests, links: linksByQuest.get(r.id) ?? [], progress: { done, total: subquests.length } }
    })
}

export function getQuest(id: string): QuestRow | undefined {
  const r = getDb().prepare('SELECT * FROM quests WHERE id = ?').get(id) as DbQuestRow | undefined
  return r ? toRow(r) : undefined
}

export function createQuest(input: {
  title: string
  detail?: string
  category?: string
  parentId?: string | null
  tracked?: boolean
}): QuestRow {
  const title = String(input.title || '').trim().slice(0, 200)
  if (!title) throw new Error('title required')
  const parentId = input.parentId ?? null
  if (parentId) {
    const parent = getQuest(parentId)
    if (!parent) throw new Error('parent quest not found')
    if (parent.parentId) throw new Error('subquests cannot have their own subquests')
  }
  const category = CATEGORIES.includes(input.category as QuestCategory) ? (input.category as QuestCategory) : 'side'
  const now = new Date().toISOString()
  const row: DbQuestRow = {
    id: randomUUID(),
    parent_id: parentId,
    title,
    detail: String(input.detail ?? '').slice(0, 4000),
    category,
    status: 'active',
    // Quests are born active, so they're born tracked (tracking follows
    // workability); subquests never track.
    tracked: (input.tracked ?? !parentId) ? 1 : 0,
    sort: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  getDb().prepare(`INSERT INTO quests (id, parent_id, title, detail, category, status, tracked, sort, created_at, updated_at, completed_at)
    VALUES (@id, @parent_id, @title, @detail, @category, @status, @tracked, @sort, @created_at, @updated_at, @completed_at)`).run(row)
  return toRow(row)
}

export function updateQuest(id: string, patch: {
  title?: string
  detail?: string
  category?: string
  status?: string
  tracked?: boolean
  sort?: number
}): QuestRow {
  const existing = getQuest(id)
  if (!existing) throw new Error('quest not found')
  const next = { ...existing }
  if (patch.title !== undefined) {
    const t = String(patch.title).trim().slice(0, 200)
    if (!t) throw new Error('title cannot be empty')
    next.title = t
  }
  if (patch.detail !== undefined) next.detail = String(patch.detail).slice(0, 4000)
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category as QuestCategory)) throw new Error('invalid category')
    next.category = patch.category as QuestCategory
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status as QuestStatus)) throw new Error('invalid status')
    next.status = patch.status as QuestStatus
    next.completedAt = patch.status === 'completed' ? new Date().toISOString() : null
    // Tracking follows workability: becoming active tracks the quest, leaving
    // active (hold/done/failed) untracks it. A patch that sets tracked
    // explicitly wins, and the eye toggle (tracked-only patch) still pins a
    // manual choice until the next status transition.
    if (patch.tracked === undefined && !existing.parentId) next.tracked = patch.status === 'active'
  }
  if (patch.tracked !== undefined) next.tracked = Boolean(patch.tracked)
  if (patch.sort !== undefined && Number.isFinite(patch.sort)) next.sort = Number(patch.sort)
  next.updatedAt = new Date().toISOString()
  getDb().prepare(`UPDATE quests SET title=@title, detail=@detail, category=@category, status=@status,
    tracked=@tracked, sort=@sort, updated_at=@updatedAt, completed_at=@completedAt WHERE id=@id`).run({
    id: next.id,
    title: next.title,
    detail: next.detail,
    category: next.category,
    status: next.status,
    tracked: next.tracked ? 1 : 0,
    sort: next.sort,
    updatedAt: next.updatedAt,
    completedAt: next.completedAt,
  })
  return next
}

export function deleteQuest(id: string): void {
  const existing = getQuest(id)
  if (!existing) throw new Error('quest not found')
  // ON DELETE CASCADE removes subquests and links.
  getDb().prepare('DELETE FROM quests WHERE id = ?').run(id)
}

export function addLink(questId: string, input: { kind: string; ref: string; label?: string }): QuestLink {
  const quest = getQuest(questId)
  if (!quest) throw new Error('quest not found')
  // Only top-level quests carry links: listQuests() never surfaces links on
  // subquests, so accepting them here would store invisible rows.
  if (quest.parentId) throw new Error('links cannot be added to subquests')
  if (!LINK_KINDS.includes(input.kind as QuestLinkKind)) throw new Error('invalid link kind')
  const ref = String(input.ref || '').trim().slice(0, 500)
  if (!ref) throw new Error('ref required')
  // Idempotent: re-linking the same thing (e.g. an intake retry after a
  // partial failure) returns the existing row instead of duplicating it.
  const existing = getDb().prepare('SELECT * FROM quest_links WHERE quest_id = ? AND kind = ? AND ref = ?')
    .get(questId, input.kind, ref) as DbLinkRow | undefined
  if (existing) return toLink(existing)
  const now = new Date().toISOString()
  const label = String(input.label ?? '').slice(0, 300)
  const result = getDb().prepare('INSERT INTO quest_links (quest_id, kind, ref, label, created_at) VALUES (?,?,?,?,?)')
    .run(questId, input.kind, ref, label, now)
  return { id: Number(result.lastInsertRowid), questId, kind: input.kind as QuestLinkKind, ref, label, createdAt: now }
}

export function deleteLink(questId: string, linkId: number): void {
  const result = getDb().prepare('DELETE FROM quest_links WHERE id = ? AND quest_id = ?').run(linkId, questId)
  if (result.changes === 0) throw new Error('link not found')
}
