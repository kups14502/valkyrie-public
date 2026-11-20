import { getKv, setKv } from '../../agentsStore.js'
import { listWatches } from './watch.js'

// Which Claude sessions are Raven's, for the phone alerts: thor's Notification
// hook posts "Session waiting / complete" to POST /api/push/session-waiting
// with the conversation id, and the push is skipped for a session Raven drives,
// because Raven already relays its answers into the Raven thread. His own
// sessions alert as before.
//
// A session is Raven's while any of these holds:
//   - Raven watches it (relays its answers): kv raven:watches
//   - it is a main-terminal pane Raven opened: kv raven:mains
//   - Raven typed into it (session_start or session_send) in the last 24 hours: kv raven:touched

const TOUCHED_KEY = 'raven:touched'
const MAINS_KEY = 'raven:mains'
const KEEP_MS = 24 * 3_600_000

function touchedMap(): Record<string, string> {
  try {
    const o = JSON.parse(getKv(TOUCHED_KEY) ?? '{}') as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Raven typed into this conversation now. */
export function noteRavenTouched(sessionId: string | null | undefined): void {
  if (!sessionId) return
  const now = Date.now()
  const map = touchedMap()
  map[sessionId] = new Date(now).toISOString()
  for (const [id, at] of Object.entries(map)) if (now - Date.parse(at) > KEEP_MS) delete map[id]
  setKv(TOUCHED_KEY, JSON.stringify(map))
}

/** Why a conversation is Raven's ('watched', 'opened', 'typed into'), or null when it is his own. */
export function ravenOwnsSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  if (listWatches().some((w) => w.sessionId === sessionId)) return 'watched'
  try {
    const mains = JSON.parse(getKv(MAINS_KEY) ?? '{}') as Record<string, { sessionId?: string }>
    if (Object.values(mains).some((m) => m?.sessionId === sessionId)) return 'opened'
  } catch { /* no mains */ }
  const at = touchedMap()[sessionId]
  if (at && Date.now() - Date.parse(at) <= KEEP_MS) return 'typed into'
  return null
}
