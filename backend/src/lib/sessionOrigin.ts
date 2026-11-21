import { getKv, setKv } from './agentsStore.js'

// Who started a Claude session: Raven or Brendon. Raven's session tools
// (lib/raven/tools/sessions.ts) record the conversation id they mint here
// BEFORE the pane opens, so the Desk can show the session as Raven's from its
// first poll. Every other session is his: the Desk, AI > Sessions, a project
// page or the phone opened it.
//
// The record is keyed on the conversation, not the pane, so it holds after the
// pane is gone: the closed list marks a session Raven started, and a resume of
// it (Recover all after thor restarts) still reads as Raven's.
//
// Before this existed, Raven kept only its main terminals (kv raven:mains,
// target to pane and conversation, written when it opened them), so those
// count too. A session_start pane opened before it has no record and reads as
// his.

const KEY = 'session:origin'
const MAINS_KEY = 'raven:mains'
const KEEP_MS = 120 * 86_400_000
const MAX = 3_000

export type SessionOrigin = 'raven' | 'brendon'

function originMap(): Record<string, string> {
  try {
    const o = JSON.parse(getKv(KEY) ?? '{}') as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Raven is starting this conversation now. */
export function noteRavenStarted(sessionId: string, now = Date.now()): void {
  if (!sessionId) return
  const map = originMap()
  map[sessionId] = new Date(now).toISOString()
  const live = Object.entries(map).filter(([, at]) => now - Date.parse(at) <= KEEP_MS)
  live.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
  setKv(KEY, JSON.stringify(Object.fromEntries(live.slice(0, MAX))))
}

/** Every conversation Raven started that is still on record. One kv read for a whole list. */
export function ravenStartedIds(): Set<string> {
  const out = new Set(Object.keys(originMap()))
  try {
    const mains = JSON.parse(getKv(MAINS_KEY) ?? '{}') as Record<string, { sessionId?: unknown }>
    for (const m of Object.values(mains ?? {})) if (typeof m?.sessionId === 'string' && m.sessionId) out.add(m.sessionId)
  } catch { /* no mains */ }
  return out
}

export const originOf = (ids: Set<string>, sessionId: string | null | undefined): SessionOrigin =>
  (sessionId && ids.has(sessionId) ? 'raven' : 'brendon')
