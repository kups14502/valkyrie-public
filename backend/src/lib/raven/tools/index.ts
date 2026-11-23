import type { RavenToolGroup } from '../types.js'
import { registerAgentTools } from './agents.js'
import { closeQuietJobs } from './autoclose.js'
import { registerMediaTools } from './media.js'
import { registerSessionTools, sessionsSnapshot, sessionsState, sessionTitles, titleFor, type RavenMain, type RavenWatch } from './sessions.js'
import { registerThorFileTools } from './thorfiles.js'
import { registerThreadTools } from './thread.js'
import { registerVaultTools } from './vault.js'
import { registerTendTools, startTender, tendsSnapshot } from './tend.js'
import { registerThorScreenTools } from './thorscreen.js'
import { startWatcher } from './watch.js'
import { registerWorkTools } from './work.js'

// Raven's tool groups (one file each under lib/raven/tools/) and the session
// watcher. The run loop (lib/raven/run.ts) and routes/ravenMcp.ts use exactly
// these four exports; the core tools (post, notebook_set, now, attachment,
// attachments) are registered by the endpoint itself.
//
//   agents.ts    the work agents: status, channels, a question to one, pause, check, pending proposals
//   sessions.ts  Brendon's Claude sessions: main terminals, start, send (with attachments), read, screen, keys, watch, stop
//   outside.ts   Claude sessions with no pane here (windows and ssh logins on thor, terminals on odin): find, screen, type, keys
//   thorscreen.ts thor's screen: screenshot, windows, a dialog's button, click, keys
//   tend.ts      sessions Raven keeps going: a check every 15 minutes wakes it
//   watch.ts     the relay watcher: a watched session's answers come back into the DM
//   autoclose.ts a job Raven started that stays quiet after its answer is closed and marked done
//   media.ts     Plex requests: search, request, live status
//   vault.ts     the Obsidian vault, live on thor (odin's nightly copy when thor is off): search, read, list, recent, a new note
//   thorfiles.ts his own files on thor, live and read-only: list, read, search
//   thread.ts    Raven's own thread, every message since it began: search, read in full
//   work.ts      tasks, projects, tickets per work area, inbox, calendar, the morning brief

export type { RavenMain, RavenWatch }

/** Every built-in Raven tool group, registered on one run's MCP server. */
export const registerRavenTools: RavenToolGroup = (server, ctx) => {
  registerAgentTools(server, ctx)
  registerSessionTools(server, ctx)
  registerThorScreenTools(server, ctx)
  registerTendTools(server, ctx)
  registerMediaTools(server, ctx)
  registerVaultTools(server, ctx)
  registerThorFileTools(server, ctx)
  registerThreadTools(server, ctx)
  registerWorkTools(server, ctx)
}

/** Starts what runs beside Raven: the relay watcher, and after each of its passes the jobs' auto-close. Called once by startRaven. */
export function startRavenTools(): void {
  startWatcher(async () => { await closeQuietJobs() })
  startTender()
}

/** Plain lines for Raven's prompt: main terminals and watched sessions. Never throws. */
export async function ravenSnapshot(): Promise<string> {
  try {
    const tends = tendsSnapshot()
    return [await sessionsSnapshot(), tends].filter(Boolean).join('\n')
  } catch (e) {
    return `Sessions: could not be read (${(e as Error).message.slice(0, 160)}).`
  }
}

/**
 * A session relay's sender as the conversation's own title ("Raven model and effort picker"), when thor's board has
 * one that says more than the pane label ("Personal"); undefined otherwise. Never waits, never throws.
 */
export function ravenRelayTitles(): (sessionId: string | undefined, label: string) => string | undefined {
  let titles: Map<string, string>
  try {
    titles = sessionTitles()
  } catch {
    titles = new Map()
  }
  return (sessionId, label) => titleFor(titles, sessionId, label)
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
