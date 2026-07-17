import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Gig log storage: game-style gigs with subgigs (one level via parent_id),
// a tracked flag (the "watch this on the HUD" toggle), and links that connect a
// gig to external things: emails from the intake pipeline, Autotask tickets,
// or plain URLs. Lives in its own SQLite DB next to auth.sqlite. The email
// intake script on the server reads this DB (read-only) to suggest gig
// matches, so schema changes here must stay backward-compatible with it.

const DATA_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'gigs.sqlite')

export type GigStatus = 'active' | 'completed' | 'failed' | 'on_hold'
export type GigCategory = 'main' | 'side' | 'daily' | 'work'
export type GigLinkKind = 'email' | 'ticket' | 'url'

export type GigLink = {
  id: number
  gigId: string
  kind: GigLinkKind
  ref: string
  label: string
  createdAt: string
}

export type GigRow = {
  id: string
  parentId: string | null
  title: string
  detail: string
  category: GigCategory
  status: GigStatus
  tracked: boolean
  sort: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type Gig = GigRow & {
  subgigs: GigRow[]
  links: GigLink[]
  progress: { done: number; total: number }
}

const STATUSES: GigStatus[] = ['active', 'completed', 'failed', 'on_hold']
const CATEGORIES: GigCategory[] = ['main', 'side', 'daily', 'work']
const LINK_KINDS: GigLinkKind[] = ['email', 'ticket', 'url']

let db: Database.Database | null = null
function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const d = new Database(DB_PATH)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  d.exec(`
    CREATE TABLE IF NOT EXISTS gigs (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES gigs(id) ON DELETE CASCADE,
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
    CREATE TABLE IF NOT EXISTS gig_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gig_id TEXT NOT NULL REFERENCES gigs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gigs_parent ON gigs(parent_id);
    CREATE INDEX IF NOT EXISTS idx_links_gig ON gig_links(gig_id);
  `)
  db = d
  return d
}

type DbGigRow = {
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
  gig_id: string
  kind: string
  ref: string
  label: string
  created_at: string
}

function toRow(r: DbGigRow): GigRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    detail: r.detail,
    category: (CATEGORIES.includes(r.category as GigCategory) ? r.category : 'side') as GigCategory,
    status: (STATUSES.includes(r.status as GigStatus) ? r.status : 'active') as GigStatus,
    tracked: Boolean(r.tracked),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  }
}

function toLink(r: DbLinkRow): GigLink {
  return {
    id: r.id,
    gigId: r.gig_id,
    kind: (LINK_KINDS.includes(r.kind as GigLinkKind) ? r.kind : 'url') as GigLinkKind,
    ref: r.ref,
    label: r.label,
    createdAt: r.created_at,
  }
}

export function listGigs(): Gig[] {
  const d = getDb()
  const rows = (d.prepare('SELECT * FROM gigs ORDER BY sort, created_at').all() as DbGigRow[]).map(toRow)
  const links = (d.prepare('SELECT * FROM gig_links ORDER BY created_at').all() as DbLinkRow[]).map(toLink)
  const linksByGig = new Map<string, GigLink[]>()
  for (const l of links) {
    const arr = linksByGig.get(l.gigId) ?? []
    arr.push(l)
    linksByGig.set(l.gigId, arr)
  }
  const subsByParent = new Map<string, GigRow[]>()
  for (const r of rows) {
    if (!r.parentId) continue
    const arr = subsByParent.get(r.parentId) ?? []
    arr.push(r)
    subsByParent.set(r.parentId, arr)
  }
  return rows
    .filter((r) => !r.parentId)
    .map((r) => {
      const subgigs = subsByParent.get(r.id) ?? []
      const done = subgigs.filter((s) => s.status === 'completed').length
      return { ...r, subgigs, links: linksByGig.get(r.id) ?? [], progress: { done, total: subgigs.length } }
    })
}

export function getGig(id: string): GigRow | undefined {
  const r = getDb().prepare('SELECT * FROM gigs WHERE id = ?').get(id) as DbGigRow | undefined
  return r ? toRow(r) : undefined
}

