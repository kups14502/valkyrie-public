import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { openDb } from './db.js'

// The phone and tablet report their own battery: an iOS Shortcuts automation
// posts it to POST /api/devices/<id>/report (routes/devices.ts). This module
// holds the two things that must outlive a restart, in DATA_DIR/devices.sqlite:
//
//   * one token per device, stored as its SHA-256 only. The token is printed
//     once by scripts/deviceToken.mts and lives in the Shortcut, never here.
//   * the last report per device, so a restart still shows where the battery
//     was left.
//
// No timers and no network in here, so the token script can import it.

export const DEVICE_IDS = ['phone', 'tablet'] as const
export type DeviceId = (typeof DEVICE_IDS)[number]
export const isDeviceId = (v: unknown): v is DeviceId => typeof v === 'string' && (DEVICE_IDS as readonly string[]).includes(v)

export const BATTERY_STATUSES = ['charging', 'discharging', 'full', 'not charging', 'unknown'] as const
export type BatteryStatus = (typeof BATTERY_STATUSES)[number]

export type DeviceReport = {
  /** ms, when odin accepted the report */
  ts: number
  /** 0..100 */
  battery: number
  status: BatteryStatus
  /** bytes, only when the Shortcut sends storage (needs a third-party action) */
  storageUsed: number | null
  storageTotal: number | null
}

const db = openDb('devices', `
  CREATE TABLE IF NOT EXISTS device_tokens (
    device TEXT PRIMARY KEY,
    token_sha256 TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_reports (
    device TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    battery REAL NOT NULL,
    status TEXT NOT NULL,
    storage_used REAL,
    storage_total REAL
  );
`)

const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

/** A new token for the device, replacing any old one. Returned once; only its hash is kept. */
export function issueDeviceToken(id: DeviceId): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare(`INSERT INTO device_tokens (device, token_sha256, created) VALUES (?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET token_sha256 = excluded.token_sha256, created = excluded.created`)
    .run(id, sha(token).toString('hex'), Date.now())
  return token
}

/** Removes the device's token: its Shortcut gets 401 until a new one is issued. */
export function revokeDeviceToken(id: DeviceId): boolean {
  return db.prepare('DELETE FROM device_tokens WHERE device = ?').run(id).changes > 0
}

export function hasDeviceToken(id: DeviceId): boolean {
  return Boolean(db.prepare('SELECT 1 FROM device_tokens WHERE device = ?').get(id))
}

/** Constant-time check of a presented token against the stored hash. False when none is stored. */
export function checkDeviceToken(id: DeviceId, presented: string | undefined): boolean {
  if (!presented || presented.length > 200) return false
  const row = db.prepare('SELECT token_sha256 AS h FROM device_tokens WHERE device = ?').get(id) as { h: string } | undefined
  if (!row || !/^[0-9a-f]{64}$/.test(row.h)) return false
  return timingSafeEqual(sha(presented), Buffer.from(row.h, 'hex'))
}

export function saveDeviceReport(id: DeviceId, r: DeviceReport): void {
  db.prepare(`INSERT INTO device_reports (device, ts, battery, status, storage_used, storage_total) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device) DO UPDATE SET ts = excluded.ts, battery = excluded.battery, status = excluded.status,
      storage_used = excluded.storage_used, storage_total = excluded.storage_total`)
    .run(id, r.ts, r.battery, r.status, r.storageUsed, r.storageTotal)
}

export function readDeviceReport(id: DeviceId): DeviceReport | null {
  const row = db.prepare('SELECT ts, battery, status, storage_used AS su, storage_total AS st FROM device_reports WHERE device = ?')
    .get(id) as { ts: number; battery: number; status: string; su: number | null; st: number | null } | undefined
  if (!row) return null
  return {
    ts: row.ts,
    battery: row.battery,
    status: (BATTERY_STATUSES as readonly string[]).includes(row.status) ? (row.status as BatteryStatus) : 'unknown',
    storageUsed: row.su,
    storageTotal: row.st,
  }
}
