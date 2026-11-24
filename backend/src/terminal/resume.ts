import { getProject, linkSession, projectsForSession } from '../lib/projectsStore.js'
import type { Ctx, Project } from '../lib/projectTypes.js'
import { createSession } from './tmux.js'

// A closed conversation reopened in a pane on thor: claude --resume in the
// conversation's own folder (terminal/tmux.ts). The Desk's Recover (POST
// /api/terminal/sessions, mode resume) and Raven's session_recover both come
// through here, so a project conversation comes back linked to its project,
// with its MCP channel, whichever of them reopened it.

/**
 * The one project a conversation is linked to, when there is exactly one and it is not archived or hidden from the
 * caller. A conversation linked to two projects is left alone.
 */
export function resumeProject(sessionId: string, hidden: (projectId: string) => boolean = () => false): Project | null {
  const ids = projectsForSession(sessionId)
  const p = ids.length === 1 ? getProject(ids[0]) : null
  return p && p.status !== 'archived' && !hidden(p.id) ? p : null
}

/** Records the resumed pane on its project. The pane is already running, so a failure is logged, not thrown. */
export function linkResumed(projectId: string, sessionId: string, pane: string, ctx: Ctx, runId: string | null = null): void {
  try {
    linkSession(projectId, { sessionId, launchSessionId: sessionId, tmuxName: pane, mode: 'resume', runId, via: 'resume' }, ctx)
  } catch (err) {
    console.error('[terminal] project link failed', (err as Error).message)
  }
}

/**
 * Reopens a conversation in a new pane on thor, as the Desk's Recover does: its project (if one) linked, the label
 * given (the board's title), else the project's name, else the id's first 8. Answers the pane's name.
 */
export async function resumeOnThor(o: { sessionId: string; label: string; cols: number; rows: number; ctx: Ctx }): Promise<string> {
  const project = resumeProject(o.sessionId)
  const label = o.label || (project ? project.name : o.sessionId.slice(0, 8))
  const name = await createSession({ mode: 'resume', host: 'thor', resumeId: o.sessionId, label, cols: o.cols, rows: o.rows, projectId: project?.id })
  if (project) linkResumed(project.id, o.sessionId, name, o.ctx)
  return name
}
