import { randomUUID } from 'node:crypto'
import { ProjError } from './projectTypes.js'

// The "new project" path. Brendon names nothing: the Projects list starts a
// Claude session on thor with what he typed (or nothing), and that session
// works the project out, creates it through the unbound MCP endpoint and fills
// its page. This holds the two things only that launch needs.
//
// The brief is free text, so it never crosses the ssh line: thor fetches it
// once over HTTP, the same way an agent run fetches its brief. Memory only. A
// brief lives ten minutes, which a launch takes seconds of, and an API restart
// in that window costs one retry.

const BRIEF_TTL_MS = 10 * 60_000
export const DESK_PROMPT_MAX = 2000

const briefs = new Map<string, { brief: string; at: number }>()

// Session id -> tmux name of each desk launch, so project_create can link the
// pane it was called from and tag it with the new project.
const panes = new Map<string, string>()

function sweep(): void {
  const cutoff = Date.now() - BRIEF_TTL_MS
  for (const [id, b] of briefs) if (b.at < cutoff) briefs.delete(id)
  // A desk session that never created a project leaves its entry behind.
  // Pane names are cheap; this only bounds the map.
  while (panes.size > 200) panes.delete(panes.keys().next().value as string)
}

function briefFor(prompt: string): string {
  const said = prompt.trim()
    ? prompt.trim()
    : 'Nothing yet. Ask him in one short question what the project is, then do the rest yourself.'
  return [
    '# New Valkyrie project',
    '',
    'Brendon started this session from the Projects page to set up a new project. You run the setup: work out what',
    'the project is, create it, name it and fill its page. He should not have to name or configure anything.',
    '',
    `What he said: ${said}`,
    '',
    'Steps:',
    '1. Work out the project. Find its folder on thor and read what is there: documents, notes, CLAUDE.md files, and',
    '   recent Claude sessions for that folder under ~/.claude/projects. Check the Obsidian vault at',
    '   C:\\Users\\Brendon\\Documents\\Obsidian Notes\\Brendon. Ask him only when two readings would make different projects.',
    '2. Pick the folder key from C:\\Thor\\var\\session-board\\launch-targets.json. If the folder has no key, add one:',
    '   powershell -NoProfile -File C:\\Thor\\tools\\session-board\\Add-LaunchTarget.ps1 -Key <slug> -Label "<name>" -Path "<folder>"',
    '3. Call the valkyrie tool project_create with a short name, the area and the folder key. It links this session.',
    '4. Fill the page with the other valkyrie tools, passing the new projectId: the summary and next action',
    '   (project_update), a markdown overview tab, a checklist tab of open tasks, a links tab when there are links,',
    '   and file_pin for the key files (paths relative to the folder).',
    '5. Finish with one line: the project name and its page, /projects/<id>.',
    '',
  ].join('\n')
}

export function createDeskBrief(prompt: string): string {
  sweep()
  if (prompt.length > DESK_PROMPT_MAX) throw new ProjError(400, `the description is longer than ${DESK_PROMPT_MAX} characters`)
  const id = randomUUID()
  briefs.set(id, { brief: briefFor(prompt), at: Date.now() })
  return id
}

// Once only, like a run brief: a second fetch of the same id is refused.
export function takeDeskBrief(id: string): { brief: string; model: ''; name: string } {
  const b = briefs.get(id)
  briefs.delete(id)
  if (!b || Date.now() - b.at > BRIEF_TTL_MS) throw new ProjError(410, 'this brief was already used or expired')
  return { brief: b.brief, model: '', name: 'new project' }
}

export function noteDeskPane(sessionId: string, tmuxName: string): void {
  sweep()
  panes.set(sessionId, tmuxName)
}

export function deskPaneFor(sessionId: string): string | null {
  return panes.get(sessionId) ?? null
}
