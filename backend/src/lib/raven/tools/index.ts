import type { RavenToolGroup } from '../types.js'
import { registerAgentTools } from './agents.js'
import { registerMediaTools } from './media.js'
import { registerSessionTools, sessionsSnapshot, sessionsState, type RavenMain, type RavenWatch } from './sessions.js'
import { registerVaultTools } from './vault.js'
import { startWatcher } from './watch.js'
import { registerWorkTools } from './work.js'

// Raven's tool groups (one file each under lib/raven/tools/) and the session
// watcher. The run loop (lib/raven/run.ts) and routes/ravenMcp.ts use exactly
// these four exports; the core tools (post, notebook_set, now, attachment,
// attachments) are registered by the endpoint itself.
//
//   agents.ts    the work agents: status, channels, a question to one, pause, check, pending proposals
//   sessions.ts  Brendon's Claude sessions: main terminals, start, send (with attachments), read, watch, stop
//   watch.ts     the relay watcher: a watched session's answers come back into the DM
//   media.ts     Plex requests: search, request, live status
//   vault.ts     the Obsidian vault: search, read, recent notes, a new note on thor
//   work.ts      tasks, projects, tickets per work area, inbox, calendar, the morning brief

export type { RavenMain, RavenWatch }

/** Every built-in Raven tool group, registered on one run's MCP server. */
export const registerRavenTools: RavenToolGroup = (server, ctx) => {
  registerAgentTools(server, ctx)
  registerSessionTools(server, ctx)
  registerMediaTools(server, ctx)
  registerVaultTools(server, ctx)
  registerWorkTools(server, ctx)
}

/** Starts what runs beside Raven (the relay watcher). Called once by startRaven. */
export function startRavenTools(): void {
  startWatcher()
}

/** Plain lines for Raven's prompt: main terminals and watched sessions. Never throws. */
export async function ravenSnapshot(): Promise<string> {
  try {
    return await sessionsSnapshot()
  } catch (e) {
    return `Sessions: could not be read (${(e as Error).message.slice(0, 160)}).`
  }
}

/** Main terminals and watched sessions for GET /api/raven. Never throws. */
export async function ravenSessionsState(): Promise<{ mains: RavenMain[]; watching: RavenWatch[] }> {
  try {
    return await sessionsState()
  } catch (e) {
    console.error('[raven-tools] sessions state:', (e as Error).message)
    return { mains: [], watching: [] }
  }
}
