import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// Shared SQLite home for the app's own data, alongside the auth DB that
// auth/store.ts already keeps here. One file per feature, opened once and held
// for the life of the process (better-sqlite3 is synchronous, so there is no
// pool to manage and no connection to lose).

export const DATA_DIR = process.env.VALKYRIE_DATA_DIR
  || path.join(homedir(), 'valkyrie', 'backend', 'data')

const open = new Map<string, Database.Database>()

export function openDb(name: string, schema: string): Database.Database {
  const existing = open.get(name)
  if (existing) return existing
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(path.join(DATA_DIR, `${name}.sqlite`))
  db.pragma('journal_mode = WAL')
  db.exec(schema)
  open.set(name, db)
  return db
}