export function createGig(input: {
  title: string
  detail?: string
  category?: string
  parentId?: string | null
  tracked?: boolean
}): GigRow {
  const title = String(input.title || '').trim().slice(0, 200)
  if (!title) throw new Error('title required')
  const parentId = input.parentId ?? null
  if (parentId) {
    const parent = getGig(parentId)
    if (!parent) throw new Error('parent gig not found')
    if (parent.parentId) throw new Error('subgigs cannot have their own subgigs')
  }
  const category = CATEGORIES.includes(input.category as GigCategory) ? (input.category as GigCategory) : 'side'
  const now = new Date().toISOString()
  const row: DbGigRow = {
    id: randomUUID(),
    parent_id: parentId,
    title,
    detail: String(input.detail ?? '').slice(0, 4000),
    category,
    status: 'active',
    // Gigs are born active, so they're born tracked (tracking follows
    // workability); subgigs never track.
    tracked: (input.tracked ?? !parentId) ? 1 : 0,
    sort: 0,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  getDb().prepare(`INSERT INTO gigs (id, parent_id, title, detail, category, status, tracked, sort, created_at, updated_at, completed_at)
    VALUES (@id, @parent_id, @title, @detail, @category, @status, @tracked, @sort, @created_at, @updated_at, @completed_at)`).run(row)
  return toRow(row)
}

export function updateGig(id: string, patch: {
  title?: string
  detail?: string
  category?: string
  status?: string
  tracked?: boolean
  sort?: number
}): GigRow {
  const existing = getGig(id)
  if (!existing) throw new Error('gig not found')
  const next = { ...existing }
  if (patch.title !== undefined) {
    const t = String(patch.title).trim().slice(0, 200)
    if (!t) throw new Error('title cannot be empty')
    next.title = t
  }
  if (patch.detail !== undefined) next.detail = String(patch.detail).slice(0, 4000)
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category as GigCategory)) throw new Error('invalid category')
    next.category = patch.category as GigCategory
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status as GigStatus)) throw new Error('invalid status')
    next.status = patch.status as GigStatus
    next.completedAt = patch.status === 'completed' ? new Date().toISOString() : null
    // Tracking follows workability: becoming active tracks the gig, leaving
    // active (hold/done/failed) untracks it. A patch that sets tracked
    // explicitly wins, and the eye toggle (tracked-only patch) still pins a
    // manual choice until the next status transition.
    if (patch.tracked === undefined && !existing.parentId) next.tracked = patch.status === 'active'
  }
  if (patch.tracked !== undefined) next.tracked = Boolean(patch.tracked)
  if (patch.sort !== undefined && Number.isFinite(patch.sort)) next.sort = Number(patch.sort)
  next.updatedAt = new Date().toISOString()
  getDb().prepare(`UPDATE gigs SET title=@title, detail=@detail, category=@category, status=@status,
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

export function deleteGig(id: string): void {
  const existing = getGig(id)
  if (!existing) throw new Error('gig not found')
  // ON DELETE CASCADE removes subgigs and links.
  getDb().prepare('DELETE FROM gigs WHERE id = ?').run(id)
}

export function addLink(gigId: string, input: { kind: string; ref: string; label?: string }): GigLink {
  const gig = getGig(gigId)
  if (!gig) throw new Error('gig not found')
  // Only top-level gigs carry links: listGigs() never surfaces links on
  // subgigs, so accepting them here would store invisible rows.
  if (gig.parentId) throw new Error('links cannot be added to subgigs')
  if (!LINK_KINDS.includes(input.kind as GigLinkKind)) throw new Error('invalid link kind')
  const ref = String(input.ref || '').trim().slice(0, 500)
  if (!ref) throw new Error('ref required')
  // Idempotent: re-linking the same thing (e.g. an intake retry after a
  // partial failure) returns the existing row instead of duplicating it.
  const existing = getDb().prepare('SELECT * FROM gig_links WHERE gig_id = ? AND kind = ? AND ref = ?')
    .get(gigId, input.kind, ref) as DbLinkRow | undefined
  if (existing) return toLink(existing)
  const now = new Date().toISOString()
  const label = String(input.label ?? '').slice(0, 300)
  const result = getDb().prepare('INSERT INTO gig_links (gig_id, kind, ref, label, created_at) VALUES (?,?,?,?,?)')
    .run(gigId, input.kind, ref, label, now)
  return { id: Number(result.lastInsertRowid), gigId, kind: input.kind as GigLinkKind, ref, label, createdAt: now }
}

export function deleteLink(gigId: string, linkId: number): void {
  const result = getDb().prepare('DELETE FROM gig_links WHERE id = ? AND gig_id = ?').run(linkId, gigId)
  if (result.changes === 0) throw new Error('link not found')
}
