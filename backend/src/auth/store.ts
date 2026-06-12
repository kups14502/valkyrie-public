import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { generateSecret, generateURI, verifySync } from 'otplib'

// Self-hosted owner credentials for the dedicated apps: one password (scrypt
// hashed) + one TOTP secret, stored in a tiny SQLite DB alongside the Code Deck
// DB. This replaces the Cloudflare Access email-code login. Single-user by
// design — there is exactly one owner row.

const DATA_DIR = path.join(homedir(), 'master-control', 'backend', 'data')
const DB_PATH = path.join(DATA_DIR, 'auth.sqlite')
const ISSUER = 'Valkyrie'
const ACCOUNT = process.env.AUTH_ACCOUNT_LABEL || 'owner'
// Accept codes within ±30s (one step) of the server clock to tolerate drift.
const TOTP_TOLERANCE = 30

let db: Database.Database | null = null
function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const d = new Database(DB_PATH)
  d.pragma('journal_mode = WAL')
  d.exec(`
    CREATE TABLE IF NOT EXISTS app_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      passwordHash TEXT NOT NULL,
      totpSecret TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db = d
  return d
}

type AuthRow = { id: number; passwordHash: string; totpSecret: string; createdAt: string; updatedAt: string }

function getRow(): AuthRow | undefined {
  return getDb().prepare('SELECT * FROM app_auth WHERE id = 1').get() as AuthRow | undefined
}

export function isConfigured(): boolean {
  return Boolean(getRow())
}

// scrypt with a random per-credential salt, stored as "saltHex:hashHex".
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// Create or overwrite the owner credential. Generates a fresh TOTP secret and
// returns the otpauth:// URI + secret for authenticator enrollment.
export function setupCredentials(password: string): { otpauthUri: string; secret: string } {
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters')
  const secret = generateSecret()
  const now = new Date().toISOString()
  const existing = getRow()
  if (existing) {
    getDb().prepare('UPDATE app_auth SET passwordHash=@passwordHash, totpSecret=@totpSecret, updatedAt=@updatedAt WHERE id=1')
      .run({ passwordHash: hashPassword(password), totpSecret: secret, updatedAt: now })
  } else {
    getDb().prepare('INSERT INTO app_auth (id, passwordHash, totpSecret, createdAt, updatedAt) VALUES (1, @passwordHash, @totpSecret, @createdAt, @updatedAt)')
      .run({ passwordHash: hashPassword(password), totpSecret: secret, createdAt: now, updatedAt: now })
  }
  return { otpauthUri: generateURI({ secret, label: ACCOUNT, issuer: ISSUER }), secret }
}

// Verify password AND TOTP together. Returns true only if both match.
export function verifyCredentials(password: string, totp: string): boolean {
  const row = getRow()
  if (!row) return false
  if (!verifyPasswordHash(password, row.passwordHash)) return false
  const code = String(totp || '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(code)) return false
  return verifySync({ token: code, secret: row.totpSecret, epochTolerance: TOTP_TOLERANCE }).valid
}

// Persisted JWT signing secret: env override, else a random secret generated
// once and stored so app tokens survive restarts without any env config.
export function getJwtSecret(): string {
  if (process.env.APP_JWT_SECRET) return process.env.APP_JWT_SECRET
  const d = getDb()
  const row = d.prepare('SELECT value FROM app_kv WHERE key = ?').get('jwtSecret') as { value: string } | undefined
  if (row?.value) return row.value
  const secret = randomBytes(48).toString('hex')
  d.prepare('INSERT INTO app_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('jwtSecret', secret)
  return secret
}
